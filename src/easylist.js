import { hostnameSuffixes, isValidDomain, normalizeHostname } from './hosts.js';

const UNSUPPORTED_MARKERS = [
  '#?#',
  '#$#',
  '#%#',
  '#@?#',
  '#@$#',
  '#@%#',
];

const UNSUPPORTED_SELECTOR = /(?:^|[^\\])(?::?-abp-|:contains\(|:matches-css\(|:xpath\(|:remove\(|:style\(|\{\s*(?:remove|style)\s*:|\+js\()/i;

function hasUnsupportedSelector(selector) {
  return UNSUPPORTED_SELECTOR.test(String(selector || '').trim());
}

export function isSafeCssSelector(selector) {
  const value = String(selector || '').trim();
  if (!value || value.length > 8192 || hasUnsupportedSelector(value)) return false;
  if (/[{}\u0000-\u001f]/.test(value)) return false;

  const stack = [];
  let quote = '';
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[' || character === '(') stack.push(character);
    if (character === ']' && stack.pop() !== '[') return false;
    if (character === ')' && stack.pop() !== '(') return false;
  }
  return !quote && stack.length === 0 && !escaped;
}

function parseDomains(raw) {
  const includes = [];
  const excludes = [];
  if (!raw) return { includes, excludes, valid: true };

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim().toLowerCase();
    const excluded = trimmed.startsWith('~');
    const domain = normalizeHostname(excluded ? trimmed.slice(1) : trimmed);
    if (!isValidDomain(domain)) return { includes: [], excludes: [], valid: false };
    (excluded ? excludes : includes).push(domain);
  }
  return { includes: [...new Set(includes)], excludes: [...new Set(excludes)], valid: true };
}

function parsePageException(line) {
  const match = line.match(/^@@\|\|([^/^$*]+)\^\$([^\s]+)$/i);
  if (!match) return null;
  const domain = normalizeHostname(match[1]);
  if (!isValidDomain(domain)) return null;
  const options = match[2].toLowerCase().split(',');
  const kinds = options.filter((option) => option === 'elemhide' || option === 'generichide');
  return kinds.length ? { domain, kinds } : null;
}

function addIndexed(target, key, rule) {
  (target[key] ||= []).push(rule);
}

function addCosmeticRule(compiled, kind, domains, selector) {
  const rule = { selector, excludes: domains.excludes };
  const genericKey = kind === 'hide' ? 'genericHides' : 'genericExceptions';
  const domainKey = kind === 'hide' ? 'domainHides' : 'domainExceptions';
  if (domains.includes.length === 0) {
    compiled[genericKey].push(rule);
  } else {
    for (const domain of domains.includes) addIndexed(compiled[domainKey], domain, rule);
  }
}

export function parseEasyList(text) {
  const compiled = {
    genericHides: [],
    genericExceptions: [],
    domainHides: Object.create(null),
    domainExceptions: Object.create(null),
    pageExceptions: Object.create(null),
    version: '',
    stats: {
      cosmetic: 0,
      exceptions: 0,
      networkIgnored: 0,
      unsupported: 0,
      invalid: 0,
      comments: 0,
    },
  };

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('!') || /^\[.+\]$/.test(line)) {
      compiled.stats.comments += 1;
      const match = line.match(/^!\s*(?:version|last modified)\s*:\s*(.+)$/i);
      if (!compiled.version && match) compiled.version = match[1].trim();
      continue;
    }

    const pageException = parsePageException(line);
    if (pageException) {
      const current = new Set(compiled.pageExceptions[pageException.domain] || []);
      pageException.kinds.forEach((kind) => current.add(kind));
      compiled.pageExceptions[pageException.domain] = [...current];
      compiled.stats.exceptions += 1;
      continue;
    }

    if (UNSUPPORTED_MARKERS.some((marker) => line.includes(marker))) {
      compiled.stats.unsupported += 1;
      continue;
    }

    const exceptionIndex = line.indexOf('#@#');
    const hideIndex = line.indexOf('##');
    const isException = exceptionIndex >= 0;
    const separatorIndex = isException ? exceptionIndex : hideIndex;
    const separatorLength = isException ? 3 : 2;
    if (separatorIndex < 0) {
      compiled.stats.networkIgnored += 1;
      continue;
    }

    const domains = parseDomains(line.slice(0, separatorIndex));
    const selector = line.slice(separatorIndex + separatorLength).trim();
    if (hasUnsupportedSelector(selector)) {
      compiled.stats.unsupported += 1;
      continue;
    }
    if (!domains.valid || !isSafeCssSelector(selector)) {
      compiled.stats.invalid += 1;
      continue;
    }
    addCosmeticRule(compiled, isException ? 'exception' : 'hide', domains, selector);
    compiled.stats[isException ? 'exceptions' : 'cosmetic'] += 1;
  }

  return compiled;
}

function mergeIndex(target, source) {
  for (const [domain, rules] of Object.entries(source || {})) {
    (target[domain] ||= []).push(...rules);
  }
}

export function mergeEasyLists(...lists) {
  const merged = {
    genericHides: [],
    genericExceptions: [],
    domainHides: Object.create(null),
    domainExceptions: Object.create(null),
    pageExceptions: Object.create(null),
    version: lists.map((list) => list?.version).filter(Boolean).join(' + '),
    stats: Object.create(null),
  };
  for (const list of lists.filter(Boolean)) {
    merged.genericHides.push(...list.genericHides);
    merged.genericExceptions.push(...list.genericExceptions);
    mergeIndex(merged.domainHides, list.domainHides);
    mergeIndex(merged.domainExceptions, list.domainExceptions);
    for (const [domain, kinds] of Object.entries(list.pageExceptions || {})) {
      merged.pageExceptions[domain] = [...new Set([...(merged.pageExceptions[domain] || []), ...kinds])];
    }
    for (const [name, count] of Object.entries(list.stats || {})) {
      merged.stats[name] = (merged.stats[name] || 0) + count;
    }
  }
  return merged;
}

function ruleApplies(rule, suffixSet) {
  return !(rule.excludes || []).some((domain) => suffixSet.has(domain));
}

function collectRules(index, suffixes, suffixSet, output) {
  for (const suffix of suffixes) {
    for (const rule of index[suffix] || []) {
      if (ruleApplies(rule, suffixSet)) output.add(rule.selector);
    }
  }
}

export function resolveSelectors(compiled, hostname) {
  const suffixes = hostnameSuffixes(hostname);
  const suffixSet = new Set(suffixes);
  const pageFlags = new Set();
  for (const suffix of suffixes) {
    for (const kind of compiled.pageExceptions[suffix] || []) pageFlags.add(kind);
  }
  if (pageFlags.has('elemhide')) return [];

  const hides = new Set();
  const exceptions = new Set();
  if (!pageFlags.has('generichide')) {
    for (const rule of compiled.genericHides) {
      if (ruleApplies(rule, suffixSet)) hides.add(rule.selector);
    }
  }
  collectRules(compiled.domainHides, suffixes, suffixSet, hides);

  for (const rule of compiled.genericExceptions) {
    if (ruleApplies(rule, suffixSet)) exceptions.add(rule.selector);
  }
  collectRules(compiled.domainExceptions, suffixes, suffixSet, exceptions);
  for (const selector of exceptions) hides.delete(selector);
  return [...hides];
}
