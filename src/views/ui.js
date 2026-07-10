import { store } from '../core/store.js';
import { THEMES } from '../core/themes.js';
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

// Traditional astronomical symbols — cleaner than emoji, and they inherit theme color.
const SKY_GLYPH = {
  MOON: '☾', SUN: '☉', MERCURY: '☿', VENUS: '♀', MARS: '♂',
  JUPITER: '♃', SATURN: '♄', URANUS: '♅', NEPTUNE: '♆',
};

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

  // Theme picker — restyles the whole app (panels + map/globe/polar) live.
  const themeSel = h('select', {
    class: 'theme-sel',
    title: 'Color theme',
    onchange: (e) => store.patch({ theme: e.target.value }),
  }, Object.entries(THEMES).map(([id, t]) => h('option', { value: id }, t.name)));
  themeSel.value = store.get().theme;

  // UI size (S/M/L). Changing it manually exits Field mode.
  const sizeDefs = [['sm', 'S'], ['md', 'M'], ['lg', 'L']];
  const sizeBtns = {};
  const sizeSeg = h('div', { class: 'seg size-seg', title: 'UI size' }, sizeDefs.map(([k, l]) =>
    (sizeBtns[k] = h('button', { onclick: () => store.patch({ uiScale: k, fieldMode: false }) }, l))));

  // Field mode: one tap → large controls + Night Ops theme (and back).
  const fieldBtn = h('button', {
    class: 'btn sm field-btn',
    title: 'Field mode — large touch controls + Night Ops theme',
    onclick: () => {
      const on = !store.get().fieldMode;
      store.patch(on
        ? { fieldMode: true, uiScale: 'lg', theme: 'nightops' }
        : { fieldMode: false, uiScale: 'md', theme: 'midnight' });
      themeSel.value = store.get().theme;
    },
  }, '⛶ Field');

  const topbar = h('div', { class: 'topbar' }, [
    h('div', { class: 'brand' }, [
      h('img', { class: 'brand-logo', src: './icon.png', alt: '' }),
      h('span', { class: 'brand-text', html: 'Sky<span>Phreak</span>' }),
    ]),
    h('div', { class: 'spacer' }),
    selReadout,
    sizeSeg,
    fieldBtn,
    themeSel,
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
  const oemBtn = h('button', {
    class: 'btn sm',
    title: 'Load a CCSDS OEM ephemeris file (.oem/.txt/.xml) — precise tabulated state vectors, interpolated instead of SGP4',
    onclick: () => handlers.loadOem(),
  }, 'Load OEM…');
  const tleStamp = h('div', { class: 'muted', style: 'font-size:11px;margin-top:6px' }, '');
  const search = h('input', { type: 'text', placeholder: 'Search…', oninput: (e) => { searchTerm = e.target.value.toLowerCase(); renderList(); } });
  const listEl = h('div', { class: 'satlist grow' });
  let searchTerm = '';
  let browserFilter = 'all'; // all | tracked | favorites | sky
  let dsoOpen = false; // whether the deep-sky list is expanded
  let solarOpen = true; // whether the Solar System list is expanded
  let staleIds = new Set(); // tracked sats whose TLE epoch exceeds the max age
  let skyStatus = {}; // { id: elevation° } — live, for the Sky list chips

  // Segmented filter — one browser instead of four stacked boxes.
  const filterDefs = [['all', 'All'], ['tracked', 'Tracked'], ['favorites', 'Favs'], ['sky', 'Sky']];
  const filterBtns = {};
  const filterBar = h('div', { class: 'seg' }, filterDefs.map(([k, l]) =>
    (filterBtns[k] = h('button', { class: k === browserFilter ? 'active' : '', onclick: () => { browserFilter = k; syncFilter(); renderList(); } }, l))));
  const catalogControls = h('div', { class: 'catalog-controls' }, [
    groupSel,
    h('div', { class: 'row', style: 'margin-top:6px' }, [refreshBtn, oemBtn]),
    tleStamp,
  ]);
  function syncFilter() {
    for (const [k] of filterDefs) filterBtns[k].classList.toggle('active', k === browserFilter);
    catalogControls.style.display = browserFilter === 'all' ? '' : 'none';
  }

  const sidebar = h('aside', { class: 'sidebar' }, [
    h('div', { class: 'side-top' }, [search, filterBar, catalogControls]),
    listEl,
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

  // Follow-satellite toggle (keeps the active view centred on the selection).
  const followBtn = h('button', {
    class: 'btn sm', title: 'Follow the selected satellite — keep it centred in the view',
    onclick: () => store.patch({ followSat: !store.get().followSat }),
  }, '⌖ Follow');

  // Time-warp scrubber: a slider that shifts the *view* time to preview passes; hardware
  // stays live. A ⏱ button in the toolbar reveals it; LIVE snaps back to real time.
  const warpLabel = h('span', { class: 'warp-label' }, 'LIVE');
  const warpSlider = h('input', {
    type: 'range', min: -180, max: 180, step: 1, value: 0, class: 'warp-slider',
    oninput: (e) => {
      const m = +e.target.value;
      handlers.setTimeWarp(m);
      warpLabel.textContent = m === 0 ? 'LIVE' : (m > 0 ? '+' : '') + m + ' min';
      warpBar.classList.toggle('warped', m !== 0);
    },
  });
  const resetWarp = () => { warpSlider.value = 0; handlers.setTimeWarp(0); warpLabel.textContent = 'LIVE'; warpBar.classList.remove('warped'); };
  const warpBar = h('div', { class: 'warp-bar', style: 'display:none' }, [
    h('span', { class: 'warp-title' }, '⏱'), warpSlider, warpLabel,
    h('button', { class: 'btn sm', title: 'Return to live', onclick: resetWarp }, 'LIVE'),
  ]);
  const warpToggle = h('button', {
    class: 'btn sm', title: 'Time-warp — scrub the view into the future/past to preview passes',
    onclick: () => { const show = warpBar.style.display === 'none'; warpBar.style.display = show ? '' : 'none'; if (!show) resetWarp(); },
  }, '⏱');

  const tools = h('div', { class: 'stage-tools' }, [followBtn, warpToggle, mapStyleBtn, resetBtn]);

  // Auto-track mode buttons — now live in the status bar (built below).
  const trackBtns = {};
  const trackModes = [['off', 'Off'], ['selected', 'Selected'], ['schedule', 'Tracked']];
  const trackBar = h('div', { class: 'track-btns' }, trackModes.map(([m, label]) =>
    (trackBtns[m] = h('button', { class: 'btn sm track-btn', title: trackTitle(m), onclick: () => store.patchIn('hw.rotator', { autoMode: m }) }, label))));

  // Edge handles to collapse/expand the side panels (map-first mode).
  const sideToggle = h('button', { class: 'panel-toggle side', title: 'Collapse / expand the list', onclick: () => store.patch({ sideCollapsed: !store.get().sideCollapsed }) }, '◂');
  const rightToggle = h('button', { class: 'panel-toggle right', title: 'Collapse / expand the panel', onclick: () => store.patch({ rightCollapsed: !store.get().rightCollapsed }) }, '▸');

  const hint = h('div', { class: 'view-hint' }, 'Scroll to zoom · drag to pan · click a satellite to select');
  // Persistent emergency stop — always on the map while the rotator is connected,
  // so a halt is one tap away from any tab. Also bound to the Esc key (below).
  const estopFab = h('button', {
    class: 'estop-fab',
    title: 'Emergency stop (Esc) — halt the rotator immediately',
    onclick: () => handlers.stopRotator(),
  }, '⏹ STOP');
  const stage = h('main', { class: 'stage' }, [view2d, view3d, tools, warpBar, hint, sideToggle, rightToggle, estopFab]);

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

  /* ----------------------------- Status bar ------------------------------ */
  // Persistent bottom strip: clock, hardware connection state, and what the rotator
  // is currently tracking — the sort of at-a-glance status a finished app carries.
  const sbDot = (label) => {
    const dot = h('span', { class: 'sb-dot' });
    const el = h('div', { class: 'sb-item', title: label }, [dot, h('span', { class: 'sb-txt' }, label)]);
    return { el, set: (on) => dot.classList.toggle('on', on) };
  };
  const sbRot = sbDot('Rotator');
  const sbRad = sbDot('Radio');
  const sbTrack = h('span', { class: 'sb-val' }, 'Idle');
  // Cable-wrap gauge — azimuth turns accumulated away from north (hidden when idle).
  const sbWrapVal = h('span', { class: 'sb-val sb-wrap-val' }, '—');
  const sbWrap = h('div', { class: 'sb-item sb-wrap', style: 'display:none', title: 'Cable wrap' }, [
    h('span', { class: 'sb-k' }, 'Wrap'), sbWrapVal,
  ]);
  const statusbar = h('footer', { class: 'statusbar' }, [
    clockEl,
    h('div', { class: 'sb-sep' }),
    h('div', { class: 'sb-item' }, [h('span', { class: 'sb-k' }, 'Track'), trackBar]),
    h('div', { class: 'sb-item sb-target' }, [h('span', { class: 'sb-k' }, 'Target'), sbTrack]),
    h('div', { class: 'spacer' }),
    sbWrap,
    // Field controls always within reach — no digging into the Hardware tab.
    h('button', { class: 'btn sm', title: 'Park the rotator (to the default preset)', onclick: () => handlers.parkRotator() }, 'Park'),
    h('button', { class: 'btn sm danger', title: 'Stop the rotator (Esc)', onclick: () => handlers.stopRotator() }, 'Stop'),
    h('div', { class: 'sb-sep' }),
    sbRot.el,
    sbRad.el,
  ]);
  function setStatus({ rotConnected, radConnected, tracking }) {
    sbRot.set(rotConnected);
    sbRad.set(radConnected);
    sbTrack.textContent = tracking || 'Idle';
  }
  // Cable-wrap readout: {az, turns, level, warn, max} or null to hide.
  function setCableWrap(info) {
    if (!info) { sbWrap.style.display = 'none'; return; }
    sbWrap.style.display = '';
    const t = info.turns;
    sbWrapVal.textContent = (t >= 0 ? '+' : '−') + Math.abs(t).toFixed(2) + 't';
    sbWrapVal.className = 'sb-val sb-wrap-val ' + info.level;
    sbWrap.title = `Cable wrap: ${info.az.toFixed(0)}° from north (${t.toFixed(2)} turns). `
      + `Amber ≥ ${info.warn}°, red ≥ ${info.max}° — unwind manually.`;
  }

  // Collapse/expand the side panels, and set the global UI size class.
  function applyLayout(state) {
    sidebar.classList.toggle('collapsed', !!state.sideCollapsed);
    rightpanel.classList.toggle('collapsed', !!state.rightCollapsed);
    sideToggle.textContent = state.sideCollapsed ? '▸' : '◂';
    rightToggle.textContent = state.rightCollapsed ? '◂' : '▸';
    const root = document.documentElement;
    root.classList.remove('ui-sm', 'ui-md', 'ui-lg');
    root.classList.add('ui-' + (state.uiScale || 'md'));
    if (sizeBtns) for (const [k] of sizeDefs) sizeBtns[k].classList.toggle('active', k === (state.uiScale || 'md'));
    if (fieldBtn) fieldBtn.classList.toggle('active', !!state.fieldMode);
    followBtn.classList.toggle('active', !!state.followSat);
  }
  applyLayout(store.get());

  app.append(topbar, h('div', { class: 'body' }, [sidebar, stage, rightpanel]), statusbar);

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

  // Floating swatch picker for a satellite's color.
  let colorPop = null;
  const closeColorPop = () => {
    if (!colorPop) return;
    colorPop.remove();
    colorPop = null;
    document.removeEventListener('mousedown', onColorDocDown, true);
  };
  function onColorDocDown(e) { if (colorPop && !colorPop.contains(e.target)) closeColorPop(); }
  function openColorPicker(id, anchor) {
    const wasThis = colorPop && colorPop.dataset.id === id;
    closeColorPop();
    if (wasThis) return; // toggle off if clicking the same dot
    const cur = store.get().satColors[id];
    colorPop = h('div', { class: 'color-pop' }, [
      h('div', { class: 'color-grid' }, SWATCHES.map((c) =>
        h('button', {
          class: 'color-sw' + (c.toLowerCase() === (cur || '').toLowerCase() ? ' sel' : ''),
          style: `background:${c}`, title: c,
          onclick: (e) => { e.stopPropagation(); store.setSatColor(id, c); closeColorPop(); },
        }))),
      h('div', { class: 'color-actions' }, [
        h('label', { class: 'color-custom', title: 'Custom color' }, [
          h('input', { type: 'color', value: cur || colorFor(id, store.get().tracked), oninput: (e) => store.setSatColor(id, e.target.value) }),
          'Custom',
        ]),
        h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); store.clearSatColor(id); closeColorPop(); } }, 'Auto'),
      ]),
    ]);
    colorPop.dataset.id = id;
    document.body.appendChild(colorPop);
    const r = anchor.getBoundingClientRect();
    colorPop.style.left = Math.max(6, Math.min(r.left - 4, window.innerWidth - 190)) + 'px';
    colorPop.style.top = r.bottom + 5 + 'px';
    setTimeout(() => document.addEventListener('mousedown', onColorDocDown, true), 0);
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
    const dot = tracked
      ? h('button', {
          class: 'dot dot-btn', style: `background:${color}`, title: 'Click to change colour',
          onclick: (e) => { e.stopPropagation(); openColorPicker(id, e.currentTarget); },
        })
      : h('span', { class: 'dot', style: 'background:transparent;border:1px solid var(--line)' });
    return h('div', {
      class: 'sat-row' + (selected ? ' selected' : ''),
      onclick: () => store.patch({ selected: id }),
    }, [
      cb,
      dot,
      h('span', { class: 'nm' }, name),
      stale ? h('span', { class: 'stale-badge', title: 'TLE older than the max age — update when online' }, 'old TLE') : h('span', { class: 'nid' }, id),
      star,
    ]);
  }

  // A selectable sky-target row (Moon/Sun/planet/DSO): symbol · name · type · live el.
  function bodyRow(id, name, color, selected, opts = {}) {
    const { glyph = '✦', sub = '', el } = opts;
    const hasEl = Number.isFinite(el);
    const up = hasEl && el >= 0;
    return h('div', {
      class: 'sat-row sky-row' + (selected ? ' selected' : ''),
      onclick: () => store.patch({ selected: id }),
    }, [
      h('span', { class: 'sky-glyph', style: `color:${color}` }, glyph),
      h('span', { class: 'nm' }, name),
      sub ? h('span', { class: 'sky-sub' }, sub) : h('span', {}),
      h('span', { class: 'sky-el' + (hasEl ? (up ? ' up' : ' down') : ' none') },
        hasEl ? (up ? el.toFixed(0) + '°' : '↓') : ''),
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

  // Render the Sky filter (Solar System + deep sky) into the unified list.
  function renderSky(target) {
    const st = store.get();
    const sel = st.selected;
    const q = searchTerm; // a search reveals matches regardless of collapse state
    const solar = SKY_BODIES.filter(([, name]) => !q || name.toLowerCase().includes(q));
    const dsos = DSOS.filter((d) => !q || d.name.toLowerCase().includes(q) || (d.id + '').toLowerCase().includes(q));

    target.append(groupHead(solarOpen, `Solar System${q ? ` (${solar.length})` : ''}`, () => { solarOpen = !solarOpen; renderList(); },
      h('div', { class: 'chk-group' }, [
        h('label', { class: 'on-map', title: 'Show the Moon on the 2D map' }, [checkbox(st.showMoon, (v) => store.patch({ showMoon: v })), h('span', {}, 'Moon')]),
        h('label', { class: 'on-map', title: 'Show the Sun & planets on the 2D map' }, [checkbox(st.showPlanets, (v) => store.patch({ showPlanets: v })), h('span', {}, 'Planets')]),
      ])));
    if (solarOpen || q) for (const [id, name, color] of solar) {
      target.append(bodyRow(id, name, color, sel === id, { glyph: SKY_GLYPH[id], el: skyStatus[id] }));
    }

    target.append(groupHead(dsoOpen, `Deep sky${q ? ` (${dsos.length})` : ''}`, () => { dsoOpen = !dsoOpen; renderList(); },
      onMapChk('showDso', 'Overlay all deep-sky objects on the 2D map')));
    if (dsoOpen || q) for (const d of dsos) {
      const did = 'DSO:' + d.id;
      const type = d.type.replace(/ nebula/i, ' Neb.').replace(/ cluster/i, ' Cl.').replace(/ galaxy/i, ' Gal.');
      const sub = (d.mag != null ? 'm' + d.mag + ' · ' : '') + type;
      target.append(bodyRow(did, d.name, '#c792ea', sel === did, { glyph: '✦', sub, el: skyStatus[did] }));
    }
    if (q && !solar.length && !dsos.length) target.append(h('div', { class: 'empty' }, 'No sky objects match'));
  }

  // Live elevation for the Sky-list chips (main.js feeds it each tick when active).
  function updateSky(map) {
    skyStatus = map || {};
    if (browserFilter === 'sky') renderList();
  }
  const isSkyActive = () => browserFilter === 'sky';

  // Unified satellite browser: one list driven by the segmented filter + search.
  function renderList() {
    const st = store.get();
    const tracked = new Set(st.tracked);
    const favIds = new Set(st.favorites.map((f) => f.id));
    const savedScroll = listEl.scrollTop;
    listEl.innerHTML = '';

    if (browserFilter === 'sky') { renderSky(listEl); return; }

    let entries;
    let emptyMsg;
    if (browserFilter === 'tracked') {
      entries = st.tracked.map((id) => ({ id, s: satLike(id) }));
      emptyMsg = 'No satellites tracked — check one in All';
    } else if (browserFilter === 'favorites') {
      entries = st.favorites.map((f) => ({ id: f.id, s: { name: f.name } }));
      emptyMsg = 'Tap ☆ on a satellite to add it';
    } else {
      const catalog = store.getCatalog();
      entries = catalog.map((s) => ({ id: s.noradId, s }));
      emptyMsg = catalog.length ? 'No matches' : 'Loading catalog…';
    }
    if (searchTerm) entries = entries.filter(({ id, s }) => (s && s.name || '').toLowerCase().includes(searchTerm) || id.includes(searchTerm));
    if (browserFilter === 'all') entries = entries.slice(0, 250);

    if (!entries.length) {
      listEl.append(h('div', { class: 'empty' }, emptyMsg));
      return;
    }
    for (const { id, s } of entries) {
      listEl.append(satRow({
        id, name: s ? s.name : 'NORAD ' + id,
        tracked: tracked.has(id), favorite: favIds.has(id),
        selected: st.selected === id, color: colorFor(id, st.tracked),
      }));
    }
    listEl.scrollTop = savedScroll;
  }

  function updateClock(date, warpMs = 0) {
    const utc = date.toISOString().slice(11, 19);
    const loc = date.toLocaleTimeString();
    let extra = '';
    if (warpMs) {
      const m = Math.round(warpMs / 60000);
      extra = ` &nbsp;·&nbsp; <span class="clock-warp">${m >= 0 ? '+' : ''}${m}m preview</span>`;
    }
    clockEl.innerHTML = `<b>${utc}</b> UTC &nbsp;·&nbsp; ${loc}${extra}`;
  }

  const kv = (label, value, cls = '') => [h('div', { class: 'k' }, label), h('div', { class: 'v ' + cls }, value)];

  // EME (Moon-bounce) working figures for the selected Moon, with an editable frequency.
  function appendEmeSection(eme) {
    const freq = h('input', {
      type: 'number', step: '1', value: eme.freqMHz, style: 'width:80px',
      oninput: (e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) handlers.setEmeFreq(v); },
    });
    const dop = eme.dopplerHz;
    infoText.append(
      h('div', { class: 'section-title' }, '☾ EME · Moon-bounce'),
      h('label', { class: 'fld' }, [h('span', {}, 'Frequency (MHz)'), freq]),
      h('div', { class: 'stat-grid' }, [
        statCard('Path loss (echo)', eme.echoPathLoss.toFixed(1) + ' dB'),
        statCard('Path loss (1-way)', eme.fsplOneWay.toFixed(1) + ' dB'),
        statCard('Echo Doppler', (dop >= 0 ? '+' : '') + (dop / 1000).toFixed(2) + ' kHz'),
        statCard('Declination', eme.declination.toFixed(1) + '°'),
        statCard('Degradation', '+' + eme.degradationDb.toFixed(1) + ' dB'),
        statCard('Range', Math.round(eme.rangeKm).toLocaleString() + ' km'),
      ]),
      h('div', { class: 'muted', style: 'font-size:11px' }, 'Free-space path loss + self-echo Doppler for the current Moon geometry. Degradation is extra two-way loss vs. perigee (sky-noise and libration not modelled).')
    );
  }

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
    infoText.innerHTML = '';

    // A non-satellite sky target (Moon / Sun / planet / DSO) is selected.
    if (selBody) {
      const up = selBody.el >= 0;
      selReadout.innerHTML = `<b>${selBody.name}</b> &nbsp; ${selBody.el.toFixed(1)}° el / ${selBody.az.toFixed(0)}° az`;
      infoText.append(
        h('div', { class: 'dash-head' }, [
          h('div', { class: 'dash-name' }, selBody.name),
          h('div', { class: 'dash-badge ' + (up ? 'up' : 'down') }, up ? 'ABOVE HORIZON' : 'BELOW HORIZON'),
        ]),
        h('div', { class: 'stat-grid' }, [
          statCard('Azimuth', selBody.az.toFixed(1) + '°', 'big'),
          statCard('Elevation', selBody.el.toFixed(1) + '°', 'big ' + (up ? 'up' : 'down')),
          ...selBody.extra.map(([a, b]) => statCard(a, b)),
        ])
      );
      if (selBody.eme) appendEmeSection(selBody.eme);
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
      const rf = store.get().hw.radio;
      infoText.append(
        h('div', { class: 'dash-head' }, [
          h('div', { class: 'dash-name' }, info.name),
          h('div', { class: 'dash-id' }, 'NORAD ' + info.noradId),
        ]),
        h('div', { class: 'dash-status ' + (info.aboveHorizon ? 'up' : '') }, info.statusText),
        h('div', { class: 'stat-grid' }, [
          statCard('Azimuth', info.aboveHorizon ? info.az.toFixed(1) + '°' : '—', 'big'),
          statCard('Elevation', info.aboveHorizon ? info.el.toFixed(1) + '°' : '—', 'big ' + (info.aboveHorizon ? 'up' : 'down')),
          statCard('Range', info.rangeKm ? info.rangeKm.toFixed(0) + ' km' : '—'),
          statCard('Altitude', info.altKm.toFixed(0) + ' km'),
          statCard('Velocity', info.velocityKmS.toFixed(2) + ' km/s'),
          statCard('TLE age', fmtAge(info.tleAgeDays), info.tleStale ? 'warn' : ''),
          statCard('Doppler', (info.dopplerHz >= 0 ? '+' : '') + (info.dopplerHz / 1000).toFixed(2) + ' kHz'),
          statCard('Downlink', (rf.downlinkHz / 1e6).toFixed(3) + ' MHz'),
        ]),
        h('div', { class: 'section-title' }, 'Sub-satellite point'),
        h('div', { class: 'kv' }, [
          ...kv('Latitude', info.lat.toFixed(3) + '°'),
          ...kv('Longitude', info.lon.toFixed(3) + '°'),
          ...kv('Observed freq', (info.observedHz / 1e6).toFixed(5) + ' MHz'),
        ])
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
    const ap = store.get().hw.rotator.armedPass;
    for (const it of items) {
      const p = it.pass;
      const live = now >= p.aos && now <= p.los;
      const untilMs = p.aos.getTime() - now;
      const count = live ? 'LOS ' + fmtCountdown(p.los.getTime() - now) : fmtCountdown(untilMs);
      const countCls = live ? 'now' : untilMs < 10 * 60000 ? 'soon' : '';
      const armed = ap && ap.id === it.id && Math.abs(ap.aos - p.aos.getTime()) < 60000;
      const mini = h('canvas', { class: 'pass-mini', title: `Max ${p.maxEl}° · AOS ${azName(p.aosAz)} → LOS ${azName(p.losAz)}` });

      pane.append(
        h('div', {
          class: 'pass-row' + (live ? ' live' : '') + (armed ? ' armed' : '') + (it.id === selId ? ' selected' : ''),
          onclick: () => store.patch({ selected: it.id }),
        }, [
          h('div', { class: 'pass-main' }, [
            h('div', { class: 'pass-l1' }, [
              h('span', { class: 'dot', style: `background:${it.color}` }),
              h('span', { class: 'pass-sat' }, it.name),
              h('span', { class: 'pass-norad' }, '#' + it.id),
              it.visible ? h('span', { class: 'pass-vis', title: 'Optically visible — satellite sunlit while you are in darkness' }, '👁') : h('span', {}),
              h('span', { class: 'pass-count ' + countCls }, count),
              h('button', {
                class: 'pass-arm' + (armed ? ' on' : ''),
                title: armed ? 'Armed — the rotator is committed to this pass. Click to release.' : 'Arm the rotator for this specific pass (switches to Tracked mode)',
                onclick: (e) => { e.stopPropagation(); armed ? handlers.disarmPass() : handlers.armPass(it.id, p.aos.getTime(), p.los.getTime()); },
              }, armed ? '● Armed' : 'Arm'),
            ]),
            h('div', { class: 'pass-l2' }, [
              h('span', { class: 'pass-times' }, fmtDateTime(p.aos) + ' → ' + p.los.toLocaleTimeString()),
              h('span', { class: 'pass-dur' }, `${Math.floor(p.durationS / 60)}m ${p.durationS % 60}s`),
              h('span', { class: 'pass-el' }, `${p.maxEl}°`),
            ]),
          ]),
          mini,
        ])
      );
      drawPassMini(mini, it.arc, it.color);
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

  // Rotor connection light (status-bar dot) + the floating emergency-stop button,
  // which only appears while the rotator is connected.
  function setRotorConnected(connected) {
    sbRot.set(!!connected);
    estopFab.classList.toggle('show', !!connected);
  }

  // Esc = emergency stop, from anywhere (unless typing in a field).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    handlers.stopRotator();
  });

  // Update which tracked rows are flagged stale; re-render only on change.
  function setStaleIds(set) {
    if (set.size === staleIds.size && [...set].every((id) => staleIds.has(id))) return;
    staleIds = set;
    renderList();
  }

  // Space-weather readout: { ok, kp, time } or { ok:false }.
  function setSpaceWeather(info) {
    const el = stationRefs && stationRefs.spaceWxEl;
    if (!el) return;
    if (!info || !info.ok || !Number.isFinite(info.kp)) { el.textContent = 'Kp — (unavailable offline)'; el.className = 'space-wx'; return; }
    const kp = info.kp;
    const level = kp >= 5 ? 'storm' : kp >= 4 ? 'active' : 'quiet';
    const label = kp >= 5 ? 'Storm' : kp >= 4 ? 'Active' : 'Quiet';
    el.className = 'space-wx ' + level;
    el.innerHTML = `<b>Kp ${kp.toFixed(1)}</b> · ${label}` + (info.time ? ` <span class="muted">· ${new Date(info.time + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>` : '');
  }

  function setTleStatus({ maxDays, stale, auto, online }) {
    const el = stationRefs && stationRefs.tleStatusEl;
    if (!el) return;
    el.classList.toggle('warn', stale > 0);
    let msg;
    if (stale > 0) msg = `⚠ ${stale} tracked element set${stale > 1 ? 's' : ''} (TLE/OMM) older than ${maxDays} d` + (online ? ' — refreshing when possible' : ' — offline, using cache');
    else msg = `✓ Tracked elements current · TLE/OMM (< ${maxDays} d old)`;
    if (!auto) msg += ' · auto-update off';
    el.textContent = msg;
  }

  return {
    view2d, view3d,
    renderList, updateClock, updateInfo, updatePasses, setActiveView, setTleStamp, setStatus,
    setStaleIds, setTleStatus, syncAutoMode, setRotorConnected, applyLayout, updateSky, isSkyActive,
    setCableWrap, setSpaceWeather,
    hw: hwRefs,
  };
}

// A big instrument-style readout card: small label over a large value.
function statCard(label, value, cls = '') {
  return h('div', { class: 'stat ' + cls }, [
    h('div', { class: 'stat-l' }, label),
    h('div', { class: 'stat-v' }, value),
  ]);
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
    h('div', { class: 'section-title' }, 'Orbit elements (TLE / OMM)'),
    h('div', { class: 'toggle-line switch' }, [h('span', {}, 'Auto-update cached elements'), autoChk]),
    h('label', { class: 'fld' }, [h('span', {}, 'Max element age (days)'), maxAgeInp]),
    h('button', { class: 'btn', onclick: () => handlers.updateTlesNow() }, 'Update now'),
    tleStatusEl,
    h('div', { class: 'muted', style: 'margin-top:6px' }, 'Celestrak is fetched as OMM (JSON), falling back to TLE; both carry the same epoch, so this age check covers either. Loaded OEM ephemerides take priority and are used as-is (no auto-refresh).')
  );

  // Space weather: latest planetary K-index (geomagnetic activity / HF & aurora).
  const spaceWxEl = h('div', { class: 'space-wx' }, 'Kp —');
  pane.append(
    h('hr', { class: 'hr' }),
    h('div', { class: 'section-title' }, 'Space weather'),
    spaceWxEl,
    h('div', { class: 'muted', style: 'margin-top:6px' }, 'Planetary K-index (NOAA SWPC): geomagnetic activity. High Kp = auroral absorption / disturbed HF, better aurora. Updates when online.')
  );

  return { tleStatusEl, spaceWxEl };
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
    h('option', { value: 'schedule' }, 'Tracked (all, by pass)'),
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
  // Smoothness profile — accel/jerk ramp shaping (SuperRot only).
  const motionProfileSel = h('select', { onchange: (e) => store.patchIn('hw.rotator', { motionProfile: e.target.value }) }, [
    h('option', { value: 'gentle' }, 'Gentle (EME / heavy)'),
    h('option', { value: 'normal' }, 'Normal'),
    h('option', { value: 'fast' }, 'Fast (light LEO)'),
  ]);
  motionProfileSel.value = hw.rotator.motionProfile || 'normal';

  const rotConn = h('div', {});
  const rotLimits = h('div', {}, [
    h('div', { class: 'grid2' }, [
      h('label', { class: 'fld' }, [h('span', {}, 'Max Az speed (°/s)'), inputNum(hw.rotator.maxVelAz, '0.5', (v) => store.patchIn('hw.rotator', { maxVelAz: v }))]),
      h('label', { class: 'fld' }, [h('span', {}, 'Max El speed (°/s)'), inputNum(hw.rotator.maxVelEl, '0.5', (v) => store.patchIn('hw.rotator', { maxVelEl: v }))]),
    ]),
    h('label', { class: 'fld' }, [h('span', {}, 'Motion profile'), motionProfileSel]),
    h('label', { class: 'fld' }, [h('span', {}, 'El max (° — 180 enables flip-over)'), inputNum(hw.rotator.elMax, '1', (v) => store.patchIn('hw.rotator', { elMax: v }))]),
    h('div', { class: 'muted', style: 'font-size:11px' }, 'Azimuth is free 360° shortest-path (no travel limit — it can go negative). Set El max to 180 to let the mount flip over the top on high passes instead of whipping the azimuth. Gentle profile spares heavy EME dishes; fast suits light LEO rigs.'),
    h('button', { class: 'btn sm', style: 'margin-top:6px', title: 'Send the speed limits, offsets and backlash values to the firmware so they persist on the MCU', onclick: () => handlers.pushRotatorConfig() }, 'Push settings to rotator'),
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

  // Manual jog pad (touch-friendly): nudge az/el by the selected step.
  let jogStep = 5;
  const stepDefs = [[1, '1°'], [5, '5°'], [10, '10°']];
  const stepBtns = {};
  const stepSeg = h('div', { class: 'seg' }, stepDefs.map(([v, l]) =>
    (stepBtns[v] = h('button', {
      class: v === jogStep ? 'active' : '',
      onclick: () => { jogStep = v; for (const [vv] of stepDefs) stepBtns[vv].classList.toggle('active', vv === jogStep); },
    }, l))));
  const jogPad = h('div', { class: 'jog-pad' }, [
    h('button', { class: 'jog up', title: 'Elevation up', onclick: () => handlers.jogRotator(0, jogStep) }, '▲'),
    h('button', { class: 'jog left', title: 'Azimuth left', onclick: () => handlers.jogRotator(-jogStep, 0) }, '◀'),
    h('button', { class: 'jog stop', title: 'Stop', onclick: () => handlers.stopRotator() }, '■'),
    h('button', { class: 'jog right', title: 'Azimuth right', onclick: () => handlers.jogRotator(jogStep, 0) }, '▶'),
    h('button', { class: 'jog down', title: 'Elevation down', onclick: () => handlers.jogRotator(0, -jogStep) }, '▼'),
  ]);

  // Pre-slew lead: seconds before AOS to pre-position to the pass's rise azimuth.
  const preslewInp = inputNum(hw.rotator.preslewLead, '5', (v) => store.patchIn('hw.rotator', { preslewLead: Math.max(0, Math.round(v)) }));

  // Park-position presets. Rebuilt from the store whenever the preset set changes.
  const parkList = h('div', { class: 'park-list' });
  const parkNameInp = h('input', { type: 'text', placeholder: 'Name (e.g. Cable-safe)', class: 'park-name' });
  const savePark = h('button', {
    class: 'btn sm',
    title: 'Save the rotator\'s current position as a park preset',
    onclick: () => { const n = parkNameInp.value.trim(); if (!n) return; handlers.saveParkPreset(n); parkNameInp.value = ''; },
  }, 'Save current position');
  let parkSig = '';
  function renderParkPresets() {
    const rot = store.get().hw.rotator;
    const sig = JSON.stringify([rot.parkPresets, rot.parkDefault]);
    if (sig === parkSig) return; // only redraw when presets actually change
    parkSig = sig;
    parkList.innerHTML = '';
    for (const p of rot.parkPresets || []) {
      const isDef = p.name === rot.parkDefault;
      parkList.append(h('div', { class: 'park-item' }, [
        h('button', {
          class: 'star' + (isDef ? ' on' : ''), title: isDef ? 'Default (Park button uses this)' : 'Set as default',
          onclick: () => store.patchIn('hw.rotator', { parkDefault: p.name }),
        }, isDef ? '★' : '☆'),
        h('span', { class: 'park-nm' }, p.name),
        h('span', { class: 'park-pos' }, p.home ? 'Home · limit switches' : `${Math.round(p.az)}° / ${Math.round(p.el)}°`),
        h('button', { class: 'btn sm', title: 'Park here now', onclick: () => handlers.parkTo(p) }, 'Park'),
        p.name === 'Home'
          ? h('span', { class: 'park-x-spacer' })
          : h('button', { class: 'btn sm park-x', title: 'Delete preset', onclick: () => store.removeParkPreset(p.name) }, '✕'),
      ]));
    }
  }
  store.subscribe(renderParkPresets);
  renderParkPresets();

  // Calibration: mount-alignment offsets (sky → mount) with capture helpers.
  const azOffInp = inputNum(hw.rotator.azOffset, '0.1', (v) => store.patchIn('hw.rotator', { azOffset: v }));
  const elOffInp = inputNum(hw.rotator.elOffset, '0.1', (v) => store.patchIn('hw.rotator', { elOffset: v }));
  const calibNorth = h('button', {
    class: 'btn sm', title: 'Point the mount at true north, then capture the azimuth offset',
    onclick: () => { handlers.captureCalibNorth(); azOffInp.value = store.get().hw.rotator.azOffset; },
  }, 'Set North here');
  const calibLevel = h('button', {
    class: 'btn sm', title: 'Level the mount (0° elevation), then capture the elevation offset',
    onclick: () => { handlers.captureCalibLevel(); elOffInp.value = store.get().hw.rotator.elOffset; },
  }, 'Set level here');

  // Sun-avoidance guard.
  const sunAvoidChk = checkbox(hw.rotator.sunAvoid, (v) => store.patchIn('hw.rotator', { sunAvoid: v }));
  const sunAvoidDeg = inputNum(hw.rotator.sunAvoidDeg, '0.5', (v) => store.patchIn('hw.rotator', { sunAvoidDeg: Math.max(0, v) }));

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
    h('div', { class: 'grid2' }, [
      h('label', { class: 'fld' }, [h('span', {}, 'Track above elevation (°)'), rotMinEl]),
      h('label', { class: 'fld' }, [h('span', {}, 'Pre-slew lead (s)'), preslewInp]),
    ]),
    h('div', { class: 'muted', style: 'font-size:11px' }, 'Scheduled passes follows whichever tracked satellite is up, switching as passes come and go. Below the elevation limit the rotator parks. Pre-slew aims the mount at the next pass\'s rise azimuth this many seconds early (0 = off).'),
    rotLimits,
    rotTarget,

    h('div', { class: 'section-title' }, 'Park positions'),
    parkList,
    h('div', { class: 'row', style: 'display:flex;gap:8px;margin-top:6px;align-items:center' }, [parkNameInp, savePark]),

    h('div', { class: 'section-title' }, 'Calibration & safety'),
    h('div', { class: 'grid2' }, [
      h('label', { class: 'fld' }, [h('span', {}, 'Az offset (°)'), azOffInp]),
      h('label', { class: 'fld' }, [h('span', {}, 'El offset (°)'), elOffInp]),
    ]),
    h('div', { class: 'row', style: 'display:flex;gap:8px;margin-top:6px' }, [calibNorth, calibLevel]),
    h('div', { class: 'grid2' }, [
      h('label', { class: 'fld' }, [h('span', {}, 'Az backlash (°)'), inputNum(hw.rotator.backlashAz, '0.1', (v) => store.patchIn('hw.rotator', { backlashAz: Math.max(0, v) }))]),
      h('label', { class: 'fld' }, [h('span', {}, 'El backlash (°)'), inputNum(hw.rotator.backlashEl, '0.1', (v) => store.patchIn('hw.rotator', { backlashEl: Math.max(0, v) }))]),
    ]),
    h('div', { class: 'muted', style: 'font-size:11px' }, 'Offsets correct mount misalignment (added to every commanded angle). Aim the mount at the reference, then capture. Backlash is compensated on the MCU — push settings to apply.'),
    h('div', { class: 'toggle-line switch', style: 'margin-top:8px' }, [h('span', {}, 'Sun-avoidance guard'), sunAvoidChk]),
    h('label', { class: 'fld' }, [h('span', {}, 'Keep-out radius (°)'), sunAvoidDeg]),

    h('div', { class: 'section-title' }, 'Manual jog'),
    h('div', { class: 'jog-wrap' }, [jogPad, h('div', { class: 'jog-step' }, [h('span', { class: 'sub-label' }, 'Step'), stepSeg])]),

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

// A user override wins; otherwise a stable auto color by position in the tracked list.
const PALETTE = ['#57d0a0', '#4a9fd4', '#ffd23f', '#ff8c6b', '#c792ea', '#7ee787', '#ff6b9d', '#5fd3e0'];
export const SWATCHES = [...PALETTE, '#ff5252', '#e0e0e0'];
export function colorFor(id, tracked) {
  const custom = store.get().satColors;
  if (custom && custom[id]) return custom[id];
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

// Compact "in 1h 55m 03s" / "in 4m 12s" / "in 38s" countdown for the pass list.
function fmtCountdown(ms) {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  if (h > 0) return `in ${h}h ${p(m)}m ${p(ss)}s`;
  if (m > 0) return `in ${m}m ${p(ss)}s`;
  return `in ${ss}s`;
}

// Draw a pass's sky-track into a small polar plot: horizon + rings, the az/el arc
// in the satellite's colour, a green AOS dot and a red LOS dot (north at top).
function drawPassMini(canvas, arc, color) {
  const size = 58;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const cx = size / 2, cy = size / 2, R = size / 2 - 3;
  const pos = (az, el) => {
    const rr = (1 - Math.max(0, el) / 90) * R;
    const a = (az - 90) * (Math.PI / 180);
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
  };

  ctx.strokeStyle = 'rgba(150,170,200,0.30)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(150,170,200,0.13)';
  for (const el of [30, 60]) {
    ctx.beginPath();
    ctx.arc(cx, cy, (1 - el / 90) * R, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.stroke();

  if (arc && arc.length > 1) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    arc.forEach((pt, i) => { const [x, y] = pos(pt.az, pt.el); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    const [ax, ay] = pos(arc[0].az, arc[0].el);
    const [lx, ly] = pos(arc[arc.length - 1].az, arc[arc.length - 1].el);
    ctx.fillStyle = '#3ce07a';
    ctx.beginPath(); ctx.arc(ax, ay, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff5a5a';
    ctx.beginPath(); ctx.arc(lx, ly, 2.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = 'rgba(160,180,210,0.6)';
  ctx.font = '7px ui-sans-serif, system-ui';
  ctx.fillText('N', cx - 2.5, 7.5);
}
