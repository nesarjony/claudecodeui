import { spawn } from 'node:child_process';

import { quickCommandsDb } from '@/modules/database/index.js';

const MODEL_VALUES = new Set(['haiku', 'sonnet', 'opus']);
const MODE_VALUES = new Set(['off', 'heuristic', 'llm']);
const SEND_MODE_VALUES = new Set(['insert', 'direct']);

function runClaudePrompt(prompt: string, model: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const executable = process.env.CLAUDE_CLI_PATH || 'claude';
    const child = spawn(executable, ['-p', '--model', model, '--output-format', 'json', prompt], {
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const envelope = JSON.parse(stdout) as { result?: unknown };
        resolve(String(envelope.result ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim());
      } catch {
        reject(new Error(`Quick command model returned invalid JSON: ${stderr.slice(0, 300)}`));
      }
    });
  });
}

/** Used by the Quick Commands routes to orchestrate persistence and optional model-assisted suggestions. */
export const quickCommandsService = {
  list(userId: number) {
    return {
      commands: quickCommandsDb.list(userId),
      settings: quickCommandsDb.getSettings(userId),
    };
  },

  create(userId: number, label: string, body: string, emoji: string | null, triggerState: string | null, pinned: boolean, prompt: string | null) {
    return quickCommandsDb.create(userId, label, body, emoji, triggerState, pinned ? 1 : 0, prompt);
  },

  update(userId: number, id: number, fields: Parameters<typeof quickCommandsDb.update>[2]) {
    return quickCommandsDb.update(userId, id, fields);
  },

  remove(userId: number, id: number) {
    return quickCommandsDb.remove(userId, id);
  },

  reorder(userId: number, orderedIds: number[]) {
    quickCommandsDb.reorder(userId, orderedIds);
  },

  saveSettings(userId: number, fields: { mode?: string; model?: string; send_mode?: string }) {
    if (fields.mode && !MODE_VALUES.has(fields.mode)) throw new Error('invalid mode');
    if (fields.model && !MODEL_VALUES.has(fields.model)) throw new Error('invalid model');
    if (fields.send_mode && !SEND_MODE_VALUES.has(fields.send_mode)) throw new Error('invalid send_mode');
    return quickCommandsDb.saveSettings(userId, fields);
  },

  async suggest(userId: number, agentText: string) {
    const settings = quickCommandsDb.getSettings(userId);
    if (settings.mode !== 'llm') throw new Error('LLM suggest is disabled');
    const commands = quickCommandsDb.list(userId);
    if (commands.length === 0) return [];
    const commandList = commands.map((command) => `${command.id}: ${command.label} -> ${command.body.slice(0, 120)}`).join('\n');
    const prompt = `Pick the best saved quick commands to send next. Return strict JSON {"rankedIds":[<up to 3 ids>]} and no prose.\n\nCOMMANDS:\n${commandList}\n\nAGENT LAST MESSAGE:\n${agentText.slice(0, 2000)}`;
    const raw = await runClaudePrompt(prompt, settings.model || 'haiku', 30_000);
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match?.[0] ?? '{"rankedIds":[]}') as { rankedIds?: unknown[] };
    const validIds = new Set(commands.map((command) => command.id));
    return (parsed.rankedIds ?? []).map(Number).filter((id) => validIds.has(id)).slice(0, 3);
  },

  async run(userId: number, id: number, agentText: string) {
    const command = quickCommandsDb.list(userId).find((candidate) => candidate.id === id);
    if (!command) throw new Error('Quick command not found');
    if (!command.prompt) throw new Error('Quick command has no prompt');
    const settings = quickCommandsDb.getSettings(userId);
    return runClaudePrompt(`${command.prompt}\n\n--- AGENT LAST MESSAGE ---\n${agentText.slice(0, 4000)}`, settings.model || 'haiku', 45_000);
  },
};
