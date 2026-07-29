-- Migration 020: seed additional runtime feature flags (#805, PostgreSQL)

INSERT INTO feature_flags (name, enabled, created_at, updated_at)
VALUES ('player_tokens_enabled',       FALSE, 0, 0)
ON CONFLICT (name) DO NOTHING;

INSERT INTO feature_flags (name, enabled, created_at, updated_at)
VALUES ('saved_search_alerts_enabled', FALSE, 0, 0)
ON CONFLICT (name) DO NOTHING;

INSERT INTO feature_flags (name, enabled, created_at, updated_at)
VALUES ('graphql_enabled',             TRUE,  0, 0)
ON CONFLICT (name) DO NOTHING;
