import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getAllFeatureFlags } from '../db';
import { setFeatureFlag } from '../services/featureFlags';

const updateFeatureFlagSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_]*$/, 'Flag name must be snake_case starting with a letter'),
  enabled: z.boolean(),
});

/** GET /api/admin/feature-flags */
export async function getFeatureFlags(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const flags = getAllFeatureFlags().map((row) => ({
      name: row.name,
      enabled: row.enabled === 1,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    }));
    res.json({ success: true, data: flags });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/admin/feature-flags */
export async function updateFeatureFlag(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = updateFeatureFlagSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? 'Invalid request body',
      });
      return;
    }

    const { name, enabled } = parsed.data;
    const updatedBy = req.account ?? 'unknown';
    setFeatureFlag(name, enabled, updatedBy);

    res.json({
      success: true,
      data: { name, enabled, updated_by: updatedBy },
    });
  } catch (err) {
    next(err);
  }
}
