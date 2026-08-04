/**
 * Dock engine — a tiling workspace of splits and tabbed docks.
 *
 * Layout is a plain-JSON tree, so it serialises straight into settings and into
 * named workspace presets:
 *
 *   split: { t:'split', dir:'row'|'col', sizes:[.25,.75], kids:[node, node] }
 *   dock:  { t:'dock', tabs:['targets','passes'], active:'targets' }
 *
 * The one rule that shapes the implementation: PANEL ELEMENTS ARE BUILT ONCE AND
 * RE-PARENTED, never rebuilt. The viewport panel owns a WebGL globe and a 2D map
 * canvas — re-creating those on every layout change would drop the GL context and
 * flush the map's tile state. So `render()` is free to throw away and rebuild all
 * the *chrome* (splits, sizers, tab strips) on any change, because the expensive
 * part is only ever moved with appendChild.
 */

const h = (tag, attrs = {}, kids = []) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};

const MIN_PX = 130;      // a pane may not be dragged below this
const EDGE_FRAC = 0.24;  // how much of a dock's body counts as a split-drop edge

export class Dock {
  /**
   * @param root  element the workspace fills
   * @param panels  { id: { title, el, closable } } — `el` is built by the caller
   * @param onChange  called whenever the layout changes (for persistence)
   */
  constructor(root, panels, onChange) {
    this.root = root;
    this.panels = panels;
    this.onChange = onChange || (() => {});
    this.layout = null;
    this.root.classList.add('dk-root');
  }

  setLayout(layout) {
    this.layout = prune(clone(layout)) || singleDock(Object.keys(this.panels)[0]);
    this.render();
  }

  getLayout() { return clone(this.layout); }

  /** Panel ids currently placed somewhere in the tree. */
  openIds() {
    const out = [];
    walk(this.layout, (n) => { if (n.t === 'dock') out.push(...n.tabs); });
    return out;
  }

  /** Reveal a panel: focus it if already open, else add it to the biggest dock. */
  reveal(id) {
    let host = null;
    walk(this.layout, (n) => { if (n.t === 'dock' && n.tabs.includes(id)) host = n; });
    if (host) { host.active = id; this.render(); this.onChange(); return; }
    const docks = [];
    walk(this.layout, (n) => { if (n.t === 'dock') docks.push(n); });
    const target = docks.map((d) => ({ d, w: (this._rects.get(d) || { width: 0 }).width }))
      .sort((a, b) => b.w - a.w)[0];
    const dock = target ? target.d : docks[0];
    if (!dock) return;
    dock.tabs.push(id);
    dock.active = id;
    this.render();
    this.onChange();
  }

  close(id) {
    walk(this.layout, (n) => {
      if (n.t !== 'dock') return;
      const i = n.tabs.indexOf(id);
      if (i < 0) return;
      n.tabs.splice(i, 1);
      if (n.active === id) n.active = n.tabs[Math.min(i, n.tabs.length - 1)] || null;
    });
    this.layout = prune(this.layout) || singleDock(id);
    this.render();
    this.onChange();
  }

  /* ------------------------------- rendering ------------------------------ */

  render() {
    // Detach every live panel first so replaceChildren() below can't destroy one.
    for (const p of Object.values(this.panels)) if (p.el.parentNode) p.el.remove();
    this._rects = new Map();
    this._els = [];
    this.root.replaceChildren(this._node(this.layout));
    // Cache dock geometry after layout so reveal() can pick the biggest one.
    requestAnimationFrame(() => {
      for (const [node, el] of this._els) this._rects.set(node, el.getBoundingClientRect());
    });
  }

  _node(node) {
    return node.t === 'split' ? this._split(node) : this._dock(node);
  }

  _split(node) {
    // Direction classes are namespaced (dk-row / dk-col): a bare `row` class would
    // collide with the generic .row flex utility and inherit align-items:center,
    // which collapses every pane to its content height.
    const el = h('div', { class: 'dk-split dk-' + node.dir });
    node.kids.forEach((kid, i) => {
      const pane = h('div', { class: 'dk-pane' }, [this._node(kid)]);
      pane.style.flex = `${node.sizes[i]} 1 0`;
      el.append(pane);
      if (i < node.kids.length - 1) el.append(this._sizer(node, i, el));
    });
    return el;
  }

  _sizer(node, i, splitEl) {
    const row = node.dir === 'row';
    const sizer = h('div', { class: 'dk-sizer dk-' + node.dir, role: 'separator' });
    sizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sizer.setPointerCapture(e.pointerId);
      sizer.classList.add('drag');
      const panes = [...splitEl.children].filter((c) => c.classList.contains('dk-pane'));
      const a = panes[i].getBoundingClientRect();
      const b = panes[i + 1].getBoundingClientRect();
      const total = row ? a.width + b.width : a.height + b.height;
      const start = row ? e.clientX : e.clientY;
      const sum = node.sizes[i] + node.sizes[i + 1];
      const move = (ev) => {
        const d = (row ? ev.clientX : ev.clientY) - start;
        const aPx = clamp((row ? a.width : a.height) + d, MIN_PX, total - MIN_PX);
        node.sizes[i] = sum * (aPx / total);
        node.sizes[i + 1] = sum - node.sizes[i];
        panes[i].style.flex = `${node.sizes[i]} 1 0`;
        panes[i + 1].style.flex = `${node.sizes[i + 1]} 1 0`;
      };
      const up = () => {
        sizer.classList.remove('drag');
        sizer.removeEventListener('pointermove', move);
        sizer.removeEventListener('pointerup', up);
        this.onChange();
      };
      sizer.addEventListener('pointermove', move);
      sizer.addEventListener('pointerup', up);
    });
    return sizer;
  }

  _dock(node) {
    if (!node.tabs.length) return h('div', { class: 'dk-dock' });
    if (!node.tabs.includes(node.active)) node.active = node.tabs[0];

    const strip = h('div', { class: 'dk-tabs' });
    for (const id of node.tabs) {
      const p = this.panels[id];
      if (!p) continue;
      const active = id === node.active;
      const tab = h('button', {
        class: 'dk-tab' + (active ? ' active' : ''),
        type: 'button', 'data-panel': id, title: p.title,
        onclick: () => { if (node.active !== id) { node.active = id; this.render(); this.onChange(); } },
      }, [h('span', { class: 'dk-tab-t', text: p.title })]);
      if (p.closable !== false) {
        tab.append(h('span', {
          class: 'dk-tab-x', title: 'Close panel', text: '×',
          onclick: (e) => { e.stopPropagation(); this.close(id); },
        }));
      }
      tab.addEventListener('pointerdown', (e) => this._beginDrag(e, id, tab));
      strip.append(tab);
    }

    const body = h('div', { class: 'dk-body' });
    const panel = this.panels[node.active];
    if (panel) body.append(panel.el);

    const el = h('div', { class: 'dk-dock' }, [strip, body]);
    el._dockNode = node;
    this._els.push([node, el]);
    return el;
  }

  /* -------------------------------- dragging ------------------------------ */

  _beginDrag(e, id, tab) {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let ghost = null, indicator = null, drop = null;

    const start = () => {
      tab.classList.add('dragging');
      ghost = h('div', { class: 'dk-ghost', text: this.panels[id].title });
      indicator = h('div', { class: 'dk-drop' });
      document.body.append(ghost, indicator);
      document.body.classList.add('dk-dragging');
    };

    const move = (ev) => {
      if (!ghost) {
        if (Math.abs(ev.clientX - sx) < 5 && Math.abs(ev.clientY - sy) < 5) return;
        start();
      }
      ghost.style.transform = `translate(${ev.clientX + 10}px, ${ev.clientY + 12}px)`;
      drop = this._hitTest(ev.clientX, ev.clientY);
      paintIndicator(indicator, drop);
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      tab.classList.remove('dragging');
      document.body.classList.remove('dk-dragging');
      if (ghost) ghost.remove();
      if (indicator) indicator.remove();
      if (ghost && drop) this._applyDrop(id, drop);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Resolve a screen point to { node, zone, rect, index }. */
  _hitTest(x, y) {
    const el = document.elementFromPoint(x, y);
    const dockEl = el && el.closest('.dk-dock');
    if (!dockEl || !dockEl._dockNode) return null;
    const node = dockEl._dockNode;
    const strip = dockEl.querySelector('.dk-tabs');
    const sr = strip.getBoundingClientRect();
    if (y <= sr.bottom) {
      // Over the tab strip: insert before the first tab whose midpoint is right of x.
      const tabs = [...strip.querySelectorAll('.dk-tab')];
      let index = tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const r = tabs[i].getBoundingClientRect();
        if (x < r.left + r.width / 2) { index = i; break; }
      }
      // Caret sits before the target tab, or after the last one when appending.
      let caret = sr.left;
      if (tabs[index]) caret = tabs[index].getBoundingClientRect().left;
      else if (tabs.length) caret = tabs[tabs.length - 1].getBoundingClientRect().right;
      return { node, zone: 'tabs', index, rect: { left: caret, top: sr.top, width: 2, height: sr.height } };
    }
    const br = dockEl.querySelector('.dk-body').getBoundingClientRect();
    const fx = (x - br.left) / br.width;
    const fy = (y - br.top) / br.height;
    // Nearest edge wins, but only inside the edge band; the middle is a plain move.
    const near = Math.min(fx, 1 - fx, fy, 1 - fy);
    let zone = 'center';
    if (near < EDGE_FRAC) {
      zone = near === fx ? 'left' : near === 1 - fx ? 'right' : near === fy ? 'top' : 'bottom';
    }
    const half = (r, side) => ({
      left: side === 'right' ? r.left + r.width / 2 : r.left,
      top: side === 'bottom' ? r.top + r.height / 2 : r.top,
      width: side === 'left' || side === 'right' ? r.width / 2 : r.width,
      height: side === 'top' || side === 'bottom' ? r.height / 2 : r.height,
    });
    return { node, zone, rect: zone === 'center' ? br : half(br, zone) };
  }

  _applyDrop(id, drop) {
    const { node, zone } = drop;
    const from = this._dockOf(id);
    // A no-op move: dropping a lone tab back into its own dock's body.
    if (from === node && zone === 'center' && from.tabs.length === 1) return;

    // Detach first so index maths below sees the final tab list.
    if (from) {
      const i = from.tabs.indexOf(id);
      from.tabs.splice(i, 1);
      if (from.active === id) from.active = from.tabs[Math.min(i, from.tabs.length - 1)] || null;
    }

    if (zone === 'center' || zone === 'tabs') {
      const at = zone === 'tabs' ? Math.min(drop.index, node.tabs.length) : node.tabs.length;
      node.tabs.splice(at, 0, id);
      node.active = id;
    } else {
      // Split: replace `node` in the tree with a split holding it and a new dock.
      const fresh = { t: 'dock', tabs: [id], active: id };
      const dir = zone === 'left' || zone === 'right' ? 'row' : 'col';
      const before = zone === 'left' || zone === 'top';
      const moved = { t: 'dock', tabs: node.tabs.slice(), active: node.active };
      const kids = before ? [fresh, moved] : [moved, fresh];
      // Mutate `node` in place into the split so we never have to find its parent.
      delete node.tabs; delete node.active;
      node.t = 'split';
      node.dir = dir;
      node.sizes = [0.5, 0.5];
      node.kids = kids;
    }

    this.layout = prune(this.layout) || singleDock(id);
    this.render();
    this.onChange();
  }

  _dockOf(id) {
    let found = null;
    walk(this.layout, (n) => { if (n.t === 'dock' && n.tabs.includes(id)) found = n; });
    return found;
  }
}

/* --------------------------------- helpers -------------------------------- */

function paintIndicator(el, drop) {
  if (!drop) { el.style.display = 'none'; return; }
  const r = drop.rect;
  el.style.display = '';
  el.classList.toggle('thin', drop.zone === 'tabs');
  el.style.left = r.left + 'px';
  el.style.top = r.top + 'px';
  el.style.width = r.width + 'px';
  el.style.height = r.height + 'px';
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clone = (o) => JSON.parse(JSON.stringify(o));
const singleDock = (id) => ({ t: 'dock', tabs: id ? [id] : [], active: id || null });

function walk(node, fn) {
  if (!node) return;
  fn(node);
  if (node.t === 'split') for (const k of node.kids) walk(k, fn);
}

/**
 * Drop empty docks and collapse splits that no longer branch. Runs bottom-up so a
 * split whose children all vanish disappears with them. Returns null if nothing is
 * left, which the callers turn back into a single empty dock.
 */
function prune(node) {
  if (!node) return null;
  if (node.t === 'dock') return node.tabs && node.tabs.length ? node : null;
  // Single pass — prune() mutates, so a child must not be visited twice.
  const kept = [];
  node.kids.forEach((kid, i) => {
    const p = prune(kid);
    if (p) kept.push({ node: p, size: node.sizes[i] ?? 1 / node.kids.length });
  });
  if (!kept.length) return null;
  if (kept.length === 1) return kept[0].node; // a split with one child is just the child
  // Keep the survivors' relative proportions, renormalised to 1.
  const total = kept.reduce((a, b) => a + b.size, 0) || 1;
  node.kids = kept.map((k) => k.node);
  node.sizes = kept.map((k) => k.size / total);
  return node;
}
