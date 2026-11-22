/**
 * 从 tosu 的数据里认出时刻（core/events.js）。照搬 SurfCore plugins/surfcore/scripts/test-osu-watch.mjs 的 1–2c 段。
 * 不连真的 tosu：喂假的对局数据。
 */
import assert from 'node:assert/strict';
import { createOsuTracker, normalizeSnapshot, progressOf, standingOf } from '../core/events.js';
import { MAP, frame, kinds } from './fixtures.mjs';
// ── 1. 认数据 ────────────────────────────────────────────────────────────────
{
  assert.equal(normalizeSnapshot(null), null);
  assert.equal(normalizeSnapshot([]), null);
  const empty = normalizeSnapshot({});
  assert.equal(empty.state, 'other');
  assert.equal(empty.map.title, '');
  const snap = normalizeSnapshot(frame({ time: 51_000, acc: 97.456, combo: 312, miss: 2, mods: 'HDDT' }));
  assert.equal(snap.state, 'play');
  assert.deepEqual([snap.map.title, snap.map.version, snap.map.stars, snap.map.maxCombo, snap.play.acc, snap.play.combo, snap.play.miss, snap.play.mods], ['SONG_TITLE', 'Insane', 4.83, 800, 97.46, 312, 2, 'HDDT']);
  assert.equal(progressOf(snap.map), 0.5);
  assert.equal(progressOf({ timeFirst: 0, timeLast: 0 }), null, '图的长度读不到');
  // 界面状态：编号和名字都认（lazer 下名字可能有出入）。
  for (const [state, expected] of [[{ number: 2 }, 'play'], [{ name: 'play' }, 'play'], [{ number: 7 }, 'results'], [{ name: 'ResultScreen' }, 'results'], [{ name: 'songSelect' }, 'select'], [{ number: 0, name: 'Menu' }, 'menu'], [{ number: 99, name: 'x' }, 'other']]) {
    assert.equal(normalizeSnapshot({ state }).state, expected, JSON.stringify(state));
  }
}

// ── 2. 认时刻 ────────────────────────────────────────────────────────────────
{
  const tracker = createOsuTracker();
  const feed = (options, now) => tracker.feed(normalizeSnapshot(frame(options)), now);
  assert.deepEqual(kinds(feed({ state: 5 }, 0)), [], '选歌界面：没事');
  assert.equal(tracker.current(), null);
  const start = feed({ time: 0, mods: 'HD' }, 1000);
  assert.deepEqual(kinds(start), ['start']);
  assert.deepEqual([start[0].map.title, start[0].mods, start[0].replay, start[0].retries], ['SONG_TITLE', 'HD', false, 0]);
  assert.deepEqual(kinds(feed({ time: 10_000, score: 5000, combo: 60 }, 2000)), []);
  assert.deepEqual(kinds(feed({ time: 20_000, score: 20_000, combo: 99 }, 3000)), []);
  const mark = feed({ time: 21_000, score: 21_000, combo: 101 }, 3100);
  assert.deepEqual([kinds(mark), mark[0].mark], [['combo'], 100]);
  assert.deepEqual(kinds(feed({ time: 22_000, score: 22_000, combo: 130 }, 3200)), [], '同一个关口只报一次');
  // 断连：连击掉了，而且 miss 多了。
  const broke = feed({ time: 40_000, score: 40_000, combo: 0, maxCombo: 130, miss: 1, acc: 98.5 }, 4000);
  assert.deepEqual(kinds(broke), ['combo-break']);
  assert.deepEqual([broke[0].lostCombo, broke[0].miss, broke[0].acc, Math.round(broke[0].progress * 100)], [130, 1, 98.5, 39]);
  // 短连击断了不算事。
  feed({ time: 45_000, score: 45_000, combo: 20, maxCombo: 130, miss: 1 }, 4500);
  assert.deepEqual(kinds(feed({ time: 46_000, score: 46_000, combo: 0, maxCombo: 130, miss: 2 }, 4600)), []);
  // 滑条断了（miss 没多，sliderBreaks 多了）也算。
  feed({ time: 60_000, score: 60_000, combo: 80, maxCombo: 130, miss: 2 }, 5000);
  assert.deepEqual(kinds(feed({ time: 61_000, score: 61_000, combo: 1, maxCombo: 130, miss: 2, sb: 1 }, 5100)), ['combo-break']);
  assert.equal(tracker.current().peakCombo, 130);
  // 打到最后（结算的分数和这一帧差不多：最后几下的分）
  feed({ time: 100_900, score: 896_000, combo: 486, maxCombo: 486, miss: 2, sb: 1, acc: 97.4, pp: 150 }, 8900);
  // 打完 → 结算界面。
  const finish = feed({ state: 7, time: 101_500, results: { score: 900_000, accuracy: 97.42, hits: { 0: 2 }, maxCombo: 486, mods: { name: 'HD' }, rank: 'A', pp: { current: 151 } } }, 9000);
  assert.deepEqual(kinds(finish), ['finish']);
  assert.deepEqual([finish[0].rank, finish[0].acc, finish[0].miss, finish[0].peakCombo, finish[0].pp, finish[0].fullCombo, finish[0].progress], ['A', 97.42, 2, 486, 151, false, 1]);
  assert.equal(tracker.current(), null);
  assert.deepEqual(kinds(feed({ state: 7, results: { rank: 'A', score: 1 } }, 9100)), [], '停在结算界面不会再报一次');
}
{
  // 结算界面头几帧还是上一把的数（真机 2026-11-22，Alive [Insane] DT 连打两把：第二把 4 miss / 94.35% / 272pp，
  // 结算界面那一帧却是上一把的 8 miss / 93.6% / 199pp）：对不上就用打图时最后一帧的数
  const tracker = createOsuTracker();
  const feed = (options, now) => tracker.feed(normalizeSnapshot(frame(options)), now);
  feed({ time: 0 }, 0);
  feed({ time: 1_500, score: 1_000, combo: 3 }, 500);
  feed({ time: 100_900, score: 4_867_000, combo: 120, maxCombo: 425, miss: 4, acc: 94.35, pp: 272 }, 9000);
  const stale = { score: 4_100_000, accuracy: 93.6, hits: { 0: 8 }, maxCombo: 296, mods: { name: 'DT' }, rank: 'B', pp: { current: 199 } };
  const [done] = feed({ state: 7, time: 101_500, results: stale }, 9500);
  assert.deepEqual([done.kind, done.miss, done.acc, done.pp, done.peakCombo], ['finish', 4, 94.35, 272, 425], '上一把的结算数不用');
  // 对得上的（分数只多了最后几下）照常用结算界面的数
  const t2 = createOsuTracker();
  const feed2 = (options, now) => t2.feed(normalizeSnapshot(frame(options)), now);
  feed2({ time: 0 }, 0);
  feed2({ time: 1_500, score: 1_000, combo: 3 }, 500);
  feed2({ time: 100_900, score: 4_867_000, combo: 120, maxCombo: 425, miss: 4, acc: 94.35, pp: 271 }, 9000);
  const [ok] = feed2({ state: 7, time: 101_500, results: { score: 4_867_853, accuracy: 94.35, hits: { 0: 4 }, maxCombo: 425, mods: { name: 'DT' }, rank: 'A', pp: { current: 272 } } }, 9500);
  assert.deepEqual([ok.miss, ok.pp, ok.rank], [4, 272, 'A'], '这一把的结算数照常用');
}
{
  // 全连：一个没漏，最大连击到顶。
  const tracker = createOsuTracker();
  tracker.feed(normalizeSnapshot(frame({ time: 0 })), 0);
  tracker.feed(normalizeSnapshot(frame({ time: 100_000, score: 9, combo: 800, maxCombo: 800 })), 1);
  const [fc] = tracker.feed(normalizeSnapshot(frame({ state: 7, results: { rank: 'S', score: 9, accuracy: 99.1, hits: { 0: 0 }, maxCombo: 800 } })), 2);
  assert.deepEqual([fc.kind, fc.fullCombo, fc.rank], ['finish', true, 'S']);
}
{
  // 重开：时间倒回去、分数清零。重开次数累计；重开后还是同一把的延续。
  const tracker = createOsuTracker();
  const feed = (options, now) => tracker.feed(normalizeSnapshot(frame(options)), now);
  feed({ time: 0 }, 0);
  feed({ time: 30_000, score: 30_000, combo: 200, miss: 0, acc: 99 }, 1);
  const retry = feed({ time: 500, score: 0, combo: 0 }, 2);
  assert.deepEqual(kinds(retry), ['retry']);
  assert.deepEqual([retry[0].retries, Math.round(retry[0].before.progress * 100), retry[0].before.acc], [1, 29, 99]);
  feed({ time: 20_000, score: 9000, combo: 90 }, 3);
  assert.equal(feed({ time: 300, score: 0, combo: 0 }, 4)[0].retries, 2);
  // 没血了：血条有过值，后来掉到 0，然后离开打图界面。
  feed({ time: 50_000, score: 100, combo: 10, hp: 120, miss: 5 }, 5);
  feed({ time: 55_000, score: 110, combo: 0, hp: 0, miss: 20, acc: 71 }, 6);
  const fail = feed({ state: 5 }, 7);
  assert.deepEqual([kinds(fail), fail[0].retries, fail[0].miss, Math.round(fail[0].progress * 100)], [['fail'], 2, 20, 54]);
}
{
  // 中途退出（血条没掉到 0）；没有结算界面但打到了结尾也算打完。
  const tracker = createOsuTracker();
  tracker.feed(normalizeSnapshot(frame({ time: 0 })), 0);
  tracker.feed(normalizeSnapshot(frame({ time: 40_000, score: 5, combo: 30, hp: 150 })), 1);
  assert.deepEqual(kinds(tracker.feed(normalizeSnapshot(frame({ state: 0 })), 2)), ['quit']);
  tracker.feed(normalizeSnapshot(frame({ time: 0 })), 3);
  tracker.feed(normalizeSnapshot(frame({ time: 100_500, score: 5, combo: 400, maxCombo: 400, hp: 150, acc: 96 })), 4);
  const [end] = tracker.feed(normalizeSnapshot(frame({ state: 5 })), 5);
  assert.deepEqual([end.kind, end.acc, end.peakCombo], ['finish', 96, 400]);
  // 打着打着换了图（不该发生，但数据乱了也不能把两把混在一起）。
  tracker.feed(normalizeSnapshot(frame({ time: 0 })), 6);
  const swapped = tracker.feed(normalizeSnapshot(frame({ time: 0, map: { ...MAP, checksum: 'other', title: 'OTHER', titleUnicode: 'OTHER' } })), 7);
  assert.deepEqual(kinds(swapped), ['quit', 'start']);
  assert.equal(swapped[1].map.title, 'OTHER');
  // tosu 给了失败标记时只信它（真机 2026-11-19：stable 下 play.failed 是布尔值）。
  {
    const flagged = createOsuTracker();
    flagged.feed(normalizeSnapshot(frame({ time: 0, failed: false })), 0);
    flagged.feed(normalizeSnapshot(frame({ time: 30_000, score: 5, combo: 3, hp: 90, failed: false })), 1);
    flagged.feed(normalizeSnapshot(frame({ time: 31_000, score: 5, combo: 0, hp: 40, miss: 9, failed: true })), 2);
    assert.deepEqual(kinds(flagged.feed(normalizeSnapshot(frame({ state: 5, failed: false })), 3)), ['fail'], '血条没到 0，但 tosu 说失败了');
    // 开了 NoFail：血条到 0，标记一直是 false，中途退出算退出不算失败。
    const noFail = createOsuTracker();
    noFail.feed(normalizeSnapshot(frame({ time: 0, failed: false })), 0);
    noFail.feed(normalizeSnapshot(frame({ time: 30_000, score: 5, combo: 3, hp: 90, failed: false })), 1);
    noFail.feed(normalizeSnapshot(frame({ time: 40_000, score: 6, combo: 0, hp: 0, miss: 30, failed: false })), 2);
    assert.deepEqual(kinds(noFail.feed(normalizeSnapshot(frame({ state: 5, failed: false })), 3)), ['quit']);
    assert.equal(normalizeSnapshot(frame({})).play.failed, null, '老版本没有这个字段');
  }
  // 看回放 / 观战：打图的人不是自己。
  const replay = createOsuTracker().feed(normalizeSnapshot(frame({ player: 'SOMEONE_ELSE' })), 0);
  assert.equal(replay[0].replay, true);
  assert.equal(createOsuTracker().feed(normalizeSnapshot(frame({ me: '' })), 0)[0].replay, false, '读不到自己的名字时当成是他在打');
}

{
  // 真机上记下来的样子（stable + tosu，2026-11-19）：刚进打图界面的头一帧，时间还停在选歌界面试听的位置、
  // 打图的人是空的、血条是 0；下一帧才从头开始。头一帧不能当成开始——否则这一把的进度一直卡在 81%。
  const tracker = createOsuTracker();
  const feed = (options, now) => tracker.feed(normalizeSnapshot(frame(options)), now);
  const LONG = { ...MAP, time: { live: 0, firstObject: 0, lastObject: 226_000 }, stats: { stars: { total: 7.37 }, maxCombo: 1569 } };
  feed({ state: 5, map: LONG, time: 79_000, player: '', hp: 0, failed: false }, 0);
  assert.deepEqual(kinds(feed({ map: LONG, time: 183_000, player: '', hp: 0, acc: 100, failed: false }, 1)), [], '残留的头一帧：还不算开始');
  assert.equal(tracker.current(), null);
  const start = feed({ map: LONG, time: 0, hp: 100, acc: 0, failed: false }, 2);
  assert.deepEqual([kinds(start), start[0].progress, start[0].replay], [['start'], 0, false]);
  feed({ map: LONG, time: 46_000, score: 90_000, combo: 325, acc: 96.6, failed: false }, 3);
  const broke = feed({ map: LONG, time: 47_000, score: 90_100, combo: 0, maxCombo: 325, miss: 1, acc: 96.23, failed: false }, 4);
  assert.deepEqual([kinds(broke), broke[0].lostCombo, Math.round(broke[0].progress * 100)], [['combo-break'], 325, 21], '进度是真的打到哪，不是试听的位置');
  feed({ map: LONG, time: 125_000, score: 300_000, combo: 12, maxCombo: 325, miss: 12, acc: 93.76, failed: false }, 5);
  const quit = feed({ state: 5, map: LONG, time: 125_000, player: '', hp: 0, failed: false }, 6);
  assert.deepEqual([kinds(quit), Math.round(quit[0].progress * 100), quit[0].peakCombo], [['quit'], 55, 325]);
  // 点进去马上退出（还没真的开始）：当没发生过。
  feed({ map: LONG, time: 183_000, player: '', hp: 0 }, 7);
  assert.deepEqual(kinds(feed({ state: 5, map: LONG, player: '', hp: 0 }, 8)), []);
  // 是不是回放要等名字出来才知道。
  const replay = createOsuTracker();
  assert.deepEqual(kinds(replay.feed(normalizeSnapshot(frame({ time: 9000, player: '', hp: 0 })), 0)), []);
  assert.equal(replay.feed(normalizeSnapshot(frame({ time: 0, player: 'SOMEONE_ELSE', hp: 100 })), 1)[0].replay, true);
  // 名字、血条、分数一直都没有（某些模式）：等十几帧后放行，不能永远不开始。
  const mute = createOsuTracker();
  let seen = [];
  for (let i = 0; i < 20 && !seen.length; i += 1) seen = mute.feed(normalizeSnapshot(frame({ time: i * 200, player: '', hp: 0 })), i);
  assert.deepEqual(kinds(seen), ['start']);
}

// ── 2b. 用户后来要的三种时刻：突然掉准度、多人房里超人 / 被超、休息段 ──────────────────────
{

  // 界面状态：多人房要认出来（selectMulti 里也带 select，不能被当成单人选歌）。
  for (const [state, expected] of [[{ number: 12, name: 'matchSetup' }, 'multi'], [{ number: 11, name: 'lobby' }, 'multi'], [{ name: 'selectMulti' }, 'multi'], [{ number: 13 }, 'multi'], [{ number: 14, name: 'rankingVs' }, 'results'], [{ number: 5, name: 'selectPlay' }, 'select']]) {
    assert.equal(normalizeSnapshot({ state }).state, expected, JSON.stringify(state));
  }
  const snap = normalizeSnapshot(frame({ n100: 14, n50: 2, isBreak: true, pp: 142.6, board: [['OWNER', 5], ['RIVAL_A', 9], ['', 3]] }));
  assert.deepEqual([snap.play.n100, snap.play.n50, snap.map.isBreak, snap.play.pp], [14, 2, true, 143]);
  assert.deepEqual(snap.board, [{ name: 'OWNER', score: 5, failed: false }, { name: 'RIVAL_A', score: 9, failed: false }], '没名字的那一行不要');

  // 突然掉准度：十来秒里多出 5 个以上不准的，而且准确率掉了 0.6 个点以上。
  {
    const tracker = createOsuTracker();
    const feed = (options, now) => tracker.feed(normalizeSnapshot(frame(options)), now);
    feed({ time: 0 }, 0);
    assert.deepEqual(kinds(feed({ time: 1500, score: 10, n100: 3, acc: 82 }, 500)), [], '刚开打那几下准确率大起大落，不算');
    feed({ time: 20_000, score: 2000, n100: 3, acc: 98.9, combo: 5 }, 20_000);
    assert.deepEqual(kinds(feed({ time: 24_000, score: 2400, n100: 6, acc: 98.5, combo: 9 }, 24_000)), [], '才多了 3 个');
    const drop = feed({ time: 28_000, score: 2800, n100: 9, acc: 97.8, combo: 13, miss: 1 }, 28_000);
    assert.deepEqual(kinds(drop), ['acc-drop']);
    assert.deepEqual([drop[0].new100, drop[0].new50, drop[0].accFrom, drop[0].acc, drop[0].n100, drop[0].seconds], [6, 0, 98.9, 97.8, 9, 8]);
    assert.deepEqual(kinds(feed({ time: 29_000, score: 2900, n100: 10, acc: 97.7, combo: 14, miss: 1 }, 29_000)), [], '刚报过，从头再攒');
    // 慢慢掉的不算「突然」：一分钟里每 6 秒一个 100。
    let slow = [];
    for (let i = 1; i <= 10; i += 1) slow = slow.concat(feed({ time: 29_000 + i * 6000, score: 3000 + i, n100: 10 + i, acc: 97.7 - i * 0.2, combo: 14 + i, miss: 1 }, 29_000 + i * 6000));
    assert.deepEqual(kinds(slow), []);
    // 50 比 100 重：3 个 50 就够数（算 6 个）。
    const fifty = feed({ time: 91_000, score: 4000, n100: 20, n50: 3, acc: 94.2, combo: 2, miss: 1 }, 91_000);
    assert.deepEqual([kinds(fifty), fifty[0].new50], [['acc-drop'], 3]);
    // 个数够了但准确率没怎么掉（图很长、物件很多）：不算。
    const steady = createOsuTracker();
    steady.feed(normalizeSnapshot(frame({ time: 0 })), 0);
    steady.feed(normalizeSnapshot(frame({ time: 50_000, score: 9, n100: 40, acc: 96.0, combo: 3 })), 50_000);
    assert.deepEqual(kinds(steady.feed(normalizeSnapshot(frame({ time: 56_000, score: 10, n100: 46, acc: 95.7, combo: 9 })), 56_000)), []);
  }

  // 休息段：刚进去报一次，带着到现在的 pp 和 100 的个数；开头还没打到第一个圈那段不算。
  {
    const tracker = createOsuTracker();
    const feed = (options, now) => tracker.feed(normalizeSnapshot(frame(options)), now);
    feed({ time: 0, isBreak: true }, 0);
    assert.deepEqual(kinds(feed({ time: 1200, isBreak: true }, 1)), [], '开头的空白不算休息段');
    feed({ time: 30_000, score: 500, n100: 14, n50: 1, miss: 2, acc: 97.3, combo: 40, maxCombo: 325, pp: 142 }, 2);
    const rest = feed({ time: 31_000, score: 500, n100: 14, n50: 1, miss: 2, acc: 97.3, combo: 40, maxCombo: 325, pp: 142, isBreak: true }, 3);
    assert.deepEqual(kinds(rest), ['break']);
    assert.deepEqual([rest[0].pp, rest[0].n100, rest[0].n50, rest[0].miss, rest[0].peakCombo, Math.round(rest[0].progress * 100)], [142, 14, 1, 2, 325, 30]);
    assert.deepEqual(kinds(feed({ time: 35_000, score: 500, n100: 14, n50: 1, miss: 2, acc: 97.3, combo: 40, isBreak: true }, 4)), [], '休息段里不重复报');
    feed({ time: 45_000, score: 600, n100: 14, n50: 1, miss: 2, acc: 97.4, combo: 60 }, 5);
    assert.deepEqual(kinds(feed({ time: 70_000, score: 900, n100: 15, n50: 1, miss: 2, acc: 97.5, combo: 61, isBreak: true }, 6)), ['break'], '下一个休息段再报');
  }

  // 多人房：从房间进的打图才看名次；名次变了要稳住两秒半才算。
  {
    const tracker = createOsuTracker();
    const feed = (options, now) => tracker.feed(normalizeSnapshot(frame(options)), now);
    const board = (mine, a, b) => [['OWNER', mine], ['RIVAL_A', a], ['RIVAL_B', b]];
    feed({ state: 12 }, 0);
    const start = feed({ time: 0, board: board(0, 0, 0) }, 1000);
    assert.deepEqual([kinds(start), start[0].multi], [['start'], true]);
    assert.deepEqual(kinds(feed({ time: 3000, score: 10, board: board(10, 900, 5) }, 2000)), [], '开头分数都很低，名次乱跳，不看');
    feed({ time: 20_000, score: 100_000, board: board(100_000, 120_000, 80_000) }, 10_000);
    assert.deepEqual(tracker.current().place, { rank: 2, players: 3 });
    // 闪一下又回去：不算。
    feed({ time: 21_000, score: 101_000, board: board(101_000, 121_000, 102_000) }, 11_000);
    assert.deepEqual(kinds(feed({ time: 22_000, score: 105_000, board: board(105_000, 122_000, 103_000) }, 12_000)), []);
    // 真的被超了：稳住两秒半后报，说得出是被谁。
    feed({ time: 25_000, score: 106_000, board: board(106_000, 125_000, 110_000) }, 15_000);
    assert.deepEqual(kinds(feed({ time: 26_000, score: 107_000, board: board(107_000, 126_000, 112_000) }, 16_000)), [], '还没稳住');
    const down = feed({ time: 28_000, score: 108_000, board: board(108_000, 127_000, 115_000) }, 18_000);
    assert.deepEqual(kinds(down), ['rank-down']);
    assert.deepEqual([down[0].from, down[0].to, down[0].players, down[0].names], [2, 3, 3, ['RIVAL_B']]);
    // 一口气超过两个人：只报一次最终的变化，两个名字都带上。
    feed({ time: 40_000, score: 200_000, board: board(200_000, 130_000, 120_000) }, 30_000);
    const up = feed({ time: 43_000, score: 205_000, board: board(205_000, 131_000, 121_000) }, 33_000);
    assert.deepEqual([kinds(up), up[0].from, up[0].to, up[0].names.sort()], [['rank-up'], 3, 1, ['RIVAL_A', 'RIVAL_B']]);
    // 结束：带上名次（多人房的结算界面是 rankingVs）。
    const finish = feed({ state: 14, board: board(205_000, 131_000, 121_000), results: { rank: 'A', score: 205_000, accuracy: 96, hits: { 0: 3 }, maxCombo: 300 } }, 40_000);
    assert.deepEqual([kinds(finish), finish[0].place, finish[0].multi], [['finish'], { rank: 1, players: 3 }, true]);

    // 榜上没有他自己那一行也算得出名次（拿他的分数和别人比）。
    assert.deepEqual([standingOf(normalizeSnapshot(frame({ score: 50, board: [['RIVAL_A', 90], ['RIVAL_B', 10]] }))).rank, standingOf(normalizeSnapshot(frame({ score: 50, board: [['RIVAL_A', 90], ['RIVAL_B', 10]] }))).players], [2, 3]);
    assert.equal(standingOf(normalizeSnapshot(frame({ score: 50, board: [['OWNER', 50]] }))), null, '只有自己：没有名次可言');

    // 单人打图：左边那列是排行榜上别人的旧成绩，一路超过去不值得一个个说——不看名次。
    const solo = createOsuTracker();
    solo.feed(normalizeSnapshot(frame({ state: 5 })), 0);
    assert.equal(solo.feed(normalizeSnapshot(frame({ time: 0, board: board(0, 500_000, 400_000) })), 1)[0].multi, false);
    solo.feed(normalizeSnapshot(frame({ time: 30_000, score: 100, board: board(100, 500_000, 400_000) })), 10_000);
    solo.feed(normalizeSnapshot(frame({ time: 40_000, score: 900_000, board: board(900_000, 500_000, 400_000) })), 20_000);
    assert.deepEqual(kinds(solo.feed(normalizeSnapshot(frame({ time: 45_000, score: 950_000, board: board(950_000, 500_000, 400_000) })), 25_000)), []);
    assert.equal(solo.feed(normalizeSnapshot(frame({ state: 7, results: { rank: 'S', score: 1 } })), 30_000)[0].place, null);
    // 从多人房出来再去单人：不沿用「多人」。
    const mixed = createOsuTracker();
    mixed.feed(normalizeSnapshot(frame({ state: 12 })), 0);
    mixed.feed(normalizeSnapshot(frame({ state: 5 })), 1);
    assert.equal(mixed.feed(normalizeSnapshot(frame({ time: 0 })), 2)[0].multi, false);
  }
}

// ── 2c. 滑条断（用户：「我 sliderbreak 之后她没反应」）───────────────────────────────
{
  const tracker = createOsuTracker();
  const feed = (options, now) => tracker.feed(normalizeSnapshot(frame(options)), now);
  const BIG = { ...MAP, stats: { stars: { total: 5.58 }, maxCombo: 732 } };
  feed({ time: 0, map: BIG }, 0);
  feed({ time: 30_000, map: BIG, score: 100, combo: 80 }, 1);
  // 一直 0 miss，断在滑条上：认得出是滑条断，而且是「全连没了」。
  const first = feed({ time: 31_000, map: BIG, score: 101, combo: 0, maxCombo: 80, sb: 1 }, 2);
  assert.deepEqual([kinds(first), first[0].lostCombo, first[0].sliderBreak, first[0].fcLost], [['combo-break'], 80, true, true]);
  // 第二次断：全连早就没了。
  feed({ time: 50_000, map: BIG, score: 200, combo: 90, maxCombo: 90, sb: 1 }, 3);
  const second = feed({ time: 51_000, map: BIG, score: 201, combo: 0, maxCombo: 90, sb: 1, miss: 1 }, 4);
  assert.deepEqual([second[0].sliderBreak, second[0].fcLost], [false, false], 'miss 断的不算滑条断；全连之前就没了');
}

console.log('events: ok');
