import { isProtocolMessage, MESSAGE } from './src/protocol.js';
import { createWorkerService } from './src/worker-service.js';

const service = createWorkerService();

function senderHostname(sender) {
  return new URL(sender.url || sender.tab?.url || '').hostname;
}

async function dispatch(request, sender) {
  switch (request.type) {
    case MESSAGE.GET_APPLICABLE_SELECTORS:
      return service.getPagePolicy(request.hostname);
    case MESSAGE.CLASSIFY_HOSTNAMES:
      return service.classifyResources(
        request.pageHostname || senderHostname(sender),
        request.hostnames || [],
      );
    case MESSAGE.REFRESH_SOURCES:
      return { results: await service.refreshAll({ scheduleRetry: true }) };
    case MESSAGE.GET_REFRESH_STATUS:
      return service.getRefreshStatus();
    case MESSAGE.SET_HOST_PREFERENCE:
      return service.setHostEnabled(request.hostname, request.enabled);
    case MESSAGE.GET_TAB_STATUS:
      throw new Error(`Unknown Clearspace message: ${request.type}`);
  }
}

function initialize() {
  service.initialize().catch((error) => console.error('Clearspace initialization failed', error));
}

chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);

chrome.alarms.onAlarm.addListener((alarm) => {
  service.handleAlarm(alarm.name).catch((error) => console.error('Clearspace alarm failed', error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = async () => {
    if (!isProtocolMessage(message)) throw new Error('Unsupported Clearspace message version or payload');
    return dispatch(message, sender);
  };

  respond().then((result) => sendResponse({ ok: true, ...result })).catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

initialize();
