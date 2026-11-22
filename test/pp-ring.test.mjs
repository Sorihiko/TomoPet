/**
 * 脚下的 pp 地台环（renderer/pp-ring.ts，2026-11-21 用户挑的 C 版）：不碰页面的那几个计算——
 * 进度分成前后两段、椭圆折线、tosu 一帧 → 环要的数、窗口底下留多少。画出来的样子看离屏自检的截图（pet-hud / crosspet-obs-hud）。
 */
import assert from 'node:assert/strict';

const { progressArcs, arcPath, hudFromTosu, footroomFor } = await import('../renderer/pp-ring.ts');
const near = (a, b) => Math.abs(a - b) < 1e-9;

// 进度：从左边（π）开始，先走前面（角度变小到 0），过一半再绕到后面（0 → -π）
assert.deepEqual(progressArcs(0), { front: null, back: null });
const quarter = progressArcs(0.25);
assert.ok(near(quarter.front[0], Math.PI) && near(quarter.front[1], Math.PI / 2) && quarter.back === null, '四分之一：走到前面正中');
const half = progressArcs(0.5);
assert.ok(near(half.front[1], 0) && half.back === null, '一半：前半圈走完');
const most = progressArcs(0.75);
assert.ok(near(most.front[1], 0) && near(most.back[0], 0) && near(most.back[1], -Math.PI / 2), '四分之三：绕到后面正中');
const full = progressArcs(1);
assert.ok(near(full.back[1], -Math.PI), '打完：一整圈');
assert.deepEqual(progressArcs(-1), { front: null, back: null });
assert.ok(near(progressArcs(5).back[1], -Math.PI), '超过 1 当 1');
assert.deepEqual(progressArcs('x'), { front: null, back: null });

// 椭圆折线：起点在 a、终点在 b；同一个角度不画
const d = arcPath(100, 50, 40, 10, Math.PI, 0);
assert.ok(d.startsWith('M60.0 50.0') && d.endsWith('L140.0 50.0'), d.slice(0, 30));
assert.ok(d.includes('L100.0 60.0'), '经过前面最低点（y 向下，前面在下）');
assert.equal(arcPath(0, 0, 10, 10, 1, 1), '');

// tosu websocket/v2 的一帧 → 环要的数：打图界面才 on
const frame = { state: { number: 2, name: 'play' }, play: { pp: { current: 312.7, fc: 420.2 }, hits: { 100: 12, 50: 1, 0: 0 } }, beatmap: { time: { live: 46000, firstObject: 10000, lastObject: 110000 } } };
assert.deepEqual(hudFromTosu(frame), { on: true, pp: 313, fc: 420, n100: 12, n50: 1, miss: 0, progress: 0.36 });
assert.equal(hudFromTosu({ ...frame, state: { number: 5, name: 'selectPlay' } }).on, false, '选歌界面：收起来');
assert.equal(hudFromTosu({ ...frame, beatmap: { time: { live: 0, firstObject: 0, lastObject: 0 } } }).progress, null, '图的长度读不到：只画灰环');
assert.equal(hudFromTosu({ ...frame, beatmap: { time: { live: 999999, firstObject: 10000, lastObject: 110000 } } }).progress, 1);
assert.deepEqual(hudFromTosu(null), { on: false, pp: 0, fc: 0, n100: 0, n50: 0, miss: 0, progress: null });

// 窗口底下留多少：按窗口高度的 9%，40–90 像素
assert.equal(footroomFor(700), 63);
assert.equal(footroomFor(200), 40);
assert.equal(footroomFor(2000), 90);

// ── 环上的难度带（2026-11-21）：tosu 的难度曲线按进度压成一圈、分成前后两半 × 打过 / 没打 ─────────────
{
  const { curveFromGraph } = await import('../core/strain-curve.js');
  const { curveBars } = await import('../renderer/pp-ring.ts');
  // 第一个物件 1000ms、最后一个 41000ms；曲线每 400ms 一段（真实时间），片头两段填充 -100；20–24 秒那几段 aim 很高
  const xaxis = [0, 400];
  const aim = [-100, -100];
  const speed = [-100, -100];
  for (let x = 1000; x <= 41000; x += 400) { xaxis.push(x); aim.push(x >= 20000 && x < 24000 ? 6 : 1); speed.push(0.5); }
  const graph = { series: [{ name: 'aim', data: aim }, { name: 'speed', data: speed }, { name: 'reading', data: aim.map(() => 0) }], xaxis };
  const c = curveFromGraph(graph, { first: 1000, last: 41000, rate: 1, points: 40 });
  assert.equal(c.length, 40);
  assert.equal(Math.max(...c), 1, '按最大值缩到 0–1');
  // 20–24 秒在进度 (20000-1000)/40000 ≈ 0.475 到 0.575：第 19–23 个点最高，开头和结尾低
  assert.ok(c[20] === 1 && c[21] === 1 && c[5] < 0.3 && c[35] < 0.3, JSON.stringify(c));
  // 开 DT：谱面时间 = 真实时间 × 1.5，同一条曲线落在谱面的 30–36 秒
  const dt = curveFromGraph({ ...graph, xaxis: xaxis.map((x) => x / 1.5) }, { first: 1000, last: 41000, rate: 1.5, points: 40 });
  assert.equal(dt[20], 1, '开 DT 也对得上');
  assert.equal(curveFromGraph(null, { first: 0, last: 100000 }), null);
  assert.equal(curveFromGraph(graph, { first: 1000, last: 1500 }), null, '图太短：不画');
  assert.equal(curveFromGraph({ series: [{ name: 'aim', data: aim.map(() => -100) }], xaxis }, { first: 1000, last: 41000 }), null, '全是填充：不画');

  // 柱子（2026-11-21 用户：「我想要立在圈上的那种感觉」）：从环上竖直往上长，越难越高；前半圈 / 后半圈、打过 / 没打分开
  const geo = { cx: 200, cy: 100, rx: 100, ry: 20, height: 40 };
  const ramp = Array.from({ length: 40 }, (_, i) => i / 39);
  const bars = curveBars(ramp, { ...geo, progress: 0.3, count: 20 });
  assert.equal(bars.length, 20);
  assert.ok(bars.every((b) => b.y1 <= b.y0), '都往上长');
  assert.ok(bars.every((b) => Math.abs(Math.hypot((b.x - 200) / 100, (b.y0 - 100) / 20) - 1) < 1e-9), '柱脚都在环上');
  assert.ok(bars[19].y0 - bars[19].y1 > bars[0].y0 - bars[0].y1, '越难越高');
  assert.ok(Math.abs(bars[19].y0 - bars[19].y1 - 40) < 0.01, '最难的那根到顶');
  assert.deepEqual([bars.filter((b) => b.front).length, bars.filter((b) => b.done).length], [10, 6], '前半圈 10 根；进度 0.3 → 打过 6 根');
  assert.ok(bars[5].front && bars[5].y0 > 100 && !bars[15].front && bars[15].y0 < 100, '前半圈在环下沿（离人近）、后半圈在上沿');
  assert.equal(curveBars(ramp, { ...geo, progress: null, count: 20 }).filter((b) => b.done).length, 0, '没有进度：全算没打');
  assert.ok(curveBars(Array(40).fill(0), { ...geo, progress: 0.5 }).every((b) => b.y1 === b.y0), '难度是 0：没有柱子');

  // 墙（2026-11-21 用户：墙那版「挺好看的，可以留着当个选项」）：同一套走法，连成一圈；在前后分界和进度处断开
  const { curveWalls, curveStyleOf } = await import('../renderer/pp-ring.ts');
  const walls = curveWalls(ramp, { ...geo, progress: 0.3 });
  assert.deepEqual(['frontDone', 'frontTodo', 'backDone', 'backTodo'].map((k) => walls[k].length), [1, 1, 0, 1], '进度 0.3：前半圈打过 / 没打各一截，后半圈一截没打');
  const fd = walls.frontDone[0];
  assert.equal(fd.wall.length, fd.top.length * 2, '墙面 = 底边 + 顶边');
  assert.ok(fd.top.every(([x, y], i) => x === fd.wall[i][0] && y <= fd.wall[i][1]), '墙顶在墙脚正上方');
  assert.ok(Math.abs(fd.top.at(-1)[0] - walls.frontTodo[0].top[0][0]) < 1e-9, '打过 / 没打两截在进度处接上');
  const allTop = Object.values(walls).flat().flatMap((p) => p.top.map(([x, y], i) => p.wall[i][1] - y));
  assert.ok(Math.max(...allTop) <= 40 + 1e-9, '最高不超过墙高');
  assert.deepEqual(Object.values(curveWalls(ramp, { ...geo, progress: null })).map((g) => g.length), [0, 1, 0, 1], '没有进度：全算没打');
  // 字沿着环弯过去（2026-11-21 用户：「再做个摆法，这个保留」）：基线是和环平行、大一圈的椭圆，从左经过前面到右
  const { labelArc, labelLayoutOf } = await import('../renderer/pp-ring.ts');
  const la = labelArc({ cx: 200, cy: 100, rx: 100, ry: 20 }, 6, 16);
  const pts = [...la.d.matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(pts[0][0] < 200 && pts.at(-1)[0] > 200, '从左往右写');
  assert.ok(Math.abs(Math.max(...pts.map((p) => p[1])) - la.baseline) < 0.5, '最低点就是前面正中的基线');
  assert.ok(la.baseline - 16 > 100 + 20, '字顶在环下沿下面');
  assert.ok(pts.every(([x, y]) => y >= 100 - 1), '只在前半圈（下半）');
  const tight = labelArc({ cx: 200, cy: 100, rx: 100, ry: 20 }, 6, 16, 140);
  assert.ok(tight.baseline + 16 * 0.25 <= 140 + 1e-9, '窗口底下不够时往上收，字底不出窗口');
  // 两组字不叠、不超出路径（复核：角色调小 / 4 位数 pp 加 if FC 时会叠）
  const { fitArcLabel } = await import('../renderer/pp-ring.ts');
  const roomy = fitArcLabel(400, 80, 50, 15);
  assert.equal(roomy.scale, 1, '放得下：不缩字');
  assert.ok(Math.abs(roomy.rightStart - roomy.leftEnd - 64) < 1e-9, '中间空路径的 16%');
  const cramped = fitArcLabel(150, 120, 48, 13);
  assert.ok(cramped.scale < 1, '放不下：缩字');
  assert.ok(cramped.leftEnd - 120 * cramped.scale >= 13 * 0.3 - 1e-9, '左边那组不超出路径开头');
  assert.ok(cramped.rightStart - cramped.leftEnd >= 13 * 0.6 - 1e-9, '两组之间至少空 0.6 个字');
  assert.ok(cramped.rightStart + 48 * cramped.scale <= 150 - 13 * 0.3 + 1e-9, '右边那组不超出路径末尾');
  const mid = fitArcLabel(200, 85, 40, 15);
  assert.ok(mid.scale === 1 && mid.leftEnd - 85 >= 4.5 - 1e-9 && mid.rightStart - mid.leftEnd < 32, '先缩空隙、字号不动');
  assert.deepEqual([labelLayoutOf('arc'), labelLayoutOf('沿着环'), labelLayoutOf('line'), labelLayoutOf('环下面一行'), labelLayoutOf(null)], ['arc', 'arc', 'line', 'line', 'card']);
  assert.deepEqual(['黑底卡片', '浅色成绩条', '只有字', 'paper', 'type', 'nonsense'].map(labelLayoutOf), ['card', 'paper', 'type', 'paper', 'type', 'card'], '三种新样子（2026-11-22 用户挑的），不认识的当黑底卡片');
  assert.deepEqual([curveStyleOf('wall'), curveStyleOf('墙'), curveStyleOf('bars'), curveStyleOf('柱子'), curveStyleOf(undefined)], ['wall', 'wall', 'bars', 'bars', 'bars']);
}

// pp 那块字的三种新样子（2026-11-22 用户：「这仨」）的尺寸：和效果图一样大（环横半径 205 时），缩小时小字不小于 11 像素；脚下留的地方装得下
{
  const { labelMetrics, ringFootroom, ringSize } = await import('../core/pp-ring-size.js');
  const full = labelMetrics(205, 'card');
  assert.deepEqual([full.big, full.lab, full.val, full.padH, full.radius], [32, 12, 14, 16, 12], '环 205 宽时和效果图一样');
  for (const layout of ['card', 'paper', 'type']) {
    for (const rx of [46, 86, 140, 205, 300]) {
      const m = labelMetrics(rx, layout);
      assert.ok(m.lab >= 11 && m.val >= 11, `${layout} rx=${rx}：小字不小于 11 像素`);
      assert.ok(m.height > 0 && m.gap >= 6, `${layout} rx=${rx}`);
    }
    for (const scale of [0.2, 0.4, 1, 1.5]) {
      const { ry, stroke, rx } = ringSize(512, scale);
      const m = labelMetrics(rx, layout);
      assert.ok(ringFootroom(512, scale, Infinity, false, layout) >= Math.ceil(ry * 0.65 + stroke / 2 + m.gap + m.height), `${layout} ×${scale}：留白装得下`);
    }
  }
  assert.equal(ringFootroom(512, 0.4, Infinity, false, 'line'), ringFootroom(512, 0.4, Infinity, false, 'arc'), '原来那两种留白不变');
  assert.ok(ringFootroom(512, 0.4, Infinity, false, 'card') > ringFootroom(512, 0.4, Infinity, false, 'line'), '卡片比一行字高，多留一点');
  assert.equal(ringFootroom(512, 0.4), ringFootroom(512, 0.4, Infinity, false, 'card'), '默认是黑底卡片');
}

console.log('pp-ring: ok');
