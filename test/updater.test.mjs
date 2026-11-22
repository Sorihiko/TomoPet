/**
 * 自动更新（core/updater.js，2026-11-22 用户：「再加个自动更新的功能吧」→ 一键下载并安装）。
 * 查 GitHub Releases、认版本和附件、下载校验、解压核对、装新文件的脚本（Windows 上真的跑一遍，不重开程序）。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareVersions, createUpdater, findAppFolder, INSTALL_SCRIPT, parseVersion, readRelease, RELEASES_PAGE } from '../core/updater.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tomopet-update-测试-'));
const isWin = process.platform === 'win32';

// ── 版本号 ────────────────────────────────────────────────────────────────────
assert.deepEqual(parseVersion('v0.2.0'), [0, 2, 0]);
assert.deepEqual(parseVersion('1.10.3'), [1, 10, 3]);
assert.equal(parseVersion('v1.2'), null);
assert.equal(parseVersion('latest'), null);
assert.ok(compareVersions('0.2.0', '0.1.9') > 0);
assert.ok(compareVersions('v0.10.0', '0.9.0') > 0, '按数字比，不按字符串');
assert.ok(compareVersions('0.1.0', '0.1.0') === 0);
assert.ok(compareVersions('0.0.9', '0.1.0') < 0);
assert.equal(compareVersions('nonsense', '0.1.0'), 0, '看不出来的当一样（不更新）');

// ── 读 GitHub 的 release ──────────────────────────────────────────────────────
const SHA = 'a'.repeat(64);
const rel = (over = {}) => ({
  tag_name: 'v0.2.0', body: '修了一些东西', html_url: `${RELEASES_PAGE}/tag/v0.2.0`, published_at: '2026-11-23T00:00:00Z',
  assets: [
    { name: 'TomoPet-0.2.0-win-x64.zip.sha256', size: 64, browser_download_url: 'https://github.com/x/y.sha256' },
    { name: 'TomoPet-0.2.0-win-x64.zip', size: 1234, browser_download_url: 'https://github.com/Sorihiko/TomoPet/releases/download/v0.2.0/TomoPet-0.2.0-win-x64.zip', digest: `sha256:${SHA}` },
  ],
  ...over,
});
{
  const r = readRelease(rel());
  assert.equal(r.version, '0.2.0');
  assert.deepEqual(r.asset, { name: 'TomoPet-0.2.0-win-x64.zip', size: 1234, url: 'https://github.com/Sorihiko/TomoPet/releases/download/v0.2.0/TomoPet-0.2.0-win-x64.zip', sha256: SHA });
  assert.equal(r.pageUrl, `${RELEASES_PAGE}/tag/v0.2.0`);
  assert.equal(readRelease(rel({ html_url: 'https://evil.example/x' })).pageUrl, RELEASES_PAGE, '发布页地址只认本仓库的');
  assert.equal(readRelease(rel({ assets: [] })).asset, null, '没附 zip');
  assert.equal(readRelease(rel({ assets: [{ name: 'TomoPet-0.2.0-win-x64.zip', size: 10, browser_download_url: 'http://insecure/x.zip' }] })).asset, null, '只认 https 下载');
  assert.equal(readRelease(rel({ assets: [{ name: 'TomoPet-0.2.0-win-x64.zip', size: 10, browser_download_url: 'https://x/y.zip' }] })).asset.sha256, '', '没有 digest 时不校验 sha256，只校验大小');
  assert.throws(() => readRelease(rel({ tag_name: 'nightly' })), (e) => e.code === 'update.bad-release');
}

// ── 查更新：结果和错误 ────────────────────────────────────────────────────────
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const make = (fetchImpl, over = {}) => createUpdater({ currentVersion: '0.1.0', fetchImpl, tempDir: sandbox, exePath: path.join(sandbox, 'none', 'TomoPet.exe'), isPackaged: true, logFile: path.join(sandbox, 'log.txt'), quit: () => {}, platform: 'win32', ...over });
{
  const seen = [];
  const up = make(async (url, init) => { seen.push([url, init.headers]); return json(200, rel()); });
  const st = await up.check();
  assert.equal(seen[0][0], 'https://api.github.com/repos/Sorihiko/TomoPet/releases/latest');
  assert.equal(seen[0][1]['User-Agent'], 'TomoPet-updater', '只带通用的 User-Agent，没有个人信息');
  assert.deepEqual([st.available, st.latest.version, st.latest.hasAsset, st.canInstall, st.error], [true, '0.2.0', true, true, null]);

  const same = await make(async () => json(200, rel({ tag_name: 'v0.1.0' }))).check();
  assert.equal(same.available, false, '一样的版本不算新');
  const older = await make(async () => json(200, rel({ tag_name: 'v0.0.5' }))).check();
  assert.equal(older.available, false);

  const missing = make(async () => json(404, {}));
  assert.equal((await missing.check()).error.code, 'update.no-release', '自动检查失败：记下来，不抛');
  await assert.rejects(missing.check({ manual: true }), (e) => e.code === 'update.no-release', '点了「检查更新」：抛给设置页显示');
  assert.equal((await make(async () => json(403, {})).check()).error.code, 'update.rate-limited');
  assert.equal((await make(async () => { throw new Error('ECONNRESET'); }).check()).error.code, 'update.offline');
  assert.equal((await make(async () => json(500, {})).check()).error.code, 'update.http');
}

// ── 从源码跑：只检查不安装 ──────────────────────────────────────────────────
{
  const up = make(async () => json(200, rel()), { isPackaged: false });
  const st = await up.check();
  assert.deepEqual([st.available, st.canInstall], [true, false]);
  assert.throws(() => up.startInstall(), (e) => e.code === 'update.not-packaged');
  await assert.rejects(up.install(), (e) => e.code === 'update.not-packaged');
  const none = make(async () => json(200, rel({ tag_name: 'v0.1.0' })));
  await none.check();
  assert.throws(() => none.startInstall(), (e) => e.code === 'update.nothing');
}

// ── 真的下载、解压、核对、起脚本（Windows） ──────────────────────────────────
if (isWin) {
  // 新版本的包：和 npm run package 一样，zip 里一层 TomoPet-0.2.0-win-x64 文件夹
  const build = path.join(sandbox, 'build');
  const folder = path.join(build, 'TomoPet-0.2.0-win-x64');
  fs.mkdirSync(path.join(folder, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'TomoPet.exe'), 'NEW_EXE');
  fs.writeFileSync(path.join(folder, '使用说明.txt'), '新的说明');
  fs.writeFileSync(path.join(folder, 'resources', 'app', 'package.json'), JSON.stringify({ name: 'tomopet', version: '0.2.0' }));
  fs.writeFileSync(path.join(folder, 'resources', 'app', 'new.js'), 'NEW');
  const zip = path.join(sandbox, 'TomoPet-0.2.0-win-x64.zip');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ProgressPreference='SilentlyContinue'; Compress-Archive -LiteralPath '${folder}' -DestinationPath '${zip}' -Force`], { windowsHide: true });
  const bytes = fs.readFileSync(zip);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const server = http.createServer((req, res) => {
    if (req.url === '/zip') { res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const asset = (over = {}) => [{ name: 'TomoPet-0.2.0-win-x64.zip', size: bytes.length, browser_download_url: `https://placeholder/zip`, digest: `sha256:${sha}`, ...over }];
  // 「https://placeholder/zip」改走本机的假服务器（readRelease 只认 https，测试里把地址换掉）
  const viaLocal = (release) => async (url, init) => (url.includes('/releases/latest') ? json(200, release) : fetch(url.replace('https://placeholder', `http://127.0.0.1:${port}`), init));

  // 正在跑的旧版本
  const appDir = path.join(sandbox, '程序', 'TomoPet-0.1.0-win-x64');
  fs.mkdirSync(path.join(appDir, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'TomoPet.exe'), 'OLD_EXE');
  const spawned = [];
  let quits = 0;
  const up = createUpdater({
    currentVersion: '0.1.0', fetchImpl: viaLocal(rel({ assets: asset() })), tempDir: path.join(sandbox, 'temp'), exePath: path.join(appDir, 'TomoPet.exe'),
    isPackaged: true, logFile: path.join(sandbox, 'log.txt'), quit: () => { quits += 1; }, platform: 'win32', pid: 4242,
    // 假的 PowerShell：和真脚本一样先写出 started（程序看到它才退出）
    spawnImpl: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); fs.writeFileSync(path.join(args[args.indexOf('-Work') + 1], 'started'), 'ok'); return { on() {}, unref() {} }; },
  });
  fs.mkdirSync(path.join(sandbox, 'temp'), { recursive: true });
  await up.check();
  const st = await up.install();
  assert.equal(st.phase, 'restarting');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(quits, 1, '起了脚本之后退出程序');
  assert.equal(spawned.length, 1);
  const { cmd, args, opts } = spawned[0];
  const arg = (name) => args[args.indexOf(name) + 1];
  assert.equal(cmd, 'powershell.exe');
  assert.ok(opts.detached && opts.windowsHide, '脚本独立运行、不弹窗口');
  assert.equal(arg('-ProcId'), '4242');
  assert.equal(arg('-Dst'), appDir);
  assert.equal(arg('-Exe'), path.join(appDir, 'TomoPet.exe'));
  assert.ok(fs.existsSync(path.join(arg('-Src'), 'TomoPet.exe')) && fs.readFileSync(path.join(arg('-Src'), 'resources', 'app', 'new.js'), 'utf8') === 'NEW', '解压出来的新版本找到了');
  assert.ok(fs.readFileSync(arg('-File'), 'utf8').includes('Copy-Item'), '装新文件的脚本写好了');
  assert.ok(!fs.existsSync(path.join(sandbox, 'temp', 'TomoPet-update', 'TomoPet-0.2.0-win-x64.zip')), '解压完 zip 删掉');

  // 下载出错：大小不对、sha256 不对、包里版本不对 → 报错，不起脚本、不退出
  const bad = async (release, code) => {
    const calls = [];
    const u = createUpdater({
      currentVersion: '0.1.0', fetchImpl: viaLocal(release), tempDir: path.join(sandbox, 'temp'), exePath: path.join(appDir, 'TomoPet.exe'),
      isPackaged: true, logFile: path.join(sandbox, 'log.txt'), quit: () => calls.push('quit'), platform: 'win32',
      spawnImpl: () => { calls.push('spawn'); return { unref() {} }; },
    });
    await u.check();
    await assert.rejects(u.install(), (e) => e.code === code, code);
    const after = u.status();
    assert.deepEqual([after.phase, after.error.code, calls], [null, code, []], `${code}：不起脚本、不退出，可以再点一次`);
  };
  await bad(rel({ assets: asset({ size: bytes.length + 5 }) }), 'update.download-broken');
  await bad(rel({ assets: asset({ digest: `sha256:${'0'.repeat(64)}` }) }), 'update.download-corrupt');
  // GitHub 说是 0.3.0，包里其实是 0.2.0
  await bad(rel({ tag_name: 'v0.3.0', assets: [{ ...asset()[0], name: 'TomoPet-0.3.0-win-x64.zip' }] }), 'update.bad-package');

  // 脚本没跑起来（被安全软件 / 组策略拦了）：程序不退出，报错（复核发现原来会直接退出、再也不打开）
  const blocked = async (spawnImpl, label) => {
    let quit = 0;
    const u = createUpdater({
      currentVersion: '0.1.0', fetchImpl: viaLocal(rel({ assets: asset() })), tempDir: path.join(sandbox, 'temp'), exePath: path.join(appDir, 'TomoPet.exe'),
      isPackaged: true, logFile: path.join(sandbox, 'log.txt'), quit: () => { quit += 1; }, platform: 'win32', spawnImpl, scriptStartMs: 600,
    });
    await u.check();
    await assert.rejects(u.install(), (e) => e.code === 'update.script-blocked', label);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual([quit, u.status().phase, u.status().error.code], [0, null, 'update.script-blocked'], label);
  };
  await blocked(() => ({ on() {}, unref() {} }), '脚本一直没写出 started');
  await blocked(() => ({ on(ev, cb) { if (ev === 'error') setTimeout(() => cb(new Error('spawn powershell.exe ENOENT')), 20); }, unref() {} }), '起进程就出错');

  // 写盘出错（盘满了）：报错、能再点一次，不卡在「正在下载」（复核发现原来主进程弹异常、一直卡着）
  {
    const u = createUpdater({
      currentVersion: '0.1.0', fetchImpl: viaLocal(rel({ assets: asset() })), tempDir: path.join(sandbox, 'temp'), exePath: path.join(appDir, 'TomoPet.exe'),
      isPackaged: true, logFile: path.join(sandbox, 'log.txt'), quit: () => {}, platform: 'win32', spawnImpl: () => ({ on() {}, unref() {} }),
      openWrite: (file) => fs.createWriteStream(path.join(file, '不存在的文件夹', 'x.zip')),
    });
    await u.check();
    await assert.rejects(u.install(), (e) => e.code === 'update.write-failed');
    assert.deepEqual([u.status().phase, u.status().error.code], [null, 'update.write-failed']);
  }

  // 装之前的检查：程序文件夹写不进去时，点「更新」马上报错（复核发现原来在后台被吞掉、界面还说开始下载了）
  {
    const u = createUpdater({
      currentVersion: '0.1.0', fetchImpl: viaLocal(rel({ assets: asset() })), tempDir: path.join(sandbox, 'temp'), exePath: path.join(sandbox, '没有这个文件夹', 'TomoPet.exe'),
      isPackaged: true, logFile: path.join(sandbox, 'log.txt'), quit: () => {}, platform: 'win32',
    });
    await u.check();
    assert.throws(() => u.startInstall(), (e) => e.code === 'update.no-permission');
    assert.equal(u.status().phase, null);
  }
  server.close();

  // ── 装新文件的脚本：真的跑一遍（不重开程序）──────────────────────────────────
  const src = path.join(sandbox, '新版');
  const dst = path.join(sandbox, '旧版 有空格');
  fs.mkdirSync(path.join(src, 'resources', 'app'), { recursive: true });
  fs.mkdirSync(path.join(dst, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(src, 'TomoPet.exe'), 'NEW_EXE');
  fs.writeFileSync(path.join(src, 'resources', 'app', 'main.js'), 'NEW_MAIN');
  fs.writeFileSync(path.join(dst, 'TomoPet.exe'), 'OLD_EXE');
  fs.writeFileSync(path.join(dst, 'resources', 'app', 'main.js'), 'OLD_MAIN');
  fs.writeFileSync(path.join(dst, 'resources', 'app', 'gone.js'), 'OLD_ONLY');
  fs.writeFileSync(path.join(dst, '自己放的.txt'), 'KEEP');
  // 新旧文件大小一样、时间也一样（robocopy 默认会当成同一个文件跳过）：照样要盖上
  const same = new Date('2026-11-22T12:00:00Z');
  for (const f of [path.join(src, 'TomoPet.exe'), path.join(dst, 'TomoPet.exe'), path.join(src, 'resources', 'app', 'main.js'), path.join(dst, 'resources', 'app', 'main.js')]) fs.utimesSync(f, same, same);
  const work = path.join(sandbox, 'work');
  fs.mkdirSync(work, { recursive: true });
  const script = path.join(work, 'install.ps1');
  fs.writeFileSync(script, `﻿${INSTALL_SCRIPT}`, 'utf8');
  const log = path.join(sandbox, 'install-log.txt');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProcId', '999999', '-Src', src, '-Dst', dst, '-Exe', path.join(dst, 'TomoPet.exe'), '-Work', work, '-Log', log, '-NoStart'], { windowsHide: true, timeout: 60_000 });
  assert.equal(fs.readFileSync(path.join(dst, 'TomoPet.exe'), 'utf8'), 'NEW_EXE', 'exe 换成新的');
  assert.equal(fs.readFileSync(path.join(dst, 'resources', 'app', 'main.js'), 'utf8'), 'NEW_MAIN', '程序换成新的');
  assert.ok(!fs.existsSync(path.join(dst, 'resources', 'app', 'gone.js')), 'resources\\app 里旧版才有的文件去掉');
  assert.equal(fs.readFileSync(path.join(dst, '自己放的.txt'), 'utf8'), 'KEEP', '程序文件夹里别的东西不动');
  assert.ok(!fs.existsSync(work), '临时文件夹删掉（started 也在里面）');
  assert.ok(!fs.readdirSync(dst).some((n) => n.startsWith('.update-old-')), '装好后备份删掉');
  assert.ok(fs.readFileSync(log, 'utf8').includes('新版本装好了'), '结果写进日志');

  // 装到一半失败（拷最后一项时失败）：exe、resources 都换回旧的，新版本才有的东西删掉，备份不留下（复核发现原来只换回 resources\\app）
  const src3 = path.join(sandbox, '第三版');
  const dst3 = path.join(sandbox, '第二版');
  for (const d of [src3, dst3]) fs.mkdirSync(path.join(d, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(src3, 'TomoPet.exe'), 'V3_EXE');
  fs.writeFileSync(path.join(src3, 'icudtl.dat'), 'V3_ICU');
  fs.writeFileSync(path.join(src3, 'resources', 'app', 'main.js'), 'V3_MAIN');
  fs.writeFileSync(path.join(src3, 'zzz-新的说明.txt'), 'V3_ONLY');
  fs.writeFileSync(path.join(dst3, 'TomoPet.exe'), 'V2_EXE');
  fs.writeFileSync(path.join(dst3, 'icudtl.dat'), 'V2_ICU');
  fs.writeFileSync(path.join(dst3, 'resources', 'app', 'main.js'), 'V2_MAIN');
  fs.writeFileSync(path.join(dst3, 'resources', 'app', 'only-v2.js'), 'V2_ONLY');
  fs.writeFileSync(path.join(dst3, '自己放的.txt'), 'KEEP');
  const work3 = path.join(sandbox, 'work3');
  fs.mkdirSync(work3, { recursive: true });
  const script3 = path.join(work3, 'install.ps1');
  fs.writeFileSync(script3, `\uFEFF${INSTALL_SCRIPT}`, 'utf8');
  const log3 = path.join(sandbox, 'install-log3.txt');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script3, '-ProcId', '999998', '-Src', src3, '-Dst', dst3, '-Exe', path.join(dst3, 'TomoPet.exe'), '-Work', work3, '-Log', log3, '-NoStart', '-FailOn', 'zzz-新的说明.txt'], { windowsHide: true, timeout: 60_000 });
  assert.deepEqual(
    [fs.readFileSync(path.join(dst3, 'TomoPet.exe'), 'utf8'), fs.readFileSync(path.join(dst3, 'icudtl.dat'), 'utf8'), fs.readFileSync(path.join(dst3, 'resources', 'app', 'main.js'), 'utf8'), fs.existsSync(path.join(dst3, 'resources', 'app', 'only-v2.js'))],
    ['V2_EXE', 'V2_ICU', 'V2_MAIN', true], '全部换回旧版本，不留一半新一半旧');
  assert.ok(!fs.existsSync(path.join(dst3, 'zzz-新的说明.txt')), '新版本才有的东西删掉');
  assert.equal(fs.readFileSync(path.join(dst3, '自己放的.txt'), 'utf8'), 'KEEP');
  assert.ok(!fs.readdirSync(dst3).some((n) => n.startsWith('.update-old-')), '备份挪回去了，不留下');
  const logText = fs.readFileSync(log3, 'utf8');
  assert.ok(logText.includes('更新没装上') && logText.includes('已经换回旧版本'), logText);
}

// ── 找程序文件夹 ──────────────────────────────────────────────────────────────
{
  const root = path.join(sandbox, 'find');
  const deep = path.join(root, 'a', 'TomoPet-9.9.9-win-x64');
  fs.mkdirSync(path.join(deep, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(deep, 'TomoPet.exe'), '');
  assert.equal(findAppFolder(root, 'TomoPet.exe'), '', '没有 package.json 不算');
  fs.writeFileSync(path.join(deep, 'resources', 'app', 'package.json'), '{}');
  assert.equal(findAppFolder(root, 'TomoPet.exe'), deep);
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('updater: ok');
