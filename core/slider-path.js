/**
 * 滑条真正的尾巴在哪（纯函数）：按 osu! 的画法把滑条路径算出来，沿路径走到滑条的像素长度（.osu 里第 8 栏）为止。
 *
 * 为什么（2026-11-21 复核）：原来拿最后一个控制点当尾巴。多数滑条差个几像素，但滑条长度比控制点连线短 / 长、
 * 或者用控制点「画字」的滑条，能差上百像素：全库 3 万张图里约 5% 报出来的「大跳」因此报错或漏报
 * （有张图滑条尾巴算成离下一下 693px，其实只有 162px）。大跳按「从上一个物件的尾巴挪多远」认，尾巴要准。
 *
 *   sliderEnd([x, y], type, points, length, budget?) → [x, y]   type：L 直线 / P 圆弧 / B 贝塞尔 / C Catmull；points 是控制点（不含头）
 *   budget：{ ops } 整张图共用的计算量（parseOsu 给）。用完了剩下的滑条退回「最后一个控制点」（复核：全库有两张拿滑条画动画的图，
 *   不限要算四五秒，开图时会卡住整个程序；这种图的尾巴准不准无所谓）。
 *
 * 和 osu! 一样：P 只有正好三个点、而且三点不在一条线上时才是圆弧，不然按贝塞尔；B 里连续两个相同的点（红点）把曲线分段；
 * 路径比像素长度长就截断，短就顺着最后一段的方向直着延长。点多的贝塞尔限制计算量（有的谱面一条滑条几百个点，不限会卡住主进程）。
 */

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** 每段贝塞尔「采样点数 × 控制点数²」的上限：超过就少采几个点（最少 2 个，就是控制点的首尾连线）。 */
const BEZIER_SEGMENT_OPS = 2e5;

function bezier(cp, out, budget) {
  const n = cp.length;
  if (n === 1) { out.push(cp[0]); return; }
  if (n === 2) { out.push(cp[0], cp[1]); return; }
  // 一段的点多到算一次（最少也要 n² 量级）就超过剩下的计算量：直接用控制点连线（复核发现：只在开头查计算量时，
  // 一条两万个点的滑条照样要算一秒多，点数翻倍时间翻四倍）
  if (n * n * 3 > budget.ops) { for (const p of cp) out.push(p); budget.ops -= n; return; }
  let polyLen = 0;
  for (let i = 1; i < n; i += 1) polyLen += dist(cp[i - 1], cp[i]);
  let steps = Math.max(8, Math.min(400, Math.ceil(polyLen / 3)));
  steps = Math.max(2, Math.min(steps, Math.floor(BEZIER_SEGMENT_OPS / (n * n))));
  budget.ops -= steps * n * n;
  const tmp = cp.map((p) => [p[0], p[1]]);
  for (let k = 0; k <= steps; k += 1) {
    const t = k / steps;
    for (let i = 0; i < n; i += 1) { tmp[i][0] = cp[i][0]; tmp[i][1] = cp[i][1]; }
    for (let r = 1; r < n; r += 1) {
      for (let i = 0; i < n - r; i += 1) {
        tmp[i][0] += (tmp[i + 1][0] - tmp[i][0]) * t;
        tmp[i][1] += (tmp[i + 1][1] - tmp[i][1]) * t;
      }
    }
    out.push([tmp[0][0], tmp[0][1]]);
  }
}

/** 三点圆弧（头 → 中间点 → 终点）。三点几乎在一条线上、或者圆大得离谱时返回 false（照 osu! 退回贝塞尔）。 */
function arc(a, b, c, out, budget) {
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(cross) < 1e-3 * Math.max(1, dist(a, b) * dist(b, c))) return false;
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const cx = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const cy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  const r = Math.hypot(a[0] - cx, a[1] - cy);
  if (!Number.isFinite(r) || r > 1e5) return false;
  const t0 = Math.atan2(a[1] - cy, a[0] - cx);
  let t1 = Math.atan2(c[1] - cy, c[0] - cx);
  // 顺时针还是逆时针：看三点的转向（cross 的正负），扫过的角度朝那个方向
  if (cross > 0) { while (t1 < t0) t1 += 2 * Math.PI; } else { while (t1 > t0) t1 -= 2 * Math.PI; }
  const steps = Math.max(8, Math.min(1000, Math.ceil(Math.abs(t1 - t0) * r / 3)));
  budget.ops -= steps * 4;
  for (let k = 0; k <= steps; k += 1) {
    const t = t0 + (t1 - t0) * (k / steps);
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return true;
}

/** Catmull（很老的谱面才有）：每段四个点，首尾外推。 */
function catmull(pts, out, budget) {
  const n = pts.length;
  budget.ops -= n * 51 * 8;
  for (let i = 0; i < n - 1; i += 1) {
    const v1 = i > 0 ? pts[i - 1] : pts[i];
    const v2 = pts[i];
    const v3 = pts[i + 1];
    const v4 = i < n - 2 ? pts[i + 2] : [v3[0] * 2 - v2[0], v3[1] * 2 - v2[1]];
    for (let k = 0; k <= 50; k += 1) {
      const t = k / 50;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([0, 1].map((j) => 0.5 * (2 * v2[j] + (-v1[j] + v3[j]) * t + (2 * v1[j] - 5 * v2[j] + 4 * v3[j] - v4[j]) * t2 + (-v1[j] + 3 * v2[j] - 3 * v3[j] + v4[j]) * t3)));
    }
  }
}

/** 滑条路径终点（走到 length 像素为止）。算不出来（没有控制点、长度不对、整张图的计算量用完）时返回最后一个控制点。 */
export function sliderEnd(head, type, points, length, budget = { ops: Infinity }) {
  // 不用 [...a] / push(...a)：一条滑条能有几万个点，展开会把调用栈撑爆（复核时全库有一张图这样）
  const pts = [head];
  if (Array.isArray(points)) for (const p of points) pts.push(p);
  for (let i = pts.length - 1; i >= 0; i -= 1) if (!(Array.isArray(pts[i]) && Number.isFinite(pts[i][0]) && Number.isFinite(pts[i][1]))) pts.splice(i, 1);
  const last = pts[pts.length - 1];
  if (pts.length < 2 || !(length > 0) || !(budget.ops > 0)) return [last[0], last[1]];
  budget.ops -= pts.length;
  let poly = [];
  const kind = String(type || 'B').toUpperCase();
  if (kind === 'L') poly = pts;
  else if (kind === 'C') catmull(pts, poly, budget);
  else if (!(kind === 'P' && pts.length === 3 && arc(pts[0], pts[1], pts[2], poly, budget))) {
    // 贝塞尔：连续两个相同的点（红点）处分段
    let seg = [pts[0]];
    for (let i = 1; i < pts.length; i += 1) {
      if (pts[i][0] === pts[i - 1][0] && pts[i][1] === pts[i - 1][1]) { if (seg.length) bezier(seg, poly, budget); seg = [pts[i]]; } else seg.push(pts[i]);
    }
    bezier(seg, poly, budget);
  }
  // 沿路径走 length 像素
  let walked = 0;
  for (let i = 1; i < poly.length; i += 1) {
    const s = dist(poly[i - 1], poly[i]);
    if (s > 0 && walked + s >= length) return lerp(poly[i - 1], poly[i], (length - walked) / s);
    walked += s;
  }
  // 路径不够长：顺着最后一段的方向直着延长。最后两个点重合时 osu! 不延长（lazer 照 stable 的做法），停在终点。
  const end = poly[poly.length - 1];
  if (poly.length < 2 || dist(poly[poly.length - 2], end) === 0) return [end[0], end[1]];
  const i = poly.length - 1;
  const s = dist(poly[i - 1], poly[i]);
  const extra = length - walked;
  return [end[0] + (poly[i][0] - poly[i - 1][0]) / s * extra, end[1] + (poly[i][1] - poly[i - 1][1]) / s * extra];
}
