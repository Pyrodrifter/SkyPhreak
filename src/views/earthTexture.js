/**
 * Earth texture loading + shaded-relief baking. Fully offline: the images live in
 * public/textures/ (populated by `npm run fetch-textures`). Everything degrades
 * gracefully — if the files aren't present, loaders resolve null and the views
 * fall back to their vector rendering.
 */

// Paths are relative (no leading slash) so they resolve under both the dev server
// and Electron's file:// production load.
export const TEX = {
  day: 'textures/earth-day.jpg',
  topology: 'textures/earth-topology.png',
  water: 'textures/earth-water.png',
};

// Load an image, resolving null on any failure instead of rejecting.
export function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

const clamp255 = (x) => (x < 0 ? 0 : x > 255 ? 255 : x);

/**
 * Bake a muted shaded-relief base map for the 2D canvas: a hillshade derived from
 * the topology elevation map is multiplied onto the natural-colour day map, then
 * lightly desaturated and cooled to sit calmly under the dark UI. Returns an
 * offscreen canvas (equirectangular, lon -180..180 / lat 90..-90), or null.
 */
export async function bakeReliefMap() {
  const [day, topo] = await Promise.all([loadImage(TEX.day), loadImage(TEX.topology)]);
  if (!day) return null;

  const w = day.naturalWidth;
  const h = day.naturalHeight;
  const base = document.createElement('canvas');
  base.width = w;
  base.height = h;
  const bctx = base.getContext('2d', { willReadFrequently: true });
  bctx.drawImage(day, 0, 0, w, h);
  const out = bctx.getImageData(0, 0, w, h);
  const px = out.data;

  if (topo) {
    const tc = document.createElement('canvas');
    tc.width = w;
    tc.height = h;
    const tctx = tc.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(topo, 0, 0, w, h);
    const elev = tctx.getImageData(0, 0, w, h).data;
    const E = (x, y) => {
      x = ((x % w) + w) % w; // wrap longitude
      if (y < 0) y = 0;
      else if (y >= h) y = h - 1;
      return elev[(y * w + x) * 4]; // red channel ≈ elevation
    };
    // Light from the north-west, raised — the classic cartographic relief angle.
    const lx = -1, ly = -1, lz = 2.2;
    const ll = Math.hypot(lx, ly, lz);
    const lnx = lx / ll, lny = ly / ll, lnz = lz / ll;
    const exag = 1.7; // vertical exaggeration of the slope
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dzdx = ((E(x + 1, y) - E(x - 1, y)) / 255) * exag;
        const dzdy = ((E(x, y + 1) - E(x, y - 1)) / 255) * exag;
        const nx = -dzdx, ny = -dzdy, nz = 1;
        const nl = Math.hypot(nx, ny, nz);
        let shade = (nx * lnx + ny * lny + nz * lnz) / nl; // -1..1
        shade = 0.7 + 0.55 * shade; // lift to a usable multiplier range
        if (shade < 0.25) shade = 0.25;
        const i = (y * w + x) * 4;
        px[i] = clamp255(px[i] * shade);
        px[i + 1] = clamp255(px[i + 1] * shade);
        px[i + 2] = clamp255(px[i + 2] * shade);
      }
    }
  }

  // Muted tint: pull slightly toward grey + a cool cast so it matches the UI.
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const grey = r * 0.3 + g * 0.59 + b * 0.11;
    const keep = 0.8; // retain 80% of original saturation
    px[i] = clamp255((r * keep + grey * (1 - keep)) * 0.92);
    px[i + 1] = clamp255((g * keep + grey * (1 - keep)) * 0.95);
    px[i + 2] = clamp255((b * keep + grey * (1 - keep)) * 1.0 + 6);
  }

  bctx.putImageData(out, 0, 0);
  return base;
}
