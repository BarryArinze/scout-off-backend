import { isValidPlayerId, playerIdSchema } from '../../src/utils/playerIdValidator';

describe('isValidPlayerId', () => {
  // Valid cases
  it('accepts a valid alphanumeric playerId', () => {
    expect(isValidPlayerId('player123')).toBe(true);
  });

  it('accepts a playerId with underscores and hyphens', () => {
    expect(isValidPlayerId('player_id-42')).toBe(true);
  });

  it('accepts a single character playerId', () => {
    expect(isValidPlayerId('a')).toBe(true);
  });

  it('accepts a playerId at the maximum length (128 chars)', () => {
    expect(isValidPlayerId('a'.repeat(128))).toBe(true);
  });

  // Invalid cases
  it('rejects an empty string', () => {
    expect(isValidPlayerId('')).toBe(false);
  });

  it('rejects a playerId exceeding the maximum length', () => {
    expect(isValidPlayerId('a'.repeat(129))).toBe(false);
  });

  it('rejects a playerId containing spaces', () => {
    expect(isValidPlayerId('player id')).toBe(false);
  });

  it('rejects a playerId containing special characters', () => {
    expect(isValidPlayerId('player@123')).toBe(false);
  });

  it('rejects a playerId containing a slash', () => {
    expect(isValidPlayerId('player/123')).toBe(false);
  });

  it('rejects a non-string input', () => {
    expect(isValidPlayerId(null as unknown as string)).toBe(false);
  });

  it('rejects a numeric input', () => {
    expect(isValidPlayerId(123 as unknown as string)).toBe(false);
  });
});

describe('playerIdSchema', () => {
  it('parses a valid playerId successfully', () => {
    const result = playerIdSchema.safeParse('valid-player_1');
    expect(result.success).toBe(true);
  });

  it('fails to parse an empty string', () => {
    const result = playerIdSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('fails to parse a playerId with disallowed characters', () => {
    const result = playerIdSchema.safeParse('bad id!');
    expect(result.success).toBe(false);
  });
});
