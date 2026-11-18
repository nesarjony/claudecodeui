import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OwnerQuestion } from '@/modules/foreman-next/api/contract';
import { questionsFixture } from '@/modules/foreman-next/api/mock/decideFixtures';
import { NeedsYouTab } from '@/modules/foreman-next/decide/NeedsYouTab';
import { quickApi, renderWithForeman } from '@/modules/foreman-next/tests/testHelpers';

const good = (): OwnerQuestion => {
  const [first] = questionsFixture(Date.now());
  if (!first) throw new Error('fixture is empty');
  return first;
};

// A question whose options are not a list: the card throws while rendering it.
const malformed = (): OwnerQuestion => ({ ...good(), id: 'q-broken', title: 'Broken question', options: null as unknown as OwnerQuestion['options'] });

const renderList = (questions: unknown[]) => {
  const api = quickApi();
  vi.spyOn(api, 'questions').mockResolvedValue(questions as OwnerQuestion[]);
  return renderWithForeman(<NeedsYouTab />, { api });
};

describe('the Needs you list when a question is malformed', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says that one question could not be displayed, with its id, and still shows the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderList([malformed(), good()]);
    expect(await screen.findByText('This question could not be displayed')).toBeTruthy();
    expect(screen.getByText('Question q-broken')).toBeTruthy();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    const card = screen.getByRole('article', { name: 'Bulk actions in v1?' });
    expect(within(card).getByText('Foreman recommends A')).toBeTruthy();
  });

  it('survives an entry that is not a question at all', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderList([null, good()]);
    expect(await screen.findByText('This question could not be displayed')).toBeTruthy();
    expect(screen.getByText('Question ?')).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Bulk actions in v1?' })).toBeTruthy();
  });

  it('shows a recommendation with no stated confidence, as every gate and approval question has', async () => {
    const gate = { ...good(), recommendation: { ...(good().recommendation as NonNullable<OwnerQuestion['recommendation']>), confidence: null } };
    renderList([gate]);
    const card = await screen.findByRole('article', { name: 'Bulk actions in v1?' });
    expect(within(card).getByText('Foreman recommends A')).toBeTruthy();
    expect(within(card).queryByText(/confidence/)).toBeNull();
    expect(screen.queryByText('This question could not be displayed')).toBeNull();
  });
});
