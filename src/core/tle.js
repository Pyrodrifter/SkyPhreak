import { makeSatrec } from './propagate.js';
import { parseOmm } from './omm.js';
import { parseOem } from './oem.js';

/**
 * Parse a satellite catalog, auto-detecting the format: CCSDS OEM (tabulated
 * ephemeris, KVN or XML), OMM (JSON, starts with [ or {), or classic TLE text.
 * All yield the same entry shape { name, noradId, line1, line2, satrec } — for
 * OEM the satrec is an Ephemeris, but propagate.js handles both — so callers
 * don't care which it was.
 */
export function parseCatalog(text) {
  const t = (text || '').trimStart();
  if (t.startsWith('CCSDS_OEM_VERS') || /^<(\?xml|oem|ndm)/i.test(t)) return parseOem(text);
  return t.startsWith('[') || t.startsWith('{') ? parseOmm(text) : parseTle(text);
}

/**
 * Parse a Celestrak/NORAD 2- or 3-line TLE blob into satellite descriptors.
 * Each entry: { name, noradId, line1, line2, satrec }.
 */
export function parseTle(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.length > 0);

  const sats = [];
  let i = 0;
  while (i < lines.length) {
    let name, l1, l2;
    if (lines[i].startsWith('1 ') && lines[i + 1]?.startsWith('2 ')) {
      // Bare 2-line set, no name line.
      l1 = lines[i];
      l2 = lines[i + 1];
      name = `NORAD ${l1.slice(2, 7).trim()}`;
      i += 2;
    } else if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      name = lines[i].replace(/^0\s+/, '').trim();
      l1 = lines[i + 1];
      l2 = lines[i + 2];
      i += 3;
    } else {
      i += 1;
      continue;
    }

    const satrec = makeSatrec(l1, l2);
    if (!satrec) continue;
    const noradId = l1.slice(2, 7).trim();
    sats.push({ name, noradId, line1: l1, line2: l2, satrec });
  }
  return sats;
}
