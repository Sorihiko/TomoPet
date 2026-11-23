/**
 * 看你打 osu! 的服务（core/watch.js）。照搬 SurfCore plugins/surfcore/scripts/test-osu-watch.mjs 的 3–7 段，
 * 桩换成本项目的依赖（人设 / 模型 / 语音 / 字幕窗口 / 桌面角色 / 小结）。
 *
 * 不连真的 tosu、不调真的模型和语音：喂假的对局数据，用假的依赖。数据目录在临时文件夹里。
 * 钉住的事：
 *   1. 说给模型听的话（describeEvent / mapDetail / 尺子 / 他她TA）。
 *   2. 什么时候开口、什么时候闭嘴：间隔、每首上限、每天上限、过时丢弃、排队；说了没人看见 / 听见时不调模型。
 *   3. 字幕 / 气泡 / 只念 三种输出；语音失败只出字；OBS counter 同步。
 *   4. 成绩落盘；一场打完只记一条小结。
 *   5. 只连本机的 tosu；连不上要在状态里说清楚怎么办。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-watch-'));
process.env.OSU_PET_HOME = sandbox;
const watch = await import('../core/watch.js');
const { DEFAULTS } = await import('../core/config.js');
// 这些测试按原来那套说话频率写的（2026-11-22 默认值改成了用户给的那套：间隔 10 秒、每首 10 句、念出来……），这里固定住原来的值
const TEST_WATCH = { output: 'subtitle', voice: false, minGapSec: 40, perSongMax: 3, dailyLimit: 150, headsUp: 'off', headsUpMax: 4 };
const { normalizeSnapshot } = await import('../core/events.js');
const { frame, kinds } = await import('./fixtures.mjs');
const PLAYS = path.join(sandbox, 'plays.json');
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 1. 说给模型听的话 ────────────────────────────────────────────────────────
const event = (kind, extra = {}) => ({
  kind, at: 0, replay: false, retries: 0, progress: 0.5, acc: 97.42, miss: 2, combo: 0, peakCombo: 486, mods: 'HD',
  map: { title: 'SONG_TITLE', artist: 'ARTIST', version: 'Insane', stars: 4.83, maxCombo: 800 }, ...extra,
});
{
  const finish = watch.describeEvent(event('finish', { rank: 'A', pp: 151, progress: 1 }));
  for (const wanted of ['他打完了《SONG_TITLE》 [Insane]', '开了 HD，算上 mod 是 4.83 星', '评级 A', '97.42%', '486 / 800', 'miss 2 个', '151pp']) assert.ok(finish.includes(wanted), `缺「${wanted}」：${finish}`);
  assert.ok(watch.describeEvent(event('finish', { fullCombo: true })).includes('全连'));
  assert.ok(watch.describeEvent(event('combo-break', { lostCombo: 312 })).includes('312 连断了（打到 50%）'));
  // 模型省掉了连击数的单位（2026-11-20 真机气泡：「啊 998 断了」）：补上 combo；带了单位的、别的数不动。
  {
    const cb = { kind: 'combo-break', lostCombo: 998 };
    const cases = [
      ['啊 998 断了', '啊 998 combo 断了'], ['998断了', '998 combo 断了'], ['啊998！', '啊998 combo！'], ['998', '998 combo'],
      ['998 连断了', '998 连断了'], ['998连没了', '998连没了'], ['998combo 没了', '998combo 没了'], ['998 Combo', '998 Combo'], ['连击 998 就断', '连击 998 就断'],
      ['可惜 998x', '可惜 998x'], ['1998 年的歌', '1998 年的歌'], ['9980 分', '9980 分'], ['99.8% 还行', '99.8% 还行'], ['998 和 998', '998 combo 和 998 combo'],
    ];
    for (const [input, out] of cases) assert.equal(watch.unitizeCombo(input, cb), out, input);
    assert.equal(watch.unitizeCombo('刚过 500 稳住', { kind: 'combo', mark: 500 }), '刚过 500 combo 稳住');
    assert.equal(watch.unitizeCombo('998 断了', { kind: 'finish' }), '998 断了', '别的时刻不动');
    assert.equal(watch.unitizeCombo('998 断了', { kind: 'combo-break', lostCombo: null }), '998 断了');
  }
  assert.ok(watch.describeEvent(event('combo', { mark: 500 })).includes('连击刚过 500'));
  assert.ok(watch.describeEvent(event('retry', { retries: 6, before: { progress: 0.8, acc: 95, miss: 4 } })).includes('第 6 次重开') && watch.describeEvent(event('retry', { retries: 6, before: { progress: 0.8 } })).includes('打到 80%'));
  assert.ok(watch.describeEvent(event('fail')).includes('没血了'));
  assert.ok(watch.describeEvent(event('quit')).includes('打到一半退出了'));
  assert.ok(watch.describeEvent(event('start', { retries: 3 })).includes('已经重开了 3 次'));
  assert.equal(watch.describeEvent({ kind: 'unknown', map: {} }), '');
  // 他 / 她 / TA：玩家的称呼在设置里改。
  assert.ok(watch.describeEvent(event('fail'), { pronoun: '她' }).startsWith('她打《SONG_TITLE》'));
  assert.ok(watch.describeEvent(event('finish', { multi: true, place: { rank: 2, players: 8 } }), { pronoun: 'TA' }).includes('TA排第 2'));
  // 滑条断要说清楚；全连没了要说出来（用户：「我 sliderbreak 之后她没反应」）。
  const text = watch.describeEvent({ kind: 'combo-break', map: { title: 'T', version: '', stars: 5.58, maxCombo: 732 }, mods: '', progress: 0.4, lostCombo: 80, sliderBreak: true, fcLost: true, acc: 99.1, miss: 0 });
  assert.ok(text.includes('80 连断在了滑条上') && text.includes('全连（FC）就没了'), text);
  assert.ok(!watch.describeEvent({ kind: 'combo-break', map: { title: 'T' }, lostCombo: 80, sliderBreak: false, fcLost: false, acc: 99, miss: 1 }).includes('滑条'));
  // 星数是算上 mod 之后的（用户：「我开完 dt 才 7.12 星，她以为我拿 7.12 星开 dt」）。
  const dt = watch.describeEvent(event('start', { mods: 'DT', map: { title: 'DT_MAP', version: 'Hard', stars: 7.12, maxCombo: 900 } }));
  assert.ok(dt.includes('《DT_MAP》 [Hard]，开了 DT，算上 mod 是 7.12 星') && !dt.includes('7.12 星，开了'), dt);
  const nomod = watch.describeEvent(event('start', { mods: '', map: { title: 'NM_MAP', version: '', stars: 5.4, maxCombo: 900 } }));
  assert.ok(nomod.includes('《NM_MAP》，5.4 星') && !nomod.includes('算上 mod'), nomod);
  assert.ok(watch.describeEvent(event('start', { mods: 'HR', map: { title: 'X', version: '', stars: 0, maxCombo: 0 } })).includes('《X》，开了 HR'), '读不到星数时只说 mod');

  // BPM / AR / CS 和主人自己的尺子（默认值就是用户给的：「240bpm 很快我点不动，140 比较慢」「ar9 以上是普通，9 以下算慢」）。
  assert.deepEqual([240, 230, 210, 180, 150, 140, 0].map((v) => watch.bpmFeel(v)), ['很快，他自己说过 240 左右就点不动了', '很快，他自己说过 240 左右就点不动了', '偏快', '中等', '偏慢', '偏慢', '']);
  // AR：10 以下越低越难读，10 以上才是越高越难（2026-11-20 用户纠正）——「慢 / 快」后面直接写上难不难，不让模型从「偏慢」推出「好打」。
  const AR_SLOW = '偏慢（他觉得 9 以下就算慢；AR 10 以下是越低越难读，这个 AR 更难读）';
  const AR_FAST = '偏快（AR 10 以上越高越难）';
  assert.deepEqual([4.5, 8.5, 9, 9.4, 10, 10.3, 11, 0].map((v) => watch.arFeel(v)), [AR_SLOW, AR_SLOW, '普通', '普通', '普通', AR_FAST, AR_FAST, '']);
  for (const low of [4.5, 8.5]) assert.ok(!/简单|好打|容易/.test(watch.arFeel(low)) && watch.arFeel(low).includes('更难'), 'AR 低不能被说成简单');
  assert.equal(watch.bpmFeel(240, 0), '很快，他自己说过 240 左右就点不动了', '第二个参数不是对象时用默认尺子（防 [].map(bpmFeel)）');
  // 尺子可以改（开源后别人的手感不一样）。
  const mine = { ...DEFAULTS.rulers, bpmVeryFast: 260, bpmVeryFastNote: '', bpmFast: 220, arSlowBelow: 8 };
  assert.deepEqual([240, 260, 210].map((v) => watch.bpmFeel(v, mine)), ['偏快', '很快', '中等']);
  assert.equal(watch.arFeel(8.5, mine), '普通');
  // 难度的分界固定是 10（游戏本身的规律），不跟尺子走；尺子只决定叫不叫「偏慢 / 偏快」。
  assert.equal(watch.AR_PIVOT, 10);
  const loose = { ...DEFAULTS.rulers, arFastAbove: 10.5 };
  assert.deepEqual([watch.arFeel(10.2, loose), watch.arFeel(10.8, loose), watch.arFeel(7, loose)], ['普通', AR_FAST, AR_SLOW], '把「偏快」那条线挪到 10.5：说给她听的规律还是 AR 10');
  assert.equal(watch.arFeel(9.8, { ...DEFAULTS.rulers, arFastAbove: 9.5 }), '偏快', '觉得 9.5 以上就快：可以叫偏快，但 10 以下不说「越高越难」');
  assert.equal(watch.arFeel(10.5, { ...DEFAULTS.rulers, arSlowBelow: 10.8, arFastAbove: 11 }), '偏慢（他觉得 10.8 以下就算慢）', '10 以上觉得慢：只说慢，不说「越低越难」');
  // 尺子自相矛盾（慢的线比快的线还高）时先认「偏慢」，和改之前一样。
  assert.ok(watch.arFeel(8.5, { ...DEFAULTS.rulers, arSlowBelow: 9, arFastAbove: 8 }).startsWith('偏慢'));
  // 新加的说明里不带人称：称呼设成「她 / TA」时不会多出一个对不上的「他」。
  assert.ok(!AR_SLOW.split('；')[1].includes('他') && !AR_FAST.includes('他'));
  assert.equal(watch.mapDetail({ bpm: 140, bpmMin: 140, bpmMax: 140, ar: 8.5, arOriginal: 8.5, cs: 4, csOriginal: 4, rate: 1 }, ''), `BPM 140，偏慢；AR 8.5，${AR_SLOW}；CS 4`);
  // 开了 DT：BPM 和 AR 已经是算上 mod 的，说明白；AR 带上原值。
  assert.equal(watch.mapDetail({ bpm: 240, bpmMin: 240, bpmMax: 240, ar: 10.3, arOriginal: 9, cs: 4, csOriginal: 4, rate: 1.5 }, 'DT'), `BPM 240（算上 DT），很快，他自己说过 240 左右就点不动了；AR 10.3（不开 mod 是 9），${AR_FAST}；CS 4`);
  // EZ 是增加难度的 mod，不是降低难度（2026-11-20 用户纠正）。开了 EZ 星数会变小、AR 会变低，模型最容易说反——所以图的描述里直接写明。
  assert.deepEqual(['EZ', 'HDEZ', 'EZDT', 'ez', 'HD,EZ', 'HD EZ'].map((m) => watch.hasMod(m, 'EZ')), [true, true, true, true, true, true]);
  assert.deepEqual(['', 'HD', 'HDDT', 'HR', null, undefined, 'NFSO'].map((m) => watch.hasMod(m, 'EZ')), [false, false, false, false, false, false, false]);
  const EZ_MAP = { title: 'EZ_MAP', version: 'Insane', stars: 3.9, maxCombo: 900, bpm: 180, bpmMin: 180, bpmMax: 180, ar: 4.5, arOriginal: 9, cs: 2, csOriginal: 4, rate: 1 };
  const ezStart = watch.describeEvent(event('start', { mods: 'EZ', map: EZ_MAP }));
  assert.ok(ezStart.includes('《EZ_MAP》 [Insane]，开了 EZ，算上 mod 是 3.9 星（EZ 是增加难度的 mod：它把 AR 压低、圈更难读；EZ 会把星数算低，别拿星数说它简单）'), ezStart);
  // EZ 和 DT 一起开时星数其实是变大的：说明里不能断言「星数变小了」。
  const ezdt = watch.describeEvent(event('start', { mods: 'EZDT', map: { ...EZ_MAP, stars: 6.4, ar: 7.6 } }));
  assert.ok(ezdt.includes('开了 EZDT，算上 mod 是 6.4 星（EZ 是增加难度的 mod') && !ezdt.includes('星数变小'), ezdt);
  assert.ok(ezStart.includes(`AR 4.5（不开 mod 是 9），${AR_SLOW}`), ezStart);
  for (const kind of ['finish', 'fail', 'quit', 'combo-break', 'break', 'retry']) assert.ok(watch.describeEvent(event(kind, { mods: 'HDEZ', map: EZ_MAP, lostCombo: 300, before: {} })).includes('EZ 是增加难度的 mod'), `${kind}：开了 EZ 都带说明`);
  assert.ok(watch.describeEvent(event('start', { mods: 'EZ', map: { title: 'NO_STARS', version: '', stars: 0, maxCombo: 0 } })).includes('《NO_STARS》，开了 EZ（EZ 是增加难度的 mod'), '读不到星数也说明');
  for (const mods of ['', 'HD', 'DT', 'HDHR']) assert.ok(!watch.describeEvent(event('start', { mods, map: EZ_MAP })).includes('EZ 是增加难度'), `${mods || '不开 mod'}：不带 EZ 的说明`);
  // HR 不变速：BPM 不说「算上」；CS 变了带原值；圈很小。
  assert.equal(watch.mapDetail({ bpm: 180, bpmMin: 170, bpmMax: 200, ar: 10, arOriginal: 9.4, cs: 5.2, csOriginal: 4, rate: 1 }, 'HR'), 'BPM 180（有变速，170–200），中等；AR 10（不开 mod 是 9.4），普通；CS 5.2（不开 mod 是 4），圈很小');
  assert.equal(watch.mapDetail({}, ''), '', '读不到就什么都不写');
  // 只在开局带上（用户：「改成开局说吧」）。
  const withDetail = { title: 'SPEED_MAP', version: '', stars: 6.36, maxCombo: 900, bpm: 150, bpmMin: 150, bpmMax: 150, ar: 9.4, arOriginal: 9.4, cs: 3.8, csOriginal: 3.8, rate: 1 };
  assert.ok(watch.describeEvent(event('start', { mods: '', map: withDetail })).includes('这张图：BPM 150，偏慢；AR 9.4，普通；CS 3.8。'));
  for (const kind of ['break', 'finish', 'fail', 'combo-break', 'acc-drop']) assert.ok(!watch.describeEvent(event(kind, { mods: '', map: withDetail, lostCombo: 300, new100: 6, new50: 0, accFrom: 99, seconds: 8, n100: 9 })).includes('BPM'), `${kind} 不带`);
  // 这是张什么图（2026-11-21）：玩家标签（官网）+ 从谱面看，开局带上；没有就不提
  const info = { tags: [{ name: 'skillset/jumps', count: 20 }, { name: 'tech/aim control', count: 9 }], profileText: '偏跳图：大跳 3 段，约占 20% 的时间' };
  const tagged = watch.describeEvent(event('start', { mods: '', map: withDetail }), { mapInfo: info });
  // 标签用中文叫法（core/tag-names.js），而且排在 BPM 这些数前面（2026-11-21 用户：开局应该优先报玩家标签的信息）
  assert.ok(tagged.includes('玩家在 osu! 官网给这张图打的标签（票多的在前）：跳图、aim control（方向和速度别扭）。') && tagged.includes('从谱面看：偏跳图：大跳 3 段'), tagged);
  assert.ok(tagged.indexOf('标签') < tagged.indexOf('BPM'), '标签在 BPM 前面');
  assert.ok(watch.describeEvent(event('start', { mods: '', map: withDetail }), { mapInfo: { tags: [{ name: 'brand/new tag', count: 5 }], profileText: '' } }).includes('brand/new tag'), '表里没有的原样给');
  assert.ok(watch.describeEvent(event('start', { mods: '', map: withDetail }), { mapInfo: { tags: [], profileText: '偏串图：串 9 段' } }).includes('从谱面看：偏串图') && !watch.describeEvent(event('start', { mods: '', map: withDetail }), { mapInfo: { tags: [], profileText: '偏串图' } }).includes('标签'), '没有标签就只说从谱面看的');
  assert.ok(!watch.describeEvent(event('start', { mods: '', map: withDetail })).includes('标签'), '还没准备好就不提');
  // 主要考什么（2026-11-21，tosu 算好的 aim / 手速星数）：aim ≥ 手速 × 1.4 偏 aim；手速比 aim 高偏手速；中间差不多；读不到不说
  assert.equal(watch.skillFeel({ starsAim: 3.6, starsSpeed: 2.2 }), '偏 aim（aim 3.6 星、手速 2.2 星）');
  assert.equal(watch.skillFeel({ starsAim: 2.6, starsSpeed: 2.9 }), '偏手速（aim 2.6 星、手速 2.9 星）');
  assert.equal(watch.skillFeel({ starsAim: 3.0, starsSpeed: 2.6 }), 'aim 和手速差不多（aim 3 星、手速 2.6 星）');
  assert.equal(watch.skillFeel({ starsAim: 3.6, starsSpeed: 2.2, sliderFactor: 0.82 }), '偏 aim（aim 3.6 星、手速 2.2 星），滑条也占了不少难度');
  assert.equal(watch.skillFeel({}), '');
  const skilled = watch.describeEvent(event('start', { mods: '', map: { ...withDetail, starsAim: 3.6, starsSpeed: 2.2 } }));
  assert.ok(skilled.includes('主要考的：偏 aim') && skilled.indexOf('主要考的') < skilled.indexOf('BPM'), skilled);
  assert.ok(!watch.describeEvent(event('finish', { mods: '', map: { ...withDetail, starsAim: 3.6, starsSpeed: 2.2 }, rank: 'A' })).includes('主要考的'), '只在开局说');
  // tosu 的一帧里读得到这几样
  const tosuShape = normalizeSnapshot({ state: { number: 2 }, beatmap: { stats: { stars: { total: 6.7, aim: 3.61, speed: 2.24, reading: 1.1, sliderFactor: 0.973 } } }, play: { pp: { current: 100, fc: 250 } }, performance: { graph: { series: [{ name: 'aim', data: [1] }], xaxis: [0] } } });
  assert.deepEqual([tosuShape.map.starsAim, tosuShape.map.starsSpeed, tosuShape.map.starsReading, tosuShape.map.sliderFactor, tosuShape.play.ppFc, Boolean(tosuShape.graph)], [3.61, 2.24, 1.1, 0.973, 250, true]);
  assert.ok(!watch.describeEvent(event('finish', { mods: '', map: withDetail, rank: 'A' }), { mapInfo: info }).includes('标签'), '只在开局说');
  // 真机上 tosu 给的形状（2026-11-19 只读看过）。
  const realShape = normalizeSnapshot({ state: { number: 2 }, beatmap: { title: 'R', stats: { stars: { total: 6.36 }, maxCombo: 900, ar: { original: 9.4, converted: 9.4 }, cs: { original: 3.8, converted: 3.8 }, bpm: { realtime: 150, common: 150, min: 150, max: 150 } } }, play: { mods: { name: '', rate: 1 } } });
  assert.deepEqual([realShape.map.bpm, realShape.map.bpmMin, realShape.map.bpmMax, realShape.map.ar, realShape.map.arOriginal, realShape.map.cs, realShape.map.rate], [150, 150, 150, 9.4, 9.4, 3.8, 1]);
  // 后来加的三种。
  const drop = watch.describeEvent(event('acc-drop', { new100: 6, new50: 0, accFrom: 98.9, acc: 97.8, seconds: 8, n100: 14 }));
  assert.ok(drop.includes('8 秒里连着出了 6 个 100') && drop.includes('从 98.9% 掉到 97.8%') && drop.includes('一共 14 个 100'), drop);
  assert.ok(watch.describeEvent(event('acc-drop', { new100: 2, new50: 3, accFrom: 96, acc: 94, seconds: 6, n100: 20 })).includes('2 个 100、3 个 50'));
  const rest = watch.describeEvent(event('break', { pp: 142, n100: 14, n50: 1 }));
  assert.ok(rest.includes('休息段（打到 50%）') && rest.includes('142pp') && rest.includes('100 有 14 个') && rest.includes('50 有 1 个') && rest.includes('最长 486 连'), rest);
  assert.ok(!watch.describeEvent(event('break', { pp: 0, n100: 3, n50: 0 })).includes('pp'), '读不到 pp 就不提');
  assert.ok(watch.describeEvent(event('rank-down', { from: 2, to: 3, players: 8, names: ['RIVAL_B'] })).includes('刚被「RIVAL_B」超过了，从第 2 掉到第 3（一共 8 个人）'));
  assert.ok(watch.describeEvent(event('rank-up', { from: 3, to: 1, players: 8, names: ['RIVAL_A', 'RIVAL_B'] })).includes('刚超过了「RIVAL_A」、「RIVAL_B」，从第 3 升到第 1'));
  assert.ok(watch.describeEvent(event('rank-down', { from: 1, to: 2, players: 4, names: [] })).includes('被人超过了'), '说不出是谁也能说');
  assert.ok(!watch.describeEvent(event('finish', { rank: 'A', multi: false, place: null })).includes('多人房'));
}

// ── 2. 假依赖 ────────────────────────────────────────────────────────────────
function harness({ config = {}, petVisible = true, withPet = true, counter = null, headsUp = null } = {}) {
  const state = { clock: Date.parse('2026-11-19T20:00:00+08:00'), llmReady: true, reply: 'LINE', delayMs: 0, completeFails: false, onComplete: null, petVisible, tts: { bytes: Buffer.from('RIFF_FAKE_WAV'), durationMs: 1800 }, ttsDelayMs: 0, overlayFails: false };
  const calls = { complete: [], subtitles: [], synth: [], petSpeak: [], remember: [], sockets: [], logs: [], overlayStops: 0 };
  const cfg = { ...DEFAULTS.watch, ...TEST_WATCH, enabled: true, output: 'subtitle', ...config };
  const service = watch.createOsuWatchService({
    config: () => ({ watch: cfg, rulers: DEFAULTS.rulers }),
    persona: { info: () => ({ name: 'ROLE', ownerName: 'OWNER_NAME', pronoun: '他', persona: 'PERSONA_TEXT' }) },
    llm: {
      ready: () => (state.llmReady ? { ok: true } : { ok: false, code: 'llm.no-key', error: '还没填模型的 API Key', hint: '在设置「模型」里填 Key。' }),
      complete: async (options) => {
        calls.complete.push(options);
        if (state.completeFails) throw Object.assign(new Error('MODEL_DOWN'), { code: 'llm.http', hint: 'HINT' });
        if (state.onComplete) await state.onComplete();
        state.clock += state.delayMs;
        return { text: typeof state.reply === 'function' ? state.reply(calls.complete.length) : state.reply, usage: { input: 100, output: 5 }, model: 'MODEL' };
      },
    },
    tts: {
      ready: () => (state.ttsReady === false ? { ok: false, code: 'tts.no-key', error: '还没填火山引擎的 App ID / Access Key', hint: '填上' } : { ok: true }),
      synthesize: async (text) => { calls.synth.push(text); state.clock += state.ttsDelayMs; if (state.tts instanceof Error) throw state.tts; return state.tts; },
    },
    overlay: {
      say: (line) => { if (state.overlayFails) throw Object.assign(new Error('窗口没了'), { code: 'overlay.failed', hint: '下一句会重开' }); calls.subtitles.push(line); return { ok: true }; },
      stop: () => { calls.overlayStops += 1; },
      status: () => ({ running: calls.subtitles.length > 0, lastError: null }),
    },
    pet: withPet ? { status: () => ({ enabled: true, visible: state.petVisible, lastError: state.petError ?? null }), speak: (o) => calls.petSpeak.push(o) } : null,
    counter,
    journal: { append: (entry) => { calls.remember.push(entry); return true; }, recent: () => [{ at: Date.parse('2026-11-18T20:00:00+08:00'), text: 'MEMORY_TEXT' }] },
    log: (...args) => calls.logs.push(args.join(' ')),
    deps: {
      ...(headsUp ? { headsUp } : {}),
      // 「这是张什么图」换成假的：不去读真的谱面文件、不去问真的 tosu
      mapInfo: { onFrame: () => {}, get: () => state.mapInfo ?? null, status: () => ({ last: null }) },
      now: () => state.clock,
      connect: (url) => {
        const listeners = {};
        const socket = { url, closed: false, addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); }, close() { this.closed = true; }, fire: (type, payload = {}) => (listeners[type] ?? []).forEach((fn) => fn(payload)) };
        calls.sockets.push(socket);
        return socket;
      },
    },
  });
  return { state, calls, service, cfg };
}

{
  // 整条路：模型回「啊 998 断了」→ 字幕 / 气泡 / OBS 里是「啊 998 combo 断了」。
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service } = harness();
  // 开局：这是张什么图（假的 mapInfo 给的）带进给模型的话里
  state.mapInfo = { tags: [{ name: 'streams/cutstreams', count: 7 }], profileText: '偏串图：串 9 段' };
  // 开局那句太长（50 多个字）：在上限以内最后一个标点那里收住，不截在数字中间（2026-11-21 真机：「……不过有 240 …」）
  state.reply = '294 BPM 还带变速，快得有点离谱，7.97 星……不过有 240 BPM 的那段你上次打过，稳住慢慢来就行';
  const opened = await service.handleEvent(event('start', { at: state.clock }));
  assert.ok(calls.complete.at(-1).user.includes('断开的串') && calls.complete.at(-1).user.includes('从谱面看：偏串图'), calls.complete.at(-1).user);
  // 有玩家标签：规则要她先说这是张什么图，数最多顺带一个
  assert.ok(calls.complete.at(-1).system.includes('先说这是张什么图'), '有标签时的开局规则');
  assert.equal(opened.text, '294 BPM 还带变速，快得有点离谱，7.97 星……', opened.text);
  state.mapInfo = { tags: [], profileText: '偏串图' };
  state.clock += 100_000;
  await service.handleEvent(event('start', { at: state.clock, map: { title: 'NO_TAGS', version: 'X', stars: 4, maxCombo: 400 } }));
  assert.ok(!calls.complete.at(-1).system.includes('先说这是张什么图') && calls.complete.at(-1).system.includes('可以提一两个数'), '没有标签：照旧');
  state.mapInfo = null;
  state.clock += 100_000;
  state.reply = '啊 998 断了';
  const big = { title: 'SONG_TITLE', version: 'Insane', stars: 5, maxCombo: 1500 };
  const r = await service.handleEvent(event('combo-break', { at: state.clock, map: big, lostCombo: 998 }));
  assert.deepEqual(r, { said: true, text: '啊 998 combo 断了' });
  assert.equal(calls.subtitles.at(-1).text, '啊 998 combo 断了');
  fs.rmSync(PLAYS, { force: true });
}

// ── 3. 开口和闭嘴 ────────────────────────────────────────────────────────────
{
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service } = harness();
  state.reply = '「ROLE：这把稳啊（笑）」\n第二行不要';
  const done = await service.handleEvent(event('finish', { at: state.clock, rank: 'A', pp: 151, progress: 1 }));
  assert.deepEqual(done, { said: true, text: '这把稳啊' }, '去掉引号、名字开头、括号里的动作，只留第一行');
  // 每一句都记进日志，整理过的带上模型原话（2026-11-22 用户：「有没有办法看别人桌宠说了什么」）
  assert.ok(calls.logs.some((l) => l.includes('[osu] 说了（打完）：这把稳啊') && l.includes('模型原话：「ROLE：这把稳啊（笑）」')), calls.logs.join(' | '));
  assert.equal(calls.subtitles.length, 1);
  const prompt = calls.complete[0];
  assert.ok(prompt.system.includes('ROLE') && prompt.system.includes('PERSONA_TEXT') && prompt.system.includes('MEMORY_TEXT') && prompt.system.includes('OWNER_NAME'), '人设、最近几场的小结、称呼都带上');
  assert.ok(prompt.system.includes('不超过 40 个字') && prompt.system.includes('不要念数据流水账'));
  assert.ok(prompt.system.includes('照上面给的阿拉伯数字写') && prompt.system.includes('不要改写成汉字'), '真机：5.91 星被模型写成「五倍九」');
  assert.ok(prompt.system.includes('AR 10 以下是越低越难') && prompt.system.includes('AR 10 以上才是越高越难') && prompt.system.includes('EZ 这个 mod 名字叫「简单」，实际是增加难度的') && prompt.system.includes('别说成「降难度」') && prompt.system.includes('别拿星数说它简单'), '2026-11-20 用户纠正：EZ 是加难度的；AR 10 以下越低越难');
  assert.ok(prompt.user.includes('打完了《SONG_TITLE》') && prompt.user.includes('评级 A') && prompt.user.endsWith('对他说一句。'));
  assert.ok(prompt.system.includes('数字后面一定带上它是什么') && prompt.system.includes('要说「998 combo 断了」'), '2026-11-20 真机：「啊 998 断了」');
  const status = service.status();
  assert.deepEqual([status.today.said, status.today.llmCalls, status.today.tokens, status.lastComment.text, status.lastComment.kind, status.lastError], [1, 1, 105, '这把稳啊', 'finish', null]);
  assert.deepEqual([status.plays.length, status.plays[0].result, status.plays[0].rank, status.plays[0].title], [1, 'finish', 'A', 'SONG_TITLE']);
  assert.deepEqual(status.persona, { name: 'ROLE', ownerName: 'OWNER_NAME', pronoun: '他', personaChars: 'PERSONA_TEXT'.length });

  // 打的过程中：更短的字数要求；间隔内不再说；每首有上限。
  state.clock += 100_000;
  state.reply = (n) => `MID_${n}`;
  await service.handleEvent(event('start', { at: state.clock }));
  assert.equal(calls.subtitles.at(-1).text, 'MID_2');
  assert.ok(calls.complete.at(-1).system.includes('不超过 30 个字') && calls.complete.at(-1).system.includes('这一把刚开始') && calls.complete.at(-1).system.includes('- 这把稳啊'), '开局那句：点评这张图，而且知道自己刚说过什么');
  assert.deepEqual(await service.handleEvent(event('combo-break', { at: state.clock, lostCombo: 300 })), { said: false, reason: 'too-soon' });
  state.clock += 41_000;
  assert.equal((await service.handleEvent(event('combo-break', { at: state.clock, lostCombo: 300 }))).said, true);
  assert.ok(calls.complete.at(-1).system.includes('不超过 18 个字'), '打的过程中的话要短');
  state.clock += 41_000;
  assert.equal((await service.handleEvent(event('combo', { at: state.clock, mark: 500 }))).said, true);
  state.clock += 41_000;
  assert.equal((await service.handleEvent(event('combo-break', { at: state.clock, lostCombo: 400 }))).said, true, '开局那句不占每首的名额');
  state.clock += 41_000;
  assert.deepEqual(await service.handleEvent(event('combo-break', { at: state.clock, lostCombo: 600 })), { said: false, reason: 'per-song-max' }, '一首歌的过程中最多三句');
  // 结束那一句不受间隔和每首上限的限制。
  state.clock += 7000;
  assert.equal((await service.handleEvent(event('fail', { at: state.clock }))).said, true);
  assert.equal(service.status().plays[0].result, 'fail');
  state.clock += 100_000;
  assert.equal((await service.handleEvent(event('start', { at: state.clock, map: { title: 'NEXT', version: 'Hard', stars: 3, maxCombo: 300 } }))).said, true);

  // 断连和连击关口要相对这张图够长才说。
  {
    state.clock += 100_000;
    const big = { title: 'LONG_MAP', version: 'Extra', stars: 7.37, maxCombo: 1569 };
    await service.handleEvent(event('start', { at: state.clock, map: big }));
    state.clock += 100_000;
    const before = calls.complete.length;
    for (const lost of [58, 77, 97, 110, 159]) assert.equal((await service.handleEvent(event('combo-break', { at: state.clock, map: big, lostCombo: lost }))).reason, 'combo-break-small', `${lost} / 1569`);
    for (const mark of [100, 200]) assert.equal((await service.handleEvent(event('combo', { at: state.clock, map: big, mark }))).reason, 'combo-mark-small', `${mark} / 1569`);
    assert.equal(calls.complete.length, before, '不值得说的不调模型');
    assert.equal((await service.handleEvent(event('combo-break', { at: state.clock, map: big, lostCombo: 325 }))).said, true, '325 / 1569 值得说');
    state.clock += 41_000;
    assert.equal((await service.handleEvent(event('combo', { at: state.clock, map: big, mark: 300 }))).said, true);
    state.clock += 100_000;
    const unknown = { title: 'NO_MAX', version: '', stars: 0, maxCombo: 0 };
    await service.handleEvent(event('start', { at: state.clock, map: unknown }));
    state.clock += 100_000;
    assert.equal((await service.handleEvent(event('combo-break', { at: state.clock, map: unknown, lostCombo: 40 }))).reason, 'combo-break-small');
    assert.equal((await service.handleEvent(event('combo-break', { at: state.clock, map: unknown, lostCombo: 60 }))).said, true);
  }

  // 不值得说的：重开只在第 3 / 6 / 10 … 次说；刚开打就退出不说；看回放不说。
  state.clock += 100_000;
  assert.equal((await service.handleEvent(event('retry', { at: state.clock, retries: 2, before: {} }))).reason, 'retry-not-marked');
  assert.equal((await service.handleEvent(event('retry', { at: state.clock, retries: 3, before: {} }))).said, true);
  state.clock += 100_000;
  const beforeQuit = service.status().plays.length;
  assert.equal((await service.handleEvent(event('quit', { at: state.clock, progress: 0.05 }))).reason, 'quit-early');
  assert.equal(service.status().plays.length, beforeQuit, '刚点开就退出的不进成绩');
  assert.equal((await service.handleEvent(event('quit', { at: state.clock, progress: 0.2 }))).reason, 'quit-early');
  assert.equal(service.status().plays.length, beforeQuit + 1, '打了一段再退出的记一笔，但不说话');
  assert.equal((await service.handleEvent(event('finish', { at: state.clock, replay: true }))).reason, 'replay');
  assert.equal(service.status().plays.length, beforeQuit + 1, '回放不进成绩');

  // 一场打完：只记一条小结。
  const said = calls.subtitles.length;
  service.start();
  service.stop();
  assert.equal(calls.remember.length, 1);
  assert.ok(calls.remember[0].text.includes('【看他打 osu】') && calls.remember[0].text.includes('打完 1 把') && calls.remember[0].text.includes('《SONG_TITLE》') && calls.remember[0].text.includes('准确率 97.42%'), calls.remember[0].text);
  assert.ok(!calls.remember[0].text.includes('这把稳啊'), '她说过的话不进小结');
  assert.ok(calls.remember[0].text.includes('（开了 HD，算上 mod 是 4.83 星）'), calls.remember[0].text);
  // 成绩和当天说了几句落盘了，换一个实例还在。
  const again = harness().service.status();
  assert.equal(again.plays.length, beforeQuit + 1);
  assert.equal(again.today.said, said);
}

{
  // 说了没人看见 / 听见：不调模型，状态里说清楚；成绩照记。
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service, cfg } = harness({ config: { output: 'bubble' }, petVisible: false });
  assert.deepEqual(await service.handleEvent(event('finish', { at: state.clock })), { said: false, reason: 'osu.pet-hidden' });
  assert.equal(calls.complete.length, 0, '说了也没人看见，不花这个钱');
  const hidden = service.status().lastError;
  assert.ok(hidden.error && hidden.hint.includes('显示角色'));
  assert.equal(service.status().plays.length, 1);
  // 没有桌面角色却选了气泡。
  const noPet = harness({ config: { output: 'bubble' }, withPet: false });
  assert.equal((await noPet.service.handleEvent(event('finish', { at: noPet.state.clock }))).reason, 'osu.pet-unavailable');
  assert.equal(noPet.calls.complete.length, 0);

  // 2026-11-20 用户：直播只用 OBS 那份、桌面角色藏着 → 原来一句都不说。现在 OBS 里的角色装好了就照说，气泡出在 OBS 里。
  {
    const said = [];
    const obsCounter = (installed, enabled = true) => ({ status: () => ({ enabled, installed }), say: (o) => { said.push(o); return true; }, react: () => true });
    const obs = harness({ config: { output: 'bubble' }, petVisible: false, counter: obsCounter(true) });
    obs.state.reply = 'OBS_LINE';
    assert.deepEqual(await obs.service.handleEvent(event('finish', { at: obs.state.clock })), { said: true, text: 'OBS_LINE' }, '桌面角色藏着、OBS 角色装好了：照说');
    assert.deepEqual(said.map((o) => o.text), ['OBS_LINE'], 'OBS 里的角色收到这句');
    assert.match(said[0].mouth, /^[012]+$/, 'OBS 也拿到口型轨');
    assert.deepEqual([obs.calls.petSpeak.length, obs.calls.subtitles.length], [0, 0], '藏着的桌面角色不张嘴；没开念出来也不出本地字幕');
    // 没有桌面角色这个对象也一样（只有 OBS）。
    const obsOnly = harness({ config: { output: 'bubble' }, withPet: false, counter: obsCounter(true) });
    assert.equal((await obsOnly.service.handleEvent(event('finish', { at: obsOnly.state.clock }))).said, true);
    // OBS 角色没装好 / 关了：和原来一样不说、不调模型。
    for (const c of [obsCounter(false), obsCounter(true, false)]) {
      const h = harness({ config: { output: 'bubble' }, petVisible: false, counter: c });
      assert.equal((await h.service.handleEvent(event('finish', { at: h.state.clock }))).reason, 'osu.pet-hidden');
      assert.equal(h.calls.complete.length, 0);
    }
    // counter.status 抛错：当没装好。
    const broken = harness({ config: { output: 'bubble' }, petVisible: false, counter: { status: () => { throw new Error('x'); }, say: () => true } });
    assert.equal((await broken.service.handleEvent(event('finish', { at: broken.state.clock }))).reason, 'osu.pet-hidden');
    // 两边都看不见但开了「念出来」：只出声（声音由透明的字幕窗口放，不显示字）。
    const voiceOnly = harness({ config: { output: 'bubble', voice: true }, petVisible: false });
    voiceOnly.state.reply = 'VOICE_ONLY';
    assert.equal((await voiceOnly.service.handleEvent(event('finish', { at: voiceOnly.state.clock }))).said, true);
    assert.deepEqual([voiceOnly.calls.subtitles.length, voiceOnly.calls.subtitles[0].hidden, voiceOnly.calls.subtitles[0].audio.toString(), voiceOnly.calls.petSpeak.length], [1, true, 'RIFF_FAKE_WAV', 0]);
    // 开了念出来但这句没合成出来、两边又都看不见：没人知道她说了什么，算没说（和「不出字」一样）。
    const lost = harness({ config: { output: 'bubble', voice: true }, petVisible: false });
    lost.state.tts = Object.assign(new Error('TTS_DOWN'), { code: 'tts.http' });
    assert.deepEqual(await lost.service.handleEvent(event('finish', { at: lost.state.clock })), { said: false, reason: 'no-voice' });
    assert.equal(lost.service.status().lastError.code, 'osu.voice-failed');
    assert.ok(lost.service.status().lastError.hint.includes('OBS 里的角色也没装好') && !lost.service.status().lastError.hint.includes('字照常显示'), lost.service.status().lastError.hint);
    assert.equal(lost.calls.subtitles.length, 0);
    // 同样没合成出来，但 OBS 角色装好了：字在 OBS 里出，算说了。
    const shownObs = harness({ config: { output: 'bubble', voice: true }, petVisible: false, counter: obsCounter(true) });
    shownObs.state.tts = Object.assign(new Error('TTS_DOWN'), { code: 'tts.http' });
    said.length = 0;
    assert.equal((await shownObs.service.handleEvent(event('finish', { at: shownObs.state.clock }))).said, true);
    assert.equal(said.length, 1);

    // 复核：桌面角色出不来是因为没有能用的皮肤：说真正的原因（skin.*），不说「藏着、点显示角色」。
    {
      const noSkin = harness({ config: { output: 'bubble' }, petVisible: false });
      noSkin.state.petError = { code: 'skin.none', error: '一套能用的皮肤都没有', hint: '放 art/crosspet/' };
      assert.equal((await noSkin.service.handleEvent(event('finish', { at: noSkin.state.clock }))).reason, 'skin.none');
      const err = noSkin.service.status().lastError;
      assert.ok(err.error.includes('桌面角色出不来') && err.error.includes('一套能用的皮肤都没有') && err.hint === '放 art/crosspet/', JSON.stringify(err));
      assert.equal(noSkin.calls.complete.length, 0);
    }

    // 复核 1：开了念出来但语音没配好（没填 Key）——念不出来，等于两边都没有：不调模型。
    const noKey = harness({ config: { output: 'bubble', voice: true }, petVisible: false });
    noKey.state.ttsReady = false;
    assert.equal((await noKey.service.handleEvent(event('finish', { at: noKey.state.clock }))).reason, 'osu.pet-hidden');
    assert.equal(noKey.calls.complete.length, 0, '念不出来又看不见，不花模型的钱');

    // 复核 2：刚启动还没找过 tosu（status 里 dir 是 null、installed 是 false）：先找一次再决定，开局那句不丢。
    {
      let located = false; let syncs = 0;
      const lazy = { status: () => ({ enabled: true, installed: located, dir: located ? 'D:/tosu/static/fatfish-osu' : null, lastError: null }), sync: async () => { syncs += 1; located = true; return { ok: true }; }, say: () => true, react: () => true };
      const h = harness({ config: { output: 'bubble' }, petVisible: false, counter: lazy });
      assert.equal((await h.service.handleEvent(event('finish', { at: h.state.clock }))).said, true);
      assert.equal(syncs, 1);
      // 找过了还是没装好（比如 tosu 没开）：不再每句都去找，照原规则不说。
      const never = { status: () => ({ enabled: true, installed: false, dir: 'D:/tosu/static/fatfish-osu', lastError: { code: 'osu.counter-no-tosu' } }), sync: async () => { syncs += 1; return { ok: false }; }, say: () => false };
      const h2 = harness({ config: { output: 'bubble' }, petVisible: false, counter: never });
      syncs = 0;
      assert.equal((await h2.service.handleEvent(event('finish', { at: h2.state.clock }))).reason, 'osu.pet-hidden');
      assert.equal(syncs, 0);
    }

    // 复核 2b：上一次因为「气泡没地方出」没说成，后来 OBS 角色装好了 / 桌面角色打开了：状态里不再挂着那个错。
    {
      let installed = false;
      const later = { status: () => ({ enabled: true, installed, dir: 'D:/x', lastError: null }), sync: async () => ({ ok: true }), say: () => true };
      const h = harness({ config: { output: 'bubble' }, petVisible: false, counter: later });
      await h.service.handleEvent(event('finish', { at: h.state.clock }));
      assert.equal(h.service.status().lastError.code, 'osu.pet-hidden');
      installed = true;
      assert.equal(h.service.status().lastError, null);
    }

    // 复核 3：OBS 角色装着但 state.json 写不进去：preflight 不把它算「看得见」；这一句写失败了也不算说了。
    {
      const failing = { status: () => ({ enabled: true, installed: true, dir: 'D:/x', lastError: { code: 'osu.counter-write', error: '写 state.json 失败：EPERM', hint: '检查 tosu 的 static 文件夹能不能写。' } }), say: () => false };
      const h = harness({ config: { output: 'bubble' }, petVisible: false, counter: failing });
      assert.equal((await h.service.handleEvent(event('finish', { at: h.state.clock }))).reason, 'osu.pet-hidden', '已经知道写不进去：不调模型');
      assert.equal(h.calls.complete.length, 0);
      // 之前一直好好的，这一句刚好写失败：不计数、错误码用 counter 的。
      let broken = false;
      const flaky = { status: () => ({ enabled: true, installed: true, dir: 'D:/x', lastError: broken ? { code: 'osu.counter-write', error: '写 state.json 失败：EPERM', hint: '检查' } : null }), say: () => { broken = true; return false; } };
      const h2 = harness({ config: { output: 'bubble' }, petVisible: false, counter: flaky });
      h2.state.reply = 'LOST_LINE';
      const saidBefore = h2.service.status().today.said;
      assert.deepEqual(await h2.service.handleEvent(event('finish', { at: h2.state.clock })), { said: false, reason: 'osu.counter-write' });
      const st = h2.service.status();
      assert.deepEqual([st.lastError.code, st.today.said, st.lastComment], ['osu.counter-write', saidBefore, null]);
      // 桌面角色显示着时 OBS 写失败不影响这一句（桌面上出了）。
      const h3 = harness({ config: { output: 'bubble' }, petVisible: true, counter: { status: () => ({ enabled: true, installed: true, dir: 'D:/x', lastError: null }), say: () => false } });
      assert.equal((await h3.service.handleEvent(event('finish', { at: h3.state.clock }))).said, true);
    }
  }
  // 模型没配好：用模型自己的错误码，不调模型。
  cfg.output = 'subtitle'; state.llmReady = false; state.clock += 10_000;
  assert.equal((await service.handleEvent(event('finish', { at: state.clock }))).reason, 'llm.no-key');
  assert.ok(service.status().lastError.hint.includes('Key'));
  assert.equal(service.status().llm.code, 'llm.no-key');
  assert.equal(calls.complete.length, 0);
  // 模型报错：记下来，不抛；下一次照常。
  state.llmReady = true; state.completeFails = true; state.clock += 10_000;
  assert.equal((await service.handleEvent(event('finish', { at: state.clock }))).said, false);
  assert.deepEqual([service.status().lastError.code, service.status().lastError.error, service.status().lastError.hint], ['llm.http', 'MODEL_DOWN', 'HINT']);
  state.completeFails = false; state.clock += 10_000;
  assert.equal((await service.handleEvent(event('finish', { at: state.clock }))).said, true);
  assert.equal(service.status().lastError, null, '说成了就把上一次的错误清掉');
  // 模型回了空的：不出空字幕。
  state.reply = '  \n '; state.clock += 10_000;
  assert.deepEqual(await service.handleEvent(event('finish', { at: state.clock })), { said: false, reason: 'empty' });
  assert.equal(calls.subtitles.length, 1);
  // 字幕窗口出错：记下来（带下一步），不抛。
  state.reply = 'OK'; state.overlayFails = true; state.clock += 10_000;
  assert.equal((await service.handleEvent(event('finish', { at: state.clock }))).reason, 'overlay.failed');
  assert.ok(service.status().lastError.hint);
}

{
  // 关掉「打的过程中也说」：只在结束时说。每天的上限。
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service } = harness({ config: { midPlay: false, dailyLimit: 2 } });
  assert.equal((await service.handleEvent(event('start', { at: state.clock }))).reason, 'mid-play-off');
  assert.equal((await service.handleEvent(event('combo-break', { at: state.clock, lostCombo: 400 }))).reason, 'mid-play-off');
  assert.equal(calls.complete.length, 0);
  assert.equal((await service.handleEvent(event('finish', { at: state.clock }))).said, true);
  state.clock += 10_000;
  assert.equal((await service.handleEvent(event('finish', { at: state.clock }))).said, true);
  state.clock += 10_000;
  assert.equal((await service.handleEvent(event('finish', { at: state.clock }))).reason, 'daily-limit');
  assert.equal(calls.complete.length, 2);
  state.clock += 24 * 3600_000;
  assert.equal((await service.handleEvent(event('finish', { at: state.clock }))).said, true, '过了零点重新算');
}

{
  // 模型慢了：打图中的话过时就丢掉；结束那句照说。正在写上一句时，打图中的事不排队，结束的事排队。
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service } = harness();
  state.clock += 1000;
  service.handleFrame(frame({ state: 5 }));
  state.clock += 1000;
  state.delayMs = 12_000;
  const started = service.handleFrame(frame({ time: 0 }));
  assert.deepEqual(kinds(started), ['start']);
  await tick(20);
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.subtitles.length, 0, '开打那句写了 12 秒才出来：不说了');
  assert.equal(service.status().today.said, 0, '没说出去的不算在当天的句数里');

  state.delayMs = 0;
  let release;
  state.onComplete = () => new Promise((resolve) => { release = resolve; });
  state.clock += 60_000;
  const first = service.handleEvent(event('combo', { at: state.clock, mark: 300 }));
  await tick(10);
  assert.deepEqual(await service.handleEvent(event('combo-break', { at: state.clock, lostCombo: 320 })), { said: false, reason: 'busy' });
  assert.deepEqual(await service.handleEvent(event('finish', { at: state.clock, rank: 'S' })), { said: false, reason: 'queued' });
  state.onComplete = null;
  state.reply = (n) => `LINE_${n}`;
  release();
  await first;
  await tick(30);
  assert.ok(calls.subtitles.some((line) => line.text === 'LINE_3'), '排着的结束那句说出来了');
  assert.ok(calls.complete.at(-1).user.includes('打完了'));
}

{
  // 休息段：不占每首的名额、间隔短，但一首最多两次、话可以长一点；掉准度和名次变化按打图中的普通规矩走。
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service } = harness({ config: { perSongMax: 1 } });
  state.reply = (n) => `SAID_${n}`;
  await service.handleEvent(event('start', { at: state.clock }));
  state.clock += 41_000;
  assert.equal((await service.handleEvent(event('acc-drop', { at: state.clock, new100: 6, new50: 0, accFrom: 99, seconds: 8, n100: 9 }))).said, true);
  state.clock += 41_000;
  assert.equal((await service.handleEvent(event('acc-drop', { at: state.clock, new100: 6, new50: 0, accFrom: 99, seconds: 8, n100: 15 }))).reason, 'per-song-max');
  state.clock += 1000;
  assert.equal((await service.handleEvent(event('break', { at: state.clock, pp: 142, n100: 9, n50: 0 }))).said, true, '休息段不占名额');
  const prompt = calls.complete.at(-1);
  assert.ok(prompt.system.includes('不超过 30 个字') && prompt.system.includes('现在是休息段') && prompt.system.includes('可以报一两个数') && !prompt.system.includes('最多提一个数'));
  assert.ok(prompt.user.includes('142pp') && prompt.user.includes('100 有 9 个'));
  state.clock += 5000;
  assert.equal((await service.handleEvent(event('break', { at: state.clock, pp: 150, n100: 9, n50: 0 }))).reason, 'too-soon');
  state.clock += 16_000;
  assert.equal((await service.handleEvent(event('break', { at: state.clock, pp: 160, n100: 10, n50: 0 }))).said, true);
  state.clock += 60_000;
  assert.equal((await service.handleEvent(event('break', { at: state.clock, pp: 170, n100: 11, n50: 0 }))).reason, 'break-max', '一首最多两次');
  const quiet = harness({ config: { midPlay: false } });
  for (const kind of ['acc-drop', 'break', 'rank-up', 'rank-down']) assert.equal((await quiet.service.handleEvent(event(kind, { at: quiet.state.clock, names: [], new100: 6 }))).reason, 'mid-play-off', kind);
}

{
  // 滑条断：全连没了的那一断不看比例；普通的照旧拦，并且记下为什么（用户：「我 sliderbreak 之后她没反应」）。
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service } = harness();
  const map = { title: 'FC_MAP', version: 'Insane', stars: 5.58, maxCombo: 732 };
  await service.handleEvent(event('start', { at: state.clock, map }));
  state.clock += 41_000;
  assert.equal((await service.handleEvent(event('combo-break', { at: state.clock, map, lostCombo: 80, sliderBreak: true, fcLost: true }))).said, true);
  assert.ok(calls.complete.at(-1).user.includes('断在了滑条上'));
  state.clock += 1000;
  assert.equal((await service.handleEvent(event('combo-break', { at: state.clock, map, lostCombo: 400, sliderBreak: true, fcLost: false }))).reason, 'too-soon');
  state.clock += 41_000;
  assert.equal((await service.handleEvent(event('combo-break', { at: state.clock, map, lostCombo: 80, sliderBreak: true, fcLost: false }))).reason, 'combo-break-small');
  const skipped = service.status().skipped;
  assert.deepEqual(skipped.map((item) => item.reason), ['combo-break-small', 'too-soon'], '最新在前');
  assert.ok(skipped[0].why.includes('15%') && skipped[0].lostCombo === 80 && skipped[0].maxCombo === 732 && skipped[0].sliderBreak === true);
  await service.handleEvent(event('finish', { at: state.clock, replay: true }));
  await service.handleEvent(event('quit', { at: state.clock, progress: 0.05 }));
  assert.equal(service.status().skipped.length, 2, '回放、刚开打就退出不记');
  for (let i = 0; i < 20; i += 1) { state.clock += 1000; await service.handleEvent(event('combo-break', { at: state.clock, map, lostCombo: 60, fcLost: false })); }
  assert.equal(service.status().skipped.length, 12, '只留最近 12 条');
}

{
  // 开局那一句：每张图都说、带 BPM/AR/CS；6 秒内不说；同一张图十分钟内不再点评；没说成的不算点评过。
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service } = harness();
  const mapA = { title: 'OPEN_A', version: 'Insane', stars: 6.36, maxCombo: 900, bpm: 150, bpmMin: 150, bpmMax: 150, ar: 9.4, arOriginal: 9.4, cs: 3.8, csOriginal: 3.8, rate: 1 };
  const mapB = { ...mapA, title: 'OPEN_B', bpm: 240, bpmMin: 240, bpmMax: 240 };
  assert.equal((await service.handleEvent(event('start', { at: state.clock, map: mapA }))).said, true);
  assert.ok(calls.complete.at(-1).user.includes('这张图：BPM 150，偏慢；AR 9.4，普通'));
  state.clock += 60_000;
  await service.handleEvent(event('finish', { at: state.clock, map: mapA }));
  state.clock += 7000;
  assert.equal((await service.handleEvent(event('start', { at: state.clock, map: mapB }))).said, true, '上一句才过 7 秒也说');
  state.clock += 2000;
  assert.equal((await service.handleEvent(event('start', { at: state.clock, map: { ...mapA, title: 'OPEN_C' } }))).reason, 'too-soon');
  state.clock += 30_000;
  assert.equal((await service.handleEvent(event('start', { at: state.clock, map: mapB }))).reason, 'start-same-map');
  assert.ok(service.status().skipped[0].why.includes('十分钟内已经开局点评过'));
  state.clock += 10 * 60_000;
  assert.equal((await service.handleEvent(event('start', { at: state.clock, map: mapB }))).said, true);
  state.completeFails = true; state.clock += 10_000;
  assert.equal((await service.handleEvent(event('start', { at: state.clock, map: { ...mapA, title: 'OPEN_D' } }))).said, false);
  state.completeFails = false; state.clock += 10_000;
  assert.equal((await service.handleEvent(event('start', { at: state.clock, map: { ...mapA, title: 'OPEN_D' } }))).said, true);
}

{
  // 一场的小结（之后每次开口都会带上）：只说「星数最高」，不说「最难」——星数算上了 mod，而 EZ 会把星数算低、实际却更难。
  // 开着 EZ 打完的另记一笔，免得因为星数低被盖掉。
  fs.rmSync(PLAYS, { force: true });
  const same = { title: 'SAME', version: 'Insane', maxCombo: 800 };
  const { state, calls, service } = harness();
  await service.handleEvent(event('finish', { at: state.clock, mods: '', map: { ...same, stars: 5.2 }, rank: 'A' }));
  state.clock += 10_000;
  await service.handleEvent(event('finish', { at: state.clock, mods: 'EZ', map: { ...same, stars: 3.9 }, rank: 'B' }));
  service.start();
  service.stop();
  const text = calls.remember[0].text;
  assert.ok(text.includes('星数最高的一把是《SAME》 [Insane]（5.2 星）') && !text.includes('最难'), text);
  assert.ok(text.includes('还开着 EZ 打完了《SAME》 [Insane]（开了 EZ，算上 mod 是 3.9 星；EZ 是增加难度的 mod，别拿星数说它简单）。'), text);
  // 只打完了开 EZ 的那把：它就是星数最高的，同样带说明，不重复记两遍。
  fs.rmSync(PLAYS, { force: true });
  const only = harness();
  await only.service.handleEvent(event('finish', { at: only.state.clock, mods: 'HDEZ', map: { ...same, stars: 3.9 }, rank: 'B' }));
  only.service.start();
  only.service.stop();
  const onlyText = only.calls.remember[0].text;
  assert.ok(onlyText.includes('星数最高的一把是《SAME》 [Insane]（开了 HDEZ，算上 mod 是 3.9 星；EZ 是增加难度的 mod，别拿星数说它简单）') && !onlyText.includes('还开着 EZ'), onlyText);
  // 没开 EZ 的一场：不带任何 EZ 的话。
  fs.rmSync(PLAYS, { force: true });
  const plain = harness();
  await plain.service.handleEvent(event('finish', { at: plain.state.clock, mods: 'HD', rank: 'A' }));
  plain.service.start();
  plain.service.stop();
  assert.ok(!plain.calls.remember[0].text.includes('EZ'), plain.calls.remember[0].text);
}

// ── 4. 字幕 / 气泡 / 只念，和语音 ─────────────────────────────────────────────
{
  // 字幕：按字数算停留时间；没开「念出来」不合成；桌面角色显示着就跟着张嘴（不冒气泡）。
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service } = harness();
  state.reply = '这把稳啊';
  await service.handleEvent(event('finish', { at: state.clock }));
  assert.deepEqual([calls.subtitles[0].text, calls.subtitles[0].audio, calls.subtitles[0].ms, calls.subtitles[0].hidden], ['这把稳啊', null, 2600, false], '没有语音：按字数算，最短 2.6 秒');
  assert.equal(calls.synth.length, 0);
  assert.deepEqual(calls.petSpeak.map(({ mouth, ...rest }) => rest), [{ text: '这把稳啊', durationMs: 1200, bubble: false }], '没声音时按字数算张嘴时长（最短 1.2 秒）');
  // 口型轨：没声音时按字假装说，1.2 秒 = 20 档（2026-11-21 说话时动嘴）。
  assert.match(calls.petSpeak[0].mouth, /^[012]{20}$/);
  assert.ok(calls.petSpeak[0].mouth.includes('2'));
  state.clock += 10_000;
  state.reply = '字'.repeat(40);
  await service.handleEvent(event('finish', { at: state.clock }));
  assert.equal(calls.subtitles.at(-1).ms, 7000, '字多也不会一直挂着');
  // 桌面角色藏着：不发张嘴。
  state.petVisible = false; state.clock += 10_000;
  await service.handleEvent(event('finish', { at: state.clock }));
  assert.equal(calls.petSpeak.length, 2);
}
{
  // 念出来：字幕带着声音一起出；停留时间跟着音频长度；张嘴按声音长度。
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service, cfg } = harness({ config: { voice: true } });
  state.reply = 'VOICE_LINE';
  await service.handleEvent(event('finish', { at: state.clock }));
  assert.deepEqual(calls.synth, ['VOICE_LINE']);
  assert.equal(calls.subtitles[0].audio.toString(), 'RIFF_FAKE_WAV', '音频字节交给字幕窗口去放');
  assert.equal(calls.subtitles[0].ms, 3800, '音频 1.8 秒 + 2 秒余量');
  assert.equal(calls.petSpeak[0].durationMs, 1800);
  assert.equal(service.status().lastComment.voiced, true);
  // 合成出来了但不知道多长：给一个够长的保险时长。
  state.tts = { bytes: Buffer.from('X'), durationMs: 0 }; state.clock += 10_000;
  await service.handleEvent(event('finish', { at: state.clock }));
  assert.equal(calls.subtitles.at(-1).ms, 15_000);
  // 合成失败：字幕照出，只是没声音；原因写在状态里（带 code）。下一次成功就清掉。
  for (const [tts, wanted] of [[Object.assign(new Error('火山拒绝了密钥'), { code: 'tts.auth' }), 'tts.auth'], [new Error('TTS_CRASH'), 'TTS_CRASH'], [{ bytes: Buffer.alloc(0), durationMs: 5 }, '空的']]) {
    state.tts = tts; state.clock += 10_000;
    const count = calls.subtitles.length;
    assert.equal((await service.handleEvent(event('finish', { at: state.clock }))).said, true);
    assert.equal(calls.subtitles.length, count + 1);
    assert.equal(calls.subtitles.at(-1).audio, null);
    const failure = service.status().voice.lastError;
    assert.equal(failure.code, 'osu.voice-failed');
    assert.ok(failure.error.includes(wanted) && failure.hint.includes('语音'), JSON.stringify(failure));
  }
  state.tts = { bytes: Buffer.from('RIFF_FAKE_WAV'), durationMs: 900 }; state.clock += 10_000;
  await service.handleEvent(event('finish', { at: state.clock }));
  assert.equal(service.status().voice.lastError, null);
  // 打图中的话：要等语音合成，所以比只出字多给几秒；再慢就丢掉。
  state.clock += 100_000;
  state.delayMs = 5000; state.ttsDelayMs = 7000;
  assert.equal((await service.handleEvent(event('start', { at: state.clock }))).said, true, '模型 5 秒 + 语音 7 秒 = 12 秒：念出来时还在 16 秒以内');
  state.clock += 100_000;
  state.ttsDelayMs = 13_000;
  assert.equal((await service.handleEvent(event('combo-break', { at: state.clock, lostCombo: 400 }))).reason, 'stale');
  state.delayMs = 0; state.ttsDelayMs = 0;
  // 气泡 + 念出来：角色头顶冒气泡，声音由字幕窗口放（不出字）。
  cfg.output = 'bubble'; state.clock += 100_000;
  await service.handleEvent(event('finish', { at: state.clock }));
  assert.deepEqual([calls.petSpeak.at(-1).bubble, calls.subtitles.at(-1).hidden, Boolean(calls.subtitles.at(-1).audio)], [true, true, true]);
  // 气泡、不念：不用字幕窗口。
  cfg.voice = false; state.clock += 10_000;
  const shown = calls.subtitles.length;
  const synthCount = calls.synth.length;
  await service.handleEvent(event('finish', { at: state.clock }));
  assert.deepEqual([calls.subtitles.length, calls.synth.length, calls.petSpeak.at(-1).bubble], [shown, synthCount, true]);
  // 关掉功能、停服务：字幕窗口收掉。
  service.start();
  cfg.enabled = false;
  const stopsBefore = calls.overlayStops;
  service.sync();
  assert.ok(calls.overlayStops > stopsBefore);
  // 关着时之后的每 5 秒同步不再收（不然「让她说一句试试」念到一半会被掐断）。
  const stopsAfter = calls.overlayStops;
  service.sync();
  service.sync();
  assert.equal(calls.overlayStops, stopsAfter);
  service.stop();
}
{
  // 不显示字幕（用户：「往字幕选项里再加个没字幕的选项」）：只念出来，屏幕上不出字。
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service, cfg } = harness({ config: { output: 'none', voice: true } });
  state.reply = 'QUIET_LINE';
  assert.deepEqual(await service.handleEvent(event('finish', { at: state.clock })), { said: true, text: 'QUIET_LINE' });
  assert.deepEqual([calls.subtitles.length, calls.subtitles[0].hidden, calls.subtitles[0].audio.toString()], [1, true, 'RIFF_FAKE_WAV'], '声音还是交给那个窗口放，但不出字');
  assert.equal(calls.petSpeak[0].bubble, false, '角色显示着照样张嘴，不冒气泡');
  // 合成失败：没字幕又没声音，这句算没说，原因写清楚。
  state.tts = new Error('TTS_OFF'); state.clock += 10_000;
  const shown = calls.subtitles.length;
  assert.deepEqual(await service.handleEvent(event('finish', { at: state.clock })), { said: false, reason: 'no-voice' });
  assert.equal(calls.subtitles.length, shown);
  assert.equal(service.status().lastError.code, 'osu.voice-failed');
  assert.ok(service.status().lastError.hint.includes('不显示字幕'));
  // 关着「念出来」：不调模型，告诉你开「念出来」或改回字幕。
  state.tts = { bytes: Buffer.from('W'), durationMs: 1000 };
  cfg.voice = false; state.clock += 10_000;
  const asked = calls.complete.length;
  assert.equal((await service.handleEvent(event('finish', { at: state.clock }))).reason, 'osu.no-output');
  assert.equal(calls.complete.length, asked);
  const failure = service.status().lastError;
  assert.ok(failure.error && failure.hint.includes('念出来') && failure.hint.includes('字幕'), JSON.stringify(failure));
}
{
  // OBS counter：每说成一句同步一次（不管本地用哪种输出）；连上 tosu 时装一次。
  fs.rmSync(PLAYS, { force: true });
  const counterCalls = { say: [], sync: [] };
  const counter = { say: (o) => { counterCalls.say.push(o); return true; }, sync: async (o) => { counterCalls.sync.push(o); return { ok: true }; }, status: () => ({ installed: true }) };
  const { state, calls, service } = harness({ counter });
  state.reply = 'OBS_LINE';
  await service.handleEvent(event('finish', { at: state.clock }));
  assert.deepEqual(counterCalls.say.map(({ mouth, ...rest }) => rest), [{ text: 'OBS_LINE', durationMs: 1840 }], '8 个字 × 230 毫秒');
  service.start();
  calls.sockets[0].fire('open');
  await tick(5);
  assert.deepEqual(counterCalls.sync, [{ force: false }]);
  const synced = await service.act({ action: 'counter-sync' });
  assert.deepEqual([counterCalls.sync.at(-1), synced.counterSynced.ok], [{ force: true }, true]);
  service.stop();
  // counter 装不上：act 报错带 code / hint。
  const broken = harness({ counter: { ...counter, sync: async () => ({ ok: false, code: 'osu.counter-no-tosu', error: '没找到正在运行的 tosu', hint: '先打开 tosu.exe' }) } });
  await assert.rejects(broken.service.act({ action: 'counter-sync' }), (error) => error.code === 'osu.counter-no-tosu' && Boolean(error.hint));
}

// ── 5. 和 tosu 的连接 ────────────────────────────────────────────────────────
{
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service } = harness();
  assert.equal(service.status().tosu.connected, false);
  service.start();
  assert.equal(calls.sockets.length, 1);
  assert.equal(calls.sockets[0].url, 'ws://127.0.0.1:24050/websocket/v2');
  assert.equal(service.status().tosu.connected, false, '还没握上手');
  calls.sockets[0].fire('open');
  assert.deepEqual([service.status().tosu.connected, service.status().tosu.error, service.status().playing], [true, null, null]);
  state.clock += 1000;
  calls.sockets[0].fire('message', { data: '这不是 JSON' });
  calls.sockets[0].fire('message', { data: JSON.stringify(frame({ time: 0 })) });
  await tick(10);
  assert.equal(service.status().playing.map.title, 'SONG_TITLE');
  assert.equal(calls.subtitles.length, 1, '开打说了一句');
  calls.sockets[0].fire('close');
  const down = service.status();
  assert.equal(down.tosu.connected, false);
  assert.equal(down.tosu.error.code, 'osu.tosu-offline');
  assert.ok(down.tosu.error.error && down.tosu.error.hint.includes('tosu.exe'));
  service.stop();
  const fresh = harness();
  fresh.cfg.enabled = false;
  fresh.service.start();
  assert.equal(fresh.calls.sockets.length, 0, '没开就不连');
  fresh.cfg.enabled = true;
  fresh.service.sync();
  assert.equal(fresh.calls.sockets.length, 1, '打开开关就连');
  fresh.calls.sockets[0].fire('open');
  fresh.cfg.enabled = false;
  fresh.service.sync();
  assert.equal(fresh.calls.sockets[0].closed, true);
  assert.deepEqual([fresh.service.status().tosu.connected, fresh.service.status().tosu.error], [false, null]);
  fresh.service.stop();
}

// ── 6. 设置窗口的操作 ────────────────────────────────────────────────────────
{
  fs.rmSync(PLAYS, { force: true });
  const { state, calls, service } = harness();
  state.reply = 'TEST_LINE';
  const tested = await service.act({ action: 'test' });
  assert.equal(tested.said, 'TEST_LINE');
  assert.ok(calls.complete[0].user.includes('（试一下）') && calls.complete[0].user.includes('4.8 星'));
  assert.equal(tested.plays.length, 0, '试一下不进成绩');
  state.llmReady = false;
  await assert.rejects(service.act({ action: 'test' }), (error) => error.code === 'llm.no-key' && error.hint.includes('Key'));
  await assert.rejects(service.act({ action: 'nope' }), (error) => error.code === 'osu.action-unknown' && Boolean(error.hint));
  state.llmReady = true;
  await service.handleEvent(event('finish', { at: state.clock }));
  assert.equal(service.status().plays.length, 1);
  assert.equal((await service.act({ action: 'clear-plays' })).plays.length, 0);
}

// ── 难段预告开着：难段前后打图中途的点评先不说（2026-11-21）──────────────────────
{
  let quiet = true;
  const frames = [];
  const stub = { quiet: () => quiet, onFrame: (snap, run) => frames.push([snap?.state, run]), status: () => ({ mode: 'voice', marker: 'STUB' }) };
  const { service, state } = harness({ headsUp: stub });
  assert.equal((await service.handleEvent(event('start', { at: state.clock }))).said, true, '开局那句照说');
  state.clock += 41_000;
  assert.deepEqual(await service.handleEvent(event('combo-break', { at: state.clock, lostCombo: 300 })), { said: false, reason: 'heads-up-quiet' });
  assert.ok(service.status().skipped.some((s) => s.reason === 'heads-up-quiet' && s.why.includes('难段')));
  quiet = false;
  assert.equal((await service.handleEvent(event('combo-break', { at: state.clock, lostCombo: 300 }))).said, true, '难段过了照常说');
  quiet = true;
  state.clock += 41_000;
  assert.equal((await service.handleEvent(event('finish', { at: state.clock }))).said, true, '打完那句不压');
  assert.equal(service.status().headsUp.marker, 'STUB');
  // 每一帧都喂给难段预告（不跟着 200 毫秒的节流走）。
  service.handleFrame({ state: { number: 2 }, beatmap: { checksum: 'K' } });
  service.handleFrame({ state: { number: 2 }, beatmap: { checksum: 'K' } });
  assert.equal(frames.length, 2);
  assert.equal(frames[0][0], 'play');
}
{
  // 脚下的 pp 地台环（2026-11-21）：每一帧把 pp / 100 / 50 / miss / 进度给桌面角色（不跟着节流走）；不在打图时 on 是 false
  const huds = [];
  const curves = [];
  const pet = { status: () => ({ enabled: true, visible: true }), speak: () => {}, hud: (d) => huds.push(d), hudCurve: (c) => curves.push(c) };
  const s2 = watch.createOsuWatchService({ config: () => ({ watch: { ...DEFAULTS.watch, ...TEST_WATCH }, rulers: DEFAULTS.rulers }), persona: { info: () => ({ name: 'R', ownerName: 'O', pronoun: '他' }) }, llm: { ready: () => ({ ok: true }), complete: async () => ({ text: 'x', usage: { input: 0, output: 0 } }) }, overlay: { say: () => ({ ok: true }), stop() {}, status: () => ({}) }, pet, deps: { mapInfo: { onFrame() {}, get: () => null, status: () => null }, now: () => 1 } });
  const raw = { state: { number: 2 }, play: { pp: { current: 312.4, fc: 420.4 }, hits: { 100: 12, 50: 1, 0: 2 } }, beatmap: { checksum: 'K', time: { live: 46000, firstObject: 10000, lastObject: 110000 } } };
  s2.handleFrame(raw);
  s2.handleFrame(raw);
  assert.equal(huds.length, 2, '每一帧都给（重复的由桌面窗口那边去掉）');
  assert.equal(curves.at(-1), null, '这一帧没有难度曲线：难度带收起来');
  // 帧里带着 tosu 的难度曲线：按进度压成一圈给桌面窗口（环上的难度带）
  const xaxis = [0, 400];
  for (let x = 10000; x <= 110000; x += 400) xaxis.push(x);
  const aimLine = xaxis.map((x, i) => (i < 2 ? -100 : x > 60000 && x < 64000 ? 5 : 1));
  s2.handleFrame({ ...raw, performance: { graph: { series: [{ name: 'aim', data: aimLine }, { name: 'speed', data: aimLine.map(() => 0.5) }], xaxis } } });
  assert.equal(curves.at(-1).length, 120);
  assert.equal(Math.max(...curves.at(-1)), 1);
  assert.deepEqual(huds[0], { on: true, pp: 312, fc: 420, n100: 12, n50: 1, miss: 2, progress: 0.36 });
  s2.handleFrame({ ...raw, state: { number: 5 } });
  assert.equal(huds.at(-1).on, false, '选歌界面：收起来');
  // 打到一半 tosu 断了（osu! 被关掉）：环要收起来，不能一直挂在桌面上（复核发现）
  let sock = null;
  const s3 = watch.createOsuWatchService({ config: () => ({ watch: { ...DEFAULTS.watch, ...TEST_WATCH, enabled: true }, rulers: DEFAULTS.rulers }), persona: { info: () => ({ name: 'R', ownerName: 'O', pronoun: '他' }) }, llm: { ready: () => ({ ok: true }), complete: async () => ({ text: 'x', usage: { input: 0, output: 0 } }) }, overlay: { say: () => ({ ok: true }), stop() {}, status: () => ({}) }, pet, deps: {
    mapInfo: { onFrame() {}, get: () => null, status: () => null }, now: () => 1,
    connect: (url) => { const ls = {}; sock = { url, addEventListener: (t, fn) => { (ls[t] ??= []).push(fn); }, close() {}, fire: (t, p = {}) => (ls[t] ?? []).forEach((fn) => fn(p)) }; return sock; },
  } });
  s3.start();
  sock.fire('open');
  sock.fire('message', { data: JSON.stringify(raw) });
  assert.equal(huds.at(-1).on, true);
  sock.fire('close');
  assert.equal(huds.at(-1).on, false, 'tosu 断了：收起来');
  s3.stop();
}
{
  // 闸门那一刻还不在难段前后，模型写完要出声时已经在了：这句不说（复核发现会撞上提示音）
  let quiet = false;
  const stub = { quiet: () => quiet, onFrame() {}, status: () => ({ mode: 'voice' }) };
  const { service, state, calls } = harness({ headsUp: stub });
  await service.handleEvent(event('start', { at: state.clock }));
  state.clock += 41_000;
  const shown = calls.subtitles.length;
  state.onComplete = async () => { quiet = true; };
  assert.deepEqual(await service.handleEvent(event('combo-break', { at: state.clock, lostCombo: 300 })), { said: false, reason: 'heads-up-quiet' });
  assert.equal(calls.subtitles.length, shown, '没出字幕、没出声');
  state.onComplete = null;
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('watch: ok');
