import express, { type NextFunction, type Request, type Response } from 'express';

import type { ForemanHandoverService } from '@/modules/foreman/foreman-handover.service.js';
import type { ForemanSuggestionsClient } from '@/modules/foreman/foreman-suggestions.service.js';
import type { ForemanSessionStateService } from '@/modules/foreman/foreman-session-state.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

/** The request after cloudcli's login (`authenticateToken`), which puts the logged-in user's row on it. */
type AuthenticatedRequest = Request & { user?: { id?: unknown; username?: unknown } };

function readSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new AppError('Invalid session id.', { code: 'INVALID_SESSION_ID', statusCode: 400 });
  }
  return value;
}

/** Who is asking: the logged-in user's name, or their id. With nobody logged in (a router mounted without the login) nothing is handed over. */
function readLoggedInUser(request: Request): string {
  const user = (request as AuthenticatedRequest).user;
  const name = typeof user?.username === 'string' && user.username ? user.username : typeof user?.id === 'number' || typeof user?.id === 'string' ? String(user.id) : '';
  if (!name) {
    throw new AppError('Only the logged-in owner can hand a session over.', { code: 'AUTH_REQUIRED', statusCode: 401 });
  }
  return name;
}

/**
 * Builds the user-facing Foreman suggestions router, mounted at `/api/foreman-suggestions` behind the normal cloudcli
 * login (the `/api/foreman/*` bridge routes use the bridge token instead). The browser never sees the bridge token:
 * these routes call Foreman with it server-side.
 *
 * - `GET  /pending?sessionId=`  the session's pending suggestion, or `{ suggestion: null }`
 * - `POST /:id/feedback`        `{ action: 'sent' | 'edited' | 'dismissed', finalText? }`
 * - `POST /:id/execute`         has Foreman carry out a `write_notes` or `handoff` suggestion; answers what it did
 *                               (`result.newSessionId` for a handoff, `result.version` for notes)
 * - `GET  /notes?sessionId=`    the latest task notes for a session, `{ notes: { content, version, turn, createdAt } | null }`
 * - `GET  /supervised`         the sessions Foreman supervises now, `{ sessions: [{ sessionId, supervision: 'started' | 'adopted', taskId }] }`,
 *                               so the sidebar can mark the ones the owner handed over
 * - `POST /handover/:sessionId` the owner lets Foreman adopt the session once within five minutes: 201 `{ sessionId, expiresAt }`. Only
 *                               here, behind the login: the bridge token alone can never hand a session over.
 * - `DELETE /handover/:sessionId` withdraws a grant Foreman has not used: `{ sessionId, revoked }`
 */
// Consumed by foreman.module.ts, which mounts it on the server entrypoint, and by the route tests.
export function createForemanUiRouter(options: {
  client: ForemanSuggestionsClient;
  state: Pick<ForemanSessionStateService, 'listSupervised'>;
  handover: Pick<ForemanHandoverService, 'grant' | 'revoke'>;
}) {
  const { client, state, handover } = options;
  const router = express.Router();

  router.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/pending', asyncHandler(async (request, response) => {
    const sessionId = request.query.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new AppError('sessionId is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
    }
    response.json(createApiSuccessResponse({ suggestion: await client.getPending(sessionId) }));
  }));

  router.get('/supervised', (_request, response) => {
    response.json(createApiSuccessResponse({ sessions: state.listSupervised() }));
  });

  // Ahead of `/:id/execute` and `/:id/feedback`, which would otherwise take the grant of a session named `execute` or `feedback`.
  router.post('/handover/:sessionId', (request, response) => {
    const grantedBy = readLoggedInUser(request);
    response.status(201).json(createApiSuccessResponse(handover.grant(readSessionId(request.params.sessionId), grantedBy)));
  });

  router.delete('/handover/:sessionId', (request, response) => {
    readLoggedInUser(request);
    response.json(createApiSuccessResponse(handover.revoke(readSessionId(request.params.sessionId))));
  });

  router.get('/notes', asyncHandler(async (request, response) => {
    const sessionId = request.query.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new AppError('sessionId is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
    }
    response.json(createApiSuccessResponse({ notes: await client.getNotes(sessionId) }));
  }));

  router.post('/:id/execute', asyncHandler(async (request, response) => {
    const suggestionId = typeof request.params.id === 'string' ? request.params.id : '';
    response.json(createApiSuccessResponse(await client.execute(suggestionId)));
  }));

  router.post('/:id/feedback', asyncHandler(async (request, response) => {
    const body: unknown = request.body ?? {};
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError('The request body must be a JSON object.', { code: 'INVALID_REQUEST', statusCode: 400 });
    }
    const { action, finalText } = body as { action?: unknown; finalText?: unknown };
    if (typeof action !== 'string') {
      throw new AppError('action is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
    }
    if (finalText !== undefined && typeof finalText !== 'string') {
      throw new AppError('finalText must be a string.', { code: 'INVALID_REQUEST', statusCode: 400 });
    }
    const suggestionId = typeof request.params.id === 'string' ? request.params.id : '';
    const result = await client.sendFeedback(suggestionId, {
      action: action as 'sent' | 'edited' | 'dismissed',
      finalText,
    });
    response.json(createApiSuccessResponse(result));
  }));

  // Same self-contained error shape as the bridge router.
  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    console.error('[Foreman suggestions] unexpected error', error);
    response.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  return router;
}
