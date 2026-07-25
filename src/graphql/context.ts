/**
 * GraphQL request context factory.
 *
 * Extracts the JWT from the Authorization header (same logic as the REST
 * requireAuth middleware) and populates ctx.account + ctx.role so resolvers
 * can enforce auth the same way the REST layer does.
 *
 * A fresh set of DataLoaders is created per request so batching is scoped
 * correctly.
 */

import { Request } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import { createLoaders, type RequestLoaders } from './loaders';
import { isTokenRevoked } from '../services/tokenBlocklist';
import { logger } from '../utils/logger';

export interface GraphQLContext {
  account: string | undefined;
  role: string | undefined;
  loaders: RequestLoaders;
  /** Raw Express request, available to resolvers that need it. */
  req: Request;
}

interface JwtLike {
  sub?: string;
  role?: string;
  jti?: string;
}

function tryVerifyJwt(token: string): JwtLike | null {
  const secrets = [config.jwtSecret];
  if (config.jwtSecretPrevious) secrets.push(config.jwtSecretPrevious);
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret) as JwtLike;
    } catch {
      // try next secret
    }
  }
  return null;
}

/**
 * Builds the GraphQL context for every request.
 * Called by graphql-yoga's `context` option.
 */
export function createContext({ req }: { req: Request }): GraphQLContext {
  const loaders = createLoaders();

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    logger.debug({ path: req.path, msg: 'graphql: no bearer token' });
    return { account: undefined, role: undefined, loaders, req };
  }

  const token = header.slice(7);
  const payload = tryVerifyJwt(token);
  if (!payload) {
    logger.debug({ path: req.path, msg: 'graphql: invalid jwt' });
    return { account: undefined, role: undefined, loaders, req };
  }

  if (payload.jti && isTokenRevoked(payload.jti)) {
    logger.debug({ path: req.path, msg: 'graphql: revoked token' });
    return { account: undefined, role: undefined, loaders, req };
  }

  return {
    account: payload.sub,
    role: payload.role,
    loaders,
    req,
  };
}
