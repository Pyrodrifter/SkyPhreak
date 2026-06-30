# SuperRot Rotator Protocol — v1

A tiny ASCII line protocol for **continuous-motion** az/el rotators. Unlike
rotctld's position-only `P` ("go here and **stop**"), SuperRot streams *position +
velocity* setpoints so the motors are always moving and never lurch — the point of
the whole thing is jitter-free tracking for astrophotography and EME.

This document is self-contained: you can implement a **controller (firmware)** or a
**host (control software)** from it alone. The reference implementations in this repo
are listed in [§12](#12-reference-implementations).

- **Status:** stable, v1
- **Encoding:** UTF-8 / ASCII, newline-framed
- **Transports:** USB serial *or* TCP
- **Byte order / numbers:** decimal ASCII, `.` decimal separator

---

## 1. Design in one paragraph

The **host** computes where the target (satellite, Moon, planet, DSO) is *and how
fast it is moving* across the sky, and streams that to the controller many times a
second as `A az el azRate elRate`. The **controller** continuously slews each axis
toward the moving setpoint using the supplied rate as feed-forward, ramping with its
own acceleration limits so nothing ever steps or stops. The controller streams its
real position back as telemetry. That's it.

Responsibility split:

| Concern | Owner |
|---|---|
| Where the target is, and its angular rate | **Host** |
| Trajectory smoothing / S-curve planning | **Host** (may be minimal) |
| Step/PWM generation, acceleration limiting, motor safety | **Controller** |
| Shortest-path azimuth across 0°/360° | **Controller** |

A controller that only implements `P` (goto) already works as a rotctld-style mount.
Implementing `A` is what unlocks smooth motion. See the [tiers](#11-implementation-tiers).

---

## 2. Transport

### 2.1 USB serial
- **115200 baud, 8N1**, no flow control (configurable, but 115200 is the default).
- Raw bytes; no handshake on connect. The controller should be ready to parse lines
  immediately after its boot banner.

### 2.2 TCP
- Default port **4533**. (Same number rotctld uses — you run one *or* the other on a
  device, never both; the protocols are distinct.)
- One client at a time is sufficient. Plain TCP stream, no TLS, intended for a LAN /
  the operator's own WiFi.

Both transports carry the **identical** line protocol below. A controller that
supports both should treat them the same and reply on whichever the command arrived.

---

## 3. Message framing

- Messages are **lines terminated by LF (`\n`, 0x0A)**. A leading/trailing CR (`\r`)
  must be tolerated and stripped (so `\r\n` is fine).
- A line is a **single-letter command** optionally followed by space-separated
  decimal arguments.
- Commands are **case-sensitive** and are the *first character* of the line.
- Argument separators: one or more spaces. (A tolerant `scanf("%f …")`-style parse
  is recommended.)
- Empty lines are ignored.
- Max line length: keep ≤ 64 bytes; the longest valid line is well under that.

---

## 4. Coordinates and units

| Quantity | Unit | Range | Notes |
|---|---|---|---|
| Azimuth `az` | degrees | **continuous**, within the rotator's range (e.g. `[0, 450]`) | **0 = true North, increasing clockwise**. NOT wrapped — may exceed 360° (see §4.1). |
| Elevation `el` | degrees | `[0, 90]`, optionally `[0, 180]` | 0 = horizon, 90 = zenith. Extended mode up to 180° supports flip-over passes (the mount continues past zenith and tracks "upside down" on the far side instead of a 180° azimuth whip). |
| Azimuth rate `azRate` | degrees/second | signed | + = increasing azimuth (clockwise) |
| Elevation rate `elRate` | degrees/second | signed | + = rising |

- All angles are **degrees**, all rates **degrees per second**.
- The host sends **continuous (unwrapped) azimuth** — it may be `> 360°` or `< 0°`.
  The host is responsible for keeping the trajectory continuous; the controller just
  positions to the absolute value it's given (see §4.1).
- Rates are typically small (Moon ≈ 0.004°/s; a high LEO pass can momentarily exceed
  several °/s near zenith). Controllers should clamp to a safe ceiling (see
  [§8](#8-controller-behaviour)).

### 4.1 Azimuth is continuous — the host owns wrap, the controller positions absolutely

A target crossing North goes `… 359.6 → 360.2 → 360.5 …` **not** `… 359.6 → 0.2 …`.
The model is:

- **The host streams continuous, unwrapped azimuth.** Each new target azimuth from the
  orbit math (a 0–360 value) is unwrapped relative to the last *commanded* azimuth so
  the stream never jumps:

  ```
  d = targetAz - lastAz;
  d -= 360 * Math.round(d / 360);   // nearest equivalent, in (-180, 180]
  az = lastAz + d;                   // continuous; may pass through 360, 361, …
  ```

  This keeps the mount turning the **same direction** across North instead of unwinding
  ~358° mid-pass.

- **The controller does ABSOLUTE positioning and must NOT wrap.** It drives to exactly
  the azimuth it receives, over an **extended range** (e.g. `0..450°`) — i.e. a full
  turn plus an overlap region so a pass can cross North without immediately hitting the
  travel limit. No shortest-path / modular logic on the controller side; that would
  fight the host's continuity.

**Cable wrap & range.** The azimuth range (`azMin`/`azMax`, default `0..450`) is a
configurable soft limit matching the mount's mechanical travel. The host clamps its
continuous azimuth to this range. As a pass winds the cable toward the limit, the host
should warn the operator near the boundary and offer a manual **unwind** (drive 360°
back while idle); the controller then continues from the new position. Publish your
mount's travel so the host range can be set to match.

---

## 5. Commands (host → controller)

| Cmd | Form | Meaning |
|---|---|---|
| `A` | `A <az> <el> <azRate> <elRate>` | **Track setpoint** — position + feed-forward velocity. The primary streaming command. |
| `V` | `V <azRate> <elRate>` | **Velocity** — slew at these rates (deg/s) with no position target. For jogging / manual. |
| `P` | `P <az> <el>` | **Goto** — move to position and hold (rotctld-style). |
| `S` | `S` | **Stop** — decelerate to a controlled stop and hold current position. |
| `K` | `K` | **Park** — go to the park position and hold. |
| `?` | `?` | **Poll** — request one immediate telemetry line. |

### 5.1 `A` — track setpoint (the important one)
```
A 137.42 28.10 0.512 -0.087
```
"Be at az 137.42°, el 28.10°, and at this instant the target is moving +0.512°/s in
azimuth and −0.087°/s in elevation." The host streams this continuously (see
[§7](#7-host-behaviour-streaming)). The controller should track the *moving* point,
using the rate as feed-forward so it leads rather than chases. Treat each `A` as the
current truth; do not queue them.

### 5.2 `V` — velocity
```
V 1.5 0.0
```
Slew azimuth at +1.5°/s, elevation stopped. Persists until another command. Useful
for manual jog buttons or open-loop tests. `V 0 0` is equivalent to a soft stop.

### 5.3 `P` — goto (rotctld-compatible)
```
P 180.00 45.00
```
Move to az 180°, el 45° and stop. Provided for compatibility and simple "point here"
use. Shortest-path azimuth rule still applies.

### 5.4 `S` — stop
Decelerate both axes to zero using the controller's accel limit and hold. Not an
emergency cut — it's a graceful stop. (An e-stop, if you want one, should be a
hardware concern.)

### 5.5 `K` — park
Move to the park attitude and hold. **Park position is implementation-defined**; the
reference firmware parks at **az 0°, el 90°** (pointing up). Publish yours.

### 5.6 `?` — poll
Request a single telemetry line now. Controllers that already stream telemetry
continuously may treat `?` as a no-op (the next periodic line answers it).

---

## 6. Responses and telemetry (controller → host)

The controller emits three kinds of lines, all LF-terminated:

| Line | Meaning |
|---|---|
| `OK` | Last command accepted. |
| `ERR <message>` | Command rejected / not understood. `<message>` is free text. |
| `T <az> <el> <azRate> <elRate>` | **Telemetry** — current *actual* position and slew rate. |

### 6.1 Telemetry
```
T 137.41 28.09 0.500 -0.090
```
- Same units/conventions as [§4](#4-coordinates-and-units): degrees and deg/s.
  Report the **actual continuous azimuth** (may exceed 360°) so the host can seed its
  accumulator from the mount's real position on connect.
- Emit at a steady rate — **~10 Hz recommended** — and/or in response to `?`.
- This is what lets the host show real-vs-commanded position and confirm smooth
  tracking. Hosts should tolerate telemetry arriving at any time, interleaved with
  `OK`/`ERR`.

### 6.2 Acknowledgements
`OK`/`ERR` are optional but recommended for `A`/`V`/`P`/`S`/`K`. A host MUST NOT block
waiting for `OK` before sending the next `A` (it streams open-loop at a fixed rate);
acks are for diagnostics and slow commands, not flow control.

### 6.3 Parsing rule for hosts
Lines beginning with `T ` are telemetry; everything else is a reply/log. Ignore lines
you don't recognise (controllers may print boot banners, e.g. `SuperRot ready`).

---

## 7. Host behaviour (streaming)

- When tracking, stream `A` at a **steady 10–20 Hz** (the reference host uses 20 Hz).
- Compute `azRate`/`elRate` honestly — e.g. by sampling the target's look-angle at `t`
  and `t+Δ` and differencing — so feed-forward is meaningful. Sending `…Rate = 0`
  degrades gracefully to a goto-stream but reintroduces lag.
- Send **continuous (unwrapped) azimuth** — unwrap each new target relative to the
  last commanded azimuth (§4.1) so a north crossing keeps turning the same way. Clamp
  to the configured az range; warn near the limit and offer a manual unwind.
- **Seed** the azimuth accumulator from the controller's reported telemetry az when
  (re)connecting or starting a track, so you unwrap relative to the mount's real
  position instead of assuming 0.
- On loss of target / below horizon: send `S` (or stop streaming — see watchdog).
  The reference host also **auto-unwinds after an auto-tracked pass**: it gotos az 0
  (absolute, which removes any cable wrap) at a low elevation, so wind-up never
  accumulates toward the travel limit across successive passes.
- Pre-smoothing (S-curve, accel limiting) on the host is allowed and recommended, but
  the controller must still enforce its own limits; never assume the host is sane.

---

## 8. Controller behaviour

A conforming controller:

1. **Never stops between setpoints.** While `A`/`V` keep arriving it keeps moving; it
   only stops on `S`, `K`, `V 0 0`, or the watchdog.
2. **Limits acceleration (and ideally jerk).** Velocity changes must ramp, not snap —
   this is what keeps steppers from stalling and servos from buzzing.
3. **Clamps velocity** to a safe ceiling (reference: 15°/s) regardless of commanded
   rate — protects against a bad host or a zenith keyhole sending huge azimuth rates.
4. **Positions azimuth ABSOLUTELY over an extended range and must NOT wrap**
   ([§4.1](#41-azimuth-is-continuous--the-host-owns-wrap-the-controller-positions-absolutely)).
   Drive to exactly the (continuous) azimuth received, across e.g. `0..450°`. Do not
   apply shortest-path/modular logic — that fights the host's continuity. Clamp to the
   mount's travel limits.
5. **Has no position deadband.** Deadbands are the other source of rotctld jitter.
6. **Streams telemetry** (~10 Hz), reporting the actual continuous azimuth.
7. **Implements a comms watchdog (recommended):** if no `A`/`V` arrives for, say,
   **2 seconds**, decelerate to a stop. A dropped USB/WiFi link must not leave the
   mount slewing.

Elevation should be clamped to the mount's mechanical range. Azimuth should respect
cable-wrap soft limits if applicable.

---

## 9. Example sessions

### 9.1 Smooth track of a pass
```
host →  A 96.30 12.40 0.83 0.21
ctrl →  OK
ctrl →  T 96.28 12.37 0.80 0.20
host →  A 96.39 12.42 0.84 0.20        (~50 ms later)
ctrl →  T 96.36 12.40 0.83 0.20
 …      (streaming at 20 Hz; telemetry at 10 Hz)
host →  S                              (target set; stop)
ctrl →  OK
```

### 9.2 North crossing (continuous azimuth)
```
host →  A 359.70 40.00 1.10 0.00
host →  A 360.20 40.05 1.10 0.00       (continuous: 360.2, NOT 0.2 — keeps turning CW)
host →  A 360.70 40.10 1.10 0.00       (… 361, 362 … into the overlap region)
```
The controller drives to 360.2° absolutely; it does not wrap to 0.2°.

### 9.3 Manual jog, then park
```
host →  V 2.0 0.0      (slew clockwise)
ctrl →  OK
host →  V 0 0          (stop)
ctrl →  OK
host →  K              (park)
ctrl →  OK
ctrl →  T 0.05 89.90 0.20 -0.10   (slewing to park)
```

### 9.4 Bad command
```
host →  Z 1 2
ctrl →  ERR unknown
```

---

## 10. rotctld compatibility

`P az el` is intentionally the same shape as Hamlib rotctld's set-position. A SuperRot
controller therefore behaves like a basic rotctld mount if the host only ever sends
`P`. This lets one device serve both a legacy Hamlib host and a smooth SuperRot host.
SuperRot does **not** implement the rest of the rotctld command set — it is its own
protocol, not a Hamlib superset.

---

## 11. Implementation tiers

Build up in this order; each tier is independently useful:

- **Tier 0 — Goto.** Parse `P`, move there (absolute az), `S` to stop. You now have a
  working position rotator.
- **Tier 1 — Continuous.** Parse `A`, track the streamed position with accel-limited
  motion (you may ignore the rate fields at first). Motion is already smooth because
  setpoints arrive continuously.
- **Tier 2 — Feed-forward.** Use `azRate`/`elRate` as velocity feed-forward so the
  axis leads the target. This is the best tracking.
- **Tier 3 — Polish.** Telemetry, `V` jog, watchdog, jerk limiting, cable-wrap, park.

Minimum to interoperate with the reference host: **Tier 1** (`A` + `S`) plus ignoring
unknown lines. Telemetry is optional but makes the host's live readout work.

---

## 12. Reference implementations

In this repository:

| Side | File | What it shows |
|---|---|---|
| Controller (firmware) | `firmware/superrot_tmc2209/superrot_tmc2209.ino` | ESP32 + 2× TMC2209 + NEMA 17; serial **and** TCP; parses the full command set; ~10 Hz telemetry. |
| Host — transport | `electron/superrot.cjs` | Serial/TCP client; `track()`→`A`, `velocity()`→`V`, `goto()`→`P`, `stopMotion()`→`S`, `park()`→`K`; telemetry parse. |
| Host — motion planning | `src/core/motion.js` | 20 Hz controller: velocity feed-forward + accel/jerk S-curve + **continuous azimuth accumulator** (`cmd.az`, unwrapped, clamped to `azMin..azMax`) + zenith-keyhole clamp + `seed()`. Emits the `{az,el,azRate,elRate}` that becomes `A`. |
| Host — wiring | `src/main.js` (`driveToTarget`, `streamRotatorFast`, `unwindRotator`) | Finite-differences the look angle for feed-forward, seeds the accumulator from telemetry, surfaces the cable-wrap warning + unwind. |

### 12.1 TMC2209 smoothness notes (for stepper builds)
The reference firmware leans on three driver features that matter for visibly smooth
motion; if you roll your own, replicate them:
- **StealthChop2** at tracking speed (silent, no cogging hum), auto-switching to
  **SpreadCycle** above `TPWMTHRS` for torque on fast slews.
- **`intpol = 1` (MicroPlyer):** feed 1/16 microsteps, the chip interpolates to 1/256
  internally — this alone removes most visible stepping.
- **Hardware-timed step generation** (e.g. FastAccelStepper) with acceleration ramps.
- Mechanical reduction (worm/belt) so one microstep is an arc-minute-scale move; this
  is what turns "stepping" into "tracking".

---

## 13. Known gaps

The reference firmware does absolute extended-range azimuth positioning
([§4.1](#41-azimuth-is-continuous--the-host-owns-wrap-the-controller-positions-absolutely))
and a 2 s comms watchdog ([§8](#8-controller-behaviour)). Remaining limitations worth
knowing if you base your build on it:

1. **Single TCP client**, no reconnect backoff.
2. **Open-loop** — no encoder feedback; telemetry reports the commanded position, not a
   measured one. Add a closed-loop sensor if you need true position verification.
3. **Park position is fixed** at az 0 / el 90; make it configurable if your mount needs
   a different safe attitude.

---

## 14. Quick reference card

```
Transport : serial 115200 8N1  |  TCP :4533
Framing   : ASCII lines, LF-terminated, tolerate CR
Units     : degrees, deg/s   az = continuous (e.g. 0..450) N=0 CW   el = 0..90 (or 0..180)

Host → Controller
  A az el azRate elRate   track setpoint (stream 10–20 Hz)
  V azRate elRate         velocity slew
  P az el                 goto + hold (rotctld-style)
  S                       graceful stop + hold
  K                       park
  ?                       request telemetry now

Controller → Host
  OK                      command accepted
  ERR <text>              rejected
  T az el azRate elRate   telemetry (~10 Hz)

Rules
  • controller never stops while A/V stream
  • HOST sends continuous (unwrapped) az; controller positions ABSOLUTELY, no wrap
  • controller clamps accel + max velocity + az/el travel range, no deadband
  • recommended: stop if no A/V for 2 s (watchdog)
```
