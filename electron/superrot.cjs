const net = require('node:net');
const { EventEmitter } = require('node:events');

/**
 * SuperRotClient — client for the SuperRot continuous-motion rotator protocol.
 *
 * Unlike rotctld's position-only `P` (which means "go here and STOP"), SuperRot
 * carries angular velocity so the motor is always in motion and never lurches:
 *
 *   A <az> <el> <azRate> <elRate>   track setpoint: position + feedforward velocity
 *   V <azRate> <elRate>             pure velocity (°/s)
 *   P <az> <el>                     goto (rotctld-compatible, stops on arrival)
 *   S                               stop (decelerate to hold)
 *   K                               park
 *   ?                               request telemetry
 *
 * Firmware replies are newline-terminated: `OK`, `ERR <msg>`, or telemetry
 * `T <az> <el> <azRate> <elRate>` streamed continuously (~10 Hz).
 *
 * Transport is either a USB serial port to the MCU or TCP (ESP32/WiFi). Serial
 * uses the optional `serialport` package, required lazily so the app still loads
 * for users who only use WiFi or rotctld. The class mirrors HamlibClient's
 * EventEmitter 'status' contract so the main process can treat drivers uniformly.
 */
class SuperRotClient extends EventEmitter {
  constructor(kind = 'rotator') {
    super();
    this.kind = kind;
    this.transport = null; // 'serial' | 'tcp'
    this.port = null; // SerialPort instance
    this.socket = null; // net.Socket instance
    this.connected = false;
    this.buffer = '';
    this.telemetry = null; // last { az, el, azRate, elRate }
    this.trackSeq = 0;
  }

  emitStatus(extra = {}) {
    this.emit('status', { kind: this.kind, connected: this.connected, telemetry: this.telemetry, ...extra });
  }

  /**
   * conf:
   *   { transport: 'tcp',    host, port }
   *   { transport: 'serial', path, baud }
   */
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
      sock.on('data', (d) => this._ingest(d.toString('utf8')));
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
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: err.message });
        }
      });
      sock.on('close', () => {
        this.connected = false;
        this.socket = null;
        this.emitStatus();
      });
    });
  }

  async _connectSerial({ path, baud = 115200 }) {
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
      port.on('open', () => {
        settled = true;
        this.connected = true;
        this.emitStatus({ path, baud });
        resolve({ ok: true });
      });
      port.on('data', (d) => this._ingest(d.toString('utf8')));
      port.on('error', (err) => {
        this.connected = false;
        this.emitStatus({ error: err.message });
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: err.message });
        }
      });
      port.on('close', () => {
        this.connected = false;
        this.port = null;
        this.emitStatus();
      });
    });
  }

  // Split incoming bytes into lines; parse telemetry, surface everything else.
  _ingest(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      if (line[0] === 'T') {
        const p = line.split(/\s+/);
        const t = { az: +p[1], el: +p[2], azRate: +p[3], elRate: +p[4] };
        // Optional extended diagnostics appended as key=value tokens — backward
        // compatible (old firmware sends only the 4 positional fields). Known keys:
        // tempC, curA (motor current), esAz/esEl (endstop hit 0/1), lossAz/lossEl
        // (step-loss detected 0/1), homed (0/1).
        for (let i = 5; i < p.length; i++) {
          const eq = p[i].indexOf('=');
          if (eq <= 0) continue;
          const k = p[i].slice(0, eq);
          const v = p[i].slice(eq + 1);
          const num = Number(v);
          t[k] = v !== '' && Number.isFinite(num) ? num : v;
        }
        if (Number.isFinite(t.az) && Number.isFinite(t.el)) {
          this.telemetry = t;
          this.emitStatus({ telemetry: t });
        }
      } else {
        this.emitStatus({ reply: line });
      }
    }
  }

  _write(s) {
    if (!this.connected) return { ok: false, error: 'not connected' };
    const w = this.transport === 'serial' ? this.port : this.socket;
    if (!w) return { ok: false, error: 'not connected' };
    w.write(s);
    return { ok: true };
  }

  // High-level commands. `track` is the one the smooth controller streams.
  track(az, el, azRate, elRate) {
    this.trackSeq = (this.trackSeq + 1) >>> 0;
    return this._write(`A2 ${this.trackSeq} ${az.toFixed(6)} ${el.toFixed(6)} ${azRate.toFixed(6)} ${elRate.toFixed(6)}\n`);
  }
  velocity(azRate, elRate) {
    return this._write(`V ${azRate.toFixed(3)} ${elRate.toFixed(3)}\n`);
  }
  goto(az, el) {
    return this._write(`P ${az.toFixed(2)} ${el.toFixed(2)}\n`);
  }
  stopMotion() {
    return this._write('S\n');
  }
  park() {
    return this._write('K\n');
  }
  // Run the firmware homing routine (el endstop seek + gentle re-approach).
  home() {
    return this._write('H\n');
  }
  // Unwind the azimuth cable to the 0-turn equivalent of the current heading.
  unwind() {
    return this._write('U\n');
  }
  // Push configuration to the firmware: `C key=value ...` (limits, offsets, backlash).
  // The firmware persists whatever keys it recognises and ignores the rest.
  config(obj = {}) {
    const parts = Object.entries(obj)
      .filter(([, v]) => v != null && Number.isFinite(Number(v)))
      .map(([k, v]) => `${k}=${Number(v)}`);
    if (!parts.length) return { ok: false, error: 'no config values' };
    return this._write('C ' + parts.join(' ') + '\n');
  }

  close() {
    try {
      if (this.socket) this.socket.destroy();
      if (this.port && this.port.isOpen) this.port.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.port = null;
    this.connected = false;
    this.buffer = '';
    this.trackSeq = 0;
  }
}

module.exports = { SuperRotClient };
