/**
 * 脚下的 pp 地台环（2026-11-21 用户从五版设计里挑了 C「脚下地台环」）：
 * 她站在一个椭圆环上，粉色那截是这首歌打到哪了（从左边起，先走前面再绕到后面）；环正前方一行 pp 和 100 / 50 / miss。
 * 只在打图时显示（淡入淡出）。桌面角色（renderer/pet-entry.ts）和 OBS 里的角色（renderer/counter-entry.ts）共用。
 *
 * 环分前后两半：后半圈放在角色身后（z-index -1），前半圈和字放在角色前面，看起来像站在环上。
 * 位置跟着皮肤的 hitbox（脚底 = hitbox 底边），渲染器 layout 之后调 layout()。
 * 窗口底下要留出 footroom 像素（window.__tomopetFootroom，三种渲染器 layout 时都会扣掉），字就写在这一截里。
 */

export interface HudData {
  on: boolean;
  pp: number;
  fc?: number; // 这一把要是全连能拿多少 pp（按现在的准确率算整张图；读不到是 0，不显示）
  n100: number;
  n50: number;
  miss: number;
  progress: number | null; // 0–1；读不到是 null（只画灰环）
}

// 灰环和描边用不透明的颜色：前后两半在接缝处互相盖一点点，半透明的话重叠那一截会变深（2026-11-21 用户截图：接缝处有一圈怪东西）
// 2026-11-22 改过的效果图（用户挑的三版都用这个环）：灰黑的环、没打的柱子用中灰（白色在浅色壁纸上看不见）、进度头是一个 osu! 圆圈
const COLORS = { track: '#19191b', trackEdge: '#4a4a4f', head: '#ededed', fill: '#ff66aa', pp: '#c58cff', fc: '#ffb3d1', barDone: 'rgba(255, 102, 170, .9)', barTodo: 'rgba(170, 170, 178, .9)', barFrontDone: 'rgba(255, 102, 170, .5)', barFrontTodo: 'rgba(150, 150, 158, .5)', wallDone: 'rgba(255, 102, 170, .42)', wallTodo: 'rgba(170, 170, 178, .3)', wallFrontDone: 'rgba(255, 102, 170, .26)', wallFrontTodo: 'rgba(150, 150, 158, .18)', wallTopDone: '#ff8cc0', wallTopTodo: 'rgba(190, 190, 198, .9)', n100: '#7ec850', n50: '#b47cff', miss: '#ff5a6e' };
/** 前后两半在接缝处（最左、最右）互相多盖多少弧度：平头接上，看不出缝。 */
const SEAM = 0.04;
const SVG_NS = 'http://www.w3.org/2000/svg';
import { labelLayoutOf as layoutOf, labelMetrics, ringFootroom, ringSize } from '../core/pp-ring-size.js';
export { ringFootroom };

/** 窗口底下粗留多少像素给环和字（按窗口大小；OBS 那份先按它算缩放，再按 core/pp-ring-size.js 算环实际要多少）。 */
export function footroomFor(height: number): number {
  return Math.round(Math.max(40, Math.min(90, height * 0.09)));
}

function svgLayer(z: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  Object.assign(svg.style, { position: 'fixed', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: String(z), opacity: '0', transition: 'opacity .25s ease', overflow: 'visible' });
  return svg;
}

/** 一根竖着的柱子（圆头）。 */
function bar(x: number, y0: number, y1: number, stroke: string, width: number): SVGLineElement {
  const l = document.createElementNS(SVG_NS, 'line');
  l.setAttribute('x1', x.toFixed(1));
  l.setAttribute('x2', x.toFixed(1));
  l.setAttribute('y1', y0.toFixed(1));
  l.setAttribute('y2', y1.toFixed(1));
  l.setAttribute('stroke', stroke);
  l.setAttribute('stroke-width', width.toFixed(1));
  l.setAttribute('stroke-linecap', 'round');
  return l;
}

/** 墙面（难度墙那种样子用）：填色，不描边。 */
function polygon(pts: [number, number][], fill: string): SVGPolygonElement {
  const p = document.createElementNS(SVG_NS, 'polygon');
  p.setAttribute('points', pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
  p.setAttribute('fill', fill);
  return p;
}

/** 墙顶那条亮线。 */
function polyline(pts: [number, number][], stroke: string, width: number): SVGPolylineElement {
  const l = document.createElementNS(SVG_NS, 'polyline');
  l.setAttribute('points', pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
  l.setAttribute('fill', 'none');
  l.setAttribute('stroke', stroke);
  l.setAttribute('stroke-width', width.toFixed(1));
  l.setAttribute('stroke-linejoin', 'round');
  l.setAttribute('stroke-linecap', 'round');
  return l;
}

/** 实心圆点：粉色露在外面的两头（起点、走到的那一头）用它补成圆头。 */
function dot(x: number, y: number, r: number, fill: string): SVGCircleElement {
  const c = document.createElementNS(SVG_NS, 'circle');
  c.setAttribute('cx', x.toFixed(1));
  c.setAttribute('cy', y.toFixed(1));
  c.setAttribute('r', String(r));
  c.setAttribute('fill', fill);
  return c;
}

function path(d: string, stroke: string, width: number): SVGPathElement {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', stroke);
  p.setAttribute('stroke-width', String(width));
  // 平头：圆头会伸到另一半那边，把描边画在粉色上面，接缝处冒出一圈浅色的弧（用户截图）
  p.setAttribute('stroke-linecap', 'butt');
  return p;
}

/** 椭圆上从角度 a 到 b（弧度，SVG 坐标 y 向下：0 右、π/2 前面最低点、π 左）的折线。 */
export function arcPath(cx: number, cy: number, rx: number, ry: number, a: number, b: number): string {
  if (Math.abs(b - a) < 1e-4) return '';
  const steps = Math.max(2, Math.ceil(Math.abs(b - a) / 0.08));
  let d = '';
  for (let i = 0; i <= steps; i += 1) {
    const t = a + ((b - a) * i) / steps;
    d += `${i ? 'L' : 'M'}${(cx + rx * Math.cos(t)).toFixed(1)} ${(cy + ry * Math.sin(t)).toFixed(1)}`;
  }
  return d;
}

/**
 * 难度柱（2026-11-21 用户：「难度曲线可以显示在圆环上」「我想要立在圈上的那种感觉」）：一圈竖着站在环上的柱子，
 * 环上每个位置对应歌的某一刻（和进度同一套走法：第 k 根在进度 (k + 0.5) / N，角度 π - 2π·进度），那一刻越难柱子越高。
 * curve 是 0–1 的数（core/strain-curve.js），count 根柱子（每根取它那一小段里最难的）；height 是最高多高（像素，往上）。
 * 返回 [{ x, y0（环上）, y1（柱顶）, front（在前半圈）, done（已经打过）}]。
 */
export function curveBars(curve: number[], { cx, cy, rx, ry, height, progress, count = 60 }: { cx: number; cy: number; rx: number; ry: number; height: number; progress: number | null; count?: number }) {
  const n = curve.length;
  const q = progress === null ? -1 : Math.max(0, Math.min(1, Number(progress) || 0));
  const bars: { x: number; y0: number; y1: number; front: boolean; done: boolean }[] = [];
  for (let k = 0; k < count; k += 1) {
    const f = (k + 0.5) / count;
    let v = 0;
    for (let i = Math.floor((k / count) * n); i < Math.max(Math.floor((k / count) * n) + 1, Math.floor(((k + 1) / count) * n)); i += 1) v = Math.max(v, Number(curve[Math.min(n - 1, i)]) || 0);
    const a = Math.PI - 2 * Math.PI * f;
    const x = cx + rx * Math.cos(a);
    const y0 = cy + ry * Math.sin(a);
    bars.push({ x, y0, y1: y0 - Math.max(0, Math.min(1, v)) * height, front: f < 0.5, done: f <= q });
  }
  return bars;
}

/** 难度曲线画成什么样：一圈柱子（默认），或者连成一圈墙（2026-11-21 用户：墙那版「挺好看的，可以留着当个选项」）。 */
export type CurveStyle = 'bars' | 'wall';
export const curveStyleOf = (v: unknown): CurveStyle => (v === 'wall' || v === '墙' ? 'wall' : 'bars');

/**
 * 难度墙（另一种样子）：曲线连成一圈墙竖在环上，墙顶一条亮线，那一刻越难墙越高；走法和柱子一样。
 * 返回分好组的墙面多边形和顶边折线：front / back（前半圈 / 后半圈）× done / todo（打过的 / 还没打的），每组若干段。
 */
export function curveWalls(curve: number[], { cx, cy, rx, ry, height, progress }: { cx: number; cy: number; rx: number; ry: number; height: number; progress: number | null }) {
  const n = curve.length;
  const q = Math.max(0, Math.min(1, Number(progress) || 0));
  type Group = { wall: [number, number][]; top: [number, number][] }[];
  const groups: Record<'frontDone' | 'frontTodo' | 'backDone' | 'backTodo', Group> = { frontDone: [], frontTodo: [], backDone: [], backTodo: [] };
  const base = (f: number): [number, number] => {
    const a = Math.PI - 2 * Math.PI * f;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  };
  const valueAt = (f: number) => {
    const x = f * n - 0.5;
    const i = Math.max(0, Math.min(n - 1, Math.floor(x)));
    const j = Math.max(0, Math.min(n - 1, i + 1));
    const t = Math.max(0, Math.min(1, x - i));
    return Math.max(0, Math.min(1, (Number(curve[i]) || 0) * (1 - t) + (Number(curve[j]) || 0) * t));
  };
  // 按进度切成一截一截：在 0.5（前后分界）和当前进度处断开；每截多带上分界点，相邻两截接得上
  const cuts = [0, ...[0.5, q].filter((c) => c > 0 && c < 1).sort((a, b) => a - b), 1];
  for (let c = 0; c < cuts.length - 1; c += 1) {
    const f0 = cuts[c];
    const f1 = cuts[c + 1];
    if (f1 - f0 < 1e-6) continue;
    const mid = (f0 + f1) / 2;
    const key = `${mid < 0.5 ? 'front' : 'back'}${progress !== null && mid < q ? 'Done' : 'Todo'}` as keyof typeof groups;
    const fs = [f0];
    for (let k = 0; k < n; k += 1) { const f = (k + 0.5) / n; if (f > f0 && f < f1) fs.push(f); }
    fs.push(f1);
    const bottom = fs.map(base);
    // 墙顶：从环上往正上方竖起来（屏幕上的上）
    const top = fs.map((f, i): [number, number] => [bottom[i][0], bottom[i][1] - valueAt(f) * height]);
    groups[key].push({ wall: [...bottom, ...[...top].reverse()], top });
  }
  return groups;
}

/**
 * pp 那块字的样子（core/pp-ring-size.js labelLayoutOf）：card 黑底卡片（默认）、paper 浅色成绩条、type 只有字
 * （2026-11-22 用户从效果图里挑的三版：「这仨」），还有原来的 line 环下面一行、arc 沿着环弯过去。
 */
export type LabelLayout = 'card' | 'paper' | 'type' | 'line' | 'arc';
export const labelLayoutOf = (v: unknown): LabelLayout => layoutOf(v) as LabelLayout;
/** 「只有字」那种没有底，字的颜色要和壁纸反着来：浅色字（默认，带一点灰色阴影）或深色字。 */
export type LabelInk = 'light' | 'dark';
export const labelInkOf = (v: unknown): LabelInk => (v === 'dark' || v === '深色' ? 'dark' : 'light');

// 三种新样子的样式（照效果图做的，尺寸走 CSS 变量，按 labelMetrics 缩放）。
// 不发光、不渐变，字重 400 / 500，等宽数字；粉色只用在环上。
const LABEL_CSS = `
.tpr { position: fixed; left: 0; top: 0; z-index: 6; pointer-events: none; white-space: nowrap; opacity: 0; transition: opacity .25s ease; transform: translateX(-50%); box-sizing: border-box; }
.tpr-line { font: 700 15px/1 "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif; color: #fff; -webkit-text-stroke: 4px rgba(10, 8, 20, .85); paint-order: stroke fill; text-shadow: 0 1px 4px rgba(0, 0, 0, .5); }
.tpr-n { font-family: Bahnschrift, "Segoe UI Variable Text", "Microsoft YaHei UI", sans-serif; font-variant-numeric: tabular-nums; color: var(--t1); }
.tpr-n .k { font-size: var(--lab); line-height: 1.25; color: var(--t3); }
.tpr-n .v { font-size: var(--val); line-height: 1.2; color: var(--t1); }
.tpr-n .v[data-n="0"] { color: var(--t3); }
.tpr-n .v[data-k="miss"]:not([data-n="0"]) { color: var(--miss); }
.tpr-card, .tpr-paper { display: flex; align-items: center; gap: var(--split); padding: 0 var(--padh); height: var(--h); border-radius: var(--r); }
.tpr-card .pp, .tpr-paper .pp { display: flex; align-items: baseline; gap: 4px; }
.tpr-card .pp b, .tpr-paper .pp b { font-weight: 500; font-size: var(--big); }
.tpr-card .pp span, .tpr-paper .pp span { font-size: var(--lab); color: var(--t3); }
.tpr-card .rule, .tpr-paper .rule { width: 1px; align-self: stretch; margin: var(--padv) 0; background: var(--hair); }
.tpr-card { --t1: #ededed; --t2: #a1a1a6; --t3: #85858b; --miss: #e5484d; --hair: rgba(237, 237, 237, .08); background: rgba(20, 20, 21, .9); box-shadow: inset 0 0 0 1px var(--hair), 0 8px 24px rgba(0, 0, 0, .18); }
.tpr-card .pp b { line-height: 1.125; }
.tpr-card .side { display: grid; grid-template-columns: auto auto auto; column-gap: var(--colgap); row-gap: var(--rowgap); align-items: baseline; }
.tpr-card .fc { grid-column: 1 / -1; display: flex; gap: 6px; align-items: baseline; }
.tpr-card .fc .v { color: var(--t2); }
.tpr-card .hit { display: flex; gap: 4px; align-items: baseline; }
.tpr-paper { --t1: #1f1b16; --t2: #5e554a; --t3: #7b7266; --miss: #dc2626; --hair: rgba(31, 27, 22, .1); background: #fdfbf7; box-shadow: inset 0 0 0 1px var(--hair), 0 1px 2px rgba(0, 0, 0, .08), 0 2px 6px rgba(0, 0, 0, .06); }
.tpr-paper .score { display: grid; }
.tpr-paper .pp b { line-height: .9; }
.tpr-paper .fc { font-size: var(--lab); line-height: 1.35; color: var(--t3); }
.tpr-paper .fc .v { font-size: var(--lab); color: var(--t2); }
.tpr-paper .hits { display: grid; grid-template-columns: repeat(3, auto); column-gap: var(--colgap); row-gap: var(--rowgap); text-align: right; }
.tpr-paper .hits .k { line-height: 1.33; }
.tpr-paper .hits .v { line-height: 1.25; }
.tpr-type { display: flex; justify-content: space-between; align-items: flex-end; gap: var(--mingap); min-width: var(--span); height: var(--h); }
.tpr-type.ink-dark { --t1: #171717; --t2: #3f3f42; --t3: #66666b; --miss: #dc2626; }
.tpr-type.ink-light { --t1: #f2f2f3; --t2: #dcdce0; --t3: #c2c2c7; --miss: #ff7a80; text-shadow: 0 1px 2px rgba(15, 15, 17, .45); }
.tpr-type .grp { display: flex; align-items: flex-end; gap: var(--ggap); }
.tpr-type .big { font-size: var(--big); line-height: .77; font-weight: 500; font-variation-settings: "wdth" 87.5; letter-spacing: -0.01em; }
.tpr-type .stack, .tpr-type .col { display: grid; grid-template-rows: var(--top) var(--bottom); align-items: end; }
.tpr-type .col { width: var(--col); justify-items: end; }
.tpr-type .k, .tpr-type .v { font-weight: 500; }
.tpr-type .fc .k { margin-right: 4px; }
.tpr-type .fc .v { color: var(--t2); }
`;
const LABEL_HTML: Record<Exclude<LabelLayout, 'arc'>, string> = {
  line: '', // 原来那行字（在 createPpRing 里拼，用到 COLORS）
  card: '<div class="pp"><b data-k="pp"></b><span>pp</span></div><div class="rule"></div><div class="side">'
    + '<div class="fc" data-k="fcwrap"><span class="k">if FC</span><span class="v" data-k="fc"></span></div>'
    + '<div class="hit"><span class="k">100</span><span class="v" data-k="n100"></span></div><div class="hit"><span class="k">50</span><span class="v" data-k="n50"></span></div><div class="hit"><span class="k">miss</span><span class="v" data-k="miss"></span></div></div>',
  paper: '<div class="score"><div class="pp"><b data-k="pp"></b><span>pp</span></div><div class="fc" data-k="fcwrap">if FC <span class="v" data-k="fc"></span></div></div><div class="rule"></div>'
    + '<div class="hits"><span class="k">100</span><span class="k">50</span><span class="k">miss</span><span class="v" data-k="n100"></span><span class="v" data-k="n50"></span><span class="v" data-k="miss"></span></div>',
  type: '<div class="grp"><div class="big" data-k="pp"></div><div class="stack"><span class="k">pp</span><span class="fc" data-k="fcwrap"><span class="k">if FC</span><span class="v" data-k="fc"></span></span></div></div>'
    + '<div class="grp"><div class="col"><span class="k">100</span><span class="v" data-k="n100"></span></div><div class="col"><span class="k">50</span><span class="v" data-k="n50"></span></div><div class="col"><span class="k">miss</span><span class="v" data-k="miss"></span></div></div>',
};

/**
 * 沿着环弯过去那种摆法的字的基线：比环大一圈的椭圆（横竖都往外放 d，和环平行），从左边经过前面最低点到右边。
 * d = 环的半宽 + 间隔 + 一个字高：字的顶在环下沿下面一点，字底不超过 maxBottom（窗口底；最低点 = cy + ry + d + 字的下伸）。
 * 返回 { d: 路径, baseline: 前面最低点的基线 y }。
 */
export function labelArc({ cx, cy, rx, ry }: { cx: number; cy: number; rx: number; ry: number }, stroke: number, font: number, maxBottom = Infinity) {
  const off = Math.max(0, Math.min(stroke / 2 + 4 + font * 1.05, maxBottom - cy - ry - font * 0.25));
  return { d: arcPath(cx, cy, rx + off, ry + off, Math.PI * 0.98, Math.PI * 0.02), baseline: cy + ry + off };
}

/**
 * 沿着环那种摆法两组字放哪：路径长 len，左边那组宽 wl、右边那组宽 wr（按字号 font 量的）。
 * 左边那组的尾巴在正中往左 gap / 2，右边那组的开头在正中往右 gap / 2；中间空的 gap 最多路径的 16%（脚下那截），
 * 不够就先缩空隙（最少 0.6 个字宽），还不够就把字按比例缩小。两头各留 pad，不超出路径（超出的字 SVG 不画）。
 * 返回 { leftEnd, rightStart, scale }（路径上的长度、字号倍数）。
 */
export function fitArcLabel(len: number, wl: number, wr: number, font: number) {
  const pad = font * 0.3;
  const need = Math.max(wl, wr, 1);
  const gap = Math.max(font * 0.6, Math.min(len * 0.16, len - 2 * pad - 2 * need));
  const avail = Math.max(1, len / 2 - gap / 2 - pad);
  const scale = Math.min(1, avail / need);
  return { leftEnd: len / 2 - gap / 2, rightStart: len / 2 + gap / 2, scale };
}

/**
 * 进度 p（0–1）→ 粉色那截分成前后两段的角度：从左边（π）开始往前面走（角度变小，经过 π/2 前面最低点）到右边（0），
 * 再绕到后面（-π/2 后面最高点）回到左边（-π）。返回 { front: [a, b] | null, back: [a, b] | null }。
 */
export function progressArcs(p: number): { front: [number, number] | null; back: [number, number] | null } {
  const q = Math.max(0, Math.min(1, Number(p) || 0));
  const end = Math.PI - 2 * Math.PI * q;
  if (q <= 0) return { front: null, back: null };
  if (end >= 0) return { front: [Math.PI, end], back: null };
  return { front: [Math.PI, 0], back: [0, end] };
}

export function createPpRing(getRig: () => any, getManifest: () => any) {
  const back = svgLayer(-1);
  const front = svgLayer(6);
  if (!document.getElementById('tomopet-ring-css')) {
    const css = document.createElement('style');
    css.id = 'tomopet-ring-css';
    css.textContent = LABEL_CSS;
    document.head.appendChild(css);
  }
  const label = document.createElement('div');
  label.className = 'tpr tpr-line';
  // 沿着环弯过去那种摆法（labelArc）：SVG 的 textPath，分两边顺着环的前沿走——pp（和 if FC）在左前方，100 / 50 / miss 在右前方，
  // 正前方（脚下）空出来。内容和上面那行一样（同样的 data-k，update 一起改）
  const arcLayer = svgLayer(6);
  const STROKE = 'rgba(10, 8, 20, .85)';
  // 左边那组的尾巴、右边那组的开头对着正前方（中间空一截），往两边长；位置和字号在 draw 里按量出来的宽度定（fitArcLabel）
  const arcTextTag = (anchor: string, body: string) => '<text font-weight="700" font-family="&quot;Microsoft YaHei UI&quot;, &quot;Microsoft YaHei&quot;, &quot;PingFang SC&quot;, sans-serif" fill="#fff" stroke="' + STROKE + '" stroke-width="4" stroke-linejoin="round" paint-order="stroke fill" text-anchor="' + anchor + '" style="white-space:pre;filter:drop-shadow(0 1px 3px rgba(0, 0, 0, .5))">'
    + '<textPath href="#tomopet-ring-label-arc">' + body + '</textPath></text>';
  arcLayer.innerHTML = '<defs><path id="tomopet-ring-label-arc"/></defs>'
    + arcTextTag('end', '<tspan data-k="pp" font-size="1.25em"></tspan><tspan fill="' + COLORS.pp + '" font-size=".85em">pp</tspan>'
      + '<tspan data-k="fcwrap" fill="' + COLORS.fc + '" font-size=".78em" stroke-width="3"> <tspan data-k="fc"></tspan> if FC</tspan>')
    + arcTextTag('start', '<tspan data-k="n100" fill="' + COLORS.n100 + '"></tspan><tspan>  </tspan><tspan data-k="n50" fill="' + COLORS.n50 + '"></tspan><tspan>  </tspan><tspan data-k="miss" fill="' + COLORS.miss + '"></tspan>');
  const arcTexts = [...arcLayer.querySelectorAll('text')] as SVGTextElement[];
  const arcGuide = arcLayer.querySelector('path') as SVGPathElement;
  const LINE_HTML = '<span data-k="pp" style="font-size:1.25em"></span><span style="color:' + COLORS.pp + ';font-size:.85em">pp</span>'
    // 全连能拿多少（2026-11-21 用户：环上加全连 pp）：小一号，打图时一直显示（这把的目标）。
    // 写成「572 if FC」（2026-11-21 用户：不要「全连 xxx」，要「xxx if fc」）
    + '<span data-k="fcwrap" style="color:' + COLORS.fc + ';font-size:.78em;margin-left:.45em;-webkit-text-stroke-width:3px"><span data-k="fc"></span> if FC</span>'
    + '<span style="display:inline-block;width:.7em"></span><span data-k="n100" style="color:' + COLORS.n100 + '"></span>'
    + '<span style="display:inline-block;width:.45em"></span><span data-k="n50" style="color:' + COLORS.n50 + '"></span>'
    + '<span style="display:inline-block;width:.45em"></span><span data-k="miss" style="color:' + COLORS.miss + '"></span>';
  document.body.appendChild(back);
  document.body.appendChild(front);
  document.body.appendChild(label);
  document.body.appendChild(arcLayer);
  // 两种摆法的同一格一起改（切摆法时不用重填）
  const cells = (k: string) => [...label.querySelectorAll(`[data-k="${k}"]`), ...arcLayer.querySelectorAll(`[data-k="${k}"]`)] as (HTMLElement | SVGElement)[];
  const setText = (k: string, v: string) => { for (const c of cells(k)) c.textContent = v; };
  let layout: LabelLayout = 'card';
  let ink: LabelInk = 'light';
  /** 换样子：换掉字那块的结构（arc 用 SVG 那层，字那块藏起来），再把数填回去。 */
  function applyMarkup() {
    if (layout === 'arc') return;
    label.className = layout === 'line' ? 'tpr tpr-line' : `tpr tpr-n tpr-${layout}${layout === 'type' ? ` ink-${ink}` : ''}`;
    label.innerHTML = layout === 'line' ? LINE_HTML : LABEL_HTML[layout];
    label.removeAttribute('style');
  }
  applyMarkup();
  // 「572 if FC」显示不显示（2026-11-21 用户：「if fc 可以不显示，做个开关」）
  let showFc = true;

  let data: HudData = { on: false, pp: 0, n100: 0, n50: 0, miss: 0, progress: null };
  // 难度带：这张图的难度曲线（0–1，按进度排；core/strain-curve.js），没有 / 关掉时是 null
  let curve: number[] | null = null;
  let style: CurveStyle = 'bars';
  let geo: { cx: number; cy: number; rx: number; ry: number } | null = null;

  /** 脚在窗口里的位置和环的大小。 */
  function measure() {
    const rig = getRig();
    const m = getManifest();
    if (!rig || !m?.canvas) return null;
    const hb = m.hitbox || { x: 0, y: 0, w: m.canvas.w, h: m.canvas.h };
    const ox = rig.root ? rig.root.x : rig.stageX || 0;
    const oy = rig.root ? rig.root.y : rig.stageY || 0;
    const s = rig.scale || 1;
    // 皮肤框连头发、尾巴都算进去（Claude 的长发很宽）：环按它的四成多，最宽到窗口的四成，不然左右会被切掉（离屏截图发现）。
    // 大小和窗口底下留的地方是同一套算法（core/pp-ring-size.js）
    const { rx, ry } = ringSize(hb.w, s, window.innerWidth * 0.4);
    // 环心在脚底稍微往上一点：前半圈压在脚前面、后半圈藏在脚后面
    return { cx: ox + (hb.x + hb.w / 2) * s, cy: oy + (hb.y + hb.h) * s - ry * 0.35, rx, ry };
  }

  function draw() {
    geo = measure();
    back.replaceChildren();
    front.replaceChildren();
    if (!geo) return;
    const { cx, cy, rx, ry } = geo;
    const { stroke: w, font: fontPx, wall } = ringSize(rx / 0.42, 1);
    // 难度柱画在最底下（环和粉色进度压在柱脚上）：打过的粉、还没打的白；
    // 后半圈的柱子在角色身后（后面那层），前半圈的在角色前面，更透明，腿和脚透得出来
    if (curve && curve.length >= 8 && style === 'wall') {
      // 墙：后半圈的墙在角色身后，前半圈的在前面、更透明；顶边一条亮线
      const g = curveWalls(curve, { cx, cy, rx, ry, height: wall, progress: data.progress });
      const put = (layer: SVGSVGElement, list: { wall: [number, number][]; top: [number, number][] }[], fill: string, line: string) => {
        for (const part of list) { layer.append(polygon(part.wall, fill)); layer.append(polyline(part.top, line, Math.max(1.5, w * 0.35))); }
      };
      put(back, g.backTodo, COLORS.wallTodo, COLORS.wallTopTodo);
      put(back, g.backDone, COLORS.wallDone, COLORS.wallTopDone);
      put(front, g.frontTodo, COLORS.wallFrontTodo, COLORS.wallTopTodo);
      put(front, g.frontDone, COLORS.wallFrontDone, COLORS.wallTopDone);
    } else if (curve && curve.length >= 8) {
      const barW = Math.max(2, rx * 0.032);
      for (const b of curveBars(curve, { cx, cy, rx, ry, height: wall, progress: data.progress })) {
        if (b.y0 - b.y1 < 0.5) continue;
        const color = b.front ? (b.done ? COLORS.barFrontDone : COLORS.barFrontTodo) : (b.done ? COLORS.barDone : COLORS.barTodo);
        (b.front ? front : back).append(bar(b.x, b.y0, b.y1, color, barW));
      }
    }
    // 画了难度曲线就不画环（2026-11-22 用户：「底下那个圈有点没必要了，可以删了，有这个难度曲线进度条就够了」）：
    // 柱子 / 墙本身打过的是粉色，就是进度条；只留走到那一头的 osu! 圆圈标「现在」。没有曲线（关掉了、tosu 还没给）时照旧画环
    const ringOn = !(curve && curve.length >= 8);
    // 灰环：后半圈（-π→0，上半）、前半圈（0→π，下半）；描一圈细亮边，暗色壁纸上也看得见。
    // 前半圈在两头各往后多画 SEAM，平头盖住接缝
    if (ringOn) back.append(path(arcPath(cx, cy, rx, ry, -Math.PI, 0), COLORS.trackEdge, w + 2), path(arcPath(cx, cy, rx, ry, -Math.PI, 0), COLORS.track, w));
    // 三层错开截断（描边 1 份、灰环 2 份、粉色 3 份）：每一层的截断边都落在下一层的中间，不会两条截断边叠在同一处叠出细线
    if (ringOn) front.append(path(arcPath(cx, cy, rx, ry, -SEAM, Math.PI + SEAM), COLORS.trackEdge, w + 2), path(arcPath(cx, cy, rx, ry, -2 * SEAM, Math.PI + 2 * SEAM), COLORS.track, w));
    if (data.progress !== null) {
      const arcs = ringOn ? progressArcs(data.progress) : { front: null, back: null };
      if (arcs.back) back.append(path(arcPath(cx, cy, rx, ry, arcs.back[0], arcs.back[1]), COLORS.fill, w));
      if (arcs.front) {
        // 粉色已经绕到后面：前面这截往后多画两倍 SEAM，把前半圈灰环伸过去的那一点连同它的截断边整个盖住
        // （只多画一倍时两条截断边叠在同一个位置，抗锯齿的像素叠出一条细黑线）；快打完时左边接缝同理
        const end = arcs.back ? -3 * SEAM : arcs.front[1];
        const start = arcs.back && arcs.back[1] <= -Math.PI + 3 * SEAM ? Math.PI + 3 * SEAM : arcs.front[0];
        front.append(path(arcPath(cx, cy, rx, ry, start, end), COLORS.fill, w));
      }
      // 露在外面的两头补成圆头（2026-11-21 用户：平头看着好奇怪）；接缝那里看不见，继续平头。
      // 起点在最左边（前半圈那层）；走到的那一头在前半圈就放前面那层，绕到后面了就放后面那层；打满一圈两头碰上，不用补
      const q = Math.max(0, Math.min(1, Number(data.progress) || 0));
      if (q > 0) {
        if (ringOn) front.append(dot(cx - rx, cy, w / 2, COLORS.fill));
        if (q < 0.995) {
          // 走到的那一头是一个 osu! 圆圈（粉色实心、白边，外面一圈细的深色线，什么壁纸上都看得见）
          const a = Math.PI - 2 * Math.PI * q;
          const layer = a >= 0 ? front : back;
          const hx = cx + rx * Math.cos(a);
          const hy = cy + ry * Math.sin(a);
          const r = Math.max(w / 2 + 1, w * 0.9);
          const c = dot(hx, hy, r, COLORS.fill);
          c.setAttribute('stroke', COLORS.head);
          c.setAttribute('stroke-width', Math.max(1.5, w * 0.25).toFixed(1));
          layer.append(c);
          const edge = dot(hx, hy, r + Math.max(1.5, w * 0.15), 'none');
          edge.setAttribute('stroke', 'rgba(20, 20, 21, .6)');
          edge.setAttribute('stroke-width', '1');
          layer.append(edge);
        }
      }
    }
    if (layout === 'line' || layout === 'arc') {
      label.style.fontSize = `${fontPx}px`;
      label.style.left = `${cx}px`;
      label.style.top = `${Math.min(window.innerHeight - fontPx * 1.35, cy + ry + Math.max(4, w))}px`;
    } else {
      // 三种新样子：尺寸按 labelMetrics（和窗口底下留的地方同一套），放在环下沿下面 gap 处，左右不出窗口
      const m: any = labelMetrics(rx, layout);
      const vars: Record<string, number> = { big: m.big, lab: m.lab, val: m.val, h: m.height, padv: m.padV ?? 0, padh: m.padH ?? 0, split: m.split ?? 0, r: m.radius ?? 0, colgap: m.colGap ?? 0, rowgap: m.rowGap ?? 0, top: m.top ?? 0, bottom: m.bottom ?? 0, col: m.col ?? 0, ggap: m.groupGap ?? 0, mingap: m.minGap ?? 0 };
      // 只有字：两组分在环的左右两端下面（放不下就往外撑，最宽到窗口宽）
      vars.span = Math.min(window.innerWidth - 8, rx * 2 + w);
      for (const [k, v] of Object.entries(vars)) label.style.setProperty(`--${k}`, `${v}px`);
      const top = Math.min(window.innerHeight - m.height - 2, cy + ry + w / 2 + m.gap);
      label.style.top = `${Math.round(top)}px`;
      // 比窗口还宽（很窄的 OBS 浏览器源）：整块等比缩小、居中，不出窗口（复核发现）
      const fullW = label.offsetWidth;
      const room = window.innerWidth - 8;
      if (fullW > room && fullW > 0) {
        label.style.transformOrigin = 'top center';
        label.style.transform = `translateX(-50%) scale(${(room / fullW).toFixed(3)})`;
        label.style.left = `${Math.round(window.innerWidth / 2)}px`;
      } else {
        label.style.transform = '';
        const half = fullW / 2;
        label.style.left = `${Math.round(Math.max(half + 4, Math.min(window.innerWidth - half - 4, cx)))}px`;
      }
    }
    const arc = labelArc({ cx, cy, rx, ry }, w, fontPx, window.innerHeight);
    arcGuide.setAttribute('d', arc.d);
    // 先按原字号量两组多宽，再定中间空多少、要不要缩字（复核发现：角色调小、或者 4 位数 pp 加 if FC 时，
    // 两组固定放在 30% / 72% 会叠在一起，左边那组还会超出路径开头、第一个字被吃掉）
    if (layout === 'arc') {
      for (const t of arcTexts) t.setAttribute('font-size', String(fontPx));
      const fit = fitArcLabel(arcGuide.getTotalLength(), arcTexts[0].getComputedTextLength(), arcTexts[1].getComputedTextLength(), fontPx);
      for (const t of arcTexts) t.setAttribute('font-size', (fontPx * fit.scale).toFixed(2));
      arcTexts[0].querySelector('textPath')!.setAttribute('startOffset', fit.leftEnd.toFixed(1));
      arcTexts[1].querySelector('textPath')!.setAttribute('startOffset', fit.rightStart.toFixed(1));
    }
  }

  /** 两种摆法只显示一种。 */
  function showLayout() {
    label.style.display = layout === 'arc' ? 'none' : '';
    arcLayer.style.display = layout === 'arc' ? '' : 'none';
  }
  showLayout();

  function update(next: Partial<HudData>) {
    data = { ...data, ...next };
    const pp = Math.max(0, Math.round(Number(data.pp) || 0));
    const fc = Math.max(0, Math.round(Number(data.fc) || 0));
    setText('pp', String(pp));
    setText('fc', String(fc));
    // tosu 打图时给的「全连 pp」是按现在的准确率、整张图全连能拿多少，而现在的 pp 只算到打过的地方，所以打图中一直比现在的大：
    // 一直显示（这把的目标）；读不到（0）或者比现在的还小（数据还没跟上）就不显示（复核发现原来的「比现在多 1 才显示」等于一直显示、末尾还会闪）
    // 开关关掉（showFc）时也不显示
    for (const c of cells('fcwrap')) c.style.display = showFc && fc > 0 && fc >= pp ? '' : 'none';
    // 是 0 的数变灰、miss 不是 0 时变红（三种新样子的 CSS 按 data-n 上色）
    for (const k of ['n100', 'n50', 'miss'] as const) {
      const n = String(Math.max(0, Math.round(Number(data[k]) || 0)));
      for (const c of cells(k)) { c.textContent = n; c.setAttribute('data-n', n); }
    }
    const opacity = data.on ? '1' : '0';
    back.style.opacity = opacity;
    front.style.opacity = opacity;
    label.style.opacity = opacity;
    arcLayer.style.opacity = opacity;
    if (data.on) draw();
  }

  window.addEventListener('resize', () => { if (data.on) draw(); });
  /** 这张图的难度曲线（null = 不画难度带）。 */
  function setCurve(next: number[] | null) {
    curve = Array.isArray(next) && next.length >= 8 ? next.map((v) => Math.max(0, Math.min(1, Number(v) || 0))) : null;
    if (data.on) draw();
  }
  /** 难度曲线画成柱子还是墙。 */
  function setCurveStyle(next: unknown) {
    const s = curveStyleOf(next);
    if (s === style) return;
    style = s;
    if (data.on) draw();
  }
  /** pp 那行字的摆法：环下面一行 / 沿着环弯过去。 */
  function setLabelLayout(next: unknown) {
    const l = labelLayoutOf(next);
    if (l === layout) return;
    layout = l;
    applyMarkup();
    showLayout();
    update({});
  }
  /** 「只有字」的字色：浅色 / 深色。 */
  function setLabelInk(next: unknown) {
    const v = labelInkOf(next);
    if (v === ink) return;
    ink = v;
    applyMarkup();
    showLayout();
    update({});
  }
  /** 「572 if FC」显示不显示。 */
  function setShowFc(on: unknown) {
    const v = on !== false && on !== '不显示';
    if (v === showFc) return;
    showFc = v;
    update({});
  }
  return { update, setCurve, setCurveStyle, curveStyle: () => style, setLabelLayout, labelLayout: () => layout, setLabelInk, labelInk: () => ink, setShowFc, showFc: () => showFc, layout: () => { if (data.on) draw(); }, current: () => ({ ...data }), geometry: () => geo, curve: () => curve };
}

/** tosu websocket v2 的一帧 → HudData（OBS 那份自己连 tosu 用）。打图界面（state 2）才 on。 */
export function hudFromTosu(raw: any): HudData {
  const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const state = raw?.state || {};
  const on = num(state.number) === 2 || /^play/i.test(String(state.name || ''));
  const play = raw?.play || {};
  const time = raw?.beatmap?.time || {};
  const span = num(time.lastObject) - num(time.firstObject);
  const progress = span > 1000 ? Math.max(0, Math.min(1, (num(time.live) - num(time.firstObject)) / span)) : null;
  return { on, pp: Math.round(num(play.pp?.current)), fc: Math.round(num(play.pp?.fc)), n100: num(play.hits?.['100']), n50: num(play.hits?.['50']), miss: num(play.hits?.['0']), progress };
}
