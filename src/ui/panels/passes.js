/**
 * Passes panel — the merged pass list across every tracked satellite, a NOW/NEXT
 * lead block, and a chronological timeline view.
 *
 * Two things this panel must get right:
 *   - A pass that has already set is dropped on render. The list behind it is only
 *     recomputed every 15 minutes, and a negative countdown formats as 00:00 —
 *     a finished pass would otherwise sit at the top looking live.
 *   - The list is rebuilt every second, so rows carry no transitions and the
 *     scroll position is preserved across rebuilds.
 */

import { store } from '../../core/store.js';
import { buildTimeline } from '../../core/timeline.js';
import { scoreBreakdown } from '../../core/passScore.js';
import { analyzeSchedule } from '../../core/scheduler.js';
import { h, panel, segment, countdown, countdownShort, duration, compass, deg, hhmm, hhmmss, dayShort } from '../widgets.js';
import { drawSkyTrack } from '../skytrack.js';

export function buildPasses(handlers) {
  let view = 'list';
  let items = [];      // raw (may contain finished passes)
  let readiness = null;
  let readyOpen = false;

  const viewSeg = segment([['list', 'Passes'], ['timeline', 'Timeline']], view, (v) => { view = v; syncTools(); render(Date.now()); }, 'sm');
  const sortSeg = segment(
    [['time', 'Soonest', 'Soonest first'], ['el', 'Highest', 'Highest peak first'], ['best', 'Best', 'Best overall quality first']],
    store.get().passSort || 'time', (v) => { store.patch({ passSort: v }); render(Date.now()); }, 'sm');
  const icsBtn = h('button', { class: 'btn sm', title: 'Export the upcoming passes as an .ics calendar', onclick: () => exportICS() }, 'ICS');
  const sortWrap = h('div', { class: 'row' }, [sortSeg, icsBtn]);
  function syncTools() { sortWrap.style.display = view === 'timeline' ? 'none' : ''; }

  const body = h('div', { class: 'pz' });
  const el = panel({ toolbar: [viewSeg, h('span', { class: 'spacer' }), sortWrap], body: [body], pad: false });
  syncTools();

  /* ------------------------------- lead block ----------------------------- */
  // The pass the operator is actually waiting on, with its sky track. Readiness
  // rides in this block's header as a chip rather than as a second banner.
  function leadBlock(it, now) {
    const p = it.pass;
    const aos = p.aos.getTime();
    const los = p.los.getTime();
    const live = now >= aos && now <= los;
    const canvas = h('canvas', { class: 'pz-track', title: 'Sky track — north up, horizon at the rim' });

    const chip = readiness && readiness.passId === it.id ? readinessChip() : '';
    const cell = (label, value, cls) => h('div', { class: 'stat' }, [
      h('span', { class: 'label' }, label), h('span', { class: 'value ' + (cls || '') }, value),
    ]);

    // Progress rail: during a pass it fills AOS→LOS; before one it fills over the
    // last hour of the wait, so a glance tells you how close you are without
    // reading the clock. Genuinely useful, and it gives the card a live edge.
    const frac = live
      ? (now - aos) / Math.max(1, los - aos)
      : 1 - Math.min(1, Math.max(0, (aos - now) / 3600000));
    const rail = h('div', { class: 'pz-rail' + (live ? ' live' : '') }, [
      h('i', { style: `width:${(frac * 100).toFixed(2)}%` }),
    ]);

    const block = h('div', { class: 'pz-lead' + (live ? ' live' : '') }, [
      h('div', { class: 'pz-lead-top' }, [
        h('span', { class: 'label' }, live ? 'Active pass' : 'Next pass'),
        h('span', { class: 'spacer' }),
        chip,
        h('span', { class: 'chip' + (live ? ' live' : '') }, [h('span', { class: 'dot' + (live ? ' live pulse' : '') }), live ? 'LIVE' : 'STANDBY']),
      ]),
      h('div', { class: 'pz-lead-name' }, [
        h('span', { class: 'pz-swatch', style: `background:${it.color};box-shadow:0 0 8px ${it.color}66` }),
        h('span', { class: 'pz-name' }, it.name),
        it.score != null ? scoreChip(it.score, it.scoreParts) : '',
      ]),
      h('div', { class: 'pz-lead-body' }, [
        h('div', { class: 'pz-lead-main' }, [
          h('div', { class: 'pz-lead-clock' }, [
            h('span', { class: 'label' }, live ? 'LOS in' : 'AOS in'),
            h('span', { class: 'value hero' + (live ? ' live' : '') }, countdown((live ? los : aos) - now)),
            h('span', { class: 'pz-lead-when' }, `AOS ${hhmmss(p.aos)} · ${dayShort(p.aos)}`),
          ]),
          rail,
          h('div', { class: 'pz-lead-stats' }, [
            cell('Max el', deg(p.maxEl), p.maxEl >= 45 ? 'ok' : ''),
            cell('Duration', duration(p.durationS)),
            cell('AOS az', `${Math.round(p.aosAz)}° ${compass(p.aosAz)}`),
            cell('LOS az', `${Math.round(p.losAz)}° ${compass(p.losAz)}`),
          ]),
        ]),
        h('div', { class: 'pz-lead-plot' }, [canvas]),
      ]),
      readiness && readiness.passId === it.id && readyOpen ? readinessList() : '',
    ]);
    // Sized synchronously, not in rAF: a <canvas> defaults to 300x150, which would
    // blow out the flex row until the frame lands — and rAF is starved entirely
    // when the window is occluded. drawSkyTrack takes an explicit size and never
    // measures the DOM, so there is nothing to wait for.
    drawSkyTrack(canvas, it.arc, it.color, 124);
    return block;
  }

  const scoreChip = (score, parts) => h('span', {
    class: 'chip num ' + (score >= 70 ? 'ok' : score >= 40 ? 'warn' : ''),
    title: 'Pass quality — ' + scoreBreakdown({ score, parts: parts || [] }),
  }, String(score));

  function readinessChip() {
    const bad = readiness.items.filter((i) => i.state === 'warn' || i.state === 'fail').length;
    return h('button', {
      class: 'chip ' + (readiness.state === 'ready' ? 'ok' : readiness.state === 'fail' ? 'alert' : 'warn'),
      title: readiness.state === 'ready' ? 'All pre-pass checks passed — click for the checklist'
        : `${bad} pre-pass check${bad === 1 ? '' : 's'} need attention — click for details`,
      onclick: (e) => { e.stopPropagation(); readyOpen = !readyOpen; render(Date.now()); },
    }, readiness.state === 'ready' ? 'READY' : `${bad} TO CHECK`);
  }

  function readinessList() {
    const glyph = { ok: '✓', warn: '!', fail: '✕', off: '·' };
    return h('div', { class: 'pz-checks' }, readiness.items.map((it) => h('div', { class: 'pz-check ' + it.state }, [
      h('span', { class: 'pz-check-ic' }, glyph[it.state] || '·'),
      h('span', { class: 'pz-check-l' }, it.label),
      h('span', { class: 'pz-check-d num' }, it.detail || ''),
    ])));
  }

  /* --------------------------------- rows --------------------------------- */
  function passRow(it, now, schedule, key, armed, selected) {
    const p = it.pass;
    const live = now >= p.aos && now <= p.los;
    const until = p.aos.getTime() - now;
    const soon = !live && until < 10 * 60000;
    const canvas = h('canvas', { class: 'pz-mini' });

    const badge = schedule.conflictIds.size === 0 ? ''
      : schedule.planIds.has(key) ? h('span', { class: 'chip ok', title: 'In the recommended non-conflicting plan' }, 'PLAN')
      : schedule.conflictIds.has(key) ? h('span', { class: 'chip warn', title: 'Overlaps a higher-value pass — the scheduler skips it' }, 'CLASH')
      : '';

    const row = h('div', {
      class: 'pz-row' + (live ? ' live' : '') + (armed ? ' armed' : '') + (selected ? ' sel' : ''),
      onclick: () => store.patch({ selected: it.id }),
    }, [
      h('div', { class: 'pz-when' + (live ? ' live' : soon ? ' soon' : '') }, [
        h('span', { class: 'label' }, live ? 'LOS in' : 'in'),
        h('span', { class: 'value' }, countdownShort((live ? p.los : p.aos).getTime() - now)),
        h('span', { class: 'pz-date' }, dayShort(p.aos)),
      ]),
      h('div', { class: 'pz-mid' }, [
        h('div', { class: 'pz-mid-1' }, [
          h('span', { class: 'tg-dot', style: `background:${it.color}` }),
          h('span', { class: 'pz-name' }, it.name),
          it.visible ? h('span', { class: 'chip', title: 'Optically visible — sunlit satellite, dark sky' }, 'VIS') : '',
          it.score != null ? scoreChip(it.score, it.scoreParts) : '',
          badge,
        ]),
        h('div', { class: 'pz-mid-2' }, [
          h('span', { class: 'label' }, 'max'),
          h('span', { class: 'value' + (p.maxEl >= 45 ? ' ok' : '') }, deg(p.maxEl)),
          h('span', { class: 'pz-sep' }, '·'),
          h('span', { class: 'value' }, duration(p.durationS)),
          h('span', { class: 'pz-sep' }, '·'),
          h('span', { class: 'value mute' }, `${compass(p.aosAz)}→${compass(p.losAz)}`),
        ]),
        h('div', { class: 'pz-mid-3 num' }, `AOS ${hhmm(p.aos)} · #${it.id}`),
      ]),
      canvas,
      h('button', {
        class: 'btn sm pz-arm' + (armed ? ' on' : ''),
        title: armed ? 'Armed — the rotator is committed to this pass. Click to release.'
          : 'Commit the rotator to this specific pass',
        onclick: (e) => { e.stopPropagation(); armed ? handlers.disarmPass() : handlers.armPass(it.id, p.aos.getTime(), p.los.getTime()); },
      }, armed ? 'ARMED' : 'Arm'),
    ]);
    drawSkyTrack(canvas, it.arc, it.color, 46);
    return row;
  }

  /* ------------------------------- timeline ------------------------------- */
  function renderTimeline(list, now) {
    const events = buildTimeline(list, { now, preslewLead: store.get().hw.rotator.preslewLead });
    if (!events.length) { body.append(h('div', { class: 'empty' }, 'No scheduled events in the next 12 hours')); return; }
    const tl = h('div', { class: 'pz-tl' });
    let marked = false;
    const marker = () => h('div', { class: 'pz-now' }, [h('span', { class: 'chip live' }, 'NOW')]);
    for (const e of events) {
      if (!marked && e.t >= now) { tl.append(marker()); marked = true; }
      const past = e.t < now;
      tl.append(h('div', {
        class: 'pz-ev' + (past ? ' past' : ''),
        onclick: () => store.patch({ selected: e.id }),
      }, [
        h('span', { class: 'pz-ev-t num' }, hhmm(new Date(e.t))),
        h('span', { class: 'pz-ev-k', style: `color:${e.color}` }, e.label),
        h('span', { class: 'pz-ev-n' }, e.name),
        h('span', { class: 'pz-ev-d num' }, past ? '' : countdownShort(e.t - now)),
      ]));
    }
    if (!marked) tl.append(marker());
    body.append(tl);
  }

  /* -------------------------------- render -------------------------------- */
  function render(now) {
    const keep = el._body.scrollTop;
    body.replaceChildren();

    // Drop passes that have already set — see the note at the top of this file.
    const live = items.filter((it) => it.pass.los.getTime() >= now);

    if (view === 'timeline') { renderTimeline(live, now); el._body.scrollTop = keep; return; }

    if (!live.length) {
      body.append(h('div', { class: 'empty' }, store.get().tracked.length
        ? 'No passes above the horizon for your tracked satellites in the next 48 h'
        : 'Track a satellite to see its passes here'));
      lead.set(null, now);
      return;
    }

    const sort = store.get().passSort || 'time';
    sortSeg.set(sort);
    const ordered = sort === 'el' ? [...live].sort((a, b) => b.pass.maxEl - a.pass.maxEl)
      : sort === 'best' ? [...live].sort((a, b) => (b.score || 0) - (a.score || 0))
      : live;

    // One rotator tracks one bird at a time, so overlapping passes conflict.
    const keyOf = (it) => it.id + '@' + it.pass.aos.getTime();
    const schedule = analyzeSchedule(live.map((it) => ({
      id: keyOf(it), start: it.pass.aos.getTime(), end: it.pass.los.getTime(), score: it.score || 0,
    })));

    if (schedule.conflictIds.size) body.append(plannerStrip(live, schedule, keyOf));

    const selId = store.get().selected;
    // `live` is AOS-sorted, so the lead pass is the selected target's next pass if
    // it has one, else simply the soonest — matching main.js's readiness focus.
    const leadPass = live.find((it) => it.id === selId) || live[0];
    if (leadPass) body.append(leadBlock(leadPass, now));
    lead.set(leadPass, now);

    const armed = store.get().hw.rotator.armedPass;
    const rows = h('div', { class: 'pz-rows' });
    for (const it of ordered) {
      const isArmed = !!(armed && armed.id === it.id && Math.abs(armed.aos - it.pass.aos.getTime()) < 60000);
      rows.append(passRow(it, now, schedule, keyOf(it), isArmed, it.id === selId));
    }
    body.append(rows);
    el._body.scrollTop = keep;
  }

  function plannerStrip(live, schedule, keyOf) {
    const planned = live.filter((it) => schedule.planIds.has(keyOf(it)));
    const clashes = live.filter((it) => schedule.conflictIds.has(keyOf(it))).length;
    const armed = store.get().hw.rotator.armedPass;
    const next = [...planned].sort((a, b) => a.pass.aos - b.pass.aos)
      .find((it) => !(armed && armed.id === it.id && Math.abs(armed.aos - it.pass.aos.getTime()) < 60000));
    return h('div', {
      class: 'pz-plan',
      title: `The rotator follows one satellite at a time. ${planned.length} of ${live.length} upcoming passes fit a non-overlapping plan (score ${Math.round(schedule.totalScore)}); the rest are badged CLASH.`,
    }, [
      h('span', { class: 'value warn' }, String(clashes)),
      h('span', { class: 'label' }, `overlap${clashes === 1 ? '' : 's'} · ${planned.length} in plan`),
      h('span', { class: 'spacer' }),
      next ? h('button', {
        class: 'btn sm', title: `Arm ${next.name} at ${hhmm(next.pass.aos)} — the next pass in the plan`,
        onclick: () => handlers.armPass(next.id, next.pass.aos.getTime(), next.pass.los.getTime()),
      }, 'Arm next') : '',
    ]);
  }

  function exportICS() {
    const now = Date.now();
    const live = items.filter((it) => it.pass.los.getTime() >= now);
    if (!live.length) return;
    const p2 = (n) => String(n).padStart(2, '0');
    const dt = (d) => `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
    let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SkyPhreak//Passes//EN\r\n';
    for (const it of live) {
      const p = it.pass;
      ics += 'BEGIN:VEVENT\r\n'
        + `UID:${it.id}-${p.aos.getTime()}@skyphreak\r\n`
        + `DTSTAMP:${dt(new Date())}\r\n`
        + `DTSTART:${dt(p.aos)}\r\nDTEND:${dt(p.los)}\r\n`
        + `SUMMARY:${it.name} pass (max ${p.maxEl}°)${it.visible ? ' [visible]' : ''}\r\n`
        + `DESCRIPTION:AOS ${compass(p.aosAz)} -> LOS ${compass(p.losAz)}\\, max ${p.maxEl}°\r\n`
        + 'END:VEVENT\r\n';
    }
    const a = document.createElement('a');
    a.download = 'skyphreak-passes.ics';
    a.href = URL.createObjectURL(new Blob([ics + 'END:VCALENDAR\r\n'], { type: 'text/calendar' }));
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Reported back to the top-bar cluster so AOS/MAX/DURATION stay visible even when
  // the Passes panel is closed or buried behind another tab.
  const lead = { pass: null, now: 0, set(it, now) { this.pass = it; this.now = now; } };

  return {
    el,
    update(list, now) { items = list || []; render(now); },
    setReadiness(r) { readiness = r; },
    lead,
  };
}
