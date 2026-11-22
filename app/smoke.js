/**
 * 离屏自检（开发用，不是给用户的功能）：把程序真的跑起来，给几个窗口截图、读页面里的状态，写成文件后退出。
 *
 *   OSU_PET_HOME=<临时数据目录> OSU_PET_SMOKE=<输出文件夹> npx electron .
 *
 * 为什么有它：这台机器上不能用「看屏幕、点鼠标」那一类工具来验收（会让英伟达即时回放关掉），
 * 所以用程序自己截图 + 读状态的办法确认「窗口真的画出来了」。
 * 它还会在临时目录里造一个假 tosu、起一个本机网页服务，把 OBS 那一页也打开看一遍——不碰真的 tosu。
 * 程序本身的「看你打 osu!」和 OBS 同步由 app/smoke-guard.js 隔离（连不上的地址、OBS 页面关掉、不找 tosu.exe），
 * 没给 OSU_PET_HOME 直接不跑：2026-11-20 复核发现原来会连上正在跑的真 tosu、把自检用的皮肤拷进用户 OBS 用的文件夹。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createTosuCounter, COUNTER_FOLDER, SUBTITLE_FOLDER } from '../core/tosu-counter.js';
import { defaultSkinId, resolveSkin } from '../core/skins.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.avif': 'image/avif', '.webp': 'image/webp', '.md': 'text/markdown; charset=utf-8' };

/** 假 tosu：临时目录当 static 文件夹，起一个本机网页服务（不碰真的 tosu）。 */
async function fakeTosu() {
  const tosuDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-smoke-游戏用-'));
  const staticDir = path.join(tosuDir, 'static');
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html');
    const file = path.join(staticDir, rel);
    if (!file.startsWith(staticDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { tosuDir, staticDir, port: server.address().port, close: () => { server.close(); fs.rmSync(tosuDir, { recursive: true, force: true }); } };
}

export async function runSmoke({ outDir, app, BrowserWindow, openSettings, pet, overlay, api, log }) {
  fs.mkdirSync(outDir, { recursive: true });
  const result = { startedAt: new Date().toISOString(), checks: {}, errors: [] };
  // 隐藏的窗口只在要截图时才画一帧，第一次截到的可能是上一帧：先截一次让它画，等一下再截真正要的。
  const shot = async (win, name) => {
    await win.webContents.capturePage();
    await wait(250);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
    const size = image.getSize();
    return `${size.width}x${size.height}`;
  };
  const consoleErrors = (win, tag) => win.webContents.on('console-message', (event) => { if (event.level === 'error') result.errors.push(`${tag}: ${String(event.message).slice(0, 300)}`); });
  const step = async (name, fn) => {
    try { result.checks[name] = await fn(); } catch (error) { result.checks[name] = { failed: String(error?.message ?? error).slice(0, 300) }; result.errors.push(`${name}: ${String(error?.message ?? error).slice(0, 300)}`); }
  };

  await wait(2500);

  await step('settings', async () => {
    // 不抢焦点、不显示：自检时用户可能正在用电脑。
    const win = openSettings({ quiet: true });
    consoleErrors(win, 'settings');
    await win.webContents.executeJavaScript(`window.__changes = []; document.addEventListener('change', (e) => window.__changes.push({ cfg: e.target.dataset.cfg || e.target.dataset.secret || e.target.id, trusted: e.isTrusted }), true); 0`);
    await wait(2500);
    const info = await win.webContents.executeJavaScript(`({ title: document.title, steps: [...document.querySelectorAll('#steps li .what')].map((n) => n.textContent), skinOptions: [...document.querySelectorAll('.skin-card .skin-name')].map((n) => n.firstChild.textContent), skinSelected: [...document.querySelectorAll('.skin-card.selected')].map((n) => n.dataset.skin), skinThumbs: [...document.querySelectorAll('.skin-card img')].length, tosu: document.querySelector('#st-tosu').textContent, obsUrl: document.querySelector('#obs-url').textContent, changes: window.__changes, toasts: [...document.querySelectorAll('.toast .title')].map((n) => n.textContent) })`);
    // 填好数据的设置页存一份静态 HTML（不带脚本），改样式时可以离线对着它画（2026-11-22 重新设计设置页）
    fs.writeFileSync(path.join(outDir, 'settings-snapshot.html'), await win.webContents.executeJavaScript(`(() => { const d = document.documentElement.cloneNode(true); d.querySelectorAll('script').forEach((s) => s.remove()); return '<!doctype html>\\n' + d.outerHTML; })()`));
    // 设置窗口是分页的（2026-11-20 改版）：每一页切过去截一张；顺便核对一次只显示一页、页签跟着亮。
    const pages = {};
    for (const page of ['overview', 'pet', 'watch', 'persona', 'llm', 'tts', 'obs', 'advanced']) {
      await win.webContents.executeJavaScript(`location.hash = '#${page}'; 0`);
      await wait(page === 'pet' ? 900 : 350);
      pages[page] = await win.webContents.executeJavaScript(`({ visible: [...document.querySelectorAll('main > .page')].filter((s) => !s.hidden).map((s) => s.dataset.page), active: [...document.querySelectorAll('#pages-nav a.active')].map((a) => a.dataset.page), brokenImages: [...document.querySelectorAll('main img')].filter((i) => !i.hidden && i.complete && i.naturalWidth === 0 && i.getAttribute('src')).length,
        // 整个窗口不能滚（只有右边内容区滚）：2026-11-21 用户「说话这一页有两个滚动条」。超出时记下是谁撑出去的。
        docScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        tallest: [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().bottom > document.documentElement.clientHeight + 1 && getComputedStyle(el).position !== 'fixed' && !el.closest('main')).slice(0, 6).map((el) => el.tagName + (el.id ? '#' + el.id : '') + '.' + String(el.className).slice(0, 30) + ' bottom=' + Math.round(el.getBoundingClientRect().bottom)) })`);
      if (pages[page].docScroll > 1) throw new Error(`设置「${page}」页整个窗口能滚（多出 ${pages[page].docScroll}px）：${pages[page].tallest.join('；')}`);
      pages[page].shot = await shot(win, `settings-${page}`);
      // 「角色」页：桌面上 / 脚下的 pp 环两张卡在下面（2026-11-22 重排），滚到底再截一张
      if (page === 'pet') {
        await win.webContents.executeJavaScript(`document.querySelector('main').scrollTop = 1e6; 0`);
        await wait(250);
        pages[page].bottomShot = await shot(win, 'settings-pet-bottom');
        await win.webContents.executeJavaScript(`document.querySelector('main').scrollTop = 0; 0`);
      }
      // 「说话」页比窗口长：难段预告那张卡在下面，滚到底再截一张（2026-11-21）。
      if (page === 'watch') {
        await win.webContents.executeJavaScript(`document.querySelector('main').scrollTop = 1e6; 0`);
        await wait(250);
        pages[page].bottomShot = await shot(win, 'settings-watch-bottom');
        pages[page].headsUp = await win.webContents.executeJavaScript(`({ radios: document.querySelectorAll('input[data-cfg="watch.headsUp"]').length, checked: (document.querySelector('input[data-cfg="watch.headsUp"]:checked') || {}).value })`);
        await win.webContents.executeJavaScript(`document.querySelector('main').scrollTop = 0; 0`);
      }
    }
    // 角色页像游戏选角（2026-11-21）：鼠标移到别的角色上，展示台先预览她；移开回到选中的那位；点姿势按钮换图。
    await win.webContents.executeJavaScript(`location.hash = '#pet'; 0`);
    await wait(900);
    pages.charSelect = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const read = () => ({ name: document.getElementById('stage-name').textContent, eyebrow: document.getElementById('stage-eyebrow').textContent, img: (document.querySelector('.stage-img.on') || {}).src || '' });
      const before = read();
      const other = [...document.querySelectorAll('.skin-card:not(.selected):not(.broken)')][0];
      other.dispatchEvent(new MouseEvent('mouseenter'));
      await sleep(500);
      const hover = read();
      document.getElementById('skin-grid').dispatchEvent(new MouseEvent('mouseleave'));
      await sleep(500);
      const back = read();
      const chips = document.querySelectorAll('#stage-poses button');
      if (chips[3]) chips[3].click();
      await sleep(700);
      // 带 hidden 的东西真的看不见（原来展示台的大字母被 display: grid 盖过 hidden，一直在，选中文字时冒出来）
      const shown = [...document.querySelectorAll('[hidden]')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id || e.className);
      const initial = getComputedStyle(document.getElementById('stage-initial')).display;
      return { before, hover, back, chips: chips.length, afterChip: read(), chipOn: [...chips].findIndex((b) => b.classList.contains('on')), hiddenShown: shown, initial };
    })()`);
    pages.charSelect.shot = await shot(win, 'settings-pet-stage');
    // 鼠标真的放到第二张角色卡上：她往上探出框（2026-11-22 用户：「把鼠标放在角色上面的时候角色身体能出框」）
    const cs0 = pages.charSelect;
    const cardBox = await win.webContents.executeJavaScript(`(() => { const c = document.querySelectorAll('.skin-card')[1]; if (!c) return null; c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: r.top }; })()`);
    if (cardBox) {
      await wait(300);
      // 合成的鼠标移动偶尔被吞掉（离屏自检时 hover 没触发）：先移到旁边、再移上去，各等一下
      win.webContents.sendInputEvent({ type: 'mouseMove', x: cardBox.x - 3, y: cardBox.y - 3 });
      await wait(150);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: cardBox.x, y: cardBox.y });
      await wait(600);
      pages.charSelect.hoverOut = await win.webContents.executeJavaScript(`(() => { const c = document.querySelectorAll('.skin-card')[1]; const img = c.querySelector('.skin-art img'); return { hovered: c.matches(':hover'), cardTop: c.getBoundingClientRect().top, imgTop: img ? img.getBoundingClientRect().top : null, stage: document.getElementById('stage-name').textContent, selected: c.classList.contains('selected') }; })()`);
      pages.charSelect.hoverShot = await shot(win, 'settings-pet-card-hover');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
      const h = pages.charSelect.hoverOut;
      if (!h.hovered || !(h.imgTop < h.cardTop - 8)) throw new Error(`鼠标放到角色卡上时她没有探出框：${JSON.stringify(h)}`);
      // 鼠标停在没选中的卡上：上面的展示台不换（2026-11-22 用户）
      if (!h.selected && h.stage !== cs0.before.name) throw new Error(`鼠标停在没选中的角色上，展示台换了：${JSON.stringify(h)}`);
      // 缩略图都加载出来了（clip-path 曾让懒加载一直不触发、缩略图空白）
      const blank = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.skin-card .skin-art img')].filter((i) => !(i.complete && i.naturalWidth > 0)).length`);
      if (blank) throw new Error(`有 ${blank} 张角色缩略图没加载出来`);
    }
    const cs = pages.charSelect;
    if (cs.hover.name !== cs.before.name || cs.hover.eyebrow !== '使用中' || cs.back.name !== cs.before.name || (cs.chips > 3 && (cs.chipOn !== 3 || cs.afterChip.img === cs.back.img))) throw new Error(`角色页展示台不对：${JSON.stringify({ before: cs.before.name, hover: cs.hover, back: cs.back.name, chipOn: cs.chipOn })}`);
    if (cs.hiddenShown.length || cs.initial !== 'none') throw new Error(`藏起来的东西还在页面上：${JSON.stringify({ hiddenShown: cs.hiddenShown, initial: cs.initial })}`);

    // 语音切到 Breeze（2026-11-21）：那一侧的填写项显示出来、火山的藏起来；看完切回去。
    await api.call('config.save', { patch: { tts: { provider: 'breeze' } } });
    await win.webContents.executeJavaScript(`location.hash = '#tts'; 0`);
    await wait(2200); // 设置窗口每隔一会儿才拉一次最新状态
    pages.ttsBreeze = await win.webContents.executeJavaScript(`({ breeze: !document.getElementById('tts-breeze').hidden, volc: !document.getElementById('tts-volc').hidden })`);
    pages.ttsBreeze.shot = await shot(win, 'settings-tts-breeze');
    await api.call('config.save', { patch: { tts: { provider: 'volc' } } });
    await win.webContents.executeJavaScript(`location.hash = '#overview'; 0`);
    return { ...info, pages, shot: await shot(win, 'settings') };
  });

  await step('api', async () => {
    const state = await api.call('state');
    const bad = await api.call('config.save', { patch: { watch: { url: 'ws://10.0.0.1:1/x' } } });
    const unknown = await api.call('nope');
    return { stateOk: state.ok, hasSecrets: JSON.stringify(state).includes('apiKey":"'), badCode: bad.code, badHint: Boolean(bad.hint), unknownCode: unknown.code };
  });

  await step('pet', async () => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/app/pet/'));
    if (!win) throw new Error(`桌面角色窗口没开：${JSON.stringify(pet.status())}`);
    consoleErrors(win, 'pet');
    await wait(1500);
    const before = await win.webContents.executeJavaScript(`({ rig: Boolean(window.__rig), skin: window.__skin && window.__skin.id, canvas: Boolean(document.querySelector('canvas')), err: document.getElementById('err').textContent })`);
    const idle = await shot(win, 'pet-idle');
    // 口型轨（2026-11-21 说话时动嘴）：闭 → 半张 → 张大来回，皮肤有嘴图时嘴要叠上去、跟着换。
    const spoke = pet.speak({ text: '离屏自检：这把稳啊，4.8 星都全连了', durationMs: 2500, bubble: true, mouth: '0122221111222200112222110000'.repeat(2) });
    await wait(900);
    const bubble = await win.webContents.executeJavaScript(`({ on: document.getElementById('bubble').classList.contains('on'), text: document.getElementById('bubble').textContent })`);
    const talking = await shot(win, 'pet-talking');
    const mouth = [];
    for (let i = 0; i < 8; i += 1) {
      mouth.push(await win.webContents.executeJavaScript('window.__rig.debugState ? window.__rig.debugState().mouth || null : null'));
      if (i === 2) mouth.push({ shot: await shot(win, 'pet-talking-mouth') });
      await wait(120);
    }
    const mouthFiles = [...new Set(mouth.filter((m) => m && m.on).map((m) => m.file))];
    // 换姿势不闪（2026-11-21）：换的那一阵里，姿势图层里最不透明的那一层任何时候都要是 1（原来两张同时半透明，透出桌面）。
    await wait(2600);
    const swapMin = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const layers = () => [...document.querySelectorAll('.sp-img:not(.sp-blink):not(.sp-mouth)')];
      let min = 1; let n = 0;
      window.__rig.playCommand('hop');
      const t = setInterval(() => {
        min = Math.min(min, Math.max(...layers().map((el) => Number(getComputedStyle(el).opacity))));
        if (++n >= 32) { clearInterval(t); resolve({ min, layers: layers().length }); }
      }, 25);
    })`);
    if (swapMin.min < 0.99) throw new Error(`换姿势时人变透明了：最不透明的那层只有 ${swapMin.min}`);
    // Ctrl+滚轮调大小（2026-11-21）：在她身上滚一格，设置里的大小和窗口都要变；不按 Ctrl 不变；再滚回去复原。
    const spot = await win.webContents.executeJavaScript(`(() => { for (let y = 40; y < innerHeight; y += 8) for (let x = 8; x < innerWidth; x += 8) if (window.__rig.hitTest(x, y)) return { x: x + 24, y: y + 60 }; return null; })()`);
    if (!spot) throw new Error('找不到她身上能点的地方');
    const scaleNow = async () => (await api.call('state')).config.pet.scale;
    const wheel = async (deltaY, modifiers) => { win.webContents.sendInputEvent({ type: 'mouseWheel', x: spot.x, y: spot.y, deltaX: 0, deltaY, modifiers }); await wait(400); };
    const zoom = { before: await scaleNow(), size: win.getSize() };
    await wheel(120, []);
    zoom.noCtrl = await scaleNow();
    await wheel(120, ['control']);
    zoom.after = await scaleNow();
    zoom.sizeAfter = win.getSize();
    zoom.shot = await shot(win, 'pet-zoomed');
    await wheel(-120, ['control']);
    zoom.back = await scaleNow();
    if (zoom.noCtrl !== zoom.before || zoom.after === zoom.before || zoom.sizeAfter[1] === zoom.size[1] || zoom.back !== zoom.before) throw new Error(`Ctrl+滚轮调大小不对：${JSON.stringify(zoom)}`);
    // 脚下的 pp 地台环（2026-11-21）：打图时出现、在脚底下；不打图时收起来
    await wait(500);
    // 环上的难度带（2026-11-21）：造一条曲线，进度 60%–70% 那里很难
    const fakeCurve = Array.from({ length: 120 }, (_, i) => Math.round(Math.min(1, 0.3 + 0.15 * Math.sin(i / 6) + (i > 72 && i < 84 ? 0.55 : 0)) * 100) / 100);
    pet.hudCurve(fakeCurve);
    pet.hud({ on: true, pp: 496, fc: 612, n100: 7, n50: 0, miss: 1, progress: 0.62 });
    await wait(600);
    const ring = await win.webContents.executeJavaScript(`(() => { const r = window.__ring; if (!r) return null; const g = r.geometry(); return { on: r.current().on, geo: g, curve: (r.curve() || []).length, bands: document.querySelectorAll('svg line').length, ringPaths: document.querySelectorAll('svg path:not([id])').length, footroom: window.__tomopetFootroom, h: innerHeight, w: innerWidth, label: (document.querySelector('.tpr') || {}).textContent || '' }; })()`);
    const ringShot = await shot(win, 'pet-hud');
    // 放大到 1.3 倍：留白跟着变大，字不压环、不出窗口（复核发现固定 46 像素时会）
    const fits = `(() => { const g = window.__ring.geometry(); const label = document.querySelector('.tpr'); const r = label.getBoundingClientRect(); return { ringBottom: g.cy + g.ry, labelTop: r.top, labelBottom: r.bottom, h: innerHeight, footroom: window.__tomopetFootroom }; })()`;
    const smallFit = await win.webContents.executeJavaScript(fits);
    const scaleBefore = (await api.call('state')).config.pet.scale;
    await api.call('config.save', { patch: { pet: { scale: 1.3 } } });
    await wait(900);
    // 快打完：粉色经过左右两个接缝（用户截图发现接缝处冒出一圈浅色的弧）
    pet.hud({ on: true, pp: 497, n100: 7, n50: 0, miss: 1, progress: 0.998 });
    await wait(500);
    const bigFit = await win.webContents.executeJavaScript(fits);
    const bigShot = await shot(win, 'pet-hud-big');
    await api.call('config.save', { patch: { pet: { scale: scaleBefore } } });
    await wait(600);
    for (const [name, f] of [['默认大小', smallFit], ['1.3 倍', bigFit]]) {
      if (f.labelTop < f.ringBottom - 1 || f.labelBottom > f.h + 1) throw new Error(`脚下的 pp 环 ${name} 时字压到环上 / 出了窗口：${JSON.stringify(f)}`);
    }
    pet.hud({ on: false });
    await wait(400);
    const ringOff = await win.webContents.executeJavaScript('window.__ring ? window.__ring.current().on : null');
    if (!ring || !ring.on || !ring.geo || ring.geo.cy > ring.h || ring.geo.cy < ring.h * 0.5 || !/^496pp.*ifFC612/.test(ring.label.replace(/\s/g, '')) || ringOff !== false || ring.curve !== 120 || ring.bands < 30 || ring.ringPaths !== 0) throw new Error(`脚下的 pp 环不对：${JSON.stringify({ ring, ringOff })}`);
    return { ...before, status: pet.status(), spoke, bubble, idle, talking, mouth: { has: Boolean(mouth[0] && mouth[0].has), files: mouthFiles, samples: mouth }, swap: swapMin, zoom, ring: { ...ring, shot: ringShot, offAfter: ringOff, smallFit, bigFit, bigShot } };
  });

  await step('overlay', async () => {
    overlay.say({ text: '离屏自检：字幕在屏幕下方出一行', ms: 4000 });
    await wait(1200);
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/app/overlay/'));
    if (!win) throw new Error('字幕窗口没开');
    consoleErrors(win, 'overlay');
    const info = await win.webContents.executeJavaScript(`({ text: document.getElementById('line').textContent, on: document.getElementById('box').classList.contains('on') })`);
    return { ...info, visible: win.isVisible(), focusable: win.isFocusable(), status: overlay.status(), shot: await shot(win, 'overlay') };
  });

  // 整条链路：起一个假的「OpenAI 兼容」模型服务，把设置指过去，点「让她说一句试试」——
  // 真的走 设置 → 模型请求 → 整理那一句 → 字幕窗口 + 桌面角色。不花钱、不联网。
  await step('say', async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { content: '「小鲸鱼：离屏自检，4.8 星这把稳了（笑）」\n第二行不要' } }], usage: { prompt_tokens: 300, completion_tokens: 12 } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const saved = await api.call('config.save', { patch: { llm: { provider: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fake-model', apiKey: 'smoke-key' }, watch: { output: 'subtitle' } } });
      if (!saved.ok) throw new Error(`${saved.code}: ${saved.error}`);
      const tested = await api.call('llm.test');
      const said = await api.call('watch.test');
      if (!said.ok) throw new Error(`${said.code}: ${said.error}（${said.hint}）`);
      await wait(900);
      const overlayWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/app/overlay/'));
      const line = await overlayWin.webContents.executeJavaScript(`document.getElementById('line').textContent`);
      const request = requests.at(-1);
      return {
        llmTest: { ok: tested.ok, text: tested.text }, said: said.said, subtitle: line, lastComment: said.status.lastComment?.text, today: said.status.today,
        request: { url: request.url, auth: request.auth, model: request.body.model, system: request.body.messages[0].content.slice(0, 60), user: request.body.messages[1].content },
        keyOnDisk: fs.readFileSync(path.join(process.env.OSU_PET_HOME, 'config.json'), 'utf8').includes('smoke-key') ? '明文' : '加密',
      };
    } finally {
      server.close();
    }
  });

  // 她说过一句之后的总览：「上一句」气泡里有字、今天的计数和圆环跟着变（2026-11-20 总览改版）。
  await step('overview-after-say', async () => {
    const win = openSettings({ quiet: true });
    await win.webContents.executeJavaScript(`location.hash = '#overview'; window.__refresh && window.__refresh(); 0`);
    await wait(900);
    const info = await win.webContents.executeJavaScript(`({ bubbleEmpty: document.getElementById('last-bubble').classList.contains('empty'), bubble: document.getElementById('st-last').textContent, meta: document.getElementById('st-last-meta').textContent, today: document.getElementById('st-today-count').textContent, ring: document.getElementById('st-today-bar').style.getPropertyValue('--pct'), plays: document.querySelectorAll('#plays-mini li:not(.empty)').length })`);
    const top = await shot(win, 'settings-overview-after-say');
    // 页面比窗口长：滚到底再截一张（最近几把、没说的原因在下面）。
    await win.webContents.executeJavaScript(`document.querySelector('main').scrollTop = 1e6; 0`);
    await wait(300);
    const bottom = await shot(win, 'settings-overview-after-say-bottom');
    await win.webContents.executeJavaScript(`document.querySelector('main').scrollTop = 0; 0`);
    return { ...info, shot: top, bottomShot: bottom };
  });

  // OBS 那一页：假 tosu（临时目录 + 本机网页服务），真的装一遍 counter，再用浏览器窗口打开。
  await step('counter', async () => {
    const tosuDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-smoke-游戏用-'));
    const staticDir = path.join(tosuDir, 'static');
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html');
      const file = path.join(staticDir, rel);
      if (!file.startsWith(staticDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const counter = createTosuCounter({ config: () => ({ enabled: true, tosuDir, skinId: defaultSkinId(), tosuUrl: `ws://127.0.0.1:${port}/websocket/v2` }), resolveSkin, log });
    const synced = await counter.sync();
    if (!synced.ok) throw new Error(`${synced.code}: ${synced.error}`);
    const open = async (url, width, height, tag) => {
      const win = new BrowserWindow({ width, height, show: false, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { backgroundThrottling: false } });
      consoleErrors(win, tag);
      await win.loadURL(url);
      // 隐藏的窗口里 CSS 过渡不走（气泡会一直停在透明）：自检时关掉过渡，截图才看得到最终的样子。
      await win.webContents.insertCSS('* { transition: none !important; }');
      return win;
    };
    const petPage = await open(synced.url, 600, 700, 'counter');
    const subPage = await open(synced.subtitleUrl, 1280, 720, 'counter-subtitle');
    await wait(2500);
    const loaded = await petPage.webContents.executeJavaScript(`({ rig: Boolean(window.__rig), skin: window.__skin && window.__skin.id, command: typeof (window.__counterPet && window.__counterPet.command), err: document.getElementById('err').textContent })`);
    const said = counter.say({ text: '离屏自检：OBS 里的气泡', durationMs: 3000 });
    await wait(1500);
    const bubble = await petPage.webContents.executeJavaScript(`(() => { const b = document.getElementById('bubble'); const r = b.getBoundingClientRect(); const c = getComputedStyle(b); return { on: b.classList.contains('on'), text: b.textContent, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], opacity: c.opacity, lineStyle: window.__counterSettings.lineStyle }; })()`);
    const subtitle = await subPage.webContents.executeJavaScript(`({ on: document.getElementById('line').classList.contains('on'), text: document.getElementById('line').textContent })`);
    const out = { synced: { url: synced.url, skinId: synced.skinId, files: fs.readdirSync(path.join(staticDir, COUNTER_FOLDER)).sort(), subFiles: fs.readdirSync(path.join(staticDir, SUBTITLE_FOLDER)).sort(), staticDirs: fs.readdirSync(staticDir).sort() }, loaded, said, bubble, subtitle, shot: await shot(petPage, 'counter'), subShot: await shot(subPage, 'counter-subtitle') };
    petPage.destroy(); subPage.destroy(); server.close();
    fs.rmSync(tosuDir, { recursive: true, force: true });
    return out;
  });

  // 姿势皮肤（CrossPet 的角色）：OSU_PET_SMOKE_CROSSPET=<CrossPet 里某个角色文件夹> 时导进临时数据目录、换上，
  // 给桌面角色和 OBS 页面各发一串游戏时刻，每个时刻截一张图。
  if (process.env.OSU_PET_SMOKE_CROSSPET) {
    const { importCrossPet } = await import('../core/crosspet-import.js');
    const SEQUENCE = [
      ['idle', null, false], ['start', 'start', true], ['playing', null, true], ['combo', 'combo', true], ['combo-break', 'combo-break', true],
      ['fc-lost', 'fc-lost', true], ['break', 'break', true], ['retry-rage', 'retry-rage', true], ['fc', 'fc', false], ['fail', 'fail', false],
    ];
    let skinId = '';
    await step('crosspet-import', async () => {
      const r = importCrossPet(process.env.OSU_PET_SMOKE_CROSSPET);
      if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
      skinId = r.imported[0].id;
      const saved = await api.call('config.save', { patch: { pet: { skin: skinId, scale: 0.5 } } });
      if (!saved.ok) throw new Error(`${saved.code}: ${saved.error}`);
      return { imported: r.imported.map((i) => ({ id: i.id, name: i.name, poses: i.poses, files: i.files, substituted: i.substituted })), skipped: r.skipped };
    });
    await step('crosspet-desktop', async () => {
      await wait(3500);
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/app/pet/'));
      if (!win) throw new Error(`桌面角色窗口没开：${JSON.stringify(pet.status())}`);
      consoleErrors(win, 'crosspet-desktop');
      await win.webContents.insertCSS('* { transition: none !important; }');
      const info = await win.webContents.executeJavaScript(`({ skin: window.__skin && window.__skin.id, rig: window.__skin && window.__skin.rig, err: document.getElementById('err').textContent, imgs: document.querySelectorAll('.sp-img').length })`);
      const frames = [];
      for (const [name, moment, playing] of SEQUENCE) {
        pet.react({ moment, playing });
        await wait(700);
        const state = await win.webContents.executeJavaScript('window.__rig && window.__rig.debugState ? window.__rig.debugState().shown : null');
        frames.push({ name, shown: state, shot: await shot(win, `crosspet-desktop-${name}`) });
      }
      // 点没点到她：跳起来的那一刻，头顶上方（原来脚站着时的头的位置以上）要按画出来的位置算。
      const hits = await win.webContents.executeJavaScript(`(() => {
        const r = window.__rig; const s = r.scale; const m = r.manifest;
        const cx = r.stageX + m.canvas.w * s / 2;
        return { center: r.hitTest(cx, r.stageY + m.canvas.h * s * 0.55), corner: r.hitTest(r.stageX + 2, r.stageY + 2), outside: r.hitTest(r.stageX - 20, r.stageY - 20) };
      })()`);
      frames.push({ name: 'hit-test', shown: hits });
      pet.speak({ text: '离屏自检：全连了！4.8 星都稳稳拿下', durationMs: 3000, bubble: true });
      await wait(700);
      const talking = await win.webContents.executeJavaScript('window.__rig.debugState().shown');
      frames.push({ name: 'talking', shown: talking, shot: await shot(win, 'crosspet-desktop-talking') });
      pet.react({ moment: null, playing: false });
      return { ...info, frames };
    });
    await step('crosspet-obs', async () => {
      const tosu = await fakeTosu();
      try {
        const counter = createTosuCounter({ config: () => ({ enabled: true, tosuDir: tosu.tosuDir, skinId, tosuUrl: `ws://127.0.0.1:${tosu.port}/websocket/v2` }), resolveSkin, log });
        const synced = await counter.sync();
        if (!synced.ok) throw new Error(`${synced.code}: ${synced.error}`);
        const page = new BrowserWindow({ width: 600, height: 700, show: false, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { backgroundThrottling: false } });
        consoleErrors(page, 'crosspet-obs');
        await page.loadURL(synced.url);
        await page.webContents.insertCSS('* { transition: none !important; }');
        await wait(2500);
        const loaded = await page.webContents.executeJavaScript(`({ skin: window.__skin && window.__skin.id, rig: window.__skin && window.__skin.rig, err: document.getElementById('err').textContent })`);
        const frames = [];
        for (const [name, moment, playing] of SEQUENCE.filter(([n]) => ['start', 'combo-break', 'break', 'fc', 'fail'].includes(n))) {
          counter.react({ moment, playing });
          await wait(1200); // 页面每 0.4 秒读一次 state.json
          const state = await page.webContents.executeJavaScript('window.__rig && window.__rig.debugState ? window.__rig.debugState().shown : null');
          frames.push({ name, shown: state, shot: await shot(page, `crosspet-obs-${name}`) });
        }
        counter.say({ text: '离屏自检：OBS 里她在说话', durationMs: 3000, mouth: '1222222211112222'.repeat(4) });
        await wait(1200);
        const bubble = await page.webContents.executeJavaScript(`({ on: document.getElementById('bubble').classList.contains('on'), text: document.getElementById('bubble').textContent, shown: window.__rig.debugState().shown, mouth: window.__rig.debugState().mouth })`);
        frames.push({ name: 'talking', shown: bubble.shown, mouth: bubble.mouth, bubble: { on: bubble.on, text: bubble.text }, shot: await shot(page, 'crosspet-obs-talking') });
        // 脚下的 pp 地台环（2026-11-21）：假 tosu 不推 websocket/v2，直接喂一帧看画在哪
        const obsRing = await page.webContents.executeJavaScript(`(() => { const r = window.__ring; if (!r) return null; r.setCurve(Array.from({ length: 120 }, (_, i) => Math.min(1, 0.3 + 0.15 * Math.sin(i / 6) + (i > 30 && i < 42 ? 0.55 : 0)))); r.update({ on: true, pp: 312, fc: 455, n100: 12, n50: 1, miss: 0, progress: 0.35 }); const g = r.geometry(); return { geo: g, footroom: window.__tomopetFootroom, h: innerHeight }; })()`);
        await wait(300);
        frames.push({ name: 'hud', ring: obsRing, shot: await shot(page, 'crosspet-obs-hud') });
        if (!obsRing || !obsRing.geo || obsRing.geo.cy > obsRing.h || obsRing.footroom <= 0) throw new Error(`OBS 里脚下的 pp 环不对：${JSON.stringify(obsRing)}`);
        // 难度曲线换成墙（2026-11-21 用户要留成选项）：counter 设置「难度曲线的样子」选「墙」
        const wallCount = await page.webContents.executeJavaScript(`(() => { window.__counterPet.setRingCurveStyle('墙'); window.__ring.update({ on: true, pp: 312, fc: 455, n100: 12, n50: 1, miss: 0, progress: 0.35 }); return { style: window.__ring.curveStyle(), walls: document.querySelectorAll('svg polygon').length, tops: document.querySelectorAll('svg polyline').length, bars: document.querySelectorAll('svg line').length }; })()`);
        // 假 tosu 不推帧，页面每两秒重连一次、断开时把环收起来：截图前再喂一帧
        await wait(300);
        await page.webContents.executeJavaScript(`window.__ring.update({ on: true, progress: 0.35 })`);
        await wait(300);
        frames.push({ name: 'hud-wall', wall: wallCount, shot: await shot(page, 'crosspet-obs-hud-wall') });
        if (wallCount.style !== 'wall' || wallCount.walls < 2 || wallCount.tops !== wallCount.walls || wallCount.bars !== 0) throw new Error(`OBS 里难度墙不对：${JSON.stringify(wallCount)}`);
        await page.webContents.executeJavaScript(`window.__counterPet.setRingCurveStyle('柱子')`);
        // 有难度曲线时不画环（2026-11-22 用户：底下那个圈可以删了），没有曲线时照旧画环
        const noCurve = await page.webContents.executeJavaScript(`(() => { const r = window.__ring; const saved = r.curve(); const withCurve = document.querySelectorAll('svg path:not([id])').length; r.setCurve(null); r.update({ on: true, progress: 0.35 }); const without = document.querySelectorAll('svg path:not([id])').length; r.setCurve(saved); return { withCurve, without }; })()`);
        if (noCurve.withCurve !== 0 || noCurve.without < 4) throw new Error(`有曲线时不该画环、没有曲线时该画：${JSON.stringify(noCurve)}`);
        // pp 那行字沿着环弯过去、关掉 if FC（2026-11-21 用户：「再做个摆法，这个保留。if fc 可以不显示，做个开关」）
        const arcInfo = await page.webContents.executeJavaScript(`(() => { const p = window.__counterPet; p.setRingLayout('沿着环'); p.setRingFc('不显示'); window.__ring.update({ on: true, pp: 312, fc: 455, n100: 12, n50: 1, miss: 0, progress: 0.35 }); const ts = [...document.querySelectorAll('svg textPath')]; const t = ts[0]; const fcw = t && t.querySelector('[data-k="fcwrap"]'); const line = document.querySelector('.tpr'); const boxes = ts.map((x) => { const b = x.parentNode.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }); const g = window.__ring.geometry(); return { layout: window.__ring.labelLayout(), text: ts.map((x) => x.textContent.replace(/\\s+/g, ' ').trim()).join(' | '), arcShown: t ? getComputedStyle(t.closest('svg')).display !== 'none' : false, fcHidden: fcw ? getComputedStyle(fcw).display === 'none' : false, lineHidden: line ? line.style.display === 'none' : null, boxes, cx: g.cx, cy: g.cy, ringBottom: g.cy + g.ry, h: innerHeight }; })()`);
        await wait(300);
        frames.push({ name: 'hud-arc', arc: arcInfo, shot: await shot(page, 'crosspet-obs-hud-arc') });
        if (arcInfo.layout !== 'arc' || !arcInfo.arcShown || !arcInfo.fcHidden || arcInfo.lineHidden !== true || !/^312pp.*\|1210$/.test(arcInfo.text.replace(/ /g, '')) || arcInfo.boxes.length !== 2
          // pp 在左边、100 / 50 / miss 在右边；字框（含整个字高）不高过环心、不出窗口底
          || !(arcInfo.boxes[0].x + arcInfo.boxes[0].w / 2 < arcInfo.cx && arcInfo.boxes[1].x + arcInfo.boxes[1].w / 2 > arcInfo.cx)
          || arcInfo.boxes.some((b) => b.w < 20 || b.y < arcInfo.cy || b.y + b.h > arcInfo.h + 2)) throw new Error(`OBS 里沿着环的字不对：${JSON.stringify(arcInfo)}`);
        // 4 位数 pp 加 if FC（复核发现两组会叠、左边第一个字被吃掉）：两组不叠，第一个字画出来了
        const arcFc = await page.webContents.executeJavaScript(`(() => { window.__counterPet.setRingFc('显示'); window.__ring.update({ on: true, pp: 1234, fc: 1456, n100: 123, n50: 4, miss: 2, progress: 0.35 }); const ts = [...document.querySelectorAll('svg text')].filter((t) => t.querySelector('textPath')); const b = ts.map((t) => t.getBBox()); return { leftRight: b[0].x + b[0].width, rightLeft: b[1].x, first: ts[0].getExtentOfChar(0).width, size: ts[0].getAttribute('font-size') }; })()`);
        await wait(300);
        frames.push({ name: 'hud-arc-fc', arc: arcFc, shot: await shot(page, 'crosspet-obs-hud-arc-fc') });
        if (!(arcFc.leftRight <= arcFc.rightLeft) || !(arcFc.first > 0)) throw new Error(`OBS 里沿着环的字叠在一起 / 被吃掉：${JSON.stringify(arcFc)}`);
        // 三种新样子（2026-11-22 用户挑的）：浅色成绩条、只有字（浅色 / 深色字）；黑底卡片是默认，上面 hud 那张就是。字在环下面、不出窗口
        for (const [name, style, inkName] of [['paper', '浅色成绩条', '浅色'], ['type', '只有字', '浅色'], ['type-dark', '只有字', '深色']]) {
          const info = await page.webContents.executeJavaScript(`(() => { const p = window.__counterPet; p.setRingLayout('${style}'); p.setRingInk('${inkName}'); window.__ring.update({ on: true, pp: 312, fc: 455, n100: 12, n50: 1, miss: 0, progress: 0.35 }); const l = document.querySelector('.tpr'); const b = l.getBoundingClientRect(); const g = window.__ring.geometry(); return { cls: l.className, text: l.textContent.replace(/\\s+/g, ''), top: b.top, bottom: b.bottom, left: b.left, right: b.right, ringBottom: g.cy + g.ry, w: innerWidth, h: innerHeight }; })()`);
          // 假 tosu 每两秒断一次、断开时把环收起来：截图前再喂一帧
          await wait(300);
          await page.webContents.executeJavaScript(`window.__ring.update({ on: true, progress: 0.35 })`);
          await wait(300);
          frames.push({ name: `hud-${name}`, info, shot: await shot(page, `crosspet-obs-hud-${name}`) });
          if (!/^312pp/.test(info.text) || !/ifFC455/.test(info.text) || info.top < info.ringBottom || info.bottom > info.h + 1 || info.left < 0 || info.right > info.w) throw new Error(`OBS 里「${style}」不对：${JSON.stringify(info)}`);
        }
        await page.webContents.executeJavaScript(`(() => { window.__counterPet.setRingLayout('黑底卡片'); window.__counterPet.setRingInk('浅色'); })()`);
        // 很小的 OBS 浏览器源（200×180）：黑底卡片不压环、不出窗口（复核发现留白上限四分之一时会压上去）
        const [ow, oh] = page.getContentSize();
        page.setContentSize(200, 180);
        await wait(500);
        const tiny = await page.webContents.executeJavaScript(`(() => { window.__ring.update({ on: true, pp: 312, fc: 455, n100: 12, n50: 1, miss: 0, progress: 0.35 }); const b = document.querySelector('.tpr').getBoundingClientRect(); const g = window.__ring.geometry(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, ringBottom: g.cy + g.ry, w: innerWidth, h: innerHeight }; })()`);
        frames.push({ name: 'hud-tiny', tiny, shot: await shot(page, 'crosspet-obs-hud-tiny') });
        page.setContentSize(ow, oh);
        if (tiny.top < tiny.ringBottom || tiny.bottom > tiny.h + 1 || tiny.left < 0 || tiny.right > tiny.w + 0.5) throw new Error(`很小的 OBS 浏览器源里卡片压环 / 出窗口：${JSON.stringify(tiny)}`);
        page.destroy();
        return { loaded, skinFiles: fs.readdirSync(path.join(tosu.staticDir, COUNTER_FOLDER, 'skin')).sort(), frames };
      } finally {
        tosu.close();
      }
    });
  }

  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  log(`[smoke] 完成，${result.errors.length} 个错误，结果在 ${outDir}`);
  app.exit(result.errors.length ? 1 : 0);
}
