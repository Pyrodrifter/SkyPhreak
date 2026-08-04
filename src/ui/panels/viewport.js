/**
 * Viewport panel — hosts the 2D map and the 3D globe plus their tools.
 *
 * This panel's element is created once and only ever re-parented by the dock, so
 * the globe's WebGL context and the map's projection state survive being dragged
 * to a different part of the workspace.
 */

import { store } from '../../core/store.js';
import { h, panel, segment } from '../widgets.js';

export function buildViewport(handlers) {
  const view2d = h('div', { id: 'view-2d', class: 'vp-view' });
  const view3d = h('div', { id: 'view-3d', class: 'vp-view', style: 'display:none' });

  const viewSeg = segment([['2d', 'Map'], ['3d', 'Globe']], store.get().view,
    (v) => store.patch({ view: v }), 'sm');

  const follow = h('button', {
    class: 'btn sm', title: 'Keep the selected target centred in the view',
    onclick: () => store.patch({ followSat: !store.get().followSat }),
  }, 'Follow');

  const styleBtn = h('button', {
    class: 'btn sm', title: 'Switch between vector and shaded-relief basemap',
    onclick: () => {
      const next = store.get().mapStyle === 'vector' ? 'relief' : 'vector';
      store.patch({ mapStyle: next });
      styleBtn.textContent = next === 'vector' ? 'Vector' : 'Relief';
    },
  }, store.get().mapStyle === 'vector' ? 'Vector' : 'Relief');

  /* ---- Time warp: scrub the view forward/back; hardware stays on real time ---- */
  const warpVal = h('span', { class: 'value vp-warp-v' }, 'LIVE');
  const warpSlider = h('input', {
    type: 'range', min: -180, max: 180, step: 1, value: 0, class: 'vp-warp-s',
    oninput: (e) => setWarp(+e.target.value),
  });
  const warpBar = h('div', { class: 'vp-warp', style: 'display:none' }, [
    h('span', { class: 'label' }, 'Preview'),
    warpSlider, warpVal,
    h('button', { class: 'btn sm', title: 'Snap back to real time', onclick: () => setWarp(0) }, 'Live'),
  ]);
  function setWarp(m) {
    warpSlider.value = m;
    handlers.setTimeWarp(m);
    warpVal.textContent = m === 0 ? 'LIVE' : (m > 0 ? '+' : '') + m + ' min';
    warpBar.classList.toggle('on', m !== 0);
    warpBtn.classList.toggle('on', m !== 0);
  }
  const warpBtn = h('button', {
    class: 'btn sm', title: 'Time preview — scrub the view into the future or past',
    onclick: () => {
      const show = warpBar.style.display === 'none';
      warpBar.style.display = show ? '' : 'none';
      if (!show) setWarp(0);
    },
  }, 'Time');

  const hint = h('div', { class: 'vp-hint' }, '');

  /* ---- Emergency stop: always reachable while the rotator is connected ------- */
  const estop = h('button', {
    class: 'vp-estop', title: 'Emergency stop (Esc) — halt the rotator immediately',
    onclick: () => handlers.stopRotator(),
  }, 'STOP');

  const stage = h('div', { class: 'vp-stage' }, [view2d, view3d, warpBar, hint, estop]);

  const el = panel({
    toolbar: [
      viewSeg,
      h('span', { class: 'spacer' }),
      follow, warpBtn, styleBtn,
      h('button', { class: 'btn sm', title: 'Reset the map or globe view', onclick: () => handlers.resetView() }, 'Reset'),
    ],
    body: [stage],
    pad: false,
  });
  el._body.classList.add('flush');

  return {
    el, view2d, view3d,
    setActive(view) {
      viewSeg.set(view);
      view2d.style.display = view === '2d' ? '' : 'none';
      view3d.style.display = view === '3d' ? '' : 'none';
      hint.textContent = view === '2d'
        ? 'Scroll to zoom · drag to pan · click a target to select'
        : 'Drag to rotate · scroll to zoom · click a target to select';
    },
    sync() {
      follow.classList.toggle('on', !!store.get().followSat);
      styleBtn.textContent = store.get().mapStyle === 'vector' ? 'Vector' : 'Relief';
    },
    setRotorConnected(on) { estop.classList.toggle('show', !!on); },
  };
}
