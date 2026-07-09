import { palette } from '../core/themes.js';

/**
 * Polar (radar) sky view: azimuth around the circle, elevation as radius
 * (90° at centre, horizon at edge). Shows every tracked satellite currently
 * above the horizon plus the selected satellite's marker emphasised.
 */
export class PolarView {
  constructor(container) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'polar-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.frame = null;
    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);
  }

  _resize() {
    const r = this.container.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.draw(this.frame);
  }

  _pos(az, el, cx, cy, R) {
    const rr = (1 - Math.max(0, el) / 90) * R;
    const a = (az - 90) * (Math.PI / 180);
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
  }

  draw(frame) {
    this.frame = frame;
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.w, this.h);

    const cx = this.w / 2;
    const cy = this.h / 2;
    const R = Math.min(this.w, this.h) / 2 - 16;
    if (R <= 0) { ctx.restore(); return; } // not yet sized (detached/hidden)

    // Elevation rings (0/30/60° + horizon).
    ctx.strokeStyle = palette().polar.grid;
    ctx.fillStyle = palette().polar.ticks;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-sans-serif, system-ui';
    for (const el of [0, 30, 60]) {
      const rr = (1 - el / 90) * R;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();
      if (el > 0) ctx.fillText(`${el}°`, cx + 2, cy - rr + 11);
    }

    // Azimuth spokes + N/E/S/W.
    ctx.strokeStyle = palette().polar.gridDim;
    for (let az = 0; az < 360; az += 30) {
      const [x, y] = this._pos(az, 0, cx, cy, R);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.fillStyle = palette().polar.labels;
    ctx.font = '600 12px ui-sans-serif, system-ui';
    const cards = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
    for (const [lbl, az] of cards) {
      const [x, y] = this._pos(az, 0, cx, cy, R + 0);
      ctx.fillText(lbl, x - 4, y + (az === 0 ? -4 : az === 180 ? 12 : 4));
    }

    if (!frame) {
      ctx.restore();
      return;
    }

    // Selected satellite's full pass arc (above horizon) as a faint trail.
    const sel = frame.sats.find((s) => s.selected);
    if (sel && sel.arc && sel.arc.length) {
      ctx.strokeStyle = hexA(sel.color, 0.5);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const p of sel.arc) {
        const [x, y] = this._pos(p.az, p.el, cx, cy, R);
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        started = true;
      }
      ctx.stroke();
    }

    // Flip-over preview: the selected pass's mount path when it goes "over the top"
    // (elevation past 90° → the point crosses the zenith to the far side). Drawn as a
    // dashed amber trail with a corner badge so a high pass's flip is obvious ahead of time.
    if (frame.flip && frame.flip.arc && frame.flip.arc.length) {
      ctx.save();
      ctx.strokeStyle = '#ffb454';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      let started = false;
      for (const p of frame.flip.arc) {
        const [x, y] = this._pos(p.az, Math.min(180, p.el), cx, cy, R);
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        started = true;
      }
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#ffb454';
      ctx.font = '600 10px ui-sans-serif, system-ui';
      ctx.fillText('⟳ FLIP-OVER', 6, 12);
    }

    // Markers for sats above the horizon.
    for (const s of frame.sats) {
      if (!s.look || s.look.el < 0) continue;
      const [x, y] = this._pos(s.look.az, s.look.el, cx, cy, R);
      const rad = s.selected ? 6 : 4;
      if (s.selected) {
        ctx.shadowColor = s.color;
        ctx.shadowBlur = 10;
      }
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (s.selected) {
        ctx.fillStyle = '#fff';
        ctx.font = '600 11px ui-sans-serif, system-ui';
        ctx.fillText(s.name, x + 8, y + 3);
      }
    }

    // Sky bodies (Sun, planets, selected DSO) above the horizon.
    if (frame.bodies) {
      for (const b of frame.bodies) {
        if (!b.look || b.look.el < 0) continue;
        const [x, y] = this._pos(b.look.az, b.look.el, cx, cy, R);
        const rad = b.selected ? 6 : 4;
        if (b.selected) { ctx.shadowColor = b.color; ctx.shadowBlur = 10; }
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = b.selected ? '#fff' : 'rgba(220,230,245,0.8)';
        ctx.font = `${b.selected ? '600 ' : ''}11px ui-sans-serif, system-ui`;
        ctx.fillText(b.name, x + 8, y + 3);
      }
    }

    // The Moon, when above the horizon.
    const moon = frame.moon;
    if (moon && moon.look && moon.look.el >= 0) {
      const [x, y] = this._pos(moon.look.az, moon.look.el, cx, cy, R);
      const rad = moon.selected ? 6 : 5;
      if (moon.selected) {
        ctx.shadowColor = 'rgba(230,235,245,0.9)';
        ctx.shadowBlur = 10;
      }
      ctx.fillStyle = '#e6eaf2';
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = moon.selected ? '#fff' : 'rgba(230,235,245,0.85)';
      ctx.font = `${moon.selected ? '600 ' : ''}11px ui-sans-serif, system-ui`;
      ctx.fillText('Moon', x + 8, y + 3);
    }
    ctx.restore();
  }
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
