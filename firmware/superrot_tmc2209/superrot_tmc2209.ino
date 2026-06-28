/*
 * SuperRot firmware — continuous-motion az/el rotator controller
 * Target: ESP32 + 2x TMC2209 (UART) + 2x NEMA 17, for SkyPhreak.
 *
 * Why this exists: rotctld's `P az el` makes the motor lurch to a point and STOP,
 * which jerks under astrophotography. SuperRot instead receives a continuous stream
 * of {position + velocity} setpoints and keeps both axes always moving, ramped with
 * acceleration limits. The host (SkyPhreak MotionController) does the trajectory
 * planning; this firmware does smooth, hardware-timed step generation.
 *
 * Smoothness recipe for the TMC2209 (the important part):
 *   - StealthChop2 at tracking speed  -> silent, no cogging hum
 *   - intpol = true (MicroPlyer)       -> feed 1/16 µsteps, chip interpolates to 1/256
 *   - SpreadCycle above TPWMTHRS       -> torque for fast slews
 *   - FastAccelStepper                 -> hardware-timer step pulses, jerk-free ramps
 *
 * Protocol (newline-terminated ASCII, same over USB serial or TCP :4533):
 *   A <az> <el> <azRate> <elRate>   track setpoint: position(deg) + velocity(deg/s)
 *   V <azRate> <elRate>             pure velocity (deg/s)
 *   P <az> <el>                     goto (rotctld-style)
 *   S                               stop (decelerate + hold)
 *   K                               park
 *   ?                               request one telemetry line
 * Replies: "OK", "ERR <msg>", and telemetry "T <az> <el> <azRate> <elRate>" @ ~10 Hz.
 *
 * Libraries (install via Library Manager):
 *   - TMCStepper        (TMC2209 UART config)
 *   - FastAccelStepper  (step generation + ramps)
 */

#include <Arduino.h>
#include <TMCStepper.h>
#include <FastAccelStepper.h>
#include <WiFi.h>

/* ----------------------------- Configuration ----------------------------- */
// --- WiFi (leave SSID empty to run serial-only) ---
static const char* WIFI_SSID = "";
static const char* WIFI_PASS = "";
static const uint16_t TCP_PORT = 4533;

// --- Pins (adjust to your wiring) ---
#define AZ_STEP_PIN 26
#define AZ_DIR_PIN  27
#define EL_STEP_PIN 32
#define EL_DIR_PIN  33
#define AZ_EN_PIN   25
#define EL_EN_PIN   14
// TMC2209 share one UART; address by MS1/MS2 straps (0..3).
HardwareSerial& TMC_UART = Serial2; // pins 16(RX)/17(TX) by default
#define TMC_RX 16
#define TMC_TX 17
static const uint8_t AZ_ADDR = 0b00;
static const uint8_t EL_ADDR = 0b01;
static const float R_SENSE = 0.11f; // most TMC2209 breakouts

// --- Mechanics ---
static const int   MICROSTEPS   = 16;     // fed to driver; intpol smooths to 256
static const int   MOTOR_STEPS  = 200;    // 1.8° NEMA 17
static const float AZ_GEAR      = 100.0f; // worm/belt reduction, motor:output
static const float EL_GEAR      = 100.0f;
static const uint16_t RMS_CURRENT = 600;  // mA — set to your motor/heatsinking

// Steps per output degree (resolution that turns "stepping" into "tracking").
static const float AZ_SPD = (MOTOR_STEPS * MICROSTEPS * AZ_GEAR) / 360.0f;
static const float EL_SPD = (MOTOR_STEPS * MICROSTEPS * EL_GEAR) / 360.0f;

// Motion limits (firmware-side safety net; host limits are usually tighter).
static const float MAX_DEG_S   = 15.0f;   // ceiling angular velocity
static const float ACCEL_DEG_S2 = 30.0f;  // ramp rate
static const unsigned long WATCHDOG_MS = 2000; // stop if no A/V stream for this long

// Absolute travel range. Azimuth is CONTINUOUS (the host sends unwrapped az that may
// exceed 360); we position absolutely over this range, with ~90° of overlap past a
// full turn so a north crossing doesn't immediately hit the limit (operator unwinds
// the cable by hand). We do NOT shortest-path / wrap — that would fight the host.
static const float AZ_MIN_DEG = 0.0f;
static const float AZ_MAX_DEG = 450.0f;
static const float EL_MAX_DEG = 90.0f;    // raise toward 180 for flip-over passes

/* ------------------------------- Globals --------------------------------- */
TMC2209Stepper azDrv(&TMC_UART, R_SENSE, AZ_ADDR);
TMC2209Stepper elDrv(&TMC_UART, R_SENSE, EL_ADDR);
FastAccelStepperEngine engine = FastAccelStepperEngine();
FastAccelStepper* azStep = nullptr;
FastAccelStepper* elStep = nullptr;

WiFiServer server(TCP_PORT);
WiFiClient client;
String rxBuf;
unsigned long lastTelemetry = 0;
unsigned long lastStreamMs = 0;  // last time an A/V streaming setpoint arrived
bool streaming = false;          // true while tracking; arms the comms watchdog

/* ---------------------------- Driver setup ------------------------------- */
void setupDriver(TMC2209Stepper& d) {
  d.begin();
  d.toff(4);
  d.rms_current(RMS_CURRENT);
  d.microsteps(MICROSTEPS);
  d.intpol(true);          // MicroPlyer: 1/16 -> 1/256 interpolation (key!)
  d.en_spreadCycle(false); // StealthChop2 at low speed (silent, smooth)
  d.pwm_autoscale(true);
  d.TPWMTHRS(300);         // auto-switch to SpreadCycle above this velocity
}

FastAccelStepper* setupStepper(int stepPin, int dirPin, int enPin, float maxSpd, float accelSpd) {
  FastAccelStepper* s = engine.stepperConnectToPin(stepPin);
  s->setDirectionPin(dirPin);
  s->setEnablePin(enPin);
  s->setAutoEnable(true);
  s->setSpeedInHz((uint32_t)(MAX_DEG_S * maxSpd));
  s->setAcceleration((uint32_t)(ACCEL_DEG_S2 * accelSpd));
  return s;
}

void setup() {
  Serial.begin(115200);
  TMC_UART.begin(115200, SERIAL_8N1, TMC_RX, TMC_TX);
  setupDriver(azDrv);
  setupDriver(elDrv);

  engine.init();
  azStep = setupStepper(AZ_STEP_PIN, AZ_DIR_PIN, AZ_EN_PIN, AZ_SPD, AZ_SPD);
  elStep = setupStepper(EL_STEP_PIN, EL_DIR_PIN, EL_EN_PIN, EL_SPD, EL_SPD);

  if (WIFI_SSID[0]) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 8000) delay(100);
    if (WiFi.status() == WL_CONNECTED) {
      server.begin();
      Serial.print("SuperRot WiFi ");
      Serial.println(WiFi.localIP());
    }
  }
  Serial.println("SuperRot ready");
}

/* ----------------------------- Command exec ------------------------------ */
// Azimuth target in steps. ABSOLUTE positioning over the extended range — the host
// sends CONTINUOUS (unwrapped) azimuth, so we drive straight to it and must NOT wrap
// or shortest-path (that would fight the host's continuity). Clamp to travel limits.
int32_t azTargetSteps(float targetDeg) {
  if (targetDeg < AZ_MIN_DEG) targetDeg = AZ_MIN_DEG;
  else if (targetDeg > AZ_MAX_DEG) targetDeg = AZ_MAX_DEG;
  return (int32_t)lroundf(targetDeg * AZ_SPD);
}

// Elevation target in steps, clamped to [0, EL_MAX_DEG].
int32_t elTargetSteps(float targetDeg) {
  if (targetDeg < 0.0f) targetDeg = 0.0f;
  else if (targetDeg > EL_MAX_DEG) targetDeg = EL_MAX_DEG;
  return (int32_t)lroundf(targetDeg * EL_SPD);
}

// Slew one axis toward an absolute step target at a speed set from the feed-forward
// rate. Because the host streams continuously, the motor keeps moving and never stops.
void axisMove(FastAccelStepper* s, int32_t targetSteps, float rateDegS, float spd) {
  float r = fabs(rateDegS);
  if (r > MAX_DEG_S) r = MAX_DEG_S;
  // Keep a healthy minimum so position trim doesn't stall between updates.
  uint32_t hz = (uint32_t)max(r * spd, 0.5f * spd / 60.0f);
  s->setSpeedInHz(hz > 0 ? hz : 1);
  s->moveTo(targetSteps);
}

void axisVel(FastAccelStepper* s, float rateDegS, float spd) {
  float r = rateDegS;
  if (r > MAX_DEG_S) r = MAX_DEG_S;
  if (r < -MAX_DEG_S) r = -MAX_DEG_S;
  s->setSpeedInHz((uint32_t)max(fabs(r) * spd, 1.0f));
  if (r > 0) s->runForward();
  else if (r < 0) s->runBackward();
  else s->stopMove();
}

void reply(Stream& out, const char* msg) { out.print(msg); out.print('\n'); }

void handleLine(String line, Stream& out) {
  line.trim();
  if (!line.length()) return;
  char cmd = line[0];
  float a = 0, b = 0, c = 0, d = 0;
  sscanf(line.c_str() + 1, "%f %f %f %f", &a, &b, &c, &d);
  switch (cmd) {
    case 'A': // track setpoint: position + feed-forward velocity (streamed)
      axisMove(azStep, azTargetSteps(a), c, AZ_SPD);
      axisMove(elStep, elTargetSteps(b), d, EL_SPD);
      lastStreamMs = millis(); streaming = true; // arm comms watchdog
      reply(out, "OK"); break;
    case 'V': // velocity slew (streamed / manual jog)
      axisVel(azStep, a, AZ_SPD); axisVel(elStep, b, EL_SPD);
      lastStreamMs = millis(); streaming = true;
      reply(out, "OK"); break;
    case 'P': // goto + hold (one-shot, not watched). Full speed, absolute az.
      azStep->setSpeedInHz((uint32_t)(MAX_DEG_S * AZ_SPD));
      elStep->setSpeedInHz((uint32_t)(MAX_DEG_S * EL_SPD));
      azStep->moveTo(azTargetSteps(a));
      elStep->moveTo(elTargetSteps(b));
      streaming = false; reply(out, "OK"); break;
    case 'S': azStep->stopMove(); elStep->stopMove(); streaming = false; reply(out, "OK"); break;
    case 'K': // park (one-shot): az to 0, el to 90.
      azStep->setSpeedInHz((uint32_t)(MAX_DEG_S * AZ_SPD));
      elStep->setSpeedInHz((uint32_t)(MAX_DEG_S * EL_SPD));
      azStep->moveTo(azTargetSteps(0));
      elStep->moveTo(elTargetSteps(90));
      streaming = false; reply(out, "OK"); break;
    case '?': break; // telemetry sent in loop
    default:  reply(out, "ERR unknown"); break;
  }
}

void sendTelemetry(Stream& out) {
  float az = azStep->getCurrentPosition() / AZ_SPD;
  float el = elStep->getCurrentPosition() / EL_SPD;
  float azR = azStep->getCurrentSpeedInMilliHz() / 1000.0f / AZ_SPD;
  float elR = elStep->getCurrentSpeedInMilliHz() / 1000.0f / EL_SPD;
  char buf[64];
  snprintf(buf, sizeof(buf), "T %.2f %.2f %.3f %.3f", az, el, azR, elR);
  reply(out, buf);
}

/* -------------------------------- Loop ----------------------------------- */
void pump(Stream& in, String& buf, Stream& out) {
  while (in.available()) {
    char c = (char)in.read();
    if (c == '\n') { handleLine(buf, out); buf = ""; }
    else if (c != '\r') buf += c;
  }
}

void loop() {
  // Serial transport
  static String serBuf;
  pump(Serial, serBuf, Serial);

  // TCP transport
  if (server && !client.connected()) client = server.available();
  if (client.connected()) pump(client, rxBuf, client);

  // Comms watchdog: if a tracking stream goes silent (link dropped), decelerate and
  // hold — a lost connection must not leave the mount slewing. One-shot P/K gotos are
  // not watched (streaming is cleared when they run).
  if (streaming && millis() - lastStreamMs > WATCHDOG_MS) {
    azStep->stopMove();
    elStep->stopMove();
    streaming = false;
  }

  if (millis() - lastTelemetry >= 100) { // ~10 Hz telemetry
    lastTelemetry = millis();
    if (client.connected()) sendTelemetry(client);
    else sendTelemetry(Serial);
  }
}
