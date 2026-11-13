import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import type { ForemanGitService } from '@/modules/foreman/foreman-git.service.js';
import type { createForemanSessionsService } from '@/modules/foreman/foreman-sessions.service.js';
import {
  parseForemanSuggestion,
  type ForemanSuggestionBroadcaster,
} from '@/modules/foreman/foreman-suggestions.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import type { ForemanBilling } from '@/shared/types.js';

type ForemanSessionsService = ReturnType<typeof createForemanSessionsService>;

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
// Model aliases and ids as the catalog spells them (`sonnet`, `claude-opus-5-5[1m]`), optionally with the `@api` marker.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99}(@api)?$/;
const EFFORT_PATTERN = /^[a-z]{3,12}$/;
// Foreman's own task identifiers (opaque to cloudcli): letters, digits and a few separators.
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
// Permission modes Claude sessions accept (mirrors the provider capability matrix).
const PERMISSION_MODES = ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'] as const;
const BILLING_MODES: readonly ForemanBilling[] = ['api-key', 'subscription'];

const MAX_PATH_LENGTH = 4096;
const MAX_PROMPT_LENGTH = 200_000;
const MAX_INSTRUCTIONS_LENGTH = 8000;
const MAX_TITLE_LENGTH = 100;
const MAX_DIGEST_TURNS = 10;

function invalid(message: string, code = 'INVALID_REQUEST'): AppError {
  return new AppError(message, { code, statusCode: 400 });
}

function readSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw invalid('Invalid session id.', 'INVALID_SESSION_ID');
  }
  return value;
}

function readBody(request: Request): Record<string, unknown> {
  const body: unknown = request.body ?? {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('The request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function readRequiredText(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(`${field} is required and must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw invalid(`${field} must be at most ${maxLength} characters.`);
  }
  return value;
}

function readOptionalText(body: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalid(`${field} must be a string.`);
  }
  if (value.length > maxLength) {
    throw invalid(`${field} must be at most ${maxLength} characters.`);
  }
  return value.trim() || undefined;
}

function readModel(value: unknown, field = 'model'): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !MODEL_PATTERN.test(value.trim())) {
    throw invalid(`${field} is not a valid model id.`);
  }
  return value.trim();
}

function readPermissionMode(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(value)) {
    throw invalid(`permissionMode must be one of: ${PERMISSION_MODES.join(', ')}.`);
  }
  return value;
}

function readEffort(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !EFFORT_PATTERN.test(value)) {
    throw invalid('effort is not a valid effort level.');
  }
  return value;
}

function readTaskId(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) {
    throw invalid('taskId must be 1-120 characters: letters, digits, ".", "_", ":" or "-".');
  }
  return value;
}

function readBilling(value: unknown): ForemanBilling | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !(BILLING_MODES as readonly string[]).includes(value)) {
    throw invalid(`billing must be one of: ${BILLING_MODES.join(', ')}.`);
  }
  return value as ForemanBilling;
}

function readIntegerQuery(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) {
    throw invalid(`${field} must be an integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < min || parsed > max) {
    throw invalid(`${field} must be between ${min} and ${max}.`);
  }
  return parsed;
}

/**
 * Builds the `/api/foreman` router. Every route sits behind `authMiddleware` (the bridge token,
 * not the cloudcli user login) and answers in the standard `{ success, data }` / `{ success, error }`
 * envelopes. Routes only validate input and translate results; the work happens in the service.
 */
// Consumed by foreman.module.ts, which mounts it on the server entrypoint, and by the route tests.
export function createForemanRouter(options: {
  authMiddleware: RequestHandler;
  sessions: ForemanSessionsService;
  /** Pushes suggestions to open chats; without it `POST /suggestions` answers 503. */
  suggestions?: ForemanSuggestionBroadcaster;
  /** Read-only git facts about a project; without it `GET /projects/git` answers 503. */
  git?: ForemanGitService;
}) {
  const { authMiddleware, sessions, suggestions, git } = options;
  const router = express.Router();

  router.use(authMiddleware);
  router.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/health', (_request, response) => {
    response.json(createApiSuccessResponse({ status: 'ok', time: new Date().toISOString() }));
  });

  router.get('/sessions', (request, response) => {
    const limit = readIntegerQuery(request.query.limit, 'limit', 1, 100);
    const projectPath = typeof request.query.projectPath === 'string' ? request.query.projectPath.trim() : undefined;
    response.json(createApiSuccessResponse({ sessions: sessions.listSessions({ limit, projectPath: projectPath || undefined }) }));
  });

  router.post('/sessions', asyncHandler(async (request, response) => {
    const body = readBody(request);
    const projectPath = readRequiredText(body, 'projectPath', MAX_PATH_LENGTH).trim();
    if (!projectPath.startsWith('/')) {
      throw invalid('projectPath must be an absolute path of a known cloudcli project.');
    }
    const result = await sessions.startSession({
      projectPath,
      prompt: readRequiredText(body, 'prompt', MAX_PROMPT_LENGTH),
      model: readModel(body.model) ?? 'default',
      billing: readBilling(body.billing) ?? 'api-key',
      permissionMode: readPermissionMode(body.permissionMode) ?? 'default',
      effort: readEffort(body.effort),
      title: readOptionalText(body, 'title', MAX_TITLE_LENGTH),
      taskId: readTaskId(body.taskId),
    });
    response.status(201).json(createApiSuccessResponse(result));
  }));

  // Read-only git facts (status, diff stat, diff) of a known project or a path inside one.
  router.get('/projects/git', asyncHandler(async (request, response) => {
    if (!git) {
      throw new AppError('Git inspection is not available.', { code: 'GIT_UNAVAILABLE', statusCode: 503 });
    }
    const requested = request.query.path;
    if (typeof requested !== 'string' || !requested.trim() || requested.length > MAX_PATH_LENGTH || !requested.trim().startsWith('/')) {
      throw invalid('path is required and must be an absolute path.');
    }
    response.json(createApiSuccessResponse(await git.inspect(requested.trim())));
  }));

  router.get('/sessions/:id/digest', asyncHandler(async (request, response) => {
    const sessionId = readSessionId(request.params.id);
    const turns = readIntegerQuery(request.query.turns, 'turns', 1, MAX_DIGEST_TURNS) ?? 1;
    response.json(createApiSuccessResponse(await sessions.getDigest(sessionId, turns)));
  }));

  router.get('/sessions/:id/context', asyncHandler(async (request, response) => {
    response.json(createApiSuccessResponse(await sessions.getContext(readSessionId(request.params.id))));
  }));

  router.post('/sessions/:id/message', asyncHandler(async (request, response) => {
    const sessionId = readSessionId(request.params.id);
    const body = readBody(request);
    if (body.interrupt !== undefined && typeof body.interrupt !== 'boolean') {
      throw invalid('interrupt must be a boolean.');
    }
    const result = await sessions.sendMessage(sessionId, {
      text: readRequiredText(body, 'text', MAX_PROMPT_LENGTH),
      interrupt: body.interrupt === true,
      permissionMode: readPermissionMode(body.permissionMode),
    });
    response.status(202).json(createApiSuccessResponse(result));
  }));

  router.post('/sessions/:id/interrupt', asyncHandler(async (request, response) => {
    response.json(createApiSuccessResponse(await sessions.interrupt(readSessionId(request.params.id))));
  }));

  router.post('/sessions/:id/model', asyncHandler(async (request, response) => {
    const sessionId = readSessionId(request.params.id);
    const model = readModel(readBody(request).model);
    if (!model) {
      throw invalid('model is required.');
    }
    response.json(createApiSuccessResponse(await sessions.setModel(sessionId, model)));
  }));

  router.post('/sessions/:id/compact', asyncHandler(async (request, response) => {
    const sessionId = readSessionId(request.params.id);
    const body = readBody(request);
    const result = await sessions.compact(sessionId, readOptionalText(body, 'instructions', MAX_INSTRUCTIONS_LENGTH), {
      permissionMode: readPermissionMode(body.permissionMode),
    });
    response.status(202).json(createApiSuccessResponse(result));
  }));

  // Foreman pushes each new or updated suggestion here; cloudcli broadcasts it to the open chats over the existing WebSocket.
  router.post('/suggestions', (request, response) => {
    if (!suggestions) {
      throw new AppError('Suggestion delivery is not available.', { code: 'SUGGESTIONS_UNAVAILABLE', statusCode: 503 });
    }
    const suggestion = parseForemanSuggestion(readBody(request).suggestion);
    response.status(202).json(createApiSuccessResponse({ delivered: suggestions.broadcast(suggestion) }));
  });

  // Self-contained error shape so the bridge answers identically whether or not it is mounted
  // behind the application's global error middleware.
  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    console.error('[Foreman bridge] unexpected error', error);
    response.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  return router;
}
