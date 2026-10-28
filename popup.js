import { isRecord, makeRequest, MESSAGE } from './src/protocol.js';

const hostname = document.querySelector('#hostname');
const siteStatus = document.querySelector('#site-status');
const enabled = document.querySelector('#enabled');
const refreshResult = document.querySelector('#refresh-result');
const refresh = document.querySelector('#refresh');
const recovery = document.querySelector('#recovery');
const reload = document.querySelector('#reload');
const reassurance = document.querySelector('#refresh-reassurance');
const updates = document.querySelector('details');
if (!(hostname instanceof HTMLElement)
  || !(siteStatus instanceof HTMLElement)
  || !(enabled instanceof HTMLInputElement)
  || !(refreshResult instanceof HTMLElement)
  || !(refresh instanceof HTMLButtonElement)
  || !(recovery instanceof HTMLElement)
  || !(reload instanceof HTMLButtonElement)
  || !(reassurance instanceof HTMLElement)
  || !(updates instanceof HTMLDetailsElement)) {
  throw new Error('Clearspace popup markup is incomplete');
}
const elements = { hostname, siteStatus, enabled, refreshResult, refresh, recovery, reload, reassurance, updates };

/** @typedef {{ kind: 'loading' }
 *   | { kind: 'unavailable', message: string }
 *   | {
 *       kind: 'ready',
 *       hostname: string,
 *       enabled: boolean,
 *       appliedEnabled: boolean,
 *       pending: 'save' | 'reload' | null,
 *       rulesUpdated: boolean,
 *       error: string | null,
 *     }
 * } PopupState
 */
/** @typedef {{ kind: 'idle' }
 *   | { kind: 'pending' }
 *   | { kind: 'success', message: string }
 *   | { kind: 'error', message: string }
 * } UpdateState
 */
/** @typedef {{ hostname: string, enabled: boolean }} TabStatus */

/** @type {PopupState} */
let popupState = { kind: 'loading' };
/** @type {UpdateState} */
let updateState = { kind: 'idle' };
/** @type {number | null} */
let currentTabId = null;
let updatesLoaded = false;
let savedRulesKnown = false;

/**
 * @param {import('./src/protocol.js').RequestInput} request
 * @returns {Promise<unknown>}
 */
async function sendRequest(request) {
  return chrome.runtime.sendMessage(makeRequest(request));
}

/**
 * @param {unknown} value
 * @returns {TabStatus | null}
 */
function parseTabStatus(value) {
  if (!isRecord(value)
    || value.ok !== true
    || typeof value.hostname !== 'string'
    || !value.hostname
    || typeof value.enabled !== 'boolean') return null;
  return { hostname: value.hostname, enabled: value.enabled };
}

/**
 * @param {unknown} value
 * @param {boolean} expectedEnabled
 * @returns {boolean}
 */
function preferenceWasSaved(value, expectedEnabled) {
  return isRecord(value) && value.ok === true && value.enabled === expectedEnabled;
}

/**
 * @param {unknown} value
 * @returns {{ failures: number, updated: boolean } | null}
 */
function refreshFailureCount(value) {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.results)) return null;
  const results = [value.results.hagezi, value.results.easylist];
  let failures = 0;
  let updated = false;
  for (const result of results) {
    if (!isRecord(result) || typeof result.ok !== 'boolean') return null;
    if (!result.ok) failures += 1;
    if (result.ok && result.kind === 'updated') updated = true;
  }
  return { failures, updated };
}

/** @param {Extract<PopupState, { kind: 'ready' }>} state */
function reloadReason(state) {
  if (state.enabled !== state.appliedEnabled) return 'setting';
  return state.rulesUpdated && state.appliedEnabled ? 'rules' : null;
}

function renderPopup() {
  elements.recovery.hidden = popupState.kind !== 'ready' || popupState.pending === 'save' || reloadReason(popupState) === null;
  elements.reload.disabled = popupState.kind !== 'ready' || popupState.pending !== null;
  switch (popupState.kind) {
    case 'loading':
    case 'unavailable':
      elements.hostname.hidden = true;
      elements.hostname.textContent = '';
      elements.hostname.title = '';
      elements.siteStatus.textContent = popupState.kind === 'loading'
        ? 'Checking current page...'
        : popupState.message;
      elements.enabled.checked = false;
      elements.enabled.disabled = true;
      break;
    case 'ready': {
      const stateLabel = popupState.enabled ? 'Cleanup is on' : 'Cleanup is off';
      elements.hostname.hidden = false;
      elements.hostname.textContent = popupState.hostname;
      elements.hostname.title = popupState.hostname;
      elements.siteStatus.textContent = popupState.pending === 'save' ? 'Saving…'
        : popupState.pending === 'reload' ? 'Reloading…'
        : popupState.error || (reloadReason(popupState) === 'setting' ? 'Setting saved. Reload to apply.'
          : reloadReason(popupState) === 'rules' ? 'New rules are ready. Reload to apply.' : stateLabel);
      elements.enabled.checked = popupState.enabled;
      elements.enabled.disabled = popupState.pending !== null;
      break;
    }
  }
}

function renderUpdate() {
  elements.refresh.disabled = updateState.kind === 'pending';
  elements.refresh.textContent = updateState.kind === 'error' ? 'Try again' : 'Check now';
  elements.reassurance.hidden = updateState.kind !== 'error' || !savedRulesKnown;
  switch (updateState.kind) {
    case 'idle':
      elements.refreshResult.hidden = true;
      elements.refreshResult.textContent = '';
      break;
    case 'pending':
      elements.refreshResult.hidden = false;
      elements.refreshResult.textContent = 'Checking for updates…';
      break;
    case 'success':
    case 'error':
      elements.refreshResult.hidden = false;
      elements.refreshResult.textContent = updateState.message;
      break;
  }
}

/** @param {PopupState} state */
function setPopupState(state) {
  popupState = state;
  renderPopup();
}

/** @param {UpdateState} state */
function setUpdateState(state) {
  updateState = state;
  renderUpdate();
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    setPopupState({ kind: 'unavailable', message: 'Open a website to use Clearspace.' });
    return;
  }
  currentTabId = tab.id;

  let value;
  try {
    value = await chrome.tabs.sendMessage(
      currentTabId,
      makeRequest({ type: MESSAGE.GET_TAB_STATUS }),
      { frameId: 0 },
    );
  } catch {
    setPopupState({ kind: 'unavailable', message: "Cleanup isn't available on this page." });
    return;
  }
  const status = parseTabStatus(value);
  if (!status) {
    setPopupState({ kind: 'unavailable', message: "Couldn't read this page's status. Reload it and try again." });
    return;
  }
  let savedEnabled = status.enabled;
  try {
    const policy = await sendRequest({ type: MESSAGE.GET_APPLICABLE_SELECTORS, hostname: status.hostname });
    if (isRecord(policy) && policy.ok === true && typeof policy.enabled === 'boolean') savedEnabled = policy.enabled;
  } catch { /* The document's applied status is still useful when the worker is unavailable. */ }
  setPopupState({
    kind: 'ready',
    hostname: status.hostname,
    enabled: savedEnabled,
    appliedEnabled: status.enabled,
    pending: null,
    rulesUpdated: false,
    error: null,
  });
}

async function saveSitePreference() {
  const previous = popupState;
  if (previous.kind !== 'ready' || previous.pending) return;
  const requestedEnabled = elements.enabled.checked;
  setPopupState({
    ...previous,
    enabled: requestedEnabled,
    pending: 'save',
    error: null,
  });

  try {
    const response = await sendRequest({
      type: MESSAGE.SET_HOST_PREFERENCE,
      hostname: previous.hostname,
      enabled: requestedEnabled,
    });
    if (!preferenceWasSaved(response, requestedEnabled)) throw new Error('Preference was not saved');
  } catch {
    setPopupState({
      ...(popupState.kind === 'ready' ? popupState : previous),
      enabled: previous.enabled,
      pending: null,
      error: "Couldn't save. Your setting is unchanged.",
    });
    return;
  }

  const saved = { ...(popupState.kind === 'ready' ? popupState : previous), enabled: requestedEnabled, pending: null, error: null };
  setPopupState(saved);
  if (!reloadReason(saved)) { window.close(); return; }
  await reloadPage(true);
}

/** @param {boolean} [automatic] */
async function reloadPage(automatic = false) {
  const previous = popupState;
  if (previous.kind !== 'ready' || previous.pending || !reloadReason(previous)) return;
  setPopupState({ ...previous, pending: 'reload', error: null });
  try {
    if (currentTabId === null) throw new Error('Target tab is unavailable');
    await chrome.tabs.reload(currentTabId);
  } catch {
    setPopupState({
      ...previous,
      pending: null,
      error: automatic ? null : reloadReason(previous) === 'setting'
        ? "Couldn't reload. Your setting is saved." : "Couldn't reload. Try again.",
    });
    return;
  }
  window.close();
}

async function loadUpdateStatus() {
  if (updatesLoaded || updateState.kind === 'pending') return;
  setUpdateState({ kind: 'pending' });
  try {
    const response = await sendRequest({ type: MESSAGE.GET_REFRESH_STATUS });
    if (!isRecord(response) || response.ok !== true || !isRecord(response.sources)) throw new Error('Invalid update status');
    const sources = [response.sources.hagezi, response.sources.easylist].map(source => {
      if (!isRecord(source) || typeof source.hash !== 'string' || !source.hash
        || !isRecord(source.lastResult) || typeof source.lastResult.ok !== 'boolean') throw new Error('Incomplete update status');
      return { failed: !source.lastResult.ok, bundled: source.bundledSeed === true };
    });
    savedRulesKnown = true;
    updatesLoaded = true;
    if (sources.some(source => source.failed)) {
      setUpdateState({ kind: 'error', message: "Couldn't update." });
    } else {
      setUpdateState({ kind: 'success', message: sources.some(source => source.bundled)
        ? 'Using bundled rules.' : 'Last check succeeded.' });
    }
  } catch {
    setUpdateState({ kind: 'error', message: "Couldn't check update status." });
  }
}

async function checkForUpdates() {
  if (updateState.kind === 'pending') return;
  setUpdateState({ kind: 'pending' });
  try {
    const result = refreshFailureCount(await sendRequest({ type: MESSAGE.REFRESH_SOURCES }));
    if (result === null) {
      setUpdateState({ kind: 'error', message: "Couldn't check for updates." });
    } else {
      savedRulesKnown = true;
      updatesLoaded = true;
      setUpdateState(result.failures ? { kind: 'error', message: "Couldn't update." }
        : { kind: 'success', message: result.updated ? 'Rules updated.' : 'Rules are up to date.' });
      if (result.updated && popupState.kind === 'ready' && popupState.appliedEnabled) {
        setPopupState({ ...popupState, rulesUpdated: true });
      }
    }
  } catch {
    setUpdateState({ kind: 'error', message: "Couldn't check for updates." });
  }
}

elements.enabled.addEventListener('change', () => {
  void saveSitePreference();
});
elements.refresh.addEventListener('click', () => {
  void checkForUpdates();
});
elements.reload.addEventListener('click', () => { void reloadPage(); });
elements.updates.addEventListener('toggle', () => {
  if (elements.updates.open) void loadUpdateStatus();
});

renderPopup();
renderUpdate();
load().catch(() => {
  setPopupState({ kind: 'unavailable', message: "Couldn't read this page's status. Reload it and try again." });
});
