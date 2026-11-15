import { execFile, type ExecFileException } from 'node:child_process';
import { open, stat } from 'node:fs/promises';

import { redactSecrets } from '@/modules/foreman-next/foreman-next.redact.js';

/** The last lines of Foreman's service log, as text lines. */
export type ServiceLogSource = () => Promise<string[]>;

export const MAX_LOG_LINES = 400;
/** What one answer may weigh, and the longest line in it: a log with a runaway line cannot make the panel's answer large. */
export const MAX_LOG_BYTES = 64 * 1024;
const MAX_LINE_CHARS = 2000;
const JOURNAL_TIMEOUT_MS = 10_000;
/** More than `MAX_LOG_LINES` lines can come to: journalctl is stopped, not trusted, if it says more. */
const JOURNAL_MAX_BUFFER = 2 * 1024 * 1024;

/** Foreman's own log file, which a server started without its unit writes (`FOREMAN_NEXT_LOG_FILE`); a file that is not there yet is an empty log. */
function fileLog(file: string): ServiceLogSource {
  return async () => {
    try {
      const { size } = await stat(file);
      const handle = await open(file, 'r');
      try {
        const length = Math.min(size, MAX_LOG_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        const lines = buffer.toString('utf8').split('\n');
        // The tail starts wherever the byte count fell, so its first line may be the end of one: a piece of a token is not shown.
        return length < size ? lines.slice(1) : lines;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
  };
}

const noJournal = (why: string): string[] => [`No journal is available: ${why}`];

/** Why journalctl gave nothing, in a sentence the panel shows as it is: never an empty log that looks like a quiet Foreman. */
function whyNoJournal(error: ExecFileException, stderr: string): string {
  if (error.code === 'ENOENT') return 'journalctl is not installed here.';
  if (error.killed === true) return 'journalctl did not answer in time.';
  const said = stderr.trim().split('\n')[0] ?? '';
  return typeof error.code === 'number' ? `journalctl failed (exit ${error.code})${said === '' ? '' : `: ${said.slice(0, 200)}`}.` : 'journalctl could not be run.';
}

/** The user journal of one unit, read by journalctl itself and spawned without a shell: no argument can become a command. */
function journalLog(command: string, unit: string): ServiceLogSource {
  const args = ['--user', '--unit', unit, '--lines', String(MAX_LOG_LINES), '--no-pager', '--quiet', '--no-hostname', '--output', 'short-iso'];
  return () =>
    new Promise((resolve) => {
      execFile(command, args, { timeout: JOURNAL_TIMEOUT_MS, maxBuffer: JOURNAL_MAX_BUFFER, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
        if (error !== null) return resolve(noJournal(whyNoJournal(error, stderr)));
        const lines = stdout.split('\n').filter((line) => line !== '');
        resolve(lines.length > 0 ? lines : noJournal(`the journal holds nothing for ${unit}: no user journal is kept here, or it has not logged.`));
      });
    });
}

/** The newest lines that fit, whole: at most `MAX_LOG_LINES` of them and `MAX_LOG_BYTES` in all, each cut at `MAX_LINE_CHARS`. */
function newest(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines.filter((each) => each !== '').slice(-MAX_LOG_LINES).reverse()) {
    const text = line.slice(0, MAX_LINE_CHARS);
    size += text.length + 1;
    if (size > MAX_LOG_BYTES) break;
    kept.push(text);
  }
  return kept.reverse();
}

export interface ServiceLogConfig {
  /** `FOREMAN_NEXT_LOG_FILE`: a Foreman that is not the unit (a test instance's) logs to a file, and the journal would show the other one. */
  file: string | undefined;
  journalCommand: string;
  unit: string;
  /** The exact values to take out of every line, read when asked so a rotated token is covered at once. */
  secrets: () => Promise<string[]>;
}

/** What `/service-log` answers: the last lines of Foreman's log from its file or its unit's journal, capped, with every credential taken out before the browser sees one. */
export function createServiceLog(config: ServiceLogConfig): ServiceLogSource {
  const read = config.file === undefined ? journalLog(config.journalCommand, config.unit) : fileLog(config.file);
  return async () => {
    const secrets = await config.secrets();
    return newest((await read()).map((line) => redactSecrets(line, secrets)));
  };
}
