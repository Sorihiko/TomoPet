/**
 * 角色搬进 tosu（core/tosu-counter.js）：找 tosu、装 counter、跟着换皮肤、她开口时写 state.json、各种失败。
 * 照搬 SurfCore plugins/surfcore/scripts/test-osu-tosu-counter.mjs；皮肤和渲染层的来源换成本项目自己的。
 * 不碰真的 tosu：在临时目录里造一个假 tosu（带 tosu.env）、假的渲染层产物和两套假皮肤。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNTER_FOLDER, OTHER_WATCHER_RECENT_MS, SUBTITLE_FOLDER, SURFCORE_COUNTER_FOLDER, createTosuCounter, ensureCounterSettings, findRunningTosu, staticDirOf, tosuHttpBase, writeFileReplacing } from '../core/tosu-counter.js';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${String(error?.stack ?? error).split('\n').slice(0, 4).join('\n    ')}`);
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-tosu-counter-'));
const tosuDir = path.join(root, '游戏用', 'tosu'); // 真机上 tosu 就装在中文路径里
fs.mkdirSync(tosuDir, { recursive: true });
fs.writeFileSync(path.join(tosuDir, 'tosu.env'), 'DEBUG_LOG=false\nSTATIC_FOLDER_PATH=./my-static\nSERVER_PORT=24050\n');
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
write('dist/counter-renderer.js', 'RENDERER_V1');
write('skins/skin-a/manifest.json', '{"id":"skin-a","canvas":{"w":10,"h":10}}');
write('skins/skin-a/art/a.png', 'A');
write('skins/skin-b/manifest.json', '{"id":"skin-b","canvas":{"w":10,"h":10}}');
write('skins/skin-b/art/b.png', 'B');
const rendererFile = path.join(root, 'dist', 'counter-renderer.js');
const resolveSkin = (id) => (fs.existsSync(path.join(root, 'skins', String(id), 'manifest.json'))
  ? { ok: true, id, dir: path.join(root, 'skins', id), fallback: null }
  : { ok: false, code: 'skin.none', error: '一套能用的皮肤都没有', hint: '导入一套皮肤' });

let cfg = { enabled: true, tosuDir: '', skinId: 'skin-b', tosuUrl: 'ws://127.0.0.1:24050/websocket/v2' };
const logs = [];
const make = (extra = {}) => createTosuCounter({ config: () => cfg, resolveSkin, rendererFile, findTosu: async () => path.join(tosuDir, 'tosu.exe'), log: (...a) => logs.push(a.join(' ')), now: () => 1_800_000_000_000, ...extra });
const dir = path.join(tosuDir, 'my-static', COUNTER_FOLDER);
const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

await check('文件夹名是 fatfish-osu / fatfish-osu-subtitle；地址跟着 tosu 的端口走', () => {
  assert.deepEqual([COUNTER_FOLDER, SUBTITLE_FOLDER], ['fatfish-osu', 'fatfish-osu-subtitle']);
  assert.equal(tosuHttpBase('ws://127.0.0.1:24050/websocket/v2'), 'http://127.0.0.1:24050');
  assert.equal(tosuHttpBase('ws://localhost:9000/websocket/v2'), 'http://localhost:9000');
  assert.equal(tosuHttpBase('乱写'), 'http://127.0.0.1:24050');
});

await check('static 文件夹按 tosu.env 的 STATIC_FOLDER_PATH 算；没有 tosu.env 就是 ./static', () => {
  assert.equal(staticDirOf(tosuDir), path.join(tosuDir, 'my-static'));
  assert.equal(staticDirOf(path.join(root, 'nowhere')), path.join(root, 'nowhere', 'static'));
});

await check('不是 Windows 时不去找 tosu 进程', async () => {
  assert.equal(await findRunningTosu({ platform: 'linux' }), '');
});

await check('找 tosu 进程：PowerShell 先切 UTF-8 输出（中文路径不乱码）；读到的路径不存在就当没找到', async () => {
  const exe = path.join(tosuDir, 'tosu.exe');
  fs.writeFileSync(exe, '');
  let seen = null;
  const run = (file, args, opts, cb) => { seen = { file, args, opts }; cb(null, `\uFEFF${exe}\r\n`); };
  assert.equal(await findRunningTosu({ run, platform: 'win32' }), exe);
  assert.match(seen.args.at(-1), /OutputEncoding = \[System\.Text\.Encoding\]::UTF8/);
  assert.equal(seen.opts.encoding, 'utf8');
  // 真机事故：D:\游戏用\tosu.exe 被读成乱码路径 → 直接当没找到，不往乱码路径里写
  const garbled = (file, args, opts, cb) => cb(null, 'D:\\\uFFFD\uFFFD\u03F7\uFFFD\uFFFD\\tosu.exe\r\n');
  assert.equal(await findRunningTosu({ run: garbled, platform: 'win32' }), '');
  assert.equal(await findRunningTosu({ run: (f, a, o, cb) => cb(new Error('no ps')), platform: 'win32' }), '');
});

await check('findTosu 给了不存在的位置：报 osu.counter-bad-dir，不建任何文件夹', async () => {
  const ghost = path.join(root, 'ghost-dir', 'tosu.exe');
  const r = await make({ findTosu: async () => ghost }).sync();
  assert.equal(r.code, 'osu.counter-bad-dir');
  assert.ok(r.hint);
  assert.equal(fs.existsSync(path.join(root, 'ghost-dir')), false);
});

const c1 = make();
await check('装 counter：网页 + 设置 + 渲染层 + 当前皮肤 + state.json（不再有 shim.js）', async () => {
  const r = await c1.sync();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.url, r.subtitleUrl, r.skinId], ['http://127.0.0.1:24050/fatfish-osu/', 'http://127.0.0.1:24050/fatfish-osu-subtitle/', 'skin-b']);
  for (const f of ['index.html', 'counter.js', 'metadata.txt', 'settings.json', 'renderer.js', 'skin/manifest.json', 'skin/art/b.png', 'state.json']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.equal(fs.existsSync(path.join(dir, 'shim.js')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'renderer.js'), 'utf8'), 'RENDERER_V1');
  assert.match(fs.readFileSync(path.join(dir, 'metadata.txt'), 'utf8'), /Usecase: obs-overlay/);
  assert.deepEqual([state().rev, state().seq], [1, 0]);
  const st = c1.status();
  assert.deepEqual([st.installed, st.skinId, st.lastError, st.url], [true, 'skin-b', null, 'http://127.0.0.1:24050/fatfish-osu/']);
});

await check('页面本身：只加载自己的 renderer.js 和 counter.js；台词只当文字放进去；不指向 SurfCore 的文件夹', () => {
  const page = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.ok(page.includes('<script src="./renderer.js"></script>') && page.includes('<script src="./counter.js"></script>'));
  assert.ok(!page.includes('shim.js') && !page.includes('surfcore-video-rig'));
  for (const id of ['id="sub"', 'id="bubble"', 'id="err"']) assert.ok(page.includes(id), id);
  const script = fs.readFileSync(path.join(dir, 'counter.js'), 'utf8');
  assert.ok(script.includes('textContent') && !script.includes('innerHTML'), '她说的话只当文字放进去');
  assert.ok(script.includes("'./state.json?t='") && script.includes('talk-start') && script.includes('location.reload()'));
  for (const file of fs.readdirSync(dir).filter((name) => /\.(html|js|txt|json)$/.test(name) && name !== 'renderer.js')) {
    assert.ok(!fs.readFileSync(path.join(dir, file), 'utf8').includes('surfcore-xiaojingyu'), `${file} 不该再指向 SurfCore 的文件夹`);
  }
});

await check('也装了铺满画面的字幕 counter；角色页的设置是「说话时」三选一，默认气泡', () => {
  const subDir = path.join(tosuDir, 'my-static', SUBTITLE_FOLDER);
  for (const f of ['index.html', 'metadata.txt', 'settings.json']) assert.ok(fs.existsSync(path.join(subDir, f)), f);
  const sub = fs.readFileSync(path.join(subDir, 'index.html'), 'utf8');
  assert.match(sub, /\.\.\/fatfish-osu\/state\.json/, '读角色那份台词');
  assert.ok(sub.includes('textContent') && !sub.includes('innerHTML'));
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const line = s.find((x) => x.uniqueID === 'lineStyle');
  assert.deepEqual([line.type, line.value, line.options], ['options', '气泡', ['气泡', '人物下方字幕', '都不显示']]);
});

await check('旧格式设置（只有「显示字幕」）：换成新格式、保留字号；勾掉的变成「都不显示」；新格式不再动', () => {
  const tpl = path.join(HERE, '..', 'counter', 'pet', 'settings.json');
  const file = path.join(root, 'old-settings.json');
  fs.writeFileSync(file, JSON.stringify([{ uniqueID: 'showSubtitle', type: 'checkbox', value: true }, { uniqueID: 'fontSize', type: 'number', value: 44 }]));
  assert.equal(ensureCounterSettings(file, tpl), 'migrated');
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 后来加的「脚下的 pp 环」（2026-11-21）：老设置里没有，照模板补上默认的「显示」
  assert.deepEqual(s.map((x) => [x.uniqueID, x.value]), [['lineStyle', '气泡'], ['fontSize', 44], ['ppRing', '显示'], ['ppRingCurve', '显示'], ['ppRingCurveStyle', '墙'], ['ppLabelStyle', '黑底卡片'], ['ppRingInk', '浅色'], ['ppRingFc', '不显示']]);
  assert.equal(ensureCounterSettings(file, tpl), 'kept');
  fs.writeFileSync(file, JSON.stringify([{ uniqueID: 'showSubtitle', type: 'checkbox', value: false }]));
  ensureCounterSettings(file, tpl);
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.map((x) => [x.uniqueID, x.value]), [['lineStyle', '都不显示'], ['fontSize', 30], ['ppRing', '显示'], ['ppRingCurve', '显示'], ['ppRingCurveStyle', '墙'], ['ppLabelStyle', '黑底卡片'], ['ppRingInk', '浅色'], ['ppRingFc', '不显示']]);
  fs.writeFileSync(file, 'not json');
  assert.equal(ensureCounterSettings(file, tpl), 'created');
});

await check('改名 TomoPet 后（复核）：已经装过的设置里旧的说明 / 选项照模板更新，用户改过的值保留', () => {
  const tpl = path.join(HERE, '..', 'counter', 'pet', 'settings.json');
  const file = path.join(root, 'renamed-settings.json');
  const template = JSON.parse(fs.readFileSync(tpl, 'utf8'));
  // 真机上那份：每项都在，说明还是「osu-pet 字幕」，用户把字号改成了 44、说话时改成了「人物下方字幕」。
  const mine = { fontSize: 44, lineStyle: '人物下方字幕', ppRing: '不显示', ppRingCurve: '不显示', ppRingCurveStyle: '墙', ppLabelStyle: '只有字', ppRingInk: '深色', ppRingFc: '不显示' };
  const installed = template.map((t) => ({ ...t, description: t.description.replace('TomoPet', 'osu-pet'), value: mine[t.uniqueID] }));
  fs.writeFileSync(file, JSON.stringify(installed));
  assert.equal(ensureCounterSettings(file, tpl), 'refreshed');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.map((x) => [x.uniqueID, x.value]), [['lineStyle', '人物下方字幕'], ['fontSize', 44], ['ppRing', '不显示'], ['ppRingCurve', '不显示'], ['ppRingCurveStyle', '墙'], ['ppLabelStyle', '只有字'], ['ppRingInk', '深色'], ['ppRingFc', '不显示']], '用户的值不动');
  assert.ok(s.find((x) => x.uniqueID === 'lineStyle').description.includes('「TomoPet 字幕」'), '说明换成新的');
  assert.equal(ensureCounterSettings(file, tpl), 'kept', '一样了就不再写');
  // 2026-11-22 pp 那块字换了默认值（黑底卡片），id 也换成 ppLabelStyle：昨天装过的（旧 id ppRingLayout = 环下面一行）拿到新默认
  const yesterday = template.filter((t) => !['ppLabelStyle', 'ppRingInk'].includes(t.uniqueID)).map((t) => ({ ...t }));
  yesterday.push({ uniqueID: 'ppRingLayout', type: 'options', options: ['环下面一行', '沿着环'], value: '环下面一行' });
  fs.writeFileSync(file, JSON.stringify(yesterday));
  ensureCounterSettings(file, tpl);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.find((x) => x.uniqueID === 'ppLabelStyle').value, '黑底卡片');
  assert.ok(!after.some((x) => x.uniqueID === 'ppRingLayout'), '旧 id 去掉');
  assert.ok(JSON.parse(fs.readFileSync(tpl, 'utf8')).every((t) => !JSON.stringify(t).includes('osu-pet')), '模板里没有旧名字');
});

await check('她开口：seq 加一，带上这句话和张嘴时长；rev 不变', () => {
  assert.equal(c1.say({ text: '这把稳啊', durationMs: 2345.6 }), true);
  assert.deepEqual([state().seq, state().text, state().durationMs, state().rev], [1, '这把稳啊', 2346, 1]);
  c1.say({ text: 'x'.repeat(500) });
  assert.equal(state().seq, 2);
  assert.equal(state().text.length, 200, '太长截断');
});

await check('什么都没变时再同步：不重拷皮肤、rev 不变（网页不会无故重载）', async () => {
  const r = await c1.sync();
  assert.equal(r.changed, false);
  assert.deepEqual([state().rev, state().seq], [1, 2]);
});

await check('换了皮肤：拷新皮肤（旧的不留）、rev 加一（网页自己重载）', async () => {
  cfg.skinId = 'skin-a';
  const r = await c1.sync();
  assert.equal(r.skinId, 'skin-a');
  assert.equal(fs.existsSync(path.join(dir, 'skin', 'art', 'a.png')), true);
  assert.equal(fs.existsSync(path.join(dir, 'skin', 'art', 'b.png')), false);
  assert.equal(state().rev, 2);
  assert.equal(fs.readdirSync(path.join(tosuDir, 'my-static')).filter((x) => x.includes('.tmp-') || x.includes('.old-')).length, 0, '没留临时目录');
});

await check('同名皮肤重新导入过（清单内容变了）：也重拷、rev 加一', async () => {
  write('skins/skin-a/manifest.json', '{"id":"skin-a","canvas":{"w":20,"h":20}}');
  write('skins/skin-a/art/a2.png', 'A2');
  const r = await c1.sync();
  assert.equal(r.changed, true);
  assert.equal(fs.existsSync(path.join(dir, 'skin', 'art', 'a2.png')), true);
  assert.equal(state().rev, 3);
});

await check('渲染层更新了（重新 npm run build）：跟着换，rev 加一；用户在 tosu 里改过的设置不被覆盖', async () => {
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify([{ uniqueID: 'lineStyle', type: 'options', options: ['气泡', '人物下方字幕', '都不显示'], value: '人物下方字幕' }, { uniqueID: 'fontSize', type: 'number', value: 50 }]));
  write('dist/counter-renderer.js', 'RENDERER_V2');
  const r = await c1.sync();
  assert.equal(r.changed, true);
  assert.equal(fs.readFileSync(path.join(dir, 'renderer.js'), 'utf8'), 'RENDERER_V2');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).map((x) => x.value), ['人物下方字幕', 50, '显示', '显示', '墙', '黑底卡片', '浅色', '不显示'], '用户改过的值不动（新加的「脚下的 pp 环」「环上画难度曲线」「难度曲线的样子」「pp 那块字的样子」「只有字的字色」「显示 if FC」补上默认值）');
  assert.equal(state().rev, 4);
});

await check('「重新装进 tosu」（force）：皮肤也重拷', async () => {
  fs.rmSync(path.join(dir, 'skin', 'art', 'a.png'));
  await c1.sync({ force: true });
  assert.equal(fs.existsSync(path.join(dir, 'skin', 'art', 'a.png')), true);
});

await check('关掉开关：不装、不写 state.json', async () => {
  cfg.enabled = false;
  const seq = state().seq;
  assert.deepEqual(await c1.sync(), { ok: true, disabled: true });
  assert.equal(c1.say({ text: 'hi' }), false);
  assert.equal(state().seq, seq);
  assert.equal(c1.status().enabled, false);
  cfg.enabled = true;
});

await check('失败：tosu 没开 → osu.counter-no-tosu；设置的目录不存在 → osu.counter-bad-dir', async () => {
  const none = make({ findTosu: async () => '' });
  const r = await none.sync();
  assert.equal(r.code, 'osu.counter-no-tosu');
  assert.ok(r.error && r.hint);
  assert.equal(none.status().lastError.code, 'osu.counter-no-tosu');
  assert.equal(none.say({ text: 'hi' }), false, '没装好时开口什么都不做');
  const bad = createTosuCounter({ config: () => ({ ...cfg, tosuDir: path.join(root, 'missing') }), resolveSkin, rendererFile, findTosu: async () => '' });
  const r2 = await bad.sync();
  assert.equal(r2.code, 'osu.counter-bad-dir');
  assert.ok(r2.hint);
});

await check('失败：渲染层没打包 → osu.counter-no-renderer（提示 npm run build）；没有皮肤 → 用皮肤那边的错误码', async () => {
  const noBuild = make({ rendererFile: path.join(root, 'dist', 'missing.js') });
  const r = await noBuild.sync();
  assert.equal(r.code, 'osu.counter-no-renderer');
  assert.ok(r.hint.includes('npm run build'));
  const noSkin = createTosuCounter({ config: () => ({ ...cfg, skinId: 'nope' }), resolveSkin, rendererFile, findTosu: async () => path.join(tosuDir, 'tosu.exe') });
  const r2 = await noSkin.sync();
  assert.equal(r2.code, 'skin.none');
  assert.ok(r2.error && r2.hint);
});

await check('皮肤退回了默认那套：照装，把原因带出来', async () => {
  const fallback = { code: 'skin.not-found', error: '没找到皮肤「x」，先用「DeepSeek·女仆装」', hint: '重新选一套' };
  const c = make({ resolveSkin: () => ({ ok: true, id: 'skin-b', dir: path.join(root, 'skins', 'skin-b'), fallback }) });
  const r = await c.sync();
  assert.deepEqual([r.ok, r.skinId, r.skinFallback], [true, 'skin-b', fallback]);
  assert.deepEqual(c.status().lastSync.skinFallback, fallback);
  await c1.sync();
});

await check('设置里写了 tosuDir：直接用，不去找进程', async () => {
  let asked = false;
  const fixed = createTosuCounter({ config: () => ({ ...cfg, tosuDir }), resolveSkin, rendererFile, findTosu: async () => { asked = true; return ''; } });
  assert.equal((await fixed.sync()).ok, true);
  assert.equal(asked, false);
});

await check('state.json 正被别人读（Windows 改名被拒 EPERM）：重试后写进去；一直被拒就直接覆盖；别的错照样报', () => {
  const realRename = fs.renameSync;
  const target = path.join(root, 'busy.json');
  fs.writeFileSync(target, 'old');
  let fails = 2;
  fs.renameSync = (a, b) => { if (b === target && fails > 0) { fails -= 1; throw Object.assign(new Error('busy'), { code: 'EPERM' }); } return realRename(a, b); };
  try {
    assert.equal(writeFileReplacing(target, 'v2', { waitMs: 1 }), 'renamed');
    assert.equal(fs.readFileSync(target, 'utf8'), 'v2');
    fails = 99;
    assert.equal(writeFileReplacing(target, 'v3', { waitMs: 1 }), 'overwritten');
    assert.equal(fs.readFileSync(target, 'utf8'), 'v3');
    assert.equal(fs.readdirSync(root).filter((x) => x.startsWith('busy.json.')).length, 0, '临时文件清掉了');
    fs.renameSync = () => { throw Object.assign(new Error('disk gone'), { code: 'EIO' }); };
    assert.throws(() => writeFileReplacing(target, 'v4', { waitMs: 1 }), /disk gone/);
  } finally {
    fs.renameSync = realRename;
  }
});

await check('上次同步拷完文件后才失败（没发重载信号）：下次同步看指纹不对，补发一次重载', async () => {
  const c = make();
  await c.sync();
  const before = state().rev;
  const markerFile = path.join(dir, '.osu-pet-counter.json');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  fs.writeFileSync(markerFile, JSON.stringify({ ...marker, contentHash: 'stale' }));
  const r = await c.sync();
  assert.equal(r.changed, false, '文件本身没变');
  assert.equal(state().rev, before + 1, '但补发了重载');
  await c.sync();
  assert.equal(state().rev, before + 1, '补过之后不再重复');
});

await check('同时调两次 sync 只跑一次', async () => {
  let calls = 0;
  const slow = make({ findTosu: async () => { calls += 1; await new Promise((ok) => setTimeout(ok, 20)); return path.join(tosuDir, 'tosu.exe'); } });
  const [a, b] = await Promise.all([slow.sync(), slow.sync()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
});

await check('SurfCore 的小鲸鱼最近 30 分钟在 tosu 里开过口：status().otherWatcher 带出来；太久以前 / 没开过口 / 文件坏了都不算', async () => {
  const NOW = 1_800_000_000_000;
  const c = make();
  assert.ok((await c.sync()).ok);
  assert.equal(c.status().otherWatcher, null, '没有 SurfCore 的文件夹');
  const other = path.join(tosuDir, 'my-static', SURFCORE_COUNTER_FOLDER, 'state.json');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  const put = (s) => fs.writeFileSync(other, typeof s === 'string' ? s : JSON.stringify(s));
  put({ seq: 160, rev: 1, text: '全连还100%', durationMs: 3000, at: NOW - 60_000 });
  assert.deepEqual(c.status().otherWatcher, { folder: 'surfcore-xiaojingyu', at: new Date(NOW - 60_000).toISOString() });
  put({ seq: 160, rev: 1, text: 'x', at: NOW - OTHER_WATCHER_RECENT_MS - 1 });
  assert.equal(c.status().otherWatcher, null, '半小时以前说的');
  put({ seq: 0, rev: 3, text: '', at: 0 });
  assert.equal(c.status().otherWatcher, null, '只装了没开过口');
  put({ seq: 5, at: NOW + 3_600_000 });
  assert.equal(c.status().otherWatcher, null, '时间在未来（钟不对）不算');
  put('{坏的');
  assert.equal(c.status().otherWatcher, null);
  assert.equal(make().status().otherWatcher, null, '还没同步过（不知道 static 在哪）');
  // 复核：自己的 OBS 角色关着时也要能发现（这时最容易两边一起说）；关着时只找位置，什么都不写。
  put({ seq: 7, at: NOW - 5_000 });
  const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  const saved = cfg;
  cfg = { ...cfg, enabled: false };
  try {
    const off = make();
    assert.deepEqual(await off.sync(), { ok: true, disabled: true });
    assert.equal(off.status().otherWatcher?.folder, 'surfcore-xiaojingyu');
    assert.equal(off.say({ text: 'x' }), false, '关着不写 state.json');
    assert.equal(off.react({ moment: 'fc', playing: true }), false);
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
    // 找不到 tosu 也不报错（关着就不该打扰）
    const offNoTosu = make({ findTosu: async () => '' });
    assert.deepEqual(await offNoTosu.sync(), { ok: true, disabled: true });
    assert.equal(offNoTosu.status().lastError, null);
  } finally { cfg = saved; }
  fs.rmSync(path.dirname(other), { recursive: true, force: true });
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`tosu-counter: ${failed ? `${failed} 个失败 / ` : ''}${passed} 项通过${failed ? '' : '，ok'}`);
if (failed) process.exit(1);
