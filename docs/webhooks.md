# Webhooks

The ScoutOff backend can POST contract events to a configured HTTP endpoint as
they are indexed.  Delivery is controlled by two environment variables:

| Variable           | Default | Description                                      |
| ------------------ | ------- | ------------------------------------------------ |
| `WEBHOOK_ENABLED`  | `false` | Set to `true` to enable webhook delivery         |
| `WEBHOOK_URL`      | —       | HTTPS endpoint to POST events to                 |

## Delivery Model

When `WEBHOOK_ENABLED=true` and `WEBHOOK_URL` is set, the indexer calls
`deliverToSubscription()` for every indexed event. The function:

1. POSTs `{ eventType, payload }` as JSON to `WEBHOOK_URL`
2. Retries up to 3 times with exponential back-off (500 ms base, 5 s cap)
3. Writes a **delivery-attempt row** to `webhook_deliveries` regardless of
   whether the final outcome is success or failure

The subscription identifier used as the lookup key for admin endpoints is the
webhook URL itself.

## Delivery History

Every dispatch — success or failure — is persisted to the `webhook_deliveries`
table. Operators can query recent delivery attempts and rolled-up stats via the
admin API.

### Admin Endpoints

All endpoints require a valid admin Bearer token.

#### List delivery attempts

```
GET /api/admin/webhooks/:id/deliveries
```

`:id` is the URL-encoded subscription identifier (i.e. the webhook URL).

**Query parameters:**

| Param    | Type    | Default | Description              |
| -------- | ------- | ------- | ------------------------ |
| `limit`  | integer | `20`    | Page size (max 100)      |
| `offset` | integer | `0`     | Row offset for pagination |

**Example response:**

```json
{
  "success": true,
  "total": 42,
  "limit": 20,
  "offset": 0,
  "data": [
    {
      "id": 42,
      "subscription_id": "https://my-app.com/webhook",
      "event_type": "milestone_approved",
      "delivery_id": "wh_1r2s3t_a1b2c3d4",
      "attempt_count": 1,
      "status": "success",
      "status_code": 200,
      "error_message": null,
      "latency_ms": 312,
      "created_at": 1722000000000
    }
  ]
}
```

#### Success-rate summary

```
GET /api/admin/webhooks/:id/summary
```

**Query parameters:**

| Param      | Type    | Default        | Description                     |
| ---------- | ------- | -------------- | ------------------------------- |
| `windowMs` | integer | `86400000` (24 h) | Time window in milliseconds  |

**Example response:**

```json
{
  "success": true,
  "data": {
    "subscription_id": "https://my-app.com/webhook",
    "total": 38,
    "successes": 35,
    "failures": 3,
    "success_rate": 0.92,
    "last_success_at": 1722003600000
  }
}
```

## Dead-Letter Relationship

A delivery that exhausts all retries appears in `webhook_deliveries` with
`status = 'failure'` and `attempt_count = 3`. This row represents the **final
failed attempt** and serves as the queryable trace that was missing before this
feature was added.

## Data Retention

Delivery records older than **30 days** are pruned automatically during each
indexer poll cycle (`pruneWebhookDeliveries()`). The retention window is not
currently configurable via env var; adjust the `retentionMs` default in
`src/db/index.ts` if needed.

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT    NOT NULL,
  event_type      TEXT    NOT NULL,
  delivery_id     TEXT    NOT NULL UNIQUE,
  attempt_count   INTEGER NOT NULL DEFAULT 1,
  status          TEXT    NOT NULL,          -- 'success' | 'failure'
  status_code     INTEGER,
  error_message   TEXT,
  latency_ms      INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
```
