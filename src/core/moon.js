import * as satellite from 'satellite.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const ER_KM = 6378.137; // Earth equatorial radius (the unit of Schlyter's a)

/**
 * Geocentric Moon position (Schlyter's low-precision method with the main
 * lunar perturbations — accurate to a few arc-minutes, ample for tracking and
 * visualisation). Returns equatorial RA/Dec, distance, an ECI vector in km,
 * the sub-lunar point, and phase/illumination.
 */
export function moonState(date) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451543.5; // days since 1999-12-31 0:00 UT

  // Sun (needed for perturbations + phase).
  const ws = 282.9404 + 4.70935e-5 * d;
  const Ms = norm360(356.047 + 0.9856002585 * d);
  const Ls = norm360(ws + Ms);

  // Moon orbital elements.
  const N = 125.1228 - 0.0529538083 * d;
  const i = 5.1454;
  const w = 318.0634 + 0.1643573223 * d;
  const a = 60.2666; // Earth radii
  const e = 0.0549;
  const Mm = norm360(115.3654 + 13.0649929509 * d);

  // Eccentric anomaly (deg) by iteration.
  let E = Mm + e * DEG * sind(Mm) * (1 + e * cosd(Mm));
  for (let k = 0; k < 6; k++) {
    E = E - (E - e * DEG * sind(E) - Mm) / (1 - e * cosd(E));
  }

  // Position in orbital plane (Earth radii) -> true anomaly + radius.
  const xv = a * (cosd(E) - e);
  const yv = a * (Math.sqrt(1 - e * e) * sind(E));
  const v = norm360(Math.atan2(yv, xv) * DEG);
  let r = Math.sqrt(xv * xv + yv * yv);

  // Ecliptic geocentric coords.
  const xh = r * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i));
  const yh = r * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i));
  const zh = r * (sind(v + w) * sind(i));
  let lon = Math.atan2(yh, xh) * DEG;
  let lat = Math.atan2(zh, Math.sqrt(xh * xh + yh * yh)) * DEG;

  // Perturbation arguments.
  const Lm = norm360(N + w + Mm); // Moon's mean longitude
  const D = norm360(Lm - Ls); // mean elongation
  const F = norm360(Lm - N); // argument of latitude

  lon +=
    -1.274 * sind(Mm - 2 * D) +
    0.658 * sind(2 * D) -
    0.186 * sind(Ms) -
    0.059 * sind(2 * Mm - 2 * D) -
    0.057 * sind(Mm - 2 * D + Ms) +
    0.053 * sind(Mm + 2 * D) +
    0.046 * sind(2 * D - Ms) +
    0.041 * sind(Mm - Ms) -
    0.035 * sind(D) -
    0.031 * sind(Mm + Ms) -
    0.015 * sind(2 * F - 2 * D) +
    0.011 * sind(Mm - 4 * D);
  lat +=
    -0.173 * sind(F - 2 * D) -
    0.055 * sind(Mm - F - 2 * D) -
    0.046 * sind(Mm + F - 2 * D) +
    0.033 * sind(F + 2 * D) +
    0.017 * sind(2 * Mm + F);
  r += -0.58 * cosd(Mm - 2 * D) - 0.46 * cosd(2 * D);

  // Ecliptic -> equatorial (obliquity of date).
  const ecl = 23.4393 - 3.563e-7 * d;
  const xg = r * cosd(lon) * cosd(lat);
  const yg = r * sind(lon) * cosd(lat);
  const zg = r * sind(lat);
  const xe = xg;
  const ye = yg * cosd(ecl) - zg * sind(ecl);
  const ze = yg * sind(ecl) + zg * cosd(ecl);

  const ra = norm360(Math.atan2(ye, xe) * DEG);
  const dec = Math.atan2(ze, Math.sqrt(xe * xe + ye * ye)) * DEG;
  const distanceKm = r * ER_KM;

  // ECI (km) and sub-lunar point.
  const eciKm = { x: xe * ER_KM, y: ye * ER_KM, z: ze * ER_KM };
  const gmstDeg = satellite.gstime(date) * DEG;
  const sub = { lat: dec, lon: normLon(ra - gmstDeg) };

  // Phase: geocentric elongation from the Sun.
  const phaseDeg = norm360(lon - Ls);
  const illum = (1 - cosd(phaseDeg)) / 2;

  return { ra, dec, distanceKm, eciKm, sub, illum, phaseDeg, phaseName: phaseName(phaseDeg) };
}

/** Topocentric look angles (az/el/range) to the Moon for an observer. */
export function moonLook(eciKm, date, observer) {
  const gmst = satellite.gstime(date);
  const ecf = satellite.eciToEcf(eciKm, gmst);
  const observerGd = {
    longitude: observer.lon * RAD,
    latitude: observer.lat * RAD,
    height: observer.altKm || 0,
  };
  const look = satellite.ecfToLookAngles(observerGd, ecf);
  return { az: look.azimuth * DEG, el: look.elevation * DEG, rangeKm: look.rangeSat };
}

function phaseName(p) {
  if (p < 22.5 || p >= 337.5) return 'New';
  if (p < 67.5) return 'Waxing crescent';
  if (p < 112.5) return 'First quarter';
  if (p < 157.5) return 'Waxing gibbous';
  if (p < 202.5) return 'Full';
  if (p < 247.5) return 'Waning gibbous';
  if (p < 292.5) return 'Last quarter';
  return 'Waning crescent';
}

const sind = (deg) => Math.sin(deg * RAD);
const cosd = (deg) => Math.cos(deg * RAD);
const norm360 = (a) => ((a % 360) + 360) % 360;
function normLon(lon) {
  let l = lon % 360;
  if (l > 180) l -= 360;
  if (l < -180) l += 360;
  return l;
}
