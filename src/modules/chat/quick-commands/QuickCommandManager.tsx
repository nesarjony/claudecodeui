import { useState } from 'react';
import { Pencil, Pin, Trash2, Wand2, X } from 'lucide-react';

import type {
  QuickCommand,
  QuickCommandInput,
  QuickCommandSettings,
} from '@/modules/chat/hooks/useQuickCommands';

const MODEL_OPTIONS: { value: QuickCommandSettings['model']; label: string }[] = [
  { value: 'haiku', label: 'Haiku — DeepSeek (cheap, metered)' },
  { value: 'sonnet', label: 'Sonnet — Claude plan' },
  { value: 'opus', label: 'Opus — Claude plan (best)' },
];

// Inputs use 16px text on phones: iOS zooms the page into any smaller field.
const FIELD = 'rounded-lg border border-border bg-background text-base sm:text-sm';

type QuickCommandManagerProps = {
  commands: QuickCommand[];
  settings: QuickCommandSettings;
  onClose: () => void;
  onCreate: (input: QuickCommandInput) => Promise<boolean>;
  onUpdate: (id: number, input: Partial<QuickCommandInput>) => Promise<boolean>;
  onDelete: (id: number) => Promise<boolean>;
  onSaveSettings: (next: Partial<QuickCommandSettings>) => Promise<boolean>;
};

/** Add, edit, pin and delete quick commands. A bottom sheet on phones, a dialog on desktop. */
export default function QuickCommandManager({
  commands,
  settings,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onSaveSettings,
}: QuickCommandManagerProps) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [emoji, setEmoji] = useState('');
  const [body, setBody] = useState('');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setEditingId(null);
    setLabel('');
    setEmoji('');
    setBody('');
    setPrompt('');
  };

  const startEdit = (cmd: QuickCommand) => {
    setEditingId(cmd.id);
    setLabel(cmd.label);
    setEmoji(cmd.emoji || '');
    setBody(cmd.body);
    setPrompt(cmd.prompt || '');
  };

  const canSave = Boolean(label.trim() && (body.trim() || prompt.trim()));

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    const payload = {
      label: label.trim(),
      body,
      emoji: emoji.trim() || null,
      trigger_state: null,
      prompt: prompt.trim() || null,
    };
    const ok = editingId != null ? await onUpdate(editingId, payload) : await onCreate(payload);
    setSaving(false);
    if (ok) resetForm();
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Manage quick commands"
        className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-card pb-safe-area-inset-bottom shadow-xl sm:max-h-[88vh] sm:max-w-md sm:rounded-2xl sm:pb-0"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold">Quick commands</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted sm:h-8 sm:w-8"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-3 sm:p-4">
          <div className="space-y-2">
            {commands.map((cmd) => (
              <div key={cmd.id} className="flex items-center gap-1 rounded-xl border border-border/60 bg-muted/30 py-1 pl-3 pr-1">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 text-sm font-medium sm:text-xs">
                    <span className="truncate">
                      {cmd.emoji ? `${cmd.emoji} ` : ''}
                      {cmd.label}
                    </span>
                    {cmd.prompt && cmd.prompt.trim() ? <Wand2 className="h-3 w-3 shrink-0 text-primary/80" /> : null}
                  </div>
                  <div className="truncate text-xs text-muted-foreground sm:text-[11px]">
                    {cmd.prompt && cmd.prompt.trim() ? cmd.prompt : cmd.body}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onUpdate(cmd.id, { pinned: cmd.pinned ? 0 : 1 })}
                  aria-label={cmd.pinned ? 'Unpin' : 'Pin'}
                  title={cmd.pinned ? 'Unpin' : 'Pin to the toolbar'}
                  className={
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg sm:h-8 sm:w-8 ' +
                    (cmd.pinned ? 'text-primary' : 'text-muted-foreground hover:bg-muted')
                  }
                >
                  <Pin className={'h-4 w-4 ' + (cmd.pinned ? 'fill-current' : '')} />
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(cmd)}
                  aria-label="Edit"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted sm:h-8 sm:w-8"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete "${cmd.label}"?`)) void onDelete(cmd.id);
                  }}
                  aria-label="Delete"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-destructive sm:h-8 sm:w-8"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            {commands.length === 0 && (
              <p className="py-3 text-center text-xs text-muted-foreground">No quick commands yet. Add one below.</p>
            )}
          </div>

          <div className="space-y-2 rounded-xl border border-border/60 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {editingId != null ? 'Edit command' : 'Add command'}
            </div>
            <div className="flex gap-2">
              <input
                value={emoji}
                onChange={(event) => setEmoji(event.target.value)}
                placeholder="🚀"
                maxLength={4}
                aria-label="Emoji"
                className={`${FIELD} h-10 w-14 px-2 text-center`}
              />
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Label (e.g. Cross-check)"
                aria-label="Label"
                className={`${FIELD} h-10 min-w-0 flex-1 px-3`}
              />
            </div>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={3}
              placeholder="Message text… use {input} to wrap what you already typed. Start with / for a slash command."
              aria-label="Message text"
              className={`${FIELD} w-full resize-none px-3 py-2`}
            />
            <div className="space-y-1 rounded-lg border border-primary/20 bg-primary/[0.04] p-2">
              <div className="flex items-center gap-1 text-[11px] font-medium text-primary/90">
                <Wand2 className="h-3 w-3" /> Custom AI prompt (optional)
              </div>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={2}
                placeholder="e.g. Summarize the agent's last message in 3 bullets"
                aria-label="AI prompt"
                className={`${FIELD} w-full resize-none px-3 py-2`}
              />
              <p className="text-[11px] leading-snug text-muted-foreground">
                If set, the command runs this prompt against the agent's last message (~7s) and puts the
                result in the composer.
              </p>
              <label className="flex items-center gap-2 pt-1">
                <span className="shrink-0 text-[11px] text-muted-foreground">AI model</span>
                <select
                  value={settings.model}
                  onChange={(event) =>
                    void onSaveSettings({ model: event.target.value as QuickCommandSettings['model'] })
                  }
                  className={`${FIELD} h-10 min-w-0 flex-1 px-2 sm:h-8 sm:text-xs`}
                >
                  {MODEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex justify-end gap-2">
              {editingId != null && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="h-10 rounded-lg px-4 text-sm text-muted-foreground hover:bg-muted sm:h-8 sm:text-xs"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                disabled={saving || !canSave}
                onClick={handleSave}
                className="h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:h-8 sm:text-xs"
              >
                {editingId != null ? 'Save' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
