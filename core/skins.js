/**
 * 皮肤从两个地方来：
 *   · 程序自带的 CrossPet 角色：程序文件夹里的 art/crosspet/ 转进 skins-bundled/（都不进仓库，见 core/crosspet-import.js bundleCrossPet；
 *     给别人的安装包里带着转好的 skins-bundled/，见 scripts/package-win.mjs）；
 *   · 用户自己放进 <数据目录>/skins/<id>/ 的，或在设置里「导入皮肤」。
 * 仓库里一套皮肤都没有（2026-11-20 用户：「把占位小人从我这个项目里整个删了」）。
 *
 * 为什么分开：以后可能开源，代码和受版权保护的素材不能混在一个仓库里
 * （feiyu-pet 的立绘、Claude 娘素材 CC BY-NC-SA 4.0 都不能随项目发布）。
 *
 * 皮肤格式沿用 feiyu-pet 的 manifest.json：
 *   rig: "layered"  分图层（canvas / hitbox / layers[{ id, file, group, role }] / rigOptions / interaction）
 *   rig: "video"    视频皮肤（video.states / video.clips，动态 AVIF）
 *
 * 失败都是 { ok:false, code, error, hint }（skin.*）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDirSync, dataPath, failure, isPlainObject } from './store.js';

// 程序自带的 CrossPet 角色：npm run build / npm start 时由 art/crosspet/ 转出来（core/crosspet-import.js bundleCrossPet），不进 git。
// 环境变量 OSU_PET_BUNDLED_DIR 可以改（测试用一个空文件夹，结果不受这台机器上转出来了哪些角色影响）。
export const BUNDLED_DIR = process.env.OSU_PET_BUNDLED_DIR
  ? path.resolve(process.env.OSU_PET_BUNDLED_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skins-bundled');
// 以前的版本自带一个叫 placeholder 的占位小人，设置的默认值也是它：现在当成「没选，用默认那套」。
const LEGACY_AUTO = new Set(['', 'placeholder']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** 导入时单个皮肤最多这么大（防止选错文件夹，把整个盘拷进来）。 */
const IMPORT_MAX_BYTES = 600 * 1024 * 1024;
const IMPORT_MAX_FILES = 5000;

export const userSkinsDir = () => dataPath('skins');
/** 找皮肤的地方，按优先级：用户自己的、程序自带的 CrossPet 角色。同名时前面的盖过后面的。 */
export const skinRoots = () => [[userSkinsDir(), 'user'], [BUNDLED_DIR, 'bundled']];

const inside = (root, file) => {
  const rel = path.relative(root, path.resolve(root, file));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * 检查一个皮肤文件夹。返回 { ok:true, manifest, warnings } 或失败。
 * 只做会让它「画不出来」的检查：清单读得出、类型认识、画布和命中框有数、图层文件都在而且没指到文件夹外面。
 */
export function validateSkin(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return failure('skin.no-manifest', `这个文件夹里没有 manifest.json：${dir}`, '选皮肤自己的那一层文件夹（里面直接有 manifest.json 和 art/）。');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (error) {
    return failure('skin.bad-manifest', `manifest.json 不是合法的 JSON：${String(error?.message ?? error).slice(0, 100)}`, '用编辑器打开检查括号和逗号。');
  }
  if (!isPlainObject(manifest)) return failure('skin.bad-manifest', 'manifest.json 的内容不是一个对象', '照程序文件夹 skins-bundled 里任意一套的 manifest.json 的样子写（docs/使用说明.md「皮肤」一节有说明）。');
  const rig = manifest.rig ?? 'layered';
  if (rig !== 'layered' && rig !== 'video' && rig !== 'sprite') return failure('skin.unknown-rig', `不认识的皮肤类型：${String(rig).slice(0, 40)}`, '只支持 rig: "layered"（分图层）、"video"（视频皮肤）和 "sprite"（姿势皮肤）。');
  const canvas = manifest.canvas;
  if (!isPlainObject(canvas) || !(canvas.w > 0) || !(canvas.h > 0)) return failure('skin.bad-manifest', 'manifest.json 缺 canvas（画布的宽高）', '加上 "canvas": { "w": 1024, "h": 1024 } 这样的一项。');
  const hb = manifest.hitbox;
  if (!isPlainObject(hb) || !(hb.w > 0) || !(hb.h > 0)) return failure('skin.bad-manifest', 'manifest.json 缺 hitbox（人在画布里的范围）', '加上 "hitbox": { "x": 0, "y": 0, "w": …, "h": … }。');
  const warnings = [];
  const files = [];
  if (rig === 'layered') {
    if (!Array.isArray(manifest.layers) || !manifest.layers.length) return failure('skin.bad-manifest', '分图层皮肤的 layers 是空的', '每个图层写一项 { id, file, group, role }。');
    for (const layer of manifest.layers) {
      if (!isPlainObject(layer) || typeof layer.file !== 'string' || typeof layer.role !== 'string') return failure('skin.bad-manifest', 'layers 里有一项缺 file 或 role', '每个图层要有 id / file / group / role。');
      files.push(layer.file);
    }
    const mouth = manifest.rigOptions?.mouth;
    for (const key of ['open', 'openCover', 'dent']) if (typeof mouth?.[key] === 'string') files.push(mouth[key]);
    if (!mouth && !manifest.layers.some((layer) => layer.role === 'mouth')) warnings.push('这套皮肤没有嘴的图层 / rigOptions.mouth，说话时不会张嘴。');
  } else if (rig === 'sprite') {
    // 姿势皮肤：sprite.poses = { 姿势名: [图片, …] }，至少要有 idle。反应表里指向不存在的姿势只是提醒（渲染时退回别的姿势）。
    const sprite = manifest.sprite;
    const poses = isPlainObject(sprite?.poses) ? sprite.poses : null;
    if (!poses || !Object.keys(poses).length) return failure('skin.bad-manifest', '姿势皮肤的 sprite.poses 是空的', '每个姿势写一项，比如 "idle": ["art/idle.webp"]。');
    const framesOf = (v) => (Array.isArray(v) ? v : [v]);
    for (const [name, list] of Object.entries(poses)) {
      const frames = framesOf(list);
      if (!frames.length || frames.some((f) => typeof f !== 'string')) return failure('skin.bad-manifest', `姿势「${name.slice(0, 30)}」的图片写得不对`, '每个姿势是一张图片的相对路径，或者几张图片的列表。');
      files.push(...frames);
    }
    if (!poses.idle) return failure('skin.bad-manifest', '姿势皮肤缺 idle（平时的样子）', '加上 "idle": ["art/idle.webp"]。');
    if (typeof sprite.blink?.file === 'string') files.push(sprite.blink.file);
    // 口型（可选）：{ base, levels: { closed?, half?, wide? } }，每张都是皮肤里的文件。
    if (sprite.mouth !== undefined) {
      const levels = isPlainObject(sprite.mouth) && isPlainObject(sprite.mouth.levels) ? sprite.mouth.levels : null;
      const list = levels ? Object.entries(levels).filter(([k]) => ['closed', 'half', 'wide'].includes(k)) : [];
      if (!levels || list.some(([, f]) => typeof f !== 'string') || !list.some(([k]) => k === 'half' || k === 'wide')) return failure('skin.bad-manifest', 'sprite.mouth 写得不对', '写成 { "base": "idle", "levels": { "half": "art/mouth-half.webp", "wide": "art/mouth-wide.webp" } }（closed 可选），或者删掉 mouth。');
      if (sprite.mouth.base !== undefined && !poses[sprite.mouth.base]) return failure('skin.bad-manifest', `sprite.mouth.base 指向的姿势不存在：${String(sprite.mouth.base).slice(0, 30)}`, '口型是对着哪张姿势图做的，就写那个姿势名（一般是 idle）。');
      files.push(...list.map(([, f]) => f));
    }
    const missingPoses = new Set();
    for (const r of Object.values(isPlainObject(sprite.reactions) ? sprite.reactions : {})) if (isPlainObject(r) && r.pose && !poses[r.pose]) missingPoses.add(String(r.pose));
    if (missingPoses.size) warnings.push(`反应表里用到了这套皮肤没有的姿势（会用别的姿势代替）：${[...missingPoses].slice(0, 8).join('、')}`);
  } else {
    if (!isPlainObject(manifest.video) || !Array.isArray(manifest.video.clips) || !manifest.video.clips.length) return failure('skin.bad-manifest', '视频皮肤的 video.clips 是空的', '视频皮肤要有 video.states 和 video.clips。');
    for (const clip of manifest.video.clips) if (typeof clip?.file === 'string') files.push(clip.file);
  }
  if (typeof manifest.interaction?.mask === 'string') files.push(manifest.interaction.mask);
  for (const rel of files) {
    if (!inside(dir, rel)) return failure('skin.bad-path', `皮肤里的文件路径指到了文件夹外面：${rel.slice(0, 80)}`, '图层文件只能用皮肤文件夹里的相对路径（比如 art/01_body.png）。');
    if (!fs.existsSync(path.join(dir, rel))) return failure('skin.missing-file', `皮肤缺文件：${rel.slice(0, 80)}`, '检查 manifest.json 里的文件名和 art/ 里的是不是对得上（大小写也要一样）。');
  }
  return { ok: true, manifest, warnings };
}

function dirSize(dir, limit = { bytes: 0, files: 0 }) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) dirSize(full, limit);
    else { limit.bytes += fs.statSync(full).size; limit.files += 1; }
    if (limit.bytes > IMPORT_MAX_BYTES || limit.files > IMPORT_MAX_FILES) return limit;
  }
  return limit;
}

/**
 * 数据目录里以前用「导入 CrossPet 角色」按钮（已去掉）导进来的那套，程序自带的同名那套又在：用自带的，不用旧的。
 * 为什么（2026-11-20 复核）：旧的那份没法再更新（按钮没了），自带的会随 CrossPet 的图和导入程序一起更新；
 * 不让旧的盖过新的，否则以后姿势表改了，桌面和 OBS 还停在旧的、也没有任何提示。
 */
function shadowedOldCrossPet(dir, source, id) {
  if (source !== 'user' || !id.startsWith('crosspet-')) return false;
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return false; }
  if (manifest?.source?.from !== 'crosspet' || !String(manifest?.source?.importedBy || '').includes('crosspet-import')) return false;
  return validateSkin(path.join(BUNDLED_DIR, id)).ok;
}

/** 某套皮肤用哪个文件夹（和 resolveSkin 同一条规则：按顺序第一个能用的）。没有返回空串。本地文件协议用它，图和清单一定出自同一个文件夹。 */
export function skinDirFor(id) {
  if (!ID_PATTERN.test(String(id || ''))) return '';
  for (const [root, source] of skinRoots()) {
    const dir = path.join(root, id);
    if (!fs.existsSync(path.join(dir, 'manifest.json')) || shadowedOldCrossPet(dir, source, id)) continue;
    if (validateSkin(dir).ok) return dir;
  }
  return '';
}

// 没选、选的那套没了 / 坏了的时候用哪套：DeepSeek（女仆装），没有就用列表里第一套能用的；一套都没有返回空串。
export const PREFERRED_DEFAULT = 'crosspet-deepseek';
export function defaultSkinId() {
  if (skinDirFor(PREFERRED_DEFAULT)) return PREFERRED_DEFAULT;
  return listSkins().find((skin) => skin.ok)?.id ?? '';
}

/** 所有皮肤（设置里的下拉框）：用户的在前，程序自带的在后；同名时用户的盖过自带的（以前导入的 CrossPet 旧副本除外，见上）。 */
export function listSkins() {
  const seen = new Map();
  for (const [root, source] of skinRoots()) {
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch {}
    for (const id of names) {
      if (seen.has(id) || !ID_PATTERN.test(id)) continue;
      const dir = path.join(root, id);
      if (shadowedOldCrossPet(dir, source, id)) continue;
      const checked = validateSkin(dir);
      seen.set(id, checked.ok
        ? { id, name: String(checked.manifest.name || id).slice(0, 60), rig: checked.manifest.rig ?? 'layered', source, dir, ok: true, warnings: checked.warnings, canvas: checked.manifest.canvas, hasPreview: fs.existsSync(path.join(dir, 'preview.png')), thumb: thumbOf(dir, checked.manifest), poses: posePreviews(dir, checked.manifest) }
        : { id, name: id, rig: '', source, dir, ok: false, error: { code: checked.code, error: checked.error, hint: checked.hint } });
    }
  }
  // 排序（2026-11-22 用户：「第一排全是 deepseek，默认皮肤是 deepseek 女仆装」）：默认的女仆装第一，其余 DeepSeek 的衣服紧跟着，
  // 然后才是别的（原来的顺序不变：用户导入的在前、自带的在后，各自按文件夹名）
  const rank = (id) => (id === PREFERRED_DEFAULT ? 0 : id.startsWith(`${PREFERRED_DEFAULT}-`) ? 1 : 2);
  return [...seen.values()].map((skin, i) => [skin, i]).sort((a, b) => rank(a[0].id) - rank(b[0].id) || a[1] - b[1]).map(([skin]) => skin);
}

/** 设置页「角色」展示台轮着换的几个姿势（有哪个放哪个）。 */
const SHOWCASE_POSES = [['idle', '待机'], ['happy', '开心'], ['proud', '得意'], ['oops', '呜哇'], ['drink', '喝水'], ['redhot', '生气'], ['sleeping', '睡觉']];

/**
 * 展示台用的姿势图（2026-11-21 用户：「角色页面像游戏选角色一样」）：[{ key, label, file }]，file 是皮肤文件夹里的相对路径。
 * 只认姿势皮肤、皮肤文件夹里面真实存在的文件；同一张图不重复（缺的姿势会被导入时换成别的图）。
 */
export function posePreviews(dir, manifest) {
  const poses = manifest?.sprite?.poses;
  if (!isPlainObject(poses)) return [];
  const out = [];
  const used = new Set();
  for (const [key, label] of SHOWCASE_POSES) {
    const list = poses[key];
    const rel = Array.isArray(list) ? list[0] : list;
    if (typeof rel !== 'string' || !rel || used.has(rel) || !inside(dir, rel) || !fs.existsSync(path.join(dir, rel))) continue;
    used.add(rel);
    out.push({ key, label, file: rel.split(path.sep).join('/') });
  }
  return out;
}

/**
 * 设置页「角色」里每套皮肤的缩略图（皮肤文件夹里的相对路径，页面用 osupet://local/skin/<id>/<thumb> 读）。
 * 姿势皮肤用待机图（sprite.poses.idle 第一张），别的用 preview.png；都没有返回 null（页面显示名字首字）。
 * 只认皮肤文件夹里面、真实存在的文件。
 */
export function thumbOf(dir, manifest) {
  const idle = manifest?.sprite?.poses?.idle;
  const candidates = [Array.isArray(idle) ? idle[0] : idle, 'preview.png'];
  for (const rel of candidates) {
    if (typeof rel !== 'string' || !rel || !inside(dir, rel)) continue;
    if (fs.existsSync(path.join(dir, rel))) return rel.split(path.sep).join('/');
  }
  return null;
}

/**
 * 找到一套皮肤的文件夹。要的那套没有 / 坏了就退回默认那套（defaultSkinId：DeepSeek，没有就第一套能用的），并说明原因（fallback）。
 * 没选（空、不合格，或者以前版本的默认值 placeholder）：直接用默认那套，不算出错。
 * 返回 { ok:true, id, dir, manifest, fallback } 或失败（一套能用的都没有：skin.none）。
 */
export function resolveSkin(id) {
  const raw = String(id ?? '');
  // 设置里写的就是默认那套（DeepSeek），而它不在：多半是没选过（设置的默认值），也当成「没选」——
  // 安静地换成第一套能用的；一套都没有时报 skin.none（带「去哪拿皮肤」的提示），不报「没找到 crosspet-deepseek」（复核）。
  const isMissingDefault = raw === PREFERRED_DEFAULT && !skinDirFor(raw);
  const asked = ID_PATTERN.test(raw) && !LEGACY_AUTO.has(raw) && !isMissingDefault ? raw : '';
  const fallbackId = defaultSkinId();
  const wanted = asked || fallbackId;
  let reason = null;
  for (const candidate of [...new Set([wanted, fallbackId])].filter(Boolean)) {
    for (const [root, source] of skinRoots()) {
      const dir = path.join(root, candidate);
      if (!fs.existsSync(path.join(dir, 'manifest.json')) || shadowedOldCrossPet(dir, source, candidate)) continue;
      const checked = validateSkin(dir);
      if (checked.ok) {
        const fallback = candidate === wanted || !reason ? null : { ...reason, error: `${reason.error}，先用「${String(checked.manifest.name || candidate).slice(0, 40)}」` };
        return { ok: true, id: candidate, dir, manifest: checked.manifest, warnings: checked.warnings, fallback };
      }
      if (candidate === wanted && !reason) reason = { code: checked.code, error: `皮肤「${wanted}」用不了：${checked.error}`, hint: checked.hint };
    }
    if (candidate === wanted && !reason) reason = { code: 'skin.not-found', error: `没找到皮肤「${wanted}」`, hint: '在设置「角色」里重新选一套。' };
  }
  if (reason) return failure(reason.code, `${reason.error}，也没有别的能用的皮肤`, reason.hint);
  return failure('skin.none', '一套能用的皮肤都没有', '下载打包好的 TomoPet（自带 CrossPet 的 15 套角色）；从源码跑的话把 CrossPet 的 characters 文件夹放进 art/crosspet/ 再 npm start；也可以在设置「角色」里点「导入皮肤」。');
}

/**
 * 导入：把一个皮肤文件夹拷进 <数据目录>/skins/<id>/。id 取 manifest.id（不合格就用文件夹名）。
 * 已经有同名的：先挪成 <id>.old-<时间>（不直接删），拷完再清掉。
 */
export function importSkin(srcDir, { now = Date.now } = {}) {
  const src = path.resolve(String(srcDir || ''));
  if (!srcDir || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) return failure('skin.no-folder', '选的不是一个文件夹', '选皮肤的文件夹（里面直接有 manifest.json）。');
  const checked = validateSkin(src);
  if (!checked.ok) return checked;
  const id = [checked.manifest.id, path.basename(src)].map((value) => String(value ?? '')).find((value) => ID_PATTERN.test(value));
  if (!id) return failure('skin.bad-id', '皮肤的 id 不合格', 'manifest.json 的 id（或文件夹名）只能有字母、数字、下划线、点和连字符。');
  if (LEGACY_AUTO.has(id)) return failure('skin.bad-id', '皮肤不能叫 placeholder（这个名字表示「用默认那套」）', '把 manifest.json 的 id 改成别的名字。');
  const size = dirSize(src);
  if (size.bytes > IMPORT_MAX_BYTES || size.files > IMPORT_MAX_FILES) return failure('skin.too-big', '这个文件夹太大了，不像是一套皮肤', '确认选的是皮肤自己的那一层文件夹，而不是它的上级目录。');
  const root = userSkinsDir();
  const dst = path.join(root, id);
  if (path.resolve(dst) === src) return { ok: true, id, dir: dst, name: String(checked.manifest.name || id), replaced: false, warnings: checked.warnings };
  const tmp = path.join(root, `.${id}.tmp-${process.pid}`);
  const old = path.join(root, `.${id}.old-${now()}`);
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    copyDirSync(src, tmp);
    const had = fs.existsSync(dst);
    if (had) fs.renameSync(dst, old);
    try { fs.renameSync(tmp, dst); } catch (error) { if (had) fs.renameSync(old, dst); throw error; }
    if (had) fs.rmSync(old, { recursive: true, force: true });
    return { ok: true, id, dir: dst, name: String(checked.manifest.name || id), replaced: had, warnings: checked.warnings };
  } catch (error) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return failure('skin.copy-failed', `拷皮肤失败：${String(error?.message ?? error).slice(0, 140)}`, `检查 ${root} 能不能写；桌面角色开着同名皮肤时先在托盘菜单里隐藏角色再试。`);
  }
}
