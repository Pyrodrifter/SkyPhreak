import landTopo from 'world-atlas/land-110m.json';
import { feature } from 'topojson-client';

// Land outlines only (no country borders) — vector data renders crisp at any
// zoom and keeps the map uncluttered. objects.land is a GeometryCollection, so
// feature() yields a FeatureCollection of Polygon/MultiPolygon features.
const landFC = feature(landTopo, landTopo.objects.land);
const landFeatures = landFC.type === 'FeatureCollection' ? landFC.features : [landFC];

// Flatten every feature's geometry into a list of polygons (each = array of rings).
const allPolygons = [];
for (const f of landFeatures) {
  const g = f.geometry;
  if (!g) continue;
  if (g.type === 'MultiPolygon') for (const poly of g.coordinates) allPolygons.push(poly);
  else if (g.type === 'Polygon') allPolygons.push(g.coordinates);
}

/** Array of rings, each an array of [lon, lat] points. */
export const landRings = (() => {
  const rings = [];
  for (const poly of allPolygons) for (const ring of poly) rings.push(ring);
  return rings;
})();

/** GeoJSON polygon features for the 3D globe (globe.gl polygonsData). */
export const landPolygons = allPolygons.map((coords) => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: coords },
  properties: {},
}));

/** Equirectangular projection -> pixel coords for a given canvas size. */
export function project(lon, lat, w, h) {
  return [((lon + 180) / 360) * w, ((90 - lat) / 180) * h];
}
