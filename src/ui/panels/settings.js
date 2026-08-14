/**
 * Settings panel — station, appearance, horizon mask, element freshness, alerts,
 * voice and backup. Everything except the station block starts collapsed, so the
 * panel opens as a short index rather than a wall of fields.
 */

import { store } from '../../core/store.js';
import { THEMES } from '../../core/themes.js';
import { normalizeMask, maskElAt, MASK_PRESETS } from '../../core/horizonMask.js';
import { h, panel, group, rule, checkbox, numberInput, textInput, select, segment, field, fieldInline } from '../widgets.js';

const ALERT_SOUNDS = [
  ['chime', 'Chime'], ['radar', 'Radar'], ['urgent', 'Urgent'], ['sonar', 'Sonar'],
  ['soft', 'Soft arpeggio'], ['beacon', 'Beacon'], ['sparkle', 'Sparkle'], ['descending', 'Descending'],
  ['digital', 'Digital'], ['double', 'Double tone'], ['low', 'Low tone'], ['motor', 'Motor sweep'], ['lock', 'Target lock'],
];

export function buildSettings(handlers, workspace) {
  const st = store.get();

  /* -------------------------------- station ------------------------------- */
  const stationGroup = group('Ground station', [
    field('Name', textInput(st.station.name, (v) => store.patchIn('station', { name: v }))),
    h('div', { class: 'grid-2' }, [
      field('Latitude (°)', numberInput(st.station.lat, '0.0001', (v) => store.patchIn('station', { lat: v }))),
      field('Longitude (°)', numberInput(st.station.lon, '0.0001', (v) => store.patchIn('station', { lon: v }))),
    ]),
    h('div', { class: 'grid-2' }, [
      field('Altitude (m)', numberInput(Math.round(st.station.altKm * 1000), '1', (v) => store.patchIn('station', { altKm: v / 1000 }))),
      field('Pass-list min el (°)', numberInput(st.minEl, '1', (v) => store.patch({ minEl: v }))),
    ]),
    h('p', { class: 'nf-note' }, 'Every pass prediction and look angle is computed for this location.'),
  ], true);

  /* ------------------------------- appearance ----------------------------- */
  const themeSel = select([...Object.entries(THEMES).map(([id, t]) => [id, t.name]), ['custom', 'Custom…']],
    st.theme, (v) => store.patch({ theme: v }));
  const baseSel = select(Object.entries(THEMES).map(([id, t]) => [id, t.name]),
    (st.customTheme && st.customTheme.base) || 'foundry', (v) => store.patchIn('customTheme', { base: v }));
  const accent = h('input', {
    type: 'color', value: (st.customTheme && st.customTheme.accent) || '#3fcfa8',
    oninput: (e) => store.patchIn('customTheme', { accent: e.target.value }),
  });
  const baseRow = field('Custom base palette', baseSel);
  const accentRow = fieldInline('Accent colour', accent);

  const densitySeg = segment([['compact', 'Compact'], ['normal', 'Normal'], ['roomy', 'Roomy']],
    st.uiScale === 'sm' ? 'compact' : st.uiScale === 'lg' ? 'roomy' : 'normal',
    (v) => store.patch({ uiScale: v === 'compact' ? 'sm' : v === 'roomy' ? 'lg' : 'md', fieldMode: false }));

  const fieldBtn = h('button', {
    class: 'btn', title: 'Field mode — oversized controls and the Night Ops palette',
    onclick: () => store.patch(store.get().fieldMode
      ? { fieldMode: false, uiScale: 'md', theme: 'foundry' }
      : { fieldMode: true, uiScale: 'lg', theme: 'nightops' }),
  }, 'Field mode');

  const appearanceGroup = group('Appearance', [
    field('Theme', themeSel), baseRow, accentRow,
    field('Density', densitySeg),
    fieldBtn,
    h('p', { class: 'nf-note' }, 'Field mode pairs oversized hit targets with the red-only Night Ops palette to protect dark adaptation at the antenna.'),
  ]);

  function syncAppearance() {
    const s = store.get();
    themeSel.value = s.theme;
    baseSel.value = (s.customTheme && s.customTheme.base) || 'foundry';
    accent.value = (s.customTheme && s.customTheme.accent) || '#3fcfa8';
    const custom = s.theme === 'custom';
    baseRow.style.display = custom ? '' : 'none';
    accentRow.style.display = custom ? '' : 'none';
    densitySeg.set(s.uiScale === 'sm' ? 'compact' : s.uiScale === 'lg' ? 'roomy' : 'normal');
    fieldBtn.classList.toggle('on', !!s.fieldMode);
  }
  store.subscribe(syncAppearance);
  syncAppearance();

  /* --------------------------------- basemap ------------------------------ */
  const mapGroup = group('Basemap', [
    field('Coastline detail', select([
      ['auto', 'Automatic — follows zoom'],
      ['110m', 'Low · 1:110m (5k points)'],
      ['50m', 'Medium · 1:50m (61k points)'],
      ['10m', 'High · 1:10m (409k points)'],
    ], st.mapDetail || 'auto', (v) => store.patch({ mapDetail: v }))),
    fieldInline('Country borders', checkbox(st.showBorders, (v) => store.patch({ showBorders: v }))),
    h('p', { class: 'nf-note' }, 'Natural Earth vector data, bundled — no network needed. Automatic loads the finer sets only once you zoom past 2× and 5×, so the whole-world view stays light. Pin High if you want maximum coastline detail immediately, or Low on a slow machine.'),
  ]);

  /* ------------------------------ horizon mask ---------------------------- */
  const canvas = h('canvas', { class: 'hm-plot', width: 240, height: 240 });
  const maskList = h('div', { class: 'hm-list' });
  const getMask = () => normalizeMask(store.get().horizonMask);
  const saveMask = (pts) => store.patch({ horizonMask: normalizeMask(pts) });

  function drawMask() {
    const mask = getMask();
    const on = store.get().horizonMaskOn && mask.length > 0;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, c = W / 2, R = W / 2 - 14;
    ctx.clearRect(0, 0, W, W);
    const css = getComputedStyle(document.documentElement);
    const line = (css.getPropertyValue('--line-hard') || '#2a3646').trim();
    const dim = (css.getPropertyValue('--fg-mute') || '#56626f').trim();
    const acc = (css.getPropertyValue('--accent') || '#3fcfa8').trim();
    const alert = (css.getPropertyValue('--alert') || '#e0574f').trim();
    const at = (az) => (az - 90) * Math.PI / 180;
    const rad = (elv) => R * (1 - Math.max(0, Math.min(90, elv)) / 90);

    ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.font = '9px ui-monospace, monospace'; ctx.fillStyle = dim;
    for (const e of [0, 30, 60]) { ctx.beginPath(); ctx.arc(c, c, rad(e), 0, Math.PI * 2); ctx.stroke(); }
    for (const [az, lab] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
      const a = at(az);
      ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + R * Math.cos(a), c + R * Math.sin(a)); ctx.stroke();
      ctx.fillText(lab, c + (R + 6) * Math.cos(a) - 3, c + (R + 6) * Math.sin(a) + 3);
    }
    if (!mask.length) return;
    // Fill the blocked band: the horizon disc minus the visible-sky silhouette.
    ctx.save();
    ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2);
    for (let az = 360; az >= 0; az -= 3) { const r = rad(maskElAt(mask, az)), a = at(az); ctx.lineTo(c + r * Math.cos(a), c + r * Math.sin(a)); }
    ctx.fillStyle = on ? 'rgba(224,87,79,0.15)' : 'rgba(120,130,150,0.10)';
    ctx.fill('evenodd');
    ctx.restore();
    ctx.strokeStyle = on ? alert : dim; ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let az = 0; az <= 360; az += 3) { const r = rad(maskElAt(mask, az)), a = at(az); az ? ctx.lineTo(c + r * Math.cos(a), c + r * Math.sin(a)) : ctx.moveTo(c + r * Math.cos(a), c + r * Math.sin(a)); }
    ctx.closePath(); ctx.stroke();
    ctx.fillStyle = acc;
    for (const p of mask) { const r = rad(p.el), a = at(p.az); ctx.fillRect(c + r * Math.cos(a) - 2, c + r * Math.sin(a) - 2, 4, 4); }
  }

  function renderMask() {
    const mask = getMask();
    maskList.replaceChildren();
    if (!mask.length) {
      maskList.append(h('div', { class: 'empty' }, 'No obstructions — flat 0° horizon'));
      return;
    }
    mask.forEach((p, i) => {
      maskList.append(h('div', { class: 'hm-row' }, [
        h('span', { class: 'label' }, 'Az'),
        numberInput(p.az, '1', (v) => { const m = getMask(); m[i] = { ...m[i], az: v }; saveMask(m); refreshMask(); }, { min: 0, max: 360 }),
        h('span', { class: 'label' }, 'El'),
        numberInput(p.el, '1', (v) => { const m = getMask(); m[i] = { ...m[i], el: v }; saveMask(m); drawMask(); }, { min: 0, max: 90 }),
        h('button', { class: 'btn sm', title: 'Remove point', onclick: () => { const m = getMask(); m.splice(i, 1); saveMask(m); refreshMask(); } }, '×'),
      ]));
    });
  }
  const refreshMask = () => { renderMask(); drawMask(); };

  /** Place a new point in the widest unused azimuth gap so they spread out. */
  function nextGapAz(mask) {
    if (!mask.length) return 0;
    const used = mask.map((p) => p.az).sort((a, b) => a - b);
    let best = 0, gap = -1;
    for (let i = 0; i < used.length; i++) {
      const a = used[i], b = i + 1 < used.length ? used[i + 1] : used[0] + 360;
      if (b - a > gap) { gap = b - a; best = ((a + b) / 2) % 360; }
    }
    return Math.round(best);
  }

  const horizonGroup = group('Horizon mask', [
    fieldInline('Apply to pass visibility', checkbox(store.get().horizonMaskOn !== false, (v) => { store.patch({ horizonMaskOn: v }); drawMask(); })),
    h('div', { class: 'hm-wrap' }, [canvas]),
    h('div', { class: 'row' }, [
      select([['', 'Load preset…'], ...Object.entries(MASK_PRESETS).map(([k, v]) => [k, v.label])], '', (k) => {
        if (k && MASK_PRESETS[k]) { saveMask(MASK_PRESETS[k].points); refreshMask(); }
      }),
      h('button', { class: 'btn sm', onclick: () => { const m = getMask(); m.push({ az: nextGapAz(m), el: 15 }); saveMask(m); refreshMask(); } }, 'Add point'),
      h('button', { class: 'btn sm', onclick: () => { saveMask([]); refreshMask(); } }, 'Clear'),
    ]),
    maskList,
    h('p', { class: 'nf-note' }, 'Minimum elevation per compass bearing — trees, hills, buildings. Passes clipped by the mask are down-scored, and readiness flags one stuck behind terrain.'),
  ]);
  refreshMask();
  store.subscribe(drawMask); // re-tint on theme change

  /* -------------------------------- elements ------------------------------ */
  const tleStatus = h('div', { class: 'nf-note' }, '');
  const elementsGroup = group('Orbit elements', [
    fieldInline('Auto-update cached elements', checkbox(st.tleSched.auto, (v) => store.patchIn('tleSched', { auto: v }))),
    field('Max element age (days)', numberInput(st.tleSched.maxAgeDays, '1', (v) => store.patchIn('tleSched', { maxAgeDays: Math.max(1, Math.round(v)) }))),
    h('button', { class: 'btn', onclick: () => handlers.updateTlesNow() }, 'Update now'),
    tleStatus,
    h('p', { class: 'nf-note' }, 'Celestrak is fetched as OMM JSON with a TLE fallback; both carry the same epoch, so the age check covers either. Loaded OEM ephemerides take priority and are never auto-refreshed.'),
  ]);

  /* --------------------------------- alerts ------------------------------- */
  const soundRow = (label, enabledKey, soundKey, fallback) => {
    const sel = select(ALERT_SOUNDS, store.get()[soundKey] || fallback, (v) => {
      store.patch({ [soundKey]: v });
      window.playPassAlert?.(v);
    });
    const kids = [h('span', { class: 'label' }, label), sel];
    if (enabledKey) kids.push(checkbox(store.get()[enabledKey] !== false, (v) => store.patch({ [enabledKey]: v })));
    return h('label', { class: 'snd' + (enabledKey ? ' has-chk' : '') }, kids);
  };

  const notifyChk = checkbox(st.notifyPasses, async (v) => {
    if (v && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      if (await Notification.requestPermission() !== 'granted') { notifyChk.checked = false; return; }
    }
    store.patch({ notifyPasses: v });
  });

  const alertsGroup = group('Alerts', [
    fieldInline('Desktop notification before a pass', notifyChk),
    field('Lead time (minutes)', numberInput(st.notifyLead, '1', (v) => store.patch({ notifyLead: Math.max(1, Math.round(v)) }))),
    fieldInline('Play alert sounds', checkbox(st.notifySound !== false, (v) => { store.patch({ notifySound: v }); if (v) window.playPassAlert?.(); })),
    field('Lead alert sound', select(ALERT_SOUNDS, st.notifySoundStyle || 'chime', (v) => { store.patch({ notifySoundStyle: v }); window.playPassAlert?.(v); })),
    rule('During the pass'),
    soundRow('Rising · AOS', 'notifyAos', 'notifyAosSound', 'beacon'),
    soundRow('Peak elevation', 'notifyPeak', 'notifyPeakSound', 'sparkle'),
    soundRow('Ending · LOS', 'notifyLos', 'notifyLosSound', 'descending'),
    rule('Rotator'),
    fieldInline('Rotator sounds', checkbox(st.rotatorSounds !== false, (v) => store.patch({ rotatorSounds: v }))),
    soundRow('Connected', null, 'rotatorConnectSound', 'digital'),
    soundRow('Disconnected', null, 'rotatorDisconnectSound', 'low'),
    soundRow('Tracking started', null, 'rotatorTrackSound', 'beacon'),
    soundRow('Parked', null, 'rotatorParkSound', 'soft'),
    h('button', { class: 'btn sm', style: 'margin-top:8px', onclick: () => window.playPassAlert?.() }, 'Test sound'),
    h('p', { class: 'nf-note' }, '“Play alert sounds” is the master switch — turning it off silences the rotator cues and the voice as well.'),
  ]);

  /* --------------------------------- voice -------------------------------- */
  const voiceSel = h('select', { onchange: (e) => store.patch({ notifyVoiceURI: e.target.value }) });
  const fillVoices = () => {
    const voices = window.speechSynthesis?.getVoices?.() || [];
    voiceSel.replaceChildren(h('option', { value: '__female__' }, 'Automatic female voice'), h('option', { value: '' }, 'System default'));
    voices.forEach((v) => voiceSel.append(h('option', { value: v.voiceURI }, `${v.name} (${v.lang})`)));
    voiceSel.value = store.get().notifyVoiceURI || '';
  };
  fillVoices();
  if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', fillVoices, { once: true });

  const roboticChk = checkbox(!!st.notifyVoiceRobotic, (v) => {
    store.patch({ notifyVoiceRobotic: v });
    if (store.get().notifyVoice) window.testPassVoice?.();
  });
  const template = h('textarea', { rows: 4, oninput: (e) => store.patch({ notifyVoiceTemplate: e.target.value }) }, st.notifyVoiceTemplate || '');
  const PRESETS = {
    friendly: 'Heads up! {satellite} will rise in {minutes} {minuteWord}. The pass lasts about {duration} {durationWord} and reaches {maxElevation} degrees. {visibility}',
    concise: '{satellite}, arriving in {minutes} {minuteWord}. Duration {duration} {durationWord}. Maximum elevation {maxElevation} degrees.',
    mission: 'Pass alert. Target {satellite}. A O S in {minutes} {minuteWord}. Pass duration {duration} {durationWord}. Peak elevation {maxElevation} degrees. {visibility}',
    ship: 'Attention. {satellite} acquisition of signal in {minutes} {minuteWord}. Projected peak elevation, {maxElevation} degrees. {visibility}',
  };

  const voiceGroup = group('Voice announcements', [
    fieldInline('Speak pass details', checkbox(!!st.notifyVoice, (v) => { store.patch({ notifyVoice: v }); if (v) window.testPassVoice?.(); })),
    fieldInline('Robotic ship-computer delivery', roboticChk),
    field('Voice', voiceSel),
    h('div', { class: 'grid-3' }, [
      field('Rate', numberInput(st.notifyVoiceRate ?? 0.95, '0.05', (v) => store.patch({ notifyVoiceRate: Math.min(2, Math.max(0.5, v)) }), { min: 0.5, max: 2 })),
      field('Pitch', numberInput(st.notifyVoicePitch ?? 1, '0.1', (v) => store.patch({ notifyVoicePitch: Math.min(2, Math.max(0, v)) }), { min: 0, max: 2 })),
      field('Volume', numberInput(st.notifyVoiceVolume ?? 1, '0.1', (v) => store.patch({ notifyVoiceVolume: Math.min(1, Math.max(0, v)) }), { min: 0, max: 1 })),
    ]),
    h('p', { class: 'nf-note' }, 'The robotic delivery overrides rate and pitch with a flat, deliberate cadence.'),
    field('Announcement style', select([['', 'Choose a style…'], ['friendly', 'Friendly'], ['concise', 'Short and concise'], ['mission', 'Mission control'], ['ship', 'Ship computer']], '', (k) => {
      const t = PRESETS[k];
      if (!t) return;
      template.value = t;
      store.patch({ notifyVoiceTemplate: t });
      if (k === 'ship') { store.patch({ notifyVoiceRobotic: true }); roboticChk.checked = true; }
      window.testPassVoice?.();
    })),
    field('What the announcer says', template),
    h('p', { class: 'nf-note' }, [
      'Placeholders: ', h('code', {}, '{satellite}'), ' ', h('code', {}, '{minutes}'), ' ', h('code', {}, '{duration}'), ' ',
      h('code', {}, '{maxElevation}'), ' ', h('code', {}, '{visibility}'), '. Use ', h('code', {}, '{minuteWord}'), ' and ',
      h('code', {}, '{durationWord}'), ' for correct singular and plural wording.',
    ]),
    h('button', { class: 'btn sm', onclick: () => window.testPassVoice?.() }, 'Test voice'),
  ]);

  /* -------------------------------- backup -------------------------------- */
  const dataMsg = h('div', { class: 'nf-note' }, '');
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

  const backupGroup = group('Backup & workspace', [
    h('div', { class: 'row' }, [
      h('button', { class: 'btn sm', onclick: () => {
        const a = h('a', {
          download: 'skyphreak-settings-' + new Date().toISOString().slice(0, 10) + '.json',
          href: URL.createObjectURL(new Blob([JSON.stringify(store.get(), null, 2)], { type: 'application/json' })),
        });
        a.click();
        URL.revokeObjectURL(a.href);
      } }, 'Export settings'),
      h('button', { class: 'btn sm', onclick: () => importInput.click() }, 'Import settings'),
      importInput,
    ]),
    dataMsg,
    h('p', { class: 'nf-note' }, 'Exports every setting — station, hardware, tracked satellites and their cached elements — so a field machine can be restored offline. Importing replaces everything and reloads.'),
    rule('Workspace'),
    h('button', { class: 'btn sm', onclick: () => workspace.resetLayout() }, 'Reset panel layout'),
    h('p', { class: 'nf-note' }, 'Restores the current workspace preset’s default panel arrangement.'),
  ]);

  const el = panel({
    body: [stationGroup, appearanceGroup, mapGroup, horizonGroup, elementsGroup, alertsGroup, voiceGroup, backupGroup],
  });

  return {
    el,
    setTleStatus({ maxDays, stale, auto, online }) {
      tleStatus.className = 'nf-note' + (stale > 0 ? ' warn' : '');
      let msg = stale > 0
        ? `${stale} tracked element set${stale > 1 ? 's' : ''} older than ${maxDays} d` + (online ? ' — refreshing when possible' : ' — offline, using cache')
        : `Tracked elements current, under ${maxDays} d old`;
      if (!auto) msg += ' · auto-update off';
      tleStatus.textContent = msg;
    },
  };
}
