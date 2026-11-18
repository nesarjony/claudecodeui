import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { questionsFixture } from '@/modules/foreman-next/api/mock/decideFixtures';
import { QuestionCard } from '@/modules/foreman-next/decide/QuestionCard';
import { quickApi, renderForemanApp, renderWithForeman } from '@/modules/foreman-next/tests/testHelpers';

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

describe('the worker-stalled question (Needs you)', () => {
  const stalled = () => {
    const found = quickApi('worker-stalled');
    return found.questions().then((questions) => {
      const [first] = questions.filter((candidate) => candidate.id === 'worker-stalled:run-t2');
      if (!first) throw new Error('the scenario has the question');
      return first;
    });
  };

  it('shows what the worker said, marked as the worker\'s and apart from what Foreman says, with its line breaks', async () => {
    renderWithForeman(<QuestionCard question={await stalled()} />);
    const card = screen.getByRole('article', { name: /The worker on batch t2-layout .* was stopped\. Try the batch again\?/ });
    expect(within(card).getByText(/It went 10 turns without a commit after it was told what to do/)).toBeTruthy();
    expect(within(card).getByText('Worker said')).toBeTruthy();
    expect(within(card).getByText("in its own words, not Foreman's")).toBeTruthy();
    const quote = card.querySelector('blockquote');
    expect(quote?.textContent).toBe('I will wait for the migration to finish before I touch InboxLayout.\nThen I will carry on with the header rows.');
    expect(card.textContent).not.toMatch(/The worker's last message/);
  });

  it('shows the worker\'s words as plain text, whatever they hold', async () => {
    const question = await stalled();
    renderWithForeman(<QuestionCard question={{ ...question, context: `It stopped.\n\nThe worker's last message, in its own words (quoted, not Foreman's): "<img src=x onerror=alert(1)> **bold** & \\"quoted\\"…"` }} />);
    const quote = document.querySelector('blockquote');
    expect(quote?.textContent).toBe('<img src=x onerror=alert(1)> **bold** & \\"quoted\\"…');
    expect(quote?.querySelector('img')).toBeNull();
  });

  it('renders every option Foreman sends, with its label in the table and on its button, whatever ids it names them by', async () => {
    renderWithForeman(<QuestionCard question={await stalled()} />);
    const table = screen.getByRole('table');
    for (const label of ['Try the batch again', 'Pause the goal', 'Close the goal']) expect(within(table).getByText(label)).toBeTruthy();
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    const answers = screen.getByRole('toolbar', { name: 'Answer' });
    expect(within(answers).getAllByRole('button').map((button) => button.textContent)).toEqual(['Try the batch again', 'Pause the goal', 'Close the goal']);
    expect(within(answers).getByRole('button', { name: 'go: Try the batch again' })).toBeTruthy();
    expect(within(table).getByText('recommended')).toBeTruthy();
  });

  it('answers with the option\'s id, which is what Foreman reads, not its label', async () => {
    const api = quickApi('worker-stalled');
    const answer = vi.spyOn(api, 'answerQuestion');
    const question = await stalled();
    renderWithForeman(<QuestionCard question={question} />, { api });
    fireEvent.click(screen.getByRole('button', { name: 'pause: Pause the goal' }));
    await waitFor(() => expect(answer).toHaveBeenCalledOnce());
    expect(answer).toHaveBeenCalledWith('worker-stalled:run-t2', { optionId: 'pause', reply: null, remember: 'repo', delegate: false });
  });

  it('keeps a letter on the button for options named by letters, as before', () => {
    renderWithForeman(<QuestionCard question={question()} />);
    expect(within(screen.getByRole('toolbar', { name: 'Answer' })).getAllByRole('button').map((button) => button.textContent)).toEqual(['A', 'B', 'C']);
  });

  it('copes with a context that says nothing of a worker, with no options, and with a recommendation that is empty', async () => {
    const base = await stalled();
    renderWithForeman(<QuestionCard question={{ ...base, context: 'Foreman cannot read the repo.', options: [], recommendation: { optionId: 'go', confidence: null, reason: '', similar: [] } }} />);
    expect(screen.getByText('Foreman cannot read the repo.')).toBeTruthy();
    expect(screen.queryByText('Worker said')).toBeNull();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});

describe('the Needs you list with a worker-stalled question', () => {
  it('lists it with the others, the one that holds the most rows first, and shows what the worker said', async () => {
    renderForemanApp('/foreman/decide/needs', quickApi('worker-stalled'));
    const cards = await screen.findAllByRole('article');
    expect(cards).toHaveLength(3);
    const stalledCard = cards.find((card) => card.textContent?.includes('Worker said'));
    expect(stalledCard).toBeTruthy();
    expect(within(stalledCard as HTMLElement).getByText(/I will wait for the migration/)).toBeTruthy();
    expect(within(stalledCard as HTMLElement).getByRole('button', { name: 'close: Close the goal' })).toBeTruthy();
  });
});
