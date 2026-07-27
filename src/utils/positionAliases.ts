/**
 * Position alias mapping (placeholder):
 *
 * Mapping examples:
 * - fw, fwd, striker -> forward
 * - mf, mid, midfield -> midfielder
 * - df, def -> defender
 * - gk -> goalkeeper
 *
 * This file provides a small default mapping and helper functions to normalize
 * alternate/abbreviated position terms to canonical position names. The mapping
 * can be replaced or extended via the `aliases` parameter when needed.
 */

export type PositionAliasMap = Record<string, string>;

export const defaultPositionAliases: PositionAliasMap = {
  // Forwards
  fw: 'forward',
  fwd: 'forward',
  st: 'forward',
  cf: 'forward',
  striker: 'forward',
  forward: 'forward',

  // Midfielders
  mf: 'midfielder',
  mid: 'midfielder',
  midfield: 'midfielder',
  midfielder: 'midfielder',
  cm: 'midfielder',
  dm: 'midfielder',
  am: 'midfielder',
  cdm: 'midfielder',
  cam: 'midfielder',
  lm: 'midfielder',
  rm: 'midfielder',

  // Defenders
  df: 'defender',
  def: 'defender',
  defender: 'defender',
  cb: 'defender',
  lb: 'defender',
  rb: 'defender',
  lwb: 'defender',
  rwb: 'defender',
  sw: 'defender',

  // Goalkeepers
  gk: 'goalkeeper',
  goalkeeper: 'goalkeeper',
};

/**
 * Normalize an input position term to a canonical position name.
 *
 * Returns the canonical position (e.g. "forward") if the input matches a
 * known alias; otherwise returns undefined so callers can fall back to other
 * behavior.
 */
export function normalizePosition(
  input: string,
  aliases: PositionAliasMap = defaultPositionAliases
): string | undefined {
  if (!input) return undefined;
  const key = input.trim().toLowerCase();
  return aliases[key];
}

/**
 * Normalize or fallback: returns the normalized position when available,
 * otherwise returns the trimmed original input. Useful for cases where stable
 * API behavior is desired for unknown synonyms.
 */
export function normalizePositionOrFallback(
  input: string,
  aliases: PositionAliasMap = defaultPositionAliases
): string {
  const normalized = normalizePosition(input, aliases);
  return normalized ?? input.trim();
}
