import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { questionsFixture } from '@/modules/foreman-next/api/mock/decideFixtures';
import { QuestionRecommendation, shownConfidence } from '@/modules/foreman-next/decide/QuestionRecommendation';
import { renderWithForeman } from '@/modules/foreman-next/tests/testHelpers';

const recommendation = () => {
  const [first] = questionsFixture(Date.now());
  if (!first?.recommendation) throw new Error('fixture has no recommendation');
  return first.recommendation;
};

const section = () => screen.getByRole('region', { name: 'Recommendation' });

describe('the confidence in a recommendation', () => {
  it('shows a stated confidence to one decimal', () => {
    renderWithForeman(<QuestionRecommendation recommendation={{ ...recommendation(), confidence: 0.7 }} />);
    expect(screen.getByText('confidence 0.7')).toBeTruthy();
  });

  it('shows a stated confidence of zero', () => {
    renderWithForeman(<QuestionRecommendation recommendation={{ ...recommendation(), confidence: 0 }} />);
    expect(screen.getByText('confidence 0.0')).toBeTruthy();
  });

  it.each([
    ['null (nobody stated one)', null],
    ['undefined (the field is missing)', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '0.7' as unknown as number],
  ])('shows nothing, not even a placeholder, when it is %s', (_name, confidence) => {
    renderWithForeman(<QuestionRecommendation recommendation={{ ...recommendation(), confidence }} />);
    expect(screen.queryByText(/confidence/)).toBeNull();
    expect(section().textContent).not.toMatch(/NaN|null|undefined|Infinity/);
    expect(screen.getByText('Foreman recommends A')).toBeTruthy();
    expect(screen.getByText(/parity first, defer nothing visible/)).toBeTruthy();
  });

  it('still renders when the reason and the similar decisions are missing', () => {
    const thin = { optionId: 'A', confidence: null } as unknown as Parameters<typeof QuestionRecommendation>[0]['recommendation'];
    renderWithForeman(<QuestionRecommendation recommendation={thin} />);
    expect(screen.getByText('Foreman recommends A')).toBeTruthy();
    expect(screen.queryByText(/similar decision/)).toBeNull();
  });

  it('formats only finite numbers', () => {
    expect(shownConfidence(0.66)).toBe('0.7');
    expect(shownConfidence(1)).toBe('1.0');
    expect(shownConfidence(null)).toBeNull();
    expect(shownConfidence(undefined)).toBeNull();
    expect(shownConfidence(Number.NaN)).toBeNull();
    expect(shownConfidence(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(shownConfidence('0.7')).toBeNull();
  });
});
