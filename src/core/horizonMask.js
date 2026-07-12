/**
 * Horizon mask — a per-azimuth obstruction profile (trees, buildings, hills)
 * that raises the effective minimum elevation. A satellite is only workable
 * where its elevation clears the local horizon at that azimuth.
 *
 * The mask is a sparse list of { az, el } samples (0..360, degrees). We treat
 * it as a piecewise-linear function of azimuth, wrapping around north, and
 * evaluate it with `maskElAt`. An empty mask reads as a flat 0° horizon.
 *
 * Pure module: no DOM, no store. main.js feeds the active mask in.
 */

/** Normalize + validate a raw mask into a sorted [{az,el}] with az in [0,360). */
export function normalizeMask(points) {
  if (!Array.isArray(points)) return [];
  const clean = [];
  for (const p of points) {
    const az = Number(p?.az);
    const el = Number(p?.el);
    if (!Number.isFinite(az) || !Number.isFinite(el)) continue;
    clean.push({ az: ((az % 360) + 360) % 360, el: Math.min(90, Math.max(0, el)) });
  }
  clean.sort((a, b) => a.az - b.az);
  // Collapse duplicate azimuths, keeping the highest obstruction (most conservative).
  const out = [];
  for (const p of clean) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.az - p.az) < 1e-6) last.el = Math.max(last.el, p.el);
    else out.push({ ...p });
  }
  return out;
}

/**
 * Horizon (obstruction) elevation at a given azimuth, in degrees.
 * Linear interpolation between the two nearest samples, wrapping past north.
 */
export function maskElAt(mask, az) {
  if (!mask || mask.length === 0) return 0;
  if (mask.length === 1) return mask[0].el;
  const a = ((Number(az) % 360) + 360) % 360;

  // Find the bracketing samples (with wrap-around at 360→0).
  let lo = mask[mask.length - 1];
  let hi = mask[0];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i].az <= a) { lo = mask[i]; hi = mask[(i + 1) % mask.length]; }
  }
  let loAz = lo.az;
  let hiAz = hi.az;
  // Unwrap so hiAz > loAz and `a` sits between them.
  if (hiAz <= loAz) hiAz += 360;
  let aa = a;
  if (aa < loAz) aa += 360;
  const span = hiAz - loAz;
  if (span <= 1e-6) return Math.max(lo.el, hi.el);
  const f = (aa - loAz) / span;
  return lo.el + (hi.el - lo.el) * f;
}

/** Effective minimum elevation at an azimuth: the greater of the base cutoff and the mask. */
export function effectiveMinEl(mask, az, baseMinEl = 0) {
  return Math.max(baseMinEl || 0, maskElAt(mask, az));
}

/** Is a look-angle clear of the local horizon (plus optional extra margin)? */
export function clearsHorizon(mask, az, el, marginDeg = 0) {
  return Number(el) >= maskElAt(mask, az) + (marginDeg || 0);
}

/**
 * Given a pass's sampled sky-arc [{az,el}], compute how the horizon mask clips it:
 * the fraction of the arc that is actually above the local horizon, and the peak
 * clearance (min over the arc of el - maskEl, i.e. how comfortably the peak clears).
 * Returns { obstructed, clearFraction, peakClearanceDeg, blockedAtPeak }.
 */
export function evaluateArc(mask, arc, peakEl) {
  if (!mask || mask.length === 0 || !Array.isArray(arc) || arc.length === 0) {
    return { obstructed: false, clearFraction: 1, peakClearanceDeg: peakEl ?? null, blockedAtPeak: false };
  }
  let clear = 0;
  let bestClearance = -Infinity;
  for (const s of arc) {
    const m = maskElAt(mask, s.az);
    if (s.el >= m) clear++;
    bestClearance = Math.max(bestClearance, s.el - m);
  }
  const clearFraction = clear / arc.length;
  // The pass is "blocked at peak" if even the highest point never clears the mask.
  const blockedAtPeak = bestClearance < 0;
  return {
    obstructed: clearFraction < 0.999,
    clearFraction,
    peakClearanceDeg: bestClearance === -Infinity ? null : bestClearance,
    blockedAtPeak,
  };
}

/** A few ready-made masks so the editor isn't a blank slate. */
export const MASK_PRESETS = {
  open: { label: 'Open horizon (flat 0°)', points: [] },
  suburban: {
    label: 'Suburban (10° all round, 20° south trees)',
    points: [
      { az: 0, el: 10 }, { az: 90, el: 12 }, { az: 135, el: 20 },
      { az: 180, el: 22 }, { az: 225, el: 20 }, { az: 270, el: 12 }, { az: 315, el: 10 },
    ],
  },
  valley: {
    label: 'Valley / hills (high E-W ridge)',
    points: [
      { az: 0, el: 8 }, { az: 45, el: 15 }, { az: 90, el: 28 },
      { az: 180, el: 10 }, { az: 270, el: 28 }, { az: 315, el: 15 },
    ],
  },
};
