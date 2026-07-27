import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import config from './config';
import authRoutes from './routes/auth';
import playerRoutes from './routes/player';
import scoutRoutes from './routes/scout';
import validatorRoutes from './routes/validator';
import adminRoutes from './routes/admin';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { securityHeaders } from './middleware/securityHeaders';
import { correlationId } from './middleware/correlationId';
import { traceId } from './middleware/traceId';
import { responseTime } from './middleware/responseTime';
import { stellarHealth, stellarBreaker } from './services/stellar';
import { checkHealth } from './services/ipfs';
import { API_PREFIX, API_V1_PREFIX, API_V2_PREFIX } from './config';
import { mountGraphQL } from './graphql';
import { metricsMiddleware, createMetricsHandler } from './middleware/metrics';
import { ipReputationMiddleware } from './middleware/ipReputation';
import { requestTimeout } from './middleware/timeout';
import { indexerLedgerLag } from './services/indexer';
import { getDb } from './db';
import { getVersionInfo } from './version';
import { apiVersion } from './middleware/apiVersion';
import { versionRouting } from './middleware/versionRouting';
import docsRouter from './routes/docs';
import {
  playerRoutes as playerRoutesV2,
  scoutRoutes as scoutRoutesV2,
  validatorRoutes as validatorRoutesV2,
  adminRoutes as adminRoutesV2,
} from './routes/v2';

/** Probe the SQLite database with a lightweight SELECT 1.
 *  Resolves 'ok' or 'error'; never rejects.
 *  A configurable timeout (default 2 s) guards against a locked DB hanging the health check.
 */
async function probeDb(timeoutMs = 2_000): Promise<'ok' | 'error'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('error'), timeoutMs);
    try {
      getDb().prepare('SELECT 1').get();
      clearTimeout(timer);
      resolve('ok');
    } catch {
      clearTimeout(timer);
      resolve('error');
    }
  });
}

/** Probe SQLite writability with a heartbeat-row upsert into indexer_state.
 *  Catches disk-full/permissions regressions that a read-only SELECT 1 would miss.
 *  Resolves 'ok' or 'error'; never rejects.
 *  A configurable timeout (default 2 s) guards against a locked DB hanging the readiness check.
 */
async function probeDbWritable(timeoutMs = 2_000): Promise<'ok' | 'error'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('error'), timeoutMs);
    try {
      getDb()
        .prepare(
          "INSERT INTO indexer_state (key, value) VALUES ('health_heartbeat', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(Date.now()));
      clearTimeout(timer);
      resolve('ok');
    } catch {
      clearTimeout(timer);
      resolve('error');
    }
  });
}

const app = express();
// Disable Express's default X-Powered-By header. helmet() also does this, but
// being explicit here ensures it is suppressed regardless of middleware order.
app.disable('x-powered-by');
// Disable Express's automatic ETag on every response — it would also tag
// error bodies (e.g. 404s). ETags are set explicitly where conditional GET
// support is actually implemented (see getPlayer).
app.set('etag', false);

const corsOrigin =
  config.allowedOrigins.includes('*')
    ? '*'
    : config.allowedOrigins;
app.use(cors({ origin: corsOrigin }));
app.use(compression({ threshold: parseInt(process.env.COMPRESSION_THRESHOLD ?? '1024', 10) }));
app.use(requestTimeout);
app.use(correlationId);
app.use(traceId);
// helmet first so the explicit values below (driven by config.securityHeaders) win
// on any header both middlewares set.
app.use(helmet());
app.use(securityHeaders);
app.use(responseTime);
// Set X-API-Version on every response before route handlers run
app.use(apiVersion);
// Configure Express body parser with per-route JSON payload size limits.
// Upload endpoints (player registration, milestone evidence) accept larger payloads.
// Auth endpoints are restricted to prevent DoS via large JWT bodies.
// All other routes use the global JSON_PAYLOAD_LIMIT (default 1 MB).
const uploadJsonParser = express.json({ limit: config.bodyLimit.upload });
const authJsonParser = express.json({ limit: config.bodyLimit.auth });
const defaultJsonParser = express.json({ limit: config.bodyLimit.json });

const UPLOAD_PATHS = new Set([
  '/api/players/register', '/api/v1/players/register',
  '/api/validators/milestone', '/api/v1/validators/milestone',
]);
const AUTH_PATHS = new Set(['/auth/token', '/auth/challenge']);

app.use((req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    if (UPLOAD_PATHS.has(req.path)) return uploadJsonParser(req, res, next);
    if (AUTH_PATHS.has(req.path)) return authJsonParser(req, res, next);
  }
  defaultJsonParser(req, res, next);
});
app.use(requestLogger);
// Collect per-route request counts, latency, and error counts for /metrics.
app.use(metricsMiddleware);
// IP reputation layer — runs after metrics so the finish hook in
// metricsMiddleware is registered first, keeping score increments in order.
app.use(ipReputationMiddleware);

app.get('/version', (_req, res) => {
  res.json(getVersionInfo());
});

app.get('/health', async (_req, res) => {
  const healthStatus: Record<string, 'ok' | 'error' | 'disabled'> = {};

  if (config.stellarHealthCheckEnabled) {
    const stellarOk = await stellarHealth();
    healthStatus.stellar = stellarOk ? 'ok' : 'error';
  } else {
    healthStatus.stellar = 'disabled';
  }

  healthStatus.db = await probeDb();

  res.json({ status: 'ok', healthStatus });
});

async function checkReadiness(): Promise<Record<string, 'ok' | 'unavailable' | 'disabled'>> {
  const services: Record<string, 'ok' | 'unavailable' | 'disabled'> = {};

  services.db = (await probeDbWritable()) === 'ok' ? 'ok' : 'unavailable';

  try {
    await checkHealth();
    services.ipfs = 'ok';
  } catch {
    services.ipfs = 'unavailable';
  }

  if (config.stellarHealthCheckEnabled) {
    if (stellarBreaker.state === 'OPEN') {
      services.stellar = 'unavailable';
    } else {
      try {
        const stellarOk = await stellarHealth();
        services.stellar = stellarOk ? 'ok' : 'unavailable';
      } catch {
        services.stellar = 'unavailable';
      }
    }
  } else {
    services.stellar = 'disabled';
  }

  return services;
}

app.get('/ready', async (_req, res) => {
  const services = await checkReadiness();
  const allOk = Object.values(services).every(v => v === 'ok' || v === 'disabled');
  if (allOk) {
    res.json({ status: 'ok', services });
  } else {
    res.status(503).json({ status: 'degraded', services });
  }
});

// Kubernetes-style liveness and readiness probes
app.get('/health/liveness', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/health/readiness', async (_req, res) => {
  const services = await checkReadiness();
  const allOk = Object.values(services).every(v => v === 'ok' || v === 'disabled');
  if (allOk) {
    res.json({ status: 'ok', services });
  } else {
    res.status(503).json({ status: 'degraded', services });
  }
});

// Prometheus scrape endpoint. Intentionally unauthenticated and not rate-limited
// (standard scrape pattern): it is registered before the auth routes and is not
// wrapped by any auth or rate-limit middleware.
app.get('/metrics', createMetricsHandler(() => indexerLedgerLag));

app.use('/auth', authRoutes);

// ── API-Version response header ───────────────────────────────────────────────
// Set the API-Version response header based on the URL prefix (or header override).
// This runs on every /api/* request so clients always know which version handled them.
app.use((req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
  const url = req.originalUrl;
  if (url.startsWith(API_PREFIX + '/') || url.startsWith(API_PREFIX + '?') || url === API_PREFIX) {
    let servedVersion = 1;
    if (
      req.apiVersionOverride === 2 ||
      url.startsWith(API_V2_PREFIX + '/') ||
      url === API_V2_PREFIX
    ) {
      servedVersion = 2;
    }
    res.setHeader('API-Version', String(servedVersion));
  }
  next();
});

// Mount API routes under both /api (backwards-compatible alias) and /api/v1
const prefixes = [API_PREFIX, API_V1_PREFIX];
for (const prefix of prefixes) {
  app.use(`${prefix}/docs`, docsRouter);
  app.use(`${prefix}/players`, playerRoutes);
  app.use(`${prefix}/scouts`, scoutRoutes);
  app.use(`${prefix}/validators`, validatorRoutes);
  app.use(`${prefix}/admin`, adminRoutes);
}

// /api/v2 routes — currently identical to v1 handlers; new v2-only routes added here
app.use(`${API_V2_PREFIX}/docs`, docsRouter);
app.use(`${API_V2_PREFIX}/players`, playerRoutesV2);
app.use(`${API_V2_PREFIX}/scouts`, scoutRoutesV2);
app.use(`${API_V2_PREFIX}/validators`, validatorRoutesV2);
app.use(`${API_V2_PREFIX}/admin`, adminRoutesV2);

// Header-based v2 routing: when a client sends API-Version: 2 on an unversioned
// /api/ path, the versionRouting middleware records req.apiVersionOverride = 2 and
// the API-Version response header above reflects that. The request is handled by
// the same v1 handler set (v2 is currently identical to v1).

// Mount the GraphQL endpoint alongside the REST API.
// Must be registered before the 404 catch-all.
mountGraphQL(app);

// Catch-all 404 handler for unmatched routes.
// Returns JSON so API clients never receive an HTML error page.
// Must be registered after all other routes and before the error handler.
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path });
});

app.use(errorHandler);

export default app;
