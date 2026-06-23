/**
 * Fetch the Earth textures used by the shaded-relief map/globe into public/textures/
 * so they ship inside the build (offline-friendly — no runtime CDN).
 *
 * These are NASA-derived public-domain images that already ship with the
 * `three-globe` dependency, so normally this just copies from node_modules and
 * needs no internet. If they're missing it falls back to downloading from unpkg.
 *
 * Run: npm run fetch-textures
 */
import { createWriteStream } from 'node:fs';
import { mkdir, copyFile, access, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'node_modules', 'three-globe', 'example', 'img');
const destDir = join(root, 'public', 'textures');
const cdnBase = 'https://unpkg.com/three-globe/example/img/';

// base colour, elevation (relief/bump), and water mask (ocean specular).
const FILES = ['earth-day.jpg', 'earth-topology.png', 'earth-water.png'];

const exists = (p) => access(p).then(() => true).catch(() => false);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

await mkdir(destDir, { recursive: true });

for (const name of FILES) {
  const dest = join(destDir, name);
  const src = join(srcDir, name);
  try {
    if (await exists(src)) {
      await copyFile(src, dest);
      console.log(`copied  ${name}  (${Math.round((await stat(dest)).size / 1024)} KB)`);
    } else {
      process.stdout.write(`downloading ${name} … `);
      await download(cdnBase + name, dest);
      console.log(`${Math.round((await stat(dest)).size / 1024)} KB`);
    }
  } catch (e) {
    console.error(`FAILED ${name}: ${e.message}`);
  }
}

console.log('\nTextures ready in public/textures/ — the map/globe will use them automatically.');
