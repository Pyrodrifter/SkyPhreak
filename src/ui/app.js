/**
 * App shell — top instrument cluster, dock workspace, status bar.
 *
 * createUI() returns the same surface the previous UI exposed, so main.js (the
 * propagation / hardware / driving layer) is untouched by the rebuild. Everything
 * below this line is presentation; everything main.js does is not.
 */

import { store } from '../core/store.js';
import { Dock } from './dock/dock.js';
import { PRESETS, DEFAULT_PRESET } from './workspaces.js';
import { h, popover, countdown, tleAge, deg } from './widgets.js';
import { colorFor } from './colors.js';
import { buildTargets } from './panels/targets.js';
import { buildViewport } from './panels/viewport.js';
import { buildPasses } from './panels/passes.js';
import { buildInfo, buildSky } from './panels/info.js';
import { buildRotator } from './panels/rotator.js';
import { buildRadio } from './panels/radio.js';
import { buildSettings } from './panels/settings.js';

import './tokens.css';
import './base.css';
import './shell.css';
import './dock/dock.css';
import './panels.css';

export function createUI(handlers) {
  const app = document.getElementById('app');
  app.replaceChildren();

  /* ------------------------------- panels --------------------------------- */
  const workspaceApi = { resetLayout: () => applyPreset(store.get().workspacePreset || DEFAULT_PRESET, true) };

  const targets = buildTargets(handlers);
  const viewport = buildViewport(handlers);
  const passes = buildPasses(handlers);
  const info = buildInfo(handlers);
  const sky = buildSky();
  const rotator = buildRotator(handlers);
  const radio = buildRadio(handlers);
  const settings = buildSettings(handlers, workspaceApi);

  const panels = {
    targets:  { title: 'Targets',  el: targets.el },
    viewport: { title: 'Viewport', el: viewport.el },
    passes:   { title: 'Passes',   el: passes.el },
    sky:      { title: 'Sky',      el: sky.el },
    info:     { title: 'Info',     el: info.el },
    rotator:  { title: 'Rotator',  el: rotator.el },
    radio:    { title: 'Radio',    el: radio.el },
    settings: { title: 'Settings', el: settings.el },
  };

  /* ------------------------------ top cluster ----------------------------- */
  const cellName = h('div', { class: 'cell-name' }, 'No target');
  const cellKind = h('div', { class: 'cell-sub' }, 'Standby');
  const cellDot = h('span', { class: 'dot' });
  const mk = (label, cls = '') => {
    const v = h('div', { class: 'value ' + cls }, '—');
    return { el: h('div', { class: 'cell' }, [h('span', { class: 'label' }, label), v]), v };
  };
  const cAos = mk('AOS in', 'big');
  const cAz = mk('Azimuth');
  const cEl = mk('Elevation');
  const cMax = mk('Max el');
  const cDur = mk('Duration');
  const cAge = mk('Elem age');

  const wsBtn = h('button', { class: 'btn sm menu-btn', title: 'Workspace preset' }, PRESETS[DEFAULT_PRESET].name);
  const panelBtn = h('button', { class: 'btn sm menu-btn', title: 'Show or hide panels' }, 'Panels');

  const topbar = h('div', { class: 'topbar' }, [
    h('div', { class: 'brand' }, [
      h('img', { src: './icon.png', alt: '' }),
      h('div', {}, [
        h('div', { class: 'brand-name', html: 'Sky<span>Phreak</span>' }),
        h('div', { class: 'brand-sub' }, 'Ground station'),
      ]),
    ]),
    h('div', { class: 'cluster' }, [
      h('div', { class: 'cell wide' }, [cellKind, h('div', { class: 'cell-name' }, [cellDot, cellName])]),
      cAos.el, cAz.el, cEl.el, cMax.el, cDur.el, cAge.el,
    ]),
    h('div', { class: 'spacer' }),
    h('div', { class: 'top-actions' }, [wsBtn, panelBtn]),
  ]);
  // The name cell is built inline above; keep a live reference to its text node.
  topbar.querySelector('.cell.wide .cell-name').replaceChildren(cellDot, cellName);

  /* ------------------------------- status bar ----------------------------- */
  const clock = h('div', { class: 'sb-clock' }, '');
  const modeVal = h('span', { class: 'value' }, 'Manual');
  const stateVal = h('span', { class: 'value' }, 'Idle');
  const wrapVal = h('span', { class: 'value' }, '—');
  const wrapItem = h('div', { class: 'sb-item', style: 'display:none', title: 'Cable wrap' }, [h('span', { class: 'label' }, 'Wrap'), wrapVal]);

  const linkItem = (label, kind) => {
    const dot = h('span', { class: 'dot' });
    const txt = h('span', { class: 'value' }, 'Offline');
    const el = h('button', { class: 'sb-item', title: `Quick connect ${label.toLowerCase()}` }, [dot, h('span', { class: 'label' }, label), txt]);
    el.onclick = () => quickConnect(kind, el);
    return { el, dot, txt, connected: false };
  };
  const rotLink = linkItem('Rotator', 'rotator');
  const radLink = linkItem('Radio', 'radio');

  const homeBtn = h('button', { class: 'btn sm', disabled: true, onclick: () => handlers.homeRotator() }, 'Home');
  const unwindBtn = h('button', { class: 'btn sm', disabled: true, onclick: () => handlers.unwindRotator() }, 'Unwind');

  const statusbar = h('div', { class: 'statusbar' }, [
    h('div', { class: 'sb-item' }, [clock]),
    h('div', { class: 'sb-item' }, [h('span', { class: 'label' }, 'Mode'), modeVal]),
    h('div', { class: 'sb-item' }, [h('span', { class: 'label' }, 'State'), stateVal]),
    wrapItem,
    h('span', { class: 'spacer' }),
    h('div', { class: 'sb-actions' }, [
      homeBtn, unwindBtn,
      h('button', { class: 'btn sm', title: 'Park the rotator to its default preset', onclick: () => handlers.parkRotator() }, 'Park'),
      h('button', { class: 'btn sm danger', title: 'Stop the rotator (Esc)', onclick: () => handlers.stopRotator() }, 'Stop'),
    ]),
    rotLink.el, radLink.el,
  ]);

  /* ------------------------------- workspace ------------------------------ */
  const wsRoot = h('div', { class: 'workspace' });
  app.append(topbar, wsRoot, statusbar);

  const dock = new Dock(wsRoot, panels, () => {
    store.patch({ workspaceLayout: dock.getLayout() });
  });

  function applyPreset(id, force) {
    const preset = PRESETS[id] || PRESETS[DEFAULT_PRESET];
    const saved = store.get().workspaceLayout;
    dock.setLayout(!force && saved ? saved : preset.layout);
    wsBtn.textContent = preset.name;
    if (force) store.patch({ workspacePreset: id, workspaceLayout: dock.getLayout() });
    else store.patch({ workspacePreset: id });
  }

  popoverFor(wsBtn, () => [
    h('div', { class: 'pop-list' }, [
      ...Object.entries(PRESETS).map(([id, p]) => h('button', {
        class: 'pop-item' + (store.get().workspacePreset === id ? ' on' : ''),
        onclick: () => applyPreset(id, true),
      }, [h('span', { class: 'dot' }), p.name])),
      h('div', { class: 'pop-sep' }),
      h('button', { class: 'pop-item', onclick: () => applyPreset(store.get().workspacePreset || DEFAULT_PRESET, true) }, [h('span', { class: 'dot' }), 'Reset this layout']),
    ]),
  ], 'right');

  popoverFor(panelBtn, () => {
    const open = new Set(dock.openIds());
    return [h('div', { class: 'pop-list' }, Object.entries(panels).map(([id, p]) => h('button', {
      class: 'pop-item' + (open.has(id) ? ' on' : ''),
      onclick: () => (open.has(id) ? dock.close(id) : dock.reveal(id)),
    }, [h('span', { class: 'dot' }), p.title])))];
  }, 'right');

  function popoverFor(btn, build, align) {
    const po = popover(btn, (close) => build().map((n) => {
      n.querySelectorAll?.('.pop-item').forEach((b) => b.addEventListener('click', close));
      return n;
    }), { align });
    btn.onclick = () => po.toggle();
    return po;
  }

  // Restore the saved layout, falling back to the preset.
  applyPreset(store.get().workspacePreset || DEFAULT_PRESET, false);

  /* ----------------------------- quick connect ---------------------------- */
  let qc = null;
  function quickConnect(kind, anchor) {
    if (qc) { qc.close(); qc = null; return; }
    const isRot = kind === 'rotator';
    const link = isRot ? rotLink : radLink;
    const cfg = store.get().hw[kind];
    const detail = isRot
      ? (cfg.protocol === 'superrot'
        ? `SuperRot · ${cfg.transport === 'serial' ? (cfg.path || 'no port selected') : `${cfg.host}:${cfg.port}`}`
        : `Hamlib rotctld · ${cfg.host}:${cfg.port}`)
      : `Hamlib rigctld · ${cfg.host}:${cfg.port}`;
    qc = popover(anchor, (close) => [
      h('div', { class: 'pop-title' }, isRot ? 'Rotator' : 'Radio'),
      h('div', { class: 'row', style: 'margin-bottom:6px' }, [
        h('span', { class: 'dot' + (link.connected ? ' ok' : ' alert') }),
        h('span', { class: 'value' }, link.connected ? 'Connected' : 'Offline'),
      ]),
      h('div', { class: 'nf-note', style: 'margin:0 0 8px' }, detail),
      h('button', {
        class: 'btn primary block',
        onclick: async () => { close(); qc = null; await (isRot ? handlers.connectRotator() : handlers.connectRadio()); },
      }, link.connected ? 'Disconnect' : 'Connect'),
      h('button', {
        class: 'btn block', style: 'margin-top:6px',
        onclick: () => { close(); qc = null; dock.reveal(kind); },
      }, 'Open ' + (isRot ? 'rotator' : 'radio') + ' panel'),
    ], { side: 'top', align: 'right' });
    qc.open();
  }

  /* -------------------------------- overlays ------------------------------ */
  const help = buildHelp();
  const palette = buildPalette();
  app.append(help.el, palette.el);

  function buildHelp() {
    const rows = [
      ['Ctrl K', 'Command palette'],
      ['Esc', 'Emergency-stop the rotator, or close this'],
      ['1 – 3', 'Workspace: Tracking / Planning / Hardware'],
      ['M / G', 'Map / Globe'],
      ['F', 'Field mode'],
      ['L', 'Follow the selected target'],
      ['P', 'Park the rotator'],
      ['T', 'Cycle auto-track: Manual → Selected → Scheduled'],
      ['?', 'Show or hide this'],
    ];
    const el = h('div', { class: 'overlay', style: 'display:none', onclick: (e) => { if (e.target === el) toggle(false); } }, [
      h('div', { class: 'sheet' }, [
        h('div', { class: 'sheet-h' }, 'Keyboard'),
        h('div', { class: 'keys' }, rows.map(([k, d]) => h('div', { class: 'key-row' }, [h('kbd', {}, k), h('span', {}, d)]))),
        h('button', { class: 'btn', style: 'margin-top:10px', onclick: () => toggle(false) }, 'Close'),
      ]),
    ]);
    const toggle = (on) => { el.style.display = (on === undefined ? el.style.display === 'none' : on) ? 'flex' : 'none'; };
    return { el, toggle, get open() { return el.style.display !== 'none'; } };
  }

  function buildPalette() {
    let acts = [];
    let sel = 0;
    const input = h('input', {
      type: 'text', class: 'cmd-in', placeholder: 'Command or target…',
      oninput: () => { sel = 0; draw(); },
      onkeydown: (e) => {
        const items = filtered();
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) run(items[sel]); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      },
    });
    const list = h('div', { class: 'cmd-list' });
    const el = h('div', { class: 'overlay cmd', style: 'display:none', onclick: (e) => { if (e.target === el) close(); } }, [
      h('div', { class: 'sheet cmd-sheet' }, [
        h('div', { class: 'cmd-bar' }, [input, h('kbd', {}, 'Esc')]),
        list,
      ]),
    ]);
    const filtered = () => {
      const q = input.value.trim().toLowerCase();
      return q ? acts.filter((a) => (a.section + ' ' + a.label).toLowerCase().includes(q)) : acts;
    };
    function draw() {
      const items = filtered();
      if (sel >= items.length) sel = Math.max(0, items.length - 1);
      list.replaceChildren();
      if (!items.length) { list.append(h('div', { class: 'empty' }, 'No matching commands')); return; }
      items.forEach((a, i) => {
        const row = h('div', {
          class: 'cmd-row' + (i === sel ? ' sel' : ''),
          onmousemove: () => { if (sel !== i) { sel = i; draw(); } },
          onclick: () => run(a),
        }, [h('span', { class: 'cmd-sec' }, a.section), h('span', { class: 'cmd-lbl' }, a.label)]);
        list.append(row);
        if (i === sel) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
      });
    }
    const close = () => { el.style.display = 'none'; };
    function open() {
      acts = build();
      input.value = '';
      sel = 0;
      el.style.display = 'flex';
      draw();
      setTimeout(() => input.focus(), 0);
    }
    const run = (a) => { close(); try { a.run(); } catch (err) { console.error('command failed', err); } };
    function build() {
      const out = [];
      const add = (section, label, fn) => out.push({ section, label, run: fn });
      for (const [id, p] of Object.entries(PRESETS)) add('Workspace', p.name, () => applyPreset(id, true));
      for (const [id, p] of Object.entries(panels)) add('Panel', 'Open ' + p.title, () => dock.reveal(id));
      add('View', '2D map', () => store.patch({ view: '2d' }));
      add('View', '3D globe', () => store.patch({ view: '3d' }));
      add('View', 'Toggle field mode', toggleField);
      add('View', 'Follow selected target', () => store.patch({ followSat: !store.get().followSat }));
      add('Rotator', 'Auto-track: manual', () => store.patchIn('hw.rotator', { autoMode: 'off' }));
      add('Rotator', 'Auto-track: selected', () => store.patchIn('hw.rotator', { autoMode: 'selected' }));
      add('Rotator', 'Auto-track: scheduled', () => store.patchIn('hw.rotator', { autoMode: 'schedule' }));
      add('Rotator', 'Park', () => handlers.parkRotator());
      add('Rotator', 'Stop', () => handlers.stopRotator());
      add('Rotator', 'Home', () => handlers.homeRotator && handlers.homeRotator());
      add('Rotator', 'Unwind cable', () => handlers.unwindRotator && handlers.unwindRotator());
      add('Rotator', 'Connect / disconnect', () => handlers.connectRotator());
      add('Radio', 'Connect / disconnect', () => handlers.connectRadio());
      for (const id of store.get().tracked) {
        const c = store.getCatalog().find((s) => s.noradId === id);
        add('Target', 'Select ' + (c ? c.name : 'NORAD ' + id), () => store.patch({ selected: id }));
      }
      add('Target', 'Select the Moon', () => store.patch({ selected: 'MOON' }));
      return out;
    }
    return { el, open, close, get isOpen() { return el.style.display !== 'none'; } };
  }

  const toggleField = () => store.patch(store.get().fieldMode
    ? { fieldMode: false, uiScale: 'md', theme: 'foundry' }
    : { fieldMode: true, uiScale: 'lg', theme: 'nightops' });

  /* ------------------------------- shortcuts ------------------------------ */
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      palette.isOpen ? palette.close() : palette.open();
      return;
    }
    if (palette.isOpen) return;
    if (e.key === 'Escape') {
      if (help.open) { help.toggle(false); return; }
      if (!typing) handlers.stopRotator();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const presetKeys = { 1: 'tracking', 2: 'planning', 3: 'hardware' };
    if (presetKeys[e.key]) { applyPreset(presetKeys[e.key], true); return; }
    switch (e.key) {
      case 'm': case 'M': store.patch({ view: '2d' }); break;
      case 'g': case 'G': store.patch({ view: '3d' }); break;
      case 'f': case 'F': toggleField(); break;
      case 'l': case 'L': store.patch({ followSat: !store.get().followSat }); break;
      case 'p': case 'P': handlers.parkRotator(); break;
      case 't': case 'T': {
        const order = ['off', 'selected', 'schedule'];
        const cur = store.get().hw.rotator.autoMode || 'off';
        store.patchIn('hw.rotator', { autoMode: order[(order.indexOf(cur) + 1) % order.length] });
        break;
      }
      case '?': help.toggle(); break;
    }
  });

  /* ------------------------------- wake lock ------------------------------ */
  let wakeLock = null;
  async function applyWakeLock(want) {
    try {
      if (want && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch { /* unsupported or denied */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store.get().fieldMode) applyWakeLock(true);
  });

  /* -------------------------- pill shim for main.js ----------------------- */
  // main.js drives connection text through `_set(on, text)` on these objects.
  const pill = (apply) => ({ _set: (on, text) => apply(!!on, text) });

  /* --------------------------------- API ---------------------------------- */
  return {
    view2d: viewport.view2d,
    view3d: viewport.view3d,
    polarHost: sky.host,

    renderList: () => { targets.render(); targets.syncGroup(); },
    setTleStamp: (t) => targets.setStamp(t),
    setStaleIds: (s) => targets.setStale(s),
    updateSky: (m) => targets.setSky(m),
    isSkyActive: () => targets.isSkyActive(),

    updatePasses: (list, now) => passes.update(list, now),
    setReadiness: (r) => passes.setReadiness(r),
    updateInfo: (i, moon, body) => { info.update(i, moon, body); updateCluster(i, body); },
    setSpaceWeather: (w) => info.setSpaceWeather(w),
    setTleStatus: (s) => settings.setTleStatus(s),
    setRadioTuning: (t) => radio.setTuning(t),
    setActiveView: (v) => viewport.setActive(v),
    setRotorConnected: (on) => viewport.setRotorConnected(on),

    updateClock(date, warpMs) {
      const utc = date.toISOString().slice(11, 19);
      const loc = date.toLocaleTimeString([], { hour12: false });
      clock.innerHTML = `<small>UTC</small>${utc}&nbsp;&nbsp;<small>LOC</small>${loc}`
        + (warpMs ? `&nbsp;&nbsp;<span class="value warn">${warpMs > 0 ? '+' : ''}${Math.round(warpMs / 60000)}m preview</span>` : '');
    },

    setStatus({ rotConnected, radConnected, tracking, slewing }) {
      rotLink.connected = !!rotConnected;
      radLink.connected = !!radConnected;
      rotLink.dot.className = 'dot' + (rotConnected ? ' ok' + (slewing ? ' pulse' : '') : '');
      radLink.dot.className = 'dot' + (radConnected ? ' ok' : '');
      rotLink.txt.textContent = rotConnected ? 'Online' : 'Offline';
      radLink.txt.textContent = radConnected ? 'Online' : 'Offline';

      const mode = store.get().hw.rotator.autoMode || 'off';
      modeVal.textContent = mode === 'off' ? 'Manual' : mode === 'selected' ? 'Selected' : 'Scheduled';
      modeVal.className = 'value' + (mode === 'off' ? ' mute' : ' live');
      stateVal.textContent = tracking || 'Idle';
      stateVal.className = 'value' + (tracking ? (/^Pre-slew/.test(tracking) ? ' warn' : tracking === 'Parked' ? ' mute' : ' ok') : ' mute');

      const superrot = !!rotConnected && store.get().hw.rotator.protocol === 'superrot';
      homeBtn.disabled = unwindBtn.disabled = !superrot;
      const why = superrot ? '' : ' — connect using SuperRot first';
      homeBtn.title = 'Zero azimuth at the centred position, seek the elevation endstop, then zero elevation' + why;
      unwindBtn.title = 'Unwind accumulated azimuth turns without changing heading' + why;
    },

    setCableWrap(info) {
      if (!info) { wrapItem.style.display = 'none'; return; }
      wrapItem.style.display = '';
      wrapVal.textContent = `${info.turns >= 0 ? '+' : '−'}${Math.abs(info.turns).toFixed(2)}t`;
      wrapVal.className = 'value ' + (info.level === 'red' ? 'alert' : info.level === 'amber' ? 'warn' : 'ok');
      wrapItem.title = `Cable wrap: ${info.az.toFixed(0)}° from north (${info.turns.toFixed(2)} turns). `
        + `Amber past ${info.warn}°, red past ${info.max}° — unwind manually.`;
    },

    syncAutoMode() { rotator.syncMode(); },

    applyLayout(state) {
      const root = document.documentElement;
      root.classList.remove('d-compact', 'd-normal', 'd-roomy');
      root.classList.add('d-' + (state.uiScale === 'sm' ? 'compact' : state.uiScale === 'lg' ? 'roomy' : 'normal'));
      root.classList.toggle('field', !!state.fieldMode);
      viewport.sync();
      applyWakeLock(!!state.fieldMode);
    },

    hw: {
      rotPill: pill((on, text) => rotator.setLink(on, text)),
      radPill: pill((on, text) => radio.setLink(on, text)),
      lcdPill: pill((on, text) => radio.setLcdLink(on, text)),
      rotConnect: { set textContent(t) { rotator.setConnectLabel(t); }, get textContent() { return ''; } },
      radConnect: { set textContent(t) { radio.setConnectLabel(t); }, get textContent() { return ''; } },
      lcdConnect: { set textContent(t) { radio.setLcdConnectLabel(t); }, get textContent() { return ''; } },
      // main.js writes rotator telemetry as alternating k/v divs; adapt that into
      // the panel's stat grid without changing main.js.
      rotTarget: makeKvSink((cells) => rotator.setTelemetry(cells)),
      radFreqLive: makeKvSink(() => {}),
      autoModeSel: { set value(v) { rotator.syncMode(); }, get value() { return store.get().hw.rotator.autoMode; } },
    },
  };

  /* ------------------------------ cluster sync ---------------------------- */
  function updateCluster(info, body) {
    if (body) {
      cellName.textContent = body.name;
      cellKind.textContent = body.kind === 'dso' ? 'Deep-sky object' : body.kind === 'moon' ? 'Lunar target' : 'Solar-system target';
      cellDot.className = 'dot' + (body.el >= 0 ? ' ok' : '');
      cellDot.style.background = '';
      cAz.v.textContent = deg(body.az);
      cEl.v.textContent = deg(body.el);
      cEl.v.className = 'value ' + (body.el >= 0 ? 'ok' : 'mute');
      cAge.v.textContent = 'local';
      cAos.v.textContent = '—'; cMax.v.textContent = '—'; cDur.v.textContent = '—';
      return;
    }
    if (!info) {
      cellName.textContent = 'No target';
      cellKind.textContent = 'Standby';
      cellDot.className = 'dot';
      cellDot.style.background = '';
      for (const c of [cAos, cAz, cEl, cMax, cDur, cAge]) c.v.textContent = '—';
      return;
    }
    cellName.textContent = info.name;
    cellKind.textContent = 'NORAD ' + info.noradId;
    cellDot.className = 'dot';
    cellDot.style.background = colorFor(info.noradId, store.get().tracked);
    cAz.v.textContent = deg(info.az);
    cEl.v.textContent = deg(info.el);
    cEl.v.className = 'value ' + (info.aboveHorizon ? 'ok' : 'mute');
    cAge.v.textContent = tleAge(info.tleAgeDays);
    cAge.v.className = 'value ' + (info.tleStale ? 'warn' : '');

    // AOS / MAX / DURATION mirror the Passes panel's lead pass, so the cluster keeps
    // showing them even when that panel is closed.
    const lead = passes.lead;
    if (lead.pass) {
      const p = lead.pass.pass;
      const live = lead.now >= p.aos && lead.now <= p.los;
      cAos.v.textContent = live ? 'LIVE' : countdown(p.aos.getTime() - lead.now);
      cAos.v.className = 'value big' + (live ? ' live' : '');
      cMax.v.textContent = deg(p.maxEl);
      cDur.v.textContent = `${Math.floor(p.durationS / 60)}m ${String(p.durationS % 60).padStart(2, '0')}s`;
    } else {
      cAos.v.textContent = '—'; cMax.v.textContent = '—'; cDur.v.textContent = '—';
    }
  }
}

/**
 * main.js builds rotator/radio readouts by appending alternating `.k` / `.v` divs
 * to an element and clearing it with innerHTML = ''. Rather than change that code,
 * expose an object that looks like an element and re-emits the pairs as data.
 */
function makeKvSink(emit) {
  let pending = [];
  return {
    set innerHTML(v) { if (v === '') { pending = []; emit([]); } },
    get innerHTML() { return ''; },
    append(...nodes) {
      for (const n of nodes) {
        if (!n || !n.className) continue;
        if (n.className === 'k') pending.push([n.textContent, '']);
        else if (n.className === 'v' && pending.length) pending[pending.length - 1][1] = n.textContent;
      }
      emit(pending.map(([k, v]) => [k, v, /⚠/.test(k) ? 'warn' : '']));
    },
  };
}
