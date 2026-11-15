import { useCallback, useRef, useState } from 'react';
import { Outlet } from 'react-router-dom';

import { ChatDrawer } from '@/modules/foreman-next/chat/ChatDrawer';
import { ForemanStatusProvider } from '@/modules/foreman-next/context/ForemanStatusProvider';
import { useChatShortcut } from '@/modules/foreman-next/hooks/useChatShortcut';
import { ConnectionBanner } from '@/modules/foreman-next/shell/ConnectionBanner';
import { ShellNav } from '@/modules/foreman-next/shell/ShellNav';
import { StatusStrip } from '@/modules/foreman-next/shell/StatusStrip';

/** Used by ForemanNextRoutes as the frame of every Foreman screen (wireframes §3): the status strip, the navigation, the screen itself and the chat drawer. */
export function ForemanShell() {
  // Whether the chat drawer is open. It sits over every screen, so it belongs to the shell and not to a route.
  const [chatOpen, setChatOpen] = useState(false);
  const chatButtonRef = useRef<HTMLButtonElement>(null);
  const toggleChat = useCallback(() => setChatOpen((open) => !open), []);
  const closeChat = useCallback(() => setChatOpen(false), []);
  useChatShortcut(toggleChat);

  return (
    <ForemanStatusProvider>
      <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
        <StatusStrip chatOpen={chatOpen} chatButtonRef={chatButtonRef} onToggleChat={toggleChat} />
        <ConnectionBanner />
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <ShellNav />
          <main className="min-w-0 flex-1 overflow-y-auto p-4">
            <Outlet />
          </main>
          {chatOpen ? <ChatDrawer returnFocusTo={chatButtonRef} onClose={closeChat} /> : null}
        </div>
      </div>
    </ForemanStatusProvider>
  );
}
