const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { validateManifest, profileToFirmware, provision } = require('./flasher.cjs');

test('validates and resolves a checksummed image', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superrot-manifest-'));
  const file = path.join(dir, 'firmware.bin');
  fs.writeFileSync(file, 'test image');
  const hash = crypto.createHash('sha256').update('test image').digest('hex');
  const result = validateManifest({ chip: 'esp32', images: [{ offset: '0x1000', file: 'firmware.bin', sha256: hash }] }, path.join(dir, 'manifest.json'));
  assert.equal(result.images[0].offset, 0x1000);
  assert.equal(result.images[0].file, file);
});

test('rejects traversal and checksum failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superrot-manifest-'));
  assert.throws(() => validateManifest({ chip: 'esp32', images: [{ offset: 0, file: '../outside.bin', sha256: '0'.repeat(64) }] }, path.join(dir, 'manifest.json')), /escapes/);
  fs.writeFileSync(path.join(dir, 'firmware.bin'), 'wrong');
  assert.throws(() => validateManifest({ chip: 'esp32', images: [{ offset: 0, file: 'firmware.bin', sha256: '0'.repeat(64) }] }, path.join(dir, 'manifest.json')), /checksum/);
});

test('maps the wizard profile to flat firmware fields', () => {
  const result = profileToFirmware({
    pins: { azStep: 25, azDir: 26, elStep: 27, elDir: 14, enable: 13, elLimit: 33 },
    mechanics: { motorSteps: 200, microsteps: 16, azGearRatio: 7.5, elGearRatio: 4 },
    invert: { azDirection: true, elDirection: false, enable: true, elLimit: true },
    limits: { azMin: -720, azMax: 720, elMin: 0, elMax: 180 },
  });
  assert.equal(result.azStepPin, 25);
  assert.equal(result.microsteps, 16);
  assert.equal(result.azDirectionInvert, true);
  assert.equal(result.homingMode, 1);
});

test('provisions in safe order and ignores non-reply JSON', async () => {
  const commands = [];
  class FakeSerial extends EventEmitter {
    constructor() { super(); this.isOpen = false; }
    open(cb) { this.isOpen = true; cb(); }
    close(cb) { this.isOpen = false; cb(); }
    write(line, cb) {
      const command = JSON.parse(line); commands.push(command);
      cb();
      queueMicrotask(() => {
        this.emit('data', Buffer.from('{"event":"telemetry"}\nnot json\n'));
        this.emit('data', Buffer.from(JSON.stringify({ ok: true, [command.cmd]: true }) + '\n'));
      });
    }
  }
  const profile = {
    pins: { azStep: 25, azDir: 26, elStep: 27, elDir: 14, enable: 13, elLimit: 33 },
    mechanics: { motorSteps: 200, microsteps: 8, azGearRatio: 7.5, elGearRatio: 4 },
    invert: { enable: true, elLimit: true }, limits: { azMin: -720, azMax: 720, elMin: 0, elMax: 180 },
  };
  const result = await provision({ port: 'COM9', profile, SerialPortClass: FakeSerial, timeoutMs: 100 });
  assert.equal(result.ok, true);
  assert.deepEqual(commands.map((c) => c.cmd), ['enterSetup', 'defaults', 'set', 'validate', 'save', 'reboot']);
  assert.equal(commands[2].elLimitPin, 33);
});

test('does not save when firmware rejects the profile', async () => {
  const commands = [];
  class RejectingSerial extends EventEmitter {
    constructor() { super(); this.isOpen = false; }
    open(cb) { this.isOpen = true; cb(); }
    close(cb) { this.isOpen = false; cb(); }
    write(line, cb) {
      const command = JSON.parse(line); commands.push(command.cmd); cb();
      queueMicrotask(() => this.emit('data', Buffer.from(JSON.stringify(command.cmd === 'set' ? { ok: false, error: 'invalid_config' } : { ok: true }) + '\n')));
    }
  }
  const profile = { pins: { azStep: 25, azDir: 26, elStep: 27, elDir: 14, enable: 13, elLimit: 33 }, mechanics: { motorSteps: 200, microsteps: 8, azGearRatio: 7.5, elGearRatio: 4 }, invert: {}, limits: { azMin: -720, azMax: 720, elMin: 0, elMax: 180 } };
  await assert.rejects(() => provision({ port: 'COM9', profile, SerialPortClass: RejectingSerial, timeoutMs: 100 }), /invalid_config/);
  assert.deepEqual(commands, ['enterSetup', 'defaults', 'set']);
});
