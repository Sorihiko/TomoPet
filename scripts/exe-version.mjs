/**
 * 改打包出来的 exe 的版本信息：任务管理器「进程」里的「描述」、右键「属性 → 详细信息」里的产品名、公司、版权、版本号。
 * 2026-11-20 用户：「把描述改成 TomoPet，这个项目叫 TomoPet」。原来是 Electron 自己的（描述 Electron、公司 GitHub, Inc.）。
 *
 * 只用 Windows 自带的东西：scripts/win/set-exe-version.ps1（UpdateResource 写一份新的 VS_VERSIONINFO），
 * 写完用 .NET 的 FileVersionInfo 读回来核对。失败都抛带 code / hint 的错误（version.*）。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class VersionError extends Error {
  constructor(code, message, hint) { super(message); this.code = code; this.hint = hint; }
}

/** 读 set-exe-version.ps1 的输出（一行一项「键=值」）。 */
export function parseVersionInfo(text) {
  const out = {};
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** 0.1.0 → 0.1.0.0（版本信息里是四段）。 */
export const fourPart = (v) => [...String(v || '0').split('.').map((x) => Math.min(65535, Number.parseInt(x, 10) || 0)), 0, 0, 0, 0].slice(0, 4).join('.');

/**
 * 写版本信息并核对。want：{ description, product, version, company, copyright }。返回读回来的信息。
 */
export function setExeVersion(exe, want, { run = execFileSync } = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'win', 'set-exe-version.ps1'), '-Exe', exe,
    // 版本号在这边算成四段再传过去（复核：1.2.3-rc.1 这种两边拆法不一样，会被误判成写错）。
    '-Description', want.description, '-Product', want.product, '-Version', fourPart(want.version), '-Company', want.company || want.product, '-Copyright', want.copyright || ''];
  let out;
  try {
    out = String(run('powershell.exe', args, { encoding: 'utf8', windowsHide: true }));
  } catch (error) {
    throw new VersionError('version.write-failed', `改 exe 版本信息失败：${String(error?.stderr || error?.message || error).trim().slice(0, 200)}`, '打包版的 TomoPet 可能还开着（右键托盘图标 →「退出」）；还不行就先用 npm run package -- --no-version 打包。');
  }
  const info = parseVersionInfo(out);
  const expected = { FileDescription: want.description, ProductName: want.product, FileVersion: fourPart(want.version), ProductVersion: fourPart(want.version) };
  const wrong = Object.entries(expected).filter(([k, v]) => info[k] !== v);
  if (wrong.length) {
    throw new VersionError('version.verify-failed', `改完版本信息读回来不对：${wrong.map(([k, v]) => `${k} 应该是「${v}」，读到「${info[k] ?? ''}」`).join('；')}`, '删掉 release 文件夹重新打包；还不行就先用 npm run package -- --no-version。');
  }
  return info;
}
