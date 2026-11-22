/**
 * 皮肤（core/skins.js）、渲染层产物。
 * 钉住：仓库里一套皮肤都没有（没有别人的立绘，占位小人也删了）；一套都没有时说清楚；校验 / 导入 / 退回默认那套；中文路径下也能拷。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-skins-'));
process.env.OSU_PET_HOME = path.join(sandbox, '数据');
process.env.OSU_PET_BUNDLED_DIR = path.join(sandbox, '没有自带皮肤'); // 单独跑这个文件时也不读真的 skins-bundled/
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skins = await import('../core/skins.js');
const { copyDirSync } = await import('../core/store.js');
const expectFail = (result, code) => { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.code, code); assert.ok(result.error && result.hint, `${code} 要带 error 和 hint`); };

// ── 仓库里的素材 ─────────────────────────────────────────────────────────────
{
  // 占位小人整个删了（2026-11-20 用户：「我要把占位小人从我这个项目里整个删了」）。
  assert.ok(!fs.existsSync(path.join(ROOT, 'skins-builtin')) && !fs.existsSync(path.join(ROOT, 'scripts', 'make-placeholder-skin.mjs')), '占位小人和它的生成脚本都不在了');
  assert.ok(!('BUILTIN_DIR' in skins) && !('PLACEHOLDER_ID' in skins));
  // git 里不许有别人的立绘：受版权保护的素材不随项目发布（给别人的安装包里另外带，见 scripts/package-win.mjs）。
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const art = tracked.filter((file) => /\.(png|jpe?g|webp|avif|gif|psd)$/i.test(file));
  for (const file of art) assert.ok(file.startsWith('assets/'), `仓库里不该有这张图：${file}`);
  assert.ok(!tracked.some((file) => /feiyu-0\d|claude-chan|^art\/|^skins-bundled\//i.test(file)), '没有 feiyu / Claude 娘 / CrossPet 的皮肤文件');
  assert.ok(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).includes('/skins/'), '.gitignore 挡住仓库根下的 skins/');
}

// ── 一套皮肤都没有（从源码跑、还没放 art/）：说清楚该怎么办，不抛 ──────────────────
{
  assert.deepEqual(skins.listSkins(), []);
  assert.equal(skins.defaultSkinId(), '');
  for (const asked of ['crosspet-deepseek', 'placeholder', '', null, '../../etc', 'a/b']) {
    const r = skins.resolveSkin(asked);
    // 复核：设置里是默认的 crosspet-deepseek（没选过）也报 skin.none（带「去哪拿皮肤」），不报「没找到 crosspet-deepseek、去重新选」。
    expectFail(r, 'skin.none');
  }
  const none = skins.resolveSkin('');
  assert.ok(none.hint.includes('art/crosspet/') && none.hint.includes('导入皮肤'), none.hint);
  assert.equal(skins.skinDirFor('crosspet-deepseek'), '');
}

// ── 校验 ─────────────────────────────────────────────────────────────────────
const makeSkin = (name, manifest, files = {}) => {
  const dir = path.join(sandbox, '我的皮肤', name);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) fs.writeFileSync(path.join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  return dir;
};
const LAYERED = { id: 'my-skin', name: '我的角色', rig: 'layered', canvas: { w: 100, h: 100 }, hitbox: { x: 0, y: 0, w: 100, h: 100 }, layers: [{ id: 'body', file: 'art/body.png', group: 'body', role: 'topwear' }, { id: 'mouth', file: 'art/mouth.png', group: 'head', role: 'mouth' }] };
{
  expectFail(skins.validateSkin(makeSkin('empty')), 'skin.no-manifest');
  expectFail(skins.validateSkin(makeSkin('broken', '{ not json')), 'skin.bad-manifest');
  expectFail(skins.validateSkin(makeSkin('array', '[]')), 'skin.bad-manifest');
  expectFail(skins.validateSkin(makeSkin('rig', { ...LAYERED, rig: 'live2d' })), 'skin.unknown-rig');
  expectFail(skins.validateSkin(makeSkin('nocanvas', { ...LAYERED, canvas: undefined })), 'skin.bad-manifest');
  expectFail(skins.validateSkin(makeSkin('nohit', { ...LAYERED, hitbox: undefined })), 'skin.bad-manifest');
  expectFail(skins.validateSkin(makeSkin('nolayers', { ...LAYERED, layers: [] })), 'skin.bad-manifest');
  expectFail(skins.validateSkin(makeSkin('missing', LAYERED, { 'art/body.png': 'B' })), 'skin.missing-file');
  expectFail(skins.validateSkin(makeSkin('escape', { ...LAYERED, layers: [{ id: 'x', file: '../../secret.png', group: 'body', role: 'topwear' }] })), 'skin.bad-path');
  expectFail(skins.validateSkin(makeSkin('novideo', { ...LAYERED, rig: 'video', layers: undefined })), 'skin.bad-manifest');
  const good = skins.validateSkin(makeSkin('good', LAYERED, { 'art/body.png': 'B', 'art/mouth.png': 'M' }));
  assert.deepEqual([good.ok, good.warnings], [true, []]);
  const mute = skins.validateSkin(makeSkin('mute', { ...LAYERED, layers: [LAYERED.layers[0]] }, { 'art/body.png': 'B' }));
  assert.ok(mute.ok && mute.warnings[0].includes('不会张嘴'), '没有嘴：能用，但提醒一句');
  const video = skins.validateSkin(makeSkin('video', { id: 'vid', rig: 'video', canvas: { w: 10, h: 10 }, hitbox: { x: 0, y: 0, w: 10, h: 10 }, video: { states: { idle: {} }, clips: [{ id: 'idle', type: 'loop', state: 'idle', file: 'art/idle.avif' }] } }, { 'art/idle.avif': 'V' }));
  assert.equal(video.ok, true, '视频皮肤也认');
}

// ── 导入（数据目录在中文路径下）──────────────────────────────────────────────
{
  expectFail(skins.importSkin(''), 'skin.no-folder');
  expectFail(skins.importSkin(path.join(sandbox, 'nowhere')), 'skin.no-folder');
  expectFail(skins.importSkin(path.join(sandbox, '我的皮肤', 'missing')), 'skin.missing-file');
  expectFail(skins.importSkin(makeSkin('ph', { ...LAYERED, id: 'placeholder' }, { 'art/body.png': 'B', 'art/mouth.png': 'M' })), 'skin.bad-id');
  expectFail(skins.importSkin(makeSkin('坏 id', { ...LAYERED, id: '有 空格' }, { 'art/body.png': 'B', 'art/mouth.png': 'M' })), 'skin.bad-id');
  const first = skins.importSkin(path.join(sandbox, '我的皮肤', 'good'));
  assert.deepEqual([first.ok, first.id, first.name, first.replaced], [true, 'my-skin', '我的角色', false]);
  assert.equal(first.dir, path.join(sandbox, '数据', 'skins', 'my-skin'));
  assert.equal(fs.readFileSync(path.join(first.dir, 'art', 'body.png'), 'utf8'), 'B', '中文路径下也拷对了地方');
  assert.deepEqual(fs.readdirSync(path.join(sandbox, '数据')).sort(), ['skins'], '没有拷出乱码文件夹');
  // 再导入一次（内容变了）：替换，不留临时目录。
  fs.writeFileSync(path.join(sandbox, '我的皮肤', 'good', 'art', 'body.png'), 'B2');
  const second = skins.importSkin(path.join(sandbox, '我的皮肤', 'good'));
  assert.deepEqual([second.ok, second.replaced], [true, true]);
  assert.equal(fs.readFileSync(path.join(first.dir, 'art', 'body.png'), 'utf8'), 'B2');
  assert.deepEqual(fs.readdirSync(path.join(sandbox, '数据', 'skins')), ['my-skin']);
  // manifest 没写 id：用文件夹名。
  const byFolder = skins.importSkin(makeSkin('folder-name', { ...LAYERED, id: undefined }, { 'art/body.png': 'B', 'art/mouth.png': 'M' }));
  assert.equal(byFolder.id, 'folder-name');
  // 列表：用户的在前；选得到。
  assert.deepEqual(skins.listSkins().map((skin) => [skin.id, skin.source]), [['folder-name', 'user'], ['my-skin', 'user']]);
  assert.deepEqual([skins.resolveSkin('my-skin').id, skins.resolveSkin('my-skin').fallback], ['my-skin', null]);
  // 设置里还是以前版本的默认值 placeholder：用默认那套（这里没有 DeepSeek，就是列表里第一套），不算出错。
  assert.equal(skins.defaultSkinId(), 'folder-name');
  assert.deepEqual([skins.resolveSkin('placeholder').id, skins.resolveSkin('placeholder').fallback], ['folder-name', null]);
  // 复核：设置是默认的 crosspet-deepseek 而它不在（没选过）：安静地换成第一套，不挂「没找到」的提醒。
  assert.deepEqual([skins.resolveSkin('crosspet-deepseek').id, skins.resolveSkin('crosspet-deepseek').fallback], ['folder-name', null]);
  // 用户的皮肤后来坏了：退回默认那套，说清楚原因和换成了哪套。
  fs.rmSync(path.join(first.dir, 'art', 'mouth.png'));
  const broken = skins.resolveSkin('my-skin');
  assert.deepEqual([broken.id, broken.fallback.code], ['folder-name', 'skin.missing-file']);
  assert.ok(broken.fallback.error.includes('「my-skin」用不了') && broken.fallback.error.includes('先用「') && broken.fallback.hint, broken.fallback.error);
  assert.equal(skins.listSkins().find((skin) => skin.id === 'my-skin').ok, false);
  // 没找到的那套：同样退回默认那套。
  const gone = skins.resolveSkin('nope');
  assert.deepEqual([gone.id, gone.fallback.code], ['folder-name', 'skin.not-found']);
  // 坏了的那套是唯一一套：没有可退的，失败码用它自己的原因。
  fs.rmSync(byFolder.dir, { recursive: true, force: true });
  expectFail(skins.resolveSkin('my-skin'), 'skin.missing-file');
  // 皮肤全没了：一套都没有。
  fs.rmSync(path.join(sandbox, '数据', 'skins'), { recursive: true, force: true });
  assert.deepEqual([skins.listSkins(), skins.defaultSkinId()], [[], '']);
  expectFail(skins.resolveSkin('nope'), 'skin.not-found');
  expectFail(skins.resolveSkin('placeholder'), 'skin.none');
}

// ── 逐文件拷贝（代替有 bug 的 fs.cpSync）─────────────────────────────────────
{
  const src = path.join(sandbox, 'src', '子 文件夹');
  fs.mkdirSync(path.join(src, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a', 'b', '文件.txt'), '内容');
  const dst = path.join(sandbox, '游戏用', '目标');
  copyDirSync(path.join(sandbox, 'src'), dst);
  assert.equal(fs.readFileSync(path.join(dst, '子 文件夹', 'a', 'b', '文件.txt'), 'utf8'), '内容');
  assert.ok(fs.readdirSync(sandbox).includes('游戏用'));
}

// ── 渲染层产物 ───────────────────────────────────────────────────────────────
{
  const { OUTPUTS, buildRenderer } = await import('../scripts/build-renderer.mjs');
  await buildRenderer({ ifMissing: true, log: () => {} });
  for (const [name, file] of Object.entries(OUTPUTS)) {
    const code = fs.readFileSync(file, 'utf8');
    assert.ok(code.length > 200_000, `${name} 里要有 PixiJS`);
    assert.ok(code.includes('__SurfcoreVideoRig'), `${name} 里要有视频皮肤播放器`);
    assert.ok(code.includes('talk-start') && code.includes('manifest.json'), `${name} 里要有分图层 rig 和读清单的入口`);
  }
  assert.ok(fs.readFileSync(OUTPUTS.counter, 'utf8').includes('__counterPet'), 'counter 入口给 counter.js 留了发命令的口子');
  assert.ok(fs.readFileSync(OUTPUTS.pet, 'utf8').includes('petHost'), '桌面入口走 preload 的 petHost');
  assert.equal((await buildRenderer({ ifMissing: true, log: () => {} })).built, false, '产物是新的就不重打');
}

// 排序（2026-11-22 用户：「第一排全是 deepseek，默认皮肤是 deepseek 女仆装」）：女仆装第一，别的 DeepSeek 衣服跟着，再是其余的
{
  for (const id of ['crosspet-deepseek-knit', 'crosspet-deepseek']) skins.importSkin(makeSkin(id, { ...LAYERED, id }, { 'art/body.png': 'B', 'art/mouth.png': 'M' }));
  const ids = skins.listSkins().map((skin) => skin.id);
  assert.deepEqual(ids.slice(0, 2), ['crosspet-deepseek', 'crosspet-deepseek-knit'], ids.join(','));
  assert.equal(skins.defaultSkinId(), 'crosspet-deepseek', '默认是 DeepSeek 女仆装');
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('skins: ok');
