import { getAllAuditLogRows, AuditLogRow } from '../db';
import { computeChainHash, auditChainContent, GENESIS_HASH } from './hashChain';

export interface AuditChainVerification {
  valid: boolean;
  /** id of the first row where the chain breaks, or null if the chain is intact. */
  brokenAtId: number | null;
  reason?: string;
  rowsChecked: number;
}

/**
 * Walks the entire audit_log table in id ASC order (i.e. hash-chain order,
 * across both admin actions and app events — see src/db/index.ts), recomputing
 * each row's expected hash from its own content plus the previous row's
 * *actual* stored hash (not the current row's stored prev_hash — comparing
 * against the previous row's real hash also catches a prev_hash column that
 * was tampered with in isolation). Returns the first point at which the chain
 * breaks, if any.
 *
 * A broken chain can mean: a row's content was edited after insertion, a row
 * was deleted (which shifts every subsequent row's expected prev_hash), or
 * rows were reordered/inserted out of band.
 */
export function verifyAuditChain(): AuditChainVerification {
  const rows: AuditLogRow[] = getAllAuditLogRows();
  let expectedPrevHash = GENESIS_HASH;

  for (const row of rows) {
    if (row.prev_hash !== expectedPrevHash) {
      return {
        valid: false,
        brokenAtId: row.id,
        reason: `row ${row.id}: stored prev_hash does not match the previous row's actual hash (a row may have been deleted, reordered, or its prev_hash tampered with)`,
        rowsChecked: rows.length,
      };
    }

    const expectedHash = computeChainHash(
      auditChainContent({
        action: row.action,
        adminWallet: row.admin_wallet,
        queryParams: row.query_params,
        createdAt: row.created_at,
        eventSource: row.event_source,
      }),
      expectedPrevHash
    );

    if (row.hash !== expectedHash) {
      return {
        valid: false,
        brokenAtId: row.id,
        reason: `row ${row.id}: stored hash does not match the hash recomputed from its content — row may have been tampered with`,
        rowsChecked: rows.length,
      };
    }

    expectedPrevHash = row.hash;
  }

  return { valid: true, brokenAtId: null, rowsChecked: rows.length };
}
