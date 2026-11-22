/**
 * 认出一张图里「后面要来的难段」：长串、大跳、先串后跳 / 先跳后串、变速（纯函数，不碰网络和文件）。
 *
 * 为什么（2026-11-21 用户：「让桌宠识别到后面即将会来的排列然后提前通知玩家，比如后面有长串或者有大跳」）：
 * 开图时把 .osu 解析一遍，离线算出难段列表；打图时 core/heads-up.js 按 tosu 的 beatmap.time.live 提前两三秒报。
 *
 *   parseOsu(text)                     .osu 文本 → { mode, cs, sliderMultiplier, timing, objects, breaks }（不是 osu! 标准模式返回 null）
 *   findHardSections(parsed, opts)     → 难段列表 [{ kind, start, end, count, severity }]，按 start 排；时间是谱面时间（毫秒）
 *
 * 串的认法：
 * 按节奏连续认（相邻间隔不超过 250ms、和上一下差不超过 35%，转盘打断；滑条只能在串的头尾，见 findStreams），
 * 长链要够快才算串（真实间隔不超过 STREAM_MAX_GAP_MS，再按拍子看；不然是 1/2 拍的跳链）；
 * 串的间距从上一个物件的尾巴量起、以圆的半径为单位（考虑 CS）；大跳按屏幕上的像素算（见 BIG_JUMP_PX）。串的长度分档（burst 3–8 / 短串 9–16 / 长串 17–32 / 死串 33+）
 *
 * 只挑「这张图里明显比别处难」的几段：整张图都是串时，只报比别的串明显长、明显快的那几段。
 */

import { sliderEnd } from './slider-path.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** .osu 文本 → 解析结果。只认 osu! 标准模式（Mode: 0）；读不出物件返回 null。 */
export function parseOsu(text) {
  let src = String(text ?? '').replace(/^﻿/, '');
  // 带大故事板的图 [Events] 能有上百 MB：先把它剥掉，只留休息段那几行，不然整份拆行要卡主进程一两秒（复核发现）。
  const ev = src.indexOf('[Events]');
  if (ev >= 0) {
    const next = src.indexOf('\n[', ev + 8);
    const body = src.slice(ev, next < 0 ? src.length : next);
    if (body.length > 20000) {
      const keep = body.match(/^(?:2|Break),[^\r\n]*/gm) || [];
      src = `${src.slice(0, ev)}[Events]\n${keep.join('\n')}\n${next < 0 ? '' : src.slice(next + 1)}`;
    }
  }
  const lines = src.split(/\r?\n/);
  let section = '';
  const kv = {};
  const timingRaw = [];
  const objectRaw = [];
  const breaks = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const head = /^\[(\w+)\]$/.exec(line);
    if (head) { section = head[1]; continue; }
    if (section === 'General' || section === 'Difficulty') {
      const m = /^(\w+)\s*:\s*(.*)$/.exec(line);
      if (m) kv[m[1]] = m[2];
    } else if (section === 'TimingPoints') {
      timingRaw.push(line);
    } else if (section === 'HitObjects') {
      objectRaw.push(line);
    } else if (section === 'Events') {
      const p = line.split(',');
      if ((p[0] === '2' || p[0] === 'Break') && p.length >= 3) breaks.push({ start: num(p[1]), end: num(p[2]) });
    }
  }
  const mode = num(kv.Mode, 0);
  if (mode !== 0) return null;
  const cs = num(kv.CircleSize, 4);
  // AR：老谱面没有 ApproachRate 那一行，那时 AR 跟 OD 一样（osu! 的规矩）
  const ar = num(kv.ApproachRate, num(kv.OverallDifficulty, 5));
  const sliderMultiplier = num(kv.SliderMultiplier, 1.4) || 1.4;

  // 定拍点（红线）和变速点（绿线）。老格式没有 uninherited 那一栏：beatLength > 0 就是红线。
  const timing = [];
  for (const line of timingRaw) {
    const p = line.split(',');
    if (p.length < 2) continue;
    const time = num(p[0], NaN);
    const beatLength = num(p[1], NaN);
    if (!Number.isFinite(time) || !Number.isFinite(beatLength)) continue;
    const uninherited = p.length >= 7 ? p[6].trim() === '1' : beatLength > 0;
    timing.push({ time, beatLength, uninherited });
  }
  timing.sort((a, b) => a.time - b.time || (b.uninherited ? 1 : 0) - (a.uninherited ? 1 : 0));
  const reds = timing.filter((t) => t.uninherited && t.beatLength > 0);
  if (!reds.length) return null;

  // 某个时刻的拍长（红线）和滑条速度倍数（绿线，红线会把它重置成 1）。
  const beatAt = (t) => {
    let beat = reds[0].beatLength;
    for (const r of reds) { if (r.time <= t + 1) beat = r.beatLength; else break; }
    return beat;
  };
  const svAt = (t) => {
    let sv = 1;
    for (const tp of timing) {
      if (tp.time > t + 1) break;
      if (tp.uninherited) sv = 1;
      else if (tp.beatLength < 0) sv = Math.min(10, Math.max(0.1, -100 / tp.beatLength));
    }
    return sv;
  };

  const objects = [];
  // 算滑条路径的计算量，整张图共用（core/slider-path.js）：约几十毫秒，用完了剩下的滑条按最后一个控制点算
  const pathBudget = { ops: 3e7 };
  for (const line of objectRaw) {
    const p = line.split(',');
    if (p.length < 4) continue;
    const x = num(p[0]);
    const y = num(p[1]);
    const t = num(p[2], NaN);
    const type = num(p[3]);
    if (!Number.isFinite(t)) continue;
    if (type & 8) {
      objects.push({ t, end: Math.max(t, num(p[5], t)), x: 256, y: 192, ex: 256, ey: 192, kind: 'spinner' });
    } else if (type & 2) {
      // 滑条：时长 = 长度 / (滑条倍数 × 100 × 绿线倍数) × 拍长 × 来回次数；
      // 尾巴：沿滑条路径走到像素长度那里（core/slider-path.js；原来拿最后一个控制点，有的滑条差上百像素），来回偶数次就回到头。
      const shape = String(p[5] ?? '').split('|');
      const curve = shape.slice(1).map((s) => s.split(':').map(Number)).filter((c) => c.length === 2 && c.every(Number.isFinite));
      const slides = Math.max(1, Math.round(num(p[6], 1)));
      const length = Math.max(0, num(p[7], 0));
      const dur = length / (sliderMultiplier * 100 * svAt(t)) * beatAt(t) * slides;
      let end = curve.length ? sliderEnd([x, y], shape[0], curve, length, pathBudget) : [x, y];
      if (!end.every(Number.isFinite) || Math.hypot(end[0] - x, end[1] - y) > 4000) end = curve.length ? curve[curve.length - 1] : [x, y];
      const tail = slides % 2 === 1 ? end : [x, y];
      // vel：滑条真实的速度（像素 / 谱面毫秒）= 滑条倍数 × 100 × 绿线倍数 / 拍长，「滑条变速」用（2026-11-21）
      const vel = (sliderMultiplier * 100 * svAt(t)) / beatAt(t);
      objects.push({ t, end: t + (Number.isFinite(dur) ? dur : 0), x, y, ex: tail[0], ey: tail[1], kind: 'slider', vel: Number.isFinite(vel) ? vel : 0 });
    } else if (type & 1) {
      objects.push({ t, end: t, x, y, ex: x, ey: y, kind: 'circle' });
    }
  }
  objects.sort((a, b) => a.t - b.t);
  if (!objects.length) return null;
  for (const o of objects) o.beat = beatAt(o.t);
  return { mode, cs, ar, sliderMultiplier, timing, reds, objects, breaks };
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * 串最慢多快（真实毫秒，两下之间）：115ms ≈ 130 BPM 的 1/4 拍。
 * 为什么（2026-11-21 用户拿 Camellia - Shun no Seafood… Paella [ancel's Delicatessen Extra] 问「这种滑条为什么被认成串」）：
 * 那张图的红线写的是 110 BPM（歌其实是 220 左右），谱面上的「1/4 拍」真实是 136ms 一下，是 220 BPM 的 1/2 拍走位 / 滑条，不是串；
 * 只按谱面上的拍子看会被骗。真的串一下接一下要快得多（220 BPM 的串是 68ms）。
 */
export const STREAM_MAX_GAP_MS = 115;

/**
 * 串（节奏连续的一长串，转盘和休息段打断）。返回 [{ start, end, count, gapReal, tapBpm }]。
 * 滑条只能在串的头尾（2026-11-21 同上：一串 kick 滑条，每个都要按住一下，用户不认为是串）：串中间遇到滑条就到头，滑条算最后一下。
 */
export function findStreams(objs, rate, inBreak, radius = 32) {
  const runs = [];
  let cur = null;
  const close = () => {
    if (cur && cur.items.length >= 4) runs.push(cur);
    cur = null;
  };
  for (let i = 1; i < objs.length; i += 1) {
    const a = objs[i - 1];
    const b = objs[i];
    const gap = b.t - a.t;
    const gapReal = gap / rate;
    // 硬断开：转盘、休息段、隔太久；长滑条后面接的也不算连着（滑条尾到下一下也要够近）。
    const hard = a.kind === 'spinner' || b.kind === 'spinner' || inBreak(b.t) || gapReal > 250 || gap <= 0
      || (a.kind === 'slider' && b.t - a.end > a.beat / 4 * 1.15);
    // 节奏变了（和上一下差 35% 以上）：这一串到头，从这两下开始算新的一串。
    const soft = cur && Math.abs(gap - cur.lastGap) > 0.35 * cur.lastGap;
    if (hard) { close(); continue; }
    if (soft) close();
    // 串打到一半遇到滑条：滑条是这一串的最后一下（已经加进去了），从它开始不再往下连。
    // 滑条开头接一串圈可以（cur 为空时从滑条起头）；一串滑条连着的每段最多两下，凑不成串。
    // 刚连上两三下就碰到滑条（凑不成串、会被丢掉）：滑条不算谁的结尾，让它当下一串的开头（复核发现「圈、滑条、11 个圈」少认了滑条那一下）。
    if (cur && a.kind === 'slider') {
      const kept = cur.items.length >= 4;
      close();
      if (kept) continue;
    }
    if (!cur) cur = { items: [a], gaps: [], dists: [] };
    cur.items.push(b);
    cur.gaps.push(gap);
    cur.dists.push(Math.hypot(b.x - a.ex, b.y - a.ey) / radius);
    cur.lastGap = gap;
  }
  close();
  const out = [];
  for (const run of runs) {
    const g = median(run.gaps);
    const quarter = median(run.items.map((o) => o.beat)) / 4;
    // 够快才算串：先看真实速度，两下之间不超过 STREAM_MAX_GAP_MS（红线写成一半 BPM 的图，谱面上的 1/4 拍其实是 1/2 拍）。
    // 再按拍子看，不超过 1.5 个 1/4 拍（1/4、1/3、1/6…）；慢的长链是 1/2 拍跳链之类，交给跳去认。
    // 按毫秒兜底到 95ms 且间距小（不超过 3 个半径）：BPM 写成两倍、串被写成 1/2 拍的图。不能放宽到 115ms：开 DT 时 180 BPM 的
    // 1/2 拍只有 111ms，会把整张图的小间距 1/2 拍都当成串；大间距的 1/2 拍就算快到 90ms 以内也是跳不是串（复核发现）。
    if (!(g / rate <= STREAM_MAX_GAP_MS && (g <= quarter * 1.5 || (g / rate <= 95 && median(run.dists) <= 3)))) continue;
    // 一下挪三百多像素的「串」其实是 1/4 拍的大跳（交给 findJumps），不说成串。
    if (median(run.dists) * radius >= BIG_JUMP_PX) continue;
    out.push({ start: run.items[0].t, end: run.items[run.items.length - 1].end, count: run.items.length, gapReal: g / rate, tapBpm: 15000 / (g / rate), sub: streamShape(run.items, run.dists) });
  }
  return out;
}

/**
 * 串的样子（2026-11-21 用户：「能区分 space stream、cut stream 之类的区别吗」）。
 * 定义照 osu! 官方的谱面标签（wiki Beatmap/Beatmap_tags，有中文版），门槛按用户电脑上 3 万张图里 4.7 万条串的分布定：
 *   'cut'     断开的串：节奏不断，个别几下的间距远大于串里别的（官方：「其中个别物件间距远大于串中其他物件的串」）。
 *             一下「切口」= 间距 ≥ 2.4 个半径、≥ 前后几下的 2.5 倍、≥ 前后几下 + 2 个半径；至少两下切口，平均 12 下至少一下，
 *             而且切口隔得有规律（七成以上的间隔是同一个 3–8 下的倍数，最常见四个一组）。这样的串占 1.3%。
 *   'stacked' 叠串：八成以上相邻两下离不到 0.3 个半径（叠在一起）。
 *   'jumpy'   来回跳的串：中位间距 ≥ 3 个半径、四成以上的转向超过 120°（其实是 1/4 拍的来回跳）。
 *   'spaced'  宽间距串：中位间距 ≥ 2.4 个半径（官方：「间距较大的串，通常指物件之间没有重叠」；2 个半径时圆刚好挨着，
 *             2–2.4 个半径的占 7%，对六七星的玩家太常见，不报）。
 *   'normal'  别的。
 * dists 是相邻两下的间距（以半径计，从上一个的尾巴量起），和 items 一一对应（dists[i] 是 items[i] → items[i+1]）。
 */
/** 串的样子对难度分的加成（findHardSections 用来挑报哪几段）。 */
const SHAPE_WEIGHT = Object.freeze({ cut: 1.3, spaced: 1.3, jumpy: 1.5, stacked: 0.85, normal: 1 });

export function streamShape(items, dists) {
  if (!dists.length) return 'normal';
  const med = median(dists);
  // 断开：找切口。和这一下前后各三下（合起来六下，取偏小的中位）比，不和整条串的中位比
  // （2026-11-21 用户：onoken - K8107 [Red Another] 0:42.043「就是标准的 cut stream」：叠着的四连之间跳 80–96px，
  // 但串中间有七下 37px 的，整条串的中位被抬到 1.16 个半径，切口门槛跟着变成 101px，一个都没认出来）。
  // 切口至少 2.4 个半径（圆和圆明显不挨着）：叠着的几组之间挪 2 个半径（圆刚挨着）不算（复核发现）。
  const cuts = [];
  for (let i = 0; i < dists.length; i += 1) {
    const before = dists.slice(Math.max(0, i - 3), i);
    const after = dists.slice(i + 1, i + 4);
    // 偏小的中位：一边是叠着的四连、一边是正常间距时（K8107 那段从叠串进入 37px 的那一下）也认得出切口；
    // 只取挨得近的那一边不行：宽间距串末尾夹两个叠着的，前后那两下都成了「切口」（全库抽查时发现）
    const near = before.concat(after).sort((x, y) => x - y);
    const local = near.length ? near[Math.floor((near.length - 1) / 2)] : med;
    if (dists[i] >= Math.max(2.4, 2.5 * local, local + 2)) cuts.push(i);
  }
  if (cuts.length >= 2 && cuts.length * 12 >= dists.length) {
    const gaps = cuts.slice(1).map((c, i) => c - cuts[i]);
    // 挨着的切口（间隔 1）是间距整体变了、不是切开：它不是 3–8 的倍数，算在那三成里
    // 3–8 个一组：六成以上的间隔是同一个数的倍数（「四个一组、后面变成两个一组」的也认）。
    // 两个一组（二连之间跳）也算，但组里两下要真挨着（不是切口的那些挪动中位不到 1 个半径）：
    // 不然大间距来回跳的串里夹几个叠着的二连就成了「断开」（全库抽查时发现）。
    const share = (p) => gaps.filter((g) => g % p === 0).length / gaps.length;
    const rest = dists.filter((_, i) => !cuts.includes(i));
    const periodic = [3, 4, 5, 6, 7, 8].some((p) => share(p) >= 0.6) || (share(2) >= 0.7 && median(rest) < 1);
    if (periodic) return 'cut';
  }
  // 叠串：八成以上叠在一起；或者六成以上叠着、其余的挪动都不大（几个一组叠着、组和组挨着，比如叠着的四连一组组往前走）
  const stacked = dists.filter((d) => d < 0.3).length;
  if (stacked >= dists.length * 0.8 || (stacked >= dists.length * 0.6 && !cuts.length)) return 'stacked';
  if (med >= 3) {
    // 转向角：相邻两次移动的方向差（移动太短的不算）
    let sharp = 0;
    let turns = 0;
    for (let i = 1; i < items.length - 1; i += 1) {
      const a = items[i - 1];
      const b = items[i];
      const c = items[i + 1];
      const v1 = [b.x - a.ex, b.y - a.ey];
      const v2 = [c.x - b.ex, c.y - b.ey];
      const l1 = Math.hypot(...v1);
      const l2 = Math.hypot(...v2);
      if (l1 < 1 || l2 < 1) continue;
      turns += 1;
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2);
      if (cos < Math.cos((120 * Math.PI) / 180)) sharp += 1;
    }
    if (turns && sharp >= turns * 0.4) return 'jumpy';
  }
  if (med >= 2.4) return 'spaced';
  return 'normal';
}

/**
 * 「大跳」的门槛：光标真的要在屏幕上挪多远（osu! 坐标的像素，游戏区 512×384，和 CS 无关），多快。
 *
 * 为什么（2026-11-21 用户：「我理解的大跳是 Apollo - Brazil (moonpoint) [Fiery's Extreme] 结尾那种跳」）：
 * 那张图 223 BPM，前面的 1/2 拍跳是 240–320px、四五下一组，用户叫它普通跳；结尾 0:35–0:38 连着 23 下 330–508px
 * （中位 370px、每毫秒挪 2.7px），这才是大跳。原来按「这张图平时的走位再大 30%、至少 4 个半径（CS4 约 145px）」算：
 * 间距小的图里两三百像素、甚至一百多像素的走位都被叫成大跳（用户打过的图里 Supersonic 210px、謳 195px 都报了大跳）。
 *
 * 现在：
 *   一下大跳   从上一个物件的尾巴挪到这一下 BIG_JUMP_PX 以上，中间真实时间不超过 BIG_JUMP_MAX_GAP_MS（慢悠悠挪过去的不算）。
 *              不再按拍子（1/2 拍）卡：1/4、1/3 拍挪三四百像素一样是大跳（复核时全库找到两百多张图的这种段被漏掉）。
 *   一段大跳   连着至少 6 下，中间最多夹一下不是大跳的；整段的中位距离到 BIG_JUMP_SECTION_PX、中位速度到 BIG_JUMP_MIN_SPEED，
 *              只是刚过 320px 的（像那张图前面的普通跳）不算（复核时按全库 3 万张图定的，Fiery 结尾 370px / 2.7px 每毫秒照样算）。
 */
export const BIG_JUMP_PX = 320;
export const BIG_JUMP_MAX_GAP_MS = 250;
export const BIG_JUMP_SECTION_PX = 350;
export const BIG_JUMP_MIN_SPEED = 2.0; // 像素 / 毫秒（真实时间）

/** 大跳段。间距从上一个物件的尾巴量起。返回 [{ start, end, count, vMean, medianPx }]。 */
export function findJumps(objs, rate, inBreak, { minPx = BIG_JUMP_PX, maxGapMs = BIG_JUMP_MAX_GAP_MS, sectionPx = BIG_JUMP_SECTION_PX, minSpeed = BIG_JUMP_MIN_SPEED } = {}) {
  const pairs = [];
  for (let i = 1; i < objs.length; i += 1) {
    const a = objs[i - 1];
    const b = objs[i];
    if (a.kind === 'spinner' || b.kind === 'spinner' || inBreak(b.t)) { pairs.push(null); continue; }
    // 挪光标的时间从上一个物件的尾巴算（滑条拉完才能走）；按真实时间（开 DT 变快、HT 变慢）。
    const tailMap = b.t - a.end;
    const tailReal = Math.max(1, tailMap / rate);
    const dist = Math.hypot(b.x - a.ex, b.y - a.ey);
    const isJump = tailMap > 0 && tailReal <= maxGapMs && dist >= minPx;
    pairs.push({ a, b, isJump, dist, v: dist / Math.max(40, tailReal), headReal: (b.t - a.t) / rate });
  }
  const out = [];
  let cur = null;
  let pending = null; // 夹在中间的那一下（后面还是大跳才算进这一段）
  const close = () => {
    if (cur && cur.jumps.length >= 6) {
      const medianPx = median(cur.jumps.map((p) => p.dist));
      const speed = median(cur.jumps.map((p) => p.v));
      if (medianPx >= sectionPx && speed >= minSpeed) {
        out.push({ start: cur.start, end: cur.end, count: cur.jumps.length + cur.bridged + 1, vMean: cur.jumps.reduce((s, p) => s + p.v, 0) / cur.jumps.length, medianPx });
      }
    }
    cur = null;
    pending = null;
  };
  for (const p of pairs) {
    if (p && p.isJump) {
      if (!cur) cur = { start: p.a.t, end: p.b.end, jumps: [], bridged: 0 };
      if (pending) { cur.bridged += 1; pending = null; }
      cur.jumps.push(p);
      cur.end = p.b.end;
    } else if (cur && p && !pending && cur.bridged < 1 && p.headReal <= 400) {
      // 一段里最多夹一下不是大跳的（复核发现：原来每跳一下就重新允许夹一下，「大 小 大 小」交替的普通跳也连成了大跳段）；
      // 隔得久的不算夹：那是两段。
      pending = p;
    } else {
      close();
    }
  }
  close();
  return out;
}

/**
 * 变速：玩家真打过的上一段 BPM 和接下来这段比，变了 15% 以上。
 * 底下一个物件都没有的红线不算（复核发现：拿相邻红线直接比，会被中间没物件的红线带偏，报出根本没变的变速）。
 */
function findSpeedChanges(parsed, rate) {
  const out = [];
  const { reds, objects } = parsed;
  const redIndexAt = (t) => { let k = 0; for (let i = 0; i < reds.length; i += 1) { if (reds[i].time <= t + 1) k = i; else break; } return k; };
  const hasObjects = (i) => { const from = reds[i].time; const to = i + 1 < reds.length ? reds[i + 1].time : Infinity; return objects.some((o) => o.t >= from - 1 && o.t < to - 1); };
  const seen = new Set();
  for (let i = 1; i < reds.length; i += 1) {
    const t = reds[i].time;
    const soon = objects.find((o) => o.t >= t - 1 && o.t <= t + 2000 * rate);
    if (!soon || t <= objects[0].t || seen.has(soon.t)) continue;
    const cur = redIndexAt(soon.t);
    let prevIdx = cur - 1;
    while (prevIdx >= 0 && !hasObjects(prevIdx)) prevIdx -= 1;
    if (prevIdx < 0) continue;
    const prev = 60000 / reds[prevIdx].beatLength;
    const next = 60000 / reds[cur].beatLength;
    if (!(Math.abs(next - prev) / prev >= 0.15)) continue;
    // 正好翻倍 / 减半多半只是写法（180 写成 90），节奏没变：不算变速。
    const ratio = next / prev;
    if (Math.abs(ratio - 2) < 0.06 || Math.abs(ratio - 0.5) < 0.03) continue;
    seen.add(soon.t);
    out.push({ start: soon.t, end: soon.t, faster: next > prev, bpmFrom: Math.round(prev * rate), bpmTo: Math.round(next * rate) });
  }
  return out;
}

/**
 * 难段列表（按开始时间排）：
 *   kind      'stream' 长串 / 'jump' 大跳 / 'stream-jump' 先串后跳 / 'jump-stream' 先跳后串 / 'alternate' 串跳轮着来 / 'speed' 变速
 *             / 'peak' 难度曲线上的高峰、规则没认出来的（sub: aim / speed / reading，2026-11-21）
 *   start,end 谱面时间（毫秒，和 tosu 的 beatmap.time.live 同一套）
 *   count     物件数；severity 相对这张图的难度分（越大越该提醒）
 * opts：rate（DT 1.5 / HT 0.75）、cs（套过 mod 的 CS；没有就用谱面里的）、max（最多几段）、minGapSec（两段的提醒至少隔几秒）、
 *       leadSec（提前几秒报：开头来不及报的不要）、peaks（findStrainPeaks 的结果：tosu 难度曲线上的高峰）
 */
export function findHardSections(parsed, { rate = 1, cs = null, max = 4, minGapSec = 15, leadSec = 2.5, peaks = null } = {}) {
  if (!parsed || !parsed.objects?.length) return [];
  rate = num(rate, 1) > 0 ? num(rate, 1) : 1;
  const radius = 54.4 - 4.48 * (Number.isFinite(Number(cs)) && cs !== null ? Number(cs) : parsed.cs);
  const breaks = parsed.breaks || [];
  const inBreak = (t) => breaks.some((b) => t > b.start && t < b.end);
  const objs = parsed.objects;

  const r = Math.max(8, radius);
  const streams = findStreams(objs, rate, inBreak, r).filter((s) => s.count >= 12);
  // 「大跳」按光标真的挪多远算（见 BIG_JUMP_PX）：不再和这张图平时的走位比（那样间距小的图里走路段也成了大跳）。
  const jumps = findJumps(objs, rate, inBreak);
  const speeds = findSpeedChanges(parsed, rate);

  // 相对这张图打分：串看长短和快慢（和这张图里别的串比），跳看多少下和多快（和这张图里别的跳比）。
  const refTap = median(streams.map((s) => s.tapBpm)) || 1;
  const refV = median(jumps.map((j) => j.vMean)) || 1;
  let cands = [
    // 串的样子（streamShape）也算进难度：宽间距、断开、来回跳的比普通的难，叠在一起的好打一点。
    ...streams.map((s) => ({ kind: 'stream', sub: s.sub, start: s.start, end: s.end, count: s.count, durReal: (s.end - s.start) / rate, severity: (s.count / 16) * (s.tapBpm / refTap) ** 2 * (SHAPE_WEIGHT[s.sub] ?? 1) })),
    ...jumps.map((j) => ({ kind: 'jump', start: j.start, end: j.end, count: j.count, severity: (j.count / 8) * (j.vMean / refV) })),
  ];

  // 整张图都是串 / 都是跳（这类难段占了打图时间的四成以上）：只留比同类明显难的（同类中位数的 1.5 倍以上）。
  const drain = Math.max(1, objs[objs.length - 1].end - objs[0].t - breaks.reduce((s, b) => s + Math.max(0, b.end - b.start), 0));
  for (const kind of ['stream', 'jump']) {
    const same = cands.filter((c) => c.kind === kind);
    const cover = same.reduce((s, c) => s + (c.end - c.start), 0) / drain;
    // 只有一两段时不比（和包含自己的中位数比，一两段会全被删掉；复核发现）：条数交给后面的 max 去限。
    if (cover > 0.4 && same.length >= 3) {
      const bar = median(same.map((c) => c.severity)) * 1.5;
      cands = cands.filter((c) => c.kind !== kind || c.severity >= bar);
    }
  }

  // 挨着的难段并成一段：只在「这一段的提示会落在前一段里面」时并（隔得比提前量还近），提示要在整串之前开口
  // （复核发现：kick 滑条把一条长串切成几段时，提示落在串中间）。隔得远的不并，免得把走路段也算进来。
  // 并起来的记住先后（2026-11-21 用户：串后面有跳和跳后面有串是两个东西）：parts 按时间排，kind 是
  // stream / jump（只有一种）、stream-jump（先串后跳）、jump-stream（先跳后串）、alternate（串和跳轮着来）。
  cands.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of cands) {
    const last = merged[merged.length - 1];
    const near = last && c.start - last.end <= (leadSec * 1000 + 300) * rate;
    if (near) {
      last.parts.push(c.kind);
      // 串的真实时长只加串本身（中间歇的那一下不算，复核发现：两段 30 下的串中间歇 2.7 秒，被说成「一大段长串」）
      if (c.kind === 'stream') { last.subs.push({ sub: c.sub, count: c.count, start: c.start }); last.durReal = (last.durReal ?? 0) + c.durReal; }
      last.end = Math.max(last.end, c.end);
      last.count += c.count;
      last.severity += c.severity;
    } else merged.push({ ...c, parts: [c.kind], subs: c.kind === 'stream' ? [{ sub: c.sub, count: c.count, start: c.start }] : [] });
  }
  for (const m of merged) {
    const groups = m.parts.filter((k, i) => i === 0 || k !== m.parts[i - 1]);
    m.kind = groups.length === 1 ? groups[0] : groups.length === 2 ? `${groups[0]}-${groups[1]}` : 'alternate';
    // 几截串并成一段：样子都一样就说那个样子；不一样时，里面有像样的（12 下以上）来回跳 / 断开 / 宽间距的一截，
    // 就说「中间有……」（2026-11-21 用户：K8107 [Red Another] 0:42 的断开的串被并进前后的长串，只报了「一大段长串」）。
    if (m.kind === 'stream') {
      if (m.subs.every((x) => x.sub === m.subs[0].sub)) m.sub = m.subs[0].sub;
      else {
        const notable = ['jumpy', 'cut', 'spaced'].map((k) => m.subs.find((x) => x.sub === k && x.count >= 12)).find(Boolean);
        m.sub = notable ? notable.sub : 'normal';
        if (notable) { m.mixed = true; m.subStart = notable.start; }
      }
    } else delete m.sub;
    delete m.parts;
    delete m.subs;
  }
  // 变速单独一类（不和串跳合并），分数给中等：只在名额没被更难的段占满时报。
  for (const s of speeds) merged.push({ kind: 'speed', start: s.start, end: s.end, count: 0, severity: 0.9, faster: s.faster, bpmFrom: s.bpmFrom, bpmTo: s.bpmTo });

  // 难度曲线上的高峰（tosu 算好的，2026-11-21）：和认出来的难段重叠就给它加分（排得更靠前、更容易被报）；
  // 不重叠的是规则没认出来的难处（tech、读图之类），单独成一段 'peak'，按这段主要考什么说——但只拿来补空位（见下面）。
  const extra = [];
  for (const pk of Array.isArray(peaks) ? peaks : []) {
    if (!(pk && pk.end > pk.start)) continue;
    const hit = merged.filter((m) => m.kind !== 'speed' && m.start <= pk.end && pk.start <= m.end);
    for (const m of hit) { m.severity *= 1 + 0.5 * Math.max(0, (Number(pk.strength) || 1) - 1); m.peak = true; }
    if (!hit.length) extra.push({ kind: 'peak', sub: pk.sub, start: Math.round(pk.start), end: Math.round(pk.end), count: 0, severity: Math.max(0.5, Number(pk.strength) || 1) });
  }

  // 开头来不及报的不要（第一个物件之后 leadSec + 1 秒内开始的段）。
  const first = objs[0].t;
  const inTime = (m) => (m.start - first) / rate >= (leadSec + 1) * 1000;
  // 按难度从高到低挑，两段的提醒至少隔 minGapSec 秒（真实时间），最多 max 段。
  // 先挑规则认出来的（和变速），名额还有空再用曲线高峰补：曲线只是补充，不能把认出来的长串 / 大跳挤掉
  // （复核发现：高峰的分数没有上限，一个高峰隔 15 秒以内挤掉了前后的长串和大跳）。
  const picked = [];
  const take = (list) => {
    for (const m of [...list].filter(inTime).sort((a, b) => b.severity - a.severity)) {
      if (picked.length >= max) break;
      if (picked.some((p) => Math.abs(p.start - m.start) / rate < minGapSec * 1000)) continue;
      picked.push(m);
    }
  };
  take(merged);
  take(extra);
  return picked.sort((a, b) => a.start - b.start).map((m) => ({ ...m, severity: Math.round(m.severity * 100) / 100 }));
}

/**
 * 提醒说什么：几句完整的人话（2026-11-21 用户：要说正常人话，不要单蹦一个「大跳」）。开图前就合成好放在内存里，
 * 打图中途不现场合成。念完大约两秒，提前量按实际念多久算（core/heads-up.js）。
 */
export const CUE_PHRASES = Object.freeze({
  streamShort: '后面有一小段串，准备一下',
  stream: '后面有一段长串，准备好',
  streamLong: '后面是一大段长串，稳住节奏',
  // 串的样子（streamShape，2026-11-21 用户：「能区分 space stream、cut stream 之类的区别吗」）
  streamSpaced: '后面是一段间距很大的串，手跟着走',
  streamCut: '后面是断开的串，几个一组中间要跳',
  streamStacked: '后面有一段叠在一起的串，手指稳住',
  streamJumpy: '后面是来回跳的串，手腕放开',
  // 一大段长串（几截并起来的），中间有一截样子特别的
  streamLongCut: '后面是一大段长串，中间有断开的，几个一组要跳',
  streamLongSpaced: '后面是一大段长串，中间有一段间距很大',
  streamLongJumpy: '后面是一大段长串，中间有来回跳的',
  jump: '后面要开始大跳了，手放开点',
  streamJump: '后面先来一段串，接着就是跳',
  jumpStream: '后面先跳一阵，跳完马上接串',
  alternate: '后面串和跳轮着来，别慌',
  // 难度曲线上的高峰、规则没认出来的那种（按这段主要考什么说）
  peakAim: '后面这段很考 aim，看准了再点',
  peakSpeed: '后面这段很考手速，手指跟上',
  peakReading: '后面这段很难读，看清楚再点',
  speedUp: '后面要变快了，跟上节奏',
  speedDown: '后面要变慢了，别抢拍',
});

/** 「一大段长串」的门槛：下数或者真实时长到一个就算。 */
export const LONG_STREAM_COUNT = 65;
export const LONG_STREAM_MS = 8000;

export function cueOf(section) {
  if (!section) return '';
  switch (section.kind) {
    case 'stream': {
      // 「一大段长串」（死串）：65 下以上或者 8 秒以上。原来 33 下就算：全库 33 下以上的串占一成半，对六七星的玩家不算死串（复核按全库分布定）
      const long = section.count >= LONG_STREAM_COUNT || (section.durReal ?? 0) >= LONG_STREAM_MS;
      // 几截并起来的一大段长串，中间有一截断开 / 宽间距 / 来回跳的：两样都说
      const longWith = { cut: CUE_PHRASES.streamLongCut, spaced: CUE_PHRASES.streamLongSpaced, jumpy: CUE_PHRASES.streamLongJumpy }[section.sub];
      if (long && section.mixed && longWith) return longWith;
      const shaped = { spaced: CUE_PHRASES.streamSpaced, cut: CUE_PHRASES.streamCut, stacked: CUE_PHRASES.streamStacked, jumpy: CUE_PHRASES.streamJumpy }[section.sub];
      if (shaped) return shaped;
      if (long) return CUE_PHRASES.streamLong;
      return section.count >= 17 ? CUE_PHRASES.stream : CUE_PHRASES.streamShort;
    }
    case 'jump': return CUE_PHRASES.jump;
    case 'stream-jump': return CUE_PHRASES.streamJump;
    case 'jump-stream': return CUE_PHRASES.jumpStream;
    case 'alternate': return CUE_PHRASES.alternate;
    case 'speed': return section.faster ? CUE_PHRASES.speedUp : CUE_PHRASES.speedDown;
    case 'peak': return section.sub === 'speed' ? CUE_PHRASES.peakSpeed : section.sub === 'reading' ? CUE_PHRASES.peakReading : CUE_PHRASES.peakAim;
    default: return '';
  }
}

/**
 * 难度曲线里的高峰（2026-11-21 用户：用 tosu 的难度曲线补难段预告）。
 * graph 是 tosu 的 performance.graph：series [{ name, data }]（aim / speed / reading …，每段约 400 毫秒一个峰值），
 * xaxis 是每段开头的真实毫秒（开 DT 时乘回倍速才是谱面时间）；负数是片头片尾的填充，不算。
 * 每段取 aim / speed / reading 里最大的；比这张图九成的段都难（90 分位以上）、连着至少 3 段（约 1.2 秒，中间可以夹一段）算一个高峰。
 * 返回 [{ start, end（谱面毫秒）, sub: 'aim' | 'speed' | 'reading'（这段主要考什么）, strength（段内平均 / 全图中位）}]。
 */
export function findStrainPeaks(graph, { rate = 1 } = {}) {
  const series = Array.isArray(graph?.series) ? graph.series : [];
  const xs = Array.isArray(graph?.xaxis) ? graph.xaxis : [];
  const pick = (name) => (series.find((s) => s && s.name === name)?.data || []);
  const aim = pick('aim');
  const speed = pick('speed');
  const reading = pick('reading');
  const n = Math.min(xs.length, aim.length || Infinity, speed.length || Infinity);
  if (!Number.isFinite(n) || n < 20) return [];
  rate = num(rate, 1) > 0 ? num(rate, 1) : 1;
  const at = (arr, i) => (Number.isFinite(Number(arr[i])) ? Number(arr[i]) : -1);
  const s = [];
  for (let i = 0; i < n; i += 1) s.push(at(aim, i) < 0 && at(speed, i) < 0 ? null : Math.max(at(aim, i), at(speed, i), at(reading, i), 0));
  const pos = s.filter((v) => v !== null && v > 0);
  if (pos.length < 20) return [];
  const sorted = [...pos].sort((a, b) => a - b);
  const bar = sorted[Math.floor(sorted.length * 0.9)];
  const mid = sorted[Math.floor(sorted.length / 2)] || 1;
  const gaps = [];
  for (let i = 1; i < n; i += 1) { const g = Number(xs[i]) - Number(xs[i - 1]); if (g > 0) gaps.push(g); }
  const sectionMs = median(gaps) || 400;
  const out = [];
  let run = null;
  let misses = 0;
  const close = () => {
    if (run && run.last - run.first + 1 >= 3) {
      const idx = [];
      for (let i = run.first; i <= run.last; i += 1) if (s[i] !== null) idx.push(i);
      const mean = (arr) => idx.reduce((t, i) => t + Math.max(0, at(arr, i)), 0) / idx.length;
      const skills = [['aim', mean(aim)], ['speed', mean(speed)], ['reading', reading.length ? mean(reading) : 0]];
      skills.sort((a, b) => b[1] - a[1]);
      out.push({ start: Number(xs[run.first]) * rate, end: (Number(xs[run.last]) + sectionMs) * rate, sub: skills[0][0], strength: idx.reduce((t, i) => t + s[i], 0) / idx.length / mid });
    }
    run = null;
    misses = 0;
  };
  for (let i = 0; i < n; i += 1) {
    // 要严格超过 90 分位（刚好等于的不算：难度值扎堆相等时，高峰旁边那段会被带进来）
    const above = s[i] !== null && s[i] > bar;
    if (above) { if (!run) run = { first: i, last: i }; run.last = i; misses = 0; }
    else if (run && misses < 1 && s[i] !== null) misses += 1;
    else close();
  }
  close();
  return out;
}

/** AR → 圈提前多少毫秒出现（osu! 的公式；AR 是算上 mod 之后的就是真实毫秒，谱面里的 AR 就是谱面毫秒）。 */
export function preemptMs(ar) {
  const a = num(ar, 5);
  return a < 5 ? 1200 + (600 * (5 - a)) / 5 : 1200 - (750 * (a - 5)) / 5;
}

/**
 * 滑条变速（2026-11-21 用户让加）：
 * 按出现顺序，相邻两条滑条（中间可以隔着圈）的真实速度（滑条倍数 × 绿线 / 拍长）差 15% 以上算一次变速。
 * 返回 { sliders, changes, rate }（rate = 变速次数 / 相邻对数）。
 */
export function sliderSpeedChanges(objs) {
  const vs = (objs || []).filter((o) => o.kind === 'slider' && o.vel > 0).map((o) => o.vel);
  let changes = 0;
  for (let i = 1; i < vs.length; i += 1) if (Math.abs(vs[i] - vs[i - 1]) / Math.min(vs[i], vs[i - 1]) >= 0.15) changes += 1;
  return { sliders: vs.length, changes, rate: vs.length > 1 ? changes / (vs.length - 1) : 0 };
}

/**
 * 读图：有多少圈一出现就压在同屏另一个圈上（2026-11-21 用户让加）。
 * 「同屏」按 AR：后一个圈出现的时候（提前 preempt 毫秒），前一个还没打（滑条还没拉完）。
 * 紧挨着的前三个不算（串和连打本来就一个挨一个）；隔四个以上还压在一起（两圆心距离不到一个直径，前一个是滑条时头尾都算），
 * 而且中间光标走开过再回来，才算——串绕回来压住自己、低 AR 下一屏好多圈叠着，这种才难读；叠在原地的叠串不算。
 * radius 是圆的半径（osu! 像素）；windowMs 是谱面毫秒里的同屏时长。返回 0–1。
 */
export function overlapShare(objs, { radius = 36.5, windowMs = 450 } = {}) {
  let hit = 0;
  let total = 0;
  let from = 0;
  const near = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by) < 2 * radius;
  for (let i = 0; i < objs.length; i += 1) {
    const o = objs[i];
    if (o.kind === 'spinner') continue;
    total += 1;
    const appear = o.t - windowMs;
    while (from < i && objs[from].end < appear) from += 1;
    for (let j = from; j <= i - 4; j += 1) {
      const p = objs[j];
      if (p.kind === 'spinner' || p.end < appear) continue;
      if (!(near(o.x, o.y, p.x, p.y) || (p.kind === 'slider' && near(o.x, o.y, p.ex, p.ey)))) continue;
      // 中间要真的走开过（离 p 三个半径以上）再回来：一整串叠在原地的（叠串、长串练习图）不算难读（全库校准时发现它们全排在最前面）
      let left = false;
      for (let k = j + 1; k < i && !left; k += 1) left = Math.hypot(objs[k].x - p.x, objs[k].y - p.y) >= 3 * radius;
      if (left) { hit += 1; break; }
    }
  }
  return total ? hit / total : 0;
}

/**
 * 「这是张什么图」，从谱面本身看（2026-11-21 用户要看玩家标签，又说「不是所有图都有」：没有标签时用这个，有的话两样都给模型）。
 * 整张图里所有像样的串（12 下以上）和大跳段，不像难段预告那样只挑最难的几段。
 * 返回 { streams, longStreams, deathStreams, shapes: { cut, spaced, stacked, jumpy }, jumps, streamShare, jumpShare, speedChanges,
 *        sliderSpeed: { sliders, changes, rate }, overlap }。
 * ar：算上 mod 之后的 AR（tosu 给的，真实时间）；不给就用谱面里写的。
 */
export function mapProfile(parsed, { rate = 1, cs = null, ar = null } = {}) {
  const empty = { streams: 0, longStreams: 0, deathStreams: 0, shapes: { cut: 0, spaced: 0, stacked: 0, jumpy: 0 }, jumps: 0, streamShare: 0, jumpShare: 0, speedChanges: 0, sliderSpeed: { sliders: 0, changes: 0, rate: 0 }, overlap: 0 };
  if (!parsed || !parsed.objects?.length) return empty;
  rate = num(rate, 1) > 0 ? num(rate, 1) : 1;
  const radius = Math.max(8, 54.4 - 4.48 * (Number.isFinite(Number(cs)) && cs !== null ? Number(cs) : parsed.cs));
  const breaks = parsed.breaks || [];
  const inBreak = (t) => breaks.some((b) => t > b.start && t < b.end);
  const objs = parsed.objects;
  const streams = findStreams(objs, rate, inBreak, radius).filter((s) => s.count >= 12);
  const jumps = findJumps(objs, rate, inBreak);
  const drain = Math.max(1, objs[objs.length - 1].end - objs[0].t - breaks.reduce((s, b) => s + Math.max(0, b.end - b.start), 0));
  const shapes = { cut: 0, spaced: 0, stacked: 0, jumpy: 0 };
  for (const s of streams) if (s.sub in shapes) shapes[s.sub] += 1;
  return {
    streams: streams.length,
    longStreams: streams.filter((s) => s.count >= 33).length,
    deathStreams: streams.filter((s) => s.count >= LONG_STREAM_COUNT || (s.end - s.start) / rate >= LONG_STREAM_MS).length,
    shapes,
    jumps: jumps.length,
    streamShare: Math.min(1, streams.reduce((s, x) => s + (x.end - x.start), 0) / drain),
    jumpShare: Math.min(1, jumps.reduce((s, x) => s + (x.end - x.start), 0) / drain),
    speedChanges: findSpeedChanges(parsed, rate).length,
    sliderSpeed: sliderSpeedChanges(objs),
    // 同屏多久：算上 mod 的 AR 是真实毫秒，换成谱面毫秒要乘倍速；谱面里写的 AR 本来就是谱面毫秒
    overlap: overlapShare(objs, { radius, windowMs: ar !== null && ar !== undefined && Number.isFinite(Number(ar)) ? preemptMs(ar) * rate : preemptMs(parsed.ar) }),
  };
}

/**
 * 「滑条变速多」「难读」的门槛（2026-11-21 按用户电脑上 4800 张图的分布定）：
 * 滑条变速：25% 以上的相邻两条滑条速度差一成半以上（全库前一成左右）、而且至少变 10 次、至少 30 条滑条；
 * 难读：3% 以上的圈出现时压着同屏的别的圈（全库前 5% 左右，排最前的是 2B 图、AR0 图）。
 */
export const SLIDER_SPEED_MANY = 0.25;
export const OVERLAP_MANY = 0.03;

/** mapProfile → 给模型看的一句中文（「偏串图：串 12 段，约占 35% 的时间，其中 2 段长串；有断开的串 3 段；大跳 2 段」）。 */
export function profileText(p) {
  if (!p) return '';
  const pct = (x) => `${Math.round(x * 100)}%`;
  const parts = [];
  if (p.streams) {
    const long = [p.longStreams ? `${p.longStreams} 段长串` : '', p.deathStreams ? `${p.deathStreams} 段一大段长串（死串）` : ''].filter(Boolean).join('、');
    parts.push(`串 ${p.streams} 段，约占 ${pct(p.streamShare)} 的时间${long ? `，其中 ${long}` : ''}`);
    const names = { cut: '断开的串', spaced: '宽间距串', stacked: '叠串', jumpy: '来回跳的串' };
    const shaped = Object.entries(names).filter(([k]) => p.shapes?.[k]).map(([k, name]) => `${name} ${p.shapes[k]} 段`);
    if (shaped.length) parts.push(`有${shaped.join('、')}`);
  }
  if (p.jumps) parts.push(`大跳 ${p.jumps} 段，约占 ${pct(p.jumpShare)} 的时间`);
  if (p.speedChanges) parts.push(`有 ${p.speedChanges} 处变速`);
  const ss = p.sliderSpeed;
  if (ss && ss.sliders >= 30 && ss.changes >= 10 && ss.rate >= SLIDER_SPEED_MANY) parts.push(`滑条变速多（相邻两条滑条约 ${pct(ss.rate)} 速度不一样）`);
  if (p.overlap >= OVERLAP_MANY) parts.push(`难读（约 ${pct(p.overlap)} 的圈一出现就压着同屏别的圈）`);
  if (!p.streams && !p.jumps) parts.unshift('没有明显的长串和大跳');
  const label = p.streamShare >= 0.3 && p.jumpShare >= 0.15 ? '串和大跳都多' : p.streamShare >= 0.3 ? '偏串图' : p.jumpShare >= 0.15 ? '偏跳图' : '';
  return `${label ? `${label}：` : ''}${parts.join('；')}`;
}

/**
 * 提前多久开口（真实秒数）：2 秒和 4 拍里取长的，最多 3 秒（AR10 下玩家自己只能提前约 0.45 秒看到圈，一句短提示念出来要约 1 秒）。
 * beatMs 是谱面里的拍长，rate 是倍速。
 */
export function leadSecOf(beatMs, rate = 1) {
  const beatReal = num(beatMs, 500) / (num(rate, 1) || 1) / 1000;
  return Math.min(3, Math.max(2, beatReal * 4));
}
