const PRIVATE_SUFFIXES = [
  'localhost',
  'local',
  'lan',
  'internal',
  'home',
  'home.arpa',
];

export function normalizeHostname(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!raw) return '';
  try {
    return new URL(`http://${raw}`).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  } catch {
    return raw;
  }
}

export function isValidDomain(value) {
  const host = normalizeHostname(value);
  if (!host || host.length > 253 || host.includes(':')) return false;
  const labels = host.split('.');
  return labels.length >= 2 && labels.every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

export function hostnameSuffixes(value) {
  const host = normalizeHostname(value);
  if (!host || host.includes(':')) return host ? [host] : [];
  const labels = host.split('.');
  return labels.map((_, index) => labels.slice(index).join('.'));
}

export function createSuffixMatcher(domains = []) {
  const suffixes = new Set(Array.from(domains, normalizeHostname).filter(Boolean));
  return {
    size: suffixes.size,
    has(hostname) {
      return hostnameSuffixes(hostname).some((suffix) => suffixes.has(suffix));
    },
    toJSON() {
      return [...suffixes].sort();
    },
  };
}

function parseIpv4(host) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split('.').map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

function isPrivateIpv4(parts) {
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIpv6(host) {
  if (!host.includes(':')) return false;
  if (host === '::1') return true;
  const first = Number.parseInt(host.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

export function isPrivateHostname(value) {
  const host = normalizeHostname(value);
  if (!host) return true;
  const ipv4 = parseIpv4(host);
  if (ipv4) return isPrivateIpv4(ipv4);
  if (isPrivateIpv6(host)) return true;
  return PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function hostEnabled(hostname, preferences = {}) {
  const host = normalizeHostname(hostname);
  const disabled = new Set(preferences.disabledPublicHosts || []);
  const enabledPrivate = new Set(preferences.enabledPrivateHosts || []);
  return isPrivateHostname(host) ? enabledPrivate.has(host) : !disabled.has(host);
}

export function updateHostPreference(preferences, hostname, enabled) {
  const host = normalizeHostname(hostname);
  if (!host) throw new Error('A valid hostname is required');
  const disabled = new Set(preferences.disabledPublicHosts || []);
  const enabledPrivate = new Set(preferences.enabledPrivateHosts || []);

  if (isPrivateHostname(host)) {
    disabled.delete(host);
    enabled ? enabledPrivate.add(host) : enabledPrivate.delete(host);
  } else {
    enabledPrivate.delete(host);
    enabled ? disabled.delete(host) : disabled.add(host);
  }

  return {
    disabledPublicHosts: [...disabled].sort(),
    enabledPrivateHosts: [...enabledPrivate].sort(),
  };
}
