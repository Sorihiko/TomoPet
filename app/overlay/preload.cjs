/** 字幕窗口的 preload：只给页面两样东西——收一句话、报告放完了。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayHost', {
  onSay: (callback) => ipcRenderer.on('overlay:say', (_event, message) => callback(message)),
  done: (id) => ipcRenderer.send('overlay:done', id),
});
