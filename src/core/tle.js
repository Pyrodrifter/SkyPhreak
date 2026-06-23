import { makeSatrec } from './propagate.js';

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
