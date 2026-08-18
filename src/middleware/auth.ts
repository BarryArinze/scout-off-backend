import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import { JwtPayload } from '../types';
import { sendUnauthorized, sendForbidden } from '../utils/authError';
import { logger } from '../utils/logger';
import { isTokenRevoked } from '../services/tokenBlocklist';
import { logAuditEvent } from '../services/audit';

export interface AuthPayload extends jwt.JwtPayload, Partial<JwtPayload> {}

/** Ordered list of secrets to try during verification. Current secret first. */
function jwtSecrets(): string[] {
  const secrets = [config.jwtSecret];
  if (config.jwtSecretPrevious) secrets.push(config.jwtSecretPrevious);
  return secrets;
}

/** Verify a token against the current secret, then the previous secret. */
function verifyToken(token: string): AuthPayload {
  const secrets = jwtSecrets();
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret) as AuthPayload;
    } catch {
      // try next
    }
  }
  throw new Error('Invalid or expired token');
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
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // ── X-API-Key path ──────────────────────────────────────────────────────────
  const apiKeyHeader = req.headers['x-api-key'];
  if (apiKeyHeader && typeof apiKeyHeader === 'string') {
    try {
      // Lazy require avoids a circular module dependency at load time.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { resolveApiKey } = require('../controllers/apiKeyController') as {
        resolveApiKey: (rawKey: string) => Promise<{ scout_wallet: string; id: number } | null>;
      };
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { touchApiKeyLastUsed } = require('../db') as {
        touchApiKeyLastUsed: (id: number) => Promise<void>;
      };
      const resolved = await resolveApiKey(apiKeyHeader);
      if (!resolved) {
        logger.warn({ method: req.method, path: req.path, error: 'Invalid or revoked API key' });
        sendUnauthorized(res, 'Invalid or revoked API key');
        return;
      }
      touchApiKeyLastUsed(resolved.id).catch(() => { /* best-effort */ });
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
    logAuditEvent({ action: 'auth_failed', path: req.path, reason: 'Missing auth token', timestamp: new Date().toISOString() }).catch(() => {});
    sendUnauthorized(res, 'Missing auth token');
    return;
  }
  try {
    const payload = verifyToken(header.slice(7));
    if (payload.jti && isTokenRevoked(payload.jti)) {
      logger.warn({ method: req.method, path: req.path, error: 'Token revoked' });
      sendUnauthorized(res, 'Token has been revoked');
      return;
    }
    req.account = payload.sub;
    req.role = payload.role;
    next();
  } catch {
    logger.warn({ method: req.method, path: req.path, error: 'Invalid or expired token' });
    logAuditEvent({ action: 'auth_failed', path: req.path, reason: 'Invalid or expired token', timestamp: new Date().toISOString() }).catch(() => {});
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
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // ── X-API-Key path ──────────────────────────────────────────────────────────
    const apiKeyHeader = req.headers['x-api-key'];
    if (apiKeyHeader && typeof apiKeyHeader === 'string') {
      try {
        // Lazy require avoids a circular module dependency at load time.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { resolveApiKey } = require('../controllers/apiKeyController') as {
          resolveApiKey: (rawKey: string) => Promise<{ scout_wallet: string; id: number } | null>;
        };
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { touchApiKeyLastUsed } = require('../db') as {
          touchApiKeyLastUsed: (id: number) => Promise<void>;
        };
        const resolved = await resolveApiKey(apiKeyHeader);
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
          logAuditEvent({ action: 'auth_forbidden', path: req.path, reason: 'Insufficient permissions', requiredRole: role, timestamp: new Date().toISOString() }).catch(() => {});
          sendForbidden(res, 'Insufficient permissions', { requiredRole: role, providedRole: 'scout' });
          return;
        }
        touchApiKeyLastUsed(resolved.id).catch(() => { /* best-effort */ });
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
      logAuditEvent({ action: 'auth_failed', path: req.path, reason: 'Missing auth token', requiredRole: role, timestamp: new Date().toISOString() }).catch(() => {});
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
        logAuditEvent({ action: 'auth_forbidden', path: req.path, reason: 'Insufficient permissions', requiredRole: role, timestamp: new Date().toISOString() }).catch(() => {});
        sendForbidden(res, 'Insufficient permissions', { requiredRole: role, providedRole: payload.role });
        return;
      }

      if (payload.jti && isTokenRevoked(payload.jti)) {
        logger.warn({ method: req.method, path: req.path, error: 'Token revoked', requiredRole: role });
        sendUnauthorized(res, 'Token has been revoked');
        return;
      }

      req.account = payload.sub;
      req.role = payload.role;
      next();
    } catch {
      logger.warn({ method: req.method, path: req.path, error: 'Invalid or expired token', requiredRole: role });
      logAuditEvent({ action: 'auth_failed', path: req.path, reason: 'Invalid or expired token', requiredRole: role, timestamp: new Date().toISOString() }).catch(() => {});
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
