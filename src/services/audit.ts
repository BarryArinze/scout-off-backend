import { logger } from '../utils/logger';
import { insertAuditLog } from '../db';

export interface AuditEvent {
  action: string;
  timestamp: string;
  /** Optional: contract action name for admin smart contract interactions (e.g. 'pause_contract') */
  contractAction?: string;
  adminWallet?: string;
  queryParams?: Record<string, unknown>;
  /** Optional: request path, for auth_failed/auth_forbidden events. */
  path?: string;
  /** Optional: human-readable reason, for auth_failed/auth_forbidden events. */
  reason?: string;
  /** Optional: role required by the route, for auth_failed/auth_forbidden events. */
  requiredRole?: string;
}

/**
 * Log an audit event for compliance tracking.
 * Persists to the audit_log SQLite table and emits an info log line.
 */
export function logAuditEvent(event: AuditEvent): void {
  logger.info('[audit]', JSON.stringify(event));
  try {
    insertAuditLog({
      action: event.contractAction ?? event.action,
      adminWallet: event.adminWallet,
      queryParams: { ...event.queryParams, ...(event.contractAction ? { parentAction: event.action } : {}) },
      createdAt: event.timestamp,
    });
  } catch {
    // DB write failure must not break the request
    logger.warn('[audit] failed to persist audit event to DB');
  }
}
