const net = require('node:net');
const { EventEmitter } = require('node:events');

/**
 * LCD repeater — a one-way az/el output port, independent of the rotator/radio.
 *
 * It streams the currently selected target's pointing (and name) to a standalone
 * display device — e.g. an Arduino/ESP32 driving an LCD on the bench — so you can
 * read where the bird is without looking at the app. Purely outbound: we open a
 * serial or TCP port and write short text lines; any bytes the device sends back
 * are drained and ignored.
 *
 * Transport mirrors the rotator:
 *   { transport: 'tcp',    host, port }
 *   { transport: 'serial', path, baud }
 */
class LcdRepeater extends EventEmitter {
  constructor() {
    super();
    this.transport = null;
    this.port = null;   // SerialPort instance
    this.socket = null; // net.Socket instance
    this.connected = false;
  }

  emitStatus(extra = {}) {
    this.emit('status', { connected: this.connected, transport: this.transport, ...extra });
  }

  connect(conf = {}) {
    this.close();
    return conf.transport === 'serial' ? this._connectSerial(conf) : this._connectTcp(conf);
  }

  _connectTcp({ host, port }) {
    this.transport = 'tcp';
    return new Promise((resolve) => {
      const sock = new net.Socket();
      this.socket = sock;
      let settled = false;
      sock.setTimeout(4000);
      sock.connect(port, host, () => {
        settled = true;
        this.connected = true;
        sock.setTimeout(0);
        this.emitStatus({ host, port });
        resolve({ ok: true });
      });
      sock.on('data', () => {}); // display may echo — drain and ignore
      sock.on('timeout', () => {
        if (!settled) {
          settled = true;
          sock.destroy();
          this.connected = false;
          this.emitStatus({ error: 'connection timed out' });
          resolve({ ok: false, error: 'connection timed out' });
        }
      });
      sock.on('error', (err) => {
        this.connected = false;
        this.emitStatus({ error: err.message });
        if (!settled) { settled = true; resolve({ ok: false, error: err.message }); }
      });
      sock.on('close', () => { this.connected = false; this.socket = null; this.emitStatus(); });
    });
  }

  async _connectSerial({ path, baud = 9600 }) {
    this.transport = 'serial';
    let SerialPort;
    try {
      ({ SerialPort } = require('serialport'));
    } catch {
      const error = "serial support needs the 'serialport' package (run: npm i serialport)";
      this.emitStatus({ error });
      return { ok: false, error };
    }
    return new Promise((resolve) => {
      let settled = false;
      const port = new SerialPort({ path, baudRate: baud }, (err) => {
        if (err) {
          settled = true;
          this.connected = false;
          this.emitStatus({ error: err.message });
          resolve({ ok: false, error: err.message });
        }
      });
      this.port = port;
      port.on('open', () => { settled = true; this.connected = true; this.emitStatus({ path, baud }); resolve({ ok: true }); });
      port.on('data', () => {}); // drain and ignore
      port.on('error', (err) => {
        this.connected = false;
        this.emitStatus({ error: err.message });
        if (!settled) { settled = true; resolve({ ok: false, error: err.message }); }
      });
      port.on('close', () => { this.connected = false; this.port = null; this.emitStatus(); });
    });
  }

  /** Write one already-formatted line (caller appends its own newline). */
  send(line) {
    const w = this.transport === 'serial' ? this.port : this.socket;
    if (!this.connected || !w) return false;
    try { w.write(line); return true; } catch { return false; }
  }

  close() {
    try {
      if (this.socket) { this.socket.destroy(); this.socket = null; }
      if (this.port && this.port.isOpen) this.port.close(() => {});
      this.port = null;
    } catch { /* ignore */ }
    if (this.connected) { this.connected = false; this.emitStatus(); }
    this.transport = null;
  }
}

module.exports = { LcdRepeater };
