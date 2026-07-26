import { Router } from 'express';
import { getChallenge, postToken } from '../controllers/authController';
import { rateLimit } from '../middleware/rateLimit';
import { methodNotAllowed } from '../middleware/methodNotAllowed';
import config from '../config';

const router = Router();

const authRateLimit = rateLimit({
  windowMs: config.authRateLimit.windowMs,
  max: config.authRateLimit.max,
});

router.route('/challenge')
  .get(authRateLimit, getChallenge)
  .all(methodNotAllowed(['GET']));

router.route('/token')
  .post(authRateLimit, postToken)
  .all(methodNotAllowed(['POST']));

export default router;
