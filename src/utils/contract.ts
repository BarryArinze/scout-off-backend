import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  nativeToScVal,
  scValToNative,
  Keypair,
} from '@stellar/stellar-sdk';
import { server, networkPassphrase } from '../services/stellar';
import config from '../config';

// ─── Typed errors ─────────────────────────────────────────────────────────────

export class ContractNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractNetworkError';
  }
}

export class ContractTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractTimeoutError';
  }
}

export class ContractExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractExecutionError';
  }
}

// ─── Result type ──────────────────────────────────────────────────────────────

export interface InvokeResult {
  hash: string;
  returnValue: xdr.ScVal;
}

// ─── Core helper ─────────────────────────────────────────────────────────────

/**
 * Build, sign, submit, and poll a Soroban contract invocation.
 * Uses the platform keypair from config.
 *
 * @param method   - Contract function name
 * @param args     - xdr.ScVal arguments
 * @param timeoutMs - Poll timeout in ms (default: 30 000)
 */
export async function invokeContract(
  method: string,
  args: xdr.ScVal[],
  timeoutMs = 30_000,
): Promise<InvokeResult> {
  const keypair = Keypair.fromSecret(config.platformSecret);

  let account;
  try {
    account = await server.getAccount(keypair.publicKey());
  } catch (err) {
    throw new ContractNetworkError(`Failed to load account: ${(err as Error).message}`);
  }

  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(Math.ceil(timeoutMs / 1000))
    .build();

  // Simulate
  let simResult;
  try {
    simResult = await server.simulateTransaction(tx);
  } catch (err) {
    throw new ContractNetworkError(`Simulation request failed: ${(err as Error).message}`);
  }
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new ContractExecutionError(`Simulation failed: ${simResult.error}`);
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
  preparedTx.sign(keypair);

  // Submit
  let sendResult;
  try {
    sendResult = await server.sendTransaction(preparedTx);
  } catch (err) {
    throw new ContractNetworkError(`Submit request failed: ${(err as Error).message}`);
  }
  if (sendResult.status === 'ERROR') {
    throw new ContractExecutionError(`Transaction rejected: ${sendResult.errorResult}`);
  }

  // Poll for confirmation
  const deadline = Date.now() + timeoutMs;
  let getResult = await server.getTransaction(sendResult.hash);

  while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
    if (Date.now() >= deadline) {
      throw new ContractTimeoutError(`Transaction ${sendResult.hash} not confirmed within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    getResult = await server.getTransaction(sendResult.hash);
  }

  if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new ContractExecutionError(`Transaction ${sendResult.hash} failed on-chain`);
  }

  const success = getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse;
  return {
    hash: sendResult.hash,
    returnValue: success.returnValue ?? xdr.ScVal.scvVoid(),
  };
}

// ─── ScVal helpers ────────────────────────────────────────────────────────────

/** Convert a plain string to ScVal */
export const strVal = (s: string) => nativeToScVal(s, { type: 'string' });

/** Convert a number to ScVal u32 */
export const u32Val = (n: number) => nativeToScVal(n, { type: 'u32' });

/** Convert a ScVal to a native JS value */
export const fromScVal = (v: xdr.ScVal) => scValToNative(v);
