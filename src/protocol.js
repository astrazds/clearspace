export const PROTOCOL_VERSION = 1;

export const MESSAGE = Object.freeze({
  GET_APPLICABLE_SELECTORS: 'clearspace:v1/get-applicable-selectors',
  CLASSIFY_HOSTNAMES: 'clearspace:v1/classify-hostnames',
  REFRESH_SOURCES: 'clearspace:v1/refresh-sources',
  GET_REFRESH_STATUS: 'clearspace:v1/get-refresh-status',
  SET_HOST_PREFERENCE: 'clearspace:v1/set-host-preference',
  GET_TAB_STATUS: 'clearspace:v1/get-tab-status',
});

/**
 * @typedef {{ type: typeof MESSAGE.GET_APPLICABLE_SELECTORS, hostname: string }
 *   | { type: typeof MESSAGE.CLASSIFY_HOSTNAMES, pageHostname: string, hostnames: string[] }
 *   | { type: typeof MESSAGE.REFRESH_SOURCES }
 *   | { type: typeof MESSAGE.GET_REFRESH_STATUS }
 *   | { type: typeof MESSAGE.SET_HOST_PREFERENCE, hostname: string, enabled: boolean }
 *   | { type: typeof MESSAGE.GET_TAB_STATUS }
 * } RequestInput
 */

/** @typedef {RequestInput & { version: typeof PROTOCOL_VERSION }} ProtocolRequest */
/**
 * @typedef {Exclude<ProtocolRequest, { type: typeof MESSAGE.CLASSIFY_HOSTNAMES }>
 *   | {
 *       type: typeof MESSAGE.CLASSIFY_HOSTNAMES,
 *       version: typeof PROTOCOL_VERSION,
 *       pageHostname?: string,
 *       hostnames?: string[],
 *     }
 * } IncomingProtocolRequest
 */

/**
 * Add the protocol version without weakening the payload required by each request type.
 *
 * @param {RequestInput} request
 * @returns {ProtocolRequest}
 */
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

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is IncomingProtocolRequest}
 */
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
