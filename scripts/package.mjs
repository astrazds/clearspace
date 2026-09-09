import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(repoRoot, 'manifest.json'), 'utf8'));
const releaseName = `clearspace-${manifest.version}`;
const releaseDir = path.join(repoRoot, 'dist', 'unpacked', releaseName);
const files = [
  'background.js',
  'CONTRIBUTING.md',
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

const contentOutput = path.join(releaseDir, 'content.js');
const contentBuild = await build({
  entryPoints: [path.join(repoRoot, 'src', 'content', 'entry.js')],
  outfile: contentOutput,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome109'],
  metafile: true,
  write: true,
});
const outputs = Object.keys(contentBuild.metafile.outputs);
if (outputs.length !== 1 || path.resolve(outputs[0]) !== contentOutput) {
  throw new Error(`Content build emitted unexpected outputs: ${outputs.join(', ')}`);
}
const content = await readFile(contentOutput, 'utf8');
if (/^\s*(?:import|export)\s/m.test(content)) {
  throw new Error('Content build is not a self-contained classic script');
}

console.log(JSON.stringify({
  ok: true,
  version: manifest.version,
  releaseDir,
  format: 'unpacked',
  included: [...files, 'content.js', ...directories.map((directory) => `${directory}/`)],
}, null, 2));
