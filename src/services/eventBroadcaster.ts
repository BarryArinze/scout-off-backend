import { EventEmitter } from 'events';
import { ContractEventType } from '../types';
import { logger } from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single broadcast-ready event payload sent over SSE. */
export interface BroadcastEvent {
  type: ContractEventType;
  payload: Record<string, unknown>;
}

/**
 * A connected SSE subscriber.
 * The `wallet` is the authenticated Stellar address; `send` pushes a serialised
 * SSE frame to the underlying HTTP response stream.
 */
export interface SseSubscriber {
  wallet: string;
  send: (event: BroadcastEvent) => void;
}

// ─── Relevance filter ─────────────────────────────────────────────────────────
//
// Determines whether a broadcast event is relevant to a given wallet.
// Rules (no cross-tenant leakage):
//
//   milestone_approved  → relevant when payload.player_id matches a player's own
//                         wallet OR when the player_id column of the players table
//                         is owned by that wallet. Because the indexer does NOT
//                         carry a wallet field on milestone events we match on
//                         player_id === wallet as a convention used throughout the
//                         codebase, and also broadcast to any subscriber whose
//                         wallet matches the scout_wallet / wallet field present
//                         in the payload.
//
//   scout_subscribed    → relevant when payload.scout (scout wallet) matches.
//   contact_unlocked    → relevant when payload.scout (scout wallet) matches.
//   trial_offer_logged  → relevant when payload.scout matches (scout) or
//                         payload.player_id matches (player).
//   player_registered   → relevant when payload.wallet matches.
//   milestone_submitted → relevant when payload.player_id matches or
//                         payload.validator matches.
//   fees_withdrawn      → relevant when payload.recipient matches (admin).
//
// In practice clients only need milestone_approved, scout_subscribed, and
// contact_unlocked for the described use-cases, but we handle all event types
// so the stream is self-documenting and future-proof.

export function isEventRelevantToWallet(
  event: BroadcastEvent,
  wallet: string,
): boolean {
  const p = event.payload;

  switch (event.type) {
    case 'milestone_approved':
      // Broadcast to the player who owns the milestone and to scouts watching.
      return (
        p.player_id === wallet ||
        p.wallet === wallet ||
        p.scout === wallet
      );

    case 'scout_subscribed':
      return p.scout === wallet || p.wallet === wallet;

    case 'contact_unlocked':
      return p.scout === wallet || p.wallet === wallet;

    case 'trial_offer_logged':
      return p.scout === wallet || p.player_id === wallet;

    case 'player_registered':
      return p.wallet === wallet || p.player_id === wallet;

    case 'milestone_submitted':
      return p.player_id === wallet || p.validator === wallet;

    case 'fees_withdrawn':
      return p.recipient === wallet || p.wallet === wallet;

    default:
      return false;
  }
}

// ─── EventBroadcaster ────────────────────────────────────────────────────────

/**
 * Singleton in-process pub/sub bus for SSE.
 *
 * The indexer calls `broadcast(event)` after persisting each batch of events.
 * The SSE route handler calls `subscribe(subscriber)` on connection and
 * `unsubscribe(subscriber)` on disconnect.
 *
 * Thread-safety note: Node.js is single-threaded; no locking is required.
 */
export class EventBroadcaster extends EventEmitter {
  private static _instance: EventBroadcaster | null = null;

  /** The internal EventEmitter channel name. */
  private static readonly CHANNEL = 'contract_event';

  /** Active subscriber list — used for connection-count metrics. */
  private _subscribers: Set<SseSubscriber> = new Set();

  private constructor() {
    super();
    // Raise the default max-listeners cap: each SSE connection adds one
    // listener, so we expect O(connections) listeners on the emitter.
    this.setMaxListeners(0);
  }

  /** Return (or lazily create) the process-wide singleton. */
  static getInstance(): EventBroadcaster {
    if (!EventBroadcaster._instance) {
      EventBroadcaster._instance = new EventBroadcaster();
    }
    return EventBroadcaster._instance;
  }

  /**
   * Reset the singleton — only intended for use in tests to get a clean
   * instance between test cases.
   */
  static _resetForTests(): void {
    if (EventBroadcaster._instance) {
      EventBroadcaster._instance.removeAllListeners();
      EventBroadcaster._instance = null;
    }
  }

  /** Number of currently connected SSE subscribers. */
  get subscriberCount(): number {
    return this._subscribers.size;
  }

  /**
   * Register an SSE subscriber. The subscriber's `send` callback will be
   * invoked for every event that `isEventRelevantToWallet` returns true for.
   */
  subscribe(subscriber: SseSubscriber): void {
    this._subscribers.add(subscriber);

    const listener = (event: BroadcastEvent) => {
      try {
        if (isEventRelevantToWallet(event, subscriber.wallet)) {
          subscriber.send(event);
        }
      } catch (err) {
        logger.warn(
          `[eventBroadcaster] error sending event to ${subscriber.wallet}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };

    // Attach listener with the subscriber as the key so we can remove it later.
    (subscriber as SseSubscriber & { _listener?: (e: BroadcastEvent) => void })._listener = listener;
    this.on(EventBroadcaster.CHANNEL, listener);

    logger.debug(
      `[eventBroadcaster] subscribed wallet=${subscriber.wallet} total=${this._subscribers.size}`,
    );
  }

  /**
   * Remove an SSE subscriber and detach its event listener.
   * Must be called when the client disconnects to prevent memory leaks.
   */
  unsubscribe(subscriber: SseSubscriber): void {
    const listener = (subscriber as SseSubscriber & { _listener?: (e: BroadcastEvent) => void })._listener;
    if (listener) {
      this.off(EventBroadcaster.CHANNEL, listener);
    }
    this._subscribers.delete(subscriber);

    logger.debug(
      `[eventBroadcaster] unsubscribed wallet=${subscriber.wallet} total=${this._subscribers.size}`,
    );
  }

  /**
   * Emit an event to all relevant subscribers.
   * Called by the indexer after persisting a batch of events.
   */
  broadcast(event: BroadcastEvent): void {
    logger.debug(`[eventBroadcaster] broadcast type=${event.type} subscribers=${this._subscribers.size}`);
    this.emit(EventBroadcaster.CHANNEL, event);
  }
}

/** Convenience accessor for the singleton. */
export const broadcaster = EventBroadcaster.getInstance();
