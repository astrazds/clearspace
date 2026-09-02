import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readResponseLimited,
  refreshSource,
  sha256,
  validateAndCompile,
} from '../src/source-validation.js';

const hageziText = '# Version: seed\n*.ads.example.com\n*.metrics.example.net\n';
const easyListText = '[Adblock Plus 2.0]\n! Version: seed\n##.ad\nexample.com##.slot\n';

test('validates both source formats and rejects truncated updates', () => {
  assert.equal(validateAndCompile('hagezi', hageziText, { minimumHageziDomains: 2 }).domains.length, 2);
  assert.equal(validateAndCompile('easylist', easyListText, { minimumEasyListCosmeticRules: 2 }).stats.cosmetic, 2);
  assert.throws(() => validateAndCompile('hagezi', '*.one.example\n'), /only 1 valid domains/);
  assert.throws(() => validateAndCompile('easylist', '[Adblock Plus]\n##.one\n'), /only 1 cosmetic rules/);
  assert.throws(() => validateAndCompile('easylist', '##.one\n', { minimumEasyListCosmeticRules: 1 }), /header is missing/);
});

test('sends conditional headers and accepts 304 only with a local snapshot', async () => {
  let captured;
  const result = await refreshSource({
    source: { id: 'hagezi', name: 'Hagezi', url: 'https://source.invalid/list' },
    previous: { etag: '"abc"', lastModified: 'yesterday', hash: 'old' },
    fetchImpl: async (_url, options) => {
      captured = options;
      return new Response(null, { status: 304 });
    },
    now: 42,
  });
  assert.deepEqual(captured.headers, { 'If-None-Match': '"abc"', 'If-Modified-Since': 'yesterday' });
  assert.deepEqual(result, { kind: 'not-modified', checkedAt: 42, requestHeaders: captured.headers });
  await assert.rejects(() => refreshSource({
    source: { id: 'hagezi', name: 'Hagezi', url: 'https://source.invalid/list' },
    fetchImpl: async () => new Response(null, { status: 304 }),
  }), /without a local snapshot/);
});

test('recognizes unchanged hashes without replacing compiled data', async () => {
  const hash = await sha256(hageziText);
  const result = await refreshSource({
    source: { id: 'hagezi', name: 'Hagezi', url: 'https://source.invalid/list' },
    previous: { hash },
    fetchImpl: async () => new Response(hageziText, { status: 200, headers: { etag: 'new' } }),
    thresholds: { minimumHageziDomains: 2 },
    now: 7,
  });
  assert.equal(result.kind, 'unchanged-hash');
  assert.equal(result.metadata.etag, 'new');
  assert.equal('compiled' in result, false);
});

test('rejects a structurally valid update that shrinks unexpectedly', async () => {
  await assert.rejects(() => refreshSource({
    source: { id: 'hagezi', name: 'Hagezi', url: 'https://source.invalid/list' },
    previous: { stats: { accepted: 10 } },
    fetchImpl: async () => new Response(hageziText, { status: 200 }),
    thresholds: { minimumHageziDomains: 2 },
  }), /unexpectedly truncated/);
});

test('enforces byte limits before and during body reads', async () => {
  await assert.rejects(
    () => readResponseLimited(new Response('small', { headers: { 'content-length': '100' } }), 10),
    /exceeds 10 bytes/,
  );
  await assert.rejects(
    () => readResponseLimited(new Response('this body is too large'), 5),
    /exceeds 5 bytes/,
  );
});

test('a failed independent update leaves caller-owned last-known-good state intact', async () => {
  const state = { hagezi: { hash: 'kept' }, easylist: { hash: 'other' } };
  await assert.rejects(() => refreshSource({
    source: { id: 'hagezi', name: 'Hagezi', url: 'https://source.invalid/list' },
    previous: state.hagezi,
    fetchImpl: async () => new Response('truncated', { status: 200 }),
  }), /valid domains/);
  assert.deepEqual(state, { hagezi: { hash: 'kept' }, easylist: { hash: 'other' } });
});
