/**
 * GraphQL resolvers.
 *
 * All resolvers use the existing DB helpers from src/db/index.ts — no DB
 * logic is duplicated here.  Milestone data is batch-loaded via DataLoader
 * to eliminate N+1 queries.
 *
 * Authentication: resolvers that require auth throw a GraphQL error with
 * extensions.code = 'UNAUTHENTICATED' (scout/admin paths) or
 * 'UNAUTHORIZED' (wrong role).  Read-only public resolvers (player, players)
 * are intentionally unauthenticated — the REST endpoints are also public.
 */

import { GraphQLError } from 'graphql';
import {
  getPlayerById,
  queryPlayers,
  countPlayers,
  getLatestSubscription,
  type PlayerRow,
} from '../db';
import { getTierMeta, tierName } from '../utils/tier';
import { type GraphQLContext } from './context';

// ─── Auth helpers ──────────────────────────────────────────────────────────────

function assertAuthenticated(ctx: GraphQLContext): void {
  if (!ctx.account) {
    throw new GraphQLError('Authentication required', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
}

function assertRole(ctx: GraphQLContext, role: string): void {
  assertAuthenticated(ctx);
  if (ctx.role !== role) {
    throw new GraphQLError(`Requires ${role} role`, {
      extensions: { code: 'UNAUTHORIZED' },
    });
  }
}

// ─── Serialization ─────────────────────────────────────────────────────────────

function serializePlayer(row: PlayerRow) {
  const { tierName: tn, tierDescription } = getTierMeta(row.progress_level);
  return {
    player_id: row.player_id,
    wallet: row.wallet,
    position: row.position ?? null,
    region: row.region ?? null,
    metadataUri: row.metadata_uri ?? null,
    progress_level: row.progress_level,
    created_at: row.created_at ?? null,
    is_active: row.is_active ?? 1,
    tierName: tn,
    tierDescription,
    progress_tier_name: tierName(row.progress_level),
  };
}

// ─── Query resolvers ───────────────────────────────────────────────────────────

const Query = {
  /**
   * player(id: ID!): Player
   *
   * Returns null for deactivated players (consistent with REST GET /players/:id).
   * Public — no auth required.
   */
  player(_parent: unknown, args: { id: string }, _ctx: GraphQLContext) {
    const row = getPlayerById(args.id);
    if (!row) return null;
    // Hide deactivated players from non-owner, non-admin callers
    if (row.is_active === 0) return null;
    return serializePlayer(row);
  },

  /**
   * players(region, position, minTier, page, pageSize): PlayerConnection
   *
   * Mirrors GET /api/players filter endpoint.  Public — no auth required.
   */
  players(
    _parent: unknown,
    args: {
      region?: string | null;
      position?: string | null;
      minTier?: number | null;
      page?: number | null;
      pageSize?: number | null;
    },
    _ctx: GraphQLContext,
  ) {
    const page = Math.max(1, args.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, args.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    const opts = {
      region: args.region ?? undefined,
      position: args.position ?? undefined,
      minTier: args.minTier ?? undefined,
    };

    const rows = queryPlayers({ ...opts, limit: pageSize, offset });
    const total = countPlayers(opts);
    const pages = Math.ceil(total / pageSize);

    return {
      nodes: rows.map(serializePlayer),
      pageInfo: { total, page, pageSize, pages },
    };
  },

  /**
   * milestones(playerId: ID!): [Milestone!]!
   *
   * Returns combined indexed + on-chain milestones.  Public — no auth required.
   * Uses DataLoader under the hood when called as a root query too.
   */
  async milestones(
    _parent: unknown,
    args: { playerId: string },
    ctx: GraphQLContext,
  ) {
    const player = getPlayerById(args.playerId);
    if (!player) {
      throw new GraphQLError('Player not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }
    return ctx.loaders.milestones.load(args.playerId);
  },

  /**
   * scoutSubscription(wallet: String!): ScoutSubscription
   *
   * Returns the active subscription status for a scout wallet.
   * Requires authentication; scout can only query their own wallet,
   * admins can query any wallet.
   */
  scoutSubscription(
    _parent: unknown,
    args: { wallet: string },
    ctx: GraphQLContext,
  ) {
    assertAuthenticated(ctx);
    if (ctx.role !== 'admin' && ctx.account !== args.wallet) {
      throw new GraphQLError('You can only query your own subscription', {
        extensions: { code: 'UNAUTHORIZED' },
      });
    }

    const sub = getLatestSubscription(args.wallet);
    const now = Math.floor(Date.now() / 1000);

    if (!sub) {
      return {
        active: false,
        tier: null,
        expiresAt: null,
        remainingDays: 0,
        gracePeriodActive: false,
      };
    }

    const gracePeriodSecs = (24 + 0) * 3600; // mirrors config.subscriptionGracePeriodHours
    const inGrace = now > sub.expires_at && now <= sub.expires_at + gracePeriodSecs;
    const active = sub.expires_at > now || inGrace;
    const remainingDays = Math.max(0, Math.ceil((sub.expires_at - now) / 86400));

    return {
      active,
      tier: sub.tier,
      expiresAt: sub.expires_at,
      remainingDays,
      gracePeriodActive: inGrace,
    };
  },
};

// ─── Field resolvers ───────────────────────────────────────────────────────────

const Player = {
  /**
   * Player.milestones — uses DataLoader so a list of players batches all
   * milestone lookups into a single DB+RPC round-trip.
   */
  async milestones(
    parent: { player_id: string },
    _args: unknown,
    ctx: GraphQLContext,
  ) {
    return ctx.loaders.milestones.load(parent.player_id);
  },
};

export const resolvers = {
  Query,
  Player,
};
