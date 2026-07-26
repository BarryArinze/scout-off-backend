/**
 * URI validation for metadata_uri and evidence_uri fields.
 *
 * Accepted formats:
 *   - CIDv0  — base58btc, starts with "Qm", exactly 46 characters
 *   - CIDv1  — base32, starts with "bafy" or "bafk" (the two most common
 *               content-addressed prefixes produced by kubo / go-ipfs)
 *   - HTTPS URL — must have a valid hostname; bare IPs without a domain,
 *                 path traversal (..), and non-HTTPS schemes are rejected
 *
 * Explicitly rejected:
 *   - ipfs:// scheme URIs  (callers must strip the scheme and pass the bare CID)
 *   - http:// URLs
 *   - Empty strings, null, undefined
 *   - Any string that does not match the formats above
 *
 * This is a format-only check — no network requests are made.
 */

/** Returns true when `uri` is a non-empty string with an ipfs:// or https:// scheme and meaningful content after it. */
export function isValidEvidenceUri(uri: string): boolean {
  if (!uri || typeof uri !== 'string') return false;

// HTTPS URL — requires a proper hostname (no raw IPs, no localhost).
// Rejects path traversal ("..") anywhere in the URL string.
const HTTPS_HOSTNAME_RE = /^https:\/\/[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?)+/;

/** Standard error message returned by Zod refinements and HTTP 400 responses. */
export const URI_VALIDATION_ERROR =
  "metadata_uri must be a valid IPFS CID (v0 or v1) or an HTTPS URL";

/**
 * Returns true if `uri` is a valid bare CIDv0 or CIDv1 string.
 * Does not accept ipfs:// prefixed strings.
 */
export function isValidCidUri(uri: string): boolean {
  return CID_V0_RE.test(uri) || CID_V1_RE.test(uri);
}

/**
 * Returns true if `uri` is a well-formed HTTPS URL with a proper hostname
 * and no path traversal sequences.
 */
export function isValidHttpsUrl(uri: string): boolean {
  if (!uri.startsWith('https://')) return false;
  if (uri.includes('..')) return false;
  if (!HTTPS_HOSTNAME_RE.test(uri)) return false;
  // Delegate to the platform URL parser for final structural validation.
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Primary validator used in Zod schemas.
 *
 * Returns true when the value is:
 *   - A valid bare CIDv0 or CIDv1, OR
 *   - A valid HTTPS URL
 *
 * Returns false for ipfs:// URIs, http:// URLs, empty strings, and anything else.
 */
export function isValidMetadataUri(uri: string): boolean {
  if (!uri || typeof uri !== 'string') return false;
  // Explicitly reject ipfs:// scheme — callers must pass the bare CID.
  if (uri.startsWith('ipfs://')) return false;
  return isValidCidUri(uri) || isValidHttpsUrl(uri);
}

/**
 * @deprecated  The old evidence-URI validator accepted ipfs:// scheme strings.
 * Existing callers are being migrated to isValidMetadataUri.
 * Kept temporarily so the re-export in validatorController.ts keeps compiling.
 */
export function isValidEvidenceUri(uri: string): boolean {
  return isValidMetadataUri(uri);
}
