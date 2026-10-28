import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { releaseKind, nextVersion, validateState } from '../scripts/version-policy.mjs';
import { readVersions, applyVersion } from '../scripts/version-files.mjs';

test('one release decision covers a mixed feature/fix PR', () => {
  assert.equal(releaseKind(['release:minor', 'bug'], ['popup.js', 'tests/popup.test.mjs']), 'minor');
  assert.equal(releaseKind(['release:patch'], ['src/content/entry.js']), 'patch');
  for (const labels of [[], ['release:patch', 'release:minor'], ['release:major']]) {
    assert.throws(() => releaseKind(labels, ['popup.js']), /exactly one/);
  }
});

test('docs and tests do not bump; renaming product code is not docs-only', () => {
  const files = ['README.md', 'docs/how-to.md', 'tests/parser.test.mjs', 'scripts/popup.test.mjs'];
  assert.equal(releaseKind(['release:none'], files), 'none');
  assert.throws(() => releaseKind(['release:patch'], files), /docs\/tests-only/);
  assert.equal(releaseKind(['release:minor'], ['docs/old.md', 'popup.js']), 'minor');
  assert.equal(releaseKind(['release:none'], ['.github/workflows/ci.yml']), 'none');
  assert.throws(() => releaseKind(['release:none'], []), /files/);
});

test('versions use strict numeric triplets and Chrome bounds', () => {
  assert.equal(nextVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(nextVersion('0.1.12', 'minor'), '0.2.0');
  assert.equal(nextVersion('0.1.0', 'none'), '0.1.0');
  for (const version of ['0.0.0', '01.2.3', '1.2', '1.2.3-beta', '1.65536.0']) {
    assert.throws(() => nextVersion(version, 'patch'), /version/);
  }
  assert.throws(() => nextVersion('1.2.65535', 'patch'), /version/);
  assert.throws(() => nextVersion('1.65535.2', 'minor'), /version/);
});

test('durable history must be unique, well formed and match the current version', () => {
  const state = { schema: 1, baseline: 'a'.repeat(40), initialVersion: '0.1.0', processed: [
    { pr: 9, mergeCommit: 'b'.repeat(40), kind: 'minor', version: '0.2.0' },
    { pr: 10, mergeCommit: 'c'.repeat(40), kind: 'none', version: '0.2.0' },
  ] };
  validateState(state, '0.2.0');
  assert.throws(() => validateState(state, '0.1.0'), /history/);
  assert.throws(() => validateState({ ...state, processed: [...state.processed, state.processed[0]] }, '0.2.0'), /duplicate/);
  assert.throws(() => validateState({ ...state, schema: 2 }, '0.2.0'), /state/);
});

test('npm updates both package versions and manifest without dependency churn', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clearspace-version-'));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'version-test', version: '0.1.0', private: true }));
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'version-test', version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'version-test', version: '0.1.0' } } }));
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ version: '0.1.0', permissions: ['storage'] }));
    assert.equal(await readVersions(root), '0.1.0');
    await applyVersion(root, '0.2.0');
    assert.equal(await readVersions(root), '0.2.0');
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'manifest.json'))).permissions, ['storage']);
    for (const file of ['package.json', 'package-lock.json', 'manifest.json']) {
      const original = await readFile(path.join(root, file), 'utf8');
      await writeFile(path.join(root, file), original.replace('0.2.0', '0.9.0'));
      await assert.rejects(readVersions(root), /mismatch/);
      await writeFile(path.join(root, file), original);
    }
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json')));
    lock.packages[''].version = '0.3.0';
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock));
    await assert.rejects(readVersions(root), /mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
