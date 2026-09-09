import { isRecord, makeRequest, MESSAGE } from './src/protocol.js';

const hostname = document.querySelector('#hostname');
const enabled = document.querySelector('#enabled');
const scopeNote = document.querySelector('#scope-note');
const hagezi = document.querySelector('#hagezi-status');
const easylist = document.querySelector('#easylist-status');
const refreshResult = document.querySelector('#refresh-result');
const refresh = document.querySelector('#refresh');
if (!(hostname instanceof HTMLElement)
  || !(enabled instanceof HTMLInputElement)
  || !(scopeNote instanceof HTMLElement)
  || !(hagezi instanceof HTMLElement)
  || !(easylist instanceof HTMLElement)
  || !(refreshResult instanceof HTMLElement)
  || !(refresh instanceof HTMLButtonElement)) {
  throw new Error('Clearspace popup markup is incomplete');
}
const elements = { hostname, enabled, scopeNote, hagezi, easylist, refreshResult, refresh };


let currentTab;
let currentHostname = '';

async function sendRequest(request) {
  return chrome.runtime.sendMessage(makeRequest(request));
}

function parseTabStatus(value) {
  if (!isRecord(value)
    || value.ok !== true
    || typeof value.hostname !== 'string'
    || typeof value.enabled !== 'boolean') return null;
  return { hostname: value.hostname, enabled: value.enabled };
}

function parseSource(value) {
  if (!isRecord(value)) return { kind: 'unavailable' };
  const lastResult = isRecord(value.lastResult) ? value.lastResult : null;
  const lastError = lastResult?.ok === false && typeof lastResult.error === 'string'
    ? lastResult.error
    : null;
  return {
    kind: 'available',
    version: typeof value.version === 'string' && value.version ? value.version : 'unknown',
    fetchedAt: typeof value.fetchedAt === 'number' ? value.fetchedAt : null,
    title: lastError || (typeof value.url === 'string' ? value.url : ''),
    lastError,
  };
}

function parseRefreshStatus(value) {
  if (!isRecord(value) || value.ok !== true) return null;
  const sources = isRecord(value.sources) ? value.sources : {};
  const hageziSource = parseSource(sources.hagezi);
  const easylistSource = parseSource(sources.easylist);
  let lastError = null;
  for (const sourceValue of Object.values(sources)) {
    const source = parseSource(sourceValue);
    if (source.kind === 'available' && source.lastError !== null) {
      lastError = source.lastError;
      break;
    }
  }
  return {
    hagezi: hageziSource,
    easylist: easylistSource,
    lastError,
  };
}

function parseActionResult(value, fallback) {
  if (isRecord(value) && value.ok === true) return { kind: 'success' };
  return {
    kind: 'error',
    message: isRecord(value) && typeof value.error === 'string' ? value.error : fallback,
  };
}

function parseRefreshAction(value) {
  const action = parseActionResult(value, 'Refresh failed');
  if (action.kind === 'error') return action;
  const results = isRecord(value) && isRecord(value.results) ? Object.values(value.results) : [];
  return {
    kind: 'success',
    failures: results.filter((result) => isRecord(result) && result.ok === false).length,
  };
}

function age(timestamp) {
  if (!timestamp) return 'unknown age';
  const hours = Math.max(0, Math.floor((Date.now() - timestamp) / 3_600_000));
  if (hours < 1) return 'just now';
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function renderSource(element, source) {
  if (source.kind === 'unavailable') {
    element.textContent = 'Unavailable';
    return;
  }
  element.textContent = `${source.version} · ${age(source.fetchedAt)}`;
  element.title = source.title;
}

async function load() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabStatusPromise = currentTab?.id !== undefined
    ? chrome.tabs.sendMessage(
      currentTab.id,
      makeRequest({ type: MESSAGE.GET_TAB_STATUS }),
      { frameId: 0 },
    ).catch(() => null)
    : null;
  const [tabStatusValue, refreshStatusValue] = await Promise.all([
    tabStatusPromise,
    sendRequest({ type: MESSAGE.GET_REFRESH_STATUS }),
  ]);
  const tabStatus = parseTabStatus(tabStatusValue);
  const refreshStatus = parseRefreshStatus(refreshStatusValue);

  if (tabStatus) {
    currentHostname = tabStatus.hostname;
    elements.hostname.textContent = currentHostname;
    elements.enabled.checked = tabStatus.enabled;
    elements.enabled.disabled = false;
  } else {
    elements.hostname.textContent = 'Unavailable on this page';
    elements.scopeNote.textContent = 'Open an HTTP(S) page to configure it';
  }
  if (refreshStatus) {
    renderSource(elements.hagezi, refreshStatus.hagezi);
    renderSource(elements.easylist, refreshStatus.easylist);
    elements.refreshResult.textContent = refreshStatus.lastError
      ? `Last refresh failed: ${refreshStatus.lastError}`
      : 'Last refresh succeeded';
  }
}

elements.enabled.addEventListener('change', async () => {
  elements.enabled.disabled = true;
  const result = parseActionResult(await sendRequest({
    type: MESSAGE.SET_HOST_PREFERENCE,
    hostname: currentHostname,
    enabled: elements.enabled.checked,
  }), 'Could not update this site');
  if (result.kind === 'error') {
    elements.enabled.checked = !elements.enabled.checked;
    elements.refreshResult.textContent = result.message;
    elements.enabled.disabled = false;
    return;
  }
  if (currentTab?.id !== undefined) await chrome.tabs.reload(currentTab.id);
  window.close();
});

elements.refresh.addEventListener('click', async () => {
  elements.refresh.disabled = true;
  elements.refreshResult.textContent = 'Refreshing both sources…';
  const result = parseRefreshAction(await sendRequest({ type: MESSAGE.REFRESH_SOURCES }));
  if (result.kind === 'error') elements.refreshResult.textContent = result.message;
  else {
    elements.refreshResult.textContent = result.failures
      ? `${result.failures} source refresh failed; last-known-good rules retained`
      : 'Both sources refreshed';
  }
  elements.refresh.disabled = false;
  const status = parseRefreshStatus(await sendRequest({ type: MESSAGE.GET_REFRESH_STATUS }));
  if (status) {
    renderSource(elements.hagezi, status.hagezi);
    renderSource(elements.easylist, status.easylist);
  }
});

load().catch((error) => {
  elements.hostname.textContent = 'Clearspace unavailable';
  elements.refreshResult.textContent = error instanceof Error ? error.message : String(error);
});
