(() => {
  const VERSION = 1;
  const MESSAGE = {
    GET_APPLICABLE_SELECTORS: 'clearspace:v1/get-applicable-selectors',
    CLASSIFY_HOSTNAMES: 'clearspace:v1/classify-hostnames',
    GET_TAB_STATUS: 'clearspace:v1/get-tab-status',
  };
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

  function message(type, payload = {}) {
    return chrome.runtime.sendMessage({ type, version: VERSION, ...payload });
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
      if (element.hasAttribute(attribute)) values.push(element.getAttribute(attribute));
    }
    for (const attribute of ['srcset', 'imagesrcset']) {
      if (element.hasAttribute(attribute)) {
        for (const candidate of element.getAttribute(attribute).split(',')) values.push(candidate.trim().split(/\s+/)[0]);
      }
    }
    return values.filter(Boolean);
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
        if (!associations.has(hostname)) associations.set(hostname, new Set());
        associations.get(hostname).add(element);
        if (!hostCache.has(hostname)) unknown.add(hostname);
      }
    }
    if (unknown.size) {
      const response = await message(MESSAGE.CLASSIFY_HOSTNAMES, {
        pageHostname: location.hostname,
        hostnames: [...unknown],
      });
      if (response?.ok) {
        for (const [hostname, matches] of Object.entries(response.matches || {})) hostCache.set(hostname, Boolean(matches));
      }
    }
    for (const [hostname, resources] of associations) {
      if (hostCache.get(hostname)) resources.forEach(hideResource);
    }
  }

  function enqueue(root) {
    if (!(root instanceof Element) && root !== document) return;
    if (root instanceof Element && root.matches(RESOURCE_SELECTOR)) queuedElements.add(root);
    root.querySelectorAll?.(RESOURCE_SELECTOR).forEach((element) => queuedElements.add(element));
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
    const response = await message(MESSAGE.GET_APPLICABLE_SELECTORS, { hostname: location.hostname });
    if (!response?.ok || !response.enabled) return;
    enabled = true;
    addStyle(response.selectors || []);
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
    if (incoming?.version === VERSION && incoming?.type === MESSAGE.GET_TAB_STATUS) {
      sendResponse({ ok: true, hostname: location.hostname, enabled });
    }
  });

  start().catch((error) => console.warn('Clearspace could not start', error));
})();
