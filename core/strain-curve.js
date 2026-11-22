/**
 * 把 tosu 的难度曲线压成按进度排的一圈点（2026-11-21 用户：「难度曲线可以显示在圆环上，加个选项」）。
 * 脚下的 pp 环（renderer/pp-ring.ts）按它画一圈竖在环上的柱子（2026-11-21 用户：「我想要立在圈上的那种感觉」）：
 * 环上每个位置对应歌的某一刻（和进度条同一套：0 是第一个物件，1 是最后一个），那一刻越难柱子越高。桌面那份在主进程算好发过去（core/watch.js），OBS 那份在页面里算（renderer/counter-entry.ts）。
 *
 * graph：tosu 的 performance.graph（series [{ name, data }]，xaxis 是每段开头的真实毫秒；负数是片头片尾的填充）。
 * first / last：第一个 / 最后一个物件的谱面毫秒（tosu 的 beatmap.time.firstObject / lastObject）；rate：倍速（谱面毫秒 = 真实毫秒 × 倍速）。
 * 每个点取它那一小段时间里 aim / speed / reading 最大的峰值，最后按整条的最大值缩到 0–1（保留两位小数）。读不出来返回 null。
 */
export const CURVE_POINTS = 120;

export function curveFromGraph(graph, { first, last, rate = 1, points = CURVE_POINTS } = {}) {
  const xs = Array.isArray(graph?.xaxis) ? graph.xaxis : null;
  const series = Array.isArray(graph?.series) ? graph.series : null;
  const f = Number(first);
  const l = Number(last);
  const r = Number(rate) > 0 ? Number(rate) : 1;
  if (!xs || !series || !(l - f > 1000) || xs.length < 4) return null;
  const pick = (name) => series.find((s) => s && s.name === name)?.data || [];
  const lines = [pick('aim'), pick('speed'), pick('reading')].filter((d) => d.length);
  if (!lines.length) return null;
  const n = Math.min(xs.length, ...lines.map((d) => d.length));
  const value = (i) => Math.max(0, ...lines.map((d) => Number(d[i]) || 0));
  // 每个点对应 [t0, t1)（谱面毫秒），找落在里面的段（段开头在 t1 之前、下一段开头在 t0 之后）取最大
  const out = new Array(points).fill(0);
  let j = 0;
  for (let k = 0; k < points; k += 1) {
    const t0 = (f + ((l - f) * k) / points) / r;
    const t1 = (f + ((l - f) * (k + 1)) / points) / r;
    while (j + 1 < n && Number(xs[j + 1]) <= t0) j += 1;
    let best = 0;
    for (let i = j; i < n && Number(xs[i]) < t1; i += 1) best = Math.max(best, value(i));
    if (best === 0 && j < n) best = value(j);
    out[k] = best;
  }
  const max = Math.max(...out);
  if (!(max > 0)) return null;
  return out.map((v) => Math.round((v / max) * 100) / 100);
}
