import { isProtocolMessage, isRecord, makeRequest, MESSAGE } from '../protocol.js';

const RESOURCE_SELECTOR = [
  'img[src]', 'img[srcset]', 'iframe[src]', 'video[src]', 'video[poster]',
  'audio[src]', 'source[src]', 'source[srcset]', 'object[data]', 'embed[src]',
  'input[type="image"][src]', 'link[imagesrcset]',
].join(',');
const EXPLICIT_AD_SLOT_SELECTOR = [
  '[data-ad]', '[data-ad-slot]', '[data-ad-unit]', '[data-ad-container]',
  '[aria-label="advertisement" i]', '[role="complementary"][aria-label*="advertisement" i]',
  '.ad-slot', '.ad-container', '.advertisement', '[id^="ad-slot" i]', '[id^="ad_container" i]',
].join(',');
const HIDDEN_ATTRIBUTE = 'data-clearspace-hidden';
const hostCache = new Map();
let enabled = false;
let observer;
let queuedElements = new Set();
let flushScheduled = false;

async function sendRequest(request) {
  return chrome.runtime.sendMessage(makeRequest(request));
}

function isPagePolicyResponse(value) {
  return isRecord(value)
    && value.ok === true
    && typeof value.enabled === 'boolean'
    && Array.isArray(value.selectors)
    && value.selectors.every((selector) => typeof selector === 'string');
}

function isClassificationResponse(value) {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.matches)) return false;
  return Object.values(value.matches).every((matches) => typeof matches === 'boolean');
}

function addStyle(selectors) {
  const supported = selectors.filter((selector) => {
    try {
      return !globalThis.CSS?.supports || CSS.supports(`selector(${selector})`);
    } catch {
      return false;
    }
  });
  const style = document.createElement('style');
  style.dataset.clearspace = 'cosmetic';
  style.textContent = `${supported.map((selector) => `${selector}{display:none!important}`).join('\n')}\n[${HIDDEN_ATTRIBUTE}]{display:none!important}`;
  (document.documentElement || document).append(style);
}

function urlsForElement(element) {
  const values = [];
  for (const attribute of ['src', 'poster', 'data']) {
    const value = element.getAttribute(attribute);
    if (value) values.push(value);
  }
  for (const attribute of ['srcset', 'imagesrcset']) {
    const value = element.getAttribute(attribute);
    if (value !== null) {
      for (const candidate of value.split(',')) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url) values.push(url);
      }
    }
  }
  return values;
}

function hostnameForUrl(value) {
  try {
    const parsed = new URL(value, document.baseURI);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

function hideResource(element) {
  element.setAttribute(HIDDEN_ATTRIBUTE, 'resource');
  const slot = element.closest(EXPLICIT_AD_SLOT_SELECTOR);
  if (slot) slot.setAttribute(HIDDEN_ATTRIBUTE, 'ad-slot');
}

async function classify(elements) {
  const associations = new Map();
  const unknown = new Set();
  for (const element of elements) {
    for (const value of urlsForElement(element)) {
      const hostname = hostnameForUrl(value);
      if (!hostname) continue;
      const resources = associations.get(hostname) || new Set();
      resources.add(element);
      associations.set(hostname, resources);
      if (!hostCache.has(hostname)) unknown.add(hostname);
    }
  }
  if (unknown.size) {
    const response = await sendRequest({
      type: MESSAGE.CLASSIFY_HOSTNAMES,
      pageHostname: location.hostname,
      hostnames: [...unknown],
    });
    if (isClassificationResponse(response)) {
      for (const [hostname, matches] of Object.entries(response.matches)) hostCache.set(hostname, matches);
    }
  }
  for (const [hostname, resources] of associations) {
    if (hostCache.get(hostname)) resources.forEach(hideResource);
  }
}

function enqueue(root) {
  const queryRoot = root === document ? document : root instanceof Element ? root : null;
  if (!queryRoot) return;
  if (queryRoot instanceof Element && queryRoot.matches(RESOURCE_SELECTOR)) queuedElements.add(queryRoot);
  queryRoot.querySelectorAll(RESOURCE_SELECTOR).forEach((element) => queuedElements.add(element));
  if (!flushScheduled) {
    flushScheduled = true;
    queueMicrotask(async () => {
      flushScheduled = false;
      const batch = [...queuedElements];
      queuedElements = new Set();
      if (batch.length) await classify(batch);
    });
  }
}

async function start() {
  const response = await sendRequest({
    type: MESSAGE.GET_APPLICABLE_SELECTORS,
    hostname: location.hostname,
  });
  if (!isPagePolicyResponse(response) || !response.enabled) return;
  enabled = true;
  addStyle(response.selectors);
  enqueue(document);
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') enqueue(record.target);
      else record.addedNodes.forEach((node) => enqueue(node));
    }
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'poster', 'data', 'imagesrcset'],
  });
}

chrome.runtime.onMessage.addListener((incoming, _sender, sendResponse) => {
  if (isProtocolMessage(incoming) && incoming.type === MESSAGE.GET_TAB_STATUS) {
    sendResponse({ ok: true, hostname: location.hostname, enabled });
  }
});

start().catch((error) => console.warn('Clearspace could not start', error));
