/**
 * 游戏时刻（core/moments.js）、休息段结束事件（core/events.js），以及 watch.js 把时刻发给角色（桌面 + OBS）。
 * 钉住：每种事件归到哪个时刻；姿势在说话的闸门之前发、不说话也换；回放不换；tosu 断了 / 功能关了 / 程序退出要放下「打图中」；
 * 打图中每 30 秒给 OBS 一次心跳；休息段结束只换姿势不说话。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-moments-'));
process.env.OSU_PET_HOME = sandbox;
const { MOMENTS, momentOf, playingAfter } = await import('../core/moments.js');
const { createOsuTracker, normalizeSnapshot } = await import('../core/events.js');
const watch = await import('../core/watch.js');
const { DEFAULTS } = await import('../core/config.js');
// 这些测试按原来那套说话频率写的（2026-11-22 默认值改成了用户给的那套：间隔 10 秒、每首 10 句、念出来……），这里固定住原来的值
const TEST_WATCH = { output: 'subtitle', voice: false, minGapSec: 40, perSongMax: 3, dailyLimit: 150, headsUp: 'off', headsUpMax: 4 };
const { frame, kinds } = await import('./fixtures.mjs');

// ── 时刻 ─────────────────────────────────────────────────────────────────────
{
  const ev = (kind, extra = {}) => ({ kind, replay: false, map: {}, ...extra });
  const cases = [
    [ev('start'), 'start'], [ev('combo', { mark: 300 }), 'combo'],
    [ev('combo-break'), 'combo-break'], [ev('combo-break', { sliderBreak: true }), 'slider-break'], [ev('combo-break', { fcLost: true, sliderBreak: true }), 'fc-lost'],
    [ev('acc-drop'), 'acc-drop'], [ev('break'), 'break'], [ev('break-end'), 'break-end'], [ev('rank-up'), 'rank-up'], [ev('rank-down'), 'rank-down'],
    [ev('retry', { retries: 1 }), 'retry'], [ev('retry', { retries: 2 }), 'retry'], [ev('retry', { retries: 3 }), 'retry-sulk'], [ev('retry', { retries: 9 }), 'retry-sulk'],
    [ev('retry', { retries: 10 }), 'retry-tired'], [ev('retry', { retries: 19 }), 'retry-tired'], [ev('retry', { retries: 20 }), 'retry-rage'], [ev('retry', { retries: 55 }), 'retry-rage'],
    [ev('finish', { fullCombo: true, rank: 'A' }), 'fc'],
    ...['SS', 'X', 'XH', 'SSH', 'S', 'SH', 'A', 'a'].map((rank) => [ev('finish', { rank }), 'pass-good']),
    ...['B', 'C', 'D', '', undefined].map((rank) => [ev('finish', { rank }), 'pass']),
    [ev('fail'), 'fail'], [ev('quit', { progress: 0.5 }), 'quit'], [ev('quit', { progress: 0.1 }), 'quit'], [ev('quit', { progress: 0.05 }), null], [ev('quit', { progress: null }), null],
    [ev('start', { replay: true }), null], [ev('finish', { replay: true, fullCombo: true }), null], [ev('mystery'), null], [null, null], ['x', null],
  ];
  for (const [event, expected] of cases) assert.equal(momentOf(event), expected, JSON.stringify(event));
  for (const [event] of cases) { const m = momentOf(event); if (m) assert.ok(MOMENTS.includes(m), `${m} 要在 MOMENTS 里`); }
  assert.deepEqual(['start', 'retry', 'finish', 'fail', 'quit', 'combo', 'break'].map((kind) => playingAfter(ev(kind))), [true, true, false, false, false, null, null]);
  assert.equal(playingAfter(ev('start', { replay: true })), null, '看回放不算在打');
}

// ── 休息段结束（osu-pet 加的事件）────────────────────────────────────────────
{
  const tracker = createOsuTracker();
  const feed = (options, now) => tracker.feed(normalizeSnapshot(frame(options)), now);
  feed({ time: 0 }, 0);
  feed({ time: 30_000, score: 500, combo: 40 }, 1);
  assert.deepEqual(kinds(feed({ time: 31_000, score: 500, combo: 40, isBreak: true }, 2)), ['break']);
  assert.deepEqual(kinds(feed({ time: 35_000, score: 500, combo: 40, isBreak: true }, 3)), [], '休息段里不重复报');
  assert.deepEqual(kinds(feed({ time: 45_000, score: 600, combo: 60 }, 4)), ['break-end'], '出了休息段报一次');
  assert.deepEqual(kinds(feed({ time: 46_000, score: 610, combo: 61 }, 5)), [], '只报一次');
  assert.equal(watch.describeEvent({ kind: 'break-end', map: {} }), '', '不说话：没有给模型的描述');
}

// ── watch.js 把时刻发出去 ────────────────────────────────────────────────────
const PLAYS = path.join(sandbox, 'plays.json');
function harness({ config = {} } = {}) {
  const state = { clock: Date.parse('2026-11-20T20:00:00+08:00') };
  const calls = { pet: [], counter: [], complete: 0, sockets: [] };
  const cfg = { ...DEFAULTS.watch, ...TEST_WATCH, enabled: true, output: 'subtitle', ...config };
  const service = watch.createOsuWatchService({
    config: () => ({ watch: cfg, rulers: DEFAULTS.rulers }),
    persona: { info: () => ({ name: 'ROLE', ownerName: 'OWNER', pronoun: '他', persona: '' }) },
    llm: { ready: () => ({ ok: true }), complete: async () => { calls.complete += 1; return { text: 'LINE', usage: {}, model: 'M' }; } },
    overlay: { say: () => ({ ok: true }), stop: () => {}, status: () => ({}) },
    pet: { status: () => ({ visible: true }), speak: () => {}, react: (p) => calls.pet.push(p) },
    counter: { say: () => true, sync: async () => ({ ok: true }), status: () => ({}), react: (p) => calls.counter.push(p) },
    deps: {
      now: () => state.clock,
      connect: (url) => {
        const listeners = {};
        const socket = { url, close() {}, addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, fire: (t, p = {}) => (listeners[t] ?? []).forEach((fn) => fn(p)) };
        calls.sockets.push(socket);
        return socket;
      },
    },
  });
  return { state, calls, service, cfg };
}
const event = (kind, extra = {}) => ({ kind, at: 0, replay: false, retries: 0, progress: 0.5, acc: 97, miss: 1, combo: 0, peakCombo: 300, mods: '', map: { title: 'T', version: 'V', stars: 5, maxCombo: 1000 }, ...extra });
{
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service } = harness({ config: { midPlay: false } });
  // 开局：换姿势 + 进入「打图中」；即使「打的过程中也说」关着（不说话）也换。
  await service.handleEvent(event('start', { at: state.clock }));
  assert.deepEqual(calls.pet.at(-1), { moment: 'start', playing: true });
  assert.deepEqual(calls.counter.at(-1), { moment: 'start', playing: true });
  assert.equal(service.status().posePlaying, true);
  // 不值得说的断连（被闸门拦下）：姿势照换。
  const said = calls.complete;
  assert.equal((await service.handleEvent(event('combo-break', { at: state.clock, lostCombo: 60, sliderBreak: true }))).said, false);
  assert.equal(calls.complete, said, '没调模型');
  assert.deepEqual(calls.pet.at(-1), { moment: 'slider-break', playing: true });
  // 休息段 / 结束：只换姿势，不说话、也不记进「最近没说的」。
  await service.handleEvent(event('break', { at: state.clock }));
  const r = await service.handleEvent(event('break-end', { at: state.clock }));
  assert.deepEqual(r, { said: false, reason: 'pose-only' });
  assert.deepEqual(calls.counter.at(-1), { moment: 'break-end', playing: true });
  assert.ok(!service.status().skipped.some((s) => s.kind === 'break-end'));
  // 看回放：什么都不发。
  const n = calls.pet.length;
  await service.handleEvent(event('combo', { at: state.clock, replay: true, mark: 500 }));
  await service.handleEvent(event('finish', { at: state.clock, replay: true, fullCombo: true }));
  assert.equal(calls.pet.length, n);
  // 全连打完：换姿势 + 退出「打图中」。
  state.clock += 7000;
  await service.handleEvent(event('finish', { at: state.clock, fullCombo: true, rank: 'S', progress: 1 }));
  assert.deepEqual(calls.pet.at(-1), { moment: 'fc', playing: false });
  assert.equal(service.status().posePlaying, false);
  // 刚点开就退出：不换姿势，「打图中」照样放下。
  await service.handleEvent(event('start', { at: state.clock }));
  await service.handleEvent(event('quit', { at: state.clock, progress: 0.02 }));
  assert.deepEqual(calls.pet.at(-1), { moment: null, playing: false });
}
{
  // tosu 断了：放下「打图中」（没有结束事件，不然 OBS 里她会一直停在打图的姿势）。
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service } = harness();
  service.start();
  calls.sockets[0].fire('open');
  await service.handleEvent(event('start', { at: state.clock }));
  assert.equal(service.status().posePlaying, true);
  calls.sockets[0].fire('close');
  assert.deepEqual(calls.counter.at(-1), { moment: null, playing: false });
  assert.equal(service.status().posePlaying, false);
  service.stop();
}
{
  // 打图中：对局悄悄没了（tracker 里没有在打的一把）就放下；关掉功能、停服务也放下。
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service, cfg } = harness();
  service.start();
  calls.sockets[0].fire('open');
  await service.handleEvent(event('start', { at: state.clock }));
  state.clock += 6000;
  service.sync();
  assert.deepEqual(calls.counter.at(-1), { moment: null, playing: false }, 'tracker 里没在打：当不打了');
  await service.handleEvent(event('start', { at: state.clock }));
  cfg.enabled = false;
  service.sync();
  assert.deepEqual(calls.pet.at(-1), { moment: null, playing: false });
  cfg.enabled = true;
  service.sync();
  await service.handleEvent(event('start', { at: state.clock }));
  service.stop();
  assert.deepEqual(calls.pet.at(-1), { moment: null, playing: false });
}
{
  // 真的在打（喂真的帧）：每 30 秒给 OBS 一次心跳，不重复发时刻。
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service } = harness({ config: { midPlay: false } });
  service.start();
  calls.sockets[0].fire('open');
  state.clock += 1000;
  calls.sockets[0].fire('message', { data: JSON.stringify(frame({ time: 0 })) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls.counter.at(-1), { moment: 'start', playing: true });
  const before = calls.counter.length;
  for (let t = 1; t <= 7; t += 1) {
    state.clock += 5000;
    calls.sockets[0].fire('message', { data: JSON.stringify(frame({ time: t * 5000, score: t, combo: 2 })) });
    service.sync();
  }
  const beats = calls.counter.slice(before);
  assert.equal(beats.length, 1, `35 秒里一次心跳：${JSON.stringify(beats)}`);
  assert.deepEqual(beats[0], { moment: null, playing: true });
  assert.equal(calls.pet.filter((p) => p.moment === null && p.playing === true).length, 0, '心跳只给 OBS（桌面角色在同一个程序里，不会失联）');
  service.stop();
}
{
  // 打到一半把功能关了又打开（tosu 断了又连上同理）：这一把还在 tracker 里，没有新的开局事件——有帧进来就补上 play-on（复核发现）。
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service, cfg } = harness({ config: { midPlay: false } });
  service.start();
  calls.sockets[0].fire('open');
  state.clock += 1000;
  calls.sockets[0].fire('message', { data: JSON.stringify(frame({ time: 0 })) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(service.status().posePlaying, true);
  cfg.enabled = false;
  service.sync();
  assert.equal(service.status().posePlaying, false);
  cfg.enabled = true;
  service.sync();
  const socket = calls.sockets.at(-1);
  socket.fire('open');
  state.clock += 1000;
  socket.fire('message', { data: JSON.stringify(frame({ time: 5000, score: 10, combo: 3 })) });
  assert.equal(service.status().posePlaying, true, '同一把接着打：补上 play-on');
  assert.deepEqual(calls.counter.at(-1), { moment: null, playing: true });
  // 打完的那一帧之后不会又被补成「在打」。
  state.clock += 1000;
  socket.fire('message', { data: JSON.stringify(frame({ state: 7, results: { rank: 'A', score: 9, accuracy: 97, hits: { 0: 1 }, maxCombo: 300 } })) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(service.status().posePlaying, false);
  assert.equal(calls.counter.at(-1).playing, false);
  service.stop();
}
{
  // 角色那头出错不影响说话。
  fs.rmSync(PLAYS, { force: true });
  const logs = [];
  const service = watch.createOsuWatchService({
    config: () => ({ watch: { ...DEFAULTS.watch, ...TEST_WATCH, enabled: true }, rulers: DEFAULTS.rulers }),
    persona: { info: () => ({ name: 'R', ownerName: 'O', pronoun: '他', persona: '' }) },
    llm: { ready: () => ({ ok: true }), complete: async () => ({ text: 'OK', usage: {}, model: 'M' }) },
    overlay: { say: () => ({ ok: true }), stop: () => {}, status: () => ({}) },
    pet: { status: () => ({ visible: false }), speak: () => {}, react: () => { throw new Error('PET_DOWN'); } },
    counter: { say: () => true, sync: async () => ({ ok: true }), status: () => ({}), react: () => { throw new Error('OBS_DOWN'); } },
    log: (...a) => logs.push(a.join(' ')),
    deps: { now: () => Date.parse('2026-11-20T20:00:00+08:00'), connect: () => ({ addEventListener() {}, close() {} }) },
  });
  assert.equal((await service.handleEvent(event('finish', { rank: 'A', progress: 1 }))).said, true);
  assert.ok(logs.some((l) => l.includes('PET_DOWN')) && logs.some((l) => l.includes('OBS_DOWN')), '记了日志');
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('moments: ok');
