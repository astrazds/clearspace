import { SOURCE_CONFIG } from './source-validation.js';

const DAILY_NAME = 'clearspace-refresh-daily';
const DAILY_MINUTES = 24 * 60;
const RETRY_PREFIX = 'clearspace-refresh-retry-';
const RETRY_MINUTES = 60;

/** @typedef {import('./source-validation.js').SourceId} SourceId */

/**
 * @typedef {{ readonly kind: 'daily' }
 *   | { readonly kind: 'retry', readonly sourceId: SourceId }
 *   | { readonly kind: 'ignore' }} RefreshSignal
 */

/**
 * @typedef {{
 *   ensureDailyDeadline(): Promise<void>,
 *   armRetry(sourceId: SourceId): Promise<void>,
 *   disarmRetry(sourceId: SourceId): Promise<void>,
 *   read(alarmName: string): RefreshSignal,
 * }} RefreshClock
 */

/**
 * @typedef {{
 *   get(name: string): Promise<chrome.alarms.Alarm | undefined>,
 *   create(name: string, alarmInfo: chrome.alarms.AlarmCreateInfo): Promise<void>,
 *   clear(name: string): Promise<boolean>,
 * }} AlarmHost
 */

/**
 * @param {string} value
 * @returns {value is SourceId}
 */
function isSourceId(value) {
  return Object.hasOwn(SOURCE_CONFIG, value);
}

/**
 * @param {SourceId} sourceId
 * @returns {string}
 */
function retryAlarmName(sourceId) {
  return `${RETRY_PREFIX}${sourceId}`;
}

/**
 * @param {string} alarmName
 * @returns {RefreshSignal}
 */
function readAlarmName(alarmName) {
  if (alarmName === DAILY_NAME) return { kind: 'daily' };
  if (!alarmName.startsWith(RETRY_PREFIX)) return { kind: 'ignore' };
  const sourceId = alarmName.slice(RETRY_PREFIX.length);
  if (!isSourceId(sourceId)) return { kind: 'ignore' };
  return { kind: 'retry', sourceId };
}

/**
 * @param {AlarmHost} [raw]
 * @returns {RefreshClock}
 */
export function createRefreshClock(raw = chrome.alarms) {
  return {
    async ensureDailyDeadline() {
      if (await raw.get(DAILY_NAME)) return;
      await raw.create(DAILY_NAME, {
        delayInMinutes: DAILY_MINUTES,
        periodInMinutes: DAILY_MINUTES,
      });
    },
    async armRetry(sourceId) {
      await raw.create(retryAlarmName(sourceId), { delayInMinutes: RETRY_MINUTES });
    },
    async disarmRetry(sourceId) {
      await raw.clear(retryAlarmName(sourceId));
    },
    read: readAlarmName,
  };
}
