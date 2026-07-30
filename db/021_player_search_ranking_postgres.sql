-- Migration 021: Player search ranking, registered_at column, cursor pagination
-- Adds registered_at for consistent time-based ordering and search indexes.

ALTER TABLE players ADD COLUMN IF NOT EXISTS registered_at BIGINT;

-- Backfill: HTTP-registered rows (created_at > 10B = Unix seconds)
UPDATE players SET registered_at = created_at * 1000 WHERE created_at > 10000000000;

-- Backfill: Indexer-created rows — get ledger close timestamp from events table
UPDATE players SET registered_at = (
  SELECT COALESCE(MAX(e.created_at), 0)
  FROM events e
  WHERE e.type = 'player_registered'
    AND e.payload::json->>'player_id' = players.player_id
) WHERE created_at <= 10000000000 AND created_at IS NOT NULL;

-- Remaining rows default to 0
UPDATE players SET registered_at = 0 WHERE registered_at IS NULL;

ALTER TABLE players ALTER COLUMN registered_at SET NOT NULL;
ALTER TABLE players ALTER COLUMN registered_at SET DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_players_registered_at ON players (registered_at);
CREATE INDEX IF NOT EXISTS idx_players_search ON players (region, position, progress_level, registered_at);
