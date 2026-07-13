/**
 * Per-satellite radio profiles + Doppler tuning.
 *
 * A profile pins the working frequencies for a satellite so you don't retype
 * them each pass: a downlink (sat→ground) and, for transponders/repeaters, an
 * uplink (ground→sat), each with a mode. `invert` marks a linear INVERTING
 * transponder (uplink and downlink move in opposite directions across the band).
 *
 * Doppler: the ground station must correct BOTH links independently so the
 * satellite always hears your uplink at its nominal RX frequency and you always
 * hear its downlink at its nominal TX frequency —
 *   observed downlink = downlink × factor        (tune your RX here)
 *   transmit uplink   = uplink   ÷ factor        (transmit here so the sat RX is on-freq)
 * where `factor = observed/emitted` (the topocentric range-rate Doppler factor
 * from the propagator, <1 receding, >1 approaching). This "full Doppler" scheme
 * keeps a linear-transponder QSO locked regardless of inversion.
 *
 * Pure module: no DOM, no store. The renderer persists profiles keyed by NORAD id.
 */

export const MODES = ['FM', 'USB', 'LSB', 'CW', 'CW-R', 'DATA', 'AFSK', 'DV'];

/** Observed downlink frequency (what your RX should tune to). */
export function shiftedDownlink(hz, factor) {
  return Math.round(hz * (factor || 1));
}

/** Uplink transmit frequency (so the satellite receives its nominal uplink). */
export function shiftedUplink(hz, factor) {
  return Math.round(hz / (factor || 1));
}

/** Doppler shift magnitude (Hz) for a link at a frequency and range rate. */
export function dopplerShiftHz(freqHz, factor) {
  return Math.round(freqHz * ((factor || 1) - 1));
}

/** Coerce a raw profile object into a clean, fully-formed one. */
export function normalizeProfile(p = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const mode = (m, dflt) => (MODES.includes(m) ? m : dflt);
  const downlinkHz = num(p.downlinkHz);
  const uplinkHz = num(p.uplinkHz);
  return {
    label: String(p.label || '').slice(0, 40),
    downlinkHz,
    downlinkMode: mode(p.downlinkMode, 'FM'),
    uplinkHz,
    uplinkMode: mode(p.uplinkMode, downlinkHz && !uplinkHz ? 'FM' : 'USB'),
    invert: !!p.invert,
    hasUplink: uplinkHz > 0,
  };
}

/**
 * Resolve the active profile for a satellite id, falling back to the global
 * single-downlink radio config when the sat has no dedicated profile. Returns
 * null when there's nothing sensible to tune (no profile and no global freq).
 */
export function resolveProfile(profiles, id, globalRadio) {
  const p = profiles && profiles[id];
  if (p && (p.downlinkHz || p.uplinkHz)) return { ...normalizeProfile(p), source: 'profile' };
  const g = globalRadio && globalRadio.downlinkHz;
  if (g) return { ...normalizeProfile({ downlinkHz: g, downlinkMode: 'FM' }), source: 'global' };
  return null;
}

/**
 * Live tuning for a profile at a Doppler factor. Returns the frequencies your
 * radio should sit at right now, plus the per-link shift for display.
 */
export function tuning(profile, factor) {
  if (!profile) return null;
  const f = factor || 1;
  const out = {
    downlinkHz: profile.downlinkHz,
    downlinkTunedHz: profile.downlinkHz ? shiftedDownlink(profile.downlinkHz, f) : 0,
    downlinkShiftHz: profile.downlinkHz ? dopplerShiftHz(profile.downlinkHz, f) : 0,
    downlinkMode: profile.downlinkMode,
    hasUplink: !!profile.hasUplink,
  };
  if (profile.hasUplink) {
    out.uplinkHz = profile.uplinkHz;
    out.uplinkTunedHz = shiftedUplink(profile.uplinkHz, f);
    // Uplink correction is the inverse-sense shift: transmit low when approaching.
    out.uplinkShiftHz = out.uplinkTunedHz - profile.uplinkHz;
    out.uplinkMode = profile.uplinkMode;
    out.invert = profile.invert;
  }
  return out;
}

/** MHz string for display, trimming trailing zeros to 5 dp. */
export function fmtMHz(hz) {
  if (!hz) return '—';
  return (hz / 1e6).toFixed(5).replace(/\.?0+$/, '') + ' MHz';
}

/** A few well-known amateur-satellite presets to seed a profile quickly. */
export const RADIO_PRESETS = {
  'iss-voice': { label: 'ISS FM voice', downlinkHz: 145800000, downlinkMode: 'FM', uplinkHz: 145990000, uplinkMode: 'FM' },
  'iss-aprs': { label: 'ISS APRS', downlinkHz: 145825000, downlinkMode: 'AFSK', uplinkHz: 145825000, uplinkMode: 'AFSK' },
  'so-50': { label: 'SO-50 FM', downlinkHz: 436795000, downlinkMode: 'FM', uplinkHz: 145850000, uplinkMode: 'FM' },
  'rs-44': { label: 'RS-44 linear (inv)', downlinkHz: 435640000, downlinkMode: 'USB', uplinkHz: 145965000, uplinkMode: 'LSB', invert: true },
  'ao-91': { label: 'AO-91 FM', downlinkHz: 145960000, downlinkMode: 'FM', uplinkHz: 435250000, uplinkMode: 'FM' },
};
