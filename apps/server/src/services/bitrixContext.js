import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function runWithBitrixSession(session, callback) {
  return storage.run(session, callback);
}

export function getCurrentBitrixSession() {
  return storage.getStore() ?? null;
}
