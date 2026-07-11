/**
 * Mission timeline — flattens the tracked-pass list into one chronological feed of
 * operational events, so the separate features (pre-slew, tracking, radio, park)
 * read as a single workflow. Pure function: main.js feeds it the pass list.
 *
 * Per pass it emits: WAKE (pre-slew to AOS azimuth) → AOS → MAX (peak elevation) →
 * LOS → PARK. Events already well in the past are dropped; the rest are time-sorted.
 */

const EVENTS = {
  wake: { label: 'Pre-slew', icon: '⟳', detail: (p) => `aim at AOS ${Math.round(p.pass.aosAz)}°` },
  aos: { label: 'AOS · rise', icon: '▲', detail: (p) => `${Math.round(p.pass.aosAz)}° · ${azName(p.pass.aosAz)}` },
  max: { label: 'Max elevation', icon: '★', detail: (p) => `${p.pass.maxEl.toFixed(0)}°` },
  los: { label: 'LOS · set', icon: '▼', detail: (p) => `${Math.round(p.pass.losAz)}° · ${azName(p.pass.losAz)}` },
  park: { label: 'Park', icon: '⏹', detail: () => 'stow rotator' },
};

export function buildTimeline(passes, opts = {}) {
  const now = opts.now ?? Date.now();
  const preslewMs = (opts.preslewLead ?? 45) * 1000;
  const horizonMs = (opts.horizonHours ?? 12) * 3600 * 1000;
  const grace = 90 * 1000; // keep events a bit after they fire so "NOW" is visible

  const out = [];
  for (const p of passes || []) {
    const aos = p.pass.aos.getTime();
    const los = p.pass.los.getTime();
    if (aos > now + horizonMs) continue;
    const peak = p.pass.peakTime ? p.pass.peakTime.getTime() : (aos + los) / 2;
    const rows = [
      ['wake', aos - preslewMs],
      ['aos', aos],
      ['max', peak],
      ['los', los],
      ['park', los + 1000],
    ];
    for (const [type, t] of rows) {
      if (t < now - grace) continue;
      const e = EVENTS[type];
      out.push({ t, type, label: e.label, icon: e.icon, detail: e.detail(p), id: p.id, name: p.name, color: p.color });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function azName(az) { return DIRS[Math.round(((az % 360) / 45)) % 8]; }
