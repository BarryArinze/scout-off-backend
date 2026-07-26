// IPFS service via Pinata.
//
// When PINATA_API_KEY and PINATA_SECRET are not set:
//   - In non-production environments the service starts normally and pin operations
//     return deterministic stub values, logging a warning on each call.
//   - In production (NODE_ENV=production) pin operations throw immediately with a
//     clear error so misconfiguration is caught at call time rather than silently.
//
// IPFS failure handling (#346):
//   - Failures emit a CRITICAL log entry.
//   - The JSON payload is queued in the pending_pins SQLite table for async retry.
//
// Service dependency: Pinata (https://pinata.cloud)
//   Required env vars: PINATA_API_KEY, PINATA_SECRET
//   Optional env var:  PINATA_GATEWAY (default: https://gateway.pinata.cloud)

import { createHash } from 'crypto';
import axios from 'axios';
import FormData from 'form-data';
import config from '../config';
import { logger } from '../utils/logger';
import { insertPendingPin, getPendingPins, deletePendingPin, deletePendingPinByHash, isPendingPinByHash, incrementPendingPinAttempts } from '../db';
import { observeIpfsLatency } from '../middleware/metrics';

const PINATA_PIN_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';
const PINATA_PIN_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const PINATA_TEST_URL     = 'https://api.pinata.cloud/data/testAuthentication';

function isPinataConfigured(): boolean {
  return !!(config.pinata.apiKey && config.pinata.secret);
}

function assertPinataConfigured(): void {
  throw new Error(
    'IPFS service unavailable: PINATA_API_KEY and PINATA_SECRET must be set in production'
  );
}

function pinataHeaders() {
  return {
    pinata_api_key: config.pinata.apiKey,
    pinata_secret_api_key: config.pinata.secret,
  };
}

function devStubCid(seed: string): string {
  const n = seed.length + (seed.charCodeAt(0) || 0);
  return `bafymock${n}`;
}

// ---------------------------------------------------------------------------
// pinJson deduplication cache & inflight promise tracker (#466)
// ---------------------------------------------------------------------------

/**
 * Recursively serialize an object with sorted keys for deterministic hashing.
 * Using sorted-key serialization rather than JSON.stringify(obj) directly
 * because key insertion order is not guaranteed to be identical across call
 * sites, which would produce different hashes for semantically identical
 * objects.
 * No external stable-stringify dependency is needed — a small recursive
 * implementation is sufficient and keeps this self-contained.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(k => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`)
    .join(',');
  return `{${sorted}}`;
}

function hashMetadata(body: object): string {
  return createHash('sha256').update(canonicalStringify(body)).digest('hex');
}

interface PinCacheEntry { cid: string; timestamp: number; }

/**
 * In-memory deduplication cache and in-flight request tracker for pinJson calls.
 * Uses the pending_pins table as an atomic concurrency guard / mutex.
 */
const pinJsonCache = new Map<string, PinCacheEntry>();
const inflightPins = new Map<string, Promise<string>>();

/** Exposed for test teardown only — do not call in production code. */
export function clearPinJsonCache(): void {
  pinJsonCache.clear();
  inflightPins.clear();
}

/**
 * Returns the number of entries currently held in the pinJson deduplication cache.
 * Useful for metrics and health dashboards — a high count relative to unique
 * metadata submissions indicates healthy deduplication is occurring.
 */
export function getPinJsonCacheSize(): number {
  return pinJsonCache.size;
}

/**
 * Pin a JSON object to IPFS via Pinata. Returns the CID.
 *
 * Deduplication: the metadata is canonically serialized (sorted keys,
 * recursively) and hashed with sha256. If an identical hash was pinned
 * within the configured TTL (PIN_JSON_CACHE_TTL_MS, default 5 min) the
 * cached CID is returned immediately without hitting Pinata.
 *
 * Atomic Concurrency: pending_pins DB table and in-flight promises act as a mutex
 * so concurrent identical requests resolve to exactly one Pinata API call.
 */
export async function pinJson(body: object): Promise<string> {
  const start = Date.now();
  try {
    return await (async () => {
      const hash = hashMetadata(body);

      const ttlMs = config.pinJsonCacheTtlMs;
      const cached = pinJsonCache.get(hash);
      if (cached && Date.now() - cached.timestamp < ttlMs) {
        logger.debug(`[ipfs] pinJson cache hit — returning cached CID (hash=${hash.slice(0, 8)}…)`);
        return cached.cid;
      }

      if (inflightPins.has(hash)) {
        logger.debug(`[ipfs] pinJson inflight hit — waiting for in-flight request (hash=${hash.slice(0, 8)}…)`);
        return await inflightPins.get(hash)!;
      }

      if (!isPinataConfigured()) {
        if (process.env.NODE_ENV === 'production') assertPinataConfigured();
        logger.warn('[ipfs] Pinata not configured — returning dev stub CID for pinJson');
        return devStubCid(JSON.stringify(body));
      }

      const now = new Date().toISOString();
      const acquiredLock = insertPendingPin({
        payload: JSON.stringify(body),
        hash,
        created_at: now,
        last_tried: now,
      });

      if (acquiredLock === false) {
        logger.debug(`[ipfs] pinJson lock contended — polling for completion (hash=${hash.slice(0, 8)}…)`);
        const MAX_POLL_MS = 30000;
        while (Date.now() - start < MAX_POLL_MS) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const pollCached = pinJsonCache.get(hash);
          if (pollCached && Date.now() - pollCached.timestamp < ttlMs) {
            return pollCached.cid;
          }
          if (inflightPins.has(hash)) {
            return await inflightPins.get(hash)!;
          }
          if (!isPendingPinByHash(hash)) {
            const finalCached = pinJsonCache.get(hash);
            if (finalCached && Date.now() - finalCached.timestamp < ttlMs) {
              return finalCached.cid;
            }
            break;
          }
        }
      }

      const cid = await (async () => {
        try {
          const res = await axios.post(PINATA_PIN_JSON_URL, body, { headers: pinataHeaders() });
          return res.data.IpfsHash as string;
        } catch (err) {
          logger.critical('[ipfs] Pinata unavailable — queueing payload for retry', (err as Error).message);
          const failTime = new Date().toISOString();
          insertPendingPin({ payload: JSON.stringify(body), created_at: failTime, last_tried: failTime });
          throw err;
        } finally {
          deletePendingPinByHash(hash);
          inflightPins.delete(hash);
        }
      })();

      pinJsonCache.set(hash, { cid, timestamp: Date.now() });
      return cid;
    })();
  } finally {
    observeIpfsLatency('pinJson', Date.now() - start);
  }
}

export async function pinFile(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
  const start = Date.now();
  try {
    if (!isPinataConfigured()) {
      if (process.env.NODE_ENV === 'production') assertPinataConfigured();
      logger.warn('[ipfs] Pinata not configured — returning dev stub CID for pinFile');
      return devStubCid(filename);
    }
    const form = new FormData();
    form.append('file', buffer, { filename, contentType: mimeType });
    const res = await axios.post(PINATA_PIN_FILE_URL, form, {
      headers: { ...pinataHeaders(), ...form.getHeaders() },
      maxBodyLength: Infinity,
    });
    return res.data.IpfsHash as string;
  } finally {
    observeIpfsLatency('pinFile', Date.now() - start);
  }
}

/** Build a public gateway URL for a CID. */
export function gatewayUrl(cid: string): string {
  return `${config.pinata.gateway}/ipfs/${cid}`;
}

/** Build all public gateway URLs for a CID, in priority order. */
export function gatewayUrls(cid: string): string[] {
  return config.pinata.gateways.map(gateway => `${gateway}/ipfs/${cid}`);
}

/** Strip ipfs:// prefix from a URI, or return the input unchanged. */
export async function getCid(uriOrCid: string): Promise<string> {
  return uriOrCid.startsWith('ipfs://') ? uriOrCid.replace('ipfs://', '') : uriOrCid;
}

/**
 * Health check for the Pinata/IPFS dependency.
 * Resolves immediately (with a warning) when credentials are absent in non-production.
 * Rejects with a clear error in production without credentials.
 */
export async function checkHealth(): Promise<void> {
  const start = Date.now();
  try {
    if (!isPinataConfigured()) {
      if (process.env.NODE_ENV === 'production') assertPinataConfigured();
      logger.warn('[ipfs] Pinata not configured — skipping IPFS health check in dev');
      return;
    }
    await axios.get(PINATA_TEST_URL, { headers: pinataHeaders() });
  } finally {
    observeIpfsLatency('checkHealth', Date.now() - start);
  }
}

const MAX_RETRIES = 5;
const DEBOUNCE_MS = 60 * 1000; // 1 minute

/**
 * Retry queued pending_pins entries. Called periodically by the background worker.
 * Successfully pinned entries are removed from the queue.
 * Failed retries are backed off exponentially.
 * Rows exceeding MAX_RETRIES are skipped and considered permanently failed.
 */
export async function retryPendingPins(): Promise<void> {
  if (!isPinataConfigured()) return;
  const pending = getPendingPins();
  const now = Date.now();

  for (const row of pending) {
    if (row.attempts >= MAX_RETRIES) {
      continue; // Permanently failed
    }

    if (row.last_tried) {
      const lastTried = new Date(row.last_tried).getTime();
      const backoffMs = Math.pow(2, row.attempts) * DEBOUNCE_MS;
      if (now - lastTried < backoffMs) {
        continue; // Still in backoff window
      }
    }

    try {
      const body = JSON.parse(row.payload) as object;
      const res = await axios.post(PINATA_PIN_JSON_URL, body, { headers: pinataHeaders() });
      logger.info(`[ipfs] retried pending pin id=${row.id} cid=${res.data.IpfsHash as string}`);
      deletePendingPin(row.id);
    } catch {
      incrementPendingPinAttempts(row.id);
      logger.warn(`[ipfs] retry failed for pending pin id=${row.id}, attempt=${row.attempts + 1}`);
    }
  }
}

export default { pinJson, pinFile, gatewayUrl, getCid, checkHealth, retryPendingPins, clearPinJsonCache, getPinJsonCacheSize };
