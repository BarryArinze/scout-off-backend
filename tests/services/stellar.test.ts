/**
 * Tests for stellar.ts service functions:
 *   - isSubscribed()              — view-only simulation call
 *   - queryMilestones()           — view-only simulation call
 *   - cancelSubscriptionOnChain() — real Soroban invocation
 *   - pauseContractOnChain()      — real Soroban invocation
 *   - withdrawFees()              — real Soroban invocation
 *
 * The Stellar SDK and signer utility are fully mocked so no live RPC is needed.
 */

// ─── Top-level mock methods ───────────────────────────────────────────────────
// We declare these at the top level so jest.fn() instances survive
// jest.clearAllMocks() in beforeEach without losing their identities.
// (clearAllMocks resets recorded calls + return values, but the same
// jest.fn() reference is still reachable from the mock factory closure.)

const mockGetAccount      = jest.fn();
const mockSimulate        = jest.fn();
const mockSendTransaction = jest.fn();
const mockGetTransaction  = jest.fn();
const mockAssembleBuild   = jest.fn().mockReturnValue({ sign: jest.fn() });
const mockAssemble        = jest.fn().mockReturnValue({ build: mockAssembleBuild });

jest.mock('@stellar/stellar-sdk', () => ({
  SorobanRpc: {
    Server: jest.fn().mockReturnValue({
      getLatestLedger:     jest.fn().mockResolvedValue({ sequence: 1 }),
      getAccount:          mockGetAccount,
      simulateTransaction: mockSimulate,
      sendTransaction:     mockSendTransaction,
      getTransaction:      mockGetTransaction,
    }),
    Api: {
      isSimulationError: jest.fn().mockReturnValue(false),
      GetTransactionStatus: {
        NOT_FOUND: 'NOT_FOUND',
        SUCCESS:   'SUCCESS',
        FAILED:    'FAILED',
      },
    },
    assembleTransaction: mockAssemble,
  },
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC:  'Public Global Stellar Network ; September 2015',
  },
  Contract: jest.fn().mockImplementation(() => ({
    call: jest.fn().mockReturnValue({ type: 'invokeHostFunction' }),
  })),
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout:   jest.fn().mockReturnThis(),
    build:        jest.fn().mockReturnValue({}),
  })),
  BASE_FEE: '100',
  Keypair: {
    random:     jest.fn().mockReturnValue({ publicKey: () => 'GBADUMMYACCOUNT' }),
    fromSecret: jest.fn().mockReturnValue({
      publicKey: () => 'GPLATFORMKEYPAIR0000000000000000000000000000000000000000',
      sign: jest.fn(),
    }),
  },
  Account:      jest.fn().mockImplementation(() => ({})),
  Address:      { fromString: jest.fn().mockReturnValue({ toScVal: () => ({}) }) },
  scValToNative: jest.fn().mockReturnValue(true),
  nativeToScVal: jest.fn().mockReturnValue({}),
}));

// Mock the signer so getPlatformKeypair() returns a deterministic keypair
jest.mock('../../src/utils/signer', () => ({
  getPlatformKeypair: jest.fn().mockReturnValue({
    publicKey: () => 'GPLATFORMKEYPAIR0000000000000000000000000000000000000000',
    sign: jest.fn(),
  }),
}));

import {
  isSubscribed,
  queryMilestones,
  cancelSubscriptionOnChain,
  logTrialOffer,
  pauseContractOnChain,
  registerValidatorOnChain,
  renewSubscription,
  PaymentError,
  FeeWithdrawalError,
  ValidatorActionError,
} from '../../src/services/stellar';

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
const sdk = require('@stellar/stellar-sdk') as any;

const WALLET = 'G' + 'A'.repeat(55);

// ─── Shared setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Restore default SDK behaviours after clearAllMocks() wipes return values
  sdk.scValToNative.mockReturnValue(true);
  sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(false);
  mockAssembleBuild.mockReturnValue({ sign: jest.fn() });
  mockAssemble.mockReturnValue({ build: mockAssembleBuild });

  // isSubscribed defaults — simulate returns a truthy bool
  mockSimulate.mockResolvedValue({ result: { retval: { type: 'scvBool' } } });

  // cancelSubscriptionOnChain defaults — happy path
  mockGetAccount.mockResolvedValue({});
  mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'txhash-abc' });
  mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' });
});

// ─── isSubscribed ─────────────────────────────────────────────────────────────

describe('isSubscribed', () => {
  it('invokes is_subscribed on the contract and returns { active: true, expiresAt: "" }', async () => {
    sdk.scValToNative.mockReturnValue(true);
    const result = await isSubscribed(WALLET);
    expect(result.active).toBe(true);
    expect(result.expiresAt).toBe('');
  });

  it('returns { active: false, expiresAt: null } when the contract returns false', async () => {
    sdk.scValToNative.mockReturnValue(false);
    const result = await isSubscribed(WALLET);
    expect(result.active).toBe(false);
    expect(result.expiresAt).toBeNull();
  });

  it('returns { active: false, expiresAt: null } when retval is missing', async () => {
    mockSimulate.mockResolvedValue({ result: null });
    const result = await isSubscribed(WALLET);
    expect(result.active).toBe(false);
    expect(result.expiresAt).toBeNull();
  });

  it('throws PaymentError NETWORK_ERROR on simulation error response', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'rpc down' });
    await expect(isSubscribed(WALLET)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('throws PaymentError NETWORK_ERROR when simulateTransaction rejects', async () => {
    mockSimulate.mockRejectedValue(new Error('connection timeout'));
    await expect(isSubscribed(WALLET)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('throws PaymentError for empty wallet without calling the RPC', async () => {
    await expect(isSubscribed('')).rejects.toThrow(PaymentError);
  });
});

// ─── queryMilestones ──────────────────────────────────────────────────────────

describe('queryMilestones', () => {
  const PLAYER_ID = 'GPLAYER123';

  // Fixture mimicking scValToNative()'s output for a get_milestones Vec<Milestone>
  // return value: the contract struct fields are snake_case and carry no
  // milestone id of their own (see contracts/progress/src/lib.rs MilestoneData).
  const FIXTURE_MILESTONES = [
    {
      player_id: PLAYER_ID,
      milestone_type: 'identity',
      evidence_uri: 'ipfs://QmIdentityEvidence',
      validator: 'GVALIDATOR000000000000000000000000000000000000000000000',
      approved: true,
      submitted_at: 1700000000,
    },
    {
      player_id: PLAYER_ID,
      milestone_type: 'performance',
      evidence_uri: 'ipfs://QmPerformanceEvidence',
      validator: 'GVALIDATOR000000000000000000000000000000000000000000000',
      approved: false,
      submitted_at: 1700000100,
    },
  ];

  it('throws PaymentError INVALID_ACCOUNT for an empty playerId without calling the RPC', async () => {
    await expect(queryMilestones('')).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'INVALID_ACCOUNT',
    });
    expect(mockSimulate).not.toHaveBeenCalled();
  });

  it('invokes get_milestones via simulateTransaction and parses a fixture Vec<Milestone> response', async () => {
    mockSimulate.mockResolvedValue({ result: { retval: { type: 'scvVec' } } });
    sdk.scValToNative.mockReturnValue(FIXTURE_MILESTONES);

    const result = await queryMilestones(PLAYER_ID);

    expect(mockSimulate).toHaveBeenCalled();
    // Read-only view call — never signs or submits a transaction.
    expect(mockSendTransaction).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        milestoneId: '0',
        playerId: PLAYER_ID,
        milestoneType: 'identity',
        evidenceUri: 'ipfs://QmIdentityEvidence',
        approved: true,
        approvedBy: 'GVALIDATOR000000000000000000000000000000000000000000000',
        ledger: 1700000000,
      },
      {
        milestoneId: '1',
        playerId: PLAYER_ID,
        milestoneType: 'performance',
        evidenceUri: 'ipfs://QmPerformanceEvidence',
        approved: false,
        approvedBy: null,
        ledger: 1700000100,
      },
    ]);
  });

  it('returns an empty array for a player with no milestones (not an error)', async () => {
    mockSimulate.mockResolvedValue({ result: { retval: { type: 'scvVec' } } });
    sdk.scValToNative.mockReturnValue([]);

    const result = await queryMilestones(PLAYER_ID);
    expect(result).toEqual([]);
  });

  it('returns an empty array when the simulation returns no retval', async () => {
    mockSimulate.mockResolvedValue({ result: null });

    const result = await queryMilestones(PLAYER_ID);
    expect(result).toEqual([]);
  });

  it('throws PaymentError MISSING_PLAYER when simulation reports contract error #3', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'Contract error: #3' });

    await expect(queryMilestones(PLAYER_ID)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'MISSING_PLAYER',
    });
  });

  it('throws PaymentError MISSING_PLAYER when simulation message contains "player not found"', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'PlayerNotFound' });

    await expect(queryMilestones(PLAYER_ID)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'MISSING_PLAYER',
    });
  });

  it('throws PaymentError NETWORK_ERROR for an unrelated simulation error', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'Something went wrong' });

    await expect(queryMilestones(PLAYER_ID)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws PaymentError NETWORK_ERROR when simulateTransaction rejects', async () => {
    mockSimulate.mockRejectedValue(new Error('connection timeout'));

    await expect(queryMilestones(PLAYER_ID)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });
});

// ─── cancelSubscriptionOnChain ────────────────────────────────────────────────

describe('cancelSubscriptionOnChain', () => {
  it('throws PaymentError INVALID_ACCOUNT for empty wallet', async () => {
    await expect(cancelSubscriptionOnChain('')).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'INVALID_ACCOUNT',
    });
  });

  it('submits a real Soroban transaction and returns its hash on success', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'real-tx-hash-001' });
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' });

    const result = await cancelSubscriptionOnChain(WALLET);

    expect(result.transactionId).toBe('real-tx-hash-001');
    expect(mockGetAccount).toHaveBeenCalled();
    expect(mockSimulate).toHaveBeenCalled();
    expect(mockAssemble).toHaveBeenCalled();
    expect(mockSendTransaction).toHaveBeenCalled();
    expect(mockGetTransaction).toHaveBeenCalledWith('real-tx-hash-001');
  });

  it('polls getTransaction until status is no longer NOT_FOUND', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'poll-hash' });
    mockGetTransaction
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS' });

    jest.useFakeTimers();
    const promise = cancelSubscriptionOnChain(WALLET);
    await jest.runAllTimersAsync();
    const result = await promise;
    jest.useRealTimers();

    expect(result.transactionId).toBe('poll-hash');
    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
  });

  it('throws SubscriptionError NOT_SUBSCRIBED when simulation returns contract error #8', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'Contract error: #8' });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'SubscriptionError',
      code: 'NOT_SUBSCRIBED',
    });
    // DB must NOT be touched — the function throws before submitting
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('throws SubscriptionError NOT_SUBSCRIBED when simulation message contains "NotSubscribed"', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'NotSubscribed' });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'SubscriptionError',
      code: 'NOT_SUBSCRIBED',
    });
  });

  it('throws SubscriptionError UNAUTHORIZED when simulation returns contract error #9', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'Contract error: #9' });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'SubscriptionError',
      code: 'UNAUTHORIZED',
    });
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('throws PaymentError NETWORK_ERROR for an unknown simulation error', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'Something went wrong' });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws PaymentError NETWORK_ERROR when sendTransaction returns ERROR status', async () => {
    mockSendTransaction.mockResolvedValue({
      status: 'ERROR',
      errorResult: 'tx_failed',
      hash: 'err-hash',
    });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
    // Transaction never confirmed — getTransaction should NOT be called
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it('throws PaymentError NETWORK_ERROR when the confirmed transaction has FAILED status', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'fail-hash' });
    mockGetTransaction.mockResolvedValue({ status: 'FAILED', resultMetaXdr: '' });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws SubscriptionError NOT_SUBSCRIBED when FAILED tx XDR contains #8', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'fail-hash-8' });
    mockGetTransaction.mockResolvedValue({
      status: 'FAILED',
      resultMetaXdr: 'error-payload-#8-encoded',
    });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'SubscriptionError',
      code: 'NOT_SUBSCRIBED',
    });
  });

  it('throws SubscriptionError UNAUTHORIZED when FAILED tx XDR contains #9', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'fail-hash-9' });
    mockGetTransaction.mockResolvedValue({
      status: 'FAILED',
      resultMetaXdr: 'error-payload-#9-encoded',
    });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'SubscriptionError',
      code: 'UNAUTHORIZED',
    });
  });

  it('propagates errors from getAccount (RPC unreachable)', async () => {
    mockGetAccount.mockRejectedValue(new Error('network unreachable'));

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toThrow('network unreachable');
  });
});

// ─── pauseContractOnChain ─────────────────────────────────────────────────────

describe('pauseContractOnChain', () => {
  it('submits a real Soroban transaction and returns its hash on success', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'real-pause-tx-hash-001' });
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' });

    const result = await pauseContractOnChain();

    expect(result.transactionId).toBe('real-pause-tx-hash-001');
    expect(mockGetAccount).toHaveBeenCalled();
    expect(mockSimulate).toHaveBeenCalled();
    expect(mockAssemble).toHaveBeenCalled();
    expect(mockSendTransaction).toHaveBeenCalled();
    expect(mockGetTransaction).toHaveBeenCalledWith('real-pause-tx-hash-001');
  });

  it('polls getTransaction until status is no longer NOT_FOUND', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'pause-poll-hash' });
    mockGetTransaction
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS' });

    jest.useFakeTimers();
    const promise = pauseContractOnChain();
    await jest.runAllTimersAsync();
    const result = await promise;
    jest.useRealTimers();

    expect(result.transactionId).toBe('pause-poll-hash');
    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
  });

  it('throws ContractActionError CONTRACT_ALREADY_PAUSED when simulation reports the contract is already paused', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'ContractPaused' });

    await expect(pauseContractOnChain()).rejects.toMatchObject({
      name: 'ContractActionError',
      code: 'CONTRACT_ALREADY_PAUSED',
    });
    // Never submitted — the function throws before sendTransaction
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('throws ContractActionError CONTRACT_ALREADY_PAUSED when simulation error contains contract code #10', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'Contract error: #10' });

    await expect(pauseContractOnChain()).rejects.toMatchObject({
      name: 'ContractActionError',
      code: 'CONTRACT_ALREADY_PAUSED',
    });
  });

  it('throws ContractActionError NETWORK_ERROR for an unrelated simulation error', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'Something went wrong' });

    await expect(pauseContractOnChain()).rejects.toMatchObject({
      name: 'ContractActionError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws ContractActionError NETWORK_ERROR when sendTransaction returns ERROR status', async () => {
    mockSendTransaction.mockResolvedValue({
      status: 'ERROR',
      errorResult: 'tx_failed',
      hash: 'pause-err-hash',
    });

    await expect(pauseContractOnChain()).rejects.toMatchObject({
      name: 'ContractActionError',
      code: 'NETWORK_ERROR',
    });
    // Transaction never confirmed — getTransaction should NOT be called
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it('throws ContractActionError NETWORK_ERROR when the confirmed transaction has FAILED status', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'pause-fail-hash' });
    mockGetTransaction.mockResolvedValue({ status: 'FAILED' });

    await expect(pauseContractOnChain()).rejects.toMatchObject({
      name: 'ContractActionError',
      code: 'NETWORK_ERROR',
    });
  });

  it('propagates errors from getAccount (RPC unreachable)', async () => {
    mockGetAccount.mockRejectedValue(new Error('network unreachable'));

    await expect(pauseContractOnChain()).rejects.toThrow('network unreachable');
  });
});

// ─── registerValidatorOnChain ─────────────────────────────────────────────────

describe('registerValidatorOnChain', () => {
  it('throws PaymentError INVALID_ACCOUNT for empty validatorWallet', async () => {
    await expect(registerValidatorOnChain('')).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'INVALID_ACCOUNT',
    });
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('submits a real Soroban transaction and returns its hash on success', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'real-register-tx-001' });
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' });

    const result = await registerValidatorOnChain(WALLET);

    expect(result.transactionId).toBe('real-register-tx-001');
    expect(mockGetAccount).toHaveBeenCalled();
    expect(mockSimulate).toHaveBeenCalled();
    expect(mockAssemble).toHaveBeenCalled();
    expect(mockSendTransaction).toHaveBeenCalled();
    expect(mockGetTransaction).toHaveBeenCalledWith('real-register-tx-001');
  });

  it('polls getTransaction until status is no longer NOT_FOUND', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'register-poll-hash' });
    mockGetTransaction
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS' });

    jest.useFakeTimers();
    const promise = registerValidatorOnChain(WALLET);
    await jest.runAllTimersAsync();
    const result = await promise;
    jest.useRealTimers();

    expect(result.transactionId).toBe('register-poll-hash');
    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
  });

  it('throws ValidatorActionError ALREADY_REGISTERED when simulation returns contract error #13', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'Contract error: #13' });

    await expect(registerValidatorOnChain(WALLET)).rejects.toMatchObject({
      name: 'ValidatorActionError',
      code: 'ALREADY_REGISTERED',
    });
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('throws ValidatorActionError UNAUTHORIZED when simulation message contains "unauthorized"', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'Unauthorized caller' });

    await expect(registerValidatorOnChain(WALLET)).rejects.toMatchObject({
      name: 'ValidatorActionError',
      code: 'UNAUTHORIZED',
    });
  });

  it('throws ValidatorActionError NETWORK_ERROR for an unknown simulation error', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'Something went wrong' });

    await expect(registerValidatorOnChain(WALLET)).rejects.toMatchObject({
      name: 'ValidatorActionError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws ValidatorActionError NETWORK_ERROR when sendTransaction returns ERROR status', async () => {
    mockSendTransaction.mockResolvedValue({
      status: 'ERROR',
      errorResult: 'tx_failed',
      hash: 'register-err-hash',
    });

    await expect(registerValidatorOnChain(WALLET)).rejects.toMatchObject({
      name: 'ValidatorActionError',
      code: 'NETWORK_ERROR',
    });
    // Transaction never confirmed — getTransaction should NOT be called
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it('throws ValidatorActionError NETWORK_ERROR when the confirmed transaction has FAILED status', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'register-fail-hash' });
    mockGetTransaction.mockResolvedValue({ status: 'FAILED', resultMetaXdr: '' });

    await expect(registerValidatorOnChain(WALLET)).rejects.toMatchObject({
      name: 'ValidatorActionError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws ValidatorActionError ALREADY_REGISTERED when FAILED tx XDR contains #13', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'register-fail-hash-13' });
    mockGetTransaction.mockResolvedValue({
      status: 'FAILED',
      resultMetaXdr: 'error-payload-#13-encoded',
    });

    await expect(registerValidatorOnChain(WALLET)).rejects.toMatchObject({
      name: 'ValidatorActionError',
      code: 'ALREADY_REGISTERED',
    });
  });

  it('propagates errors from getAccount (RPC unreachable)', async () => {
    mockGetAccount.mockRejectedValue(new Error('network unreachable'));

    await expect(registerValidatorOnChain(WALLET)).rejects.toThrow('network unreachable');
  });
});

// ─── logTrialOffer ────────────────────────────────────────────────────────────

describe('logTrialOffer', () => {
  const PLAYER_ID = 'player-123';
  const DETAILS_URI = 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

  it('throws PaymentError INVALID_ACCOUNT for missing scoutWallet, playerId, or detailsUri', async () => {
    await expect(logTrialOffer('', PLAYER_ID, DETAILS_URI)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'INVALID_ACCOUNT',
    });
    await expect(logTrialOffer(WALLET, '', DETAILS_URI)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'INVALID_ACCOUNT',
    });
    await expect(logTrialOffer(WALLET, PLAYER_ID, '')).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'INVALID_ACCOUNT',
    });
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('submits a real Soroban transaction and returns the confirmed hash and contract playerTier', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'real-tx-hash-002' });
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS', returnValue: { type: 'scvU32' } });
    sdk.scValToNative.mockReturnValue(3);

    const result = await logTrialOffer(WALLET, PLAYER_ID, DETAILS_URI);

    expect(result.transactionId).toBe('real-tx-hash-002');
    expect(result.playerId).toBe(PLAYER_ID);
    expect(result.detailsUri).toBe(DETAILS_URI);
    expect(result.playerTier).toBe(3);
    expect(mockGetAccount).toHaveBeenCalled();
    expect(mockSimulate).toHaveBeenCalled();
    expect(mockAssemble).toHaveBeenCalled();
    expect(mockSendTransaction).toHaveBeenCalled();
    expect(mockGetTransaction).toHaveBeenCalledWith('real-tx-hash-002');
  });

  it('defaults playerTier to 3 when the contract returns no value', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'no-retval-hash' });
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' });

    const result = await logTrialOffer(WALLET, PLAYER_ID, DETAILS_URI);
    expect(result.playerTier).toBe(3);
  });

  it('polls getTransaction until status is no longer NOT_FOUND before returning', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'poll-hash-2' });
    mockGetTransaction
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS', returnValue: { type: 'scvU32' } });
    sdk.scValToNative.mockReturnValue(3);

    jest.useFakeTimers();
    const promise = logTrialOffer(WALLET, PLAYER_ID, DETAILS_URI);
    await jest.runAllTimersAsync();
    const result = await promise;
    jest.useRealTimers();

    expect(result.transactionId).toBe('poll-hash-2');
    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
  });

  it('throws PaymentError NETWORK_ERROR when getAccount fails', async () => {
    mockGetAccount.mockRejectedValue(new Error('rpc unreachable'));

    await expect(logTrialOffer(WALLET, PLAYER_ID, DETAILS_URI)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws PaymentError NETWORK_ERROR on simulation error response', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'rpc down' });

    await expect(logTrialOffer(WALLET, PLAYER_ID, DETAILS_URI)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('throws PaymentError NETWORK_ERROR when simulateTransaction rejects', async () => {
    mockSimulate.mockRejectedValue(new Error('connection timeout'));

    await expect(logTrialOffer(WALLET, PLAYER_ID, DETAILS_URI)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws PaymentError NETWORK_ERROR when sendTransaction returns ERROR status', async () => {
    mockSendTransaction.mockResolvedValue({
      status: 'ERROR',
      errorResult: 'tx_failed',
      hash: 'err-hash',
    });

    await expect(logTrialOffer(WALLET, PLAYER_ID, DETAILS_URI)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it('throws PaymentError NETWORK_ERROR when sendTransaction rejects', async () => {
    mockSendTransaction.mockRejectedValue(new Error('submit unreachable'));

    await expect(logTrialOffer(WALLET, PLAYER_ID, DETAILS_URI)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws PaymentError NETWORK_ERROR when the confirmed transaction has FAILED status', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'fail-hash' });
    mockGetTransaction.mockResolvedValue({ status: 'FAILED' });

    await expect(logTrialOffer(WALLET, PLAYER_ID, DETAILS_URI)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws PaymentError NETWORK_ERROR when getTransaction polling rejects', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'poll-fail-hash' });
    mockGetTransaction.mockRejectedValue(new Error('poll unreachable'));

    await expect(logTrialOffer(WALLET, PLAYER_ID, DETAILS_URI)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });
});

// ─── renewSubscription ────────────────────────────────────────────────────────

describe('renewSubscription', () => {
  const TIER = 'basic';
  const DURATION = 30;
  const PREVIOUS_EXPIRY = 1700000000;

  it('throws PaymentError INVALID_ACCOUNT for empty wallet', async () => {
    await expect(renewSubscription('', TIER, DURATION, PREVIOUS_EXPIRY)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'INVALID_ACCOUNT',
    });
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('re-invokes subscribe() and returns the confirmed transaction hash and on-chain expiry', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'real-renew-tx-001' });
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS', returnValue: { type: 'scvU64' } });
    const newExpiry = 1712345678;
    sdk.scValToNative.mockReturnValue(newExpiry);

    const result = await renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY);

    expect(result.transactionId).toBe('real-renew-tx-001');
    expect(result.tier).toBe(TIER);
    expect(result.expiresAt).toBe(newExpiry);
    expect(result.status).toBe('active');
    expect(mockGetAccount).toHaveBeenCalled();
    expect(mockSimulate).toHaveBeenCalled();
    expect(mockAssemble).toHaveBeenCalled();
    expect(mockSendTransaction).toHaveBeenCalled();
    expect(mockGetTransaction).toHaveBeenCalledWith('real-renew-tx-001');
  });

  it('polls getTransaction until status is no longer NOT_FOUND before returning', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'renew-poll-hash' });
    mockGetTransaction
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS', returnValue: { type: 'scvU64' } });
    sdk.scValToNative.mockReturnValue(1712345678);

    jest.useFakeTimers();
    const promise = renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY);
    await jest.runAllTimersAsync();
    const result = await promise;
    jest.useRealTimers();

    expect(result.transactionId).toBe('renew-poll-hash');
    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
  });

  it('throws PaymentError INSUFFICIENT_FUNDS when simulation reports contract error #7', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'Contract error: #7' });

    await expect(renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'INSUFFICIENT_FUNDS',
    });
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('throws PaymentError INSUFFICIENT_FUNDS when the confirmed tx XDR reports insufficient fee', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'renew-fail-fee' });
    mockGetTransaction.mockResolvedValue({ status: 'FAILED', resultMetaXdr: 'error-payload-#7-encoded' });

    await expect(renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'INSUFFICIENT_FUNDS',
    });
  });

  it('throws PaymentError EXPIRED_TRUSTLINE when simulation reports a missing trustline', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'trustline not found for payment token' });

    await expect(renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'EXPIRED_TRUSTLINE',
    });
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('throws PaymentError EXPIRED_TRUSTLINE when the confirmed tx XDR reports a trustline error', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'renew-fail-trust' });
    mockGetTransaction.mockResolvedValue({ status: 'FAILED', resultMetaXdr: 'TrustLineEntry missing' });

    await expect(renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'EXPIRED_TRUSTLINE',
    });
  });

  it('throws PaymentError CONTRACT_ERROR on a generic contract panic during simulation', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'HostError: panicked at contract' });

    await expect(renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'CONTRACT_ERROR',
    });
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('throws PaymentError CONTRACT_ERROR when sendTransaction returns ERROR status for an unrecognized reason', async () => {
    mockSendTransaction.mockResolvedValue({
      status: 'ERROR',
      errorResult: 'tx_bad_auth',
      hash: 'renew-err-hash',
    });

    await expect(renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'CONTRACT_ERROR',
    });
    // Transaction never confirmed — getTransaction should NOT be called
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it('throws PaymentError CONTRACT_ERROR when the confirmed transaction has FAILED status for an unrecognized reason', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'renew-fail-generic' });
    mockGetTransaction.mockResolvedValue({ status: 'FAILED', resultMetaXdr: '' });

    await expect(renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'CONTRACT_ERROR',
    });
  });

  it('throws PaymentError CONTRACT_ERROR when the confirmed transaction has no returnValue field at all', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'renew-no-retval' });
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' });

    await expect(renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'CONTRACT_ERROR',
    });
  });

  it('throws PaymentError CONTRACT_ERROR (not a silent success) when the contract returns void instead of an expiry', async () => {
    // A contract function returning unit still yields a truthy ScVal wrapping
    // scvVoid — scValToNative() decodes that to `null`, not undefined, and
    // does not throw (verified against @stellar/stellar-base's scval.js).
    // This reproduces that exact on-the-wire shape to guard against silently
    // accepting expiresAt: null as if it were a real confirmed expiry.
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'renew-void-retval' });
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS', returnValue: { type: 'scvVoid' } });
    sdk.scValToNative.mockReturnValue(null);

    await expect(renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'CONTRACT_ERROR',
    });
  });

  it('throws PaymentError NETWORK_ERROR when getAccount fails (RPC unreachable) — distinct from an on-chain rejection', async () => {
    mockGetAccount.mockRejectedValue(new Error('network unreachable'));

    await expect(renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws PaymentError NETWORK_ERROR when simulateTransaction rejects — distinct from an on-chain rejection', async () => {
    mockSimulate.mockRejectedValue(new Error('connection timeout'));

    await expect(renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws PaymentError NETWORK_ERROR when sendTransaction rejects — distinct from an on-chain rejection', async () => {
    mockSendTransaction.mockRejectedValue(new Error('submit unreachable'));

    await expect(renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws PaymentError NETWORK_ERROR when getTransaction polling rejects — distinct from an on-chain rejection', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'renew-poll-fail' });
    mockGetTransaction.mockRejectedValue(new Error('poll unreachable'));

    await expect(renewSubscription(WALLET, TIER, DURATION, PREVIOUS_EXPIRY)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });
});

// ─── HTTP Keepalive Configuration ─────────────────────────────────────────────

describe('HTTP Keepalive Configuration', () => {
  it('the module loads without errors and the server singleton is defined', () => {
    expect(() => require('../../src/services/stellar')).not.toThrow();
  });
});
