import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const testDirectory = await mkdtemp(join(tmpdir(), 'milon-scheduler-'));
const statePath = join(testDirectory, 'scheduler-state.json');
process.env.AMERIA_SCHEDULER_STATE_PATH = statePath;
process.env.AMERIA_SYNC_ENABLED = 'false';

const {
  getAmeriaSchedulerStatus,
  startAmeriaScheduler,
  stopAmeriaScheduler
} = await import('../src/services/syncService.js');

test.after(async () => {
  await stopAmeriaScheduler();
  await rm(testDirectory, { recursive: true, force: true });
});

test('persists scheduler start settings and explicit stop state', async () => {
  const started = await startAmeriaScheduler({
    force: true,
    dateFrom: '2026-09-12',
    fromTime: '14:35'
  });

  assert.equal(started.running, true);
  assert.equal(started.enabled, true);
  assert.equal(started.fromDate, '2026-09-12');
  assert.equal(started.fromTime, '14:35');

  const savedStart = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(savedStart.enabled, true);
  assert.equal(savedStart.fromDate, '2026-09-12');
  assert.equal(savedStart.fromTime, '14:35');

  const stopped = await stopAmeriaScheduler();
  assert.equal(stopped.running, false);
  assert.equal(stopped.enabled, false);
  assert.equal((await getAmeriaSchedulerStatus()).enabled, false);

  const savedStop = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(savedStop.enabled, false);
});
