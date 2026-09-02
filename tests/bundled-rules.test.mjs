import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateAndCompile } from '../src/source-validation.js';

test('bundled first-run snapshots pass production validation', async () => {
  const [hagezi, easylist] = await Promise.all([
    readFile(new URL('../rules/hagezi-pro.txt', import.meta.url), 'utf8'),
    readFile(new URL('../rules/easylist.txt', import.meta.url), 'utf8'),
  ]);
  assert.ok(validateAndCompile('hagezi', hagezi).domains.length >= 1_000);
  assert.ok(validateAndCompile('easylist', easylist).stats.cosmetic >= 1_000);
});
