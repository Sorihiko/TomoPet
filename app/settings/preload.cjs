/** 设置窗口的 preload：页面只能调这一个口子，主进程那边按白名单分发（app/ipc.js）。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  call: (name, payload) => ipcRenderer.invoke('api', { name: String(name), payload }),
});
