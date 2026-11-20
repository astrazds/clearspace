#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer as createSocketServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const skillRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const repoRoot = path.resolve(skillRoot, '../../..');
const runDir = path.join(skillRoot, 'run');
const sessionPath = path.join(runDir, 'session.json');
const toolsDir = path.join(skillRoot, '.tools');
const browsersPath = path.join(toolsDir, 'browsers');
const playwrightDir = path.join(toolsDir, 'playwright');
const playwrightEntry = path.join(playwrightDir, 'node_modules', 'playwright-core', 'index.mjs');
const playwrightCli = path.join(playwrightDir, 'node_modules', 'playwright-core', 'cli.js');
const fixturePath = path.join(skillRoot, 'fixtures', 'article.html');
const port = 8877;
const controlPort = 8878;
const display = ':98';
const evidenceNames = ['site-toggle', 'public-cleanup', 'updates', 'unavailable-page'];
const ids = {
  article: 'clearspace-fixture-article',
  note: 'clearspace-fixture-note',
  slot: 'clearspace-fixture-slot',
};
const switchName = 'Clean up this site';
const adRule = '.ad-banner-container{display:none!important}';

let sessionContext = null;
let article = null;
let popup = null;
let extensionId = '';
let httpServer = null;
let xvfbProcess = null;
let browserPid = 0;
let shuttingDown = false;
const logs = [];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
  } catch {
    return '';
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function browserPidFor(profileDir) {
  const hits = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const command = cmdline(pid);
    if (!command.includes(profileDir) || !command.includes('chrom') || command.includes('--type=')) continue;
    hits.push(pid);
  }
  return hits.length === 1 ? hits[0] : 0;
}

async function signal(pid, needle) {
  if (!alive(pid) || !cmdline(pid).includes(needle)) return;
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 3000;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (alive(pid) && cmdline(pid).includes(needle)) process.kill(pid, 'SIGKILL');
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail(`unknown argument ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`missing value for ${token}`);
    out[token.slice(2)] = value;
    index += 1;
  }
  return out;
}

function splitAction(action) {
  const index = action.indexOf(':');
  if (index === -1) return { name: action, args: '' };
  return { name: action.slice(0, index), args: action.slice(index + 1) };
}

function evidenceDir(input) {
  const resolved = path.resolve(input);
  const root = path.resolve(skillRoot, 'evidence');
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`evidence must be under ${root}`);
  }
  return resolved;
}

async function ensureTools() {
  const started = Date.now();
  if (!existsSync(playwrightEntry)) {
    console.error('installing playwright-core 1.62.1');
    await mkdir(playwrightDir, { recursive: true });
    await writeFile(path.join(playwrightDir, 'package.json'), `${JSON.stringify({
      private: true,
      dependencies: { 'playwright-core': '1.62.1' },
    }, null, 2)}\n`);
    await execFileAsync('npm', ['install', '--ignore-scripts', '--no-fund', '--no-audit'], {
      cwd: playwrightDir,
    });
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  const { chromium } = await import(pathToFileURL(playwrightEntry).href);
  let executable = '';
  try {
    executable = chromium.executablePath();
  } catch {
    executable = '';
  }
  if (!executable || !existsSync(executable)) {
    console.error('installing verification Chromium');
    await execFileAsync(process.execPath, [playwrightCli, 'install', 'chromium'], {
      cwd: playwrightDir,
      env: process.env,
    });
  }
  return { chromium, toolsMs: Date.now() - started };
}

function attachLogs(page, label) {
  page.on('console', (message) => logs.push(`[${label}] ${message.type()} ${message.text()}`));
  page.on('pageerror', (error) => logs.push(`[${label}] ${error}`));
}

async function waitForWorker() {
  const pick = () => sessionContext.serviceWorkers().filter((worker) => worker.url().endsWith('/background.js'));
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const found = pick();
    if (found.length > 1) throw new Error(`expected one Clearspace service worker, found ${found.length}`);
    if (found.length === 1) return found[0];
    const remaining = Math.max(1, deadline - Date.now());
    const event = await sessionContext.waitForEvent('serviceworker', { timeout: remaining }).catch((error) => {
      if (String(error).includes('Timeout')) return null;
      throw error;
    });
    if (!event && pick().length === 0) break;
  }
  throw new Error(`expected one Clearspace service worker, found ${pick().length}`);
}

async function startFixtureServer(nonce) {
  const body = await readFile(fixturePath);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://fixture.local').pathname;
    if (pathname === '/favicon.ico') {
      response.writeHead(204, { 'x-clearspace-verify': nonce, 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (pathname !== '/' && pathname !== '/article.html') {
      response.writeHead(404, { 'x-clearspace-verify': nonce, 'cache-control': 'no-store' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-clearspace-verify': nonce,
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function readPage() {
  const view = { url: article.url() };
  for (const [key, id] of Object.entries(ids)) {
    const locator = article.locator(`#${id}`);
    const count = await locator.count();
    if (count !== 1) throw new Error(`#${id} matched ${count} elements`);
    const display = await locator.evaluate((element) => getComputedStyle(element).display);
    view[key] = display === 'none' ? 'hidden' : 'visible';
  }
  const styles = article.locator('style[data-clearspace="cosmetic"]');
  const styleCount = await styles.count();
  if (styleCount > 1) throw new Error(`cosmetic style matched ${styleCount} elements`);
  view.cosmeticStyles = styleCount;
  view.hasAdRule = false;
  if (styleCount === 1) {
    const text = await styles.evaluate((element) => element.textContent || '');
    view.hasAdRule = text.includes(adRule);
  }
  return view;
}

function expectPage(view, ad, articleState, note, rule) {
  if (rule !== 'rule' && rule !== 'no-rule') throw new Error(`bad rule token ${rule}`);
  const problems = [];
  if (view.slot !== ad) problems.push(`ad slot is ${view.slot}, expected ${ad}`);
  if (view.article !== articleState) problems.push(`article is ${view.article}, expected ${articleState}`);
  if (view.note !== note) problems.push(`sponsor note is ${view.note}, expected ${note}`);
  const wantRule = rule === 'rule';
  if (view.hasAdRule !== wantRule) {
    problems.push(wantRule
      ? 'stylesheet has no .ad-banner-container hide'
      : 'stylesheet hid .ad-banner-container while cleanup should be off');
  }
  if (view.cosmeticStyles !== (wantRule ? 1 : 0)) problems.push(`cosmetic style count is ${view.cosmeticStyles}`);
  if (problems.length) throw new Error(problems.join('; '));
  return view;
}

async function readPopup(page) {
  const status = page.locator('#site-status');
  const hostname = page.locator('#hostname');
  const switches = page.getByRole('switch', { name: switchName, exact: true });
  if (await status.count() !== 1) throw new Error(`#site-status matched ${await status.count()} elements`);
  if (await hostname.count() !== 1) throw new Error(`#hostname matched ${await hostname.count()} elements`);
  if (await switches.count() !== 1) throw new Error(`${switchName} matched ${await switches.count()} elements`);
  return {
    status: (await status.innerText()).trim(),
    hostname: (await hostname.innerText()).trim(),
    hostnameHidden: await hostname.isHidden(),
    checked: await switches.isChecked(),
    switchEnabled: await switches.isEnabled(),
  };
}

async function waitForPopupStatus(page) {
  await page.waitForFunction(() => {
    const text = document.querySelector('#site-status')?.textContent ?? '';
    return text.length > 0 && text !== 'Checking current page...';
  }, undefined, { timeout: 45000 });
}

async function openPopup() {
  if (popup && !popup.isClosed()) throw new Error('a popup is already open');
  const page = await sessionContext.newPage();
  page.setDefaultTimeout(20000);
  attachLogs(page, 'popup');
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await article.bringToFront();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForPopupStatus(page);
  const switches = page.getByRole('switch', { name: switchName, exact: true });
  if (await switches.count() !== 1) throw new Error(`${switchName} matched ${await switches.count()} elements`);
  popup = page;
  return readPopup(page);
}

async function openUnavailable() {
  if (popup && !popup.isClosed()) throw new Error('a popup is already open');
  const page = await sessionContext.newPage();
  page.setDefaultTimeout(20000);
  attachLogs(page, 'popup');
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForPopupStatus(page);
  popup = page;
  return readPopup(page);
}

async function closePopup() {
  if (!popup || popup.isClosed()) throw new Error('no popup is open');
  await popup.close();
  popup = null;
  return { closed: true };
}

async function gotoPrivate() {
  const url = `http://127.0.0.1:${port}/article.html`;
  await article.goto(url, { waitUntil: 'domcontentloaded' });
  await article.locator(`#${ids.article}`).waitFor({ state: 'visible', timeout: 20000 });
  await article.locator(`#${ids.note}`).waitFor({ state: 'visible', timeout: 20000 });
  await article.locator(`#${ids.slot}`).waitFor({ state: 'visible', timeout: 20000 });
  return readPage();
}

async function gotoPublic() {
  const url = `http://article.test:${port}/article.html`;
  await article.goto(url, { waitUntil: 'domcontentloaded' });
  await article.locator(`#${ids.article}`).waitFor({ state: 'visible', timeout: 20000 });
  await article.locator(`#${ids.note}`).waitFor({ state: 'visible', timeout: 20000 });
  await article.locator('style[data-clearspace="cosmetic"]').waitFor({ state: 'attached', timeout: 45000 });
  await article.locator(`#${ids.slot}`).waitFor({ state: 'hidden', timeout: 20000 });
  return expectPage(await readPage(), 'hidden', 'visible', 'visible', 'rule');
}

async function shot(kind, name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad screenshot name ${name}`);
  const page = kind === 'page' ? article : popup;
  if (!page || page.isClosed()) throw new Error(`no ${kind} is open`);
  const png = path.join(currentEvidence, `${name}.png`);
  const aria = path.join(currentEvidence, `${name}.aria.txt`);
  if (kind === 'page') await page.screenshot({ path: png, fullPage: true });
  else await page.locator('body').screenshot({ path: png });
  const snapshot = await page.locator('body').ariaSnapshot();
  await writeFile(aria, `${snapshot}\n`);
  return { png: path.basename(png), aria: path.basename(aria) };
}

let currentEvidence = '';

async function toggle() {
  if (!popup || popup.isClosed()) throw new Error('toggle needs an open popup. Run open-popup first.');
  const before = await readPopup(popup);
  if (before.status !== 'Cleanup is on' && before.status !== 'Cleanup is off') {
    throw new Error(`refusing to toggle from status ${JSON.stringify(before.status)}`);
  }
  const turningOn = before.status === 'Cleanup is off';
  const switches = popup.getByRole('switch', { name: switchName, exact: true });
  if (await switches.count() !== 1) throw new Error(`${switchName} matched ${await switches.count()} elements`);
  if (!(await switches.isEnabled())) throw new Error(`${switchName} is disabled`);
  const origin = await article.evaluate(() => performance.timeOrigin);
  const closed = popup.waitForEvent('close', { timeout: 20000 });
  const navigated = article.waitForFunction(
    (previous) => performance.timeOrigin !== previous,
    origin,
    { timeout: 20000 },
  );
  try {
    await switches.click();
  } catch (error) {
    if (!popup.isClosed()) throw error;
  }
  try {
    await closed;
  } catch {
    const status = popup.isClosed() ? '' : (await readPopup(popup)).status;
    throw new Error(`popup did not close after the switch. status=${JSON.stringify(status)}`);
  }
  popup = null;
  await navigated;
  await article.waitForLoadState('domcontentloaded');
  await article.locator(`#${ids.article}`).waitFor({ state: 'visible', timeout: 20000 });
  await article.locator(`#${ids.note}`).waitFor({ state: 'visible', timeout: 20000 });
  if (turningOn) {
    await article.locator('style[data-clearspace="cosmetic"]').waitFor({ state: 'attached', timeout: 45000 });
    await article.locator(`#${ids.slot}`).waitFor({ state: 'hidden', timeout: 20000 });
  } else {
    await article.waitForFunction(
      () => document.querySelectorAll('style[data-clearspace="cosmetic"]').length === 0,
      undefined,
      { timeout: 20000 },
    );
    await article.locator(`#${ids.slot}`).waitFor({ state: 'visible', timeout: 20000 });
  }
  return { turnedOn: turningOn, page: await readPage() };
}

async function openUpdates() {
  if (!popup || popup.isClosed()) throw new Error('open-updates needs an open popup');
  const summary = popup.locator('summary');
  if (await summary.count() !== 1) throw new Error(`summary matched ${await summary.count()} elements`);
  const text = (await summary.innerText()).trim();
  if (text !== 'Updates') throw new Error(`summary text ${JSON.stringify(text)}`);
  await summary.click();
  if (await popup.locator('details').count() !== 1) throw new Error('expected one Updates details element');
  await popup.locator('details[open]').waitFor({ state: 'attached' });
  return { open: true };
}

async function assertUpdates(expected) {
  if (!popup || popup.isClosed()) throw new Error('assert-updates needs an open popup');
  const result = popup.locator('#refresh-result');
  if (await result.count() !== 1) throw new Error(`#refresh-result matched ${await result.count()} elements`);
  await result.filter({ hasText: new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).waitFor({ timeout: 20000 });
  const button = popup.getByRole('button', { name: 'Check now', exact: true });
  if (await button.count() !== 1) throw new Error(`Check now matched ${await button.count()} elements`);
  if (!(await button.isEnabled())) throw new Error('Check now is disabled');
  const status = (await result.innerText()).trim();
  return { status, button: 'Check now' };
}

async function checkNow() {
  if (!popup || popup.isClosed()) throw new Error('check-now needs an open popup');
  const button = popup.getByRole('button', { name: 'Check now', exact: true });
  if (await button.count() !== 1) throw new Error(`Check now matched ${await button.count()} elements`);
  await button.click();
  const result = popup.locator('#refresh-result');
  await result.filter({
    hasText: /^(Rules updated\.|Rules are up to date\.|Couldn't update\.|Couldn't check for updates\.)$/,
  }).waitFor({ timeout: 60000 });
  const status = (await result.innerText()).trim();
  if (status !== 'Rules updated.' && status !== 'Rules are up to date.') {
    throw new Error(`Check now finished as ${JSON.stringify(status)}. That is not a successful update check.`);
  }
  const page = await readPage();
  if (page.article !== 'visible' || page.note !== 'visible') {
    throw new Error('Check now changed the article or the sponsor note');
  }
  return { status, page };
}

async function assertPopup(args) {
  if (!popup || popup.isClosed()) throw new Error('assert-popup needs an open popup');
  const parts = args.split(':');
  if (parts.length < 3) throw new Error(`bad assert-popup ${args}`);
  const host = parts[0];
  const checkedWord = parts.at(-1);
  const status = parts.slice(1, -1).join(':');
  if (checkedWord !== 'checked' && checkedWord !== 'unchecked') throw new Error(`bad checked token ${checkedWord}`);
  const view = await readPopup(popup);
  if (view.hostname !== host || view.status !== status || view.checked !== (checkedWord === 'checked') || view.hostnameHidden) {
    throw new Error(`popup is hostname=${JSON.stringify(view.hostname)} hidden=${view.hostnameHidden} status=${JSON.stringify(view.status)} checked=${view.checked}`);
  }
  return view;
}

async function assertUnavailable() {
  const view = await readPopup(popup);
  const problems = [];
  if (view.status !== "Cleanup isn't available on this page.") problems.push(`status ${JSON.stringify(view.status)}`);
  if (view.checked) problems.push('switch is checked');
  if (view.switchEnabled) problems.push('switch is enabled');
  if (!view.hostnameHidden) problems.push(`hostname is visible as ${JSON.stringify(view.hostname)}`);
  if (problems.length) throw new Error(problems.join('; '));
  return view;
}

async function perform(action) {
  const { name, args } = splitAction(action);
  if (name === 'goto-private') return gotoPrivate();
  if (name === 'goto-public') return gotoPublic();
  if (name === 'open-popup') return openPopup();
  if (name === 'open-unavailable') return openUnavailable();
  if (name === 'close-popup') return closePopup();
  if (name === 'open-updates') return openUpdates();
  if (name === 'assert-updates') return assertUpdates(args);
  if (name === 'check-now') return checkNow();
  if (name === 'assert-popup') return assertPopup(args);
  if (name === 'assert-unavailable') return assertUnavailable();
  if (name === 'assert-page') {
    const [ad, articleState, note, rule] = args.split(':');
    return expectPage(await readPage(), ad, articleState, note, rule);
  }
  if (name === 'shot-page') return shot('page', args);
  if (name === 'shot-popup') return shot('popup', args);
  if (name === 'toggle') return toggle();
  throw new Error(`unknown action ${action}`);
}

async function writeState(dir, actions, steps, error) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'state.json'), `${JSON.stringify({
    actions,
    steps,
    error: error ? String(error.message || error) : null,
  }, null, 2)}\n`);
  await writeFile(path.join(dir, 'console.txt'), `${logs.join('\n')}\n`);
}

async function runActions(dir, actions) {
  currentEvidence = dir;
  const steps = [];
  try {
    for (const action of actions) {
      steps.push({ action, ...(await perform(action)) });
    }
  } catch (error) {
    await writeState(dir, actions, steps, error);
    throw error;
  }
  await writeState(dir, actions, steps, null);
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const chromiumPid = browserPid || browserPidFor(path.join(runDir, 'profile'));
  const xvfbPid = xvfbProcess?.pid;
  if (sessionContext) {
    await Promise.race([
      sessionContext.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  await signal(chromiumPid, 'chrom');
  await signal(xvfbPid, display);
  httpServer?.close();
  await rm(sessionPath, { force: true });
}

function call(message) {
  return new Promise((resolve, reject) => {
    const socket = connect(controlPort, '127.0.0.1');
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('drive socket timed out'));
    }, 180000);
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      clearTimeout(timer);
      socket.end();
      resolve(JSON.parse(buffer));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write(`${JSON.stringify(message)}\n`);
  });
}

async function launch() {
  const started = Date.now();
  if (existsSync(sessionPath)) fail(`a session already exists at ${sessionPath}`);
  if (existsSync(`/tmp/.X11-unix/X${display.slice(1)}`)) fail(`display ${display} is already in use`);
  if (!existsSync(fixturePath)) fail(`missing fixture ${fixturePath}`);
  const manifestPath = path.join(repoRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const extensionDir = path.join(repoRoot, 'dist', 'unpacked', `clearspace-${manifest.version}`);
  if (!existsSync(path.join(extensionDir, 'manifest.json'))) {
    fail(`missing ${extensionDir}. Run mise install, mise run install, and mise run package.`);
  }
  const { chromium, toolsMs } = await ensureTools();
  await mkdir(runDir, { recursive: true });
  const nonce = randomBytes(8).toString('hex');
  const privateUrl = `http://127.0.0.1:${port}/article.html`;
  const publicUrl = `http://article.test:${port}/article.html`;
  const profile = path.join(runDir, 'profile');
  await mkdir(profile, { recursive: true });
  process.on('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
  try {
    xvfbProcess = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    const displaySocket = `/tmp/.X11-unix/X${display.slice(1)}`;
    const displayDeadline = Date.now() + 5000;
    while (!existsSync(displaySocket)) {
      if (Date.now() > displayDeadline) throw new Error(`Xvfb did not create ${displaySocket}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    httpServer = await startFixtureServer(nonce);
    sessionContext = await chromium.launchPersistentContext(profile, {
      headless: false,
      viewport: { width: 1100, height: 800 },
      deviceScaleFactor: 1,
      env: { ...process.env, DISPLAY: display },
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--host-resolver-rules=MAP article.test 127.0.0.1',
        '--no-proxy-server',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-component-update',
        '--disable-sync',
      ],
    });
    browserPid = browserPidFor(profile);
    if (!browserPid) throw new Error(`could not find the Chromium process for ${profile}`);
    const session = {
      pid: process.pid,
      browserPid,
      xvfbPid: xvfbProcess.pid,
      display,
      port,
      nonce,
      extensionId: '',
      extensionDir,
      version: manifest.version,
      privateUrl,
      publicUrl,
      ready: false,
    };
    await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
    article = sessionContext.pages()[0] || await sessionContext.newPage();
    article.setDefaultTimeout(20000);
    attachLogs(article, 'page');
    const workerPromise = waitForWorker();
    await article.goto(privateUrl, { waitUntil: 'domcontentloaded' });
    const worker = await workerPromise;
    extensionId = new URL(worker.url()).host;
    worker.on('console', (message) => logs.push(`[worker] ${message.type()} ${message.text()}`));
    session.extensionId = extensionId;
    session.browserPid = browserPid;
    await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
    const popupStarted = Date.now();
    const popupView = await openPopup();
    const pageView = await readPage();
    expectPage(pageView, 'visible', 'visible', 'visible', 'no-rule');
    if (popupView.hostname !== '127.0.0.1' || popupView.status !== 'Cleanup is off' || popupView.checked || popupView.hostnameHidden) {
      throw new Error(`launch popup hostname=${JSON.stringify(popupView.hostname)} status=${JSON.stringify(popupView.status)} checked=${popupView.checked}`);
    }
    await closePopup();
    const popupMs = Date.now() - popupStarted;
    const socketServer = createSocketServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        const message = JSON.parse(buffer);
        buffer = '';
        handle(message)
          .then((response) => {
            socket.write(`${JSON.stringify(response)}\n`);
            if (message.op === 'cleanup') setImmediate(() => shutdown().finally(() => process.exit(0)));
          })
          .catch((error) => {
            socket.end(`${JSON.stringify({ ok: false, error: String(error.stack || error) })}\n`);
          });
      });
    });
    await new Promise((resolve, reject) => {
      socketServer.once('error', reject);
      socketServer.listen(controlPort, '127.0.0.1', resolve);
    });
    session.ready = true;
    await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
    const setupMs = Date.now() - started;
    console.log(`ready url=${privateUrl} extension=${extensionId} version=${manifest.version} hostname=127.0.0.1 status=Cleanup is off ad=visible article=visible note=visible setup_ms=${setupMs} tools_ms=${toolsMs} popup_ms=${popupMs}`);
    await new Promise(() => {});
  } catch (error) {
    console.error(String(error.stack || error));
    if (logs.length) console.error(logs.slice(-20).join('\n'));
    await shutdown();
    process.exit(1);
  }

  async function handle(message) {
    if (message.op === 'doctor') {
      const counts = {};
      for (const [key, id] of Object.entries(ids)) counts[key] = await article.locator(`#${id}`).count();
      const workers = sessionContext.serviceWorkers().filter((worker) => worker.url().endsWith('/background.js'));
      return { ok: true, counts, pageUrl: article.url(), extensionId, workers: workers.length };
    }
    if (message.op === 'run') {
      const dir = evidenceDir(message.evidence);
      const actions = String(message.actions || '').split(',').map((item) => item.trim()).filter(Boolean);
      if (!actions.length) throw new Error('run needs actions');
      await mkdir(dir, { recursive: true });
      await runActions(dir, actions);
      return { ok: true, evidence: dir };
    }
    if (message.op === 'cleanup') return { ok: true };
    throw new Error(`unknown op ${message.op}`);
  }
}

async function doctor() {
  if (!existsSync(sessionPath)) fail('no session. Launch first.');
  const session = JSON.parse(await readFile(sessionPath, 'utf8'));
  if (!session.ready) fail('launch has not printed ready');
  if (!alive(session.pid) || !cmdline(session.pid).includes('drive.mjs')) {
    fail(`session pid ${session.pid} is not drive.mjs`);
  }
  const response = await fetch(session.privateUrl);
  if (response.headers.get('x-clearspace-verify') !== session.nonce) fail('the port is not the verify server');
  const manifest = JSON.parse(await readFile(path.join(session.extensionDir, 'manifest.json'), 'utf8'));
  if (manifest.name !== 'Clearspace' || manifest.version !== session.version) {
    fail(`loaded manifest is ${manifest.name} ${manifest.version}`);
  }
  const live = await call({ op: 'doctor' });
  if (!live.ok) fail(live.error || 'doctor failed');
  if (live.extensionId !== session.extensionId) fail('extension id changed');
  if (live.workers !== 1) fail(`background workers=${live.workers}`);
  if (live.counts.article !== 1 || live.counts.slot !== 1 || live.counts.note !== 1) {
    fail(`fixture counts article=${live.counts.article} slot=${live.counts.slot} note=${live.counts.note}`);
  }
  console.log(`doctor ok server=${session.privateUrl} page=${live.pageUrl} pid=${session.pid} port=${session.port} extension=${session.extensionId} version=${session.version} article=1 slot=1 note=1`);
}

async function run(options) {
  const started = Date.now();
  if (!options.evidence || !options.actions) fail('run needs --evidence and --actions');
  const response = await call({ op: 'run', evidence: options.evidence, actions: options.actions });
  if (!response.ok) fail(response.error || 'run failed');
  console.log(`pass evidence=${options.evidence} verify_ms=${Date.now() - started}`);
}

async function killSession() {
  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  await signal(session.browserPid, 'chrom');
  await signal(session.xvfbPid, session.display);
  await signal(session.pid, 'drive.mjs');
  await rm(sessionPath, { force: true });
}

async function cleanup() {
  if (existsSync(sessionPath)) {
    const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
    if (alive(session.pid)) await call({ op: 'cleanup' }).catch(() => {});
    if (existsSync(sessionPath)) await killSession();
  }
  await rm(runDir, { recursive: true, force: true });
  for (const name of evidenceNames) {
    console.log(`evidence .cursor/skills/verify-clearspace/evidence/${name}`);
  }
  console.log('cleanup ok');
}

const command = process.argv[2];
const options = parseArgs(process.argv.slice(3));
if (command === 'launch') await launch();
else if (command === 'doctor') await doctor();
else if (command === 'run') await run(options);
else if (command === 'cleanup') await cleanup();
else fail('usage: drive.mjs launch|doctor|run|cleanup');
