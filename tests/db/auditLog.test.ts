import { getDb, insertAuditLog, getAuditLogs, getAuditLogsCount, getAllAuditLogRows } from '../../src/db';
import { GENESIS_HASH } from '../../src/utils/hashChain';

describe('audit_log — persistence and hash chain (#464)', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM audit_log').run();
  });

  it('round-trips a row through insertAuditLog / getAuditLogs', () => {
    insertAuditLog({
      action: 'contract_state_change',
      adminWallet: 'GADMIN1',
      queryParams: { contractAction: 'pause_contract' },
      createdAt: '2025-01-01T00:00:00.000Z',
    });

    const rows = getAuditLogs({});
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('contract_state_change');
    expect(rows[0].admin_wallet).toBe('GADMIN1');
    expect(JSON.parse(rows[0].query_params)).toEqual({ contractAction: 'pause_contract' });
    expect(getAuditLogsCount({})).toBe(1);
  });

  it('chains the first row onto the genesis hash', () => {
    const row = insertAuditLog({ action: 'a', adminWallet: 'G1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    expect(row.prev_hash).toBe(GENESIS_HASH);
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('chains each subsequent row onto the previous row\'s hash', () => {
    const r1 = insertAuditLog({ action: 'a', adminWallet: 'G1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    const r2 = insertAuditLog({ action: 'b', adminWallet: 'G2', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z' });
    const r3 = insertAuditLog({ action: 'c', adminWallet: 'G3', queryParams: {}, createdAt: '2025-01-03T00:00:00.000Z' });

    expect(r2.prev_hash).toBe(r1.hash);
    expect(r3.prev_hash).toBe(r2.hash);
    // Distinct content/position -> distinct hashes.
    expect(new Set([r1.hash, r2.hash, r3.hash]).size).toBe(3);
  });

  it('defaults event_source to admin_action when not specified', () => {
    const row = insertAuditLog({ action: 'a', adminWallet: 'G1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    expect(row.event_source).toBe('admin_action');
  });

  it('stores a distinct event_source when specified (app_event)', () => {
    const row = insertAuditLog({
      action: 'player_search',
      adminWallet: 'GSCOUT',
      queryParams: {},
      createdAt: '2025-01-01T00:00:00.000Z',
      eventSource: 'app_event',
    });
    expect(row.event_source).toBe('app_event');
  });

  it('getAllAuditLogRows returns every row in id ASC (chain) order, unpaginated', () => {
    for (let i = 0; i < 5; i++) {
      insertAuditLog({ action: `a${i}`, adminWallet: 'G1', queryParams: {}, createdAt: `2025-01-0${i + 1}T00:00:00.000Z` });
    }
    const rows = getAllAuditLogRows();
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort((a, b) => a - b));
  });

  it('getAllAuditLogRows filters by eventSource', () => {
    insertAuditLog({ action: 'admin1', adminWallet: 'G1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    insertAuditLog({ action: 'app1', adminWallet: 'G2', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z', eventSource: 'app_event' });

    expect(getAllAuditLogRows({ eventSource: 'app_event' })).toHaveLength(1);
    expect(getAllAuditLogRows({ eventSource: 'admin_action' })).toHaveLength(1);
    expect(getAllAuditLogRows()).toHaveLength(2);
  });
});
