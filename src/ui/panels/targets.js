/**
 * Targets panel — the satellite/sky browser.
 *
 * One list driven by a scope segment (All / Tracked / Favs / Sky) plus a search
 * box, rendered as a data table rather than a stack of cards. The catalog source
 * controls only appear under All, where they mean something.
 */

import { store } from '../../core/store.js';
import { DSOS } from '../../core/dso.js';
import { h, panel, segment, checkbox, popover, deg } from '../widgets.js';
import { colorFor, SWATCHES } from '../colors.js';

const SKY_BODIES = [
  ['MOON', 'Moon', '#e6eaf2', '☾'], ['SUN', 'Sun', '#ffd23f', '☉'],
  ['MERCURY', 'Mercury', '#b0a08c', '☿'], ['VENUS', 'Venus', '#e8e3d0', '♀'],
  ['MARS', 'Mars', '#d9603b', '♂'], ['JUPITER', 'Jupiter', '#d8b48c', '♃'],
  ['SATURN', 'Saturn', '#e3d9a8', '♄'], ['URANUS', 'Uranus', '#9fe0e6', '♅'],
  ['NEPTUNE', 'Neptune', '#5b7cdf', '♆'],
];

const GROUPS = [
  ['active', 'Active satellites'], ['stations', 'Space stations'], ['amateur', 'Amateur radio'],
  ['weather', 'Weather'], ['noaa', 'NOAA'], ['goes', 'GOES'], ['starlink', 'Starlink'],
  ['gps-ops', 'GPS'], ['visual', 'Brightest / visual'],
];

export function buildTargets(handlers) {
  let scope = 'all';
  let term = '';
  let shownIds = [];
  let staleIds = new Set();
  let skyEl = {};        // { id: elevation° } — live, only while the Sky scope is up
  let solarOpen = true;
  let dsoOpen = false;

  /* -------------------------------- toolbar ------------------------------- */
  const search = h('input', {
    type: 'search', placeholder: 'Search name or NORAD id…',
    oninput: (e) => { term = e.target.value.trim().toLowerCase(); render(); },
  });
  const scopeSeg = segment(
    [['all', 'All'], ['tracked', 'Tracked'], ['favs', 'Favs'], ['sky', 'Sky']],
    scope, (v) => { scope = v; syncScope(); render(); }, 'sm');

  const groupSel = h('select', { onchange: (e) => { store.patch({ group: e.target.value }); handlers.refreshTLE(); } },
    GROUPS.map(([v, l]) => h('option', { value: v }, l)));
  groupSel.value = store.get().group;

  const tlePaste = h('textarea', { rows: 4, placeholder: 'Paste TLE — name line + 2 element lines…', style: 'display:none;margin-top:6px' });
  const pasteAdd = h('button', { class: 'btn sm', style: 'display:none;margin-top:4px', onclick: () => {
    if (handlers.addManualTle(tlePaste.value)) { tlePaste.value = ''; togglePaste(false); }
  } }, 'Add pasted elements');
  const togglePaste = (show) => {
    tlePaste.style.display = show ? '' : 'none';
    pasteAdd.style.display = show ? '' : 'none';
    if (show) tlePaste.focus();
  };

  const stamp = h('div', { class: 'tg-stamp' }, '');
  // The group picker gets its own line — with the three source buttons alongside it
  // the row cannot fit a narrow Targets dock without clipping the first label.
  const source = h('div', { class: 'tg-source' }, [
    groupSel,
    h('div', { class: 'row wrap', style: 'margin-top:6px' }, [
      h('button', { class: 'btn sm', title: 'Re-download this group from Celestrak', onclick: () => handlers.refreshTLE() }, 'Refresh'),
      h('button', { class: 'btn sm', title: 'Load a CCSDS OEM ephemeris file', onclick: () => handlers.loadOem() }, 'OEM…'),
      h('button', { class: 'btn sm', title: 'Paste a 2/3-line element set manually', onclick: () => togglePaste(tlePaste.style.display === 'none') }, 'Paste'),
    ]),
    tlePaste, pasteAdd, stamp,
  ]);

  /* ---------------------------------- list -------------------------------- */
  const count = h('span', { class: 'label' }, '');
  const bulk = h('div', { class: 'tg-bulk' }, [
    count,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', title: 'Track every satellite shown', onclick: bulkTrack }, 'Track all'),
    h('button', { class: 'btn sm', title: 'Untrack every satellite shown', onclick: () => shownIds.length && store.untrackMany(shownIds) }, 'None'),
  ]);
  const list = h('div', { class: 'tg-list' });

  const el = panel({ toolbar: [search], body: [scopeSeg, source, bulk, list], pad: false });
  el._body.classList.add('tg-scroll');
  // Toolbar holds only the search; the scope segment and source block live in the
  // scroll body's sticky header so a long list keeps maximum room.
  el.querySelector('.p-tools').classList.add('tg-toolbar');

  function syncScope() {
    scopeSeg.set(scope);
    source.style.display = scope === 'all' ? '' : 'none';
    bulk.style.display = scope === 'sky' ? 'none' : '';
  }

  function satLike(id) {
    const c = store.getCatalog().find((s) => s.noradId === id);
    if (c) return c;
    const f = store.get().favorites.find((x) => x.id === id);
    if (f) return { noradId: f.id, name: f.name, line1: f.line1, line2: f.line2 };
    const t = (store.get().tleStore || {})[id];
    return t ? { noradId: id, name: t.name, line1: t.line1, line2: t.line2 } : null;
  }

  function bulkTrack() {
    if (!shownIds.length) return;
    if (shownIds.length > 60 && !confirm(`Track all ${shownIds.length} shown satellites? Tracking a lot at once slows the pass solver.`)) return;
    store.trackMany(shownIds.map((id) => {
      const s = satLike(id);
      return { id, name: s && s.name, line1: s && s.line1, line2: s && s.line2 };
    }));
  }

  /* ------------------------------ colour picker --------------------------- */
  function pickColour(id, anchor) {
    const cur = store.get().satColors[id];
    popover(anchor, (close) => [
      h('div', { class: 'pop-title' }, 'Track colour'),
      h('div', { class: 'sw-grid' }, SWATCHES.map((c) => h('button', {
        class: 'sw' + (c.toLowerCase() === (cur || '').toLowerCase() ? ' sel' : ''),
        style: `background:${c}`, title: c,
        onclick: () => { store.setSatColor(id, c); close(); },
      }))),
      h('div', { class: 'row', style: 'margin-top:8px' }, [
        h('input', { type: 'color', value: cur || colorFor(id, store.get().tracked), oninput: (e) => store.setSatColor(id, e.target.value) }),
        h('button', { class: 'btn sm', onclick: () => { store.clearSatColor(id); close(); } }, 'Auto'),
      ]),
    ]).open();
  }

  /* -------------------------------- rendering ----------------------------- */
  function satRow(id, name, tracked, fav, selected) {
    const cb = checkbox(tracked, () => store.toggleTracked(id, satLike(id)));
    cb.title = 'Track';
    cb.addEventListener('click', (e) => e.stopPropagation());
    const swatch = tracked
      ? h('button', {
          class: 'tg-dot', style: `background:${colorFor(id, store.get().tracked)}`, title: 'Change track colour',
          onclick: (e) => { e.stopPropagation(); pickColour(id, e.currentTarget); },
        })
      : h('span', { class: 'tg-dot off' });
    const star = h('button', {
      class: 'tg-star' + (fav ? ' on' : ''), title: fav ? 'Remove favourite' : 'Add favourite',
      onclick: (e) => { e.stopPropagation(); const s = satLike(id); if (s) store.toggleFavorite(s); },
    }, fav ? '★' : '☆');
    return h('div', {
      class: 'tg-row' + (selected ? ' sel' : ''),
      onclick: () => store.patch({ selected: id }),
    }, [
      cb, swatch,
      h('span', { class: 'tg-name' }, name),
      staleIds.has(id) ? h('span', { class: 'chip warn', title: 'Elements older than the max age — update when online' }, 'OLD')
        : h('span', { class: 'tg-id num' }, id),
      star,
    ]);
  }

  function bodyRow(id, name, colour, glyph, sub, selected) {
    const e = skyEl[id];
    const has = Number.isFinite(e);
    const up = has && e >= 0;
    return h('div', {
      class: 'tg-row tg-sky' + (selected ? ' sel' : ''),
      onclick: () => store.patch({ selected: id }),
    }, [
      h('span', { class: 'tg-glyph', style: `color:${colour}` }, glyph),
      h('span', { class: 'tg-name' }, name),
      sub ? h('span', { class: 'tg-sub' }, sub) : h('span', { class: 'spacer' }),
      h('span', { class: 'tg-el num' + (has ? (up ? ' up' : ' down') : '') }, has ? (up ? deg(e, 0) : '↓') : ''),
    ]);
  }

  function subhead(open, label, onToggle, extra) {
    return h('div', { class: 'tg-sub-head' }, [
      h('button', { class: 'tg-disc', onclick: onToggle }, [h('span', { class: 'chev', text: open ? '▼' : '▶' }), label]),
      extra || h('span', {}),
    ]);
  }

  function renderSky() {
    const st = store.get();
    const q = term;
    const solar = SKY_BODIES.filter(([, n]) => !q || n.toLowerCase().includes(q));
    const dsos = DSOS.filter((d) => !q || d.name.toLowerCase().includes(q) || String(d.id).toLowerCase().includes(q));

    list.append(subhead(solarOpen, `Solar system${q ? ` · ${solar.length}` : ''}`, () => { solarOpen = !solarOpen; render(); },
      h('div', { class: 'row' }, [
        h('label', { class: 'tg-chk', title: 'Draw the Moon on the map' }, [checkbox(st.showMoon, (v) => store.patch({ showMoon: v })), 'Moon']),
        h('label', { class: 'tg-chk', title: 'Draw the Sun and planets on the map' }, [checkbox(st.showPlanets, (v) => store.patch({ showPlanets: v })), 'Planets']),
      ])));
    if (solarOpen || q) for (const [id, name, colour, glyph] of solar) list.append(bodyRow(id, name, colour, glyph, '', st.selected === id));

    list.append(subhead(dsoOpen, `Deep sky${q ? ` · ${dsos.length}` : ''}`, () => { dsoOpen = !dsoOpen; render(); },
      h('label', { class: 'tg-chk', title: 'Overlay all deep-sky objects on the map' }, [checkbox(st.showDso, (v) => store.patch({ showDso: v })), 'On map'])));
    if (dsoOpen || q) for (const d of dsos) {
      const id = 'DSO:' + d.id;
      const type = d.type.replace(/ nebula/i, ' Neb').replace(/ cluster/i, ' Cl').replace(/ galaxy/i, ' Gal');
      list.append(bodyRow(id, d.name, '#c792ea', '✦', (d.mag != null ? `m${d.mag} · ` : '') + type, st.selected === id));
    }
    if (q && !solar.length && !dsos.length) list.append(h('div', { class: 'empty' }, 'No sky objects match'));
  }

  function render() {
    const st = store.get();
    const keep = el._body.scrollTop;
    list.replaceChildren();

    if (scope === 'sky') { shownIds = []; renderSky(); el._body.scrollTop = keep; return; }

    const tracked = new Set(st.tracked);
    const favs = new Set(st.favorites.map((f) => f.id));
    let entries;
    let emptyMsg;
    if (scope === 'tracked') {
      entries = st.tracked.map((id) => ({ id, s: satLike(id) }));
      emptyMsg = 'Nothing tracked — tick a satellite under All';
    } else if (scope === 'favs') {
      entries = st.favorites.map((f) => ({ id: f.id, s: { name: f.name } }));
      emptyMsg = 'Star a satellite to keep it here';
    } else {
      const cat = store.getCatalog();
      entries = cat.map((s) => ({ id: s.noradId, s }));
      emptyMsg = cat.length ? 'No matches' : 'Loading catalog…';
    }
    if (term) entries = entries.filter(({ id, s }) => ((s && s.name) || '').toLowerCase().includes(term) || id.includes(term));
    // The full active catalog runs to thousands; the search box is the way in.
    if (scope === 'all') entries = entries.slice(0, 300);

    shownIds = entries.map((e) => e.id);
    count.textContent = `${entries.length} shown · ${entries.filter((e) => tracked.has(e.id)).length} tracked`;

    if (!entries.length) { list.append(h('div', { class: 'empty' }, emptyMsg)); return; }
    for (const { id, s } of entries) {
      list.append(satRow(id, s ? s.name : 'NORAD ' + id, tracked.has(id), favs.has(id), st.selected === id));
    }
    el._body.scrollTop = keep;
  }

  syncScope();

  return {
    el,
    render,
    setStamp: (t) => { stamp.textContent = t; },
    setStale: (set) => {
      if (set.size === staleIds.size && [...set].every((id) => staleIds.has(id))) return;
      staleIds = set;
      render();
    },
    setSky: (map) => { skyEl = map || {}; if (scope === 'sky') render(); },
    isSkyActive: () => scope === 'sky',
    syncGroup: () => { groupSel.value = store.get().group; },
  };
}
