/**
 * 窗口管理（app/overlay-window.js、app/pet-window.js）和本地文件协议（core/local-files.js）。
 * 不起 Electron：用假的 BrowserWindow / screen，钉住「不抢焦点、点击穿透、位置、失败码」这些容易漏的地方。
 * 真窗口画出来的样子由离屏自检（app/smoke.js）截图确认。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOverlayWindow } from '../app/overlay-window.js';
import { createPetWindow, footroomFor } from '../app/pet-window.js';
import { ORIGIN, resolveLocalUrl, skinBaseUrl } from '../core/local-files.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假的 Electron：记下每个窗口的选项和调用。 */
function fakeElectron({ loadFails = false, cursor = { x: 500, y: 500 } } = {}) {
  const windows = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.calls = [];
      this.sent = [];
      this.destroyed = false;
      this.visible = false;
      this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 100, height: options.height ?? 100 };
      this.listeners = {};
      const web = { listeners: {}, once: (type, fn) => { web.listeners[type] = fn; }, on: (type, fn) => { web.listeners[type] = fn; }, send: (channel, payload) => this.sent.push([channel, payload]) };
      this.webContents = web;
      windows.push(this);
    }
    on(type, fn) { this.listeners[type] = fn; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    destroy() { this.destroyed = true; this.listeners.closed?.(); }
    showInactive() { this.visible = true; this.calls.push('showInactive'); }
    show() { this.visible = true; this.calls.push('show'); }
    hide() { this.visible = false; this.calls.push('hide'); }
    focus() { this.calls.push('focus'); }
    setAlwaysOnTop(flag, level) { this.calls.push(`top:${flag}:${level}`); }
    setIgnoreMouseEvents(flag, options) { this.calls.push(`ignore:${flag}:${options?.forward === true}`); }
    setMenu() {}
    setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; }
    getPosition() { return [this.bounds.x, this.bounds.y]; }
    setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; }
    getSize() { return [this.bounds.width, this.bounds.height]; }
    loadURL(url) { this.url = url; return loadFails ? Promise.reject(new Error('ERR_FILE_NOT_FOUND')) : Promise.resolve(); }
    finishLoad() { this.webContents.listeners['did-finish-load']?.(); }
  }
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const screen = { getPrimaryDisplay: () => display, getAllDisplays: () => [display], getCursorScreenPoint: () => ({ ...cursor }) };
  const menus = [];
  const Menu = { buildFromTemplate: (template) => { menus.push(template); return { popup: () => {} }; } };
  return { BrowserWindow: FakeWindow, screen, Menu, windows, menus, cursor };
}

// ── 本地文件协议 ─────────────────────────────────────────────────────────────
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-local-'));
  const userSkins = path.join(sandbox, '皮肤');
  fs.mkdirSync(path.join(userSkins, 'mine', 'art'), { recursive: true });
  fs.writeFileSync(path.join(userSkins, 'mine', 'manifest.json'), '{}');
  fs.writeFileSync(path.join(userSkins, 'mine', 'art', '图 1.png'), 'P');
  fs.writeFileSync(path.join(sandbox, 'secret.txt'), 'S');
  const bundledSkins = path.join(sandbox, 'skins-bundled');
  fs.mkdirSync(path.join(bundledSkins, 'crosspet-x'), { recursive: true });
  fs.writeFileSync(path.join(bundledSkins, 'crosspet-x', 'manifest.json'), '{}');
  const roots = { appRoot: ROOT, skinRoots: [userSkins, bundledSkins] };
  const resolve = (url) => resolveLocalUrl(url, roots);
  assert.equal(resolve(`${ORIGIN}/app/settings/index.html`), path.join(ROOT, 'app', 'settings', 'index.html'));
  assert.equal(resolve(`${ORIGIN}/app/overlay/subtitle.html?x=1`), path.join(ROOT, 'app', 'overlay', 'subtitle.html'));
  assert.equal(resolve(`${ORIGIN}/skin/crosspet-x/manifest.json`), path.join(bundledSkins, 'crosspet-x', 'manifest.json'), '程序自带的皮肤');
  assert.equal(resolve(`${ORIGIN}/skin/mine/art/${encodeURIComponent('图 1.png')}`), path.join(userSkins, 'mine', 'art', '图 1.png'), '用户皮肤，中文文件名');
  assert.equal(skinBaseUrl('mine'), 'osupet://local/skin/mine/');
  // 不认识的、越界的、不存在的：一律不给。
  for (const bad of [
    `${ORIGIN}/app/../package.json`, `${ORIGIN}/app/..%2F..%2Fpackage.json`, `${ORIGIN}/core/config.js`, `${ORIGIN}/package.json`, `${ORIGIN}/node_modules/electron/package.json`,
    `${ORIGIN}/skin/mine/..%2F..%2Fsecret.txt`, `${ORIGIN}/skin/..%2F/secret.txt`, `${ORIGIN}/skin/mine/`, `${ORIGIN}/skin/nope/manifest.json`, `${ORIGIN}/app/settings/`, `${ORIGIN}/app/nope.html`,
    'osupet://other/app/settings/index.html', 'file:///C:/Windows/win.ini', 'https://example.com/app/settings/index.html', 'not a url', '',
  ]) assert.equal(resolve(bad), '', bad);
  // 给了 skinDir(id)（程序里就这样用）：只在它选中的文件夹里找，图和清单不会一个文件一个文件地混着来自两份。
  {
    const bundled = path.join(sandbox, 'bundled');
    fs.mkdirSync(path.join(bundled, 'mine', 'art'), { recursive: true });
    fs.writeFileSync(path.join(bundled, 'mine', 'art', 'only-in-bundled.png'), 'B');
    const pick = (id) => (id === 'mine' ? path.join(bundled, 'mine') : '');
    const viaDir = (url) => resolveLocalUrl(url, { appRoot: ROOT, skinRoots: [userSkins], skinDir: pick });
    assert.equal(viaDir(`${ORIGIN}/skin/mine/art/only-in-bundled.png`), path.join(bundled, 'mine', 'art', 'only-in-bundled.png'));
    assert.equal(viaDir(`${ORIGIN}/skin/mine/art/${encodeURIComponent('图 1.png')}`), '', '不回头去别的文件夹找');
    for (const bad of [`${ORIGIN}/skin/mine/..%2F..%2Fsecret.txt`, `${ORIGIN}/skin/nope/manifest.json`, `${ORIGIN}/skin/mine/`]) assert.equal(viaDir(bad), '', bad);
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
}

// ── 字幕窗口 ─────────────────────────────────────────────────────────────────
{
  const e = fakeElectron();
  const logs = [];
  const overlay = createOverlayWindow({ BrowserWindow: e.BrowserWindow, screen: e.screen, pageUrl: 'osupet://local/app/overlay/subtitle.html', preload: 'PRELOAD', log: (...a) => logs.push(a.join(' ')) });
  assert.deepEqual(overlay.status(), { running: false, ready: false, lastError: null }, '没说话时不开窗口');
  assert.equal(overlay.say({ text: 'LINE_A', ms: 3000 }).ok, true);
  assert.equal(e.windows.length, 1, '要说话时才开');
  const win = e.windows[0];
  // 不能抢焦点、不能挡鼠标：正在打的游戏不能被切走。
  const o = win.options;
  assert.deepEqual([o.focusable, o.transparent, o.frame, o.skipTaskbar, o.show, o.alwaysOnTop, o.resizable], [false, true, false, true, false, true, false]);
  assert.deepEqual([o.webPreferences.contextIsolation, o.webPreferences.nodeIntegration, o.webPreferences.sandbox, o.webPreferences.preload], [true, false, true, 'PRELOAD'], '页面碰不到 Node');
  assert.ok(win.calls.includes('ignore:true:false') && win.calls.includes('top:true:screen-saver'));
  assert.equal(win.url, 'osupet://local/app/overlay/subtitle.html');
  assert.deepEqual(win.sent, [], '页面还没好：先排着');
  overlay.say({ text: 'LINE_B', audio: Buffer.from('WAV'), ms: 1234.6, hidden: true });
  win.finishLoad();
  assert.deepEqual(win.sent.map(([channel, m]) => [channel, m.id, m.text, m.ms, m.hidden, m.audio]), [['overlay:say', 1, 'LINE_A', 3000, false, ''], ['overlay:say', 2, 'LINE_B', 1235, true, Buffer.from('WAV').toString('base64')]]);
  assert.equal(win.sent[0][1].scale, 1, '1080p 上不缩放');
  assert.ok(win.calls.includes('showInactive') && !win.calls.includes('show') && !win.calls.includes('focus'), '只用 showInactive');
  assert.deepEqual([win.bounds.width, win.bounds.height, win.bounds.x, win.bounds.y], [1613, 200, 154, 804], '屏幕下方居中');
  // 放完了才藏；旧的一句的 done 不能把新的一句收掉。
  overlay.done(1);
  assert.equal(win.visible, true);
  overlay.done(2);
  assert.equal(win.visible, false);
  overlay.say({ text: 'LINE_C' });
  assert.deepEqual([e.windows.length, win.visible, win.sent.at(-1)[1].ms], [1, true, 4000], '留着复用');
  // 页面进程没了：记下来（带下一步），下一句重新开。
  win.webContents.listeners['render-process-gone'](null, { reason: 'crashed' });
  const failure = overlay.status().lastError;
  assert.deepEqual([failure.code, failure.error.includes('crashed'), Boolean(failure.hint), overlay.status().running], ['overlay.failed', true, true, false]);
  overlay.say({ text: 'LINE_D' });
  assert.deepEqual([e.windows.length, overlay.status().lastError], [2, null], '说成了就清掉上一次的错误');
  overlay.stop();
  assert.deepEqual([e.windows[1].destroyed, overlay.status().running], [true, false]);
  overlay.stop();
  // 窗口根本建不出来：抛带 code / hint 的错（watch.js 会记成「上一次没说成」）。
  const broken = createOverlayWindow({ BrowserWindow: class { constructor() { throw new Error('GPU_DEAD'); } }, screen: e.screen, pageUrl: 'x', preload: 'p' });
  assert.throws(() => broken.say({ text: 'X' }), (error) => error.code === 'overlay.failed' && error.message.includes('GPU_DEAD') && Boolean(error.hint));
  // 页面打不开：记下来。
  const bad = fakeElectron({ loadFails: true });
  const failing = createOverlayWindow({ BrowserWindow: bad.BrowserWindow, screen: bad.screen, pageUrl: 'x', preload: 'p' });
  failing.say({ text: 'X' });
  await tick();
  assert.equal(failing.status().lastError.code, 'overlay.failed');
  // 页面本身：台词只当文字放进去；不用 Node。
  const page = fs.readFileSync(path.join(ROOT, 'app', 'overlay', 'subtitle.html'), 'utf8');
  assert.ok(page.includes('textContent') && !page.includes('innerHTML') && !page.includes('require('));
}

// ── 桌面角色窗口 ─────────────────────────────────────────────────────────────
{
  const e = fakeElectron();
  // 先关掉脚下的 pp 地台环（窗口尺寸按原来的算；环的测试在后面）
  const cfg = { enabled: true, skin: 'deepseek', scale: 0.5, hud: false, x: null, y: null };
  const saved = [];
  const skinsById = { deepseek: { ok: true, id: 'deepseek', manifest: { canvas: { w: 512, h: 512 } }, fallback: null }, big: { ok: true, id: 'big', manifest: { canvas: { w: 1280, h: 1280 } }, fallback: null } };
  let resolveSkin = (id) => skinsById[id] ?? { ...skinsById.deepseek, fallback: { code: 'skin.not-found', error: `没找到皮肤「${id}」，先用「DeepSeek」`, hint: '重新选一套' } };
  let settingsOpened = 0;
  const pet = createPetWindow({ electron: e, config: () => cfg, savePosition: (patch) => { saved.push(patch); Object.assign(cfg, patch); }, resolveSkin: (id) => resolveSkin(id), pageUrl: 'osupet://local/app/pet/index.html', preload: 'PRELOAD', onOpenSettings: () => { settingsOpened += 1; } });
  assert.deepEqual(pet.status(), { enabled: true, visible: false, skinId: null, fallback: null, lastError: null });
  assert.equal(pet.speak({ text: 'x' }), false, '窗口没开时开口什么都不做');
  pet.sync();
  const win = e.windows[0];
  const o = win.options;
  assert.deepEqual([o.focusable, o.transparent, o.frame, o.skipTaskbar, o.show, o.alwaysOnTop], [false, true, false, true, false, true]);
  assert.deepEqual([o.webPreferences.contextIsolation, o.webPreferences.nodeIntegration, o.webPreferences.sandbox], [true, false, true]);
  assert.ok(win.calls.includes('ignore:true:true'), '一开始整个窗口点击穿透（鼠标移动照样转给页面）');
  assert.deepEqual([o.width, o.height], [326, 406], '窗口 = 角色大小 + 左右留边 + 顶上给气泡的地方');
  assert.deepEqual([o.x, o.y], [1920 - 326 - 24, 1040 - 406], '默认在主显示器工作区的右下角');
  assert.equal(pet.status().visible, false, '页面还没好：不算显示');
  win.finishLoad();
  assert.ok(win.calls.includes('showInactive') && !win.calls.includes('focus'));
  assert.deepEqual([pet.status().visible, pet.status().skinId], [true, 'deepseek']);
  assert.deepEqual(pet.skinForPage(), { baseUrl: 'osupet://local/skin/deepseek/', scale: 0.5, playing: false, footroom: 0, curve: false, curveStyle: 'bars', hudLayout: 'card', hudInk: 'light', hudFc: true });
  // 游戏时刻：换姿势的命令；「在不在打图」只在变的时候发；页面取皮肤时顺带拿到（窗口打图中重开后自己补上）。
  pet.react({ moment: 'start', playing: true });
  assert.deepEqual(win.sent.slice(-2), [['pet:command', 'play-on'], ['pet:command', 'react:start']]);
  pet.react({ moment: 'combo', playing: true });
  assert.deepEqual(win.sent.at(-1), ['pet:command', 'react:combo'], '没变就不重发 play-on');
  assert.equal(pet.skinForPage().playing, true);
  pet.react({ moment: null, playing: false });
  assert.deepEqual(win.sent.at(-1), ['pet:command', 'play-off']);
  // 她开口：张嘴 + 气泡；太长的截断。
  assert.equal(pet.speak({ text: '这把稳啊', durationMs: 1800.4, bubble: true }), true);
  assert.deepEqual(win.sent.at(-1), ['pet:speak', { text: '这把稳啊', durationMs: 1800, bubble: true, mouth: '' }]);
  // 口型轨只留 0/1/2（2026-11-21 说话时动嘴）。
  pet.speak({ text: '嗯', durationMs: 600, mouth: '0122x<b>9' });
  assert.equal(win.sent.at(-1)[1].mouth, '0122');
  pet.speak({ text: 'x'.repeat(500) });
  assert.deepEqual([win.sent.at(-1)[1].text.length, win.sent.at(-1)[1].bubble], [200, false]);
  // 鼠标在不在她身上。
  pet.setInteractive(true);
  assert.equal(win.calls.at(-1), 'ignore:false:false');
  pet.setInteractive(false);
  assert.equal(win.calls.at(-1), 'ignore:true:true');
  // 拖动：跟着鼠标走，松手记位置。
  pet.dragStart();
  e.cursor.x += 120; e.cursor.y -= 60;
  await tick(60);
  pet.dragEnd();
  assert.deepEqual(win.getPosition(), [o.x + 120, o.y - 60]);
  assert.deepEqual(saved.at(-1), { x: o.x + 120, y: o.y - 60 }, '位置记进设置');
  // 右键菜单 → 隐藏角色 / 打开设置 / 回到右下角。
  pet.openMenu();
  const menu = e.menus.at(-1);
  assert.deepEqual(menu.filter((item) => item.label).map((item) => item.label), ['眨个眼', '说句话', '回到右下角', '隐藏角色', '打开设置']);
  menu.find((item) => item.label === '眨个眼').click();
  assert.deepEqual(win.sent.at(-1), ['pet:command', 'blink']);
  menu.find((item) => item.label === '打开设置').click();
  assert.equal(settingsOpened, 1);
  assert.equal(pet.recenter(), true);
  assert.deepEqual([win.getPosition(), saved.at(-1)], [[o.x, o.y], { x: null, y: null }]);
  // 改大小：脚底不动（窗口往上长），通知页面。
  cfg.scale = 1;
  pet.sync();
  assert.deepEqual([e.windows.length, win.bounds.width, win.bounds.height, win.bounds.y + win.bounds.height], [1, 582, 662, 1040]);
  assert.deepEqual(win.sent.at(-1), ['pet:scale', 1]);
  // Ctrl+滚轮（2026-11-21）：每格乘 / 除 1.1，存进设置、窗口跟着变；到 150% / 10% 就停；不合格的步数不理。
  assert.equal(pet.zoom(1), 1.1);
  assert.deepEqual([saved.at(-1), win.sent.at(-1), win.bounds.y + win.bounds.height], [{ scale: 1.1 }, ['pet:scale', 1.1], 1040]);
  assert.equal(pet.zoom(-2), 0.91);
  assert.equal(pet.zoom(99), 1.47, '一次最多 5 格');
  assert.equal(pet.zoom(3), 1.5);
  const savedCount = saved.length;
  assert.equal(pet.zoom(1), 1.5, '到顶了不再存');
  assert.equal(saved.length, savedCount);
  assert.equal(pet.zoom('x'), null);
  cfg.scale = 0.1;
  assert.equal(pet.zoom(-1), 0.1);
  cfg.scale = 1; pet.sync();
  // 换皮肤：重开窗口。
  cfg.skin = 'big'; cfg.scale = 0.3;
  pet.sync();
  assert.deepEqual([e.windows.length, win.destroyed, e.windows[1].options.width, e.windows[1].options.height], [2, true, 454, 534]);
  // 存的位置跑到屏幕外面了（换了显示器）：回到右下角。
  cfg.x = 9000; cfg.y = 9000; cfg.skin = 'deepseek';
  pet.sync();
  assert.deepEqual([e.windows[2].options.x, e.windows[2].options.y], [1920 - e.windows[2].options.width - 24, 1040 - e.windows[2].options.height]);
  // 脚下的 pp 地台环（2026-11-21）：关着时不发数据；打开 → 重开窗口、底下多留 FOOT_ROOM、页面知道留了多少
  const winsBefore = e.windows.length;
  assert.equal(pet.hud({ on: true, pp: 100 }), false, '环关着：不发');
  assert.equal(pet.skinForPage().footroom, 0);
  cfg.hud = true; cfg.hudCurve = false; cfg.x = null; cfg.y = null; // 先不画难度带（后面单测）
  pet.sync();
  const hudWin = e.windows.at(-1);
  assert.equal(e.windows.length, winsBefore + 1, '开关环要重开窗口');
  const M512 = { canvas: { w: 512, h: 512 } };
  const room = footroomFor(M512, cfg.scale, true);
  assert.ok(room >= 30, `留白 ${room}`);
  assert.equal(hudWin.options.height, e.windows[winsBefore - 1].options.height + room, '底下多留一截给环和字');
  assert.equal(pet.skinForPage().footroom, room);
  // 留白跟着角色大小走（复核发现：固定 46 像素时放大到 1.5 环会被切掉、字压到环上）
  assert.ok(footroomFor(M512, 1.5, true) > footroomFor(M512, 0.4, true));
  assert.equal(footroomFor(M512, 1, false), 0);
  assert.equal(pet.hud({ on: true, pp: 1 }), false, '页面还没好：不发');
  hudWin.finishLoad();
  assert.equal(pet.hud({ on: true, pp: 496.4, fc: 612.6, n100: 7, n50: 0, miss: 1, progress: 0.4567 }), true);
  assert.deepEqual(hudWin.sent.at(-1), ['pet:hud', { on: true, pp: 496, fc: 613, n100: 7, n50: 0, miss: 1, progress: 0.457 }]);
  assert.equal(pet.hud({ on: true, pp: 496, fc: 613, n100: 7, n50: 0, miss: 1, progress: 0.4567 }), false, '一样的不重发');
  assert.equal(pet.hud({ on: false, pp: -3, progress: null }), true);
  assert.deepEqual(hudWin.sent.at(-1)[1], { on: false, pp: 0, fc: 0, n100: 0, n50: 0, miss: 0, progress: null }, '不在打图：收起来；数清理过');
  assert.equal(pet.hud({ on: true, progress: 7 }) && hudWin.sent.at(-1)[1].progress, 1, '进度夹在 0–1');
  // 页面的环准备好了：把最近一次的数据补发过去（窗口重开时第一帧可能被丢掉；复核发现）
  const sentBefore = hudWin.sent.length;
  pet.hudReady();
  assert.deepEqual([hudWin.sent.length, hudWin.sent.at(-1)[0]], [sentBefore + 1, 'pet:hud']);
  // Ctrl+滚轮改大小：留白跟着新的大小，先告诉页面留白再换缩放
  pet.zoom(1);
  assert.equal(hudWin.bounds.height, Math.round(512 * cfg.scale) + 150 + footroomFor(M512, cfg.scale, true));
  assert.deepEqual(hudWin.sent.slice(-2).map((m) => m[0]), ['pet:footroom', 'pet:scale']);
  assert.equal(hudWin.sent.at(-2)[1], footroomFor(M512, cfg.scale, true));
  assert.equal(pet.hudCurve([0.1, 0.5, 1, 0.2, 0.3, 0.4, 0.9, 0.8]), false, '难度带关着：不发曲线');
  // 环上的难度柱（2026-11-21）：打开 → 重开窗口；曲线一样不重发；页面准备好时补发
  cfg.hudCurve = true;
  pet.sync();
  const curveWin = e.windows.at(-1);
  assert.equal(hudWin.destroyed, true, '开关难度带要重开窗口');
  assert.equal(pet.skinForPage().curve, true);
  assert.equal(footroomFor(M512, cfg.scale, true, true), footroomFor(M512, cfg.scale, true), '难度柱往上长：不多占脚下');
  assert.equal(curveWin.options.height, Math.round(512 * cfg.scale) + 150 + footroomFor(M512, cfg.scale, true, true));
  curveWin.finishLoad();
  const curve = Array.from({ length: 12 }, (_, i) => i / 11);
  assert.equal(pet.hudCurve(curve), true);
  assert.deepEqual(curveWin.sent.at(-1), ['pet:hud-curve', curve.map((v) => Math.round(v * 100) / 100)]);
  assert.equal(pet.hudCurve(curve), false, '一样的不重发');
  assert.equal(pet.hudCurve(null), true, '换到没有曲线的图：发 null，带子收起来');
  assert.equal(pet.hudCurve([1, 2]), false, '点太少当没有（和上一次的 null 一样）');
  pet.hudCurve(curve);
  const before2 = curveWin.sent.length;
  pet.hudReady();
  assert.ok(curveWin.sent.slice(before2).some((m) => m[0] === 'pet:hud-curve'), '页面准备好：补发曲线');
  cfg.hud = false;
  pet.sync();
  assert.equal(curveWin.destroyed, true, '关掉环也重开窗口');
  // 要的皮肤没有：退回默认那套，状态里说清楚。
  cfg.skin = 'gone'; cfg.x = null; cfg.y = null;
  pet.sync();
  assert.deepEqual([pet.status().fallback.code, Boolean(pet.status().fallback.hint)], ['skin.not-found', true]);
  // 页面说皮肤画不出来：记成带下一步的错误。
  pet.reportFatal('读不到皮肤清单 manifest.json（HTTP 404）');
  assert.deepEqual([pet.status().lastError.code, pet.status().lastError.error.includes('404'), pet.status().lastError.hint.includes('换一套')], ['pet.skin-failed', true, true]);
  // 关掉：窗口收掉；菜单里「隐藏角色」走的也是这条路。
  cfg.enabled = false;
  pet.sync();
  assert.deepEqual([e.windows.at(-1).destroyed, pet.status().enabled, pet.status().visible], [true, false, false]);
  cfg.enabled = true;
  pet.sync();
  e.windows.at(-1).finishLoad();
  pet.openMenu();
  e.menus.at(-1).find((item) => item.label === '隐藏角色').click();
  assert.deepEqual([cfg.enabled, e.windows.at(-1).destroyed], [false, true]);
  // 一套能用的皮肤都没有：不开窗口，报错带下一步。
  cfg.enabled = true;
  cfg.skin = 'gone';
  pet.sync();
  assert.equal(pet.status().fallback.code, 'skin.not-found', '先在用退回的那套');
  resolveSkin = () => ({ ok: false, code: 'skin.none', error: '一套能用的皮肤都没有', hint: '放 art/crosspet/' });
  const before = e.windows.length;
  pet.sync();
  assert.deepEqual([e.windows.length, pet.status().lastError.code, Boolean(pet.status().lastError.hint)], [before, 'skin.none', true]);
  assert.equal(pet.status().fallback, null, '复核：「先用了哪套」的旧提示不再和「没有能用的皮肤」同时挂着');
  // 页面打不开（渲染层没打包）：提示 npm run build。
  const bad = fakeElectron({ loadFails: true });
  const failing = createPetWindow({ electron: bad, config: () => ({ enabled: true, skin: 'deepseek', scale: 0.5, x: null, y: null }), resolveSkin: () => skinsById.deepseek, pageUrl: 'x', preload: 'p' });
  failing.sync();
  await tick();
  assert.deepEqual([failing.status().lastError.code, failing.status().lastError.hint.includes('npm run build'), failing.status().visible], ['pet.load-failed', true, false]);
  pet.destroy();
  // 页面本身：只加载自己打包的渲染层。
  const page = fs.readFileSync(path.join(ROOT, 'app', 'pet', 'index.html'), 'utf8');
  assert.ok(page.includes('dist/pet-renderer.js') && page.includes('id="bubble"') && page.includes('id="err"'));
}

console.log('windows: ok');
