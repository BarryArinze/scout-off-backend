// Tests for atomic pinJson deduplication and concurrency guard (#466)

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    pinata: { apiKey: 'test-key', secret: 'test-secret', gateway: 'https://gateway.pinata.cloud' },
    logLevel: 'warn',
    nodeEnv: 'test',
    pinJsonCacheTtlMs: 300_000,
  },
}));

jest.mock('axios');
import axios from 'axios';
const mockedPost = jest.fn();
(axios as jest.Mocked<typeof axios>).post = mockedPost;

jest.mock('../../src/db', () => ({
  insertPendingPin: jest.fn().mockImplementation((p: { hash?: string }) => {
    if (p.hash) {
      return true;
    }
    return true;
  }),
  getPendingPins: jest.fn().mockReturnValue([]),
  deletePendingPin: jest.fn(),
  deletePendingPinByHash: jest.fn(),
  isPendingPinByHash: jest.fn().mockReturnValue(false),
  incrementPendingPinAttempts: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    critical: jest.fn(),
  },
}));

import { pinJson, clearPinJsonCache } from '../../src/services/ipfs';
import { insertPendingPin, deletePendingPinByHash } from '../../src/db';

describe('pinJson concurrency and atomic deduplication (#466)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPinJsonCache();
  });

  it('guarantees exactly one Pinata API call when two pinJson requests are made concurrently with identical content', async () => {
    mockedPost.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ data: { IpfsHash: 'QmConcurrentCID' } }), 50))
    );

    const metadata = { playerId: 'P001', score: 100 };

    const [cid1, cid2] = await Promise.all([pinJson(metadata), pinJson(metadata)]);

    expect(cid1).toBe('QmConcurrentCID');
    expect(cid2).toBe('QmConcurrentCID');
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(insertPendingPin).toHaveBeenCalledWith(
      expect.objectContaining({ payload: JSON.stringify(metadata), hash: expect.any(String) })
    );
    expect(deletePendingPinByHash).toHaveBeenCalledWith(expect.any(String));
  });

  it('handles DB lock contention when concurrent caller encounters existing pending_pin', async () => {
    const pendingLocks = new Set<string>();

    (insertPendingPin as jest.Mock).mockImplementation((p: { hash?: string; payload: string }) => {
      if (p.hash) {
        if (pendingLocks.has(p.hash)) return false;
        pendingLocks.add(p.hash);
        return true;
      }
      return true;
    });

    (deletePendingPinByHash as jest.Mock).mockImplementation((hash: string) => {
      pendingLocks.delete(hash);
    });

    mockedPost.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ data: { IpfsHash: 'QmContendedCID' } }), 60))
    );

    const metadata = { playerId: 'P002', score: 200 };

    const [cid1, cid2] = await Promise.all([pinJson(metadata), pinJson(metadata)]);

    expect(cid1).toBe('QmContendedCID');
    expect(cid2).toBe('QmContendedCID');
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });
});
