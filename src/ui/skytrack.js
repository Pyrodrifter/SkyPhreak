/**
 * Sky-track thumbnail: a pass's az/el arc on a polar grid, north up, horizon at
 * the rim, zenith at the centre. Used at 46px in list rows and ~116px in the lead
 * block, so everything scales off `size`.
 *
 * Grid colours are read from the live CSS custom properties rather than hard-coded,
 * so the thumbnails re-tint with the theme on their next repaint (they are redrawn
 * every second anyway).
 */

export function drawSkyTrack(canvas, arc, color, size = 46) {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== size * dpr) {
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const css = getComputedStyle(document.documentElement);
  const line = (css.getPropertyValue('--line-hard') || '#2a3646').trim();
  const soft = (css.getPropertyValue('--line') || '#1b2431').trim();
  const dim = (css.getPropertyValue('--fg-mute') || '#56626f').trim();

  const c = size / 2;
  const R = c - (size > 80 ? 9 : 3);
  const pos = (az, el) => {
    const r = (1 - Math.max(0, Math.min(90, el)) / 90) * R;
    const a = (az - 90) * (Math.PI / 180);
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };

  // Horizon, then the 30/60° rings.
  ctx.lineWidth = 1;
  ctx.strokeStyle = line;
  ctx.beginPath();
  ctx.arc(c, c, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = soft;
  for (const el of [30, 60]) {
    ctx.beginPath();
    ctx.arc(c, c, (1 - el / 90) * R, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Cardinal cross.
  ctx.beginPath();
  ctx.moveTo(c, c - R); ctx.lineTo(c, c + R);
  ctx.moveTo(c - R, c); ctx.lineTo(c + R, c);
  ctx.stroke();

  if (arc && arc.length > 1) {
    ctx.strokeStyle = color;
    ctx.lineWidth = size > 80 ? 1.8 : 1.4;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    arc.forEach((p, i) => { const [x, y] = pos(p.az, p.el); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    // Square end caps: filled = AOS (rise), hollow = LOS (set).
    const r = size > 80 ? 3 : 2.2;
    const [ax, ay] = pos(arc[0].az, arc[0].el);
    const [lx, ly] = pos(arc[arc.length - 1].az, arc[arc.length - 1].el);
    ctx.fillStyle = color;
    ctx.fillRect(ax - r, ay - r, r * 2, r * 2);
    ctx.clearRect(lx - r, ly - r, r * 2, r * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(lx - r, ly - r, r * 2, r * 2);
  }

  if (size > 80) {
    ctx.fillStyle = dim;
    ctx.font = '8px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', c, 8);
    ctx.fillText('S', c, size - 1);
    ctx.textAlign = 'left';
    ctx.fillText('W', 0, c + 3);
    ctx.textAlign = 'right';
    ctx.fillText('E', size, c + 3);
  }
}
