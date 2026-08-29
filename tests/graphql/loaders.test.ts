// Unit tests for src/graphql/loaders.ts's milestone batch loader (#1189).
//
// batchLoadMilestones merges indexed `milestone_approved` events with
// on-chain query results: indexed rows win on a milestoneId collision,
// on-chain-only milestones are appended, a rejected on-chain lookup still
// returns the indexed rows for that player, and results preserve the
// requested playerId order (the DataLoader contract).

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  queryMilestones: jest.fn(),
}));

import { queryEvents } from '../../src/db';
import { queryMilestones } from '../../src/services/stellar';
import { createLoaders } from '../../src/graphql/loaders';

const mockQueryEvents = queryEvents as jest.Mock;
const mockQueryMilestones = queryMilestones as jest.Mock;

function indexedEvent(playerId: string, milestoneId: string) {
  return {
    payload: {
      player_id: playerId,
      milestone_id: milestoneId,
      milestone_type: 'first_goal',
      evidence_uri: 'ipfs://indexed',
    },
  };
}

function onChainMilestone(milestoneId: string) {
  return {
    milestoneId,
    milestoneType: 'first_goal',
    evidenceUri: 'ipfs://onchain',
    approved: true,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('batchLoadMilestones', () => {
  it('keeps the indexed row and drops the on-chain row on a milestoneId collision', async () => {
    mockQueryEvents.mockReturnValue([indexedEvent('p1', 'm1')]);
    mockQueryMilestones.mockResolvedValue([onChainMilestone('m1')]);

    const result = await createLoaders().milestones.load('p1');

    expect(result).toHaveLength(1);
    expect(result[0].evidenceUri).toBe('ipfs://indexed');
  });

  it('appends an on-chain-only milestone not present in the indexed set', async () => {
    mockQueryEvents.mockReturnValue([indexedEvent('p1', 'm1')]);
    mockQueryMilestones.mockResolvedValue([onChainMilestone('m2')]);

    const result = await createLoaders().milestones.load('p1');

    const ids = result.map((m) => m.milestoneId).sort();
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('falls back to indexed-only rows when the on-chain lookup rejects', async () => {
    mockQueryEvents.mockReturnValue([indexedEvent('p1', 'm1')]);
    mockQueryMilestones.mockRejectedValue(new Error('rpc timeout'));

    const result = await createLoaders().milestones.load('p1');

    expect(result).toEqual([expect.objectContaining({ milestoneId: 'm1' })]);
  });

  it('returns results in the requested playerId order', async () => {
    mockQueryEvents.mockReturnValue([
      indexedEvent('p1', 'm1'),
      indexedEvent('p2', 'm2'),
    ]);
    mockQueryMilestones.mockResolvedValue([]);

    const results = await createLoaders().milestones.loadMany(['p2', 'p1']);

    expect((results[0] as any)[0].playerId).toBe('p2');
    expect((results[1] as any)[0].playerId).toBe('p1');
  });
});
