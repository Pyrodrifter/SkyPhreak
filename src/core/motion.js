/**
 * MotionController — turns a coarse (≈1 Hz) stream of target az/el setpoints into
 * a smooth, *continuously moving* command stream for the rotator.
 *
 * The reason rotctld jerks: a `P az el` command means "slew to here and stop", so
 * the motor lurches, stops, and waits for the next 1 Hz update. Real astronomical
 * mounts never stop — they command angular *velocity* matched to the sky, and only
 * trim position on top. This controller does exactly that:
 *
 *     v_command = v_feedforward + Kp · (target_pos − commanded_pos)
 *
 * It runs its own high-rate loop (default 20 Hz), extrapolating the target between
 * the slow updates using the feedforward rate, and emits {az, el, azRate, elRate}
 * to a `send` sink. Acceleration and jerk are limited so the motor ramps instead of
 * snapping. Output is driver-agnostic — the same stream drives SuperRot firmware
 * (which consumes velocity directly) or, by ignoring the rates, a plain goto.
 *
 * All angles are degrees; rates are degrees/second. The controller works open-loop
 * (no encoder): "commanded position" is its own integrated model, which is what the
 * stepper firmware faithfully follows.
 */

const DEFAULTS = {
  rateHz: 20, // control-loop frequency
  kp: 0.8, // position-trim gain (1/s); small = gentle, won't fight feedforward
  maxVel: { az: 12, el: 8 }, // °/s ceiling (also the zenith-keyhole clamp)
  maxAccel: { az: 20, el: 15 }, // °/s² — how fast velocity may change
  maxJerk: { az: 120, el: 90 }, // °/s³ — how fast acceleration may change (S-curve)
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
    this._reset();
  }

  _reset() {
    // Unwrapped target (az is NOT clamped to 0–360 so we never see a 359→0 spike).
    this.tgt = null; // { az, el, azRate, elRate }
    this.cmd = null; // { az, el } — integrated model position (unwrapped az)
    this.vel = { az: 0, el: 0 }; // current commanded velocity
    this.acc = { az: 0, el: 0 }; // current commanded acceleration (for jerk limit)
  }

  /**
   * Feed a fresh target. `azRate`/`elRate` are the true sky rates (°/s) — pass them
   * if you can compute them (finite-difference the look angle); they make tracking
   * lead the target instead of chasing it. Omit and they're estimated from successive
   * setpoints. Az is unwrapped to stay continuous with the current command.
   */
  setTarget(az, el, azRate = null, elRate = null) {
    if (!Number.isFinite(az) || !Number.isFinite(el)) return;
    const prev = this.tgt;
    let uaz = az;
    // Unwrap az to be within ±180° of where we already are, so motion follows the
    // short way and the target's natural progression rather than teleporting.
    const ref = this.cmd ? this.cmd.az : prev ? prev.az : az;
    uaz = ref + wrap180(az - ref);

    if (azRate == null && prev && this.lastSetT) {
      const dt = (now() - this.lastSetT) / 1000;
      if (dt > 1e-3) {
        azRate = (uaz - prev.az) / dt;
        elRate = (el - prev.el) / dt;
      }
    }
    this.tgt = { az: uaz, el, azRate: azRate || 0, elRate: elRate || 0 };
    this.lastSetT = now();
    if (!this.cmd) this.cmd = { az: uaz, el }; // first lock: start exactly on target
  }

  start() {
    if (this.timer) return;
    this.lastT = now();
    const periodMs = 1000 / this.cfg.rateHz;
    this.timer = setInterval(() => this._step(), periodMs);
  }

  stop({ halt = true } = {}) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (halt) this.send({ az: this.cmd?.az ?? 0, el: this.cmd?.el ?? 0, azRate: 0, elRate: 0, stop: true });
    this._reset();
    this.lastSetT = 0;
  }

  /** One control-loop iteration: extrapolate target, compute + limit velocity, integrate, emit. */
  _step() {
    const t = now();
    let dt = (t - this.lastT) / 1000;
    this.lastT = t;
    if (dt <= 0 || dt > 0.5) dt = 1 / this.cfg.rateHz; // guard against tab-throttle hiccups
    if (!this.tgt || !this.cmd) return;

    // Extrapolate the target forward at its own rate so we keep moving smoothly in
    // the gaps between the slow setpoint updates.
    this.tgt.az += this.tgt.azRate * dt;
    this.tgt.el += this.tgt.elRate * dt;
    this.tgt.el = clamp(this.tgt.el, 0, 90);

    for (const ax of ['az', 'el']) {
      const ff = this.tgt[ax + 'Rate'];
      const err = this.tgt[ax] - this.cmd[ax];
      // Desired velocity: feedforward (keeps us moving with the sky) + position trim.
      let vDes = ff + this.cfg.kp * err;
      vDes = clamp(vDes, -this.cfg.maxVel[ax], this.cfg.maxVel[ax]); // keyhole clamp

      // Jerk-limited approach to the desired velocity (S-curve), then accel clamp.
      const aMax = this.cfg.maxAccel[ax];
      const jMax = this.cfg.maxJerk[ax];
      let aDes = (vDes - this.vel[ax]) / dt;
      aDes = clamp(aDes, -aMax, aMax);
      const dA = clamp(aDes - this.acc[ax], -jMax * dt, jMax * dt);
      this.acc[ax] += dA;
      this.vel[ax] += this.acc[ax] * dt;
      this.vel[ax] = clamp(this.vel[ax], -this.cfg.maxVel[ax], this.cfg.maxVel[ax]);
      this.cmd[ax] += this.vel[ax] * dt;
    }
    this.cmd.el = clamp(this.cmd.el, 0, 90);

    this.send({
      az: wrap360(this.cmd.az),
      el: this.cmd.el,
      azRate: this.vel.az,
      elRate: this.vel.el,
    });
  }
}

/* ------------------------------ angle helpers ------------------------------ */
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const wrap360 = (d) => ((d % 360) + 360) % 360;
const wrap180 = (d) => {
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  return x;
};
