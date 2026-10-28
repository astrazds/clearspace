import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { parseVersion } from './version-policy.mjs';

const exec = promisify(execFile);
export const versionFiles = ['package.json', 'package-lock.json', 'manifest.json', 'release-state.json'];
export const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

export async function readVersions(root) {
  const [pkg, lock, manifest] = await Promise.all(['package.json', 'package-lock.json', 'manifest.json'].map(file => readJson(path.join(root, file))));
  parseVersion(pkg.version);
  if ([lock.version, lock.packages?.['']?.version, manifest.version].some(version => version !== pkg.version)) {
    throw new Error('Package, lockfile and extension version mismatch');
  }
  return pkg.version;
}

export async function npm(root, args) {
  // npm.cmd requires cmd.exe on Windows; all callers supply fixed arguments or validated numeric versions.
  return process.platform === 'win32'
    ? exec('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
    : exec('npm', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
}

export async function applyVersion(root, version) {
  parseVersion(version);
  await readVersions(root);
  await npm(root, ['version', version, '--no-git-tag-version', '--ignore-scripts']);
  const file = path.join(root, 'manifest.json');
  const manifest = await readJson(file);
  manifest.version = version;
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  await readVersions(root);
}
