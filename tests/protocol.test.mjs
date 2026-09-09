import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isProtocolMessage,
  makeRequest,
  MESSAGE,
  PROTOCOL_VERSION,
} from '../src/protocol.js';

test('builds the exact v1 request envelopes used by maintained callers', () => {
  assert.deepEqual(MESSAGE, {
    GET_APPLICABLE_SELECTORS: 'clearspace:v1/get-applicable-selectors',
    CLASSIFY_HOSTNAMES: 'clearspace:v1/classify-hostnames',
    REFRESH_SOURCES: 'clearspace:v1/refresh-sources',
    GET_REFRESH_STATUS: 'clearspace:v1/get-refresh-status',
    SET_HOST_PREFERENCE: 'clearspace:v1/set-host-preference',
    GET_TAB_STATUS: 'clearspace:v1/get-tab-status',
  });
  assert.deepEqual(
    makeRequest({ type: MESSAGE.GET_APPLICABLE_SELECTORS, hostname: 'news.example' }),
    {
      type: 'clearspace:v1/get-applicable-selectors',
      version: PROTOCOL_VERSION,
      hostname: 'news.example',
    },
  );
  assert.deepEqual(
    makeRequest({
      type: MESSAGE.CLASSIFY_HOSTNAMES,
      pageHostname: 'news.example',
      hostnames: ['ads.example'],
    }),
    {
      type: 'clearspace:v1/classify-hostnames',
      version: PROTOCOL_VERSION,
      pageHostname: 'news.example',
      hostnames: ['ads.example'],
    },
  );
  assert.deepEqual(
    makeRequest({
      type: MESSAGE.SET_HOST_PREFERENCE,
      hostname: 'news.example',
      enabled: false,
    }),
    {
      type: 'clearspace:v1/set-host-preference',
      version: PROTOCOL_VERSION,
      hostname: 'news.example',
      enabled: false,
    },
  );
});

test('validates incoming messages while retaining legacy classification defaults', () => {
  assert.equal(isProtocolMessage({
    type: MESSAGE.CLASSIFY_HOSTNAMES,
    version: PROTOCOL_VERSION,
  }), true);
  assert.equal(isProtocolMessage({
    type: MESSAGE.CLASSIFY_HOSTNAMES,
    version: PROTOCOL_VERSION,
    hostnames: ['ads.example'],
  }), true);
  assert.equal(isProtocolMessage({
    type: MESSAGE.CLASSIFY_HOSTNAMES,
    version: PROTOCOL_VERSION,
    hostnames: [42],
  }), false);
  assert.equal(isProtocolMessage({
    type: MESSAGE.GET_APPLICABLE_SELECTORS,
    version: PROTOCOL_VERSION,
  }), false);
  assert.equal(isProtocolMessage({
    type: MESSAGE.REFRESH_SOURCES,
    version: 2,
  }), false);
});
