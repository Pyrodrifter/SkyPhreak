/**
 * Radio panel — rigctld link, live tuning readout, per-satellite frequency
 * profiles, and the one-way LCD repeater output.
 *
 * The tuning readout is the point of the panel: RX and TX as large monospace
 * numbers with the Doppler shift beside them, because that is what you check
 * mid-QSO without reading any labels.
 */

import { store } from '../../core/store.js';
import { MODES, RADIO_PRESETS } from '../../core/radioProfiles.js';
import { h, panel, group, rule, stat, statGrid, checkbox, numberInput, textInput, select, field, fieldInline } from '../widgets.js';

export function buildRadio(handlers) {
  const rad = () => store.get().hw.radio;

  const link = h('div', { class: 'hw-link' }, [h('span', { class: 'dot' }), h('span', { class: 'hw-link-t' }, 'Radio disconnected')]);
  const connectBtn = h('button', { class: 'btn primary', onclick: () => handlers.connectRadio() }, 'Connect');

  /* ------------------------------ tuning deck ----------------------------- */
  const rx = h('span', { class: 'value hero' }, '—');
  const tx = h('span', { class: 'value hero' }, '—');
  const rxMode = h('span', { class: 'chip' }, '—');
  const txMode = h('span', { class: 'chip' }, '—');
  const shift = h('span', { class: 'value big' }, '0.00 kHz');
  const target = h('span', { class: 'rd-target' }, 'No target');
  const profileLbl = h('span', { class: 'cell-sub' }, 'Global fallback');

  const dopplerBtn = h('button', {
    class: 'btn sm', role: 'switch', 'aria-checked': 'false',
    title: 'Continuously retune the radio to cancel the Doppler shift',
    onclick: () => store.patchIn('hw.radio', { doppler: !rad().doppler }),
  }, 'Doppler');

  const deck = h('div', { class: 'rd-deck' }, [
    h('div', { class: 'rd-head' }, [target, profileLbl]),
    h('div', { class: 'rd-line' }, [h('span', { class: 'label' }, 'RX · downlink'), rxMode, h('span', { class: 'spacer' }), rx]),
    h('div', { class: 'rd-line' }, [h('span', { class: 'label' }, 'TX · uplink'), txMode, h('span', { class: 'spacer' }), tx]),
    h('div', { class: 'rd-line shift' }, [h('span', { class: 'label' }, 'Doppler Δ'), h('span', { class: 'spacer' }), shift]),
  ]);

  /* ------------------------------- profiles ------------------------------- */
  const prof = h('div', {});
  let editId = null;
  const nameFor = (id) => {
    const c = store.getCatalog().find((s) => s.noradId === id);
    if (c) return c.name;
    const f = store.get().favorites.find((x) => x.id === id);
    if (f) return f.name;
    const t = (store.get().tleStore || {})[id];
    return t ? t.name : 'NORAD ' + id;
  };
  const getProfile = (id) => (store.get().radioProfiles || {})[id] || {};
  const setProfile = (id, patch) => {
    const all = { ...(store.get().radioProfiles || {}) };
    all[id] = { ...(all[id] || {}), ...patch };
    store.patch({ radioProfiles: all });
  };
  const mhz = (hz, on) => h('input', {
    type: 'number', step: '0.0001', placeholder: '—', value: hz ? (hz / 1e6).toFixed(4) : '',
    oninput: (e) => { const v = parseFloat(e.target.value); on(Number.isNaN(v) ? 0 : Math.round(v * 1e6)); },
  });

  function renderProfiles() {
    const st = store.get();
    const ids = st.tracked || [];
    prof.replaceChildren();
    if (!ids.length) { prof.append(h('div', { class: 'empty' }, 'Track a satellite to give it a radio profile')); return; }
    if (!ids.includes(editId)) editId = ids.includes(st.selected) ? st.selected : ids[0];

    const satSel = h('select', { onchange: (e) => { editId = e.target.value; renderProfiles(); } },
      ids.map((id) => h('option', { value: id }, nameFor(id) + ((st.radioProfiles || {})[id] ? '  •' : ''))));
    satSel.value = editId;

    const p = getProfile(editId);
    const presetSel = h('select', { onchange: (e) => {
      const k = e.target.value;
      if (k && RADIO_PRESETS[k]) setProfile(editId, { ...RADIO_PRESETS[k] });
      renderProfiles();
    } }, [h('option', { value: '' }, 'Load preset…'), ...Object.entries(RADIO_PRESETS).map(([k, v]) => h('option', { value: k }, v.label))]);

    const modeSel = (mode, on) => select(MODES.map((m) => [m, m]), mode || 'FM', on);

    prof.append(
      field('Satellite', satSel),
      h('div', { class: 'row' }, [presetSel, h('button', {
        class: 'btn sm', title: 'Remove this profile so the satellite falls back to the default downlink',
        onclick: () => {
          const all = { ...(store.get().radioProfiles || {}) };
          delete all[editId];
          store.patch({ radioProfiles: all });
          renderProfiles();
        },
      }, 'Clear')]),
      field('Label', textInput(p.label || '', (v) => setProfile(editId, { label: v }), 'e.g. RS-44 linear')),
      h('div', { class: 'grid-2' }, [
        field('Downlink (MHz)', mhz(p.downlinkHz, (hz) => setProfile(editId, { downlinkHz: hz }))),
        field('Mode', modeSel(p.downlinkMode, (m) => setProfile(editId, { downlinkMode: m }))),
        field('Uplink (MHz)', mhz(p.uplinkHz, (hz) => setProfile(editId, { uplinkHz: hz }))),
        field('Mode', modeSel(p.uplinkMode, (m) => setProfile(editId, { uplinkMode: m }))),
      ]),
      fieldInline('Inverting transponder', checkbox(!!p.invert, (v) => setProfile(editId, { invert: v }))),
      h('p', { class: 'nf-note' }, 'The downlink tunes your RX; the uplink is Doppler-corrected in the opposite sense so a linear-transponder QSO stays locked. Leave the uplink blank for beacons and telemetry.'),
    );
  }
  renderProfiles();
  // Re-render only when the tracked set or selection changes — not on the store
  // patches our own inputs fire, which would steal focus mid-typing.
  let profSig = (store.get().tracked || []).join(',') + '|' + store.get().selected;
  store.subscribe(() => {
    const next = (store.get().tracked || []).join(',') + '|' + store.get().selected;
    if (next !== profSig) { profSig = next; renderProfiles(); }
  });

  /* ----------------------------- LCD repeater ----------------------------- */
  const lcd = () => store.get().hw.lcd;
  const lcdLink = h('div', { class: 'hw-link' }, [h('span', { class: 'dot' }), h('span', { class: 'hw-link-t' }, 'Display disconnected')]);
  const lcdBtn = h('button', { class: 'btn sm', onclick: () => handlers.connectLcd() }, 'Connect');
  const lcdConn = h('div', {});
  const lcdPortSel = h('select', { onchange: (e) => store.patchIn('hw.lcd', { path: e.target.value }) });
  async function refreshLcdPorts() {
    lcdPortSel.replaceChildren(h('option', { value: '' }, 'Scanning…'));
    // Shared serial-port enumerator — it lives under the rotator bridge but lists
    // every port on the machine, which is what the display picker needs too.
    const r = await window.pyro.rotator.listPorts();
    lcdPortSel.replaceChildren();
    if (!r.ok) return lcdPortSel.append(h('option', { value: '' }, r.error || 'USB unavailable'));
    if (!r.ports.length) return lcdPortSel.append(h('option', { value: '' }, 'No serial ports found'));
    for (const p of r.ports) lcdPortSel.append(h('option', { value: p.path }, p.label));
    const cur = lcd().path;
    if (r.ports.some((p) => p.path === cur)) lcdPortSel.value = cur;
    else { lcdPortSel.value = r.ports[0].path; store.patchIn('hw.lcd', { path: r.ports[0].path }); }
  }
  function renderLcd() {
    const l = lcd();
    lcdConn.replaceChildren();
    if (l.transport === 'serial') {
      lcdConn.append(
        field('USB port', h('div', { class: 'row' }, [lcdPortSel, h('button', { class: 'btn sm', onclick: refreshLcdPorts }, 'Scan')])),
        field('Baud', numberInput(l.baud, '1', (v) => store.patchIn('hw.lcd', { baud: Math.max(300, Math.round(v)) }))),
      );
      refreshLcdPorts();
    } else if (l.transport === 'server') {
      lcdConn.append(
        field('Listen port', numberInput(l.port, '1', (v) => store.patchIn('hw.lcd', { port: Math.round(v) }))),
        h('p', { class: 'nf-note' }, 'Enter this machine’s IP and the port above in the display’s satellite-feed settings and it will connect in. The connected address appears above once listening.'),
      );
    } else {
      lcdConn.append(h('div', { class: 'grid-2' }, [
        field('Host', textInput(l.host, (v) => store.patchIn('hw.lcd', { host: v }))),
        field('Port', numberInput(l.port, '1', (v) => store.patchIn('hw.lcd', { port: Math.round(v) }))),
      ]));
    }
  }
  const lcdGroup = group('Display repeater', [
    lcdLink,
    fieldInline('Stream selected target', checkbox(lcd().enabled, (v) => store.patchIn('hw.lcd', { enabled: v }))),
    field('Connection', select([
      ['serial', 'USB serial'], ['tcp', 'Wi-Fi / TCP — we dial the display'], ['server', 'Listen — the display dials us'],
    ], lcd().transport, (v) => { store.patchIn('hw.lcd', { transport: v }); renderLcd(); })),
    lcdConn,
    field('Line format', select([
      ['simple', 'Simple — AZ179.4 EL42.1'], ['csv', 'CSV — 179.4,42.1'],
      ['json', 'JSON — {name,az,el}'], ['pyrolcd', 'PyroLCD — sat/az/el + pass'],
    ], lcd().format || 'simple', (v) => store.patchIn('hw.lcd', { format: v }))),
    lcdBtn,
    h('p', { class: 'nf-note' }, 'A one-way feed to a bench display, independent of the rotator. Sends the selected target’s bearing once a second; elevation goes negative below the horizon. For the PyroLCD ESP32 use Listen plus the PyroLCD format.'),
  ]);
  renderLcd();

  /* -------------------------------- assembly ------------------------------ */
  const liveTune = h('div', {});
  const el = panel({
    toolbar: [connectBtn, dopplerBtn, h('span', { class: 'spacer' })],
    body: [
      link, deck,
      rule('Link'),
      h('div', { class: 'grid-2' }, [
        field('Host', textInput(rad().host, (v) => store.patchIn('hw.radio', { host: v }))),
        field('Port', numberInput(rad().port, '1', (v) => store.patchIn('hw.radio', { port: v }))),
      ]),
      field('Default downlink (MHz)', numberInput((rad().downlinkHz / 1e6).toFixed(4), '0.0001',
        (v) => store.patchIn('hw.radio', { downlinkHz: Math.round(v * 1e6) }))),
      h('p', { class: 'nf-note' }, 'Used when the active satellite has no profile of its own.'),
      liveTune,
      rule('Per-satellite profiles'),
      prof,
      lcdGroup,
    ],
  });

  function syncDoppler() {
    const on = !!rad().doppler;
    dopplerBtn.classList.toggle('on', on);
    dopplerBtn.setAttribute('aria-checked', String(on));
  }
  store.subscribe(syncDoppler);
  syncDoppler();

  return {
    el,
    setLink(on, text) {
      link.querySelector('.dot').className = 'dot' + (on ? ' ok pulse' : ' alert');
      link.querySelector('.hw-link-t').textContent = text;
      connectBtn.textContent = on ? 'Disconnect' : 'Connect';
    },
    setConnectLabel(t) { connectBtn.textContent = t; },
    setLcdLink(on, text) {
      lcdLink.querySelector('.dot').className = 'dot' + (on ? ' ok' : '');
      lcdLink.querySelector('.hw-link-t').textContent = text;
    },
    setLcdConnectLabel(t) { lcdBtn.textContent = t; },
    /** Live tuning, pushed by main.js each tick. null clears the deck. */
    setTuning(t) {
      deck.classList.toggle('active', !!t);
      rx.textContent = t?.downlinkTunedHz ? (t.downlinkTunedHz / 1e6).toFixed(5) : '—';
      tx.textContent = t?.uplinkTunedHz ? (t.uplinkTunedHz / 1e6).toFixed(5) : '—';
      rxMode.textContent = t?.downlinkMode || '—';
      txMode.textContent = t?.uplinkMode || '—';
      target.textContent = t?.targetName || 'No target';
      profileLbl.textContent = t?.profileLabel || (t?.source === 'profile' ? 'Saved profile' : 'Global fallback');
      const d = t?.downlinkShiftHz || 0;
      shift.textContent = `${d >= 0 ? '+' : '−'}${Math.abs(d / 1000).toFixed(2)} kHz`;
      shift.className = 'value big' + (d > 0 ? ' ok' : d < 0 ? ' warn' : ' mute');
      liveTune.replaceChildren();
      if (t) {
        const cells = [stat('Downlink tuned', (t.downlinkTunedHz / 1e6).toFixed(5) + ' MHz')];
        if (t.hasUplink) cells.push(stat('Uplink tuned', (t.uplinkTunedHz / 1e6).toFixed(5) + ' MHz' + (t.invert ? ' ↕' : '')));
        liveTune.append(statGrid(cells, cells.length));
      }
    },
  };
}
