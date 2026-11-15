import { open, stat } from 'node:fs/promises';

const TAIL_BYTES = 64 * 1024;
const MAX_LINES = 400;

/** The last lines of Foreman's service log: cloudcli reads the file itself, so the owner can read why Foreman is not answering when it is not. */
export async function readServiceLog(file: string | undefined): Promise<string[]> {
  if (file === undefined) return [];
  try {
    const { size } = await stat(file);
    const handle = await open(file, 'r');
    try {
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n').filter((line) => line !== '');
      return lines.slice(-MAX_LINES);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
