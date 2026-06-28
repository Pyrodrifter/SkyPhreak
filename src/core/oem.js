import * as satellite from 'satellite.js';

/**
 * OEM (Orbit Ephemeris Message) support. Unlike a TLE/OMM — which carry SGP4
 * *mean elements* the app turns into a satrec and propagates analytically — an
 * OEM is a *tabulated ephemeris*: a list of state vectors (position + velocity)
 * at timestamps, produced by a real numerical integrator. There are no mean
 * elements and SGP4 does not apply; you interpolate the table instead.
 *
 * To slot into the existing pipeline without disturbing it, parseOem() returns
 * the same { name, noradId, line1, line2, satrec } entry shape as the TLE/OMM
 * parsers — except `satrec` is an {@link Ephemeris} that duck-types the few
 * fields/behaviours propagate.js relies on (`.no`, `.jdsatepoch`, `.error`,
 * `.isEphemeris`, `.eval(date)`). propagate.js branches on `.isEphemeris`, so
 * subPoint/lookAngles/predictPasses and the ground-track views work unchanged.
 *
 * Frames & precision. Everything downstream funnels to ECEF via satellite.js's
 * GMST rotation, which assumes a TEME-like ECI. eval() therefore returns state
 * already rotated into that frame:
 *   - TEME / TOD            → used as-is (TOD ≈ TEME to ~1″, sub-km).
 *   - EME2000/J2000/GCRF    → IAU-76 precession J2000 → mean-of-date (the
 *     dominant term, ~0.014°/yr; nutation/equation-of-equinoxes left off as
 *     they are arcsecond-level, far under any rotator beamwidth).
 *   - ITRF/ITRF2000/GTOD…   → already Earth-fixed; rotated to ECI by +GMST with
 *     the ω×r term added back to the velocity (for Doppler).
 * TIME_SYSTEM is normalised to UTC with a constant offset (TAI/GPS/TT), which is
 * correct to the second across the current leap-second era.
 */

const MU = 398600.4418; // km³/s², Earth GM
const OMEGA_E = 7.2921159e-5; // rad/s, Earth rotation rate
const EDGE_SLOP_MS = 1000; // tolerance for queries a hair outside the table span

/* ------------------------------- Public API ------------------------------- */

// Parse a CCSDS OEM document (KVN text or XML) into TLE-parser-shaped entries.
export function parseOem(text) {
  const t = (text || '').trim();
  if (!t) return [];
  try {
    return t.startsWith('<') ? parseOemXml(text) : parseOemKvn(text);
  } catch {
    return [];
  }
}

/* ----------------------------- KVN (text) parse --------------------------- */

function parseOemKvn(text) {
  const segs = [];
  let meta = null;
  let recs = null;
  let inData = false;
  let inCov = false;
  const flush = () => {
    if (meta && recs && recs.length) segs.push({ meta, recs });
    meta = null; recs = null; inData = false; inCov = false;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('COMMENT')) continue;
    if (line === 'META_START') { flush(); meta = {}; recs = []; continue; }
    if (line === 'META_STOP') { inData = true; continue; }
    if (line === 'COVARIANCE_START') { inCov = true; continue; }
    if (line === 'COVARIANCE_STOP') { inCov = false; continue; }
    if (inCov) continue;

    if (meta && !inData) {
      const eq = line.indexOf('=');
      if (eq > 0) meta[line.slice(0, eq).trim().toUpperCase()] = line.slice(eq + 1).trim();
      continue;
    }
    if (inData) {
      const rec = parseDataLine(line);
      if (rec) recs.push(rec);
    }
  }
  flush();
  return buildEntries(segs);
}

// One ephemeris row: "<epoch> X Y Z [Vx Vy Vz [Ax Ay Az]]" (km, km/s).
function parseDataLine(line) {
  const p = line.split(/\s+/);
  if (p.length < 4) return null;
  const t = parseEpochMs(p[0]);
  if (!isFinite(t)) return null;
  const n = p.slice(1).map(Number);
  if (n.length < 3 || n.slice(0, 3).some((x) => !isFinite(x))) return null;
  const v = n.length >= 6 && n.slice(3, 6).every(isFinite) ? [n[3], n[4], n[5]] : null;
  return { t, r: [n[0], n[1], n[2]], v };
}

/* ------------------------------- XML parse -------------------------------- */

function parseOemXml(text) {
  if (typeof DOMParser === 'undefined') return [];
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) return [];
  const segs = [];
  for (const seg of doc.querySelectorAll('segment')) {
    const meta = {};
    for (const el of seg.querySelectorAll('metadata > *')) meta[el.tagName.toUpperCase()] = el.textContent.trim();
    const recs = [];
    for (const sv of seg.querySelectorAll('data > stateVector')) {
      const t = parseEpochMs(text1(sv, 'EPOCH'));
      if (!isFinite(t)) continue;
      const r = [num(sv, 'X'), num(sv, 'Y'), num(sv, 'Z')];
      if (r.some((x) => !isFinite(x))) continue;
      const v = ['X_DOT', 'Y_DOT', 'Z_DOT'].map((k) => num(sv, k));
      recs.push({ t, r, v: v.every(isFinite) ? v : null });
    }
    if (recs.length) segs.push({ meta, recs });
  }
  return buildEntries(segs);
}

const text1 = (el, tag) => el.querySelector(tag)?.textContent.trim() ?? '';
const num = (el, tag) => Number(text1(el, tag));

/* ------------------------- Segment → Ephemeris ---------------------------- */

// Merge segments belonging to the same object/frame/time-system (a single OEM
// commonly splits an object's ephemeris across maneuvers), then build one entry.
function buildEntries(segs) {
  const groups = new Map();
  for (const s of segs) {
    const m = s.meta;
    const key = `${(m.OBJECT_ID || m.OBJECT_NAME || 'OBJECT').trim()}|${m.REF_FRAME || ''}|${m.TIME_SYSTEM || ''}`;
    if (!groups.has(key)) groups.set(key, { meta: m, recs: [] });
    groups.get(key).recs.push(...s.recs);
  }

  const out = [];
  for (const g of groups.values()) {
    const m = g.meta;
    const offsetMs = timeSysOffsetSec(m.TIME_SYSTEM) * 1000;
    let recs = g.recs
      .map((r) => ({ t: r.t - offsetMs, r: r.r, v: r.v })) // normalise epochs to UTC
      .sort((a, b) => a.t - b.t)
      .filter((r, i, a) => i === 0 || r.t !== a[i - 1].t); // drop duplicate timestamps
    if (recs.length < 2) continue;
    fillVelocities(recs);

    const degree = parseInt(m.INTERPOLATION_DEGREE, 10);
    const ephem = new Ephemeris({
      name: (m.OBJECT_NAME || m.OBJECT_ID || 'OEM object').trim(),
      frame: m.REF_FRAME,
      records: recs,
      degree: isFinite(degree) ? degree : 5,
    });
    out.push({
      name: ephem.name,
      noradId: deriveId(m.OBJECT_ID, m.OBJECT_NAME),
      line1: null,
      line2: null,
      satrec: ephem,
      isOem: true,
    });
  }
  return out;
}

// Fill any rows lacking velocity by central-differencing position (rare: most
// OEMs include velocity, but pos-only ephemerides are legal).
function fillVelocities(recs) {
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].v) continue;
    const a = recs[Math.max(0, i - 1)];
    const b = recs[Math.min(recs.length - 1, i + 1)];
    const dt = (b.t - a.t) / 1000;
    recs[i].v = dt ? [(b.r[0] - a.r[0]) / dt, (b.r[1] - a.r[1]) / dt, (b.r[2] - a.r[2]) / dt] : [0, 0, 0];
  }
}

// A stable, NORAD-distinct id. OEMs carry no catalog number, so namespace it.
function deriveId(objectId, name) {
  return 'OEM:' + String(objectId || name || 'object').trim().replace(/\s+/g, '_');
}

/* ------------------------------- Ephemeris -------------------------------- */

/**
 * A tabulated ephemeris that duck-types the slice of `satrec` propagate.js uses.
 * eval(date) Lagrange-interpolates the table and returns TEME-like ECI state
 * { position, velocity } (km, km/s) — the same shape satellite.propagate emits —
 * or null when the query falls outside the table's time span.
 */
class Ephemeris {
  constructor({ name, frame, records, degree }) {
    this.isEphemeris = true;
    this.error = 0;
    this.name = name;
    this.frameKind = frameKind(frame); // 'teme' | 'j2000' | 'ecef'
    this.frameRaw = frame || 'TEME';
    this.records = records;
    this.startMs = records[0].t;
    this.stopMs = records[records.length - 1].t;
    // Interpolation window: degree+1 points, centred on the query, clamped to span.
    this.k = Math.min(Math.max((degree | 0) + 1, 2), records.length);
    // satrec-compat: epoch (for tleAgeDays/epochMs) and mean motion (periodMinutes).
    this.jdsatepoch = this.startMs / 86400000 + 2440587.5;
    this.no = this._meanMotion();
  }

  // Mean motion (rad/min) from a mid-table state via vis-viva — only drives the
  // ground-track sample window, so an approximation is fine. Convert to inertial
  // first so an Earth-fixed (ITRF) velocity doesn't corrupt the energy.
  _meanMotion() {
    const mid = this.records[this.records.length >> 1];
    const st = this.toEci(mid.r, mid.v, new Date(mid.t));
    const r = Math.hypot(st.position.x, st.position.y, st.position.z);
    const v = Math.hypot(st.velocity.x, st.velocity.y, st.velocity.z);
    const a = 1 / (2 / r - (v * v) / MU); // vis-viva semi-major axis
    return a > 0 ? Math.sqrt(MU / (a * a * a)) * 60 : 0;
  }

  eval(date) {
    const t = date.getTime();
    const r = this.records;
    if (t < this.startMs - EDGE_SLOP_MS || t > this.stopMs + EDGE_SLOP_MS) return null;

    const s = this._window(t);
    const ts = [];
    const cols = [[], [], [], [], [], []]; // x y z vx vy vz
    for (let i = s; i < s + this.k; i++) {
      const p = r[i];
      ts.push(p.t);
      cols[0].push(p.r[0]); cols[1].push(p.r[1]); cols[2].push(p.r[2]);
      cols[3].push(p.v[0]); cols[4].push(p.v[1]); cols[5].push(p.v[2]);
    }
    const c = cols.map((y) => lagrange(ts, y, t));
    return this.toEci([c[0], c[1], c[2]], [c[3], c[4], c[5]], date);
  }

  // First index of the k-point window centred on time t (clamped to the table).
  _window(t) {
    const r = this.records;
    let lo = 0;
    let hi = r.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (r[m].t < t) lo = m + 1; else hi = m;
    }
    let start = lo - (this.k >> 1);
    if (start < 0) start = 0;
    if (start + this.k > r.length) start = r.length - this.k;
    return start;
  }

  // Rotate a raw table state (in this OEM's frame) into TEME-like ECI.
  toEci(pos, vel, date) {
    if (this.frameKind === 'j2000') {
      const M = precessionMatrix(date); // J2000 → mean-of-date
      pos = mv(M, pos);
      vel = mv(M, vel);
    } else if (this.frameKind === 'ecef') {
      return ecefToEci(pos, vel, date);
    }
    return { position: { x: pos[0], y: pos[1], z: pos[2] }, velocity: { x: vel[0], y: vel[1], z: vel[2] } };
  }
}

/* ------------------------------ Frame helpers ----------------------------- */

function frameKind(frame) {
  const f = String(frame || 'TEME').toUpperCase().replace(/[\s_-]/g, '');
  if (/^(ITRF|GTOD|TDR|EFG|GRGT|WGS84|PEF|ECEF|ECF)/.test(f)) return 'ecef';
  if (/^(EME2000|J2000|GCRF|ICRF|MJ2000EQ)/.test(f)) return 'j2000';
  return 'teme'; // TEME, TOD, and anything unrecognised (closest to the SGP4 world)
}

// Earth-fixed → ECI: rotate by +GMST about Z and restore the ω×r velocity term.
function ecefToEci(pos, vel, date) {
  const th = satellite.gstime(date);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const x = pos[0] * c - pos[1] * s;
  const y = pos[0] * s + pos[1] * c;
  const z = pos[2];
  return {
    position: { x, y, z },
    velocity: {
      x: vel[0] * c - vel[1] * s - OMEGA_E * y,
      y: vel[0] * s + vel[1] * c + OMEGA_E * x,
      z: vel[2],
    },
  };
}

// IAU-76 precession matrix: M·r_J2000 = r_mean-of-date.
function precessionMatrix(date) {
  const T = (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525.0; // Julian centuries from J2000
  const a = Math.PI / (180 * 3600); // arcsec → rad
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * a;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * a;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * a;
  return mul3(rotZ(-z), mul3(rotY(theta), rotZ(-zeta)));
}

/* --------------------------------- Math ----------------------------------- */

function lagrange(xs, ys, x) {
  let sum = 0;
  const n = xs.length;
  for (let i = 0; i < n; i++) {
    let term = ys[i];
    for (let j = 0; j < n; j++) if (j !== i) term *= (x - xs[j]) / (xs[i] - xs[j]);
    sum += term;
  }
  return sum;
}

const rotZ = (a) => [[Math.cos(a), Math.sin(a), 0], [-Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
const rotY = (a) => [[Math.cos(a), 0, -Math.sin(a)], [0, 1, 0], [Math.sin(a), 0, Math.cos(a)]];

function mul3(A, B) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
  return C;
}

const mv = (M, v) => [
  M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
  M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
  M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
];

/* --------------------------------- Time ----------------------------------- */

// Seconds to subtract from a TIME_SYSTEM-labelled epoch to get UTC. Constant
// within the current leap-second era (valid 2017–present).
function timeSysOffsetSec(ts) {
  switch (String(ts || 'UTC').toUpperCase()) {
    case 'TAI': return 37;
    case 'GPS': return 18;
    case 'TT':
    case 'TDT':
    case 'TDB':
    case 'ET': return 69.184;
    default: return 0; // UTC, UT1 (≈ UTC)
  }
}

// Parse an OEM epoch: ISO calendar ("2026-06-25T00:00:00.000") or CCSDS
// day-of-year ("2026-176T00:00:00.000"). Returned ms is in the file's time
// system; buildEntries applies the UTC offset.
function parseEpochMs(s) {
  s = String(s).trim();
  const doy = s.match(/^(\d{4})-(\d{3})T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (doy) {
    const [, y, d, hh, mm, ss] = doy;
    return Date.UTC(+y, 0, 1) + (+d - 1) * 86400000 + (+hh * 3600 + +mm * 60 + +ss) * 1000;
  }
  return new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z').getTime();
}
