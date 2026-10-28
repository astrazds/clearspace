import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture, easylist } from './browser-fixture.mjs';

async function capturePopup(popup, state) {
  if (!process.env.CLEARSPACE_POPUP_SCREENSHOT_DIR) return;
  const directory = path.resolve(process.env.CLEARSPACE_POPUP_SCREENSHOT_DIR);
  await mkdir(directory, { recursive: true });
  for (const colorScheme of ['light', 'dark']) {
    await popup.emulateMedia({ colorScheme });
    const clip = await popup.locator('body').boundingBox();
    assert.ok(clip);
    await popup.screenshot({ clip, path: path.join(directory, `${state}-${colorScheme}.png`) });
  }
  await popup.emulateMedia({ colorScheme: 'light' });
}

async function openPopup({ context, page, harness }, fault) {
  const popup = await context.newPage();
  popup.setDefaultTimeout(3000);
  await popup.addInitScript((fault) => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.requests = [];
    chrome.runtime.sendMessage = (...args) => { window.requests.push(args[0].type); return send(...args); };
    if (fault === 'reload') {
      const reload = chrome.tabs.reload.bind(chrome.tabs); let failures = 2;
      chrome.tabs.reload = (...args) => failures-- > 0 ? Promise.reject(new Error('Fixture reload failed')) : reload(...args);
    }
    if (fault === 'save') {
      const original = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = (...args) => args[0].type.endsWith('/set-host-preference')
        ? Promise.reject(new Error('Fixture save failed')) : original(...args);
    }
    if (fault === 'delayed-save') {
      const original = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = (...args) => args[0].type.endsWith('/set-host-preference')
        ? new Promise((_, reject) => { window.rejectSave = () => reject(new Error('Fixture delayed save failed')); })
        : original(...args);
    }
  }, fault);
  await popup.goto(`chrome-extension://${new URL(harness.url()).host}/popup.html`);
  await page.bringToFront();
  await popup.reload();
  await popup.locator('#hostname').filter({ hasText: 'public.test' }).waitFor();
  return popup;
}

test('normal popup is compact and loads update metadata only on disclosure', async () => fixture(async (env) => {
  const popup = await openPopup(env);
  assert.equal(await popup.locator('#site-status').innerText(), 'Cleanup is on');
  assert.equal(await popup.getByRole('button', { name: 'Reload page', exact: true }).isVisible(), false);
  assert.equal(await popup.locator('details').getAttribute('open'), null);
  await capturePopup(popup, 'normal');
  assert.equal(await popup.evaluate(() => window.requests.some(type => type.endsWith('/get-refresh-status'))), false);
  await popup.locator('summary').click();
  await popup.getByText('Using bundled rules.', { exact: true }).waitFor();
  assert.equal(await popup.getByRole('button', { name: 'Check now', exact: true }).isVisible(), true);
}));

test('automatic update failure stays in Updates and retries through the button', async () => fixture(async (env) => {
  await env.context.route('https://raw.githubusercontent.com/**', route => route.fulfill({ status: 503, body: 'unavailable' }));
  await env.context.route('https://easylist-downloads.adblockplus.org/**', route => route.fulfill({ body: easylist }));
  await env.harness.evaluate(async () => {
    const { makeRequest, MESSAGE } = await import('./src/protocol.js');
    await chrome.runtime.sendMessage(makeRequest({ type: MESSAGE.REFRESH_SOURCES }));
  });
  const popup = await openPopup(env);
  assert.equal(await popup.locator('details').getAttribute('open'), null);
  assert.equal(await popup.locator('#site-status').innerText(), 'Cleanup is on');
  await popup.locator('summary').click();
  await popup.getByText("Couldn't update.", { exact: true }).waitFor();
  assert.equal(await popup.getByText('Saved rules are still active.', { exact: true }).isVisible(), true);
  await capturePopup(popup, 'update-failure');
  assert.equal(await popup.locator('#reload').isVisible(), false);
  await env.context.unroute('https://raw.githubusercontent.com/**');
  await env.context.route('https://raw.githubusercontent.com/**', route => route.fulfill({status: 304}));
  await popup.getByRole('button', { name: 'Try again', exact: true }).click();
  await popup.getByText('Rules are up to date.', { exact: true }).waitFor();
  assert.equal(await popup.getByText('Saved rules are still active.', { exact: true }).isVisible(), false);
}));

test('failed save keeps the applied setting and does not expose Reload page', async () => fixture(async (env) => {
  const popup = await openPopup(env, 'save');
  await popup.getByRole('switch').click();
  await popup.getByText("Couldn't save. Your setting is unchanged.", { exact: true }).waitFor();
  assert.equal(await popup.locator('#enabled').evaluate(el => el.checked), true);
  assert.equal(await popup.locator('#reload').isVisible(), false);
}));

test('saved setting survives reload failures and the Reload page button recovers', async () => fixture(async (env) => {
  const popup = await openPopup(env, 'reload');
  await popup.getByRole('switch').click();
  await popup.getByText('Setting saved. Reload to apply.', { exact: true }).waitFor();
  const reload = popup.getByRole('button', { name: 'Reload page', exact: true });
  assert.equal(await reload.isVisible(), true);
  await capturePopup(popup, 'reload-needed');
  await reload.click();
  await popup.getByText("Couldn't reload. Your setting is saved.", { exact: true }).waitFor();
  assert.equal(await reload.isEnabled(), true);
  const closed = popup.waitForEvent('close');
  await reload.click();
  await closed;
  const reopened = await openPopup(env);
  await reopened.getByText('Cleanup is off', { exact: true }).waitFor();
  assert.equal(await reopened.locator('#reload').isVisible(), false);
}));

test('reopening after an unsuccessful reload shows saved versus applied state', async () => fixture(async (env) => {
  const first = await openPopup(env, 'reload');
  await first.getByRole('switch').click();
  await first.getByText('Setting saved. Reload to apply.', { exact: true }).waitFor();
  await first.close();
  const reopened = await openPopup(env);
  await reopened.getByText('Setting saved. Reload to apply.', { exact: true }).waitFor();
  assert.equal(await reopened.locator('#enabled').evaluate(el => el.checked), false);
  assert.equal(await reopened.locator('#reload').isVisible(), true);
}));

test('new rules offer Reload page without claiming they already changed this document', async () => fixture(async (env) => {
  await env.context.route('https://raw.githubusercontent.com/**', route => route.fulfill({status: 304}));
  await env.context.route('https://easylist-downloads.adblockplus.org/**', route => route.fulfill({ body: easylist + '\n##.new-ad' }));
  const popup = await openPopup(env);
  await popup.locator('summary').click();
  await popup.getByRole('button', {name: 'Check now', exact: true}).click();
  await popup.getByText('Rules updated.', {exact: true}).waitFor();
  await popup.getByText('New rules are ready. Reload to apply.', {exact: true}).waitFor();
  assert.equal(await popup.locator('#reload').isVisible(), true);
}));

test('reverting an unapplied setting needs no second reload', async () => fixture(async (env) => {
  const popup = await openPopup(env, 'reload');
  await popup.getByRole('switch').click();
  await popup.getByText('Setting saved. Reload to apply.', {exact: true}).waitFor();
  const before = await env.page.evaluate(() => performance.timeOrigin);
  const closed = popup.waitForEvent('close');
  await popup.getByRole('switch').click();
  await closed;
  assert.equal(await env.page.evaluate(() => performance.timeOrigin), before);
  const reopened = await openPopup(env);
  await reopened.getByText('Cleanup is on', {exact: true}).waitFor();
  assert.equal(await reopened.locator('#reload').isVisible(), false);
}));

test('failed preference save retains reload recovery for rules installed concurrently', async () => fixture(async (env) => {
  await env.context.route('https://raw.githubusercontent.com/**', route => route.fulfill({status: 304}));
  await env.context.route('https://easylist-downloads.adblockplus.org/**', route => route.fulfill({ body: easylist + '\n##.new-ad' }));
  const popup = await openPopup(env, 'delayed-save');
  await popup.locator('summary').click();
  await popup.getByText('Using bundled rules.', {exact: true}).waitFor();
  await popup.getByRole('switch').click();
  await popup.getByRole('button', {name:'Check now',exact:true}).click();
  await popup.getByText('Rules updated.', {exact:true}).waitFor();
  await popup.evaluate(() => window.rejectSave());
  await popup.getByText("Couldn't save. Your setting is unchanged.", {exact:true}).waitFor();
  assert.equal(await popup.locator('#reload').isVisible(), true);
  assert.equal(await popup.locator('#reload').isEnabled(), true);
  const closed = popup.waitForEvent('close');
  await popup.locator('#reload').click();
  await closed;
}));

