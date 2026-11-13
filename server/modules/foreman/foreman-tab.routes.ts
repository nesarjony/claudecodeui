import express, { type NextFunction, type Request, type Response } from 'express';

import { FOREMAN_TAB_ROUTES, type ForemanTabClient } from '@/modules/foreman/foreman-tab.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

/**
 * Builds the Foreman tab's router, mounted at `/api/foreman-tab` behind the normal cloudcli login. Each route is an
 * entry of the allowlist in foreman-tab.service.ts: the router forwards it to Foreman with the bridge token, which stays
 * server-side. Anything else under this prefix is a 404 that never reaches Foreman.
 *
 * Answers use cloudcli's envelope: `{ success: true, data }` (data is Foreman's JSON) or
 * `{ success: false, error: { code, message, details? } }`. A refused settings change carries Foreman's per-field
 * messages in `error.details.fieldErrors`.
 */
// Consumed by foreman-tab.module.ts, which mounts it on the server entrypoint, and by the route tests.
export function createForemanTabRouter(options: { client: ForemanTabClient }) {
  const { client } = options;
  const router = express.Router();

  router.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  for (const route of FOREMAN_TAB_ROUTES) {
    const handler = asyncHandler(async (request, response) => {
      const params: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.params)) {
        params[name] = typeof value === 'string' ? value : '';
      }
      const data = await client.forward({ route, params, query: request.query as Record<string, unknown>, body: request.body });
      response.json(createApiSuccessResponse(data));
    });
    router[route.method === 'GET' ? 'get' : route.method === 'PUT' ? 'put' : 'post'](route.path, handler);
  }

  router.use((_request: Request, _response: Response, next: NextFunction) => {
    next(new AppError('Not found.', { code: 'NOT_FOUND', statusCode: 404 }));
  });

  // Same self-contained error shape as the other Foreman routers.
  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    console.error('[Foreman tab] unexpected error', error);
    response.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  return router;
}
