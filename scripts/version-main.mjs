import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, npm } from './version-files.mjs';
import { createGithub } from './version-github.mjs';
import { createGitAdapter } from './version-git.mjs';
import { reconcile } from './version-reconcile.mjs';
import { validateRunContext } from './version-context.mjs';

// The Git adapter resets unpublished attempts: never run it in a developer checkout.
validateRunContext(process.env, await readJson(process.env.GITHUB_EVENT_PATH));
const root = await realpath(process.cwd());
if (root !== await realpath(process.env.GITHUB_WORKSPACE)) throw new Error('Requires the disposable Actions workspace');
const exec = promisify(execFile);
const adapter = createGitAdapter(root, createGithub(process.env.GITHUB_REPOSITORY), async () => {
  // main may have moved since job setup; install its exact lockfile again.
  try {
    await npm(root, ['ci']);
    const { stdout } = await exec('mise', ['run', 'check'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    console.log(stdout);
  } catch (error) {
    console.error(error.stdout || '', error.stderr || '');
    throw error;
  }
});
await adapter.initialize();
console.log(`Recorded ${await reconcile(adapter)} merged PR decision(s).`);
