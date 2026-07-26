import request from 'supertest';
import app from '../../src/app';

describe('404 fallback handler', () => {
  it('returns 404 JSON for unknown path', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Not Found' });
  });

  it('does not return HTML for unknown path', async () => {
    const res = await request(app).get('/unknown/route');
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.status).toBe(404);
  });

  it('known routes still work normally', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
