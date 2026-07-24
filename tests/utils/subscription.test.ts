import { getActiveSubscription } from '../../src/utils/subscription';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  isSubscribed: jest.fn(),
}));

import { queryEvents } from '../../src/db';
import { isSubscribed } from '../../src/services/stellar';

const mockGetEvents = queryEvents as jest.Mock;
const mockIsSubscribed = isSubscribed as jest.Mock;

const WALLET = 'GSCOUTWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

beforeEach(() => {
  mockGetEvents.mockReset().mockReturnValue([]);
  mockIsSubscribed.mockReset().mockResolvedValue({ active: false, expiresAt: null });
});

// ─── On-chain (step 1) ────────────────────────────────────────────────────────

describe('getActiveSubscription — on-chain path', () => {
  it('returns active=true when on-chain reports active', async () => {
    mockIsSubscribed.mockResolvedValue({ active: true, expiresAt: '9999999999' });
    const result = await getActiveSubscription(WALLET);
    expect(result.active).toBe(true);
    expect(result.tier).toBe('basic');
  });

  it('coerces expiresAt to a number when on-chain returns it as a string', async () => {
    mockIsSubscribed.mockResolvedValue({ active: true, expiresAt: '1234567890' });
    const result = await getActiveSubscription(WALLET);
    expect(result.expiresAt).toBe(1234567890);
    expect(typeof result.expiresAt).toBe('number');
  });

  it('skips indexed events lookup when on-chain returns active', async () => {
    mockIsSubscribed.mockResolvedValue({ active: true, expiresAt: null });
    await getActiveSubscription(WALLET);
    expect(mockGetEvents).not.toHaveBeenCalled();
  });
});

// ─── Indexed events fallback (step 2) ────────────────────────────────────────

describe('getActiveSubscription — indexed events fallback', () => {
  it('returns active=false with nulls when no events exist', async () => {
    mockGetEvents.mockReturnValue([]);
    const result = await getActiveSubscription(WALLET);
    expect(result).toEqual({ active: false, tier: null, expiresAt: null });
  });

  it('returns active=true for a non-expired subscription event', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86400 * 10;
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: expiresAt, tier: 'premium' },
      },
    ]);
    const result = await getActiveSubscription(WALLET);
    expect(result.active).toBe(true);
    expect(result.tier).toBe('premium');
    expect(result.expiresAt).toBe(expiresAt);
  });

  it('returns active=false for an expired subscription event', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 86400;
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: expiresAt },
      },
    ]);
    const result = await getActiveSubscription(WALLET);
    expect(result.active).toBe(false);
    expect(result.tier).toBeNull();
    expect(result.expiresAt).toBe(expiresAt);
  });

  it('defaults tier to "basic" when tier is absent from event payload', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: expiresAt },
      },
    ]);
    const result = await getActiveSubscription(WALLET);
    expect(result.tier).toBe('basic');
  });

  it('uses the most recent event when multiple subscription events exist', async () => {
    const olderExpiry = Math.floor(Date.now() / 1000) - 86400; // expired
    const newerExpiry = Math.floor(Date.now() / 1000) + 86400; // active
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: olderExpiry, tier: 'basic' },
      },
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: newerExpiry, tier: 'premium' },
      },
    ]);
    const result = await getActiveSubscription(WALLET);
    expect(result.active).toBe(true);
    expect(result.tier).toBe('premium');
    expect(result.expiresAt).toBe(newerExpiry);
  });

  it('filters events to the provided wallet only', async () => {
    const otherWallet = 'GOTHERWALLET2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: otherWallet, subscription_expiry: expiresAt, tier: 'premium' },
      },
    ]);
    const result = await getActiveSubscription(WALLET);
    expect(result.active).toBe(false);
    expect(result.tier).toBeNull();
  });
});
