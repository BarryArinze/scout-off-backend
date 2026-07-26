-- Migration 013: webhook dead-letter queue (#470)
--
-- A row is inserted whenever postWebhookWithRetry() exhausts all retry attempts
-- for a given subscriber. Rows can be listed and manually replayed via the
-- admin API (GET /api/admin/webhooks/dead-letters, POST /api/admin/webhooks/:id/replay).

CREATE TABLE IF NOT EXISTS webhook_dead_letters (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER,
  url             TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  failure_reason  TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'replayed'
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  replayed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_dead_letters_status ON webhook_dead_letters (status);
