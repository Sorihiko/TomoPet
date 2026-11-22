/**
 * 滑条真正的尾巴（core/slider-path.js，2026-11-21）：沿路径走到像素长度，截断 / 延长；圆弧、红点分段的贝塞尔、Catmull；
 * 点特别多的贝塞尔不能卡住。
 */
import assert from 'node:assert/strict';

const { sliderEnd } = await import('../core/slider-path.js');
const near = (got, want, tol, msg) => assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1]) <= tol, `${msg}：得到 ${got.map((v) => v.toFixed(1))}，应该 ${want}`);

// 直线：比控制点短就截断，长就顺着方向延长
near(sliderEnd([0, 0], 'L', [[100, 0]], 60), [60, 0], 0.01, '直线截断');
near(sliderEnd([0, 0], 'L', [[100, 0]], 140), [140, 0], 0.01, '直线延长');
near(sliderEnd([0, 0], 'L', [[100, 0], [100, 100]], 150), [100, 50], 0.01, '折线走到第二段中间');
// 「控制点在 380px 外、长度只有 54」的短滑条（复核时在真图里找到的）：尾巴在 54px 处，不是控制点
near(sliderEnd([100, 200], 'L', [[480, 200]], 54), [154, 200], 0.01, '短滑条的控制点很远');

// 圆弧：圆心 (100,0) 半径 100，从 (0,0) 经 (100,100) 到 (200,0)，半圆长 π×100
near(sliderEnd([0, 0], 'P', [[100, 100], [200, 0]], Math.PI * 50), [100, 100], 1, '圆弧走四分之一圈');
near(sliderEnd([0, 0], 'P', [[100, 100], [200, 0]], Math.PI * 100), [200, 0], 1, '圆弧走到终点');
near(sliderEnd([0, 0], 'P', [[100, -100], [200, 0]], Math.PI * 50), [100, -100], 1, '反方向的圆弧');
// 三点在一条线上：不是圆弧（照 osu! 退回贝塞尔，就是直线）
near(sliderEnd([0, 0], 'P', [[50, 0], [100, 0]], 80), [80, 0], 0.5, '三点共线');
// 几乎共线（圆大得离谱）：不能算出天文数字
const almost = sliderEnd([0, 0], 'P', [[50, 0.0001], [100, 0]], 80);
assert.ok(almost.every(Number.isFinite) && Math.abs(almost[0] - 80) < 1, String(almost));

// 贝塞尔：三点的二次曲线，走完全长在终点；连续两个相同的点（红点）分成两段直线
const quad = sliderEnd([0, 0], 'B', [[100, 100], [200, 0]], 1000);
assert.ok(quad[0] > 200, '比曲线长：顺着最后的方向往外延长');
near(sliderEnd([0, 0], 'B', [[100, 0], [100, 0], [100, 100]], 150), [100, 50], 0.5, '红点：先直着走 100，再拐弯');
// 没有类型 / 不认识的类型：按贝塞尔
near(sliderEnd([0, 0], '', [[100, 0]], 50), [50, 0], 0.5, '没有类型');

// Catmull（很老的图）：经过控制点
near(sliderEnd([0, 0], 'C', [[100, 0]], 50), [50, 0], 1, 'Catmull 直线');

// 算不出来时退回最后一个控制点：长度 0、没有控制点
near(sliderEnd([10, 10], 'L', [[100, 0]], 0), [100, 0], 0, '长度 0');
near(sliderEnd([10, 10], 'L', [], 50), [10, 10], 0, '没有控制点');

// 最后两个点重合：osu! 不往外延长，停在终点
near(sliderEnd([0, 0], 'B', [[100, 0], [100, 0]], 150), [100, 0], 0.01, '末尾重合不延长');
// 整张图的计算量用完：一条两万个点的滑条也要马上返回（复核发现只在开头查计算量时要算一秒多）
const huge = Array.from({ length: 20000 }, (_, i) => [(i * 7) % 512, (i * 13) % 384]);
const t1 = Date.now();
const budget = { ops: 3e7 };
assert.ok(sliderEnd([0, 0], 'B', huge, 500, budget).every(Number.isFinite));
assert.ok(Date.now() - t1 < 200, `两万个点用了 ${Date.now() - t1}ms`);
assert.ok(budget.ops > 0, '没把计算量用成负的一大截');
// 计算量用完了：直接给最后一个控制点
near(sliderEnd([0, 0], 'L', [[100, 0]], 50, { ops: 0 }), [100, 0], 0, '计算量用完');

// 点特别多的贝塞尔（「画字」的滑条有几百个点）：不能卡住主进程
const many = Array.from({ length: 600 }, (_, i) => [i % 2 ? 300 : 0, i]);
const t0 = Date.now();
const end = sliderEnd([0, 0], 'B', many, 300);
assert.ok(end.every(Number.isFinite), String(end));
assert.ok(Date.now() - t0 < 1000, `600 个点用了 ${Date.now() - t0}ms`);

console.log('slider-path: ok');
