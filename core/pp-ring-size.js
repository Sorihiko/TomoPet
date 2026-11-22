/**
 * 脚下 pp 地台环的大小（2026-11-21）：renderer/pp-ring.ts 按它画，app/pet-window.js 按它给窗口底下留地方，两边用同一套，
 * 角色放大了环跟着大、留白也跟着大（复核发现：原来留白固定 46 像素，缩放到 0.5 以上字就压到环上、1.5 时环被窗口底边切掉）。
 *
 * hitboxW 是皮肤 hitbox 的宽（画布坐标，连头发、尾巴），scale 是缩放；maxRx 是环最宽多少（窗口宽的四成）。
 */
/** 难度墙（竖在环上的难度曲线）最高多高：环横半径的这个比例（往上长，不占脚下的地方）。 */
export const CURVE_WALL = 0.4;

export function ringSize(hitboxW, scale, maxRx = Infinity) {
  const rx = Math.max(46, Math.min(maxRx, (Number(hitboxW) || 512) * (Number(scale) || 0.4) * 0.42));
  const ry = Math.max(9, rx * 0.17);
  const stroke = Math.max(4, Math.round(rx * 0.06));
  const font = Math.round(Math.max(13, Math.min(30, rx * 0.17)));
  return { rx, ry, stroke, font, wall: rx * CURVE_WALL };
}

/**
 * pp 那块字的几种样子（2026-11-22 用户从效果图里挑了三版：「这仨」）：
 *   card 黑底卡片（深灰卡片，大号 pp，右边两行小字）、paper 浅色成绩条（米白纸条、深色字）、type 只有字（没有底，大号 pp 在左、100 / 50 / miss 三列在右），
 *   还有原来的 line（环下面一行字）、arc（沿着环的前沿弯过去）。
 */
export const LABEL_LAYOUTS = ['card', 'paper', 'type', 'line', 'arc'];
export const labelLayoutOf = (v) => {
  const map = { 黑底卡片: 'card', 浅色成绩条: 'paper', 只有字: 'type', 环下面一行: 'line', 沿着环: 'arc' };
  const k = map[v] || v;
  return LABEL_LAYOUTS.includes(k) ? k : 'card';
};

/**
 * 三种新样子的尺寸：按效果图（环横半径 205 时）等比例缩，小字最小 11 像素（桌面默认大小时环只有 86 宽，照比例缩小字就看不清了）。
 * 返回字号、内边距、圆角、离环多远（gap）和这块字的高度（height，窗口底下按它留地方；页面上卡片也按它定高）。
 */
export function labelMetrics(rx, layout) {
  const k = Math.max(0.2, Number(rx) || 86) / 205;
  const px = (v, min) => Math.max(min, Math.round(v * k));
  const gap = px(8, 6);
  if (layout === 'type') {
    const big = px(52, 26);
    const lab = px(13, 11);
    const val = px(16, 12);
    const top = Math.max(px(20, 0), Math.ceil(lab * 1.3));
    const bottom = Math.max(px(28, 0), Math.ceil(val * 1.5));
    return { big, lab, val, top, bottom, col: Math.max(px(36, 0), Math.ceil(val * 2.2)), groupGap: px(12, 8), minGap: px(24, 12), gap, height: Math.max(Math.ceil(big * 0.8), top + bottom) };
  }
  const paper = layout === 'paper';
  const big = px(paper ? 28 : 32, 18);
  const lab = px(paper ? 12 : 12, 11);
  const val = px(paper ? 16 : 14, 11);
  const padV = px(8, 4);
  const padH = px(16, 8);
  const rowGap = px(4, 2);
  const inner = paper
    ? Math.max(Math.ceil(big * 0.9 + lab * 1.35), Math.ceil(lab * 1.35 + rowGap + val * 1.25))
    : Math.max(Math.ceil(big * 1.125), Math.ceil(Math.max(lab, val) * 1.2 * 2 + rowGap));
  return { big, lab, val, padV, padH, rowGap, colGap: px(paper ? 16 : 12, 8), split: px(16, 8), radius: px(12, 8), gap, height: inner + padV * 2 };
}

/**
 * 脚底下要留多少像素：环的下沿（环心在脚底往上 0.35 个 ry）+ 间隔 + 那块字的高度 + 一点边距。
 * line / arc（原来的一行字）：一行字高；card / paper / type：labelMetrics 的高度。
 * 难度墙是往上竖的，不占脚下（curve 参数留着，和以前的调用兼容）。
 */
export function ringFootroom(hitboxW, scale, maxRx = Infinity, curve = false, layout = 'card') { // eslint-disable-line no-unused-vars
  const { rx, ry, stroke, font } = ringSize(hitboxW, scale, maxRx);
  const l = labelLayoutOf(layout);
  if (l === 'line' || l === 'arc') return Math.ceil(ry * 0.65 + Math.max(4, stroke) + font * 1.35 + 6);
  const m = labelMetrics(rx, l);
  return Math.ceil(ry * 0.65 + stroke / 2 + m.gap + m.height + 8);
}
