import { MESSAGE } from '../../src/protocol.js';

/** @typedef {import('../../src/protocol.js').RequestInput} RequestInput */
/** @typedef {import('../../src/source-validation.js').RefreshResult} RefreshResult */

/** @type {{ type: typeof MESSAGE.GET_APPLICABLE_SELECTORS } extends RequestInput ? true : false} */
const acceptsMissingHostname = false;

/** @type {{ type: typeof MESSAGE.CLASSIFY_HOSTNAMES } extends RequestInput ? true : false} */
const acceptsMissingClassificationPayload = false;

/** @type {{ type: typeof MESSAGE.SET_HOST_PREFERENCE, hostname: string } extends RequestInput ? true : false} */
const acceptsMissingPreferenceValue = false;

/** @type {{ at: number, kind: 'error', ok: false } extends RefreshResult ? true : false} */
const acceptsFailureWithoutError = false;

/** @type {{ at: number, kind: 'updated', ok: false, error: string } extends RefreshResult ? true : false} */
const acceptsContradictoryRefreshResult = false;
