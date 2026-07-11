/**
 * Pass quality score — an EXPLAINABLE 0–100 rating for a predicted pass.
 * The total is simply the sum of its parts (clamped 0..100), and the parts are
 * returned so the UI can show exactly where the number came from:
 *
 *   Elevation   0..50   how high the pass peaks (sub-linear — 45° is already good)
 *   Duration    0..25   15 minutes = full marks
 *   Visible     0 / 15  optically visible (sunlit sat, dark observer)
 *   Freshness   0..10   TLE age (full under 1 d, fading to 0 by 7 d)
 *   Sun         −10     pass encroaches on the Sun keep-out (when guard enabled)
 *   Mount limit −30     peak above the mount's El max (no flip-over available)
 *
 * Horizon obstruction is intentionally absent here: once the horizon mask lands,
 * predictions themselves account for it, so the geometry parts already reflect it.
 */
export function scorePass(pass, ctx = {}) {
  const parts = [];

  const el = Math.max(0, Math.min(90, pass.maxEl));
  parts.push({ label: 'Elevation', pts: Math.round(50 * Math.pow(el / 90, 0.8)) });

  parts.push({ label: 'Duration', pts: Math.round(25 * Math.min(1, pass.durationS / 900)) });

  if (ctx.visible) parts.push({ label: 'Visible pass', pts: 15 });

  let fresh = 10;
  if (ctx.tleAgeDays != null) fresh = Math.round(10 * Math.max(0, 1 - Math.max(0, ctx.tleAgeDays - 1) / 6));
  parts.push({ label: 'TLE freshness', pts: fresh });

  if (ctx.sunAvoid && ctx.sunSepDeg != null && ctx.sunSepDeg < (ctx.sunAvoidDeg || 5) * 2) {
    parts.push({ label: 'Sun proximity', pts: -10 });
  }

  if (ctx.elMax != null && pass.maxEl > ctx.elMax && ctx.elMax < 135) {
    parts.push({ label: 'Above mount limit', pts: -30 });
  }

  const score = Math.max(0, Math.min(100, parts.reduce((s, p) => s + p.pts, 0)));
  return { score, parts };
}

/** One-line human breakdown for tooltips: "Elevation +34 · Duration +18 · … = 62". */
export function scoreBreakdown(s) {
  return s.parts.map((p) => `${p.label} ${p.pts >= 0 ? '+' : ''}${p.pts}`).join(' · ') + ` = ${s.score}`;
}
