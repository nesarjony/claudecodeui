// How Foreman marks a worker's words inside a question's `context` (the worker-stalled question): its own sentence, then the words in quotation marks, clipped, last in the text.
// The marker is matched loosely (from "The worker's last message" to the first `: "`), so a rewording after it still finds the quote; text that does not match is shown whole.
const WORKER_WORDS = /(?:^|\n\n)The worker['’]s last message[^\n"]*?:\s*"([\s\S]*)"\s*$/;

/** A question's context cut into what Foreman says and what the worker said, which is shown apart and marked as the worker's; `workerSaid` is null when the context quotes no worker. */
export function splitWorkerWords(context: unknown): { lead: string; workerSaid: string | null } {
  const text = typeof context === 'string' ? context : '';
  const match = WORKER_WORDS.exec(text);
  const said = match?.[1]?.trim() ?? '';
  if (!match || said === '') return { lead: text.trim(), workerSaid: null };
  return { lead: text.slice(0, match.index).trim(), workerSaid: said };
}
