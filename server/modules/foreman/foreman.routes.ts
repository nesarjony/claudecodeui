import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { declaredModelBilling } from '@/modules/foreman/foreman-billing.service.js';
import type { ForemanGitService } from '@/modules/foreman/foreman-git.service.js';
import { fingerprintOf, type ForemanIdempotency } from '@/modules/foreman/foreman-idempotency.service.js';
import { parseSandboxPolicy } from '@/modules/foreman/foreman-sandbox.service.js';
import type { createForemanSessionsService } from '@/modules/foreman/foreman-sessions.service.js';
import {
  parseForemanSuggestion,
  type ForemanSuggestionBroadcaster,
} from '@/modules/foreman/foreman-suggestions.service.js';
import { MAX_WORKTREE_BRANCH_LENGTH, type ForemanWorktreesService } from '@/modules/foreman/foreman-worktrees.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import type { ForemanBilling } from '@/shared/types.js';

type ForemanSessionsService = ReturnType<typeof createForemanSessionsService>;

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
// Model aliases and ids as the catalog spells them (`sonnet`, `claude-opus-5-5[1m]`), optionally with the `@api` or `@cap` marker.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99}(@api|@cap)?$/;
const EFFORT_PATTERN = /^[a-z]{3,12}$/;
// Foreman's own task identifiers (opaque to cloudcli): letters, digits and a few separators.
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
// Permission modes Claude sessions accept (mirrors the provider capability matrix).
const PERMISSION_MODES = ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'] as const;
// Permission request ids are minted by the runtime (a UUID); anything of that shape is accepted.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const PERMISSION_DECISIONS = ['allow', 'deny'] as const;
const BILLING_MODES: readonly ForemanBilling[] = ['api-key', 'subscription', 'cap'];
// The key Foreman makes up for each call that changes a session (the slice's own naming: `start:<run>:<attempt>`).
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MAX_EVENTS_PAGE = 500;

const MAX_PATH_LENGTH = 4096;
const MAX_PROMPT_LENGTH = 200_000;
const MAX_INSTRUCTIONS_LENGTH = 8000;
const MAX_TITLE_LENGTH = 100;
const MAX_REASON_LENGTH = 1000;
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

function readIdempotencyKey(body: Record<string, unknown>): string {
  const key = body.idempotencyKey;
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw invalid('idempotencyKey is required: 1-200 characters, letters, digits, ".", "_", ":" or "-".', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  return key;
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
  /** Makes each call that changes a session apply its idempotency key at most once. */
  idempotency: ForemanIdempotency;
  /** Pushes suggestions to open chats; without it `POST /suggestions` answers 503. */
  suggestions?: ForemanSuggestionBroadcaster;
  /** Read-only git facts about a project; without it `GET /projects/git` answers 503. */
  git?: ForemanGitService;
  /** Task worktrees; without it `POST` and `DELETE /projects/worktree` answer 503. */
  worktrees?: ForemanWorktreesService;
}) {
  const { authMiddleware, sessions, idempotency, suggestions, git, worktrees } = options;
  const router = express.Router();

  /** Runs a call that changes a session under the idempotency key of its body, and sends the answer it first gave. */
  async function once(response: Response, call: { body: Record<string, unknown>; operation: string; scope: string; status: number }, run: () => Promise<unknown>): Promise<void> {
    const answer = await idempotency.once(
      // The key is left out of the fingerprint: the same call asked again under the same key must match itself.
      { key: readIdempotencyKey(call.body), operation: call.operation, fingerprint: fingerprintOf({ scope: call.scope, asked: { ...call.body, idempotencyKey: undefined } }) },
      async () => ({ status: call.status, body: createApiSuccessResponse(await run()) }),
    );
    response.status(answer.status).json(answer.body);
  }

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
    // Checked before anything else: a session that cannot be sandboxed must not start at all.
    const sandbox = parseSandboxPolicy(body.sandbox);
    const projectPath = readRequiredText(body, 'projectPath', MAX_PATH_LENGTH).trim();
    if (!projectPath.startsWith('/')) {
      throw invalid('projectPath must be an absolute path of a known cloudcli project.');
    }
    const model = readModel(body.model) ?? 'default';
    const input = {
      projectPath,
      prompt: readRequiredText(body, 'prompt', MAX_PROMPT_LENGTH),
      model,
      // An explicit billing wins; without one a marked model keeps its marker's billing. A worker goes through claude-cap unless Foreman says otherwise.
      billing: readBilling(body.billing) ?? declaredModelBilling(model) ?? 'cap',
      permissionMode: readPermissionMode(body.permissionMode) ?? 'default',
      effort: readEffort(body.effort),
      title: readOptionalText(body, 'title', MAX_TITLE_LENGTH),
      taskId: readTaskId(body.taskId),
      sandbox,
    };
    await once(response, { body, operation: 'start', scope: projectPath, status: 201 }, () => sessions.startSession(input));
  }));

  // The owner hands one of their own sessions to Foreman, and later takes it back. Neither changes the session's model, routing or permissions.
  router.post('/sessions/:id/adopt', asyncHandler(async (request, response) => {
    const sessionId = readSessionId(request.params.id);
    const body = readBody(request);
    const taskId = readTaskId(body.taskId);
    await once(response, { body, operation: 'adopt', scope: sessionId, status: 200 }, () => sessions.adopt(sessionId, { taskId }));
  }));

  router.post('/sessions/:id/release', asyncHandler(async (request, response) => {
    const sessionId = readSessionId(request.params.id);
    await once(response, { body: readBody(request), operation: 'release', scope: sessionId, status: 200 }, () => sessions.release(sessionId));
  }));

  router.get('/sessions/:id/state', (request, response) => {
    response.json(createApiSuccessResponse(sessions.getState(readSessionId(request.params.id))));
  });

  // The events above `after`, for Foreman to fill a gap or to catch up after its own restart; `hasMore` says to ask again from the last sequence.
  router.get('/sessions/:id/events', (request, response) => {
    const afterSequence = readIntegerQuery(request.query.after, 'after', 0, 2_000_000_000) ?? 0;
    const limit = readIntegerQuery(request.query.limit, 'limit', 1, MAX_EVENTS_PAGE) ?? MAX_EVENTS_PAGE;
    response.json(createApiSuccessResponse(sessions.eventsSince(readSessionId(request.params.id), afterSequence, limit)));
  });

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

  // A task worktree of a known project, registered as a cloudcli project: 201 when made now, 200 when it already existed.
  router.post('/projects/worktree', asyncHandler(async (request, response) => {
    if (!worktrees) {
      throw new AppError('Worktree management is not available.', { code: 'WORKTREES_UNAVAILABLE', statusCode: 503 });
    }
    const body = readBody(request);
    const projectPath = readRequiredText(body, 'projectPath', MAX_PATH_LENGTH).trim();
    if (!projectPath.startsWith('/')) {
      throw invalid('projectPath must be an absolute path of a known cloudcli project.');
    }
    // Branch rules are the service's (git's own); the length here only bounds what is read.
    const result = await worktrees.create({
      projectPath,
      branch: readRequiredText(body, 'branch', MAX_WORKTREE_BRANCH_LENGTH + 100).trim(),
      base: readOptionalText(body, 'base', MAX_WORKTREE_BRANCH_LENGTH + 100),
    });
    response.status(result.created ? 201 : 200).json(createApiSuccessResponse(result));
  }));

  router.delete('/projects/worktree', asyncHandler(async (request, response) => {
    if (!worktrees) {
      throw new AppError('Worktree management is not available.', { code: 'WORKTREES_UNAVAILABLE', statusCode: 503 });
    }
    const body = readBody(request);
    const worktreePath = readRequiredText(body, 'path', MAX_PATH_LENGTH).trim();
    if (!worktreePath.startsWith('/')) {
      throw invalid('path must be the absolute path of a worktree the bridge created.');
    }
    for (const flag of ['deleteBranch', 'force']) {
      if (body[flag] !== undefined && typeof body[flag] !== 'boolean') {
        throw invalid(`${flag} must be a boolean.`);
      }
    }
    response.json(createApiSuccessResponse(await worktrees.remove({
      path: worktreePath,
      deleteBranch: body.deleteBranch === true,
      force: body.force === true,
    })));
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
    const input = {
      text: readRequiredText(body, 'text', MAX_PROMPT_LENGTH),
      interrupt: body.interrupt === true,
      permissionMode: readPermissionMode(body.permissionMode),
    };
    await once(response, { body, operation: 'message', scope: sessionId, status: 202 }, () => sessions.sendMessage(sessionId, input));
  }));

  router.get('/sessions/:id/permissions', (request, response) => {
    response.json(createApiSuccessResponse(sessions.listPermissions(readSessionId(request.params.id))));
  });

  router.post('/sessions/:id/permission', asyncHandler(async (request, response) => {
    const sessionId = readSessionId(request.params.id);
    const body = readBody(request);
    const requestId = body.requestId;
    if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
      throw invalid('requestId is required and must be a permission request id.');
    }
    const decision = body.decision;
    if (typeof decision !== 'string' || !(PERMISSION_DECISIONS as readonly string[]).includes(decision)) {
      throw invalid(`decision must be one of: ${PERMISSION_DECISIONS.join(', ')}.`);
    }
    const input = { requestId, decision: decision as (typeof PERMISSION_DECISIONS)[number], reason: readOptionalText(body, 'reason', MAX_REASON_LENGTH) };
    await once(response, { body, operation: 'permission', scope: sessionId, status: 200 }, async () => sessions.answerPermission(sessionId, input));
  }));

  router.post('/sessions/:id/interrupt', asyncHandler(async (request, response) => {
    const sessionId = readSessionId(request.params.id);
    await once(response, { body: readBody(request), operation: 'interrupt', scope: sessionId, status: 200 }, () => sessions.interrupt(sessionId));
  }));

  router.post('/sessions/:id/model', asyncHandler(async (request, response) => {
    const sessionId = readSessionId(request.params.id);
    const body = readBody(request);
    const model = readModel(body.model);
    if (!model) {
      throw invalid('model is required.');
    }
    await once(response, { body, operation: 'model', scope: sessionId, status: 200 }, () => sessions.setModel(sessionId, model));
  }));

  router.post('/sessions/:id/compact', asyncHandler(async (request, response) => {
    const sessionId = readSessionId(request.params.id);
    const body = readBody(request);
    const instructions = readOptionalText(body, 'instructions', MAX_INSTRUCTIONS_LENGTH);
    const permissionMode = readPermissionMode(body.permissionMode);
    await once(response, { body, operation: 'compact', scope: sessionId, status: 202 }, () => sessions.compact(sessionId, instructions, { permissionMode }));
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
