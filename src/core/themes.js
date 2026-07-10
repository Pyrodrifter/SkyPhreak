/**
 * Theme system. Each theme is a full palette: the CSS custom properties that skin
 * every DOM panel, plus the canvas colors used by the 2D map, polar view, and the
 * 3D globe's vector mode (relief mode is texture-based and mostly theme-neutral).
 *
 * Satellite identity colors (ui.js PALETTE) and the yellow station marker are data
 * colors, not chrome — they stay fixed across themes so targets keep their identity.
 *
 * applyTheme() writes the CSS vars onto <html>; the canvas views call palette()
 * every draw (they repaint at 1 Hz anyway), so a theme change propagates within a
 * tick with no per-view wiring.
 */

export const THEMES = {
  // Mission Control — the SkyPhreak house look: deep navy HUD with sky-blue / cyan
  // accents (matches the icon sheet: Sky Blue #4fc3ff, Accent Cyan #00e5ff).
  mission: {
    name: 'Mission',
    vars: {
      '--bg': '#070b12', '--panel': '#0b1220', '--panel-2': '#0f1a2b',
      '--line': '#1b2c44', '--text': '#dbe7f5', '--text-dim': '#7f93ac',
      '--accent': '#4fc3ff', '--accent-2': '#00e5ff',
      '--warn': '#ffc53f', '--danger': '#ff5a5f',
      '--topbar-hi': '#0c1626', '--topbar-lo': '#08101c',
    },
    map: {
      bg: '#08182b', land: '#123553', landStroke: 'rgba(90,180,255,0.55)',
      graticule: 'rgba(100,170,230,0.10)', equator: 'rgba(100,170,230,0.18)',
      terminator: 'rgba(2,6,14,0.50)', labelBg: 'rgba(6,12,22,0.7)',
      labelText: 'rgba(220,235,250,0.85)', moonShadow: '#14243a',
    },
    polar: {
      grid: 'rgba(100,180,255,0.22)', gridDim: 'rgba(100,180,255,0.15)',
      ticks: 'rgba(100,180,255,0.45)', labels: 'rgba(180,220,255,0.85)',
    },
    globe: {
      atmosphere: '#4fc3ff', polyCap: 'rgba(30,90,140,0.9)',
      polySide: 'rgba(18,55,85,0.4)', polyStroke: 'rgba(90,180,255,0.6)',
      sphere: '#08182b', sphereEmissive: '#050f1c',
    },
  },

  midnight: {
    name: 'Midnight',
    vars: {
      '--bg': '#0a0e14', '--panel': '#0e141d', '--panel-2': '#121a25',
      '--line': '#1d2733', '--text': '#d7e0ee', '--text-dim': '#8b97a8',
      '--accent': '#4a9fd4', '--accent-2': '#57d0a0',
      '--warn': '#ffd23f', '--danger': '#ff6b6b',
      '--topbar-hi': '#0f1620', '--topbar-lo': '#0b1118',
    },
    map: {
      bg: '#0c1a2b', land: '#16314a', landStroke: 'rgba(120,190,230,0.55)',
      graticule: 'rgba(120,160,200,0.10)', equator: 'rgba(120,160,200,0.18)',
      terminator: 'rgba(3,6,16,0.45)', labelBg: 'rgba(8,12,20,0.7)',
      labelText: 'rgba(220,230,245,0.85)', moonShadow: '#1a2433',
    },
    polar: {
      grid: 'rgba(120,160,200,0.22)', gridDim: 'rgba(120,160,200,0.15)',
      ticks: 'rgba(120,160,200,0.45)', labels: 'rgba(180,210,235,0.8)',
    },
    globe: {
      atmosphere: '#4a9fd4', polyCap: 'rgba(36,90,130,0.9)',
      polySide: 'rgba(20,50,75,0.4)', polyStroke: 'rgba(120,190,230,0.6)',
      sphere: '#0a1626', sphereEmissive: '#06101c',
    },
  },

  // PyroLabs house colors — charcoal + ember orange (matches the PyroRotator badge).
  ember: {
    name: 'Ember',
    vars: {
      '--bg': '#120d09', '--panel': '#1a120c', '--panel-2': '#221810',
      '--line': '#36271b', '--text': '#eee1d4', '--text-dim': '#a8917e',
      '--accent': '#ff7a45', '--accent-2': '#ffb03f',
      '--warn': '#ffd23f', '--danger': '#ff5252',
      '--topbar-hi': '#1c130c', '--topbar-lo': '#140d08',
    },
    map: {
      bg: '#170f08', land: '#3a2415', landStroke: 'rgba(235,150,90,0.55)',
      graticule: 'rgba(210,150,100,0.10)', equator: 'rgba(210,150,100,0.18)',
      terminator: 'rgba(10,4,0,0.45)', labelBg: 'rgba(20,10,4,0.7)',
      labelText: 'rgba(245,225,205,0.85)', moonShadow: '#2b1c10',
    },
    polar: {
      grid: 'rgba(210,150,100,0.22)', gridDim: 'rgba(210,150,100,0.15)',
      ticks: 'rgba(210,150,100,0.45)', labels: 'rgba(235,200,170,0.8)',
    },
    globe: {
      atmosphere: '#ff7a45', polyCap: 'rgba(130,70,35,0.9)',
      polySide: 'rgba(75,40,20,0.4)', polyStroke: 'rgba(235,150,90,0.6)',
      sphere: '#1c120a', sphereEmissive: '#120a05',
    },
  },

  // Red-on-black field mode: preserves night-adapted vision at the telescope/antenna.
  nightops: {
    name: 'Night Ops',
    vars: {
      '--bg': '#0d0405', '--panel': '#150708', '--panel-2': '#1d0a0c',
      '--line': '#361316', '--text': '#f0b2b2', '--text-dim': '#a06565',
      '--accent': '#ff4545', '--accent-2': '#ff8060',
      '--warn': '#ffb03f', '--danger': '#ff2020',
      '--topbar-hi': '#170708', '--topbar-lo': '#100405',
    },
    map: {
      bg: '#120406', land: '#320d12', landStroke: 'rgba(255,95,95,0.5)',
      graticule: 'rgba(255,110,110,0.10)', equator: 'rgba(255,110,110,0.18)',
      terminator: 'rgba(8,0,0,0.45)', labelBg: 'rgba(18,4,4,0.7)',
      labelText: 'rgba(245,190,190,0.85)', moonShadow: '#2a1013',
    },
    polar: {
      grid: 'rgba(255,110,110,0.22)', gridDim: 'rgba(255,110,110,0.15)',
      ticks: 'rgba(255,110,110,0.45)', labels: 'rgba(245,180,180,0.8)',
    },
    globe: {
      atmosphere: '#ff4545', polyCap: 'rgba(120,30,35,0.9)',
      polySide: 'rgba(70,15,20,0.4)', polyStroke: 'rgba(255,95,95,0.6)',
      sphere: '#1a0709', sphereEmissive: '#100304',
    },
  },

  // Green CRT radar-terminal retro.
  phosphor: {
    name: 'Phosphor',
    vars: {
      '--bg': '#060c07', '--panel': '#0a140b', '--panel-2': '#0e1c10',
      '--line': '#1d3322', '--text': '#c9eecd', '--text-dim': '#7da884',
      '--accent': '#3ce07a', '--accent-2': '#9ae05a',
      '--warn': '#ffd23f', '--danger': '#ff6b6b',
      '--topbar-hi': '#0b160c', '--topbar-lo': '#071008',
    },
    map: {
      bg: '#07130b', land: '#153b23', landStroke: 'rgba(110,225,150,0.5)',
      graticule: 'rgba(110,220,140,0.10)', equator: 'rgba(110,220,140,0.18)',
      terminator: 'rgba(0,8,3,0.45)', labelBg: 'rgba(4,14,7,0.7)',
      labelText: 'rgba(205,240,215,0.85)', moonShadow: '#12281a',
    },
    polar: {
      grid: 'rgba(110,220,140,0.22)', gridDim: 'rgba(110,220,140,0.15)',
      ticks: 'rgba(110,220,140,0.45)', labels: 'rgba(180,235,195,0.8)',
    },
    globe: {
      atmosphere: '#3ce07a', polyCap: 'rgba(30,105,55,0.9)',
      polySide: 'rgba(15,60,30,0.4)', polyStroke: 'rgba(110,225,150,0.6)',
      sphere: '#0a1a10', sphereEmissive: '#05100a',
    },
  },
};

let active = THEMES.midnight;

/** The active theme's canvas palette — views read this on every draw. */
export const palette = () => active;

// Shift a #rrggbb toward white by `amt` (0..1) — used to derive a lighter secondary
// accent for custom themes so chips/links still read as a related tint.
function lighten(hex, amt) {
  const n = parseInt(hex.replace('#', ''), 16);
  const mix = (c) => Math.round(c + (255 - c) * amt);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// Build a 'custom' theme: a base palette with the user's accent applied to the DOM
// chrome and the globe atmosphere. Everything else inherits the (dark) base.
function buildCustom(custom) {
  const base = THEMES[custom && custom.base] || THEMES.midnight;
  const accent = (custom && custom.accent) || base.vars['--accent'];
  return {
    ...base,
    name: 'Custom',
    vars: { ...base.vars, '--accent': accent, '--accent-2': lighten(accent, 0.25) },
    globe: { ...base.globe, atmosphere: accent },
  };
}

/** Apply a theme by id (or a built 'custom' theme): set CSS vars + canvas palette. */
export function applyTheme(id, custom) {
  active = id === 'custom' ? buildCustom(custom) : (THEMES[id] || THEMES.midnight);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(active.vars)) root.style.setProperty(k, v);
  return active;
}
