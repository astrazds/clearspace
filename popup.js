import { isRecord, makeRequest, MESSAGE } from './src/protocol.js';

const hostname = document.querySelector('#hostname');
const siteStatus = document.querySelector('#site-status');
const enabled = document.querySelector('#enabled');
const refreshResult = document.querySelector('#refresh-result');
const refresh = document.querySelector('#refresh');
if (!(hostname instanceof HTMLElement)
  || !(siteStatus instanceof HTMLElement)
  || !(enabled instanceof HTMLInputElement)
  || !(refreshResult instanceof HTMLElement)
  || !(refresh instanceof HTMLButtonElement)) {
  throw new Error('Clearspace popup markup is incomplete');
}
const elements = { hostname, siteStatus, enabled, refreshResult, refresh };

/** @typedef {{ kind: 'loading' }
 *   | { kind: 'unavailable', message: string }
 *   | {
 *       kind: 'ready',
 *       hostname: string,
 *       enabled: boolean,
 *       pending: boolean,
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
 * @returns {number | null}
 */
function refreshFailureCount(value) {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.results)) return null;
  const results = Object.values(value.results);
  if (!results.length) return null;
  let failures = 0;
  for (const result of results) {
    if (!isRecord(result) || typeof result.ok !== 'boolean') return null;
    if (!result.ok) failures += 1;
  }
  return failures;
}

function renderPopup() {
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
      const stateLabel = (popupState.enabled ? 'On' : 'Off') + ' for this site';
      elements.hostname.hidden = false;
      elements.hostname.textContent = popupState.hostname;
      elements.hostname.title = popupState.hostname;
      elements.siteStatus.textContent = popupState.pending
        ? 'Saving...'
        : popupState.error ? stateLabel + '. ' + popupState.error : stateLabel;
      elements.enabled.checked = popupState.enabled;
      elements.enabled.disabled = popupState.pending;
      break;
    }
  }
}

function renderUpdate() {
  elements.refresh.disabled = updateState.kind === 'pending';
  switch (updateState.kind) {
    case 'idle':
      elements.refreshResult.hidden = true;
      elements.refreshResult.textContent = '';
      break;
    case 'pending':
      elements.refreshResult.hidden = false;
      elements.refreshResult.textContent = 'Checking...';
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
    setPopupState({ kind: 'unavailable', message: 'Open a website to use Clearspace.' });
    return;
  }
  const status = parseTabStatus(value);
  if (!status) {
    setPopupState({ kind: 'unavailable', message: 'Open a website to use Clearspace.' });
    return;
  }
  setPopupState({
    kind: 'ready',
    hostname: status.hostname,
    enabled: status.enabled,
    pending: false,
    error: null,
  });
}

async function saveSitePreference() {
  const previous = popupState;
  if (previous.kind !== 'ready' || previous.pending) return;
  const requestedEnabled = elements.enabled.checked;
  setPopupState({
    kind: 'ready',
    hostname: previous.hostname,
    enabled: requestedEnabled,
    pending: true,
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
      kind: 'ready',
      hostname: previous.hostname,
      enabled: previous.enabled,
      pending: false,
      error: "Couldn't save this change. Try again.",
    });
    return;
  }

  try {
    if (currentTabId === null) throw new Error('Target tab is unavailable');
    await chrome.tabs.reload(currentTabId);
  } catch {
    setPopupState({
      kind: 'ready',
      hostname: previous.hostname,
      enabled: requestedEnabled,
      pending: false,
      error: 'Reload this page to apply it.',
    });
    return;
  }
  window.close();
}

async function checkForUpdates() {
  if (updateState.kind === 'pending') return;
  setUpdateState({ kind: 'pending' });
  try {
    const failures = refreshFailureCount(await sendRequest({ type: MESSAGE.REFRESH_SOURCES }));
    if (failures === null) {
      setUpdateState({ kind: 'error', message: "Couldn't check for updates. Try again." });
    } else if (failures) {
      setUpdateState({ kind: 'error', message: 'Some updates failed. Try again.' });
    } else {
      setUpdateState({ kind: 'success', message: 'Updates checked.' });
    }
  } catch {
    setUpdateState({ kind: 'error', message: "Couldn't check for updates. Try again." });
  }
}

elements.enabled.addEventListener('change', () => {
  void saveSitePreference();
});
elements.refresh.addEventListener('click', () => {
  void checkForUpdates();
});

renderPopup();
renderUpdate();
load().catch(() => {
  setPopupState({ kind: 'unavailable', message: 'Open a website to use Clearspace.' });
});
