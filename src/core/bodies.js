import * as satellite from 'satellite.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
export const AU_KM = 149597870.7;

const sind = (d) => Math.sin(d * RAD);
const cosd = (d) => Math.cos(d * RAD);
const norm360 = (a) => ((a % 360) + 360) % 360;
function normLon(lon) {
  let l = lon % 360;
  if (l > 180) l -= 360;
  if (l < -180) l += 360;
  return l;
}

// Days since 1999-12-31 0:00 UT (Schlyter's epoch).
function dayNum(date) {
  return date.getTime() / 86400000 + 2440587.5 - 2451543.5;
}

// Orbital elements (degrees / AU) as functions of the day number `d`.
const ELEMENTS = {
  SUN: (d) => ({ N: 0, i: 0, w: 282.9404 + 4.70935e-5 * d, a: 1, e: 0.016709 - 1.151e-9 * d, M: 356.047 + 0.9856002585 * d }),
  MERCURY: (d) => ({ N: 48.3313 + 3.24587e-5 * d, i: 7.0047 + 5.0e-8 * d, w: 29.1241 + 1.01444e-5 * d, a: 0.387098, e: 0.205635 + 5.59e-10 * d, M: 168.6562 + 4.0923344368 * d }),
  VENUS: (d) => ({ N: 76.6799 + 2.4659e-5 * d, i: 3.3946 + 2.75e-8 * d, w: 54.891 + 1.38374e-5 * d, a: 0.72333, e: 0.006773 - 1.302e-9 * d, M: 48.0052 + 1.6021302244 * d }),
  MARS: (d) => ({ N: 49.5574 + 2.11081e-5 * d, i: 1.8497 - 1.78e-8 * d, w: 286.5016 + 2.92961e-5 * d, a: 1.523688, e: 0.093405 + 2.516e-9 * d, M: 18.6021 + 0.5240207766 * d }),
  JUPITER: (d) => ({ N: 100.4542 + 2.76854e-5 * d, i: 1.303 - 1.557e-7 * d, w: 273.8777 + 1.64505e-5 * d, a: 5.20256, e: 0.048498 + 4.469e-9 * d, M: 19.895 + 0.0830853001 * d }),
  SATURN: (d) => ({ N: 113.6634 + 2.3898e-5 * d, i: 2.4886 - 1.081e-7 * d, w: 339.3939 + 2.97661e-5 * d, a: 9.55475, e: 0.055546 - 9.499e-9 * d, M: 316.967 + 0.0334442282 * d }),
  URANUS: (d) => ({ N: 74.0005 + 1.3978e-5 * d, i: 0.7733 + 1.9e-8 * d, w: 96.6612 + 3.0565e-5 * d, a: 19.18171 - 1.55e-8 * d, e: 0.047318 + 7.45e-9 * d, M: 142.5905 + 0.011725806 * d }),
  NEPTUNE: (d) => ({ N: 131.7806 + 3.0173e-5 * d, i: 1.77 - 2.55e-7 * d, w: 272.8461 - 6.027e-6 * d, a: 30.05826 + 3.313e-8 * d, e: 0.008606 + 2.15e-9 * d, M: 260.2471 + 0.005995147 * d }),
};

// Eccentric anomaly (deg).
function eccAnomaly(M, e) {
  M = norm360(M);
  let E = M + e * DEG * sind(M) * (1 + e * cosd(M));
  for (let k = 0; k < 8; k++) E = E - (E - e * DEG * sind(E) - M) / (1 - e * cosd(E));
  return E;
}

// Heliocentric (or geocentric, for the Sun) rectangular ecliptic coords + r.
function helioRect(el) {
  const E = eccAnomaly(el.M, el.e);
  const xv = el.a * (cosd(E) - el.e);
  const yv = el.a * (Math.sqrt(1 - el.e * el.e) * sind(E));
  const v = norm360(Math.atan2(yv, xv) * DEG);
  const r = Math.sqrt(xv * xv + yv * yv);
  const xh = r * (cosd(el.N) * cosd(v + el.w) - sind(el.N) * sind(v + el.w) * cosd(el.i));
  const yh = r * (sind(el.N) * cosd(v + el.w) + cosd(el.N) * sind(v + el.w) * cosd(el.i));
  const zh = r * (sind(v + el.w) * sind(el.i));
  return { xh, yh, zh, r, v };
}

/**
 * Geocentric apparent position of a Sun/planet. Returns equatorial RA/Dec
 * (degrees, equator of date), geocentric distance (AU), and the sub-point
 * (lat = Dec, lon = RA − GMST). Accuracy ~1–2 arc-minutes for the bright
 * planets — ample for pointing and visualisation.
 */
export function planetState(name, date) {
  const d = dayNum(date);
  const ecl = 23.4393 - 3.563e-7 * d;

  // Sun (also the geocentric offset for the planets).
  const sun = helioRect(ELEMENTS.SUN(d));
  const lonsun = norm360(sun.v + ELEMENTS.SUN(d).w);
  const xs = sun.r * cosd(lonsun);
  const ys = sun.r * sind(lonsun);

  let xg, yg, zg;
  if (name === 'SUN') {
    xg = xs; yg = ys; zg = 0;
  } else {
    const p = helioRect(ELEMENTS[name](d));
    let lon = Math.atan2(p.yh, p.xh) * DEG;
    let lat = Math.atan2(p.zh, Math.sqrt(p.xh * p.xh + p.yh * p.yh)) * DEG;
    let r = p.r;

    // Major perturbations for the outer planets (Schlyter).
    const Mj = norm360(ELEMENTS.JUPITER(d).M);
    const Ms = norm360(ELEMENTS.SATURN(d).M);
    const Mu = norm360(ELEMENTS.URANUS(d).M);
    if (name === 'JUPITER') {
      lon += -0.332 * sind(2 * Mj - 5 * Ms - 67.6) - 0.056 * sind(2 * Mj - 2 * Ms + 21) +
        0.042 * sind(3 * Mj - 5 * Ms + 21) - 0.036 * sind(Mj - 2 * Ms) +
        0.022 * cosd(Mj - Ms) + 0.023 * sind(2 * Mj - 3 * Ms + 52) - 0.016 * sind(Mj - 5 * Ms - 69);
    } else if (name === 'SATURN') {
      lon += 0.812 * sind(2 * Mj - 5 * Ms - 67.6) - 0.229 * cosd(2 * Mj - 4 * Ms - 2) +
        0.119 * sind(Mj - 2 * Ms - 3) + 0.046 * sind(2 * Mj - 6 * Ms - 69) + 0.014 * sind(Mj - 3 * Ms + 32);
      lat += -0.02 * cosd(2 * Mj - 4 * Ms - 2) + 0.018 * sind(2 * Mj - 6 * Ms - 49);
    } else if (name === 'URANUS') {
      lon += 0.04 * sind(Ms - 2 * Mu + 6) + 0.035 * sind(Ms - 3 * Mu + 33) - 0.015 * sind(Mj - Mu + 20);
    }

    const xh = r * cosd(lon) * cosd(lat);
    const yh = r * sind(lon) * cosd(lat);
    const zh = r * sind(lat);
    xg = xh + xs;
    yg = yh + ys;
    zg = zh;
  }

  // Ecliptic -> equatorial.
  const xe = xg;
  const ye = yg * cosd(ecl) - zg * sind(ecl);
  const ze = yg * sind(ecl) + zg * cosd(ecl);
  const ra = norm360(Math.atan2(ye, xe) * DEG);
  const dec = Math.atan2(ze, Math.sqrt(xe * xe + ye * ye)) * DEG;
  const distanceAU = Math.sqrt(xg * xg + yg * yg + zg * zg);

  const gmstDeg = satellite.gstime(date) * DEG;
  return { ra, dec, distanceAU, sub: { lat: dec, lon: normLon(ra - gmstDeg) } };
}

/** Sub-point (lat = Dec, lon = RA − GMST) for any equatorial RA/Dec. */
export function subPointOf(raDeg, decDeg, date) {
  const gmstDeg = satellite.gstime(date) * DEG;
  return { lat: decDeg, lon: normLon(raDeg - gmstDeg) };
}

/** Topocentric az/el from equatorial RA/Dec (parallax-free; fine beyond the Moon). */
export function raDecToAzEl(raDeg, decDeg, date, observer) {
  const gmstDeg = satellite.gstime(date) * DEG;
  const lst = gmstDeg + observer.lon; // local sidereal time (deg)
  const ha = norm360(lst - raDeg); // hour angle
  const sinAlt = sind(decDeg) * sind(observer.lat) + cosd(decDeg) * cosd(observer.lat) * cosd(ha);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;
  let cosA = (sind(decDeg) - sind(observer.lat) * sinAlt) / (cosd(observer.lat) * Math.cos(alt * RAD));
  cosA = Math.max(-1, Math.min(1, cosA));
  let az = Math.acos(cosA) * DEG;
  if (sind(ha) > 0) az = 360 - az;
  return { az, el: alt };
}
