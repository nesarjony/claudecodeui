import { useEffect } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Tab skips the unchecked radios of a group that has a checked one, so they are not the end of the tab order.
const isTabbable = (element: HTMLElement, all: HTMLElement[]): boolean =>
  !(element instanceof HTMLInputElement && element.type === 'radio' && !element.checked && all.some((other) => other instanceof HTMLInputElement && other.type === 'radio' && other.name === element.name && other.checked));

/** Used by the chat drawer while it covers the screen: Tab and Shift+Tab cycle inside it, and focus that has left it is brought back. */
export function useFocusTrap(container: RefObject<HTMLElement>, active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !container.current) return;
      const all = Array.from(container.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      const tabbable = all.filter((element) => isTabbable(element, all));
      const first = tabbable[0];
      const last = tabbable[tabbable.length - 1];
      if (!first || !last) return;
      const outside = !container.current.contains(document.activeElement);
      if (outside || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [container, active]);
}
