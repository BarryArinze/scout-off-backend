/**
 * API Key Controller (#490)
 *
 * Allows scouts to issue, list, and revoke long-lived API keys for
 * server-to-server integrations.  The raw key is returned exactly once at
 * issuance time and never persisted.
 *
 * Two derived representations are stored per key:
 *  - `key_hash`    — `salt:sha256(salt+key)`, the authentication proof. Salted
 *                    per row, therefore not searchable.
 *  - `lookup_hash` — a deterministic keyed digest used purely to locate the
 *                    candidate row with one indexed query (#1033). Never
 *                    sufficient to authenticate on its own, and never exposed
 *                    in an API response. See src/utils/apiKeyLookup.ts.
 */
import { Request, Response, NextFunction } from 'express';
import { randomBytes, createHash } from 'crypto';
import { z } from 'zod';
import {
  insertApiKey,
  listApiKeysByWallet,
  revokeApiKeyById,
  getActiveApiKeyByLookupHash,
  getActiveApiKeysAwaitingLookupHash,
  setApiKeyLookupHash,
  ApiKeyRow,
} from '../db';
import { logger } from '../utils/logger';
import {
  parseApiKeyScopes,
  normalizeRequestedScopes,
} from '../utils/apiKeyScopes';
import { deriveApiKeyLookupHash } from '../utils/apiKeyLookup';

// ─── Hashing helpers (mirrors tokenBlocklist.ts conventions) ──────────────────

/** Length of the random salt prepended before hashing. */
const SALT_BYTES = 16;
const SEPARATOR = ':';

/**
 * Generate a random API key and the two representations persisted for it.
 *
 * Returns `{ key, keyHash, lookupHash }` where:
 *  - `key`        is the raw (plaintext) value, returned to the caller once
 *                 and never stored;
 *  - `keyHash`    is `salt:sha256(salt+key)` — the *authentication proof*,
 *                 salted per row and therefore not searchable;
 *  - `lookupHash` is the deterministic HMAC used to find this row by indexed
 *                 equality (#1033). It is only a locator; possession of it
 *                 does not authenticate. See src/utils/apiKeyLookup.ts.
 */
export function generateApiKey(): { key: string; keyHash: string; lookupHash: string } {
  const key = randomBytes(32).toString('hex'); // 64-char hex string
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = createHash('sha256').update(salt + key).digest('hex');
  const keyHash = `${salt}${SEPARATOR}${hash}`;
  return { key, keyHash, lookupHash: deriveApiKeyLookupHash(key) };
}

/**
 * Verify a raw API key against a stored `salt:hash` value.
 */
export function verifyApiKey(rawKey: string, keyHash: string): boolean {
  const separatorIndex = keyHash.indexOf(SEPARATOR);
  if (separatorIndex === -1) return false;
  const salt = keyHash.slice(0, separatorIndex);
  const hash = keyHash.slice(separatorIndex + 1);
  if (!salt || !hash) return false;
  const expected = createHash('sha256').update(salt + rawKey).digest('hex');
  // Timing-safe comparison
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf   = Buffer.from(hash, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedBuf.length; i++) {
    diff |= expectedBuf[i] ^ actualBuf[i];
  }
  return diff === 0;
}

export interface ResolvedApiKey {
  scout_wallet: string;
  id: number;
  scopes: string[] | null;
}

/** Build the resolver's return value from a verified row. */
function toResolvedApiKey(row: ApiKeyRow): ResolvedApiKey {
  return {
    scout_wallet: row.scout_wallet,
    id: row.id,
    scopes: parseApiKeyScopes(row.scopes, (message) => logger.warn(message)),
  };
}

/**
 * Resolve a raw API key string to the associated scout wallet.
 *
 * Two distinct steps, and they must not be conflated (#1033):
 *
 *   1. LOCATE — derive the deterministic lookup value for the presented key
 *      and fetch the single candidate row with an indexed equality query.
 *      This replaces the former "load every active key and re-hash each one"
 *      scan, whose cost grew linearly with the number of issued keys.
 *   2. VERIFY — prove possession of the raw key against that row's salted
 *      `key_hash` using the existing timing-safe comparison. A row located in
 *      step 1 is *not* authenticated until this succeeds.
 *
 * Returns `{ scout_wallet, id, scopes }` on success or null on failure —
 * identical to the pre-optimization contract, including for unknown, revoked
 * (filtered out by the query's `revoked_at IS NULL`) and malformed keys.
 *
 * `scopes` is the parsed scope list (`null` = legacy/unrestricted key) so
 * REST middleware and GraphQL context can enforce the shared scope contract
 * through one code path (see src/utils/apiKeyScopes.ts).
 *
 * This is intentionally exported so auth.ts can call it without creating a
 * circular dependency — auth.ts calls this function only at runtime via a
 * lazy require so the module graph stays acyclic at load time.
 */
export function resolveApiKey(rawKey: string): ResolvedApiKey | null {
  if (!rawKey || typeof rawKey !== 'string') return null;

  const lookupHash = deriveApiKeyLookupHash(rawKey);

  // ── 1. Indexed lookup ──────────────────────────────────────────────────────
  const candidate = getActiveApiKeyByLookupHash(lookupHash);
  if (candidate) {
    // ── 2. Cryptographic verification against the salted stored hash ─────────
    return verifyApiKey(rawKey, candidate.key_hash) ? toResolvedApiKey(candidate) : null;
  }

  return resolvePreMigrationApiKey(rawKey, lookupHash);
}

/**
 * TRANSITIONAL fallback for keys issued before db/024_api_key_lookup_hash.sql.
 *
 * Those rows have `lookup_hash IS NULL` and cannot be backfilled in SQL: only
 * a one-way salted hash of each key is stored, so the raw key needed to derive
 * the lookup value simply does not exist server-side. Rather than force every
 * scout to rotate, such a key is verified the old way *once* — against the
 * strictly-shrinking set of not-yet-migrated rows, never the full table — and
 * its lookup_hash is written on that first successful authentication, moving
 * it onto the indexed path for good.
 *
 * The set is backed by the partial index idx_api_keys_lookup_pending, so once
 * every active key has been healed this costs one empty indexed read. It is
 * deliberately not a general-purpose fallback: a wrong or revoked key never
 * reaches the full-table scan the old implementation performed.
 */
function resolvePreMigrationApiKey(rawKey: string, lookupHash: string): ResolvedApiKey | null {
  const pending: ApiKeyRow[] = getActiveApiKeysAwaitingLookupHash();
  for (const row of pending) {
    if (!verifyApiKey(rawKey, row.key_hash)) continue;
    try {
      setApiKeyLookupHash(row.id, lookupHash);
      logger.info({ action: 'api_key_lookup_hash_backfilled', keyId: row.id });
    } catch {
      // Best-effort: failing to persist the lookup value must never fail an
      // otherwise valid authentication. The row is simply retried next time.
    }
    return toResolvedApiKey(row);
  }
  return null;
}

// ─── Validation ───────────────────────────────────────────────────────────────

const issueKeySchema = z.object({
  label: z.string().max(100).default(''),
  /**
   * Optional explicit scope list. Omitted → legacy key with unrestricted
   * scout-level access (backward compatible). Restricted keys may only
   * perform operations covered by their granted scopes (#1019).
   */
  scopes: z.array(z.string()).optional(),
});

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /api/scouts/:wallet/api-keys
 *
 * Issue a new API key.  The plaintext key is returned exactly once in the
 * response and is never stored.  Subsequent GET calls return only the hash
 * prefix and metadata.
 */
export async function issueApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = issueKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid body' });
      return;
    }

    const scopesResult = normalizeRequestedScopes(parsed.data.scopes);
    if (!scopesResult.ok) {
      res.status(400).json({ success: false, error: scopesResult.error });
      return;
    }

    const { key, keyHash, lookupHash } = generateApiKey();
    const now = Math.floor(Date.now() / 1000);

    const grantedScopes = scopesResult.scopes;
    const id = insertApiKey({
      key_hash: keyHash,
      scout_wallet: req.params.wallet,
      label: parsed.data.label,
      created_at: now,
      scopes: grantedScopes.length > 0 ? grantedScopes : undefined,
      // Indexed lookup value (#1033). Persisted alongside the salted
      // verification hash so this key never touches the transitional scan
      // path; deliberately absent from the response body below.
      lookup_hash: lookupHash,
    });

    logger.info({ scout: req.params.wallet, action: 'api_key_issued', keyId: id, scopes: grantedScopes.length > 0 ? grantedScopes : null });

    res.status(201).json({
      success: true,
      data: {
        id,
        key,          // plaintext — returned once only
        label: parsed.data.label,
        created_at: now,
        // Empty array == legacy/unrestricted key (omitted scopes).
        scopes: grantedScopes,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/scouts/:wallet/api-keys
 *
 * List existing API keys.  Returns metadata and a truncated hash prefix for
 * display purposes only — the full hash and plaintext key are never returned.
 */
export async function listApiKeys(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rows: ApiKeyRow[] = listApiKeysByWallet(req.params.wallet);

    res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        label: r.label,
        key_prefix: r.key_hash.slice(0, 8) + '…', // display hint only
        created_at: r.created_at,
        last_used_at: r.last_used_at ?? null,
        revoked: r.revoked_at !== null,
        revoked_at: r.revoked_at ?? null,
        // Empty array = legacy/unrestricted key; otherwise the granted scope list.
        scopes: r.scopes ? (JSON.parse(r.scopes) as string[]) : [],
      })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/scouts/:wallet/api-keys/:id
 *
 * Revoke an API key by its row id.  After revocation the key is rejected by
 * the auth middleware.
 */
export async function revokeApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid API key id' });
      return;
    }

    const revoked = revokeApiKeyById(id, req.params.wallet);
    if (!revoked) {
      res.status(404).json({ success: false, error: 'API key not found' });
      return;
    }

    logger.info({ scout: req.params.wallet, action: 'api_key_revoked', keyId: id });

    res.json({ success: true, data: { id, revoked: true } });
  } catch (err) {
    next(err);
  }
}
