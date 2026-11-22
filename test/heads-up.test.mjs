/**
 * 难段预告（2026-11-21）：解析 .osu 和找难段（core/patterns.js）、打图时按时间提前报（core/heads-up.js）。
 * 用造出来的谱面和假时钟，不碰真的 tosu / osu! / 火山。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const { parseOsu, findHardSections, cueOf, leadSecOf, CUE_PHRASES } = await import('../core/patterns.js');
const { createHeadsUp, tosuHttpBase } = await import('../core/heads-up.js');
const { pcmToWav } = await import('../core/speakable.js');

// ── 造一张图：180 BPM（拍长 333.33ms），CS4 ─────────────────────────────────────
const BEAT = 60000 / 180;
function makeMap({ mode = 0, extra = [], timing = [`0,${BEAT},4,2,0,60,1,0`], breaks = [] } = {}) {
  const objs = [];
  // 0–20 秒：1/2 拍的普通圈，间距小（2 个半径以内）
  for (let t = 1000; t < 20000; t += BEAT / 2) objs.push(`${256 + (objs.length % 2) * 40},192,${Math.round(t)},1,0`);
  // 25 秒起：24 下 1/4 拍的串
  for (let i = 0; i < 24; i += 1) objs.push(`${200 + (i % 4) * 15},200,${Math.round(25000 + i * BEAT / 4)},1,0`);
  // 中间再垫一段普通的
  for (let t = 28000; t < 40000; t += BEAT / 2) objs.push(`${256 + (objs.length % 2) * 40},192,${Math.round(t)},1,0`);
  // 45 秒起：12 下 1/2 拍的大跳（左右来回 390px）
  for (let i = 0; i < 12; i += 1) objs.push(`${i % 2 ? 450 : 60},${200},${Math.round(45000 + i * BEAT / 2)},1,0`);
  for (let t = 50000; t < 70000; t += BEAT / 2) objs.push(`${256 + (objs.length % 2) * 40},192,${Math.round(t)},1,0`);
  return [
    'osu file format v14', '', '[General]', `Mode: ${mode}`, '', '[Difficulty]', 'CircleSize:4', 'SliderMultiplier:1.4', '',
    '[Events]', ...breaks.map((b) => `2,${b[0]},${b[1]}`), '', '[TimingPoints]', ...timing, '', '[HitObjects]', ...objs, ...extra, '',
  ].join('\r\n');
}

// ── 解析 ─────────────────────────────────────────────────────────────────────
{
  const p = parseOsu('\uFEFF' + makeMap({
    extra: ['100,100,71000,2,0,L|200:100,1,140', '100,100,73000,2,0,B|150:150|300:100,2,140', '256,192,76000,12,0,78000'],
    timing: [`0,${BEAT},4,2,0,60,1,0`, '70500,-50,4,2,0,60,0,0'],
    breaks: [[20500, 24000]],
  }));
  assert.ok(p);
  assert.equal(p.cs, 4);
  assert.deepEqual(p.breaks, [{ start: 20500, end: 24000 }]);
  const slider = p.objects.find((o) => o.t === 71000);
  // 时长 = 140 / (1.4 × 100 × 2) × 333.33 × 1 ≈ 166.7ms（绿线 -50 = 2 倍速）；尾巴在最后一个点
  assert.equal(slider.kind, 'slider');
  assert.ok(Math.abs(slider.end - 71000 - 166.7) < 1, String(slider.end));
  // 尾巴沿路径走到像素长度：控制点连线只有 100px、长度写的 140 → 顺着方向延长到 x=240（和 osu! 一样）
  assert.deepEqual([slider.ex, slider.ey], [240, 100]);
  const back = p.objects.find((o) => o.t === 73000);
  assert.deepEqual([back.ex, back.ey], [100, 100], '来回两次：尾巴回到头');
  const spin = p.objects.find((o) => o.t === 76000);
  assert.deepEqual([spin.kind, spin.end], ['spinner', 78000]);
  assert.equal(parseOsu(makeMap({ mode: 3 })), null, '不是标准模式');
  assert.equal(parseOsu(''), null);
  assert.equal(parseOsu('[HitObjects]\n1,2,3,1,0'), null, '没有红线');
}

// ── 找难段 ───────────────────────────────────────────────────────────────────
{
  const p = parseOsu(makeMap());
  const secs = findHardSections(p, { rate: 1 });
  assert.deepEqual(secs.map((s) => s.kind), ['stream', 'jump'], JSON.stringify(secs));
  assert.equal(secs[0].start, 25000);
  assert.equal(secs[0].count, 24);
  assert.equal(secs[1].start, 45000);
  assert.ok(secs[1].count >= 10);
  assert.equal(cueOf(secs[0]), CUE_PHRASES.stream);
  // 「一大段长串」：65 下以上或者 8 秒以上（33 下只是长串）
  assert.equal(cueOf({ kind: 'stream', count: 40 }), CUE_PHRASES.stream);
  assert.equal(cueOf({ kind: 'stream', count: 70 }), CUE_PHRASES.streamLong);
  assert.equal(cueOf({ kind: 'stream', count: 40, durReal: 9000 }), CUE_PHRASES.streamLong);
  // 串的样子说在前面（宽间距 / 断开 / 叠串 / 来回跳），普通的照长短说
  assert.equal(cueOf({ kind: 'stream', count: 70, sub: 'cut' }), CUE_PHRASES.streamCut);
  assert.equal(cueOf({ kind: 'stream', count: 20, sub: 'spaced' }), CUE_PHRASES.streamSpaced);
  assert.equal(cueOf({ kind: 'stream', count: 20, sub: 'normal' }), CUE_PHRASES.stream);
  assert.equal(cueOf(secs[1]), CUE_PHRASES.jump);
  // 最多几段、两段隔太近只留难的那段
  assert.equal(findHardSections(p, { max: 1 }).length, 1);
  assert.equal(findHardSections(p, { minGapSec: 30 }).length, 1, '25 秒和 45 秒只隔 20 秒');
  // 大跳按光标在屏幕上挪多远算（390px），和 CS 无关：开 HR 圈变小也还是这一段
  assert.deepEqual(findHardSections(p, { cs: 0 }).map((s) => [s.kind, s.start]), findHardSections(p, { cs: 7 }).map((s) => [s.kind, s.start]));
  // 开头来不及报的不要
  const early = parseOsu(makeMap().replace(/(\[HitObjects\]\r\n)/, '$1' + Array.from({ length: 20 }, (_, i) => `200,200,${Math.round(1200 + i * BEAT / 4)},1,0`).join('\r\n') + '\r\n'));
  assert.ok(!findHardSections(early, { rate: 1 }).some((s) => s.start < 3000));
  // 串和跳挨着：并成「串接跳」
  // （跳那几秒底下的普通圈去掉：不然普通圈夹在跳中间，每下只挪两百来像素，不算大跳了）
  const mixedText = makeMap({ extra: Array.from({ length: 12 }, (_, i) => `${i % 2 ? 450 : 60},200,${Math.round(25000 + 24 * BEAT / 4 + 200 + i * BEAT / 2)},1,0`) })
    .split('\r\n').filter((line) => { const m = /^(?:256|296),192,(\d+),1,0$/.exec(line); return !(m && Number(m[1]) >= 27000 && Number(m[1]) < 29500); }).join('\r\n');
  const mixedMap = parseOsu(mixedText);
  // 串在前、跳在后：是「先串后跳」，提示要把先后说对（2026-11-21 用户：串后面有跳和跳后面有串是两个东西）
  const ordered = findHardSections(mixedMap).find((s) => s.kind.includes('-'));
  assert.equal(ordered?.kind, 'stream-jump', JSON.stringify(findHardSections(mixedMap)));
  assert.equal(cueOf(ordered), CUE_PHRASES.streamJump);
  assert.equal(cueOf({ kind: 'jump-stream' }), CUE_PHRASES.jumpStream);
  assert.equal(cueOf({ kind: 'alternate' }), CUE_PHRASES.alternate);
  for (const phrase of Object.values(CUE_PHRASES)) assert.ok(Array.from(phrase).length >= 8, `「${phrase}」要是一句完整的话`);
  // 变速：BPM 变 15% 以上才算；正好翻倍 / 减半只是写法，不算
  const fast = parseOsu(makeMap({ timing: [`0,${BEAT},4,2,0,60,1,0`, `60000,${60000 / 230},4,2,0,60,1,0`] }));
  assert.ok(findHardSections(fast, { max: 8 }).some((s) => s.kind === 'speed' && s.faster && cueOf(s) === CUE_PHRASES.speedUp));
  const half = parseOsu(makeMap({ timing: [`0,${BEAT},4,2,0,60,1,0`, `60000,${BEAT * 2},4,2,0,60,1,0`] }));
  assert.ok(!findHardSections(half, { max: 8 }).some((s) => s.kind === 'speed'));
  // 整张图都是串：只报比别的串明显难的
  const allStreams = [];
  // 每 2 秒一段 16 下的串（一段约 1.3 秒）：七成的时间都在打串
  for (let k = 0; k < 36; k += 1) for (let i = 0; i < 16; i += 1) allStreams.push(`200,200,${Math.round(5000 + k * 2000 + i * BEAT / 4)},1,0`);
  for (let i = 0; i < 64; i += 1) allStreams.push(`200,200,${Math.round(80000 + i * BEAT / 4)},1,0`);
  const dense = parseOsu(makeMap().replace(/\[HitObjects\][\s\S]*$/, `[HitObjects]\r\n${allStreams.join('\r\n')}\r\n`));
  const denseSecs = findHardSections(dense, { max: 8, minGapSec: 1 });
  assert.deepEqual(denseSecs.map((s) => [s.kind, s.start]), [['stream', 80000]], JSON.stringify(denseSecs));
  // 慢的长链（1/2 拍、间隔 > 140ms）不算串
  const slow = parseOsu(makeMap().replace(/\[HitObjects\][\s\S]*$/, `[HitObjects]\r\n${Array.from({ length: 40 }, (_, i) => `256,192,${Math.round(10000 + i * BEAT / 2)},1,0`).join('\r\n')}\r\n`));
  assert.ok(!findHardSections(slow).some((s) => s.kind === 'stream'));
  assert.deepEqual(findHardSections(null), []);
  // 提前量：2 秒和 4 拍取长的，最多 3 秒；DT 下拍子变短
  assert.equal(leadSecOf(BEAT, 1), 2);
  assert.equal(leadSecOf(1000, 1), 3, '60 BPM 的 4 拍是 4 秒，封顶 3 秒');
  assert.equal(leadSecOf(600, 1), 2.4);
  assert.equal(leadSecOf(600, 1.5), 2);
}

// ── 控制器：到点提醒 ─────────────────────────────────────────────────────────
const MAP_TEXT = makeMap();
const MD5 = createHash('md5').update(MAP_TEXT).digest('hex');
const wav = pcmToWav(Buffer.alloc(24000 * 2 * 0.8, 1), 24000); // 0.8 秒
function rig({ mode = 'voice', tts = true, readFile = () => MAP_TEXT, fetchText = async () => MAP_TEXT } = {}) {
  const cfg = { watch: { headsUp: mode, headsUpMax: 4, url: 'ws://127.0.0.1:24050/websocket/v2' }, tts: { appId: 'a', speaker: 's' } };
  const calls = { synth: [], overlay: [], counterSay: [], counterReact: [], petReact: [], petSpeak: [], fetched: [], read: [], logs: [] };
  let clock = 1_000_000;
  const timers = [];
  const h = createHeadsUp({
    config: () => cfg,
    tts: tts ? { ready: () => ({ ok: true }), synthesize: async (t) => { calls.synth.push(t); return { bytes: wav, durationMs: 800 }; } } : null,
    overlay: { say: (o) => calls.overlay.push(o) },
    counter: { react: (o) => calls.counterReact.push(o), say: (o) => calls.counterSay.push(o) },
    pet: { react: (o) => calls.petReact.push(o), speak: (o) => calls.petSpeak.push(o) },
    log: (...a) => calls.logs.push(a.join(' ')),
    deps: {
      now: () => clock,
      readFile: (f) => { calls.read.push(f); return readFile(f); },
      fetchText: async (u) => { calls.fetched.push(u); return fetchText(u); },
      setTimeout: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t; },
      clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    },
  });
  const snap = (state, live, extra = {}) => ({
    state, me: 'ME', player: extra.player !== undefined ? extra.player : state === 'play' ? 'ME' : '',
    map: { key: MD5, title: 'T', version: 'V', rate: 1, cs: 4, timeLive: live, songsDir: 'D:/osu!/Songs', file: '1 a/b.osu', ...extra.map },
    play: { mods: extra.mods || '', hp: extra.hp ?? 200, score: extra.score ?? 0 },
    graph: extra.graph || null,
  });
  const tick = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
  // 从 live 开始每 150ms 推一帧，推到 until
  const play = (from, until, extra = {}, run = { replay: false, multi: false }) => {
    for (let t = from; t <= until; t += 150) {
      clock += 150;
      h.onFrame(snap('play', t, extra), run, clock);
      for (const tm of [...timers]) if (tm.at <= clock) { timers.splice(timers.indexOf(tm), 1); tm.fn(); }
    }
  };
  return { h, calls, snap, tick, play, cfg, setClock: (c) => { clock = c; }, get clock() { return clock; } };
}

{
  assert.equal(tosuHttpBase('ws://127.0.0.1:24050/websocket/v2'), 'http://127.0.0.1:24050');
  assert.equal(tosuHttpBase('wss://x:1/y'), 'https://x:1');
  assert.equal(tosuHttpBase('不是地址'), 'http://127.0.0.1:24050');

  const r = rig();
  // 选歌界面就先读好、先合成好提示语音
  r.h.onFrame(r.snap('select', 0), null);
  await r.tick();
  assert.equal(r.calls.read[0].replace(/\\/g, '/'), 'D:/osu!/Songs/1 a/b.osu');
  await r.h.prepareVoices();
  assert.deepEqual(new Set(r.calls.synth), new Set(Object.values(CUE_PHRASES)));
  const st = r.h.status();
  assert.deepEqual(st.map.sections.map((s) => [s.kind, s.start]), [['stream', 25000], ['jump', 45000]]);
  assert.equal(st.voices.ready, st.voices.total);
  // 打图：到 25000 - 2000 = 23000 之前不报
  r.play(0, 22700);
  assert.equal(r.calls.overlay.length, 0);
  r.play(22850, 23300);
  assert.equal(r.calls.overlay.length, 1, JSON.stringify(r.calls.overlay));
  assert.deepEqual([r.calls.overlay[0].text, r.calls.overlay[0].hidden, Buffer.isBuffer(r.calls.overlay[0].audio)], [CUE_PHRASES.stream, true, true]);
  assert.equal(r.calls.counterReact.length, 0, '念出来的这档 OBS 里也是张嘴说，不摆姿势');
  assert.equal(r.calls.counterSay.at(-1).text, CUE_PHRASES.stream, 'OBS 里冒气泡');
  assert.match(r.calls.counterSay.at(-1).mouth, /^[012]+$/);
  // 桌面角色也冒气泡、张嘴说这句（2026-11-21 用户：桌宠不弹气泡）；念出来的这档不摆姿势（嘴在动就够了）
  assert.deepEqual([r.calls.petSpeak.at(-1).text, r.calls.petSpeak.at(-1).bubble], [CUE_PHRASES.stream, true]);
  assert.match(r.calls.petSpeak.at(-1).mouth, /^[012]+$/);
  assert.equal(r.calls.petReact.length, 0);
  assert.ok(r.h.quiet(), '难段前后不插嘴');
  // 同一段不报第二次；下一段（大跳）照报
  r.play(23450, 44000);
  assert.equal(r.calls.overlay.length, 2);
  assert.equal(r.calls.overlay[1].text, CUE_PHRASES.jump);
  assert.equal(r.h.status().lastFired.cue, CUE_PHRASES.jump);
  r.play(44150, 52000);
  assert.ok(!r.h.quiet(), '难段过了');
  // 重开：live 往回跳，报过的清掉重来
  r.play(0, 23300);
  assert.equal(r.calls.overlay.length, 3);
}

{
  // 暂停：live 停住不动就不报（停在离难段 2.5 秒的地方等了很久）
  const r = rig();
  r.h.onFrame(r.snap('select', 0), null);
  await r.tick();
  await r.h.prepareVoices();
  r.play(20000, 22450);
  for (let i = 0; i < 20; i += 1) { r.setClock(r.clock + 150); r.h.onFrame(r.snap('play', 22450), { replay: false }, r.clock); }
  assert.equal(r.calls.overlay.length, 0, '暂停时不往前推');
  // 太晚了（直接从离难段 0.5 秒的地方开始）：来不及念完，不报
  const late = rig();
  late.h.onFrame(late.snap('select', 0), null);
  await late.tick();
  await late.h.prepareVoices();
  late.play(24500, 25000);
  assert.equal(late.calls.overlay.length, 0);
}

{
  // 看回放 / 观战：不报（打的不是你）
  {
    const r = rig();
    r.h.onFrame(r.snap('select', 0), null);
    await r.tick();
    await r.h.prepareVoices();
    r.play(20000, 24000, {}, { replay: true });
    assert.equal(r.calls.overlay.length + r.calls.counterSay.length, 0);
    assert.equal(r.h.status().blocked, 'replay');
    assert.equal(r.h.quiet(), false);
  }
  // 开 HD / FL、在多人房里：照样报（2026-11-21 用户：「多人房和 HD / FL 也能报」）
  for (const [extra, run, why] of [[{ mods: 'HDDT' }, { replay: false }, 'HD'], [{ mods: 'FL' }, { replay: false }, 'FL'], [{}, { multi: true }, '多人房']]) {
    const r = rig();
    r.h.onFrame(r.snap('select', 0), null);
    await r.tick();
    await r.h.prepareVoices();
    r.play(20000, 23300, extra, run);
    assert.equal(r.calls.overlay.length, 1, why);
    assert.equal(r.h.status().blocked, null, why);
  }
}

{
  // 「只给观众看」（viewers）2026-11-22 去掉了：老设置里还是 viewers 也当关，什么都不报、不摆姿势
  const r = rig({ mode: 'viewers' });
  r.h.onFrame(r.snap('select', 0), null);
  await r.tick();
  r.play(20000, 23300);
  assert.deepEqual([r.calls.overlay.length, r.calls.synth.length, r.calls.counterSay.length, r.calls.petSpeak.length, r.calls.petReact.length, r.calls.counterReact.length], [0, 0, 0, 0, 0, 0]);
  assert.equal(r.h.status().mode, 'off');
  // 关掉：什么都不做
  r.cfg.watch.headsUp = 'off';
  r.play(40000, 44000);
  assert.equal(r.calls.counterSay.length, 0);
  assert.equal(r.h.status().mode, 'off');
}

{
  // DT：谱面时间走得快 1.5 倍，提前量按真实时间算（2 秒真实 = 3000 谱面毫秒）
  const r = rig();
  r.h.onFrame(r.snap('select', 0, { map: { rate: 1.5 } }), null);
  await r.tick();
  await r.h.prepareVoices();
  r.play(20000, 21700, { map: { rate: 1.5 } });
  assert.equal(r.calls.overlay.length, 0);
  r.play(21850, 22300, { map: { rate: 1.5 } });
  assert.equal(r.calls.overlay.length, 1);
}

{
  // 读到的谱面和 checksum 对不上（换图途中）：退回问 tosu 要；都对不上就报错，不瞎报
  const r = rig({ readFile: () => 'WRONG', fetchText: async () => MAP_TEXT });
  r.h.onFrame(r.snap('select', 0), null);
  await r.tick();
  assert.equal(r.calls.fetched[0], 'http://127.0.0.1:24050/files/beatmap/file');
  assert.equal(r.h.status().map.sections.length, 2);
  const bad = rig({ readFile: () => 'WRONG', fetchText: async () => 'ALSO WRONG' });
  bad.h.onFrame(bad.snap('select', 0), null);
  await bad.tick();
  assert.match(bad.h.status().map.error, /对不上/);
  assert.equal(bad.h.status().lastError.code, 'headsup.map-unreadable');
  assert.ok(bad.h.status().lastError.hint);
}

{
  // 语音没配好：提示照样换姿势、冒气泡，不出声；合成失败一分钟内不重试
  let fails = 0;
  const r = rig();
  r.h.onFrame(r.snap('select', 0), null);
  await r.tick();
  const broken = createHeadsUp({
    config: () => r.cfg,
    tts: { ready: () => ({ ok: true }), synthesize: async () => { fails += 1; throw Object.assign(new Error('NET'), { code: 'tts.network', hint: 'H' }); } },
    deps: { now: () => 5_000_000 },
  });
  await broken.prepareVoices();
  await broken.prepareVoices();
  assert.equal(fails, 1, '失败后一分钟内不再请求');
  assert.equal(broken.status().voices.error.code, 'tts.network');
}

{
  // 不是 UTF-8 的老谱面（混了 Latin-1 字节）：按原始字节核对 checksum，照样认得出（复核发现）
  const bytes = Buffer.concat([Buffer.from(MAP_TEXT), Buffer.from([0x2f, 0x2f, 0x20, 0xe9, 0x0d, 0x0a])]);
  const key = createHash('md5').update(bytes).digest('hex');
  const r = rig({ readFile: () => bytes });
  r.h.onFrame({ ...r.snap('select', 0), map: { ...r.snap('select', 0).map, key } }, null);
  await r.tick();
  assert.equal(r.h.status().map.error, null);
  assert.equal(r.h.status().map.sections.length, 2);
}

// ── 复核修过的几处（2026-11-21）──────────────────────────────────────────────
{
  // 同一张图打完再打一遍：从头再报（原来只靠残留帧碰巧清掉）
  const r = rig();
  r.h.onFrame(r.snap('select', 0), null);
  await r.tick();
  await r.h.prepareVoices();
  r.play(20000, 23300);
  assert.equal(r.calls.overlay.length, 1);
  r.h.onFrame(r.snap('results', 0), null);
  r.h.onFrame(r.snap('select', 0), null);
  r.play(0, 23300);
  assert.equal(r.calls.overlay.length, 2, '第二遍照样报');
}

{
  // 暂停正好落在报点前一点：按往前推的时间报出去的那段放回去，继续打时再报，不会漏
  const r = rig();
  r.h.onFrame(r.snap('select', 0), null);
  await r.tick();
  await r.h.prepareVoices();
  r.play(20000, 22850); // 报点 23000，停在 22850
  for (let i = 0; i < 10; i += 1) { r.setClock(r.clock + 150); r.h.onFrame(r.snap('play', 22850), { replay: false }, r.clock); }
  const before = r.calls.overlay.length;
  r.play(22850, 24000); // 继续打
  assert.ok(r.calls.overlay.length >= 1 && r.calls.overlay.length - before >= (before ? 1 : 1), `继续打以后要报：${r.calls.overlay.length}（暂停时 ${before}）`);
}

{
  // 进图头几帧还是选歌试听的时间（名字空、血条 0、分数 0）：这几帧里时间在走也不报
  const r = rig();
  r.h.onFrame(r.snap('select', 0), null);
  await r.tick();
  await r.h.prepareVoices();
  const residue = { player: '', hp: -1, score: 0 };
  for (const t of [23050, 23200, 23350]) { r.setClock(r.clock + 150); r.h.onFrame(r.snap('play', t, residue), null, r.clock); }
  assert.equal(r.calls.overlay.length, 0, '残留帧不报');
  r.play(0, 300);
  r.play(22850, 23300);
  assert.equal(r.calls.overlay.length, 1, '真开局以后照常报');
}

{
  // 读谱面一时失败：5 秒后再试；改了「每张图最多报几次」马上重算
  let fail = true;
  const r = rig({ readFile: () => { if (fail) throw new Error('EBUSY'); return MAP_TEXT; }, fetchText: async () => { if (fail) throw new Error('HTTP 404'); return MAP_TEXT; } });
  r.h.onFrame(r.snap('select', 0), null);
  await r.tick();
  assert.ok(r.h.status().map.error);
  fail = false;
  r.h.onFrame(r.snap('select', 0), null);
  await r.tick();
  assert.ok(r.h.status().map.error, '5 秒内不重读');
  r.setClock(r.clock + 6000);
  r.h.onFrame(r.snap('select', 0), null);
  await r.tick();
  assert.equal(r.h.status().map.sections.length, 2, '过了 5 秒再读');
  r.cfg.watch.headsUpMax = 1;
  r.h.onFrame(r.snap('select', 0), null);
  await r.tick();
  assert.equal(r.h.status().map.sections.length, 1, '改了次数马上重算');
}

{
  // 语音没配好的错：配好、几句也都在以后清掉
  let ok = false;
  const r = rig();
  const h = createHeadsUp({
    config: () => r.cfg,
    tts: { ready: () => (ok ? { ok: true } : { ok: false, code: 'tts.no-key', error: '还没填', hint: 'H' }), synthesize: async () => ({ bytes: wav, durationMs: 800 }) },
    deps: { now: () => 1 },
  });
  await h.prepareVoices();
  assert.equal(h.status().voices.error.code, 'tts.no-key');
  ok = true;
  await h.prepareVoices();
  await h.prepareVoices();
  assert.equal(h.status().voices.error, null);
}

// 认难段：1/4 拍滑条接 1/2 拍的跳（滑条尾到下一下只隔 1/4 拍）、开 DT 的高 BPM 跳、只有一两段、被 kick 滑条切开的长串、空红线
function mapWith(objs, timing = [`0,${BEAT},4,2,0,60,1,0`], cs = 4) {
  return ['[General]', 'Mode: 0', '[Difficulty]', `CircleSize:${cs}`, 'SliderMultiplier:1.4', '[TimingPoints]', ...timing, '[HitObjects]', ...objs].join('\n');
}
{
  // 1/4 拍的滑条（长度 1.4×100×0.25 = 35）在左边，下一下在右边，头到头 1/2 拍
  const objs = [];
  for (let t = 1000; t < 8000; t += BEAT / 2) objs.push(`256,192,${Math.round(t)},1,0`);
  for (let i = 0; i < 12; i += 1) {
    const t = Math.round(10000 + i * BEAT / 2);
    objs.push(i % 2 ? `450,200,${t},1,0` : `60,200,${t},2,0,L|95:200,1,35`);
  }
  for (let t = 15000; t < 30000; t += BEAT / 2) objs.push(`256,192,${Math.round(t)},1,0`);
  const secs = findHardSections(parseOsu(mapWith(objs)));
  assert.ok(secs.some((s) => s.kind === 'jump' && s.start === 10000), JSON.stringify(secs));
}
{
  // 230 BPM 开 DT：1/2 拍真实只有 87ms，也要认得出跳
  const beat = 60000 / 230;
  const objs = [];
  // 填充用 1 拍一下（开 DT 时 1/2 拍的密集小间距本身就是串的速度了）
  for (let t = 1000; t < 8000; t += beat) objs.push(`256,192,${Math.round(t)},1,0`);
  for (let i = 0; i < 12; i += 1) objs.push(`${i % 2 ? 450 : 60},200,${Math.round(12000 + i * beat / 2)},1,0`);
  for (let t = 16000; t < 30000; t += beat) objs.push(`256,192,${Math.round(t)},1,0`);
  const secs = findHardSections(parseOsu(mapWith(objs, [`0,${beat},4,2,0,60,1,0`])), { rate: 1.5 });
  assert.ok(secs.some((s) => s.kind === 'jump'), JSON.stringify(secs));
}
{
  // 大跳按光标真的挪多远算（2026-11-21 用户：明明在打走路段她说有大跳；大跳是 Brazil [Fiery's Extreme] 结尾那种）：
  // 那张图 223 BPM，前面 240–320px 的 1/2 拍跳是普通跳，结尾连着 330–500px 的才是大跳。
  const beat = 60000 / 223;
  const at = (i) => Math.round(5000 + i * beat / 2);
  const zigzag = (i, px) => `${i % 2 ? 256 + px / 2 : 256 - px / 2},192,${at(i)},1,0`;
  // 整张图都是 280px 的 1/2 拍跳（普通跳）：一段都不算大跳
  const normal = Array.from({ length: 200 }, (_, i) => zigzag(i, 280));
  assert.ok(!findHardSections(parseOsu(mapWith(normal, [`0,${beat},4,2,0,60,1,0`]))).some((s) => s.kind.includes('jump')), '280px 是普通跳');
  // 间距小的图（200px 的走位）：原来按「这张图平时的走位」比会被当成大跳，现在不算
  const walk = Array.from({ length: 200 }, (_, i) => zigzag(i, i >= 120 && i < 136 ? 260 : 120));
  assert.ok(!findHardSections(parseOsu(mapWith(walk, [`0,${beat},4,2,0,60,1,0`]))).some((s) => s.kind.includes('jump')), '比平时大一点的走位也不是大跳');
  // 结尾那种：连着 16 下 360px → 报这一段；CS 多大都一样（看的是屏幕上的距离）
  const withBig = Array.from({ length: 200 }, (_, i) => zigzag(i, i >= 150 && i < 166 ? 360 : 280));
  for (const cs of [2, 4, 6]) {
    const big = findHardSections(parseOsu(mapWith(withBig, [`0,${beat},4,2,0,60,1,0`], cs))).filter((s) => s.kind === 'jump');
    assert.equal(big.length, 1, JSON.stringify(big));
    assert.ok(Math.abs(big[0].start - at(150)) <= beat, `CS${cs} 报的是 360px 的那一段`);
  }
  // 门槛附近：一组里只有零星几下过 320px（普通跳里偶尔一下大的）不算；连不到 6 下不算
  const sparse = Array.from({ length: 200 }, (_, i) => zigzag(i, i % 4 === 0 ? 340 : 280));
  assert.ok(!findHardSections(parseOsu(mapWith(sparse, [`0,${beat},4,2,0,60,1,0`]))).some((s) => s.kind === 'jump'), '零星几下大的不算');
  const short = Array.from({ length: 200 }, (_, i) => zigzag(i, i >= 150 && i < 153 ? 400 : 280)); // 前后各带一下 340px，一共 4 下过线
  assert.ok(!findHardSections(parseOsu(mapWith(short, [`0,${beat},4,2,0,60,1,0`]))).some((s) => s.kind === 'jump'), '只有 4 下大的不算一段');
  // 慢的不算：100 BPM 的 1/2 拍（两下隔 300ms）就算挪 440px 也是慢慢挪过去
  const slowBeat = 60000 / 100;
  // 前 40 下是小间距（开头来不及报的段不要），后面 440px 来回
  const slow = Array.from({ length: 120 }, (_, i) => `${i < 40 ? 256 + (i % 2) * 30 : i % 2 ? 476 : 36},192,${Math.round(5000 + i * slowBeat / 2)},1,0`);
  assert.ok(!findHardSections(parseOsu(mapWith(slow, [`0,${slowBeat},4,2,0,60,1,0`]))).some((s) => s.kind === 'jump'), '慢悠悠的大间距不算大跳');
  // 同一张慢图开 DT（真实间隔 200ms）：算
  assert.ok(findHardSections(parseOsu(mapWith(slow, [`0,${slowBeat},4,2,0,60,1,0`])), { rate: 1.5 }).some((s) => s.kind === 'jump'), '开 DT 快起来就算');
}
{
  // 门槛一个个卡住（复核发现原来的测试把门槛改成 290 或 345 都照样过）。223 BPM 的 1/2 拍 = 135ms。
  const beat = 60000 / 223;
  const timing = [`0,${beat},4,2,0,60,1,0`];
  const at = (i) => Math.round(5000 + i * beat / 2);
  // 前 150 下普通走位（120px），第 151 下起 n 下每下挪 pxOf(i)（左右来回），后面再普通走位
  const build = (n, px, { pxOf = () => px } = {}) => {
    const objs = [];
    let x = 256;
    for (let i = 0; i < 300; i += 1) {
      const big = i > 150 && i <= 150 + n;
      const d = big ? pxOf(i) : 120;
      x = x > 256 ? x - d : x + d;
      objs.push(`${Math.round(x)},192,${at(i)},1,0`);
    }
    return findHardSections(parseOsu(mapWith(objs, timing))).filter((s) => s.kind === 'jump');
  };
  assert.equal(build(12, 360).length, 1, '12 下 360px：是');
  assert.equal(build(12, 340).length, 0, '每下都过 320 但整段中位 340 < 350：普通跳');
  assert.equal(build(6, 400).length, 1, '正好 6 下：是');
  assert.equal(build(5, 400).length, 0, '5 下：不够');
  // 中间夹一下小的不断；「大 小 大 小」交替的不算（复核发现原来会被连成一段）
  assert.equal(build(13, 0, { pxOf: (i) => (i === 157 ? 200 : 400) }).length, 1, '夹一下小的照样是一段');
  assert.equal(build(16, 0, { pxOf: (i) => (i % 2 ? 380 : 280) }).length, 0, '大小交替不是大跳段');
  // 真实间隔：240ms 挪 520px（每毫秒 2.2px）算，260ms 不算（BIG_JUMP_MAX_GAP_MS）；同样 240ms 只挪 400px 太慢（每毫秒 1.7px）不算
  const slowBeat = 60000 / 125; // 1/2 拍 = 240ms
  const wide = (beatMs, px) => {
    const objs = Array.from({ length: 120 }, (_, i) => `${i < 40 ? 256 + (i % 2) * 30 : i % 2 ? 256 + px / 2 : 256 - px / 2},192,${Math.round(5000 + i * beatMs / 2)},1,0`);
    return findHardSections(parseOsu(mapWith(objs, [`0,${beatMs},4,2,0,60,1,0`]))).some((s) => s.kind === 'jump');
  };
  assert.equal(wide(slowBeat, 500), true, '240ms 挪 500px');
  assert.equal(wide(60000 / 115, 500), false, '260ms 太久了');
  assert.equal(wide(slowBeat, 400), false, '240ms 挪 400px 太慢');
  // 不按拍子卡：1/4 拍挪 380px 一样是大跳（150 BPM 的 1/4 拍 = 100ms，快到够串的速度），也不说成串
  const q = 60000 / 150;
  const quarterJumps = Array.from({ length: 120 }, (_, i) => `${i < 40 ? 256 + (i % 2) * 30 : i % 2 ? 446 : 66},192,${Math.round(5000 + i * q / 4)},1,0`);
  const qs = findHardSections(parseOsu(mapWith(quarterJumps, [`0,${q},4,2,0,60,1,0`])));
  assert.deepEqual(qs.map((s) => s.kind), ['jump'], JSON.stringify(qs));
  // 距离从滑条真正的尾巴量（core/slider-path.js）：1/4 拍的滑条（长度 1.4×100×1/4 = 35px）从 x=60 往右拉，尾巴在 x=95。
  // 控制点写在 x=430 也一样（长度只有 35，拉不到那么远）：原来拿控制点当尾巴，会把只挪 15px 的算成 320px 的大跳。
  const sliderJumps = (next, ctrlX) => {
    const objs = [];
    for (let i = 0; i < 40; i += 1) objs.push(`${256 + (i % 2) * 30},192,${at(i)},1,0`);
    for (let k = 0; k < 10; k += 1) {
      objs.push(`60,192,${at(40 + k * 2)},2,0,L|${ctrlX}:192,1,35`);
      objs.push(`${next},192,${at(41 + k * 2)},1,0`);
    }
    for (let i = 60; i < 120; i += 1) objs.push(`${256 + (i % 2) * 30},192,${at(i)},1,0`);
    return findHardSections(parseOsu(mapWith(objs, timing))).some((s) => s.kind === 'jump');
  };
  assert.equal(sliderJumps(470, 95), true, '尾巴到下一下 375px');
  assert.equal(sliderJumps(110, 430), false, '尾巴到下一下只有 15px（控制点远也不算）');
}
{
  // 串里的滑条、红线写成一半 BPM 的图（2026-11-21 用户拿 Paella [ancel's Delicatessen Extra] 问「这种滑条为什么被认成串」）
  const filler = (from, to, beat) => { const o = []; for (let t = from; t < to; t += beat) o.push(`${256 + (o.length % 2) * 40},192,${Math.round(t)},1,0`); return o; };
  const streamOf = (objs, beat) => findHardSections(parseOsu(mapWith(objs, [`0,${beat},4,2,0,60,1,0`]))).filter((s) => s.kind === 'stream');
  // 一串 kick 滑条：每 1/4 拍一个、每个按住 1/8 拍（长度 1.4×100×1/8 = 17.5）→ 不是串
  const kicks = [...filler(1000, 9000, BEAT), ...Array.from({ length: 20 }, (_, i) => `${200 + (i % 4) * 20},200,${Math.round(10000 + i * BEAT / 4)},2,0,L|${215 + (i % 4) * 20}:200,1,17.5`), ...filler(12000, 30000, BEAT)];
  assert.deepEqual(streamOf(kicks, BEAT), [], '一串滑条不是串');
  // 串的头尾是滑条可以：滑条起头、20 下圈、滑条收尾 → 还是串，从滑条那下算起
  const ends = [...filler(1000, 9000, BEAT), `200,200,10000,2,0,L|215:200,1,17.5`, ...Array.from({ length: 20 }, (_, i) => `${200 + (i % 4) * 15},200,${Math.round(10000 + (i + 1) * BEAT / 4)},1,0`), `260,200,${Math.round(10000 + 21 * BEAT / 4)},2,0,L|300:200,1,70`, ...filler(13000, 30000, BEAT)];
  const s = streamOf(ends, BEAT);
  assert.equal(s.length, 1, JSON.stringify(s));
  assert.deepEqual([s[0].start, s[0].count], [10000, 22]);
  // 前一下和滑条也在节奏里（圈、滑条、11 个圈，一样的间隔）：滑条照样当串的开头（复核发现原来这下被丢了，串从后一下才算）
  const { findStreams } = await import('../core/patterns.js');
  const lead = parseOsu(mapWith([`100,200,9917,1,0`, `120,200,10000,2,0,L|130:200,1,10`, ...Array.from({ length: 11 }, (_, i) => `${140 + (i % 4) * 15},200,${Math.round(10000 + (i + 1) * BEAT / 4)},1,0`)]));
  assert.deepEqual(findStreams(lead.objects, 1, () => false, 32).map((x) => [x.start, x.count]), [[10000, 12]]);
  // 红线写成 110 BPM 的 220 BPM 歌：谱面上的「1/4 拍」真实 136ms 一下 → 不是串；真的串（谱面 1/8 拍、68ms 一下）照认
  const half = 60000 / 110;
  const slow = [...filler(1000, 9000, half), ...Array.from({ length: 24 }, (_, i) => `${200 + (i % 4) * 15},200,${Math.round(10000 + i * half / 4)},1,0`), ...filler(14000, 30000, half)];
  assert.deepEqual(streamOf(slow, half), [], '136ms 一下的不是串');
  const real = [...filler(1000, 9000, half), ...Array.from({ length: 24 }, (_, i) => `${200 + (i % 4) * 15},200,${Math.round(10000 + i * half / 8)},1,0`), ...filler(14000, 30000, half)];
  assert.equal(streamOf(real, half).length, 1, '68ms 一下的是串');
}
{
  // 串的样子（2026-11-21 用户：「能区分 space stream、cut stream 之类的区别吗」）。CS4 半径 36.5px。
  const { streamShape, findStreams } = await import('../core/patterns.js');
  const R = 54.4 - 4.48 * 4;
  // 按每下的位移造一条 24 下的 1/4 拍串，看认成什么
  const shapeOf = (steps) => {
    let x = 100;
    let y = 200;
    const objs = [`${x},${y},10000,1,0`];
    steps.forEach(([dx, dy], i) => { x += dx; y += dy; objs.push(`${Math.round(x)},${Math.round(y)},${Math.round(10000 + (i + 1) * BEAT / 4)},1,0`); });
    const s = findStreams(parseOsu(mapWith(objs)).objects, 1, () => false, R);
    return s.length === 1 ? s[0].sub : `找到 ${s.length} 条`;
  };
  const line = (d, n = 23) => Array.from({ length: n }, () => [d, 0]);
  assert.equal(shapeOf(line(1.2 * R)), 'normal', '1.2 个半径：普通的串');
  assert.equal(shapeOf(line(2.2 * R)), 'normal', '2.2 个半径（圆刚挨着）：还不算宽');
  assert.equal(shapeOf(line(2.6 * R)), 'spaced', '2.6 个半径：宽间距串');
  assert.equal(shapeOf(line(0.1 * R)), 'stacked', '叠在一起');
  // 四个一组，组和组之间跳 5 个半径（中位 1 个半径）：断开的串
  assert.equal(shapeOf(Array.from({ length: 23 }, (_, i) => [i % 4 === 3 ? 5 * R : R, 0])), 'cut', '四个一组中间跳');
  // 只有零星一下大的：不算断开（至少两下、而且隔得有规律）
  assert.equal(shapeOf(Array.from({ length: 23 }, (_, i) => [i === 11 ? 5 * R : R, 0])), 'normal', '只断一下');
  // 越拉越开（后面几下连着都很大）：不是有规律的切口
  assert.equal(shapeOf(Array.from({ length: 23 }, (_, i) => [i >= 19 ? 5 * R : R, 0])), 'normal', '最后几下连着拉开不算断开');
  // 3.5 个半径、来回横跳（每下转 180°）：来回跳的串；同样间距一直往前走：宽间距串
  assert.equal(shapeOf(Array.from({ length: 23 }, (_, i) => [i % 2 ? -3.5 * R : 3.5 * R, 0])), 'jumpy', '来回跳');
  assert.equal(shapeOf(Array.from({ length: 23 }, (_, i) => [3.5 * R * Math.cos(i * 0.3), 3.5 * R * Math.sin(i * 0.3)])), 'spaced', '绕圈走的宽串');
  assert.equal(streamShape([], []), 'normal');
  // 叠着的四连一组组往前走（复核发现原来组间 1.5 个半径是「普通」、2 个半径以上就成了「断开」）
  const quads = (gap) => Array.from({ length: 23 }, (_, i) => [i % 4 === 3 ? gap * R : 0.05 * R, 0]);
  assert.equal(shapeOf(quads(1.5)), 'stacked', '叠着的四连，组和组挨着');
  assert.equal(shapeOf(quads(2)), 'stacked', '组和组隔 2 个半径（圆刚挨着）也还是叠串');
  assert.equal(shapeOf(quads(3.5)), 'cut', '组和组隔 3.5 个半径：几个一组中间要跳');
  assert.equal(shapeOf(Array.from({ length: 23 }, (_, i) => [i % 4 === 3 ? 0.4 * R : 0.1 * R, 0])), 'stacked', '几乎全叠着');
  // 切口和前后几下比，不和整条串比（2026-11-21 用户：K8107 [Red Another] 0:42.043 是标准的 cut stream）：
  // 叠着的四连之间跳 2.7 个半径，中间夹七下 1.16 个半径的（整条串的中位被抬高，原来一个切口都认不出）
  const k8107 = [...[0.15, 0.15, 0.15, 2.6], ...[0.15, 0.15, 0.15, 2.9], ...Array(7).fill(1.16), 2.5, ...[0.2, 0.2, 0.2, 2.8], ...[0.2, 0.2, 0.2, 2.8]].map((d) => [d * R, 0]);
  assert.equal(shapeOf(k8107), 'cut', 'K8107 那种断开的串');
  // 宽间距串末尾夹两个叠着的：前后那两下不算切口，还是宽间距（全库抽查时 Aquarion [Full Rush] 0:56.9 被误认成断开）
  assert.equal(shapeOf([...Array(19).fill(2.5), 2.8, 0, 2.7, 0].map((d) => [d * R, 0])), 'spaced', '宽串末尾的叠二连');
  // 叠着的二连之间跳 3.5 个半径：两个一组的断开；大间距来回跳里夹几个叠着的二连：还是来回跳
  assert.equal(shapeOf(Array.from({ length: 23 }, (_, i) => [i % 2 ? 3.5 * R : 0, 0])), 'cut', '二连 跳 二连 跳');
  assert.equal(shapeOf(Array.from({ length: 23 }, (_, i) => [(i % 2 ? -1 : 1) * (i >= 8 && i < 16 && i % 2 ? 0 : 4.2 * R), 0])), 'jumpy', '来回跳里夹叠着的');
  // 一大段长串（几截并起来）中间有一截断开的：两样都说
  assert.equal(cueOf({ kind: 'stream', count: 100, sub: 'cut', mixed: true }), CUE_PHRASES.streamLongCut);
  assert.equal(cueOf({ kind: 'stream', count: 30, sub: 'cut', mixed: true }), CUE_PHRASES.streamCut, '不长：就说断开的串');
  assert.equal(cueOf({ kind: 'stream', count: 100, sub: 'cut' }), CUE_PHRASES.streamCut, '整段都是断开的：说断开的串');
  // 并起来的几截串：样子一样才说那个样子；真实时长只算串本身（中间歇的不算）
  const twoStreams = (gapMs, xStep2) => {
    const objs = [];
    for (let t = 1000; t < 9000; t += BEAT) objs.push(`${256 + (objs.length % 2) * 40},192,${Math.round(t)},1,0`);
    let x = 60;
    for (let i = 0; i < 30; i += 1) { objs.push(`${Math.round(x)},200,${Math.round(10000 + i * BEAT / 4)},1,0`); x += 1.2 * R / 3; }
    const t2 = 10000 + 29 * BEAT / 4 + gapMs;
    x = 60;
    for (let i = 0; i < 30; i += 1) { objs.push(`${Math.round(x)},300,${Math.round(t2 + i * BEAT / 4)},1,0`); x += xStep2; }
    for (let t = t2 + 30 * BEAT / 4 + 4000; t < t2 + 20000; t += BEAT) objs.push(`${256 + (objs.length % 2) * 40},192,${Math.round(t)},1,0`);
    return findHardSections(parseOsu(mapWith(objs))).filter((s) => s.kind === 'stream');
  };
  const pair = twoStreams(2700, 1.2 * R / 3);
  assert.equal(pair.length, 1, JSON.stringify(pair));
  assert.ok(pair[0].count === 60 && pair[0].durReal < 8000, JSON.stringify(pair[0]));
  assert.equal(cueOf(pair[0]), CUE_PHRASES.stream, '两段 30 下中间歇一下，不是「一大段长串」');
  assert.equal(twoStreams(2700, 0.05 * R)[0].sub, 'normal', '一截普通、一截叠着：并起来当普通的串');
  // 一截普通、一截宽间距（30 下、2.6 个半径）：并起来说「中间有一段间距很大」那一截
  const withSpaced = twoStreams(2700, 2.6 * R)[0];
  assert.deepEqual([withSpaced.sub, withSpaced.mixed], ['spaced', true], JSON.stringify(withSpaced));
  // 报出来的难段带着样子，提醒照样子说
  const objs = [];
  for (let t = 1000; t < 9000; t += BEAT) objs.push(`${256 + (objs.length % 2) * 40},192,${Math.round(t)},1,0`);
  let x = 60;
  for (let i = 0; i < 24; i += 1) { objs.push(`${Math.round(x)},200,${Math.round(10000 + i * BEAT / 4)},1,0`); x += i % 4 === 3 ? -3 * R : R; }
  for (let t = 14000; t < 30000; t += BEAT) objs.push(`${256 + (objs.length % 2) * 40},192,${Math.round(t)},1,0`);
  const sec = findHardSections(parseOsu(mapWith(objs))).find((s) => s.kind === 'stream');
  assert.deepEqual([sec?.sub, cueOf(sec)], ['cut', CUE_PHRASES.streamCut], JSON.stringify(sec));
}
{
  // 一条长串中间夹了几个 kick 滑条（间隔超过 250ms 被切成两截）：提示要在整串之前，不能在前一截打到一半时响
  const objs = [];
  for (let t = 1000; t < 9000; t += BEAT / 2) objs.push(`256,192,${Math.round(t)},1,0`);
  for (let i = 0; i < 20; i += 1) objs.push(`200,200,${Math.round(10000 + i * BEAT / 4)},1,0`);
  for (let k = 0; k < 3; k += 1) objs.push(`200,200,${Math.round(11700 + k * 320)},2,0,L|230:200,1,35`);
  for (let i = 0; i < 40; i += 1) objs.push(`200,200,${Math.round(12700 + i * BEAT / 4)},1,0`);
  for (let t = 17000; t < 40000; t += BEAT / 2) objs.push(`256,192,${Math.round(t)},1,0`);
  const secs = findHardSections(parseOsu(mapWith(objs)));
  assert.equal(secs.filter((s) => s.kind === 'stream').length, 1, JSON.stringify(secs));
  assert.equal(secs.find((s) => s.kind === 'stream').start, 10000, '从第一截开始');
}
{
  // 变速：中间那条没有物件的红线不算（123 → 空的 162 → 128：其实没变速）
  const objs = [];
  const b1 = 60000 / 123;
  const b3 = 60000 / 128;
  for (let t = 1000; t < 20000; t += b1 / 2) objs.push(`256,192,${Math.round(t)},1,0`);
  for (let t = 22000; t < 40000; t += b3 / 2) objs.push(`256,192,${Math.round(t)},1,0`);
  const secs = findHardSections(parseOsu(mapWith(objs, [`0,${b1},4,2,0,60,1,0`, `20500,${60000 / 162},4,2,0,60,1,0`, `22000,${b3},4,2,0,60,1,0`])), { max: 8 });
  assert.ok(!secs.some((s) => s.kind === 'speed'), JSON.stringify(secs));
}
{
  // 带大故事板的图：[Events] 剥掉、只留休息段，照常解析
  const sb = Array.from({ length: 5000 }, (_, i) => `Sprite,Foreground,Centre,"sb/${i}.png",320,240`).join('\n');
  const text = makeMap().replace('[Events]', `[Events]\n${sb}\n2,20500,24000`);
  const p = parseOsu(text);
  assert.deepEqual(p.breaks, [{ start: 20500, end: 24000 }]);
  assert.equal(p.objects.length, parseOsu(makeMap()).objects.length);
}

// ── 难度曲线补难段（2026-11-21：tosu 的 performance.graph） ─────────────────────────
{
  const { findStrainPeaks } = await import('../core/patterns.js');
  // 造一条曲线，照 tosu 的样子：片头两段是填充（-100，时间 0、400），第一段真数据正好在第一个物件（1000ms），之后每 400ms 一段；
  // 平时 1，hot 里的几段改成别的值。第 i 段（i ≥ 2）的时间 = first + (i - 2) × 400
  const curve = ({ aimHot = {}, speedHot = {}, until = 70000, first = 1000 } = {}) => {
    const xaxis = [];
    const aim = [];
    const speed = [];
    for (let i = 0; i < 2 || first + (i - 2) * 400 < until; i += 1) {
      xaxis.push(i < 2 ? i * 400 : first + (i - 2) * 400);
      aim.push(i < 2 ? -100 : aimHot[i] ?? 1 + (i % 3) * 0.05);
      speed.push(i < 2 ? -100 : speedHot[i] ?? 0.9);
    }
    return { series: [{ name: 'aim', data: aim }, { name: 'aimNoSliders', data: aim }, { name: 'reading', data: aim.map(() => 0) }, { name: 'speed', data: speed }], xaxis };
  };
  const hot = (from, n, v) => Object.fromEntries(Array.from({ length: n }, (_, k) => [from + k, v]));
  // 60.2 秒那里（第 150 段起）连着 5 段 aim 很高 → 一个 aim 高峰
  const p = findStrainPeaks(curve({ aimHot: hot(150, 5, 4) }));
  assert.equal(p.length, 1, JSON.stringify(p));
  assert.deepEqual([p[0].start, p[0].end, p[0].sub], [60200, 62200, 'aim']);
  assert.ok(p[0].strength > 2, String(p[0].strength));
  assert.equal(findStrainPeaks(curve({ speedHot: hot(150, 5, 5) }))[0].sub, 'speed', '手速那条高：手速高峰');
  assert.equal(findStrainPeaks(curve({ aimHot: hot(150, 2, 4) })).filter((x) => x.start === 60200).length, 0, '只有两段（0.8 秒）不算');
  assert.equal(findStrainPeaks(curve({ aimHot: hot(150, 5, 4) }), { rate: 1.5 })[0].start, 90300, '开 DT：真实时间乘回倍速才是谱面时间');
  assert.deepEqual(findStrainPeaks(null), []);
  assert.deepEqual(findStrainPeaks({ series: [], xaxis: [] }), []);

  // 合进难段：60 秒（规则没认出东西）→ 补一段 aim 难点；45 秒（大跳那段）的高峰 → 给大跳加分，不另起一段
  const parsed = parseOsu(MAP_TEXT);
  const base = findHardSections(parsed);
  const peaksAt = (fromIdx) => findStrainPeaks(curve({ aimHot: hot(fromIdx, 5, 4) }));
  const withPeak = findHardSections(parsed, { peaks: peaksAt(150) });
  const peakSec = withPeak.find((s) => s.kind === 'peak');
  assert.ok(peakSec && peakSec.start === 60200 && peakSec.sub === 'aim', JSON.stringify(withPeak));
  assert.equal(cueOf(peakSec), CUE_PHRASES.peakAim);
  assert.equal(cueOf({ kind: 'peak', sub: 'speed' }), CUE_PHRASES.peakSpeed);
  assert.equal(cueOf({ kind: 'peak', sub: 'reading' }), CUE_PHRASES.peakReading);
  // 曲线高峰只补空位，不挤掉认出来的长串和大跳（复核发现：高峰分数没上限，33 秒一个高峰挤掉了 25 秒的串和 45 秒的大跳）
  const strong = findHardSections(parsed, { peaks: findStrainPeaks(curve({ aimHot: hot(82, 5, 20) })) }); // 33.8 秒，很强
  assert.ok(strong.some((s) => s.kind === 'stream') && strong.some((s) => s.kind === 'jump'), JSON.stringify(strong));
  const boosted = findHardSections(parsed, { peaks: peaksAt(112) }); // 45 秒起，压在大跳上
  const jumpBase = base.find((s) => s.kind === 'jump');
  const jumpBoost = boosted.find((s) => s.kind === 'jump');
  assert.ok(jumpBoost.severity > jumpBase.severity && jumpBoost.peak === true, '和大跳重叠：加分');
  assert.ok(!boosted.some((s) => s.kind === 'peak'), '重叠的不另起一段');

  // 难段预告：选歌时曲线到了、对得上这张图 → 补上 60 秒那段；对不上（别的图的曲线）不用；开打以后才到的不中途改
  const r = rig();
  r.h.onFrame(r.snap('select', 0), null);
  await r.tick();
  assert.ok(!r.h.status().map.sections.some((s) => s.kind === 'peak'));
  r.h.onFrame(r.snap('select', 0, { graph: curve({ aimHot: hot(150, 5, 4), until: 200000 }) }), null);
  assert.ok(!r.h.status().map.sections.some((s) => s.kind === 'peak'), '曲线长度对不上这张图（换图时还是上一张的）：不用');
  // 同一个谱面集的别的难度：结尾差不多，但第一个物件差 2 秒 → 不用（复核发现只看结尾会被骗、还会锁死）
  r.h.onFrame(r.snap('select', 0, { graph: curve({ aimHot: hot(82, 5, 4), first: 3000, until: 72000 }) }), null);
  assert.ok(!r.h.status().map.sections.some((s) => s.kind === 'peak'), '第一个物件对不上：不用');
  r.h.onFrame(r.snap('select', 0, { graph: curve({ aimHot: hot(150, 5, 4) }) }), null);
  const sec = r.h.status().map.sections.find((s) => s.kind === 'peak');
  assert.ok(sec && sec.start === 60200 && sec.cue === CUE_PHRASES.peakAim, JSON.stringify(r.h.status().map.sections));
  assert.ok(r.calls.logs.some((l) => l.includes('按 tosu 的难度曲线补过')));
  // 开打前曲线又变了（tosu 重算过）：按新的再算一次
  r.h.onFrame(r.snap('select', 0, { graph: curve({ speedHot: hot(150, 5, 5) }) }), null);
  assert.equal(r.h.status().map.sections.find((s) => s.kind === 'peak')?.cue, CUE_PHRASES.peakSpeed, '曲线换了：重算');
  const r2 = rig();
  r2.h.onFrame(r2.snap('select', 0), null);
  await r2.tick();
  r2.play(1000, 3000);
  r2.h.onFrame(r2.snap('play', 3150, { graph: curve({ aimHot: hot(150, 5, 4) }) }), { replay: false }, r2.clock + 150);
  assert.ok(!r2.h.status().map.sections.some((s) => s.kind === 'peak'), '开打以后才到：不中途改');
}

console.log('heads-up: ok');
