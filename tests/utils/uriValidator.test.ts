import { isValidEvidenceUri } from '../../src/utils/uriValidator';

describe('isValidEvidenceUri', () => {
  it('accepts ipfs:// URIs', () => {
    expect(isValidEvidenceUri('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(true);
  });

  it('accepts https:// URLs', () => {
    expect(isValidEvidenceUri('https://example.com/evidence.json')).toBe(true);
  });

  it('rejects http:// URIs', () => {
    expect(isValidEvidenceUri('http://example.com/evidence')).toBe(false);
  });

  it('rejects plain strings', () => {
    expect(isValidEvidenceUri('not-a-uri')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isValidEvidenceUri('')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isValidEvidenceUri(undefined as unknown as string)).toBe(false);
    expect(isValidEvidenceUri(null as unknown as string)).toBe(false);
  });

  it('rejects bare scheme prefixes with no content', () => {
    expect(isValidEvidenceUri('https://')).toBe(false);
    expect(isValidEvidenceUri('ipfs://')).toBe(false);
  });

  it('rejects scheme prefixes with only whitespace content', () => {
    expect(isValidEvidenceUri('https://   ')).toBe(false);
  });
});
