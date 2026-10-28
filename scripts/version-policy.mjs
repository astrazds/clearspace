const kinds = new Map([['release:minor', 'minor'], ['release:patch', 'patch'], ['release:none', 'none']]);
const sha = /^[a-f0-9]{40}$/;

export function releaseKind(labels, files) {
  const releaseLabels = labels.filter(label => label.startsWith('release:'));
  if (releaseLabels.length !== 1 || !kinds.has(releaseLabels[0])) {
    throw new Error('Choose exactly one of release:minor, release:patch, release:none');
  }
  if (!files.length || files.some(file => typeof file !== 'string' || !file)) throw new Error('Missing PR files');
  const kind = kinds.get(releaseLabels[0]);
  const docsTestsOnly = files.every(file => /\.md$/i.test(file)
    || file.startsWith('docs/') || file.startsWith('tests/')
    || /^scripts\/[^/]+\.test\.mjs$/.test(file));
  if (docsTestsOnly && kind !== 'none') throw new Error('A docs/tests-only PR must use release:none');
  return kind;
}

export function parseVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Invalid version: ${version}`);
  }
  const parts = version.split('.').map(Number);
  if (parts.some(part => part > 65535) || parts.every(part => part === 0)) throw new Error(`Invalid Chrome version: ${version}`);
  return parts;
}

export function nextVersion(version, kind) {
  const parts = parseVersion(version);
  if (kind === 'minor') { parts[1]++; parts[2] = 0; }
  else if (kind === 'patch') parts[2]++;
  else if (kind !== 'none') throw new Error(`Invalid release kind: ${kind}`);
  const next = parts.join('.');
  parseVersion(next);
  return next;
}

export function validateState(state, version) {
  if (state?.schema !== 1 || !sha.test(state.baseline) || !Array.isArray(state.processed)) throw new Error('Invalid release state');
  let current = nextVersion(state.initialVersion, 'none');
  const prs = new Set();
  const commits = new Set();
  for (const entry of state.processed) {
    if (!Number.isSafeInteger(entry.pr) || entry.pr < 1 || !sha.test(entry.mergeCommit)) throw new Error('Invalid release state entry');
    if (prs.has(entry.pr) || commits.has(entry.mergeCommit)) throw new Error('Invalid duplicate release history');
    prs.add(entry.pr); commits.add(entry.mergeCommit);
    current = nextVersion(current, entry.kind);
    if (entry.version !== current) throw new Error('Invalid version history');
  }
  if (current !== version) throw new Error('Version does not match release history');
}
