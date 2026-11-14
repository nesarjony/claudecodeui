import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { AppError } from '@/shared/utils.js';

/**
 * Location of the shared bridge secret.
 *
 * `FOREMAN_BRIDGE_TOKEN_FILE` overrides it (tests, non-standard installs); otherwise the
 * file Foreman provisions at `~/.config/foreman/bridge-token` is used. The same file
 * authenticates inbound calls from Foreman; outbound event pushes use `resolveEventsTokenFile`.
 */
// Consumed by foreman.module.ts, which hands the path to both the auth middleware and the event pusher.
export function resolveBridgeTokenFile(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const override = environment.FOREMAN_BRIDGE_TOKEN_FILE?.trim();
  return override || path.join(homeDirectory, '.config', 'foreman', 'bridge-token');
}

/**
 * Location of the token cloudcli presents to Foreman's intake with every event it pushes.
 *
 * `FOREMAN_EVENTS_TOKEN_FILE` names it; without one the bridge token file is used. A separate file keeps the two directions apart: a
 * leaked intake token cannot start or stop sessions.
 */
// Consumed by foreman.module.ts, which hands the path to the event pusher.
export function resolveEventsTokenFile(bridgeTokenFile: string, environment: NodeJS.ProcessEnv = process.env): string {
  return environment.FOREMAN_EVENTS_TOKEN_FILE?.trim() || bridgeTokenFile;
}

/**
 * Reads the bridge token fresh from disk. Returns `null` when the file is missing,
 * unreadable, or blank — the bridge is then disabled.
 *
 * It is deliberately re-read on every call (the file is a few dozen bytes) so rotating the
 * token never needs a cloudcli restart. The value is never logged.
 */
// Consumed by the auth middleware here and by the event pusher in foreman-event-push.service.ts (which reads its own token file).
export async function readBridgeToken(tokenFile: string): Promise<string | null> {
  try {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Extracts the credential from an `Authorization: Bearer <token>` header, or `null`. */
// Consumed by the auth middleware in this file and by its tests.
export function extractBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Constant-time token comparison. Both values are hashed first so the comparison runs over
 * equal-length buffers and neither the length nor the content of the secret leaks through timing.
 */
// Consumed by the auth middleware in this file and by its tests.
export function bridgeTokenMatches(expected: string, provided: string): boolean {
  const expectedDigest = createHash('sha256').update(expected).digest();
  const providedDigest = createHash('sha256').update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

/**
 * Express middleware guarding `/api/foreman/*` with the bridge token instead of the normal
 * cloudcli user login.
 *
 * - token file missing/blank: 503 `FOREMAN_BRIDGE_DISABLED` for every request;
 * - header absent, malformed, or wrong: 401 `FOREMAN_BRIDGE_UNAUTHORIZED`;
 * - otherwise the request continues.
 */
// Consumed by foreman.routes.ts, which mounts it in front of every bridge route.
export function createBridgeAuthMiddleware(options: { tokenFile: string }): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction) => {
    void (async () => {
      const expected = await readBridgeToken(options.tokenFile);
      if (!expected) {
        throw new AppError('The Foreman bridge is disabled: no bridge token is configured.', {
          code: 'FOREMAN_BRIDGE_DISABLED',
          statusCode: 503,
        });
      }

      const provided = extractBearerToken(request.headers.authorization);
      if (!provided || !bridgeTokenMatches(expected, provided)) {
        throw new AppError('Invalid or missing bridge token.', {
          code: 'FOREMAN_BRIDGE_UNAUTHORIZED',
          statusCode: 401,
        });
      }
    })().then(() => next(), next);
  };
}
