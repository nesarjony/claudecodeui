import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

type JumpToLatestPillProps = {
  /** Rows that arrived since the user scrolled away; 0 renders a plain arrow. */
  newMessageCount: number;
  /** Lift the pill clear of the composer's floating activity tab while it shows. */
  isRaised: boolean;
  onJumpToLatest: () => void;
};

/**
 * Rendered by chat's ChatInterface above the composer while the transcript is
 * detached from its live end: "↓ 3 new" once rows arrive below, a plain "↓"
 * before that. Tapping it glides back down and resumes following.
 *
 * Centered and lifted above the composer rather than pinned to a corner, so on
 * a phone it never sits on the send button or the activity tab's Stop control.
 */
export default function JumpToLatestPill({ newMessageCount, isRaised, onJumpToLatest }: JumpToLatestPillProps) {
  const { t } = useTranslation('chat');
  const hasNewMessages = newMessageCount > 0;
  const label = hasNewMessages
    ? t('input.newMessagesBelow', { count: newMessageCount, defaultValue: '{{count}} new messages below — jump to latest' })
    : t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' });

  return (
    <div
      className={`pointer-events-none absolute bottom-full left-1/2 z-20 -translate-x-1/2 ${
        isRaised ? 'mb-11' : 'mb-3'
      }`}
    >
      <button
        type="button"
        onClick={onJumpToLatest}
        aria-label={label}
        title={label}
        // The entry animation sits here rather than on the wrapper, whose
        // centering transform the animation's own transform would replace.
        className={`chat-row-enter pointer-events-auto flex h-9 items-center justify-center gap-1.5 rounded-full border border-border bg-card/95 text-foreground shadow-md backdrop-blur-sm transition-colors duration-150 hover:bg-accent active:bg-accent ${
          hasNewMessages ? 'px-3.5 text-xs font-medium' : 'w-9 text-muted-foreground'
        }`}
      >
        <ArrowDownIcon className="h-4 w-4 flex-shrink-0" aria-hidden />
        {hasNewMessages && (
          <span className="whitespace-nowrap tabular-nums">
            {t('input.newMessages', { count: newMessageCount, defaultValue: '{{count}} new' })}
          </span>
        )}
      </button>
    </div>
  );
}
