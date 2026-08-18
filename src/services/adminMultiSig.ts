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
  insertValidator,
  revokeValidatorRow,
  insertFeeWithdrawal,
  getDb,
} from '../db';
import { logAuditEvent } from './audit';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';
import {
  pauseContractOnChain,
  unpauseContractOnChain,
  withdrawFees as stellarWithdrawFees,
  registerValidatorOnChain,
  revokeValidatorOnChain,
  type FeeWithdrawalResult,
  type ContractActionResult,
} from './stellar';

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

export interface ExecutionResult {
  success: boolean;
  transactionId?: string;
  error?: string;
  errorCode?: string;
}

// ─── Execute the privileged operation for a specific action type ──────────────
async function executeAdminAction(
  actionType: AdminActionType,
  payload: Record<string, unknown>,
  proposer: string,
): Promise<ExecutionResult> {
  try {
    switch (actionType) {
      case 'pause_contract': {
        const result: ContractActionResult = await pauseContractOnChain(proposer);
        return { success: true, transactionId: result.transactionId };
      }

      case 'unpause_contract': {
        const result: ContractActionResult = await unpauseContractOnChain(proposer);
        return { success: true, transactionId: result.transactionId };
      }

      case 'withdraw_fees': {
        const recipient = payload.recipient as string;
        if (!recipient) {
          return { success: false, error: 'Missing recipient in payload', errorCode: 'INVALID_PAYLOAD' };
        }
        const result: FeeWithdrawalResult = await stellarWithdrawFees(recipient);
        
        // Record the withdrawal in the database
        try {
          insertFeeWithdrawal({
            idempotencyKey: null, // Multi-sig actions don't use idempotency keys
            treasuryAddress: recipient,
            amountStroops: result.amount,
            txHash: result.transactionId,
            adminWallet: proposer,
            createdAt: new Date().toISOString(),
          });
        } catch (dbErr) {
          logger.error(`[multisig] fee_withdrawal_db_insert_failed txHash=${result.transactionId} err=${dbErr instanceof Error ? dbErr.message : dbErr}`);
        }
        
        return { success: true, transactionId: result.transactionId };
      }

      case 'register_validator': {
        const validatorWallet = payload.validatorWallet as string;
        if (!validatorWallet) {
          return { success: false, error: 'Missing validatorWallet in payload', errorCode: 'INVALID_PAYLOAD' };
        }
        const result: ContractActionResult = await registerValidatorOnChain(validatorWallet);
        
        // Record the validator in the database
        insertValidator(validatorWallet, result.transactionId);
        
        return { success: true, transactionId: result.transactionId };
      }

      case 'revoke_validator': {
        const validatorWallet = payload.validatorWallet as string;
        if (!validatorWallet) {
          return { success: false, error: 'Missing validatorWallet in payload', errorCode: 'INVALID_PAYLOAD' };
        }
        const result: ContractActionResult = await revokeValidatorOnChain(validatorWallet);
        
        // Record the revocation in the database
        revokeValidatorRow(validatorWallet, result.transactionId);
        
        return { success: true, transactionId: result.transactionId };
      }

      case 'bulk_validator_import': {
        // For bulk import, we just register individual validators
        // The controller handles the bulk logic by creating multiple individual actions
        const { wallet, label, region } = payload;
        if (!wallet) {
          return { success: false, error: 'Missing wallet in payload', errorCode: 'INVALID_PAYLOAD' };
        }
        const result: ContractActionResult = await registerValidatorOnChain(wallet as string);
        
        // Record the validator in the database
        insertValidator(wallet as string, result.transactionId);
        
        return { success: true, transactionId: result.transactionId };
      }

      case 'update_platform_fee': {
        // This would require a stellar contract function that doesn't exist yet
        // For now, return a placeholder response
        logger.warn(`[multisig] update_platform_fee not yet implemented in stellar service`);
        return { success: false, error: 'update_platform_fee not yet implemented', errorCode: 'NOT_IMPLEMENTED' };
      }

      default: {
        return { success: false, error: `Unknown action type: ${actionType}`, errorCode: 'INVALID_ACTION_TYPE' };
      }
    }
  } catch (err) {
    logger.error(`[multisig] execution_failed action=${actionType} error=${err instanceof Error ? err.message : err}`);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      errorCode: (err as any)?.code || 'EXECUTION_FAILED',
    };
  }
}

export interface ExecutionResult {
  success: boolean;
  transactionId?: string;
  error?: string;
  errorCode?: string;
}

// ─── Execute the privileged operation for a specific action type ──────────────
async function executeAdminAction(
  actionType: AdminActionType,
  payload: Record<string, unknown>,
  proposer: string,
): Promise<ExecutionResult> {
  try {
    switch (actionType) {
      case 'pause_contract': {
        const result: ContractActionResult = await pauseContractOnChain(proposer);
        return { success: true, transactionId: result.transactionId };
      }

      case 'unpause_contract': {
        const result: ContractActionResult = await unpauseContractOnChain(proposer);
        return { success: true, transactionId: result.transactionId };
      }

      case 'withdraw_fees': {
        const recipient = payload.recipient as string;
        if (!recipient) {
          return { success: false, error: 'Missing recipient in payload', errorCode: 'INVALID_PAYLOAD' };
        }
        const result: FeeWithdrawalResult = await stellarWithdrawFees(recipient);
        
        // Record the withdrawal in the database
        try {
          insertFeeWithdrawal({
            idempotencyKey: null, // Multi-sig actions don't use idempotency keys
            treasuryAddress: recipient,
            amountStroops: result.amount,
            txHash: result.transactionId,
            adminWallet: proposer,
            createdAt: new Date().toISOString(),
          });
        } catch (dbErr) {
          logger.error(`[multisig] fee_withdrawal_db_insert_failed txHash=${result.transactionId} err=${dbErr instanceof Error ? dbErr.message : dbErr}`);
        }
        
        return { success: true, transactionId: result.transactionId };
      }

      case 'register_validator': {
        const validatorWallet = payload.validatorWallet as string;
        if (!validatorWallet) {
          return { success: false, error: 'Missing validatorWallet in payload', errorCode: 'INVALID_PAYLOAD' };
        }
        const result: ContractActionResult = await registerValidatorOnChain(validatorWallet);
        
        // Record the validator in the database
        insertValidator(validatorWallet, result.transactionId);
        
        return { success: true, transactionId: result.transactionId };
      }

      case 'revoke_validator': {
        const validatorWallet = payload.validatorWallet as string;
        if (!validatorWallet) {
          return { success: false, error: 'Missing validatorWallet in payload', errorCode: 'INVALID_PAYLOAD' };
        }
        const result: ContractActionResult = await revokeValidatorOnChain(validatorWallet);
        
        // Record the revocation in the database
        revokeValidatorRow(validatorWallet, result.transactionId);
        
        return { success: true, transactionId: result.transactionId };
      }

      case 'bulk_validator_import': {
        // For bulk import, we just register individual validators
        // The controller handles the bulk logic by creating multiple individual actions
        const { wallet, label, region } = payload;
        if (!wallet) {
          return { success: false, error: 'Missing wallet in payload', errorCode: 'INVALID_PAYLOAD' };
        }
        const result: ContractActionResult = await registerValidatorOnChain(wallet as string);
        
        // Record the validator in the database
        insertValidator(wallet as string, result.transactionId);
        
        return { success: true, transactionId: result.transactionId };
      }

      case 'update_platform_fee': {
        // This would require a stellar contract function that doesn't exist yet
        // For now, return a placeholder response
        logger.warn(`[multisig] update_platform_fee not yet implemented in stellar service`);
        return { success: false, error: 'update_platform_fee not yet implemented', errorCode: 'NOT_IMPLEMENTED' };
      }

      default: {
        return { success: false, error: `Unknown action type: ${actionType}`, errorCode: 'INVALID_ACTION_TYPE' };
      }
    }
  } catch (err) {
    logger.error(`[multisig] execution_failed action=${actionType} error=${err instanceof Error ? err.message : err}`);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      errorCode: (err as any)?.code || 'EXECUTION_FAILED',
    };
  }
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

export async function approveAction(
  actionId: string,
  signer: string,
): Promise<ApprovalResult> {
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

  // Atomic signature collection: check for duplicate, insert signature, and increment count
  // This entire sequence must be atomic to prevent race conditions
  let collected: number;
  let thresholdReached = false;
  
  try {
    const result = getDb().transaction(() => {
      // Check for duplicate signer within the transaction
      const existingSig = getAdminActionSignature(actionId, signer);
      if (existingSig) {
        return { duplicate: true, collected: action.collected_signatures };
      }

      // Insert signature and increment counter atomically
      const now = Date.now();
      insertAdminActionSignature({ action_id: actionId, signer, signed_at: now });
      incrementActionSignatures(actionId);

      // Get updated count
      const updatedAction = getPendingAdminActionById(actionId);
      const newCollected = updatedAction?.collected_signatures ?? action.collected_signatures + 1;
      
      return { duplicate: false, collected: newCollected };
    });
    
    if (result.duplicate) {
      return {
        actionId,
        collected: result.collected,
        required: action.required_signatures,
        status: 'duplicate',
      };
    }
    
    collected = result.collected;
    thresholdReached = collected >= action.required_signatures;
  } catch (err) {
    logger.error(`[multisig] atomic_signature_failed actionId=${actionId} signer=${signer} error=${err instanceof Error ? err.message : err}`);
    throw Object.assign(new Error('Failed to record signature'), { code: 'SIGNATURE_FAILED', status: 500 });
  }

  logAuditEvent({
    action: `${action.action_type}_approved`,
    adminWallet: signer,
    queryParams: {
      actionId,
      actionType: action.action_type,
      collected,
      required: action.required_signatures,
      outcome: thresholdReached ? 'threshold_met' : 'partially_signed',
    },
    timestamp: new Date().toISOString(),
  });

  if (thresholdReached) {
    updatePendingAdminActionStatus(actionId, 'executed');
    logger.info(`[multisig] action=${action.action_type} id=${actionId} threshold=${action.required_signatures} collected=${collected} — executing`);
    
    // Execute the actual privileged operation now that quorum is reached
    const payload = JSON.parse(action.payload);
    const executionResult = await executeAdminAction(action.action_type as AdminActionType, payload, action.proposer);
    
    if (!executionResult.success) {
      // Execution failed - update audit log and return error status
      logAuditEvent({
        action: `${action.action_type}_execution_failed`,
        adminWallet: signer,
        queryParams: {
          actionId,
          actionType: action.action_type,
          error: executionResult.error,
          errorCode: executionResult.errorCode,
          outcome: 'execution_failed',
        },
        timestamp: new Date().toISOString(),
      });
      
      // Update status to reflect execution failure - this allows for retry/resolution
      updatePendingAdminActionStatus(actionId, 'pending');
      
      throw Object.assign(new Error(executionResult.error || 'Execution failed'), { 
        code: executionResult.errorCode || 'EXECUTION_FAILED', 
        status: 500 
      });
    }
    
    // Execution succeeded - log the success
    logAuditEvent({
      action: `${action.action_type}_executed`,
      adminWallet: signer,
      queryParams: {
        actionId,
        actionType: action.action_type,
        transactionId: executionResult.transactionId,
        outcome: 'execution_succeeded',
      },
      timestamp: new Date().toISOString(),
    });
    
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
