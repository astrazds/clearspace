import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createGitAdapter } from '../scripts/version-git.mjs';
import { reconcile } from '../scripts/version-reconcile.mjs';
import { readVersions, readJson } from '../scripts/version-files.mjs';
const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', args, { cwd })).stdout.trim();

async function setup(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clearspace-release-'));
  try {
    const remote = path.join(root, 'remote.git');
    const author = path.join(root, 'author');
    const bot = path.join(root, 'bot');
    await git(root, 'init', '--bare', '--initial-branch=main', remote);
    await git(root, 'clone', remote, author);
    await git(author, 'config', 'user.name', 'Test');
    await git(author, 'config', 'user.email', 'test@example.invalid');
    const json = (name, body) => writeFile(path.join(author, name), JSON.stringify(body, null, 2) + '\n');
    await json('package.json', { name: 'test-release', version: '0.1.0', private: true });
    await json('package-lock.json', { name: 'test-release', version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'test-release', version: '0.1.0' } } });
    await json('manifest.json', { version: '0.1.0', permissions: ['storage'] });
    const commit = async message => { await git(author, 'add', '.'); await git(author, 'commit', '-m', message); return git(author, 'rev-parse', 'HEAD'); };
    const baseline = await commit('baseline');
    await json('release-state.json', { schema: 1, baseline, initialVersion: '0.1.0', processed: [] });
    const first = await commit('feature');
    await writeFile(path.join(author, 'README.md'), 'Documentation\n');
    const second = await commit('docs');
    await git(author, 'push', 'origin', 'main');
    await git(root, 'clone', remote, bot);
    const pulls = [
      { number: 10, merge_commit_sha: second, merged_at: 'date', base: { ref: 'main' } },
      { number: 9, merge_commit_sha: first, merged_at: 'date', base: { ref: 'main' } },
    ];
    const api = { async listMerged() { return pulls; }, async describe(pull) {
      return { labels: [`release:${pull.number === 9 ? 'minor' : pull.number === 10 ? 'none' : 'patch'}`], files: [pull.number === 10 ? 'README.md' : 'popup.js'] };
    } };
    await run({ root, remote, author, bot, pulls, api, commit });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('real Git/npm retries a moving main, records each PR once, preserves product changes', async () => setup(async ({ remote, author, bot, api, pulls, commit }) => {
  let moved = false;
  const adapter = createGitAdapter(bot, api, async () => {
    await readVersions(bot);
    if (!moved) {
      moved = true;
      await writeFile(path.join(author, 'popup.js'), '// concurrent fix\n');
      const sha = await commit('fix');
      pulls.push({ number: 11, merge_commit_sha: sha, merged_at: 'date', base: { ref: 'main' } });
      await git(author, 'push', 'origin', 'main');
    }
  });
  await adapter.initialize();
  assert.equal(await reconcile(adapter), 3);
  assert.equal(await readVersions(bot), '0.2.1');
  assert.deepEqual((await readJson(path.join(bot, 'release-state.json'))).processed.map(e => e.pr), [9, 10, 11]);
  assert.equal(await readFile(path.join(bot, 'popup.js'), 'utf8'), '// concurrent fix\n');
  assert.equal(await reconcile(adapter), 0);
  const head = await git(bot, 'rev-parse', 'HEAD');
  assert.equal(await git(remote, 'rev-parse', 'main'), head);
  const commits = (await git(bot, 'log', '-3', '--format=%s')).split('\n');
  assert.deepEqual(commits, ['chore(version): 0.2.1 for PR #11', 'chore(version): record no release for PR #10', 'chore(version): 0.2.0 for PR #9']);
}));

test('bot refuses unrelated file changes and preserves remote on a failed gate', async () => setup(async ({ remote, bot, api }) => {
  const before = await git(remote, 'rev-parse', 'main');
  const adapter = createGitAdapter(bot, api, async () => { await writeFile(path.join(bot, 'README.md'), 'unexpected mutation'); });
  await adapter.initialize();
  await assert.rejects(reconcile(adapter), /Unexpected changed file/);
  assert.equal(await git(remote, 'rev-parse', 'main'), before);
}));

test('adapter refuses an existing dirty checkout before any reset', async () => setup(async ({ bot, api }) => {
  await writeFile(path.join(bot, 'README.md'), 'keep my edit');
  const adapter = createGitAdapter(bot, api, async () => {});
  await assert.rejects(adapter.initialize(), /clean disposable/);
  assert.equal(await readFile(path.join(bot, 'README.md'), 'utf8'), 'keep my edit');
}));
