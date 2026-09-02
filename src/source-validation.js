import { parseEasyList } from './easylist.js';
import { parseHagezi } from './hagezi.js';

export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export const SOURCE_CONFIG = Object.freeze({
  hagezi: {
    id: 'hagezi',
    name: 'Hagezi Pro',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/pro.txt',
    seedPath: 'rules/hagezi-pro.txt',
  },
  easylist: {
    id: 'easylist',
    name: 'EasyList',
    url: 'https://easylist-downloads.adblockplus.org/easylist.txt',
    seedPath: 'rules/easylist.txt',
  },
});

export async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function readResponseLimited(response, maxBytes = MAX_SOURCE_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`Source exceeds ${maxBytes} bytes`);
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > maxBytes) throw new Error(`Source exceeds ${maxBytes} bytes`);
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Source exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function validateAndCompile(sourceId, text, thresholds = {}) {
  if (!String(text || '').trim()) throw new Error(`${sourceId} source is empty`);
  if (sourceId === 'hagezi') {
    const compiled = parseHagezi(text);
    const minimum = thresholds.minimumHageziDomains ?? 1_000;
    if (compiled.domains.length < minimum) throw new Error(`Hagezi source has only ${compiled.domains.length} valid domains`);
    if (compiled.stats.malformed > Math.max(20, compiled.domains.length * 0.02)) throw new Error('Hagezi source is unexpectedly malformed');
    return compiled;
  }
  if (sourceId === 'easylist') {
    if (!/^\[Adblock Plus/i.test(String(text).trimStart())) throw new Error('EasyList header is missing');
    const compiled = parseEasyList(text);
    const minimum = thresholds.minimumEasyListCosmeticRules ?? 1_000;
    if (compiled.stats.cosmetic < minimum) throw new Error(`EasyList source has only ${compiled.stats.cosmetic} cosmetic rules`);
    return compiled;
  }
  throw new Error(`Unknown source: ${sourceId}`);
}

export async function refreshSource({ source, previous, fetchImpl = fetch, now = Date.now(), thresholds }) {
  const headers = {};
  if (previous?.etag) headers['If-None-Match'] = previous.etag;
  if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;
  const response = await fetchImpl(source.url, { cache: 'no-store', headers });

  if (response.status === 304) {
    if (!previous) throw new Error(`${source.name} returned 304 without a local snapshot`);
    return { kind: 'not-modified', checkedAt: now, requestHeaders: headers };
  }
  if (!response.ok) throw new Error(`${source.name} returned HTTP ${response.status}`);

  const text = await readResponseLimited(response);
  const compiled = validateAndCompile(source.id, text, thresholds);
  const previousAccepted = source.id === 'hagezi'
    ? previous?.stats?.accepted
    : previous?.stats?.cosmetic;
  const nextAccepted = source.id === 'hagezi'
    ? compiled.stats.accepted
    : compiled.stats.cosmetic;
  if (previousAccepted && nextAccepted < previousAccepted * 0.8) {
    throw new Error(`${source.name} update is unexpectedly truncated (${nextAccepted} rules; previously ${previousAccepted})`);
  }
  const hash = await sha256(text);
  const metadata = {
    sourceId: source.id,
    url: source.url,
    hash,
    version: compiled.version || hash.slice(0, 12),
    fetchedAt: now,
    checkedAt: now,
    etag: response.headers.get('etag') || '',
    lastModified: response.headers.get('last-modified') || '',
    sizeBytes: new TextEncoder().encode(text).length,
    stats: compiled.stats,
  };

  if (previous?.hash === hash) return { kind: 'unchanged-hash', metadata, requestHeaders: headers };
  return { kind: 'replace', text, compiled, metadata, requestHeaders: headers };
}
