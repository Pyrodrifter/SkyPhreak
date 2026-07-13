const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SUPPORTED_CHIPS = new Set(['esp32', 'esp32s2', 'esp32s3', 'esp32c3', 'esp32c6']);
const SERIAL_BAUD = 115200;
const REPLY_TIMEOUT_MS = 2500;

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

function profileToFirmware(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) fail('A valid hardware profile is required.');
  const p = profile.pins || {}, m = profile.mechanics || {}, i = profile.invert || {}, l = profile.limits || {};
  const output = {
    azStepPin: p.azStep, azDirPin: p.azDir, elStepPin: p.elStep, elDirPin: p.elDir,
    enablePin: p.enable, azLimitPin: Number.isInteger(p.azLimit) ? p.azLimit : -1, elLimitPin: p.elLimit,
    motorSteps: m.motorSteps, microsteps: m.microsteps, azGearRatio: m.azGearRatio, elGearRatio: m.elGearRatio,
    azMin: l.azMin, azMax: l.azMax, elMin: l.elMin, elMax: l.elMax,
    azDirectionInvert: !!i.azDirection, elDirectionInvert: !!i.elDirection,
    enableActiveLow: !!i.enable, azLimitActiveLow: true, elLimitActiveLow: !!i.elLimit,
    allowStrappingPins: false, elHomeDirection: -1, homingMode: 1,
  };
  const pins = ['azStepPin', 'azDirPin', 'elStepPin', 'elDirPin', 'enablePin', 'elLimitPin'];
  if (pins.some((key) => !Number.isInteger(output[key]))) fail('Profile GPIO assignments must be integers.');
  const numbers = ['motorSteps', 'microsteps', 'azGearRatio', 'elGearRatio', 'azMin', 'azMax', 'elMin', 'elMax'];
  if (numbers.some((key) => !Number.isFinite(output[key]))) fail('Profile mechanics and limits must be finite numbers.');
  return output;
}

function openSerial(SerialPort, pathName) {
  return new Promise((resolve, reject) => {
    const serial = new SerialPort({ path: pathName, baudRate: SERIAL_BAUD, autoOpen: false });
    serial.open((error) => error ? reject(error) : resolve(serial));
  });
}

function closeSerial(serial) {
  return new Promise((resolve) => {
    if (!serial?.isOpen) return resolve();
    serial.close(() => resolve());
  });
}

function requestJson(serial, command, timeoutMs = REPLY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => { clearTimeout(timer); serial.off('data', onData); serial.off('error', onError); };
    const onError = (error) => { cleanup(); reject(error); };
    const onData = (chunk) => {
      buffer += String(chunk);
      if (buffer.length > 65536) buffer = buffer.slice(-32768);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line.startsWith('{')) continue;
        let reply; try { reply = JSON.parse(line); } catch { continue; }
        if (typeof reply.ok !== 'boolean') continue; // ignore boot events and tracking telemetry
        cleanup();
        if (!reply.ok) reject(new Error(`Controller rejected ${command.cmd}: ${reply.error || 'unknown error'}${reply.detail ? ` (${reply.detail})` : ''}`));
        else resolve(reply);
        return;
      }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${command.cmd} reply.`)); }, timeoutMs);
    serial.on('data', onData); serial.on('error', onError);
    serial.write(`${JSON.stringify(command)}\n`, (error) => { if (error) onError(error); });
  });
}

/** Explicitly provision an already-flashed controller. This never invokes the flasher. */
async function provision({ port, profile, SerialPortClass, timeoutMs = REPLY_TIMEOUT_MS }) {
  if (typeof port !== 'string' || !port.trim() || /[\r\n\0]/.test(port)) fail('A valid serial port is required.');
  const fields = profileToFirmware(profile);
  const SerialPort = SerialPortClass || require('serialport').SerialPort;
  let serial;
  try {
    serial = await openSerial(SerialPort, port);
    await requestJson(serial, { cmd: 'enterSetup' }, timeoutMs);
    await requestJson(serial, { cmd: 'defaults' }, timeoutMs);
    await requestJson(serial, { cmd: 'set', ...fields }, timeoutMs);
    await requestJson(serial, { cmd: 'validate' }, timeoutMs);
    const diagnostics = await requestJson(serial, { cmd: 'diagnose' }, timeoutMs);
    if (!diagnostics.driversDisabled || diagnostics.stepPulses !== 0) fail('Controller did not confirm a safe diagnostic state.');
    await requestJson(serial, { cmd: 'save' }, timeoutMs);
    await requestJson(serial, { cmd: 'reboot' }, timeoutMs);
    return { ok: true, rebooting: true, diagnostics };
  } finally {
    await closeSerial(serial);
  }
}

module.exports = { validateManifest, loadManifest, listPorts, defaultToolPath, flash, profileToFirmware, requestJson, provision };
