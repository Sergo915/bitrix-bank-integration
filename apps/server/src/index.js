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
import { refreshReceiptBoardCache } from './services/matchEngine.js';
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
    await restoreAmeriaScheduler();
  } catch (error) {
    console.error('Could not restore Ameria scheduler:', error.message);
  }

  startReceiptBoardWarmUp();
});

// Rebuilding the board walks every voucher, deal and schedule in Bitrix and takes about two
// minutes, which is longer than the proxy will wait. Bitrix's own guidance is to keep work
// like this out of the request path, so it runs on a timer here and readers are always served
// from the cache instead of waiting for a cold rebuild.
// The gap is measured from the end of the previous rebuild, not from its start. On a fixed
// interval a rebuild that takes longer than the interval means the next one starts the moment
// it finishes: the process then rebuilds without pause, burning about half a core around the
// clock and stalling interactive requests whenever it reaches its CPU-heavy phase.
function startReceiptBoardWarmUp() {
  const gap = Math.max(env.RECEIPT_BOARD_CACHE_TTL_MS, 60000);

  const warmUp = async () => {
    try {
      await refreshReceiptBoardCache();
    } catch (error) {
      console.error('Receipt board warm-up failed:', error.message);
    } finally {
      scheduleAfter(warmUp, gap).unref();
    }
  };

  warmUp();
}
