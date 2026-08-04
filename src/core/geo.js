/**
 * Basemap vector data — Natural Earth via `world-atlas`, at three resolutions.
 *
 * Detail follows zoom. The whole-world view only needs 1:110m (5k points); by 8x
 * zoom one screen pixel is roughly 3 km while 110m has vertices every ~100 km, so
 * coastlines visibly go polygonal. 1:50m and 1:10m are loaded on demand through
 * dynamic import(), which keeps them out of the initial bundle — the app still
 * boots with only the 54 KB 110m set and stays fully offline once cached.
 *
 *   110m   54 KB      5,123 pts   bundled, whole-world view
 *    50m  533 KB     60,629 pts   lazy, from ~2x zoom
 *    10m  3.0 MB    408,953 pts   lazy, from ~5x zoom
 *
 * Rings are prepared once at load: longitudes unwrapped (so dateline-crossing
 * polygons stay continuous) and a lon/lat bbox attached for cheap off-screen
 * culling. Doing that per frame is what makes high-resolution data expensive.
 */

import landTopo110 from 'world-atlas/land-110m.json';
import { feature } from 'topojson-client';

export const DETAIL_LEVELS = ['110m', '50m', '10m'];

// Dynamic specifiers are written out in full so the bundler can find and split them.
const LAND_LOADERS = {
  '50m': () => import('world-atlas/land-50m.json'),
  '10m': () => import('world-atlas/land-10m.json'),
};
const BORDER_LOADERS = {
  '110m': () => import('world-atlas/countries-110m.json'),
  '50m': () => import('world-atlas/countries-50m.json'),
  '10m': () => import('world-atlas/countries-10m.json'),
};

/**
 * Unwrap a ring's longitudes into a continuous run, so a polygon that crosses the
 * antimeridian doesn't smear a band across the map. Values may fall outside
 * ±180; the renderer draws the ring at -360/0/+360 and culls what's off-screen.
 */
function unwrap(ring) {
  const out = [[ring[0][0], ring[0][1]]];
  let prevRaw = ring[0][0];
  let cont = ring[0][0];
  for (let i = 1; i < ring.length; i++) {
    const raw = ring[i][0];
    let d = raw - prevRaw;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    cont += d;
    out.push([cont, ring[i][1]]);
    prevRaw = raw;
  }
  return out;
}

/** Prepared ring: unwrapped points plus the bbox the renderer culls against. */
function prepare(coords) {
  const pts = unwrap(coords);
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of pts) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { pts, minLon, maxLon, minLat, maxLat };
}

/** Flatten a TopoJSON object into prepared rings. */
function ringsFrom(topo, key) {
  const fc = feature(topo, topo.objects[key]);
  const feats = fc.type === 'FeatureCollection' ? fc.features : [fc];
  const out = [];
  for (const f of feats) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
    for (const poly of polys) for (const ring of poly) out.push(prepare(ring));
  }
  return out;
}

/** Raw GeoJSON polygons, for the 3D globe (see the note on landPolygons below). */
function polygonsFrom(topo, key) {
  const fc = feature(topo, topo.objects[key]);
  const feats = fc.type === 'FeatureCollection' ? fc.features : [fc];
  const out = [];
  for (const f of feats) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
    for (const poly of polys) out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: {} });
  }
  return out;
}

const landCache = { '110m': ringsFrom(landTopo110, 'land') };
const borderCache = {};
const pending = new Set();
const listeners = new Set();

const notify = () => { for (const fn of listeners) fn(); };

/** Called when a lazily-loaded level arrives, so views can redraw with it. */
export function onBasemapLoad(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function request(kind, level, loaders, cache, objectKey) {
  const tag = kind + ':' + level;
  if (cache[level] || pending.has(tag) || !loaders[level]) return;
  pending.add(tag);
  loaders[level]()
    .then((mod) => {
      const topo = mod.default || mod;
      cache[level] = ringsFrom(topo, objectKey);
      notify();
    })
    .catch((err) => console.warn(`basemap ${tag} unavailable`, err))
    .finally(() => pending.delete(tag));
}

/**
 * Best land rings available at or below `level`, kicking off a load for `level` if
 * it isn't cached yet. Always returns something drawable — the caller never waits.
 */
export function landAt(level) {
  if (level !== '110m') request('land', level, LAND_LOADERS, landCache, 'land');
  return landCache[level]
    || (level === '10m' && landCache['50m'])
    || landCache['110m'];
}

/** Country borders at `level`, or null until the first load completes. */
export function bordersAt(level) {
  request('border', level, BORDER_LOADERS, borderCache, 'countries');
  return borderCache[level] || borderCache['50m'] || borderCache['110m'] || null;
}

/**
 * Land polygons for globe.gl. Deliberately pinned to 110m: the canvas map strokes
 * a path, but the globe extrudes real geometry per polygon, so 110m's 125 polygons
 * become 4,061 at 10m and the GPU cost is not worth detail you can't see on a
 * sphere at that size.
 */
export const landPolygons = polygonsFrom(landTopo110, 'land');

/** Equirectangular projection -> pixel coords for a given canvas size. */
export function project(lon, lat, w, h) {
  return [((lon + 180) / 360) * w, ((90 - lat) / 180) * h];
}
