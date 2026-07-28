/**
 * Quick commands repository.
 *
 * Per-user saved chat snippets ("quick commands") the user inserts into the
 * composer, plus per-user Smart Suggest settings.
 */

import { getConnection } from '@/modules/database/connection.js';

export type QuickCommandRow = {
  id: number;
  user_id: number;
  label: string;
  body: string;
  emoji: string | null;
  trigger_state: string | null;
  pinned: number;
  prompt: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type QuickCommandSettingsRow = {
  user_id: number;
  mode: string; // 'off' | 'heuristic' | 'llm'
  model: string; // 'haiku' | 'sonnet' | 'opus'
  send_mode: string; // 'insert' | 'direct'
  updated_at: string;
};

const DEFAULT_SETTINGS = { mode: 'heuristic', model: 'haiku', send_mode: 'insert' };

export const quickCommandsDb = {
  list(userId: number): QuickCommandRow[] {
    const db = getConnection();
    return db
      .prepare(
        'SELECT * FROM quick_commands WHERE user_id = ? ORDER BY sort_order ASC, id ASC'
      )
      .all(userId) as QuickCommandRow[];
  },

  create(
    userId: number,
    label: string,
    body: string,
    emoji: string | null,
    triggerState: string | null,
    pinned: number,
    prompt: string | null
  ): QuickCommandRow {
    const db = getConnection();
    const { next } = db
      .prepare(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM quick_commands WHERE user_id = ?'
      )
      .get(userId) as { next: number };
    const result = db
      .prepare(
        'INSERT INTO quick_commands (user_id, label, body, emoji, trigger_state, pinned, prompt, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(userId, label, body, emoji, triggerState, pinned, prompt, next);
    return db
      .prepare('SELECT * FROM quick_commands WHERE id = ?')
      .get(result.lastInsertRowid) as QuickCommandRow;
  },

  update(
    userId: number,
    id: number,
    fields: {
      label?: string;
      body?: string;
      emoji?: string | null;
      trigger_state?: string | null;
      pinned?: number;
      prompt?: string | null;
    }
  ): QuickCommandRow | undefined {
    const db = getConnection();
    const existing = db
      .prepare('SELECT * FROM quick_commands WHERE id = ? AND user_id = ?')
      .get(id, userId) as QuickCommandRow | undefined;
    if (!existing) return undefined;
    const label = fields.label ?? existing.label;
    const body = fields.body ?? existing.body;
    const emoji = fields.emoji === undefined ? existing.emoji : fields.emoji;
    const trigger =
      fields.trigger_state === undefined ? existing.trigger_state : fields.trigger_state;
    const pinned = fields.pinned === undefined ? existing.pinned : fields.pinned;
    const prompt = fields.prompt === undefined ? existing.prompt : fields.prompt;
    db.prepare(
      'UPDATE quick_commands SET label = ?, body = ?, emoji = ?, trigger_state = ?, pinned = ?, prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
    ).run(label, body, emoji, trigger, pinned, prompt, id, userId);
    return db
      .prepare('SELECT * FROM quick_commands WHERE id = ?')
      .get(id) as QuickCommandRow;
  },

  remove(userId: number, id: number): boolean {
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM quick_commands WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return result.changes > 0;
  },

  reorder(userId: number, orderedIds: number[]): void {
    const db = getConnection();
    const stmt = db.prepare(
      'UPDATE quick_commands SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
    );
    const tx = db.transaction((ids: number[]) => {
      ids.forEach((id, index) => stmt.run(index, id, userId));
    });
    tx(orderedIds);
  },

  getSettings(userId: number): QuickCommandSettingsRow {
    const db = getConnection();
    const row = db
      .prepare('SELECT * FROM quick_command_settings WHERE user_id = ?')
      .get(userId) as QuickCommandSettingsRow | undefined;
    if (row) return row;
    return {
      user_id: userId,
      mode: DEFAULT_SETTINGS.mode,
      model: DEFAULT_SETTINGS.model,
      send_mode: DEFAULT_SETTINGS.send_mode,
      updated_at: '',
    };
  },

  saveSettings(
    userId: number,
    fields: { mode?: string; model?: string; send_mode?: string }
  ): QuickCommandSettingsRow {
    const db = getConnection();
    const current = this.getSettings(userId);
    const mode = fields.mode ?? current.mode;
    const model = fields.model ?? current.model;
    const send_mode = fields.send_mode ?? current.send_mode;
    db.prepare(
      `INSERT INTO quick_command_settings (user_id, mode, model, send_mode, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, model = excluded.model, send_mode = excluded.send_mode, updated_at = CURRENT_TIMESTAMP`
    ).run(userId, mode, model, send_mode);
    return this.getSettings(userId);
  },
};
