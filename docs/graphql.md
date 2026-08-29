# GraphQL Endpoint

The ScoutOff backend exposes a `/graphql` endpoint that is **disabled by
default** and controlled by the `graphql_enabled` feature flag.

## Feature Flag

| Flag key          | Default | Description                                         |
| ----------------- | ------- | --------------------------------------------------- |
| `graphql_enabled` | `false` | Mount and serve the `/graphql` endpoint             |

The flag is stored in the `feature_flags` table (see below) and evaluated
**dynamically on every request**. No process restart is required when the flag
is toggled; the new value is visible within one cache TTL window (default 5 s,
controlled by `FEATURE_FLAG_CACHE_TTL_MS`).

### Toggling at runtime

```sql
-- Enable
UPDATE feature_flags SET enabled = 1, updated_at = strftime('%s', 'now')
WHERE key = 'graphql_enabled';

-- Disable
UPDATE feature_flags SET enabled = 0, updated_at = strftime('%s', 'now')
WHERE key = 'graphql_enabled';
```

Or via the `setFlag` helper in `src/services/featureFlags.ts`:

```ts
import { setFlag, GRAPHQL_ENABLED } from './services/featureFlags';

setFlag(GRAPHQL_ENABLED, true);  // enable
setFlag(GRAPHQL_ENABLED, false); // disable
```

### Behaviour by flag state

| Flag state | `GET /graphql` response | Schema exposed? |
| ---------- | ----------------------- | --------------- |
| `off`      | `404 Not Found`         | No              |
| `on`       | GraphQL response        | Yes             |

When the flag is off, introspection is also unavailable (the request never
reaches the GraphQL handler).

## Error Codes

Every GraphQL error response includes an `extensions.code` field. The table
below lists every code a client may receive.

### Codes mapped to the REST `ErrorCode` enum

These codes are shared with the REST API (`src/utils/errorCodes.ts`) so a
client can handle both surfaces with a single mapping.

| `extensions.code`    | REST `ErrorCode` equivalent | Meaning                                  |
| -------------------- | --------------------------- | ---------------------------------------- |
| `UNAUTHORIZED`       | `UNAUTHORIZED`              | Request is not authenticated             |
| `FORBIDDEN`          | `FORBIDDEN`                 | Authenticated but lacks permission       |
| `NOT_FOUND`          | `NOT_FOUND`                 | Requested resource does not exist        |
| `VALIDATION_ERROR`   | `VALIDATION_ERROR`          | Input failed schema or semantic validation |
| `INTERNAL_SERVER_ERROR` | `INTERNAL_SERVER_ERROR`  | Unexpected server-side error             |

### GraphQL-only codes

These codes have no REST equivalent and are specific to the GraphQL transport
layer.

| `extensions.code`        | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `QUERY_COST_EXCEEDED`    | Query complexity score exceeds the configured maximum             |
| `DEPTH_LIMIT_EXCEEDED`   | Query nesting depth exceeds the configured maximum                |
| `INTROSPECTION_DISABLED` | Introspection was attempted but is disabled (production guard)    |
| `NOT_IMPLEMENTED`        | The resolver or feature is not yet implemented                    |

## Schema & Resolvers

> The GraphQL schema and resolvers are not yet implemented (stub endpoint).
> When `graphql-yoga` or a similar server is added, replace the stub handler in
> `src/graphql/index.ts` with the real yoga handler. The feature-flag guard is
> intentionally kept as a separate middleware layer so it wraps any future
> implementation without modification.

## Database Schema

The `feature_flags` table is created and seeded by `bootstrapFeatureFlags()`
(called from `src/index.ts` after `initDb()`).

```sql
CREATE TABLE IF NOT EXISTS feature_flags (
  key        TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
```

Default rows seeded on startup:

| key               | enabled |
| ----------------- | ------- |
| `graphql_enabled` | `0`     |

## Environment Variables

| Variable                   | Default | Description                                             |
| -------------------------- | ------- | ------------------------------------------------------- |
| `FEATURE_FLAG_CACHE_TTL_MS` | `5000` | How long (ms) to cache a flag value before re-reading  |
