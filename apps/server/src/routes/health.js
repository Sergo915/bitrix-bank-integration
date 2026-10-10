import { Router } from 'express';
import { getAmeriaStatus } from '../services/ameriaClient.js';
import { getBitrixStatus } from '../services/bitrixClient.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      service: 'bitrix-ameriabank-server',
      bitrix: getBitrixStatus(),
      ameria: await getAmeriaStatus()
    });
  } catch (error) {
    next(error);
  }
});
