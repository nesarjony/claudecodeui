import express from 'express';
import type { Request } from 'express';

import { quickCommandsService } from '@/modules/quick-commands/quick-commands.service.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function userId(request: Request): number {
  const value = Number((request as AuthenticatedRequest).user?.id);
  if (!Number.isInteger(value)) throw new AppError('Authenticated user is required.', { statusCode: 401 });
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError(`${field} is required.`, { statusCode: 400 });
  return value.trim();
}

function optionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => res.json(quickCommandsService.list(userId(req)))));

router.post('/', asyncHandler(async (req, res) => {
  const body = record(req.body);
  const label = requiredText(body.label, 'label');
  const commandBody = optionalText(body.body) ?? '';
  const prompt = optionalText(body.prompt) ?? null;
  if (!commandBody && !prompt) throw new AppError('body or prompt is required.', { statusCode: 400 });
  const command = quickCommandsService.create(
    userId(req), label, commandBody, optionalText(body.emoji) ?? null,
    optionalText(body.trigger_state) ?? null, Boolean(body.pinned), prompt,
  );
  res.status(201).json({ success: true, command });
}));

router.put('/settings', asyncHandler(async (req, res) => {
  const body = record(req.body);
  const settings = quickCommandsService.saveSettings(userId(req), {
    mode: optionalText(body.mode) ?? undefined,
    model: optionalText(body.model) ?? undefined,
    send_mode: optionalText(body.send_mode) ?? undefined,
  });
  res.json({ success: true, settings });
}));

router.put('/reorder', asyncHandler(async (req, res) => {
  const orderedIds = record(req.body).orderedIds;
  if (!Array.isArray(orderedIds)) throw new AppError('orderedIds must be an array.', { statusCode: 400 });
  quickCommandsService.reorder(userId(req), orderedIds.map(Number).filter(Number.isInteger));
  res.json({ success: true });
}));

router.post('/suggest', asyncHandler(async (req, res) => {
  const rankedIds = await quickCommandsService.suggest(userId(req), requiredText(record(req.body).agentText, 'agentText'));
  res.json({ rankedIds });
}));

router.post('/:id/run', asyncHandler(async (req, res) => {
  const text = await quickCommandsService.run(userId(req), Number(req.params.id), String(record(req.body).agentText ?? ''));
  res.json({ text });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const body = record(req.body);
  const command = quickCommandsService.update(userId(req), Number(req.params.id), {
    label: optionalText(body.label) ?? undefined,
    body: optionalText(body.body) ?? undefined,
    emoji: optionalText(body.emoji),
    trigger_state: optionalText(body.trigger_state),
    pinned: body.pinned === undefined ? undefined : body.pinned ? 1 : 0,
    prompt: optionalText(body.prompt),
  });
  if (!command) throw new AppError('Quick command not found.', { statusCode: 404 });
  res.json({ success: true, command });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  if (!quickCommandsService.remove(userId(req), Number(req.params.id))) {
    throw new AppError('Quick command not found.', { statusCode: 404 });
  }
  res.json({ success: true });
}));

export default router;
