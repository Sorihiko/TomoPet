/**
 * 程序改名 TomoPet（2026-11-20 用户：「把描述改成 TomoPet，这个项目叫 TomoPet」）：
 *   · exe 版本信息（scripts/exe-version.mjs + scripts/win/set-exe-version.ps1）：任务管理器里的「描述」、属性里的产品名等；
 *   · 看得见的名字都改了，但数据目录还是 %APPDATA%\osu-pet（不然已经填好的 Key、设置全「不见」）。
 * 真的改 exe（拷一份 node_modules/electron/dist/electron.exe 到临时目录）只在 Windows 上跑。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VersionError, fourPart, parseVersionInfo, setExeVersion } from '../scripts/exe-version.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tomopet-version-test-'));
const expectCode = (fn, code) => assert.throws(fn, (e) => e instanceof VersionError && e.code === code && Boolean(e.message) && Boolean(e.hint));
const want = { description: 'TomoPet', product: 'TomoPet', version: '0.1.0', company: 'TomoPet', copyright: 'Copyright (c) 2026 TomoPet contributors' };

// ── 纯逻辑 ───────────────────────────────────────────────────────────────────
{
  assert.deepEqual(parseVersionInfo('﻿FileDescription=TomoPet\r\nProductName=TomoPet\r\nFileVersion=0.1.0.0\r\nnoise\r\n'), { FileDescription: 'TomoPet', ProductName: 'TomoPet', FileVersion: '0.1.0.0' });
  assert.deepEqual([fourPart('0.1.0'), fourPart('1.2'), fourPart('3.4.5.6.7'), fourPart('99999.0.0'), fourPart('')], ['0.1.0.0', '1.2.0.0', '3.4.5.6', '65535.0.0.0', '0.0.0.0']);
  const good = 'FileDescription=TomoPet\nProductName=TomoPet\nFileVersion=0.1.0.0\nProductVersion=0.1.0.0\n';
  assert.equal(setExeVersion('a.exe', want, { run: () => good }).ProductName, 'TomoPet');
  expectCode(() => setExeVersion('a.exe', want, { run: () => { throw Object.assign(new Error('x'), { stderr: '改不了 exe（正在运行？）' }); } }), 'version.write-failed');
  // 写了但读回来还是 Electron：不算成功，说清楚哪一项不对。
  assert.throws(() => setExeVersion('a.exe', want, { run: () => good.replace('FileDescription=TomoPet', 'FileDescription=Electron') }), (e) => e.code === 'version.verify-failed' && e.message.includes('Electron') && Boolean(e.hint));
  assert.ok(fs.readFileSync(path.join(ROOT, 'scripts', 'win', 'set-exe-version.ps1')).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'set-exe-version.ps1 要带 BOM');
  for (const f of ['set-exe-version.ps1', 'set-exe-icon.ps1', 'resize-png.ps1']) assert.ok(fs.readFileSync(path.join(ROOT, 'scripts', 'win', f), 'utf8').includes('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'), `${f} 报错按 UTF-8 出（不然中文乱码）`);
}

// ── 改名：看得见的叫 TomoPet，数据目录还是 osu-pet ───────────────────────────────
{
  const main = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');
  assert.ok(main.includes("export const DATA_FOLDER = 'osu-pet';") && main.includes("app.setPath('userData', path.join(app.getPath('appData'), DATA_FOLDER))"), '数据目录固定是 %APPDATA%\\osu-pet');
  assert.ok(main.includes("export const APP_NAME = 'TomoPet';") && main.includes('app.setName(APP_NAME)') && main.includes('`${APP_NAME} 设置`') && main.includes('`${APP_NAME} · 看你打 osu!`'));
  assert.ok(!/'osu-pet 设置'|'osu-pet 启动失败'|'osu-pet · /.test(main), '窗口标题、托盘、报错框里不再是 osu-pet');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual([pkg.name, pkg.productName], ['tomopet', 'TomoPet']);
  assert.ok(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8').includes('Copyright (c) 2026 TomoPet contributors'));
  const settings = fs.readFileSync(path.join(ROOT, 'app', 'settings', 'index.html'), 'utf8');
  assert.ok(settings.includes('<title>TomoPet 设置</title>') && settings.includes('<div class="brand-name">TomoPet</div>'));
  for (const f of ['counter/pet/metadata.txt', 'counter/subtitle/metadata.txt']) assert.ok(fs.readFileSync(path.join(ROOT, f), 'utf8').includes('（TomoPet）'), `${f}：tosu 里显示 TomoPet`);
}

// ── 真机：改一份 electron.exe 的版本信息，读回来 ───────────────────────────────
const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (process.platform === 'win32' && fs.existsSync(electronExe)) {
  const exe = path.join(sandbox, 'TomoPet.exe');
  fs.copyFileSync(electronExe, exe);
  const info = setExeVersion(exe, want);
  assert.deepEqual([info.FileDescription, info.ProductName, info.CompanyName, info.FileVersion, info.ProductVersion, info.OriginalFilename, info.LegalCopyright],
    ['TomoPet', 'TomoPet', 'TomoPet', '0.1.0.0', '0.1.0.0', 'TomoPet.exe', 'Copyright (c) 2026 TomoPet contributors']);
  // 再改一次（重新打包时会这样）：照样对。
  assert.equal(setExeVersion(exe, { ...want, version: '0.2.0' }).FileVersion, '0.2.0.0');
  // 复核：带预发布后缀的版本号（1.2.3-rc.1）两边算法一致，不会误判成写错。
  assert.equal(setExeVersion(exe, { ...want, version: '1.2.3-rc.1' }).FileVersion, '1.2.3.1');
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('exe-version: ok');
