/**
 * Machine-readable snake_case error codes for all API error responses.
 *
 * Usage:
 *   import { ErrorCode } from '../utils/errorCodes';
 *   res.status(400).json({ success: false, error: '...', code: ErrorCode.VALIDATION_ERROR });
 *
 * Existing PaymentError / FeeWithdrawalError codes are included so controllers
 * can reference them from one place.
 */
export const ErrorCode = {
  // ── Generic ───────────────────────────────────────────────────────────────
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  NOT_FOUND:             'NOT_FOUND',
  VALIDATION_ERROR:      'VALIDATION_ERROR',
  MALFORMED_JSON:        'MALFORMED_JSON',
  PAYLOAD_TOO_LARGE:     'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',

  // ── Auth ──────────────────────────────────────────────────────────────────
  UNAUTHORIZED:          'UNAUTHORIZED',
  FORBIDDEN:             'FORBIDDEN',
  TOKEN_INVALID:         'TOKEN_INVALID',
  TOKEN_EXPIRED:         'TOKEN_EXPIRED',

  // ── Payment (preserve existing PaymentError codes) ────────────────────────
  INSUFFICIENT_FUNDS:    'INSUFFICIENT_FUNDS',
  INVALID_ACCOUNT:       'INVALID_ACCOUNT',
  NETWORK_ERROR:         'NETWORK_ERROR',
  PAYMENT_UNKNOWN:       'UNKNOWN',

  // ── Fee withdrawal (preserve existing FeeWithdrawalError codes) ───────────
  NO_FEES:               'NO_FEES',
  INVALID_RECIPIENT:     'INVALID_RECIPIENT',
  CONTRACT_PAUSED:       'CONTRACT_PAUSED',

  // ── Subscription ──────────────────────────────────────────────────────────
  /**
   * Maps to Soroban contract error code 8 (NotSubscribed).
   * Returned by cancel_subscription when the scout has no active subscription,
   * and by any access-guard that requires a live subscription.
   */
  NOT_SUBSCRIBED:        'NOT_SUBSCRIBED',

  // ── Resource ──────────────────────────────────────────────────────────────
  PLAYER_NOT_FOUND:      'PLAYER_NOT_FOUND',
  SUBSCRIPTION_REQUIRED: 'SUBSCRIPTION_REQUIRED',
  CONFLICT:              'CONFLICT',
  WALLET_MISMATCH:       'WALLET_MISMATCH',
  FEATURE_DISABLED:      'FEATURE_DISABLED',

  // ── Conditional requests / optimistic concurrency ─────────────────────────
  /**
   * HTTP 412 — an If-Match header was supplied but does not match the
   * current version of the resource (e.g. PUT /api/players/:playerId after
   * the profile was updated elsewhere).
   */
  PRECONDITION_FAILED:   'PRECONDITION_FAILED',
  /**
   * HTTP 428 — the request requires a conditional header (If-Match) that
   * was not supplied, e.g. PUT /api/players/:playerId without one.
   */
  PRECONDITION_REQUIRED: 'PRECONDITION_REQUIRED',

  // ── Multi-sig administration ───────────────────────────────────────────────
  EXPIRED_ACTION:        'EXPIRED_ACTION',
  ACTION_EXECUTED:       'ACTION_EXECUTED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Mapping from Soroban contract numeric error codes (as defined in
 * contracts/shared/src/errors.rs) to machine-readable backend error codes.
 *
 * Used by the XDR error parser and any code that pattern-matches on '#N'
 * substrings in simulation/result error strings.
 *
 * | Code | Contract variant  | Backend code         |
 * |------|-------------------|----------------------|
 * |  1   | AlreadyInitialized| CONFLICT             |
 * |  2   | NotInitialized    | INTERNAL_SERVER_ERROR|
 * |  3   | PlayerNotFound    | PLAYER_NOT_FOUND     |
 * |  4   | NotFound          | NOT_FOUND            |
 * |  5   | InvalidInput      | VALIDATION_ERROR     |
 * |  6   | AlreadyVerified   | CONFLICT             |
 * |  7   | InsufficientFee   | INSUFFICIENT_FUNDS   |
 * |  8   | NotSubscribed     | NOT_SUBSCRIBED       |
 * |  9   | Unauthorized      | UNAUTHORIZED         |
 * | 10   | ContractPaused    | CONTRACT_PAUSED      |
 * | 11   | Overflow          | INTERNAL_SERVER_ERROR|
 */
export const SOROBAN_ERROR_CODE_MAP: Record<number, ErrorCode> = {
  1:  ErrorCode.CONFLICT,
  2:  ErrorCode.INTERNAL_SERVER_ERROR,
  3:  ErrorCode.PLAYER_NOT_FOUND,
  4:  ErrorCode.NOT_FOUND,
  5:  ErrorCode.VALIDATION_ERROR,
  6:  ErrorCode.CONFLICT,
  7:  ErrorCode.INSUFFICIENT_FUNDS,
  8:  ErrorCode.NOT_SUBSCRIBED,
  9:  ErrorCode.UNAUTHORIZED,
  10: ErrorCode.CONTRACT_PAUSED,
  11: ErrorCode.INTERNAL_SERVER_ERROR,
} as const;
