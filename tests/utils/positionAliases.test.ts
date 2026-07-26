import { normalizePosition, normalizePositionOrFallback, defaultPositionAliases } from '../../src/utils/positionAliases';

describe('positionAliases', () => {
  test('normalizes common synonyms (fw -> forward)', () => {
    expect(normalizePosition('fw')).toBe('forward');
    expect(normalizePosition('FWD')).toBe('forward');
    expect(normalizePosition('Forward')).toBe('forward');
  });

  test('returns undefined for unknown synonyms', () => {
    expect(normalizePosition('unknown-position')).toBeUndefined();
  });

  test('normalizePositionOrFallback falls back to original for unknown', () => {
    expect(normalizePositionOrFallback('unknown-position')).toBe('unknown-position');
    expect(normalizePositionOrFallback('  Unknown-Position  ')).toBe('Unknown-Position');
  });

  test('custom alias map works', () => {
    const custom = { x: 'extra' } as typeof defaultPositionAliases & Record<string, string>;
    expect(normalizePosition('x', custom)).toBe('extra');
  });

  // ── Programmatic coverage of every key-value pair in defaultPositionAliases ──

  describe('every alias in defaultPositionAliases resolves to its canonical value', () => {
    const entries = Object.entries(defaultPositionAliases) as [string, string][];

    it('has entries to test (guard against an empty map)', () => {
      expect(entries.length).toBeGreaterThan(0);
    });

    test.each(entries)(
      'normalizePosition("%s") === "%s"',
      (alias, canonical) => {
        // Test with the key exactly as stored (already lowercase)
        expect(normalizePosition(alias)).toBe(canonical);
      },
    );

    test.each(entries)(
      'normalizePosition("%s" uppercased) still resolves to "%s" (case-insensitive)',
      (alias, canonical) => {
        expect(normalizePosition(alias.toUpperCase())).toBe(canonical);
      },
    );

    test.each(entries)(
      'normalizePosition("%s" with surrounding whitespace) still resolves to "%s"',
      (alias, canonical) => {
        expect(normalizePosition(`  ${alias}  `)).toBe(canonical);
      },
    );
  });

  // ── Case-insensitivity spot-checks ──

  describe('case-insensitive matching', () => {
    it('lowercased alias resolves correctly', () => {
      // ST is not in the map; test a real alias in mixed case
      expect(normalizePosition('FW')).toBe('forward');
      expect(normalizePosition('Fw')).toBe('forward');
      expect(normalizePosition('fW')).toBe('forward');
    });

    it('midfielder aliases are case-insensitive', () => {
      expect(normalizePosition('MF')).toBe('midfielder');
      expect(normalizePosition('MID')).toBe('midfielder');
      expect(normalizePosition('Midfield')).toBe('midfielder');
      expect(normalizePosition('MIDFIELDER')).toBe('midfielder');
    });

    it('defender aliases are case-insensitive', () => {
      expect(normalizePosition('DF')).toBe('defender');
      expect(normalizePosition('DEF')).toBe('defender');
      expect(normalizePosition('Defender')).toBe('defender');
    });

    it('goalkeeper aliases are case-insensitive', () => {
      expect(normalizePosition('GK')).toBe('goalkeeper');
      expect(normalizePosition('Goalkeeper')).toBe('goalkeeper');
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('unknown alias: normalizePosition returns undefined', () => {
      expect(normalizePosition('winger')).toBeUndefined();
      expect(normalizePosition('ST')).toBeUndefined();
      expect(normalizePosition('cb')).toBeUndefined();
      expect(normalizePosition('lb')).toBeUndefined();
    });

    it('unknown alias: normalizePositionOrFallback returns the trimmed input unchanged', () => {
      expect(normalizePositionOrFallback('winger')).toBe('winger');
      expect(normalizePositionOrFallback('  winger  ')).toBe('winger');
    });

    it('empty string: normalizePosition returns undefined (falsy guard in implementation)', () => {
      expect(normalizePosition('')).toBeUndefined();
    });

    it('empty string: normalizePositionOrFallback returns an empty string', () => {
      // normalizePosition('') returns undefined → fallback is input.trim() = ''
      expect(normalizePositionOrFallback('')).toBe('');
    });

    it('whitespace-only string: normalizePosition returns undefined', () => {
      expect(normalizePosition('   ')).toBeUndefined();
    });

    it('whitespace-only string: normalizePositionOrFallback returns empty string after trim', () => {
      expect(normalizePositionOrFallback('   ')).toBe('');
    });
  });
});
