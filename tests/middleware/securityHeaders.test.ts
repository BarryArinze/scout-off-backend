import request from 'supertest';
import app from '../../src/app';
import config from '../../src/config';

describe('securityHeaders middleware', () => {
  describe('headers present in all environments', () => {
    let res: Awaited<ReturnType<typeof request>>;

    beforeAll(async () => {
      res = await request(app).get('/health');
    });

    it('sets Content-Security-Policy', () => {
      expect(res.headers['content-security-policy']).toBe(config.securityHeaders.csp);
    });

    it('sets X-Content-Type-Options: nosniff', () => {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('sets X-Frame-Options: DENY', () => {
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('sets Referrer-Policy: no-referrer', () => {
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('sets Permissions-Policy', () => {
      expect(res.headers['permissions-policy']).toBe(config.securityHeaders.permissionsPolicy);
    });

    it('does not expose X-Powered-By', () => {
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('HSTS is environment-conditional', () => {
    it('omits Strict-Transport-Security in test/development mode', async () => {
      // NODE_ENV=test (set by Jest via tests/setup.ts), so HSTS must be absent.
      const res = await request(app).get('/health');
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });

    it('would set Strict-Transport-Security in production mode', () => {
      // Verify the configured value is correct without spinning up a full
      // production process — just assert the config value matches the spec.
      expect(config.securityHeaders.hsts).toMatch(/max-age=31536000/);
      expect(config.securityHeaders.hsts).toMatch(/includeSubDomains/);
    });
  });

  describe('CSP defaults', () => {
    it('includes default-src none', () => {
      expect(config.securityHeaders.csp).toContain("default-src 'none'");
    });

    it('includes frame-ancestors none', () => {
      expect(config.securityHeaders.csp).toContain("frame-ancestors 'none'");
    });
  });

  describe('Permissions-Policy defaults', () => {
    it('disables camera, microphone, and geolocation', () => {
      const pp = config.securityHeaders.permissionsPolicy;
      expect(pp).toContain('camera=()');
      expect(pp).toContain('microphone=()');
      expect(pp).toContain('geolocation=()');
    });
  });
});
