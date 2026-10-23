import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshClock } from '../src/refresh-clock.js';

const DAILY_NAME = 'clearspace-refresh-daily';

/**
 * @param {{
 *   get?: (name: string) => Promise<{ name: string, scheduledTime: number, periodInMinutes: number } | undefined>,
 * }} [behavior]
 */
function recordingHost(behavior = {}) {
  /** @type {unknown[]} */
  const creates = [];
  /** @type {unknown[]} */
  const clears = [];
  const clock = createRefreshClock({
    get: behavior.get || (async () => undefined),
    create: async (...args) => {
      creates.push(args);
    },
    clear: async (...args) => {
      clears.push(args);
      return true;
    },
  });
  return { clock, creates, clears };
}

test('daily refresh alarm keeps an existing deadline and creates only when absent', async () => {
  const existing = { name: DAILY_NAME, scheduledTime: 123, periodInMinutes: 1_440 };
  const kept = recordingHost({ get: async () => existing });
  await kept.clock.ensureDailyDeadline();
  assert.deepEqual(kept.creates, []);

  const missing = recordingHost();
  await missing.clock.ensureDailyDeadline();
  assert.deepEqual(missing.creates, [[DAILY_NAME, {
    delayInMinutes: 1_440,
    periodInMinutes: 1_440,
  }]]);
});

test('retry alarms are named by source id and a fired name is daily, retry, or ignore', async () => {
  const host = recordingHost();
  await host.clock.armRetry('hagezi');
  await host.clock.armRetry('easylist');
  await host.clock.disarmRetry('hagezi');
  assert.deepEqual(host.creates, [
    ['clearspace-refresh-retry-hagezi', { delayInMinutes: 60 }],
    ['clearspace-refresh-retry-easylist', { delayInMinutes: 60 }],
  ]);
  assert.deepEqual(host.clears, [['clearspace-refresh-retry-hagezi']]);
  assert.deepEqual(host.clock.read(DAILY_NAME), { kind: 'daily' });
  assert.deepEqual(host.clock.read('clearspace-refresh-retry-easylist'), {
    kind: 'retry',
    sourceId: 'easylist',
  });
  assert.deepEqual(host.clock.read('clearspace-refresh-retry-other'), { kind: 'ignore' });
  assert.deepEqual(host.clock.read('unrelated'), { kind: 'ignore' });
});
