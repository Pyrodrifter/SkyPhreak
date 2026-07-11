/**
 * Pre-pass readiness check — turns the app's existing signals into a single
 * "Ready / Attention required" state for the focus pass, with an itemised
 * checklist explaining exactly what needs attention.
 *
 * Pure function: main.js assembles the context each tick from live state and the
 * UI renders the result. States per item: 'ok' | 'warn' | 'fail' | 'off'
 * ('off' = not applicable right now, shown dim and never gates the aggregate).
 */

const SEV = { off: 0, ok: 0, warn: 1, fail: 2 };

/**
 * ctx: {
 *   station: {lat, lon, altKm},
 *   tleAgeDays: number|null, maxAgeDays: number,
 *   rotRequired: bool,           // auto-track is on (rotator expected to drive)
 *   rotConnected: bool, homed: 0|1|null,
 *   maxEl: number|null, elMax: number|null,
 *   radConnected: bool, dopplerOn: bool,
 *   wrapAz: number|null, wrapMaxDeg: number,
 *   sunAvoid: bool, sunAvoidDeg: number, sunSepDeg: number|null,
 * }
 */
export function computeReadiness(ctx) {
  const items = [];
  const add = (label, state, detail) => items.push({ label, state, detail });

  // Station location — sane coordinates, not the 0/0 null island.
  const st = ctx.station || {};
  const stOk = Number.isFinite(st.lat) && Number.isFinite(st.lon)
    && Math.abs(st.lat) <= 90 && Math.abs(st.lon) <= 180 && !(st.lat === 0 && st.lon === 0);
  add('Station location', stOk ? 'ok' : 'fail',
    stOk ? `${st.lat.toFixed(2)}°, ${st.lon.toFixed(2)}°` : 'set your station in Setup');

  // Orbit elements freshness.
  if (ctx.tleAgeDays == null) add('Orbit elements', 'fail', 'no TLE for this target');
  else if (ctx.tleAgeDays <= ctx.maxAgeDays) add('Orbit elements', 'ok', `TLE ${ctx.tleAgeDays.toFixed(1)} d old`);
  else add('Orbit elements', 'warn', `TLE ${ctx.tleAgeDays.toFixed(1)} d old — update when online`);

  // Rotator.
  if (!ctx.rotRequired) add('Rotator', 'off', 'auto-track off');
  else if (!ctx.rotConnected) add('Rotator', 'fail', 'not connected');
  else if (ctx.homed === 0) add('Rotator', 'warn', 'connected · not homed');
  else add('Rotator', 'ok', 'connected' + (ctx.homed ? ' · homed' : ''));

  // Mechanical limits — is the pass peak reachable? (elMax >= 135 allows flip-over.)
  if (ctx.maxEl != null && ctx.elMax != null) {
    const reachable = ctx.maxEl <= ctx.elMax || ctx.elMax >= 135;
    add('Mechanical limits', reachable ? 'ok' : 'fail',
      reachable ? `peak ${ctx.maxEl.toFixed(0)}° within limits`
        : `peak ${ctx.maxEl.toFixed(0)}° exceeds El max ${ctx.elMax}°`);
  }

  // Radio — informational; a rotator-only station is still "ready".
  if (!ctx.radConnected) add('Radio', 'off', 'not connected');
  else add('Radio', 'ok', ctx.dopplerOn ? 'connected · Doppler on' : 'connected');

  // Cable-wrap headroom — a full pass can sweep up to ~360° of azimuth.
  if (ctx.rotConnected && ctx.wrapAz != null && Number.isFinite(ctx.wrapMaxDeg)) {
    const headroom = ctx.wrapMaxDeg - Math.abs(ctx.wrapAz);
    add('Cable wrap', headroom > 360 ? 'ok' : headroom > 90 ? 'warn' : 'fail',
      headroom > 360 ? 'full headroom'
        : `${Math.max(0, Math.round(headroom))}° headroom — consider Unwind`);
  }

  // Sun clearance over the pass arc (only when the guard is enabled).
  if (ctx.sunAvoid && ctx.sunSepDeg != null) {
    const clear = ctx.sunSepDeg > ctx.sunAvoidDeg;
    add('Sun clearance', clear ? 'ok' : 'warn',
      clear ? `${ctx.sunSepDeg.toFixed(0)}° from Sun`
        : `pass comes within ${ctx.sunSepDeg.toFixed(0)}° of the Sun`);
  }

  const worst = items.reduce((w, i) => Math.max(w, SEV[i.state] ?? 0), 0);
  return { state: worst === 2 ? 'fail' : worst === 1 ? 'warn' : 'ready', items };
}
