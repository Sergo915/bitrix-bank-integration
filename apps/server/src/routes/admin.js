import { Router } from 'express';
import { z } from 'zod';
import { getAdminOverview, getAdminReceipts, listAuditEvents, listUserSessions } from '../services/adminService.js';
import {
  getAmeriaSchedulerStatus,
  startAmeriaScheduler,
  stopAmeriaScheduler,
  syncAmeriaTransactions
} from '../services/syncService.js';

export const adminRouter = Router();

adminRouter.use((req, res, next) => {
  if (!process.env.ADMIN_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'ADMIN_ACCESS_TOKEN is not configured' });
  }

  if (req.get('x-admin-token') !== process.env.ADMIN_ACCESS_TOKEN) {
    return res.status(401).json({ error: 'Admin access token is invalid' });
  }

  next();
});

adminRouter.post('/sync', async (req, res, next) => {
  try {
    const params = z.record(z.union([z.string(), z.number(), z.boolean()])).parse(req.body ?? {});
    res.json(await syncAmeriaTransactions(params));
  } catch (error) {
    if (error.code === 'ECONNRESET' || error.cause?.code === 'ECONNRESET') {
      error.status = 502;
      error.message = 'Ameriabank connection was reset. Check AMERIA_BASE_URL or set AMERIA_PROXY_URL only if a working proxy is required.';
    }
    next(error);
  }
});
adminRouter.get('/scheduler', async (_req, res, next) => {
  try {
    res.json(await getAmeriaSchedulerStatus());
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/scheduler/start', async (req, res, next) => {
  try {
    const params = z.object({
      runImmediately: z.boolean().default(false),
      dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
      fromTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)
    }).parse(req.body ?? {});
    res.json(await startAmeriaScheduler({ force: true, ...params }));
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/scheduler/stop', async (_req, res, next) => {
  try {
    res.json(await stopAmeriaScheduler());
  } catch (error) {
    next(error);
  }
});
adminRouter.get('/overview', async (_req, res, next) => {
  try {
    res.json(await getAdminOverview());
  } catch (error) {
    next(error);
  }
});

adminRouter.get('/audit', async (req, res, next) => {
  try {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
      action: z.string().trim().max(64).default(''),
      status: z.string().trim().max(32).default('')
    }).parse(req.query);
    res.json({ events: await listAuditEvents(query) });
  } catch (error) {
    next(error);
  }
});

adminRouter.get('/receipts', async (req, res, next) => {
  try {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(1000).default(500),
      offset: z.coerce.number().int().min(0).default(0)
    }).parse(req.query);
    res.json(await getAdminReceipts(query));
  } catch (error) {
    next(error);
  }
});
adminRouter.get('/sessions', async (req, res, next) => {
  try {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0)
    }).parse(req.query);
    res.json({ sessions: await listUserSessions(query) });
  } catch (error) {
    next(error);
  }
});
