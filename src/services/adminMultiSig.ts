import { createId } from '@paralleldrive/cuid2';
import config from '../config';
import {
  insertPendingAdminAction,
  getPendingAdminActionById,
  updatePendingAdminActionStatus,
  insertAdminActionSignature,
  incrementActionSignatures,
  getAdminActionSignature,
  getAdminActionSignatures,
  expireStalePendingAdminActions,
  getPendingAdminActionsByStatus,
  PendingAdminActionRow,
} from '../db';
import { logAuditEvent } from './audit';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';

export type AdminActionType =
  | 'pause_contract'
  | 'unpause_contract'
  | 'withdraw_fees'
  | 'update_platform_fee'
  | 'register_validator'
  | 'revoke_validator'
  | 'bulk_validator_import';

export interface ProposalResult {
  actionId: string;
  status: 'proposed' | 'immediate';
}

export interface ApprovalResult {
  actionId: string;
  collected: number;
  required: number;
  status: 'approved' | 'pending' | 'expired' | 'duplicate';
}

// ─── Propose a high-value action ──────────────────────────────────────────────
// If threshold is 1, executes immediately (returns 'immediate').
// Otherwise persists a pending action for co-signing.

export function proposeAction(
  actionType: AdminActionType,
  payload: Record<string, unknown>,
  proposer: string,
): ProposalResult {
  expireStalePendingAdminActions();

  const required = config.adminThreshold;
  if (required <= 1) {
    logAuditEvent({
      action: `${actionType}_proposed`,
      adminWallet: proposer,
      queryParams: { actionType, threshold: required, outcome: 'immediate' },
      timestamp: new Date().toISOString(),
    });
    return { actionId: '', status: 'immediate' };
  }

  const actionId = createId();
  const now = Date.now();
  const expiresAt = now + config.adminActionTtlMs;

  insertPendingAdminAction({
    id: actionId,
    action_type: actionType,
    proposer,
    payload: JSON.stringify(payload),
    required_signatures: required,
    expires_at: expiresAt,
    created_at: now,
  });

  // The proposer is the first signer
  insertAdminActionSignature({ action_id: actionId, signer: proposer, signed_at: now });
  incrementActionSignatures(actionId);

  logAuditEvent({
    action: `${actionType}_proposed`,
    adminWallet: proposer,
    queryParams: {
      actionId,
      actionType,
      threshold: required,
      collected: 1,
      outcome: 'multisig_pending',
    },
    timestamp: new Date().toISOString(),
  });

  return { actionId, status: 'proposed' };
}

// ─── Co-sign an existing pending action ───────────────────────────────────────
// Each signer must be a distinct wallet from config.adminWallets.
// The same wallet cannot count twice. Expired proposals are rejected.
// Once the threshold is reached, status flips to 'executed'.

export function approveAction(
  actionId: string,
  signer: string,
): ApprovalResult {
  expireStalePendingAdminActions();

  const action = getPendingAdminActionById(actionId);
  if (!action) {
    throw Object.assign(new Error('Pending action not found'), { code: 'ACTION_NOT_FOUND', status: 404 });
  }
  if (action.status === 'expired') {
    throw Object.assign(new Error('Action proposal has expired'), { code: ErrorCode.EXPIRED_ACTION, status: 410 });
  }
  if (action.status === 'executed') {
    throw Object.assign(new Error('Action has already been executed'), { code: ErrorCode.ACTION_EXECUTED, status: 409 });
  }
  if (action.status !== 'pending') {
    throw Object.assign(new Error('Action is not in a pending state'), { code: ErrorCode.CONFLICT, status: 400 });
  }

  if (Date.now() > action.expires_at) {
    updatePendingAdminActionStatus(actionId, 'expired');
    throw Object.assign(new Error('Action proposal has expired'), { code: ErrorCode.EXPIRED_ACTION, status: 410 });
  }

  if (!config.adminWallets.includes(signer)) {
    throw Object.assign(new Error('Insufficient permissions'), { code: ErrorCode.FORBIDDEN, status: 403 });
  }

  // Check for duplicate signer
  const existingSig = getAdminActionSignature(actionId, signer);
  if (existingSig) {
    return {
      actionId,
      collected: action.collected_signatures,
      required: action.required_signatures,
      status: 'duplicate',
    };
  }

  const now = Date.now();
  insertAdminActionSignature({ action_id: actionId, signer, signed_at: now });
  incrementActionSignatures(actionId);

  const updated = getPendingAdminActionById(actionId);
  const collected = updated?.collected_signatures ?? action.collected_signatures + 1;

  logAuditEvent({
    action: `${action.action_type}_approved`,
    adminWallet: signer,
    queryParams: {
      actionId,
      actionType: action.action_type,
      collected,
      required: action.required_signatures,
      outcome: collected >= action.required_signatures ? 'threshold_met' : 'partially_signed',
    },
    timestamp: new Date().toISOString(),
  });

  if (collected >= action.required_signatures) {
    updatePendingAdminActionStatus(actionId, 'executed');
    logger.info(`[multisig] action=${action.action_type} id=${actionId} threshold=${action.required_signatures} collected=${collected} — executing`);
    return { actionId, collected, required: action.required_signatures, status: 'approved' };
  }

  return { actionId, collected, required: action.required_signatures, status: 'pending' };
}

// ─── Lookup pending actions (with expiry sweep) ──────────────────────────────

export function listPendingActions(): PendingAdminActionRow[] {
  expireStalePendingAdminActions();
  return getPendingAdminActionsByStatus('pending') as PendingAdminActionRow[];
}

export function getActionDetails(actionId: string): {
  action: PendingAdminActionRow;
  signatures: { signer: string; signed_at: number }[];
} | null {
  const action = getPendingAdminActionById(actionId);
  if (!action) return null;
  const signatures = getAdminActionSignatures(actionId);
  return { action, signatures };
}
