import { getAllRecords, getRecord, putMetadata, replaceSourceAtomically } from './db.js';
import { mergeEasyLists, parseEasyList, resolveSelectors } from './easylist.js';
import { createSuffixMatcher, hostEnabled, normalizeHostname, updateHostPreference } from './hosts.js';
import { refreshSource, sha256, SOURCE_CONFIG, validateAndCompile } from './source-validation.js';

export const DAILY_ALARM = 'clearspace-refresh-daily';
const RETRY_PREFIX = 'clearspace-refresh-retry-';
const PREFERENCES_KEY = 'hostPreferences';
const ONE_DAY_MINUTES = 24 * 60;
const ONE_HOUR_MINUTES = 60;


const DEFAULT_PREFERENCES = Object.freeze({ disabledPublicHosts: [], enabledPrivateHosts: [] });

export async function ensureDailyRefreshAlarm(alarms = chrome.alarms) {
  if (await alarms.get(DAILY_ALARM)) return;
  await alarms.create(DAILY_ALARM, {
    delayInMinutes: ONE_DAY_MINUTES,
    periodInMinutes: ONE_DAY_MINUTES,
  });
}

export function createWorkerService(alarms = chrome.alarms) {
  let initializationPromise;
  let hageziMatcher;
  let easyListRules;
  let overrideRules;
  let cosmeticRules;
  let preferenceWrites = Promise.resolve();

  function rebuildCosmeticRules() {
    if (!easyListRules || !overrideRules) throw new Error('Cosmetic rule caches are incomplete');
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
    if (!hagezi?.data || !('domains' in hagezi.data)
      || !easylist?.data || !('genericHides' in easylist.data)) {
      throw new Error('Rule database is incomplete');
    }
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
        await ensureDailyRefreshAlarm(alarms);
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
      lastResult: {
        at: now,
        kind: 'error',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
    await putMetadata(metadata);
    if (scheduleRetry) {
      await alarms.create(`${RETRY_PREFIX}${source.id}`, { delayInMinutes: ONE_HOUR_MINUTES });
    }
    return metadata.lastResult;
  }

  async function refreshOne(source, { scheduleRetry }) {
    const previous = await getRecord('metadata', source.id);
    try {
      const result = await refreshSource({ source, previous });
      let metadata;
      if (result.kind === 'replace') {
        metadata = {
          ...result.metadata,
          bundledSeed: false,
          lastResult: { at: Date.now(), kind: 'updated', ok: true },
        };
        await replaceSourceAtomically(source.id, result.text, result.compiled, metadata);
        if ('domains' in result.compiled) {
          hageziMatcher = createSuffixMatcher(result.compiled.domains);
        } else {
          easyListRules = result.compiled;
          rebuildCosmeticRules();
        }
      } else {
        const update = result.kind === 'unchanged-hash' ? result.metadata : { checkedAt: result.checkedAt };
        metadata = {
          ...previous,
          ...update,
          sourceId: source.id,
          url: source.url,
          checkedAt: update.checkedAt || Date.now(),
          lastResult: { at: Date.now(), kind: result.kind, ok: true },
        };
        await putMetadata(metadata);
      }
      await alarms.clear(`${RETRY_PREFIX}${source.id}`);
      return metadata.lastResult;
    } catch (error) {
      return updateRefreshFailure(source, error, scheduleRetry);
    }
  }

  async function refreshAll(options) {
    await initialize();
    const [hagezi, easylist] = await Promise.all([
      refreshOne(SOURCE_CONFIG.hagezi, options),
      refreshOne(SOURCE_CONFIG.easylist, options),
    ]);
    return { hagezi, easylist };
  }

  async function getRefreshStatus() {
    await initialize();
    const [metadata, preferences] = await Promise.all([getAllRecords('metadata'), getPreferences()]);
    const sources = {};
    for (const item of metadata) sources[item.sourceId] = item;
    return { sources, preferences };
  }

  async function getPagePolicy(hostname) {
    await initialize();
    const host = normalizeHostname(hostname);
    const preferences = await getPreferences();
    const enabled = hostEnabled(host, preferences);
    if (!enabled) return { enabled, hostname: host, selectors: [] };
    if (!cosmeticRules) throw new Error('Cosmetic rule cache is unavailable');
    return { enabled, hostname: host, selectors: resolveSelectors(cosmeticRules, host) };
  }

  async function classifyResources(pageHostname, hostnames) {
    await initialize();
    const pageHost = normalizeHostname(pageHostname);
    if (!hostEnabled(pageHost, await getPreferences())) return { matches: {} };
    const matcher = hageziMatcher;
    if (!matcher) throw new Error('Hagezi rule cache is unavailable');
    const matches = Object.fromEntries(hostnames.map((hostname) => {
      const host = normalizeHostname(hostname);
      return [host, matcher.has(host)];
    }));
    return { matches };
  }

  async function setHostEnabled(hostname, enabled) {
    const update = preferenceWrites.then(async () => {
      const preferences = updateHostPreference(await getPreferences(), hostname, enabled);
      await chrome.storage.local.set({ [PREFERENCES_KEY]: preferences });
      return { enabled: hostEnabled(hostname, preferences), preferences };
    });
    preferenceWrites = update.then(() => {}, () => {});
    return update;
  }

  async function handleAlarm(name) {
    if (name === DAILY_ALARM) {
      await refreshAll({ scheduleRetry: true });
      return;
    }
    if (!name.startsWith(RETRY_PREFIX)) return;
    const sourceId = name.slice(RETRY_PREFIX.length);
    if (sourceId === 'hagezi' || sourceId === 'easylist') {
      await refreshOne(SOURCE_CONFIG[sourceId], { scheduleRetry: false });
    }
  }

  return {
    initialize,
    getPagePolicy,
    classifyResources,
    refreshAll,
    getRefreshStatus,
    setHostEnabled,
    handleAlarm,
  };
}
