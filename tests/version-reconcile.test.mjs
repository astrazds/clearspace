import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../scripts/version-reconcile.mjs';

const hash = n => n.toString(16).padStart(40, '0');
const pr = (number, label = 'patch') => ({ number, mergeCommit: hash(number), labels: [`release:${label}`], files: [label === 'none' ? 'README.md' : 'popup.js'] });
function fixture(pulls) {
  let durable = { version: '0.1.0', state: { schema: 1, baseline: hash(1), initialVersion: '0.1.0', processed: [] } };
  let draft;
  const calls = [];
  const adapter = {
    async snapshot() { calls.push('snapshot'); return structuredClone({ ...durable, pulls }); },
    async apply(entry, state) { calls.push(`apply:${entry.pr}`); draft = { version: entry.version, state }; },
    async verify() { calls.push('verify'); },
    async commit(entry) { calls.push(`commit:${entry.pr}`); },
    async push() { calls.push('push'); durable = structuredClone(draft); return true; },
  };
  return { adapter, calls, get durable() { return durable; }, set durable(value) { durable = value; } };
}

test('reconciles ordered mixed merges once and ignores later label edits', async () => {
  const pulls = [pr(9, 'minor'), pr(10), pr(11, 'none')];
  const f = fixture(pulls);
  assert.equal(await reconcile(f.adapter), 3);
  assert.deepEqual(f.durable.state.processed.map(e => e.version), ['0.2.0', '0.2.1', '0.2.1']);
  pulls[0].labels = [];
  assert.equal(await reconcile(f.adapter), 0);
  assert.equal(f.calls.filter(c => c === 'push').length, 3);
});

test('invalid classification blocks later merges without silently skipping', async () => {
  const f = fixture([pr(9), { ...pr(10), labels: [] }, pr(11)]);
  await assert.rejects(reconcile(f.adapter), /exactly one/);
  assert.deepEqual(f.durable.state.processed.map(e => e.pr), [9]);
});

test('failed verification never commits or publishes', async () => {
  const f = fixture([pr(9)]);
  f.adapter.verify = async () => { throw new Error('gate failed'); };
  await assert.rejects(reconcile(f.adapter), /gate failed/);
  assert.equal(f.durable.version, '0.1.0');
  assert.ok(!f.calls.some(c => c.startsWith('commit:')));
});

test('a concurrent main change recomputes before retrying and cannot duplicate a bump', async () => {
  const f = fixture([pr(9), pr(10, 'minor')]);
  const push = f.adapter.push;
  let first = true;
  f.adapter.push = async () => {
    if (first) {
      first = false;
      // Another worker has already published the same first decision.
      f.durable = { version: '0.1.1', state: { ...f.durable.state,
        processed: [{ pr: 9, mergeCommit: hash(9), kind: 'patch', version: '0.1.1' }] } };
      return false;
    }
    return push();
  };
  await reconcile(f.adapter);
  assert.deepEqual(f.durable.state.processed.map(e => e.pr), [9, 10]);
  assert.equal(f.durable.version, '0.2.0');
});

test('rerun after a crash following successful push does not bump again', async () => {
  const f = fixture([pr(9)]);
  const push = f.adapter.push;
  f.adapter.push = async () => { await push(); throw new Error('connection lost'); };
  await assert.rejects(reconcile(f.adapter), /connection lost/);
  f.adapter.push = push;
  assert.equal(await reconcile(f.adapter), 0);
  assert.equal(f.durable.version, '0.1.1');
});

test('out-of-order or divergent history fails closed', async () => {
  const f = fixture([pr(9), pr(10)]);
  f.durable = { version: '0.1.1', state: { ...f.durable.state,
    processed: [{ pr: 10, mergeCommit: hash(10), kind: 'patch', version: '0.1.1' }] } };
  await assert.rejects(reconcile(f.adapter), /merge order/);
});

test('persistent push conflicts stop after a bounded number of retries', async () => {
  const f = fixture([pr(9)]);
  f.adapter.push = async () => false;
  await assert.rejects(reconcile(f.adapter, { maxConflicts: 3 }), /concurrent/);
  assert.equal(f.calls.filter(c => c === 'verify').length, 3);
});
