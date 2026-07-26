-- Migration 013: webhook dead letters (PostgreSQL)
-- Stores failed webhook delivery attempts.

CREATE TABLE IF NOT EXISTS webhook_dead_letters (
  id                SERIAL PRIMARY KEY,
  subscription_id   INTEGER NOT NULL,
  event_payload     TEXT NOT NULL,  -- JSON-serialised event
  error_message     TEXT,
  attempt_count     INTEGER DEFAULT 1,
  last_attempted_at BIGINT NOT NULL,
  replayed_at       BIGINT,
  created_at        BIGINT NOT NULL,
  FOREIGN KEY (subscription_id) REFERENCES webhook_subscriptions(id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_dead_letters_subscription ON webhook_dead_letters (subscription_id);
CREATE INDEX IF NOT EXISTS idx_webhook_dead_letters_replayed_at ON webhook_dead_letters (replayed_at);
