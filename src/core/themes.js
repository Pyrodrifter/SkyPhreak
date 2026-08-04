/**
 * Theme system. A theme supplies the palette only — the surfaces, hairlines, text
 * and accent as CSS custom properties, plus the canvas colours the map, globe and
 * polar views read on every draw.
 *
 * A theme changes the colour of the instrument, never its shape: geometry, type
 * and density live in ui/tokens.css and are identical across every theme.
 *
 * Track colours (ui/colors.js) are deliberately NOT themed — a satellite's colour
 * is data, and it must not change identity when the operator switches palette
 * halfway through a pass.
 *
 * applyTheme() writes the vars onto <html>; the canvas views call palette() every
 * draw (they repaint at 1 Hz anyway), so a change propagates within a tick.
 */

export const THEMES = {
  // House look: near-black navy with a sky-blue accent.
  mission: {
    name: 'Mission',
    vars: {
      '--bg-0': '#06090d', '--bg-1': '#0a0e14', '--bg-2': '#0f141c', '--bg-3': '#151b25', '--bg-4': '#1c2430',
      '--line': '#1b2431', '--line-soft': '#131a24', '--line-hard': '#2a3646',
      '--fg': '#ccd6e2', '--fg-dim': '#7e8da0', '--fg-mute': '#56626f',
      '--accent': '#4db8ff', '--accent-fg': '#04121d',
      '--ok': '#3fb984', '--warn': '#d9a441', '--alert': '#e0574f',
    },
    map: {
      bg: '#070d16', land: '#101f30', landStroke: 'rgba(77,184,255,0.42)',
      graticule: 'rgba(126,141,160,0.09)', equator: 'rgba(126,141,160,0.16)',
      terminator: 'rgba(2,5,10,0.52)', labelBg: 'rgba(6,9,13,0.78)',
      labelText: 'rgba(204,214,226,0.9)', moonShadow: '#121a26',
    },
    polar: {
      grid: 'rgba(42,54,70,0.95)', gridDim: 'rgba(27,36,49,0.95)',
      ticks: 'rgba(126,141,160,0.7)', labels: 'rgba(204,214,226,0.8)',
    },
    globe: {
      atmosphere: '#4db8ff', polyCap: 'rgba(22,54,84,0.92)',
      polySide: 'rgba(14,34,54,0.42)', polyStroke: 'rgba(77,184,255,0.5)',
      sphere: '#070d16', sphereEmissive: '#040a11',
    },
  },

  midnight: {
    name: 'Midnight',
    vars: {
      '--bg-0': '#07090c', '--bg-1': '#0b0e13', '--bg-2': '#10141a', '--bg-3': '#161b23', '--bg-4': '#1d232d',
      '--line': '#1c232e', '--line-soft': '#141922', '--line-hard': '#2b3442',
      '--fg': '#d0d8e4', '--fg-dim': '#828e9e', '--fg-mute': '#59636f',
      '--accent': '#5aa9e6', '--accent-fg': '#04101a',
      '--ok': '#4ab98a', '--warn': '#dba94a', '--alert': '#e05f56',
    },
    map: {
      bg: '#08111c', land: '#132435', landStroke: 'rgba(90,169,230,0.4)',
      graticule: 'rgba(130,142,158,0.09)', equator: 'rgba(130,142,158,0.16)',
      terminator: 'rgba(3,5,9,0.5)', labelBg: 'rgba(7,9,12,0.78)',
      labelText: 'rgba(208,216,228,0.9)', moonShadow: '#141c27',
    },
    polar: {
      grid: 'rgba(43,52,66,0.95)', gridDim: 'rgba(28,35,46,0.95)',
      ticks: 'rgba(130,142,158,0.7)', labels: 'rgba(208,216,228,0.8)',
    },
    globe: {
      atmosphere: '#5aa9e6', polyCap: 'rgba(26,56,84,0.92)',
      polySide: 'rgba(16,36,54,0.42)', polyStroke: 'rgba(90,169,230,0.5)',
      sphere: '#08111c', sphereEmissive: '#050b12',
    },
  },

  // Charcoal and ember — the PyroLabs hardware palette.
  ember: {
    name: 'Ember',
    vars: {
      '--bg-0': '#0c0805', '--bg-1': '#120d08', '--bg-2': '#19120c', '--bg-3': '#211812', '--bg-4': '#2b2017',
      '--line': '#2e2118', '--line-soft': '#221810', '--line-hard': '#443124',
      '--fg': '#e6dace', '--fg-dim': '#a08d7c', '--fg-mute': '#6d5c4e',
      '--accent': '#ff8a4c', '--accent-fg': '#1a0c04',
      '--ok': '#5cba7d', '--warn': '#e8b23c', '--alert': '#e85c4a',
    },
    map: {
      bg: '#130c06', land: '#2e1e12', landStroke: 'rgba(255,138,76,0.38)',
      graticule: 'rgba(160,141,124,0.09)', equator: 'rgba(160,141,124,0.16)',
      terminator: 'rgba(8,4,1,0.5)', labelBg: 'rgba(12,8,5,0.78)',
      labelText: 'rgba(230,218,206,0.9)', moonShadow: '#241810',
    },
    polar: {
      grid: 'rgba(68,49,36,0.95)', gridDim: 'rgba(46,33,24,0.95)',
      ticks: 'rgba(160,141,124,0.7)', labels: 'rgba(230,218,206,0.8)',
    },
    globe: {
      atmosphere: '#ff8a4c', polyCap: 'rgba(92,52,26,0.92)',
      polySide: 'rgba(58,32,16,0.42)', polyStroke: 'rgba(255,138,76,0.5)',
      sphere: '#130c06', sphereEmissive: '#0c0703',
    },
  },

  // Red-only: preserves dark adaptation at the antenna. Paired with Field mode.
  nightops: {
    name: 'Night Ops',
    vars: {
      '--bg-0': '#0a0304', '--bg-1': '#100506', '--bg-2': '#170809', '--bg-3': '#1f0c0e', '--bg-4': '#291012',
      '--line': '#2c1214', '--line-soft': '#1f0d0f', '--line-hard': '#451c1f',
      '--fg': '#ecb3b3', '--fg-dim': '#a86a6a', '--fg-mute': '#734848',
      '--accent': '#ff4d4d', '--accent-fg': '#140303',
      '--ok': '#e08585', '--warn': '#ffa04d', '--alert': '#ff2f2f',
    },
    map: {
      bg: '#0e0405', land: '#2a0e11', landStroke: 'rgba(255,77,77,0.4)',
      graticule: 'rgba(168,106,106,0.09)', equator: 'rgba(168,106,106,0.16)',
      terminator: 'rgba(6,0,0,0.5)', labelBg: 'rgba(10,3,4,0.78)',
      labelText: 'rgba(236,179,179,0.9)', moonShadow: '#210c0e',
    },
    polar: {
      grid: 'rgba(69,28,31,0.95)', gridDim: 'rgba(44,18,20,0.95)',
      ticks: 'rgba(168,106,106,0.7)', labels: 'rgba(236,179,179,0.8)',
    },
    globe: {
      atmosphere: '#ff4d4d', polyCap: 'rgba(94,24,28,0.92)',
      polySide: 'rgba(58,14,17,0.42)', polyStroke: 'rgba(255,77,77,0.5)',
      sphere: '#0e0405', sphereEmissive: '#080202',
    },
  },

  // Green CRT radar terminal.
  phosphor: {
    name: 'Phosphor',
    vars: {
      '--bg-0': '#040806', '--bg-1': '#070d09', '--bg-2': '#0b140d', '--bg-3': '#101c13', '--bg-4': '#16261a',
      '--line': '#152218', '--line-soft': '#0f1911', '--line-hard': '#254029',
      '--fg': '#c3e6c9', '--fg-dim': '#7ba383', '--fg-mute': '#526e58',
      '--accent': '#48d67f', '--accent-fg': '#03140a',
      '--ok': '#48d67f', '--warn': '#d8c84a', '--alert': '#e06a5a',
    },
    map: {
      bg: '#05100a', land: '#0f2617', landStroke: 'rgba(72,214,127,0.38)',
      graticule: 'rgba(123,163,131,0.09)', equator: 'rgba(123,163,131,0.16)',
      terminator: 'rgba(0,5,2,0.5)', labelBg: 'rgba(4,8,6,0.78)',
      labelText: 'rgba(195,230,201,0.9)', moonShadow: '#122016',
    },
    polar: {
      grid: 'rgba(37,64,41,0.95)', gridDim: 'rgba(21,34,24,0.95)',
      ticks: 'rgba(123,163,131,0.7)', labels: 'rgba(195,230,201,0.8)',
    },
    globe: {
      atmosphere: '#48d67f', polyCap: 'rgba(24,74,44,0.92)',
      polySide: 'rgba(14,46,27,0.42)', polyStroke: 'rgba(72,214,127,0.5)',
      sphere: '#05100a', sphereEmissive: '#030a06',
    },
  },
};

let active = THEMES.mission;

/** The active theme's canvas palette — views read this on every draw. */
export const palette = () => active;

/** Relative luminance, for deciding whether text on the accent should be dark. */
function luminance(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}

/**
 * Build the user 'custom' theme: a base palette with their accent swapped in.
 * `--accent-fg` is recomputed from the accent's luminance so a light accent still
 * gets readable dark text on filled buttons.
 */
function buildCustom(custom) {
  const base = THEMES[(custom && custom.base)] || THEMES.midnight;
  const accent = (custom && custom.accent) || base.vars['--accent'];
  return {
    ...base,
    name: 'Custom',
    vars: { ...base.vars, '--accent': accent, '--accent-fg': luminance(accent) > 0.45 ? '#080d12' : '#f2f7fc' },
    // Only the atmosphere picks up the accent; the map and polar palettes stay on
    // the base so a wild accent choice can't wash out the basemap.
    globe: { ...base.globe, atmosphere: accent },
  };
}

/** Apply a theme by id (or the built 'custom' theme): set CSS vars + canvas palette. */
export function applyTheme(id, custom) {
  active = id === 'custom' ? buildCustom(custom) : (THEMES[id] || THEMES.mission);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(active.vars)) root.style.setProperty(k, v);
  return active;
}
