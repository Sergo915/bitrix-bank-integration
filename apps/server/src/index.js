import { setTimeout as scheduleAfter } from 'node:timers';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { ameriaRouter } from './routes/ameria.js';
import { adminRouter } from './routes/admin.js';
import { bitrixRouter } from './routes/bitrix.js';
import { healthRouter } from './routes/health.js';
import { receiptsRouter } from './routes/receipts.js';
import { refreshReceiptBoardCache, syncReceiptBoard } from './services/matchEngine.js';
import { loadPersistedSessions } from './services/bitrixSession.js';
import { restoreAmeriaScheduler } from './services/syncService.js';

const app = express();

app.use(helmet());
app.use(cors({ origin: env.CLIENT_ORIGIN }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use('/api/health', healthRouter);
app.use('/api/bitrix', bitrixRouter);
app.use('/api/ameria', ameriaRouter);
app.use('/api/admin', adminRouter);
app.use('/api/receipts', receiptsRouter);

app.use((error, _req, res, _next) => {
  const status = error.name === 'ZodError' ? 400 : error.status ?? error.response?.status ?? 500;
  const message = error.response?.data?.message ?? error.message ?? 'Unexpected server error';

  res.status(status).json({
    error: message
  });
});

app.listen(env.SERVER_PORT, async () => {
  console.log(`Server listening on http://localhost:${env.SERVER_PORT}`);

  try {
    const restored = await loadPersistedSessions();
    if (restored) console.log(`Restored ${restored} Bitrix session(s)`);
  } catch (error) {
    console.error('Could not restore Bitrix sessions:', error.message);
  }

  try {
    await restoreAmeriaScheduler();
  } catch (error) {
    console.error('Could not restore Ameria scheduler:', error.message);
  }

  startReceiptBoardWarmUp();
});

// Two clocks, because the two jobs cost three orders of magnitude apart.
//
// A delta sync asks Bitrix for the vouchers touched since the last one -- a single request,
// a few hundred milliseconds -- and patches those receipts into the cached board. It is what
// makes a receipt created in Bitrix show up in the app by itself.
//
// A full rebuild walks every voucher, deal and contact and takes minutes. It only exists for
// the figures a delta cannot recompute: suggestions, schedule balances, the payment timeline.
// Running it on the delta's clock was the old behaviour and it never stopped: a rebuild took
// longer than the gap, so the next one began as soon as it ended, around the clock.
function startReceiptBoardWarmUp() {
  const syncGap = Math.max(env.RECEIPT_BOARD_CACHE_TTL_MS, 15000);
  const rebuildGap = Math.max(env.RECEIPT_BOARD_FULL_REBUILD_MS, syncGap);

  const runSync = async () => {
    try {
      await syncReceiptBoard();
    } catch (error) {
      console.error('Receipt board sync failed:', error.message);
    } finally {
      scheduleAfter(runSync, syncGap).unref();
    }
  };

  // Measured from the end of the previous rebuild, so a slow one cannot queue the next.
  const runRebuild = async () => {
    try {
      await refreshReceiptBoardCache();
    } catch (error) {
      console.error('Receipt board rebuild failed:', error.message);
    } finally {
      scheduleAfter(runRebuild, rebuildGap).unref();
    }
  };

  runRebuild();
  scheduleAfter(runSync, syncGap).unref();
}
