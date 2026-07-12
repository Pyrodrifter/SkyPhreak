import { store } from '../core/store.js';
import { THEMES } from '../core/themes.js';
import { DSOS } from '../core/dso.js';
import { icon } from './icons.js';
import { buildTimeline } from '../core/timeline.js';
import { scoreBreakdown } from '../core/passScore.js';

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
  app.classList.add('mission-console');

  /* ------------------------------- Topbar -------------------------------- */
  const clockEl = h('div', { class: 'clock' });
  const selReadout = h('div', { class: 'sel-readout' });
  const btn2d = h('button', { class: 'active', onclick: () => store.patch({ view: '2d' }) }, [h('span', { html: icon('map', 15) }), h('span', {}, 'Map')]);
  const btn3d = h('button', { onclick: () => store.patch({ view: '3d' }) }, [h('span', { html: icon('globe', 15) }), h('span', {}, 'Globe')]);

  // Theme picker — restyles the whole app (panels + map/globe/polar) live. The last
  // option is a user 'Custom' theme (a base palette + an accent colour you choose).
  const themeSel = h('select', {
    class: 'theme-sel',
    title: 'Color theme',
    onchange: (e) => { store.patch({ theme: e.target.value }); syncThemeCustom(); },
  }, [
    ...Object.entries(THEMES).map(([id, t]) => h('option', { value: id }, t.name)),
    h('option', { value: 'custom' }, 'Custom…'),
  ]);
  themeSel.value = store.get().theme;
  const themeAccent = h('input', {
    type: 'color', class: 'theme-accent', title: 'Custom accent colour',
    value: store.get().customTheme?.accent || '#4a9fd4',
    oninput: (e) => store.patchIn('customTheme', { accent: e.target.value }),
  });
  function syncThemeCustom() { if (apAccentRow) apAccentRow.style.display = store.get().theme === 'custom' ? '' : 'none'; }

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
      syncThemeCustom();
    },
  }, '⛶ Field');

  // Appearance popover — size, theme, accent and field mode consolidated behind one
  // ⚙ button so the topbar stays to brand · target · view.
  const apAccentRow = h('div', { class: 'ap-row' }, [h('span', { class: 'ap-label' }, 'Accent'), themeAccent]);
  const appearancePop = h('div', { class: 'appearance-pop', style: 'display:none' }, [
    h('div', { class: 'ap-row' }, [h('span', { class: 'ap-label' }, 'Size'), sizeSeg]),
    h('div', { class: 'ap-row' }, [h('span', { class: 'ap-label' }, 'Theme'), themeSel]),
    apAccentRow,
    h('div', { class: 'ap-row' }, [h('span', { class: 'ap-label' }, 'Field mode'), fieldBtn]),
  ]);
  let apOpen = false;
  const onApDocDown = (e) => { if (!appearanceWrap.contains(e.target)) closeAppearance(); };
  function closeAppearance() { appearancePop.style.display = 'none'; apOpen = false; document.removeEventListener('mousedown', onApDocDown, true); }
  function openAppearance() { appearancePop.style.display = ''; apOpen = true; setTimeout(() => document.addEventListener('mousedown', onApDocDown, true), 0); }
  const appearanceBtn = h('button', { class: 'topbar-settings', title: 'Display settings — size, theme, field mode', 'aria-label': 'Display settings', onclick: () => (apOpen ? closeAppearance() : openAppearance()) }, [h('span', { html: icon('setup', 15) }), h('span', {}, 'Settings')]);
  const appearanceWrap = h('div', { class: 'appearance-wrap' }, [appearanceBtn, appearancePop]);
  const displayControls = h('div', { class: 'topbar-controls stage-display-controls' }, [
    h('span', { class: 'topbar-controls-label' }, 'Display'),
    h('div', { class: 'toggle view-switch' }, [btn2d, btn3d]),
    appearanceWrap,
  ]);
  syncThemeCustom();

  const missionTargetDot = h('div', { class: 'mission-target-dot' });
  const missionName = h('div', { class: 'mission-target-name' }, 'Select a target');
  const missionKind = h('div', { class: 'mission-target-kind' }, 'SkyPhreak tracking station');
  const missionState = h('div', { class: 'mission-target-state standby' }, 'STANDBY');
  const missionAos = h('b', {}, '—');
  const missionAz = h('b', {}, '—');
  const missionEl = h('b', {}, '—');
  const missionMax = h('b', {}, '—');
  const missionDur = h('b', {}, '—');
  const missionTle = h('b', {}, '—');
  const missionMetric = (label, value, tone = '') => h('div', { class: 'mission-metric' + (tone ? ' ' + tone : '') }, [
    h('span', { class: 'mission-metric-label' }, label), value, h('small', {}, ''),
  ]);
  const missionDot = (label) => {
    const dot = h('span', { class: 'mission-dot' });
    const value = h('span', {}, 'Offline');
    return { el: h('div', { class: 'mission-link' }, [dot, h('div', {}, [h('small', {}, label), value])]), set: (on, text) => {
      dot.classList.toggle('on', !!on); value.textContent = text || (on ? 'Connected' : 'Offline');
    } };
  };
  const missionGps = missionDot('Station');
  const missionRot = missionDot('Rotator');
  const missionRad = missionDot('Radio');

  const topbar = h('div', { class: 'topbar' }, [
    h('div', { class: 'brand' }, [
      h('img', { class: 'brand-logo', src: './icon.png', alt: '' }),
      h('div', { class: 'brand-text', html: 'Sky<span>Phreak</span><small>Satellite sky tracking</small>' }),
    ]),
    h('div', { class: 'mission-target' }, [
      missionTargetDot,
      h('div', { class: 'mission-target-id' }, [missionKind, missionName, missionState]),
    ]),
    h('div', { class: 'mission-metrics' }, [
      missionMetric('AOS IN', missionAos, 'hot'), missionMetric('AZ', missionAz), missionMetric('EL', missionEl),
      missionMetric('MAX EL', missionMax, 'good'), missionMetric('DURATION', missionDur),
    ]),
    h('div', { class: 'mission-links' }, [missionGps.el, missionRot.el, missionRad.el, missionMetric('TLE AGE', missionTle)]),
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
  let wakeLock = null; // screen wake-lock sentinel (Field mode); see applyWakeLock

  // Segmented filter — one browser instead of four stacked boxes.
  const filterDefs = [['all', 'All'], ['tracked', 'Tracked'], ['favorites', 'Favs'], ['sky', 'Sky']];
  const filterBtns = {};
  const filterBar = h('div', { class: 'seg' }, filterDefs.map(([k, l]) =>
    (filterBtns[k] = h('button', { class: k === browserFilter ? 'active' : '', onclick: () => { browserFilter = k; syncFilter(); renderList(); } }, l))));
  // Manual TLE paste — for a satellite not in any Celestrak group.
  const tlePaste = h('textarea', { class: 'tle-paste', placeholder: 'Paste TLE — name line + 2 element lines…', rows: 4, style: 'display:none' });
  const tleAddBtn = h('button', { class: 'btn sm', style: 'display:none;margin-top:4px', onclick: () => {
    if (handlers.addManualTle(tlePaste.value)) { tlePaste.value = ''; tlePaste.style.display = 'none'; tleAddBtn.style.display = 'none'; }
  } }, 'Add pasted TLE');
  const pasteToggle = h('button', { class: 'btn sm', title: 'Paste a 2/3-line element set manually', onclick: () => {
    const show = tlePaste.style.display === 'none';
    tlePaste.style.display = show ? '' : 'none';
    tleAddBtn.style.display = show ? '' : 'none';
    if (show) tlePaste.focus();
  } }, 'Paste TLE');
  const catalogControls = h('div', { class: 'catalog-controls' }, [
    groupSel,
    h('div', { class: 'row', style: 'margin-top:6px' }, [refreshBtn, oemBtn, pasteToggle]),
    tlePaste,
    tleAddBtn,
    tleStamp,
  ]);
  function syncFilter() {
    for (const [k] of filterDefs) filterBtns[k].classList.toggle('active', k === browserFilter);
    catalogControls.style.display = browserFilter === 'all' ? '' : 'none';
  }

  // Bulk track/untrack for whatever the list is currently showing (respects the
  // active filter + search). shownIds is refreshed by renderList each render.
  let shownIds = [];
  function bulkTrack() {
    if (!shownIds.length) return;
    if (shownIds.length > 60 && !confirm(`Track all ${shownIds.length} shown satellites? Tracking a lot at once can slow things down.`)) return;
    store.trackMany(shownIds.map((id) => { const s = satLike(id); return { id, name: s && s.name, line1: s && s.line1, line2: s && s.line2 }; }));
  }
  function bulkUntrack() { if (shownIds.length) store.untrackMany(shownIds); }
  const bulkInfo = h('span', { class: 'bulk-info' }, '');
  const listBar = h('div', { class: 'list-bar' }, [
    bulkInfo,
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn xs', title: 'Track every satellite shown', onclick: bulkTrack }, '✓ Track all'),
    h('button', { class: 'btn xs', title: 'Untrack every satellite shown', onclick: bulkUntrack }, '✕ None'),
  ]);

  const sidebar = h('aside', { class: 'sidebar' }, [
    h('div', { class: 'side-top' }, [h('div', { class: 'panel-heading' }, ['Targets', h('span', { html: icon('setup', 14) })]), search, filterBar, catalogControls]),
    listBar,
    listEl,
  ]);

  /* -------------------------------- Stage -------------------------------- */
  const view2d = h('div', { id: 'view-2d' });
  const view3d = h('div', { id: 'view-3d' });
  const mapStyleLbl = h('span', {}, store.get().mapStyle === 'vector' ? 'Vector' : 'Shaded');
  const mapStyleBtn = h('button', {
    class: 'btn sm',
    title: 'Toggle shaded-relief / vector map',
    onclick: () => {
      const next = store.get().mapStyle === 'vector' ? 'relief' : 'vector';
      store.patch({ mapStyle: next });
      mapStyleLbl.textContent = next === 'vector' ? 'Vector' : 'Shaded';
    },
  }, [h('span', { class: 'btn-ico', html: icon('terrain', 14) }), mapStyleLbl]);
  const resetBtn = h('button', { class: 'btn sm', title: 'Reset the map/globe view', onclick: () => handlers.resetView() }, [h('span', { class: 'btn-ico', html: icon('reset', 14) }), 'Reset']);

  // Follow-satellite toggle (keeps the active view centred on the selection).
  const followBtn = h('button', {
    class: 'btn sm', title: 'Follow the selected satellite — keep it centred in the view',
    onclick: () => store.patch({ followSat: !store.get().followSat }),
  }, [h('span', { class: 'btn-ico', html: icon('follow', 14) }), 'Follow']);

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
  }, [h('span', { class: 'btn-ico', html: icon('time', 14) }), 'Time']);

  const helpBtn = h('button', { class: 'btn sm', title: 'Keyboard shortcuts (press ?)', onclick: () => toggleHelp(true) }, [h('span', { class: 'btn-ico', html: icon('help', 14) }), 'Help']);
  const tools = h('div', { class: 'stage-tools' }, [
    displayControls,
    h('div', { class: 'stage-tool-group map-action-tools', 'aria-label': 'Map tools' }, [followBtn, warpToggle, mapStyleBtn, resetBtn, helpBtn]),
  ]);

  // Auto-track mode buttons — now live in the status bar (built below).
  const trackBtns = {};
  const trackModes = [['off', 'Off'], ['selected', 'Selected'], ['schedule', 'Tracked']];
  const trackBar = h('div', { class: 'track-btns', role: 'radiogroup', 'aria-label': 'Rotator tracking mode' }, trackModes.map(([m, label]) =>
    (trackBtns[m] = h('button', {
      class: 'btn sm track-btn', type: 'button', role: 'radio', 'aria-checked': 'false',
      title: trackTitle(m), onclick: () => store.patchIn('hw.rotator', { autoMode: m }),
    }, label))));

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
  const tabNames = { passes: 'Passes', info: 'Info', station: 'Setup', hw: 'Hardware' };
  const tabIcons = { info: 'info', passes: 'passes', station: 'setup', hw: 'hardware' };
  const tabsBar = h('div', { class: 'tabs' });
  let activeTab = 'passes';
  for (const key of Object.keys(tabNames)) {
    const b = h('button', { class: key === activeTab ? 'active' : '', onclick: () => setTab(key) }, [
      h('span', { class: 'tab-ico', html: icon(tabIcons[key], 15) }),
      h('span', {}, tabNames[key]),
    ]);
    tabBtns[key] = b;
    tabsBar.append(b);
    tabPanes[key] = h('div', { class: 'tabpane' + (key === activeTab ? ' active' : '') });
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

  // The Info pane has a text block (rebuilt each tick), a persistent space-weather
  // strip (glanceable, not buried in settings), plus the polar/radar canvas mounted
  // once — both must survive the per-tick rebuild of infoText.
  const infoText = h('div');
  const spaceWxEl = h('div', { class: 'space-wx' }, 'Kp —');
  const infoWx = h('div', { class: 'info-wx', title: 'Geomagnetic activity (NOAA planetary K-index)' }, [
    h('span', { class: 'info-wx-k' }, '☀ Space wx'), spaceWxEl,
  ]);
  tabPanes.info.append(infoText, infoWx);

  /* ----------------------------- Status bar ------------------------------ */
  // Persistent bottom strip: clock, hardware connection state, and what the rotator
  // is currently tracking — the sort of at-a-glance status a finished app carries.
  const sbDot = (label, cls) => {
    const dot = h('span', { class: 'sb-dot' });
    const el = h('button', { type: 'button', class: 'sb-item sb-connection ' + (cls || ''), title: `Quick connect ${label.toLowerCase()}` }, [dot, h('span', { class: 'sb-txt' }, label)]);
    return {
      el, dot, connected: false,
      set(on) {
        this.connected = !!on;
        dot.classList.remove('connecting', 'disconnecting');
        dot.classList.toggle('on', on);
      },
      setPending(mode) {
        dot.classList.remove('on', 'connecting', 'disconnecting');
        dot.classList.add(mode);
      },
    };
  };
  const sbRot = sbDot('Rotator', 'sb-rotator');
  const sbRad = sbDot('Radio', 'sb-radio');
  let quickConnectPop = null;
  function closeQuickConnect() {
    if (!quickConnectPop) return;
    quickConnectPop.remove();
    quickConnectPop = null;
    document.removeEventListener('mousedown', quickConnectOutside, true);
  }
  function quickConnectOutside(e) {
    if (quickConnectPop && !quickConnectPop.contains(e.target) && !sbRot.el.contains(e.target) && !sbRad.el.contains(e.target)) closeQuickConnect();
  }
  function openQuickConnect(kind, anchor) {
    const wasKind = quickConnectPop && quickConnectPop.dataset.kind === kind;
    closeQuickConnect();
    if (wasKind) return;
    const isRot = kind === 'rotator';
    const cfg = store.get().hw[kind];
    const state = isRot ? sbRot : sbRad;
    const detail = isRot
      ? (cfg.protocol === 'superrot'
        ? `SuperRot · ${cfg.transport === 'serial' ? (cfg.path || 'USB port not selected') : `${cfg.host}:${cfg.port}`}`
        : `Hamlib · ${cfg.host}:${cfg.port}`)
      : `Hamlib rigctld · ${cfg.host}:${cfg.port}`;
    const popDot = h('span', { class: 'sb-dot' + (state.connected ? ' on' : '') });
    const extras = [];
    let usbPortSelect = null;
    if (isRot && !state.connected) {
      const transport = h('select', { class: 'quick-connect-select', onchange: (e) => {
        store.patchIn('hw.rotator', { protocol: 'superrot', transport: e.target.value });
        if (usbPortSelect) usbPortSelect.closest('.quick-connect-field').style.display = e.target.value === 'serial' ? '' : 'none';
      } }, [
        h('option', { value: 'tcp' }, 'Wi-Fi / TCP'),
        h('option', { value: 'serial' }, 'USB serial (no network)'),
      ]);
      transport.value = cfg.protocol === 'superrot' ? (cfg.transport || 'tcp') : 'tcp';
      usbPortSelect = h('select', { class: 'quick-connect-select', onchange: (e) => store.patchIn('hw.rotator', { path: e.target.value, baud: 115200 }) }, [
        h('option', { value: '' }, 'Scanning USB ports…'),
      ]);
      const portField = h('label', { class: 'quick-connect-field', style: transport.value === 'serial' ? '' : 'display:none' }, [h('span', {}, 'Serial port'), usbPortSelect]);
      extras.push(h('label', { class: 'quick-connect-field' }, [h('span', {}, 'Connection'), transport]), portField);
    }
    const action = h('button', { class: 'btn primary quick-connect-action', onclick: async (e) => {
      e.stopPropagation();
      action.disabled = true;
      const pending = state.connected ? 'disconnecting' : 'connecting';
      state.setPending(pending);
      popDot.className = `sb-dot ${pending}`;
      action.textContent = state.connected ? 'Disconnecting…' : 'Connecting…';
      await (isRot ? handlers.connectRotator() : handlers.connectRadio());
      closeQuickConnect();
    } }, state.connected ? 'Disconnect' : 'Connect');
    const homeAction = isRot && state.connected ? h('button', { class: 'btn quick-connect-secondary', onclick: (e) => {
      e.stopPropagation();
      handlers.homeRotator();
      closeQuickConnect();
    } }, 'Home rotator') : null;
    quickConnectPop = h('div', { class: 'quick-connect-pop' }, [
      h('div', { class: 'quick-connect-head' }, [popDot, h('strong', {}, isRot ? 'Rotator' : 'Radio')]),
      h('div', { class: 'quick-connect-state' }, state.connected ? 'Connected' : 'Offline'),
      h('div', { class: 'quick-connect-detail' }, detail),
      ...extras,
      action,
      homeAction || '',
      h('div', { class: 'quick-connect-hint' }, 'Uses your saved Hardware settings'),
    ]);
    quickConnectPop.dataset.kind = kind;
    document.body.appendChild(quickConnectPop);
    const r = anchor.getBoundingClientRect();
    quickConnectPop.style.left = Math.max(8, Math.min(r.left + r.width / 2 - 120, window.innerWidth - 248)) + 'px';
    quickConnectPop.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + 'px';
    if (usbPortSelect) {
      window.pyro.rotator.listPorts().then((result) => {
        if (!quickConnectPop || !usbPortSelect.isConnected) return;
        usbPortSelect.replaceChildren();
        if (!result.ok || !result.ports.length) {
          usbPortSelect.append(h('option', { value: '' }, result.error || 'No USB serial ports found'));
          return;
        }
        for (const port of result.ports) usbPortSelect.append(h('option', { value: port.path }, port.label));
        const saved = store.get().hw.rotator.path;
        usbPortSelect.value = result.ports.some((p) => p.path === saved) ? saved : result.ports[0].path;
        store.patchIn('hw.rotator', { path: usbPortSelect.value, baud: 115200 });
      });
    }
    setTimeout(() => document.addEventListener('mousedown', quickConnectOutside, true), 0);
  }
  sbRot.el.onclick = (e) => { e.stopPropagation(); openQuickConnect('rotator', sbRot.el); };
  sbRad.el.onclick = (e) => { e.stopPropagation(); openQuickConnect('radio', sbRad.el); };
  const sbTrack = h('span', { class: 'sb-val' }, 'Idle');
  const sbTle = h('span', { class: 'sb-val' }, '—');
  // Cable-wrap gauge — azimuth turns accumulated away from north (hidden when idle).
  const sbWrapVal = h('span', { class: 'sb-val sb-wrap-val' }, '—');
  const sbWrap = h('div', { class: 'sb-item sb-wrap', style: 'display:none', title: 'Cable wrap' }, [
    h('span', { class: 'sb-k' }, 'Wrap'), sbWrapVal,
  ]);
  const sbOrbitIcon = h('span', { class: 'sb-orbit-icon', 'aria-hidden': 'true' });
  const sbStateIcon = h('span', { class: 'sb-state-icon', 'aria-hidden': 'true' });
  // Chevron collapses the footer to a slim strip (clock + STOP stay); persisted.
  const sbCollapseBtn = h('button', {
    class: 'btn sm sb-collapse', title: 'Collapse / expand the status bar',
    onclick: () => store.patch({ sbCollapsed: !store.get().sbCollapsed }),
  }, '⌄');
  const statusbar = h('footer', { class: 'statusbar' }, [
    clockEl,
    h('div', { class: 'sb-sep' }),
    h('div', { class: 'sb-item sb-track-mode' }, [sbOrbitIcon, h('div', {}, [h('span', { class: 'sb-k' }, 'Tracking mode'), trackBar])]),
    h('div', { class: 'sb-item sb-target' }, [sbStateIcon, h('div', {}, [h('span', { class: 'sb-k' }, 'Target state'), sbTrack])]),
    h('div', { class: 'sb-item sb-tle' }, [h('span', { class: 'sb-k' }, 'TLE age'), sbTle]),
    h('div', { class: 'spacer' }),
    sbWrap,
    // Field controls always within reach — no digging into the Hardware tab.
    h('button', { class: 'btn sm park-btn', title: 'Park the rotator (to the default preset)', onclick: () => handlers.parkRotator() }, [h('span', { class: 'sb-btn-icon' }, 'P'), h('span', {}, 'Park')]),
    h('button', { class: 'btn sm danger', title: 'Stop the rotator (Esc)', onclick: () => handlers.stopRotator() }, [h('span', { class: 'sb-stop-icon' }), h('span', {}, 'Stop Tracking')]),
    h('div', { class: 'sb-sep' }),
    sbRot.el,
    sbRad.el,
    sbCollapseBtn,
  ]);
  function setStatus({ rotConnected, radConnected, tracking, slewing }) {
    sbRot.set(rotConnected);
    sbRad.set(radConnected);
    sbTrack.textContent = tracking || 'Idle';
    const mode = store.get().hw.rotator.autoMode || 'off';
    sbOrbitIcon.classList.toggle('active', mode !== 'off');
    sbOrbitIcon.classList.toggle('connected', !!rotConnected);
    sbOrbitIcon.classList.toggle('slewing', mode !== 'off' && !!rotConnected && !!slewing);
    const targetText = tracking || '';
    const seeking = /^Pre-slew/.test(targetText);
    const parked = targetText === 'Parked';
    const trackingTarget = !!targetText && !seeking && !parked && !targetText.includes('Time-warp');
    sbStateIcon.classList.toggle('seeking', seeking);
    sbStateIcon.classList.toggle('tracking', trackingTarget);
    sbStateIcon.classList.toggle('parked', parked);
    missionGps.set(true, 'Station ready');
    missionRot.set(rotConnected, rotConnected ? 'Connected' : 'Offline');
    missionRad.set(radConnected, radConnected ? 'Connected' : 'Offline');
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
    statusbar.classList.toggle('collapsed', !!state.sbCollapsed);
    sbCollapseBtn.textContent = state.sbCollapsed ? '⌃' : '⌄';
    applyWakeLock(!!state.fieldMode);
  }
  applyLayout(store.get());

  // Keyboard-shortcut help overlay (toggled by the ? key / toolbar button).
  const helpOverlay = h('div', { class: 'help-overlay', style: 'display:none', onclick: (e) => { if (e.target === helpOverlay) toggleHelp(false); } }, [
    h('div', { class: 'help-card' }, [
      h('div', { class: 'help-title' }, 'Keyboard shortcuts'),
      ...[
        ['Ctrl K', 'Command palette — jump to anything'],
        ['Esc', 'Emergency-stop the rotator (or close this)'],
        ['2 / 3', '2D map / 3D globe'],
        ['F', 'Toggle Field mode'],
        ['L', 'Follow the selected satellite'],
        ['P', 'Park the rotator'],
        ['T', 'Cycle auto-track: Off → Selected → Tracked'],
        ['?', 'Show / hide this help'],
      ].map(([k, d]) => h('div', { class: 'help-row' }, [h('kbd', {}, k), h('span', {}, d)])),
      h('button', { class: 'btn sm', style: 'margin-top:10px', onclick: () => toggleHelp(false) }, 'Close'),
    ]),
  ]);
  function toggleHelp(force) {
    const show = force === undefined ? helpOverlay.style.display === 'none' : force;
    helpOverlay.style.display = show ? 'flex' : 'none';
  }

  /* ------------------------- Command palette (Ctrl+K) -------------------- */
  let cmdActions = [];
  let cmdSel = 0;
  const cmdInput = h('input', {
    class: 'cmd-input', type: 'text', placeholder: 'Search commands and targets…',
    oninput: () => { cmdSel = 0; renderCmd(); },
    onkeydown: (e) => {
      const items = cmdFiltered();
      if (e.key === 'ArrowDown') { e.preventDefault(); cmdSel = Math.min(items.length - 1, cmdSel + 1); renderCmd(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cmdSel = Math.max(0, cmdSel - 1); renderCmd(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[cmdSel]) runCmd(items[cmdSel]); }
      else if (e.key === 'Escape') { e.preventDefault(); closeCmd(); }
    },
  });
  const cmdList = h('div', { class: 'cmd-list' });
  const cmdOverlay = h('div', { class: 'cmd-overlay', style: 'display:none', onclick: (e) => { if (e.target === cmdOverlay) closeCmd(); } }, [
    h('div', { class: 'cmd-panel' }, [
      h('div', { class: 'cmd-search' }, [h('span', { class: 'cmd-search-ic', html: icon('search', 15) }), cmdInput, h('span', { class: 'cmd-kbd' }, 'Esc')]),
      cmdList,
    ]),
  ]);
  const cmdOpen = () => cmdOverlay.style.display !== 'none';
  function closeCmd() { cmdOverlay.style.display = 'none'; }
  function openCmd() {
    cmdActions = buildCmdActions();
    cmdInput.value = ''; cmdSel = 0;
    cmdOverlay.style.display = 'flex';
    renderCmd();
    setTimeout(() => cmdInput.focus(), 0);
  }
  function runCmd(a) { closeCmd(); try { a.run(); } catch (err) { console.error('command failed', err); } }
  function cmdFiltered() {
    const q = cmdInput.value.trim().toLowerCase();
    if (!q) return cmdActions;
    return cmdActions.filter((a) => (a.label + ' ' + a.section + ' ' + (a.hint || '')).toLowerCase().includes(q));
  }
  function renderCmd() {
    const items = cmdFiltered();
    if (cmdSel >= items.length) cmdSel = Math.max(0, items.length - 1);
    cmdList.innerHTML = '';
    if (!items.length) { cmdList.append(h('div', { class: 'cmd-empty' }, 'No matching commands')); return; }
    items.forEach((a, i) => {
      const row = h('div', {
        class: 'cmd-item' + (i === cmdSel ? ' sel' : ''),
        onmousemove: () => { if (cmdSel !== i) { cmdSel = i; renderCmd(); } },
        onclick: () => runCmd(a),
      }, [
        h('span', { class: 'cmd-item-section' }, a.section),
        h('span', { class: 'cmd-item-label' }, a.label),
        a.hint ? h('span', { class: 'cmd-item-hint' }, a.hint) : '',
      ]);
      cmdList.append(row);
      if (i === cmdSel) setTimeout(() => row.scrollIntoView({ block: 'nearest' }), 0);
    });
  }
  // Build the action list fresh each open (tracked targets change).
  function buildCmdActions() {
    const st = store.get();
    const acts = [];
    const add = (section, label, hint, run) => acts.push({ section, label, hint, run });
    add('View', '2D Map', '', () => store.patch({ view: '2d' }));
    add('View', '3D Globe', '', () => store.patch({ view: '3d' }));
    add('View', 'Toggle Field mode', '', () => fieldBtn.click());
    add('View', 'Follow selected satellite', '', () => store.patch({ followSat: !store.get().followSat }));
    for (const [k, name] of Object.entries(tabNames)) add('Panel', 'Open ' + name, 'tab', () => setTab(k));
    add('Rotator', 'Auto-track: Off', '', () => store.patchIn('hw.rotator', { autoMode: 'off' }));
    add('Rotator', 'Auto-track: Selected target', '', () => store.patchIn('hw.rotator', { autoMode: 'selected' }));
    add('Rotator', 'Auto-track: Scheduled passes', '', () => store.patchIn('hw.rotator', { autoMode: 'schedule' }));
    add('Rotator', 'Park rotator', '', () => handlers.parkRotator());
    add('Rotator', 'Stop rotator', 'emergency stop', () => handlers.stopRotator());
    add('Rotator', 'Home rotator', '', () => handlers.homeRotator && handlers.homeRotator());
    add('Rotator', 'Unwind cable', '', () => handlers.unwindRotator && handlers.unwindRotator());
    add('Rotator', 'Connect / disconnect rotator', '', () => handlers.connectRotator());
    add('Radio', 'Connect / disconnect radio', '', () => handlers.connectRadio());
    for (const id of st.tracked) {
      const s = satLike(id);
      add('Target', 'Select ' + (s ? s.name : 'NORAD ' + id), '#' + id, () => store.patch({ selected: id }));
    }
    add('Target', 'Select the Moon', '', () => store.patch({ selected: 'MOON' }));
    return acts;
  }

  app.append(topbar, h('div', { class: 'body' }, [sidebar, stage, rightpanel]), statusbar, helpOverlay, cmdOverlay);

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

    if (browserFilter === 'sky') { listBar.style.display = 'none'; shownIds = []; renderSky(listEl); return; }
    listBar.style.display = '';

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

    shownIds = entries.map((e) => e.id);
    const nTracked = entries.filter((e) => tracked.has(e.id)).length;
    bulkInfo.textContent = `${entries.length} shown · ${nTracked} tracked`;

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
    const utcDate = date.toLocaleDateString([], { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
    const localDate = date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    let extra = '';
    if (warpMs) {
      const m = Math.round(warpMs / 60000);
      extra = ` &nbsp;·&nbsp; <span class="clock-warp">${m >= 0 ? '+' : ''}${m}m preview</span>`;
    }
    clockEl.innerHTML = `<span class="clock-zone"><small>UTC</small><b>${utc}</b><em>${utcDate}</em></span><span class="clock-zone"><small>LOCAL</small><b>${loc}</b><em>${localDate}${extra}</em></span>`;
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
      missionName.textContent = selBody.name;
      missionKind.textContent = selBody.kind === 'dso' ? 'Deep-sky object' : selBody.kind === 'moon' ? 'Lunar target' : 'Solar-system target';
      missionState.textContent = up ? 'ABOVE HORIZON' : 'BELOW HORIZON';
      missionState.className = 'mission-target-state ' + (up ? 'up' : 'down');
      missionTargetDot.style.color = selBody.kind === 'moon' ? '#e6eaf2' : '#cbd8ea';
      missionTargetDot.classList.toggle('live', up);
      missionAz.textContent = selBody.az.toFixed(1) + '°';
      missionEl.textContent = selBody.el.toFixed(1) + '°';
      missionTle.textContent = 'LOCAL';
      sbTle.textContent = 'Local';
      const kindLabel = selBody.kind === 'dso' ? 'Deep-sky object' : selBody.kind === 'moon' ? 'Lunar target' : 'Solar-system target';
      infoText.append(
        infoHero(selBody.name, kindLabel, up, selBody.az.toFixed(1) + '°', selBody.el.toFixed(1) + '°'),
        h('div', { class: 'stat-grid' }, selBody.extra.map(([a, b]) => statCard(a, b)))
      );
      if (selBody.eme) appendEmeSection(selBody.eme);
      if (moon && selBody.kind !== 'moon') appendMoonSection(moon);
      return;
    }

    if (!info) {
      selReadout.innerHTML = '<span class="muted">No target selected</span>';
      missionName.textContent = 'Select a target';
      missionKind.textContent = 'SkyPhreak tracking station';
      missionState.textContent = 'STANDBY';
      missionState.className = 'mission-target-state standby';
      missionTargetDot.style.color = '';
      missionTargetDot.classList.remove('live');
      missionAz.textContent = '—'; missionEl.textContent = '—'; missionTle.textContent = '—';
      sbTle.textContent = '—';
      infoText.append(h('div', { class: 'empty' }, 'Select a satellite, planet, the Moon, or a deep-sky object'));
    } else {
      selReadout.innerHTML = info.aboveHorizon
        ? `<b>${info.name}</b> &nbsp; ${info.el.toFixed(1)}° el / ${info.az.toFixed(0)}° az`
        : `<b>${info.name}</b> &nbsp; ${info.statusText}`;
      missionName.textContent = info.name;
      missionKind.textContent = 'NORAD ' + info.noradId + ' · satellite target';
      missionState.textContent = info.statusText.toUpperCase();
      missionState.className = 'mission-target-state ' + (info.aboveHorizon ? 'up' : 'down');
      missionTargetDot.style.color = colorFor(info.noradId, store.get().tracked);
      missionTargetDot.classList.toggle('live', info.aboveHorizon);
      missionAz.textContent = info.az.toFixed(1) + '°';
      missionEl.textContent = info.el.toFixed(1) + '°';
      missionTle.textContent = fmtAge(info.tleAgeDays);
      sbTle.textContent = fmtAge(info.tleAgeDays);
      const rf = store.get().hw.radio;
      const up = info.aboveHorizon;
      infoText.append(
        infoHero(info.name, 'NORAD ' + info.noradId, up, up ? info.az.toFixed(1) + '°' : '—', up ? info.el.toFixed(1) + '°' : '—', info.statusText),
        h('div', { class: 'stat-grid' }, [
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
  // Wave-1 operational state (kept in closures so the per-tick pane rebuild preserves
  // the readiness expand + the Passes/Timeline view toggle).
  let lastReadiness = null;
  let readinessOpen = false;
  let passesView = 'list';
  let lastPassItems = [];
  function setReadiness(r) { lastReadiness = r; }

  const scoreChip = (score, parts) => {
    const tier = score >= 70 ? 'good' : score >= 40 ? 'ok' : 'low';
    return h('span', { class: 'score-chip ' + tier, title: 'Pass quality — ' + scoreBreakdown({ score, parts: parts || [] }) }, String(score));
  };

  // The Ready / Attention bar shown under the NOW/NEXT hero, expandable to the checklist.
  function renderReadiness() {
    const r = lastReadiness;
    if (!r) return document.createComment('');
    const attention = r.items.filter((i) => i.state === 'warn' || i.state === 'fail').length;
    const label = r.state === 'ready' ? 'READY' : r.state === 'fail' ? 'ATTENTION REQUIRED' : 'ATTENTION';
    const sub = r.state === 'ready' ? 'all pre-pass checks passed' : `${attention} item${attention === 1 ? '' : 's'} to review`;
    const bar = h('button', {
      class: 'readiness-bar ' + r.state, title: 'Pre-pass readiness',
      onclick: () => { readinessOpen = !readinessOpen; updatePasses(lastPassItems, Date.now()); },
    }, [
      h('span', { class: 'rdy-dot' }),
      h('span', { class: 'rdy-label' }, label),
      h('span', { class: 'rdy-sub' }, sub),
      h('span', { class: 'rdy-chev' }, readinessOpen ? '▾' : '▸'),
    ]);
    if (!readinessOpen) return bar;
    const glyph = { ok: '✓', warn: '!', fail: '✕', off: '·' };
    return h('div', { class: 'readiness-wrap' }, [bar, h('div', { class: 'readiness-list' },
      r.items.map((it) => h('div', { class: 'rdy-item ' + it.state }, [
        h('span', { class: 'rdy-item-ic' }, glyph[it.state] || '·'),
        h('span', { class: 'rdy-item-label' }, it.label),
        h('span', { class: 'rdy-item-detail' }, it.detail || ''),
      ])))]);
  }

  // Chronological event feed (WAKE → AOS → MAX → LOS → PARK across all passes).
  function renderTimeline(pane, items, now) {
    const events = buildTimeline(items, { now, preslewLead: store.get().hw.rotator.preslewLead });
    if (!events.length) { pane.append(h('div', { class: 'empty' }, 'No scheduled events in the next 12 hours')); return; }
    const tl = h('div', { class: 'mc-timeline' });
    let markedNow = false;
    const nowMarker = () => h('div', { class: 'tl-now' }, [h('span', { class: 'tl-now-tag' }, 'NOW'), h('span', { class: 'tl-now-line' })]);
    for (const e of events) {
      if (!markedNow && e.t >= now) { tl.append(nowMarker()); markedNow = true; }
      const rel = e.t - now;
      tl.append(h('div', {
        class: 'tl-row tl-' + e.type + (rel < 0 ? ' past' : ''),
        onclick: () => store.patch({ selected: e.id }),
      }, [
        h('div', { class: 'tl-time' }, new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
        h('span', { class: 'tl-icon', style: `color:${e.color}` }, e.icon),
        h('div', { class: 'tl-body' }, [
          h('div', { class: 'tl-label' }, [h('span', { class: 'tl-evt' }, e.label), h('span', { class: 'tl-sat' }, e.name)]),
          h('div', { class: 'tl-detail' }, e.detail),
        ]),
        h('div', { class: 'tl-rel' }, rel < 0 ? 'now' : fmtCountShort(rel)),
      ]));
    }
    if (!markedNow) tl.append(nowMarker());
    pane.append(tl);
  }

  function updatePasses(items, now) {
    lastPassItems = items || [];
    const pane = tabPanes.passes;
    pane.innerHTML = '';
    const sort = store.get().passSort || 'time';
    const sortBtn = (key, label, title) => h('button', { class: sort === key ? 'active' : '', title, onclick: () => store.patch({ passSort: key }) }, label);
    pane.append(h('div', { class: 'passes-head' }, [
      h('div', { class: 'seg mini' }, [
        h('button', { class: passesView === 'list' ? 'active' : '', onclick: () => { passesView = 'list'; updatePasses(lastPassItems, Date.now()); } }, 'Passes'),
        h('button', { class: passesView === 'timeline' ? 'active' : '', onclick: () => { passesView = 'timeline'; updatePasses(lastPassItems, Date.now()); } }, 'Timeline'),
      ]),
      h('div', { class: 'passes-tools' }, passesView === 'timeline' ? [] : [
        h('div', { class: 'seg mini' }, [
          sortBtn('time', 'Soonest', 'Soonest first'),
          sortBtn('el', 'Highest', 'Highest elevation first'),
          sortBtn('best', 'Best', 'Best overall quality first'),
        ]),
        h('button', { class: 'btn sm', title: 'Export upcoming passes as an .ics calendar', onclick: () => exportICS(items) }, '.ics'),
      ]),
    ]));

    if (passesView === 'timeline') { renderTimeline(pane, items, now); return; }

    if (!items || !items.length) {
      const anyTracked = store.get().tracked.length;
      pane.append(h('div', { class: 'empty' }, anyTracked
        ? 'No passes for your tracked satellites in the next 48 h above the horizon'
        : 'Check a satellite in the list to see its passes here'));
      return;
    }

    const selId = store.get().selected;
    const ap = store.get().hw.rotator.armedPass;
    const ordered = sort === 'el' ? [...items].sort((a, b) => b.pass.maxEl - a.pass.maxEl)
      : sort === 'best' ? [...items].sort((a, b) => (b.score || 0) - (a.score || 0))
      : items;
    // The NOW/NEXT hero is always the soonest current/upcoming pass (independent of the
    // row sort), so it stays in step with main's readiness focus. `items` is aos-sorted.
    const missionPass = items.find((it) => it.id === selId && it.pass.los.getTime() >= now)
      || items.find((it) => it.pass.los.getTime() >= now);
    if (missionPass) {
      const p = missionPass.pass;
      const live = now >= p.aos && now <= p.los;
      missionAos.textContent = live ? 'LIVE' : fmtCountdown(p.aos.getTime() - now);
      missionMax.textContent = p.maxEl.toFixed(1) + '°';
      missionDur.textContent = `${Math.floor(p.durationS / 60)}m ${p.durationS % 60}s`;
      const heroMini = h('canvas', { class: 'mission-pass-polar', title: 'Pass sky track' });
      const hstat = (l, v, cls) => h('div', { class: 'mc-stat' + (cls ? ' ' + cls : '') }, [h('small', {}, l), h('b', {}, v)]);
      pane.append(h('div', { class: 'mission-pass-hero' + (live ? ' live' : '') }, [
        h('div', { class: 'mission-hero-top' }, [
          h('span', { class: 'mission-pass-eyebrow' }, live ? 'NOW · ACTIVE PASS' : 'NOW / NEXT PASS'),
          h('span', { class: 'mission-live' + (live ? ' on' : '') }, [h('span', { class: 'mission-live-dot' }), live ? 'LIVE' : 'STANDBY']),
        ]),
        h('div', { class: 'mission-hero-body' }, [
          h('div', { class: 'mission-hero-info' }, [
            h('div', { class: 'mission-pass-title' }, [
              h('span', { class: 'dot', style: `background:${missionPass.color};color:${missionPass.color}` }),
              h('span', { class: 'mission-hero-name' }, missionPass.name),
              missionPass.score != null ? scoreChip(missionPass.score, missionPass.scoreParts) : '',
            ]),
            h('div', { class: 'mission-hero-aos' }, [
              h('small', {}, live ? 'LOS IN' : 'AOS IN'),
              h('b', {}, (live ? fmtCountdown(p.los.getTime() - now) : fmtCountdown(p.aos.getTime() - now)).replace(/^in\s+/, '')),
              h('span', { class: 'mission-hero-when' }, `AOS ${p.aos.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${p.aos.toLocaleDateString([], { month: 'short', day: 'numeric' })}`),
            ]),
            h('div', { class: 'mission-hero-stats' }, [
              hstat('MAX EL', p.maxEl.toFixed(1) + '°', 'hi'),
              hstat('DURATION', `${Math.floor(p.durationS / 60)}m ${p.durationS % 60}s`),
              hstat('AZ AOS', Math.round(p.aosAz) + '°'),
              hstat('AZ LOS', Math.round(p.losAz) + '°'),
            ]),
          ]),
          h('div', { class: 'mission-hero-polar' }, [heroMini]),
        ]),
      ]));
      drawPassMini(heroMini, missionPass.arc, missionPass.color, 112);
      if (lastReadiness && lastReadiness.passId === missionPass.id) pane.append(renderReadiness());
    } else {
      missionAos.textContent = '—'; missionMax.textContent = '—'; missionDur.textContent = '—';
    }
    for (const it of ordered) {
      const p = it.pass;
      const live = now >= p.aos && now <= p.los;
      const untilMs = p.aos.getTime() - now;
      const count = live ? fmtCountShort(p.los.getTime() - now) : fmtCountShort(untilMs);
      const countCls = live ? 'now' : untilMs < 10 * 60000 ? 'soon' : '';
      const armed = ap && ap.id === it.id && Math.abs(ap.aos - p.aos.getTime()) < 60000;
      const mini = h('canvas', { class: 'pass-mini', title: `Max ${p.maxEl}° · AOS ${azName(p.aosAz)} → LOS ${azName(p.losAz)}` });

      pane.append(
        h('div', {
          class: 'pass-row' + (live ? ' live' : '') + (armed ? ' armed' : '') + (it.id === selId ? ' selected' : ''),
          onclick: () => store.patch({ selected: it.id }),
        }, [
          h('div', { class: 'pass-when ' + countCls }, [
            h('span', {}, live ? 'LOS IN' : 'IN'),
            h('b', {}, count),
            h('span', { class: 'pass-when-date' }, p.aos.toLocaleDateString([], { month: 'short', day: 'numeric' })),
          ]),
          h('div', { class: 'pass-main' }, [
            h('div', { class: 'pass-l1' }, [
              h('span', { class: 'dot', style: `background:${it.color};color:${it.color}` }),
              h('span', { class: 'pass-sat' }, it.name),
              it.visible ? h('span', { class: 'pass-vis', title: 'Optically visible — satellite sunlit while you are in darkness' }, '👁') : '',
              it.score != null ? scoreChip(it.score, it.scoreParts) : '',
            ]),
            h('div', { class: 'pass-l2' }, [
              h('span', { class: 'pass-l2-k' }, 'MAX'),
              h('span', { class: 'pass-maxel' }, `${p.maxEl.toFixed(1)}°`),
              h('span', { class: 'pass-l2-sep' }, '·'),
              h('span', { class: 'pass-dur' }, `${Math.floor(p.durationS / 60)}m ${p.durationS % 60}s`),
            ]),
            h('div', { class: 'pass-l3' }, [
              h('span', { class: 'pass-times' }, `AOS ${p.aos.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · #${it.id}`),
            ]),
          ]),
          mini,
          h('button', {
            class: 'pass-arm' + (armed ? ' on' : ''),
            title: armed ? 'Armed — the rotator is committed to this pass. Click to release.' : 'Arm the rotator for this specific pass (switches to Tracked mode)',
            onclick: (e) => { e.stopPropagation(); armed ? handlers.disarmPass() : handlers.armPass(it.id, p.aos.getTime(), p.los.getTime()); },
          }, armed ? '● Armed' : 'Arm'),
        ])
      );
      drawPassMini(mini, it.arc, it.color);
    }
  }

  // Export the upcoming passes as an .ics calendar (one VEVENT per pass).
  function exportICS(items) {
    if (!items || !items.length) return;
    const pad = (n) => String(n).padStart(2, '0');
    const dt = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SkyPhreak//Passes//EN\r\n';
    for (const it of items) {
      const p = it.pass;
      ics += 'BEGIN:VEVENT\r\n'
        + `UID:${it.id}-${p.aos.getTime()}@skyphreak\r\n`
        + `DTSTAMP:${dt(new Date())}\r\n`
        + `DTSTART:${dt(p.aos)}\r\n`
        + `DTEND:${dt(p.los)}\r\n`
        + `SUMMARY:${it.name} pass (max ${p.maxEl}°)${it.visible ? ' \u{1F441}' : ''}\r\n`
        + `DESCRIPTION:AOS ${azName(p.aosAz)} → LOS ${azName(p.losAz)}\\, max ${p.maxEl}°\r\n`
        + 'END:VEVENT\r\n';
    }
    ics += 'END:VCALENDAR\r\n';
    const a = document.createElement('a');
    a.download = 'skyphreak-passes.ics';
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    a.click();
    URL.revokeObjectURL(a.href);
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
    for (const [m] of trackModes) {
      const active = m === mode;
      trackBtns[m].classList.toggle('active', active);
      trackBtns[m].setAttribute('aria-checked', active ? 'true' : 'false');
    }
    if (hwRefs.autoModeSel) hwRefs.autoModeSel.value = mode;
  }

  // Rotor connection light (status-bar dot) + the floating emergency-stop button,
  // which only appears while the rotator is connected.
  function setRotorConnected(connected) {
    sbRot.set(!!connected);
    estopFab.classList.toggle('show', !!connected);
  }

  // Keyboard shortcuts (ignored while typing in a field). Esc always stops / closes help.
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    // Ctrl/Cmd+K opens the command palette from anywhere; while it's open the input
    // owns the keyboard, so let its own handler manage arrows / Enter / Esc.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); cmdOpen() ? closeCmd() : openCmd(); return; }
    if (cmdOpen()) return;
    if (e.key === 'Escape') {
      if (helpOverlay.style.display !== 'none') { toggleHelp(false); return; }
      if (!typing) handlers.stopRotator();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case '2': store.patch({ view: '2d' }); break;
      case '3': store.patch({ view: '3d' }); break;
      case 'f': case 'F': fieldBtn.click(); break;
      case 'l': case 'L': store.patch({ followSat: !store.get().followSat }); break;
      case 'p': case 'P': handlers.parkRotator(); break;
      case 't': case 'T': {
        const order = ['off', 'selected', 'schedule'];
        const cur = store.get().hw.rotator.autoMode || 'off';
        store.patchIn('hw.rotator', { autoMode: order[(order.indexOf(cur) + 1) % order.length] });
        break;
      }
      case '?': toggleHelp(); break;
    }
  });

  // Screen wake-lock: keep the display awake in Field mode (long unattended passes).
  async function applyWakeLock(want) {
    try {
      if (want && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch { /* unsupported or denied — ignore */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store.get().fieldMode) applyWakeLock(true);
  });

  // Update which tracked rows are flagged stale; re-render only on change.
  function setStaleIds(set) {
    if (set.size === staleIds.size && [...set].every((id) => staleIds.has(id))) return;
    staleIds = set;
    renderList();
  }

  // Space-weather readout: { ok, kp, time } or { ok:false }.
  function setSpaceWeather(info) {
    const el = spaceWxEl;
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
    setCableWrap, setSpaceWeather, setReadiness,
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

// Info-tab pointing hero: target id + above/below badge over the big AZ / EL readout
// (the two numbers you rotate to). Mirrors the Passes NOW/NEXT hero styling.
function infoHero(name, sub, up, az, el, status) {
  return h('div', { class: 'info-hero' + (up ? ' up' : '') }, [
    h('div', { class: 'info-hero-top' }, [
      h('div', { class: 'info-hero-id' }, [
        h('div', { class: 'info-hero-name' }, name),
        h('div', { class: 'info-hero-sub' }, sub),
      ]),
      h('span', { class: 'mission-live' + (up ? ' on' : '') }, [
        h('span', { class: 'mission-live-dot' }),
        up ? 'ABOVE HORIZON' : 'BELOW HORIZON',
      ]),
    ]),
    h('div', { class: 'info-azel' }, [
      h('div', { class: 'info-azel-cell' }, [h('small', {}, 'AZIMUTH'), h('b', {}, az)]),
      h('div', { class: 'info-azel-cell' }, [h('small', {}, 'ELEVATION'), h('b', { class: up ? 'up' : 'down' }, el)]),
    ]),
    status ? h('div', { class: 'info-status' + (up ? ' up' : '') }, status) : '',
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
      mk('Pass-list min el (°)', store.get().minEl, '1', (v) => store.patch({ minEl: v })),
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

  // Pass alerts (desktop notifications).
  const notifyChk = checkbox(store.get().notifyPasses, async (v) => {
    if (v && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { notifyChk.checked = false; return; }
    }
    store.patch({ notifyPasses: v });
  });
  const notifyLead = inputNum(store.get().notifyLead, '1', (v) => store.patch({ notifyLead: Math.max(1, Math.round(v)) }));
  const soundChk = checkbox(store.get().notifySound !== false, (v) => {
    store.patch({ notifySound: v });
    if (v) window.playPassAlert?.();
  });
  const soundStyle = h('select', {
    onchange: (e) => { store.patch({ notifySoundStyle: e.target.value }); window.playPassAlert?.(e.target.value); },
  }, [
    h('option', { value: 'chime' }, 'Chime'),
    h('option', { value: 'radar' }, 'Radar'),
    h('option', { value: 'urgent' }, 'Urgent'),
    h('option', { value: 'sonar' }, 'Sonar'),
    h('option', { value: 'soft' }, 'Soft arpeggio'),
    h('option', { value: 'beacon' }, 'Beacon'),
    h('option', { value: 'sparkle' }, 'Sparkle'),
    h('option', { value: 'descending' }, 'Descending'),
    h('option', { value: 'digital' }, 'Digital'),
    h('option', { value: 'double' }, 'Double tone'),
    h('option', { value: 'low' }, 'Low tone'),
    h('option', { value: 'motor' }, 'Motor sweep'),
    h('option', { value: 'lock' }, 'Target lock'),
  ]);
  soundStyle.value = store.get().notifySoundStyle || 'chime';
  const alertSoundOptions = [
    ['chime', 'Chime'], ['radar', 'Radar'], ['urgent', 'Urgent'], ['sonar', 'Sonar'],
    ['soft', 'Soft arpeggio'], ['beacon', 'Beacon'], ['sparkle', 'Sparkle'],
    ['descending', 'Descending'], ['digital', 'Digital'], ['double', 'Double tone'], ['low', 'Low tone'],
    ['motor', 'Motor sweep'], ['lock', 'Target lock'],
  ];
  const eventControl = (label, enabledKey, soundKey, fallback) => {
    const enabled = enabledKey ? checkbox(store.get()[enabledKey] !== false, (v) => store.patch({ [enabledKey]: v })) : null;
    const select = h('select', { onchange: (e) => {
      store.patch({ [soundKey]: e.target.value });
      window.playPassAlert?.(e.target.value);
    } }, alertSoundOptions.map(([value, name]) => h('option', { value }, name)));
    select.value = store.get()[soundKey] || fallback;
    return h('div', { style: `display:grid;grid-template-columns:${enabled ? '1fr auto' : '1fr'};gap:8px;align-items:end` }, [
      h('label', { class: 'fld' }, [h('span', {}, label), select]),
      enabled ? h('label', { class: 'toggle-line switch', style: 'margin-bottom:1px' }, [h('span', {}, 'On'), enabled]) : '',
    ]);
  };
  const voiceChk = checkbox(!!store.get().notifyVoice, (v) => {
    store.patch({ notifyVoice: v });
    if (v) window.testPassVoice?.();
  });
  // Robotic "ship computer" delivery (Subnautica-style): flat deep pitch + chime.
  const roboticChk = checkbox(!!store.get().notifyVoiceRobotic, (v) => {
    store.patch({ notifyVoiceRobotic: v });
    if (store.get().notifyVoice) window.testPassVoice?.();
  });
  const voiceSelect = h('select', { onchange: (e) => store.patch({ notifyVoiceURI: e.target.value }) });
  const fillVoices = () => {
    const voices = window.speechSynthesis?.getVoices?.() || [];
    voiceSelect.replaceChildren(
      h('option', { value: '__female__' }, 'Automatic female voice'),
      h('option', { value: '' }, 'System default'),
    );
    voices.forEach((voice) => voiceSelect.append(h('option', { value: voice.voiceURI }, `${voice.name} (${voice.lang})`)));
    voiceSelect.value = store.get().notifyVoiceURI || '';
  };
  fillVoices();
  if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', fillVoices, { once: true });
  const voiceRate = inputNum(store.get().notifyVoiceRate ?? 0.95, '0.05', (v) => store.patch({ notifyVoiceRate: Math.min(2, Math.max(0.5, v)) }));
  voiceRate.min = '0.5'; voiceRate.max = '2';
  const voicePitch = inputNum(store.get().notifyVoicePitch ?? 1, '0.1', (v) => store.patch({ notifyVoicePitch: Math.min(2, Math.max(0, v)) }));
  voicePitch.min = '0'; voicePitch.max = '2';
  const voiceVolume = inputNum(store.get().notifyVoiceVolume ?? 1, '0.1', (v) => store.patch({ notifyVoiceVolume: Math.min(1, Math.max(0, v)) }));
  voiceVolume.min = '0'; voiceVolume.max = '1';
  const voiceTemplate = h('textarea', {
    rows: 5,
    oninput: (e) => store.patch({ notifyVoiceTemplate: e.target.value }),
  }, store.get().notifyVoiceTemplate || '');
  const speechPresets = {
    friendly: 'Heads up! {satellite} will rise in {minutes} {minuteWord}. The pass lasts about {duration} {durationWord} and reaches {maxElevation} degrees. {visibility}',
    concise: '{satellite}, arriving in {minutes} {minuteWord}. Duration {duration} {durationWord}. Maximum elevation {maxElevation} degrees.',
    mission: 'Pass alert. Target {satellite}. A O S in {minutes} {minuteWord}. Pass duration {duration} {durationWord}. Peak elevation {maxElevation} degrees. {visibility}',
    ship: 'Attention. {satellite} acquisition of signal in {minutes} {minuteWord}. Projected peak elevation, {maxElevation} degrees. {visibility}',
  };
  const templatePreset = h('select', { onchange: (e) => {
    const template = speechPresets[e.target.value];
    if (!template) return;
    voiceTemplate.value = template;
    store.patch({ notifyVoiceTemplate: template });
    // The "Ship computer" style pairs with the robotic voice — enable it for the preview.
    if (e.target.value === 'ship') { store.patch({ notifyVoiceRobotic: true }); roboticChk.checked = true; }
    window.testPassVoice?.();
  } }, [
    h('option', { value: '' }, 'Choose an announcement style…'),
    h('option', { value: 'friendly' }, 'Friendly'),
    h('option', { value: 'concise' }, 'Short and concise'),
    h('option', { value: 'mission' }, 'Mission control'),
    h('option', { value: 'ship' }, 'Ship computer (robotic)'),
  ]);

  // Backup / restore all settings.
  const dataMsg = h('div', { class: 'muted', style: 'font-size:11px;margin-top:6px' }, '');
  const exportBtn = h('button', { class: 'btn sm', onclick: () => {
    const a = document.createElement('a');
    a.download = 'skyphreak-settings-' + new Date().toISOString().slice(0, 10) + '.json';
    a.href = URL.createObjectURL(new Blob([JSON.stringify(store.get(), null, 2)], { type: 'application/json' }));
    a.click();
    URL.revokeObjectURL(a.href);
  } }, 'Export settings');
  const importInput = h('input', { type: 'file', accept: 'application/json', style: 'display:none', onchange: (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        if (store.importSettings(JSON.parse(r.result))) { dataMsg.textContent = 'Imported — reloading…'; setTimeout(() => location.reload(), 400); }
        else dataMsg.textContent = 'Import failed: not a settings file';
      } catch { dataMsg.textContent = 'Import failed: invalid JSON'; }
    };
    r.readAsText(f);
  } });
  const importBtn = h('button', { class: 'btn sm', onclick: () => importInput.click() }, 'Import settings');

  pane.append(
    h('hr', { class: 'hr' }),
    h('div', { class: 'section-title' }, 'Pass alerts'),
    h('div', { class: 'toggle-line switch' }, [h('span', {}, 'Notify before a pass'), notifyChk]),
    h('div', { class: 'toggle-line switch' }, [h('span', {}, 'Play alert sound'), soundChk]),
    h('label', { class: 'fld' }, [h('span', {}, 'Alert sound'), soundStyle]),
    h('div', { class: 'section-title', style: 'margin-top:10px' }, 'Pass event alerts'),
    eventControl('Satellite rising (AOS)', 'notifyAos', 'notifyAosSound', 'beacon'),
    eventControl('Maximum elevation', 'notifyPeak', 'notifyPeakSound', 'sparkle'),
    eventControl('Pass ending (LOS)', 'notifyLos', 'notifyLosSound', 'descending'),
    h('div', { class: 'section-title', style: 'margin-top:10px' }, 'Rotator alerts'),
    h('div', { class: 'toggle-line switch' }, [h('span', {}, 'Enable rotator sounds'), checkbox(store.get().rotatorSounds !== false, (v) => store.patch({ rotatorSounds: v }))]),
    eventControl('Rotator connected', null, 'rotatorConnectSound', 'digital'),
    eventControl('Rotator disconnected', null, 'rotatorDisconnectSound', 'low'),
    eventControl('Tracking started', null, 'rotatorTrackSound', 'beacon'),
    eventControl('Rotator parked', null, 'rotatorParkSound', 'soft'),
    h('div', { class: 'toggle-line switch' }, [h('span', {}, 'Speak pass details'), voiceChk]),
    h('div', { class: 'toggle-line switch' }, [h('span', {}, 'Robotic ship-computer voice'), roboticChk]),
    h('label', { class: 'fld' }, [h('span', {}, 'Voice'), voiceSelect]),
    h('div', { class: 'row', style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px' }, [
      h('label', { class: 'fld' }, [h('span', {}, 'Rate'), voiceRate]),
      h('label', { class: 'fld' }, [h('span', {}, 'Pitch'), voicePitch]),
      h('label', { class: 'fld' }, [h('span', {}, 'Volume'), voiceVolume]),
    ]),
    h('label', { class: 'fld' }, [h('span', {}, 'Announcement style'), templatePreset]),
    h('label', { class: 'fld' }, [h('span', {}, 'What the announcer says'), voiceTemplate]),
    h('div', { class: 'muted', style: 'font-size:10px;margin-top:-5px;line-height:1.5' }, [
      'You can write normal sentences and include: ',
      h('code', {}, '{satellite}'), ' name · ', h('code', {}, '{minutes}'), ' until rise · ',
      h('code', {}, '{duration}'), ' pass length · ', h('code', {}, '{maxElevation}'), ' peak angle · ',
      h('code', {}, '{visibility}'), ' viewing note. Use ', h('code', {}, '{minuteWord}'),
      ' and ', h('code', {}, '{durationWord}'), ' for correct singular/plural wording.'
    ]),
    h('label', { class: 'fld' }, [h('span', {}, 'Lead time (minutes)'), notifyLead]),
    h('div', { class: 'row', style: 'display:flex;gap:8px' }, [
      h('button', { class: 'btn sm', onclick: () => window.playPassAlert?.() }, 'Test sound'),
      h('button', { class: 'btn sm', onclick: () => window.testPassVoice?.() }, 'Test voice'),
    ]),
    h('div', { class: 'section-title' }, 'Backup'),
    h('div', { class: 'row', style: 'display:flex;gap:8px' }, [exportBtn, importBtn, importInput]),
    dataMsg
  );

  return { tleStatusEl };
}

/* ----------------------------- Hardware pane ---------------------------- */
function buildHwPane(pane, handlers) {
  const hw = store.get().hw;

  // A collapsible sub-section: header toggles a body open/closed. Advanced/occasional
  // controls live in these (collapsed by default) so the pane isn't a wall of fields.
  function section(title, children, open = false) {
    let expanded = open;
    const body = h('div', { class: 'hw-sec-body', style: expanded ? '' : 'display:none' }, children);
    const chev = h('span', { class: 'hw-sec-chev' }, expanded ? '▾' : '▸');
    const head = h('button', { class: 'hw-sec-head', type: 'button', onclick: () => {
      expanded = !expanded;
      body.style.display = expanded ? '' : 'none';
      chev.textContent = expanded ? '▾' : '▸';
    } }, [chev, h('span', {}, title)]);
    return h('div', { class: 'hw-sec' }, [head, body]);
  }

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
    if (motionSection) motionSection.style.display = superrot ? '' : 'none';
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
        h('span', { class: 'park-pos' }, p.home ? 'Firmware home · EL endstop' : `${Math.round(p.az)}° / ${Math.round(p.el)}°`),
        h('button', { class: 'btn sm', title: p.home ? 'Run the firmware homing sequence' : 'Park here now', onclick: () => handlers.parkTo(p) }, p.home ? 'Home' : 'Park'),
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

  // Advanced / occasional controls live in collapsible sections (collapsed by default)
  // so the everyday connect + auto-track + jog controls aren't buried.
  const motionSection = section('Motion & limits', [rotLimits]);
  const parkSection = section('Park positions', [
    parkList,
    h('div', { class: 'row', style: 'display:flex;gap:8px;margin-top:6px;align-items:center' }, [parkNameInp, savePark]),
  ]);
  const calibSection = section('Calibration & safety', [
    h('div', { class: 'grid2' }, [
      h('label', { class: 'fld' }, [h('span', {}, 'Az offset (°)'), azOffInp]),
      h('label', { class: 'fld' }, [h('span', {}, 'El offset (°)'), elOffInp]),
    ]),
    h('div', { class: 'row', style: 'display:flex;gap:8px;margin-top:6px' }, [calibNorth, calibLevel]),
    h('div', { class: 'grid2' }, [
      h('label', { class: 'fld' }, [h('span', {}, 'Az backlash (°)'), inputNum(hw.rotator.backlashAz, '0.1', (v) => store.patchIn('hw.rotator', { backlashAz: Math.max(0, v) }))]),
      h('label', { class: 'fld' }, [h('span', {}, 'El backlash (°)'), inputNum(hw.rotator.backlashEl, '0.1', (v) => store.patchIn('hw.rotator', { backlashEl: Math.max(0, v) }))]),
    ]),
    h('div', { class: 'muted', style: 'font-size:11px' }, 'Offsets correct mount misalignment; aim at the reference then capture. Backlash is compensated on the MCU — push settings to apply.'),
    h('div', { class: 'toggle-line switch', style: 'margin-top:8px' }, [h('span', {}, 'Sun-avoidance guard'), sunAvoidChk]),
    h('label', { class: 'fld' }, [h('span', {}, 'Keep-out radius (°)'), sunAvoidDeg]),
  ]);
  const radioSection = section('Radio (rigctld / Hamlib)', [
    radPill,
    h('div', { class: 'grid2', style: 'margin-top:8px' }, [
      h('label', { class: 'fld' }, [h('span', {}, 'Host'), radHost]),
      h('label', { class: 'fld' }, [h('span', {}, 'Port'), radPort]),
    ]),
    radConnect,
    h('label', { class: 'fld', style: 'margin-top:8px' }, [h('span', {}, 'Downlink frequency (MHz)'), downlink]),
    h('div', { class: 'toggle-line switch' }, [h('span', {}, 'Doppler correction'), doppler]),
    radFreqLive,
  ]);

  pane.append(
    // --- Connection: the essentials, always visible ---
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
    h('div', { class: 'row', style: 'display:flex;gap:8px;margin-top:6px' }, [
      h('button', { class: 'btn sm', title: 'Run the homing sequence — seeks the elevation endstop; azimuth zero is the compass-set position (SuperRot only)', onclick: () => handlers.homeRotator() }, 'Home'),
      h('button', { class: 'btn sm', title: 'Unwind the azimuth cable to a neutral wrap without changing heading (SuperRot only)', onclick: () => handlers.unwindRotator() }, 'Unwind'),
    ]),

    // --- Auto-track: everyday controls, visible ---
    h('label', { class: 'fld', style: 'margin-top:8px' }, [h('span', {}, 'Auto-track'), autoMode]),
    h('div', { class: 'grid2' }, [
      h('label', { class: 'fld' }, [h('span', {}, 'Rotator tracking min el (°)'), rotMinEl]),
      h('label', { class: 'fld' }, [h('span', {}, 'Pre-slew lead (s)'), preslewInp]),
    ]),
    h('div', { class: 'muted', style: 'font-size:11px' }, 'Scheduled mode follows whichever tracked satellite is up. Pre-slew aims at the next rise azimuth this many seconds early (0 = off).'),
    rotTarget,

    // --- Manual jog: primary hands-on control, visible ---
    h('div', { class: 'section-title' }, 'Manual jog'),
    h('div', { class: 'jog-wrap' }, [jogPad, h('div', { class: 'jog-step' }, [h('span', { class: 'sub-label' }, 'Step'), stepSeg])]),

    // --- Collapsed by default ---
    motionSection,
    parkSection,
    calibSection,
    radioSection,
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

// Compact single-line countdown for the tight pass-row column: mm:ss under an hour,
// "Hh MMm" beyond (no seconds), so it never wraps to two/three lines.
function fmtCountShort(ms) {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}h ${p(m)}m` : `${p(m)}:${p(s % 60)}`;
}

// Draw a pass's sky-track into a small polar plot: horizon + rings, the az/el arc
// in the satellite's colour, a green AOS dot and a red LOS dot (north at top).
function drawPassMini(canvas, arc, color, size = 58) {
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
