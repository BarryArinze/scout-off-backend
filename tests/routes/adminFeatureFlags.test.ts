/**
 * Tests for runtime feature flags (#494)
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import { getDb } from '../../src/db';
import {
  clearFeatureFlagCache,
  isFeatureEnabled,
  FeatureFlags,
} from '../../src/services/featureFlags';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
const ADMIN_WALLET = 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';

function getAdminToken(): string {
  return jwt.sign({ sub: ADMIN_WALLET, role: 'admin' }, SECRET, { expiresIn: '1h' });
}

function getScoutToken(): string {
  return jwt.sign(
    { sub: 'GSCOUTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', role: 'scout' },
    SECRET,
    { expiresIn: '1h' },
  );
}

describe('Admin feature flags (#494)', () => {
  beforeEach(() => {
    clearFeatureFlagCache();
    getDb()
      .prepare(
        `INSERT INTO feature_flags (name, enabled, updated_at, updated_by)
         VALUES (?, 1, ?, 'system')
         ON CONFLICT(name) DO UPDATE SET enabled = 1, updated_by = 'system'`,
      )
      .run(FeatureFlags.SAVED_SEARCHES, Date.now());
    clearFeatureFlagCache();
  });

  describe('GET /api/admin/feature-flags', () => {
    it('returns 401 without a token', async () => {
      const res = await request(app).get('/api/admin/feature-flags');
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin role', async () => {
      const res = await request(app)
        .get('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getScoutToken()}`);
      expect(res.status).toBe(403);
    });

    it('returns all feature flags for admin', async () => {
      const res = await request(app)
        .get('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: FeatureFlags.SAVED_SEARCHES,
            enabled: true,
          }),
        ]),
      );
    });
  });

  describe('PUT /api/admin/feature-flags', () => {
    it('returns 401 without a token', async () => {
      const res = await request(app)
        .put('/api/admin/feature-flags')
        .send({ name: FeatureFlags.SAVED_SEARCHES, enabled: false });
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin role', async () => {
      const res = await request(app)
        .put('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getScoutToken()}`)
        .send({ name: FeatureFlags.SAVED_SEARCHES, enabled: false });
      expect(res.status).toBe(403);
    });

    it('returns 400 for invalid flag name', async () => {
      const res = await request(app)
        .put('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ name: 'Invalid-Flag', enabled: false });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('updates a flag and takes effect immediately without restart', async () => {
      expect(isFeatureEnabled(FeatureFlags.SAVED_SEARCHES)).toBe(true);

      const disableRes = await request(app)
        .put('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ name: FeatureFlags.SAVED_SEARCHES, enabled: false });

      expect(disableRes.status).toBe(200);
      expect(disableRes.body.data.enabled).toBe(false);
      expect(isFeatureEnabled(FeatureFlags.SAVED_SEARCHES)).toBe(false);

      const enableRes = await request(app)
        .put('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ name: FeatureFlags.SAVED_SEARCHES, enabled: true });

      expect(enableRes.status).toBe(200);
      expect(isFeatureEnabled(FeatureFlags.SAVED_SEARCHES)).toBe(true);
    });

    it('persists flag state to the database', async () => {
      await request(app)
        .put('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${getAdminToken()}`)
        .send({ name: FeatureFlags.SAVED_SEARCHES, enabled: false });

      clearFeatureFlagCache();

      const row = getDb()
        .prepare('SELECT enabled FROM feature_flags WHERE name = ?')
        .get(FeatureFlags.SAVED_SEARCHES) as { enabled: number };

      expect(row.enabled).toBe(0);
      expect(isFeatureEnabled(FeatureFlags.SAVED_SEARCHES)).toBe(false);
    });
  });
});
