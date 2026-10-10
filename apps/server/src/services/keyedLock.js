export function runWithKeyedLock(locks, key, task) {
  const normalizedKey = String(key);
  const previous = locks.get(normalizedKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);

  locks.set(normalizedKey, current);

  return current.finally(() => {
    if (locks.get(normalizedKey) === current) {
      locks.delete(normalizedKey);
    }
  });
}
