import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types';
import { sendUnauthorized, sendForbidden } from '../utils/authError';
import { logger } from '../utils/logger';
import { isTokenRevoked } from '../services/tokenBlocklist';
import { logAuditEvent } from '../services/audit';
import { verifyJwt } from '../utils/jwt';

export interface AuthPayload extends jwt.JwtPayload, Partial<JwtPayload> {}

/** Verify a token against the current secret, then the previous secret (grace window). */
function verifyToken(token: string): AuthPayload {
  return verifyJwt(token) as AuthPayload;
}

/**
 * Middleware that verifies any valid JWT Bearer token.
 * Attaches `req.account` (Stellar public key) and `req.role` on success.
 * Returns 401 if the token is missing, invalid, expired, or revoked.
 *
 * Also accepts an X-API-Key header as an alternative to a JWT Bearer token.
 * When an X-API-Key is provided and verified, req.account is set to the
 * associated scout wallet and req.role is set to 'scout'.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // ── X-API-Key path ──────────────────────────────────────────────────────────
  const apiKeyHeader = req.headers['x-api-key'];
  if (apiKeyHeader && typeof apiKeyHeader === 'string') {
    try {
      // Lazy require avoids a circular module dependency at load time.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { resolveApiKey } = require('../controllers/apiKeyController') as {
        resolveApiKey: (rawKey: string) => { scout_wallet: string; id: number } | null;
      };
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { touchApiKeyLastUsed } = require('../db') as {
        touchApiKeyLastUsed: (id: number) => void;
      };
      const resolved = resolveApiKey(apiKeyHeader);
      if (!resolved) {
        logger.warn({ method: req.method, path: req.path, error: 'Invalid or revoked API key' });
        sendUnauthorized(res, 'Invalid or revoked API key');
        return;
      }
      try { touchApiKeyLastUsed(resolved.id); } catch { /* best-effort */ }
      req.account = resolved.scout_wallet;
      req.role = 'scout';
      next();
      return;
    } catch {
      logger.warn({ method: req.method, path: req.path, error: 'API key auth error' });
      sendUnauthorized(res, 'Invalid or revoked API key');
      return;
    }
  }

  // ── JWT Bearer path ─────────────────────────────────────────────────────────
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    logger.warn({ method: req.method, path: req.path, error: 'Missing auth token' });
    logAuditEvent({ action: 'auth_failed', path: req.path, reason: 'Missing auth token', timestamp: new Date().toISOString() });
    sendUnauthorized(res, 'Missing auth token');
    return;
  }
  try {
    const payload = verifyToken(header.slice(7));
    // isTokenRevoked is async; we must chain into a Promise to avoid blocking
    // the event loop while still sending the 401 on the same request lifecycle.
    isTokenRevoked(payload.jti).then((revoked) => {
      if (revoked) {
        logger.warn({ method: req.method, path: req.path, error: 'Token revoked' });
        sendUnauthorized(res, 'Token has been revoked');
        return;
      }
      req.account = payload.sub;
      req.role = payload.role;
      next();
    }).catch(() => {
      // Revocation check failed — fail open (allow request) to avoid blocking
      // legitimate traffic when the blocklist store is temporarily unavailable.
      logger.warn({ method: req.method, path: req.path, error: 'Revocation check failed, allowing request' });
      req.account = payload.sub;
      req.role = payload.role;
      next();
    });
  } catch {
    logger.warn({ method: req.method, path: req.path, error: 'Invalid or expired token' });
    logAuditEvent({ action: 'auth_failed', path: req.path, reason: 'Invalid or expired token', timestamp: new Date().toISOString() });
    sendUnauthorized(res, 'Invalid or expired token');
  }
}

/**
 * Middleware guard that restricts access to a single role.
 *
 * Usage: router.get('/admin-only', requireRole('admin'), handler)
 *
 * Returns 401 if no valid token is present.
 * Returns 403 if the token's role does not match.
 * All 401 and 403 responses are persisted to the audit trail.
 */
export function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // ── X-API-Key path ──────────────────────────────────────────────────────────
    const apiKeyHeader = req.headers['x-api-key'];
    if (apiKeyHeader && typeof apiKeyHeader === 'string') {
      try {
        // Lazy require avoids a circular module dependency at load time.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { resolveApiKey } = require('../controllers/apiKeyController') as {
          resolveApiKey: (rawKey: string) => { scout_wallet: string; id: number } | null;
        };
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { touchApiKeyLastUsed } = require('../db') as {
          touchApiKeyLastUsed: (id: number) => void;
        };
        const resolved = resolveApiKey(apiKeyHeader);
        if (!resolved) {
          logger.warn({ method: req.method, path: req.path, error: 'Invalid or revoked API key' });
          sendUnauthorized(res, 'Invalid or revoked API key');
          return;
        }
        if (role !== 'scout') {
          logger.warn({
            method: req.method,
            path: req.path,
            error: 'Insufficient permissions',
            requiredRole: role,
            providedRole: 'scout',
          });
          logAuditEvent({ action: 'auth_forbidden', path: req.path, reason: 'Insufficient permissions', requiredRole: role, timestamp: new Date().toISOString() });
          sendForbidden(res, 'Insufficient permissions', { requiredRole: role, providedRole: 'scout' });
          return;
        }
        try { touchApiKeyLastUsed(resolved.id); } catch { /* best-effort */ }
        req.account = resolved.scout_wallet;
        req.role = 'scout';
        next();
        return;
      } catch {
        logger.warn({ method: req.method, path: req.path, error: 'API key auth error' });
        sendUnauthorized(res, 'Invalid or revoked API key');
        return;
      }
    }

    // ── JWT Bearer path ─────────────────────────────────────────────────────────
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      logger.warn({ method: req.method, path: req.path, error: 'Missing auth token', requiredRole: role });
      logAuditEvent({ action: 'auth_failed', path: req.path, reason: 'Missing auth token', requiredRole: role, timestamp: new Date().toISOString() });
      sendUnauthorized(res, 'Missing auth token');
      return;
    }

    try {
      const token = header.slice(7);
      const payload = verifyToken(token);

      if (payload.role !== role) {
        logger.warn({
          method: req.method,
          path: req.path,
          error: 'Insufficient permissions',
          requiredRole: role,
          providedRole: payload.role,
        });
        logAuditEvent({ action: 'auth_forbidden', path: req.path, reason: 'Insufficient permissions', requiredRole: role, timestamp: new Date().toISOString() });
        sendForbidden(res, 'Insufficient permissions', { requiredRole: role, providedRole: payload.role });
        return;
      }

      isTokenRevoked(payload.jti).then((revoked) => {
        if (revoked) {
          logger.warn({ method: req.method, path: req.path, error: 'Token revoked', requiredRole: role });
          sendUnauthorized(res, 'Token has been revoked');
          return;
        }
        req.account = payload.sub;
        req.role = payload.role;
        next();
      }).catch(() => {
        req.account = payload.sub;
        req.role = payload.role;
        next();
      });
    } catch {
      logger.warn({ method: req.method, path: req.path, error: 'Invalid or expired token', requiredRole: role });
      logAuditEvent({ action: 'auth_failed', path: req.path, reason: 'Invalid or expired token', requiredRole: role, timestamp: new Date().toISOString() });
      sendUnauthorized(res, 'Invalid or expired token');
    }
  };
}

/**
 * Middleware that extracts a JWT if present but never blocks unauthenticated requests.
 * Sets req.account and req.role when a valid Bearer token is found; otherwise no-ops.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(header.slice(7));
      req.account = payload.sub;
      req.role = payload.role;
    } catch {
      // Invalid/expired token — treat the request as anonymous
    }
  }
  next();
}

/**
 * Middleware guard that allows access to any one of the specified roles.
 * Use this when a route should be accessible to multiple roles.
 *
 * Usage: router.get('/route', requireRoles('admin', 'validator'), handler)
 *
 * Returns 401 if no valid token is present.
 * Returns 403 if the token's role is not in the allowed list.
 */
export function requireRoles(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      sendUnauthorized(res, 'Missing auth token');
      return;
    }
    try {
      const payload = verifyToken(header.slice(7));
      if (!payload.role || !roles.includes(payload.role)) {
        sendForbidden(res, 'Insufficient permissions');
        return;
      }
      req.account = payload.sub;
      req.role = payload.role;
      next();
    } catch {
      sendUnauthorized(res, 'Invalid or expired token');
    }
  };
}
