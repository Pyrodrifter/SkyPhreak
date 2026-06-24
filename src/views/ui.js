import { store } from '../core/store.js';
import { DSOS } from '../core/dso.js';

// Sun, Moon and planets shown in the Sky box (id, label, marker colour).
const SKY_BODIES = [
  ['MOON', 'Moon', '#e6eaf2'],
  ['SUN', 'Sun', '#ffd23f'],
  ['MERCURY', 'Mercury', '#b0a08c'],
  ['VENUS', 'Venus', '#e8e3d0'],
  ['MARS', 'Mars', '#d9603b'],
  ['JUPITER', 'Jupiter', '#d8b48c'],
  ['SATURN', 'Saturn', '#e3d9a8'],
  ['URANUS', 'Uranus', '#9fe0e6'],
  ['NEPTUNE', 'Neptune', '#5b7cdf'],
];

// Tiny DOM helper.
function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) el.append(c?.nodeType ? c : document.createTextNode(c));
  return el;
}

export function createUI(handlers) {
  const app = document.getElementById('app');
  app.innerHTML = '';

  /* ------------------------------- Topbar -------------------------------- */
  const clockEl = h('div', { class: 'clock' });
  const selReadout = h('div', { class: 'sel-readout' });
  const btn2d = h('button', { class: 'active', onclick: () => store.patch({ view: '2d' }) }, '2D Map');
  const btn3d = h('button', { onclick: () => store.patch({ view: '3d' }) }, '3D Globe');

  const topbar = h('div', { class: 'topbar' }, [
    h('div', { class: 'brand' }, [
      h('img', { class: 'brand-logo', src: './icon.png', alt: '' }),
      h('span', { class: 'brand-text', html: 'Sky<span>Phreak</span>' }),
    ]),
    clockEl,
    h('div', { class: 'spacer' }),
    selReadout,
    h('div', { class: 'toggle' }, [btn2d, btn3d]),
  ]);

  /* ------------------------------- Sidebar ------------------------------- */
  const groupSel = h('select', {
    onchange: (e) => { store.patch({ group: e.target.value }); handlers.refreshTLE(); },
  }, [
    ['active', 'Active satellites'],
    ['stations', 'Space stations'],
    ['amateur', 'Amateur radio'],
    ['weather', 'Weather'],
    ['noaa', 'NOAA'],
    ['goes', 'GOES'],
    ['starlink', 'Starlink'],
    ['gps-ops', 'GPS'],
    ['visual', 'Brightest / visual'],
  ].map(([v, l]) => h('option', { value: v }, l)));
  groupSel.value = store.get().group;

  const refreshBtn = h('button', { class: 'btn sm', onclick: () => handlers.refreshTLE() }, 'Refresh');
  const tleStamp = h('div', { class: 'muted', style: 'font-size:11px;margin-top:6px' }, '');
  const search = h('input', { type: 'text', placeholder: 'Search satellites…', oninput: (e) => { searchTerm = e.target.value.toLowerCase(); renderList(); } });
  const listEl = h('div', { class: 'satlist' });
  const skyEl = h('div', { class: 'satlist box-list' });
  const trackedEl = h('div', { class: 'satlist box-list' });
  const favEl = h('div', { class: 'satlist box-list' });
  let searchTerm = '';
  let dsoOpen = false; // whether the deep-sky list is expanded in the sidebar
  let solarOpen = true; // whether the Solar System list is expanded
  let staleIds = new Set(); // tracked sats whose TLE epoch exceeds the max age

  const sidebar = h('aside', { class: 'sidebar' }, [
    h('div', { class: 'side-box' }, [
      h('div', { class: 'side-title pad' }, 'Sky'),
      skyEl,
    ]),
    h('div', { class: 'side-box' }, [
      h('div', { class: 'side-title pad' }, 'Tracked'),
      trackedEl,
    ]),
    h('div', { class: 'side-box' }, [
      h('div', { class: 'side-title pad' }, 'Favorites'),
      favEl,
    ]),
    h('div', { class: 'side-box grow' }, [
      h('div', { class: 'side-head' }, [
        h('div', { class: 'side-title' }, 'Catalog'),
        groupSel,
        h('div', { class: 'row', style: 'margin-top:8px' }, [search, refreshBtn]),
        tleStamp,
      ]),
      listEl,
    ]),
  ]);

  /* -------------------------------- Stage -------------------------------- */
  const view2d = h('div', { id: 'view-2d' });
  const view3d = h('div', { id: 'view-3d' });
  const styleLabel = (s) => (s === 'vector' ? 'Map: Vector' : 'Map: Shaded');
  const mapStyleBtn = h('button', {
    class: 'btn sm',
    title: 'Toggle shaded-relief / vector map',
    onclick: () => {
      const next = store.get().mapStyle === 'vector' ? 'relief' : 'vector';
      store.patch({ mapStyle: next });
      mapStyleBtn.textContent = styleLabel(next);
    },
  }, styleLabel(store.get().mapStyle));
  const resetBtn = h('button', { class: 'btn sm', onclick: () => handlers.resetView() }, 'Reset view');
  const tools = h('div', { class: 'stage-tools' }, [mapStyleBtn, resetBtn]);

  // Quick-access auto-track controls on the map: the three tracking modes + a
  // rotor connection light (red = disconnected, green = connected).
  const trackBtns = {};
  const trackModes = [['off', 'Off'], ['selected', 'Selected'], ['schedule', 'Schedule']];
  const trackBar = h('div', { class: 'toggle' }, trackModes.map(([m, label]) =>
    (trackBtns[m] = h('button', { title: trackTitle(m), onclick: () => store.patchIn('hw.rotator', { autoMode: m }) }, label))));
  const rotorDot = h('span', { class: 'rotor-dot', title: 'Rotor disconnected' });
  const trackCluster = h('div', { class: 'track-cluster' }, [
    h('span', { class: 'track-label' }, 'Auto-track'),
    trackBar,
    h('span', { class: 'rotor-status' }, [rotorDot, h('span', { class: 'rotor-text' }, 'Rotor')]),
  ]);

  const hint = h('div', { class: 'view-hint' }, 'Scroll to zoom · drag to pan · click a satellite to select');
  const stage = h('main', { class: 'stage' }, [view2d, view3d, trackCluster, tools, hint]);

  /* ----------------------------- Right panel ----------------------------- */
  const tabPanes = {};
  const tabBtns = {};
  const tabNames = { info: 'Info', passes: 'Passes', station: 'Station', hw: 'Hardware' };
  const tabsBar = h('div', { class: 'tabs' });
  let activeTab = 'info';
  for (const key of Object.keys(tabNames)) {
    const b = h('button', { class: key === 'info' ? 'active' : '', onclick: () => setTab(key) }, tabNames[key]);
    tabBtns[key] = b;
    tabsBar.append(b);
    tabPanes[key] = h('div', { class: 'tabpane' + (key === 'info' ? ' active' : '') });
  }
  function setTab(key) {
    activeTab = key;
    for (const k of Object.keys(tabPanes)) {
      tabPanes[k].classList.toggle('active', k === key);
      tabBtns[k].classList.toggle('active', k === key);
    }
  }
  const rightpanel = h('aside', { class: 'rightpanel' }, [tabsBar, ...Object.values(tabPanes)]);

  const stationRefs = buildStationPane(tabPanes.station, handlers);
  const hwRefs = buildHwPane(tabPanes.hw, handlers);

  // The Info pane has a text block (rebuilt each tick) plus the polar/radar
  // canvas, which is mounted once and must persist across rebuilds.
  const infoText = h('div');
  tabPanes.info.append(infoText);

  app.append(topbar, h('div', { class: 'body' }, [sidebar, stage, rightpanel]));

  /* ------------------------------ Rendering ------------------------------ */
  // A sat-like {noradId,name,line1,line2} for an id, from catalog or favorites.
  function satLike(id) {
    const c = store.getCatalog().find((s) => s.noradId === id);
    if (c) return c;
    const f = store.get().favorites.find((fa) => fa.id === id);
    if (f) return { noradId: f.id, name: f.name, line1: f.line1, line2: f.line2 };
    const t = (store.get().tleStore || {})[id];
    return t ? { noradId: id, name: t.name, line1: t.line1, line2: t.line2 } : null;
  }

  function satRow({ id, name, tracked, favorite, selected, color }) {
    const cb = h('input', {
      type: 'checkbox',
      title: 'Track',
      onclick: (e) => { e.stopPropagation(); store.toggleTracked(id, satLike(id)); },
    });
    cb.checked = tracked;
    const star = h('button', {
      class: 'star' + (favorite ? ' on' : ''),
      title: favorite ? 'Remove favorite' : 'Add favorite',
      onclick: (e) => { e.stopPropagation(); const s = satLike(id); if (s) store.toggleFavorite(s); },
    }, favorite ? '★' : '☆');
    const stale = staleIds.has(id);
    return h('div', {
      class: 'sat-row' + (selected ? ' selected' : ''),
      onclick: () => store.patch({ selected: id }),
    }, [
      cb,
      h('span', { class: 'dot', style: tracked ? `background:${color}` : 'background:transparent;border:1px solid var(--line)' }),
      h('span', { class: 'nm' }, name),
      stale ? h('span', { class: 'stale-badge', title: 'TLE older than the max age — update when online' }, 'old TLE') : h('span', { class: 'nid' }, id),
      star,
    ]);
  }

  // A selectable sky-target row (Moon/Sun/planet/DSO) — no track/favorite.
  function bodyRow(id, name, color, selected, sub) {
    return h('div', {
      class: 'sat-row' + (selected ? ' selected' : ''),
      onclick: () => store.patch({ selected: id }),
    }, [
      h('span', { class: 'dot', style: `background:${color}` }),
      h('span', { class: 'nm' }, name),
      h('span', { class: 'nid' }, sub || ''),
    ]);
  }

  // A collapsible group header: a clickable disclosure on the left, controls on
  // the right (e.g. an "on map" checkbox).
  function groupHead(open, label, onToggle, controls) {
    return h('div', { class: 'mini-head' }, [
      h('span', { class: 'discl', onclick: onToggle }, (open ? '▾ ' : '▸ ') + label),
      controls || h('span', {}),
    ]);
  }
  const onMapChk = (flag, title) => {
    const cb = checkbox(store.get()[flag], (v) => store.patch({ [flag]: v }));
    return h('label', { class: 'on-map', title }, [cb, h('span', {}, 'on map')]);
  };

  function renderSky() {
    const st = store.get();
    const sel = st.selected;
    skyEl.innerHTML = '';

    // Solar System: the Moon, Sun and planets. "on map" controls the 2D-map
    // overlay (Moon + planets); they always remain on the radar view.
    skyEl.append(groupHead(solarOpen, 'Solar System', () => { solarOpen = !solarOpen; renderSky(); },
      h('div', { class: 'chk-group' }, [
        h('label', { class: 'on-map', title: 'Show the Moon on the 2D map' }, [checkbox(st.showMoon, (v) => store.patch({ showMoon: v })), h('span', {}, 'Moon')]),
        h('label', { class: 'on-map', title: 'Show the Sun & planets on the 2D map' }, [checkbox(st.showPlanets, (v) => store.patch({ showPlanets: v })), h('span', {}, 'Planets')]),
      ])));
    if (solarOpen) for (const [id, name, color] of SKY_BODIES) skyEl.append(bodyRow(id, name, color, sel === id));

    // Deep sky: expand to pick a target; "on map" overlays all DSOs (off by
    // default). The selected DSO always shows on the map regardless.
    skyEl.append(groupHead(dsoOpen, 'Deep sky', () => { dsoOpen = !dsoOpen; renderSky(); },
      onMapChk('showDso', 'Overlay all deep-sky objects on the 2D map')));
    if (dsoOpen) for (const d of DSOS) {
      skyEl.append(bodyRow('DSO:' + d.id, d.name, '#c792ea', sel === 'DSO:' + d.id, d.type.replace(/ ?nebula/i, '').trim() || d.type));
    }
  }

  function renderList() {
    const st = store.get();
    const catalog = store.getCatalog();
    const tracked = new Set(st.tracked);
    const favIds = new Set(st.favorites.map((f) => f.id));

    renderSky();

    // Tracked box: tracked satellites.
    trackedEl.innerHTML = '';
    if (!st.tracked.length) trackedEl.append(h('div', { class: 'mini-empty' }, 'No satellites tracked'));
    for (const id of st.tracked) {
      const s = satLike(id);
      trackedEl.append(satRow({
        id, name: s ? s.name : 'NORAD ' + id, tracked: true,
        favorite: favIds.has(id), selected: st.selected === id, color: colorFor(id, st.tracked),
      }));
    }

    // Favorites box.
    favEl.innerHTML = '';
    if (!st.favorites.length) favEl.append(h('div', { class: 'mini-empty' }, 'Tap ☆ on a satellite to add it'));
    for (const f of st.favorites) {
      favEl.append(satRow({
        id: f.id, name: f.name, tracked: tracked.has(f.id),
        favorite: true, selected: st.selected === f.id, color: colorFor(f.id, st.tracked),
      }));
    }

    // Catalog box: the loaded group, filtered by search (capped). Preserve the
    // scroll position — renderList runs on every state change (incl. selecting a
    // satellite), and rebuilding the list would otherwise jump it back to the top.
    const savedScroll = listEl.scrollTop;
    listEl.innerHTML = '';
    let pool = catalog;
    if (searchTerm) pool = catalog.filter((s) => s.name.toLowerCase().includes(searchTerm) || s.noradId.includes(searchTerm));
    const rows = pool.slice(0, 200);
    if (!rows.length) {
      listEl.append(h('div', { class: 'empty' }, catalog.length ? 'No matches' : 'Loading catalog…'));
      return;
    }
    for (const s of rows) {
      listEl.append(satRow({
        id: s.noradId, name: s.name, tracked: tracked.has(s.noradId),
        favorite: favIds.has(s.noradId), selected: st.selected === s.noradId, color: colorFor(s.noradId, st.tracked),
      }));
    }
    listEl.scrollTop = savedScroll;
  }

  function updateClock(date) {
    const utc = date.toISOString().slice(11, 19);
    const loc = date.toLocaleTimeString();
    clockEl.innerHTML = `<b>${utc}</b> UTC &nbsp;·&nbsp; ${loc}`;
  }

  const kv = (label, value, cls = '') => [h('div', { class: 'k' }, label), h('div', { class: 'v ' + cls }, value)];

  function appendMoonSection(moon) {
    const up = moon.look.el >= 0;
    infoText.append(
      h('div', { class: 'section-title' }, '☾ Moon'),
      h('div', { class: 'kv' }, [
        ...kv('Azimuth', moon.look.az.toFixed(1) + '°'),
        ...kv('Elevation', moon.look.el.toFixed(1) + '°', up ? 'up' : 'down'),
        ...kv('Distance', Math.round(moon.distanceKm).toLocaleString() + ' km'),
        ...kv('Illumination', Math.round(moon.illum * 100) + '%'),
        ...kv('Phase', moon.phaseName),
      ])
    );
  }

  function updateInfo(info, moon, selBody) {
    const k = kv;
    infoText.innerHTML = '';

    // A non-satellite sky target (Moon / Sun / planet / DSO) is selected.
    if (selBody) {
      const up = selBody.el >= 0;
      selReadout.innerHTML = `<b>${selBody.name}</b> &nbsp; ${selBody.el.toFixed(1)}° el / ${selBody.az.toFixed(0)}° az`;
      infoText.append(
        h('div', { class: 'section-title' }, selBody.name),
        h('div', { class: 'kv' }, [
          ...k('Elevation', selBody.el.toFixed(1) + '°', up ? 'up big' : 'down big'),
          ...k('Azimuth', selBody.az.toFixed(1) + '°'),
          ...selBody.extra.flatMap(([a, b]) => k(a, b)),
        ]),
        h('div', { class: 'muted', style: 'margin-top:6px' }, up ? 'Above the horizon — trackable now.' : 'Below the horizon.')
      );
      if (moon && selBody.kind !== 'moon') appendMoonSection(moon);
      return;
    }

    if (!info) {
      selReadout.innerHTML = '<span class="muted">No target selected</span>';
      infoText.append(h('div', { class: 'empty' }, 'Select a satellite, planet, the Moon, or a deep-sky object'));
    } else {
      selReadout.innerHTML = info.aboveHorizon
        ? `<b>${info.name}</b> &nbsp; ${info.el.toFixed(1)}° el / ${info.az.toFixed(0)}° az`
        : `<b>${info.name}</b> &nbsp; ${info.statusText}`;

      const head = h('div', { class: 'kv' }, [
        ...k('Status', info.statusText, info.aboveHorizon ? 'up big' : 'big'),
        ...k('TLE age', fmtAge(info.tleAgeDays), info.tleStale ? 'warn' : ''),
      ]);
      const pos = h('div', { class: 'kv' }, [
        ...k('Latitude', info.lat.toFixed(3) + '°'),
        ...k('Longitude', info.lon.toFixed(3) + '°'),
        ...k('Altitude', info.altKm.toFixed(1) + ' km'),
        ...k('Velocity', info.velocityKmS.toFixed(3) + ' km/s'),
      ]);
      const look = h('div', { class: 'kv' }, [
        ...k('Azimuth', info.aboveHorizon ? info.az.toFixed(1) + '°' : '—'),
        ...k('Elevation', info.aboveHorizon ? info.el.toFixed(1) + '°' : '—', info.aboveHorizon ? 'up' : 'down'),
        ...k('Range', info.rangeKm ? info.rangeKm.toFixed(0) + ' km' : '—'),
        ...k('Downlink', (store.get().hw.radio.downlinkHz / 1e6).toFixed(4) + ' MHz'),
        ...k('Doppler shift', (info.dopplerHz >= 0 ? '+' : '') + (info.dopplerHz / 1000).toFixed(2) + ' kHz'),
        ...k('Observed freq', (info.observedHz / 1e6).toFixed(5) + ' MHz'),
      ]);
      infoText.append(
        h('div', { class: 'section-title' }, info.name + ' · NORAD ' + info.noradId),
        head,
        h('div', { class: 'section-title' }, 'Sub-satellite point'),
        pos,
        h('div', { class: 'section-title' }, 'From ' + store.get().station.name),
        look,
      );
    }

    if (moon) appendMoonSection(moon);
  }

  // Renders the merged pass list for *all* tracked satellites. `items` is
  // [{ id, name, color, pass }] sorted by AOS; rows are clickable to select.
  function updatePasses(items, now) {
    const pane = tabPanes.passes;
    pane.innerHTML = '';
    pane.append(h('div', { class: 'section-title' }, 'Upcoming passes · tracked satellites'));

    if (!items || !items.length) {
      const anyTracked = store.get().tracked.length;
      pane.append(h('div', { class: 'empty' }, anyTracked
        ? 'No passes for your tracked satellites in the next 48 h above the horizon'
        : 'Check a satellite in the list to see its passes here'));
      return;
    }

    const selId = store.get().selected;
    for (const it of items) {
      const p = it.pass;
      const live = now >= p.aos && now <= p.los;
      const dur = `${Math.floor(p.durationS / 60)}m ${p.durationS % 60}s`;
      pane.append(
        h('div', {
          class: 'pass-row' + (live ? ' live' : '') + (it.id === selId ? ' selected' : ''),
          onclick: () => store.patch({ selected: it.id }),
        }, [
          h('div', { class: 'when pass-head' }, [
            h('span', { class: 'dot', style: `background:${it.color}` }),
            h('span', { class: 'pass-sat' }, it.name),
            h('span', { class: 'pass-when' }, fmtDateTime(p.aos) + (live ? ' · LIVE' : '')),
          ]),
          h('div', { class: 'meta' }, [
            h('span', {}, `Max el ${p.maxEl}°`),
            h('span', {}, `${dur}`),
          ]),
          h('div', { class: 'meta' }, [
            h('span', {}, `AOS ${azName(p.aosAz)} (${p.aosAz}°)`),
            h('span', {}, `LOS ${azName(p.losAz)} (${p.losAz}°)`),
          ]),
        ])
      );
    }
  }

  function setActiveView(view) {
    btn2d.classList.toggle('active', view === '2d');
    btn3d.classList.toggle('active', view === '3d');
    view2d.style.display = view === '2d' ? 'block' : 'none';
    view3d.style.display = view === '3d' ? 'block' : 'none';
    hint.textContent = view === '2d'
      ? 'Scroll to zoom · drag to pan · click a satellite to select'
      : 'Drag to rotate · scroll to zoom · click a satellite to select';
  }

  function setTleStamp(text) { tleStamp.textContent = text; }

  // Sync the on-map auto-track buttons + the Hardware-pane dropdown to the store.
  function syncAutoMode() {
    const mode = store.get().hw.rotator.autoMode || 'off';
    for (const [m] of trackModes) trackBtns[m].classList.toggle('active', m === mode);
    if (hwRefs.autoModeSel) hwRefs.autoModeSel.value = mode;
  }

  // Rotor connection light on the map (red = disconnected, green = connected).
  function setRotorConnected(connected) {
    rotorDot.classList.toggle('on', !!connected);
    rotorDot.title = connected ? 'Rotor connected' : 'Rotor disconnected';
  }

  // Update which tracked rows are flagged stale; re-render only on change.
  function setStaleIds(set) {
    if (set.size === staleIds.size && [...set].every((id) => staleIds.has(id))) return;
    staleIds = set;
    renderList();
  }

  function setTleStatus({ maxDays, stale, auto, online }) {
    const el = stationRefs && stationRefs.tleStatusEl;
    if (!el) return;
    el.classList.toggle('warn', stale > 0);
    let msg;
    if (stale > 0) msg = `⚠ ${stale} tracked TLE${stale > 1 ? 's' : ''} older than ${maxDays} d` + (online ? ' — refreshing when possible' : ' — offline, using cache');
    else msg = `✓ Tracked TLEs current (< ${maxDays} d old)`;
    if (!auto) msg += ' · auto-update off';
    el.textContent = msg;
  }

  return {
    view2d, view3d,
    renderList, updateClock, updateInfo, updatePasses, setActiveView, setTleStamp,
    setStaleIds, setTleStatus, syncAutoMode, setRotorConnected,
    hw: hwRefs,
  };
}

function trackTitle(m) {
  return m === 'off' ? 'Manual — rotator not auto-driven'
    : m === 'selected' ? 'Auto-track the selected target'
    : 'Auto-track scheduled passes across all tracked satellites';
}

/* ----------------------------- Station pane ----------------------------- */
function buildStationPane(pane, handlers) {
  const st = store.get().station;
  const mk = (label, value, step, on) =>
    h('label', { class: 'fld' }, [h('span', {}, label), inputNum(value, step, on)]);
  pane.append(
    h('div', { class: 'section-title' }, 'Ground station'),
    h('label', { class: 'fld' }, [h('span', {}, 'Name'),
      h('input', { type: 'text', value: st.name, oninput: (e) => store.patchIn('station', { name: e.target.value }) })]),
    h('div', { class: 'grid2' }, [
      mk('Latitude (°)', st.lat, '0.0001', (v) => store.patchIn('station', { lat: v })),
      mk('Longitude (°)', st.lon, '0.0001', (v) => store.patchIn('station', { lon: v })),
    ]),
    h('div', { class: 'grid2' }, [
      mk('Altitude (m)', Math.round(st.altKm * 1000), '1', (v) => store.patchIn('station', { altKm: v / 1000 })),
      mk('Min elevation (°)', store.get().minEl, '1', (v) => store.patch({ minEl: v })),
    ]),
    h('div', { class: 'muted' }, 'Pass predictions and look angles are computed for this location.')
  );

  // TLE freshness scheduler.
  const sched = store.get().tleSched;
  const autoChk = checkbox(sched.auto, (v) => store.patchIn('tleSched', { auto: v }));
  const maxAgeInp = inputNum(sched.maxAgeDays, '1', (v) => store.patchIn('tleSched', { maxAgeDays: Math.max(1, Math.round(v)) }));
  const tleStatusEl = h('div', { class: 'tle-status', style: 'margin-top:8px' }, '');
  pane.append(
    h('hr', { class: 'hr' }),
    h('div', { class: 'section-title' }, 'TLE updates'),
    h('div', { class: 'toggle-line switch' }, [h('span', {}, 'Auto-update cached TLEs'), autoChk]),
    h('label', { class: 'fld' }, [h('span', {}, 'Max TLE age (days)'), maxAgeInp]),
    h('button', { class: 'btn', onclick: () => handlers.updateTlesNow() }, 'Update now'),
    tleStatusEl,
    h('div', { class: 'muted', style: 'margin-top:6px' }, 'Keeps saved TLEs current for accurate tracking (works alongside SatDump). Uses cached elements when offline.')
  );

  return { tleStatusEl };
}

/* ----------------------------- Hardware pane ---------------------------- */
function buildHwPane(pane, handlers) {
  const hw = store.get().hw;

  // Rotator
  const rotPill = statusPill('Rotator disconnected');
  const rotConnect = h('button', { class: 'btn primary', onclick: () => handlers.connectRotator() }, 'Connect');
  const rotTarget = h('div', { class: 'kv' }, []);
  const autoMode = h('select', { onchange: (e) => store.patchIn('hw.rotator', { autoMode: e.target.value }) }, [
    h('option', { value: 'off' }, 'Off (manual)'),
    h('option', { value: 'selected' }, 'Selected target'),
    h('option', { value: 'schedule' }, 'Scheduled passes (all tracked)'),
  ]);
  autoMode.value = hw.rotator.autoMode || 'off';
  const rotMinEl = inputNum(hw.rotator.minEl, '1', (v) => store.patchIn('hw.rotator', { minEl: v }));

  // Protocol: 'hamlib' = legacy rotctld goto; 'superrot' = smooth continuous motion.
  const rotProtocol = h('select', {
    onchange: (e) => { store.patchIn('hw.rotator', { protocol: e.target.value }); renderRotDynamic(); },
  }, [
    h('option', { value: 'hamlib' }, 'Hamlib / rotctld (legacy)'),
    h('option', { value: 'superrot' }, 'SuperRot (smooth)'),
  ]);
  rotProtocol.value = hw.rotator.protocol;

  // Transport (SuperRot only): WiFi/TCP or USB serial to the MCU.
  const rotTransport = h('select', {
    onchange: (e) => { store.patchIn('hw.rotator', { transport: e.target.value }); renderRotDynamic(); },
  }, [
    h('option', { value: 'tcp' }, 'WiFi / TCP'),
    h('option', { value: 'serial' }, 'USB serial'),
  ]);
  rotTransport.value = hw.rotator.transport;
  const transportRow = h('label', { class: 'fld' }, [h('span', {}, 'Transport'), rotTransport]);

  // Connection fields and speed limits are rebuilt by renderRotDynamic() on change.
  const rotConn = h('div', {});
  const rotLimits = h('div', {}, [
    h('div', { class: 'grid2' }, [
      h('label', { class: 'fld' }, [h('span', {}, 'Max Az speed (°/s)'), inputNum(hw.rotator.maxVelAz, '0.5', (v) => store.patchIn('hw.rotator', { maxVelAz: v }))]),
      h('label', { class: 'fld' }, [h('span', {}, 'Max El speed (°/s)'), inputNum(hw.rotator.maxVelEl, '0.5', (v) => store.patchIn('hw.rotator', { maxVelEl: v }))]),
    ]),
  ]);

  // USB serial-port picker: enumerates devices by friendly name, persists the path.
  const portSelect = h('select', { onchange: (e) => store.patchIn('hw.rotator', { path: e.target.value }) });
  async function refreshPorts() {
    portSelect.innerHTML = '';
    portSelect.append(h('option', { value: '' }, 'Scanning…'));
    const r = await window.pyro.rotator.listPorts();
    portSelect.innerHTML = '';
    if (!r.ok) { portSelect.append(h('option', { value: '' }, r.error || 'USB unavailable')); return; }
    if (!r.ports.length) { portSelect.append(h('option', { value: '' }, 'No ports found')); return; }
    const cur = store.get().hw.rotator.path;
    for (const p of r.ports) portSelect.append(h('option', { value: p.path }, p.label));
    if (r.ports.some((p) => p.path === cur)) portSelect.value = cur;
    else { portSelect.value = r.ports[0].path; store.patchIn('hw.rotator', { path: r.ports[0].path }); }
  }

  function renderRotDynamic() {
    const r = store.get().hw.rotator;
    const superrot = r.protocol === 'superrot';
    transportRow.style.display = superrot ? '' : 'none';
    rotLimits.style.display = superrot ? '' : 'none';
    rotConn.innerHTML = '';
    if (superrot && r.transport === 'serial') {
      const baud = inputNum(r.baud, '1', (v) => store.patchIn('hw.rotator', { baud: v }));
      rotConn.append(
        h('label', { class: 'fld' }, [h('span', {}, 'Serial port'), portSelect]),
        h('div', { class: 'row', style: 'display:flex;gap:8px;margin-top:6px;align-items:flex-end' }, [
          h('label', { class: 'fld', style: 'flex:1' }, [h('span', {}, 'Baud'), baud]),
          h('button', { class: 'btn sm', onclick: () => refreshPorts() }, 'Refresh'),
        ])
      );
      refreshPorts();
    } else {
      const host = h('input', { type: 'text', value: r.host, oninput: (e) => store.patchIn('hw.rotator', { host: e.target.value }) });
      const port = inputNum(r.port, '1', (v) => store.patchIn('hw.rotator', { port: v }));
      rotConn.append(h('div', { class: 'grid2' }, [
        h('label', { class: 'fld' }, [h('span', {}, 'Host'), host]),
        h('label', { class: 'fld' }, [h('span', {}, 'Port'), port]),
      ]));
    }
  }

  // Radio
  const radPill = statusPill('Radio disconnected');
  const radHost = h('input', { type: 'text', value: hw.radio.host, oninput: (e) => store.patchIn('hw.radio', { host: e.target.value }) });
  const radPort = inputNum(hw.radio.port, '1', (v) => store.patchIn('hw.radio', { port: v }));
  const radConnect = h('button', { class: 'btn primary', onclick: () => handlers.connectRadio() }, 'Connect');
  const downlink = inputNum((hw.radio.downlinkHz / 1e6).toFixed(4), '0.0001', (v) => store.patchIn('hw.radio', { downlinkHz: Math.round(v * 1e6) }));
  const doppler = checkbox(hw.radio.doppler, (v) => store.patchIn('hw.radio', { doppler: v }));
  const radFreqLive = h('div', { class: 'kv' }, []);

  pane.append(
    h('div', { class: 'section-title' }, 'Rotator'),
    rotPill,
    h('label', { class: 'fld', style: 'margin-top:8px' }, [h('span', {}, 'Protocol'), rotProtocol]),
    transportRow,
    rotConn,
    h('div', { class: 'row', style: 'display:flex;gap:8px;margin-top:8px' }, [
      rotConnect,
      h('button', { class: 'btn', onclick: () => handlers.stopRotator() }, 'Stop'),
      h('button', { class: 'btn', onclick: () => handlers.parkRotator() }, 'Park'),
    ]),
    h('label', { class: 'fld', style: 'margin-top:8px' }, [h('span', {}, 'Auto-track'), autoMode]),
    h('label', { class: 'fld' }, [h('span', {}, 'Track above elevation (°)'), rotMinEl]),
    h('div', { class: 'muted', style: 'font-size:11px' }, 'Scheduled passes follows whichever tracked satellite is up, switching as passes come and go. Below the elevation limit the rotator parks.'),
    rotLimits,
    rotTarget,

    h('hr', { class: 'hr' }),
    h('div', { class: 'section-title' }, 'Radio (rigctld / Hamlib)'),
    radPill,
    h('div', { class: 'grid2', style: 'margin-top:8px' }, [
      h('label', { class: 'fld' }, [h('span', {}, 'Host'), radHost]),
      h('label', { class: 'fld' }, [h('span', {}, 'Port'), radPort]),
    ]),
    radConnect,
    h('label', { class: 'fld', style: 'margin-top:8px' }, [h('span', {}, 'Downlink frequency (MHz)'), downlink]),
    h('div', { class: 'toggle-line switch' }, [h('span', {}, 'Doppler correction'), doppler]),
    radFreqLive,
  );

  renderRotDynamic();

  return { rotPill, radPill, rotConnect, radConnect, rotTarget, radFreqLive, autoModeSel: autoMode };
}

/* -------------------------------- helpers ------------------------------- */
function inputNum(value, step, on) {
  return h('input', {
    type: 'number', value, step,
    oninput: (e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) on(v); },
  });
}
function checkbox(checked, on) {
  const cb = h('input', { type: 'checkbox', onchange: (e) => on(e.target.checked) });
  cb.checked = checked;
  return cb;
}
function statusPill(text) {
  const led = h('span', { class: 'led' });
  const label = h('span', {}, text);
  const pill = h('span', { class: 'status-pill' }, [led, label]);
  pill._set = (on, t) => { pill.classList.toggle('on', on); label.textContent = t; };
  return pill;
}

// Stable color per tracked satellite (by position in the tracked list).
const PALETTE = ['#57d0a0', '#4a9fd4', '#ffd23f', '#ff8c6b', '#c792ea', '#7ee787', '#ff6b9d', '#5fd3e0'];
export function colorFor(id, tracked) {
  const i = tracked.indexOf(id);
  return PALETTE[(i < 0 ? tracked.length : i) % PALETTE.length];
}

function fmtDateTime(d) {
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtAge(days) {
  if (days == null || !isFinite(days)) return '—';
  return days < 1 ? Math.max(0, Math.round(days * 24)) + ' h' : days.toFixed(1) + ' d';
}
function azName(az) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((az % 360) / 45)) % 8];
}
