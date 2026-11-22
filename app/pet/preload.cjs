/** 桌面角色窗口的 preload：页面（renderer/pet-entry.ts）通过 window.petHost 和主进程说话。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petHost', {
  getSkin: () => ipcRenderer.invoke('pet:get-skin'),
  setInteractive: (on) => ipcRenderer.send('pet:interactive', on === true),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  openMenu: () => ipcRenderer.send('pet:menu'),
  // Ctrl+滚轮调大小：steps 往上滚为正（变大），往下为负
  zoom: (steps) => ipcRenderer.send('pet:zoom', Number(steps) || 0),
  onCommand: (callback) => ipcRenderer.on('pet:command', (_event, command) => callback(command)),
  onSpeak: (callback) => ipcRenderer.on('pet:speak', (_event, line) => callback(line)),
  onScale: (callback) => ipcRenderer.on('pet:scale', (_event, scale) => callback(scale)),
  // 脚下的 pp 地台环：{ on, pp, n100, n50, miss, progress }
  onHud: (callback) => ipcRenderer.on('pet:hud', (_event, data) => callback(data)),
  onFootroom: (callback) => ipcRenderer.on('pet:footroom', (_event, px) => callback(px)),
  // 环上的难度带：这张图的难度曲线（0–1 的数组，或 null）
  onHudCurve: (callback) => ipcRenderer.on('pet:hud-curve', (_event, curve) => callback(curve)),
  hudReady: () => ipcRenderer.send('pet:hud-ready'),
  log: (text) => ipcRenderer.send('pet:log', String(text).slice(0, 300)),
  fatal: (text) => ipcRenderer.send('pet:fatal', String(text).slice(0, 300)),
});
