import { Router } from 'express';

const router = Router();

// Deliberate v2-only example endpoint used to demonstrate intentional
// divergence and exercise the parity allowlist/test.
// GET /api/v2/versioning/demo
router.get('/demo', (_req, res) => {
  res.json({ version: 2, demo: true });
});

export default router;
