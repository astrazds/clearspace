import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithub, mergedInOrder } from '../scripts/version-github.mjs';
import { reconcile } from '../scripts/version-reconcile.mjs';

test('metadata edits between API pages cannot skip an earlier merge and poison history', async () => {
  const hash = n => n.toString(16).padStart(40, '0');
  const earlier = { number: 9, merge_commit_sha: hash(9), merged_at: 'date', base: { ref: 'main' } };
  const later = { number: 10, merge_commit_sha: hash(10), merged_at: 'date', base: { ref: 'main' } };
  const filler = Array.from({ length: 99 }, (_, i) => ({ number: i + 11, merged_at: null }));
  let durable = { version: '0.1.0', state: { schema: 1, baseline: hash(1), initialVersion: '0.1.0', processed: [] } };
  let attempt;
  const api = createGithub('owner/repo', async endpoint => {
    const url = new URL(`https://api.github.com/${endpoint}`);
    const stable = url.searchParams.get('state') === 'all' && url.searchParams.get('sort') === 'created'
      && url.searchParams.get('direction') === 'asc' && !url.searchParams.has('base');
    // On updated order, editing #9 after page one moves it out of page two.
    // All-state creation order stays stable even across reopen/base/label edits.
    if (url.searchParams.get('page') === '1') return stable ? [earlier, later, ...filler.slice(0, 98)] : [later, ...filler];
    return stable ? filler.slice(98) : [filler.at(-1)];
  });
  const adapter = {
    async snapshot() { return structuredClone({ ...durable, pulls: mergedInOrder([hash(9), hash(10)], await api.listMerged()) }); },
    async describe() { return { labels: ['release:patch'], files: ['popup.js'] }; },
    async apply(entry, state) { attempt = { version: entry.version, state }; },
    async verify() {}, async commit() {},
    async push() { durable = attempt; return true; },
  };
  await reconcile(adapter);
  assert.deepEqual(durable.state.processed.map(e => e.pr), [9, 10]);
  assert.equal(await reconcile(adapter), 0);
});

test('GitHub pagination includes all PR files and both sides of a rename', async () => {
  const calls = [];
  const api = createGithub('owner/repo', async endpoint => {
    calls.push(endpoint);
    if (endpoint.endsWith('/pulls/9')) return { number: 9, labels: [{ name: 'release:minor' }], changed_files: 101 };
    if (endpoint.endsWith('&page=1')) return Array.from({ length: 100 }, (_, i) => ({ filename: `tests/${i}.mjs` }));
    return [{ filename: 'docs/old.md', previous_filename: 'popup.js' }];
  });
  const details = await api.describe({ number: 9 });
  assert.equal(details.files.length, 102);
  assert.ok(details.files.includes('popup.js'));
  assert.ok(calls.some(call => call.endsWith('page=2')));
});

test('incomplete file lists fail closed rather than treating product changes as docs', async () => {
  const api = createGithub('owner/repo', async endpoint => endpoint.endsWith('/pulls/9')
    ? { changed_files: 4, labels: [{ name: 'release:none' }] } : [{ filename: 'README.md' }]);
  await assert.rejects(api.describe({ number: 9 }), /Incomplete/);
});

test('merged PR order follows first-parent history, not API order or timestamps', () => {
  const pulls = [
    { number: 3, merge_commit_sha: 'c', merged_at: 'same', base: { ref: 'main' } },
    { number: 1, merge_commit_sha: 'a', merged_at: 'same', base: { ref: 'main' } },
    { number: 4, merge_commit_sha: 'z', merged_at: 'old', base: { ref: 'main' } },
    { number: 5, merge_commit_sha: 'b', merged_at: null, base: { ref: 'main' } },
  ];
  assert.deepEqual(mergedInOrder(['a', 'b', 'c'], pulls).map(p => p.number), [1, 3]);
  assert.throws(() => mergedInOrder(['a'], [...pulls, { ...pulls[1], number: 6 }]), /Ambiguous/);
});
