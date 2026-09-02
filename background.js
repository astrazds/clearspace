import { getAllRecords, getRecord, putMetadata, replaceSourceAtomically } from './src/db.js';
import { mergeEasyLists, parseEasyList, resolveSelectors } from './src/easylist.js';
import { createSuffixMatcher, hostEnabled, normalizeHostname, updateHostPreference } from './src/hosts.js';
import { MESSAGE, PROTOCOL_VERSION } from './src/protocol.js';
import { refreshSource, sha256, SOURCE_CONFIG, validateAndCompile } from './src/source-validation.js';

const DAILY_ALARM = 'clearspace-refresh-daily';
const RETRY_PREFIX = 'clearspace-refresh-retry-';
const PREFERENCES_KEY = 'hostPreferences';
const ONE_DAY_MINUTES = 24 * 60;
const ONE_HOUR_MINUTES = 60;
const DEFAULT_PREFERENCES = Object.freeze({ disabledPublicHosts: [], enabledPrivateHosts: [] });

let initializationPromise;
let hageziMatcher;
let easyListRules;
let overrideRules;
let cosmeticRules;

function rebuildCosmeticRules() {
  cosmeticRules = mergeEasyLists(easyListRules, overrideRules);
}

async function getPreferences() {
  const stored = await chrome.storage.local.get(PREFERENCES_KEY);
  return { ...DEFAULT_PREFERENCES, ...(stored[PREFERENCES_KEY] || {}) };
}

async function loadOverrideRules() {
  if (overrideRules) return overrideRules;
  const response = await fetch(chrome.runtime.getURL('rules/overrides.txt'));
  if (!response.ok) throw new Error('Bundled overrides could not be loaded');
  overrideRules = parseEasyList(await response.text());
  return overrideRules;
}

async function seedSource(source) {
  if (await getRecord('metadata', source.id)) return;
  const response = await fetch(chrome.runtime.getURL(source.seedPath));
  if (!response.ok) throw new Error(`${source.name} seed could not be loaded`);
  const text = await response.text();
  const compiled = validateAndCompile(source.id, text);
  const now = Date.now();
  const hash = await sha256(text);
  await replaceSourceAtomically(source.id, text, compiled, {
    sourceId: source.id,
    url: source.url,
    hash,
    version: compiled.version || `seed-${hash.slice(0, 12)}`,
    fetchedAt: now,
    checkedAt: now,
    sizeBytes: new TextEncoder().encode(text).length,
    stats: compiled.stats,
    bundledSeed: true,
    lastResult: { at: now, kind: 'bundled-seed', ok: true },
  });
}

async function hydrateCaches() {
  const [hagezi, easylist] = await Promise.all([
    getRecord('compiled', 'hagezi'),
    getRecord('compiled', 'easylist'),
  ]);
  if (!hagezi?.data || !easylist?.data) throw new Error('Rule database is incomplete');
  hageziMatcher = createSuffixMatcher(hagezi.data.domains);
  easyListRules = easylist.data;
  await loadOverrideRules();
  rebuildCosmeticRules();
}

async function initialize() {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      await Promise.all(Object.values(SOURCE_CONFIG).map(seedSource));
      await hydrateCaches();
      chrome.alarms.create(DAILY_ALARM, { delayInMinutes: ONE_DAY_MINUTES, periodInMinutes: ONE_DAY_MINUTES });
    })().catch((error) => {
      initializationPromise = undefined;
      throw error;
    });
  }
  return initializationPromise;
}

async function updateRefreshFailure(source, error, scheduleRetry) {
  const previous = await getRecord('metadata', source.id);
  const now = Date.now();
  const metadata = {
    ...(previous || { sourceId: source.id, url: source.url }),
    checkedAt: now,
    lastResult: { at: now, kind: 'error', ok: false, error: String(error?.message || error) },
  };
  await putMetadata(metadata);
  if (scheduleRetry) chrome.alarms.create(`${RETRY_PREFIX}${source.id}`, { delayInMinutes: ONE_HOUR_MINUTES });
  return metadata.lastResult;
}

async function refreshOne(source, { scheduleRetry = true } = {}) {
  const previous = await getRecord('metadata', source.id);
  try {
    const result = await refreshSource({ source, previous });
    let metadata;
    if (result.kind === 'replace') {
      metadata = { ...result.metadata, bundledSeed: false, lastResult: { at: Date.now(), kind: 'updated', ok: true } };
      await replaceSourceAtomically(source.id, result.text, result.compiled, metadata);
      if (source.id === 'hagezi') hageziMatcher = createSuffixMatcher(result.compiled.domains);
      if (source.id === 'easylist') {
        easyListRules = result.compiled;
        rebuildCosmeticRules();
      }
    } else {
      metadata = {
        ...previous,
        ...(result.metadata || {}),
        checkedAt: result.checkedAt || result.metadata?.checkedAt || Date.now(),
        lastResult: { at: Date.now(), kind: result.kind, ok: true },
      };
      await putMetadata(metadata);
    }
    await chrome.alarms.clear(`${RETRY_PREFIX}${source.id}`);
    return metadata.lastResult;
  } catch (error) {
    return updateRefreshFailure(source, error, scheduleRetry);
  }
}

async function refreshAll(options) {
  await initialize();
  const entries = await Promise.all(Object.values(SOURCE_CONFIG).map(async (source) => [source.id, await refreshOne(source, options)]));
  return Object.fromEntries(entries);
}

async function getStatus() {
  await initialize();
  const [metadata, preferences] = await Promise.all([getAllRecords('metadata'), getPreferences()]);
  return { sources: Object.fromEntries(metadata.map((item) => [item.sourceId, item])), preferences };
}

async function applicableSelectors(hostname) {
  await initialize();
  const host = normalizeHostname(hostname);
  const preferences = await getPreferences();
  const enabled = hostEnabled(host, preferences);
  if (!enabled) return { enabled, hostname: host, selectors: [] };
  return { enabled, hostname: host, selectors: resolveSelectors(cosmeticRules, host) };
}

chrome.runtime.onInstalled.addListener(() => {
  initialize().catch((error) => console.error('Clearspace initialization failed', error));
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch((error) => console.error('Clearspace initialization failed', error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAILY_ALARM) {
    refreshAll({ scheduleRetry: true }).catch((error) => console.error('Clearspace refresh failed', error));
    return;
  }
  if (alarm.name.startsWith(RETRY_PREFIX)) {
    const source = SOURCE_CONFIG[alarm.name.slice(RETRY_PREFIX.length)];
    if (source) refreshOne(source, { scheduleRetry: false }).catch((error) => console.error('Clearspace retry failed', error));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = async () => {
    if (!message || message.version !== PROTOCOL_VERSION) throw new Error('Unsupported Clearspace message version');
    if (message.type === MESSAGE.GET_APPLICABLE_SELECTORS) return applicableSelectors(message.hostname);
    if (message.type === MESSAGE.CLASSIFY_HOSTNAMES) {
      await initialize();
      const pageHost = normalizeHostname(message.pageHostname || new URL(sender.url || sender.tab?.url || '').hostname);
      if (!hostEnabled(pageHost, await getPreferences())) return { matches: {} };
      const matches = Object.fromEntries((message.hostnames || []).map((hostname) => {
        const host = normalizeHostname(hostname);
        return [host, hageziMatcher.has(host)];
      }));
      return { matches };
    }
    if (message.type === MESSAGE.REFRESH_SOURCES) return { results: await refreshAll({ scheduleRetry: true }) };
    if (message.type === MESSAGE.GET_REFRESH_STATUS) return getStatus();
    if (message.type === MESSAGE.SET_HOST_PREFERENCE) {
      const preferences = updateHostPreference(await getPreferences(), message.hostname, Boolean(message.enabled));
      await chrome.storage.local.set({ [PREFERENCES_KEY]: preferences });
      return { enabled: hostEnabled(message.hostname, preferences), preferences };
    }
    throw new Error(`Unknown Clearspace message: ${message.type}`);
  };

  respond().then((result) => sendResponse({ ok: true, ...result })).catch((error) => {
    sendResponse({ ok: false, error: String(error?.message || error) });
  });
  return true;
});

initialize().catch((error) => console.error('Clearspace initialization failed', error));
