import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ChatProposal } from '@/modules/foreman-next/api/contract';
import { ChatMessageItem } from '@/modules/foreman-next/chat/ChatMessageItem';
import { quickApi, renderWithForeman } from '@/modules/foreman-next/tests/testHelpers';

// `state` is typed 'open' | 'confirmed'; the backend also sends 'expired' and may add more, so the tests pass states the type does not know.
const message = (state: string): ChatMessage => ({
  id: 'm-1',
  role: 'foreman',
  at: '2026-11-18T09:00:00.000Z',
  text: 'I can stop that run.',
  evidence: [],
  actions: null,
  proposals: [{ id: 'p-1', kind: 'stop-run', summary: 'Stop run t2-layout', state } as unknown as ChatProposal],
  remembered: null,
});

const renderItem = (state: string) => {
  const api = quickApi();
  const confirm = vi.spyOn(api, 'confirmChatProposal');
  renderWithForeman(
    <ul>
      <ChatMessageItem message={message(state)} />
    </ul>,
    { api },
  );
  return confirm;
};

describe('a proposal in a chat message', () => {
  it('has a Confirm button while it is open, and pressing it confirms the proposal', () => {
    const confirm = renderItem('open');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(confirm).toHaveBeenCalledWith('p-1');
  });

  it('shows Confirmed, without the button, once it is confirmed', () => {
    renderItem('confirmed');
    expect(screen.getByText('Confirmed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('shows Expired, without the Confirm button, when it has expired', () => {
    const confirm = renderItem('expired');
    expect(screen.getByText('Stop run t2-layout')).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('hides the button and shows the state text for a state it does not know, so a future state cannot bring the bug back', () => {
    renderItem('superseded');
    expect(screen.getByText('superseded')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('hides the button when the state is missing', () => {
    const missing = message('open');
    delete (missing.proposals[0] as Partial<ChatProposal>).state;
    renderWithForeman(
      <ul>
        <ChatMessageItem message={missing} />
      </ul>,
    );
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });
});
