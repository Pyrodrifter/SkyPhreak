const { contextBridge, ipcRenderer } = require('electron');

// Thin, explicit API surface exposed to the renderer. No raw ipcRenderer.
contextBridge.exposeInMainWorld('pyro', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (data) => ipcRenderer.invoke('settings:set', data),
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
  rotator: {
    // conf: { protocol:'hamlib'|'superrot', transport:'tcp'|'serial', host, port, path, baud }
    connect: (conf) => ipcRenderer.invoke('rotator:connect', conf),
    listPorts: () => ipcRenderer.invoke('rotator:listPorts'),
    disconnect: () => ipcRenderer.invoke('rotator:disconnect'),
    setAzEl: (az, el) => ipcRenderer.invoke('rotator:setAzEl', { az, el }),
    track: (az, el, azRate, elRate) => ipcRenderer.invoke('rotator:track', { az, el, azRate, elRate }),
    stop: () => ipcRenderer.invoke('rotator:stop'),
    park: () => ipcRenderer.invoke('rotator:park'),
    onStatus: (cb) => ipcRenderer.on('hw:rotator-status', (_e, s) => cb(s)),
  },
  radio: {
    connect: (host, port) => ipcRenderer.invoke('radio:connect', { host, port }),
    disconnect: () => ipcRenderer.invoke('radio:disconnect'),
    setFreq: (hz) => ipcRenderer.invoke('radio:setFreq', { hz }),
    onStatus: (cb) => ipcRenderer.on('hw:radio-status', (_e, s) => cb(s)),
  },
});
