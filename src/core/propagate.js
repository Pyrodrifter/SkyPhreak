import * as satellite from 'satellite.js';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
export const EARTH_R = 6371; // km, mean radius

/** Build a satellite record from a TLE line pair. Returns null if invalid. */
export function makeSatrec(line1, line2) {
  try {
    const satrec = satellite.twoline2satrec(line1, line2);
    if (satrec.error) return null;
    return satrec;
  } catch {
    return null;
  }
}

/**
 * ECI (TEME) state { position, velocity } for a propagation source at a date.
 * Branches between an SGP4 satrec (TLE/OMM) and a tabulated OEM Ephemeris, which
 * exposes the same shape via .eval(). Returns null on failure / outside span.
 */
function propagateEci(satrec, date) {
  return satrec && satrec.isEphemeris ? satrec.eval(date) : satellite.propagate(satrec, date);
}

/** Epoch of a TLE (the element-set reference time) as Unix ms. */
export function epochMs(satrec) {
  return (satrec.jdsatepoch - 2440587.5) * 86400000;
}

/**
 * Age in days at `now` of the elements driving a satellite. For an SGP4 satrec
 * this is the TLE/OMM epoch age. For an OEM ephemeris it is 0 while `now` is
 * within (or before) the tabulated span, growing only once the table runs out —
 * the meaningful "stale" signal for a finite ephemeris.
 */
export function tleAgeDays(satrec, now = Date.now()) {
  if (satrec && satrec.isEphemeris) return now > satrec.stopMs ? (now - satrec.stopMs) / 86400000 : 0;
  return (now - epochMs(satrec)) / 86400000;
}

/** Orbital period in minutes derived from mean motion (satrec.no = rad/min). */
export function periodMinutes(satrec) {
  if (!satrec.no) return 90;
  return (2 * Math.PI) / satrec.no;
}

/**
 * Geodetic sub-point + velocity for a satellite at a given time.
 * Returns { lat, lon, altKm, velocityKmS } or null on propagation failure.
 */
export function subPoint(satrec, date) {
  const pv = propagateEci(satrec, date);
  if (!pv || !pv.position) return null;
  const gmst = satellite.gstime(date);
  const geo = satellite.eciToGeodetic(pv.position, gmst);
  const v = pv.velocity;
  const speed = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : 0;
  return {
    lat: geo.latitude * DEG,
    lon: normLon(geo.longitude * DEG),
    altKm: geo.height,
    velocityKmS: speed,
  };
}

/**
 * Look angles (az/el/range) from an observer to a satellite.
 * observer: { lat, lon, altKm } in degrees/km.
 * Returns { az, el, rangeKm, dopplerFactor } where dopplerFactor multiplies a
 * downlink frequency to give the observed (shifted) frequency.
 */
export function lookAngles(satrec, date, observer) {
  const pv = propagateEci(satrec, date);
  if (!pv || !pv.position) return null;
  const gmst = satellite.gstime(date);
  const observerGd = {
    longitude: observer.lon * RAD,
    latitude: observer.lat * RAD,
    height: (observer.altKm || 0),
  };
  const ecf = satellite.eciToEcf(pv.position, gmst);
  const look = satellite.ecfToLookAngles(observerGd, ecf);

  // Range rate for Doppler: project relative velocity onto the line of sight.
  let dopplerFactor = 1;
  if (pv.velocity) {
    const vEcf = satellite.eciToEcf(pv.velocity, gmst);
    const posEcfObs = satellite.geodeticToEcf(observerGd);
    const rx = ecf.x - posEcfObs.x;
    const ry = ecf.y - posEcfObs.y;
    const rz = ecf.z - posEcfObs.z;
    const rng = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    const rangeRate = (rx * vEcf.x + ry * vEcf.y + rz * vEcf.z) / rng; // km/s
    const c = 299792.458; // km/s
    dopplerFactor = 1 - rangeRate / c; // approaching (negative rate) -> higher freq
  }

  return {
    az: look.azimuth * DEG,
    el: look.elevation * DEG,
    rangeKm: look.rangeSat,
    dopplerFactor,
  };
}

/** Footprint (coverage) angular radius in degrees for altitude h (km). */
export function footprintRadiusDeg(altKm) {
  const ratio = EARTH_R / (EARTH_R + altKm);
  return Math.acos(Math.max(-1, Math.min(1, ratio))) * DEG;
}

/** Sub-solar point (lat/lon) for terminator + day/night shading. */
export function subSolarPoint(date) {
  const jd = date / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda)) * DEG;
  // Greenwich hour angle of the sun -> sub-solar longitude.
  const gmst = satellite.gstime(date) * DEG;
  let ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) * DEG;
  let lon = normLon(ra - gmst);
  return { lat: decl, lon };
}

export function normLon(lon) {
  let l = lon % 360;
  if (l > 180) l -= 360;
  if (l < -180) l += 360;
  return l;
}

/** Destination lat/lon given start, angular distance (deg) and bearing (deg). */
export function destPoint(lat, lon, angDist, bearing) {
  const φ1 = lat * RAD;
  const λ1 = lon * RAD;
  const δ = angDist * RAD;
  const θ = bearing * RAD;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: φ2 * DEG, lon: normLon(λ2 * DEG) };
}
