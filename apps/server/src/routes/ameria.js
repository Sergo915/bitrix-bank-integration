import { Router } from 'express';
import { z } from 'zod';
import { getAmeriaStatus, getAmeriaToken } from '../services/ameriaClient.js';
import { syncAmeriaTransactions } from '../services/syncService.js';
import { requireBitrixSession } from '../services/bitrixSession.js';

export const ameriaRouter = Router();

ameriaRouter.use(requireBitrixSession);

ameriaRouter.get('/status', async (_req, res, next) => {
  try {
    res.json(await getAmeriaStatus());
  } catch (error) {
    next(error);
  }
});

ameriaRouter.post('/auth/test', async (_req, res, next) => {
  try {
    await getAmeriaToken();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

ameriaRouter.post('/sync', async (req, res, next) => {
  try {
    const params = z.record(z.union([z.string(), z.number(), z.boolean()])).parse(req.body ?? {});
    res.json(await syncAmeriaTransactions(params));
  } catch (error) {
    next(error);
  }
});
