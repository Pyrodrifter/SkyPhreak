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
 *
 * ---------------------------------------------------------------------------
 * Why these differ from each other in more than one channel.
 *
 * An earlier set varied only the accent hue over identical cool-grey neutrals and
 * near-white text. That produces several versions of one look, because the accent
 * is a few hundred pixels of the screen — the neutral surfaces and the body text
 * are the other 95%, and those never changed.
 *
 * So each theme moves three things together: the TEMPERATURE of the neutrals, the
 * TEXT colour (bone, sand or ember — never plain white), and only then the accent.
 *
 * Accent hue is constrained. Green, amber and red are committed to ok / warn /
 * alert and occupy the whole warm arc; blue and violet are the generic dark-mode
 * palette. Foundry resolves that by keeping the accent cool and putting the
 * character in the neutrals. Sideband resolves it by reassigning what caution
 * means. Night Ops sidesteps it entirely — see its note.
 */

export const THEMES = {
  // Warm iron and bone with a cool jade accent. The warm chrome / cold live-state
  // split is what makes it read as machined equipment rather than a dark UI.
  foundry: {
    name: 'Foundry',
    vars: {
      '--bg-0': '#100e0c', '--bg-1': '#181512', '--bg-2': '#201c18', '--bg-3': '#2a2521', '--bg-4': '#352e28',
      '--line': '#332c26', '--line-soft': '#241f1a', '--line-hard': '#4a4137',
      '--fg': '#e9e1d3', '--fg-dim': '#a89b8b', '--fg-mute': '#75695c',
      '--accent': '#3fcfa8', '--accent-fg': '#04231b',
      '--ok': '#8ac765', '--warn': '#e8a33c', '--alert': '#e8574a',
    },
    map: {
      bg: '#0d1512', land: '#1d2a24', landStroke: 'rgba(63,207,168,0.40)', border: 'rgba(63,207,168,0.26)',
      graticule: 'rgba(168,155,139,0.09)', equator: 'rgba(168,155,139,0.17)',
      terminator: 'rgba(8,6,4,0.52)', labelBg: 'rgba(16,14,12,0.8)',
      labelText: 'rgba(233,225,211,0.9)', moonShadow: '#26201b',
    },
    polar: {
      grid: 'rgba(74,65,55,0.95)', gridDim: 'rgba(51,44,38,0.95)',
      ticks: 'rgba(168,155,139,0.7)', labels: 'rgba(233,225,211,0.82)',
    },
    globe: {
      atmosphere: '#3fcfa8', polyCap: 'rgba(28,68,58,0.92)',
      polySide: 'rgba(18,44,37,0.42)', polyStroke: 'rgba(63,207,168,0.5)',
      sphere: '#0d1512', sphereEmissive: '#070d0b',
    },
  },

  // The front panel of a radio: near-black warm grey, amber readouts, bone labels.
  // Amber IS the accent here rather than the caution colour — that is the whole
  // point of the look — so caution moves to a bright yellow and stays separable.
  sideband: {
    name: 'Sideband',
    vars: {
      '--bg-0': '#0b0a08', '--bg-1': '#12100d', '--bg-2': '#191612', '--bg-3': '#221e19', '--bg-4': '#2c2721',
      '--line': '#2b251e', '--line-soft': '#1e1a15', '--line-hard': '#443a2e',
      '--fg': '#e2d9c6', '--fg-dim': '#a2947c', '--fg-mute': '#6f6454',
      '--accent': '#ffab2e', '--accent-fg': '#1c1102',
      '--ok': '#67cf7d', '--warn': '#ffe14d', '--alert': '#ff5c4d',
    },
    map: {
      bg: '#0f0d0a', land: '#241d15', landStroke: 'rgba(255,171,46,0.38)', border: 'rgba(255,171,46,0.24)',
      graticule: 'rgba(162,148,124,0.09)', equator: 'rgba(162,148,124,0.17)',
      terminator: 'rgba(6,4,2,0.52)', labelBg: 'rgba(11,10,8,0.8)',
      labelText: 'rgba(226,217,198,0.9)', moonShadow: '#211a12',
    },
    polar: {
      grid: 'rgba(68,58,46,0.95)', gridDim: 'rgba(43,37,30,0.95)',
      ticks: 'rgba(162,148,124,0.7)', labels: 'rgba(226,217,198,0.82)',
    },
    globe: {
      atmosphere: '#ffab2e', polyCap: 'rgba(72,52,20,0.92)',
      polySide: 'rgba(46,33,13,0.42)', polyStroke: 'rgba(255,171,46,0.5)',
      sphere: '#0f0d0a', sphereEmissive: '#080604',
    },
  },

  // Petrol-black hull, warm sand text, signal-orange accent — the inverse split to
  // Foundry: cold chrome, warm live state.
  deepwater: {
    name: 'Deepwater',
    vars: {
      '--bg-0': '#060f10', '--bg-1': '#0b1618', '--bg-2': '#0f1e20', '--bg-3': '#15282b', '--bg-4': '#1c3337',
      '--line': '#1a2e31', '--line-soft': '#122123', '--line-hard': '#2b494e',
      '--fg': '#e4e0d2', '--fg-dim': '#8fa39f', '--fg-mute': '#5f7573',
      '--accent': '#ff8a4d', '--accent-fg': '#1a0c03',
      '--ok': '#3fcf9c', '--warn': '#f5cf5a', '--alert': '#f0544f',
    },
    map: {
      bg: '#07161a', land: '#11282c', landStroke: 'rgba(255,138,77,0.36)', border: 'rgba(255,138,77,0.24)',
      graticule: 'rgba(143,163,159,0.09)', equator: 'rgba(143,163,159,0.17)',
      terminator: 'rgba(2,7,8,0.52)', labelBg: 'rgba(6,15,16,0.8)',
      labelText: 'rgba(228,224,210,0.9)', moonShadow: '#152a2e',
    },
    polar: {
      grid: 'rgba(43,73,78,0.95)', gridDim: 'rgba(26,46,49,0.95)',
      ticks: 'rgba(143,163,159,0.7)', labels: 'rgba(228,224,210,0.82)',
    },
    globe: {
      atmosphere: '#ff8a4d', polyCap: 'rgba(20,62,68,0.92)',
      polySide: 'rgba(12,40,44,0.42)', polyStroke: 'rgba(255,138,77,0.5)',
      sphere: '#07161a', sphereEmissive: '#040c0e',
    },
  },

  /**
   * Night Ops — kept because it is equipment, not decoration: Field mode switches
   * to it so a bright screen doesn't destroy the dark adaptation you need at the
   * antenna. Rod cells barely respond above ~620 nm, so every colour here sits in
   * the deep red band (hue 3–26°).
   *
   * That rules out signalling status by hue — a green "ok" chip would undo the
   * whole point. Nor can it be a clean brightness ramp: green carries 71% of
   * relative luminance, so a saturated red always computes dimmer than an orange
   * and "alert brightest" is unreachable inside the band.
   *
   * So status is carried by SATURATION and brightness together, on top of the
   * ✓ / ! / ✕ glyphs the readiness list already draws:
   *   ok     dim and desaturated (0.19 luma, 0.46 sat) — recedes into the panel
   *   warn   bright amber-red    (0.43 luma, 0.67 sat) — the brightest chip
   *   alert  pure saturated red  (0.25 luma, 0.81 sat) — the only full-chroma
   *          element anywhere in the theme, so nothing else competes with it
   */
  nightops: {
    name: 'Night Ops',
    vars: {
      '--bg-0': '#0a0403', '--bg-1': '#120705', '--bg-2': '#1a0a07', '--bg-3': '#24100b', '--bg-4': '#2f150f',
      '--line': '#2e130e', '--line-soft': '#200c08', '--line-hard': '#4a1f16',
      '--fg': '#ffb3a0', '--fg-dim': '#b4705f', '--fg-mute': '#7a4a3e',
      '--accent': '#ff5c3d', '--accent-fg': '#1a0402',
      '--ok': '#a8685a', '--warn': '#ff9455', '--alert': '#ff3b30',
    },
    map: {
      bg: '#0d0503', land: '#28100b', landStroke: 'rgba(255,92,61,0.38)', border: 'rgba(255,92,61,0.24)',
      graticule: 'rgba(180,112,95,0.09)', equator: 'rgba(180,112,95,0.17)',
      terminator: 'rgba(5,0,0,0.52)', labelBg: 'rgba(10,4,3,0.8)',
      labelText: 'rgba(255,179,160,0.9)', moonShadow: '#24110c',
    },
    polar: {
      grid: 'rgba(74,31,22,0.95)', gridDim: 'rgba(46,19,14,0.95)',
      ticks: 'rgba(180,112,95,0.7)', labels: 'rgba(255,179,160,0.82)',
    },
    globe: {
      atmosphere: '#ff5c3d', polyCap: 'rgba(92,30,18,0.92)',
      polySide: 'rgba(58,18,11,0.42)', polyStroke: 'rgba(255,92,61,0.5)',
      sphere: '#0d0503', sphereEmissive: '#070201',
    },
  },
};

/**
 * Themes that no longer exist, mapped to their nearest survivor. A saved setting
 * naming one of these is migrated on load rather than silently falling back, so
 * the Settings dropdown doesn't show an empty selection.
 */
export const RETIRED_THEMES = {
  mission: 'foundry',    // violet on slate
  midnight: 'deepwater', // blue on slate — closest surviving cool palette
  ember: 'sideband',     // orange on brown — closest surviving warm palette
  phosphor: 'foundry',   // green CRT — Foundry's jade accent is the nearest
};

/** Resolve a possibly-retired theme id to one that exists. */
export const resolveTheme = (id) => (THEMES[id] ? id : RETIRED_THEMES[id] || (id === 'custom' ? id : 'foundry'));

let active = THEMES.foundry;

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
  const base = THEMES[resolveTheme(custom && custom.base)] || THEMES.foundry;
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
  active = id === 'custom' ? buildCustom(custom) : (THEMES[resolveTheme(id)] || THEMES.foundry);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(active.vars)) root.style.setProperty(k, v);
  return active;
}
