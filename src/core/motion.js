/**
 * Streams astronomical target position and feed-forward velocity to SuperRot.
 * Firmware is the single owner of position correction and step generation; the
 * host extrapolates between fresh sky solutions to mask transport jitter, and
 * shapes the feed-forward rate with an accel/jerk ramp (the motion profile) so
 * that a zenith azimuth whip never reaches the mount as a step change in speed.
 */
const DEFAULTS = {
  rateHz: 20,
  maxVel: { az: 12, el: 8 },      // deg/s   — hard speed ceiling
  maxAccel: { az: 20, el: 15 },   // deg/s^2 — how fast the sent rate may change
  maxJerk: { az: 120, el: 90 },   // deg/s^3 — how fast that acceleration may change
  elMax: 90,
};

export class MotionController {
  constructor(opts = {}) {
    this.cfg = {
      ...DEFAULTS,
      ...opts,
      maxVel: { ...DEFAULTS.maxVel, ...(opts.maxVel || {}) },
      maxAccel: { ...DEFAULTS.maxAccel, ...(opts.maxAccel || {}) },
      maxJerk: { ...DEFAULTS.maxJerk, ...(opts.maxJerk || {}) },
    };
    this.send = opts.send || (() => {});
    this.timer = null;
    this.lastT = 0;
    this.actual = null;
    this._reset();
  }

  /**
   * Live config update — speed limits, motion profile and elevation ceiling all
   * take effect mid-track (the UI changes them while the mount is moving).
   */
  setCfg(patch = {}) {
    // Only finite values are taken: callers pass straight from the settings
    // object, where an unset field is undefined and must leave the limit alone
    // rather than wiping it.
    for (const k of ['maxVel', 'maxAccel', 'maxJerk']) {
      if (!patch[k]) continue;
      const next = { ...this.cfg[k] };
      for (const axis of ['az', 'el']) if (Number.isFinite(patch[k][axis])) next[axis] = patch[k][axis];
      this.cfg[k] = next;
    }
    if (Number.isFinite(patch.elMax)) this.cfg.elMax = patch.elMax;
    if (Number.isFinite(patch.rateHz) && patch.rateHz > 0 && patch.rateHz !== this.cfg.rateHz) {
      this.cfg.rateHz = patch.rateHz;
      if (this.timer) { clearInterval(this.timer); this.timer = null; this.start(); }
    }
  }

  setActual(az) { this.actual = Number.isFinite(az) ? az : null; }
  _reset() { this.tgt = null; this.cmd = null; this.vel = { az: 0, el: 0 }; this.acc = { az: 0, el: 0 }; }

  setTarget(az, el, azRate = 0, elRate = 0) {
    if (!Number.isFinite(az) || !Number.isFinite(el)) return;
    const prev = this.tgt;
    const ref = Number.isFinite(this.actual) ? this.actual : this.cmd ? this.cmd.az : prev ? prev.az : az;
    this.tgt = {
      az: ref + wrap180(az - ref),
      el,
      azRate: Number.isFinite(azRate) ? azRate : 0,
      elRate: Number.isFinite(elRate) ? elRate : 0,
    };
    this.lastSetT = now();
    if (!this.cmd) this.cmd = { az: this.tgt.az, el };
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
    this.vel = { az: 0, el: 0 }; this.acc = { az: 0, el: 0 };
  }

  _step() {
    const t = now(); let dt = (t - this.lastT) / 1000; this.lastT = t;
    if (dt <= 0 || dt > 0.5) dt = 1 / this.cfg.rateHz;
    if (!this.tgt) return;
    this.tgt.az += this.tgt.azRate * dt;
    this.tgt.el = clamp(this.tgt.el + this.tgt.elRate * dt, 0, this.cfg.elMax);
    this.cmd = { az: this.tgt.az, el: this.tgt.el };
    this.send({
      az: this.cmd.az,
      el: this.cmd.el,
      azRate: this._ramp('az', this.tgt.azRate, dt),
      elRate: this._ramp('el', this.tgt.elRate, dt),
    });
  }

  /**
   * Jerk-limited approach to the requested feed-forward rate: acceleration is
   * capped at maxAccel and may itself only change by maxJerk*dt per tick. The
   * acceleration cap also shrinks near the target (so it can ramp back to zero
   * in time), and the final clamp keeps the approach monotone — no overshoot,
   * no ringing. Position is untouched: the sky solution stays the authority.
   */
  _ramp(axis, want, dt) {
    const vMax = this.cfg.maxVel?.[axis] ?? Infinity;
    const aMax = this.cfg.maxAccel?.[axis] ?? Infinity;
    const jMax = this.cfg.maxJerk?.[axis] ?? Infinity;
    const v = this.vel[axis];
    const target = clamp(Number.isFinite(want) ? want : 0, -vMax, vMax);
    const err = target - v;
    const aCap = Math.min(aMax, Math.sqrt(2 * jMax * Math.abs(err)) || 0);
    let a = clamp(err / dt, -aCap, aCap);
    a = clamp(a, this.acc[axis] - jMax * dt, this.acc[axis] + jMax * dt);
    let nv = v + a * dt;
    if (err >= 0 ? nv > target : nv < target) { nv = target; a = (nv - v) / dt; }
    this.acc[axis] = a;
    this.vel[axis] = nv;
    return nv;
  }

  currentAz() { return Number.isFinite(this.actual) ? this.actual : this.cmd ? this.cmd.az : 0; }
}
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
// Signed shortest angular difference, in [-180, 180).
const wrap180 = (d) => ((d % 360) + 540) % 360 - 180;
