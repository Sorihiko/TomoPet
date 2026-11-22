/**
 * 把角色做成 tosu 的 counter，给 OBS 用（浏览器源）：只在录制 / 直播里出现，自己屏幕上看不到。
 * 照搬 SurfCore lib/osu/tosu-counter.js；渲染层和皮肤的来源换成本项目自己的。
 *
 * 为什么（2026-11-19，用户：「有没有办法把小鲸鱼做到 tosu 里去，我 obs 捕获能看见，本地看不见」）：
 * tosu 把 static 文件夹里的每个子文件夹当成一个 counter 网页，放在 http://127.0.0.1:24050/<文件夹>/ 下；
 * OBS 的浏览器源加这个地址就行。osu! 要用全屏独占英伟达即时回放才会录，那时本地窗口盖不上去，所以 OBS 叠加是主要的显示方式。
 *
 *   · <static>/fatfish-osu/           角色页：counter/pet/ 的 index.html / counter.js / metadata.txt（settings.json 只在没有时写）
 *                                     + dist/counter-renderer.js（拷成 renderer.js）+ 当前选的皮肤（拷成 skin/）
 *   · <static>/fatfish-osu-subtitle/  铺满画面的字幕页（读同一份 state.json）
 *   · 她开口时写 state.json（{ seq, text, durationMs, rev }），网页每 0.4 秒读一次：张嘴 + 气泡 / 字幕；
 *   · 换了皮肤 / 页面文件变了：rev 加一，网页自己重载。
 *
 * tosu 在哪：先看设置 counter.tosuDir，没有就看正在跑的 tosu.exe 的位置；static 文件夹按 tosu.env 的 STATIC_FOLDER_PATH（默认 ./static）。
 * 失败都带 code / error / hint，显示在设置窗口「OBS」那一块。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { copyDirSync, failure } from './store.js';
import { cleanMouthTrack } from './speakable.js';

export const COUNTER_FOLDER = 'fatfish-osu';
export const SUBTITLE_FOLDER = 'fatfish-osu-subtitle';
// SurfCore 原来那只（osu-pet 就是从它拆出来的）装进 tosu 的文件夹。它最近说过话 = SurfCore 也在看你打 osu!，两边会各说一句。
// 只读它的 state.json 里的 at（最后一次开口的时间），别的不碰。
export const SURFCORE_COUNTER_FOLDER = 'surfcore-xiaojingyu';
export const OTHER_WATCHER_RECENT_MS = 30 * 60 * 1000;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_DIR = path.join(ROOT, 'counter', 'pet');
const SUBTITLE_ASSET_DIR = path.join(ROOT, 'counter', 'subtitle');
const RENDERER_FILE = path.join(ROOT, 'dist', 'counter-renderer.js');
const PAGE_FILES = ['index.html', 'counter.js', 'metadata.txt'];
const MARKER = '.osu-pet-counter.json';

/** tosu 的网页地址：从 websocket 地址换算（ws://127.0.0.1:24050/websocket/v2 → http://127.0.0.1:24050）。 */
export function tosuHttpBase(wsUrl) {
  try {
    const url = new URL(String(wsUrl));
    return `${url.protocol === 'wss:' ? 'https' : 'http'}://${url.host}`;
  } catch {
    return 'http://127.0.0.1:24050';
  }
}

/**
 * 角色页的设置：tosu 会把用户改的值（value）写回 settings.json，这些值一律保留；
 * 其余的（标题、说明、选项）照模板更新——2026-11-20 改名 TomoPet 后复核发现，原来「每项都在就不动」，
 * 已经装过的人在 tosu 里一直看到旧的「osu-pet 字幕」说明。少了新加的项时补上。
 * 返回 'kept'（一样，没写）| 'created' | 'migrated'（补了新项）| 'refreshed'（只更新了标题 / 说明 / 选项）。
 */
export function ensureCounterSettings(file, templateFile) {
  const template = JSON.parse(fs.readFileSync(templateFile, 'utf8'));
  let current = null;
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!Array.isArray(current)) {
    fs.writeFileSync(file, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
    return 'created';
  }
  const ids = new Set(current.map((x) => x && x.uniqueID));
  const old = Object.fromEntries(current.filter((x) => x && x.uniqueID).map((x) => [x.uniqueID, x.value]));
  const next = template.map((t) => {
    if (t.uniqueID in old) return { ...t, value: old[t.uniqueID] };
    // SurfCore 第一版只有「显示字幕」勾选：勾掉的换成「都不显示」。
    if (t.uniqueID === 'lineStyle' && old.showSubtitle === false) return { ...t, value: '都不显示' };
    return t;
  });
  if (JSON.stringify(next) === JSON.stringify(current)) return 'kept';
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return template.every((t) => ids.has(t.uniqueID)) ? 'refreshed' : 'migrated';
}

/**
 * 正在跑的 tosu.exe 的完整路径（Windows；找不到返回空串）。
 * PowerShell 默认按系统代码页（中文系统是 GBK）输出，Node 按 UTF-8 读会把中文路径读成乱码——
 * 2026-11-19 真机上 `D:\游戏用\tosu.exe` 被读成乱码，counter 装进了 D 盘根目录一个乱码文件夹。
 * 所以先把输出编码切成 UTF-8，并且只认真实存在的路径。
 */
export const TOSU_QUERY = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; (Get-Process tosu -ErrorAction SilentlyContinue | Select-Object -First 1).Path';
export function findRunningTosu({ run = execFile, platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return Promise.resolve('');
  return new Promise((resolve) => {
    try {
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TOSU_QUERY],
        { timeout: 8000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
          const found = error ? '' : String(stdout || '').replace(/^\uFEFF/, '').trim();
          resolve(found && exists(found) ? found : '');
        });
    } catch {
      resolve('');
    }
  });
}

/** tosu 目录 → static 文件夹（读 tosu.env 的 STATIC_FOLDER_PATH，相对路径按 tosu 目录算）。 */
export function staticDirOf(tosuDir) {
  let rel = './static';
  try {
    const env = fs.readFileSync(path.join(tosuDir, 'tosu.env'), 'utf8');
    const m = /^\s*STATIC_FOLDER_PATH\s*=\s*(.+?)\s*$/m.exec(env);
    if (m && m[1]) rel = m[1].replace(/^["']|["']$/g, '');
  } catch {}
  return path.resolve(tosuDir, rel);
}

const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

/**
 * 先写临时文件再改名覆盖；改名被拒（Windows 上目标文件正被别人打开：OBS 每 0.4 秒经 tosu 读一次 state.json）
 * 就等几十毫秒重试，还不行就直接覆盖写（不是原子的，网页偶尔读到半截会在下一次重读）。
 * 2026-11-19 真机：同步时 rename 撞上 tosu 正在读 → 这次同步写到一半就停了。
 */
export function writeFileReplacing(dst, data, { attempts = 5, waitMs = 40 } = {}) {
  const tmp = `${dst}.osu-pet-${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(tmp, dst);
      return 'renamed';
    } catch (error) {
      if (!BUSY_CODES.has(error?.code)) { try { fs.rmSync(tmp, { force: true }); } catch {} throw error; }
      sleepSync(waitMs);
    }
  }
  try {
    fs.writeFileSync(dst, data);
    return 'overwritten';
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function copyIfChanged(src, dst) {
  const next = fs.readFileSync(src);
  let prev = null;
  try { prev = fs.readFileSync(dst); } catch {}
  if (prev && prev.equals(next)) return false;
  writeFileReplacing(dst, next);
  return true;
}

function replaceDir(src, dst) {
  const tmp = `${dst}.tmp-${process.pid}`;
  const old = `${dst}.old-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  copyDirSync(src, tmp);
  const had = fs.existsSync(dst);
  if (had) fs.renameSync(dst, old);
  try {
    fs.renameSync(tmp, dst);
  } catch (error) {
    if (had) fs.renameSync(old, dst);
    throw error;
  }
  if (had) fs.rmSync(old, { recursive: true, force: true });
}

/**
 * 皮肤文件夹的指纹：manifest.json 的内容 + 每个文件的相对路径、大小、修改时间。
 * 不读全部图片内容（几十 MB 的皮肤每分钟同步一次，读内容太浪费），换图时大小或修改时间总会变。
 */
export function skinFingerprint(dir) {
  const hash = createHash('sha1');
  try { hash.update(fs.readFileSync(path.join(dir, 'manifest.json'))); } catch {}
  const walk = (sub) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) {
        try { const st = fs.statSync(path.join(dir, rel)); hash.update(`${rel}\0${st.size}\0${Math.round(st.mtimeMs)}\n`); } catch {}
      }
    }
  };
  walk('');
  return hash.digest('hex');
}

/**
 * @param {object} opts
 * @param {() => {enabled:boolean, tosuDir:string, skinId:string, tosuUrl:string}} opts.config
 * @param {(id:string) => object} opts.resolveSkin   皮肤 id → { ok, id, dir, fallback }（core/skins.js 的 resolveSkin）
 * @param {() => Promise<string>} [opts.findTosu]    正在跑的 tosu.exe 路径
 * @param {string} [opts.rendererFile]               打包好的渲染层（默认 dist/counter-renderer.js）
 */
export function createTosuCounter({ config = () => ({}), resolveSkin, findTosu = findRunningTosu, rendererFile = RENDERER_FILE, log = () => {}, now = Date.now } = {}) {
  let staticDir = '';
  let lastSync = null;
  let lastError = null;
  let syncing = null;

  const counterDir = () => (staticDir ? path.join(staticDir, COUNTER_FOLDER) : '');
  const urls = () => { const base = tosuHttpBase((config() || {}).tosuUrl); return { url: `${base}/${COUNTER_FOLDER}/`, subtitleUrl: `${base}/${SUBTITLE_FOLDER}/` }; };

  function readMarker() {
    try { return JSON.parse(fs.readFileSync(path.join(counterDir(), MARKER), 'utf8')); } catch { return null; }
  }

  function readState() {
    try { return JSON.parse(fs.readFileSync(path.join(counterDir(), 'state.json'), 'utf8')); } catch { return {}; }
  }

  function writeState(patch) {
    const prev = readState();
    const next = { seq: Number(prev.seq) || 0, rev: Number(prev.rev) || 0, text: '', durationMs: 0, at: 0, ...prev, ...patch };
    writeFileReplacing(path.join(counterDir(), 'state.json'), `${JSON.stringify(next)}\n`);
    return next;
  }

  async function locate() {
    const cfg = config() || {};
    const fixed = String(cfg.tosuDir || '').trim();
    if (fixed) {
      if (!fs.existsSync(fixed)) return failure('osu.counter-bad-dir', `设置里的 tosu 目录不存在：${fixed}`, '在设置「OBS」里重新选 tosu.exe 所在的文件夹，或者清空让它自己找。');
      return { ok: true, tosuDir: fixed };
    }
    const exe = await findTosu();
    if (!exe) return failure('osu.counter-no-tosu', '没找到正在运行的 tosu', '先打开 tosu.exe；它开着的时候会自动把角色装进去。也可以在设置「OBS」里手动选 tosu 的文件夹。');
    // 只往真实存在的 tosu 目录里写（防止路径读错时在别处建文件夹）
    if (!fs.existsSync(path.dirname(exe))) return failure('osu.counter-bad-dir', `找到的 tosu 位置不存在：${exe}`, '在设置「OBS」里手动选 tosu.exe 所在的文件夹。');
    return { ok: true, tosuDir: path.dirname(exe) };
  }

  /** 装 / 更新 counter 文件夹，拷皮肤。返回 { ok, dir, url, subtitleUrl, skinId, changed } 或失败。 */
  async function sync({ force = false } = {}) {
    if (syncing) return syncing;
    syncing = (async () => {
      const cfg = config() || {};
      if (cfg.enabled === false) {
        // 自己的 OBS 角色关着也要知道 static 在哪：看 SurfCore 的小鲸鱼是不是也在说（otherWatcher）。什么都不写。
        lastError = null;
        try { const where = await locate(); if (where.ok) staticDir = staticDirOf(where.tosuDir); } catch {}
        return { ok: true, disabled: true };
      }
      const where = await locate();
      if (!where.ok) { lastError = where; return where; }
      staticDir = staticDirOf(where.tosuDir);
      if (!fs.existsSync(rendererFile)) {
        lastError = failure('osu.counter-no-renderer', '渲染层还没打包（dist/counter-renderer.js 不在）', '在项目文件夹里跑一次 npm run build，然后点「重新装进 tosu」。');
        return lastError;
      }
      const skin = resolveSkin(cfg.skinId);
      if (!skin?.ok) {
        lastError = failure(skin?.code || 'osu.counter-no-skin', skin?.error || '没有可用的皮肤', skin?.hint || '在设置「角色」里选一套皮肤。');
        return lastError;
      }
      const dir = counterDir();
      try {
        fs.mkdirSync(dir, { recursive: true });
        let changed = false;
        for (const f of PAGE_FILES) changed = copyIfChanged(path.join(ASSET_DIR, f), path.join(dir, f)) || changed;
        // 设置文件 tosu 会把用户改的值写回去：不覆盖；只在没有或少了项时写。
        ensureCounterSettings(path.join(dir, 'settings.json'), path.join(ASSET_DIR, 'settings.json'));
        // 第二个 counter：铺满画面的字幕
        const subDir = path.join(staticDir, SUBTITLE_FOLDER);
        fs.mkdirSync(subDir, { recursive: true });
        for (const f of ['index.html', 'metadata.txt']) changed = copyIfChanged(path.join(SUBTITLE_ASSET_DIR, f), path.join(subDir, f)) || changed;
        ensureCounterSettings(path.join(subDir, 'settings.json'), path.join(SUBTITLE_ASSET_DIR, 'settings.json'));
        changed = copyIfChanged(rendererFile, path.join(dir, 'renderer.js')) || changed;
        const marker = readMarker();
        // 皮肤的指纹：清单内容变了，或者只换了图片 / 模型文件（重新导入过同名皮肤）都要重拷。
        // 2026-11-20 复核发现：原来只看 manifest.json，换了图没改清单时 OBS 里一直是旧的。
        const skinHash = skinFingerprint(skin.dir);
        let skinChanged = false;
        if (force || !marker || marker.skinId !== skin.id || marker.skinHash !== skinHash || !fs.existsSync(path.join(dir, 'skin', 'manifest.json'))) {
          replaceDir(skin.dir, path.join(dir, 'skin'));
          skinChanged = true;
        }
        // 页面文件的指纹：和上次记下的不一样就让网页重载（某次同步拷完文件后才失败，下次也能补上重载）
        const contentHash = (() => {
          const hash = createHash('sha1');
          for (const name of [...PAGE_FILES, 'renderer.js']) { try { hash.update(fs.readFileSync(path.join(dir, name))); } catch {} }
          hash.update(skin.id).update(skinHash);
          return hash.digest('hex');
        })();
        if (changed || skinChanged || marker?.contentHash !== contentHash || !fs.existsSync(path.join(dir, 'state.json'))) {
          writeState({ rev: (Number(readState().rev) || 0) + 1 });
        }
        writeFileReplacing(path.join(dir, MARKER), `${JSON.stringify({ by: 'osu-pet', skinId: skin.id, skinHash, contentHash, syncedAt: new Date(now()).toISOString() })}\n`);
        if (skinChanged) log(`[osu] 角色已装进 tosu：${dir}（皮肤 ${skin.id}）`);
        lastError = null;
        lastSync = { at: new Date(now()).toISOString(), skinId: skin.id, dir, skinFallback: skin.fallback ?? null };
        return { ok: true, dir, ...urls(), skinId: skin.id, skinFallback: skin.fallback ?? null, changed: changed || skinChanged };
      } catch (error) {
        const reason = String(error?.message ?? error).slice(0, 160);
        lastError = failure('osu.counter-write', `写 tosu 文件夹失败：${reason}`, `检查 ${dir} 能不能写；tosu 装在只读位置（比如 Program Files）的话，把 tosu 挪到普通文件夹，或在设置「OBS」里选一个可写的 tosu 目录。`);
        return lastError;
      }
    })();
    try { return await syncing; } finally { syncing = null; }
  }

  /**
   * 游戏时刻：网页里的角色换姿势（core/moments.js 的名字），以及「在不在打图」。
   * 写进 state.json 的 reactSeq（每个时刻加一）、react（时刻名）、playing、playingAt（心跳时间，页面 90 秒没收到就当不打了）。
   * moment 为 null 时只更新 playing / playingAt（开始、结束、心跳）。没装好就什么都不做。
   */
  function react({ moment = null, playing = false } = {}) {
    const cfg = config() || {};
    if (cfg.enabled === false || !staticDir || !readMarker()) return false;
    try {
      const prev = readState();
      // 休息段也记成一个「状态」（resting），不只是一次性的时刻：页面每 0.4 秒才读一次，两个时刻挨得近时只看得到后一个；
      // 页面重载（换皮肤）后也能接着喝水。
      let resting = playing === true && prev.resting === true;
      if (moment === 'break') resting = playing === true;
      if (moment === 'break-end' || moment === 'start' || String(moment || '').startsWith('retry')) resting = false;
      const patch = { playing: playing === true, playingAt: now(), resting };
      if (moment) Object.assign(patch, { reactSeq: (Number(prev.reactSeq) || 0) + 1, react: String(moment).slice(0, 40) });
      writeState(patch);
      return true;
    } catch (error) {
      lastError = failure('osu.counter-write', `写 state.json 失败：${String(error?.message ?? error).slice(0, 120)}`, '检查 tosu 的 static 文件夹能不能写。');
      return false;
    }
  }

  /** 她开口了：网页张嘴 + 气泡 / 字幕。没装好就什么都不做（不影响别的输出）。 */
  function say({ text = '', durationMs = 0, mouth = '' } = {}) {
    const cfg = config() || {};
    if (cfg.enabled === false || !staticDir || !readMarker()) return false;
    try {
      writeState({ seq: (Number(readState().seq) || 0) + 1, text: String(text).slice(0, 200), durationMs: Math.max(0, Math.round(Number(durationMs) || 0)), mouth: cleanMouthTrack(mouth), at: now() });
      return true;
    } catch (error) {
      lastError = failure('osu.counter-write', `写 state.json 失败：${String(error?.message ?? error).slice(0, 120)}`, '检查 tosu 的 static 文件夹能不能写。');
      return false;
    }
  }

  /**
   * SurfCore 的小鲸鱼是不是也在看（最近 30 分钟在 tosu 里开过口）。是 → { folder, at }，否则 null。
   * 2026-11-20 真机：两个程序同一秒各说了一句（「全连还满准确率…」「全连还100%…」），声音叠在一起，用户以为是 osu-pet 说了两遍。
   */
  function otherWatcher() {
    if (!staticDir) return null;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(staticDir, SURFCORE_COUNTER_FOLDER, 'state.json'), 'utf8'));
      const at = Number(s?.at) || 0;
      const age = now() - at;
      if (at > 0 && Number(s.seq) > 0 && age < OTHER_WATCHER_RECENT_MS && age > -60_000) return { folder: SURFCORE_COUNTER_FOLDER, at: new Date(at).toISOString() };
    } catch {}
    return null;
  }

  function status() {
    const cfg = config() || {};
    const marker = staticDir ? readMarker() : null;
    return {
      enabled: cfg.enabled !== false,
      installed: Boolean(marker),
      dir: counterDir() || null,
      ...urls(),
      skinId: marker?.skinId ?? null,
      lastSync,
      lastError,
      otherWatcher: otherWatcher(),
    };
  }

  return { sync, say, react, status };
}
