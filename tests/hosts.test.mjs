import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSuffixMatcher,
  hostEnabled,
  hostnameSuffixes,
  isPrivateHostname,
  normalizeHostname,
  updateHostPreference,
} from '../src/hosts.js';

test('normalizes hostnames and matches domain suffixes centrally', () => {
  assert.equal(normalizeHostname('[FC00::1]'), 'fc00::1');
  assert.deepEqual(hostnameSuffixes('ads.media.example.com'), [
    'ads.media.example.com', 'media.example.com', 'example.com', 'com',
  ]);
  const matcher = createSuffixMatcher(['tracker.example.com']);
  assert.equal(matcher.has('img.tracker.example.com'), true);
  assert.equal(matcher.has('nottracker.example.com'), false);
});

test('excludes named private hosts and literal private address ranges', () => {
  for (const host of [
    'localhost', 'box.local', 'router.lan',
    '127.0.0.1', '10.1.2.3', '172.31.2.3', '192.168.2.2',
    '169.254.1.1', '100.127.2.3', '::1', 'fc00::12', 'fdff::2', 'fe80::1',
  ]) assert.equal(isPrivateHostname(host), true, host);
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860:4860::8888']) {
    assert.equal(isPrivateHostname(host), false, host);
  }
});

test('stores exact public disables and private opt-ins separately', () => {
  let preferences = updateHostPreference({}, 'news.example.com', false);
  assert.equal(hostEnabled('news.example.com', preferences), false);
  assert.equal(hostEnabled('other.example.com', preferences), true);
  preferences = updateHostPreference(preferences, 'box.local', true);
  assert.equal(hostEnabled('box.local', preferences), true);
  assert.equal(hostEnabled('other.local', preferences), false);
  preferences = updateHostPreference(preferences, 'news.example.com', true);
  assert.equal(hostEnabled('news.example.com', preferences), true);

  preferences = updateHostPreference({
    disabledPublicHosts: ['box.local'],
    enabledPrivateHosts: ['news.example.com'],
  }, 'box.local', true);
  assert.deepEqual(preferences, {
    disabledPublicHosts: [],
    enabledPrivateHosts: ['box.local', 'news.example.com'],
  });
  preferences = updateHostPreference(preferences, 'news.example.com', false);
  assert.deepEqual(preferences, {
    disabledPublicHosts: ['news.example.com'],
    enabledPrivateHosts: ['box.local'],
  });
});
