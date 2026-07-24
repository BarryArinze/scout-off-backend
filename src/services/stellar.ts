import {
  SorobanRpc,
  Networks,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  Account,
  Address,
  scValToNative,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';

const tracer = trace.getTracer('scout-off-backend');

const server = new SorobanRpc.Server(config.sorobanRpcUrl, {
  allowHttp: config.sorobanRpcUrl.startsWith('http://'),
});

export { server };

export function networkPassphrase(): string {
  return config.network === 'mainnet'
    ? Networks.PUBLIC
    : Networks.TESTNET;
}

export async function getLatestLedger(): Promise<number> {
  const ledger = await server.getLatestLedger();
  return ledger.sequence;
}

export type PaymentStatus = 'pending' | 'submitted' | 'failed';

export interface ContactPaymentResult {
  transactionId: string;
  status: PaymentStatus;
}

export class PaymentError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'INSUFFICIENT_FUNDS'
      | 'INVALID_ACCOUNT'
      | 'NETWORK_ERROR'
      | 'MISSING_PLAYER'
      | 'EXPIRED_TRUSTLINE'
      | 'CONTRACT_ERROR'
      | 'UNKNOWN',
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

/**
 * Ping the Soroban RPC to verify network reachability.
 */
export async function stellarHealth(): Promise<boolean> {
  try {
    await server.getLatestLedger();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a scout has an active on-chain subscription by invoking
 * `is_subscribed(scout)` on the Soroban contract via simulateTransaction.
 *
 * The contract function returns a plain bool; the expiry ledger is not
 * exposed via this entry point, so expiresAt is '' for active and null
 * for inactive/absent subscriptions.
 */
export async function isSubscribed(
  scoutWallet: string,
): Promise<{ active: boolean; expiresAt: string | null }> {
  return tracer.startActiveSpan('stellar.isSubscribed', async (span) => {
    span.setAttribute('stellar.contract_function', 'is_subscribed');
    try {
      if (!scoutWallet) {
        throw new PaymentError('Missing scoutWallet', 'INVALID_ACCOUNT');
      }

      try {
        const contract = new Contract(config.contractId);
        // Use a random ephemeral keypair as the simulation source — no on-chain
        // auth is required for this view-only call, and we never submit the tx.
        const ephemeral = Keypair.random();
        const sourceAccount = new Account(ephemeral.publicKey(), '0');

        const tx = new TransactionBuilder(sourceAccount, {
          fee: BASE_FEE,
          networkPassphrase: networkPassphrase(),
        })
          .addOperation(
            contract.call('is_subscribed', Address.fromString(scoutWallet).toScVal()),
          )
          .setTimeout(30)
          .build();

        const simResult = await server.simulateTransaction(tx);

        if (SorobanRpc.Api.isSimulationError(simResult)) {
          throw new PaymentError(
            `Contract simulation failed: ${simResult.error}`,
            'NETWORK_ERROR',
          );
        }

        const successSim = simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse;
        const retval = successSim.result?.retval;
        if (!retval) {
          span.setAttribute('stellar.active', false);
          return { active: false, expiresAt: null };
        }

        const active = scValToNative(retval) as boolean;
        span.setAttribute('stellar.active', active);
        return { active, expiresAt: active ? '' : null };
      } catch (err) {
        if (err instanceof PaymentError) throw err;
        throw new PaymentError(
          `RPC call failed: ${(err as Error).message}`,
          'NETWORK_ERROR',
        );
      }
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.setAttribute('error.type', (err as Error).name);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Invoke `pay_to_contact(scout, player_id)` on the Soroban contract to unlock
 * direct contact with a player by paying the platform's micro-fee.
 *
 * Flow mirrors purchaseSubscription() / logTrialOffer():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash and a 'submitted' status.
 * Throws PaymentError with code 'INSUFFICIENT_FUNDS' when the contract
 * reports error #7 (InsufficientFee) — see contracts/subscription/src/lib.rs.
 */
export async function submitContactPayment(
  scoutWallet: string,
  playerId: string,
): Promise<ContactPaymentResult> {
  return tracer.startActiveSpan('stellar.submitContactPayment', async (span): Promise<ContactPaymentResult> => {
    span.setAttribute('stellar.contract_function', 'pay_to_contact');
    span.setAttribute('stellar.player_id', playerId);
    try {
      if (!scoutWallet || !playerId) {
        throw new PaymentError('Missing scoutWallet or playerId', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      let account;
      try {
        account = await server.getAccount(keypair.publicKey());
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      const contract = new Contract(config.contractId);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: networkPassphrase(),
      })
        .addOperation(
          contract.call(
            'pay_to_contact',
            Address.fromString(scoutWallet).toScVal(),
            nativeToScVal(playerId, { type: 'string' }),
          ),
        )
        .setTimeout(30)
        .build();

      let simResult;
      try {
        simResult = await server.simulateTransaction(tx);
      } catch (err) {
        throw new PaymentError(`Simulation request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (SorobanRpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (isInsufficientFeeError(errMsg)) {
          throw new PaymentError('Insufficient funds to unlock contact', 'INSUFFICIENT_FUNDS');
        }
        throw new PaymentError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      let sendResult;
      try {
        sendResult = await server.sendTransaction(preparedTx);
      } catch (err) {
        throw new PaymentError(`Submit request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }
      if (sendResult.status === 'ERROR') {
        const errMsg = String(sendResult.errorResult ?? '');
        if (isInsufficientFeeError(errMsg)) {
          throw new PaymentError('Insufficient funds to unlock contact', 'INSUFFICIENT_FUNDS');
        }
        throw new PaymentError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult;
      try {
        getResult = await server.getTransaction(hash);
        while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
          await new Promise((r) => setTimeout(r, 1000));
          getResult = await server.getTransaction(hash);
        }
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
        if (isInsufficientFeeError(resultMeta)) {
          throw new PaymentError('Insufficient funds to unlock contact', 'INSUFFICIENT_FUNDS');
        }
        throw new PaymentError('pay_to_contact transaction failed on-chain', 'NETWORK_ERROR');
      }

      span.setAttribute('stellar.status', 'submitted');
      return {
        transactionId: hash,
        status: 'submitted',
      };
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.setAttribute('error.type', (err as Error).name);
      throw err;
    } finally {
      span.end();
    }
  });
}

// ─── Trial offer ──────────────────────────────────────────────────────────────

export interface TrialOfferResult {
  transactionId: string;
  playerId: string;
  detailsUri: string;
  playerTier: number;
}

/**
 * Invoke the contract's `log_trial_offer(scout, player_id, details_uri)` method.
 * Creates an immutable on-chain record of the offer; the contract promotes the
 * player's tier and returns the updated value.
 *
 * Flow mirrors cancelSubscriptionOnChain():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash and the player's
 * updated tier as reported by the contract's return value.
 */
export async function logTrialOffer(
  scoutWallet: string,
  playerId: string,
  detailsUri: string,
): Promise<TrialOfferResult> {
  return tracer.startActiveSpan('stellar.logTrialOffer', async (span) => {
    span.setAttribute('stellar.contract_function', 'log_trial_offer');
    span.setAttribute('stellar.player_id', playerId);
    try {
      if (!scoutWallet || !playerId || !detailsUri) {
        throw new PaymentError('Missing scoutWallet, playerId, or detailsUri', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      let account;
      try {
        account = await server.getAccount(keypair.publicKey());
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      const contract = new Contract(config.contractId);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: networkPassphrase(),
      })
        .addOperation(
          contract.call(
            'log_trial_offer',
            Address.fromString(scoutWallet).toScVal(),
            nativeToScVal(playerId, { type: 'string' }),
            nativeToScVal(detailsUri, { type: 'string' }),
          ),
        )
        .setTimeout(30)
        .build();

      let simResult;
      try {
        simResult = await server.simulateTransaction(tx);
      } catch (err) {
        throw new PaymentError(`Simulation request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (SorobanRpc.Api.isSimulationError(simResult)) {
        throw new PaymentError(`Simulation failed: ${simResult.error}`, 'NETWORK_ERROR');
      }

      const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      let sendResult;
      try {
        sendResult = await server.sendTransaction(preparedTx);
      } catch (err) {
        throw new PaymentError(`Submit request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }
      if (sendResult.status === 'ERROR') {
        throw new PaymentError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult;
      try {
        getResult = await server.getTransaction(hash);
        while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
          await new Promise((r) => setTimeout(r, 1000));
          getResult = await server.getTransaction(hash);
        }
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new PaymentError('log_trial_offer transaction failed on-chain', 'NETWORK_ERROR');
      }

      const success = getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      const playerTier = success.returnValue
        ? (scValToNative(success.returnValue) as number)
        : 3;
      span.setAttribute('stellar.player_tier', playerTier);

      return {
        transactionId: hash,
        playerId,
        detailsUri,
        playerTier,
      };
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.setAttribute('error.type', (err as Error).name);
      throw err;
    } finally {
      span.end();
    }
  });
}

// ─── Milestone query ──────────────────────────────────────────────────────────

export interface OnChainMilestone {
  milestoneId: string;
  playerId: string;
  milestoneType: string;
  evidenceUri: string;
  approved: boolean;
  approvedBy: string | null;
  ledger: number | null;
}

export interface FeeWithdrawalResult {
  transactionId: string;
  recipient: string;
  amount: string; // u128 as string to avoid precision loss
  token: string;
}

export type FeeWithdrawalErrorCode =
  | 'NO_FEES'
  | 'INVALID_RECIPIENT'
  | 'NETWORK_ERROR'
  | 'CONTRACT_PAUSED';

/** Non-retryable codes — the caller should not retry without corrective action. */
const NON_RETRYABLE_CODES: ReadonlySet<FeeWithdrawalErrorCode> = new Set([
  'NO_FEES',
  'INVALID_RECIPIENT',
  'CONTRACT_PAUSED',
]);

export class FeeWithdrawalError extends Error {
  /** Whether the operation may succeed if retried (e.g. transient network blip). */
  public readonly retryable: boolean;

  constructor(
    message: string,
    public readonly code: FeeWithdrawalErrorCode,
  ) {
    super(message);
    this.name = 'FeeWithdrawalError';
    this.retryable = !NON_RETRYABLE_CODES.has(code);
  }
}

/** Matches the contract's ContractPaused (#10) error in a simulation/result error string. */
function isContractPausedError(message: string): boolean {
  return /#10\b/.test(message) || /contract.?paused/i.test(message);
}

/**
 * Invoke `withdraw_fees(recipient: Address) -> u128` on the Soroban contract
 * via the platform keypair.
 *
 * Flow mirrors pauseContractOnChain() / cancelSubscriptionOnChain():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success, parses the confirmed transaction's u128 return value and
 * throws FeeWithdrawalError('No fees available', 'NO_FEES') if it is zero
 * rather than returning a zero-amount result. Throws
 * FeeWithdrawalError(..., 'CONTRACT_PAUSED') if the contract's paused-state
 * guard (error #10) rejects the call, and (..., 'NETWORK_ERROR') for any
 * RPC/transport failure.
 */
export async function withdrawFees(recipient: string): Promise<FeeWithdrawalResult> {
  return tracer.startActiveSpan('stellar.withdrawFees', async (span) => {
    span.setAttribute('stellar.contract_function', 'withdraw_fees');
    try {
      if (!recipient) {
        throw new FeeWithdrawalError('Missing recipient', 'INVALID_RECIPIENT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      let account;
      try {
        account = await server.getAccount(keypair.publicKey());
      } catch (err) {
        throw new FeeWithdrawalError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      const contract = new Contract(config.contractId);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: networkPassphrase(),
      })
        .addOperation(
          contract.call('withdraw_fees', Address.fromString(recipient).toScVal()),
        )
        .setTimeout(30)
        .build();

      let simResult;
      try {
        simResult = await server.simulateTransaction(tx);
      } catch (err) {
        throw new FeeWithdrawalError(`Simulation request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (SorobanRpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (isContractPausedError(errMsg)) {
          throw new FeeWithdrawalError('Contract is paused; withdrawal not available', 'CONTRACT_PAUSED');
        }
        throw new FeeWithdrawalError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      let sendResult;
      try {
        sendResult = await server.sendTransaction(preparedTx);
      } catch (err) {
        throw new FeeWithdrawalError(`Submit request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }
      if (sendResult.status === 'ERROR') {
        const errMsg = String(sendResult.errorResult ?? '');
        if (isContractPausedError(errMsg)) {
          throw new FeeWithdrawalError('Contract is paused; withdrawal not available', 'CONTRACT_PAUSED');
        }
        throw new FeeWithdrawalError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult;
      try {
        getResult = await server.getTransaction(hash);
        while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
          await new Promise((r) => setTimeout(r, 1000));
          getResult = await server.getTransaction(hash);
        }
      } catch (err) {
        throw new FeeWithdrawalError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
        if (isContractPausedError(resultMeta)) {
          throw new FeeWithdrawalError('Contract is paused; withdrawal not available', 'CONTRACT_PAUSED');
        }
        throw new FeeWithdrawalError('withdraw_fees transaction failed on-chain', 'NETWORK_ERROR');
      }

      const success = getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      const amount = success.returnValue
        ? (scValToNative(success.returnValue) as bigint)
        : 0n;
      span.setAttribute('stellar.fee_amount', amount.toString());

      if (amount === 0n) {
        throw new FeeWithdrawalError('No fees available to withdraw', 'NO_FEES');
      }

      return {
        transactionId: hash,
        recipient,
        amount: amount.toString(),
        token: 'XLM',
      };
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.setAttribute('error.type', (err as Error).name);
      throw err;
    } finally {
      span.end();
    }
  });
}

export type SubscriptionTier = 'basic' | 'premium';

export interface SubscriptionResult {
  transactionId: string;
  tier: SubscriptionTier;
  expiresAt: number; // Unix timestamp
  status: 'active';
}

/** Matches Soroban contract error #7 (InsufficientFee) in a simulation/result error string. */
function isInsufficientFeeError(message: string): boolean {
  return /#7\b/.test(message) || /insufficient.?fee/i.test(message);
}

/**
 * Matches a missing/expired classic Stellar trustline in a simulation/result
 * error string. The contract's payment token may be a Stellar Asset Contract
 * wrapping a classic asset, whose trustline errors surface as diagnostic text
 * rather than a scout_off_shared::errors::Error code, so — like
 * isContractPausedError() above — this is a best-effort message match rather
 * than a numbered contract error.
 */
function isExpiredTrustlineError(message: string): boolean {
  return /trust.?line/i.test(message);
}

/**
 * Invoke `subscribe(scout, tier, duration)` on the Soroban contract.
 *
 * Flow mirrors cancelSubscriptionOnChain() / logTrialOffer():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash and the on-chain expiry
 * timestamp decoded from the contract's return value.
 * Throws PaymentError with code 'INSUFFICIENT_FUNDS' for contract error #7
 * (InsufficientFee).
 */
export async function purchaseSubscription(
  scoutWallet: string,
  tier: SubscriptionTier,
  duration: number,
): Promise<SubscriptionResult> {
  return tracer.startActiveSpan('stellar.purchaseSubscription', async (span): Promise<SubscriptionResult> => {
    span.setAttribute('stellar.contract_function', 'subscribe');
    span.setAttribute('stellar.tier', tier);
    try {
      if (!scoutWallet) {
        throw new PaymentError('Missing scoutWallet', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      let account;
      try {
        account = await server.getAccount(keypair.publicKey());
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      const contract = new Contract(config.contractId);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: networkPassphrase(),
      })
        .addOperation(
          contract.call(
            'subscribe',
            Address.fromString(scoutWallet).toScVal(),
            nativeToScVal(tier, { type: 'string' }),
            nativeToScVal(duration, { type: 'u32' }),
          ),
        )
        .setTimeout(30)
        .build();

      let simResult;
      try {
        simResult = await server.simulateTransaction(tx);
      } catch (err) {
        throw new PaymentError(`Simulation request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (SorobanRpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (isInsufficientFeeError(errMsg)) {
          throw new PaymentError('Insufficient funds for subscription', 'INSUFFICIENT_FUNDS');
        }
        throw new PaymentError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      let sendResult;
      try {
        sendResult = await server.sendTransaction(preparedTx);
      } catch (err) {
        throw new PaymentError(`Submit request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }
      if (sendResult.status === 'ERROR') {
        const errMsg = String(sendResult.errorResult ?? '');
        if (isInsufficientFeeError(errMsg)) {
          throw new PaymentError('Insufficient funds for subscription', 'INSUFFICIENT_FUNDS');
        }
        throw new PaymentError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult;
      try {
        getResult = await server.getTransaction(hash);
        while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
          await new Promise((r) => setTimeout(r, 1000));
          getResult = await server.getTransaction(hash);
        }
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
        if (isInsufficientFeeError(resultMeta)) {
          throw new PaymentError('Insufficient funds for subscription', 'INSUFFICIENT_FUNDS');
        }
        throw new PaymentError('subscribe transaction failed on-chain', 'NETWORK_ERROR');
      }

      const success = getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      if (!success.returnValue) {
        throw new PaymentError('subscribe transaction returned no expiry value', 'NETWORK_ERROR');
      }
      const expiresAt = scValToNative(success.returnValue) as number;
      span.setAttribute('stellar.expires_at', expiresAt);

      return {
        transactionId: hash,
        tier,
        expiresAt,
        status: 'active',
      };
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.setAttribute('error.type', (err as Error).name);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Re-invoke `subscribe(scout, tier, duration)` on the Soroban contract to renew
 * an existing subscription.
 *
 * The subscription contract has no dedicated renewal entry point (see
 * contracts/subscription/src/lib.rs) — its subscribe() is safely re-callable
 * while already active and simply overwrites the stored expiry with a fresh
 * one computed from the current ledger sequence (see its own
 * resubscribing_while_active_extends_expiry test), which is exactly the
 * behaviour a renewal needs.
 *
 * Flow mirrors purchaseSubscription() / cancelSubscriptionOnChain():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash and the on-chain expiry
 * timestamp decoded from the contract's return value — the contract is
 * authoritative for the new expiry, so currentExpiresAt is not used to
 * compute it (only recorded on the span for observability).
 *
 * Throws PaymentError with code:
 *   'INSUFFICIENT_FUNDS' — contract error #7 (InsufficientFee)
 *   'EXPIRED_TRUSTLINE'  — payment token trustline missing/expired
 *   'CONTRACT_ERROR'     — any other on-chain rejection (e.g. contract panic)
 *   'NETWORK_ERROR'      — RPC/transport failure, distinct from an on-chain rejection
 */
export async function renewSubscription(
  scoutWallet: string,
  tier: SubscriptionTier,
  duration: number,
  currentExpiresAt: number,
): Promise<SubscriptionResult> {
  return tracer.startActiveSpan('stellar.renewSubscription', async (span): Promise<SubscriptionResult> => {
    span.setAttribute('stellar.contract_function', 'subscribe');
    span.setAttribute('stellar.tier', tier);
    span.setAttribute('stellar.renewal', true);
    span.setAttribute('stellar.previous_expires_at', currentExpiresAt);
    try {
      if (!scoutWallet) {
        throw new PaymentError('Missing scoutWallet', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      let account;
      try {
        account = await server.getAccount(keypair.publicKey());
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      const contract = new Contract(config.contractId);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: networkPassphrase(),
      })
        .addOperation(
          contract.call(
            'subscribe',
            Address.fromString(scoutWallet).toScVal(),
            nativeToScVal(tier, { type: 'string' }),
            nativeToScVal(duration, { type: 'u32' }),
          ),
        )
        .setTimeout(30)
        .build();

      let simResult;
      try {
        simResult = await server.simulateTransaction(tx);
      } catch (err) {
        throw new PaymentError(`Simulation request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (SorobanRpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (isInsufficientFeeError(errMsg)) {
          throw new PaymentError('Insufficient funds for subscription renewal', 'INSUFFICIENT_FUNDS');
        }
        if (isExpiredTrustlineError(errMsg)) {
          throw new PaymentError('Payment token trustline is missing or expired', 'EXPIRED_TRUSTLINE');
        }
        throw new PaymentError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
      }

      const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      let sendResult;
      try {
        sendResult = await server.sendTransaction(preparedTx);
      } catch (err) {
        throw new PaymentError(`Submit request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }
      if (sendResult.status === 'ERROR') {
        const errMsg = String(sendResult.errorResult ?? '');
        if (isInsufficientFeeError(errMsg)) {
          throw new PaymentError('Insufficient funds for subscription renewal', 'INSUFFICIENT_FUNDS');
        }
        if (isExpiredTrustlineError(errMsg)) {
          throw new PaymentError('Payment token trustline is missing or expired', 'EXPIRED_TRUSTLINE');
        }
        throw new PaymentError(`Submit failed: ${sendResult.errorResult}`, 'CONTRACT_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult;
      try {
        getResult = await server.getTransaction(hash);
        while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
          await new Promise((r) => setTimeout(r, 1000));
          getResult = await server.getTransaction(hash);
        }
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
        if (isInsufficientFeeError(resultMeta)) {
          throw new PaymentError('Insufficient funds for subscription renewal', 'INSUFFICIENT_FUNDS');
        }
        if (isExpiredTrustlineError(resultMeta)) {
          throw new PaymentError('Payment token trustline is missing or expired', 'EXPIRED_TRUSTLINE');
        }
        throw new PaymentError('subscribe transaction failed on-chain', 'CONTRACT_ERROR');
      }

      const success = getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      // Check the *decoded* value, not just whether returnValue is present: a
      // contract function returning unit (no expiry) still yields a truthy
      // ScVal wrapping scvVoid, which scValToNative() decodes to `null` rather
      // than throwing — so `!success.returnValue` alone would silently accept
      // a null expiry here instead of surfacing the mismatch.
      const decoded = success.returnValue ? scValToNative(success.returnValue) : null;
      if (typeof decoded !== 'number') {
        throw new PaymentError('renew_subscription transaction returned no expiry value', 'CONTRACT_ERROR');
      }
      const expiresAt = decoded;
      span.setAttribute('stellar.expires_at', expiresAt);

      return {
        transactionId: hash,
        tier,
        expiresAt,
        status: 'active',
      };
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.setAttribute('error.type', (err as Error).name);
      throw err;
    } finally {
      span.end();
    }
  });
}

export type SubscriptionErrorCode =
  | 'NOT_SUBSCRIBED'
  | 'ALREADY_CANCELLED'
  | 'UNAUTHORIZED'
  | 'NETWORK_ERROR';

/**
 * Thrown when a cancel_subscription contract call cannot proceed due to a
 * known on-chain state — e.g. the scout was never subscribed or the
 * subscription was already cancelled.  These map to 4xx HTTP responses, not
 * 5xx, so we keep them separate from PaymentError.
 */
export class SubscriptionError extends Error {
  constructor(
    message: string,
    public readonly code: SubscriptionErrorCode,
  ) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

/**
 * Invoke `cancel_subscription(scout)` on the Soroban contract.
 *
 * Flow mirrors unpauseContractOnChain():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash.
 * Maps Soroban contract error codes to SubscriptionError:
 *   #8 NotSubscribed  → code: 'NOT_SUBSCRIBED'
 *   #9 Unauthorized   → code: 'UNAUTHORIZED'
 */
export async function cancelSubscriptionOnChain(
  scoutWallet: string,
): Promise<{ transactionId: string }> {
  return tracer.startActiveSpan('stellar.cancelSubscriptionOnChain', async (span) => {
    span.setAttribute('stellar.contract_function', 'cancel_subscription');
    try {
      if (!scoutWallet) {
        throw new PaymentError('Missing scoutWallet', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      const account = await server.getAccount(keypair.publicKey());
      const contract = new Contract(config.contractId);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: networkPassphrase(),
      })
        .addOperation(
          contract.call('cancel_subscription', Address.fromString(scoutWallet).toScVal()),
        )
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);

      if (SorobanRpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        // Contract error #8 = NotSubscribed
        if (errMsg.includes('#8') || /not.?subscribed/i.test(errMsg)) {
          throw new SubscriptionError('Scout has no active on-chain subscription', 'NOT_SUBSCRIBED');
        }
        // Contract error #9 = Unauthorized
        if (errMsg.includes('#9') || /unauthorized/i.test(errMsg)) {
          throw new SubscriptionError('Unauthorized: wallet is not allowed to cancel this subscription', 'UNAUTHORIZED');
        }
        throw new PaymentError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      const sendResult = await server.sendTransaction(preparedTx);
      if (sendResult.status === 'ERROR') {
        throw new PaymentError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult = await server.getTransaction(hash);
      while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        await new Promise((r) => setTimeout(r, 1000));
        getResult = await server.getTransaction(hash);
      }

      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        // Inspect the result XDR for contract-level error codes.
        // Cast through unknown because GetFailedTransactionResponse and
        // GetSuccessfulTransactionResponse share no overlapping status type.
        const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
        if (resultMeta.includes('#8') || /not.?subscribed/i.test(resultMeta)) {
          throw new SubscriptionError('Scout has no active on-chain subscription', 'NOT_SUBSCRIBED');
        }
        if (resultMeta.includes('#9') || /unauthorized/i.test(resultMeta)) {
          throw new SubscriptionError('Unauthorized: wallet is not allowed to cancel this subscription', 'UNAUTHORIZED');
        }
        throw new PaymentError('cancel_subscription transaction failed on-chain', 'NETWORK_ERROR');
      }

      return { transactionId: hash };
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.setAttribute('error.type', (err as Error).name);
      throw err;
    } finally {
      span.end();
    }
  });
}

export interface ContractActionResult {
  transactionId: string;
}

export class ContractActionError extends Error {
  constructor(
    message: string,
    public readonly code: 'CONTRACT_NOT_PAUSED' | 'CONTRACT_ALREADY_PAUSED' | 'NETWORK_ERROR' | 'UNAUTHORIZED',
  ) {
    super(message);
    this.name = 'ContractActionError';
  }
}

/**
 * Invoke the contract's `unpause()` function via the platform keypair.
 * Returns the transaction hash on success.
 * Throws ContractActionError with code 'CONTRACT_NOT_PAUSED' if the simulation
 * indicates the contract is not currently paused (Soroban error code 10).
 */
export async function unpauseContractOnChain(): Promise<ContractActionResult> {
  return tracer.startActiveSpan('stellar.unpauseContractOnChain', async (span) => {
    span.setAttribute('stellar.contract_function', 'unpause');
    try {
      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      const account = await server.getAccount(keypair.publicKey());
      const contract = new Contract(config.contractId);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: networkPassphrase(),
      })
        .addOperation(contract.call('unpause'))
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (errMsg.includes('ContractPaused') || errMsg.includes('contract_paused') || errMsg.includes('#10')) {
          throw new ContractActionError('Contract is not currently paused', 'CONTRACT_NOT_PAUSED');
        }
        throw new ContractActionError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      const sendResult = await server.sendTransaction(preparedTx);
      if (sendResult.status === 'ERROR') {
        throw new ContractActionError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult = await server.getTransaction(hash);
      while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        await new Promise((r) => setTimeout(r, 1000));
        getResult = await server.getTransaction(hash);
      }

      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new ContractActionError('Transaction failed on-chain', 'NETWORK_ERROR');
      }

      return { transactionId: hash };
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.setAttribute('error.type', (err as Error).name);
      throw err;
    } finally {
      span.end();
    }
  });
}

// ─── Validator registration ───────────────────────────────────────────────────

export interface RegisterValidatorResult {
  transactionId: string;
}

export type ValidatorActionErrorCode =
  | 'ALREADY_REGISTERED'
  // 'ALREADY_REVOKED' / 'NOT_REGISTERED' belong to revokeValidatorOnChain's
  // half of this same error type (see adminController.ts's revokeValidator
  // handler) — included here so ValidatorActionError stays a single shared
  // type across both validator admin actions rather than forking per-action
  // error classes.
  | 'ALREADY_REVOKED'
  | 'NOT_REGISTERED'
  | 'UNAUTHORIZED'
  | 'NETWORK_ERROR';

/**
 * Thrown when a validator admin action (register/revoke) contract call
 * cannot proceed due to a known on-chain state, or fails for network/
 * transport reasons. Known-state codes map to 4xx HTTP responses in the
 * controller; NETWORK_ERROR maps to 5xx.
 */
export class ValidatorActionError extends Error {
  constructor(
    message: string,
    public readonly code: ValidatorActionErrorCode,
  ) {
    super(message);
    this.name = 'ValidatorActionError';
  }
}

/**
 * Invoke `register_validator(validator: Address)` on the Soroban contract
 * via the platform keypair.
 *
 * Flow mirrors unpauseContractOnChain() / cancelSubscriptionOnChain():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash.
 *
 * NOTE on error codes: the contract's register_validator call is currently
 * idempotent (re-registering an already-registered wallet succeeds
 * silently), so ALREADY_REGISTERED is unlikely to surface today. The
 * string matching below is best-effort — mirroring the #8/#9 pattern
 * cancelSubscriptionOnChain() uses for the subscription contract — so
 * callers still get a typed error to branch on if the contract's error
 * enum grows a dedicated code for this case later. Any simulation/
 * submission/poll failure that doesn't match a known pattern falls
 * through to a generic NETWORK_ERROR rather than crashing.
 */
export async function registerValidatorOnChain(
  validatorWallet: string,
): Promise<RegisterValidatorResult> {
  return tracer.startActiveSpan('stellar.registerValidatorOnChain', async (span) => {
    span.setAttribute('stellar.contract_function', 'register_validator');
    try {
      if (!validatorWallet) {
        throw new PaymentError('Missing validatorWallet', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      const account = await server.getAccount(keypair.publicKey());
      const contract = new Contract(config.contractId);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: networkPassphrase(),
      })
        .addOperation(
          contract.call('register_validator', Address.fromString(validatorWallet).toScVal()),
        )
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);

      if (SorobanRpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        // Best-effort contract error mapping — see NOTE above.
        if (errMsg.includes('#13') || /already.?registered/i.test(errMsg)) {
          throw new ValidatorActionError('Validator is already registered on-chain', 'ALREADY_REGISTERED');
        }
        if (/unauthorized/i.test(errMsg)) {
          throw new ValidatorActionError('Unauthorized: platform account cannot register this validator', 'UNAUTHORIZED');
        }
        throw new ValidatorActionError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      const sendResult = await server.sendTransaction(preparedTx);
      if (sendResult.status === 'ERROR') {
        throw new ValidatorActionError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult = await server.getTransaction(hash);
      while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        await new Promise((r) => setTimeout(r, 1000));
        getResult = await server.getTransaction(hash);
      }

      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        // Inspect the result XDR for contract-level error codes.
        // Cast through unknown because GetFailedTransactionResponse and
        // GetSuccessfulTransactionResponse share no overlapping status type.
        const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
        if (resultMeta.includes('#13') || /already.?registered/i.test(resultMeta)) {
          throw new ValidatorActionError('Validator is already registered on-chain', 'ALREADY_REGISTERED');
        }
        throw new ValidatorActionError('register_validator transaction failed on-chain', 'NETWORK_ERROR');
      }

      return { transactionId: hash };
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.setAttribute('error.type', (err as Error).name);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Invoke the contract's `pause()` function via the platform keypair.
 * Returns the transaction hash on success.
 * Throws ContractActionError with code 'CONTRACT_ALREADY_PAUSED' if the simulation
 * indicates the contract is already paused (Soroban error code 10).
 *
 * Note: the shared contract error enum (contracts/shared/src/errors.rs) only
 * defines a single generic `ContractPaused` (#10) variant for paused-state
 * preconditions — there is no distinct "already paused" vs "not paused"
 * error code. pause()/unpause() reuse that same variant for whichever
 * precondition fails, so the client interprets the code based on which
 * action was invoked (mirrors unpauseContractOnChain's string matching).
 */
export async function pauseContractOnChain(): Promise<ContractActionResult> {
  return tracer.startActiveSpan('stellar.pauseContractOnChain', async (span) => {
    span.setAttribute('stellar.contract_function', 'pause');
    try {
      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      const account = await server.getAccount(keypair.publicKey());
      const contract = new Contract(config.contractId);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: networkPassphrase(),
      })
        .addOperation(contract.call('pause'))
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (errMsg.includes('ContractPaused') || errMsg.includes('contract_paused') || errMsg.includes('#10')) {
          throw new ContractActionError('Contract is already paused', 'CONTRACT_ALREADY_PAUSED');
        }
        throw new ContractActionError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      const sendResult = await server.sendTransaction(preparedTx);
      if (sendResult.status === 'ERROR') {
        throw new ContractActionError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult = await server.getTransaction(hash);
      while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        await new Promise((r) => setTimeout(r, 1000));
        getResult = await server.getTransaction(hash);
      }

      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new ContractActionError('Transaction failed on-chain', 'NETWORK_ERROR');
      }

      return { transactionId: hash };
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.setAttribute('error.type', (err as Error).name);
      throw err;
    } finally {
      span.end();
    }
  });
}

export interface UpdateProfileResult {
  transactionId: string;
  metadataUri: string;
}

/**
 * Invoke `update_profile(player_id, metadata_uri)` on the Soroban contract
 * via the platform keypair.
 *
 * Flow mirrors logTrialOffer() / cancelSubscriptionOnChain():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash and the metadataUri
 * that was submitted. Throws PaymentError('MISSING_PLAYER') if the
 * contract simulation reports the player id is unknown (the register
 * contract's update_profile returns PlayerNotFound (#3) for that case).
 */
export async function updateProfile(
  playerId: string,
  metadataUri: string,
): Promise<UpdateProfileResult> {
  return tracer.startActiveSpan('stellar.updateProfile', async (span) => {
    span.setAttribute('stellar.contract_function', 'update_profile');
    span.setAttribute('stellar.player_id', playerId);
    try {
      if (!playerId || !metadataUri) {
        throw new PaymentError('playerId and metadataUri are required', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      let account;
      try {
        account = await server.getAccount(keypair.publicKey());
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      const contract = new Contract(config.contractId);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: networkPassphrase(),
      })
        .addOperation(
          contract.call(
            'update_profile',
            nativeToScVal(playerId, { type: 'string' }),
            nativeToScVal(metadataUri, { type: 'string' }),
          ),
        )
        .setTimeout(30)
        .build();

      let simResult;
      try {
        simResult = await server.simulateTransaction(tx);
      } catch (err) {
        throw new PaymentError(`Simulation request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (SorobanRpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (isPlayerNotFoundError(errMsg)) {
          throw new PaymentError('Player not found on-chain', 'MISSING_PLAYER');
        }
        throw new PaymentError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      let sendResult;
      try {
        sendResult = await server.sendTransaction(preparedTx);
      } catch (err) {
        throw new PaymentError(`Submit request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }
      if (sendResult.status === 'ERROR') {
        throw new PaymentError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult;
      try {
        getResult = await server.getTransaction(hash);
        while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
          await new Promise((r) => setTimeout(r, 1000));
          getResult = await server.getTransaction(hash);
        }
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
        if (isPlayerNotFoundError(resultMeta)) {
          throw new PaymentError('Player not found on-chain', 'MISSING_PLAYER');
        }
        throw new PaymentError('update_profile transaction failed on-chain', 'NETWORK_ERROR');
      }

      return { transactionId: hash, metadataUri };
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.setAttribute('error.type', (err as Error).name);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Parse the native JS value produced by `scValToNative()` on a
 * `get_milestones` return value (a `Vec<Milestone>`) into `OnChainMilestone[]`.
 *
 * The contract's Milestone struct fields are snake_case; tolerate a
 * camelCase shape too so this keeps working if a future SDK version (or a
 * differently-configured client) normalizes field casing during XDR
 * decoding. The contract struct does not carry its own milestone id, so one
 * is synthesized from the entry's position in the returned vector.
 */
export function parseMilestonesFromNative(playerId: string, native: unknown): OnChainMilestone[] {
  if (!Array.isArray(native)) {
    return [];
  }
  return native.map((entry, index) => {
    const rec = (entry ?? {}) as Record<string, unknown>;
    const approved = Boolean(rec.approved);
    const submittedAt = rec.submitted_at ?? rec.submittedAt ?? rec.ledger;
    return {
      milestoneId: String(rec.milestone_id ?? rec.milestoneId ?? index),
      playerId: String(rec.player_id ?? rec.playerId ?? playerId),
      milestoneType: String(rec.milestone_type ?? rec.milestoneType ?? ''),
      evidenceUri: String(rec.evidence_uri ?? rec.evidenceUri ?? ''),
      approved,
      approvedBy: approved ? String(rec.validator ?? rec.approvedBy ?? '') : null,
      ledger: submittedAt != null ? Number(submittedAt) : null,
    };
  });
}

/** Matches the contract's PlayerNotFound (#3) error in a simulation error string. */
function isPlayerNotFoundError(message: string): boolean {
  return /#3\b/.test(message) || /player.?not.?found/i.test(message);
}

/**
 * Query verified milestones for a player by invoking
 * `get_milestones(player_id) -> Vec<Milestone>` on the Soroban contract via
 * simulateTransaction. Read-only — no transaction is signed or submitted.
 *
 * Returns a tamper-proof list of all milestones (pending and approved)
 * associated with the given player, or an empty array if the player has
 * none. Throws PaymentError('MISSING_PLAYER') if the contract simulation
 * reports the player id is unknown.
 */
export async function queryMilestones(playerId: string): Promise<OnChainMilestone[]> {
  return tracer.startActiveSpan('stellar.queryMilestones', async (span) => {
    span.setAttribute('stellar.contract_function', 'get_milestones');
    try {
      if (!playerId) {
        throw new PaymentError('Missing playerId', 'INVALID_ACCOUNT');
      }

      try {
        const contract = new Contract(config.contractId);
        // Use a random ephemeral keypair as the simulation source — no on-chain
        // auth is required for this view-only call, and we never submit the tx.
        const ephemeral = Keypair.random();
        const sourceAccount = new Account(ephemeral.publicKey(), '0');

        const tx = new TransactionBuilder(sourceAccount, {
          fee: BASE_FEE,
          networkPassphrase: networkPassphrase(),
        })
          .addOperation(
            contract.call('get_milestones', nativeToScVal(playerId, { type: 'string' })),
          )
          .setTimeout(30)
          .build();

        const simResult = await server.simulateTransaction(tx);

        if (SorobanRpc.Api.isSimulationError(simResult)) {
          const errMsg = simResult.error ?? '';
          if (isPlayerNotFoundError(errMsg)) {
            throw new PaymentError('Player not found on-chain', 'MISSING_PLAYER');
          }
          throw new PaymentError(`Contract simulation failed: ${errMsg}`, 'NETWORK_ERROR');
        }

        const successSim = simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse;
        const retval = successSim.result?.retval;
        if (!retval) {
          return [];
        }

        const milestones = parseMilestonesFromNative(playerId, scValToNative(retval));
        span.setAttribute('stellar.milestone_count', milestones.length);
        return milestones;
      } catch (err) {
        if (err instanceof PaymentError) throw err;
        throw new PaymentError(
          `RPC call failed: ${(err as Error).message}`,
          'NETWORK_ERROR',
        );
      }
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.setAttribute('error.type', (err as Error).name);
      throw err;
    } finally {
      span.end();
    }
  });
}
