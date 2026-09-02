import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeCssSelector, mergeEasyLists, parseEasyList, resolveSelectors } from '../src/easylist.js';

const rules = parseEasyList(`[Adblock Plus 2.0]
! Version: test-1
##.generic-ad
~excluded.example##.generic-with-exclusion
example.com,news.test##.scoped-ad
example.com,~shop.example.com##.except-subdomain
example.com#@#.scoped-ad
shop.example.com##.shop-only
@@||nogeneric.example^$generichide
nogeneric.example##.domain-still-applies
@@||nohide.example^$elemhide
||network.example^
##:contains(sponsored)
example.com#$#.bad { remove: true }
##div[
`);

test('resolves generic, included, excluded, and domain-specific exception rules', () => {
  assert.deepEqual(resolveSelectors(rules, 'www.example.com').sort(), [
    '.except-subdomain', '.generic-ad', '.generic-with-exclusion',
  ]);
  assert.deepEqual(resolveSelectors(rules, 'shop.example.com').sort(), [
    '.generic-ad', '.generic-with-exclusion', '.shop-only',
  ]);
  assert.equal(resolveSelectors(rules, 'excluded.example').includes('.generic-with-exclusion'), false);
});

test('generichide preserves domain-specific rules while elemhide suppresses all hiding', () => {
  assert.deepEqual(resolveSelectors(rules, 'nogeneric.example'), ['.domain-still-applies']);
  assert.deepEqual(resolveSelectors(rules, 'nohide.example'), []);
});

test('counts and rejects unsupported, network, and invalid rules', () => {
  assert.equal(rules.version, 'test-1');
  assert.equal(rules.stats.networkIgnored, 1);
  assert.equal(rules.stats.unsupported, 2);
  assert.equal(rules.stats.invalid, 1);
  assert.equal(isSafeCssSelector('article > .advertisement'), true);
  assert.equal(isSafeCssSelector('div:-abp-has(.ad)'), false);
  assert.equal(isSafeCssSelector('div { remove: true }'), false);
});

test('exceptions and page flags apply across merged upstream and local lists', () => {
  const upstream = parseEasyList('[Adblock Plus 2.0]\n##.upstream-ad\n##.locally-restored\n');
  const local = parseEasyList('[Adblock Plus 2.0]\n#@#.locally-restored\nexample.com##.local-ad\n');
  assert.deepEqual(resolveSelectors(mergeEasyLists(upstream, local), 'example.com').sort(), [
    '.local-ad', '.upstream-ad',
  ]);
});
