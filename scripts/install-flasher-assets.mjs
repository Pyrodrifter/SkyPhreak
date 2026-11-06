import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { spawnSync } from 'node:child_process';

// Thrown only when fetched bytes do not match the digest upstream published.
// Everything else (no release yet, 404, offline, no pinned build for this arch) is
// an "unavailable" condition and is skipped rather than failing the build.
class IntegrityError extends Error {}

const ROOT = path.resolve(import.meta.dirname, '..');
const DEST = path.join(ROOT, 'electron', 'superrot-flasher');
const ESPTOOL_TAG = 'v5.3.0';

function get(url, json = false) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SkyPhreak-build', Accept: json ? 'application/vnd.github+json' : '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(get(res.headers.location, json)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => {
        const data = Buffer.concat(chunks); resolve(json ? JSON.parse(data.toString('utf8')) : data);
      });
    }).on('error', reject);
  });
}

function assetName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return `esptool-${ESPTOOL_TAG}-windows-amd64.zip`;
  if (platform === 'linux' && arch === 'x64') return `esptool-${ESPTOOL_TAG}-linux-amd64.tar.gz`;
  if (platform === 'linux' && arch === 'arm64') return `esptool-${ESPTOOL_TAG}-linux-aarch64.tar.gz`;
  if (platform === 'darwin' && arch === 'x64') return `esptool-${ESPTOOL_TAG}-macos-amd64.tar.gz`;
  if (platform === 'darwin' && arch === 'arm64') return `esptool-${ESPTOOL_TAG}-macos-arm64.tar.gz`;
  throw new Error(`No pinned esptool build for ${platform}/${arch}.`);
}

function extract(archive, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${directory}' -Force`], { stdio: 'inherit' })
    : spawnSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Unable to extract the verified esptool archive.');
}

function find(root, name) {
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) { const result = find(file, name); if (result) return result; }
    else if (item.name === name) return file;
  }
}

async function installEsptool() {
  const release = await get(`https://api.github.com/repos/espressif/esptool/releases/tags/${ESPTOOL_TAG}`, true);
  const name = assetName(); const asset = release.assets?.find((a) => a.name === name);
  if (!asset || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) throw new Error(`Official ${name} asset or SHA-256 digest is unavailable.`);
  const data = await get(asset.browser_download_url);
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (actual !== asset.digest.slice(7).toLowerCase()) throw new IntegrityError(`Checksum failed for ${name}.`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skyphreak-esptool-'));
  try {
    const archive = path.join(temp, name); fs.writeFileSync(archive, data); extract(archive, path.join(temp, 'out'));
    const executableName = process.platform === 'win32' ? 'esptool.exe' : 'esptool';
    const source = find(path.join(temp, 'out'), executableName); if (!source) throw new Error(`${executableName} missing from verified archive.`);
    const targetDir = path.join(DEST, 'tools', process.platform); fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(source, path.join(targetDir, executableName)); if (process.platform !== 'win32') fs.chmodSync(path.join(targetDir, executableName), 0o755);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

async function installFirmware() {
  const release = await get('https://api.github.com/repos/Pyrodrifter/PyroRotator/releases/latest', true);
  const asset = release.assets?.find((a) => a.name === 'superrot-universal-esp32.zip');
  if (!asset || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) throw new Error('No checksummed universal-firmware release is available yet.');
  const data = await get(asset.browser_download_url); const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (actual !== asset.digest.slice(7).toLowerCase()) throw new IntegrityError('Universal-firmware release checksum failed.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skyphreak-firmware-'));
  try {
    const archive = path.join(temp, 'firmware.zip'); fs.writeFileSync(archive, data);
    const result = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${DEST}' -Force`], { stdio: 'inherit' })
      : spawnSync('unzip', ['-o', archive, '-d', DEST], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Unable to extract the verified firmware archive.');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

/**
 * The bundled USB flasher is an OPTIONAL extra. When its assets are absent the app
 * reports "Bundled flashing is unavailable" in the SuperRot wizard and everything
 * else works normally, so a missing upstream release must not take the installer
 * build down with it.
 *
 * It used to. `npm run dist` is `prepare:flasher && vite build && electron-builder`,
 * and Pyrodrifter/PyroRotator has no published release, so installFirmware() threw
 * on a 404 and the pipeline died before vite build ever ran -- on all three runners.
 * That is why v0.5.0-rc.1, v0.5.0-rc.2 and v0.5.0-ui-v1 shipped zero installers.
 *
 * A failed checksum is a different matter: those bytes are not what upstream
 * published, so it stays a hard failure and nothing gets installed.
 */
async function optional(label, install) {
  try {
    await install();
    console.log(`  installed ${label}`);
    return true;
  } catch (err) {
    if (err instanceof IntegrityError) throw err;
    console.warn(`  skipping ${label}: ${err.message}`);
    return false;
  }
}

const haveTool = await optional('the pinned esptool build', installEsptool);
const haveFirmware = await optional('the SuperRot universal firmware', installFirmware);
if (haveTool && haveFirmware) {
  console.log('Verified SuperRot firmware and flasher assets installed.');
} else {
  console.warn('SuperRot USB flashing will be disabled in this build. Nothing else is affected.');
}
