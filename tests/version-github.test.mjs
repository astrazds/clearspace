import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithub, mergedInOrder } from '../scripts/version-github.mjs';

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
