import { EventEmitter } from 'events';
import RedisMock from 'ioredis-mock';
import { InMemoryCacheStore } from '../../src/services/inMemoryCacheStore';
import { RedisCacheStore, RedisLike } from '../../src/services/redisCacheStore';
import { runCacheStoreContractTests } from './cacheStore.contract';

// Same contract, two backends. There is no live Redis server in this
// environment, so the Redis-backed run uses ioredis-mock — an in-memory fake
// that implements the ioredis client surface (get/set/del/exists/scan/
// pipeline, including PX/EX TTL support) so the SCAN-based invalidation and
// TTL-expiry paths in RedisCacheStore are exercised without a real server.
runCacheStoreContractTests('InMemoryCacheStore', () => new InMemoryCacheStore());

runCacheStoreContractTests('RedisCacheStore (ioredis-mock)', async () => {
  // ioredis-mock simulates multiple clients talking to the *same* server, so
  // separate `new RedisMock()` instances share state by default (mirroring
  // real Redis). Flush before each test so the contract suite sees an
  // isolated store per test, same as the fresh InMemoryCacheStore above.
  const client = new RedisMock();
  await client.flushall();
  return new RedisCacheStore(client as unknown as RedisLike);
});

describe('cache.ts public API (default in-memory backend)', () => {
  // REDIS_URL is unset in the test environment, so src/services/cache.ts
  // resolves to the InMemoryCacheStore backend.
  let cache: typeof import('../../src/services/cache');

  beforeEach(() => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cache = require('../../src/services/cache');
  });

  it('cacheSet/cacheGet round-trip a value', async () => {
    await cache.cacheSet('players:1', { name: 'Bob' });
    await expect(cache.cacheGet('players:1')).resolves.toEqual({ name: 'Bob' });
  });

  it('cacheGet returns undefined for a key that was never set', async () => {
    await expect(cache.cacheGet('nope')).resolves.toBeUndefined();
  });

  it('invalidatePlayerCache() clears players:list:* and, if given a playerId, players:<id>', async () => {
    await cache.cacheSet('players:list:region=africa', ['a', 'b']);
    await cache.cacheSet('players:list:region=europe', ['c']);
    await cache.cacheSet('players:42', { id: 42 });

    await cache.invalidatePlayerCache('42');

    await expect(cache.cacheGet('players:list:region=africa')).resolves.toBeUndefined();
    await expect(cache.cacheGet('players:list:region=europe')).resolves.toBeUndefined();
    await expect(cache.cacheGet('players:42')).resolves.toBeUndefined();
  });

  it('invalidatePlayerCache() without a playerId only clears the list cache', async () => {
    await cache.cacheSet('players:list:all', ['a']);
    await cache.cacheSet('players:99', { id: 99 });

    await cache.invalidatePlayerCache();

    await expect(cache.cacheGet('players:list:all')).resolves.toBeUndefined();
    await expect(cache.cacheGet('players:99')).resolves.toEqual({ id: 99 });
  });

  it('invalidateMilestoneCache() clears the milestone entry and the player list cache', async () => {
    await cache.cacheSet('milestones:7', [{ type: 'identity' }]);
    await cache.cacheSet('players:list:all', ['x']);
    await cache.cacheSet('players:7', { id: 7 });

    await cache.invalidateMilestoneCache('7');

    await expect(cache.cacheGet('milestones:7')).resolves.toBeUndefined();
    await expect(cache.cacheGet('players:list:all')).resolves.toBeUndefined();
    await expect(cache.cacheGet('players:7')).resolves.toBeUndefined();
  });
});

describe('cache.ts Redis backend error handling', () => {
  // A Redis client's 'error' event with no listener is treated by Node as an
  // uncaught exception and crashes the process. Simulate that event here and
  // assert the module survives it, guarding against the listener being
  // dropped in a future refactor.
  it('does not crash when the Redis client emits an error event', async () => {
    const fakeClient = new EventEmitter();
    jest.resetModules();
    jest.doMock('ioredis', () => ({
      __esModule: true,
      default: jest.fn(() => fakeClient),
    }));
    jest.doMock('../../src/config', () => ({
      __esModule: true,
      default: { ...jest.requireActual('../../src/config').default, redisUrl: 'redis://fake:6379' },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../src/services/cache');

    expect(() => fakeClient.emit('error', new Error('connection refused'))).not.toThrow();

    jest.dontMock('ioredis');
    jest.dontMock('../../src/config');
    jest.resetModules();
  });
});
