import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express, { type NextFunction, type Request, type Response } from 'express';

import { createForemanNextClient, type ForemanNextClient } from '@/modules/foreman-next/foreman-next.client.js';
import { FOREMAN_NEXT_ROUTES } from '@/modules/foreman-next/foreman-next.routes.js';
import { readServiceLog } from '@/modules/foreman-next/foreman-next.service-log.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

/**
 * The rebuilt Foreman's server half (slice 4b): the allowlisted, login-protected proxy to Foreman's own API, which stays on loopback. Mounted at
 * `/api/foreman-next` behind `authenticateToken`, so a request that reaches it is the logged-in owner's, and the token it adds is what tells Foreman
 * so. Answers use cloudcli's envelope: `{ success: true, data }`, or `{ success: false, error: { code, message } }`.
 */
export function createForemanNextRouter(options: { client: ForemanNextClient; serviceLogFile: string | undefined }) {
  const { client, serviceLogFile } = options;
  const router = express.Router();

  router.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/service-log', asyncHandler(async (_request, response) => response.json(createApiSuccessResponse(await readServiceLog(serviceLogFile)))));

  for (const route of FOREMAN_NEXT_ROUTES) {
    const handler = asyncHandler(async (request, response) => {
      const params: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.params)) params[name] = typeof value === 'string' ? value : '';
      response.json(createApiSuccessResponse(await client.forward({ route, params, query: request.query as Record<string, unknown>, body: request.body })));
    });
    router[route.method === 'GET' ? 'get' : route.method === 'PUT' ? 'put' : 'post'](route.path, handler);
  }

  router.use((_request: Request, _response: Response, next: NextFunction) => {
    next(new AppError('Not found.', { code: 'NOT_FOUND', statusCode: 404 }));
  });

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    console.error('[Foreman next] unexpected error', error);
    response.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  return router;
}

/** Where Foreman's API token is: a file of its own, like the bridge token's, which is what keeps it out of the environment of every process cloudcli starts. */
export function resolveForemanNextTokenFile(environment: NodeJS.ProcessEnv = process.env, homeDirectory: string = os.homedir()): string {
  return environment.FOREMAN_NEXT_API_TOKEN_FILE?.trim() || path.join(homeDirectory, '.config', 'foreman', 'next-api-token');
}

/** The token, read fresh from its file so rotating it needs no restart; none when the file is missing or blank. It is never logged. */
async function readToken(file: string): Promise<string | null> {
  try {
    const token = (await readFile(file, 'utf8')).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** A token file others can read is a token others can use: said once at the boot, with the path and the mode and never the content. */
function warnIfReadable(file: string): void {
  try {
    const mode = statSync(file).mode;
    if ((mode & 0o077) !== 0) console.warn(`[Foreman next] token file ${file} has mode ${(mode & 0o777).toString(8)}: it should be readable by its owner only (chmod 600).`);
  } catch {
    // A file that is not there is reported when a request needs the token.
  }
}

/** Configured by the environment of the cloudcli process: where Foreman answers (loopback only), the file with its API token, and its service log. None of it reaches the browser. */
export function createForemanNextModule() {
  const tokenFile = resolveForemanNextTokenFile();
  warnIfReadable(tokenFile);
  return createForemanNextRouter({
    client: createForemanNextClient({ baseUrl: process.env.FOREMAN_NEXT_URL ?? 'http://127.0.0.1:4211', token: () => readToken(tokenFile) }),
    serviceLogFile: process.env.FOREMAN_NEXT_LOG_FILE,
  });
}
