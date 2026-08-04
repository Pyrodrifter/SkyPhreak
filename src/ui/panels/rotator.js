/**
 * Rotator panel — connection, auto-track mode, live telemetry, manual jog, and the
 * occasional-use groups (motion limits, park presets, calibration, recorder).
 *
 * Layout intent: the things you touch during a pass (connect, mode, jog, stop) are
 * always visible; everything you set once and forget lives in a collapsed group.
 */

import { store } from '../../core/store.js';
import { h, panel, group, rule, stat, statGrid, segment, checkbox, numberInput, textInput, select, field, fieldInline, deg } from '../widgets.js';
import { openSuperRotSetup } from '../../views/superrotSetup.js';

export function buildRotator(handlers) {
  const rot = () => store.get().hw.rotator;

  /* ------------------------------- connection ----------------------------- */
  const link = h('div', { class: 'hw-link' }, [
    h('span', { class: 'dot' }),
    h('span', { class: 'hw-link-t' }, 'Rotator disconnected'),
  ]);
  const connectBtn = h('button', { class: 'btn primary', onclick: () => handlers.connectRotator() }, 'Connect');

  const protoSel = select([['hamlib', 'Hamlib / rotctld'], ['superrot', 'SuperRot (smooth)']], rot().protocol,
    (v) => { store.patchIn('hw.rotator', { protocol: v }); renderConn(); });
  const transportSel = select([['tcp', 'Wi-Fi / TCP'], ['serial', 'USB serial']], rot().transport,
    (v) => { store.patchIn('hw.rotator', { transport: v }); renderConn(); });
  const transportRow = field('Transport', transportSel);

  const portSel = h('select', { onchange: (e) => store.patchIn('hw.rotator', { path: e.target.value }) });
  async function refreshPorts() {
    portSel.replaceChildren(h('option', { value: '' }, 'Scanning…'));
    const r = await window.pyro.rotator.listPorts();
    portSel.replaceChildren();
    if (!r.ok) return portSel.append(h('option', { value: '' }, r.error || 'USB unavailable'));
    if (!r.ports.length) return portSel.append(h('option', { value: '' }, 'No serial ports found'));
    for (const p of r.ports) portSel.append(h('option', { value: p.path }, p.label));
    const cur = rot().path;
    if (r.ports.some((p) => p.path === cur)) portSel.value = cur;
    else { portSel.value = r.ports[0].path; store.patchIn('hw.rotator', { path: r.ports[0].path }); }
  }

  const connFields = h('div', {});
  function renderConn() {
    const r = rot();
    const superrot = r.protocol === 'superrot';
    transportRow.style.display = superrot ? '' : 'none';
    motionGroup.style.display = superrot ? '' : 'none';
    connFields.replaceChildren();
    if (superrot && r.transport === 'serial') {
      connFields.append(
        field('Serial port', h('div', { class: 'row' }, [portSel, h('button', { class: 'btn sm', onclick: refreshPorts }, 'Scan')])),
        field('Baud', numberInput(r.baud, '1', (v) => store.patchIn('hw.rotator', { baud: v }))),
      );
      refreshPorts();
    } else {
      connFields.append(h('div', { class: 'grid-2' }, [
        field('Host', textInput(r.host, (v) => store.patchIn('hw.rotator', { host: v }))),
        field('Port', numberInput(r.port, '1', (v) => store.patchIn('hw.rotator', { port: v }))),
      ]));
    }
  }

  /* ------------------------------- auto-track ----------------------------- */
  const modeSeg = segment(
    [['off', 'Manual', 'Rotator not auto-driven'],
     ['selected', 'Selected', 'Follow the selected target whenever it is up'],
     ['schedule', 'Scheduled', 'Follow whichever tracked satellite is in a pass']],
    rot().autoMode || 'off', (v) => store.patchIn('hw.rotator', { autoMode: v }));

  /* -------------------------------- telemetry ----------------------------- */
  const tel = h('div', { class: 'hw-tel' });

  /* ---------------------------------- jog --------------------------------- */
  let step = 5;
  const stepSeg = segment([[1, '1°'], [5, '5°'], [10, '10°']], step, (v) => { step = +v; stepSeg.set(v); }, 'sm');
  const jog = (daz, del, label, title, cls) => h('button', { class: 'jog ' + cls, title, onclick: () => handlers.jogRotator(daz, del) }, label);
  const jogPad = h('div', { class: 'jog-pad' }, [
    jog(0, step, '▲', 'Elevation up', 'up'),
    jog(-step, 0, '◀', 'Azimuth counter-clockwise', 'left'),
    h('button', { class: 'jog stop', title: 'Stop the rotator', onclick: () => handlers.stopRotator() }, '■'),
    jog(step, 0, '▶', 'Azimuth clockwise', 'right'),
    jog(0, -step, '▼', 'Elevation down', 'down'),
  ]);
  // Rebind the arrows whenever the step changes, so each button always sends the
  // current increment without rebuilding the pad.
  const rebind = () => {
    const [up, left, , right, down] = jogPad.children;
    up.onclick = () => handlers.jogRotator(0, step);
    down.onclick = () => handlers.jogRotator(0, -step);
    left.onclick = () => handlers.jogRotator(-step, 0);
    right.onclick = () => handlers.jogRotator(step, 0);
  };
  stepSeg.querySelectorAll('button').forEach((b) => b.addEventListener('click', rebind));

  /* --------------------------- collapsed groups --------------------------- */
  const motionGroup = group('Motion & limits', [
    h('div', { class: 'grid-2' }, [
      field('Max az rate (°/s)', numberInput(rot().maxVelAz, '0.5', (v) => store.patchIn('hw.rotator', { maxVelAz: v }))),
      field('Max el rate (°/s)', numberInput(rot().maxVelEl, '0.5', (v) => store.patchIn('hw.rotator', { maxVelEl: v }))),
    ]),
    field('Motion profile', select([['gentle', 'Gentle — EME / heavy'], ['normal', 'Normal'], ['fast', 'Fast — light LEO']],
      rot().motionProfile || 'normal', (v) => store.patchIn('hw.rotator', { motionProfile: v }))),
    field('El max (° — 180 enables flip-over)', numberInput(rot().elMax, '1', (v) => store.patchIn('hw.rotator', { elMax: v }))),
    h('p', { class: 'nf-note' }, 'Azimuth is free 360° shortest-path with no travel limit, so it may run negative. Set El max to 180 to let the mount flip over the top on high passes instead of whipping the azimuth around.'),
    rule('Cable wrap'),
    h('div', { class: 'grid-2' }, [
      field('Warn at (°)', numberInput(rot().wrapWarnDeg, '30', (v) => store.patchIn('hw.rotator', { wrapWarnDeg: Math.max(0, Math.round(v)) }))),
      field('Limit at (°)', numberInput(rot().wrapMaxDeg, '30', (v) => store.patchIn('hw.rotator', { wrapMaxDeg: Math.max(0, Math.round(v)) }))),
    ]),
    h('p', { class: 'nf-note' }, 'Accumulated azimuth away from north. The status-bar wrap gauge turns amber past the warning and red past the limit, and readiness flags a pass that would run out of cable. 540° is one and a half turns.'),
    h('button', { class: 'btn sm', style: 'margin-top:6px', title: 'Write the rate limits, offsets and backlash to the controller so they persist on the MCU', onclick: () => handlers.pushRotatorConfig() }, 'Push settings to controller'),
  ]);

  const parkList = h('div', { class: 'park' });
  const parkName = h('input', { type: 'text', placeholder: 'Preset name' });
  let parkSig = '';
  function renderParks() {
    const r = rot();
    const sig = JSON.stringify([r.parkPresets, r.parkDefault]);
    if (sig === parkSig) return;
    parkSig = sig;
    parkList.replaceChildren();
    for (const p of r.parkPresets || []) {
      const isDef = p.name === r.parkDefault;
      parkList.append(h('div', { class: 'park-row' }, [
        h('button', {
          class: 'tg-star' + (isDef ? ' on' : ''),
          title: isDef ? 'Default — the Park button uses this' : 'Make default',
          onclick: () => store.patchIn('hw.rotator', { parkDefault: p.name }),
        }, isDef ? '★' : '☆'),
        h('span', { class: 'park-n' }, p.name),
        h('span', { class: 'park-p num' }, p.home ? 'HOME' : `${Math.round(p.az)}° / ${Math.round(p.el)}°`),
        h('button', { class: 'btn sm', title: p.home ? 'Run the firmware homing sequence' : 'Slew here now', onclick: () => handlers.parkTo(p) }, p.home ? 'Home' : 'Go'),
        p.name === 'Home' ? h('span', { style: 'width:22px' })
          : h('button', { class: 'btn sm', title: 'Delete preset', onclick: () => store.removeParkPreset(p.name) }, '×'),
      ]));
    }
  }
  store.subscribe(renderParks);
  renderParks();

  const parkGroup = group('Park positions', [
    parkList,
    h('div', { class: 'row', style: 'margin-top:6px' }, [
      parkName,
      h('button', {
        class: 'btn sm', title: 'Save the rotator’s current position under this name',
        onclick: () => { const n = parkName.value.trim(); if (n) { handlers.saveParkPreset(n); parkName.value = ''; } },
      }, 'Save current'),
    ]),
  ]);

  const azOff = numberInput(rot().azOffset, '0.1', (v) => store.patchIn('hw.rotator', { azOffset: v }));
  const elOff = numberInput(rot().elOffset, '0.1', (v) => store.patchIn('hw.rotator', { elOffset: v }));
  const calibGroup = group('Calibration & safety', [
    h('div', { class: 'grid-2' }, [field('Az offset (°)', azOff), field('El offset (°)', elOff)]),
    h('div', { class: 'row' }, [
      h('button', { class: 'btn sm', title: 'Point the mount at true north, then capture', onclick: () => { handlers.captureCalibNorth(); azOff.value = rot().azOffset; } }, 'Set north here'),
      h('button', { class: 'btn sm', title: 'Level the mount at 0° elevation, then capture', onclick: () => { handlers.captureCalibLevel(); elOff.value = rot().elOffset; } }, 'Set level here'),
    ]),
    h('div', { class: 'grid-2', style: 'margin-top:6px' }, [
      field('Az backlash (°)', numberInput(rot().backlashAz, '0.1', (v) => store.patchIn('hw.rotator', { backlashAz: Math.max(0, v) }))),
      field('El backlash (°)', numberInput(rot().backlashEl, '0.1', (v) => store.patchIn('hw.rotator', { backlashEl: Math.max(0, v) }))),
    ]),
    h('p', { class: 'nf-note' }, 'Offsets correct mount misalignment — aim at the reference, then capture. Backlash is compensated on the controller; push settings to apply it.'),
    rule('Sun avoidance'),
    fieldInline('Guard enabled', checkbox(rot().sunAvoid, (v) => store.patchIn('hw.rotator', { sunAvoid: v }))),
    field('Keep-out radius (°)', numberInput(rot().sunAvoidDeg, '0.5', (v) => store.patchIn('hw.rotator', { sunAvoidDeg: Math.max(0, v) }))),
    h('p', { class: 'nf-note' }, 'Warns during a live track and skips a pre-slew that would point the boresight within this angle of the Sun.'),
  ]);

  /* --------------------------------- recorder ----------------------------- */
  const recStats = h('div', { class: 'stat-grid', style: 'grid-template-columns:repeat(3,1fr)' });
  const dl = (name, text, type) => {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const nowStamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const csvBtn = h('button', { class: 'btn sm', onclick: () => dl(`skyphreak-log-${nowStamp()}.csv`, handlers.blackboxCSV(), 'text/csv') }, 'CSV');
  const jsonBtn = h('button', { class: 'btn sm', onclick: () => dl(`skyphreak-log-${nowStamp()}.json`, handlers.blackboxJSON(), 'application/json') }, 'JSON');
  const clrBtn = h('button', { class: 'btn sm', onclick: () => { handlers.blackboxClear(); refreshRec(); } }, 'Clear');
  function fmtDur(ms) {
    const s = Math.round((ms || 0) / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  function refreshRec() {
    const s = handlers.blackboxStats();
    recStats.replaceChildren(
      stat('Samples', String(s.samples)), stat('Events', String(s.events)), stat('Span', fmtDur(s.durationMs)),
      stat('Max error', s.maxErrDeg == null ? '—' : deg(s.maxErrDeg)),
      stat('RMS error', s.rmsErrDeg == null ? '—' : deg(s.rmsErrDeg, 2)),
      stat('State', s.samples ? 'Recording' : 'Idle', s.samples ? 'ok' : 'mute'),
    );
    const empty = !s.samples && !s.events;
    csvBtn.disabled = jsonBtn.disabled = clrBtn.disabled = empty;
  }
  const recGroup = group('Session recorder', [
    recStats,
    h('div', { class: 'row', style: 'margin-top:6px' }, [csvBtn, jsonBtn, clrBtn]),
    h('p', { class: 'nf-note' }, 'Logs commanded against actual pointing, tuning and hardware events while the rotator is connected. Export the pointing log as CSV or the whole session as JSON for post-pass analysis.'),
  ]);
  setInterval(refreshRec, 2000);
  refreshRec();

  /* --------------------------------- assembly ----------------------------- */
  const el = panel({
    toolbar: [
      connectBtn,
      h('button', { class: 'btn sm', title: 'Park to the default preset', onclick: () => handlers.parkRotator() }, 'Park'),
      h('button', { class: 'btn sm danger', title: 'Stop the rotator (Esc)', onclick: () => handlers.stopRotator() }, 'Stop'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', title: 'Create or import a SuperRot hardware profile', onclick: openSuperRotSetup }, 'Setup…'),
    ],
    body: [
      link,
      field('Protocol', protoSel),
      transportRow,
      connFields,
      h('div', { class: 'row', style: 'margin-top:2px' }, [
        h('button', { class: 'btn sm', title: 'Run the homing sequence — seeks the elevation endstop (SuperRot only)', onclick: () => handlers.homeRotator() }, 'Home'),
        h('button', { class: 'btn sm', title: 'Unwind accumulated azimuth turns without changing heading (SuperRot only)', onclick: () => handlers.unwindRotator() }, 'Unwind'),
      ]),
      rule('Auto-track'),
      modeSeg,
      h('div', { class: 'grid-2', style: 'margin-top:6px' }, [
        field('Tracking min el (°)', numberInput(rot().minEl, '1', (v) => store.patchIn('hw.rotator', { minEl: v }))),
        field('Pre-slew lead (s)', numberInput(rot().preslewLead, '5', (v) => store.patchIn('hw.rotator', { preslewLead: Math.max(0, Math.round(v)) }))),
      ]),
      h('p', { class: 'nf-note' }, 'Scheduled mode follows whichever tracked satellite is in a pass. Pre-slew aims at the next rise azimuth this many seconds early; 0 disables it.'),
      tel,
      rule('Manual jog'),
      h('div', { class: 'jog-wrap' }, [jogPad, h('div', {}, [h('span', { class: 'label' }, 'Step'), stepSeg])]),
      motionGroup, parkGroup, calibGroup, recGroup,
    ],
  });

  renderConn();

  return {
    el,
    setLink(on, text) {
      link.querySelector('.dot').className = 'dot' + (on ? ' ok pulse' : ' alert');
      link.querySelector('.hw-link-t').textContent = text;
      connectBtn.textContent = on ? 'Disconnect' : 'Connect';
    },
    setConnectLabel(t) { connectBtn.textContent = t; },
    syncMode() { modeSeg.set(rot().autoMode || 'off'); },
    /** Live target/telemetry readout, fed by main.js each tick. */
    setTelemetry(cells) {
      tel.replaceChildren();
      if (!cells.length) return;
      tel.append(statGrid(cells.map(([l, v, tone]) => stat(l, v, tone)), 2));
    },
  };
}
