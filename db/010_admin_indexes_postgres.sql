-- Migration 010: admin indexes (PostgreSQL)
-- Performance indexes for admin queries.

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at);
CREATE INDEX IF NOT EXISTS idx_players_created_at ON players (created_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_created_at ON subscriptions (created_at);
