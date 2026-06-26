const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const { HamlibClient } = require('./hamlib.cjs');
const { SuperRotClient } = require('./superrot.cjs');

const isDev = !!process.env.ELECTRON_DEV;
const userDataDir = () => app.getPath('userData');
const settingsPath = () => path.join(userDataDir(), 'settings.json');
const tleCachePath = () => path.join(userDataDir(), 'tle-cache.json');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0a0e14',
    title: 'SkyPhreak',
    icon: path.join(__dirname, '..', 'public', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const wc = mainWindow.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) => console.error(`did-fail-load ${code} ${desc} ${url}`));
  wc.on('preload-error', (_e, p, err) => console.error('preload-error', err));
  // Surface renderer warnings/errors to the terminal when devtools is closed.
  wc.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`);
  });
  wc.on('render-process-gone', (_e, details) => console.error('[renderer gone]', JSON.stringify(details)));

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Open external links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// One-time migration: inherit settings + TLE cache from the pre-rename
// ("pyrosattrack") userData folder if this profile doesn't have them yet.
function migrateLegacyUserData() {
  try {
    const newDir = userDataDir();
    if (fs.existsSync(path.join(newDir, 'settings.json'))) return;
    const oldDir = path.join(app.getPath('appData'), 'pyrosattrack');
    if (oldDir === newDir) return;
    for (const f of ['settings.json', 'tle-cache.json']) {
      const src = path.join(oldDir, f);
      if (fs.existsSync(src)) {
        fs.mkdirSync(newDir, { recursive: true });
        fs.copyFileSync(src, path.join(newDir, f));
      }
    }
  } catch { /* best-effort */ }
}

app.whenReady().then(() => {
  migrateLegacyUserData();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  rotatorMgr.close();
  radio.close();
  if (process.platform !== 'darwin') app.quit();
});

/* ----------------------------- Settings I/O ----------------------------- */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

ipcMain.handle('settings:get', () => readJson(settingsPath(), null));
ipcMain.handle('settings:set', (_e, data) => {
  writeJson(settingsPath(), data);
  return true;
});

/* ------------------------------ TLE fetch ------------------------------- */

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'SkyPhreak/0.1' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(httpGet(res.headers.location));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

// Fetch satellite elements from Celestrak, preferring OMM (JSON) — the modern,
// robust-to-parse format — and falling back to classic TLE text if JSON isn't
// available. The renderer auto-detects which format it got.
async function fetchGp(query) {
  try {
    const json = await httpGet(`https://celestrak.org/NORAD/elements/gp.php?${query}&FORMAT=json`);
    const t = json.trimStart();
    if ((t.startsWith('[') && t.length > 2) || t.startsWith('{')) return json;
  } catch { /* fall back to TLE */ }
  return httpGet(`https://celestrak.org/NORAD/elements/gp.php?${query}&FORMAT=tle`);
}

// Fetch a Celestrak group (e.g. "active", "amateur", "weather", "stations").
ipcMain.handle('tle:fetch', async (_e, group) => {
  const safe = String(group || 'active').replace(/[^a-z0-9-]/gi, '');
  const text = await fetchGp(`GROUP=${safe}`);
  const cache = readJson(tleCachePath(), {});
  cache[safe] = { fetchedAt: Date.now(), text };
  writeJson(tleCachePath(), cache);
  return { group: safe, fetchedAt: cache[safe].fetchedAt, text };
});

// Fetch a single satellite's current elements by NORAD catalog number.
ipcMain.handle('tle:fetchOne', async (_e, id) => {
  const safe = String(id || '').replace(/[^0-9]/g, '');
  const text = await fetchGp(`CATNR=${safe}`);
  return { id: safe, text };
});

ipcMain.handle('tle:cache', () => readJson(tleCachePath(), {}));

/* --------------------------- Hamlib HW control -------------------------- */

/**
 * Rotator manager — the renderer picks a protocol at connect time and this routes
 * commands to the right driver. 'hamlib' keeps the legacy rotctld `P` path for
 * stock rotors; 'superrot' speaks the continuous-motion protocol (serial or WiFi)
 * so the smooth controller can stream velocity setpoints. Both clients emit the
 * same 'status' shape, which we forward to the renderer unchanged.
 */
const rotatorMgr = {
  client: null,
  protocol: 'hamlib',
  _forward(s) {
    mainWindow?.webContents.send('hw:rotator-status', s);
  },
  async connect(conf = {}) {
    this.close();
    this.protocol = conf.protocol || 'hamlib';
    if (this.protocol === 'superrot') {
      this.client = new SuperRotClient('rotator');
      this.client.on('status', (s) => this._forward(s));
      return this.client.connect(conf); // { transport, host, port, path, baud }
    }
    this.client = new HamlibClient('rotator');
    this.client.on('status', (s) => this._forward(s));
    return this.client.connect(conf.host, conf.port);
  },
  // Continuous tracking setpoint (position + feedforward velocity). SuperRot uses
  // it directly; Hamlib can only approximate with a goto to the position.
  track(az, el, azRate, elRate) {
    if (!this.client) return { ok: false, error: 'not connected' };
    if (this.protocol === 'superrot') return this.client.track(az, el, azRate, elRate);
    return this.client.send(`P ${az.toFixed(2)} ${el.toFixed(2)}\n`);
  },
  setAzEl(az, el) {
    if (!this.client) return { ok: false, error: 'not connected' };
    if (this.protocol === 'superrot') return this.client.goto(az, el);
    return this.client.send(`P ${az.toFixed(2)} ${el.toFixed(2)}\n`);
  },
  park() {
    if (!this.client) return { ok: false, error: 'not connected' };
    if (this.protocol === 'superrot') return this.client.park();
    return this.client.send('P 0.00 90.00\n');
  },
  stop() {
    if (!this.client) return { ok: false, error: 'not connected' };
    if (this.protocol === 'superrot') return this.client.stopMotion();
    return { ok: true }; // rotctld has no soft-stop; it stops at the last goto
  },
  close() {
    if (this.client) {
      this.client.removeAllListeners('status');
      this.client.close();
      this.client = null;
    }
  },
};

const radio = new HamlibClient('radio');
radio.on('status', (s) => mainWindow?.webContents.send('hw:radio-status', s));

// List USB serial devices for the rotator picker, with human-friendly names so a
// non-technical user can recognise their hardware ("Silicon Labs CP210x…") instead
// of guessing a COM number. Returns { ok, ports } or a friendly error if the
// optional serialport package isn't installed.
ipcMain.handle('rotator:listPorts', async () => {
  let SerialPort;
  try {
    ({ SerialPort } = require('serialport'));
  } catch {
    return { ok: false, error: "USB support isn't installed. Use WiFi, or run: npm i serialport", ports: [] };
  }
  try {
    const list = await SerialPort.list();
    const ports = list.map((p) => ({
      path: p.path,
      label: p.friendlyName || [p.manufacturer, p.path].filter(Boolean).join(' · ') || p.path,
    }));
    return { ok: true, ports };
  } catch (e) {
    return { ok: false, error: e.message, ports: [] };
  }
});

ipcMain.handle('rotator:connect', (_e, conf) => rotatorMgr.connect(conf));
ipcMain.handle('rotator:disconnect', () => rotatorMgr.close());
ipcMain.handle('rotator:setAzEl', (_e, { az, el }) => rotatorMgr.setAzEl(az, el));
ipcMain.handle('rotator:track', (_e, { az, el, azRate, elRate }) => rotatorMgr.track(az, el, azRate, elRate));
ipcMain.handle('rotator:stop', () => rotatorMgr.stop());
ipcMain.handle('rotator:park', () => rotatorMgr.park());

ipcMain.handle('radio:connect', (_e, { host, port }) => radio.connect(host, port));
ipcMain.handle('radio:disconnect', () => radio.close());
ipcMain.handle('radio:setFreq', (_e, { hz }) => radio.send(`F ${Math.round(hz)}\n`));
