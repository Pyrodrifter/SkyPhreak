const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateManifest } = require('./flasher.cjs');

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
