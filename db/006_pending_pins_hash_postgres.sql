-- Migration 006: pending pins hash (PostgreSQL)
-- Adds hash chain verification to pending_pins table if not already present.

ALTER TABLE IF EXISTS pending_pins ADD COLUMN IF NOT EXISTS hash_chain TEXT;
ALTER TABLE IF EXISTS pending_pins ADD COLUMN IF NOT EXISTS prev_hash TEXT;
