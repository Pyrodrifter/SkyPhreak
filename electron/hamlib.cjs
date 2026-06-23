const net = require('node:net');
const { EventEmitter } = require('node:events');

/**
 * Minimal Hamlib network client for rotctld (rotator, default port 4533) and
 * rigctld (radio, default port 4532). Both speak the same simple line protocol:
 * commands are newline-terminated, replies end with "RPRT <code>" on a line.
 *
 * We keep it deliberately small: connect, send a command, surface connection
 * state and replies. Doppler tuning and az/el targeting are driven from the
 * renderer, which computes values and calls send().
 */
class HamlibClient extends EventEmitter {
  constructor(kind) {
    super();
    this.kind = kind; // 'rotator' | 'radio'
    this.socket = null;
    this.connected = false;
    this.buffer = '';
  }

  emitStatus(extra = {}) {
    this.emit('status', { kind: this.kind, connected: this.connected, ...extra });
  }

  connect(host, port) {
    this.close();
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

      sock.on('data', (d) => {
        this.buffer += d.toString('utf8');
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (line) this.emitStatus({ reply: line });
        }
      });

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

  send(cmd) {
    if (!this.socket || !this.connected) return { ok: false, error: 'not connected' };
    this.socket.write(cmd);
    return { ok: true };
  }

  close() {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.connected = false;
  }
}

module.exports = { HamlibClient };
