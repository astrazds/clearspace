import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, easylist } from './browser-fixture.mjs';

test('unsupported conditional exceptions do not suppress cleanup across a whole host', async () => fixture(async ({ page }) => {
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="generic-ad" id="ad">Ad gap</div>'));
  assert.equal(await page.locator('#ad').evaluate(el => getComputedStyle(el).display), 'none');
}));

test('reused resources and their slots recover when the last blocked resource leaves', async () => fixture(async ({ page }) => {
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<aside class="ad-slot" id="slot"><img id="one" src="https://ads.fixture.test/one"><img id="two" src="https://ads.fixture.test/two"></aside>');
  });
  await page.waitForFunction(() => document.querySelector('#one').hasAttribute('data-clearspace-hidden') && document.querySelector('#two').hasAttribute('data-clearspace-hidden'));
  await page.evaluate(() => { document.querySelector('#one').src = 'https://clean.fixture.test/one'; });
  await page.waitForFunction(() => !document.querySelector('#one').hasAttribute('data-clearspace-hidden'), null, { timeout: 3000 });
  assert.equal(await page.locator('#slot').evaluate(el => getComputedStyle(el).display), 'none');
  await page.locator('#two').evaluate(el => el.remove());
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#slot')).display !== 'none', null, { timeout: 3000 });
  assert.notEqual(await page.locator('#one').evaluate(el => getComputedStyle(el).display), 'none');
}));

test('moving a blocked resource releases its old explicit slot without collapsing arbitrary parents', async () => fixture(async ({ page }) => {
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<aside class="ad-slot" id="old"><img id="moving" src="https://ads.fixture.test/one"></aside><section id="article">Useful text</section>'));
  await page.locator('#old[data-clearspace-hidden]').waitFor({ state: 'attached' });
  await page.evaluate(() => document.querySelector('#article').append(document.querySelector('#moving')));
  await page.waitForFunction(() => !document.querySelector('#old').hasAttribute('data-clearspace-hidden'), null, { timeout: 3000 });
  assert.notEqual(await page.locator('#article').evaluate(el => getComputedStyle(el).display), 'none');
  assert.equal(await page.locator('#moving').evaluate(el => getComputedStyle(el).display), 'none');
}));

test('picture cleanup follows the selected image and ignores unused blocked candidates', async () => fixture(async ({ page }) => {
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<picture><source srcset="https://ads.fixture.test/selected"><img id="selected" src="https://clean.fixture.test/fallback"></picture><picture><source media="(min-width: 99999px)" srcset="https://ads.fixture.test/unused"><img id="clean" src="https://clean.fixture.test/image"></picture>'));
  await page.waitForFunction(() => document.querySelector('#selected').currentSrc.includes('ads.fixture.test'));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#selected')).display === 'none', null, { timeout: 3000 });
  assert.notEqual(await page.locator('#clean').evaluate(el => getComputedStyle(el).display), 'none');
  await page.evaluate(() => { document.querySelector('source').srcset = 'https://clean.fixture.test/selected'; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#selected')).display !== 'none', null, { timeout: 3000 });
}));

test('late classification cannot hide a resource whose URL changed', async () => fixture(async ({ page, worker }) => {
  // Delay the storage read below classification, keeping the real protocol and matcher.
  await worker.evaluate(() => {
    const original = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = async (...args) => { await new Promise(resolve => setTimeout(resolve, 200)); return original(...args); };
  });
  await page.evaluate(() => {
    const image = document.createElement('img'); image.id = 'reused'; image.src = 'https://ads.fixture.test/late'; document.body.append(image);
    setTimeout(() => { image.src = 'https://clean.fixture.test/real'; }, 50);
  });
  await page.waitForTimeout(500);
  assert.notEqual(await page.locator('#reused').evaluate(el => getComputedStyle(el).display), 'none');
}));

test('selected video source hides its media owner and clears after reuse', async () => fixture(async ({ page }) => {
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<section id="media-article">Article<video id="video" preload="auto"><source src="https://ads.fixture.test/movie.mp4" type="video/mp4"></video></section>'));
  await page.waitForFunction(() => document.querySelector('#video').currentSrc.includes('ads.fixture.test'));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#video')).display === 'none', null, { timeout: 3000 });
  assert.notEqual(await page.locator('#media-article').evaluate(el => getComputedStyle(el).display), 'none');
  await page.evaluate(() => { const video = document.querySelector('#video'); video.src = 'https://clean.fixture.test/movie.mp4'; video.load(); });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#video')).display !== 'none', null, { timeout: 3000 });
}));

test('an unselected srcset candidate cannot hide the selected clean image', async () => fixture(async ({ page }) => {
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<img id="responsive" src="https://ads.fixture.test/fallback" srcset="https://clean.fixture.test/one 1x, https://ads.fixture.test/large 10x">'));
  await page.waitForFunction(() => document.querySelector('#responsive').complete && document.querySelector('#responsive').currentSrc.includes('clean.fixture.test'));
  await page.waitForTimeout(100);
  assert.notEqual(await page.locator('#responsive').evaluate(el => getComputedStyle(el).display), 'none');
}));

test('an image input reused as a text field becomes visible with its slot', async () => fixture(async ({ page }) => {
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="ad-slot" id="form-slot"><input id="field" type="image" src="https://ads.fixture.test/button"></div>'));
  await page.locator('#field[data-clearspace-hidden]').waitFor({ state: 'attached' });
  await page.locator('#field').evaluate(el => { el.type = 'text'; el.value = 'Legitimate entry'; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#field')).display !== 'none' && getComputedStyle(document.querySelector('#form-slot')).display !== 'none', null, { timeout: 3000 });
}));

test('overlapping refreshes leave snapshot, metadata and active rules consistent', async () => fixture(async ({ harness }) => {
  const result = await harness.evaluate(async (body) => {
    const { createWorkerService } = await import('./src/worker-service.js');
    const { getRecord } = await import('./src/db.js');
    const service = createWorkerService(); await service.initialize();
    const original = fetch; let calls = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('easylist-downloads')) {
        if (++calls === 1) { await new Promise(resolve => setTimeout(resolve, 200)); return new Response(null, { status: 304 }); }
        return new Response(body.replace('Version: A', 'Version: B') + '\n##.new-rule', { headers: { etag: 'B' } });
      }
      if (String(url).includes('raw.githubusercontent')) return new Response(null, { status: 304 });
      return original(url, options);
    };
    try {
      await Promise.all([service.refreshAll({ scheduleRetry: true }), service.refreshAll({ scheduleRetry: true })]);
      return { metadata: await getRecord('metadata', 'easylist'), snapshot: await getRecord('snapshots', 'easylist'), policy: await service.getPagePolicy('public.test') };
    } finally { globalThis.fetch = original; }
  }, easylist);
  assert.match(result.snapshot.text, /Version: B/);
  assert.equal(result.metadata.version, 'B');
  assert.ok(result.policy.selectors.includes('.new-rule'));
}));

test('a retry arriving during initialization waits for caches before publishing', async () => fixture(async ({ harness }) => {
  const result = await harness.evaluate(async (body) => {
    const { createWorkerService } = await import('./src/worker-service.js');
    const { getRecord } = await import('./src/db.js');
    const original = fetch;
    let entered; const loading = new Promise(resolve => { entered = resolve; });
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/rules/overrides.txt')) { entered(); await new Promise(resolve => setTimeout(resolve, 200)); }
      if (String(url).includes('easylist-downloads')) return new Response(body.replace('Version: A', 'Version: B') + '\n##.new-rule');
      return original(url, options);
    };
    try {
      const service = createWorkerService(); const initializing = service.initialize();
      await loading;
      await Promise.all([initializing, service.handleAlarm('clearspace-refresh-retry-easylist')]);
      return { metadata: await getRecord('metadata', 'easylist'), policy: await service.getPagePolicy('public.test') };
    } finally { globalThis.fetch = original; }
  }, easylist);
  assert.equal(result.metadata.lastResult.ok, true);
  assert.ok(result.policy.selectors.includes('.new-rule'));
}));

test('a timed-out source keeps its snapshot and a later queued refresh can recover', async () => fixture(async ({ harness }) => {
  const result = await harness.evaluate(async () => {
    const { createWorkerService } = await import('./src/worker-service.js');
    const { getRecord } = await import('./src/db.js');
    const service = createWorkerService(); await service.initialize();
    const before = await getRecord('snapshots', 'hagezi');
    const originalFetch = fetch; const originalTimeout = setTimeout;
    // Accelerate the production deadline, while preserving real IndexedDB,
    // service failure handling, abort signalling and subsequent queue recovery.
    globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 20000 ? 30 : ms, ...args);
    let first = true;
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('raw.githubusercontent') && first) {
        first = false;
        return new Response(new ReadableStream({
          start(controller) {
            options.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
            originalTimeout(() => { try { controller.close(); } catch {} }, 300);
          },
        }));
      }
      if (String(url).startsWith('https:')) return new Response(null, { status: 304 });
      return originalFetch(url, options);
    };
    try {
      const failed = await service.refreshAll({ scheduleRetry: true });
      const after = await getRecord('snapshots', 'hagezi');
      const recovered = await service.refreshAll({ scheduleRetry: false });
      return { failed, before, after, recovered };
    } finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; }
  });
  assert.match(result.failed.hagezi.error, /timed out/i);
  assert.equal(result.failed.easylist.ok, true);
  assert.deepEqual(result.after, result.before);
  assert.equal(result.recovered.hagezi.ok, true);
}));
