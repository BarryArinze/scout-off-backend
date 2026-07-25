import Redis from 'ioredis';
import { RateLimitStore } from './rateLimitStore';

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private client: Redis) {}

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const redisKey = `rate-limit:${key}`;
    
    // Use a Lua script to ensure atomicity of INCR and conditional PEXPIRE.
    // It returns the new count and the current TTL in milliseconds.
    const script = `
      local count = redis.call("INCR", KEYS[1])
      if count == 1 then
        redis.call("PEXPIRE", KEYS[1], ARGV[1])
      end
      local ttl = redis.call("PTTL", KEYS[1])
      return {count, ttl}
    `;

    const result = await this.client.eval(script, 1, redisKey, windowMs) as [number, number];
    const count = result[0];
    const ttl = result[1] > 0 ? result[1] : windowMs;
    const resetAt = Date.now() + ttl;

    return { count, resetAt };
  }
}
