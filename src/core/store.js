/**
 * Central app state with a tiny pub/sub. Settings (ground station, tracked
 * satellite IDs, HW config, UI prefs) persist via the Electron main process.
 */

const DEFAULTS = {
  station: { name: 'Home', lat: 52.37, lon: 4.9, altKm: 0 }, // Amsterdam-ish placeholder
  group: 'active',
  tracked: ['25544'], // ISS by default
  selected: '25544', // a NORAD id, or 'MOON'
  favorites: [], // [{ id, name, line1, line2 }] — TLE stored so they work offline
  satColors: {}, // { id: '#hex' } — user color overrides (else auto-assigned palette)
  tleStore: {}, // { id: { name, line1, line2 } } — cached TLEs for tracked sats (offline)
  tleSched: { auto: true, maxAgeDays: 2 }, // auto-refresh cached TLEs so they stay < maxAgeDays old
  view: '2d', // '2d' | '3d'
  theme: 'midnight', // UI theme id — see core/themes.js (midnight/ember/nightops/phosphor)
  sideCollapsed: false, // left satellite-browser panel collapsed
  rightCollapsed: false, // right info/settings panel collapsed
  mapStyle: 'vector', // 'vector' = dark blue lines | 'relief' = shaded topographic
  showMoon: true, // draw the Moon on the 2D map
  showPlanets: true, // draw the Sun + planets on the 2D map
  showDso: false, // master show/hide for all deep-sky objects on the sky views
  minEl: 5,
  hw: {
    rotator: {
      // 'hamlib' = legacy rotctld (jerky goto). 'superrot' = continuous-motion driver.
      protocol: 'hamlib',
      transport: 'tcp', // 'tcp' (WiFi/ESP32 or rotctld) | 'serial' (USB to MCU)
      host: '127.0.0.1',
      port: 4533,
      path: 'COM3', // serial port when transport === 'serial'
      baud: 115200,
      // 'off' = manual · 'selected' = follow the selected target · 'schedule' =
      // auto-track whichever tracked satellite is in a pass (park when none).
      autoMode: 'off',
      minEl: 0,
      // Smooth-controller motion limits (only used by the 'superrot' path).
      maxVelAz: 12, // °/s
      maxVelEl: 8,
      // SuperRot absolute azimuth range. The host streams CONTINUOUS (unwrapped) az
      // into this range so a north crossing keeps turning the same way instead of
      // unwinding; azMax > 360 gives cable-overlap before a manual unwind is needed.
      azMin: 0,
      azMax: 450,
      // Elevation ceiling — 90 for standard mounts, up to 180 for flip-over passes.
      elMax: 90,
      // After a pass (auto-track modes only) return to home/stow (az 0, low el),
      // which drives absolute az 0 and so unwinds any accumulated cable wrap.
      autoUnwind: true,
    },
    radio: { host: '127.0.0.1', port: 4532, downlinkHz: 145800000, doppler: false },
  },
};

const listeners = new Set();
let state = structuredClone(DEFAULTS);

// Full satellite catalog from the loaded TLE group (not persisted).
let catalog = [];

export const store = {
  get: () => state,
  getCatalog: () => catalog,

  setCatalog(sats) {
    catalog = sats;
    emit();
  },

  /** Set / clear a satellite's custom color override. */
  setSatColor(id, hex) {
    state = { ...state, satColors: { ...state.satColors, [id]: hex } };
    emit();
    persist();
  },
  clearSatColor(id) {
    const next = { ...state.satColors };
    delete next[id];
    state = { ...state, satColors: next };
    emit();
    persist();
  },

  /** Shallow-merge a patch into state and notify subscribers. */
  patch(patch) {
    state = { ...state, ...patch };
    emit();
    persist();
  },

  /** Patch a nested object (e.g. station, hw.rotator) immutably. */
  patchIn(path, patch) {
    const keys = path.split('.');
    const next = structuredClone(state);
    let cur = next;
    for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
    Object.assign(cur[keys[keys.length - 1]], patch);
    state = next;
    emit();
    persist();
  },

  toggleTracked(id, sat) {
    const set = new Set(state.tracked);
    const adding = !set.has(id);
    adding ? set.add(id) : set.delete(id);
    // Cache the TLE while tracked so the satellite keeps working across group
    // changes and offline; drop it when untracked (favorites persist separately).
    const tleStore = { ...state.tleStore };
    if (adding) {
      if (sat && sat.line1 && sat.line2) tleStore[id] = { name: sat.name, line1: sat.line1, line2: sat.line2 };
    } else {
      delete tleStore[id];
    }
    state = { ...state, tracked: [...set], tleStore };
    // If the selected satellite was just untracked, fall back to another tracked
    // one — but never override a 'MOON' selection.
    if (state.selected !== 'MOON' && !set.has(state.selected)) {
      state.selected = [...set][0] ?? 'MOON';
    }
    emit();
    persist();
  },

  isFavorite(id) {
    return state.favorites.some((f) => f.id === id);
  },

  /** Add/remove a favorite. `sat` is a catalog entry (carries its TLE). */
  toggleFavorite(sat) {
    const exists = state.favorites.some((f) => f.id === sat.noradId);
    const favorites = exists
      ? state.favorites.filter((f) => f.id !== sat.noradId)
      : [...state.favorites, { id: sat.noradId, name: sat.name, line1: sat.line1, line2: sat.line2 }];
    state = { ...state, favorites };
    emit();
    persist();
  },

  /** Refresh stored favorite TLEs from a freshly-loaded catalog (keeps them current). */
  refreshFavoriteTles(byId) {
    let changed = false;
    const favorites = state.favorites.map((f) => {
      const s = byId.get(f.id);
      if (s && (s.line1 !== f.line1 || s.line2 !== f.line2)) {
        changed = true;
        return { ...f, name: s.name, line1: s.line1, line2: s.line2 };
      }
      return f;
    });
    if (changed) {
      state = { ...state, favorites };
      persist();
    }
  },

  /** Capture/refresh cached TLEs for every tracked satellite present in a catalog. */
  refreshTrackedTles(byId) {
    let changed = false;
    const tleStore = { ...state.tleStore };
    for (const id of state.tracked) {
      const s = byId.get(id);
      if (s && (!tleStore[id] || tleStore[id].line1 !== s.line1 || tleStore[id].line2 !== s.line2)) {
        tleStore[id] = { name: s.name, line1: s.line1, line2: s.line2 };
        changed = true;
      }
    }
    if (changed) {
      state = { ...state, tleStore };
      persist();
    }
  },

  /** Store a freshly-downloaded TLE for a tracked and/or favorite satellite. */
  setStoredTle(id, tle) {
    let changed = false;
    const next = { ...state };
    if (state.tracked.includes(id)) { next.tleStore = { ...state.tleStore, [id]: tle }; changed = true; }
    if (state.favorites.some((f) => f.id === id)) {
      next.favorites = state.favorites.map((f) => (f.id === id ? { ...f, ...tle } : f));
      changed = true;
    }
    if (changed) { state = next; emit(); persist(); }
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** Load persisted settings from disk, merging over defaults. */
  async hydrate() {
    try {
      const saved = await window.pyro.settings.get();
      if (saved) state = deepMerge(structuredClone(DEFAULTS), saved);
    } catch {
      /* keep defaults */
    }
    emit();
  },
};

function emit() {
  for (const fn of listeners) fn(state);
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    window.pyro?.settings.set(state).catch(() => {});
  }, 400);
}

function deepMerge(base, over) {
  for (const k of Object.keys(over)) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) {
      base[k] = deepMerge(base[k] ?? {}, over[k]);
    } else {
      base[k] = over[k];
    }
  }
  return base;
}
