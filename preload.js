const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  addSymbol: (s) => ipcRenderer.invoke('watchlist:add', s),
  removeSymbol: (s) => ipcRenderer.invoke('watchlist:remove', s),
  fetchQuotes: () => ipcRenderer.invoke('quotes:fetch'),
  search: (q) => ipcRenderer.invoke('symbols:search', q),
  fetchSpark: (s) => ipcRenderer.invoke('spark:fetch', s),
  setPin: (v) => ipcRenderer.invoke('window:pin', v),
  setAutoStart: (v) => ipcRenderer.invoke('autostart:set', v),
  winCtl: (a) => ipcRenderer.send('window:ctl', a),
});
