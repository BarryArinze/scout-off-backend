import { getFeatureFlag, upsertFeatureFlag } from '../db';

/** Named feature flags. Add new constants here as features are gated. */
export const FeatureFlags = {
  SAVED_SEARCHES: 'saved_searches',
} as const;

export type FeatureFlagName = (typeof FeatureFlags)[keyof typeof FeatureFlags];

export interface FeatureFlagContext {
  /** Authenticated account (e.g. scout wallet). Reserved for future rollout rules. */
  account?: string;
}

const cache = new Map<string, boolean>();

/** Clear the in-memory cache (used in tests). */
export function clearFeatureFlagCache(): void {
  cache.clear();
}

/**
 * Returns whether a named feature flag is enabled.
 * Reads from an in-process cache that is refreshed on admin updates.
 */
export async function isFeatureEnabled(
  flagName: string,
  _context?: FeatureFlagContext,
): Promise<boolean> {
  if (cache.has(flagName)) {
    return cache.get(flagName)!;
  }

  const row = await getFeatureFlag(flagName);
  const enabled = row?.enabled === 1;
  cache.set(flagName, enabled);
  return enabled;
}

/** Update a flag at runtime and refresh the in-process cache immediately. */
export async function setFeatureFlag(
  flagName: string,
  enabled: boolean,
  updatedBy: string,
): Promise<void> {
  await upsertFeatureFlag({
    name: flagName,
    enabled: enabled ? 1 : 0,
    updated_at: Date.now(),
    updated_by: updatedBy,
  });
  cache.set(flagName, enabled);
}
