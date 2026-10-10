import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { env } from '../config/env.js';
import { fetchAmeriaTransactions } from './ameriaClient.js';
import { addActivity } from './activityStore.js';
import { importBankTransaction } from './matchEngine.js';

let activeSync = null;
let schedulerTimer = null;
let schedulerStartedAt = null;
let schedulerStateLoaded = false;
let schedulerStateLoading;
let schedulerState = {
  enabled: env.AMERIA_SYNC_ENABLED,
  fromDate: env.AMERIA_SYNC_FROM_DATE,
  fromTime: '00:00'
};
let schedulerWriteQueue = Promise.resolve();

const schedulerStatePath = resolve(env.AMERIA_SCHEDULER_STATE_PATH);
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

function getSyncRanges(params = {}) {
  const now = new Date();
  const dateFrom = String(params.dateFrom ?? env.AMERIA_SYNC_FROM_DATE);
  const dateTo = String(params.dateTo ?? toDateString(now));
  const requestParams = { ...params };
  delete requestParams.fromTime;
  const start = new Date(`${dateFrom}T00:00:00.000Z`);
  const end = new Date(`${dateTo}T00:00:00.000Z`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    const error = new Error('Invalid Ameria sync date range');
    error.status = 400;
    throw error;
  }

  const ranges = [];
  let cursor = start;
  while (cursor <= end) {
    const yearEnd = new Date(Date.UTC(cursor.getUTCFullYear(), 11, 31));
    const chunkEnd = yearEnd < end ? yearEnd : end;
    ranges.push({ ...requestParams, dateFrom: toDateString(cursor), dateTo: toDateString(chunkEnd) });
    cursor = new Date(chunkEnd.getTime() + 24 * 60 * 60 * 1000);
  }
  return ranges;
}

function transactionKey(transaction) {
  const account = transaction.accountNumber ?? '';
  const id = transaction.transactionId ?? transaction.bankTransactionId ?? transaction.transferId;
  return id ? `${account}:${id}` : null;
}

export function syncAmeriaTransactions(params = {}) {
  if (activeSync) return activeSync;

  activeSync = runSync(params).finally(() => {
    activeSync = null;
  });
  return activeSync;
}

async function runSync(params) {
  const transactionMap = new Map();
  let rangeCount = 0;

  for (const range of getSyncRanges(params)) {
    rangeCount += 1;
    const transactions = await fetchAmeriaTransactions(range);
    for (const transaction of transactions) {
      const key = transactionKey(transaction);
      if (key) transactionMap.set(key, transaction);
      else transactionMap.set(Symbol(), transaction);
    }
  }

  const transactions = [...transactionMap.values()].filter((transaction) => isTransactionAtOrAfter(transaction, params));
  const results = [];

  for (const transaction of transactions) {
    results.push(await importBankTransaction(transaction));
  }

  const imported = results.filter((result) => result.created).length;
  const skipped = results.length - imported;
  await addActivity({
    receiptId: '-',
    action: `Ameriabank sync completed: ${imported} imported, ${skipped} skipped`,
    actor: 'System'
  });

  return {
    ok: true,
    received: transactions.length,
    imported,
    skipped,
    ranges: rangeCount,
    receipts: results.map((result) => result.receipt)
  };
}

function currentSchedulerStatus() {
  return {
    running: Boolean(schedulerTimer),
    enabled: schedulerState.enabled,
    startedAt: schedulerStartedAt,
    intervalMs: env.AMERIA_SYNC_INTERVAL_MS,
    fromDate: schedulerState.fromDate,
    fromTime: schedulerState.fromTime
  };
}

export async function getAmeriaSchedulerStatus() {
  await ensureSchedulerStateLoaded();
  return currentSchedulerStatus();
}

export async function restoreAmeriaScheduler() {
  await ensureSchedulerStateLoaded();
  if (!schedulerState.enabled) return currentSchedulerStatus();
  return startSchedulerTimer({ runImmediately: env.AMERIA_SYNC_RUN_ON_START });
}

export async function startAmeriaScheduler({ force = false, runImmediately = false, dateFrom, fromTime } = {}) {
  await ensureSchedulerStateLoaded();
  if (!force && !schedulerState.enabled) return currentSchedulerStatus();

  const nextState = normalizeSchedulerState({
    enabled: true,
    fromDate: dateFrom ?? schedulerState.fromDate,
    fromTime: fromTime ?? schedulerState.fromTime
  });
  const configurationChanged = nextState.fromDate !== schedulerState.fromDate || nextState.fromTime !== schedulerState.fromTime;
  schedulerState = nextState;
  await persistSchedulerState();

  if (schedulerTimer && !configurationChanged) return currentSchedulerStatus();
  if (schedulerTimer) globalThis.clearInterval(schedulerTimer);
  schedulerTimer = null;
  return startSchedulerTimer({ runImmediately });
}

function startSchedulerTimer({ runImmediately = false } = {}) {
  const syncParams = { dateFrom: schedulerState.fromDate, fromTime: schedulerState.fromTime };

  const run = () => {
    syncAmeriaTransactions(syncParams).catch((error) => {
      console.error('Scheduled Ameriabank sync failed:', error.message);
    });
  };
  const timer = setInterval(run, env.AMERIA_SYNC_INTERVAL_MS);
  timer.unref();
  schedulerTimer = timer;
  schedulerStartedAt = new Date().toISOString();

  if (runImmediately || env.AMERIA_SYNC_RUN_ON_START) run();
  return currentSchedulerStatus();
}

export async function stopAmeriaScheduler() {
  await ensureSchedulerStateLoaded();
  if (schedulerTimer) globalThis.clearInterval(schedulerTimer);
  schedulerTimer = null;
  schedulerStartedAt = null;
  schedulerState = { ...schedulerState, enabled: false };
  await persistSchedulerState();
  return currentSchedulerStatus();
}

async function ensureSchedulerStateLoaded() {
  if (schedulerStateLoaded) return;
  if (schedulerStateLoading) return schedulerStateLoading;

  schedulerStateLoading = (async () => {
    try {
      const content = await readFile(schedulerStatePath, 'utf8');
      schedulerState = normalizeSchedulerState(JSON.parse(content));
    } catch (error) {
      const invalidSavedState = error instanceof SyntaxError || error.status === 400;
      if (error.code !== 'ENOENT' && !invalidSavedState) throw error;
      if (invalidSavedState) {
        console.error(`Ignoring invalid scheduler state at ${schedulerStatePath}:`, error.message);
      }
      schedulerState = normalizeSchedulerState(schedulerState);
    }

    schedulerStateLoaded = true;
  })();

  return schedulerStateLoading;
}

function normalizeSchedulerState(state) {
  const fromDate = String(state.fromDate ?? env.AMERIA_SYNC_FROM_DATE);
  const fromTime = String(state.fromTime ?? '00:00');
  const date = new Date(`${fromDate}T00:00:00.000Z`);

  if (!datePattern.test(fromDate) || Number.isNaN(date.getTime()) || toDateString(date) !== fromDate) {
    const error = new Error('Invalid scheduler start date');
    error.status = 400;
    throw error;
  }
  if (!timePattern.test(fromTime)) {
    const error = new Error('Invalid scheduler start time');
    error.status = 400;
    throw error;
  }

  return { enabled: Boolean(state.enabled), fromDate, fromTime };
}

function persistSchedulerState() {
  const snapshot = { ...schedulerState, updatedAt: new Date().toISOString() };
  const writeSnapshot = async () => {
    await mkdir(dirname(schedulerStatePath), { recursive: true });
    const temporaryPath = `${schedulerStatePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2), 'utf8');
    await rename(temporaryPath, schedulerStatePath);
  };
  schedulerWriteQueue = schedulerWriteQueue.then(writeSnapshot, writeSnapshot);
  return schedulerWriteQueue;
}

function isTransactionAtOrAfter(transaction, params) {
  if (!params.fromTime) return true;

  const cutoff = new Date(`${params.dateFrom}T${params.fromTime}:00+04:00`);
  const rawTimestamp = transaction.paymentDate ?? transaction.operationDate ?? transaction.creationDate;
  if (!rawTimestamp || Number.isNaN(cutoff.getTime())) return true;

  const transactionTime = new Date(rawTimestamp);
  return Number.isNaN(transactionTime.getTime()) || transactionTime >= cutoff;
}
