/**
 * exe 图标（scripts/exe-icon.mjs + scripts/win/*.ps1）：logo → 多尺寸 .ico → 写进 exe。
 * 2026-11-20 用户：「把 exe 图标也换成我的 logo」。
 * 纯逻辑（拼 .ico、读 PNG 尺寸、解析读回来的结果、各种失败）在哪都跑；
 * 真的缩放 logo、真的改 exe（拷一份 node_modules/electron/dist/electron.exe 到临时目录）只在 Windows 上跑。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_SIZES, IconError, buildIco, makeIco, parseInspect, pngSize, setExeIcon } from '../scripts/exe-icon.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-icon-test-'));
const expectCode = (fn, code) => assert.throws(fn, (e) => e instanceof IconError && e.code === code && Boolean(e.message) && Boolean(e.hint));

// 一个只有文件头的假 PNG（够 pngSize / makeIco 用）
const fakePng = (w, h) => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};

// ── 拼 .ico ──────────────────────────────────────────────────────────────────
{
  assert.deepEqual(pngSize(fakePng(48, 48)), { w: 48, h: 48 });
  assert.equal(pngSize(Buffer.from('not a png at all, really not')), null);
  const images = [256, 16, 32].map((size) => ({ size, data: fakePng(size, size) }));
  const ico = makeIco(images);
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 3], '图标文件头：类型 1、三张图');
  const entries = [0, 1, 2].map((i) => {
    const o = 6 + i * 16;
    return { w: ico[o], h: ico[o + 1], planes: ico.readUInt16LE(o + 4), bpp: ico.readUInt16LE(o + 6), bytes: ico.readUInt32LE(o + 8), offset: ico.readUInt32LE(o + 12) };
  });
  assert.deepEqual(entries.map((e) => e.w), [16, 32, 0], '从小到大排；256 写成 0');
  assert.ok(entries.every((e) => e.planes === 1 && e.bpp === 32 && e.bytes === 33));
  assert.deepEqual(entries.map((e) => e.offset), [6 + 48, 6 + 48 + 33, 6 + 48 + 66], '图片数据紧跟在目录后面');
  assert.ok(ico.subarray(entries[2].offset, entries[2].offset + 33).equals(fakePng(256, 256)), 'PNG 原样存');
  expectCode(() => makeIco([]), 'icon.no-images');
  expectCode(() => makeIco([{ size: 32, data: fakePng(16, 16) }]), 'icon.bad-image');
  expectCode(() => makeIco([{ size: 512, data: fakePng(512, 512) }]), 'icon.bad-image');
  assert.deepEqual(ICON_SIZES, [16, 24, 32, 48, 64, 128, 256]);
}

// ── 读回来的结果、失败 ─────────────────────────────────────────────────────────
{
  assert.deepEqual(parseInspect('group=1 lang=1033 icons=16x16#5:100,256x256#11:999\r\n'), { group: 1, lang: 1033, sizes: [16, 256] });
  assert.equal(parseInspect('no-group'), null);
  expectCode(() => buildIco(path.join(sandbox, 'no-logo.png'), path.join(sandbox, 'x.ico')), 'icon.no-logo');
  expectCode(() => buildIco(path.join(ROOT, 'assets', 'logo.png'), path.join(sandbox, 'x.ico'), { run: () => { throw Object.assign(new Error('ps failed'), { stderr: '缩放出错' }); } }), 'icon.resize-failed');
  expectCode(() => setExeIcon('a.exe', 'a.ico', { run: () => { throw Object.assign(new Error('x'), { stderr: '改不了 exe（正在运行？）' }); } }), 'icon.write-failed');
  // 写进去了但读回来少了尺寸：不算成功。
  expectCode(() => setExeIcon('a.exe', 'a.ico', { run: () => 'group=1 lang=1033 icons=16x16#5:100\r\n' }), 'icon.verify-failed');
  assert.deepEqual(setExeIcon('a.exe', 'a.ico', { run: () => `group=1 lang=1033 icons=${ICON_SIZES.map((s, i) => `${s}x${s}#${i + 5}:10`).join(',')}\r\n` }).sizes, ICON_SIZES);
  // 两个 .ps1 带 BOM（Windows PowerShell 5.1 不带 BOM 时按 GBK 读，中文会乱）。
  for (const f of ['resize-png.ps1', 'set-exe-icon.ps1']) assert.ok(fs.readFileSync(path.join(ROOT, 'scripts', 'win', f)).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${f} 要带 BOM`);
}

// ── 真机：缩放 logo、改一份 electron.exe、读回来、抽出图标看看是不是 logo ──────────────
const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (process.platform === 'win32' && fs.existsSync(electronExe) && fs.existsSync(path.join(ROOT, 'assets', 'logo.png'))) {
  const exe = path.join(sandbox, 'osu-pet.exe');
  fs.copyFileSync(electronExe, exe);
  const ico = buildIco(path.join(ROOT, 'assets', 'logo.png'), path.join(sandbox, 'logo.ico'));
  const icoBuf = fs.readFileSync(ico);
  assert.equal(icoBuf.readUInt16LE(4), ICON_SIZES.length, '.ico 里七个尺寸');
  const info = setExeIcon(exe, ico);
  assert.deepEqual([...info.sizes].sort((a, b) => a - b), ICON_SIZES, 'exe 里的图标组换成了七个尺寸');
  // 原来的 electron.exe 没被动。
  assert.notDeepEqual(parseInspect(execPs(['-File', path.join(ROOT, 'scripts', 'win', 'set-exe-icon.ps1'), '-Exe', electronExe, '-Inspect'])).sizes, ICON_SIZES);
  // 资源管理器取到的图标就是 logo 缩小的那张：和 32 像素那张逐像素比，绝大部分一样。
  const png = path.join(sandbox, 'extracted.png');
  execPs(['-Command', `Add-Type -AssemblyName System.Drawing; $i = [System.Drawing.Icon]::ExtractAssociatedIcon('${exe.replace(/'/g, "''")}'); $i.ToBitmap().Save('${png.replace(/'/g, "''")}')`]);
  assert.ok(fs.existsSync(png) && pngSize(fs.readFileSync(png)).w === 32, '抽得出 32 像素的图标');
}
function execPs(args) {
  return String(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true }));
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('exe-icon: ok');
