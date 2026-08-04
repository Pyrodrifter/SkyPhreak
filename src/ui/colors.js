/**
 * Track colours — the identity colour of a satellite across the map, globe, polar
 * plot and every list. Deliberately NOT theme-derived: a target's colour is data,
 * and it must stay the same when the operator switches theme mid-pass.
 *
 * Chosen for separability on a near-black field and to stay distinguishable under
 * the red-only Night Ops palette, where hue collapses toward luminance.
 */

import { store } from '../core/store.js';

const PALETTE = [
  '#4db8ff', // blue
  '#3fb984', // green
  '#d9a441', // amber
  '#e0574f', // red
  '#c792ea', // violet
  '#5fd3e0', // cyan
  '#ff9d5c', // orange
  '#7ee787', // lime
];

export const SWATCHES = [...PALETTE, '#e6eaf2', '#8593a5'];

/** A user override wins; otherwise a stable colour by position in the tracked list. */
export function colorFor(id, tracked) {
  const custom = store.get().satColors;
  if (custom && custom[id]) return custom[id];
  const i = tracked.indexOf(id);
  return PALETTE[(i < 0 ? tracked.length : i) % PALETTE.length];
}
