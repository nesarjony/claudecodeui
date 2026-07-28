import { spawn } from 'child_process';

import express from 'express';

import { quickCommandsDb } from '../modules/database/index.js';

const router = express.Router();

const MODEL_MAP = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' };

// ---- Commands CRUD --------------------------------------------------------
router.get('/', (req, res) => {
  try {
    res.json({
      commands: quickCommandsDb.list(req.user.id),
      settings: quickCommandsDb.getSettings(req.user.id),
    });
  } catch (error) {
    console.error('Error listing quick commands:', error);
    res.status(500).json({ error: 'Failed to list quick commands' });
  }
});

router.post('/', (req, res) => {
  try {
    const { label, body, emoji, trigger_state, pinned, prompt } = req.body || {};
    const hasBody = body && body.trim();
    const hasPrompt = prompt && prompt.trim();
    if (!label || !label.trim() || (!hasBody && !hasPrompt)) {
      return res.status(400).json({ error: 'label and (body or prompt) are required' });
    }
    const command = quickCommandsDb.create(
      req.user.id,
      label.trim(),
      body || '',
      emoji && emoji.trim() ? emoji.trim() : null,
      trigger_state || null,
      pinned ? 1 : 0,
      hasPrompt ? prompt : null
    );
    res.json({ success: true, command });
  } catch (error) {
    console.error('Error creating quick command:', error);
    res.status(500).json({ error: 'Failed to create quick command' });
  }
});

// ---- Settings (declare before '/:id') -------------------------------------
router.get('/settings', (req, res) => {
  try {
    res.json({ settings: quickCommandsDb.getSettings(req.user.id) });
  } catch (error) {
    console.error('Error reading quick command settings:', error);
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

router.put('/settings', (req, res) => {
  try {
    const { mode, model, send_mode } = req.body || {};
    if (mode && !['off', 'heuristic', 'llm'].includes(mode)) {
      return res.status(400).json({ error: 'invalid mode' });
    }
    if (model && !MODEL_MAP[model]) {
      return res.status(400).json({ error: 'invalid model' });
    }
    if (send_mode && !['insert', 'direct'].includes(send_mode)) {
      return res.status(400).json({ error: 'invalid send_mode' });
    }
    const settings = quickCommandsDb.saveSettings(req.user.id, { mode, model, send_mode });
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Error saving quick command settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

router.put('/reorder', (req, res) => {
  try {
    const { orderedIds } = req.body || {};
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'orderedIds must be an array' });
    }
    quickCommandsDb.reorder(req.user.id, orderedIds.map(Number));
    res.json({ success: true });
  } catch (error) {
    console.error('Error reordering quick commands:', error);
    res.status(500).json({ error: 'Failed to reorder quick commands' });
  }
});

// ---- Smart Suggest LLM refine (opt-in; native `claude -p`) -----------------
// Only ever invoked when the user has set mode='llm'. Uses the patched claude
// binary -> claude-cap proxy (first-party). Model picks the wallet:
// opus/sonnet -> Claude plan, haiku -> MiniMax.
router.post('/suggest', (req, res) => {
  try {
    const settings = quickCommandsDb.getSettings(req.user.id);
    if (settings.mode !== 'llm') {
      return res.status(409).json({ error: 'LLM suggest is disabled' });
    }
    const { agentText } = req.body || {};
    if (!agentText || !String(agentText).trim()) {
      return res.status(400).json({ error: 'agentText required' });
    }
    const commands = quickCommandsDb.list(req.user.id);
    if (commands.length === 0) return res.json({ rankedIds: [] });

    const list = commands
      .map((c) => `${c.id}: ${c.label} -> ${c.body.slice(0, 120)}`)
      .join('\n');
    const prompt =
      'You pick which saved quick-command a developer should send next to their coding agent. ' +
      'Given the agent\'s last message and the list of commands, return STRICT JSON ' +
      '{"rankedIds":[<command ids, best first, max 3>]}. No prose.\n\n' +
      `COMMANDS:\n${list}\n\nAGENT LAST MESSAGE:\n${String(agentText).slice(0, 2000)}`;

    const bin = process.env.CLAUDE_CLI_PATH || 'claude';
    const model = MODEL_MAP[settings.model] || 'haiku';
    const child = spawn(bin, ['-p', '--model', model, '--output-format', 'json', prompt], {
      env: process.env,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const envelope = JSON.parse(out);
        const raw = (envelope.result || '').replace(/<think>[\s\S]*?<\/think>/g, '');
        const match = raw.match(/\{[\s\S]*\}/);
        const parsed = match ? JSON.parse(match[0]) : { rankedIds: [] };
        const valid = new Set(commands.map((c) => c.id));
        const rankedIds = (parsed.rankedIds || [])
          .map(Number)
          .filter((id) => valid.has(id))
          .slice(0, 3);
        res.json({ rankedIds });
      } catch (e) {
        console.error('suggest parse failed:', e, err.slice(0, 300));
        res.status(502).json({ error: 'suggest failed', rankedIds: [] });
      }
    });
  } catch (error) {
    console.error('Error in suggest:', error);
    res.status(500).json({ error: 'Failed to suggest' });
  }
});

// Run a command's custom prompt against the agent's last message (native
// `claude -p`, first-party). Only for commands that carry a prompt.
router.post('/:id/run', (req, res) => {
  try {
    const command = quickCommandsDb
      .list(req.user.id)
      .find((c) => c.id === Number(req.params.id));
    if (!command) return res.status(404).json({ error: 'Not found' });
    if (!command.prompt) return res.status(400).json({ error: 'command has no prompt' });
    const settings = quickCommandsDb.getSettings(req.user.id);
    const { agentText } = req.body || {};
    const composed =
      command.prompt +
      '\n\n--- AGENT LAST MESSAGE ---\n' +
      String(agentText || '(no recent agent message)').slice(0, 4000);
    const bin = process.env.CLAUDE_CLI_PATH || 'claude';
    const model = MODEL_MAP[settings.model] || 'haiku';
    const child = spawn(bin, ['-p', '--model', model, '--output-format', 'json', composed], {
      env: process.env,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const envelope = JSON.parse(out);
        const text = (envelope.result || '')
          .replace(/<think>[\s\S]*?<\/think>/g, '')
          .trim();
        res.json({ text });
      } catch (e) {
        console.error('run parse failed:', e, err.slice(0, 300));
        res.status(502).json({ error: 'run failed' });
      }
    });
  } catch (error) {
    console.error('Error in run:', error);
    res.status(500).json({ error: 'Failed to run' });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { label, body, emoji, trigger_state, pinned, prompt } = req.body || {};
    const command = quickCommandsDb.update(req.user.id, Number(req.params.id), {
      label,
      body,
      emoji,
      trigger_state,
      pinned: pinned === undefined ? undefined : pinned ? 1 : 0,
      prompt: prompt === undefined ? undefined : prompt && prompt.trim() ? prompt : null,
    });
    if (!command) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, command });
  } catch (error) {
    console.error('Error updating quick command:', error);
    res.status(500).json({ error: 'Failed to update quick command' });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const ok = quickCommandsDb.remove(req.user.id, Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting quick command:', error);
    res.status(500).json({ error: 'Failed to delete quick command' });
  }
});

export default router;
