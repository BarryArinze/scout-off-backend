/**
 * Evidence URI validation helper.
 * Accepts: ipfs://, https://
 * Rejects: http://, plain strings, empty/non-string values, and bare
 * scheme prefixes with no meaningful content after them (e.g. "https://").
 */
const SCHEMES = ['ipfs://', 'https://'];
const MIN_CONTENT_LENGTH = 3;

export function isValidEvidenceUri(uri: string): boolean {
  if (!uri || typeof uri !== 'string') return false;

  const scheme = SCHEMES.find((s) => uri.startsWith(s));
  if (!scheme) return false;

  const content = uri.slice(scheme.length).trim();
  if (content.length < MIN_CONTENT_LENGTH) return false;

  return true;
}
