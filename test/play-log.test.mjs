/**
 * 日志里「当时打成什么样」的那几段字（core/play-log.js）。
 * 钉住：时间 / 百分比 / 准度的写法；读不到的项不写；每种事件的说明；开局那一行；耗时那一段；不带别人的名字。
 */
import assert from 'node:assert/strict';

const { clock, seconds, mapName, stateOf, detailOf, startLine, contextOf, timingOf, hideNames } = await import('../core/play-log.js');

assert.equal(clock(102_400), '1:42');
assert.equal(clock(0), '0:00');
assert.equal(clock(3_600_000 + 5000), '60:05');
assert.equal(clock(null), '');
assert.equal(clock(-5), '');
assert.equal(seconds(1834), '1.8 秒');
assert.equal(seconds(undefined), '');

assert.equal(mapName({ map: { title: 'T', version: 'Hard' }, mods: 'HDDT' }), 'T [Hard] +HDDT');
assert.equal(mapName({ map: { title: 'T' }, mods: 'HD, DT' }), 'T +HDDT');
assert.equal(mapName({}), '（不知道哪张图）');

const ev = { kind: 'combo-break', map: { title: 'T', version: 'Hard', maxCombo: 800 }, mods: '', timeMs: 61_000, progress: 0.5, acc: 98.765, combo: 3, peakCombo: 400, n100: 2, n50: 0, miss: 1, pp: 99.6, lostCombo: 400, sliderBreak: true };
assert.equal(stateOf(ev), 'T [Hard]｜谱面 1:01（50%）｜98.77%｜连击 3（最高 400 / 800）｜100×2 50×0 miss×1｜100pp');
assert.equal(detailOf(ev), '断了 400 combo，滑条没跟住');
assert.equal(contextOf(ev), `断了 400 combo，滑条没跟住｜${stateOf(ev)}`);

// 读不到的项不写，不出现 undefined / NaN
const bare = stateOf({ kind: 'break', map: { title: 'T' } });
assert.equal(bare, 'T');
for (const kind of ['start', 'retry', 'combo-break', 'combo', 'acc-drop', 'break', 'break-end', 'rank-up', 'rank-down', 'finish', 'fail', 'quit', 'weird']) {
  const text = contextOf({ kind, map: {} });
  assert.ok(!/undefined|NaN|null/.test(text), `${kind}：${text}`);
}

assert.equal(detailOf({ kind: 'combo', mark: 500 }), '过了 500 combo');
assert.equal(detailOf({ kind: 'acc-drop', seconds: 8, new100: 5, new50: 1, accFrom: 98.2, acc: 96.4 }), '8 秒里多了 5 个 100、1 个 50，准度 98.20% → 96.40%');
assert.equal(detailOf({ kind: 'rank-down', from: 1, to: 2, players: 4, names: ['SOMEONE'] }), '多人房第 1 → 第 2（4 人）');
assert.equal(detailOf({ kind: 'finish', rank: 'S', fullCombo: true, place: { rank: 1, players: 4 } }), '打完，评级 S，FC，多人房第 1 / 4');
assert.equal(detailOf({ kind: 'fail', progress: 0.42 }), '失败，打到 42%');
assert.equal(detailOf({ kind: 'quit' }), '退出');
assert.equal(detailOf({ kind: 'retry', retries: 1 }), '第 1 次重开');
assert.equal(detailOf({ kind: 'start', retries: 0 }), '开局');

assert.equal(startLine({ map: { title: 'T', version: 'X', stars: 7.12, bpm: 224.6, ar: 10.33, cs: 4, maxCombo: 1500 }, mods: 'DT', retries: 2, multi: true }), 'T [X] +DT｜7.12 星｜BPM 225｜AR 10.3｜CS 4｜1500 combo｜第 2 次重开｜多人房');
assert.equal(startLine({ map: { title: 'T' }, replay: true }), 'T｜回放 / 观战，不说话');

assert.equal(timingOf({ eventAt: 1000, saidAt: 3900, llmMs: 1800, ttsMs: 600, model: 'M', input: 10, output: 2 }), '事件后 2.9 秒说出｜模型 M 1.8 秒（输入 10 / 输出 2 token），语音 0.6 秒');
assert.equal(timingOf({ eventAt: 1000, saidAt: 3000, dropped: true }), '事件后 2.0 秒');
assert.equal(timingOf({ eventAt: 0, saidAt: 3000, llmMs: 500 }), '模型 0.5 秒', '事件时间不对（0）就不写「事件后」');
assert.equal(timingOf({}), '');
assert.ok(!contextOf({ kind: 'rank-up', from: 2, to: 1, names: ['RIVAL'] }).includes('RIVAL'), '不写别人的名字');
assert.equal(timingOf({ llmMs: 1000, ttsMs: 12_000, ttsFail: '等了 12 秒还没合成出来' }), '模型 1.0 秒，语音没念出来（等了 12 秒还没合成出来，等了 12.0 秒）');
assert.equal(hideNames('超过 Bobby 了，Bob 也在后面', ['Bob', 'Bobby']), '超过 对方 了，对方 也在后面', '长的名字先换');
assert.equal(hideNames('没有名字', null), '没有名字');
assert.equal(hideNames('a', ['', '  ']), 'a', '空名字不动');

console.log('play-log: ok');
