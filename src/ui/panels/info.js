/**
 * Info panel — everything about the currently selected target.
 *
 * Rebuilt every second from main.js, so it keeps no interactive state beyond the
 * EME frequency box (which is re-created with its value each tick; the store is
 * the source of truth and typing into it patches the store immediately).
 */

import { store } from '../../core/store.js';
import { h, panel, stat, statGrid, rule, numberInput, deg } from '../widgets.js';
import { tleAge } from '../widgets.js';

export function buildInfo(handlers) {
  const body = h('div', { class: 'nf' });
  const wx = h('div', { class: 'nf-wx' }, [h('span', { class: 'label' }, 'Space wx'), h('span', { class: 'value mute' }, 'Kp —')]);
  const el = panel({ body: [body, wx] });

  /** Big AZ / EL pair — the two numbers you point the mount at. */
  function pointing(az, elv, up, status) {
    return h('div', { class: 'nf-point' + (up ? ' up' : '') }, [
      h('div', { class: 'nf-point-c' }, [h('span', { class: 'label' }, 'Azimuth'), h('span', { class: 'value hero' }, az)]),
      h('div', { class: 'nf-point-c' }, [h('span', { class: 'label' }, 'Elevation'), h('span', { class: 'value hero ' + (up ? 'ok' : 'mute') }, elv)]),
      status ? h('div', { class: 'nf-status' }, status) : '',
    ]);
  }

  function head(name, sub, up) {
    return h('div', { class: 'nf-head' }, [
      h('div', { class: 'nf-head-t' }, [
        h('div', { class: 'nf-name' }, name),
        h('div', { class: 'cell-sub' }, sub),
      ]),
      h('span', { class: 'chip ' + (up ? 'ok' : '') }, up ? 'ABOVE HORIZON' : 'BELOW HORIZON'),
    ]);
  }

  function moonBlock(moon) {
    const up = moon.look.el >= 0;
    return [
      rule('Moon'),
      statGrid([
        stat('Azimuth', deg(moon.look.az)),
        stat('Elevation', deg(moon.look.el), up ? 'ok' : 'mute'),
        stat('Distance', Math.round(moon.distanceKm).toLocaleString() + ' km'),
        stat('Illumination', Math.round(moon.illum * 100) + '%'),
        stat('Phase', moon.phaseName),
      ], 2),
    ];
  }

  function emeBlock(eme) {
    const freq = numberInput(eme.freqMHz, '1', (v) => handlers.setEmeFreq(v));
    const d = eme.dopplerHz;
    return [
      rule('EME · Moon-bounce'),
      h('label', { class: 'field inline' }, [h('span', { class: 'label' }, 'Frequency (MHz)'), freq]),
      statGrid([
        stat('Path loss · echo', eme.echoPathLoss.toFixed(1) + ' dB'),
        stat('Path loss · 1-way', eme.fsplOneWay.toFixed(1) + ' dB'),
        stat('Echo Doppler', `${d >= 0 ? '+' : '−'}${Math.abs(d / 1000).toFixed(2)} kHz`),
        stat('Declination', deg(eme.declination)),
        stat('Degradation', '+' + eme.degradationDb.toFixed(1) + ' dB'),
        stat('Range', Math.round(eme.rangeKm).toLocaleString() + ' km'),
      ], 2),
      h('p', { class: 'nf-note' }, 'Free-space path loss and self-echo Doppler for the current Moon geometry. Degradation is the extra two-way loss against perigee; sky noise and libration are not modelled.'),
    ];
  }

  return {
    el,
    /** `info` = satellite, `selBody` = Moon/Sun/planet/DSO. One or neither. */
    update(info, moon, selBody) {
      body.replaceChildren();

      if (selBody) {
        const up = selBody.el >= 0;
        const kind = selBody.kind === 'dso' ? 'Deep-sky object' : selBody.kind === 'moon' ? 'Lunar target' : 'Solar-system target';
        body.append(
          head(selBody.name, kind, up),
          pointing(deg(selBody.az), deg(selBody.el), up),
          statGrid(selBody.extra.map(([a, b]) => stat(a, b)), 2),
        );
        if (selBody.eme) body.append(...emeBlock(selBody.eme));
        if (moon && selBody.kind !== 'moon') body.append(...moonBlock(moon));
        return;
      }

      if (!info) {
        body.append(h('div', { class: 'empty' }, 'Select a satellite, planet, the Moon, or a deep-sky object'));
        if (moon) body.append(...moonBlock(moon));
        return;
      }

      const up = info.aboveHorizon;
      const rf = store.get().hw.radio;
      body.append(
        head(info.name, 'NORAD ' + info.noradId, up),
        pointing(up ? deg(info.az) : '—', up ? deg(info.el) : '—', up, info.statusText),
        statGrid([
          stat('Range', info.rangeKm ? Math.round(info.rangeKm).toLocaleString() + ' km' : '—'),
          stat('Altitude', Math.round(info.altKm).toLocaleString() + ' km'),
          stat('Velocity', info.velocityKmS.toFixed(2) + ' km/s'),
          stat('Element age', tleAge(info.tleAgeDays), info.tleStale ? 'warn' : ''),
          stat('Doppler', `${info.dopplerHz >= 0 ? '+' : '−'}${Math.abs(info.dopplerHz / 1000).toFixed(2)} kHz`),
          stat('Downlink', (rf.downlinkHz / 1e6).toFixed(3) + ' MHz'),
        ], 2),
        rule('Sub-satellite point'),
        statGrid([
          stat('Latitude', info.lat.toFixed(3) + '°'),
          stat('Longitude', info.lon.toFixed(3) + '°'),
          stat('Observed', (info.observedHz / 1e6).toFixed(5) + ' MHz'),
        ], 3),
      );
      if (moon) body.append(...moonBlock(moon));
    },

    setSpaceWeather(w) {
      const v = wx.querySelector('.value');
      if (!w || !w.ok || !Number.isFinite(w.kp)) { v.textContent = 'Kp — offline'; v.className = 'value mute'; return; }
      const level = w.kp >= 5 ? 'alert' : w.kp >= 4 ? 'warn' : 'ok';
      const label = w.kp >= 5 ? 'Storm' : w.kp >= 4 ? 'Active' : 'Quiet';
      v.textContent = `Kp ${w.kp.toFixed(1)} · ${label}`;
      v.className = 'value ' + level;
      wx.title = 'NOAA planetary K-index — geomagnetic activity'
        + (w.time ? ` · observed ${new Date(w.time + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '');
    },
  };
}

/**
 * Sky panel — the live polar/radar plot. main.js mounts PolarView into `host`, so
 * this panel is only the frame. It was previously buried at the bottom of the Info
 * tab (where a mounting bug meant it never rendered at all); as its own dockable
 * panel it can sit beside the map full-height.
 */
export function buildSky() {
  const host = h('div', { class: 'sky-host' });
  const el = panel({ body: [host], pad: false });
  el._body.classList.add('flush');
  return { el, host };
}
