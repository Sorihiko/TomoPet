/**
 * 桌面角色窗口：透明、无边框、置顶、不进任务栏、不抢焦点；只有角色身上能点（别处点击穿到下面），按住能拖，位置记进设置。
 * 她开口时张嘴；「怎么说」选了气泡时在头顶冒气泡。和 OBS 里那一份用同一套渲染层和皮肤。
 *
 * 限制和本地字幕一样：osu! 用「全屏独占」时任何窗口都盖不上去，这时桌面上看不到她（OBS 里那一份不受影响）。
 *
 * 这个文件不直接 import electron：要用的东西从参数传进来，测试可以塞假的。
 */
import { skinBaseUrl } from '../core/local-files.js';
import { cleanMouthTrack } from '../core/speakable.js';
import { labelLayoutOf, ringFootroom } from '../core/pp-ring-size.js';

/** 窗口比角色大出来的部分：左右留边，顶上留给气泡。 */
const PAD_X = 70;
const HEADROOM = 150;
const MIN_W = 300;
/**
 * 脚下的 pp 地台环（renderer/pp-ring.ts，设置 pet.hud）开着时，窗口底下多留多高给环和那一行字：跟着角色的大小走
 * （core/pp-ring-size.js，和画环的同一套算法）。关着时是 0。
 */
export function footroomFor(manifest, scale, hud, curve = false, layout = 'card') {
  if (!hud) return 0;
  const w = Number(manifest?.hitbox?.w) || Number(manifest?.canvas?.w) || 512;
  return ringFootroom(w, scale, Infinity, curve, layout);
}
/** Ctrl+滚轮：每格乘 / 除 1.1；范围和设置里的滑块一样（core/config.js 的 pet.scale）。 */
const ZOOM_STEP = 1.1;
const SCALE_MIN = 0.1;
const SCALE_MAX = 1.5;

/**
 * @param {object} opts
 * @param {{BrowserWindow:any, screen:any, Menu?:any}} opts.electron
 * @param {() => {enabled:boolean, skin:string, scale:number, hud?:boolean, x:number|null, y:number|null}} opts.config
 * @param {(patch:object) => void} opts.savePosition   记位置 / 开关：传 { x, y } 或 { enabled }
 * @param {(id:string) => object} opts.resolveSkin
 * @param {string} opts.pageUrl
 * @param {string} opts.preload
 * @param {() => void} [opts.onOpenSettings]
 */
export function createPetWindow({ electron, config, savePosition = () => {}, resolveSkin, pageUrl, preload, onOpenSettings = () => {}, log = () => {} } = {}) {
  const { BrowserWindow, screen, Menu } = electron;
  let win = null;
  let ready = false;
  let loaded = null; // 现在窗口里装的是哪套：{ skinId, scale, manifestKey, hud }
  let lastHud = ''; // 上一次发给页面的地台环数据（一样就不重发）
  let lastHudData = null; // 上一次的数据本身：页面刚准备好时补发一次
  let lastCurve = ''; // 上一次发给页面的难度曲线（一样就不重发）
  let lastCurveData = null;
  let lastError = null;
  let fallback = null;
  let dragTimer = null;
  // 「在不在打图」（游戏时刻那边告诉的），窗口重开后补发给新页面。
  let posePlaying = false;
  let dragOffset = null;

  const alive = () => Boolean(win && !win.isDestroyed());

  const hudOn = (cfg) => cfg?.hud !== false;
  // 环上的难度带（设置 pet.hudCurve）：环开着才有
  const curveOn = (cfg) => hudOn(cfg) && cfg?.hudCurve !== false;
  // 难度曲线画成柱子还是墙（设置 pet.hudCurveStyle；2026-11-21 用户要把墙那版留成选项）
  const curveStyle = (cfg) => (cfg?.hudCurveStyle === 'wall' ? 'wall' : 'bars');
  // pp 那块字的样子（pet.hudLayout：card 黑底卡片 / paper 浅色成绩条 / type 只有字 / line 环下面一行 / arc 沿着环）、
  // 「只有字」的字色（pet.hudInk：light / dark）、「572 if FC」显示不显示（pet.hudFc）
  const hudLayout = (cfg) => labelLayoutOf(cfg?.hudLayout);
  const hudInk = (cfg) => (cfg?.hudInk === 'dark' ? 'dark' : 'light');
  const hudFc = (cfg) => cfg?.hudFc !== false;
  function sizeFor(manifest, scale, hud = false, curve = false, layout = 'card') {
    const cw = Number(manifest?.canvas?.w) || 512;
    const ch = Number(manifest?.canvas?.h) || 512;
    return { width: Math.max(MIN_W, Math.round(cw * scale) + PAD_X), height: Math.round(ch * scale) + HEADROOM + footroomFor(manifest, scale, hud, curve, layout) };
  }

  /** 默认位置：主显示器工作区的右下角。存过的位置要是跑到屏幕外面了（换了显示器）也回到这里。 */
  function positionFor(size, cfg) {
    const area = screen.getPrimaryDisplay().workArea;
    const home = { x: area.x + area.width - size.width - 24, y: area.y + area.height - size.height };
    if (typeof cfg.x !== 'number' || typeof cfg.y !== 'number') return home;
    const displays = screen.getAllDisplays?.() ?? [screen.getPrimaryDisplay()];
    const visible = displays.some((display) => {
      const b = display.workArea ?? display.bounds;
      return cfg.x + size.width > b.x + 40 && cfg.x < b.x + b.width - 40 && cfg.y + size.height > b.y + 40 && cfg.y < b.y + b.height - 40;
    });
    return visible ? { x: cfg.x, y: cfg.y } : home;
  }

  function stopDrag(save) {
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = null;
    dragOffset = null;
    if (save && alive()) {
      const [x, y] = win.getPosition();
      try { savePosition({ x, y }); } catch (error) { log('[pet] 记位置失败：', String(error?.message ?? error).slice(0, 100)); }
    }
  }

  function destroy() {
    stopDrag(false);
    const old = win;
    win = null;
    ready = false;
    loaded = null;
    if (old && !old.isDestroyed()) { try { old.destroy(); } catch {} }
  }

  function open(cfg, skin) {
    const size = sizeFor(skin.manifest, cfg.scale, hudOn(cfg), curveOn(cfg), hudLayout(cfg));
    const pos = positionFor(size, cfg);
    const created = new BrowserWindow({
      ...size,
      ...pos,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win = created;
    ready = false;
    loaded = { skinId: skin.id, scale: cfg.scale, manifestKey: JSON.stringify(skin.manifest?.canvas ?? null), hud: hudOn(cfg), curve: curveOn(cfg), curveStyle: curveStyle(cfg), hudLayout: hudLayout(cfg), hudInk: hudInk(cfg), hudFc: hudFc(cfg) };
    lastHud = '';
    lastCurve = '';
    created.setAlwaysOnTop(true, 'screen-saver');
    // 一开始整个窗口点击穿透；鼠标移到她身上时页面会叫我们改回来（forward：穿透时照样把鼠标移动转给页面）。
    created.setIgnoreMouseEvents(true, { forward: true });
    created.setMenu?.(null);
    created.on('closed', () => { if (win === created) { win = null; ready = false; loaded = null; stopDrag(false); } });
    created.webContents.on('render-process-gone', (_event, details) => {
      lastError = { code: 'pet.crashed', error: `桌面角色的页面进程没了（${details?.reason ?? '未知原因'}）`, hint: '在托盘菜单里点一下「显示角色」重新打开；一直这样就换一套皮肤试试。' };
      log(`[pet] ${lastError.error}`);
      if (win === created) destroy();
    });
    created.webContents.once('did-finish-load', () => {
      if (win !== created) return;
      ready = true;
      created.showInactive();
      // 打图中换了皮肤（窗口重开）：新页面取皮肤时（skinForPage）会顺带拿到「在打图」，自己补上 play-on，不靠猜等多久。
    });
    Promise.resolve(created.loadURL(pageUrl)).catch((error) => {
      lastError = { code: 'pet.load-failed', error: `桌面角色的页面打不开：${String(error?.message ?? error).slice(0, 120)}`, hint: '先在项目文件夹里跑一次 npm run build（渲染层没打包时会这样），再重开程序。' };
      log(`[pet] ${lastError.error}`);
      if (win === created) destroy();
    });
  }

  /** 按现在的设置对齐：开 / 关、换皮肤（重开窗口）、改大小（调窗口 + 通知页面）。 */
  function sync() {
    let cfg;
    try { cfg = config(); } catch { return; }
    // 关掉、或者一套能用的皮肤都没有时，上一次「先用了哪套」的提示也作废（复核：原来会和「没有能用的皮肤」同时挂着）。
    if (!cfg?.enabled) { fallback = null; if (alive()) destroy(); return; }
    const skin = resolveSkin(cfg.skin);
    if (!skin?.ok) {
      fallback = null;
      lastError = { code: skin?.code || 'skin.none', error: skin?.error || '没有可用的皮肤', hint: skin?.hint || '在设置「角色」里选一套皮肤。' };
      if (alive()) destroy();
      return;
    }
    fallback = skin.fallback ?? null;
    // 换皮肤、开关地台环：重开窗口（环要的脚下留白是页面加载时定的）
    if (alive() && loaded && (loaded.skinId !== skin.id || loaded.manifestKey !== JSON.stringify(skin.manifest?.canvas ?? null) || loaded.hud !== hudOn(cfg) || loaded.curve !== curveOn(cfg) || loaded.curveStyle !== curveStyle(cfg) || loaded.hudLayout !== hudLayout(cfg) || loaded.hudInk !== hudInk(cfg) || loaded.hudFc !== hudFc(cfg))) destroy();
    if (!alive()) {
      try {
        open(cfg, skin);
        if (lastError?.code !== 'pet.crashed') lastError = null;
      } catch (error) {
        lastError = { code: 'pet.open-failed', error: `桌面角色的窗口开不了：${String(error?.message ?? error).slice(0, 120)}`, hint: '重开程序试试；还不行就先在设置里关掉桌面角色，用字幕。' };
        log(`[pet] ${lastError.error}`);
      }
      return;
    }
    if (loaded.scale !== cfg.scale) {
      // 改大小：脚底的位置不动（窗口往上长），再通知页面换缩放。
      const size = sizeFor(skin.manifest, cfg.scale, hudOn(cfg), curveOn(cfg), hudLayout(cfg));
      const [x, y] = win.getPosition();
      const [w, h] = win.getSize();
      win.setBounds({ x: x + Math.round((w - size.width) / 2), y: y + h - size.height, ...size });
      loaded.scale = cfg.scale;
      // 先告诉页面新的脚下留白，再换缩放（页面 layout 时要扣掉留白）
      if (ready && loaded.hud) win.webContents.send('pet:footroom', footroomFor(skin.manifest, cfg.scale, true, loaded.curve, loaded.hudLayout));
      if (ready) win.webContents.send('pet:scale', cfg.scale);
    }
  }

  /** 页面要皮肤：{ baseUrl, scale }。 */
  function skinForPage() {
    const cfg = config();
    const skin = resolveSkin(cfg.skin);
    if (!skin?.ok) throw new Error(skin?.error || '没有可用的皮肤');
    return { baseUrl: skinBaseUrl(skin.id), scale: cfg.scale, playing: posePlaying, footroom: footroomFor(skin.manifest, cfg.scale, hudOn(cfg), curveOn(cfg), hudLayout(cfg)), curve: curveOn(cfg), curveStyle: curveStyle(cfg), hudLayout: hudLayout(cfg), hudInk: hudInk(cfg), hudFc: hudFc(cfg) };
  }

  /**
   * 脚下的 pp 地台环：{ on, pp, fc（全连能拿多少）, n100, n50, miss, progress }（watch.js 每一帧给；on = 正在打图）。
   * 设置里关了、窗口没开就不发；和上一次一样也不发。
   */
  function hud(data = {}) {
    if (!alive() || !ready || !loaded?.hud) return false;
    const clean = {
      on: data.on === true,
      pp: Math.max(0, Math.round(Number(data.pp) || 0)),
      fc: Math.max(0, Math.round(Number(data.fc) || 0)),
      n100: Math.max(0, Math.round(Number(data.n100) || 0)),
      n50: Math.max(0, Math.round(Number(data.n50) || 0)),
      miss: Math.max(0, Math.round(Number(data.miss) || 0)),
      progress: Number.isFinite(Number(data.progress)) && data.progress !== null ? Math.round(Math.max(0, Math.min(1, Number(data.progress))) * 1000) / 1000 : null,
    };
    lastHudData = clean;
    const key = JSON.stringify(clean);
    if (key === lastHud) return false;
    lastHud = key;
    win.webContents.send('pet:hud', clean);
    return true;
  }

  /**
   * 环上的难度带：这张图的难度曲线（0–1 的数组，core/strain-curve.js；没有就 null）。watch.js 每一帧给，一样就不重发。
   * 设置里关了难度带、窗口没开就不发。
   */
  function hudCurve(curve) {
    const clean = Array.isArray(curve) && curve.length >= 8 ? curve.slice(0, 400).map((v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100) / 100) : null;
    lastCurveData = clean;
    if (!alive() || !ready || !loaded?.curve) return false;
    const key = JSON.stringify(clean);
    if (key === lastCurve) return false;
    lastCurve = key;
    win.webContents.send('pet:hud-curve', clean);
    return true;
  }

  /** 页面的地台环准备好了：把最近一次的数据补发过去（窗口重开时第一帧可能在页面准备好之前就发了，被丢掉；复核发现）。 */
  function hudReady() {
    lastHud = '';
    if (lastHudData && alive() && ready && loaded?.hud) { lastHud = JSON.stringify(lastHudData); win.webContents.send('pet:hud', lastHudData); }
    lastCurve = '';
    if (lastCurveData && alive() && ready && loaded?.curve) { lastCurve = JSON.stringify(lastCurveData); win.webContents.send('pet:hud-curve', lastCurveData); }
  }

  function setInteractive(on) {
    if (!alive()) return;
    if (on) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  }

  /**
   * 按住拖动：记下鼠标和窗口左上角的距离，之后每 16 毫秒跟一次鼠标，直到松手。
   * 用 setBounds 带上按下时的大小，不用 setPosition（2026-11-22 朋友：「长按拖桌宠的位置桌宠会自己跑」）：
   * Windows 开了 125% / 150% 这类缩放时，Electron 的 setPosition 每调一次窗口就被取整变大一点，拖三秒能从 256×408 长到 441×607，
   * 她在窗口里是贴着底边居中的，窗口一长她就离开鼠标往右下跑（--force-device-scale-factor=1.25 复现过；setBounds 拖完大小不变）。
   */
  function dragStart() {
    if (!alive() || dragTimer) return;
    const cursor = screen.getCursorScreenPoint();
    const [x, y] = win.getPosition();
    const [width, height] = win.getSize();
    dragOffset = { x: cursor.x - x, y: cursor.y - y, width, height };
    dragTimer = setInterval(() => {
      if (!alive() || !dragOffset) { stopDrag(false); return; }
      const now = screen.getCursorScreenPoint();
      win.setBounds({ x: now.x - dragOffset.x, y: now.y - dragOffset.y, width: dragOffset.width, height: dragOffset.height });
    }, 16);
    dragTimer.unref?.();
  }

  function recenter() {
    if (!alive()) return false;
    const [width, height] = win.getSize();
    const pos = positionFor({ width, height }, { x: null, y: null });
    win.setBounds({ x: pos.x, y: pos.y, width, height }); // 同上：缩放屏幕上 setPosition 会把窗口撑大
    try { savePosition({ x: null, y: null }); } catch {}
    return true;
  }

  /**
   * Ctrl+滚轮调大小（2026-11-21 用户要的）：每格放大 / 缩小一成，和设置里的滑块同一个范围（10%–150%）、同一个设置项。
   * 存进设置后照常 sync（脚底不动，窗口往上长）；设置窗口开着的话滑块过一会儿自己跟上。
   */
  function zoom(steps) {
    const n = Math.max(-5, Math.min(5, Math.trunc(Number(steps) || 0)));
    if (!n || !alive()) return null;
    let cfg;
    try { cfg = config(); } catch { return null; }
    const now = Number(cfg?.scale) || 0.4;
    const next = Math.round(Math.max(SCALE_MIN, Math.min(SCALE_MAX, now * ZOOM_STEP ** n)) * 100) / 100;
    if (next === now) return now;
    try { savePosition({ scale: next }); } catch (error) { log('[pet] 记大小失败：', String(error?.message ?? error).slice(0, 100)); return now; }
    sync();
    return next;
  }

  function command(cmd) {
    if (alive() && ready) win.webContents.send('pet:command', String(cmd));
  }

  /**
   * 游戏时刻（core/moments.js）：react:<时刻> 换姿势；playing 变了就发 play-on / play-off（打图时专注的姿势）。
   * 只有姿势皮肤（rig: sprite）认这些命令，别的皮肤直接忽略。「在不在打图」记下来，窗口重开（换皮肤）后补发一次。
   */
  function react({ moment = null, playing = posePlaying } = {}) {
    if (playing !== posePlaying) { posePlaying = playing === true; command(posePlaying ? 'play-on' : 'play-off'); }
    if (moment) command(`react:${String(moment).slice(0, 40)}`);
  }

  /** 她开口了：张嘴；bubble 为真时在头顶冒气泡。窗口没开着就什么都不做，返回 false。 */
  function speak({ text = '', durationMs = 0, bubble = false, mouth = '' } = {}) {
    if (!alive() || !ready) return false;
    // 有些全屏 / 无边框程序会把自己重新顶到最上面：她开口时再顶一次。
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.send('pet:speak', { text: String(text).slice(0, 200), durationMs: Math.round(Number(durationMs) || 0), bubble: bubble === true, mouth: cleanMouthTrack(mouth) });
    return true;
  }

  function openMenu() {
    if (!alive() || !Menu) return;
    Menu.buildFromTemplate([
      { label: '眨个眼', click: () => command('blink') },
      { label: '说句话', click: () => command('talk') },
      { type: 'separator' },
      { label: '回到右下角', click: () => recenter() },
      { label: '隐藏角色', click: () => { try { savePosition({ enabled: false }); } catch {} sync(); } },
      { type: 'separator' },
      { label: '打开设置', click: () => onOpenSettings() },
    ]).popup({ window: win });
  }

  function reportFatal(text) {
    lastError = { code: 'pet.skin-failed', error: `桌面角色没画出来：${String(text).slice(0, 160)}`, hint: '这套皮肤可能有问题：在设置「角色」里换一套试试（比如 DeepSeek·女仆装）；自己做的皮肤检查 manifest.json 和图层文件。' };
    log(`[pet] ${lastError.error}`);
  }

  function status() {
    let cfg = null;
    try { cfg = config(); } catch {}
    return { enabled: cfg?.enabled === true, visible: alive() && ready && win.isVisible(), skinId: loaded?.skinId ?? null, fallback, lastError };
  }

  return { sync, status, speak, command, react, recenter, destroy, skinForPage, setInteractive, dragStart, dragEnd: () => stopDrag(true), openMenu, reportFatal, zoom, hud, hudCurve, hudReady };
}
