import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyVersion, readJson, readVersions, versionFiles } from './version-files.mjs';
import { validateState } from './version-policy.mjs';
import { mergedInOrder } from './version-github.mjs';
const exec = promisify(execFile);
const lines = text => text.trim() ? text.trim().split('\n') : [];

/** Only call with a dedicated, disposable clone. initialize refuses local edits. */
export function createGitAdapter(root, api, verify) {
  let initialized = false;
  let base;
  const git = async (...args) => (await exec('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  return {
    async initialize() {
      if (await git('status', '--porcelain', '--untracked-files=all')) throw new Error('Versioning requires a clean disposable checkout');
      await git('config', 'user.name', 'github-actions[bot]');
      await git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
      initialized = true;
    },
    async snapshot() {
      if (!initialized) throw new Error('Initialize a disposable checkout first');
      await git('fetch', 'origin', 'main');
      // Discard only this job's unpublished attempt after a non-fast-forward push.
      await git('reset', '--hard', 'origin/main');
      base = await git('rev-parse', 'HEAD');
      const state = await readJson(path.join(root, 'release-state.json'));
      const version = await readVersions(root);
      validateState(state, version);
      await git('merge-base', '--is-ancestor', state.baseline, 'HEAD');
      const history = lines(await git('rev-list', '--first-parent', '--reverse', `${state.baseline}..HEAD`));
      const pulls = mergedInOrder(history, await api.listMerged());
      return { state, version, pulls };
    },
    describe: pull => api.describe(pull),
    async apply(entry, state) {
      if (entry.kind !== 'none') await applyVersion(root, entry.version);
      await writeFile(path.join(root, 'release-state.json'), `${JSON.stringify(state, null, 2)}\n`);
    },
    verify,
    async commit(entry) {
      const version = await readVersions(root);
      validateState(await readJson(path.join(root, 'release-state.json')), version);
      const changes = new Set([
        ...lines(await git('diff', '--name-only')),
        ...lines(await git('diff', '--cached', '--name-only')),
        ...lines(await git('ls-files', '--others', '--exclude-standard')),
      ]);
      for (const file of changes) if (!versionFiles.includes(file)) throw new Error(`Unexpected changed file: ${file}`);
      await git('add', '--', ...versionFiles);
      const description = entry.kind === 'none' ? 'record no release' : entry.version;
      await git('commit', '-m', `chore(version): ${description} for PR #${entry.pr}`);
    },
    async push() {
      try {
        await git('push', 'origin', 'HEAD:refs/heads/main');
        return true;
      } catch (error) {
        await git('fetch', 'origin', 'main');
        const remote = await git('rev-parse', 'origin/main');
        if (remote === await git('rev-parse', 'HEAD')) return true; // server accepted, response lost
        if (remote !== base) return false;
        throw error; // permissions/protection/network failure, not a concurrent update
      }
    },
  };
}
