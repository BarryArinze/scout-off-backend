import { Request, Response, NextFunction } from 'express';
import { sendForbidden, sendUnauthorized } from '../utils/authError';

/**
 * Typed helper: returns true when the authenticated account matches the target id.
 */
export function isOwner(account: string | undefined, targetId: string): boolean {
  return !!account && account === targetId;
}

/**
 * Middleware that ensures the authenticated user (JWT sub) matches req.params.playerId.
 * Must be used after requireAuth so that req.account is already set.
 * Returns 403 if the caller is not the profile owner.
 */
export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  const account = req.account;
  const { playerId } = req.params;
  if (!isOwner(account, playerId)) {
    sendForbidden(res, 'Forbidden: not the profile owner');
    return;
  }
  next();
}

/**
 * Middleware that ensures the authenticated user (JWT sub) matches req.params.wallet.
 * Admins bypass the ownership check.
 * Must be used after requireAuth so that req.account is already set.
 *
 * - No req.account (unauthenticated) → 401 Unauthorized
 * - req.role === 'admin' → calls next() regardless of wallet match
 * - req.account matches req.params.wallet → calls next()
 * - Mismatch or missing req.params.wallet → 403 Forbidden
 */
export function requireWalletOwner(req: Request, res: Response, next: NextFunction): void {
  const account = req.account;

  if (!account) {
    sendUnauthorized(res, 'Unauthorized');
    return;
  }

  // Admins may act on behalf of any wallet.
  if (req.role === 'admin') {
    next();
    return;
  }

  const { wallet } = req.params;
  if (!wallet || account !== wallet) {
    sendForbidden(res, 'Forbidden');
    return;
  }

  next();
}
