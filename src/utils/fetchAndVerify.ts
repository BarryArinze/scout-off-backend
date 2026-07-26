import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';

export class CidMismatchError extends Error {
  expected: string;
  computed: string;

  constructor(expected: string, computed: string) {
    super(`CID mismatch: expected ${expected}, got ${computed}`);
    this.name = 'CidMismatchError';
    this.expected = expected;
    this.computed = computed;
  }
}

export async function fetchAndVerify(cid: string, gatewayUrl: string): Promise<any> {
    // just dummy for now
}
