import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { env } from '../config/env.js';

const trashPath = resolve(env.RECEIPT_TRASH_PATH ?? 'data/receipt-trash.json');
let loaded = false;
let receiptIds = new Set();
let writeQueue = Promise.resolve();

async function ensureLoaded() {
  if (loaded) return;
  try {
    const content = await readFile(trashPath, 'utf8');
    const parsed = content.trim() ? JSON.parse(content) : [];
    receiptIds = new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  loaded = true;
}

async function persist() {
  await mkdir(dirname(trashPath), { recursive: true });
  const temporaryPath = `${trashPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify([...receiptIds], null, 2), 'utf8');
  await rename(temporaryPath, trashPath);
}

async function update(receiptId, trashed) {
  await ensureLoaded();
  const id = String(receiptId);
  if (trashed) receiptIds.add(id);
  else receiptIds.delete(id);
  writeQueue = writeQueue.then(persist, persist);
  await writeQueue;
  return id;
}

export async function getTrashedReceiptIds() {
  await ensureLoaded();
  return new Set(receiptIds);
}

export function trashReceipt(receiptId) {
  return update(receiptId, true);
}

export function restoreReceipt(receiptId) {
  return update(receiptId, false);
}
