import { getDb, queryPlayers, countPlayers, insertOrUpdatePlayer, deactivatePlayer, reactivatePlayer } from '../../src/db';

describe('Player Query Deactivation Filtering', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM players').run();
  });

  it('excludes deactivated players by default in queryPlayers and countPlayers', () => {
    insertOrUpdatePlayer({ player_id: 'p-active', wallet: 'G-wallet-active', position: 'striker', region: 'europe', created_at: 100 });
    insertOrUpdatePlayer({ player_id: 'p-deactivated', wallet: 'G-wallet-deactivated', position: 'striker', region: 'europe', created_at: 200 });

    deactivatePlayer('p-deactivated');

    // Default query
    const activeRows = queryPlayers({ region: 'europe' });
    const activeCount = countPlayers({ region: 'europe' });

    expect(activeRows.map((r) => r.player_id)).toEqual(['p-active']);
    expect(activeCount).toBe(1);
  });

  it('includes deactivated players in queryPlayers when includeDeactivated is true', () => {
    insertOrUpdatePlayer({ player_id: 'p-active', wallet: 'G-wallet-active', position: 'striker', region: 'europe', created_at: 100 });
    insertOrUpdatePlayer({ player_id: 'p-deactivated', wallet: 'G-wallet-deactivated', position: 'striker', region: 'europe', created_at: 200 });

    deactivatePlayer('p-deactivated');

    const allRows = queryPlayers({ region: 'europe', includeDeactivated: true });
    expect(allRows.map((r) => r.player_id)).toContain('p-active');
    expect(allRows.map((r) => r.player_id)).toContain('p-deactivated');
    expect(allRows).toHaveLength(2);
  });

  it('makes reactivated players visible again', () => {
    insertOrUpdatePlayer({ player_id: 'p-reactivated', wallet: 'G-wallet-reactivated', position: 'striker', region: 'europe', created_at: 100 });
    
    deactivatePlayer('p-reactivated');
    expect(queryPlayers({ region: 'europe' })).toHaveLength(0);

    reactivatePlayer('p-reactivated');
    expect(queryPlayers({ region: 'europe' }).map((r) => r.player_id)).toEqual(['p-reactivated']);
  });
});
