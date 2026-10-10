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
    const parsed = content.trim() ? JSON.parse(content) : [];
    entries = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    if (error instanceof SyntaxError) console.error(`Ignoring invalid activity journal at ${logPath}:`, error.message);
  }
  loaded = true;
}

async function persistJournal() {
  await mkdir(dirname(logPath), { recursive: true });
  const temporaryPath = `${logPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(entries, null, 2), 'utf8');
  await rename(temporaryPath, logPath);
}

function requireDatabase() {
  if (!isDatabaseConfigured()) {
    throw new Error('MySQL is required for activity history. Set DB_HOST, DB_NAME, DB_USER and DB_PASSWORD.');
  }
  return getDatabasePool();
}

function describeEntry(entry) {
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
  return { receiptId, action, eventType, actorType };
}

async function persistToDatabase(entry, connection = requireDatabase()) {
  const { receiptId, action, eventType, actorType } = describeEntry(entry);
  const [result] = await connection.query(
    'INSERT IGNORE INTO activity_events ' +
      '(legacy_id, event_type, receipt_id, bank_transaction_id, receipt_title, amount, currency, action_text, actor_type, actor_name, metadata, occurred_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [String(entry.id), eventType, receiptId, entry.bankTransactionId ?? null, entry.receiptTitle ?? null,
      entry.amount ?? null, entry.currency ?? null, action, actorType, entry.actor ?? null,
      JSON.stringify(entry), new Date(entry.createdAt)]
  );

  if (result.affectedRows === 1) {
    await connection.query(
      'INSERT INTO audit_events ' +
        '(operation_id, actor_type, actor_name, action, status, receipt_id, occurred_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
      [null, actorType, entry.actor ?? null, eventType, 'success', receiptId, new Date(entry.createdAt)]
    );
  }
}

async function replayJournal() {
  await ensureLoaded();
  if (!entries.length) return;
  const connection = await requireDatabase().getConnection();
  try {
    await connection.beginTransaction();
    for (const entry of entries) await persistToDatabase(entry, connection);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function readMetadata(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function getActivityLog() {
  await ensureLoaded();
  if (!isDatabaseConfigured() && env.NODE_ENV !== 'production') return entries.slice(0, 1000);
  await replayJournal();
  const [rows] = await requireDatabase().query(
    "SELECT metadata FROM activity_events WHERE event_type IN ('receipt_matched', 'receipt_unlinked', 'receipt_created') " +
      'ORDER BY occurred_at DESC, id DESC'
  );
  return rows.map((row) => readMetadata(row.metadata)).filter(Boolean);
}

export async function addActivity(entry) {
  await ensureLoaded();
  const nextEntry = {
    id: entry.id ?? `LOG-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: entry.createdAt ?? new Date().toISOString(),
    ...entry
  };

  // The journal is written first as a recovery path. MySQL remains mandatory
  // and authoritative; a DB failure is returned instead of being hidden.
  entries.unshift(nextEntry);
  writeQueue = writeQueue.then(persistJournal, persistJournal);
  await writeQueue;

  if (!isDatabaseConfigured() && env.NODE_ENV !== 'production') return nextEntry;

  const connection = await requireDatabase().getConnection();
  try {
    await connection.beginTransaction();
    await persistToDatabase(nextEntry, connection);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return nextEntry;
}
