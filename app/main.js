/**
 * osu-pet · Electron 主进程：把各部分接起来。
 *
 *   core/watch.js（连 tosu、认时刻、过闸、调模型）
 *        ├─ app/overlay-window.js   本地字幕窗口（也负责放声音）
 *        ├─ app/pet-window.js       桌面角色窗口
 *        └─ core/tosu-counter.js    OBS 用的 tosu counter
 *   设置窗口（app/settings/）经 app/api.js 调服务；托盘图标是程序的入口。
 *
 * 数据都在 Electron 的 userData 目录（Windows：%APPDATA%\osu-pet；环境变量 OSU_PET_HOME 可以改），不读别的程序的目录。
 */
import { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, net, protocol, safeStorage, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConfigStore, safeStorageBox } from '../core/config.js';
import { dataDir, dataPath, setDataDir } from '../core/store.js';
import { ORIGIN, SCHEME, resolveLocalUrl } from '../core/local-files.js';
import { createLlm } from '../core/llm.js';
import { createTts } from '../core/tts.js';
import { createOsuApi } from '../core/osu-api.js';
import { createUpdater } from '../core/updater.js';
import { createAutostart } from './autostart.js';
import { createJournal } from '../core/journal.js';
import { createPersona, ensurePersonaFile, personaFile } from '../core/persona.js';
import { createOsuWatchService } from '../core/watch.js';
import { createTosuCounter } from '../core/tosu-counter.js';
import * as skins from '../core/skins.js';
import { createOverlayWindow } from './overlay-window.js';
import { createPetWindow } from './pet-window.js';
import { createApi } from './api.js';
import { findNoTosu, isolateConfig, smokePreflight } from './smoke-guard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LOGO = path.join(ROOT, 'assets', 'logo.png');
const RENDERER_FILES = [path.join(ROOT, 'dist', 'counter-renderer.js'), path.join(ROOT, 'dist', 'pet-renderer.js')];
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();

// 自己的窗口都从 osupet://local/… 加载（为什么：见 core/local-files.js）。必须在 app ready 之前登记。
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
// 程序叫 TomoPet（2026-11-20 用户：「这个项目叫 TomoPet」），但数据目录固定还是 %APPDATA%\osu-pet：
// Electron 默认按程序名定数据目录，改名会让已经填好的 Key、设置、导入的皮肤全「不见」。
export const DATA_FOLDER = 'osu-pet';
export const APP_NAME = 'TomoPet';
app.setName(APP_NAME);
// 数据目录被 OSU_PET_HOME 改到别处时（测试、离屏自检、便携版），Electron 自己的缓存也跟过去，不碰默认的 %APPDATA%\osu-pet。
if (process.env.OSU_PET_HOME) app.setPath('userData', path.join(path.resolve(process.env.OSU_PET_HOME), 'electron'));
else app.setPath('userData', path.join(app.getPath('appData'), DATA_FOLDER));
// 字幕窗口要自己出声：没有人会去点它。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// 离屏自检时关掉 Windows 的「窗口被挡住就当藏起来」：自检的窗口被桌面上别的窗口盖住时，页面变成 hidden，
// 不认鼠标悬停（角色卡探出框那项时过时不过，2026-11-27 查到 visibilityState 是 hidden）。只在自检时关，平时照常省电
if (process.env.OSU_PET_SMOKE) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(main).catch((error) => {
    dialog.showErrorBox(`${APP_NAME} 启动失败`, `${String(error?.stack ?? error).slice(0, 800)}\n\n把这段发给开发者；数据目录：${safeDataDir()}`);
    app.exit(1);
  });
}

function safeDataDir() {
  try { return dataDir(); } catch { return '（读不到）'; }
}

function createLogger() {
  const dir = dataPath('logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'osu-pet.log');
  return (...args) => {
    const line = `${new Date().toISOString()} ${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}`;
    console.log(line);
    try {
      // 日志文件到 1MB 就换一个新的（旧的留一份）。
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${line}\n`);
    } catch {}
  };
}

async function main() {
  // 离屏自检只许碰临时的东西（为什么：见 app/smoke-guard.js）。没给临时数据目录就不跑，免得改掉真的设置。
  const smoke = smokePreflight(process.env);
  if (!smoke.ok) {
    console.error(`[smoke] ${smoke.error}（${smoke.code}）\n${smoke.hint}`);
    app.exit(2);
    return;
  }
  if (!process.env.OSU_PET_HOME) setDataDir(app.getPath('userData'));
  const log = createLogger();
  log(`[app] ${APP_NAME} ${VERSION} 启动，数据目录 ${dataDir()}`);

  // 皮肤的文件只从 resolveSkin 选中的那个文件夹出（skins.skinDirFor），图和清单不会混着来自两份。
  // 页面一载就是二十几张图：选文件夹的结果记 2 秒，不用每张图都把整套皮肤校验一遍。
  const skinDirCache = new Map();
  const skinDir = (id) => {
    const hit = skinDirCache.get(id);
    if (hit && Date.now() - hit.at < 2000) return hit.dir;
    const dir = skins.skinDirFor(id);
    skinDirCache.set(id, { dir, at: Date.now() });
    return dir;
  };
  protocol.handle(SCHEME, (request) => {
    const file = resolveLocalUrl(request.url, { appRoot: ROOT, skinDir });
    if (!file) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href, { bypassCustomProtocolHandlers: true });
  });

  const configStore = createConfigStore({ secretBox: safeStorageBox(safeStorage) });
  ensurePersonaFile();
  // 自检时：tosu 地址换成连不上的、OBS 页面关掉——不连真的 tosu，不往真的 tosu 文件夹里写。
  const cfg = smoke.smoke ? () => isolateConfig(configStore.get()) : () => configStore.get();

  const llm = createLlm({ config: () => cfg().llm });
  // 语音合成：火山 / Breeze 云端，按设置里选的那一家（core/tts.js）。
  const tts = createTts({ config: () => cfg().tts, cacheDir: dataPath('tts-cache') });
  const persona = createPersona(() => cfg().persona);
  const journal = createJournal();

  const overlay = createOverlayWindow({ BrowserWindow, screen, pageUrl: `${ORIGIN}/app/overlay/subtitle.html`, preload: path.join(HERE, 'overlay', 'preload.cjs'), log });
  ipcMain.on('overlay:done', (_event, id) => overlay.done(id));

  let openSettings = () => {};
  let refreshTray = () => {};
  const pet = createPetWindow({
    electron: { BrowserWindow, screen, Menu },
    config: () => cfg().pet,
    savePosition: (patch) => { configStore.save({ pet: patch }); refreshTray(); },
    resolveSkin: skins.resolveSkin,
    pageUrl: `${ORIGIN}/app/pet/index.html`,
    preload: path.join(HERE, 'pet', 'preload.cjs'),
    onOpenSettings: () => openSettings(),
    log,
  });
  const fromOurPage = (event) => String(event.senderFrame?.url ?? '').startsWith(`${ORIGIN}/app/`);
  ipcMain.handle('pet:get-skin', (event) => { if (!fromOurPage(event)) throw new Error('forbidden'); return pet.skinForPage(); });
  ipcMain.on('pet:interactive', (event, on) => { if (fromOurPage(event)) pet.setInteractive(on === true); });
  ipcMain.on('pet:drag-start', (event) => { if (fromOurPage(event)) pet.dragStart(); });
  ipcMain.on('pet:drag-end', (event) => { if (fromOurPage(event)) pet.dragEnd(); });
  ipcMain.on('pet:menu', (event) => { if (fromOurPage(event)) pet.openMenu(); });
  ipcMain.on('pet:zoom', (event, steps) => { if (fromOurPage(event)) pet.zoom(steps); });
  ipcMain.on('pet:hud-ready', (event) => { if (fromOurPage(event)) pet.hudReady(); });
  ipcMain.on('pet:log', (event, text) => { if (fromOurPage(event)) log(`[pet] ${text}`); });
  ipcMain.on('pet:fatal', (event, text) => { if (fromOurPage(event)) pet.reportFatal(text); });

  const counter = createTosuCounter({
    config: () => { const c = cfg(); return { enabled: c.counter.enabled, tosuDir: c.counter.tosuDir, skinId: c.pet.skin, tosuUrl: c.watch.url }; },
    resolveSkin: skins.resolveSkin,
    // 自检时也不去找正在跑的 tosu.exe（OBS 页面另用 smoke.js 里的假 tosu 测）。
    findTosu: smoke.smoke ? findNoTosu : undefined,
    log,
  });

  // osu! 官网（查谱面的玩家标签）：用户自己的 OAuth 应用，没填就不查（core/osu-api.js）。自检时不连官网。
  const osuApi = smoke.smoke ? null : createOsuApi({ config: () => cfg().osuApi, cacheFile: dataPath('osu-tags.json'), log });
  const service = createOsuWatchService({ config: cfg, persona, llm, tts, overlay, pet, counter, journal, osuApi, log });

  // 设置变了：各处对齐一遍（连接、桌面角色、OBS 里的皮肤、托盘菜单）。
  const onConfigChanged = () => {
    service.sync();
    pet.sync();
    counter.sync().catch(() => {});
    refreshTray();
  };

  const autostart = createAutostart({ app });
  // 自动更新（core/updater.js）：GitHub Releases 有新版本时提示，一键下载、退出、盖文件、重开。走 electron 的 net（系统代理）。
  // 自检时不查（不连网）。有新版本时托盘菜单多一条，Windows 右下角冒一次提示。
  let tray = null;
  let notifiedVersion = '';
  let lastPhase = null;
  const updater = createUpdater({
    currentVersion: VERSION,
    fetchImpl: (url, init) => net.fetch(url, init),
    tempDir: app.getPath('temp'),
    exePath: process.execPath,
    isPackaged: app.isPackaged,
    logFile: path.join(dataPath('logs'), 'osu-pet.log'),
    quit: () => app.quit(),
    enabled: () => !smoke.smoke && cfg().update.autoCheck !== false,
    onChange: (st) => {
      refreshTray();
      const failedNow = lastPhase && !st.phase && st.error;
      lastPhase = st.phase;
      if (!tray) return;
      // 点了「更新」但没装上：冒一句（不管开没开自动检查，是用户自己点的）
      if (failedNow) {
        try { tray.displayBalloon({ title: `${APP_NAME} 更新没装上`, content: `${st.error.error}。${st.error.hint}`, iconType: 'warning' }); } catch {}
        return;
      }
      // 有新版本的提示只在开着「自动检查更新」时冒（复核发现：关掉了手动查也会冒）
      if (st.available && st.latest && st.latest.version !== notifiedVersion && cfg().update.autoCheck !== false) {
        notifiedVersion = st.latest.version;
        try { tray.displayBalloon({ title: `${APP_NAME} 有新版本 ${st.latest.version}`, content: '右键托盘图标点「更新」，或者在设置「高级」里更新。', iconType: 'info' }); } catch {}
      }
    },
    log,
  });
  const api = createApi({
    configStore, service, llm, tts, overlay, pet, skins, autostart, osuApi, updater,
    shell: {
      openPath: async (target) => { const failed = await shell.openPath(target); if (failed) throw new Error(failed); },
      pickFolder: async (title) => { const result = await dialog.showOpenDialog({ title, properties: ['openDirectory'] }); return result.canceled ? '' : result.filePaths[0] ?? ''; },
      copyText: (text) => clipboard.writeText(text),
      openExternal: (url) => shell.openExternal(url),
    },
    info: { version: VERSION, dataDir: dataDir(), personaFile: personaFile(), rendererBuilt: () => RENDERER_FILES.every((file) => fs.existsSync(file)), logoFound: () => fs.existsSync(LOGO), logoUrl: `${ORIGIN}/assets/logo.png` },
    onConfigChanged,
    log,
  });

  // ── 设置窗口 ──────────────────────────────────────────────────────────────
  // logo 不在（assets/logo.png 被删了）：托盘用空图标，设置窗口「下一步」里会提示。
  const iconImage = () => (fs.existsSync(LOGO) ? nativeImage.createFromPath(LOGO) : nativeImage.createEmpty());
  let settingsWin = null;
  openSettings = ({ quiet = false } = {}) => {
    if (settingsWin && !settingsWin.isDestroyed()) { if (!quiet) { settingsWin.show(); settingsWin.focus(); } return settingsWin; }
    settingsWin = new BrowserWindow({
      width: 1000, height: 780, minWidth: 760, minHeight: 560, show: !quiet, title: `${APP_NAME} 设置`, icon: iconImage(), backgroundColor: '#141415', autoHideMenuBar: true,
      // 不用 Windows 自带的标题栏（2026-11-21 用户：「感觉好丑」）：页面顶上自己画一条深色的（settings.css .titlebar），
      // 右上角最小化 / 最大化 / 关闭还是系统的（贴靠布局、双击最大化照常），只是换成同样的深色。
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#0f0f10', symbolColor: '#a1a1a6', height: 40 }, // 和设置页标题栏同色（2026-11-22 设置页重新设计）
      webPreferences: { preload: path.join(HERE, 'settings', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    settingsWin.setMenu(null);
    settingsWin.on('closed', () => { settingsWin = null; });
    // 页面里的链接不在这个窗口里开，也不新开窗口。
    settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    settingsWin.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${ORIGIN}/app/settings/`)) event.preventDefault(); });
    settingsWin.loadURL(`${ORIGIN}/app/settings/index.html`).catch((error) => log('[app] 设置窗口打不开：', String(error?.message ?? error)));
    return settingsWin;
  };
  ipcMain.handle('api', (event, request) => {
    if (!String(event.senderFrame?.url ?? '').startsWith(`${ORIGIN}/app/settings/`)) return { ok: false, code: 'api.forbidden', error: '只有设置窗口能调这个接口', hint: '重开程序。' };
    return api.call(request?.name, request?.payload);
  });

  // ── 托盘 ──────────────────────────────────────────────────────────────────
  tray = new Tray(iconImage().resize({ width: 32, height: 32 }));
  tray.setToolTip(`${APP_NAME} · 看你打 osu!`);
  refreshTray = () => {
    let now;
    try { now = cfg(); } catch { return; }
    if (!tray) return;
    const up = updater.status();
    const updateItems = up.available && up.latest
      ? [{ label: up.phase ? `正在更新到 ${up.latest.version}…` : `更新到 ${up.latest.version}`, enabled: !up.phase && up.canInstall && up.latest.hasAsset, click: () => { try { updater.startInstall(); } catch { openSettings(); } } }, { type: 'separator' }]
      : [];
    tray.setContextMenu(Menu.buildFromTemplate([
      ...updateItems,
      { label: '打开设置', click: () => openSettings() },
      { type: 'separator' },
      { label: '看你打 osu!', type: 'checkbox', checked: now.watch.enabled, click: (item) => { configStore.save({ watch: { enabled: item.checked } }); onConfigChanged(); } },
      { label: '显示角色', type: 'checkbox', checked: now.pet.enabled, click: (item) => { configStore.save({ pet: { enabled: item.checked } }); onConfigChanged(); } },
      { label: '角色回到右下角', enabled: now.pet.enabled, click: () => pet.recenter() },
      { type: 'separator' },
      { label: '让她说一句试试', click: () => { api.call('watch.test').then((result) => { if (!result.ok) { openSettings(); } }); } },
      { label: '打开数据文件夹', click: () => api.call('data.open') },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
  };
  refreshTray();
  tray.on('click', () => openSettings());
  tray.on('double-click', () => openSettings());

  app.on('second-instance', () => openSettings());
  // 这是个托盘程序：窗口都关了也不退出。
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    try { updater.stop(); } catch {}
    try { service.stop(); } catch {}
    try { pet.destroy(); } catch {}
    try { overlay.stop(); } catch {}
    log('[app] 退出');
  });

  service.start();
  pet.sync();
  updater.start();

  // 打开程序就显示设置窗口（2026-11-21 用户：「打开应用应该显示这个窗口」）。关掉窗口它照样在托盘里看着。
  // 带 --hidden 启动时只待在托盘（以后加开机自启用）；还没填模型的 Key 时不管怎样都打开。
  if (!process.argv.includes('--hidden') || !llm.ready().ok) openSettings();

  // 离屏自检（开发用）：OSU_PET_SMOKE=<输出文件夹> 时把几个窗口截图存下来然后退出，见 app/smoke.js。
  if (process.env.OSU_PET_SMOKE) {
    const { runSmoke } = await import('./smoke.js');
    runSmoke({ outDir: process.env.OSU_PET_SMOKE, app, BrowserWindow, openSettings, pet, overlay, api, log }).catch((error) => { log('[smoke] 失败：', String(error?.stack ?? error)); app.exit(1); });
  }
}
