/**
 * 程序自己的窗口（设置、字幕、桌面角色）都从 osupet://local/… 加载，这里把地址换成磁盘上的文件。
 *
 * 为什么不用 file://：网页里 fetch() 读不了 file:// 地址（皮肤清单 manifest.json 要 fetch）；
 * 而且页面和皮肤图片要同源，PixiJS 才能把图片传进 WebGL（跨源的图会被拒）。
 *
 *   osupet://local/app/…          <程序目录>/app/…（页面）
 *   osupet://local/dist/…         <程序目录>/dist/…（打包好的渲染层）
 *   osupet://local/assets/…       <程序目录>/assets/…（logo）
 *   osupet://local/skin/<id>/…    皮肤：在 skins.skinDirFor(id) 选中的文件夹里找（数据目录 → skins-bundled）
 *
 * 只认这几个前缀，而且解析后的路径必须还在对应的文件夹里面（防 ../）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const SCHEME = 'osupet';
export const ORIGIN = `${SCHEME}://local`;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function within(root, parts) {
  const full = path.resolve(root, ...parts);
  const rel = path.relative(root, full);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? full : '';
}

/**
 * @param {string} url
 * @param {{appRoot:string, skinRoots:string[]}} roots   appRoot = 程序目录；skinRoots = 皮肤文件夹（按优先顺序）
 * @returns {string} 磁盘路径；不认识 / 越界 / 不存在返回空串
 */
export function resolveLocalUrl(url, { appRoot, skinRoots = [], skinDir = null }) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return ''; }
  if (parsed.protocol !== `${SCHEME}:` || parsed.host !== 'local') return '';
  let parts;
  try { parts = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part)); } catch { return ''; }
  if (parts.some((part) => part === '..' || part.includes('\\') || part.includes('\0'))) return '';
  const [head, ...rest] = parts;
  if (!rest.length) return '';
  if (head === 'app' || head === 'dist' || head === 'assets') {
    const file = within(path.join(appRoot, head), rest);
    return file && fs.existsSync(file) && fs.statSync(file).isFile() ? file : '';
  }
  if (head === 'skin') {
    const [id, ...inner] = rest;
    if (!ID_PATTERN.test(id) || !inner.length) return '';
    // 给了 skinDir(id)：只在 resolveSkin 选中的那个文件夹里找（图和清单出自同一份，不会一个文件一个文件地混着来）。
    if (typeof skinDir === 'function') {
      const dir = skinDir(id);
      const file = dir ? within(dir, inner) : '';
      return file && fs.existsSync(file) && fs.statSync(file).isFile() ? file : '';
    }
    for (const root of skinRoots) {
      const file = within(path.join(root, id), inner);
      if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return '';
}

export const skinBaseUrl = (id) => `${ORIGIN}/skin/${encodeURIComponent(id)}/`;
