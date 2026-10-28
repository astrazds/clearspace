import { getAllRecords, getRecord, putMetadata, replaceSourceAtomically } from './db.js';
import { mergeEasyLists, parseEasyList, resolveSelectors } from './easylist.js';
import { createSuffixMatcher, hostEnabled, normalizeHostname, updateHostPreference } from './hosts.js';
import { createRefreshClock } from './refresh-clock.js';
import { refreshSource, sha256, SOURCE_CONFIG, validateAndCompile } from './source-validation.js';

const PREFERENCES_KEY = 'hostPreferences';

/** @typedef {import('./hosts.js').HostPreferences} HostPreferences */
/** @typedef {import('./refresh-clock.js').RefreshClock} RefreshClock */
/** @typedef {import('./source-validation.js').RefreshResult} RefreshResult */
/** @typedef {import('./source-validation.js').SeedSourceDefinition} SeedSourceDefinition */
/** @typedef {import('./source-validation.js').SourceId} SourceId */
/** @typedef {import('./source-validation.js').SourceMetadata} SourceMetadata */
/** @typedef {{ scheduleRetry: boolean }} RefreshOptions */

/** @type {Readonly<HostPreferences>} */
const DEFAULT_PREFERENCES = Object.freeze({ disabledPublicHosts: [], enabledPrivateHosts: [] });

/**
 * Own the worker's cached rules, persistence operations, refresh policy, and preferences.
 *
 * @param {RefreshClock} [clock]
 */
export function createWorkerService(clock = createRefreshClock()) {
  /** @type {Promise<void> | undefined} */
  let initializationPromise;
  /** @type {ReturnType<typeof createSuffixMatcher> | undefined} */
  let hageziMatcher;
  /** @type {ReturnType<typeof parseEasyList> | undefined} */
  let easyListRules;
  /** @type {ReturnType<typeof parseEasyList> | undefined} */
  let overrideRules;
  /** @type {ReturnType<typeof parseEasyList> | undefined} */
  let cosmeticRules;
  /** @type {Promise<void>} */
  let preferenceWrites = Promise.resolve();
  /** @type {Map<SourceId, Promise<void>>} */
  const sourceRefreshes = new Map();

  function rebuildCosmeticRules() {
    if (!easyListRules || !overrideRules) throw new Error('Cosmetic rule caches are incomplete');
    cosmeticRules = mergeEasyLists(easyListRules, overrideRules);
  }

  /** @returns {Promise<HostPreferences>} */
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

  /**
   * @param {SeedSourceDefinition} source
   * @returns {Promise<void>}
   */
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

  /** @returns {Promise<void>} */
  async function initialize() {
    if (!initializationPromise) {
      initializationPromise = (async () => {
        await Promise.all(Object.values(SOURCE_CONFIG).map(seedSource));
        await hydrateCaches();
        await clock.ensureDailyDeadline();
      })().catch((error) => {
        initializationPromise = undefined;
        throw error;
      });
    }
    return initializationPromise;
  }

  /**
   * @param {SeedSourceDefinition} source
   * @param {unknown} error
   * @param {boolean} scheduleRetry
   * @returns {Promise<RefreshResult>}
   */
  async function updateRefreshFailure(source, error, scheduleRetry) {
    const previous = await getRecord('metadata', source.id);
    const now = Date.now();
    /** @type {SourceMetadata & { lastResult: RefreshResult }} */
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
    if (scheduleRetry) await clock.armRetry(source.id);
    return metadata.lastResult;
  }

  /**
   * @param {SeedSourceDefinition} source
   * @param {RefreshOptions} options
   * @returns {Promise<RefreshResult>}
   */
  async function performRefresh(source, { scheduleRetry }) {
    const previous = await getRecord('metadata', source.id);
    try {
      const result = await refreshSource({ source, previous });
      /** @type {SourceMetadata & { lastResult: RefreshResult }} */
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
      await clock.disarmRetry(source.id);
      return metadata.lastResult;
    } catch (error) {
      return updateRefreshFailure(source, error, scheduleRetry);
    }
  }

  /**
   * Serialize the entire read/download/publish operation, including metadata-only
   * results. Different sources can still refresh independently.
   * @param {SeedSourceDefinition} source
   * @param {RefreshOptions} options
   */
  function refreshOne(source, options) {
    const operation = (sourceRefreshes.get(source.id) || Promise.resolve()).then(async () => {
      await initialize();
      return performRefresh(source, options);
    });
    sourceRefreshes.set(source.id, operation.then(() => {}, () => {}));
    return operation;
  }

  /**
   * @param {RefreshOptions} options
   * @returns {Promise<Record<SourceId, RefreshResult>>}
   */
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
    /** @type {Partial<Record<SourceId, SourceMetadata>>} */
    const sources = {};
    for (const item of metadata) sources[item.sourceId] = item;
    return { sources, preferences };
  }

  /**
   * @param {string} hostname
   */
  async function getPagePolicy(hostname) {
    await initialize();
    const host = normalizeHostname(hostname);
    const preferences = await getPreferences();
    const enabled = hostEnabled(host, preferences);
    if (!enabled) return { enabled, hostname: host, selectors: [] };
    if (!cosmeticRules) throw new Error('Cosmetic rule cache is unavailable');
    return { enabled, hostname: host, selectors: resolveSelectors(cosmeticRules, host) };
  }

  /**
   * @param {string} pageHostname
   * @param {string[]} hostnames
   */
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

  /**
   * @param {string} hostname
   * @param {boolean} enabled
   */
  async function setHostEnabled(hostname, enabled) {
    const update = preferenceWrites.then(async () => {
      const preferences = updateHostPreference(await getPreferences(), hostname, enabled);
      await chrome.storage.local.set({ [PREFERENCES_KEY]: preferences });
      return { enabled: hostEnabled(hostname, preferences), preferences };
    });
    preferenceWrites = update.then(() => {}, () => {});
    return update;
  }

  /**
   * @param {string} name
   * @returns {Promise<void>}
   */
  async function handleAlarm(name) {
    const signal = clock.read(name);
    switch (signal.kind) {
      case 'daily':
        await refreshAll({ scheduleRetry: true });
        return;
      case 'retry':
        await refreshOne(SOURCE_CONFIG[signal.sourceId], { scheduleRetry: false });
        return;
      case 'ignore':
        return;
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
