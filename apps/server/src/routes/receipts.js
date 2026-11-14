import { Router } from 'express';
import { z } from 'zod';
import {
  confirmMatch,
  importBankTransaction,
  listBuildingOptions,
  listCachedReceipts,
  listReceipts,
  normalizeApartmentSearchInput,
  syncReceiptBoard,
  restoreReceiptOnBoard,
  searchDeals,
  trashReceiptOnBoard,
  undoMatch
} from '../services/matchEngine.js';
import { requireBitrixSession } from '../services/bitrixSession.js';
import { restoreReceipt, trashReceipt } from '../services/receiptTrashStore.js';

export const receiptsRouter = Router();

receiptsRouter.use(requireBitrixSession);

receiptsRouter.get('/', async (req, res, next) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    res.json(await (forceRefresh ? listReceipts() : listCachedReceipts()));
  } catch (error) {
    next(error);
  }
});

// What the refresh button calls, and what the open board polls. It asks Bitrix only about the
// receipts touched since the last sync -- plus any the caller names -- and answers with just
// those, so the client patches the few rows that changed instead of re-downloading the board.
// The full rebuild behind GET /?refresh=1 takes minutes; this takes well under a second.
receiptsRouter.get('/updates', async (req, res, next) => {
  try {
    const { receiptIds } = z
      .object({
        receiptIds: z
          .string()
          .trim()
          .max(500)
          .optional()
          .default('')
          .transform((value) => value.split(',').map((id) => id.trim()).filter((id) => /^\d+$/u.test(id)))
      })
      .parse(req.query);

    const result = await syncReceiptBoard({ receiptIds, reason: 'client' });

    res.json({
      receipts: result.receipts,
      removedIds: result.removedIds,
      rebuilt: Boolean(result.rebuilt),
      syncedAt: result.syncedAt,
      log: result.log ?? result.board?.log ?? []
    });
  } catch (error) {
    next(error);
  }
});

receiptsRouter.post('/trash', async (req, res, next) => {
  try {
    const { receiptId } = z.object({ receiptId: z.string().regex(/^\d+$/) }).parse(req.body);
    await trashReceipt(receiptId);
    await trashReceiptOnBoard(receiptId);
    res.json({ ok: true, receiptId });
  } catch (error) {
    next(error);
  }
});

receiptsRouter.post('/trash/restore', async (req, res, next) => {
  try {
    const { receiptId } = z.object({ receiptId: z.string().regex(/^\d+$/) }).parse(req.body);
    await restoreReceipt(receiptId);
    await restoreReceiptOnBoard(receiptId);
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
