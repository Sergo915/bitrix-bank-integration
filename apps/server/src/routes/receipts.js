import { Router } from 'express';
import { z } from 'zod';
import {
  confirmMatch,
  importBankTransaction,
  listBuildingOptions,
  listReceipts,
  normalizeApartmentSearchInput,
  searchDeals,
  undoMatch
} from '../services/matchEngine.js';
import { requireBitrixSession } from '../services/bitrixSession.js';
import { restoreReceipt, trashReceipt } from '../services/receiptTrashStore.js';

export const receiptsRouter = Router();

receiptsRouter.use(requireBitrixSession);

receiptsRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await listReceipts());
  } catch (error) {
    next(error);
  }
});

receiptsRouter.post('/trash', async (req, res, next) => {
  try {
    const { receiptId } = z.object({ receiptId: z.string().regex(/^\d+$/) }).parse(req.body);
    await trashReceipt(receiptId);
    res.json({ ok: true, receiptId });
  } catch (error) {
    next(error);
  }
});

receiptsRouter.post('/trash/restore', async (req, res, next) => {
  try {
    const { receiptId } = z.object({ receiptId: z.string().regex(/^\d+$/) }).parse(req.body);
    await restoreReceipt(receiptId);
    res.json({ ok: true, receiptId });
  } catch (error) {
    next(error);
  }
});

receiptsRouter.get('/deals/search', async (req, res, next) => {
  try {
    const query = z.object({
      name: z.string().trim().max(100).optional().default(''),
      building: z.enum(['', '1503', '1505', '1507']).optional().default(''),
      apartment: z
        .string()
        .trim()
        .max(20)
        .optional()
        .default('')
        .transform(normalizeApartmentSearchInput)
    }).parse(req.query);
    res.json({
      deals: await searchDeals(query)
    });
  } catch (error) {
    next(error);
  }
});

receiptsRouter.get('/buildings', async (_req, res, next) => {
  try {
    res.json({
      buildings: await listBuildingOptions()
    });
  } catch (error) {
    next(error);
  }
});

receiptsRouter.post('/bank/import', async (req, res, next) => {
  try {
    const result = await importBankTransaction(req.body);
    res.json({
      ok: true,
      created: result.created,
      receipt: result.receipt
    });
  } catch (error) {
    next(error);
  }
});

receiptsRouter.post('/match', async (req, res, next) => {
  try {
    const payload = z
      .object({
        receiptId: z.string().regex(/^\d+$/),
        dealId: z.string().regex(/^\d+$/),
        scheduleIds: z.array(z.string().regex(/^\d+$/)).max(100).default([])
      })
      .parse(req.body);

    res.json({
      ok: true,
      receipt: await confirmMatch(payload)
    });
  } catch (error) {
    next(error);
  }
});

receiptsRouter.post('/match/undo', async (req, res, next) => {
  try {
    const payload = z
      .object({
        receiptId: z.string().regex(/^\d+$/),
        dealId: z.string().regex(/^\d+$/).optional()
      })
      .parse(req.body);

    res.json({
      ok: true,
      receipt: await undoMatch(payload)
    });
  } catch (error) {
    next(error);
  }
});
