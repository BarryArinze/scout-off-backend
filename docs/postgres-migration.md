# PostgreSQL Migration Guide

This guide documents the process for migrating a Scout-Off backend deployment from SQLite to PostgreSQL.

## Overview

Scout-Off supports two database drivers:
- **SQLite** (default): Fast, simple, file-based. Suitable for single-instance deployments.
- **PostgreSQL** (opt-in): Network-accessible, supports horizontal scaling, concurrent connections.

The migration is reversible within a maintenance window.

## Prerequisites

- PostgreSQL 12 or later
- `pg_dump` utility (included with PostgreSQL)
- Network connectivity between backend instances and PostgreSQL server
- Admin access to create databases and users

## Pre-Migration Checklist

- [ ] Back up current SQLite database file
- [ ] Plan maintenance window (expected downtime: 10-30 minutes depending on data size)
- [ ] Notify stakeholders of maintenance
- [ ] Test procedure in staging environment
- [ ] Verify PostgreSQL server capacity and connectivity

## Step 1: Set Up PostgreSQL

### Local Development (Docker Compose)

If using `docker-compose.yml`, the PostgreSQL service is already configured:

```bash
docker-compose up -d postgres
```

Verify connectivity:

```bash
docker-compose exec postgres psql -U scout_user -d scout_off -c "SELECT 1"
```

### Production Setup

Create a dedicated database and user:

```sql
-- Connect to PostgreSQL as admin
CREATE USER scout_user WITH PASSWORD '[strong-password]';
CREATE DATABASE scout_off OWNER scout_user;
GRANT ALL PRIVILEGES ON DATABASE scout_off TO scout_user;
```

## Step 2: Export Data from SQLite

While the backend is running, export the SQLite database:

```bash
# SQLite to CSV export (example - adjust based on your needs)
sqlite3 scout-off.db <<'EOF'
.mode csv
.output events.csv
SELECT * FROM events;

.output players.csv
SELECT * FROM players;

-- Export all tables similarly
.output events.csv
SELECT * FROM events;
EOF
```

Or use `sqlite3` dump format:

```bash
sqlite3 scout-off.db ".dump" > scout-off-dump.sql
```

## Step 3: Run Migrations

The Scout-Off backend automatically runs migrations on startup. To switch to PostgreSQL:

1. Set the `DB_DRIVER` environment variable to `postgres`:

```bash
export DB_DRIVER=postgres
export DATABASE_URL="postgresql://scout_user:[password]@postgres-host:5432/scout_off"
```

2. Start the backend:

```bash
npm run build
npm start
```

The backend will:
- Connect to PostgreSQL
- Detect any unapplied migrations
- Create schema using PostgreSQL-specific migration files (`*_postgres.sql`)
- Apply all pending migrations in order

## Step 4: Verify Data Integrity

After migration, verify that all data has been transferred:

```sql
-- Connect to PostgreSQL
SELECT COUNT(*) FROM events;
SELECT COUNT(*) FROM players;
SELECT COUNT(*) FROM subscriptions;
-- ... verify counts match SQLite exports
```

Check application logs for any errors during migration or startup.

## Step 5: Configure for Production

Update your deployment configuration:

### Docker Compose

```yaml
services:
  backend:
    environment:
      DB_DRIVER: postgres
      DATABASE_URL: "postgresql://scout_user:${DB_PASSWORD}@postgres:5432/scout_off"
```

### Kubernetes / Other Orchestration

Set environment variables in your deployment manifest:

```yaml
env:
  - name: DB_DRIVER
    value: "postgres"
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: db-credentials
        key: connection-url
```

## Step 6: Enable Horizontal Scaling

With PostgreSQL, multiple backend replicas can now safely share the same database:

```yaml
# Example: 3 backend replicas
replicas: 3
```

All instances will:
- Connect to the same PostgreSQL database
- Use row-level locking and transactions for consistency
- Benefit from connection pooling via PgBouncer or pgpool2 (optional)

## Rollback Procedure

If issues arise, rollback to SQLite:

1. Stop all backend instances
2. Verify SQLite database file still exists and is backed up
3. Set environment variables back to SQLite:

```bash
export DB_DRIVER=sqlite
export DB_PATH=scout-off.db
```

4. Restart backend instances

**Note:** If you made changes to data in PostgreSQL after switching, those changes will not be reflected in SQLite. Only rollback if the migration completed but you encounter unexpected issues during testing.

## PostgreSQL Connection Pooling (Optional)

For high-concurrency deployments, use PgBouncer or pgpool2:

### PgBouncer Example

```ini
[databases]
scout_off = host=postgres port=5432 dbname=scout_off user=scout_user password=password

[pgbouncer]
pool_mode = transaction
max_client_conn = 1000
default_pool_size = 25
```

Then connect backend to PgBouncer:

```bash
DATABASE_URL="postgresql://scout_user:password@pgbouncer:6432/scout_off"
```

## Performance Tuning

### PostgreSQL Configuration (`postgresql.conf`)

For typical Scout-Off workloads:

```ini
# Connection limits
max_connections = 200
superuser_reserved_connections = 3

# Memory
shared_buffers = 256MB
effective_cache_size = 1GB
work_mem = 4MB
maintenance_work_mem = 64MB

# WAL
wal_buffers = 16MB
checkpoint_completion_target = 0.9

# Query planning
random_page_cost = 1.1  # For SSD storage
```

### Create Indexes for Common Queries

Indexes are created by migrations, but monitor slow query log:

```bash
# Enable slow query logging
ALTER SYSTEM SET log_min_duration_statement = 100;  -- Log queries >100ms
SELECT pg_reload_conf();
```

## Troubleshooting

### Connection Refused

Verify PostgreSQL is running and accessible:

```bash
psql -h postgres-host -U scout_user -d scout_off -c "SELECT 1"
```

### Migration Fails

Check the backend logs for specific error messages. Common issues:

- **Permission denied**: User lacks permissions on the database
- **Disk full**: PostgreSQL server out of disk space
- **Timezone issues**: Ensure PostgreSQL and backend use compatible timezone settings

### Performance Issues Post-Migration

- Run `ANALYZE` to update table statistics:

```sql
ANALYZE;
```

- Check for missing indexes:

```sql
SELECT * FROM pg_stat_user_indexes WHERE idx_scan = 0;
```

## FAQ

**Q: Can I keep SQLite for backups?**

A: Yes. Continue to back up PostgreSQL using `pg_dump`:

```bash
pg_dump -h postgres-host -U scout_user scout_off | gzip > backup-$(date +%Y%m%d).sql.gz
```

**Q: What about read replicas?**

A: PostgreSQL streaming replication is outside the scope of this guide. Refer to PostgreSQL documentation for setting up standby replicas.

**Q: How do I monitor PostgreSQL?**

A: Use tools like:
- `pg_stat_statements` (query performance)
- `pgAdmin` (web UI)
- `Prometheus + postgres_exporter` (metrics)

## Support

For issues with the migration or PostgreSQL driver support, open an issue on the project repository with:

- Error messages from backend logs
- PostgreSQL version
- Data size (approx. table row counts)
- Deployment environment (Docker, Kubernetes, etc.)
