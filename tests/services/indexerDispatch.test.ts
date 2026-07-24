import { indexEvents } from '../../src/services/indexer';
import { dispatchEventWebhook } from '../../src/services/webhooks';

jest.mock('../../src/services/stellar', () => ({
  server: {
    queryEvents: jest.fn(),
  },
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { server } = require('../../src/services/stellar') as { server: { queryEvents: jest.Mock } };
const mockedDispatch = dispatchEventWebhook as jest.MockedFunction<typeof dispatchEventWebhook>;

function makeEvent(type: string, payload: Record<string, unknown>, txHash: string, ledger = 100) {
  return {
    topic: [{ value: () => type }],
    value: { value: () => payload },
    ledger,
    txHash,
  };
}

describe('indexEvents — milestone_approved webhook dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('dispatches a webhook when a milestone_approved event is indexed', async () => {
    const payload = { player_id: 'P1', milestone_type: 'identity' };
    server.queryEvents.mockResolvedValue({
      events: [makeEvent('milestone_approved', payload, 'hash-001')],
    });

    await indexEvents();

    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(mockedDispatch).toHaveBeenCalledWith('milestone_approved', payload);
  });

  it('dispatches a webhook for each milestone_approved event in a batch', async () => {
    server.queryEvents.mockResolvedValue({
      events: [
        makeEvent('milestone_approved', { player_id: 'P1' }, 'hash-002', 100),
        makeEvent('player_registered', { player_id: 'P2', wallet: 'GWALLETP2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'hash-003', 101),
        makeEvent('milestone_approved', { player_id: 'P3' }, 'hash-004', 102),
      ],
    });

    await indexEvents();

    expect(mockedDispatch).toHaveBeenCalledTimes(2);
    expect(mockedDispatch).toHaveBeenCalledWith('milestone_approved', { player_id: 'P1' });
    expect(mockedDispatch).toHaveBeenCalledWith('milestone_approved', { player_id: 'P3' });
  });

  it('does not dispatch a webhook for non-milestone_approved events', async () => {
    server.queryEvents.mockResolvedValue({
      events: [makeEvent('player_registered', { player_id: 'P1', wallet: 'GWALLETP1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'hash-005')],
    });

    await indexEvents();

    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch any webhooks when the event stream is empty', async () => {
    server.queryEvents.mockResolvedValue({ events: [] });

    await indexEvents();

    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it('logs a warning and continues when the webhook dispatch fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const warnSpy = jest.spyOn(require('../../src/utils/logger').logger, 'warn').mockImplementation(() => {});
    mockedDispatch.mockRejectedValueOnce(new Error('endpoint unreachable'));

    server.queryEvents.mockResolvedValue({
      events: [makeEvent('milestone_approved', { player_id: 'P1' }, 'hash-006')],
    });

    await expect(indexEvents()).resolves.toBeUndefined();
    await new Promise(setImmediate);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('endpoint unreachable'));
    warnSpy.mockRestore();
  });
});
