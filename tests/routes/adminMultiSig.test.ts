jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    adminWallets: [
      'GADMIN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'GADMIN2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'GADMIN3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ],
    adminThreshold: 3,
    adminActionTtlMs: 60000,
    adminWallet: 'GADMIN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    nodeEnv: 'test',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    jwtSecret: 'test-secret',
    jwtSecretPrevious: '',
    platformSecret: '',
    platformSecretKey: '',
    dbPath: ':memory:',
    stellarHealthCheckEnabled: false,
    useMockServices: true,
    showErrorDetails: true,
    port: 0,
    network: 'testnet',
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    platformFeeBps: 500,
    securityHeaders: {
      hsts: 'max-age=31536000',
      xContentTypeOptions: 'nosniff',
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
      csp: "default-src 'none'",
    },
    webhook: { enabled: false, url: '' },
    rateLimit: { enabled: false, windowMs: 60000, max: 1000 },
    authRateLimit: { windowMs: 60000, max: 1000 },
    bodyLimit: { json: '1mb' },
    allowedOrigins: [],
    logLevel: 'warn',
    requestTimeoutMs: 30000,
    requestLog: { skipPaths: [], sampleRate: 1 },
    playerCacheTtlMs: 60000,
    pinJsonCacheTtlMs: 300000,
    subscriptionGracePeriodHours: 24,
    pinata: { apiKey: '', secret: '', gateway: '', gateways: [] },
    backfillFromLedger: null,
  },
}));

const store: {
  pending_admin_actions: Array<Record<string, unknown>>;
  admin_action_signatures: Array<Record<string, unknown>>;
} = {
  pending_admin_actions: [],
  admin_action_signatures: [],
};

function resetStore(): void {
  store.pending_admin_actions = [];
  store.admin_action_signatures = [];
}

jest.mock('../../src/db', () => {
  const actual = jest.requireActual('../../src/db');
  return {
    ...actual,
    queryEvents: jest.fn().mockReturnValue([]),
    insertPendingAdminAction: jest.fn((p: Record<string, unknown>) => {
      store.pending_admin_actions.push({
        ...p,
        status: 'pending',
        collected_signatures: p.collected_signatures ?? 0,
      });
    }),
    getPendingAdminActionById: jest.fn((id: string) => {
      return (store.pending_admin_actions as Array<Record<string, unknown>>).find((a) => a.id === id) ?? null;
    }),
    updatePendingAdminActionStatus: jest.fn((id: string, status: string) => {
      const a = store.pending_admin_actions.find((x) => x.id === id);
      if (a) a.status = status;
    }),
    insertAdminActionSignature: jest.fn((p: Record<string, unknown>) => {
      const exists = store.admin_action_signatures.find(
        (s) => s.action_id === p.action_id && s.signer === p.signer,
      );
      if (exists) return false;
      store.admin_action_signatures.push({ ...p });
      return true;
    }),
    incrementActionSignatures: jest.fn((id: string) => {
      const a = store.pending_admin_actions.find((x) => x.id === id);
      if (a) {
        a.collected_signatures = ((a.collected_signatures as number) ?? 0) + 1;
      }
    }),
    getAdminActionSignature: jest.fn((action_id: string, signer: string) => {
      const s = store.admin_action_signatures.find(
        (x) => x.action_id === action_id && x.signer === signer,
      );
      return s ? { signed_at: s.signed_at as number } : null;
    }),
    expireStalePendingAdminActions: jest.fn(() => {
      const now = Date.now();
      let count = 0;
      for (const a of store.pending_admin_actions) {
        if (a.status === 'pending' && (a.expires_at as number) <= now) {
          a.status = 'expired';
          count++;
        }
      }
      return count;
    }),
    getPendingAdminActionsByStatus: jest.fn((status: string) => {
      return (store.pending_admin_actions as Array<Record<string, unknown>>).filter(
        (a) => a.status === status,
      );
    }),
    getAdminActionSignatures: jest.fn((action_id: string) => {
      return (store.admin_action_signatures as Array<Record<string, unknown>>)
        .filter((s) => s.action_id === action_id)
        .map((s) => ({ signer: s.signer as string, signed_at: s.signed_at as number }));
    }),
  };
});

jest.mock('../../src/services/audit', () => ({
  logAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  proposeAction,
  approveAction,
  listPendingActions,
  getActionDetails,
} from '../../src/services/adminMultiSig';
import { logAuditEvent } from '../../src/services/audit';

const mockLogAuditEvent = logAuditEvent as jest.Mock;

const ADMIN_1 = 'GADMIN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ADMIN_2 = 'GADMIN2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ADMIN_3 = 'GADMIN3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OUTSIDER = 'GOUTSIDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
});

afterAll(() => {
  resetStore();
});

// ─── Propose action ──────────────────────────────────────────────────────────

describe('proposeAction()', () => {
  it('returns a proposed result with actionId when threshold > 1', () => {
    const result = proposeAction('pause_contract', {}, ADMIN_1);

    expect(result.status).toBe('proposed');
    expect(result.actionId).toBeDefined();
    expect(typeof result.actionId).toBe('string');
  });

  it('persists an action with the correct properties', () => {
    const result = proposeAction('withdraw_fees', { recipient: 'G...' }, ADMIN_1);

    const action = store.pending_admin_actions[0];
    expect(action).toBeDefined();
    expect(action.id).toBe(result.actionId);
    expect(action.action_type).toBe('withdraw_fees');
    expect(action.proposer).toBe(ADMIN_1);
    expect(action.required_signatures).toBe(3);
    expect(action.collected_signatures).toBe(1);
    expect(action.status).toBe('pending');
  });

  it('records the proposer as the first signature', () => {
    proposeAction('pause_contract', {}, ADMIN_1);

    expect(store.admin_action_signatures).toHaveLength(1);
    expect(store.admin_action_signatures[0].signer).toBe(ADMIN_1);
  });

  it('logs an audit event on proposal', () => {
    proposeAction('pause_contract', {}, ADMIN_1);

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pause_contract_proposed',
        adminWallet: ADMIN_1,
      }),
    );
  });

  it('sets an expiry timestamp in the future', () => {
    const before = Date.now();
    proposeAction('pause_contract', {}, ADMIN_1);

    expect(store.pending_admin_actions[0].expires_at as number).toBeGreaterThanOrEqual(before);
  });
});

// ─── Approve action ──────────────────────────────────────────────────────────

describe('approveAction()', () => {
  let actionId: string;

  beforeEach(() => {
    actionId = proposeAction('pause_contract', {}, ADMIN_1).actionId;
    jest.clearAllMocks();
  });

  it('records a co-signature and returns pending when below threshold', () => {
    const result = approveAction(actionId, ADMIN_2);

    expect(result.status).toBe('pending');
    expect(result.collected).toBe(2);
    expect(result.required).toBe(3);

    expect(store.admin_action_signatures).toHaveLength(2);
  });

  it('rejects a duplicate signature from the same wallet', () => {
    const result = approveAction(actionId, ADMIN_1);

    expect(result.status).toBe('duplicate');
    expect(result.collected).toBe(1);

    expect(store.admin_action_signatures).toHaveLength(1);
  });

  it('throws when the signer is not in adminWallets', () => {
    expect(() => approveAction(actionId, OUTSIDER)).toThrow('Insufficient permissions');
  });

  it('returns approved status when threshold is reached', () => {
    approveAction(actionId, ADMIN_2);
    const result = approveAction(actionId, ADMIN_3);

    expect(result.status).toBe('approved');
    expect(result.collected).toBe(3);
    expect(result.required).toBe(3);
  });

  it('marks the action as executed when threshold is reached', () => {
    approveAction(actionId, ADMIN_2);
    approveAction(actionId, ADMIN_3);

    const a = store.pending_admin_actions[0];
    expect(a.status).toBe('executed');
  });

  it('throws when trying to approve an already executed action', () => {
    approveAction(actionId, ADMIN_2);
    approveAction(actionId, ADMIN_3);

    expect(() => approveAction(actionId, ADMIN_1)).toThrow('already been executed');
  });

  it('throws for a non-existent action', () => {
    expect(() => approveAction('nonexistent', ADMIN_1)).toThrow('Pending action not found');
  });

  it('rejects expired actions', () => {
    const a = store.pending_admin_actions[0];
    a.expires_at = Date.now() - 1000;

    expect(() => approveAction(actionId, ADMIN_2)).toThrow('expired');
    expect(store.pending_admin_actions[0].status).toBe('expired');
  });

  it('logs an audit event on each approval', () => {
    approveAction(actionId, ADMIN_2);

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pause_contract_approved',
        adminWallet: ADMIN_2,
      }),
    );
  });

  it('logs threshold_met when threshold is reached', () => {
    approveAction(actionId, ADMIN_2);
    jest.clearAllMocks();

    approveAction(actionId, ADMIN_3);

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        queryParams: expect.objectContaining({ outcome: 'threshold_met' }),
      }),
    );
  });
});

// ─── List pending actions ────────────────────────────────────────────────────

describe('listPendingActions()', () => {
  it('returns empty array when no pending actions exist', () => {
    const result = listPendingActions();
    expect(result).toEqual([]);
  });

  it('returns only pending actions', () => {
    proposeAction('pause_contract', {}, ADMIN_1);

    const pending = listPendingActions();
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('pending');
  });

  it('does not return expired actions', () => {
    proposeAction('pause_contract', {}, ADMIN_1);
    const a = store.pending_admin_actions[0];
    a.expires_at = Date.now() - 1000;

    const pending = listPendingActions();
    expect(pending).toHaveLength(0);
    expect(store.pending_admin_actions[0].status).toBe('expired');
  });
});

// ─── Get action details ──────────────────────────────────────────────────────

describe('getActionDetails()', () => {
  it('returns null for non-existent action', () => {
    expect(getActionDetails('nonexistent')).toBeNull();
  });

  it('returns action with signatures', () => {
    const id = proposeAction('pause_contract', {}, ADMIN_1).actionId;
    approveAction(id, ADMIN_2);

    const details = getActionDetails(id);
    expect(details).not.toBeNull();
    expect(details!.action.id).toBe(id);
    expect(details!.signatures).toHaveLength(2);
    expect(details!.signatures.map((s) => s.signer)).toEqual(
      expect.arrayContaining([ADMIN_1, ADMIN_2]),
    );
  });
});

// ─── Happy path: 3-of-3 full flow ────────────────────────────────────────────

describe('Full flow: 3-of-3 threshold', () => {
  it('propose -> co-sign -> co-sign -> executed', () => {
    const result1 = proposeAction('withdraw_fees', { recipient: 'G...' }, ADMIN_1);
    expect(result1.status).toBe('proposed');
    const actionId = result1.actionId;

    const result2 = approveAction(actionId, ADMIN_2);
    expect(result2.status).toBe('pending');
    expect(result2.collected).toBe(2);

    const result3 = approveAction(actionId, ADMIN_3);
    expect(result3.status).toBe('approved');
    expect(result3.collected).toBe(3);

    const a = store.pending_admin_actions[0];
    expect(a.status).toBe('executed');
    expect(a.collected_signatures).toBe(3);
  });
});

// ─── Edge: only 2 of 3 signatures collected (below threshold) ────────────────

describe('Below-threshold: 2 of 3 signatures', () => {
  it('remains pending after 2 signatures', () => {
    const actionId = proposeAction('pause_contract', {}, ADMIN_1).actionId;

    approveAction(actionId, ADMIN_2);
    const detail = listPendingActions();
    expect(detail).toHaveLength(1);
    expect(detail[0].status).toBe('pending');

    const result = approveAction(actionId, ADMIN_3);
    expect(result.status).toBe('approved');
  });
});
