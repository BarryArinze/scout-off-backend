import { Keypair } from '@stellar/stellar-sdk';
import { isValidStellarAddress } from '../../src/utils/stellarAddress';

describe('isValidStellarAddress', () => {
  it('accepts a valid G-address', () => {
    const validAddress = Keypair.random().publicKey();
    expect(isValidStellarAddress(validAddress)).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidStellarAddress('')).toBe(false);
  });

  it('rejects a random non-address string', () => {
    expect(isValidStellarAddress('not-a-stellar-address')).toBe(false);
  });

  it('rejects an S-address (secret key)', () => {
    const secretKey = Keypair.random().secret();
    expect(isValidStellarAddress(secretKey)).toBe(false);
  });

  it('rejects null-like values', () => {
    expect(isValidStellarAddress(null as unknown as string)).toBe(false);
    expect(isValidStellarAddress(undefined as unknown as string)).toBe(false);
  });

  it('rejects a string that is too short', () => {
    expect(isValidStellarAddress('GABC')).toBe(false);
  });

  it('rejects a string with wrong starting character', () => {
    expect(isValidStellarAddress('XAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN')).toBe(false);
  });
});
