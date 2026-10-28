import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchExtension } from './browser.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
export const easylist = '[Adblock Plus 2.0]\n! Version: A\n##.generic-ad\n@@||public.test^$generichide,domain=other.test\n'
  + Array.from({ length: 1000 }, (_, i) => `##.fixture-${i}`).join('\n');
const hagezi = '# Version: A\n*.ads.fixture.test\n'
  + Array.from({ length: 1000 }, (_, i) => `*.ad-${i}.invalid`).join('\n');

export async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'clearspace-robustness-'));
  let context;
  try {
    const extension = path.join(directory, 'extension');
    await cp(path.join(root, `dist/unpacked/clearspace-${version}`), extension, { recursive: true });
    await writeFile(path.join(extension, 'rules/easylist.txt'), easylist);
    await writeFile(path.join(extension, 'rules/hagezi-pro.txt'), hagezi);
    await writeFile(path.join(extension, 'harness.html'), '<!doctype html><title>Test harness</title>');
    context = await launchExtension(path.join(directory, 'profile'), extension);
    await context.route('http://public.test/**', (route) => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><html><head></head><body><main>Article</main></body></html>',
    }));
    await context.route('https://ads.fixture.test/**', (route) => route.abort());
    await context.route('https://clean.fixture.test/**', (route) => route.fulfill({
      contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'),
    }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const harness = await context.newPage();
    await harness.goto(`chrome-extension://${new URL(worker.url()).host}/harness.html`);
    await harness.evaluate(async () => {
      const { makeRequest, MESSAGE } = await import('./src/protocol.js');
      const result = await chrome.runtime.sendMessage(makeRequest({ type: MESSAGE.GET_REFRESH_STATUS }));
      if (!result.ok) throw new Error(result.error);
    });
    const page = await context.newPage();
    await page.goto('http://public.test/');
    await page.locator('style[data-clearspace]').waitFor({ state: 'attached' });
    await run({ context, page, harness, worker });
  } finally {
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

