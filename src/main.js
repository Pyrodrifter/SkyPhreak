import './style.css';
import { store } from './core/store.js';
import { parseCatalog } from './core/tle.js';
import { parseOem } from './core/oem.js';
import { subPoint, lookAngles, makeSatrec, tleAgeDays } from './core/propagate.js';
import { moonState, moonLook } from './core/moon.js';
import { planetState, raDecToAzEl, subPointOf } from './core/bodies.js';
import { precessToDate, dsoById, DSOS } from './core/dso.js';
import { predictPasses } from './core/passes.js';
import { MotionController } from './core/motion.js';
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
let rotTelemetry = null; // last { az, el, azRate, elRate } reported by SuperRot firmware
let activeTrackId = null; // id the rotator is actively tracking (null when parked/idle)
let lastDrivenId = null; // last object the smooth controller was driven toward
let azCmdContinuous = null; // last continuous (unwrapped) az streamed to SuperRot

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
    parkRotator: () => { if (motionRunning) { motion.stop(); motionRunning = false; } window.pyro.rotator.park(); },
    stopRotator: () => { if (motionRunning) { motion.stop(); motionRunning = false; } else window.pyro.rotator.stop(); },
    unwindRotator,
    connectRadio,
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
      // cmd.az is CONTINUOUS (unwrapped, may exceed 360) — send it as-is so the
      // rotator keeps turning the same way across north. Remember it for the
      // cable-wrap warning / manual unwind.
      azCmdContinuous = cmd.az;
      window.pyro.rotator.track(cmd.az, cmd.el, cmd.azRate, cmd.elRate);
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
  tick();
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
function onState(state) {
  ui.renderList();
  ui.syncAutoMode(); // keep the on-map track buttons + HW dropdown in sync
  if (state.view !== lastView) {
    ui.setActiveView(state.view);
    lastView = state.view;
  }
  if (state.mapStyle !== lastMapStyle) {
    lastMapStyle = state.mapStyle;
    map2d.setStyle(state.mapStyle);
    globe3d.setStyle(state.mapStyle);
  }
  // Recompute passes when the selection, station, or min elevation changes.
  const key = `${state.selected}|${state.station.lat}|${state.station.lon}|${state.station.altKm}|${state.minEl}`;
  if (key !== selCache.key) {
    selCache.key = key;
    recomputeSelected();
  }
  // Recompute the all-tracked pass list when the checked set (or location) changes.
  const tkey = `${[...state.tracked].sort().join(',')}|${state.station.lat}|${state.station.lon}|${state.station.altKm}|${state.minEl}`;
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
}

// Build the merged, time-sorted pass list across all tracked satellites. Each entry
// carries its satellite's name/colour so the Passes tab can label and colour rows.
function recomputeTrackedPasses() {
  const state = store.get();
  const observer = state.station;
  const out = [];
  for (const id of state.tracked) {
    const sat = catalogById.get(id);
    if (!sat) continue;
    const passes = predictPasses(sat.satrec, observer, { minEl: state.minEl, hours: 48, count: 8 });
    const color = colorFor(id, state.tracked);
    for (const p of passes) out.push({ id, name: sat.name, color, pass: p });
  }
  out.sort((a, b) => a.pass.aos - b.pass.aos);
  trackedPassesCache.list = out;
}

/* -------------------------------- Tick --------------------------------- */
function tick() {
  const state = store.get();
  const date = new Date();
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

  const frame = { date, station: observer, sats, moon, bodies, mapShow: { moon: state.showMoon, planets: state.showPlanets } };

  if (state.view === '2d') map2d.draw(frame);
  else globe3d.draw(frame);
  polar.draw(frame);
  ensurePolarMounted();

  ui.updateClock(date);
  updateSelectedInfo(frame, date);
  ui.updatePasses(trackedPassesCache.list, date.getTime());
  updateTleStatus();

  driveHardware(frame, date);
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

// Describe the selected sky target (Moon/Sun/planet/DSO) for the Info panel.
function buildSelBody(frame) {
  const sel = store.get().selected;
  if (sel === 'MOON') {
    const m = frame.moon;
    return {
      name: 'Moon', kind: 'moon', az: m.look.az, el: m.look.el,
      extra: [['Distance', Math.round(m.distanceKm).toLocaleString() + ' km'], ['Illumination', Math.round(m.illum * 100) + '%'], ['Phase', m.phaseName]],
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
    rotConnected = s.connected;
    if (s.telemetry) rotTelemetry = s.telemetry;
    if (!s.connected) rotTelemetry = null;
    // Closed-loop: keep the smooth controller anchored to the rotator's real azimuth.
    if (motion) motion.setActual(s.connected && s.telemetry ? s.telemetry.az : NaN);
    const where = s.path ? s.path : `${s.host || ''}:${s.port || ''}`;
    ui.hw.rotPill._set(s.connected, s.connected ? `Rotator connected ${where}` : (s.error ? 'Rotator: ' + s.error : 'Rotator disconnected'));
    ui.hw.rotConnect.textContent = s.connected ? 'Disconnect' : 'Connect';
    ui.setRotorConnected(s.connected); // on-map rotor light
  });
  window.pyro.radio.onStatus((s) => {
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

// Pass-scheduler state: the satellite the scheduler is locked onto, and whether
// we've already issued the park command while idle (so we don't spam it).
let schedLockId = null;
let parkedByAuto = false;

// Choose which tracked satellite to follow in 'schedule' mode, from the predicted
// pass windows (so geostationary sats, which never "pass", don't hog the rotator).
// Stay locked on the current pass until its LOS, then jump to the best pass still
// in progress; park when none is active.
function pickScheduledTarget(frame, nowMs) {
  const active = trackedPassesCache.list.filter(
    (p) => nowMs >= p.pass.aos.getTime() && nowMs <= p.pass.los.getTime()
  );
  if (!active.length) { schedLockId = null; return null; }
  const liveLook = (id) => {
    const s = frame.sats.find((x) => x.id === id);
    return s && s.look ? { id, name: s.name, look: s.look } : null;
  };
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

// Auto-unwind: after an auto-tracked pass, return to home/stow (az 0, low el). The
// absolute az-0 move unwinds any cable wrap accumulated crossing north during the
// pass, so it never builds up toward the travel limit. SuperRot only (the Hamlib
// path never winds, since it sends standard 0–360).
function stowAfterPass() {
  if (motionRunning) { motion.stop(); motionRunning = false; }
  window.pyro.rotator.setAzEl(0, 0);
}

// Operator action (idle): unwind the cable one full turn. Drives an absolute goto
// 360° back toward the centre of travel; the next track reseeds from telemetry.
function unwindRotator() {
  const rot = store.get().hw.rotator;
  if (!rotConnected || rot.protocol !== 'superrot') return;
  const az = rotTelemetry && Number.isFinite(rotTelemetry.az) ? rotTelemetry.az : azCmdContinuous;
  if (az == null) return;
  const el = rotTelemetry && Number.isFinite(rotTelemetry.el) ? rotTelemetry.el : 0;
  const mid = ((rot.azMin ?? 0) + (rot.azMax ?? 450)) / 2;
  const target = az + (az > mid ? -360 : 360);
  if (motionRunning) { motion.stop(); motionRunning = false; }
  activeTrackId = null;
  window.pyro.rotator.setAzEl(target, Math.max(0, el));
}

// Stream/goto the rotator to a target (smooth controller for SuperRot, 1 Hz goto for Hamlib).
function driveToTarget(track, date, rot) {
  const look = track.look;
  if (rot.protocol === 'superrot') {
    const dt = 0.2; // s — finite-difference horizon for the velocity feedforward
    const ahead = sampleTargetLook(track.id, new Date(date.getTime() + dt * 1000));
    let azRate = 0;
    let elRate = 0;
    if (ahead) {
      azRate = wrap180(ahead.az - look.az) / dt;
      elRate = (ahead.el - look.el) / dt;
    }
    // Re-seed when (re)starting or switching to a DIFFERENT object — not while
    // continuously tracking the same one (that must stay smooth/unwrapped).
    const newObject = !motionRunning || track.id !== lastDrivenId;
    if (!motionRunning) {
      motion.cfg.maxVel.az = rot.maxVelAz ?? motion.cfg.maxVel.az;
      motion.cfg.maxVel.el = rot.maxVelEl ?? motion.cfg.maxVel.el;
      motion.cfg.azMin = rot.azMin ?? motion.cfg.azMin;
      motion.cfg.azMax = rot.azMax ?? motion.cfg.azMax;
      motion.cfg.elMax = rot.elMax ?? motion.cfg.elMax;
      motion.start();
      motionRunning = true;
    }
    // Semi-closed-loop: seed the controller from the rotator's ACTUAL reported
    // position (telemetry) so a slew to a new object goes the short way from where
    // the mount really is — no wind-up carried over from a previous pass/target.
    if (newObject && rotTelemetry && Number.isFinite(rotTelemetry.az)) {
      motion.seed(rotTelemetry.az, rotTelemetry.el);
    }
    lastDrivenId = track.id;
    motion.setTarget(look.az, Math.max(0, look.el), azRate, elRate);
  } else {
    if (motionRunning) { motion.stop(); motionRunning = false; }
    if (date.getTime() - lastRotSend > 1000) {
      window.pyro.rotator.setAzEl(look.az, Math.max(0, look.el));
      lastRotSend = date.getTime();
    }
  }
}

// 10 Hz refresh of the smooth controller's target (SuperRot only). The 1 Hz tick
// chooses the target; this re-samples its true az/el + feedforward 10× as often so
// the controller corrects far more frequently — much tighter through the zenith
// keyhole — without re-rendering the views at 10 Hz. Cheap: one/two SGP4 calls per
// iteration, and only while actively tracking.
function streamRotatorFast() {
  if (!motionRunning || activeTrackId == null) return;
  if ((store.get().hw.rotator.protocol || 'hamlib') !== 'superrot') return;
  const now = Date.now();
  const look = sampleTargetLook(activeTrackId, new Date(now));
  if (!look) return;
  const dt = 0.2; // s — finite-difference horizon for the velocity feedforward
  const ahead = sampleTargetLook(activeTrackId, new Date(now + dt * 1000));
  let azRate = 0;
  let elRate = 0;
  if (ahead) {
    azRate = wrap180(ahead.az - look.az) / dt;
    elRate = (ahead.el - look.el) / dt;
  }
  motion.setTarget(look.az, Math.max(0, look.el), azRate, elRate);
}

function driveHardware(frame, date) {
  const state = store.get();
  const rot = state.hw.rotator;
  const mode = rot.autoMode || 'off';
  const selected = activeTarget(frame);

  // Resolve the auto-track target for this mode.
  let track = null;
  if (mode === 'selected') {
    if (selected && selected.look && selected.look.el >= rot.minEl) track = selected;
  } else if (mode === 'schedule') {
    track = pickScheduledTarget(frame, date.getTime());
  } else {
    schedLockId = null;
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
    } else if (mode === 'schedule') {
      ui.hw.rotTarget.append(...k('Scheduler', rotConnected ? 'Parked — waiting for a pass' : 'Idle'));
    } else if (selected && selected.look) {
      ui.hw.rotTarget.append(...k('Target', selected.name), ...k('Az', selected.look.az.toFixed(1) + '°'), ...k('El', selected.look.el.toFixed(1) + '°'));
      if (mode === 'selected' && selected.look.el < rot.minEl) ui.hw.rotTarget.append(...k('Status', rotConnected ? 'Below min — parked' : 'Below min'));
    }
    if (rot.protocol === 'superrot' && rotTelemetry) {
      ui.hw.rotTarget.append(
        ...k('Actual', `${rotTelemetry.az.toFixed(1)}° / ${rotTelemetry.el.toFixed(1)}°`),
        ...k('Slew', `${rotTelemetry.azRate.toFixed(2)} / ${rotTelemetry.elRate.toFixed(2)} °/s`)
      );
    }
  }

  // Cable-wrap warning: the continuous azimuth is nearing the rotator's travel limit.
  if (ui.hw.setRotWarn) {
    const warnDeg = 15;
    const azNow = rotTelemetry && Number.isFinite(rotTelemetry.az) ? rotTelemetry.az : azCmdContinuous;
    let warn = null;
    if (rot.protocol === 'superrot' && rotConnected && azNow != null) {
      if (azNow >= (rot.azMax ?? 450) - warnDeg) warn = `Az ${azNow.toFixed(0)}° near upper limit ${rot.azMax}° — unwind`;
      else if (azNow <= (rot.azMin ?? 0) + warnDeg) warn = `Az ${azNow.toFixed(0)}° near lower limit ${rot.azMin}° — unwind`;
    }
    ui.hw.setRotWarn(warn);
  }

  // Drive the rotator: track when there's a target, park once when there isn't.
  // The SuperRot setpoint is refreshed at 10 Hz by streamRotatorFast(); here we
  // just decide the target and publish its id for that loop.
  if (rotConnected && mode !== 'off') {
    if (track) {
      driveToTarget(track, date, rot);
      parkedByAuto = false;
      activeTrackId = rot.protocol === 'superrot' ? track.id : null;
    } else {
      activeTrackId = null;
      // Pass over (or none up): stow once. With auto-unwind on, SuperRot returns to
      // home (az 0, low el) which also unwinds the cable; otherwise just park.
      if (!parkedByAuto) {
        if (rot.protocol === 'superrot' && rot.autoUnwind !== false) stowAfterPass();
        else parkNow();
        parkedByAuto = true;
      }
    }
  } else {
    if (motionRunning) { motion.stop(); motionRunning = false; }
    parkedByAuto = false;
    activeTrackId = null;
  }

  // Radio Doppler — follows the tracked satellite (or the selected one). Only
  // satellites carry a dopplerFactor; the Moon/planets/DSOs don't.
  const dopTarget = track || selected;
  const dopplerFactor = dopTarget && dopTarget.look && dopTarget.look.dopplerFactor != null ? dopTarget.look.dopplerFactor : null;
  if (ui.hw.radFreqLive) {
    ui.hw.radFreqLive.innerHTML = '';
    if (dopplerFactor != null) {
      const observed = state.hw.radio.downlinkHz * dopplerFactor;
      ui.hw.radFreqLive.append(elKV('k', 'Tuned freq'), elKV('v', (observed / 1e6).toFixed(5) + ' MHz'));
    }
  }
  if (radConnected && state.hw.radio.doppler && dopplerFactor != null) {
    if (date.getTime() - lastRadSend > 1000) {
      window.pyro.radio.setFreq(state.hw.radio.downlinkHz * dopplerFactor);
      lastRadSend = date.getTime();
    }
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
