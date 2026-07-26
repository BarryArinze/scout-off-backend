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

  // ── Resource ──────────────────────────────────────────────────────────────
  PLAYER_NOT_FOUND:      'PLAYER_NOT_FOUND',
  SUBSCRIPTION_REQUIRED: 'SUBSCRIPTION_REQUIRED',
  CONFLICT:              'CONFLICT',
  WALLET_MISMATCH:       'WALLET_MISMATCH',
  FEATURE_DISABLED:      'FEATURE_DISABLED',

  // ── Multi-sig administration ───────────────────────────────────────────────
  EXPIRED_ACTION:        'EXPIRED_ACTION',
  ACTION_EXECUTED:       'ACTION_EXECUTED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
