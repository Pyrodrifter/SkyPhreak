import { landAt, bordersAt, onBasemapLoad, project } from '../core/geo.js';
import { store } from '../core/store.js';
import { palette } from '../core/themes.js';
import { bakeReliefMap } from './earthTexture.js';
import {
  subPoint,
  footprintRadiusDeg,
  destPoint,
  periodMinutes,
  subSolarPoint,
} from '../core/propagate.js';

const RAD = Math.PI / 180;

/**
 * High-resolution equirectangular world map on a canvas. Fully offline — vector
 * coastlines stay crisp at any zoom. Renders day/night terminator, ground
 * tracks, footprints, satellite markers and the ground station. Wheel zoom +
 * drag pan; click a satellite to select.
 */
export class Map2D {
  constructor(container) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map2d-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.scale = 1; // 1 = whole world fits width
    this.offsetX = 0;
    this.offsetY = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.frame = null;
    this.onSelect = null;
    this.relief = null; // baked shaded-relief base map (null → vector fallback)
    this.useRelief = true; // user toggle; shows relief when baked + enabled

    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);
    this._bindInput();

    // Bake the shaded-relief base once textures load, then redraw with it.
    bakeReliefMap().then((canvas) => {
      if (canvas) {
        this.relief = canvas;
        this.draw(this.frame);
      }
    });

    // A finer basemap level finished loading in the background — repaint with it.
    this._offBasemap = onBasemapLoad(() => this.draw(this.frame));
  }

  /**
   * Basemap resolution for the current zoom. The thresholds are where the coarser
   * set starts showing straight-line coastlines: 110m holds up across the whole
   * world, 50m to roughly 5x, 10m beyond. `mapDetail` pins it when the operator
   * wants to cap the memory cost (or force maximum detail).
   */
  _detailLevel() {
    const pref = store.get().mapDetail || 'auto';
    if (pref !== 'auto') return pref;
    return this.scale >= 5 ? '10m' : this.scale >= 2 ? '50m' : '110m';
  }

  _resize() {
    const r = this.container.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.draw(this.frame);
  }

  // Base projection uses a 2:1 world sized to fit the viewport width.
  get baseW() {
    return this.w * this.scale;
  }
  get baseH() {
    return this.baseW / 2;
  }

  _toScreen(lon, lat) {
    const [bx, by] = project(lon, lat, this.baseW, this.baseH);
    return [bx + this.offsetX, by + this.offsetY + (this.h - this.baseH) / 2];
  }

  _fromScreenLonLat(sx, sy) {
    const bx = sx - this.offsetX;
    const by = sy - this.offsetY - (this.h - this.baseH) / 2;
    const lon = (bx / this.baseW) * 360 - 180;
    const lat = 90 - (by / this.baseH) * 180;
    return { lon, lat };
  }

  _bindInput() {
    let dragging = false;
    let last = null;
    let moved = 0;

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const before = this._fromScreenLonLat(e.offsetX, e.offsetY);
      this.scale = Math.min(8, Math.max(1, this.scale * factor));
      // Keep cursor anchored to the same geo point.
      const [ax, ay] = this._toScreen(before.lon, before.lat);
      this.offsetX += e.offsetX - ax;
      this.offsetY += e.offsetY - ay;
      this._clamp();
      this.draw(this.frame);
    }, { passive: false });

    this.canvas.addEventListener('mousedown', (e) => {
      dragging = true;
      moved = 0;
      last = { x: e.offsetX, y: e.offsetY };
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      this.offsetX += x - last.x;
      this.offsetY += y - last.y;
      moved += Math.abs(x - last.x) + Math.abs(y - last.y);
      last = { x, y };
      this._clamp();
      this.draw(this.frame);
    });
    window.addEventListener('mouseup', () => {
      if (dragging && moved < 4) this._handleClick(last.x, last.y);
      dragging = false;
    });
  }

  _clamp() {
    const maxY = this.baseH * 0.5;
    this.offsetY = Math.max(-maxY, Math.min(maxY, this.offsetY));
  }

  _handleClick(sx, sy) {
    if (!this.frame) return;
    let best = null;
    let bestD = 18 * 18;
    for (const s of this.frame.sats) {
      const [x, y] = this._toScreen(s.sub.lon, s.sub.lat);
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best && this.onSelect) this.onSelect(best.id);
  }

  resetView() {
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.draw(this.frame);
  }

  // Pan so a given lon/lat sits at the viewport centre (for follow-satellite mode).
  // Sets the offsets only; the caller's next draw() renders them.
  centerOn(lon, lat) {
    const [bx, by] = project(lon, lat, this.baseW, this.baseH);
    this.offsetX = this.w / 2 - bx;
    this.offsetY = this.h / 2 - by - (this.h - this.baseH) / 2;
    this._clamp();
  }

  // 'relief' = shaded topographic base, 'vector' = the dark blue line map.
  setStyle(style) {
    this.useRelief = style !== 'vector';
    this.draw(this.frame);
  }

  draw(frame) {
    this.frame = frame;
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.w, this.h);

    ctx.fillStyle = palette().map.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    if (this.relief && this.useRelief) {
      this._drawRelief(ctx);
      this._drawGraticule(ctx);
    } else {
      this._drawGraticule(ctx);
      this._drawLand(ctx);
    }
    // Borders sit over either basemap — they read as political detail on the
    // relief image just as well as on the vector fill.
    if (store.get().showBorders) this._drawBorders(ctx);
    if (frame) {
      this._drawTerminator(ctx, frame.date);
      for (const s of frame.sats) this._drawFootprint(ctx, s);
      for (const s of frame.sats) this._drawTrack(ctx, s, frame.date);
      this._drawStation(ctx, frame.station);
      for (const s of frame.sats) this._drawSat(ctx, s);
      const mapShow = frame.mapShow || { moon: true, planets: true };
      if (frame.bodies) for (const b of frame.bodies) this._drawBody(ctx, b, mapShow);
      if (frame.moon && (mapShow.moon || frame.moon.selected)) this._drawMoon(ctx, frame.moon);
    }
    ctx.restore();
  }

  // Draw the baked shaded-relief texture as the base layer. It's equirectangular,
  // matching the map's plate-carrée projection, so it maps straight onto the world
  // rectangle; we draw three copies (−360/0/+360) so panning wraps seamlessly.
  _drawRelief(ctx) {
    const [tlx, tly] = this._toScreen(-180, 90); // top-left corner of the world
    const wpx = this.baseW;
    const hpx = this.baseH;
    ctx.imageSmoothingQuality = 'high';
    for (const off of [-1, 0, 1]) {
      const x = tlx + off * wpx;
      if (x + wpx < 0 || x > this.w) continue; // skip copies fully off-screen
      ctx.drawImage(this.relief, x, tly, wpx, hpx);
    }
  }

  _drawGraticule(ctx) {
    ctx.strokeStyle = palette().map.graticule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += 30) {
      const [x0, y0] = this._toScreen(lon, 85);
      const [x1, y1] = this._toScreen(lon, -85);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const [x0, y0] = this._toScreen(-180, lat);
      const [x1, y1] = this._toScreen(180, lat);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    ctx.strokeStyle = palette().map.equator;
    ctx.beginPath();
    const [ex0, ey0] = this._toScreen(-180, 0);
    const [ex1, ey1] = this._toScreen(180, 0);
    ctx.moveTo(ex0, ey0);
    ctx.lineTo(ex1, ey1);
    ctx.stroke();
  }

  /**
   * Trace a prepared ring (see core/geo.js) at a longitude offset, skipping it
   * entirely when its bbox falls outside the viewport. The cull is what makes the
   * 60k- and 409k-point sets affordable: at high zoom almost every ring is off
   * screen, and rejecting one costs four comparisons instead of a full path.
   */
  _traceRing(ctx, ring, off) {
    const [x0] = this._toScreen(ring.minLon + off, 0);
    const [x1] = this._toScreen(ring.maxLon + off, 0);
    if (x1 < 0 || x0 > this.w) return false;
    const [, yTop] = this._toScreen(0, ring.maxLat);
    const [, yBot] = this._toScreen(0, ring.minLat);
    if (yBot < 0 || yTop > this.h) return false;

    const pts = ring.pts;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = this._toScreen(pts[i][0] + off, pts[i][1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    return true;
  }

  _drawLand(ctx) {
    ctx.fillStyle = palette().map.land;
    ctx.strokeStyle = palette().map.landStroke;
    ctx.lineWidth = 0.8;
    const rings = landAt(this._detailLevel());
    // Drawn at -360/0/+360 so a polygon wrapped past the antimeridian still shows
    // on the correct side; the bbox cull discards the copies that miss the view.
    for (const ring of rings) {
      for (const off of [-360, 0, 360]) {
        if (!this._traceRing(ctx, ring, off)) continue;
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  /** Country borders — a separate, lighter stroke over the land fill. */
  _drawBorders(ctx) {
    const rings = bordersAt(this._detailLevel());
    if (!rings) return;
    ctx.strokeStyle = palette().map.border || palette().map.graticule;
    ctx.lineWidth = 0.6;
    for (const ring of rings) {
      for (const off of [-360, 0, 360]) {
        if (!this._traceRing(ctx, ring, off)) continue;
        ctx.stroke();
      }
    }
  }

  _drawTerminator(ctx, date) {
    const sun = subSolarPoint(date);
    const δ = sun.lat * RAD;
    if (Math.abs(δ) < 0.0001) return;
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 2) {
      const H = (lon - sun.lon) * RAD;
      const lat = Math.atan(-Math.cos(H) / Math.tan(δ)) / RAD;
      pts.push(this._toScreen(lon, lat));
    }
    const darkSouth = δ >= 0; // sun north -> south pole in darkness
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts) ctx.lineTo(p[0], p[1]);
    const [rx] = this._toScreen(180, 0);
    const [lx] = this._toScreen(-180, 0);
    if (darkSouth) {
      const [, by] = this._toScreen(0, -90);
      ctx.lineTo(rx, by);
      ctx.lineTo(lx, by);
    } else {
      const [, ty] = this._toScreen(0, 90);
      ctx.lineTo(rx, ty);
      ctx.lineTo(lx, ty);
    }
    ctx.closePath();
    ctx.fillStyle = palette().map.terminator;
    ctx.fill();
  }

  // Draw a lon/lat polyline, breaking the stroke across the ±180° seam.
  _strokePath(ctx, lonlat, style, width, dash = []) {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let prevLon = null;
    let started = false;
    for (const [lon, lat] of lonlat) {
      if (prevLon !== null && Math.abs(lon - prevLon) > 180) started = false;
      const [x, y] = this._toScreen(lon, lat);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
      prevLon = lon;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _drawTrack(ctx, s, date) {
    const periodMs = periodMinutes(s.satrec) * 60000;
    const steps = 120;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = new Date(date.getTime() - periodMs / 2 + (periodMs * i) / steps);
      const sp = subPoint(s.satrec, t);
      if (sp) pts.push([sp.lon, sp.lat]);
    }
    this._strokePath(ctx, pts, s.selected ? s.color : hexA(s.color, 0.5), s.selected ? 1.6 : 1, [4, 4]);
  }

  _drawFootprint(ctx, s) {
    const radDeg = footprintRadiusDeg(s.sub.altKm);
    const pts = [];
    let crosses = false;
    let prevLon = null;
    for (let b = 0; b <= 360; b += 4) {
      const p = destPoint(s.sub.lat, s.sub.lon, radDeg, b);
      if (prevLon !== null && Math.abs(p.lon - prevLon) > 180) crosses = true;
      pts.push([p.lon, p.lat]);
      prevLon = p.lon;
    }
    // Fill only the selected footprint, and only when it doesn't wrap the ±180°
    // seam — a wrapped fill would smear a stray band across the whole map.
    if (s.selected && !crosses) {
      ctx.save();
      ctx.fillStyle = hexA(s.color, 0.1);
      ctx.beginPath();
      let started = false;
      for (const [lon, lat] of pts) {
        const [x, y] = this._toScreen(lon, lat);
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        started = true;
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // Outline is always safe — _strokePath breaks the line at the seam.
    this._strokePath(ctx, pts, hexA(s.color, s.selected ? 0.75 : 0.4), 1);
  }

  // Sub-point of a sky body (Sun / planet / deep-sky object).
  _drawBody(ctx, b, mapShow) {
    // Sun/planets obey the "Planets on map" toggle; the selected target always shows.
    if (b.kind !== 'dso' && mapShow && !mapShow.planets && !b.selected) return;
    const [x, y] = this._toScreen(b.sub.lon, b.sub.lat);
    const r = b.selected ? 5 : 3.5;
    if (b.selected) {
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 10;
    }
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.font = `${b.selected ? '600 ' : ''}11px ui-sans-serif, system-ui`;
    const tw = ctx.measureText(b.name).width;
    ctx.fillStyle = palette().map.labelBg;
    ctx.fillRect(x + 7, y - 8, tw + 6, 15);
    ctx.fillStyle = b.selected ? '#fff' : palette().map.labelText;
    ctx.fillText(b.name, x + 10, y + 4);
  }

  // Sub-lunar point: where the Moon is at the zenith.
  _drawMoon(ctx, moon) {
    const [x, y] = this._toScreen(moon.sub.lon, moon.sub.lat);
    const R = 7;
    ctx.save();
    ctx.shadowColor = 'rgba(230,235,245,0.9)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#e6eaf2';
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();
    // Crescent hint: clip to the disc, then carve the shadow side by the
    // illuminated fraction so nothing draws outside the Moon.
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = palette().map.moonShadow;
    ctx.beginPath();
    ctx.arc(x - moon.illum * 2 * R, y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.font = '11px ui-sans-serif, system-ui';
    const tw = ctx.measureText('Moon').width;
    ctx.fillStyle = palette().map.labelBg;
    ctx.fillRect(x + 9, y - 8, tw + 8, 16);
    ctx.fillStyle = 'rgba(230,235,245,0.9)';
    ctx.fillText('Moon', x + 13, y + 4);
  }

  _drawStation(ctx, st) {
    if (!st) return;
    const [x, y] = this._toScreen(st.lon, st.lat);
    ctx.fillStyle = '#ffd23f';
    ctx.strokeStyle = '#1a1200';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 7);
    ctx.lineTo(x + 6, y + 5);
    ctx.lineTo(x - 6, y + 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  _drawSat(ctx, s) {
    const [x, y] = this._toScreen(s.sub.lon, s.sub.lat);
    const r = s.selected ? 6 : 4;
    if (s.selected) {
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 12;
    }
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = `${s.selected ? '600 12px' : '11px'} ui-sans-serif, system-ui`;
    const label = s.name;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = palette().map.labelBg;
    ctx.fillRect(x + 8, y - 9, tw + 8, 16);
    ctx.fillStyle = s.selected ? '#fff' : palette().map.labelText;
    ctx.fillText(label, x + 12, y + 3);
  }
}


function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}
