/**
 * GraphQL endpoint mount helper.
 *
 * `mountGraphQL(app)` attaches a dynamic middleware at `/graphql` that checks
 * the `graphql_enabled` feature flag on every request. When the flag is off
 * the handler returns `404 Not Found` immediately; when it is on the request
 * is forwarded to the yoga handler.
 *
 * Toggle behaviour: **dynamic per-request** — no restart required.  The flag
 * is read through the featureFlags service which caches the DB value for
 * `FEATURE_FLAG_CACHE_TTL_MS` (default 5 s), so a flag change is visible within
 * one cache TTL window without restarting the process.
 *
 * See docs/graphql.md for the full list of error codes and endpoint behaviour.
 */

import type { Application, Request, Response, NextFunction } from 'express';
import { isEnabled, GRAPHQL_ENABLED } from '../services/featureFlags';
import { logger } from '../utils/logger';

/**
 * Minimal GraphQL handler.
 *
 * When a real GraphQL server (e.g. graphql-yoga) is added, replace the stub
 * handler below with the yoga handler and uncomment the relevant imports.
 * The feature-flag guard is intentionally kept as a separate middleware so it
 * wraps any future yoga instance without modification.
 */
function createGraphQLHandler() {
  // Stub handler — replace with yoga.handleNodeRequest / yogaRouter when the
  // graphql-yoga package is installed.
  return function graphqlStubHandler(_req: Request, res: Response) {
    res.status(501).json({
      errors: [
        {
          message: 'GraphQL endpoint not yet implemented',
          extensions: { code: 'NOT_IMPLEMENTED' },
        },
      ],
    });
  };
}

/**
 * Returns Express middleware that blocks requests when the graphql_enabled
 * flag is off, and forwards to the real handler when it is on.
 */
function graphqlFeatureFlagMiddleware(handler: ReturnType<typeof createGraphQLHandler>) {
  return function (req: Request, res: Response, next: NextFunction) {
    if (!isEnabled(GRAPHQL_ENABLED)) {
      logger.debug('[graphql] graphql_enabled flag is off — returning 404');
      res.status(404).json({ error: 'Not Found' });
      return;
    }
    handler(req, res, next);
  };
}

/**
 * Mount the /graphql route on the Express application.
 *
 * The endpoint is guarded by the `graphql_enabled` feature flag (dynamic,
 * per-request). With the flag off, all requests to /graphql return 404.
 */
export function mountGraphQL(app: Application): void {
  const handler = createGraphQLHandler();
  const middleware = graphqlFeatureFlagMiddleware(handler);

  app.all('/graphql', middleware);
  logger.info('[graphql] /graphql endpoint registered (guarded by graphql_enabled flag)');
}
