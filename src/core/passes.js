import { lookAngles, periodMinutes } from './propagate.js';

/**
 * Predict upcoming passes for a satellite over an observer.
 * A "pass" is a contiguous interval where elevation >= minEl (degrees).
 *
 * Coarse 30s sampling finds the windows; the AOS/LOS/peak edges are then
 * refined by bisection to ~1s. Returns up to `count` passes within `hours`.
 */
export function predictPasses(satrec, observer, opts = {}) {
  const minEl = opts.minEl ?? 5;
  const hours = opts.hours ?? 48;
  const count = opts.count ?? 10;
  const start = opts.start ? opts.start.getTime() : Date.now();
  const end = start + hours * 3600 * 1000;
  const stepMs = 30 * 1000;

  const passes = [];
  let inPass = false;
  let aos = null;
  let peak = { el: -Infinity, t: 0, az: 0 };
  let prevT = start;
  let prevEl = elAt(satrec, observer, start);

  // If the satellite is already above the horizon at the window start, we're
  // mid-pass — open the pass now (AOS = start) so an in-progress pass isn't missed
  // (e.g. launching the pass scheduler while a satellite is overhead).
  if (prevEl >= minEl) {
    inPass = true;
    aos = start;
    peak = { el: -Infinity, t: 0, az: 0 };
  }

  for (let t = start + stepMs; t <= end && passes.length < count; t += stepMs) {
    const el = elAt(satrec, observer, t);
    if (!inPass && el >= minEl && prevEl < minEl) {
      inPass = true;
      aos = refineCrossing(satrec, observer, prevT, t, minEl);
      peak = { el: -Infinity, t: 0, az: 0 };
    }
    if (inPass) {
      const look = lookAngles(satrec, new Date(t), observer);
      if (look && look.el > peak.el) peak = { el: look.el, t, az: look.az };
    }
    if (inPass && el < minEl && prevEl >= minEl) {
      const los = refineCrossing(satrec, observer, prevT, t, minEl);
      const peakLook = lookAngles(satrec, new Date(peak.t), observer);
      passes.push({
        aos: new Date(aos),
        los: new Date(los),
        durationS: Math.round((los - aos) / 1000),
        maxEl: Math.round((peakLook?.el ?? peak.el) * 10) / 10,
        peakTime: new Date(peak.t), // TCA — time of closest approach / max elevation
        aosAz: round1(lookAngles(satrec, new Date(aos), observer)?.az),
        losAz: round1(lookAngles(satrec, new Date(los), observer)?.az),
        peakAz: round1(peak.az),
      });
      inPass = false;
    }
    prevT = t;
    prevEl = el;
  }
  return passes;
}

function elAt(satrec, observer, t) {
  const look = lookAngles(satrec, new Date(t), observer);
  return look ? look.el : -90;
}

// Bisection on the minEl crossing between two sample times. Works for both
// rising (AOS) and falling (LOS) edges by tracking the sign at the low end.
function refineCrossing(satrec, observer, t0, t1, minEl) {
  const lowBelow = elAt(satrec, observer, t0) < minEl;
  for (let k = 0; k < 18; k++) {
    const mid = (t0 + t1) / 2;
    const below = elAt(satrec, observer, mid) < minEl;
    if (below === lowBelow) t0 = mid;
    else t1 = mid;
  }
  return (t0 + t1) / 2;
}

function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}

export { periodMinutes };
