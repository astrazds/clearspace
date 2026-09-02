import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(repoRoot, 'manifest.json'), 'utf8'));
const releaseName = `clearspace-${manifest.version}`;
const releaseDir = path.join(repoRoot, 'dist', 'unpacked', releaseName);
const files = [
  'background.js',
  'content.js',
  'LICENSE',
  'manifest.json',
  'popup.css',
  'popup.html',
  'popup.js',
  'PRIVACY.md',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
];
const directories = ['docs', 'icons', 'rules', 'src'];

await rm(releaseDir, { force: true, recursive: true });
await mkdir(releaseDir, { recursive: true });
for (const file of files) await cp(path.join(repoRoot, file), path.join(releaseDir, file));
for (const directory of directories) {
  await cp(path.join(repoRoot, directory), path.join(releaseDir, directory), { recursive: true });
}

console.log(JSON.stringify({
  ok: true,
  version: manifest.version,
  releaseDir,
  format: 'unpacked',
  included: [...files, ...directories.map((directory) => `${directory}/`)],
}, null, 2));
