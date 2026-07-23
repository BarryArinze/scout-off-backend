import { Request, Response, NextFunction } from 'express';

export interface RouteMetric {
  count: number;
  totalLatencyMs: number;
}

export type ErrorRange = '4xx' | '5xx';

/** In-memory metrics store. Replace with Prometheus or similar in production. */
export const metricsStore: Record<string, RouteMetric> = {};

/** Tracks http_errors_total counter, labelled by status code range (4xx / 5xx). */
export const errorCountsStore: Record<ErrorRange, number> = { '4xx': 0, '5xx': 0 };

/** Whether metrics collection is enabled. Controlled by METRICS_ENABLED env var. */
export function isMetricsEnabled(): boolean {
  return process.env.METRICS_ENABLED !== 'false';
}

/**
 * Express middleware that increments per-route request counts, accumulates latency,
 * and tracks http_errors_total for 4xx and 5xx responses.
 * Disabled when METRICS_ENABLED=false.
 *
 * Unmatched routes (no req.route set — 404s, bot scans, arbitrary paths) are
 * aggregated under a single UNMATCHED_ROUTE_LABEL rather than keyed by the raw
 * req.path string. Without this bucketing, every distinct URL probed by scanners
 * or typos would permanently occupy an entry in metricsStore, giving an attacker
 * trivial unbounded cardinality growth to degrade Prometheus scraping.
 */
export const UNMATCHED_ROUTE_LABEL = 'unmatched_route';

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isMetricsEnabled()) {
    next();
    return;
  }
  const start = Date.now();
  res.on('finish', () => {
    // Use the matched Express route pattern when available; fall back to a
    // single constant label for all unmatched requests so scanner/bot traffic
    // cannot grow metricsStore without bound.
    const routeLabel = req.route?.path ?? UNMATCHED_ROUTE_LABEL;
    const key = `${req.method} ${routeLabel}`;
    const latency = Date.now() - start;
    if (!metricsStore[key]) {
      metricsStore[key] = { count: 0, totalLatencyMs: 0 };
    }
    metricsStore[key].count += 1;
    metricsStore[key].totalLatencyMs += latency;
    observeLatency(latency);

    const status = res.statusCode;
    if (status >= 400 && status < 500) {
      errorCountsStore['4xx'] += 1;
    } else if (status >= 500) {
      errorCountsStore['5xx'] += 1;
    }
  });
  next();
}

/** Returns a snapshot of collected route metrics. */
export function getMetrics(): Record<string, RouteMetric> {
  return { ...metricsStore };
}

/** Returns a snapshot of http_errors_total counters. */
export function getErrorMetrics(): Record<ErrorRange, number> {
  return { ...errorCountsStore };
}

// ─── Request-duration histogram ────────────────────────────────────────────────

/** Upper bounds (inclusive) for the request-duration histogram, in milliseconds. */
export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

export interface LatencyHistogram {
  /** bucketCounts[i] = number of observations with latency <= LATENCY_BUCKETS_MS[i] (cumulative). */
  bucketCounts: number[];
  sum: number;
  count: number;
}

export const latencyHistogram: LatencyHistogram = {
  bucketCounts: LATENCY_BUCKETS_MS.map(() => 0),
  sum: 0,
  count: 0,
};

/** Records a single request latency into the cumulative histogram. */
function observeLatency(latencyMs: number): void {
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    if (latencyMs <= LATENCY_BUCKETS_MS[i]) latencyHistogram.bucketCounts[i] += 1;
  }
  latencyHistogram.sum += latencyMs;
  latencyHistogram.count += 1;
}

/** Returns a snapshot of the request-duration histogram. */
export function getLatencyHistogram(): LatencyHistogram {
  return {
    bucketCounts: [...latencyHistogram.bucketCounts],
    sum: latencyHistogram.sum,
    count: latencyHistogram.count,
  };
}

/** Resets every metric store. Intended for test isolation. */
export function resetMetrics(): void {
  Object.keys(metricsStore).forEach((k) => delete metricsStore[k]);
  errorCountsStore['4xx'] = 0;
  errorCountsStore['5xx'] = 0;
  latencyHistogram.bucketCounts = LATENCY_BUCKETS_MS.map(() => 0);
  latencyHistogram.sum = 0;
  latencyHistogram.count = 0;
}

// ─── Prometheus exposition ──────────────────────────────────────────────────────

/** Content-Type for the Prometheus text exposition format (v0.0.4). */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Escapes a Prometheus label value (backslash, double-quote, newline). */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export interface SerializeMetricsExtras {
  /** Optional indexer_ledger_lag gauge value, injected by the caller. */
  indexerLedgerLag?: number;
}

/**
 * Serialises all collected metrics into Prometheus text exposition format.
 * Takes external gauges (e.g. indexer lag) as parameters so this stays free of
 * any dependency on the indexer or the rest of the app — it is pure and unit
 * testable on its own.
 */
export function serializeMetrics(extras: SerializeMetricsExtras = {}): string {
  const routes = getMetrics();
  const errors = getErrorMetrics();
  const hist = getLatencyHistogram();
  const lines: string[] = [];

  // Request count (counter) — one series per route.
  lines.push('# HELP http_requests_total Total number of HTTP requests per route');
  lines.push('# TYPE http_requests_total counter');
  for (const [route, m] of Object.entries(routes)) {
    lines.push(`http_requests_total{route="${escapeLabelValue(route)}"} ${m.count}`);
  }

  // Request duration (histogram) — cumulative buckets plus _sum and _count.
  lines.push('# HELP http_request_duration_ms Request latency in milliseconds');
  lines.push('# TYPE http_request_duration_ms histogram');
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    lines.push(`http_request_duration_ms_bucket{le="${LATENCY_BUCKETS_MS[i]}"} ${hist.bucketCounts[i]}`);
  }
  lines.push(`http_request_duration_ms_bucket{le="+Inf"} ${hist.count}`);
  lines.push(`http_request_duration_ms_sum ${hist.sum}`);
  lines.push(`http_request_duration_ms_count ${hist.count}`);

  // Error rate (counter) — labelled by status class.
  lines.push('# HELP http_errors_total Total number of HTTP error responses by status class');
  lines.push('# TYPE http_errors_total counter');
  lines.push(`http_errors_total{range="4xx"} ${errors['4xx']}`);
  lines.push(`http_errors_total{range="5xx"} ${errors['5xx']}`);

  // Indexer lag (gauge) — optional, injected by the caller.
  if (extras.indexerLedgerLag !== undefined) {
    lines.push('# HELP indexer_ledger_lag Ledgers behind the chain tip after the last poll');
    lines.push('# TYPE indexer_ledger_lag gauge');
    lines.push(`indexer_ledger_lag ${extras.indexerLedgerLag}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Builds the GET /metrics Express handler. The indexer-lag getter is injected so
 * this module never imports the indexer.
 */
export function createMetricsHandler(getIndexerLedgerLag: () => number = () => 0) {
  return (_req: Request, res: Response): void => {
    res.set('Content-Type', PROMETHEUS_CONTENT_TYPE);
    res.send(serializeMetrics({ indexerLedgerLag: getIndexerLedgerLag() }));
  };
}
