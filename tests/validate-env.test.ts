import { validateRuntimeEnv } from '../scripts/validate-env';

describe('validate-env runtime validation', () => {
  it('should pass on a complete valid config (NODE_ENV=development)', () => {
    const env = {
      NODE_ENV: 'development',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toEqual([]);
  });

  it('should pass on a complete valid config (NODE_ENV=production)', () => {
    const env = {
      NODE_ENV: 'production',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toEqual([]);
  });

  it('should pass when NODE_ENV is unset (defaults to development)', () => {
    const env = {
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toEqual([]);
  });

  it('should report an error when CONTRACT_ID is missing', () => {
    const env = {
      NODE_ENV: 'development',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain('Missing required environment variable: CONTRACT_ID');
  });

  it('should report an error when JWT_SECRET is missing', () => {
    const env = {
      NODE_ENV: 'development',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain('Missing required environment variable: JWT_SECRET');
  });

  it('should report both errors when CONTRACT_ID and JWT_SECRET are missing', () => {
    const env = {
      NODE_ENV: 'development',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain('Missing required environment variable: CONTRACT_ID');
    expect(errors).toContain('Missing required environment variable: JWT_SECRET');
    expect(errors.length).toBe(2);
  });

  it('should report an error on a malformed/invalid NODE_ENV value', () => {
    const env = {
      NODE_ENV: 'invalid_env',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain(
      'NODE_ENV="invalid_env" is invalid. Must be one of: development, test, production'
    );
  });

  it('should pass on valid CORS_ALLOWED_ORIGINS', () => {
    const env = {
      NODE_ENV: 'production',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
      CORS_ALLOWED_ORIGINS: 'https://app.scoutoff.io,https://staging.scoutoff.io',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toEqual([]);
  });

  it('should report an error on malformed CORS_ALLOWED_ORIGINS', () => {
    const env = {
      NODE_ENV: 'production',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
      CORS_ALLOWED_ORIGINS: 'invalid-origin-without-protocol',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain(
      'Invalid CORS origin format: "invalid-origin-without-protocol". Origins must be "*" or start with http:// or https://'
    );
  });
});
