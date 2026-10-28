import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

/** Launch only in a caller-owned disposable profile, never a user's profile. */
export async function launchExtension(profile, extension, options = {}) {
  const chrome = process.env.CHROME_EXECUTABLE || [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(candidate => candidate && existsSync(candidate));
  const context = await chromium.launchPersistentContext(profile, {
    ...options,
    executablePath: chrome || process.env.CHROMIUM_EXECUTABLE || chromium.executablePath(),
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      ...(chrome ? ['--enable-unsafe-extension-debugging']
        : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]),
      ...(options.args || []),
    ],
  });
  if (chrome) {
    try {
      const session = await context.browser().newBrowserCDPSession();
      await session.send('Extensions.loadUnpacked', { path: path.resolve(extension) });
      await session.detach();
    } catch (error) {
      await context.close();
      throw error;
    }
  }
  return context;
}
