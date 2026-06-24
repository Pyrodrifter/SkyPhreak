import { makeSatrec } from './propagate.js';

/**
 * OMM (Orbit Mean-Elements Message) support. OMM is the modern CCSDS replacement
 * for the TLE: the same SGP4 mean elements, but in named JSON/XML/CSV fields
 * instead of the cramped 69-column two-line text. Celestrak serves it from the
 * same gp.php endpoint with FORMAT=JSON.
 *
 * satellite.js only knows twoline2satrec, so we reconstruct the two TLE lines
 * from the OMM fields and feed them through the proven parser. SGP4 propagation
 * is byte-for-byte identical — this is purely a format bridge — and the line1/
 * line2 we emit keep the rest of the app (storage, offline cache) unchanged.
 *
 * Note: TLE's 5-digit catalog number can't represent objects ≥ 100000 without
 * Alpha-5 encoding; that's a known limit of the reconstruction, not of OMM.
 */

// Parse a Celestrak OMM JSON document into the same entry shape as parseTle().
export function parseOmm(jsonText) {
  let arr;
  try {
    arr = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) arr = [arr];
  const out = [];
  for (const o of arr) {
    const tle = ommToTle(o);
    if (!tle) continue;
    const satrec = makeSatrec(tle.line1, tle.line2);
    if (!satrec) continue;
    out.push({ name: tle.name, noradId: tle.noradId, line1: tle.line1, line2: tle.line2, satrec });
  }
  return out;
}

/** Convert one OMM record to { name, noradId, line1, line2 } (TLE text). */
export function ommToTle(o) {
  if (o == null || o.NORAD_CAT_ID == null || o.MEAN_MOTION == null) return null;
  const name = (o.OBJECT_NAME || `NORAD ${o.NORAD_CAT_ID}`).trim();
  const noradId = String(o.NORAD_CAT_ID).trim();
  const satnum = noradId.padStart(5, '0').slice(-5);
  const cls = (o.CLASSIFICATION_TYPE || 'U').slice(0, 1);

  let l1 = '1 ' + satnum + cls + ' ' + intlDesig(o.OBJECT_ID) + ' ' + epochField(o.EPOCH) + ' ' +
    ndotField(o.MEAN_MOTION_DOT) + ' ' + expField(o.MEAN_MOTION_DDOT) + ' ' + expField(o.BSTAR) + ' ' +
    String(o.EPHEMERIS_TYPE ?? 0).slice(0, 1) + ' ' + String(o.ELEMENT_SET_NO ?? 999).padStart(4, ' ').slice(-4);
  l1 += checksum(l1);

  let l2 = '2 ' + satnum + ' ' + deg8(o.INCLINATION) + ' ' + deg8(o.RA_OF_ASC_NODE) + ' ' +
    eccField(o.ECCENTRICITY) + ' ' + deg8(o.ARG_OF_PERICENTER) + ' ' + deg8(o.MEAN_ANOMALY) + ' ' +
    mmField(o.MEAN_MOTION) + String(o.REV_AT_EPOCH ?? 0).padStart(5, ' ').slice(-5);
  l2 += checksum(l2);

  return { name, noradId, line1: l1, line2: l2 };
}

/* --------------------------- TLE field formatters --------------------------- */

// Cols 10-17: international designator "YYNNNPPP " from OBJECT_ID "1998-067A".
function intlDesig(objId) {
  if (!objId) return ' '.repeat(8);
  const m = String(objId).match(/^(\d{2})(\d{2})-(\d{3})([A-Z]{0,3})$/);
  if (!m) return String(objId).padEnd(8).slice(0, 8);
  return (m[2] + m[3] + (m[4] || '')).padEnd(8).slice(0, 8);
}

// Cols 19-32: epoch "YYDDD.DDDDDDDD". OMM EPOCH is UTC; force Z so JS doesn't read local time.
function epochField(iso) {
  const s = String(iso);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
  const year = d.getUTCFullYear();
  const yy = String(year % 100).padStart(2, '0');
  const doy = (d.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1; // Jan 1 00:00 UT = 1.0
  const [int, dec] = doy.toFixed(8).split('.');
  return yy + int.padStart(3, '0') + '.' + dec;
}

// Cols 34-43: first derivative of mean motion (ndot/2), " .NNNNNNNN" / "-.NNNNNNNN".
function ndotField(v) {
  v = +v || 0;
  return (v < 0 ? '-' : ' ') + '.' + Math.abs(v).toFixed(8).split('.')[1];
}

// Assumed-decimal exponent notation, 8 chars: sign + 5 mantissa digits + expsign + expdigit.
// e.g. 0.000012345 -> " 12345-4" (= 0.12345 × 10^-4). Used for nddot and BSTAR.
function expField(v) {
  v = +v || 0;
  if (v === 0) return ' 00000+0';
  const sign = v < 0 ? '-' : ' ';
  let m = Math.abs(v);
  let exp = 0;
  while (m >= 1) { m /= 10; exp += 1; }
  while (m < 0.1) { m *= 10; exp -= 1; }
  let mant = Math.round(m * 1e5);
  if (mant >= 1e5) { mant = Math.round(mant / 10); exp += 1; } // rounding carry
  return sign + String(mant).padStart(5, '0').slice(0, 5) + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).slice(-1);
}

// Cols 9-16 etc.: angle in degrees, "NNN.NNNN" right-justified in 8.
function deg8(v) {
  return (((+v % 360) + 360) % 360).toFixed(4).padStart(8, ' ');
}

// Cols 27-33: eccentricity as 7 assumed-decimal digits (0.0006703 -> "0006703").
function eccField(v) {
  return String(Math.round((+v || 0) * 1e7)).padStart(7, '0').slice(0, 7);
}

// Cols 53-63: mean motion (rev/day) "NN.NNNNNNNN" right-justified in 11.
function mmField(v) {
  return (+v).toFixed(8).padStart(11, ' ');
}

// TLE checksum: (sum of digits, with '-' counting 1) mod 10, over cols 1-68.
function checksum(line) {
  let sum = 0;
  for (const ch of line) {
    if (ch >= '0' && ch <= '9') sum += +ch;
    else if (ch === '-') sum += 1;
  }
  return String(sum % 10);
}
