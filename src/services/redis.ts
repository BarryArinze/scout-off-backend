import Redis from 'ioredis';
import config from '../config';
import { logger } from '../utils/logger';

let redisClient: Redis | null = null;
let redisSubscriberClient: Redis | null = null;

/**
 * Get a shared singleton Redis client if REDIS_URL is configured.
 */
export function getRedisClient(): Redis | null {
  if (!config.redisUrl) {
    return null;
  }
  if (!redisClient) {
    redisClient = new Redis(config.redisUrl);
    // ioredis emits 'error' on connection failures; an EventEmitter 'error' with no listener 
    // crashes the process, so this must be attached.
    redisClient.on('error', (err) => {
      logger.error('[redis] Redis client error:', err);
    });
  }
  return redisClient;
}

/**
 * Get a dedicated Redis connection for Pub/Sub subscriber mode.
 *
 * ioredis forbids issuing normal commands on a connection that has been put
 * into subscriber mode, so this returns a *duplicated* connection (sharing the
 * same underlying connection pool options but with its own socket) that is
 * exclusively used for `subscribe` / message handling. `null` when REDIS_URL
 * is not configured — the in-memory backend has no cross-instance channel.
 */
export function getRedisSubscriberClient(): Redis | null {
  const client = getRedisClient();
  if (!client) {
    return null;
  }
  if (!redisSubscriberClient) {
    redisSubscriberClient = client.duplicate();
    redisSubscriberClient.on('error', (err) => {
      logger.error('[redis] Redis subscriber client error:', err);
    });
  }
  return redisSubscriberClient;
}

/**
 * Close both Redis connections used by this module (the command client and the
 * pub/sub subscriber). Safe to call when Redis is not configured or already
 * closed; failures are logged and swallowed so shutdown is never blocked.
 */
export async function closeRedisClients(): Promise<void> {
  if (redisSubscriberClient) {
    const subscriber = redisSubscriberClient;
    redisSubscriberClient = null;
    try {
      await subscriber.quit();
    } catch (err) {
      logger.warn('[redis] error closing subscriber client:', err);
    }
  }
  if (redisClient) {
    const client = redisClient;
    redisClient = null;
    try {
      await client.quit();
    } catch (err) {
      logger.warn('[redis] error closing Redis client:', err);
    }
  }
}
