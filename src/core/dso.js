/**
 * Curated deep-sky catalog (J2000 RA/Dec in degrees). Mostly nebulae, plus a
 * few famous objects. Coordinates are precessed to date before pointing.
 */
export const DSOS = [
  { id: 'M42', name: 'Orion Nebula', ra: 83.822, dec: -5.391, type: 'Emission nebula', mag: 4.0 },
  { id: 'M43', name: 'De Mairan’s Nebula', ra: 83.88, dec: -5.27, type: 'Emission nebula', mag: 9.0 },
  { id: 'M8', name: 'Lagoon Nebula', ra: 270.92, dec: -24.38, type: 'Emission nebula', mag: 6.0 },
  { id: 'M20', name: 'Trifid Nebula', ra: 270.6, dec: -23.03, type: 'Emission nebula', mag: 6.3 },
  { id: 'M16', name: 'Eagle Nebula', ra: 274.7, dec: -13.78, type: 'Emission nebula', mag: 6.0 },
  { id: 'M17', name: 'Omega Nebula', ra: 275.2, dec: -16.17, type: 'Emission nebula', mag: 6.0 },
  { id: 'M57', name: 'Ring Nebula', ra: 283.396, dec: 33.029, type: 'Planetary nebula', mag: 8.8 },
  { id: 'M27', name: 'Dumbbell Nebula', ra: 299.901, dec: 22.721, type: 'Planetary nebula', mag: 7.4 },
  { id: 'M97', name: 'Owl Nebula', ra: 168.699, dec: 55.019, type: 'Planetary nebula', mag: 9.9 },
  { id: 'M1', name: 'Crab Nebula', ra: 83.633, dec: 22.014, type: 'Supernova remnant', mag: 8.4 },
  { id: 'NGC7000', name: 'North America Nebula', ra: 314.75, dec: 44.52, type: 'Emission nebula', mag: 4.0 },
  { id: 'NGC2244', name: 'Rosette Nebula', ra: 97.98, dec: 4.95, type: 'Emission nebula', mag: 4.8 },
  { id: 'M45', name: 'Pleiades', ra: 56.75, dec: 24.117, type: 'Open cluster', mag: 1.6 },
  { id: 'M31', name: 'Andromeda Galaxy', ra: 10.685, dec: 41.269, type: 'Galaxy', mag: 3.4 },
  { id: 'M13', name: 'Hercules Cluster', ra: 250.423, dec: 36.461, type: 'Globular cluster', mag: 5.8 },
];

export const dsoById = new Map(DSOS.map((d) => [d.id, d]));

/**
 * Approximate precession of J2000 coordinates to the given date (good to a few
 * arc-minutes over decades — adequate for pointing). Returns { ra, dec } in deg.
 */
export function precessToDate(raDeg, decDeg, date) {
  const years = (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 365.25;
  const RAD = Math.PI / 180;
  // Annual general precession (Meeus low-precision).
  const dRaSec = 3.07496 + 1.33621 * Math.sin(raDeg * RAD) * Math.tan(decDeg * RAD); // sec of time / yr
  const dDecArc = 20.0431 * Math.cos(raDeg * RAD); // arcsec / yr
  return {
    ra: raDeg + (dRaSec * 15 / 3600) * years,
    dec: decDeg + (dDecArc / 3600) * years,
  };
}
