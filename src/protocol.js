export const PROTOCOL_VERSION = 1;

export const MESSAGE = Object.freeze({
  GET_APPLICABLE_SELECTORS: 'clearspace:v1/get-applicable-selectors',
  CLASSIFY_HOSTNAMES: 'clearspace:v1/classify-hostnames',
  REFRESH_SOURCES: 'clearspace:v1/refresh-sources',
  GET_REFRESH_STATUS: 'clearspace:v1/get-refresh-status',
  SET_HOST_PREFERENCE: 'clearspace:v1/set-host-preference',
  GET_TAB_STATUS: 'clearspace:v1/get-tab-status',
});



export function makeRequest(request) {
  switch (request.type) {
    case MESSAGE.GET_APPLICABLE_SELECTORS:
      return { type: request.type, version: PROTOCOL_VERSION, hostname: request.hostname };
    case MESSAGE.CLASSIFY_HOSTNAMES:
      return {
        type: request.type,
        version: PROTOCOL_VERSION,
        pageHostname: request.pageHostname,
        hostnames: request.hostnames,
      };
    case MESSAGE.SET_HOST_PREFERENCE:
      return {
        type: request.type,
        version: PROTOCOL_VERSION,
        hostname: request.hostname,
        enabled: request.enabled,
      };
    case MESSAGE.REFRESH_SOURCES:
    case MESSAGE.GET_REFRESH_STATUS:
    case MESSAGE.GET_TAB_STATUS:
      return { type: request.type, version: PROTOCOL_VERSION };
  }
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isProtocolMessage(value) {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION) return false;

  switch (value.type) {
    case MESSAGE.GET_APPLICABLE_SELECTORS:
      return typeof value.hostname === 'string';
    case MESSAGE.CLASSIFY_HOSTNAMES:
      return (value.pageHostname === undefined || typeof value.pageHostname === 'string')
        && (value.hostnames === undefined
          || (Array.isArray(value.hostnames)
            && value.hostnames.every((hostname) => typeof hostname === 'string')));
    case MESSAGE.SET_HOST_PREFERENCE:
      return typeof value.hostname === 'string' && typeof value.enabled === 'boolean';
    case MESSAGE.REFRESH_SOURCES:
    case MESSAGE.GET_REFRESH_STATUS:
    case MESSAGE.GET_TAB_STATUS:
      return true;
    default:
      return false;
  }
}
