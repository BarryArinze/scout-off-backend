import {
  runDeadLetterRetryJob,
  startDeadLetterRetryJob,
  stopDeadLetterRetryJob,
  isDeadLetterJobRunning,
  MAX_AUTO_RETRIES,
  DEAD_LETTER_JOB_INTERVAL_MS,
} from '../../src/services/webhookDeadLetterJob';
import * as db from '../../src/db';
import * as webhooks from '../../src/services/webhooks';
import * as metrics from '../../src/middleware/metrics';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  countWebhookDeadLetters: jest.fn(),
  listWebhookDeadLetters: jest.fn(),
  listWebhookSubscriptions: jest.fn(),
  getWebhookDeadLetterById: jest.fn(),
  markWebhookDeadLetterReplayed: jest.fn(),
  updateWebhookDeadLetterAttempt: jest.fn(),
}));

jest.mock('../../src/services/webhooks', () => ({
  postWebhookWithRetry: jest.fn(),
}));

jest.mock('../../src/middleware/metrics', () => ({
  incrementWebhookRetrySuccessTotal: jest.fn(),
  incrementWebhookDeadLettersTotal: jest.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OLD_DATE = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15 min ago
const NEW_DATE = new Date(Date.now() - 2 * 60 * 1000).toISOString();  // 2 min ago (too new)

function makeLetter(overrides: Partial<db.WebhookDeadLetter> = {}): db.WebhookDeadLetter {
  return {
    id: 1,
    subscription_id: 1,
    url: 'https://example.com/webhook',
    event_type: 'player_registered',
    payload: JSON.stringify({ foo: 'bar' }),
    failure_reason: 'connect ECONNREFUSED',
    attempts: 1,
    status: 'pending',
    created_at: OLD_DATE,
    replayed_at: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('webhookDeadLetterJob — runDeadLetterRetryJob', () => {
  const mockCountDeadLetters = db.countWebhookDeadLetters as jest.Mock;
  const mockListDeadLetters = db.listWebhookDeadLetters as jest.Mock;
  const mockListSubscriptions = db.listWebhookSubscriptions as jest.Mock;
  const mockGetById = db.getWebhookDeadLetterById as jest.Mock;
  const mockMarkReplayed = db.markWebhookDeadLetterReplayed as jest.Mock;
  const mockUpdateAttempt = db.updateWebhookDeadLetterAttempt as jest.Mock;
  const mockPost = webhooks.postWebhookWithRetry as jest.Mock;
  const mockIncrSuccess = metrics.incrementWebhookRetrySuccessTotal as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCountDeadLetters.mockReturnValue(0);
    mockListSubscriptions.mockReturnValue([{ id: 1, url: 'https://example.com/webhook', secret: 'secret' }]);
  });

  it('returns 0 when there are no eligible rows', async () => {
    mockListDeadLetters.mockReturnValue([]);
    const result = await runDeadLetterRetryJob();
    expect(result).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('skips rows that are too new (< 10 min old)', async () => {
    mockListDeadLetters.mockReturnValue([makeLetter({ created_at: NEW_DATE })]);
    const result = await runDeadLetterRetryJob();
    expect(result).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('skips rows that already have MAX_AUTO_RETRIES attempts', async () => {
    mockListDeadLetters.mockReturnValue([makeLetter({ attempts: MAX_AUTO_RETRIES })]);
    const result = await runDeadLetterRetryJob();
    expect(result).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('skips rows that are already replayed', async () => {
    mockListDeadLetters.mockReturnValue([makeLetter({ status: 'replayed' })]);
    const result = await runDeadLetterRetryJob();
    expect(result).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('successfully retries an eligible dead letter', async () => {
    const letter = makeLetter();
    mockListDeadLetters.mockReturnValue([letter]);
    mockGetById.mockReturnValue(letter);
    mockPost.mockResolvedValue(undefined);

    const result = await runDeadLetterRetryJob();

    expect(result).toBe(1);
    expect(mockPost).toHaveBeenCalledWith(
      letter.url,
      { foo: 'bar' },
      expect.objectContaining({ secret: 'secret' }),
    );
    expect(mockMarkReplayed).toHaveBeenCalledWith(letter.id);
    expect(mockIncrSuccess).toHaveBeenCalledTimes(1);
  });

  it('increments retry_count on delivery failure', async () => {
    const letter = makeLetter({ attempts: 2 });
    mockListDeadLetters.mockReturnValue([letter]);
    mockGetById.mockReturnValue(letter);
    mockPost.mockRejectedValue(new Error('timeout'));

    const result = await runDeadLetterRetryJob();

    expect(result).toBe(0);
    expect(mockMarkReplayed).not.toHaveBeenCalled();
    expect(mockUpdateAttempt).toHaveBeenCalledWith(letter.id, 3, 'timeout');
    expect(mockIncrSuccess).not.toHaveBeenCalled();
  });

  it('does not retry a row if it was concurrently replayed (getById returns replayed)', async () => {
    const letter = makeLetter();
    mockListDeadLetters.mockReturnValue([letter]);
    mockGetById.mockReturnValue({ ...letter, status: 'replayed' });

    const result = await runDeadLetterRetryJob();
    expect(result).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('emits overflow log when queue depth exceeds 100', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockCountDeadLetters.mockReturnValue(150);
    mockListDeadLetters.mockReturnValue([]);

    await runDeadLetterRetryJob();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[error]'),
      expect.stringContaining('webhook_dead_letter_overflow'),
    );
    consoleSpy.mockRestore();
  });
});

describe('webhookDeadLetterJob — scheduler', () => {
  afterEach(() => stopDeadLetterRetryJob());

  it('starts and stops correctly', () => {
    expect(isDeadLetterJobRunning()).toBe(false);
    startDeadLetterRetryJob();
    expect(isDeadLetterJobRunning()).toBe(true);
    stopDeadLetterRetryJob();
    expect(isDeadLetterJobRunning()).toBe(false);
  });

  it('is idempotent — calling start twice does not create two intervals', () => {
    startDeadLetterRetryJob();
    startDeadLetterRetryJob();
    expect(isDeadLetterJobRunning()).toBe(true);
    // If two intervals were created, stopping once should still leave one running.
    stopDeadLetterRetryJob();
    expect(isDeadLetterJobRunning()).toBe(false);
  });

  it('uses a 5-minute interval', () => {
    expect(DEAD_LETTER_JOB_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});
