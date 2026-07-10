# SuperRot Rotator Protocol — v1

SuperRot is a small, newline-framed ASCII protocol for smooth azimuth/elevation
rotators. It solves the stop-start behaviour of position-only `rotctld` tracking by
streaming a target position and its angular velocity together.

**Canonical controller:** `PyroRotator/PyroRotator.ino`. The older
`firmware/superrot_tmc2209/` sketch is deprecated and must not be flashed with the
current SkyPhreak app.

## Transport and framing

- TCP on port **4533**, or USB serial at **115200 8N1**.
- One ASCII command or response per LF-terminated line. CR/LF is accepted.
- Numbers are decimal degrees and degrees per second.
- TCP port 4533 may run either SuperRot or rotctld, never both simultaneously.
  PyroRotator selects the active protocol in its web interface.

## Coordinates

- Azimuth: true north is 0°, increasing clockwise.
- Elevation: 0–90°, or 0–180° when flip-over mode is enabled.
- SkyPhreak uses a **free, continuous azimuth** model. The host resolves each sky
  bearing to the nearest equivalent of the mount's actual heading, so commands may
  be negative or greater than 360°. A controller must accept streamed `A` azimuths
  as absolute, continuous positions and must not wrap them again.
- One-shot `P` goto commands may choose a shortest path themselves.
- Cable wrap is the accumulated continuous azimuth. SkyPhreak displays it and offers
  `U` to return to the equivalent 0–360° heading while idle.

## Commands (host → controller)

| Command | Form | Meaning |
|---|---|---|
| Track | `A <az> <el> <azRate> <elRate>` | Set a moving target and feed-forward rate. Stream at 10–20 Hz. |
| Velocity | `V <azRate> <elRate>` | Slew continuously at the requested rates. |
| Goto | `P <az> <el>` | Go to a fixed position and hold. |
| Stop | `S` | Decelerate and hold the current position. |
| Park | `K` | Move to the controller's configured park attitude. |
| Home | `H` | Run the controller's homing sequence. In PyroRotator, elevation homes to its endstop; azimuth is compass-set to zero. |
| Unwind | `U` | Move azimuth to its 0–360° equivalent to remove accumulated cable wrap. |
| Config | `C key=value ...` | Apply supported runtime settings. |
| Query | `?` | Request telemetry; continuous-telemetry controllers may answer on their next cycle. |

Example:

```text
A 359.70 40.00 1.10 0.00
A 360.20 40.05 1.10 0.00
```

The azimuth remains continuous through north; it must not jump back to 0.20°.

## Responses and telemetry (controller → host)

```text
OK
ERR <message>
T <az> <el> <azRate> <elRate> [key=value ...]
```

Telemetry is normally emitted at about 10 Hz. PyroRotator appends optional
diagnostics such as `esAz`, `esEl`, `homed`, and `tempC`; hosts must ignore unknown
trailing fields.

Hosts must not wait for `OK` before sending the next `A` command. Acknowledgements are
diagnostic only; tracking is an open streaming loop.

## Controller requirements

1. Treat each `A` as current truth; never queue track points.
2. Acceleration-limit motion and clamp speed to safe mechanical limits.
3. Do not introduce a position deadband while tracking.
4. Clamp elevation to physical limits and protect against bad commands.
5. Stream the current continuous azimuth in telemetry so the host can seed its motion
   model after connecting, homing, parking, or manual movement.

PyroRotator is open-loop: its telemetry is the stepper's estimated position, not an
encoder measurement.

## Reference implementation map

| Component | File |
|---|---|
| Canonical firmware | `PyroRotator/PyroRotator.ino` |
| Electron transport client | `electron/superrot.cjs` |
| Smooth host motion controller | `src/core/motion.js` |
| Hardware scheduling and cable-wrap UI | `src/main.js` |
