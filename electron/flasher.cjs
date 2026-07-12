const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SUPPORTED_CHIPS = new Set(['esp32', 'esp32s2', 'esp32s3', 'esp32c3', 'esp32c6']);

function fail(message) {
  const error = new Error(message);
  error.code = 'FLASHER_VALIDATION';
  throw error;
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/** Validate a release manifest and resolve image paths beneath its directory. */
function validateManifest(input, manifestPath) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Firmware manifest must be an object.');
  const chip = String(input.chip || '').toLowerCase();
  if (!SUPPORTED_CHIPS.has(chip)) fail(`Unsupported or missing ESP32 chip: ${chip || '(missing)'}.`);
  if (!Array.isArray(input.images) || input.images.length === 0) fail('Firmware manifest contains no images.');

  const root = path.dirname(path.resolve(manifestPath));
  const seenOffsets = new Set();
  const images = input.images.map((entry, index) => {
    if (!entry || typeof entry !== 'object') fail(`Image ${index} is invalid.`);
    const offset = typeof entry.offset === 'string' ? Number(entry.offset) : entry.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 0x1000000) fail(`Image ${index} has an invalid offset.`);
    if (seenOffsets.has(offset)) fail(`Duplicate flash offset 0x${offset.toString(16)}.`);
    seenOffsets.add(offset);

    const name = String(entry.file || '');
    if (!name || path.isAbsolute(name)) fail(`Image ${index} must use a relative file path.`);
    const file = path.resolve(root, name);
    if (!inside(root, file)) fail(`Image ${index} escapes the firmware directory.`);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`Firmware image is missing: ${name}.`);
    const expected = String(entry.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) fail(`Image ${index} has no valid SHA-256 hash.`);
    const actual = sha256(file);
    if (actual !== expected) fail(`Firmware image checksum failed: ${name}.`);
    return { offset, file, name, sha256: actual };
  });

  return {
    schemaVersion: Number(input.schemaVersion || 1),
    firmwareVersion: String(input.firmwareVersion || ''),
    chip,
    baud: Number.isSafeInteger(input.baud) ? input.baud : 460800,
    images: images.sort((a, b) => a.offset - b.offset),
  };
}

function loadManifest(manifestPath) {
  const resolved = path.resolve(manifestPath);
  if (!fs.existsSync(resolved)) fail('Bundled SuperRot firmware manifest is not installed.');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch { fail('Bundled SuperRot firmware manifest is not valid JSON.'); }
  return validateManifest(parsed, resolved);
}

async function listPorts() {
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    return { ok: true, ports: ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer || '',
      serialNumber: p.serialNumber || '',
      vendorId: p.vendorId || '',
      productId: p.productId || '',
    })) };
  } catch (error) {
    return { ok: false, ports: [], error: `Unable to list USB serial ports: ${error.message}` };
  }
}

function defaultToolPath(resourcesPath, platform = process.platform) {
  const executable = platform === 'win32' ? 'esptool.exe' : 'esptool';
  return path.join(resourcesPath, 'superrot-flasher', 'tools', platform, executable);
}

/** Flash with a bundled esptool executable. No shell is used and all args are validated. */
function flash({ port, manifestPath, resourcesPath, toolPath, onProgress = () => {} }) {
  if (typeof port !== 'string' || !port.trim() || /[\r\n\0]/.test(port)) fail('A valid serial port is required.');
  const manifest = loadManifest(manifestPath);
  const executable = path.resolve(toolPath || defaultToolPath(resourcesPath));
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    fail('The bundled ESP32 flashing tool is not installed in this build.');
  }
  const args = ['--chip', manifest.chip, '--port', port, '--baud', String(manifest.baud),
    'write_flash', '--flash_mode', 'dio', '--flash_freq', '40m'];
  for (const image of manifest.images) args.push(`0x${image.offset.toString(16)}`, image.file);

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false });
    let output = '';
    const accept = (chunk) => {
      const text = String(chunk);
      output = (output + text).slice(-20000);
      onProgress(text);
    };
    child.stdout.on('data', accept);
    child.stderr.on('data', accept);
    child.once('error', (error) => reject(new Error(`Unable to start ESP32 flasher: ${error.message}`)));
    child.once('close', (code) => {
      if (code === 0) resolve({ ok: true, firmwareVersion: manifest.firmwareVersion });
      else reject(new Error(`ESP32 flashing failed (exit ${code}). ${output.trim().slice(-1000)}`));
    });
  });
}

module.exports = { validateManifest, loadManifest, listPorts, defaultToolPath, flash };
