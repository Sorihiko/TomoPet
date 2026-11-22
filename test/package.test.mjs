/**
 * 打包给别人的 Windows 版（scripts/package-win.mjs）：在临时目录里造一个假项目（假 Electron、假依赖、假皮肤），
 * 看拼出来的文件夹对不对：自带全部皮肤、带授权说明、不带原图 / 测试 / 脚本、exe 改了名、生产依赖带齐。
 * 2026-11-20 用户：「这个程序别人下载下来应该自带所有 crosspet 的皮肤」（选的是「打成安装包时带上」）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DIRS, PackageError, licenseText, packageWin, packagedManifest, prodPackageDirs, thirdPartyNotices, verifyZip, zipFolder } from '../scripts/package-win.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-package-'));
const write = (root, rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const expectCode = async (promise, code) => assert.rejects(promise, (error) => { assert.ok(error instanceof PackageError, String(error)); assert.equal(error.code, code); assert.ok(error.message && error.hint, `${code} 要带 error 和 hint`); return true; });

// ── 生产依赖：按 Node 找包的规则，带上依赖的依赖；嵌套的、带作用域的都认 ───────────
{
  const root = path.join(sandbox, 'deps');
  const pkg = (rel, deps = {}, optional = {}) => write(root, `${rel}/package.json`, JSON.stringify({ name: path.basename(rel), dependencies: deps, optionalDependencies: optional }));
  pkg('node_modules/@anthropic-ai/sdk', { 'json-schema-to-ts': '^3', standardwebhooks: '^1' }, { 'not-installed': '^1' });
  pkg('node_modules/json-schema-to-ts', { 'ts-algebra': '^2' });
  pkg('node_modules/ts-algebra');
  pkg('node_modules/standardwebhooks', { 'fast-sha256': '^1' });
  pkg('node_modules/standardwebhooks/node_modules/fast-sha256'); // 嵌套的那份优先
  pkg('node_modules/fast-sha256');
  pkg('node_modules/pixi.js'); // 开发依赖：不该带
  const r = prodPackageDirs(root, { '@anthropic-ai/sdk': '^1' });
  assert.deepEqual(r.missing, [], '没装的可选依赖不算缺');
  assert.deepEqual(r.dirs.map((d) => d.split(path.sep).join('/')), [
    'node_modules/@anthropic-ai/sdk', 'node_modules/json-schema-to-ts', 'node_modules/standardwebhooks',
    'node_modules/standardwebhooks/node_modules/fast-sha256', 'node_modules/ts-algebra',
  ]);
  assert.deepEqual(prodPackageDirs(root, { nope: '1' }).missing, ['nope']);
}

// ── 包里的 package.json、授权说明 ────────────────────────────────────────────
{
  const m = packagedManifest({ name: 'osu-pet', version: '1.2.3', main: 'app/main.js', type: 'module', scripts: { start: 'x' }, dependencies: { a: '1' }, devDependencies: { electron: '45' } });
  assert.deepEqual(m, { name: 'osu-pet', version: '1.2.3', main: 'app/main.js', type: 'module', dependencies: { a: '1' } });
  const text = licenseText({ name: 'osu-pet', version: '1.2.3', skins: [{ id: 'crosspet-deepseek', name: 'DeepSeek·女仆装', credit: 'B 站 ZipZipPipe' }, { id: 'crosspet-glm', name: 'GLM', credit: '' }] });
  for (const wanted of ['CC BY-NC-SA 4.0', 'github.com/lokicorvus/crosspet', '不得商用', '署名', 'ZipZipPipe', 'DeepSeek·女仆装', 'GLM', '自带的 2 套', 'MIT', '及原作者', '设定来源', 'THIRD-PARTY-NOTICES.txt', 'Apache-2.0', 'surfpet', 'licenses']) assert.ok(text.includes(wanted), `授权说明缺「${wanted}」`);
  assert.ok(!text.includes('不带「分图层皮肤」'), 'rig.ts 授权查清了（surfpet，MIT），打包版带着它');
  assert.ok(!text.includes('「角色立绘：CrossPet（github.com/lokicorvus/crosspet），CC BY-NC-SA 4.0」'), '复核：署名不能只写 CrossPet，要带原作者');
  assert.ok(!text.includes('hunmer'), '没有带口型的皮肤就不写 hunmer');
  // 张嘴口型（2026-11-21）：取自 hunmer/aboutme-pets，单独署名、写明改动。
  const withMouth = licenseText({ name: 'TomoPet', version: '1.2.3', skins: [{ id: 'crosspet-claude', name: 'Claude', credit: '', mouth: true }, { id: 'crosspet-glm', name: 'GLM', credit: '' }] });
  for (const wanted of ['张嘴口型', 'https://github.com/hunmer/aboutme-pets', '其中 1 套', '改动', 'Claude（带张嘴口型）']) assert.ok(withMouth.includes(wanted), `授权说明缺「${wanted}」`);
}

// ── 整个打包：假项目 ──────────────────────────────────────────────────────────
const makeProject = (name, { skins = ['crosspet-deepseek', 'crosspet-glm'], electron = true } = {}) => {
  const root = path.join(sandbox, name);
  write(root, 'package.json', JSON.stringify({ name: 'osu-pet', version: '9.9.9', main: 'app/main.js', type: 'module', scripts: { start: 'electron .' }, dependencies: { '@anthropic-ai/sdk': '^1' }, devDependencies: { electron: '45', 'pixi.js': '8' } }));
  write(root, 'LICENSE', ['MIT License', '', 'Copyright (c) 2026 Someone', '', 'Permission is hereby granted'].join('\n'));
  for (const f of ['NOTICE', 'README.md', 'app/main.js', 'app/settings/index.html', 'core/skins.js', 'counter/pet/counter.js', 'dist/counter-renderer.js', 'dist/pet-renderer.js', 'assets/logo.png']) write(root, f);
  for (const f of ['art/crosspet/characters/deepseek/idle.webp', 'renderer/rig.ts', 'scripts/package-win.mjs', 'test/a.test.mjs', 'docs/DESIGN.md', 'node_modules/pixi.js/package.json']) write(root, f, '{}');
  write(root, 'node_modules/@anthropic-ai/sdk/package.json', JSON.stringify({ name: '@anthropic-ai/sdk' }));
  write(root, 'node_modules/@anthropic-ai/sdk/index.js');
  for (const id of skins) {
    write(root, `skins-bundled/${id}/manifest.json`, JSON.stringify({ id, name: `${id} 的名字`, author: `CrossPet，CC BY-NC-SA 4.0；设定来源：来源-${id}` }));
    write(root, `skins-bundled/${id}/art/idle.webp`);
    write(root, `skins-bundled/${id}/CREDITS.md`, '# 署名');
  }
  write(root, 'skins-bundled/crosspet-glm.tmp-123/manifest.json', '{}'); // 中断留下的，不该带
  write(root, 'licenses/surfpet-MIT.txt', '来源：https://github.com/Mieksido/surfpet\n\nMIT License\n\nCopyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors\n');
  if (electron) {
    for (const f of ['electron.exe', 'ffmpeg.dll', 'LICENSE', 'LICENSES.chromium.html', 'resources/default_app.asar', 'locales/zh-CN.pak']) write(root, `node_modules/electron/dist/${f}`);
  }
  return root;
};

// 假的渲染层打包：写两个产物，报告打进去了哪些源文件（真的是 esbuild 的 metafile）。
const fakeRenderer = (inputs = ['renderer/pet-entry.ts', 'renderer/rig.ts', 'renderer/sprite-rig.ts']) => async (outdir) => {
  for (const f of ['counter-renderer.js', 'pet-renderer.js']) write(outdir, f, 'BUILT_FOR_PACKAGE');
  return { built: true, inputs };
};

// ── 第三方授权全文 ───────────────────────────────────────────────────────────
{
  const root = path.join(sandbox, 'notices');
  write(root, 'node_modules/with-license/package.json', JSON.stringify({ name: 'with-license', version: '1.0.0', license: 'Apache-2.0', author: { name: 'A' } }));
  write(root, 'node_modules/with-license/LICENSE', 'APACHE TEXT');
  write(root, 'node_modules/no-license/package.json', JSON.stringify({ name: 'no-license', version: '2.0.0', license: 'MIT', author: 'B <b@x>' }));
  const text = thirdPartyNotices(root, ['node_modules/with-license', 'node_modules/no-license', 'node_modules/with-license']);
  for (const wanted of ['with-license 1.0.0', '协议：Apache-2.0；作者：A', 'APACHE TEXT', 'no-license 2.0.0', '协议：MIT；作者：B <b@x>', '这个包没带授权文件', 'LICENSES.chromium.html']) assert.ok(text.includes(wanted), `缺「${wanted}」`);
  assert.equal(text.split('with-license 1.0.0').length, 2, '同一个包只写一次');
}

{
  const root = makeProject('ok');
  write(root, 'node_modules/bundled-lib/package.json', JSON.stringify({ name: 'bundled-lib', version: '3.0.0', license: 'MIT' }));
  write(root, 'node_modules/bundled-lib/LICENSE', 'BUNDLED LIB LICENSE');
  const zipped = [];
  const icons = [];
  const versions = [];
  const r = await packageWin({ root, out: path.join(root, 'release'), steps: { build: async () => {}, renderer: fakeRenderer(['renderer/pet-entry.ts', 'renderer/rig.ts', 'node_modules/bundled-lib/index.js']), icon: async (exe, logo) => { icons.push([exe, logo, fs.existsSync(exe)]); return { group: 1, lang: 1033, sizes: [16, 32, 256] }; }, version: async (exe, want) => { versions.push([exe, want]); return { FileDescription: want.description }; }, zip: async (dir, file) => { zipped.push([dir, file]); fs.writeFileSync(file, 'ZIP'); } }, log: () => {} });
  const stage = path.join(root, 'release', 'TomoPet-9.9.9-win-x64');
  assert.equal(r.dir, stage);
  assert.deepEqual(r.skins, ['crosspet-deepseek', 'crosspet-glm'], '自带全部皮肤');
  // exe 图标换成 logo（2026-11-20 用户）：对改好名的 TomoPet.exe、用 assets/logo.png。
  assert.deepEqual(icons, [[path.join(stage, 'TomoPet.exe'), path.join(root, 'assets', 'logo.png'), true]]);
  // exe 版本信息（「把描述改成 TomoPet，这个项目叫 TomoPet」）：描述 / 产品名 / 公司是 TomoPet，版本号和版权从项目里来。
  assert.deepEqual(versions, [[path.join(stage, 'TomoPet.exe'), { description: 'TomoPet', product: 'TomoPet', version: '9.9.9', company: 'TomoPet', copyright: 'Copyright (c) 2026 Someone' }]]);
  assert.equal(r.version.FileDescription, 'TomoPet');
  assert.deepEqual(r.icon.sizes, [16, 32, 256]);
  assert.deepEqual(zipped, [[stage, path.join(root, 'release', 'TomoPet-9.9.9-win-x64.zip')]]);
  const has = (rel) => fs.existsSync(path.join(stage, rel));
  assert.ok(has('TomoPet.exe') && !has('electron.exe') && !has('osu-pet.exe'), 'exe 改名成 TomoPet.exe');
  assert.ok(!has('resources/default_app.asar'), '去掉 Electron 自带的演示程序');
  assert.ok(has('ffmpeg.dll') && has('locales/zh-CN.pak') && has('LICENSES.chromium.html'));
  for (const dir of APP_DIRS) assert.ok(has(`resources/app/${dir}`), `缺 ${dir}`);
  for (const rel of ['skins-bundled/crosspet-deepseek/art/idle.webp', 'skins-bundled/crosspet-deepseek/CREDITS.md', 'skins-bundled/crosspet-glm/manifest.json', 'node_modules/@anthropic-ai/sdk/index.js', 'LICENSE', 'NOTICE', 'app/settings/index.html', 'dist/pet-renderer.js']) assert.ok(has(`resources/app/${rel}`), `缺 ${rel}`);
  for (const rel of ['art', 'renderer', 'scripts', 'test', 'docs', 'node_modules/pixi.js', 'node_modules/electron', 'skins-bundled/crosspet-glm.tmp-123', 'release']) assert.ok(!has(`resources/app/${rel}`), `不该带 ${rel}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'resources/app/package.json'), 'utf8'));
  assert.deepEqual([manifest.main, manifest.scripts, manifest.devDependencies, manifest.dependencies], ['app/main.js', undefined, undefined, { '@anthropic-ai/sdk': '^1' }]);
  const license = fs.readFileSync(path.join(stage, '授权说明.txt'), 'utf8');
  assert.ok(license.startsWith('﻿') && license.includes('\r\n'), '记事本打开不乱码');
  for (const wanted of ['crosspet-deepseek 的名字', '来源-crosspet-glm', 'CC BY-NC-SA 4.0', '不得商用']) assert.ok(license.includes(wanted), `授权说明缺「${wanted}」`);
  assert.ok(fs.readFileSync(path.join(stage, '使用说明.txt'), 'utf8').includes('TomoPet.exe'));
  // 渲染层用单独打的那份，不是项目里 dist/ 那份；临时文件夹不留。
  assert.equal(fs.readFileSync(path.join(stage, 'resources/app/dist/pet-renderer.js'), 'utf8'), 'BUILT_FOR_PACKAGE');
  assert.ok(!fs.existsSync(path.join(root, 'release', '.renderer-for-package')));
  // 上游代码的许可全文（licenses/）带着，也收进 THIRD-PARTY-NOTICES.txt 的最前面。
  assert.ok(has('resources/app/licenses/surfpet-MIT.txt'));
  // 第三方授权全文（上游代码 + 运行时依赖 + 打进渲染层的包）。
  const notices = fs.readFileSync(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  assert.ok(notices.startsWith('﻿') && notices.includes('@anthropic-ai/sdk') && notices.includes('bundled-lib 3.0.0') && notices.includes('BUNDLED LIB LICENSE'));
  assert.ok(notices.includes('surfpet-MIT（源码里照搬 / 改编的代码）') && notices.includes('Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors'));
  assert.ok(notices.indexOf('surfpet-MIT') < notices.indexOf('@anthropic-ai/sdk'), '上游代码的许可放在最前面');
  // 再打一次：旧的整个换掉，不留上一次的文件。
  fs.writeFileSync(path.join(stage, 'stale.txt'), 'old');
  await packageWin({ root, out: path.join(root, 'release'), zip: false, icon: false, version: false, steps: { build: async () => {}, renderer: fakeRenderer() }, log: () => {} });
  assert.ok(!fs.existsSync(path.join(stage, 'stale.txt')));
  // licenses/ 不见了：不打（许可全文是必须随附的）。
  fs.rmSync(path.join(root, 'licenses'), { recursive: true, force: true });
  await expectCode(packageWin({ root, out: path.join(root, 'release'), zip: false, icon: false, version: false, steps: { build: async () => {}, renderer: fakeRenderer() }, log: () => {} }), 'package.no-licenses');
}

// ── 真项目：rig.ts 的来源和许可（2026-11-20 查清：surfpet，MIT），打包版带着它和 PixiJS ─────────
{
  const rig = fs.readFileSync(path.join(ROOT, 'renderer', 'rig.ts'), 'utf8');
  assert.ok(rig.includes('github.com/Mieksido/surfpet') && rig.includes('Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors') && rig.includes('licenses/surfpet-MIT.txt'), 'rig.ts 文件头写明来源和许可');
  assert.ok(!fs.existsSync(path.join(ROOT, 'renderer', 'rig-unavailable.ts')), '替身去掉了');
  for (const [file, holder] of [['surfpet-MIT.txt', 'Derpyu520 and qq-bridge / QSH contributors'], ['surfcore-MIT.txt', 'Derpyu520 and qq-bridge / QSH contributors'], ['crosspet-MIT.txt', 'lokicorvus and CrossPet contributors']]) {
    const text = fs.readFileSync(path.join(ROOT, 'licenses', file), 'utf8');
    assert.ok(text.includes('MIT License') && text.includes(`Copyright (c) 2026 ${holder}`) && text.includes('The above copyright notice and this permission notice shall be included') && text.trim().endsWith('SOFTWARE.'), `${file} 是 MIT 全文`);
  }
  const notice = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
  assert.ok(notice.includes('https://github.com/Mieksido/surfpet') && !notice.includes('授权待确认'), 'NOTICE 写明 surfpet 出处，不再说「授权待确认」');
  const { buildRenderer } = await import('../scripts/build-renderer.mjs');
  const outdir = path.join(sandbox, 'real-renderer');
  const r = await buildRenderer({ outdir, log: () => {} });
  assert.ok(r.inputs.includes('renderer/rig.ts') && r.inputs.includes('renderer/sprite-rig.ts'), '打包版支持分图层皮肤');
  assert.ok(r.inputs.some((p) => p.startsWith('node_modules/pixi.js/')), 'PixiJS 打进渲染层（授权写进 THIRD-PARTY-NOTICES.txt）');
  assert.ok(fs.existsSync(path.join(outdir, 'pet-renderer.js')) && fs.existsSync(path.join(outdir, 'counter-renderer.js')));
}

// ── 压缩：用 Windows 自带的 System32\tar.exe（不是 PATH 里的 tar：Git Bash 里那是 GNU tar，不出 zip、还把 D: 当远程主机）──
{
  const calls = [];
  const ok = zipFolder('D:\\out', 'osu-pet-1-win-x64', 'D:\\out\\osu-pet-1-win-x64.zip', { systemRoot: 'C:\\Windows', exists: () => true, run: (cmd, args) => { calls.push([cmd, args]); } });
  assert.equal(ok, 'tar');
  assert.deepEqual(calls, [[path.join('C:\\Windows', 'System32', 'tar.exe'), ['--options', 'hdrcharset=UTF-8', '-a', '-c', '-f', 'D:\\out\\osu-pet-1-win-x64.zip', '-C', 'D:\\out', 'osu-pet-1-win-x64']]], '文件名按 UTF-8 存（不然中文名变成问号）');
  // bsdtar 失败 / 没有：退回 PowerShell 的 Compress-Archive（路径里的单引号要转义）。
  calls.length = 0;
  const viaPs = zipFolder("D:\\o'ut", 'f', "D:\\o'ut\\f.zip", { systemRoot: 'C:\\Windows', exists: () => true, run: (cmd, args) => { calls.push([cmd, args]); if (cmd.endsWith('tar.exe')) throw new Error('boom'); } });
  assert.equal(viaPs, 'powershell');
  assert.equal(calls[1][0], 'powershell.exe');
  assert.ok(calls[1][1].at(-1).includes("-LiteralPath 'D:\\o''ut\\f'") && calls[1][1].at(-1).includes("-DestinationPath 'D:\\o''ut\\f.zip'"), calls[1][1].at(-1));
  // 两样都不行：带 code / error / hint，提示文件夹已经拼好了。
  assert.throws(() => zipFolder('D:\\out', 'f', 'D:\\out\\f.zip', { exists: () => false, run: () => { throw new Error('no'); } }), (e) => e.code === 'package.zip-failed' && e.hint.includes('文件夹已经拼好了'));
}

// ── 压完检查 zip：要紧的文件在不在、中文名有没有变成问号（2026-11-20 真机：「授权说明.txt」被存成了「????.txt」）──
{
  const listing = (names) => () => `﻿${names.join('\r\n')}\r\n`;
  const want = ['p/osu-pet.exe', 'p/授权说明.txt', 'p/使用说明.txt'];
  assert.deepEqual(verifyZip('x.zip', want, { run: listing(['p/osu-pet.exe', 'p\\授权说明.txt', 'p/使用说明.txt']) }).length, 3, '反斜杠也认');
  assert.throws(() => verifyZip('x.zip', want, { run: listing(['p/osu-pet.exe', 'p/????.txt', 'p/????.txt']) }), (e) => e.code === 'package.zip-broken' && e.message.includes('授权说明.txt') && Boolean(e.hint));
  assert.throws(() => verifyZip('x.zip', want, { run: () => { throw new Error('no powershell'); } }), (e) => e.code === 'package.zip-broken' && Boolean(e.hint));
}

// ── 打不成的情况：都带 code / error / hint ───────────────────────────────────
{
  const steps = { build: async () => {}, renderer: fakeRenderer(), icon: async () => ({ sizes: [16] }), version: async () => ({}), zip: async () => {} };
  await expectCode(packageWin({ root: makeProject('no-skins', { skins: [] }), steps, log: () => {} }), 'package.no-skins');
  await expectCode(packageWin({ root: makeProject('no-electron', { electron: false }), steps, log: () => {} }), 'package.no-electron');
  const noDeps = makeProject('no-deps');
  fs.rmSync(path.join(noDeps, 'node_modules', '@anthropic-ai'), { recursive: true, force: true });
  await expectCode(packageWin({ root: noDeps, steps, log: () => {} }), 'package.missing-deps');
  // 渲染层打不出来（esbuild 没装之类）/ 打出来缺文件。
  await expectCode(packageWin({ root: makeProject('renderer-throws'), steps: { ...steps, renderer: async () => { throw new Error('esbuild not found'); } }, log: () => {} }), 'package.no-renderer');
  await expectCode(packageWin({ root: makeProject('renderer-empty'), steps: { ...steps, renderer: async () => ({ inputs: [] }) }, log: () => {} }), 'package.no-renderer');
  // 换图标失败：错误码和下一步照原样带出来（--no-icon 是退路）。
  const iconFail = Object.assign(new Error('UpdateResource 失败'), { code: 'icon.write-failed', hint: '先退出打包版 osu-pet' });
  await expectCode(packageWin({ root: makeProject('icon-fails'), steps: { ...steps, icon: async () => { throw iconFail; } }, log: () => {} }), 'icon.write-failed');
  await expectCode(packageWin({ root: makeProject('icon-throws-plain'), steps: { ...steps, icon: async () => { throw new Error('boom'); } }, log: () => {} }), 'icon.failed');
  // icon: false（npm run package -- --no-icon）：不换。
  let called = false;
  const plain = await packageWin({ root: makeProject('no-icon'), icon: false, version: false, steps: { ...steps, icon: async () => { called = true; }, version: async () => { called = true; } }, log: () => {} });
  assert.deepEqual([called, plain.icon, plain.version], [false, null, null]);
  // 改版本信息失败：错误码和下一步照原样带出来（--no-version 是退路）。
  const versionFail = Object.assign(new Error('UpdateResource 失败'), { code: 'version.write-failed', hint: '先退出打包版 TomoPet' });
  await expectCode(packageWin({ root: makeProject('version-fails'), steps: { ...steps, version: async () => { throw versionFail; } }, log: () => {} }), 'version.write-failed');
}

// ── 真项目：package.json 里接好了；pixi.js 只是打包时用（进渲染层），不算运行时依赖 ─────────
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.package, 'node scripts/package-win.mjs');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@anthropic-ai/sdk'], '主进程只用到 Anthropic SDK');
  assert.ok(pkg.devDependencies['pixi.js'] && pkg.devDependencies.electron);
  assert.ok(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).includes('/release/'), '打出来的包不进仓库');
  // 主进程 / core 里没人 import pixi.js 或 renderer/ 源码（这些不在包里）。
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
  for (const file of [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'core'))]) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!/from ['"]pixi\.js['"]|from ['"]\.\.\/renderer\/|from ['"]\.\.\/scripts\//.test(src), `${path.relative(ROOT, file)} 引用了包里没有的东西`);
  }
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('package: ok');
