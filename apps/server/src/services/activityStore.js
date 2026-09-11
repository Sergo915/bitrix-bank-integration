import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { env } from '../config/env.js';
import { getDatabasePool, isDatabaseConfigured } from './mysql.js';

const logPath = resolve(env.ACTIVITY_LOG_PATH ?? 'data/activity-log.json');
let loaded = false;
let entries = [];
let writeQueue = Promise.resolve();

async function ensureLoaded() {
  if (loaded) return;

  try {
    const content = await readFile(logPath, 'utf8');
    const parsed = JSON.parse(content);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  loaded = true;
}

async function persist() {
  await mkdir(dirname(logPath), { recursive: true });
  const temporaryPath = logPath + '.' + process.pid + '.tmp';
  await writeFile(temporaryPath, JSON.stringify(entries, null, 2), 'utf8');
  await rename(temporaryPath, logPath);
}

async function persistToDatabase(entry) {
  if (!isDatabaseConfigured()) return;

  const receiptId = /^\d+$/u.test(String(entry.receiptId ?? '')) ? Number(entry.receiptId) : null;
  const action = String(entry.action ?? '');
  const eventType = action.startsWith('Receipt matched')
    ? 'receipt_matched'
    : action.startsWith('Receipt unlinked')
      ? 'receipt_unlinked'
      : action === 'Bank receipt was created in Bitrix'
        ? 'receipt_created'
        : action.startsWith('Ameriabank sync completed')
          ? 'sync_completed'
          : 'activity';
  const actorType = String(entry.actor ?? '').toLowerCase() === 'system' ? 'system' : 'user';
  const pool = getDatabasePool();

  await pool.query(
    'INSERT INTO activity_events ' +
      '(legacy_id, event_type, receipt_id, bank_transaction_id, receipt_title, amount, currency, action_text, actor_type, actor_name, metadata, occurred_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      String(entry.id),
      eventType,
      receiptId,
      entry.bankTransactionId ?? null,
      entry.receiptTitle ?? null,
      entry.amount ?? null,
      entry.currency ?? null,
      action,
      actorType,
      entry.actor ?? null,
      JSON.stringify(entry),
      new Date(entry.createdAt)
    ]
  );

  await pool.query(
    'INSERT INTO audit_events ' +
      '(operation_id, actor_type, actor_name, action, status, receipt_id, occurred_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
    [null, actorType, entry.actor ?? null, eventType, 'success', receiptId, new Date(entry.createdAt)]
  );
}

export async function getActivityLog() {
  await ensureLoaded();
  return entries.slice();
}

export async function addActivity(entry) {
  await ensureLoaded();
  const nextEntry = {
    id: entry.id ?? ('LOG-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)),
    createdAt: entry.createdAt ?? new Date().toISOString(),
    ...entry
  };

  entries.unshift(nextEntry);
  entries = entries.slice(0, 1000);
  writeQueue = writeQueue.then(persist, persist);
  try {
    await writeQueue;
  } catch (error) {
    // Activity history is auxiliary data. A filesystem permission or disk error must not
    // roll back a successful Bitrix business operation that recorded this event.
    console.error('Could not persist activity log:', error.message);
  }

  try {
    await persistToDatabase(nextEntry);
  } catch (error) {
    console.error('Could not persist activity event to MySQL:', error.message);
  }

  return nextEntry;
}
