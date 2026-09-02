export const PROTOCOL_VERSION = 1;

export const MESSAGE = Object.freeze({
  GET_APPLICABLE_SELECTORS: 'clearspace:v1/get-applicable-selectors',
  CLASSIFY_HOSTNAMES: 'clearspace:v1/classify-hostnames',
  REFRESH_SOURCES: 'clearspace:v1/refresh-sources',
  GET_REFRESH_STATUS: 'clearspace:v1/get-refresh-status',
  SET_HOST_PREFERENCE: 'clearspace:v1/set-host-preference',
  GET_TAB_STATUS: 'clearspace:v1/get-tab-status',
});

export function isMessage(message, type) {
  return Boolean(message && message.version === PROTOCOL_VERSION && message.type === type);
}
