import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
  createBitrixSession,
  endBitrixSession,
  getSessionFromRequest,
  requireBitrixSession
} from '../services/authService.js';

export const authRouter = Router();

authRouter.get('/config', (_req, res) => {
  res.json({ required: env.BITRIX_AUTH_REQUIRED });
});

authRouter.post('/bitrix/session', async (req, res, next) => {
  try {
    const payload = z.object({
      domain: z.string().trim().min(1).max(191),
      accessToken: z.string().trim().min(12),
      userId: z.union([z.string(), z.number()]).optional()
    }).parse(req.body);
    const session = await createBitrixSession(payload);
    res.json({
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      user: session.user
    });
  } catch (error) {
    next(error);
  }
});

authRouter.get('/me', async (req, res, next) => {
  try {
    const session = await getSessionFromRequest(req);
    if (!session) {
      return res.json({ authenticated: false, required: env.BITRIX_AUTH_REQUIRED });
    }
    res.json({ authenticated: true, expiresAt: session.expiresAt, user: session.user });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/logout', requireBitrixSession, async (req, res, next) => {
  try {
    await endBitrixSession(req.bitrixSession, 'logout');
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
