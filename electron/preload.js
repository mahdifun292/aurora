'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
  },
  library: {
    get: () => ipcRenderer.invoke('library:get'),
    scan: () => ipcRenderer.invoke('library:scan'),
    addFolder: () => ipcRenderer.invoke('library:add-folder'),
    removeFolder: (folder) => ipcRenderer.invoke('library:remove-folder', folder),
    reveal: (filePath) => ipcRenderer.invoke('library:reveal', filePath),
    onProgress: (cb) => on('library:progress', cb),
  },
  playlists: {
    get: () => ipcRenderer.invoke('playlists:get'),
    set: (playlists) => ipcRenderer.invoke('playlists:set', playlists),
  },
  favorites: {
    get: () => ipcRenderer.invoke('favorites:get'),
    set: (favorites) => ipcRenderer.invoke('favorites:set', favorites),
  },
  lyrics: {
    local: (track) => ipcRenderer.invoke('lyrics:local', track),
    server: (track) => ipcRenderer.invoke('lyrics:server', track),
  },
  subsonic: {
    test: () => ipcRenderer.invoke('subsonic:test'),
    call: (action, params) => ipcRenderer.invoke('subsonic:call', action, params),
  },
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    onMaximized: (cb) => on('win:maximized', cb),
  },
  app: {
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
    info: () => ipcRenderer.invoke('app:info'),
  },
  media: {
    onCommand: (cb) => {
      const unsubs = [
        on('media:playpause', () => cb('playpause')),
        on('media:next', () => cb('next')),
        on('media:previous', () => cb('previous')),
        on('media:stop', () => cb('stop')),
      ];
      return () => unsubs.forEach((fn) => fn());
    },
  },
});
