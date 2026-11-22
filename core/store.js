/**
 * 数据目录和文件读写。
 *
 * 数据目录：环境变量 OSU_PET_HOME；没有就由 Electron 主进程在启动时用 setDataDir(app.getPath('userData')) 定下来
 * （Windows 上是 %APPDATA%\osu-pet）。测试一律设 OSU_PET_HOME 指到临时目录。
 * 这里不读任何别的程序的目录（尤其是 ~/.dsh）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let explicitDir = '';

export function setDataDir(dir) {
  explicitDir = dir ? path.resolve(dir) : '';
}

export function dataDir() {
  const dir = process.env.OSU_PET_HOME ? path.resolve(process.env.OSU_PET_HOME) : explicitDir || path.join(os.homedir(), '.osu-pet');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const dataPath = (...parts) => path.join(dataDir(), ...parts);

export const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

/** 先写临时文件再改名，写到一半断电不会留下半个文件。 */
export function writeJsonAtomic(file, value, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

/** 改文件之前留一份备份（backups/<tag>-<时间>.json），只留最近 keep 份。没有原文件返回 null。 */
export function backupFile(file, tag, { keep = 10, now = Date.now } = {}) {
  if (!fs.existsSync(file)) return null;
  const dir = dataPath('backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `${tag}-${stamp}.json`);
  fs.copyFileSync(file, target);
  const old = fs.readdirSync(dir).filter((name) => name.startsWith(`${tag}-`)).sort();
  for (const name of old.slice(0, Math.max(0, old.length - keep))) {
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch {}
  }
  return target;
}

/**
 * 递归拷一个文件夹（不跟符号链接）。
 * 不用 fs.cpSync：Node 22 / 24 在 Windows 上遇到非 ASCII 路径会把目标路径写成乱码
 * （实测 2026-11-20，Node 24.14：拷到「游戏用\dst」结果建出了「娓告垙鐢╘\dst」）——而用户的 tosu 就装在 D:\游戏用\。
 */
export function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyDirSync(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/** 结构化的失败：{ ok:false, code, error, hint }。 */
export function failure(code, error, hint) {
  return { ok: false, code, error, hint };
}

/** 带 code / hint 的异常（服务内部用，最后由 failureOf 转成结构化失败）。 */
export function codedError(code, error, hint) {
  const err = new Error(error);
  err.code = code;
  err.hint = hint;
  return err;
}

export function failureOf(error, fallbackHint = '看日志里的详细信息。') {
  return {
    ok: false,
    code: typeof error?.code === 'string' && error.code.includes('.') ? error.code : 'app.unexpected',
    error: String(error?.message ?? error).slice(0, 240),
    hint: typeof error?.hint === 'string' && error.hint ? error.hint : fallbackHint,
  };
}
