/**
 * Conflict-aware pass scheduler.
 *
 * A single rotator can only track one satellite at a time, so passes whose
 * [AOS, LOS] windows overlap are in conflict — you have to choose. This module:
 *   • flags every pair of overlapping passes (conflict groups), and
 *   • computes the highest-value non-overlapping PLAN via weighted interval
 *     scheduling (an exact DP that maximises total pass score), so the
 *     recommendation is optimal, not just greedy.
 *
 * Pure module: it takes normalized passes and returns plain data. main.js/ui.js
 * map the tracked-pass items in and render the badges + plan.
 *
 * A normalized pass is { id, start, end, score } where start/end are epoch ms.
 * `id` here is unique per pass (e.g. `${noradId}@${aosMs}`), since one satellite
 * has many passes.
 */

/** Do two [start,end) windows overlap? */
export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Full schedule analysis.
 * @returns {{ planIds:Set<string>, conflictIds:Set<string>, conflicts:Map<string,string[]>, totalScore:number }}
 *   planIds     — ids selected for the optimal non-overlapping plan
 *   conflictIds — ids that overlap at least one other pass
 *   conflicts   — id → list of ids it overlaps
 *   totalScore  — summed score of the plan
 */
export function analyzeSchedule(passes) {
  const list = (passes || [])
    .filter((p) => p && Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start)
    .map((p) => ({ id: p.id, start: p.start, end: p.end, score: Number.isFinite(p.score) ? p.score : 0 }));

  // Pairwise conflicts.
  const conflicts = new Map();
  const conflictIds = new Set();
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (overlaps(list[i], list[j])) {
        if (!conflicts.has(list[i].id)) conflicts.set(list[i].id, []);
        if (!conflicts.has(list[j].id)) conflicts.set(list[j].id, []);
        conflicts.get(list[i].id).push(list[j].id);
        conflicts.get(list[j].id).push(list[i].id);
        conflictIds.add(list[i].id);
        conflictIds.add(list[j].id);
      }
    }
  }

  // Weighted interval scheduling for the optimal plan.
  const sorted = [...list].sort((a, b) => a.end - b.end);
  const n = sorted.length;
  // p[i] = index of the latest pass that ends at or before sorted[i] starts.
  const p = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = i - 1; j >= 0; j--) {
      if (sorted[j].end <= sorted[i].start) { p[i] = j; break; }
    }
  }
  const opt = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const incl = sorted[i - 1].score + opt[p[i - 1] + 1];
    opt[i] = Math.max(opt[i - 1], incl);
  }
  // Backtrack to recover the chosen ids.
  const planIds = new Set();
  let i = n;
  while (i > 0) {
    const incl = sorted[i - 1].score + opt[p[i - 1] + 1];
    if (incl >= opt[i - 1]) { planIds.add(sorted[i - 1].id); i = p[i - 1] + 1; }
    else i -= 1;
  }

  let totalScore = 0;
  for (const s of sorted) if (planIds.has(s.id)) totalScore += s.score;

  return { planIds, conflictIds, conflicts, totalScore };
}
