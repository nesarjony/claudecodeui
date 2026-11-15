import os from 'node:os';
import path from 'node:path';

import express, { type NextFunction, type Request, type Response } from 'express';

import { createForemanNextClient, type ForemanNextClient } from '@/modules/foreman-next/foreman-next.client.js';
import { FOREMAN_NEXT_ROUTES } from '@/modules/foreman-next/foreman-next.routes.js';
import { createServiceLog, type ServiceLogSource } from '@/modules/foreman-next/foreman-next.service-log.js';
import { readTokenFile } from '@/modules/foreman-next/foreman-next.token.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

/**
 * The rebuilt Foreman's server half (slice 4b): the allowlisted, login-protected proxy to Foreman's own API, which stays on loopback. Mounted at
 * `/api/foreman-next` behind `authenticateToken`, so a request that reaches it is the logged-in owner's, and the token it adds is what tells Foreman
 * so. Answers use cloudcli's envelope: `{ success: true, data }`, or `{ success: false, error: { code, message } }`.
 */
export function createForemanNextRouter(options: { client: ForemanNextClient; serviceLog: ServiceLogSource }) {
  const { client, serviceLog } = options;
  const router = express.Router();

  router.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/service-log', asyncHandler(async (_request, response) => response.json(createApiSuccessResponse(await serviceLog()))));

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

/** Foreman's user unit, whose journal is the service log unless `FOREMAN_NEXT_LOG_FILE` names a file. */
const FOREMAN_UNIT = 'foreman-next';

/** Configured by the environment of the cloudcli process: where Foreman answers (loopback only), the file with its API token, and its service log. None of it reaches the browser. */
export function createForemanNextModule() {
  const tokenFile = resolveForemanNextTokenFile();
  const token = () => readTokenFile(tokenFile);
  return createForemanNextRouter({
    client: createForemanNextClient({ baseUrl: process.env.FOREMAN_NEXT_URL ?? 'http://127.0.0.1:4211', token }),
    // The token guard's own read: the log is cleaned of the exact token the proxy holds, whatever shape a line gives it.
    serviceLog: createServiceLog({
      file: process.env.FOREMAN_NEXT_LOG_FILE,
      journalCommand: 'journalctl',
      unit: FOREMAN_UNIT,
      secrets: async () => {
        const value = await token();
        return value === null ? [] : [value];
      },
    }),
  });
}
