import { getTierMeta } from '../../src/utils/tier';
import { ProgressLevel } from '../../src/types';

describe('getTierMeta', () => {
  const levels: ProgressLevel[] = [0, 1, 2, 3];

  it.each(levels)('returns tierName and tierDescription for level %i', (level) => {
    const meta = getTierMeta(level);
    expect(typeof meta.tierName).toBe('string');
    expect(meta.tierName.length).toBeGreaterThan(0);
    expect(typeof meta.tierDescription).toBe('string');
    expect(meta.tierDescription.length).toBeGreaterThan(0);
  });

  it('uses canonical tier names matching docs/tier-promotion.md', () => {
    expect(getTierMeta(0).tierName).toBe('Unverified');
    expect(getTierMeta(1).tierName).toBe('Emerging');
    expect(getTierMeta(2).tierName).toBe('Established');
    expect(getTierMeta(3).tierName).toBe('Elite');
  });

  it('returns fallback for unknown level', () => {
    const meta = getTierMeta(99);
    expect(meta.tierName).toBe('Unknown');
  });
});
