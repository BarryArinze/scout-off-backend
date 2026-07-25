import Redis from 'ioredis';
import config from '../config';
import { logger } from '../utils/logger';

let redisClient: Redis | null = null;

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
