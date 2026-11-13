import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * How close to the bottom, in px, a downward scroll has to land to re-attach
 * the transcript to the live end.
 */
const REATTACH_DISTANCE_PX = 16;

/** Keys that scroll a focused transcript upward. */
const SCROLL_UP_KEYS = new Set(['PageUp', 'Home', 'ArrowUp']);

/** How far a finger has to drag down (content moving up) before it counts as reading back. */
const TOUCH_DETACH_SLOP_PX = 6;

/**
 * How long after "jump to latest" growth keeps gliding to the new bottom
 * instead of snapping to it, so content landing mid-jump extends the glide.
 */
const SMOOTH_FOLLOW_WINDOW_MS = 700;

type UseTranscriptFollowArgs = {
  scrollContainerRef: RefObject<HTMLDivElement>;
  /** The element holding the rows; its size changes are what following reacts to. */
  scrollContentRef: RefObject<HTMLDivElement>;
  /**
   * False while another writer owns the scroll position — the restore after
   * older history is prepended, a sidebar-search jump, a hidden tab.
   */
  canFollow: () => boolean;
  /** Called on the attached → detached transition, before the state update renders. */
  onDetach?: () => void;
};

type BoundElements = {
  container: HTMLDivElement;
  content: HTMLDivElement | null;
  unbind: () => void;
};

function canScroll(container: HTMLElement): boolean {
  return container.scrollHeight - container.clientHeight > REATTACH_DISTANCE_PX;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/**
 * True when a wheel or drag over `target` is taken by a scroller nested in the
 * transcript (long command output, a wide diff) that can still move up.
 * Reading back inside a code block is not reading back in the conversation.
 */
function isInsideNestedScroller(target: EventTarget | null, container: HTMLElement): boolean {
  let element = target instanceof Element ? target : null;
  while (element && element !== container) {
    if (element instanceof HTMLElement && element.scrollTop > 0 && element.scrollHeight > element.clientHeight) {
      const { overflowY } = window.getComputedStyle(element);
      if (overflowY === 'auto' || overflowY === 'scroll') {
        return true;
      }
    }
    element = element.parentElement;
  }
  return false;
}

/**
 * Keeps a transcript stuck to its newest message until the user reads back.
 *
 * The previous logic re-derived "scrolled up" from distance-to-bottom on every
 * scroll event and only followed when the message count changed. Streaming
 * text, a tool result or an image loading grows the page without adding a
 * message, so nothing followed it, and any growth past the 50px band that
 * arrived with a scroll event read as the user leaving — after which following
 * stayed off for good.
 *
 * Here the view detaches only on user intent: a wheel or drag upward, a
 * scroll-up key, or a scroll that moved the view up that this hook did not
 * write. Every position this hook writes is recorded as the last known one, so
 * the scroll event it causes reads as no movement. It re-attaches when a
 * downward scroll lands within a few px of the bottom. While attached, a
 * ResizeObserver on the rows and the viewport re-pins on any height change.
 *
 * Used only by useChatSessionState, which owns the other scroll writers and
 * decides through `canFollow` when following must stand aside.
 */
export function useTranscriptFollow({
  scrollContainerRef,
  scrollContentRef,
  canFollow,
  onDetach,
}: UseTranscriptFollowArgs) {
  // Whether the user has scrolled away from the live end. Drives the
  // jump-to-latest pill; the ref mirror is what event handlers and the resize
  // observer read, since they must see a detach in the same frame it happens.
  const [isDetached, setIsDetachedState] = useState(false);
  const isDetachedRef = useRef(false);
  /** Last scroll position seen or written; scroll direction is measured against it. */
  const lastScrollTopRef = useRef(0);
  const smoothFollowUntilRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  /** Whether the last pointer press landed in this transcript, so a body-level key belongs to it. */
  const pointerInsideRef = useRef(false);
  const boundRef = useRef<BoundElements | null>(null);
  const canFollowRef = useRef(canFollow);
  const onDetachRef = useRef(onDetach);

  useLayoutEffect(() => {
    canFollowRef.current = canFollow;
    onDetachRef.current = onDetach;
  });

  const setDetached = useCallback((next: boolean) => {
    if (next && !isDetachedRef.current) {
      onDetachRef.current?.();
    }
    isDetachedRef.current = next;
    setIsDetachedState(next);
    // Following pins the view itself, and browser scroll anchoring adjusting
    // the same position underneath it is what made growth look like a
    // scroll-up. Reading back still wants anchoring: rows above the viewport
    // settle from estimated to real heights and would shift the text.
    const container = scrollContainerRef.current;
    if (container) {
      container.style.overflowAnchor = next ? 'auto' : 'none';
    }
  }, [scrollContainerRef]);

  /** Writes a scroll position and records it, so its scroll event reads as no movement. */
  const writeScrollTop = useCallback((top: number) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = top;
    lastScrollTopRef.current = container.scrollTop;
  }, [scrollContainerRef]);

  /** Moves the view to the newest content, unless the user detached or another writer owns the scroll. */
  const pinToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || isDetachedRef.current || !canFollowRef.current()) return;

    if (Date.now() < smoothFollowUntilRef.current && typeof container.scrollTo === 'function') {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      return;
    }
    // Assigning scrollHeight lets the browser clamp to the real bottom.
    writeScrollTop(container.scrollHeight);
  }, [scrollContainerRef, writeScrollTop]);

  /** Re-attaches and glides to the newest message — the jump-to-latest pill. */
  const jumpToLatest = useCallback(() => {
    setDetached(false);
    const container = scrollContainerRef.current;
    if (!container) return;

    if (prefersReducedMotion() || typeof container.scrollTo !== 'function') {
      writeScrollTop(container.scrollHeight);
      return;
    }
    smoothFollowUntilRef.current = Date.now() + SMOOTH_FOLLOW_WINDOW_MS;
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, [scrollContainerRef, setDetached, writeScrollTop]);

  // Binds to whatever container/content elements are mounted. Checked on every
  // commit rather than once, because the transcript pane mounts after this hook
  // (ChatInterface renders nothing until a project is selected) and remounts
  // with the session.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const content = scrollContentRef.current;
    const bound = boundRef.current;
    if (bound?.container === container && bound?.content === content) return;

    bound?.unbind();
    boundRef.current = null;
    if (!container) return;

    const detachIfScrollable = (target: EventTarget | null) => {
      if (!isDetachedRef.current && canScroll(container) && !isInsideNestedScroller(target, container)) {
        setDetached(true);
      }
    };

    const handleScroll = () => {
      const top = container.scrollTop;
      const movedBy = top - lastScrollTopRef.current;
      lastScrollTopRef.current = top;

      const distanceFromBottom = container.scrollHeight - top - container.clientHeight;
      if (movedBy < -0.5 && distanceFromBottom > 1) {
        // Up, and not by us. Content shrinking under a pinned view also moves
        // it up, but the browser clamps that to the bottom, so it never lands
        // here.
        if (!isDetachedRef.current) setDetached(true);
      } else if (movedBy > 0.5 && distanceFromBottom <= REATTACH_DISTANCE_PX) {
        if (isDetachedRef.current) setDetached(false);
      }
    };

    // Intent events fire before the scroll they cause. Detaching here keeps a
    // resize-driven re-pin from landing between the gesture and its scroll
    // and snapping the view back down mid-stream.
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && !event.ctrlKey) detachIfScrollable(event.target);
    };
    const handleTouchStart = (event: TouchEvent) => {
      touchStartYRef.current = event.touches[0]?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const startY = touchStartYRef.current;
      const currentY = event.touches[0]?.clientY;
      if (startY !== null && currentY !== undefined && currentY - startY > TOUCH_DETACH_SLOP_PX) {
        detachIfScrollable(event.target);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      pointerInsideRef.current = event.target instanceof Node && container.contains(event.target);
    };
    // Opening a collapsed block (a diff, command output, a steps row) is
    // reading: re-pinning to the bottom as it grows would push the block the
    // user just opened up and out of view. The live steps row opts out with
    // `data-follow-on-expand` — it sits at the live end, so following it is
    // what the user wants. Capture phase, to read the state before the toggle.
    const handleClick = (event: MouseEvent) => {
      const toggle = event.target instanceof Element ? event.target.closest('[aria-expanded]') : null;
      if (
        toggle
        && container.contains(toggle)
        && toggle.getAttribute('aria-expanded') === 'false'
        && !toggle.hasAttribute('data-follow-on-expand')
      ) {
        detachIfScrollable(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const isScrollUpKey = SCROLL_UP_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey);
      if (!isScrollUpKey || event.defaultPrevented || isEditableTarget(event.target)) return;
      // Keys reach the body when nothing is focused, and every split pane
      // listens; only the transcript the user last pressed in owns them.
      const target = event.target instanceof Node ? event.target : null;
      const ownsKey = target !== null
        && (container.contains(target) || (target === document.body && pointerInsideRef.current));
      if (ownsKey) detachIfScrollable(null);
    };

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
        if (!canFollowRef.current()) return;
        if (isDetachedRef.current) {
          // Nothing left to read back through (the transcript shrank to fit).
          if (!canScroll(container)) setDetached(false);
          return;
        }
        pinToBottom();
      });
    resizeObserver?.observe(container);
    if (content) resizeObserver?.observe(content);

    container.style.overflowAnchor = isDetachedRef.current ? 'auto' : 'none';
    lastScrollTopRef.current = container.scrollTop;
    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('click', handleClick, true);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);

    boundRef.current = {
      container,
      content,
      unbind: () => {
        resizeObserver?.disconnect();
        container.removeEventListener('scroll', handleScroll);
        container.removeEventListener('wheel', handleWheel);
        container.removeEventListener('touchstart', handleTouchStart);
        container.removeEventListener('touchmove', handleTouchMove);
        container.removeEventListener('click', handleClick, true);
        document.removeEventListener('pointerdown', handlePointerDown, true);
        document.removeEventListener('keydown', handleKeyDown, true);
      },
    };
  });

  useEffect(() => () => {
    boundRef.current?.unbind();
    boundRef.current = null;
  }, []);

  return {
    isDetached,
    isDetachedRef,
    setDetached,
    writeScrollTop,
    pinToBottom,
    jumpToLatest,
  };
}
