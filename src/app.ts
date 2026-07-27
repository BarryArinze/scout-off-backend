import express from 'express';
import cors, { CorsOptions } from 'cors';
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
import { API_PREFIX, API_V1_PREFIX } from './config';
import { mountGraphQL } from './graphql';
import { metricsMiddleware, createMetricsHandler } from './middleware/metrics';
import { ipReputationMiddleware } from './middleware/ipReputation';
import { requestTimeout } from './middleware/timeout';
import { indexerLedgerLag } from './services/indexer';
import { getDb } from './db';
import { getVersionInfo } from './version';
import { apiVersion } from './middleware/apiVersion';
import docsRouter from './routes/docs';
import { logger } from './utils/logger';

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

// ─── CORS ─────────────────────────────────────────────────────────────────────
//
// Allowed origins are driven by the CORS_ALLOWED_ORIGINS env var (comma-separated).
// In development and test we default to '*' (any origin).
// In production/staging we use an explicit allowlist; if none is configured we
// log a warning and reject all cross-origin requests.

const isDevOrTest = config.nodeEnv === 'development' || config.nodeEnv === 'test';
const allowedOrigins = config.corsAllowedOrigins;

if (!isDevOrTest && (!allowedOrigins || allowedOrigins.length === 0)) {
  logger.warn(
    '[cors] WARNING: CORS_ALLOWED_ORIGINS is not set in production. ' +
    'All cross-origin requests will be rejected.',
  );
}

const isWildcard = allowedOrigins.includes('*');

const corsOptions: CorsOptions = {
  // Callback-based origin so we can do per-request allow/deny
  origin: (origin, callback) => {
    // Same-origin or server-to-server (no Origin header) — always allow
    if (!origin) {
      callback(null, true);
      return;
    }

    // Wildcard: allow all (dev / test only)
    if (isWildcard) {
      callback(null, '*');
      return;
    }

    // Explicit allowlist check (case-sensitive, exact match)
    if (allowedOrigins.includes(origin)) {
      callback(null, origin);
      return;
    }

    // Not in the allowlist — suppress the CORS header (no error thrown so the
    // request still gets a response body, but the browser will block it)
    callback(null, false);
  },
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-API-Key',
    'X-Correlation-ID',
    'X-Idempotency-Key',
    'X-API-Version',
  ],
  exposedHeaders: ['ETag', 'X-Correlation-ID', 'X-Response-Time', 'X-API-Version'],
  // credentials cannot be used with a wildcard origin (CORS spec); only enable
  // it when we are using an explicit allowlist
  credentials: !isWildcard,
  maxAge: 86400, // 24 hours — browsers cache pre-flight for this duration
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

const app = express();
// Disable Express's default X-Powered-By header. helmet() also does this, but
// being explicit here ensures it is suppressed regardless of middleware order.
app.disable('x-powered-by');
// Disable Express's automatic ETag on every response — it would also tag
// error bodies (e.g. 404s). ETags are set explicitly where conditional GET
// support is actually implemented (see getPlayer).
app.set('etag', false);

// Apply CORS with the callback-based options built above.
// Also handle pre-flight OPTIONS requests explicitly so they short-circuit
// before any auth or body-parser middleware runs.
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
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
// Configure Express body parser with JSON payload size limit
// Returns 413 Payload Too Large if exceeded
app.use(express.json({ limit: config.bodyLimit.json }));
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

// Mount API routes under both /api (backwards-compatible alias) and /api/v1
const prefixes = [API_PREFIX, API_V1_PREFIX];
for (const prefix of prefixes) {
  app.use(`${prefix}/docs`, docsRouter);
  app.use(`${prefix}/players`, playerRoutes);
  app.use(`${prefix}/scouts`, scoutRoutes);
  app.use(`${prefix}/validators`, validatorRoutes);
  app.use(`${prefix}/admin`, adminRoutes);
}

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
