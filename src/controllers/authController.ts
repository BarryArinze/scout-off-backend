import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Keypair } from '@stellar/stellar-sdk';
import { buildChallenge, verifyAndIssueToken, extractAccount } from '../services/sep10';
import { logger } from '../utils/logger';
import { extractClientIp } from '../utils/ipExtractor';
import config from '../config';
import { ErrorCode } from '../utils/errorCodes';

const TOKEN_TTL_SECONDS = 86400;

const challengeSchema = z.object({
  account: z.string().refine(
    (val) => { try { Keypair.fromPublicKey(val); return true; } catch { return false; } },
    { message: 'Invalid Stellar public key' }
  ),
});

const tokenSchema = z.object({
  transaction: z.string().min(1),
  role: z.enum(['player', 'scout', 'validator', 'admin']).optional(),
});

/** GET /auth/challenge?account=G... */
export function getChallenge(req: Request, res: Response, next: NextFunction): void {
  try {
    const parsed = challengeSchema.safeParse(req.query);
    if (!parsed.success) {
      logger.warn('[auth] failed_challenge_request', {
        correlationId: req.correlationId,
        origin: extractClientIp(req),
        attemptedAccount: (req.query.account as string) ?? null,
        reason: parsed.error.errors[0]?.message,
      });
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request', code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const challenge = buildChallenge(parsed.data.account);
    res.json({ challenge, networkPassphrase: config.networkPassphrase });
  } catch (err) {
    next(err);
  }
}

/** POST /auth/token  { transaction: "<signed XDR>", role?: "validator" } */
export function postToken(req: Request, res: Response, next: NextFunction): void {
  try {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn('[auth] failed_token_request invalid_body', {
        correlationId: req.correlationId,
        origin: extractClientIp(req),
        reason: parsed.error.errors[0]?.message,
      });
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request', code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const { transaction, role } = parsed.data;

    // Design note: admin-role seeding is intentionally performed AFTER
    // cryptographic signature verification, not before it.
    //
    // Previously the code called extractAccount() on the raw (unverified) XDR
    // to determine whether to grant admin role, then passed that role into
    // verifyAndIssueToken().  While verifyAndIssueToken() would still reject
    // an improperly-signed transaction, the "peek then verify" ordering was a
    // design smell: role determination was derived from attacker-controlled
    // input before the payload's authenticity was established.
    //
    // The restructured flow:
    //   1. verifyAndIssueToken() — cryptographically verifies the challenge
    //      signatures and extracts the authenticated account identity.
    //   2. Only the verified `account` value is used to check admin membership.
    //   3. If the account is an admin wallet, a second token is issued with the
    //      admin role.  Otherwise the caller-supplied role (or 'player' default)
    //      is used, exactly as before.
    //
    // This ensures no admin-role token can ever be derived from an unverified
    // account identity.

    // Step 1: verify signatures and get the authenticated account.
    // verifyAndIssueToken() throws on any signature, TTL, or structure failure.
    const { token: baseToken, account } = verifyAndIssueToken(transaction, role);

    // Step 2: determine the effective role from the cryptographically verified account.
    const isAdmin =
      (config.adminWallet && account === config.adminWallet) ||
      (account !== null && config.adminWallets.includes(account));

    if (!isAdmin) {
      // Not an admin — the token issued by verifyAndIssueToken() with the
      // caller-supplied role is the final answer.
      const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
      res.json({ token: baseToken, account, expiresAt });
      return;
    }

    // Step 3: admin wallet confirmed post-verification — re-issue with admin role.
    const { token, account: verifiedAccount } = verifyAndIssueToken(transaction, 'admin');
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    res.json({ token, account: verifiedAccount, expiresAt });
  } catch (err) {
    if (err instanceof Error) {
      const knownAuthErrors = [
        'Invalid challenge signature',
        'Missing source account in challenge',
        'Challenge has expired',
      ];
      if (knownAuthErrors.includes(err.message)) {
        let attemptedWallet: string | null = null;
        try { attemptedWallet = extractAccount((req.body as { transaction?: string }).transaction ?? ''); } catch { /* not extractable */ }
        logger.warn('[auth] failed_token_exchange', {
          correlationId: req.correlationId,
          origin: extractClientIp(req),
          attemptedWallet,
          reason: err.message,
        });
        res.status(401).json({ success: false, error: err.message });
        return;
      }
      // XDR parse failures and other transaction-format errors are bad input → 400
      logger.warn('[auth] failed_token_request malformed_xdr', {
        correlationId: req.correlationId,
        origin: extractClientIp(req),
        reason: err.message,
      });
      res.status(400).json({ success: false, error: err.message, code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    next(err);
  }
}
