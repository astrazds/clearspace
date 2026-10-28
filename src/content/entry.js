import { isProtocolMessage, isRecord, makeRequest, MESSAGE } from '../protocol.js';

const RESOURCE_SELECTOR = [
  'img', 'iframe', 'video', 'audio', 'source', 'object', 'embed', 'input[type="image"]',
].join(',');
const EXPLICIT_AD_SLOT_SELECTOR = [
  '[data-ad]', '[data-ad-slot]', '[data-ad-unit]', '[data-ad-container]',
  '[aria-label="advertisement" i]', '[role="complementary"][aria-label*="advertisement" i]',
  '.ad-slot', '.ad-container', '.advertisement', '[id^="ad-slot" i]', '[id^="ad_container" i]',
].join(',');
const HIDDEN_ATTRIBUTE = 'data-clearspace-hidden';
/** @type {Map<string, boolean>} */
const hostCache = new Map();
let enabled = false;
/** @type {MutationObserver | undefined} */
let observer;
/** @type {Set<Element>} */
let queuedElements = new Set();
let flushScheduled = false;
/** @type {WeakMap<Element, number>} */
const revisions = new WeakMap();
/** @type {Set<Element>} */
const hiddenResources = new Set();
/** @type {Set<Element>} */
let hiddenSlots = new Set();

/**
 * @param {import('../protocol.js').RequestInput} request
 * @returns {Promise<unknown>}
 */
async function sendRequest(request) {
  return chrome.runtime.sendMessage(makeRequest(request));
}

/**
 * @param {unknown} value
 * @returns {value is { ok: true, enabled: boolean, selectors: string[] }}
 */
function isPagePolicyResponse(value) {
  return isRecord(value)
    && value.ok === true
    && typeof value.enabled === 'boolean'
    && Array.isArray(value.selectors)
    && value.selectors.every((selector) => typeof selector === 'string');
}

/**
 * @param {unknown} value
 * @returns {value is { ok: true, matches: Record<string, boolean> }}
 */
function isClassificationResponse(value) {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.matches)) return false;
  return Object.values(value.matches).every((matches) => typeof matches === 'boolean');
}

/** @param {string[]} selectors */
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

/**
 * @param {Element} element
 * @returns {string[]}
 */
function urlsForElement(element) {
  if (!element.matches(RESOURCE_SELECTOR)) return [];
  // Let the browser resolve srcset, picture media queries and source selection.
  // Classifying every candidate can hide a legitimate selected resource.
  if (element instanceof HTMLImageElement) {
    const responsive = element.hasAttribute('srcset') || element.parentElement?.matches('picture');
    return [element.currentSrc || (responsive ? '' : element.getAttribute('src') || '')];
  }
  if (element instanceof HTMLMediaElement) {
    return [element.currentSrc || element.getAttribute('src') || element.getAttribute('poster') || ''];
  }
  /** @type {string[]} */
  const values = [];
  for (const attribute of ['src', 'poster', 'data']) {
    const value = element.getAttribute(attribute);
    if (value) values.push(value);
  }
  return values;
}

/**
 * @param {string} value
 * @returns {string}
 */
function hostnameForUrl(value) {
  try {
    const parsed = new URL(value, document.baseURI);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

/** @param {Element} element */
function releaseResource(element) {
  if (hiddenResources.delete(element)) element.removeAttribute(HIDDEN_ATTRIBUTE);
}

function reconcileSlots() {
  const slots = new Set();
  for (const element of hiddenResources) {
    if (!element.isConnected || !element.matches(RESOURCE_SELECTOR)) { releaseResource(element); continue; }
    element.setAttribute(HIDDEN_ATTRIBUTE, 'resource');
    const slot = element.closest(EXPLICIT_AD_SLOT_SELECTOR);
    if (slot) slots.add(slot);
  }
  for (const slot of hiddenSlots) {
    if (!slots.has(slot) && !hiddenResources.has(slot)) slot.removeAttribute(HIDDEN_ATTRIBUTE);
  }
  for (const slot of slots) slot.setAttribute(HIDDEN_ATTRIBUTE, 'ad-slot');
  hiddenSlots = slots;
}

/** @param {Element[]} elements */
async function classify(elements) {
  const snapshots = elements.filter(element => element.isConnected).map(element => ({
    element,
    revision: revisions.get(element),
    urls: urlsForElement(element),
  }));
  /** @type {Set<string>} */
  const unknown = new Set();
  for (const { element, urls } of snapshots) {
    releaseResource(element);
    for (const value of urls) {
      const hostname = hostnameForUrl(value);
      if (!hostname) continue;
      if (!hostCache.has(hostname)) unknown.add(hostname);
    }
  }
  reconcileSlots();
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
  for (const { element, revision, urls } of snapshots) {
    if (!element.isConnected || revisions.get(element) !== revision
      || JSON.stringify(urlsForElement(element)) !== JSON.stringify(urls)) continue;
    if (urls.some(value => hostCache.get(hostnameForUrl(value)))) hiddenResources.add(element);
  }
  reconcileSlots();
}

/** @param {Element} element */
function enqueueResource(element) {
  if (element instanceof HTMLSourceElement) {
    const parent = element.parentElement;
    const owner = parent instanceof HTMLMediaElement ? parent
      : parent?.matches('picture') ? parent.querySelector('img') : null;
    if (owner) enqueueResource(owner);
    return;
  }
  revisions.set(element, (revisions.get(element) || 0) + 1);
  queuedElements.add(element);
}

/** @param {Node | Document} root */
function enqueue(root) {
  const queryRoot = root === document ? document : root instanceof Element ? root : null;
  if (!queryRoot) return;
  if (queryRoot instanceof Element && (queryRoot.matches(RESOURCE_SELECTOR) || revisions.has(queryRoot))) enqueueResource(queryRoot);
  queryRoot.querySelectorAll(RESOURCE_SELECTOR).forEach(enqueueResource);
  scheduleFlush();
}

function scheduleFlush() {
  if (!flushScheduled) {
    flushScheduled = true;
    // A task boundary lets the browser update currentSrc after DOM mutations.
    setTimeout(async () => {
      try {
        do {
          const batch = [...queuedElements];
          queuedElements = new Set();
          reconcileSlots();
          if (batch.length) await classify(batch);
        } while (queuedElements.size);
      } catch (error) {
        console.warn('Clearspace could not classify resources', error);
      } finally {
        flushScheduled = false;
        if (queuedElements.size) scheduleFlush();
      }
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
      else {
        record.addedNodes.forEach(enqueue);
        // Source removal can change a media selection. Other removals only
        // need ownership reconciliation, not a rescan of the entire parent.
        if (record.target instanceof Element && record.target.matches('picture, video, audio')) enqueue(record.target);
        if (record.removedNodes.length) scheduleFlush();
      }
    }
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'sizes', 'media', 'type', 'poster', 'data',
      'class', 'id', 'aria-label', 'role', 'data-ad', 'data-ad-slot', 'data-ad-unit', 'data-ad-container'],
  });
  for (const event of ['load', 'error', 'loadstart', 'loadedmetadata', 'emptied']) {
    document.addEventListener(event, (event) => {
      if (event.target instanceof Element && event.target.matches(RESOURCE_SELECTOR)) enqueue(event.target);
    }, true);
  }
  window.addEventListener('resize', () => enqueue(document));
}

chrome.runtime.onMessage.addListener((incoming, _sender, sendResponse) => {
  if (isProtocolMessage(incoming) && incoming.type === MESSAGE.GET_TAB_STATUS) {
    sendResponse({ ok: true, hostname: location.hostname, enabled });
  }
});

start().catch((error) => console.warn('Clearspace could not start', error));
