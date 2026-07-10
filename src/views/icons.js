/**
 * SkyPhreak icon set — a cohesive line-icon family rebuilt as inline SVG from the
 * project icon sheet (24px grid, 2px stroke, rounded joins). Icons stroke in
 * `currentColor`, so they inherit whatever colour the surrounding text/accent uses
 * and recolour automatically across themes. `icon(name, size)` returns SVG markup
 * for injection via the h() helper's `html:` attribute.
 *
 * Palette reference (Mission theme): Sky Blue #4fc3ff, Accent Cyan #00e5ff.
 */

// Inner markup per icon (paths in a 0..24 viewBox). Filled shapes set their own fill.
const PATHS = {
  map: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 6v12M15 6v12"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3.2 3 3.2 15 0 18M12 3c-3.2 3-3.2 15 0 18"/>',
  satellite: '<rect x="9.5" y="9.5" width="5" height="5" rx="1" transform="rotate(45 12 12)"/><path d="M8 8L5 5M16 16l3 3"/><path d="M15 6a5 5 0 0 1 3 3M15 3a8 8 0 0 1 6 6"/>',
  passes: '<g transform="rotate(-25 12 12)"><ellipse cx="12" cy="12" rx="9" ry="4"/></g><circle cx="17" cy="7.6" r="1.7" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11.5v4.5"/><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none"/>',
  setup: '<path d="M19.4 13a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/><circle cx="12" cy="12" r="3"/>',
  hardware: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><rect x="10" y="10" width="4" height="4" rx="0.5"/><path d="M9 3v2M12 3v2M15 3v2M9 19v2M12 19v2M15 19v2M3 9h2M3 12h2M3 15h2M19 9h2M19 12h2M19 15h2"/>',
  follow: '<circle cx="12" cy="12" r="3.4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  time: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  reset: '<path d="M20 11.5a8 8 0 1 0-.5 3.9"/><path d="M20 4v6h-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.3a2.6 2.6 0 1 1 3.6 2.4c-1 .5-1.5 1.1-1.5 2.3"/><circle cx="11.5" cy="16.8" r="0.7" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.3-4.3"/>',
  favorites: '<path d="M12 3.2l2.7 5.5 6 .9-4.35 4.25 1.03 6L12 17.1 6.62 19.85l1.03-6L3.3 9.6l6-.9z"/>',
  park: '<circle cx="12" cy="12" r="9"/><path d="M9.8 16.5V7.5h3.4a2.6 2.6 0 0 1 0 5.2H9.8"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none"/>',
  rotator: '<path d="M18 9a7 7 0 1 0 1.2 5"/><path d="M18 4v5h-5"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>',
  radio: '<path d="M12 21v-7"/><path d="M9 21l3-9 3 9"/><path d="M5.6 8.4a9 9 0 0 1 12.8 0M8.1 10.9a5.5 5.5 0 0 1 7.8 0"/>',
  load: '<path d="M14 3v5h5"/><path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z"/><path d="M12 18v-6M9.4 14.6L12 12l2.6 2.6"/>',
  gps: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  moon: '<path d="M20 13.4A8.5 8.5 0 1 1 10.6 4 6.6 6.6 0 0 0 20 13.4z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  planet: '<circle cx="12" cy="11" r="6"/><g transform="rotate(25 12 12)"><ellipse cx="12" cy="12" rx="10.5" ry="3.2"/></g>',
};

/** Build inline SVG markup for a named icon at `size` px (stroke = currentColor). */
export function icon(name, size = 16) {
  const inner = PATHS[name];
  if (!inner) return '';
  return `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" `
    + `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

/** Names available (for tooling / a future icon gallery). */
export const ICON_NAMES = Object.keys(PATHS);
