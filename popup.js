import { MESSAGE, PROTOCOL_VERSION } from './src/protocol.js';

const elements = {
  hostname: document.querySelector('#hostname'),
  enabled: document.querySelector('#enabled'),
  scopeNote: document.querySelector('#scope-note'),
  hagezi: document.querySelector('#hagezi-status'),
  easylist: document.querySelector('#easylist-status'),
  refreshResult: document.querySelector('#refresh-result'),
  refresh: document.querySelector('#refresh'),
};

let currentTab;
let currentHostname = '';

function request(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, version: PROTOCOL_VERSION, ...payload });
}

function age(timestamp) {
  if (!timestamp) return 'unknown age';
  const hours = Math.max(0, Math.floor((Date.now() - timestamp) / 3_600_000));
  if (hours < 1) return 'just now';
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function renderSource(element, source) {
  if (!source) {
    element.textContent = 'Unavailable';
    return;
  }
  element.textContent = `${source.version || 'unknown'} · ${age(source.fetchedAt)}`;
  element.title = source.lastResult?.ok === false ? source.lastResult.error : source.url;
}

async function load() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [tabStatus, refreshStatus] = await Promise.all([
    currentTab?.id
      ? chrome.tabs.sendMessage(currentTab.id, { type: MESSAGE.GET_TAB_STATUS, version: PROTOCOL_VERSION }).catch(() => null)
      : null,
    request(MESSAGE.GET_REFRESH_STATUS),
  ]);

  if (tabStatus?.ok && tabStatus.hostname) {
    currentHostname = tabStatus.hostname;
    elements.hostname.textContent = currentHostname;
    elements.enabled.checked = Boolean(tabStatus.enabled);
    elements.enabled.disabled = false;
  } else {
    elements.hostname.textContent = 'Unavailable on this page';
    elements.scopeNote.textContent = 'Open an HTTP(S) page to configure it';
  }
  if (refreshStatus?.ok) {
    renderSource(elements.hagezi, refreshStatus.sources?.hagezi);
    renderSource(elements.easylist, refreshStatus.sources?.easylist);
    const results = Object.values(refreshStatus.sources || {}).map((source) => source.lastResult).filter(Boolean);
    const failed = results.find((result) => !result.ok);
    elements.refreshResult.textContent = failed ? `Last refresh failed: ${failed.error}` : 'Last refresh succeeded';
  }
}

elements.enabled.addEventListener('change', async () => {
  elements.enabled.disabled = true;
  const response = await request(MESSAGE.SET_HOST_PREFERENCE, {
    hostname: currentHostname,
    enabled: elements.enabled.checked,
  });
  if (!response?.ok) {
    elements.enabled.checked = !elements.enabled.checked;
    elements.refreshResult.textContent = response?.error || 'Could not update this site';
    elements.enabled.disabled = false;
    return;
  }
  if (currentTab?.id) await chrome.tabs.reload(currentTab.id);
  window.close();
});

elements.refresh.addEventListener('click', async () => {
  elements.refresh.disabled = true;
  elements.refreshResult.textContent = 'Refreshing both sources…';
  const response = await request(MESSAGE.REFRESH_SOURCES);
  if (!response?.ok) elements.refreshResult.textContent = response?.error || 'Refresh failed';
  else {
    const failures = Object.values(response.results || {}).filter((result) => !result.ok);
    elements.refreshResult.textContent = failures.length ? `${failures.length} source refresh failed; last-known-good rules retained` : 'Both sources refreshed';
  }
  elements.refresh.disabled = false;
  const status = await request(MESSAGE.GET_REFRESH_STATUS);
  if (status?.ok) {
    renderSource(elements.hagezi, status.sources?.hagezi);
    renderSource(elements.easylist, status.sources?.easylist);
  }
});

load().catch((error) => {
  elements.hostname.textContent = 'Clearspace unavailable';
  elements.refreshResult.textContent = error.message;
});
