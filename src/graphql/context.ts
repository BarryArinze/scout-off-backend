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
import { createLoaders, type RequestLoaders } from './loaders';
import { isTokenRevoked } from '../services/tokenBlocklist';
import { logger } from '../utils/logger';
import { tryVerifyJwt } from '../utils/jwt';

export interface GraphQLContext {
  account: string | undefined;
  role: string | undefined;
  loaders: RequestLoaders;
  /** Raw Express request, available to resolvers that need it. */
  req: Request;
}

/**
 * Builds the GraphQL context for every request.
 * Called by graphql-yoga's `context` option.
 */
export async function createContext({ req }: { req: Request }): Promise<GraphQLContext> {
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

  if (payload.jti && (await isTokenRevoked(payload.jti))) {
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
