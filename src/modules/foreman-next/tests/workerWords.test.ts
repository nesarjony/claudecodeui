import { describe, expect, it } from 'vitest';

import { splitWorkerWords } from '@/modules/foreman-next/utils/workerWords';

const LEAD = 'Its worker slot is free for the other goals, and what it committed is kept.';
const marked = (words: string) => `${LEAD}\n\nThe worker's last message, in its own words (quoted, not Foreman's): "${words}"`;

describe('the worker\'s words in a question\'s context', () => {
  it('are split from what Foreman says, without the marker sentence or the quotation marks', () => {
    expect(splitWorkerWords(marked('I will wait for the migration.'))).toEqual({ lead: LEAD, workerSaid: 'I will wait for the migration.' });
  });

  it('keep their own line breaks, quotation marks and the clip, and are whatever the worker wrote', () => {
    const words = 'Done with "step 1".\nNow step 2 <b>not bold</b> & more…';
    expect(splitWorkerWords(marked(words))).toEqual({ lead: LEAD, workerSaid: words });
  });

  it('are found when the context is nothing but the quote, and when the sentence is worded a little differently or uses a curly apostrophe', () => {
    expect(splitWorkerWords(`The worker's last message, in its own words (quoted, not Foreman's): "hello"`)).toEqual({ lead: '', workerSaid: 'hello' });
    expect(splitWorkerWords('The worker’s last message (quoted): "hello"')).toEqual({ lead: '', workerSaid: 'hello' });
  });

  it('are none in a context that does not quote a worker, which is shown whole', () => {
    expect(splitWorkerWords('Libredesk lists bulk assign.\n\nRows 88-94 depend on it.')).toEqual({ lead: 'Libredesk lists bulk assign.\n\nRows 88-94 depend on it.', workerSaid: null });
    expect(splitWorkerWords('')).toEqual({ lead: '', workerSaid: null });
  });

  it('are none when the marker has nothing after it, or its quote is never opened, and the text is still shown', () => {
    const empty = marked('   ');
    expect(splitWorkerWords(empty)).toEqual({ lead: empty.trim(), workerSaid: null });
    const open = `${LEAD}\n\nThe worker's last message, in its own words (quoted, not Foreman's): it said nothing`;
    expect(splitWorkerWords(open)).toEqual({ lead: open.trim(), workerSaid: null });
  });

  it('are none for a context that is not text', () => {
    for (const value of [undefined, null, 42, {}]) expect(splitWorkerWords(value)).toEqual({ lead: '', workerSaid: null });
  });
});
