import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { MESSAGE, makeRequest } from '../src/protocol.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(repoRoot, 'manifest.json'), 'utf8'));
const extensionSource = path.join(repoRoot, 'dist', 'unpacked', `clearspace-${manifest.version}`);
const fixturesRoot = path.join(repoRoot, 'fixtures');

function chromiumExecutable() {
  if (process.env.CHROMIUM_EXECUTABLE) return process.env.CHROMIUM_EXECUTABLE;
  const systemExecutable = execFileSync(
    'bash',
    ['-lc', 'command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable || true'],
    { encoding: 'utf8' },
  ).trim();
  if (systemExecutable) return systemExecutable;
  const playwrightExecutable = chromium.executablePath();
  if (existsSync(playwrightExecutable)) return playwrightExecutable;
  throw new Error('Chromium executable not found; run `mise run install:browser`');
}

function testHagezi() {
  return ['# Version: smoke-1', '*.ads.fixture.test', ...Array.from({ length: 1_000 }, (_, index) => `*.ad-${index}.fixture.invalid`)].join('\n');
}

function testEasyList(version = 'smoke-1') {
  return [
    '[Adblock Plus 2.0]',
    `! Version: ${version}`,
    '##.generic-ad',
    'public.test##.site-ad',
    '##.exception-kept',
    'public.test#@#.exception-kept',
    ...Array.from({ length: 1_000 }, (_, index) => `##.fixture-ad-${index}`),
  ].join('\n');
}

async function prepareExtension() {
  const directory = await mkdtemp(path.join(tmpdir(), 'clearspace-extension-'));
  await cp(extensionSource, directory, { recursive: true });
  await writeFile(path.join(directory, 'rules', 'hagezi-pro.txt'), testHagezi());
  await writeFile(path.join(directory, 'rules', 'easylist.txt'), testEasyList());
  await writeFile(path.join(directory, 'harness.html'), '<!doctype html><meta charset="utf-8"><title>Clearspace smoke harness</title>');
  return directory;
}

async function createFixtureServer() {
  let port;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://fixture').pathname;
    const filename = pathname === '/frame.html' ? 'frame.html' : pathname === '/private.html' ? 'private.html' : 'public.html';
    try {
      const body = (await readFile(path.join(fixturesRoot, filename), 'utf8')).replaceAll('__PORT__', String(port));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(body);
    } catch (error) {
      response.writeHead(500);
      response.end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
  return { server, port };
}

async function display(page, selector) {
  return page.locator(selector).evaluate((element) => getComputedStyle(element).display);
}

async function send(extensionPage, type, payload = {}) {
  return extensionPage.evaluate((message) => chrome.runtime.sendMessage(message), makeRequest({ type, ...payload }));
}

async function waitForHostEnabled(extensionPage, hostname, enabled) {
  await extensionPage.waitForFunction(async ({ request, expectedEnabled }) => {
    const response = await chrome.runtime.sendMessage(request);
    return response?.ok && response.enabled === expectedEnabled;
  }, { request: makeRequest({ type: MESSAGE.GET_APPLICABLE_SELECTORS, hostname }), expectedEnabled: enabled });
}

async function stopServiceWorker(context, page, scriptUrl) {
  const session = await context.newCDPSession(page);
  let version;
  session.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    version = versions.find((candidate) => candidate.scriptURL === scriptUrl) || version;
  });
  await session.send('ServiceWorker.enable');
  const deadline = Date.now() + 5_000;
  while (!version && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (!version) throw new Error('Could not locate the Clearspace service worker version');
  await session.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await session.detach();
}

const extensionDir = await prepareExtension();
const userDataDir = await mkdtemp(path.join(tmpdir(), 'clearspace-profile-'));
const { server, port } = await createFixtureServer();
let context;

try {
  context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromiumExecutable(),
    headless: true,
    deviceScaleFactor: process.env.CLEARSPACE_POPUP_SCREENSHOT ? 2 : 1,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--host-resolver-rules=MAP public.test 127.0.0.1, MAP frame.public.test 127.0.0.1, MAP private.local 127.0.0.1',
      '--no-proxy-server',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
    ],
  });

  let hageziMode = 'success';
  let easyListVersion = 'smoke-refresh';
  await context.route('https://raw.githubusercontent.com/**', (route) => {
    if (hageziMode === 'fail') return route.fulfill({ status: 503, body: 'fixture failure' });
    return route.fulfill({
      status: 200,
      body: testHagezi(),
      headers: { etag: '"smoke-hagezi"', 'content-type': 'text/plain' },
    });
  });
  await context.route('https://easylist-downloads.adblockplus.org/**', (route) => route.fulfill({
    status: 200,
    body: testEasyList(easyListVersion),
    headers: { etag: `"${easyListVersion}"`, 'content-type': 'text/plain' },
  }));
  await context.route('https://ads.fixture.test/**', (route) => route.abort());

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const harness = await context.newPage();
  await harness.goto(`chrome-extension://${extensionId}/harness.html`);
  const page = await context.newPage();
  await page.goto(`http://public.test:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('style[data-clearspace="cosmetic"]').waitFor({ state: 'attached' });

  if (await display(page, '#generic-ad') !== 'none') throw new Error('Generic cosmetic selector was not applied');
  if (await display(page, '#site-ad') !== 'none') throw new Error('Domain-specific selector was not applied');
  if (await display(page, '#exception-kept') === 'none') throw new Error('Cosmetic exception did not preserve content');
  if (await display(page, '#legitimate-content') === 'none') throw new Error('Legitimate content was hidden');
  await page.locator('#blocked-resource[data-clearspace-hidden="resource"]').waitFor({ state: 'attached' });
  if (await display(page, '#arbitrary-parent') === 'none') throw new Error('An arbitrary resource ancestor was collapsed');
  await page.locator('#explicit-slot[data-clearspace-hidden="ad-slot"]').waitFor({ state: 'attached' });
  await page.locator('#dynamic-blocked-resource[data-clearspace-hidden="resource"]').waitFor({ state: 'attached' });

  const frame = page.frame({ url: new RegExp('frame\\.public\\.test') });
  if (!frame) throw new Error('Fixture frame did not load');
  await frame.locator('style[data-clearspace="cosmetic"]').waitFor({ state: 'attached' });
  if (await display(frame, '#frame-ad') !== 'none') throw new Error('All-frame cosmetic rule was not applied');
  if (await display(frame, '#frame-content') === 'none') throw new Error('All-frame rule hid legitimate content');

  const privatePage = await context.newPage();
  await privatePage.goto(`http://private.local:${port}/private.html`, { waitUntil: 'domcontentloaded' });
  await privatePage.locator('#private-ad').waitFor({ state: 'visible' });
  if (await display(privatePage, '#private-ad') === 'none') throw new Error('Private hostname was not excluded');

  const popupTarget = await context.newPage();
  await popupTarget.goto(`http://public.test:${port}/`, { waitUntil: 'domcontentloaded' });
  await popupTarget.locator('style[data-clearspace="cosmetic"]').waitFor({ state: 'attached' });
  await popupTarget.bringToFront();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popupTarget.bringToFront();
  await popup.reload();
  await popup.locator('#hostname').filter({ hasText: /^public\.test$/ }).waitFor();
  if (!await popup.locator('#enabled').isChecked()) throw new Error('Popup did not show enabled host status');
  const workerStatusBeforeToggle = await send(harness, MESSAGE.GET_APPLICABLE_SELECTORS, { hostname: 'public.test' });
  if (workerStatusBeforeToggle.enabled !== true) throw new Error('Worker was not enabled before the popup toggle');
  await popup.locator('#refresh').click();
  await popup.locator('#refresh-result').filter({ hasText: 'Both sources refreshed' }).waitFor();
  if (process.env.CLEARSPACE_POPUP_SCREENSHOT) {
    const screenshotPath = path.resolve(repoRoot, process.env.CLEARSPACE_POPUP_SCREENSHOT);
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    await popup.locator('body').screenshot({
      path: screenshotPath,
      animations: 'disabled',
      scale: 'device',
    });
  }
  const navigationTimestamp = await popupTarget.evaluate(() => performance.timeOrigin);
  const popupClosed = popup.waitForEvent('close');
  await popup.locator('#enabled').evaluate((input) => {
    input.checked = false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitForHostEnabled(harness, 'public.test', false);
  await harness.waitForFunction(async () => {
    const stored = await chrome.storage.local.get('hostPreferences');
    return stored.hostPreferences?.disabledPublicHosts?.includes('public.test');
  });
  await popupTarget.waitForFunction((before) => performance.timeOrigin !== before, navigationTimestamp);
  await popupClosed;
  await popupTarget.close();
  const disabledPage = await context.newPage();
  await disabledPage.goto(`http://public.test:${port}/`, { waitUntil: 'domcontentloaded' });
  await disabledPage.locator('#generic-ad').waitFor({ state: 'visible' });
  if (await display(disabledPage, '#generic-ad') === 'none') throw new Error('Popup preference did not disable the hostname on a new navigation');
  await disabledPage.close();
  await send(harness, MESSAGE.SET_HOST_PREFERENCE, { hostname: 'public.test', enabled: true });
  await harness.waitForFunction(async () => {
    const stored = await chrome.storage.local.get('hostPreferences');
    return !stored.hostPreferences?.disabledPublicHosts?.includes('public.test');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('style[data-clearspace="cosmetic"]').waitFor({ state: 'attached' });

  const dailyBefore = await harness.evaluate(() => chrome.alarms.get('clearspace-refresh-daily'));
  const workerUrl = worker.url();
  await stopServiceWorker(context, page, workerUrl);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('style[data-clearspace="cosmetic"]').waitFor({ state: 'attached' });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  if (await display(page, '#generic-ad') !== 'none') throw new Error('Rules did not survive a service-worker restart');
  const dailyAfter = await harness.evaluate(() => chrome.alarms.get('clearspace-refresh-daily'));
  if (!dailyBefore || dailyAfter?.scheduledTime !== dailyBefore.scheduledTime) {
    throw new Error('Service-worker restart postponed the scheduled daily refresh');
  }

  const refresh = await send(harness, MESSAGE.REFRESH_SOURCES);
  if (!refresh.ok || Object.values(refresh.results).some((result) => !result.ok)) throw new Error('Manual refresh did not update both sources');
  const beforeFailure = await send(harness, MESSAGE.GET_REFRESH_STATUS);
  hageziMode = 'fail';
  easyListVersion = 'smoke-independent';
  const partialRefresh = await send(harness, MESSAGE.REFRESH_SOURCES);
  if (partialRefresh.results.hagezi.ok || !partialRefresh.results.easylist.ok) throw new Error('Independent source failure handling was not preserved');
  const afterFailure = await send(harness, MESSAGE.GET_REFRESH_STATUS);
  if (afterFailure.sources.hagezi.hash !== beforeFailure.sources.hagezi.hash) throw new Error('Failed source replaced its last-known-good snapshot');
  if (afterFailure.sources.easylist.version !== 'smoke-independent') throw new Error('Healthy source did not update independently');
  hageziMode = 'success';

  const preferenceResults = await Promise.all([
    send(harness, MESSAGE.SET_HOST_PREFERENCE, { hostname: 'first.public.test', enabled: false }),
    send(harness, MESSAGE.SET_HOST_PREFERENCE, { hostname: 'second.public.test', enabled: false }),
  ]);
  if (preferenceResults.some((result) => !result.ok)) throw new Error('Concurrent site toggle failed');
  const concurrentStatus = await send(harness, MESSAGE.GET_REFRESH_STATUS);
  if (!['first.public.test', 'second.public.test'].every((host) => concurrentStatus.preferences.disabledPublicHosts.includes(host))) {
    throw new Error('Concurrent site toggles lost a saved hostname preference');
  }

  console.log(JSON.stringify({
    ok: true,
    extensionId,
    checks: [
      'generic and domain-specific cosmetics',
      'cosmetic exceptions',
      'dynamic Hagezi resources',
      'explicit ad-slot ancestor boundary',
      'private-host exclusion',
      'all-frame behavior',
      'exact-host toggle and reload',
      'concurrent site toggles retain both preferences',
      'service-worker restart persistence',
      'daily refresh deadline survives worker restart',
      'offline bundled-seed startup',
      'manual refresh',
      'independent source failure and last-known-good retention',
      'popup status',
      'popup manual refresh',
    ],
  }, null, 2));
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(extensionDir, { force: true, recursive: true });
  await rm(userDataDir, { force: true, recursive: true });
}
