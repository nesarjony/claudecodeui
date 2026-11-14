import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { questionsFixture } from '@/modules/foreman-next/api/mock/decideFixtures';
import { QuestionCard } from '@/modules/foreman-next/decide/QuestionCard';
import { quickApi, renderWithForeman } from '@/modules/foreman-next/tests/testHelpers';

const question = () => {
  const [first] = questionsFixture(Date.now());
  if (!first) throw new Error('fixture is empty');
  return first;
};

describe('the decision card (Needs you)', () => {
  it('lays out what the owner needs to decide in one view', () => {
    renderWithForeman(<QuestionCard question={question()} />);
    const card = screen.getByRole('article', { name: 'Bulk actions in v1?' });
    expect(within(card).getByText(/Why it's yours: product scope questions are set to "Ask me"/)).toBeTruthy();
    expect(within(card).getByText(/Libredesk's list supports bulk assign/)).toBeTruthy();
    expect(within(card).getAllByRole('row')).toHaveLength(4);
    expect(within(card).getByText('Foreman recommends A')).toBeTruthy();
    expect(within(card).getByText('confidence 0.7')).toBeTruthy();
    expect(within(card).getByText(/t3-bulk stays held/)).toBeTruthy();
    expect(within(card).getByText(/similar decisions \(3\)/)).toBeTruthy();
  });

  it('answers with one tap, saving the answer as a rule for the repo by default', async () => {
    const api = quickApi();
    const answer = vi.spyOn(api, 'answerQuestion');
    renderWithForeman(<QuestionCard question={question()} />, { api });
    fireEvent.click(screen.getByRole('button', { name: 'A: All three: assign, close, tag' }));
    await waitFor(() => expect(answer).toHaveBeenCalledOnce());
    expect(answer).toHaveBeenCalledWith('q-bulk', { optionId: 'A', reply: null, remember: 'repo', delegate: false });
  });

  it('sends the rule scope and the trust-ladder step the owner chose', async () => {
    const api = quickApi();
    const answer = vi.spyOn(api, 'answerQuestion');
    renderWithForeman(<QuestionCard question={question()} />, { api });
    fireEvent.click(screen.getByLabelText('this goal'));
    fireEvent.click(screen.getByLabelText(/Let Foreman decide product scope questions like this one/));
    fireEvent.click(screen.getByRole('button', { name: 'B: Assign and close; tag later' }));
    await waitFor(() => expect(answer).toHaveBeenCalled());
    expect(answer).toHaveBeenCalledWith('q-bulk', { optionId: 'B', reply: null, remember: 'goal', delegate: true });
  });

  it('does not save a rule when "Remember as a rule" is unchecked, and disables the scope choices', async () => {
    const api = quickApi();
    const answer = vi.spyOn(api, 'answerQuestion');
    renderWithForeman(<QuestionCard question={question()} />, { api });
    fireEvent.click(screen.getByLabelText('Remember as a rule'));
    expect(screen.getByLabelText('this goal').matches(':disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'C: None in v1' }));
    await waitFor(() => expect(answer).toHaveBeenCalled());
    expect(answer).toHaveBeenCalledWith('q-bulk', { optionId: 'C', reply: null, remember: null, delegate: false });
  });

  it('answers in words when the owner types a reply', async () => {
    const api = quickApi();
    const answer = vi.spyOn(api, 'answerQuestion');
    renderWithForeman(<QuestionCard question={question()} />, { api });
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('or reply:'), { target: { value: 'A, but tag only for admins' } });
    fireEvent.click(send);
    await waitFor(() => expect(answer).toHaveBeenCalled());
    expect(answer).toHaveBeenCalledWith('q-bulk', { optionId: null, reply: 'A, but tag only for admins', remember: 'repo', delegate: false });
  });

  it('moves between the answer buttons with the arrow keys, wrapping at the ends', () => {
    renderWithForeman(<QuestionCard question={question()} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Answer' });
    const [a, b, c] = within(toolbar).getAllByRole('button');
    a?.focus();
    fireEvent.keyDown(toolbar, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(toolbar, { key: 'ArrowLeft' });
    fireEvent.keyDown(toolbar, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(c);
  });

  it('keeps the card and says so when the answer does not go through', async () => {
    const api = quickApi();
    vi.spyOn(api, 'answerQuestion').mockRejectedValue(new Error('down'));
    renderWithForeman(<QuestionCard question={question()} />, { api });
    fireEvent.click(screen.getByRole('button', { name: /^A:/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('lists the similar past decisions behind the recommendation', () => {
    renderWithForeman(<QuestionCard question={question()} />);
    fireEvent.click(screen.getByText(/similar decisions \(3\)/));
    expect(screen.getByText(/Parity first: defer nothing visible · Full option/)).toBeTruthy();
  });
});
