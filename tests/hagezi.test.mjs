import test from 'node:test';
import assert from 'node:assert/strict';
import { compileHagezi, parseHagezi } from '../src/hagezi.js';

test('parses wildcard and adblock domain forms and ignores non-domains', () => {
  const parsed = parseHagezi(`
# Version: 2026.08.31
*.ads.example.com
||tracker.example.net^
plain.example.org
bad rule / path
`);
  assert.deepEqual(parsed.domains, ['ads.example.com', 'plain.example.org', 'tracker.example.net']);
  assert.equal(parsed.version, '2026.08.31');
  assert.equal(parsed.stats.malformed, 1);
});

test('compiled Hagezi rules suffix-match subdomains without substring matches', () => {
  const compiled = compileHagezi('*.ads.example.com\n');
  assert.equal(compiled.matcher.has('cdn.ads.example.com'), true);
  assert.equal(compiled.matcher.has('safeads.example.com'), false);
});
