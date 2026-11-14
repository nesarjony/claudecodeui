import { useEffect } from 'react';

/** Used by ForemanShell to open and close the chat drawer with ⌘J (Ctrl+J elsewhere) from any screen. */
export function useChatShortcut(onToggle: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        onToggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onToggle]);
}
