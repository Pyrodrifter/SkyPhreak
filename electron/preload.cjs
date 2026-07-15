const { contextBridge, ipcRenderer } = require('electron');

// Thin, explicit API surface exposed to the renderer. No raw ipcRenderer.
contextBridge.exposeInMainWorld('pyro', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (data) => ipcRenderer.invoke('settings:set', data),
  },
  flasher: {
    listPorts: () => ipcRenderer.invoke('flasher:listPorts'),
    availability: () => ipcRenderer.invoke('flasher:availability'),
    flash: (port) => ipcRenderer.invoke('flasher:flash', { port }),
    provision: (port, profile) => ipcRenderer.invoke('flasher:provision', { port, profile }),
    onProgress: (cb) => {
      const listener = (_event, progress) => cb(progress);
      ipcRenderer.on('flasher:progress', listener);
      return () => ipcRenderer.removeListener('flasher:progress', listener);
    },
  },
  tle: {
    fetch: (group) => ipcRenderer.invoke('tle:fetch', group),
    fetchOne: (id) => ipcRenderer.invoke('tle:fetchOne', id),
    cache: () => ipcRenderer.invoke('tle:cache'),
  },
  oem: {
    // Returns [{ name, text }] for the chosen OEM files ([] if cancelled).
    load: () => ipcRenderer.invoke('oem:load'),
  },
  space: {
    // Latest planetary K-index: { ok, kp, time } or { ok:false, error }.
    weather: () => ipcRenderer.invoke('space:weather'),
  },
  rotator: {
    // conf: { protocol:'hamlib'|'superrot', transport:'tcp'|'serial', host, port, path, baud }
    connect: (conf) => ipcRenderer.invoke('rotator:connect', conf),
    listPorts: () => ipcRenderer.invoke('rotator:listPorts'),
    disconnect: () => ipcRenderer.invoke('rotator:disconnect'),
    setAzEl: (az, el) => ipcRenderer.invoke('rotator:setAzEl', { az, el }),
    track: (az, el, azRate, elRate) => ipcRenderer.invoke('rotator:track', { az, el, azRate, elRate }),
    stop: () => ipcRenderer.invoke('rotator:stop'),
    park: () => ipcRenderer.invoke('rotator:park'),
    home: () => ipcRenderer.invoke('rotator:home'),
    unwind: () => ipcRenderer.invoke('rotator:unwind'),
    config: (cfg) => ipcRenderer.invoke('rotator:config', cfg),
    mission: (target, state) => ipcRenderer.invoke('rotator:mission', { target, state }),
    onStatus: (cb) => ipcRenderer.on('hw:rotator-status', (_e, s) => cb(s)),
  },
  radio: {
    connect: (host, port) => ipcRenderer.invoke('radio:connect', { host, port }),
    disconnect: () => ipcRenderer.invoke('radio:disconnect'),
    setFreq: (hz) => ipcRenderer.invoke('radio:setFreq', { hz }),
    onStatus: (cb) => ipcRenderer.on('hw:radio-status', (_e, s) => cb(s)),
  },
  lcd: {
    // conf: { transport:'tcp'|'serial', host, port, path, baud }
    connect: (conf) => ipcRenderer.invoke('lcd:connect', conf),
    disconnect: () => ipcRenderer.invoke('lcd:disconnect'),
    send: (line) => ipcRenderer.invoke('lcd:send', { line }),
    onStatus: (cb) => ipcRenderer.on('hw:lcd-status', (_e, s) => cb(s)),
  },
});
