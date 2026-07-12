/**
 * Session blackbox — a rolling flight recorder for a tracking session.
 *
 * It captures two streams into capped ring buffers:
 *   • samples — periodic pointing snapshots: commanded vs actual az/el, the
 *     great-circle pointing error between them, and the tuned downlink frequency.
 *   • events  — discrete moments: connect/disconnect, park, track start/stop,
 *     errors. Timestamped, free-form detail.
 *
 * The recorder is a small stateful factory (no DOM). main.js owns one instance,
 * feeds it from the tick and the hardware event handlers, and the UI reads
 * stats() for a live summary and toCSV()/toJSON() for export/replay.
 */

const RAD = Math.PI / 180;

/** Great-circle angle (degrees) between two az/el pointing directions. */
export function angularError(az1, el1, az2, el2) {
  if (![az1, el1, az2, el2].every(Number.isFinite)) return null;
  const v = (az, el) => {
    const a = az * RAD, e = el * RAD, c = Math.cos(e);
    return [c * Math.cos(a), c * Math.sin(a), Math.sin(e)];
  };
  const p = v(az1, el1), q = v(az2, el2);
  const dot = Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
  return Math.acos(dot) / RAD;
}

export function createBlackbox({ sampleCap = 5000, eventCap = 500 } = {}) {
  const samples = [];
  const events = [];

  const push = (arr, item, cap) => { arr.push(item); if (arr.length > cap) arr.shift(); };

  return {
    /** Record a pointing snapshot. commanded/actual are {az,el} or null. */
    sample({ t = Date.now(), commanded = null, actual = null, freqHz = null, trackId = null } = {}) {
      const err = commanded && actual
        ? angularError(commanded.az, commanded.el, actual.az, actual.el) : null;
      push(samples, {
        t,
        cmdAz: commanded ? round2(commanded.az) : null,
        cmdEl: commanded ? round2(commanded.el) : null,
        actAz: actual ? round2(actual.az) : null,
        actEl: actual ? round2(actual.el) : null,
        errDeg: err == null ? null : round2(err),
        freqHz: freqHz || null,
        trackId,
      }, sampleCap);
    },

    /** Record a discrete event. */
    event(type, detail = '') {
      push(events, { t: Date.now(), type: String(type), detail: String(detail) }, eventCap);
    },

    entries() { return { samples: samples.slice(), events: events.slice() }; },
    counts() { return { samples: samples.length, events: events.length }; },

    /** Live summary: span, sample/event counts, and pointing-error stats. */
    stats() {
      const errs = samples.map((s) => s.errDeg).filter((e) => e != null);
      const all = [...samples.map((s) => s.t), ...events.map((e) => e.t)].sort((a, b) => a - b);
      const startT = all.length ? all[0] : null;
      const endT = all.length ? all[all.length - 1] : null;
      let maxErr = null, rmsErr = null;
      if (errs.length) {
        maxErr = Math.max(...errs);
        rmsErr = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
      }
      return {
        samples: samples.length,
        events: events.length,
        startT, endT,
        durationMs: startT != null ? endT - startT : 0,
        maxErrDeg: maxErr == null ? null : round2(maxErr),
        rmsErrDeg: rmsErr == null ? null : round2(rmsErr),
      };
    },

    clear() { samples.length = 0; events.length = 0; },

    /** Full session as JSON (samples + events + summary). */
    toJSON() {
      return JSON.stringify({
        exportedAt: new Date().toISOString(),
        stats: this.stats(),
        events: events.map((e) => ({ ...e, iso: new Date(e.t).toISOString() })),
        samples,
      }, null, 2);
    },

    /** Pointing log as CSV — the main analytical artifact. */
    toCSV() {
      const head = 'iso,epoch_ms,cmd_az,cmd_el,act_az,act_el,err_deg,freq_hz,track_id';
      const rows = samples.map((s) => [
        new Date(s.t).toISOString(), s.t,
        nz(s.cmdAz), nz(s.cmdEl), nz(s.actAz), nz(s.actEl), nz(s.errDeg), nz(s.freqHz),
        s.trackId == null ? '' : s.trackId,
      ].join(','));
      return [head, ...rows].join('\n');
    },
  };
}

function round2(v) { return Math.round(v * 100) / 100; }
function nz(v) { return v == null ? '' : v; }
