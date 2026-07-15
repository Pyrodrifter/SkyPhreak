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
  theme: 'midnight', // UI theme id — see core/themes.js (midnight/ember/nightops/phosphor/custom)
  customTheme: { base: 'midnight', accent: '#4a9fd4' }, // user 'custom' theme: a base + accent
  uiScale: 'md', // UI size: 'sm' | 'md' | 'lg'
  fieldMode: false, // one-tap field mode (large + Night Ops)
  sideCollapsed: false, // left satellite-browser panel collapsed
  rightCollapsed: false, // right info/settings panel collapsed
  sbCollapsed: false, // bottom status bar collapsed to a slim strip
  followSat: false, // keep the active view centred on the selected satellite
  passSort: 'time', // Passes tab order: 'time' (soonest) | 'el' (highest first)
  notifyPasses: false, // desktop notification before a tracked pass rises
  notifySound: true, // play an audible cue with pass notifications
  notifySoundStyle: 'chime', // 'chime' | 'radar' | 'urgent'
  notifyAos: true,
  notifyAosSound: 'beacon',
  notifyPeak: true,
  notifyPeakSound: 'sparkle',
  notifyLos: true,
  notifyLosSound: 'descending',
  rotatorSounds: true,
  rotatorConnectSound: 'digital',
  rotatorDisconnectSound: 'low',
  rotatorTrackSound: 'beacon',
  rotatorParkSound: 'soft',
  notifyVoice: false, // speak pass details after the alert cue
  notifyVoiceURI: '__female__', // automatic female match; empty uses system default
  notifyVoiceRate: 0.95,
  notifyVoicePitch: 1,
  notifyVoiceVolume: 1,
  // Robotic "ship computer" delivery (Subnautica-style): flat low pitch, deliberate
  // rate, preceded by a two-tone computer chime. Overrides the rate/pitch sliders.
  notifyVoiceRobotic: false,
  notifyVoiceTemplate: '{satellite} will rise in {minutes} {minuteWord}. Pass duration is about {duration} {durationWord}, with a maximum elevation of {maxElevation} degrees. {visibility}',
  notifyLead: 5, // minutes before AOS to notify
  mapStyle: 'vector', // 'vector' = dark blue lines | 'relief' = shaded topographic
  showMoon: true, // draw the Moon on the 2D map
  showPlanets: true, // draw the Sun + planets on the 2D map
  showDso: false, // master show/hide for all deep-sky objects on the sky views
  emeFreqMHz: 144, // frequency for EME (Moon-bounce) path-loss / Doppler readouts
  minEl: 5,
  // Horizon mask: sparse [{ az, el }] obstruction profile (trees/buildings/hills)
  // that raises the effective minimum elevation per-azimuth. Empty = flat 0°.
  horizonMask: [],
  horizonMaskOn: true, // apply the mask to pass visibility/readiness (off = ignore it)
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
      // Motion smoothness profile (accel/jerk ramp) — see MOTION_PROFILES in main.js.
      // 'gentle' for EME/heavy dishes, 'normal', 'fast' for light LEO rigs.
      motionProfile: 'normal',
      // Elevation ceiling — 90 for standard mounts, up to 180 for flip-over passes.
      elMax: 90,
      // Azimuth is FREE / continuous (shortest-path, may go negative or past 360 —
      // there is no travel limit). These are informational cable-wrap thresholds:
      // the wrap gauge turns amber past wrapWarnDeg and red past wrapMaxDeg of
      // accumulated azimuth away from north, prompting a manual unwind.
      wrapWarnDeg: 540,
      wrapMaxDeg: 720,
      // Auto-track: pre-position to the next pass's AOS azimuth this many seconds
      // before the satellite rises, so the mount is already pointing when it appears.
      preslewLead: 45,
      // Named park positions. 'home' presets trigger the firmware homing sequence;
      // others slew to a saved az/el. parkDefault names the one the Park button uses.
      parkPresets: [{ name: 'Home', home: true }],
      parkDefault: 'Home',
      // Mount-alignment calibration: offsets added to the true-sky command to get the
      // mount command (mount = sky + offset); telemetry is mapped back the other way.
      // 0/0 = no correction (default). Backlash figures are for firmware config sync.
      azOffset: 0,
      elOffset: 0,
      backlashAz: 0,
      backlashEl: 0,
      // Sun-avoidance guard: warn (and skip pre-slew) when pointing within sunAvoidDeg
      // of the Sun, to protect optics/sensors on the boresight.
      sunAvoid: false,
      sunAvoidDeg: 5,
      // Multi-pass queue: a specific pass the scheduler is committed to, overriding the
      // automatic highest-pass pick. { id, aos } (aos = epoch ms) or null.
      armedPass: null,
    },
    radio: { host: '127.0.0.1', port: 4532, downlinkHz: 145800000, doppler: false },
    // Standalone LCD/display repeater — a one-way output port that streams the
    // SELECTED target's az/el (and name) to a bench display (Arduino/ESP32 + LCD),
    // independent of the rotator. transport 'serial' (USB) or 'tcp' (networked).
    // format: 'simple' = "AZ179.4 EL42.1" · 'csv' = "179.4,42.1" · 'json'.
    lcd: {
      enabled: false,
      transport: 'serial',
      host: '127.0.0.1',
      port: 4535,
      path: 'COM4',
      baud: 9600,
      format: 'simple', // updates once per second (tick rate) while connected
    },
  },
  // Per-satellite radio profiles keyed by NORAD id: { downlinkHz, downlinkMode,
  // uplinkHz, uplinkMode, invert, label }. Override the single global downlink so
  // each bird tunes to its own up/down pair. See core/radioProfiles.js.
  radioProfiles: {},
  rigBarCollapsed: false,
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

  /** Add (or replace by name) a rotator park preset. */
  addParkPreset(preset) {
    const rot = state.hw.rotator;
    const presets = [...(rot.parkPresets || [])].filter((p) => p.name !== preset.name);
    presets.push(preset);
    this.patchIn('hw.rotator', { parkPresets: presets });
  },
  /** Remove a park preset by name (the 'Home' preset can't be removed). */
  removeParkPreset(name) {
    if (name === 'Home') return;
    const rot = state.hw.rotator;
    const presets = (rot.parkPresets || []).filter((p) => p.name !== name);
    const patch = { parkPresets: presets };
    if (rot.parkDefault === name) patch.parkDefault = 'Home';
    this.patchIn('hw.rotator', patch);
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

  /** Track many satellites at once (bulk "select all"), caching each TLE. */
  trackMany(list) {
    const set = new Set(state.tracked);
    const tleStore = { ...state.tleStore };
    for (const s of list) {
      if (!s || !s.id) continue;
      set.add(s.id);
      if (s.line1 && s.line2) tleStore[s.id] = { name: s.name, line1: s.line1, line2: s.line2 };
    }
    state = { ...state, tracked: [...set], tleStore };
    emit();
    persist();
  },

  /** Untrack many satellites at once (bulk "deselect all"). */
  untrackMany(ids) {
    const rm = new Set(ids);
    const tracked = state.tracked.filter((id) => !rm.has(id));
    const tleStore = { ...state.tleStore };
    for (const id of rm) delete tleStore[id];
    let selected = state.selected;
    if (selected !== 'MOON' && !tracked.includes(selected)) selected = tracked[0] ?? 'MOON';
    state = { ...state, tracked, tleStore, selected };
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

  /** Replace all settings from an imported object (backup restore), over defaults. */
  importSettings(obj) {
    if (!obj || typeof obj !== 'object') return false;
    state = deepMerge(structuredClone(DEFAULTS), obj);
    emit();
    persist();
    return true;
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
