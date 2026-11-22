/**
 * 把 osu-pet 的 logo（assets/logo.png）做成 exe 图标，写进打包出来的 osu-pet.exe。
 * 2026-11-20 用户：「把 exe 图标也换成我的 logo」。
 *
 * 只用 Windows 自带的东西，不另外下载工具（rcedit 之类）：
 *   1. scripts/win/resize-png.ps1：System.Drawing 把 logo 缩成 16 / 24 / 32 / 48 / 64 / 128 / 256 七个尺寸；
 *   2. makeIco（这里）：七张 PNG 拼成一个 .ico（每张原样用 PNG 存，Windows Vista 起都认）；
 *   3. scripts/win/set-exe-icon.ps1：用系统的 UpdateResource 把 exe 里原来的图标组换掉。
 * 写完再读一遍 exe 里的图标组，核对七个尺寸都在。失败都抛带 code / hint 的错误（打包脚本照样显示）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

export class IconError extends Error {
  constructor(code, message, hint) { super(message); this.code = code; this.hint = hint; }
}

/** PNG 的宽高（读 IHDR）。不是 PNG 返回 null。 */
export function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/**
 * 几张 PNG → 一个 .ico 文件（Buffer）。images: [{ size, data }]，按尺寸从小到大排。
 * ICONDIR（6 字节）+ 每张一个 ICONDIRENTRY（16 字节）+ 图片数据。宽高 256 写成 0（.ico 的规定）。
 */
export function makeIco(images) {
  const list = [...images].sort((a, b) => a.size - b.size);
  if (!list.length) throw new IconError('icon.no-images', '没有图片可以拼成图标', '这是打包脚本的问题。');
  for (const img of list) {
    const s = pngSize(img.data);
    if (!s || s.w !== img.size || s.h !== img.size) throw new IconError('icon.bad-image', `第 ${img.size} 像素那张不是 ${img.size}×${img.size} 的 PNG`, '这是打包脚本的问题：检查 scripts/win/resize-png.ps1。');
    if (img.size > 256) throw new IconError('icon.bad-image', `图标最大 256 像素，给的是 ${img.size}`, '这是打包脚本的问题。');
  }
  const header = Buffer.alloc(6 + list.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = 图标
  header.writeUInt16LE(list.length, 4);
  let offset = header.length;
  list.forEach((img, i) => {
    const o = 6 + i * 16;
    header.writeUInt8(img.size >= 256 ? 0 : img.size, o);
    header.writeUInt8(img.size >= 256 ? 0 : img.size, o + 1);
    header.writeUInt8(0, o + 2); // 调色板颜色数（真彩色写 0）
    header.writeUInt8(0, o + 3);
    header.writeUInt16LE(1, o + 4); // 平面数
    header.writeUInt16LE(32, o + 6); // 每像素位数
    header.writeUInt32LE(img.data.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += img.data.length;
  });
  return Buffer.concat([header, ...list.map((img) => img.data)]);
}

const ps = (run, script, args, opts = {}) => String(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'win', script), ...args], { encoding: 'utf8', windowsHide: true, ...opts }));

/** logo.png → .ico（写到 icoFile）。 */
export function buildIco(logo, icoFile, { run = execFileSync, tmpRoot = os.tmpdir() } = {}) {
  if (!fs.existsSync(logo)) throw new IconError('icon.no-logo', `找不到 logo：${logo}`, '把 logo 存成项目文件夹里的 assets/logo.png，再打包。');
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'osu-pet-icon-'));
  try {
    try {
      ps(run, 'resize-png.ps1', ['-Source', logo, '-OutDir', tmp, '-Sizes', ICON_SIZES.join(',')]);
    } catch (error) {
      throw new IconError('icon.resize-failed', `logo 缩放失败：${String(error?.stderr || error?.message || error).trim().slice(0, 160)}`, '确认 assets/logo.png 是一张正常的 PNG；还不行就先用 npm run package -- --no-icon 打包。');
    }
    const images = ICON_SIZES.map((size) => ({ size, data: fs.readFileSync(path.join(tmp, `${size}.png`)) }));
    fs.writeFileSync(icoFile, makeIco(images));
    return icoFile;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 读 set-exe-icon.ps1 -Inspect 的输出：group=1 lang=1033 icons=16x16#7:1234,… → { group, lang, sizes:[16,…] }。 */
export function parseInspect(text) {
  const m = /group=(\d+) lang=(\d+) icons=(\S*)/.exec(String(text));
  if (!m) return null;
  const sizes = m[3].split(',').filter(Boolean).map((part) => Number(/^(\d+)x/.exec(part)?.[1])).filter(Boolean);
  return { group: Number(m[1]), lang: Number(m[2]), sizes };
}

/** 把 .ico 写进 exe，再读回来核对尺寸。返回 parseInspect 的结果。 */
export function setExeIcon(exe, icoFile, { run = execFileSync } = {}) {
  let out;
  try {
    out = ps(run, 'set-exe-icon.ps1', ['-Exe', exe, '-Ico', icoFile]);
  } catch (error) {
    throw new IconError('icon.write-failed', `换 exe 图标失败：${String(error?.stderr || error?.message || error).trim().slice(0, 200)}`, '打包版的 TomoPet 可能还开着（右键托盘图标 →「退出」）；还不行就先用 npm run package -- --no-icon 打包。');
  }
  const info = parseInspect(out);
  const want = ICON_SIZES;
  if (!info || want.some((s) => !info.sizes.includes(s))) {
    throw new IconError('icon.verify-failed', `换完图标读回来不对：${String(out).trim().slice(0, 160)}`, '删掉 release 文件夹重新打包；还不行就先用 npm run package -- --no-icon。');
  }
  return info;
}
