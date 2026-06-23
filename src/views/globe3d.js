import Globe from 'globe.gl';
import * as THREE from 'three';
import { landPolygons } from '../core/geo.js';
import { TEX, loadImage } from './earthTexture.js';
import { subPoint, periodMinutes, EARTH_R, subSolarPoint, footprintRadiusDeg, destPoint } from '../core/propagate.js';

/**
 * Interactive 3D globe (globe.gl / three.js). Vector land polygons on a dark
 * sphere keep the look consistent with the 2D map and free of raster clutter.
 * Satellites are glowing markers at true altitude; the selected satellite shows
 * its orbit path. The ground station is a marker on the surface.
 */
export class Globe3D {
  constructor(container) {
    this.container = container;
    this.el = document.createElement('div');
    this.el.className = 'globe3d-host';
    container.appendChild(this.el);
    this.frame = null;
    this.onSelect = null;

    const g = Globe({ rendererConfig: { antialias: true } })(this.el)
      .backgroundColor('rgba(0,0,0,0)')
      .showGlobe(true)
      .showAtmosphere(true)
      .atmosphereColor('#4a9fd4')
      .atmosphereAltitude(0.18)
      .polygonsData(landPolygons)
      .polygonCapColor(() => 'rgba(36,90,130,0.9)')
      .polygonSideColor(() => 'rgba(20,50,75,0.4)')
      .polygonStrokeColor(() => 'rgba(120,190,230,0.6)')
      .polygonAltitude(0.006)
      .objectLat((d) => d.sub.lat)
      .objectLng((d) => d.sub.lon)
      .objectAltitude((d) => d.sub.altKm / EARTH_R)
      .objectThreeObject((d) => this._satObject(d))
      .objectLabel((d) => `<div class="globe-tip">${d.name}</div>`)
      .onObjectClick((d) => d?.id && this.onSelect && this.onSelect(d.id))
      .pointsData([])
      .pointLat('lat')
      .pointLng('lon')
      .pointColor(() => '#ffd23f')
      .pointAltitude(0)
      .pointRadius(0.35)
      .pathPointLat((p) => p[0])
      .pathPointLng((p) => p[1])
      .pathPointAlt((p) => p[2])
      .pathColor((p) => p.color || 'rgba(120,200,255,0.8)')
      .pathStroke(2)
      // Solid, static line — no dash animation, no per-update redraw "pulse".
      .pathDashLength(1)
      .pathDashGap(0)
      .pathDashAnimateTime(0)
      .pathTransitionDuration(0)
      .pathsData([]);

    const mat = g.globeMaterial();
    mat.color = new THREE.Color('#0a1626');
    mat.emissive = new THREE.Color('#06101c');
    mat.shininess = 6;

    const controls = g.controls();
    controls.autoRotate = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;

    // Moon at true scale and distance. globe.gl's globe radius is 100 scene
    // units = one Earth radius, so the Moon sphere and its distance use the same
    // ratio to Earth as in reality (~0.27 R and ~60 R).
    this.MOON_R = (1737.4 / EARTH_R) * 100;
    this.moonGroup = new THREE.Group();
    this.moonGroup.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(this.MOON_R, 32, 32),
        new THREE.MeshPhongMaterial({ color: '#b9bdc7', emissive: '#23262e', shininess: 3 })
      )
    );
    const moonLabel = makeTextSprite('Moon');
    moonLabel.position.set(0, this.MOON_R + 40, 0);
    this.moonGroup.add(moonLabel);
    this.moonGroup.visible = false;
    g.scene().add(this.moonGroup);

    // Let the user zoom out far enough to see the Moon at true distance.
    const cam = g.camera();
    cam.far = 250000;
    cam.updateProjectionMatrix();
    controls.maxDistance = 80000;

    this.g = g;
    this.sunLight = null;
    this.useSun = false;
    this.style = 'relief';
    this.texturesReady = false;
    // Captured so we can restore even lighting when switching back to vector.
    this.defaultLights = typeof g.lights === 'function' ? g.lights() : null;
    this._loadTextures();
    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);
  }

  // Load the Earth textures once, then apply whichever style is active.
  async _loadTextures() {
    const [day, water] = await Promise.all([loadImage(TEX.day), loadImage(TEX.water)]);
    if (!day) return; // textures unavailable → stay on the vector globe
    this.waterTex = water ? new THREE.TextureLoader().load(TEX.water) : null;
    this.texturesReady = true;
    this._applyStyle(this.style);
  }

  // Public toggle: 'relief' = shaded topographic globe, 'vector' = dark blue lines.
  setStyle(style) {
    this.style = style;
    this._applyStyle(style);
  }

  // Apply a style to the globe material, land layer and lighting. Relief adds a
  // directional "sun" light (aimed at the sub-solar point each frame in draw) for
  // a real day/night terminator; vector restores the original even lighting.
  _applyStyle(style) {
    const g = this.g;
    const mat = g.globeMaterial();
    if (style === 'relief' && this.texturesReady) {
      g.globeImageUrl(TEX.day).bumpImageUrl(TEX.topology);
      g.polygonsData([]); // texture replaces the vector land
      mat.color = new THREE.Color('#c4cace'); // mute the daymap to match the UI
      mat.emissive = new THREE.Color('#0a1420');
      mat.bumpScale = 6;
      if (this.waterTex) {
        mat.specularMap = this.waterTex;
        mat.specular = new THREE.Color('#21303f'); // subtle ocean sheen
        mat.shininess = 12;
      }
      mat.needsUpdate = true;
      if (typeof g.lights === 'function') {
        if (!this.sunLight) this.sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
        g.lights([new THREE.AmbientLight(0xffffff, 0.22), this.sunLight]);
      }
      this.useSun = true;
    } else {
      // Vector: dark sphere + line coastlines, original flat lighting.
      g.globeImageUrl(null).bumpImageUrl(null);
      g.polygonsData(landPolygons);
      mat.map = null;
      mat.bumpMap = null;
      mat.specularMap = null;
      mat.bumpScale = 0;
      mat.color = new THREE.Color('#0a1626');
      mat.emissive = new THREE.Color('#06101c');
      mat.shininess = 6;
      mat.needsUpdate = true;
      if (this.defaultLights && typeof g.lights === 'function') g.lights(this.defaultLights);
      this.useSun = false;
    }
  }

  _resize() {
    const r = this.container.getBoundingClientRect();
    this.g.width(Math.max(1, r.width)).height(Math.max(1, r.height));
  }

  _satObject(d) {
    const group = new THREE.Group();
    const r = d.selected ? 5 : 3.5;
    const color = new THREE.Color(d.color);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(r, 16, 16),
      new THREE.MeshBasicMaterial({ color })
    );
    group.add(mesh);
    // Soft glow halo so satellites read clearly against the globe.
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(r * 1.9, 16, 16),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: d.selected ? 0.28 : 0.16 })
    );
    group.add(halo);
    return group;
  }

  draw(frame) {
    this.frame = frame;
    if (!frame) return;

    // Aim the sun light at the sub-solar point so the lit side tracks real time.
    if (this.sunLight && this.useSun) {
      const sun = subSolarPoint(frame.date);
      const c = this.g.getCoords(sun.lat, sun.lon, 1.5);
      this.sunLight.position.set(c.x, c.y, c.z);
    }

    this.g.objectsData(frame.sats);

    // Ground station marker.
    this.g.pointsData(frame.station ? [{ lat: frame.station.lat, lon: frame.station.lon }] : []);

    // Orbit path + ground footprint for the selected satellite.
    const sel = frame.sats.find((s) => s.selected);
    if (sel) {
      const paths = [];

      const periodMs = periodMinutes(sel.satrec) * 60000;
      const steps = 160;
      const orbit = [];
      for (let i = 0; i <= steps; i++) {
        const t = new Date(frame.date.getTime() - periodMs / 2 + (periodMs * i) / steps);
        const sp = subPoint(sel.satrec, t);
        if (sp) orbit.push([sp.lat, sp.lon, sp.altKm / EARTH_R]);
      }
      orbit.color = sel.color;
      paths.push(orbit);

      // Footprint: the circle of Earth the satellite can see, drawn as a ring on
      // the surface — the 3D analogue of the 2D map's area-of-view outline.
      const radDeg = footprintRadiusDeg(sel.sub.altKm);
      // Sit just above the extruded vector land cap (polygonAltitude 0.006) so the
      // ring is never occluded by raised land in vector mode.
      const ringAlt = 0.008;
      const ring = [];
      for (let b = 0; b <= 360; b += 4) {
        const p = destPoint(sel.sub.lat, sel.sub.lon, radDeg, b);
        ring.push([p.lat, p.lon, ringAlt]);
      }
      ring.color = hexA(sel.color, 0.7);
      paths.push(ring);

      this.g.pathsData(paths);
    } else {
      this.g.pathsData([]);
    }

    // Moon at its true sub-point direction, scale and distance.
    if (frame.moon) {
      const alt = frame.moon.distanceKm / EARTH_R - 1; // Earth radii above surface
      const c = this.g.getCoords(frame.moon.sub.lat, frame.moon.sub.lon, alt);
      this.moonGroup.position.set(c.x, c.y, c.z);
      this.moonGroup.visible = true;
    } else {
      this.moonGroup.visible = false;
    }
  }

  // Point the camera at the selected satellite's sub-point.
  focus(lat, lon) {
    this.g.pointOfView({ lat, lng: lon, altitude: 2.2 }, 800);
  }

  dispose() {
    this._ro?.disconnect();
  }
}

// Hex colour → rgba string with the given alpha (for the translucent footprint).
function hexA(hex, a) {
  const s = hex.replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// A small always-facing text label rendered as a three.js sprite.
function makeTextSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = '600 40px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e6eaf2';
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(140, 35, 1);
  return sprite;
}
