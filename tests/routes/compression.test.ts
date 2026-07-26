/**
 * Verifies that the compression middleware sends gzip-encoded responses when
 * the client advertises Accept-Encoding: gzip.
 *
 * COMPRESSION_THRESHOLD is set to 0 so even small test payloads are compressed.
 */
process.env.COMPRESSION_THRESHOLD = '0';

import request from 'supertest';
import app from '../../src/app';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  getPlayerById: jest.fn().mockReturnValue(null),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn().mockReturnValue(1),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
  indexerLedgerLag: 0,
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'),
  checkHealth: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/stellar', () => ({
  stellarHealth: jest.fn().mockResolvedValue(true),
  updateProfile: jest.fn(),
  queryMilestones: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/cache', () => ({
  cacheGet: jest.fn().mockReturnValue(undefined),
  cacheSet: jest.fn(),
  invalidatePlayerCache: jest.fn(),
}));

describe('Response compression', () => {
  it('compresses the player list response when client sends Accept-Encoding: gzip', async () => {
    const res = await request(app)
      .get('/api/players')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse((res, callback) => {
        // Collect raw bytes so we can inspect headers before decompression.
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('serves health check correctly without compression when not requested', async () => {
    const res = await request(app)
      .get('/health')
      .set('Accept-Encoding', 'identity');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('serves health check with gzip when Accept-Encoding: gzip is set', async () => {
    const res = await request(app)
      .get('/health')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });
});
