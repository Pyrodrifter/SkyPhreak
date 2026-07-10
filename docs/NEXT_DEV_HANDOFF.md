# Next developer handoff

## Current source of truth

- Canonical ESP32 firmware: `PyroRotator/PyroRotator.ino`.
- `firmware/superrot_tmc2209/` is retained only as a deprecated UART/TMC2209 reference;
  do not use it with current SkyPhreak releases.
- SuperRot protocol: `docs/SUPERROT_PROTOCOL.md`.
- Azimuth model: free/continuous shortest-path host commands, with explicit cable-wrap
  visibility and manual `U` unwind. Do not reintroduce a 0–450° clamp in the active
  firmware without changing the host model and documentation together.

## Completed correctness work

- Scheduled tracking respects the rotator tracking minimum elevation.
- `H` homing and `U` cable-unwind are available through the Electron bridge and the
  Hardware pane.
- The built-in Home preset now runs `H`; saved presets still use normal goto.
- Pass-list and rotator tracking minimum elevations have distinct labels.

## Suggested next work: Mission Control / Operate mode

The supplied render is the design reference. Preserve the existing feature set, but
make the primary operating screen answer immediately: selected target, next/current
pass, actual vs commanded pointing, radio/rotator state, cable wrap, and a prominent
stop action.

Recommended sequence:

1. Mission top bar: target hero and AOS/AZ/EL/max-elevation/duration readouts.
2. Persistent status bar: UTC/local, mode, connections, wrap, Park, and a dominant
   red Stop button.
3. Right-panel pass hero and a lighter upcoming-pass timeline.
4. Make the map/globe visually dominant; reduce side-panel borders and density.
5. Stop rebuilding pass/info DOM on every tick—keep rows mounted and update only live
   values so scrolling and interaction remain stable.

## Safety note

The firmware contains Wi-Fi credentials in source. Rotate them if the repository has
ever been shared, and move them to a local untracked configuration before publishing.
