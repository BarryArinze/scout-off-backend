jest.mock('../../src/services/ipfs', () => ({
  gatewayUrl: (cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`,
  gatewayUrls: (cid: string) => [`https://gateway.pinata.cloud/ipfs/${cid}`],
}));

import { serializeIpfsResult, IpfsSerializedResult } from '../../src/utils/ipfsSerializer';

const TEST_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

describe('serializeIpfsResult', () => {
  it('returns stable shape with cid, uri, metadata, and storageProvider', () => {
    const result = serializeIpfsResult(TEST_CID);
    expect(result).toMatchObject<IpfsSerializedResult>({
      cid: TEST_CID,
      uri: `https://gateway.pinata.cloud/ipfs/${TEST_CID}`,
      metadata: {},
      storageProvider: 'pinata',
    });
  });

  it('includes custom metadata when provided', () => {
    const meta = { wallet: 'GSCOUT1', position: 'forward' };
    const result = serializeIpfsResult(TEST_CID, meta);
    expect(result.metadata).toEqual(meta);
  });

  it('uses a custom storageProvider when specified', () => {
    const result = serializeIpfsResult(TEST_CID, {}, 'arweave');
    expect(result.storageProvider).toBe('arweave');
  });

  it('uri is built from the provided cid', () => {
    const result = serializeIpfsResult(TEST_CID);
    expect(result.uri).toContain(TEST_CID);
  });
});
