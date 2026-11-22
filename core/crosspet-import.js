/**
 * 把 CrossPet（github.com/lokicorvus/crosspet）的角色立绘导入成 osu-pet 的姿势皮肤（rig: "sprite"）。
 *
 * 为什么（2026-11-20，用户选的方案）：CrossPet 给每个角色画了约 60 张姿势，正好对得上 osu! 的时刻；
 * 它的程序本身帮不上 osu-pet（没有 OBS 输出、全屏游戏时会藏起来、气泡只能说它自带的台词），所以只拿图。
 *
 * 做的事：从 CrossPet 的 characters/<id>/（character.json + 一堆 .webp）里挑出 osu-pet 用得上的姿势
 * （某个角色缺的姿势换成意思最接近的那张），原样拷成一套皮肤，写 manifest.json（姿势表、游戏时刻 → 姿势的反应表）
 * 和 CREDITS.md（署名和授权）。两种用法：
 *   · bundleCrossPet：程序文件夹里的 art/crosspet/ → skins-bundled/（npm start / npm run build 时，程序默认就带着全部角色）；
 *   · importCrossPet：某个文件夹 → <数据目录>/skins/（离屏自检用）。
 *
 * 不改图、不拷别的文件、不运行 CrossPet 的任何东西。仓库里没有 CrossPet 的图（它们是 CC BY-NC-SA 4.0，见 NOTICE）。
 * 失败都是 { ok:false, code, error, hint }（crosspet.* 或 skin.*）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { failure, isPlainObject } from './store.js';
import { importSkin, validateSkin } from './skins.js';

/**
 * osu-pet 用到的姿势 → CrossPet 的姿势名（按顺序找，第一个找得到的就用）。
 * 一个姿势可以有几张：pose.webp、pose-2.webp、pose-3.webp……（CrossPet 的写法；Claude 只有 happy-2 / pat-2 / sleeping-2，没有不带数字的那张）。
 * 真没有的姿势换成意思最接近的；Gemini 没有眨眼帧，Kimi 没有 idle-2/3。
 */
export const POSE_SOURCES = Object.freeze({
  idle: ['idle'],
  listening: ['listening', 'reading', 'idle'],
  running: ['running', 'roll_call', 'listening'],
  happy: ['happy', 'roll_call', 'proud'],
  oops: ['oops', 'surprised'],
  dizzy: ['dizzy', 'oops'],
  surprised: ['surprised', 'oops'],
  annoyed: ['annoyed', 'puffed', 'tired'],
  drink: ['drink', 'hum'],
  puffed: ['puffed', 'annoyed'],
  sulk: ['sulk', 'tired'],
  tired: ['tired', 'sulk'],
  redhot: ['redhot', 'puffed', 'annoyed'],
  proud: ['proud', 'happy', 'roll_call'],
  pat: ['pat', 'coaxed', 'happy'],
  coaxed: ['coaxed', 'pat'],
  forgiven: ['forgiven', 'happy'],
  yawn: ['yawn', 'tired'],
  sleeping: ['sleeping', 'yawn', 'tired'],
  bye: ['bye'],
});
const BLINK_FILE = 'idle-blink';

/**
 * 游戏时刻（core/moments.js）→ 姿势、动作、摆多久、优先级。用户可以在皮肤的 manifest.json 里改。
 * 优先级：打完 / 失败 > 全连断了 > 普通断连 > 连击关口；低优先级的不打断刚开始不到 2.5 秒的高优先级反应。
 */
export const DEFAULT_REACTIONS = Object.freeze({
  start: { pose: 'running', motion: 'jolt', holdMs: 2200, priority: 1 },
  combo: { pose: 'happy', motion: 'jump', holdMs: 4500, priority: 1 },
  'combo-break': { pose: 'oops', motion: 'shake', holdMs: 4000, priority: 2 },
  'slider-break': { pose: 'surprised', motion: 'jolt', holdMs: 3000, priority: 2 },
  'fc-lost': { pose: 'dizzy', motion: 'dizzy', holdMs: 5000, priority: 3 },
  'acc-drop': { pose: 'annoyed', motion: 'rock', holdMs: 3500, priority: 1 },
  'rank-up': { pose: 'happy', motion: 'hop', holdMs: 4000, priority: 1 },
  'rank-down': { pose: 'puffed', motion: 'jolt', holdMs: 3500, priority: 1 },
  retry: { pose: 'surprised', motion: 'jolt', holdMs: 1800, priority: 1 },
  'retry-sulk': { pose: 'sulk', motion: 'slow', holdMs: 5000, priority: 2 },
  'retry-tired': { pose: 'tired', motion: 'slow', holdMs: 5000, priority: 2 },
  'retry-rage': { pose: 'redhot', motion: 'angry', holdMs: 5000, priority: 3 },
  fc: { pose: 'proud', motion: 'hop', holdMs: 6000, priority: 4 },
  'pass-good': { pose: 'happy', motion: 'hop', holdMs: 5000, priority: 3 },
  pass: { pose: 'sulk', motion: 'slow', holdMs: 4500, priority: 3 },
  fail: { pose: 'dizzy', motion: 'dizzy', holdMs: 5000, priority: 4 },
  quit: { pose: 'sulk', motion: 'slow', holdMs: 4000, priority: 3 },
  // 难段预告（2026-11-21）：后面有长串 / 大跳，她先摆出冲的架势。
  'heads-up': { pose: 'running', motion: 'jolt', holdMs: 2500, priority: 2 },
});

const BASE_POSES = Object.freeze({ idle: 'idle', playing: 'listening', resting: 'drink', talk: 'listening', drowsy: 'yawn', sleep: 'sleeping' });
const MOTION_OF_POSE = Object.freeze({ drink: 'slow', listening: 'slow', sleeping: 'slow', yawn: 'squish' });

/** CrossPet characters/LICENSE.md 表格里每个角色的叫法（文件夹名 → 表格第一列）。 */
const CREDIT_NAMES = Object.freeze({ deepseek: 'DeepSeek', gpt: 'GPT', glm: 'GLM', qwen: '千问', kimi: 'Kimi', grok: 'Grok', gemini: 'Gemini', claude: 'Claude' });
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,60}$/;

/** WebP 的宽高（只读文件头，不解码）。不是 WebP 返回 null。 */
export function webpSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  return null;
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

/** 找到要导入的角色文件夹：选的是角色文件夹本身、characters 文件夹、或者整个 CrossPet。 */
export function findCharacterDirs(src) {
  const root = path.resolve(String(src || ''));
  if (!src || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  if (fs.existsSync(path.join(root, 'character.json'))) return [root];
  const charsDir = fs.existsSync(path.join(root, 'characters')) ? path.join(root, 'characters') : root;
  let names = [];
  try { names = fs.readdirSync(charsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; }
  // 彩蛋（egg-*）只有几张图，不是完整角色。
  return names.filter((name) => !name.startsWith('egg-') && fs.existsSync(path.join(charsDir, name, 'character.json')) && fs.existsSync(path.join(charsDir, name, 'idle.webp')))
    .map((name) => path.join(charsDir, name));
}

/** 从 CrossPet 的 characters/LICENSE.md 里找这个角色的设定来源那一行。找不到返回空串。 */
export function creditLine(charDir) {
  const base = path.basename(charDir).split('-')[0];
  const label = CREDIT_NAMES[base];
  if (!label) return '';
  let text = '';
  try { text = fs.readFileSync(path.join(path.dirname(charDir), 'LICENSE.md'), 'utf8'); } catch { return ''; }
  const row = text.split(/\r?\n/).find((line) => line.startsWith('|') && line.split('|')[1]?.trim() === label);
  if (!row) return '';
  return row.split('|')[2]?.replace(/\*\*/g, '').trim() || '';
}

/**
 * 把一个角色文件夹转成一套皮肤（写进 outDir），返回 { ok, id, name, poses, substituted, missing } 或失败。
 * 只拷用得上的图，原样不改。
 */
export function buildSkin(charDir, outDir, { mouthsDir = null } = {}) {
  const folder = path.basename(charDir).toLowerCase();
  const id = `crosspet-${folder}`;
  if (!ID_PATTERN.test(folder)) return failure('crosspet.bad-id', `角色文件夹的名字不合格：${folder.slice(0, 40)}`, '只能有小写字母、数字、点、下划线和连字符。');
  const character = readJsonSafe(path.join(charDir, 'character.json'));
  if (!isPlainObject(character)) return failure('crosspet.bad-character', `读不到 ${folder}/character.json`, '选 CrossPet 里 characters 下面的角色文件夹（里面有 character.json 和一堆 .webp）。');
  const available = new Map(); // 文件名（不带 .webp）→ 宽高
  for (const name of fs.readdirSync(charDir)) {
    if (!name.endsWith('.webp')) continue;
    let size = null;
    try { if (fs.statSync(path.join(charDir, name)).isFile()) size = webpSize(fs.readFileSync(path.join(charDir, name))); } catch {}
    if (size) available.set(name.slice(0, -5), size);
  }
  if (!available.has('idle')) return failure('crosspet.bad-character', `${folder} 里没有 idle.webp`, '这不像是 CrossPet 的完整角色文件夹（彩蛋文件夹不能单独导入）。');
  // 一个姿势的几张图：pose、pose-2、pose-3……（按数字排；idle-blink 不算 idle 的一张）
  const framesOf = (pose) => {
    const list = [];
    if (available.has(pose)) list.push(pose);
    const numbered = [...available.keys()].map((n) => /^(.+)-(\d+)$/.exec(n)).filter((m) => m && m[1] === pose).sort((a, b) => Number(a[2]) - Number(b[2])).map((m) => m[0]);
    return list.concat(numbered);
  };

  fs.mkdirSync(path.join(outDir, 'art'), { recursive: true });
  const copied = new Map(); // CrossPet 文件名 → 皮肤里的相对路径
  const copy = (srcPose) => {
    if (!copied.has(srcPose)) {
      fs.copyFileSync(path.join(charDir, `${srcPose}.webp`), path.join(outDir, 'art', `${srcPose}.webp`));
      copied.set(srcPose, `art/${srcPose}.webp`);
    }
    return copied.get(srcPose);
  };

  const poses = {};
  const substituted = {};
  const missing = [];
  for (const [pose, sources] of Object.entries(POSE_SOURCES)) {
    const found = sources.find((s) => framesOf(s).length > 0);
    if (!found) { missing.push(pose); continue; }
    if (found !== pose) substituted[pose] = found;
    // 待机用全部几张轮换（第一张是主图，眨眼帧对着它画）；别的姿势也带上几张，渲染器用第一张。
    poses[pose] = framesOf(found).map(copy);
  }
  const blink = available.has(BLINK_FILE) && poses.idle[0] === 'art/idle.webp' ? { base: 'idle', file: copy(BLINK_FILE) } : null;
  const mouth = poses.idle[0] === 'art/idle.webp' ? copyMouth(mouthsDir, id, charDir, available.get('idle'), outDir) : { skipped: 'idle 不是 idle.webp' };

  // 画布：用到的图里最宽、最高的那张；图按 contain、底边居中放（宽窄不一的姿势不拉伸）。
  let W = 0;
  let H = 0;
  for (const src of copied.keys()) { const s = available.get(src); W = Math.max(W, s.w); H = Math.max(H, s.h); }
  const idle = available.get('idle');
  // 包围盒用整张画布：有的姿势比待机图宽（张开手、带道具），真正点没点到她由渲染器看那张图的透明度决定。
  const hitbox = { x: 0, y: 0, w: W, h: H };
  // CrossPet 是 Q 版大头：头大约在上面 55%。摸头区域按主图估一个椭圆；点到透明处不算（渲染器看图的透明度）。
  const regions = [
    { id: 'head', gesture: 'pat', cursor: 'pointer', shape: { type: 'ellipse', cx: Math.round(W / 2), cy: Math.round(H - idle.h + idle.h * 0.36), rx: Math.round(idle.w * 0.32), ry: Math.round(idle.h * 0.28) } },
    { id: 'body', gesture: 'poke', cursor: 'pointer', shape: { type: 'rect', x: Math.round((W - idle.w * 0.6) / 2), y: Math.round(H - idle.h * 0.42), w: Math.round(idle.w * 0.6), h: Math.round(idle.h * 0.42) } },
  ];

  const reactions = {};
  for (const [moment, r] of Object.entries(DEFAULT_REACTIONS)) if (poses[r.pose]) reactions[moment] = { ...r };
  const motions = {};
  for (const [pose, motion] of Object.entries(MOTION_OF_POSE)) if (poses[pose]) motions[pose] = motion;

  // 换装文件夹（deepseek-hoodie 之类）的 character.json 往往不写 outfit：用文件夹名后半截，免得列表里几套都叫同一个名字。
  // CrossPet 的写法：主角色用 outfit，换装用 skinName（比如「圣女」「睡衣」）。
  const outfitName = [character.outfit, character.skinName].find((v) => typeof v === 'string' && v.trim())?.trim() || (folder.includes('-') ? folder.slice(folder.indexOf('-') + 1) : '');
  const outfit = outfitName ? `·${outfitName}` : '';
  // 名字里不带「（CrossPet）」（2026-11-20 用户：括号删了，README 里写了就够）；来源和署名在 manifest 的 author、CREDITS.md 里。
  const name = `${String(character.name || folder).slice(0, 30)}${outfit.slice(0, 20)}`;
  const credit = creditLine(charDir);
  const authorLine = `CrossPet（github.com/lokicorvus/crosspet），CC BY-NC-SA 4.0${credit ? `；设定来源：${credit}` : ''}`;
  const manifest = {
    schema: 1,
    id,
    name,
    author: authorLine,
    license: 'CC BY-NC-SA 4.0（立绘与角色设定，见 CREDITS.md）',
    source: { from: 'crosspet', character: folder, importedBy: 'osu-pet core/crosspet-import.js' },
    rig: 'sprite',
    canvas: { w: W, h: H },
    display: { scale: 0.5 },
    hitbox,
    interaction: { cursor: 'pointer', regions },
    sprite: { poses, ...(blink ? { blink } : {}), ...(mouth.spec ? { mouth: mouth.spec } : {}), base: { ...BASE_POSES }, reactions, motions },
  };
  if (mouth.spec) manifest.author += `；张嘴口型：${MOUTH_CREDIT_SHORT}`;
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'CREDITS.md'), creditsText({ name, folder, credit, substituted, mouth: mouth.source || null }));
  return { ok: true, id, name, poses: Object.keys(poses), substituted, missing, files: copied.size, canvas: { w: W, h: H }, mouth: Boolean(mouth.spec), ...(mouth.skipped && mouthsDir ? { mouthSkipped: mouth.skipped } : {}) };
}

// ── 张嘴口型（2026-11-21）────────────────────────────────────────────────────────
// scripts/mouths/make-mouths.py 把 hunmer/aboutme-pets「碎碎念」视频里的嘴对齐到立绘上，做成只有嘴的叠加图，
// 放在 art/mouths/<皮肤 id>/（mouth-closed / mouth-half / mouth-wide.webp + mouth.json）。这里拷进皮肤、写进 manifest。
// 立绘换过（mouth.json 记的 idle 的 sha 对不上）或者尺寸不一样就不带：嘴会贴歪，宁可说话时不动嘴。
const MOUTH_LEVELS = ['closed', 'half', 'wide'];
const MOUTH_CREDIT_SHORT = 'hunmer/aboutme-pets（github.com/hunmer/aboutme-pets），CC BY-NC-SA 4.0';

/** 和 git 一样的 blob sha（make-mouths.py 记的就是这个）。 */
export function blobSha(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function copyMouth(mouthsDir, id, charDir, idleSize, outDir) {
  if (!mouthsDir) return { skipped: '没给口型文件夹' };
  const dir = path.join(mouthsDir, id);
  const meta = readJsonSafe(path.join(dir, 'mouth.json'));
  if (!isPlainObject(meta) || !isPlainObject(meta.files)) return { skipped: '没有口型' };
  let idleBuf;
  try { idleBuf = fs.readFileSync(path.join(charDir, 'idle.webp')); } catch { return { skipped: '读不到 idle.webp' }; }
  if (meta.idleSha !== blobSha(idleBuf)) return { skipped: '口型是对着另一张 idle.webp 做的（立绘换过了），重新跑 scripts/mouths/make-mouths.py' };
  // 先全部检查完再拷：中途有一张不对就一张都不带（不然拷进去的嘴图没有署名、也没写进 manifest，复核发现）。
  const picked = [];
  for (const lv of MOUTH_LEVELS) {
    const name = meta.files[lv];
    if (typeof name !== 'string' || !/^mouth-[a-z]+\.webp$/.test(name)) continue;
    let size = null;
    try { size = webpSize(fs.readFileSync(path.join(dir, name))); } catch {}
    if (!size) return { skipped: `读不到 ${name}` };
    if (size.w !== idleSize.w || size.h !== idleSize.h) return { skipped: `${name} 和 idle.webp 不一样大` };
    picked.push([lv, name]);
  }
  if (!picked.some(([lv]) => lv === 'half' || lv === 'wide')) return { skipped: '口型里没有张嘴的图' };
  const levels = {};
  for (const [lv, name] of picked) {
    fs.copyFileSync(path.join(dir, name), path.join(outDir, 'art', name));
    levels[lv] = `art/${name}`;
  }
  return { spec: { base: 'idle', levels }, source: isPlainObject(meta.source) ? meta.source : {} };
}

/** 某个皮肤的口型文件（指纹用）：改了口型要重新打包。 */
function mouthFiles(mouthsDir, id) {
  const dir = mouthsDir && path.join(mouthsDir, id);
  try { return fs.readdirSync(dir).sort().map((name) => path.join(dir, name)); } catch { return []; }
}

function creditsText({ name, folder, credit, substituted, mouth = null }) {
  const subs = Object.entries(substituted).map(([pose, src]) => `- ${pose} → 用的是 ${src}.webp（这个角色没有 ${pose}）`);
  const pack = mouth && typeof mouth.pack === 'string' ? mouth.pack : '';
  const how = mouth?.mode === 'transplant'
    ? `从 ${String(mouth.donor || '').replace(/^crosspet-/, '')} 皮肤做好的嘴移植过来（那张嘴取自 \`pets/${pack}\` 的「${mouth.action || ''}」）`
    : `取自 \`pets/${pack}\` 的「${mouth?.action || ''}」`;
  const mouthText = mouth ? `
## 张嘴口型（说话时叠在待机图上的那几张嘴）

> 张嘴口型：hunmer/aboutme-pets（https://github.com/hunmer/aboutme-pets，作者 hunmer），CC BY-NC-SA 4.0（https://creativecommons.org/licenses/by-nc-sa/4.0/）

- ${how}，提交 ${String(mouth.commit || '').slice(0, 12)}。
${typeof mouth.closedFromCrossPet === 'string' ? `- 闭嘴那一张不是 hunmer 的：取自 CrossPet \`characters/${mouth.closedFromCrossPet.replace(/[^\w./-]/g, '')}\` 上的嘴（CC BY-NC-SA 4.0，见上面 CrossPet 的署名），缩放、旋转、调色后移植过来。\n` : ''}- **改动**：TomoPet 只截取了视频里几帧的嘴部，旋转缩放对齐到这张立绘、调了颜色、边缘羽化，做成只有嘴的透明叠加图（scripts/mouths/make-mouths.py）。
- 据 hunmer 说明，这些视频由 AI 生成。协议同上：署名、**不得商用**、改编后公开分享用同一协议。
` : '';
  return `# ${name}

这套皮肤由 TomoPet 从 CrossPet 的 \`characters/${folder}/\` 导入，立绘原样拷贝，没有修改${mouth ? '（说话时叠在上面的口型图是另做的，见下面「张嘴口型」）' : ''}。

## 署名（直播、录像、截图公开时请带上）

> 角色立绘：CrossPet（https://github.com/lokicorvus/crosspet），CC BY-NC-SA 4.0（https://creativecommons.org/licenses/by-nc-sa/4.0/）${credit ? `\n> 设定来源：${credit}` : ''}

## 授权要点

- 立绘与角色设定：CC BY-NC-SA 4.0。署名、**不得商用**；公开分享改编后的素材要用同一协议。
- 据 CrossPet 说明，这些立绘由 AI 生图工具按社区设定重新绘制。
- CrossPet 的授权只覆盖它自己有权授权的部分；社区既有设定的权利以各自来源为准（CrossPet README「授权」一节）。
  例如由 B 站 ZipZipPipe 设计的角色，CrossPet 没有写明它们的授权：自己电脑上用没问题，公开使用前最好先问原作者。
- 这些图不属于 TomoPet，也不要提交进 TomoPet（osu-pet）的仓库。

${mouthText}${subs.length ? `## 用别的姿势代替的\n\n${subs.join('\n')}\n` : ''}`;
}

/**
 * 导入：选的文件夹里每个角色转成一套皮肤，装进数据目录（同名的会被替换）。
 * 返回 { ok:true, imported:[…], skipped:[…] } 或失败（一个都没导进去时）。
 */
export function importCrossPet(src, { now = Date.now } = {}) {
  const dirs = findCharacterDirs(src);
  if (!dirs.length) return failure('crosspet.not-found', '这个文件夹里找不到 CrossPet 的角色', '选 CrossPet 文件夹本身、它的 characters 文件夹，或者 characters 下面某个角色的文件夹（比如 deepseek）。');
  const imported = [];
  const skipped = [];
  for (const dir of dirs) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-crosspet-'));
    try {
      const built = buildSkin(dir, path.join(tmp, path.basename(dir).toLowerCase()));
      if (!built.ok) { skipped.push({ folder: path.basename(dir), code: built.code, error: built.error, hint: built.hint }); continue; }
      // 装进数据目录走和「导入皮肤」同一条路（校验、原子替换）。importSkin 用 manifest.id 当文件夹名。
      const result = importSkin(path.join(tmp, path.basename(dir).toLowerCase()), { now });
      if (!result.ok) { skipped.push({ folder: path.basename(dir), code: result.code, error: result.error, hint: result.hint }); continue; }
      imported.push({ id: result.id, name: built.name, replaced: result.replaced, poses: built.poses.length, files: built.files, substituted: built.substituted, missing: built.missing, warnings: result.warnings });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
  if (!imported.length) {
    const first = skipped[0] || {};
    return failure(first.code || 'crosspet.import-failed', first.error || '一个角色都没导进去', first.hint || '看上面的原因。');
  }
  return { ok: true, imported, skipped };
}

// ── 程序自带的 CrossPet 角色（2026-11-20 用户：「不需要导入 crosspet 选项，默认就全有」）──────────
// 图放在程序文件夹的 art/crosspet/（不进 git：代码和受版权保护的素材分开），打包时（npm run build / npm start）
// 一次性转成皮肤放进 skins-bundled/crosspet-<角色>/（也不进 git），程序把它们列在「皮肤」下拉框里。
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ART_DIR = path.join(ROOT, 'art', 'crosspet');
export const MOUTHS_DIR = path.join(ROOT, 'art', 'mouths');
export const BUNDLED_MARKER = '.bundled.json';

/** 角色文件夹的指纹：每个文件的名字、大小、修改时间 + 署名表 + 这个导入程序本身（改了姿势表也要重新转）。 */
function sourceFingerprint(charDir, mouthsDir = null) {
  const hash = createHash('sha1');
  const id = `crosspet-${path.basename(charDir).toLowerCase()}`;
  for (const file of mouthFiles(mouthsDir, id)) {
    try { const st = fs.statSync(file); if (st.isFile()) hash.update(`mouth/${path.basename(file)}\0${st.size}\0${Math.round(st.mtimeMs)}\n`); } catch {}
  }
  try { hash.update(fs.readFileSync(new URL(import.meta.url))); } catch {}
  try { hash.update(fs.readFileSync(path.join(path.dirname(charDir), 'LICENSE.md'))); } catch {}
  for (const name of fs.readdirSync(charDir).sort()) {
    try { const st = fs.statSync(path.join(charDir, name)); if (st.isFile()) hash.update(`${name}\0${st.size}\0${Math.round(st.mtimeMs)}\n`); } catch {}
  }
  return hash.digest('hex');
}

/**
 * 把 artDir 里的每个 CrossPet 角色转成皮肤，放进 outDir/crosspet-<角色>/。
 * ifMissing：已经转过、源文件没变的跳过（npm start 每次都跑，不能每次重拷几十 MB）。
 * 源里已经没有的角色（以前转过的，带 .bundled.json 记号）删掉；别的文件夹不碰。
 * 一个角色都没找到（art 没放、或者解压多套了一层）时什么都不删：多半是放错了，不是真的不要了。
 * 某个角色写不进去（文件正被占用之类）：旧的那套原样留着，记进 skipped（带 code / error / hint），别的照常。
 * 返回 { ok:true, built:[…], kept:[…], removed:[…], skipped:[…], artFound }；artDir 不在不算失败（artFound:false）。
 */
export function bundleCrossPet({ artDir = ART_DIR, mouthsDir = null, outDir, ifMissing = false, fsOps = fs } = {}) {
  // 口型默认在 art 旁边：art/crosspet → art/mouths（测试里给的假 art 旁边没有，不会读到这台机器上真的口型）。
  if (!mouthsDir) mouthsDir = artDir === ART_DIR ? MOUTHS_DIR : path.join(path.dirname(artDir), 'mouths');
  if (!outDir) return failure('crosspet.no-out', '没给皮肤放在哪', '这是程序的问题：bundleCrossPet 要传 outDir。');
  const dirs = fs.existsSync(artDir) ? findCharacterDirs(artDir) : [];
  const result = { ok: true, built: [], kept: [], removed: [], skipped: [], artFound: dirs.length > 0 };
  fs.mkdirSync(outDir, { recursive: true });
  const wanted = new Set();
  for (const dir of dirs) {
    const folder = path.basename(dir).toLowerCase();
    const id = `crosspet-${folder}`;
    const target = path.join(outDir, id);
    wanted.add(id);
    const fingerprint = sourceFingerprint(dir, mouthsDir);
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(path.join(target, BUNDLED_MARKER), 'utf8')); } catch {}
    if (ifMissing && marker?.fingerprint === fingerprint && validateSkin(target).ok) { result.kept.push(id); continue; }
    const tmp = `${target}.tmp-${process.pid}`;
    const old = `${target}.old-${process.pid}`;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      const built = buildSkin(dir, tmp, { mouthsDir });
      if (!built.ok) { result.skipped.push({ folder, code: built.code, error: built.error, hint: built.hint }); continue; }
      const checked = validateSkin(tmp);
      if (!checked.ok) { result.skipped.push({ folder, code: checked.code, error: checked.error, hint: checked.hint }); continue; }
      fs.writeFileSync(path.join(tmp, BUNDLED_MARKER), `${JSON.stringify({ by: 'osu-pet bundleCrossPet', from: folder, fingerprint })}\n`);
      // 换上新的：旧的先挪开，新的改名进来，失败就把旧的挪回去（和 importSkin、tosu-counter 的 replaceDir 一样）。
      // Windows 上刚写完一堆文件、或者杀毒 / 索引正读着时，改名偶尔被拒：等一下再试几次。
      const had = fs.existsSync(target);
      if (had) retryBusy(() => fsOps.renameSync(target, old));
      try {
        retryBusy(() => fsOps.renameSync(tmp, target));
      } catch (error) {
        if (had) { try { retryBusy(() => fsOps.renameSync(old, target)); } catch {} }
        throw error;
      }
      if (had) { try { fs.rmSync(old, { recursive: true, force: true }); } catch {} }
      result.built.push({ id, name: built.name, poses: built.poses.length, files: built.files, substituted: built.substituted, missing: built.missing, mouth: built.mouth, ...(built.mouthSkipped ? { mouthSkipped: built.mouthSkipped } : {}) });
    } catch (error) {
      result.skipped.push({
        folder,
        code: 'crosspet.bundle-write',
        error: `${folder} 没转成：${String(error?.code || error?.message || error).slice(0, 120)}`,
        hint: fs.existsSync(path.join(target, 'manifest.json')) ? '旧的那套还在、照样能用。关掉占着这些文件的程序（文件夹窗口、杀毒扫描），再跑一次 npm run bundle-crosspet。' : '关掉占着 skins-bundled 文件夹的程序（文件夹窗口、杀毒扫描），再跑一次 npm run bundle-crosspet。',
      });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
  // 源里删掉的角色：只删自己转出来的（有记号的）；上次中断留下的临时文件夹也清掉。
  // 一个角色都没找到时不删：多半是 art 放错了位置（比如解压多套了一层），不是真的不要了。
  if (result.artFound) {
    for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || wanted.has(entry.name)) continue;
      const dir = path.join(outDir, entry.name);
      const leftover = /\.(tmp|old)-\d+$/.test(entry.name);
      if (!leftover && !fs.existsSync(path.join(dir, BUNDLED_MARKER))) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        if (!leftover) result.removed.push(entry.name);
      } catch (error) {
        if (!leftover) result.skipped.push({ folder: entry.name, code: 'crosspet.bundle-write', error: `${entry.name} 删不掉：${String(error?.code || error?.message || error).slice(0, 80)}`, hint: '关掉占着它的程序，再跑一次 npm run bundle-crosspet。' });
      }
    }
  }
  return result;
}

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
function retryBusy(fn, attempts = 6, waitMs = 80) {
  for (let i = 0; ; i += 1) {
    try { return fn(); } catch (error) {
      if (!BUSY.has(error?.code) || i >= attempts - 1) throw error;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs); } catch {}
    }
  }
}
