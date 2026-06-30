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
  // Absolute azimuth range. We emit CONTINUOUS (unwrapped) az into this range — the
  // host owns trajectory continuity, the rotator positions absolutely — so a north
  // crossing keeps turning the same direction instead of unwinding 358°. azMax > 360
  // is the cable-overlap region. Elevation ceiling is elMax (90, or up to 180).
  azMin: 0,
  azMax: 450,
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
    this.actual = null; // rotator's reported azimuth (telemetry) — closed-loop reference
    this._reset();
  }

  /** Feed the rotator's actual reported azimuth (from telemetry) for closed-loop sync. */
  setActual(az) {
    this.actual = Number.isFinite(az) ? az : null;
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
    // Resolve az to the equivalent nearest the rotator's ACTUAL position (closed-loop),
    // so a slew always takes the short way from where the mount really is. Falls back
    // to the model position if telemetry isn't available.
    const ref = Number.isFinite(this.actual) ? this.actual : this.cmd ? this.cmd.az : prev ? prev.az : az;
    let uaz = ref + wrap180(az - ref);
    // Keep the absolute target inside the rotator's travel range. If the nearest
    // equivalent falls outside, step by whole turns into range — this is what forces
    // the long way round when the mount is wound near a limit (vs. an impossible
    // out-of-range target it could never reach). Callers seed cmd from the actual
    // position on an object change so this resolves to the genuine shortest path.
    const { azMin, azMax } = this.cfg;
    while (uaz > azMax && uaz - 360 >= azMin) uaz -= 360;
    while (uaz < azMin && uaz + 360 <= azMax) uaz += 360;
    uaz = clamp(uaz, azMin, azMax);

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

  /**
   * Seed the continuous-azimuth accumulator from a known actual position (e.g. the
   * rotator's reported telemetry az) so the first setTarget unwraps relative to where
   * the mount really is, not an assumed 0. `az` is continuous (may exceed 360).
   */
  seed(az, el) {
    if (!Number.isFinite(az)) return;
    this.cmd = { az, el: Number.isFinite(el) ? el : this.cmd?.el ?? 0 };
    this.tgt = null;
    this.lastSetT = 0;
    this.vel = { az: 0, el: 0 };
    this.acc = { az: 0, el: 0 };
  }

  /** One control-loop iteration: extrapolate target, compute + limit velocity, integrate, emit. */
  _step() {
    const t = now();
    let dt = (t - this.lastT) / 1000;
    this.lastT = t;
    if (dt <= 0 || dt > 0.5) dt = 1 / this.cfg.rateHz; // guard against tab-throttle hiccups
    if (!this.tgt || !this.cmd) return;

    // Closed-loop resync: if the model has drifted far from the rotator's real azimuth
    // (e.g. after a park/stow/manual move left them a whole turn apart), snap to reality
    // so we stream positions the mount can reach the SHORT way — not a phantom wound-up
    // value that makes it spin almost all the way around. The 30° threshold is far above
    // normal tracking lag, so it never fires during smooth tracking.
    if (Number.isFinite(this.actual) && Math.abs(this.cmd.az - this.actual) > 30) {
      this.cmd.az = this.actual;
      this.vel.az = 0;
      this.acc.az = 0;
      this.tgt.az = this.actual + wrap180(this.tgt.az - this.actual); // re-aim from reality
    }

    // Extrapolate the target forward at its own rate so we keep moving smoothly in
    // the gaps between the slow setpoint updates.
    this.tgt.az += this.tgt.azRate * dt;
    this.tgt.el += this.tgt.elRate * dt;
    this.tgt.el = clamp(this.tgt.el, 0, this.cfg.elMax);

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

    // Clamp to the rotator's absolute travel. Azimuth is CONTINUOUS (not wrapped) —
    // it may exceed 360 in the overlap region. Anti-windup: if we're pinned at a
    // bound, zero any velocity still pushing into it so we can leave cleanly.
    if (this.cmd.az < this.cfg.azMin) { this.cmd.az = this.cfg.azMin; if (this.vel.az < 0) { this.vel.az = 0; this.acc.az = 0; } }
    else if (this.cmd.az > this.cfg.azMax) { this.cmd.az = this.cfg.azMax; if (this.vel.az > 0) { this.vel.az = 0; this.acc.az = 0; } }
    this.cmd.el = clamp(this.cmd.el, 0, this.cfg.elMax);

    this.send({
      az: this.cmd.az, // continuous / unwrapped — host owns trajectory continuity
      el: this.cmd.el,
      azRate: this.vel.az,
      elRate: this.vel.el,
    });
  }
}

/* ------------------------------ angle helpers ------------------------------ */
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const wrap180 = (d) => {
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  return x;
};
