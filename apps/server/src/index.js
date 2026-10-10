import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { ameriaRouter } from './routes/ameria.js';
import { adminRouter } from './routes/admin.js';
import { bitrixRouter } from './routes/bitrix.js';
import { healthRouter } from './routes/health.js';
import { receiptsRouter } from './routes/receipts.js';
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
});
