import { nativeToScVal } from '@stellar/stellar-sdk';
import { parseBoolean, parseU128, parseMilestones, parseSubscription } from '../../src/utils/xdrParser';

describe('parseBoolean', () => {
  it('returns true for scvBool true', () => {
    const val = nativeToScVal(true, { type: 'bool' });
    expect(parseBoolean(val)).toBe(true);
  });

  it('returns false for scvBool false', () => {
    const val = nativeToScVal(false, { type: 'bool' });
    expect(parseBoolean(val)).toBe(false);
  });

  it('throws for non-bool ScVal', () => {
    const val = nativeToScVal(42, { type: 'u32' });
    expect(() => parseBoolean(val)).toThrow();
  });
});

describe('parseU128', () => {
  it('parses a u128 value to bigint', () => {
    const val = nativeToScVal(BigInt('123456789'), { type: 'u128' });
    expect(parseU128(val)).toBe(BigInt('123456789'));
  });

  it('throws for non-u128 ScVal', () => {
    const val = nativeToScVal(true, { type: 'bool' });
    expect(() => parseU128(val)).toThrow();
  });
});

describe('parseMilestones', () => {
  it('returns empty array for empty vec', () => {
    const val = nativeToScVal([], { type: 'array' });
    expect(parseMilestones(val)).toEqual([]);
  });

  it('throws for non-vec ScVal', () => {
    const val = nativeToScVal(true, { type: 'bool' });
    expect(() => parseMilestones(val)).toThrow();
  });
});

describe('parseSubscription', () => {
  it('parses active subscription', () => {
    const val = nativeToScVal(
      { active: true, expires_at: '1000000' },
      { type: 'map' }
    );
    const result = parseSubscription(val);
    expect(result.active).toBe(true);
    expect(result.expiresAt).toBe('1000000');
  });

  it('throws for non-map ScVal', () => {
    const val = nativeToScVal(true, { type: 'bool' });
    expect(() => parseSubscription(val)).toThrow();
  });
});
