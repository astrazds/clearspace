import test from 'node:test';
import assert from 'node:assert/strict';
import { DAILY_ALARM, ensureDailyRefreshAlarm } from '../src/worker-service.js';

test('daily refresh alarm keeps an existing deadline and creates only when absent', async () => {
  const existing = { name: DAILY_ALARM, scheduledTime: 123, periodInMinutes: 1_440 };
  const existingCreates = [];
  await ensureDailyRefreshAlarm({
    get: async () => existing,
    create: async (...args) => existingCreates.push(args),
  });
  assert.deepEqual(existingCreates, []);

  const missingCreates = [];
  await ensureDailyRefreshAlarm({
    get: async () => undefined,
    create: async (...args) => missingCreates.push(args),
  });
  assert.deepEqual(missingCreates, [[DAILY_ALARM, {
    delayInMinutes: 1_440,
    periodInMinutes: 1_440,
  }]]);
});
