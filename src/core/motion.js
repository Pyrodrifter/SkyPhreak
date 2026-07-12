/**
 * Streams astronomical target position and feed-forward velocity to SuperRot.
 * Firmware is the single owner of position correction, acceleration, and steps.
 * The host only extrapolates between fresh sky solutions to mask transport jitter.
 */
const DEFAULTS = {
  rateHz: 20,
  maxVel: { az: 12, el: 8 },
  elMax: 90,
};

export class MotionController {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts, maxVel: { ...DEFAULTS.maxVel, ...(opts.maxVel || {}) } };
    this.send = opts.send || (() => {});
    this.timer = null;
    this.lastT = 0;
    this.actual = null;
    this._reset();
  }
  setActual(az) { this.actual = Number.isFinite(az) ? az : null; }
  _reset() { this.tgt = null; this.cmd = null; }
  setTarget(az, el, azRate = null, elRate = null) {
    if (!Number.isFinite(az) || !Number.isFinite(el)) return;
    const prev = this.tgt;
    const ref = Number.isFinite(this.actual) ? this.actual : this.cmd ? this.cmd.az : prev ? prev.az : az;
    const uaz = ref + wrap180(az - ref);
    if (azRate == null && prev && this.lastSetT) {
      const dt = (now() - this.lastSetT) / 1000;
      if (dt > 1e-3) { azRate = (uaz - prev.az) / dt; elRate = (el - prev.el) / dt; }
    }
    this.tgt = { az: uaz, el, azRate: azRate || 0, elRate: elRate || 0 };
    this.lastSetT = now();
    if (!this.cmd) this.cmd = { az: uaz, el };
  }
  start() {
    if (this.timer) return;
    this.lastT = now();
    this.timer = setInterval(() => this._step(), 1000 / this.cfg.rateHz);
  }
  stop({ halt = true } = {}) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (halt) this.send({ az: this.cmd?.az ?? 0, el: this.cmd?.el ?? 0, azRate: 0, elRate: 0, stop: true });
    this._reset(); this.lastSetT = 0;
  }
  seed(az, el) {
    if (!Number.isFinite(az)) return;
    this.actual = az;
    this.cmd = { az, el: Number.isFinite(el) ? el : this.cmd?.el ?? 0 };
    this.tgt = null; this.lastSetT = 0;
  }
  _step() {
    const t = now(); let dt = (t - this.lastT) / 1000; this.lastT = t;
    if (dt <= 0 || dt > 0.5) dt = 1 / this.cfg.rateHz;
    if (!this.tgt) return;
    this.tgt.az += this.tgt.azRate * dt;
    this.tgt.el = clamp(this.tgt.el + this.tgt.elRate * dt, 0, this.cfg.elMax);
    this.cmd = { az: this.tgt.az, el: this.tgt.el };
    this.send({ az: this.cmd.az, el: this.cmd.el,
      azRate: clamp(this.tgt.azRate, -this.cfg.maxVel.az, this.cfg.maxVel.az),
      elRate: clamp(this.tgt.elRate, -this.cfg.maxVel.el, this.cfg.maxVel.el) });
  }
  currentAz() { return Number.isFinite(this.actual) ? this.actual : this.cmd ? this.cmd.az : 0; }
}
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const wrap180 = (d) => ((d + 180) % 360 + 540) % 360 - 180;
