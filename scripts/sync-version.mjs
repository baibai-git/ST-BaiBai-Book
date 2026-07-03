import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(root, 'package.json');
const manifestPath = path.join(root, 'manifest.json');

const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
const manifestText = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText);

const version = String(pkg.version ?? '').trim();
if (!version) {
  throw new Error('package.json version is required');
}

const expectedJs = `dist/index.js?ver=${encodeURIComponent(version)}`;
manifest.version = version;
manifest.js = expectedJs;

const nextManifestText = `${JSON.stringify(manifest, null, 2)}\n`;
if (nextManifestText !== manifestText) {
  await writeFile(manifestPath, nextManifestText, 'utf8');
  console.log(`Synced manifest.json to version ${version}`);
} else {
  console.log(`manifest.json already synced to version ${version}`);
}
