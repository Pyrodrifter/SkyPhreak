/**
 * Shared DOM vocabulary. Panels compose from these instead of hand-rolling markup,
 * which is what keeps the instrument language consistent across seven panels.
 */

/** Tiny hyperscript. `html:` sets innerHTML, `on*` binds a listener. */
export function h(tag, attrs = {}, kids = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(kids)) if (c != null && c !== '') el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

export const frag = (kids) => { const f = document.createDocumentFragment(); for (const k of [].concat(kids)) if (k) f.append(k); return f; };

/* ------------------------------ panel scaffold ---------------------------- */

/**
 * A panel shell: optional fixed toolbar, then a scrolling body. Every dockable
 * panel uses this so scroll behaviour and padding are identical everywhere.
 */
export function panel({ toolbar, body, pad = true } = {}) {
  const scroll = h('div', { class: 'p-body' + (pad ? ' pad' : '') }, body || []);
  const el = h('div', { class: 'p-shell' }, toolbar ? [h('div', { class: 'p-tools' }, toolbar), scroll] : [scroll]);
  el._body = scroll;
  return el;
}

/** A label/value stat cell. `cls` tints the value (ok / warn / alert / live). */
export function stat(label, value = '—', cls = '') {
  const v = h('div', { class: 'value ' + cls }, value);
  const el = h('div', { class: 'stat' }, [h('span', { class: 'label' }, label), v]);
  el.set = (text, tone) => {
    v.textContent = text;
    if (tone !== undefined) v.className = 'value ' + (tone || '');
  };
  return el;
}

/** A big headline stat — the number the operator is actually waiting on. */
export function statBig(label, value = '—', size = 'big') {
  const v = h('div', { class: 'value ' + size }, value);
  const el = h('div', { class: 'stat' }, [h('span', { class: 'label' }, label), v]);
  el.set = (text, tone) => {
    v.textContent = text;
    if (tone !== undefined) v.className = 'value ' + size + (tone ? ' ' + tone : '');
  };
  return el;
}

/** A grid of stat cells. */
export const statGrid = (cells, cols = 2) =>
  h('div', { class: 'stat-grid', style: `grid-template-columns:repeat(${cols},minmax(0,1fr))` }, cells);

/** Uppercase divider with a rule filling the remaining width. */
export const rule = (label) => h('div', { class: 'rule' }, label);

/** Collapsible group. Returns the element; `open` controls the initial state. */
export function group(title, kids, open = false) {
  let on = open;
  const body = h('div', { class: 'group-body', style: on ? '' : 'display:none' }, kids);
  const chev = h('span', { class: 'chev', text: '▶' });
  const head = h('button', {
    class: 'group-head', type: 'button', 'aria-expanded': String(on),
    onclick: () => {
      on = !on;
      body.style.display = on ? '' : 'none';
      head.setAttribute('aria-expanded', String(on));
    },
  }, [chev, h('span', {}, title)]);
  return h('div', { class: 'group' }, [head, body]);
}

/* -------------------------------- controls -------------------------------- */

export function checkbox(checked, onChange) {
  const cb = h('input', { type: 'checkbox', onchange: (e) => onChange(e.target.checked) });
  cb.checked = !!checked;
  return cb;
}

export function numberInput(value, step, onInput, { min, max } = {}) {
  const el = h('input', {
    type: 'number', value, step, min, max,
    oninput: (e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onInput(v); },
  });
  return el;
}

export function textInput(value, onInput, placeholder) {
  return h('input', { type: 'text', value, placeholder, oninput: (e) => onInput(e.target.value) });
}

export function select(options, value, onChange) {
  const el = h('select', { onchange: (e) => onChange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v }, label)));
  el.value = value;
  return el;
}

/** Stacked label over control. */
export const field = (label, control) => h('label', { class: 'field' }, [h('span', { class: 'label' }, label), control]);
/** Label left, control right — for dense settings lists and toggles. */
export const fieldInline = (label, control) => h('label', { class: 'field inline' }, [h('span', { class: 'label' }, label), control]);

/** Segmented control. Returns { el, set } so callers can re-sync from the store. */
export function segment(options, value, onPick, cls = '') {
  const btns = {};
  const el = h('div', { class: 'seg ' + cls }, options.map(([v, label, title]) =>
    (btns[v] = h('button', { type: 'button', title, onclick: () => onPick(v) }, label))));
  const set = (v) => { for (const k of Object.keys(btns)) btns[k].classList.toggle('active', k === String(v)); };
  set(value);
  el.set = set;
  return el;
}

/** Square status dot with an optional label; `set(state, text)` updates it. */
export function statusDot(label) {
  const dot = h('span', { class: 'dot' });
  const txt = h('span', { class: 'sd-t' }, label);
  const el = h('span', { class: 'sd' }, [dot, txt]);
  el.set = (state, text) => {
    dot.className = 'dot' + (state ? ' ' + state : '');
    if (text != null) txt.textContent = text;
  };
  return el;
}

/* --------------------------------- popover -------------------------------- */

/**
 * Anchored popover with outside-click dismissal. Returns { open, close, toggle }.
 * Positioned after mount so it can flip up/left when it would overflow the window.
 */
export function popover(anchor, build, { align = 'left', side = 'bottom' } = {}) {
  let el = null;
  const onDown = (e) => { if (el && !el.contains(e.target) && !anchor.contains(e.target)) close(); };
  function close() {
    if (!el) return;
    el.remove();
    el = null;
    document.removeEventListener('pointerdown', onDown, true);
    anchor.classList.remove('on');
  }
  function open() {
    if (el) return;
    el = h('div', { class: 'pop' }, build(close));
    document.body.append(el);
    anchor.classList.add('on');
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    let left = align === 'right' ? a.right - r.width : a.left;
    left = Math.max(4, Math.min(left, window.innerWidth - r.width - 4));
    let top = side === 'top' ? a.top - r.height - 3 : a.bottom + 3;
    if (top + r.height > window.innerHeight - 4) top = a.top - r.height - 3;
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(Math.max(4, top)) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  }
  return { open, close, toggle: () => (el ? close() : open()), get isOpen() { return !!el; } };
}

/* -------------------------------- formatting ------------------------------- */

/** "1:15:33" / "15:33" — a countdown that keeps its column width. */
export function countdown(ms) {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  const hh = Math.floor(s / 3600);
  return hh > 0 ? `${hh}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

/** Coarser countdown for list rows: "2h 06m" beyond an hour, else "06:12". */
export function countdownShort(ms) {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  const hh = Math.floor(s / 3600);
  return hh > 0 ? `${hh}h ${p(Math.floor((s % 3600) / 60))}m` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

export const duration = (sec) => `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, '0')}s`;

export function tleAge(days) {
  if (days == null || !Number.isFinite(days)) return '—';
  return days < 1 ? `${Math.max(0, Math.round(days * 24))}h` : `${days.toFixed(1)}d`;
}

export const compass = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((az % 360) + 360) % 360 / 45) % 8];

export const deg = (v, dp = 1) => (Number.isFinite(v) ? v.toFixed(dp) + '°' : '—');

export const hhmm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const hhmmss = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const dayShort = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
