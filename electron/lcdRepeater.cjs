const net = require('node:net');
const os = require('node:os');
const { EventEmitter } = require('node:events');

// Best-guess LAN IPv4 to show the user which address to type into the display.
function lanIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

/**
 * LCD repeater — a one-way az/el output port, independent of the rotator/radio.
 *
 * It streams the currently selected target's pointing (and name) to a standalone
 * display device — e.g. an Arduino/ESP32 driving an LCD on the bench — so you can
 * read where the bird is without looking at the app. Purely outbound: we open a
 * serial or TCP port and write short text lines; any bytes the device sends back
 * are drained and ignored.
 *
 * Transport:
 *   { transport: 'tcp',    host, port }   — we dial out to a listening display
 *   { transport: 'server', port }         — WE listen; the display connects in
 *   { transport: 'serial', path, baud }
 *
 * Server mode exists for displays that are themselves TCP clients (e.g. the
 * PyroLCD ESP32, which dials out to a "SkyPhreak IP:port"). We listen and
 * broadcast each line to every connected display.
 */
class LcdRepeater extends EventEmitter {
  constructor() {
    super();
    this.transport = null;
    this.port = null;    // SerialPort instance
    this.socket = null;  // net.Socket instance (client mode)
    this.server = null;  // net.Server instance (server mode)
    this.clients = new Set(); // connected display sockets (server mode)
    this.connected = false;
  }

  emitStatus(extra = {}) {
    this.emit('status', { connected: this.connected, transport: this.transport, ...extra });
  }

  connect(conf = {}) {
    this.close();
    if (conf.transport === 'serial') return this._connectSerial(conf);
    if (conf.transport === 'server') return this._listen(conf);
    return this._connectTcp(conf);
  }

  // Listen for inbound display connections (the display is the TCP client).
  _listen({ port, host = '0.0.0.0' }) {
    this.transport = 'server';
    return new Promise((resolve) => {
      const server = net.createServer((sock) => {
        this.clients.add(sock);
        sock.on('data', () => {}); // display may chatter — drain and ignore
        sock.on('error', () => {});
        sock.on('close', () => { this.clients.delete(sock); this.emitStatus({ port, ip: lanIp(), clients: this.clients.size }); });
        this.emitStatus({ port, ip: lanIp(), clients: this.clients.size });
      });
      this.server = server;
      server.on('error', (err) => {
        this.connected = false;
        this.emitStatus({ error: err.message });
        resolve({ ok: false, error: err.message });
      });
      server.listen(port, host, () => {
        this.connected = true;
        this.emitStatus({ port, ip: lanIp(), clients: 0 });
        resolve({ ok: true });
      });
    });
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
    if (this.transport === 'server') {
      if (!this.clients.size) return false;
      let ok = false;
      for (const s of this.clients) { try { s.write(line); ok = true; } catch { /* drop */ } }
      return ok;
    }
    const w = this.transport === 'serial' ? this.port : this.socket;
    if (!this.connected || !w) return false;
    try { w.write(line); return true; } catch { return false; }
  }

  close() {
    try {
      if (this.socket) { this.socket.destroy(); this.socket = null; }
      if (this.port && this.port.isOpen) this.port.close(() => {});
      this.port = null;
      for (const s of this.clients) { try { s.destroy(); } catch { /* ignore */ } }
      this.clients.clear();
      if (this.server) { this.server.close(); this.server = null; }
    } catch { /* ignore */ }
    if (this.connected) { this.connected = false; this.emitStatus(); }
    this.transport = null;
  }
}

module.exports = { LcdRepeater };
