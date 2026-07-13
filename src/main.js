import './style.css';
import { store } from './core/store.js';
import { parseCatalog } from './core/tle.js';
import { parseOem } from './core/oem.js';
import { subPoint, lookAngles, makeSatrec, tleAgeDays, subSolarPoint } from './core/propagate.js';
import { moonState, moonLook } from './core/moon.js';
import { planetState, raDecToAzEl, subPointOf } from './core/bodies.js';
import { precessToDate, dsoById, DSOS } from './core/dso.js';
import { predictPasses } from './core/passes.js';
import { scorePass } from './core/passScore.js';
import { computeReadiness } from './core/readiness.js';
import { normalizeMask, evaluateArc, maskElAt } from './core/horizonMask.js';
import { resolveProfile, tuning as radioTuning } from './core/radioProfiles.js';
import { createBlackbox } from './core/blackbox.js';
import { MotionController } from './core/motion.js';
import { THEMES, applyTheme } from './core/themes.js';
import { createUI, colorFor } from './views/ui.js';
import { Map2D } from './views/map2d.js';
import { Globe3D } from './views/globe3d.js';
import { PolarView } from './views/polar.js';

let ui, map2d, globe3d, polar;
let catalogById = new Map();
// User-loaded OEM ephemerides, kept apart from the TLE/OMM catalog so they
// survive group refreshes (which rebuild catalogById) and aren't hit by the
// online TLE freshness scheduler. Re-merged into the catalog after each fetch.
let oemById = new Map();

// Sun + planets shown on the sky views; metadata (name, colour, default-shown).
const PLANET_META = {
  SUN: { name: 'Sun', color: '#ffd23f', kind: 'sun', show: true },
  MERCURY: { name: 'Mercury', color: '#b0a08c', kind: 'planet', show: true },
  VENUS: { name: 'Venus', color: '#e8e3d0', kind: 'planet', show: true },
  MARS: { name: 'Mars', color: '#d9603b', kind: 'planet', show: true },
  JUPITER: { name: 'Jupiter', color: '#d8b48c', kind: 'planet', show: true },
  SATURN: { name: 'Saturn', color: '#e3d9a8', kind: 'planet', show: true },
  URANUS: { name: 'Uranus', color: '#9fe0e6', kind: 'planet', show: false },
  NEPTUNE: { name: 'Neptune', color: '#5b7cdf', kind: 'planet', show: false },
};
const DSO_COLOR = '#c792ea';

// Resolve a sky-target id ('SUN'..'NEPTUNE' or 'DSO:<id>') to a render entry.
function computeBody(id, date, observer) {
  const meta = PLANET_META[id];
  if (meta) {
    const ps = planetState(id, date);
    return { id, name: meta.name, color: meta.color, kind: meta.kind, look: raDecToAzEl(ps.ra, ps.dec, date, observer), sub: ps.sub, distanceAU: ps.distanceAU };
  }
  if (id.startsWith('DSO:')) {
    const d = dsoById.get(id.slice(4));
    if (!d) return null;
    const pc = precessToDate(d.ra, d.dec, date);
    return { id, name: d.name, color: DSO_COLOR, kind: 'dso', look: raDecToAzEl(pc.ra, pc.dec, date, observer), sub: subPointOf(pc.ra, pc.dec, date), dso: d };
  }
  return null;
}

// Derived/cached state for the selected satellite.
let selCache = { key: '', passes: [], arc: [] };

// Passes for every tracked (checked) satellite, merged and time-sorted for the
// Passes tab. Recomputed only when the tracked set / station / min-el changes.
let trackedPassesCache = { key: '', list: [] };
// Separate geometric windows used to drive the rotator. The visible pass list can
// intentionally hide the low horizon (e.g. 5°), but hardware must obey its own
// tracking minimum (often 0°) so AOS/LOS are not shortened by a display filter.
let rotatorPassesCache = [];

// HW connection flags (mirrored from main-process status events).
let rotConnected = false;
let radConnected = false;
let lastRotSend = 0;
let lastRadSend = 0;

// Smooth continuous-motion controller (SuperRot path). Streams velocity setpoints
// at its own high rate; a fast 10 Hz loop feeds it fresh targets + feedforward
// (the 1 Hz tick only decides *which* target and handles the views).
let motion = null;
let motionRunning = false;
// Time-warp preview: a viewing-time offset (ms) for scrubbing the map/globe/polar into
// the future or past. Renderer-local (resets to live on launch). Hardware tracking
// stays on real time — the offset only shifts what the visualisation shows.
let timeWarpOffset = 0;
let rotTelemetry = null; // last { az, el, azRate, elRate } reported by SuperRot firmware
let activeTrackId = null; // id the rotator is actively tracking (null when parked/idle)
let lastMissionKey = '', lastMissionSent = 0;

function publishRotatorMission(target, missionState) {
  const rot = store.get().hw.rotator;
  if (!rotConnected || rot.protocol !== 'superrot' || !window.pyro?.rotator?.mission) return;
  const key = `${target}|${missionState}`, nowMs = Date.now();
  if (key === lastMissionKey && nowMs - lastMissionSent < 5000) return;
  lastMissionKey = key; lastMissionSent = nowMs;
  window.pyro.rotator.mission(target || '-', missionState || 'idle');
}
let lastDrivenId = null; // last object the smooth controller was driven toward

// Session blackbox — flight recorder for commanded/actual pointing, Doppler and
// hardware events. Sampled once every blackboxIntervalMs while connected.
const blackbox = createBlackbox();
let lastBlackboxSample = 0;
let lastLoggedTrackId = null; // last activeTrackId written to the blackbox event log
const BLACKBOX_INTERVAL_MS = 2000;

window.addEventListener('error', (e) => console.error(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('unhandledrejection:', e.reason));

boot().catch((e) => console.error('boot failed:', e));

async function boot() {
  await store.hydrate();

  ui = createUI({
    refreshTLE,
    loadOem,
    updateTlesNow: () => ensureFreshTles(true),
    resetView: () => (store.get().view === '2d' ? map2d.resetView() : globe3d.focus(store.get().station.lat, store.get().station.lon)),
    connectRotator,
    // Park button parks to the configured default preset; parkTo lets the HW pane
    // park to any named preset; saveParkPreset captures the current position.
    parkRotator: () => parkToDefault(),
    parkTo: (preset) => parkToPreset(preset),
    saveParkPreset: (name) => {
      const az = rotTelemetry && Number.isFinite(rotTelemetry.az) ? rotTelemetry.az : motion.currentAz();
      const el = rotTelemetry && Number.isFinite(rotTelemetry.el) ? rotTelemetry.el : 0;
      store.addParkPreset({ name, az: Math.round(az * 10) / 10, el: Math.round(Math.max(0, el) * 10) / 10 });
    },
    stopRotator: () => { if (motionRunning) { motion.stop(); motionRunning = false; } else if (rotConnected) window.pyro.rotator.stop(); },
    // Run the firmware homing sequence (SuperRot 'H' — el endstop, az compass-zero).
    homeRotator: () => {
      if (!rotConnected) return;
      if (store.get().hw.rotator.autoMode !== 'off') store.patchIn('hw.rotator', { autoMode: 'off' });
      if (motionRunning) { motion.stop(); motionRunning = false; }
      window.pyro.rotator.home();
    },
    // Unwind the cable: drive azimuth to its 0-turn equivalent (same heading, no wrap).
    unwindRotator: () => {
      if (!rotConnected) return;
      if (store.get().hw.rotator.autoMode !== 'off') store.patchIn('hw.rotator', { autoMode: 'off' });
      if (motionRunning) { motion.stop(); motionRunning = false; }
      window.pyro.rotator.unwind();
    },
    // Calibration: capture the current telemetry as the true-north / level reference.
    captureCalibNorth: () => { if (rotTelemetry && Number.isFinite(rotTelemetry.az)) store.patchIn('hw.rotator', { azOffset: Math.round(rotTelemetry.az * 10) / 10 }); },
    captureCalibLevel: () => { if (rotTelemetry && Number.isFinite(rotTelemetry.el)) store.patchIn('hw.rotator', { elOffset: Math.round(rotTelemetry.el * 10) / 10 }); },
    // Multi-pass queue: commit the scheduler to one specific pass (and switch to
    // schedule mode so it takes effect); disarm to return to the automatic pick.
    armPass: (id, aosMs, losMs) => store.patchIn('hw.rotator', { armedPass: { id, aos: aosMs, los: losMs }, autoMode: 'schedule' }),
    disarmPass: () => store.patchIn('hw.rotator', { armedPass: null }),
    // Config sync: push the current speed limits, offsets and backlash to the firmware.
    pushRotatorConfig: async () => {
      const r = store.get().hw.rotator;
      const res = await window.pyro.rotator.config({
        maxVelAz: r.maxVelAz, maxVelEl: r.maxVelEl, elMax: r.elMax,
        azOffset: r.azOffset, elOffset: r.elOffset, backlashAz: r.backlashAz, backlashEl: r.backlashEl,
      });
      ui.hw.rotPill._set(rotConnected, res && res.ok ? 'Config sent to rotator' : 'Config: ' + ((res && res.error) || 'failed'));
    },
    // Manual jog: take control (auto-track off) and nudge az/el by a step.
    jogRotator: (daz, del) => {
      if (!rotConnected) return;
      store.patchIn('hw.rotator', { autoMode: 'off' });
      if (motionRunning) { motion.stop(); motionRunning = false; }
      const az = rotTelemetry && Number.isFinite(rotTelemetry.az) ? rotTelemetry.az : 0;
      const el = rotTelemetry && Number.isFinite(rotTelemetry.el) ? rotTelemetry.el : 0;
      window.pyro.rotator.setAzEl(az + daz, Math.max(0, el + del));
    },
    connectRadio,
    // Time-warp scrubber: shift the visualisation time by N minutes (0 = live).
    setTimeWarp: (minutes) => { timeWarpOffset = (minutes || 0) * 60000; },
    // EME readout frequency (MHz).
    setEmeFreq: (mhz) => store.patch({ emeFreqMHz: Math.max(1, mhz || 144) }),
    // Manually paste in a TLE (2/3-line set) for a sat not in any Celestrak group.
    addManualTle: (text) => addManualTle(text),
    // Session blackbox: live stats for the recorder panel, plus export/clear.
    blackboxStats: () => blackbox.stats(),
    blackboxCSV: () => blackbox.toCSV(),
    blackboxJSON: () => blackbox.toJSON(),
    blackboxClear: () => { blackbox.clear(); blackbox.event('session', 'log cleared'); },
  });

  map2d = new Map2D(ui.view2d);
  globe3d = new Globe3D(ui.view3d);
  polar = mountPolar(ui.view2d); // polar overlay lives in the right panel info area? -> use separate mount
  map2d.onSelect = (id) => store.patch({ selected: id });
  globe3d.onSelect = (id) => store.patch({ selected: id });

  wireHardwareStatus();

  // The controller pushes setpoints straight to the rotator driver. A `stop`
  // command decelerates and holds; otherwise stream the continuous track setpoint.
  motion = new MotionController({
    send: (cmd) => {
      if (!rotConnected) return;
      if (cmd.stop) { window.pyro.rotator.stop(); return; }
      // cmd.az is free/continuous (shortest path, may be negative or >360) — send as-is,
      // plus the mount-alignment offset (sky → mount). The model stays in sky space.
      const off = store.get().hw.rotator;
      window.pyro.rotator.track(cmd.az + (off.azOffset || 0), cmd.el + (off.elOffset || 0), cmd.azRate, cmd.elRate);
    },
  });

  store.subscribe(onState);
  onState(store.get());

  await loadInitialTle();
  ensureFreshTles(false); // enforce the max-age policy on startup (online)
  // Re-check on an interval; the check is a cheap no-op when everything is fresh
  // or when offline. Keeps cached TLEs < maxAgeDays old for accurate tracking.
  setInterval(() => ensureFreshTles(false), 30 * 60 * 1000);

  // Roll the 48 h pass window forward so the scheduler always has upcoming passes.
  setInterval(() => recomputeTrackedPasses(), 15 * 60 * 1000);

  ui.setActiveView(store.get().view);
  setInterval(tick, 1000);
  setInterval(streamRotatorFast, 100); // 10 Hz SuperRot setpoint refresh

  // Space weather (planetary K-index): fetch now + hourly when online.
  fetchSpaceWeather();
  setInterval(fetchSpaceWeather, 60 * 60 * 1000);

  tick();
}

async function fetchSpaceWeather() {
  if (!navigator.onLine) { ui.setSpaceWeather({ ok: false }); return; }
  try {
    ui.setSpaceWeather(await window.pyro.space.weather());
  } catch {
    ui.setSpaceWeather({ ok: false });
  }
}

/* --------------------------- TLE freshness scheduler -------------------- */
// Keep cached/saved TLEs younger than the configured max age so SkyPhreak and
// SatDump both track with current elements. `force` ignores the auto setting and
// the freshness check (used by the manual "Update now" button).
async function ensureFreshTles(force = false) {
  const st = store.get();
  const sched = st.tleSched || { auto: true, maxAgeDays: 2 };
  if (!force && !sched.auto) { updateTleStatus(); return; }
  if (!navigator.onLine) { updateTleStatus(); return; } // offline — keep using cache
  const maxMs = (sched.maxAgeDays || 2) * 86400000;

  // Refresh the loaded group if its cached fetch is stale (or forced); that also
  // top-ups out-of-group persisted sats. Otherwise just top up stale persisted ones.
  let needGroup = force;
  if (!needGroup) {
    try {
      const cache = await window.pyro.tle.cache();
      const c = cache[st.group];
      needGroup = !c || Date.now() - c.fetchedAt > maxMs;
    } catch { needGroup = true; }
  }
  if (needGroup) await refreshTLE();
  else await refreshPersistedTles();
  updateTleStatus();
}

// Compute which tracked TLEs are stale (epoch older than max age) and push the
// freshness summary to the UI.
function updateTleStatus() {
  const st = store.get();
  const maxDays = (st.tleSched && st.tleSched.maxAgeDays) || 2;
  const stale = new Set();
  for (const id of st.tracked) {
    const s = catalogById.get(id);
    if (s && s.satrec && tleAgeDays(s.satrec) > maxDays) stale.add(id);
  }
  ui.setStaleIds(stale);
  ui.setTleStatus({ maxDays, stale: stale.size, auto: !!(st.tleSched && st.tleSched.auto), online: navigator.onLine });
}

/* ----------------------------- Polar mount ----------------------------- */
// The polar/radar view sits in the Info tab beneath the readouts so it stays
// visible alongside either map. It is created lazily into a dedicated host.
function mountPolar() {
  const host = document.createElement('div');
  host.id = 'polar-host';
  host.style.cssText = 'position:relative;height:240px;margin-top:8px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2);';
  return new PolarView(host);
}

/* ------------------------------- TLE load ------------------------------ */
async function loadInitialTle() {
  const group = store.get().group;
  try {
    const cache = await window.pyro.tle.cache();
    if (cache[group]) {
      // Load instantly from cache (offline-first); the freshness scheduler
      // (ensureFreshTles) handles refreshing per the max-age policy.
      applyTle(cache[group].text, cache[group].fetchedAt);
      return;
    }
  } catch { /* ignore */ }
  await refreshTLE();
}

async function refreshTLE() {
  const group = store.get().group;
  ui.setTleStamp('Fetching ' + group + '…');
  try {
    const res = await window.pyro.tle.fetch(group);
    applyTle(res.text, res.fetchedAt);
    refreshPersistedTles(); // top up tracked/favorite sats that aren't in this group
  } catch (e) {
    ui.setTleStamp('Fetch failed: ' + e.message + ' (using cache if available)');
    try {
      const cache = await window.pyro.tle.cache();
      if (cache[group]) applyTle(cache[group].text, cache[group].fetchedAt);
    } catch { /* ignore */ }
  }
}

// Download fresh TLEs (by NORAD id) for tracked/favorite sats that aren't in the
// loaded group, so persisted targets stay current when online. Silent offline.
let persistedRefreshing = false;
async function refreshPersistedTles() {
  if (persistedRefreshing) return;
  persistedRefreshing = true;
  try {
    await doRefreshPersistedTles();
  } finally {
    persistedRefreshing = false;
  }
}

async function doRefreshPersistedTles() {
  const st = store.get();
  const maxDays = st.tleSched?.maxAgeDays || 2;
  const groupIds = new Set(store.getCatalog().map((s) => s.noradId));
  const ids = new Set([...st.tracked, ...st.favorites.map((f) => f.id)]);
  let updated = false;
  for (const id of ids) {
    if (groupIds.has(id)) continue; // already refreshed by the group fetch
    if (oemById.has(id)) continue; // OEM ephemeris — not a Celestrak TLE
    const cur = catalogById.get(id);
    if (cur && cur.satrec && tleAgeDays(cur.satrec) <= maxDays) continue; // cached copy still fresh enough
    try {
      const res = await window.pyro.tle.fetchOne(id);
      const parsed = parseCatalog(res.text);
      const s = parsed[0];
      if (s) {
        store.setStoredTle(id, { name: s.name, line1: s.line1, line2: s.line2 });
        catalogById.set(id, s);
        updated = true;
      }
    } catch { /* offline or not found — keep the cached TLE */ }
  }
  if (updated) {
    selCache.key = '';
    trackedPassesCache.key = '';
    onState(store.get());
    ui.renderList();
  }
}

// Add pasted TLE text to the catalog: parse, cache (tracked so it persists offline),
// track and select. Returns the number of objects added.
function addManualTle(text) {
  const sats = parseCatalog(text || '');
  if (!sats.length) { ui.setTleStamp('No valid TLE/OMM found in the pasted text'); return 0; }
  for (const s of sats) {
    catalogById.set(s.noradId, s);
    if (!store.get().tracked.includes(s.noradId)) store.toggleTracked(s.noradId, s); // caches its TLE
  }
  store.patch({ selected: sats[0].noradId });
  selCache.key = '';
  trackedPassesCache.key = '';
  ui.setTleStamp(`Added ${sats.length} pasted object${sats.length > 1 ? 's' : ''}`);
  ui.renderList();
  return sats.length;
}

function applyTle(text, fetchedAt) {
  const sats = parseCatalog(text);
  catalogById = new Map(sats.map((s) => [s.noradId, s]));

  // Keep cached TLEs (favorites + tracked) fresh from this group, then make sure
  // every persisted satellite is trackable even if it isn't in the current group.
  store.refreshFavoriteTles(catalogById);
  store.refreshTrackedTles(catalogById);
  const cached = [
    ...store.get().favorites.map((f) => ({ id: f.id, name: f.name, line1: f.line1, line2: f.line2 })),
    ...Object.entries(store.get().tleStore || {}).map(([id, t]) => ({ id, name: t.name, line1: t.line1, line2: t.line2 })),
  ];
  for (const c of cached) {
    if (!catalogById.has(c.id) && c.line1 && c.line2) {
      const satrec = makeSatrec(c.line1, c.line2);
      if (satrec) catalogById.set(c.id, { name: c.name, noradId: c.id, line1: c.line1, line2: c.line2, satrec });
    }
  }

  // Force a pass recompute on the onState that setCatalog will emit, now that
  // the catalog (and thus the selected satrec) is actually available.
  selCache.key = '';
  trackedPassesCache.key = '';
  store.setCatalog(sats);
  mergeOemIntoCatalog(); // re-add user OEMs the group fetch just overwrote
  ui.setTleStamp(`${sats.length} objects · updated ${new Date(fetchedAt).toLocaleString()}`);
  ui.renderList();
}

/* -------------------------------- OEM load ----------------------------- */
// Load one or more CCSDS OEM ephemeris files, parse them, and merge them into
// the catalog as trackable objects (id prefixed "OEM:"). Unlike TLE/OMM these
// are tabulated state vectors propagated by interpolation, not SGP4.
async function loadOem() {
  let files;
  try {
    files = await window.pyro.oem.load();
  } catch (e) {
    ui.setTleStamp('OEM load failed: ' + e.message);
    return;
  }
  if (!files || !files.length) return; // cancelled

  let firstId = null;
  let added = 0;
  for (const f of files) {
    const entries = parseOem(f.text);
    for (const e of entries) {
      oemById.set(e.noradId, e);
      if (!firstId) firstId = e.noradId;
      added++;
    }
  }
  if (!added) { ui.setTleStamp('OEM: no usable ephemeris found in file'); return; }

  mergeOemIntoCatalog();
  if (firstId) {
    if (!store.get().tracked.includes(firstId)) store.toggleTracked(firstId, null);
    store.patch({ selected: firstId });
  }
  selCache.key = '';
  trackedPassesCache.key = '';
  ui.setTleStamp(`${added} OEM ephemeri${added === 1 ? 's' : 'des'} loaded`);
  ui.renderList();
}

// Surface the loaded OEMs in both the catalog list and the lookup map, keeping
// them ahead of the TLE/OMM entries and never duplicated.
function mergeOemIntoCatalog() {
  for (const e of oemById.values()) catalogById.set(e.noradId, e);
  if (!oemById.size) return;
  const base = store.getCatalog().filter((s) => !s.isOem);
  store.setCatalog([...oemById.values(), ...base]);
}

/* ----------------------------- State changes --------------------------- */
let lastView = null;
let lastMapStyle = null;
let lastTheme = null;
function onState(state) {
  ui.renderList();
  ui.syncAutoMode(); // keep the on-map track buttons + HW dropdown in sync
  ui.applyLayout(state); // collapsible side panels
  if (state.view !== lastView) {
    ui.setActiveView(state.view);
    lastView = state.view;
  }
  if (state.mapStyle !== lastMapStyle) {
    lastMapStyle = state.mapStyle;
    map2d.setStyle(state.mapStyle);
    globe3d.setStyle(state.mapStyle);
  }
  // Theme: set the CSS vars; the 2D/polar canvases pick the palette up on their
  // next repaint, the globe re-applies its materials explicitly. The key includes the
  // custom accent so tweaking it (while on the 'custom' theme) re-applies live.
  const themeKey = state.theme + (state.theme === 'custom' ? '|' + JSON.stringify(state.customTheme) : '');
  if (themeKey !== lastTheme) {
    lastTheme = themeKey;
    applyTheme(state.theme, state.customTheme);
    globe3d.refreshTheme();
    map2d.draw(map2d.frame);
  }
  // Recompute passes when the selection, station, or min elevation changes.
  const key = `${state.selected}|${state.station.lat}|${state.station.lon}|${state.station.altKm}|${state.minEl}|${state.hw.rotator.elMax}`;
  if (key !== selCache.key) {
    selCache.key = key;
    recomputeSelected();
  }
  // Recompute the all-tracked pass list when the checked set (or location) changes.
  const tkey = `${[...state.tracked].sort().join(',')}|${state.station.lat}|${state.station.lon}|${state.station.altKm}|${state.minEl}|${state.hw.rotator.minEl}`;
  if (tkey !== trackedPassesCache.key) {
    trackedPassesCache.key = tkey;
    recomputeTrackedPasses();
  }
}

function recomputeSelected() {
  const state = store.get();
  const sat = catalogById.get(state.selected);
  if (!sat) {
    selCache.passes = [];
    selCache.arc = [];
    selCache.mountArc = [];
    selCache.willFlip = false;
    return;
  }
  const observer = state.station;
  selCache.passes = predictPasses(sat.satrec, observer, { minEl: state.minEl, hours: 48, count: 12 });

  // Polar arc: sample the current or next pass from AOS to LOS.
  const now = Date.now();
  const pass = selCache.passes.find((p) => p.los.getTime() >= now) || null;
  selCache.arc = [];
  if (pass) {
    const a = pass.aos.getTime();
    const b = pass.los.getTime();
    const steps = 60;
    for (let i = 0; i <= steps; i++) {
      const look = lookAngles(sat.satrec, new Date(a + ((b - a) * i) / steps), observer);
      if (look && look.el >= 0) selCache.arc.push({ az: look.az, el: look.el });
    }
  }

  // Flip-over preview: if the mount can flip (elMax >= 135), walk the pass arc
  // through resolveMount from its AOS azimuth. Where the shortest-motion solution
  // goes "over the top" (mount el > 90) the pass will flip — flag it and keep the
  // mount arc so the polar view can draw the over-the-top path.
  const elMax = state.hw.rotator.elMax || 90;
  selCache.mountArc = [];
  selCache.willFlip = false;
  if (elMax >= 135 && selCache.arc.length) {
    let ref = selCache.arc[0].az;
    for (const p of selCache.arc) {
      const m = resolveMount(p.az, p.el, ref, elMax);
      ref = m.az;
      selCache.mountArc.push(m);
      if (m.el > 90.5) selCache.willFlip = true;
    }
  }
}

// Build the merged, time-sorted pass list across all tracked satellites. Each entry
// carries its satellite's name/colour so the Passes tab can label and colour rows.
function recomputeTrackedPasses() {
  const state = store.get();
  const observer = state.station;
  const out = [];
  const rotatorOut = [];
  const mask = state.horizonMaskOn ? normalizeMask(state.horizonMask) : [];
  for (const id of state.tracked) {
    const sat = catalogById.get(id);
    if (!sat) continue;
    const passes = predictPasses(sat.satrec, observer, { minEl: state.minEl, hours: 48, count: 8 });
    const color = colorFor(id, state.tracked);
    const controlPasses = predictPasses(sat.satrec, observer, { minEl: state.hw.rotator.minEl ?? 0, hours: 48, count: 8 });
    for (const p of controlPasses) rotatorOut.push({ id, name: sat.name, pass: p });
    for (const p of passes) {
      // Sample the sky-track (az/el) AOS→LOS for the row's mini polar plot.
      const a = p.aos.getTime();
      const b = p.los.getTime();
      const steps = 24;
      const arc = [];
      for (let i = 0; i <= steps; i++) {
        const look = lookAngles(sat.satrec, new Date(a + ((b - a) * i) / steps), observer);
        if (look) arc.push({ az: look.az, el: Math.max(0, look.el) });
      }
      // Optical visibility: at the pass peak, is the satellite sunlit while the
      // observer is in darkness (civil twilight or later)? Those are the passes you
      // can actually see (ISS, Starlink trains, flares).
      const tPeak = p.peakTime || new Date((p.aos.getTime() + p.los.getTime()) / 2);
      const sunLook = computeBody('SUN', tPeak, observer);
      const satSub = subPoint(sat.satrec, tPeak);
      const sunSub = subSolarPoint(tPeak);
      const visible = !!(sunLook && sunLook.look.el < -6 && satSub && satSunlit(satSub, sunSub) && p.maxEl >= 10);

      // Sun separation at the peak (for the quality score + readiness Sun-clearance).
      let sunSepDeg = null;
      const peakLook = lookAngles(sat.satrec, tPeak, observer);
      if (sunLook && sunLook.look && peakLook) sunSepDeg = angSep(peakLook.az, peakLook.el, sunLook.look.az, sunLook.look.el);

      // Horizon mask: how much of the sky-arc actually clears local obstructions.
      const horizon = evaluateArc(mask, arc, p.maxEl);

      const rot = state.hw.rotator;
      const sc = scorePass(p, {
        visible, tleAgeDays: tleAgeDays(sat.satrec), elMax: rot.elMax,
        sunAvoid: rot.sunAvoid, sunAvoidDeg: rot.sunAvoidDeg, sunSepDeg,
        obstructed: horizon.obstructed, blockedAtPeak: horizon.blockedAtPeak,
      });

      out.push({
        id, name: sat.name, color, pass: p, arc, visible, sunSepDeg,
        score: sc.score, scoreParts: sc.parts,
        obstructed: horizon.obstructed, peakClearanceDeg: horizon.peakClearanceDeg,
        blockedAtPeak: horizon.blockedAtPeak, clearFraction: horizon.clearFraction,
      });
    }
  }
  out.sort((a, b) => a.pass.aos - b.pass.aos);
  trackedPassesCache.list = out;
  rotatorOut.sort((a, b) => a.pass.aos - b.pass.aos);
  rotatorPassesCache = rotatorOut;
}

// Is a satellite (given its sub-point + altitude) in sunlight rather than Earth's
// shadow? Tests the shadow cylinder along the Earth→Sun axis in an Earth-fixed frame.
function satSunlit(satSub, sunSub) {
  const RAD = Math.PI / 180;
  const R = 6371;
  const rs = R + (satSub.altKm || 0);
  const la = satSub.lat * RAD, lo = satSub.lon * RAD;
  const p = [rs * Math.cos(la) * Math.cos(lo), rs * Math.cos(la) * Math.sin(lo), rs * Math.sin(la)];
  const sla = sunSub.lat * RAD, slo = sunSub.lon * RAD;
  const s = [Math.cos(sla) * Math.cos(slo), Math.cos(sla) * Math.sin(slo), Math.sin(sla)];
  const dot = p[0] * s[0] + p[1] * s[1] + p[2] * s[2];
  if (dot >= 0) return true; // on the sunlit side of the planet
  const perp = Math.sqrt(Math.max(0, p[0] ** 2 + p[1] ** 2 + p[2] ** 2 - dot * dot));
  return perp > R; // clears the shadow cylinder
}

/* -------------------------------- Tick --------------------------------- */
function tick() {
  const state = store.get();
  const live = timeWarpOffset === 0;
  // Visualisation time (may be warped for preview); hardware always uses real time.
  const date = new Date(Date.now() + timeWarpOffset);
  const observer = state.station;

  const sats = [];
  for (const id of state.tracked) {
    const sat = catalogById.get(id);
    if (!sat) continue;
    const sub = subPoint(sat.satrec, date);
    if (!sub) continue;
    const look = lookAngles(sat.satrec, date, observer);
    const entry = {
      id,
      name: sat.name,
      satrec: sat.satrec,
      color: colorFor(id, state.tracked),
      selected: id === state.selected,
      sub,
      look,
    };
    if (entry.selected) entry.arc = selCache.arc;
    sats.push(entry);
  }

  // Moon: true position, look angles, distance and phase.
  const ms = moonState(date);
  const moon = {
    sub: ms.sub,
    distanceKm: ms.distanceKm,
    look: moonLook(ms.eciKm, date, observer),
    illum: ms.illum,
    phaseName: ms.phaseName,
    selected: state.selected === 'MOON',
  };

  // Sky bodies: the default-shown Sun/planets, plus whatever sky target is
  // selected (an outer planet or a deep-sky object).
  const need = new Set(Object.keys(PLANET_META).filter((k) => PLANET_META[k].show));
  if (PLANET_META[state.selected]) need.add(state.selected);
  // Deep-sky objects: shown all-at-once via the master toggle (else hidden).
  if (state.showDso) for (const d of DSOS) need.add('DSO:' + d.id);
  else if ((state.selected || '').startsWith('DSO:')) need.add(state.selected);
  const bodies = [];
  for (const id of need) {
    const b = computeBody(id, date, observer);
    if (b) { b.selected = state.selected === id; bodies.push(b); }
  }

  const frame = {
    date, station: observer, sats, moon, bodies,
    mapShow: { moon: state.showMoon, planets: state.showPlanets },
    // Flip-over preview for the polar view (selected sat only).
    flip: selCache.willFlip ? { arc: selCache.mountArc } : null,
    // Live rotor pointing (actual vs commanded + trail) for the polar view.
    rotor: buildRotorFrame(state.hw.rotator.azOffset || 0, state.hw.rotator.elOffset || 0),
  };

  // Follow-satellite: keep the active view centred on the selected satellite.
  if (state.followSat) {
    const sel = sats.find((s) => s.selected);
    if (sel && sel.sub) {
      if (state.view === '2d') map2d.centerOn(sel.sub.lon, sel.sub.lat);
      else globe3d.followPoint(sel.sub.lat, sel.sub.lon);
    }
  }

  if (state.view === '2d') map2d.draw(frame);
  else globe3d.draw(frame);
  polar.draw(frame);
  ensurePolarMounted();

  ui.updateClock(date, timeWarpOffset);
  updateSelectedInfo(frame, date);
  updateReadiness();
  ui.updatePasses(trackedPassesCache.list, Date.now());

  // Live elevations for the Sky-list chips — only computed while that tab is open.
  if (ui.isSkyActive()) {
    const skyStatus = { MOON: moon.look ? moon.look.el : null };
    for (const id of Object.keys(PLANET_META)) { const b = computeBody(id, date, observer); if (b) skyStatus[id] = b.look.el; }
    for (const d of DSOS) { const b = computeBody('DSO:' + d.id, date, observer); if (b) skyStatus['DSO:' + d.id] = b.look.el; }
    ui.updateSky(skyStatus);
  }
  updateTleStatus();
  checkPassNotifications();

  driveHardware(frame, date, live);
}

// Fire a desktop notification a configurable lead time before a tracked pass rises.
const notifiedPasses = new Set();
let alertAudioContext = null;

// Generate a short offline two-tone cue instead of loading an audio asset.
function playPassAlert(style = store.get().notifySoundStyle || 'chime') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    alertAudioContext ||= new AudioCtx();
    if (alertAudioContext.state === 'suspended') alertAudioContext.resume();
    const start = alertAudioContext.currentTime + 0.02;
    const patterns = {
      chime: [[660, 0, 0.16], [880, 0.2, 0.28]],
      radar: [[520, 0, 0.1], [520, 0.18, 0.1], [780, 0.36, 0.18]],
      urgent: [[880, 0, 0.14], [660, 0.18, 0.14], [880, 0.36, 0.14], [1040, 0.54, 0.25]],
      sonar: [[360, 0, 0.5], [540, 0.55, 0.5]],
      soft: [[440, 0, 0.22], [554, 0.24, 0.22], [659, 0.48, 0.35]],
      beacon: [[740, 0, 0.08], [740, 0.12, 0.08], [740, 0.24, 0.08], [980, 0.42, 0.2]],
      sparkle: [[784, 0, 0.1], [988, 0.12, 0.1], [1175, 0.24, 0.22]],
      descending: [[880, 0, 0.18], [660, 0.2, 0.18], [440, 0.4, 0.3]],
      digital: [[600, 0, 0.06], [900, 0.1, 0.06], [600, 0.2, 0.06], [1100, 0.3, 0.18]],
      double: [[700, 0, 0.2], [700, 0.3, 0.28]],
      low: [[260, 0, 0.25], [330, 0.28, 0.35]],
      motor: [[320, 0, 0.08], [380, 0.09, 0.08], [450, 0.18, 0.08], [540, 0.27, 0.2]],
      lock: [[880, 0, 0.07], [1100, 0.1, 0.16]],
      computer: [[659, 0, 0.08], [988, 0.1, 0.08], [1319, 0.2, 0.16]], // ship-computer preamble
    };
    (patterns[style] || patterns.chime).forEach(([frequency, offset, duration]) => {
      const at = start + offset;
      const oscillator = alertAudioContext.createOscillator();
      const gain = alertAudioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      oscillator.connect(gain).connect(alertAudioContext.destination);
      oscillator.start(at);
      oscillator.stop(at + duration + 0.02);
    });
  } catch (err) {
    console.warn('Unable to play pass alert', err);
  }
}

// Web Speech exposes no gender metadata, so "automatic female" matches commonly
// female-named system voices and falls back gracefully.
const FEMALE_VOICE = /aria|ava|emma|jenny|joanna|karen|kendra|kimberly|linda|michelle|moira|salli|samantha|susan|tessa|victoria|zira|female/i;
function pickVoice(st) {
  const voices = window.speechSynthesis.getVoices();
  return st.notifyVoiceURI === '__female__'
    ? (voices.find((v) => FEMALE_VOICE.test(v.name)) || voices.find((v) => /^en[-_]/i.test(v.lang)) || voices[0])
    : voices.find((v) => v.voiceURI === st.notifyVoiceURI);
}

// Apply voice + delivery to an utterance. Robotic mode forces a flat, deep,
// deliberate "ship computer" cadence (Subnautica-style) over the rate/pitch sliders.
function configureVoice(utterance, st) {
  const voice = pickVoice(st);
  if (voice) utterance.voice = voice;
  if (st.notifyVoiceRobotic) {
    utterance.rate = 0.86;
    utterance.pitch = 0.32;
  } else {
    utterance.rate = Math.min(2, Math.max(0.5, st.notifyVoiceRate || 0.95));
    utterance.pitch = Math.min(2, Math.max(0, st.notifyVoicePitch ?? 1));
  }
  utterance.volume = Math.min(1, Math.max(0, st.notifyVoiceVolume ?? 1));
}

// Speak the utterance — in robotic mode, precede it with the computer chime so the
// words land just after the "attention" tone, like a submarine PDA.
function speakUtterance(utterance, st) {
  window.speechSynthesis.cancel();
  if (st.notifyVoiceRobotic) {
    playPassAlert('computer');
    setTimeout(() => window.speechSynthesis.speak(utterance), 340);
  } else {
    window.speechSynthesis.speak(utterance);
  }
}

function speakPassAlert(pass, mins) {
  if (!('speechSynthesis' in window)) return;
  const st = store.get();
  const duration = Math.max(1, Math.round(pass.pass.durationS / 60));
  const values = {
    satellite: pass.name,
    minutes: mins,
    minuteWord: mins === 1 ? 'minute' : 'minutes',
    duration,
    durationWord: duration === 1 ? 'minute' : 'minutes',
    maxElevation: Math.round(pass.pass.maxEl),
    visibility: pass.visible ? 'This should be a visible pass.' : 'This pass is not expected to be optically visible.',
  };
  const fallback = '{satellite} will rise in {minutes} {minuteWord}. Maximum elevation {maxElevation} degrees.';
  const message = (st.notifyVoiceTemplate || fallback).replace(/\{(satellite|minutes|minuteWord|duration|durationWord|maxElevation|visibility)\}/g, (_, key) => values[key]);
  const utterance = new SpeechSynthesisUtterance(message);
  configureVoice(utterance, st);
  speakUtterance(utterance, st);
}

window.playPassAlert = playPassAlert;
window.testPassVoice = () => speakPassAlert({
  name: 'International Space Station', visible: true,
  pass: { durationS: 540, maxEl: 67 },
}, store.get().notifyLead || 5);

let lastRotatorAudioConnected = null;
let lastRotatorAudioState = 'idle';
function playRotatorCue(event) {
  const st = store.get();
  if (!st.rotatorSounds || st.notifySound === false) return;
  const styles = {
    connect: st.rotatorConnectSound || 'digital',
    disconnect: st.rotatorDisconnectSound || 'low',
    track: st.rotatorTrackSound || 'beacon',
    park: st.rotatorParkSound || 'soft',
  };
  playPassAlert(styles[event]);
}

function updateRotatorAudioState(next) {
  if (next === lastRotatorAudioState) return;
  const previous = lastRotatorAudioState;
  lastRotatorAudioState = next;
  if (next === 'tracking' || next === 'preslew') playRotatorCue('track');
  else if (next === 'parked' && previous !== 'idle') playRotatorCue('park');
}

function speakLifecycleAlert(pass, event) {
  if (!('speechSynthesis' in window)) return;
  const messages = {
    aos: `${pass.name} is now above the horizon. Acquisition of signal.`,
    peak: `${pass.name} is near maximum elevation, ${Math.round(pass.pass.maxEl)} degrees.`,
    los: `${pass.name} pass complete. Loss of signal.`,
  };
  const message = messages[event];
  if (!message) return;
  const st = store.get();
  const utterance = new SpeechSynthesisUtterance(message);
  configureVoice(utterance, st);
  speakUtterance(utterance, st);
}

function checkPassNotifications() {
  const st = store.get();
  if (!st.notifyPasses || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const now = Date.now();
  const lead = (st.notifyLead || 5) * 60000;
  for (const p of trackedPassesCache.list) {
    const aos = p.pass.aos.getTime();
    const los = p.pass.los.getTime();
    const peak = aos + (los - aos) / 2;
    const key = p.id + '@' + aos;
    if (aos > now && aos - now <= lead && !notifiedPasses.has(key)) {
      notifiedPasses.add(key);
      const mins = Math.max(1, Math.round((aos - now) / 60000));
      new Notification(`${p.name} rising`, {
        body: `AOS in ~${mins} min · max ${p.pass.maxEl}°${p.visible ? ' · visible pass' : ''}`,
      });
      if (st.notifySound !== false) playPassAlert();
      if (st.notifyVoice) speakPassAlert(p, mins);
    }
    const lifecycle = [
      ['aos', aos, st.notifyAos, st.notifyAosSound, `${p.name} is rising`, 'Acquisition of signal'],
      ['peak', peak, st.notifyPeak, st.notifyPeakSound, `${p.name} at peak elevation`, `Maximum elevation ${Math.round(p.pass.maxEl)}°`],
      ['los', los, st.notifyLos, st.notifyLosSound, `${p.name} pass complete`, 'Loss of signal'],
    ];
    for (const [event, time, enabled, sound, title, body] of lifecycle) {
      const eventKey = `${key}:${event}`;
      // The tick runs every second; the wider window also tolerates brief sleep/resume.
      if (enabled && now >= time && now - time < 15000 && !notifiedPasses.has(eventKey)) {
        notifiedPasses.add(eventKey);
        new Notification(title, { body });
        if (st.notifySound !== false) playPassAlert(sound);
        if (st.notifyVoice) speakLifecycleAlert(p, event);
      }
    }
  }
  if (notifiedPasses.size > 300) notifiedPasses.clear();
}

// Pre-pass readiness — evaluate the focus pass (the next upcoming pass for the
// selected sat, else the soonest upcoming one) against the live station/hardware
// signals and push the Ready/Attention result to the hero. Mirrors ui's focus-pass
// choice so the pill matches the NOW/NEXT card.
function updateReadiness() {
  const state = store.get();
  const now = Date.now();
  const list = trackedPassesCache.list;
  const focus = list.find((it) => it.id === state.selected && it.pass.los.getTime() >= now)
    || list.find((it) => it.pass.los.getTime() >= now);
  if (!focus) { ui.setReadiness(null); return; }

  const rot = state.hw.rotator;
  const sat = catalogById.get(focus.id);
  const wrapAz = rotTelemetry && Number.isFinite(rotTelemetry.az) ? rotTelemetry.az
    : (motionRunning ? motion.currentAz() : null);
  const result = computeReadiness({
    station: state.station,
    tleAgeDays: sat && sat.satrec ? tleAgeDays(sat.satrec) : null,
    maxAgeDays: (state.tleSched && state.tleSched.maxAgeDays) || 2,
    rotRequired: (rot.autoMode || 'off') !== 'off',
    rotConnected,
    homed: rotTelemetry && Number.isFinite(rotTelemetry.homed) ? rotTelemetry.homed : null,
    maxEl: focus.pass.maxEl,
    elMax: rot.elMax,
    radConnected,
    dopplerOn: !!state.hw.radio.doppler,
    wrapAz,
    wrapMaxDeg: rot.wrapMaxDeg,
    sunAvoid: !!rot.sunAvoid,
    sunAvoidDeg: rot.sunAvoidDeg,
    sunSepDeg: focus.sunSepDeg,
    horizonActive: !!state.horizonMaskOn && Array.isArray(state.horizonMask) && state.horizonMask.length > 0,
    obstructed: focus.obstructed,
    blockedAtPeak: focus.blockedAtPeak,
    peakClearanceDeg: focus.peakClearanceDeg,
  });
  ui.setReadiness({ ...result, passId: focus.id, passName: focus.name });
}

// Insert the polar canvas host into the Info tab once it exists in the DOM.
function ensurePolarMounted() {
  if (polar._mounted) return;
  const infoPane = document.querySelector('.tabpane'); // first pane = info
  if (infoPane && polar.container && !document.getElementById('polar-host')) {
    infoPane.appendChild(polar.container);
    polar._mounted = true;
    polar._resize();
  }
}

// EME (Moon-bounce) metrics for a given frequency: two-way free-space path loss,
// self-echo Doppler (from the topocentric range rate) and a distance-degradation
// figure relative to perigee. Libration/sky-noise degradation are not modelled.
function computeEme(date, observer, moonLk, ms, freqMHz) {
  const C = 299792.458; // km/s
  const rng = moonLk.rangeKm;
  const dt = 30; // s — finite-difference the topocentric range for range rate
  const later = new Date(date.getTime() + dt * 1000);
  const ms2 = moonState(later);
  const rng2 = moonLook(ms2.eciKm, later, observer).rangeKm;
  const rangeRate = (rng2 - rng) / dt; // km/s (+ = receding)
  const fMHz = freqMHz || 144;
  const dopplerHz = -2 * (rangeRate / C) * (fMHz * 1e6); // two-way echo Doppler
  const fspl = 20 * Math.log10(rng) + 20 * Math.log10(fMHz) + 32.44; // one-way, dB
  const perigee = 356500; // km
  return {
    freqMHz: fMHz,
    rangeKm: rng,
    dopplerHz,
    fsplOneWay: fspl,
    echoPathLoss: 2 * fspl, // two-way free space (excludes Moon reflection loss)
    declination: ms.dec,
    degradationDb: 40 * Math.log10(rng / perigee), // excess two-way loss vs perigee
  };
}

// Describe the selected sky target (Moon/Sun/planet/DSO) for the Info panel.
function buildSelBody(frame) {
  const sel = store.get().selected;
  if (sel === 'MOON') {
    const m = frame.moon;
    const ms = moonState(frame.date);
    const eme = computeEme(frame.date, frame.station, m.look, ms, store.get().emeFreqMHz);
    return {
      name: 'Moon', kind: 'moon', az: m.look.az, el: m.look.el,
      extra: [['Distance', Math.round(m.distanceKm).toLocaleString() + ' km'], ['Illumination', Math.round(m.illum * 100) + '%'], ['Phase', m.phaseName]],
      eme,
    };
  }
  const b = frame.bodies.find((x) => x.id === sel);
  if (!b) return null;
  const extra = [];
  if (b.kind === 'dso') {
    const d = b.dso;
    extra.push(['Type', d.type], ['Magnitude', d.mag != null ? String(d.mag) : '—'], ['RA', fmtRA(d.ra)], ['Dec', d.dec.toFixed(2) + '°']);
  } else {
    extra.push(['Distance', b.distanceAU.toFixed(3) + ' AU'], ['Light time', fmtLightTime(b.distanceAU)]);
  }
  return { name: b.name, kind: b.kind, az: b.look.az, el: b.look.el, extra };
}

function updateSelectedInfo(frame, date) {
  const state = store.get();
  const selBody = buildSelBody(frame);
  if (selBody) { ui.updateInfo(null, frame.moon, selBody); return; }
  const sat = catalogById.get(state.selected);
  if (!sat) { ui.updateInfo(null, frame.moon, null); return; }
  const sub = subPoint(sat.satrec, date);
  const look = lookAngles(sat.satrec, date, state.station);
  if (!sub || !look) { ui.updateInfo(null, frame.moon, null); return; }

  const aboveHorizon = look.el >= 0;
  const now = date.getTime();
  let statusText = 'No upcoming pass';
  const cur = selCache.passes.find((p) => now >= p.aos.getTime() && now <= p.los.getTime());
  const next = selCache.passes.find((p) => p.aos.getTime() > now);
  if (cur) statusText = 'Visible · LOS in ' + countdown(cur.los.getTime() - now);
  else if (next) statusText = 'AOS in ' + countdown(next.aos.getTime() - now);

  const downlinkHz = state.hw.radio.downlinkHz;
  const observedHz = downlinkHz * look.dopplerFactor;
  const ageDays = tleAgeDays(sat.satrec);
  const maxDays = (state.tleSched && state.tleSched.maxAgeDays) || 2;

  ui.updateInfo({
    name: sat.name,
    noradId: sat.noradId,
    lat: sub.lat, lon: sub.lon, altKm: sub.altKm, velocityKmS: sub.velocityKmS,
    az: look.az, el: look.el, rangeKm: look.rangeKm,
    aboveHorizon, statusText,
    tleAgeDays: ageDays, tleStale: ageDays > maxDays,
    dopplerHz: observedHz - downlinkHz,
    observedHz,
  }, frame.moon, null);
}

function fmtRA(deg) {
  const h = deg / 15;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${hh}h ${String(mm).padStart(2, '0')}m`;
}
function fmtLightTime(au) {
  const min = (au * 499.004784) / 60;
  return min < 60 ? min.toFixed(1) + ' min' : (min / 60).toFixed(2) + ' h';
}

/* ------------------------------ Hardware ------------------------------- */
function wireHardwareStatus() {
  window.pyro.rotator.onStatus((s) => {
    if (lastRotatorAudioConnected !== null && s.connected !== lastRotatorAudioConnected) {
      playRotatorCue(s.connected ? 'connect' : 'disconnect');
      blackbox.event('rotator', s.connected ? 'connected' : 'disconnected');
    }
    if (s.connected && s.error) blackbox.event('rotator-error', s.error);
    lastRotatorAudioConnected = s.connected;
    rotConnected = s.connected;
    if (s.telemetry) rotTelemetry = s.telemetry;
    if (!s.connected) rotTelemetry = null;
    // Closed-loop: keep the smooth controller anchored to the rotator's real azimuth,
    // mapped from mount space back to sky space via the alignment offset.
    if (motion) motion.setActual(s.connected && s.telemetry ? s.telemetry.az - (store.get().hw.rotator.azOffset || 0) : NaN);
    const where = s.path ? s.path : `${s.host || ''}:${s.port || ''}`;
    ui.hw.rotPill._set(s.connected, s.connected ? `Rotator connected ${where}` : (s.error ? 'Rotator: ' + s.error : 'Rotator disconnected'));
    ui.hw.rotConnect.textContent = s.connected ? 'Disconnect' : 'Connect';
    ui.setRotorConnected(s.connected); // on-map rotor light
  });
  window.pyro.radio.onStatus((s) => {
    if (s.connected !== radConnected) blackbox.event('radio', s.connected ? 'connected' : 'disconnected');
    radConnected = s.connected;
    ui.hw.radPill._set(s.connected, s.connected ? `Radio connected ${s.host || ''}:${s.port || ''}` : (s.error ? 'Radio: ' + s.error : 'Radio disconnected'));
    ui.hw.radConnect.textContent = s.connected ? 'Disconnect' : 'Connect';
  });
}

async function connectRotator() {
  if (rotConnected) {
    if (motionRunning) { motion.stop(); motionRunning = false; }
    await window.pyro.rotator.disconnect();
    return;
  }
  const rot = store.get().hw.rotator;
  const conf =
    rot.protocol === 'superrot'
      ? { protocol: 'superrot', transport: rot.transport, host: rot.host, port: rot.port, path: rot.path, baud: rot.baud }
      : { protocol: 'hamlib', host: rot.host, port: rot.port };
  const r = await window.pyro.rotator.connect(conf);
  if (!r.ok) ui.hw.rotPill._set(false, 'Rotator: ' + (r.error || 'failed'));
}

async function connectRadio() {
  if (radConnected) { await window.pyro.radio.disconnect(); return; }
  const { host, port } = store.get().hw.radio;
  const r = await window.pyro.radio.connect(host, port);
  if (!r.ok) ui.hw.radPill._set(false, 'Radio: ' + (r.error || 'failed'));
}

// The selected rotator/radio target: a satellite, the Moon, a planet, or a DSO.
function activeTarget(frame) {
  const state = store.get();
  if (state.selected === 'MOON') return { id: 'MOON', name: 'Moon', look: frame.moon.look };
  const b = frame.bodies.find((x) => x.id === state.selected);
  if (b) return { id: b.id, name: b.name, look: b.look };
  const s = frame.sats.find((x) => x.selected);
  return s ? { id: s.id, name: s.name, look: s.look } : null;
}

// Look angle of any target id at an arbitrary instant (for velocity feedforward).
function sampleTargetLook(id, date) {
  const observer = store.get().station;
  if (id === 'MOON') {
    const ms = moonState(date);
    return moonLook(ms.eciKm, date, observer);
  }
  if (PLANET_META[id] || (id || '').startsWith('DSO:')) {
    const b = computeBody(id, date, observer);
    return b ? b.look : null;
  }
  const sat = catalogById.get(id);
  return sat ? lookAngles(sat.satrec, date, observer) : null;
}

const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;

// Great-circle angular separation (degrees) between two az/el look directions.
function angSep(az1, el1, az2, el2) {
  const r = Math.PI / 180;
  const c = Math.sin(el1 * r) * Math.sin(el2 * r) + Math.cos(el1 * r) * Math.cos(el2 * r) * Math.cos((az1 - az2) * r);
  return Math.acos(Math.min(1, Math.max(-1, c))) / r;
}

// Rolling buffer of recent actual rotor positions (sky space) for the polar trail.
let rotorTrail = [];

// Snapshot for the polar view: where the mount is actually pointing (telemetry,
// mapped to sky space) vs where the controller is commanding it, plus a fading
// trail of recent actual positions. Null when there's nothing meaningful to show.
function buildRotorFrame(azOff, elOff) {
  if (!rotConnected) { rotorTrail.length = 0; return null; }
  let actual = null;
  let commanded = null;
  if (rotTelemetry && Number.isFinite(rotTelemetry.az)) actual = { az: rotTelemetry.az - azOff, el: rotTelemetry.el - elOff };
  if (motionRunning && motion.cmd) commanded = { az: motion.cmd.az, el: motion.cmd.el };
  if (actual) {
    rotorTrail.push({ az: actual.az, el: actual.el });
    if (rotorTrail.length > 50) rotorTrail.shift();
  }
  if (!actual && !commanded) return null;
  return { actual, commanded, trail: rotorTrail.slice() };
}

// Pass-scheduler state: the satellite the scheduler is locked onto, and whether
// we've already issued the park command while idle (so we don't spam it).
let schedLockId = null;
let parkedByAuto = false;
let preslewId = null; // id we're pre-positioning for (AOS az), before the pass starts

// Choose which tracked satellite to follow in 'schedule' mode, from the predicted
// pass windows (so geostationary sats, which never "pass", don't hog the rotator).
// Stay locked on the current pass until its LOS, then jump to the best pass still
// in progress; park when none is active.
function pickScheduledTarget(frame, nowMs) {
  const active = rotatorPassesCache.filter(
    (p) => nowMs >= p.pass.aos.getTime() && nowMs <= p.pass.los.getTime()
  );
  if (!active.length) { schedLockId = null; return null; }
  const liveLook = (id) => {
    const s = frame.sats.find((x) => x.id === id);
    return s && s.look ? { id, name: s.name, look: s.look } : null;
  };
  // An armed pass wins outright while it's in progress (the operator committed to it).
  const armed = store.get().hw.rotator.armedPass;
  if (armed && active.some((p) => p.id === armed.id)) {
    const t = liveLook(armed.id);
    if (t) { schedLockId = armed.id; return t; }
  }
  if (schedLockId && active.some((p) => p.id === schedLockId)) {
    const t = liveLook(schedLockId);
    if (t) return t;
  }
  // Pick the in-progress pass that peaks highest (the best pass to be on).
  active.sort((a, b) => b.pass.maxEl - a.pass.maxEl);
  schedLockId = active[0].id;
  return liveLook(active[0].id);
}

function parkNow() {
  if (motionRunning) { motion.stop(); motionRunning = false; }
  window.pyro.rotator.park();
}

/* --------------------------- Motion profiles --------------------------- */
// Smoothness presets: the accel/jerk ramp that shapes how the smooth controller
// gets up to (and off) the user's max slew speed. Gentle spares heavy EME dishes
// and gearboxes; fast suits light LEO rigs that must whip through the zenith.
const MOTION_PROFILES = {
  gentle: { maxAccel: { az: 8, el: 6 }, maxJerk: { az: 40, el: 30 } },
  normal: { maxAccel: { az: 20, el: 15 }, maxJerk: { az: 120, el: 90 } },
  fast: { maxAccel: { az: 40, el: 30 }, maxJerk: { az: 300, el: 240 } },
};

// Push the user's speed limits + selected smoothness profile into the live
// controller (cheap; called each drive so changes take effect immediately).
function applyMotionProfile(rot) {
  motion.cfg.maxVel.az = rot.maxVelAz ?? motion.cfg.maxVel.az;
  motion.cfg.maxVel.el = rot.maxVelEl ?? motion.cfg.maxVel.el;
  const prof = MOTION_PROFILES[rot.motionProfile] || MOTION_PROFILES.normal;
  motion.cfg.maxAccel = { ...prof.maxAccel };
  motion.cfg.maxJerk = { ...prof.maxJerk };
}

/* ----------------------------- Park presets ---------------------------- */
// The park preset the Park button uses (by name), falling back to Home.
function defaultParkPreset() {
  const rot = store.get().hw.rotator;
  const presets = rot.parkPresets || [];
  return presets.find((p) => p.name === rot.parkDefault) || presets[0] || { name: 'Home', home: true };
}

// The main Park action must use SuperRot's actual K command when the built-in
// Home entry is the default.  Home remains available as an explicit H command
// from the Hardware pane; custom defaults still slew to their saved position.
function parkToDefault() {
  const preset = defaultParkPreset();
  if (preset && !preset.home) {
    parkToPreset(preset);
    return;
  }
  if (motionRunning) { motion.stop(); motionRunning = false; }
  if (store.get().hw.rotator.autoMode !== 'off') store.patchIn('hw.rotator', { autoMode: 'off' });
  parkedByAuto = false;
  preslewId = null;
  activeTrackId = null;
  if (rotConnected) window.pyro.rotator.park();
}

// Park to a named preset: the built-in Home preset runs the firmware homing sequence;
// other presets slew to their saved az/el. Either way we take manual control so the
// scheduler doesn't immediately re-drive the mount off the requested position.
function parkToPreset(preset) {
  if (motionRunning) { motion.stop(); motionRunning = false; }
  if (store.get().hw.rotator.autoMode !== 'off') store.patchIn('hw.rotator', { autoMode: 'off' });
  parkedByAuto = false;
  preslewId = null;
  activeTrackId = null;
  if (!rotConnected) return;
  if (!preset || preset.home) window.pyro.rotator.home();
  else window.pyro.rotator.setAzEl(preset.az, Math.max(0, preset.el || 0));
}

// Resolve a true sky (az, el) into mount coordinates, choosing normal vs FLIP-OVER
// ("over the top": az+180, el→180−el) — whichever needs LESS azimuth motion from the
// reference. This is what stops the azimuth whip through the zenith on a high pass:
// as the target transits overhead, the flipped representation keeps az continuous and
// lets elevation carry on past 90°. Flip is only offered when the mount allows it
// (elMax ≥ 135). Returns a continuous (free) azimuth — shortest path from `refAz`.
function resolveMount(az, el, refAz, elMax) {
  const nAz = refAz + wrap180(az - refAz);
  if ((elMax || 90) < 135) return { az: nAz, el }; // standard mount, no flip
  const fAz = refAz + wrap180(az + 180 - refAz);
  const fEl = 180 - el;
  return Math.abs(fAz - refAz) < Math.abs(nAz - refAz) ? { az: fAz, el: fEl } : { az: nAz, el };
}

// Build the smooth setpoint for a target: flip-resolved mount az/el + a feed-forward
// rate derived from the SAME representation a short step ahead (so the rate is smooth
// across a flip). Azimuth is free/continuous — shortest path from where we are.
function computeSetpoint(id, date, elMax) {
  const look = sampleTargetLook(id, date);
  if (!look) return null;
  const ref = motion.currentAz();
  const r0 = resolveMount(look.az, Math.max(0, look.el), ref, elMax);
  const dt = 0.2;
  const ahead = sampleTargetLook(id, new Date(date.getTime() + dt * 1000));
  let azRate = 0;
  let elRate = 0;
  if (ahead) {
    const r1 = resolveMount(ahead.az, Math.max(0, ahead.el), r0.az, elMax);
    azRate = (r1.az - r0.az) / dt;
    elRate = (r1.el - r0.el) / dt;
  }
  return { az: r0.az, el: r0.el, azRate, elRate };
}

// Stream/goto the rotator to a target (smooth controller for SuperRot, 1 Hz goto for Hamlib).
function driveToTarget(track, date, rot) {
  const look = track.look;
  if (rot.protocol === 'superrot') {
    const newObject = !motionRunning || track.id !== lastDrivenId;
    applyMotionProfile(rot); // live: speed limits + smoothness profile
    if (!motionRunning) {
      motion.cfg.elMax = rot.elMax ?? motion.cfg.elMax;
      motion.start();
      motionRunning = true;
    }
    // Semi-closed-loop: seed from the rotator's ACTUAL reported position on a new
    // object so the slew goes the short way from where the mount really is.
    if (newObject && rotTelemetry && Number.isFinite(rotTelemetry.az)) {
      motion.seed(rotTelemetry.az, rotTelemetry.el);
    }
    lastDrivenId = track.id;
    const sp = computeSetpoint(track.id, date, rot.elMax);
    if (sp) motion.setTarget(sp.az, sp.el, sp.azRate, sp.elRate);
  } else {
    if (motionRunning) { motion.stop(); motionRunning = false; }
    if (date.getTime() - lastRotSend > 1000) {
      window.pyro.rotator.setAzEl(look.az + (rot.azOffset || 0), Math.max(0, look.el) + (rot.elOffset || 0));
      lastRotSend = date.getTime();
    }
  }
}

// Find an imminent pass to pre-position for: the soonest upcoming pass whose AOS is
// within the pre-slew lead time. Returns { id, name, az, el, t } or null. In
// 'selected' mode only the selected target counts; in 'schedule' mode any tracked one.
function pickPreslew(nowMs, mode, rot) {
  const lead = (rot.preslewLead || 45) * 1000;
  if (lead <= 0) return null;
  let best = null;
  if (mode === 'schedule') {
    // If a pass is armed, pre-slew only for it; otherwise the soonest imminent one.
    const armed = rot.armedPass;
    for (const p of rotatorPassesCache) {
      const t = p.pass.aos.getTime();
      if (armed && !(p.id === armed.id && Math.abs(t - armed.aos) < 60000)) continue;
      if (t > nowMs && t - nowMs <= lead && (!best || t < best.t)) {
        best = { id: p.id, name: p.name, az: p.pass.aosAz, el: rot.minEl || 0, t };
      }
    }
  } else if (mode === 'selected') {
    const selId = store.get().selected;
    const next = selCache.passes.find((p) => p.aos.getTime() > nowMs);
    if (next && next.aos.getTime() - nowMs <= lead) {
      best = { id: selId, name: catalogById.get(selId)?.name || 'target', az: next.aosAz, el: rot.minEl || 0, t: next.aos.getTime() };
    }
  }
  return best && Number.isFinite(best.az) ? best : null;
}

// Smoothly pre-position to a fixed (AOS az, min el) point ahead of a pass. Uses the
// smooth controller for SuperRot (so it eases into place) or a throttled goto for
// Hamlib. Does NOT publish activeTrackId, so the 10 Hz loop won't chase the target's
// current (below-horizon) position — we hold the AOS point until the pass opens.
function preSlewTo(pre, date, rot) {
  const el = Math.max(0, pre.el || 0);
  if (rot.protocol === 'superrot') {
    applyMotionProfile(rot);
    if (!motionRunning) {
      motion.cfg.elMax = rot.elMax ?? motion.cfg.elMax;
      motion.start();
      motionRunning = true;
      if (rotTelemetry && Number.isFinite(rotTelemetry.az)) motion.seed(rotTelemetry.az, rotTelemetry.el);
    }
    const r = resolveMount(pre.az, el, motion.currentAz(), rot.elMax);
    motion.setTarget(r.az, r.el, 0, 0);
  } else if (date.getTime() - lastRotSend > 1000) {
    window.pyro.rotator.setAzEl(pre.az + (rot.azOffset || 0), el + (rot.elOffset || 0));
    lastRotSend = date.getTime();
  }
  preslewId = pre.id;
}

// Cable-wrap gauge: azimuth is free/continuous, so the accumulated angle away from
// north IS the wrap. Report it (with amber/red thresholds) so the operator knows
// when to manually unwind. Uses live telemetry (SuperRot) or the motion model.
function updateCableWrap(rot) {
  let az = null;
  if (rotTelemetry && Number.isFinite(rotTelemetry.az)) az = rotTelemetry.az;
  else if (motionRunning) az = motion.currentAz();
  if (!rotConnected || az == null) { ui.setCableWrap(null); return; }
  const warn = rot.wrapWarnDeg || 540;
  const max = rot.wrapMaxDeg || 720;
  const mag = Math.abs(az);
  const level = mag >= max ? 'red' : mag >= warn ? 'amber' : 'ok';
  ui.setCableWrap({ az, turns: az / 360, level, warn, max });
}

// 10 Hz refresh of the smooth controller's target (SuperRot only). The 1 Hz tick
// chooses the target; this re-resolves its mount az/el + feed-forward 10× as often so
// the controller corrects far more frequently — much tighter through the zenith.
function streamRotatorFast() {
  if (!motionRunning || activeTrackId == null) return;
  if ((store.get().hw.rotator.protocol || 'hamlib') !== 'superrot') return;
  const sp = computeSetpoint(activeTrackId, new Date(), store.get().hw.rotator.elMax);
  if (sp) motion.setTarget(sp.az, sp.el, sp.azRate, sp.elRate);
}

function driveHardware(frame, date, live = true) {
  const state = store.get();
  const rot = state.hw.rotator;
  const mode = rot.autoMode || 'off';
  const selected = activeTarget(frame);

  // Auto-disarm a queued pass once it's over (small grace after LOS).
  if (rot.armedPass && Date.now() > (rot.armedPass.los || 0) + 5000) store.patchIn('hw.rotator', { armedPass: null });

  // Resolve the auto-track target for this mode.
  let track = null;
  if (mode === 'selected') {
    if (selected && selected.look && selected.look.el >= rot.minEl) track = selected;
  } else if (mode === 'schedule') {
    track = pickScheduledTarget(frame, date.getTime());
    // Respect the rotator's tracking minimum too (pass prediction uses the pass-list
    // minimum, which may be lower) — don't drive the mount below rot.minEl.
    if (track && track.look && track.look.el < rot.minEl) track = null;
  } else {
    schedLockId = null;
  }

  // No live target but a pass is imminent? Pre-position to its AOS azimuth. Uses real
  // time (not the possibly-warped view time) so the countdown and driving stay honest.
  const nowMs = Date.now();
  let pre = rotConnected && mode !== 'off' && !track ? pickPreslew(nowMs, mode, rot) : null;

  // Sun-avoidance guard: how close the intended boresight is to the Sun. During a live
  // track we can only warn (skipping would lose the satellite); for a pre-slew we hold
  // off (park) rather than park/point the dish straight at the Sun.
  let sunWarn = null;
  if (rot.sunAvoid) {
    const sun = (frame.bodies || []).find((b) => b.id === 'SUN');
    const pointing = track ? track.look : pre ? { az: pre.az, el: pre.el } : null;
    if (sun && sun.look && pointing) {
      const sep = angSep(pointing.az, pointing.el, sun.look.az, sun.look.el);
      if (sep < (rot.sunAvoidDeg || 5)) {
        sunWarn = sep;
        if (!track && pre) pre = null; // don't pre-slew into the Sun; park instead
      }
    }
  }

  // Rotator readout.
  if (ui.hw.rotTarget) {
    ui.hw.rotTarget.innerHTML = '';
    const k = (a, b) => [elKV('k', a), elKV('v', b)];
    if (track) {
      ui.hw.rotTarget.append(
        ...k(mode === 'schedule' ? 'Tracking' : 'Target', track.name),
        ...k('Az', track.look.az.toFixed(1) + '°'),
        ...k('El', track.look.el.toFixed(1) + '°')
      );
    } else if (pre) {
      ui.hw.rotTarget.append(
        ...k('Pre-slew', pre.name),
        ...k('AOS az', pre.az.toFixed(1) + '°'),
        ...k('AOS in', countdown(pre.t - nowMs))
      );
    } else if (mode === 'schedule') {
      ui.hw.rotTarget.append(...k('Scheduler', rotConnected ? 'Parked — waiting for a pass' : 'Idle'));
    } else if (selected && selected.look) {
      ui.hw.rotTarget.append(...k('Target', selected.name), ...k('Az', selected.look.az.toFixed(1) + '°'), ...k('El', selected.look.el.toFixed(1) + '°'));
      if (mode === 'selected' && selected.look.el < rot.minEl) ui.hw.rotTarget.append(...k('Status', rotConnected ? 'Below min — parked' : 'Below min'));
    }
    if (rot.protocol === 'superrot' && rotTelemetry) {
      const tel = rotTelemetry;
      ui.hw.rotTarget.append(
        ...k('Actual', `${tel.az.toFixed(1)}° / ${tel.el.toFixed(1)}°`),
        ...k('Slew', `${tel.azRate.toFixed(2)} / ${tel.elRate.toFixed(2)} °/s`)
      );
      // Extended firmware diagnostics (only shown when the firmware reports them).
      if (Number.isFinite(tel.tempC)) ui.hw.rotTarget.append(...k('Temp', tel.tempC.toFixed(1) + ' °C'));
      if (Number.isFinite(tel.curA)) ui.hw.rotTarget.append(...k('Current', tel.curA.toFixed(2) + ' A'));
      if (tel.esAz != null || tel.esEl != null) {
        ui.hw.rotTarget.append(...k('Endstops', `Az ${tel.esAz ? '● HIT' : '—'} · El ${tel.esEl ? '● HIT' : '—'}`));
      }
      if (tel.homed != null) ui.hw.rotTarget.append(...k('Homed', tel.homed ? 'yes' : 'no'));
      if (tel.lossAz || tel.lossEl) ui.hw.rotTarget.append(...k('⚠ Step loss', `${tel.lossAz ? 'Az ' : ''}${tel.lossEl ? 'El' : ''}`.trim()));
    }
    if (sunWarn != null) ui.hw.rotTarget.append(...k('⚠ Sun', sunWarn.toFixed(1) + '° from boresight'));
  }

  // Bottom status bar: connection state + what the rotator is tracking.
  ui.setStatus({
    rotConnected,
    radConnected,
    slewing: !!(rotTelemetry && (Math.abs(rotTelemetry.azRate || 0) > 0.12 || Math.abs(rotTelemetry.elRate || 0) > 0.12)),
    tracking: !live ? '⏱ Time-warp preview'
      : track ? track.name + (sunWarn != null ? ' · ⚠ Sun' : '')
      : pre ? `Pre-slew ${pre.name} · AOS ${countdown(pre.t - nowMs)}`
      : (rotConnected && mode !== 'off' ? 'Parked' : null),
  });
  updateRotatorAudioState(track ? 'tracking' : pre ? 'preslew' : (rotConnected && mode !== 'off' ? 'parked' : 'idle'));
  publishRotatorMission(track?.name || pre?.name || '', track ? 'tracking' : pre ? 'preslew' : (rotConnected && mode !== 'off' ? 'parked' : 'idle'));

  // Drive the rotator: track when there's a target, pre-position when a pass is
  // imminent, else park once. The SuperRot setpoint is refreshed at 10 Hz by
  // streamRotatorFast(); here we decide the target and publish its id for that loop.
  // Skipped during a time-warp preview — the live 10 Hz loop keeps real-time tracking
  // untouched while the display scrubs ahead, so we never slew to a previewed future.
  if (live) {
    if (rotConnected && mode !== 'off') {
      if (track) {
        driveToTarget(track, date, rot);
        parkedByAuto = false;
        preslewId = null;
        activeTrackId = rot.protocol === 'superrot' ? track.id : null;
      } else if (pre) {
        preSlewTo(pre, date, rot);
        parkedByAuto = false;
        activeTrackId = null; // holding the AOS point; not chasing the live target yet
      } else {
        activeTrackId = null;
        preslewId = null;
        // Pass over (or none up): park once.
        if (!parkedByAuto) { parkNow(); parkedByAuto = true; }
      }
    } else {
      if (motionRunning) { motion.stop(); motionRunning = false; }
      parkedByAuto = false;
      preslewId = null;
      activeTrackId = null;
    }
  }

  updateCableWrap(rot);

  // Radio Doppler — follows the tracked satellite (or the selected one). Only
  // satellites carry a dopplerFactor; the Moon/planets/DSOs don't. The active
  // satellite's per-sat radio profile (up/down/mode/invert) overrides the global
  // downlink; full-Doppler correction is applied to both links independently.
  const dopTarget = track || selected;
  const dopplerFactor = dopTarget && dopTarget.look && dopTarget.look.dopplerFactor != null ? dopTarget.look.dopplerFactor : null;
  const dopId = dopTarget && dopTarget.id;
  const profile = dopId ? resolveProfile(state.radioProfiles, dopId, state.hw.radio) : null;
  const tune = dopplerFactor != null ? radioTuning(profile, dopplerFactor) : null;
  ui.setRadioTuning(tune);
  if (ui.hw.radFreqLive) {
    ui.hw.radFreqLive.innerHTML = '';
    if (tune) {
      ui.hw.radFreqLive.append(
        elKV('k', 'Downlink ' + tune.downlinkMode),
        elKV('v', (tune.downlinkTunedHz / 1e6).toFixed(5) + ' MHz'));
      if (tune.hasUplink) {
        ui.hw.radFreqLive.append(
          elKV('k', 'Uplink ' + tune.uplinkMode + (tune.invert ? ' ↕' : '')),
          elKV('v', (tune.uplinkTunedHz / 1e6).toFixed(5) + ' MHz'));
      }
    }
  }
  if (radConnected && state.hw.radio.doppler && tune && tune.downlinkTunedHz) {
    if (date.getTime() - lastRadSend > 1000) {
      window.pyro.radio.setFreq(tune.downlinkTunedHz);
      lastRadSend = date.getTime();
    }
  }

  // Blackbox: log track-target changes (acquire / release) as they happen.
  if (rotConnected && live && activeTrackId !== lastLoggedTrackId) {
    if (activeTrackId) {
      const s = catalogById.get(activeTrackId);
      blackbox.event('track', 'acquire ' + (s ? s.name : activeTrackId));
    } else if (lastLoggedTrackId) {
      blackbox.event('track', 'release');
    }
    lastLoggedTrackId = activeTrackId;
  }

  // Blackbox: sample commanded vs actual pointing + tuned freq while connected.
  if (rotConnected && live && frame.rotor && date.getTime() - lastBlackboxSample >= BLACKBOX_INTERVAL_MS) {
    blackbox.sample({
      t: date.getTime(),
      commanded: frame.rotor.commanded,
      actual: frame.rotor.actual,
      freqHz: tune && tune.downlinkTunedHz ? tune.downlinkTunedHz : null,
      trackId: activeTrackId,
    });
    lastBlackboxSample = date.getTime();
  }
}

function elKV(cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return d;
}

function countdown(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}
