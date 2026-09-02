import { createSuffixMatcher, isValidDomain, normalizeHostname } from './hosts.js';

export function parseHagezi(text) {
  const domains = new Set();
  let ignored = 0;
  let malformed = 0;
  let version = '';

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('!')) {
      const match = line.match(/(?:version|last modified|updated)\s*[:=]\s*(.+)$/i);
      if (!version && match) version = match[1].trim();
      continue;
    }

    let candidate = line;
    if (candidate.startsWith('||') && candidate.endsWith('^')) {
      candidate = candidate.slice(2, -1);
    }
    candidate = candidate.replace(/^\*\./, '').replace(/\.$/, '');
    candidate = normalizeHostname(candidate);

    if (isValidDomain(candidate)) domains.add(candidate);
    else if (/\s|\/|\^|\||\*/.test(candidate)) malformed += 1;
    else ignored += 1;
  }

  return {
    domains: [...domains].sort(),
    version,
    stats: { accepted: domains.size, ignored, malformed },
  };
}

export function compileHagezi(text) {
  const parsed = parseHagezi(text);
  return {
    ...parsed,
    matcher: createSuffixMatcher(parsed.domains),
  };
}
