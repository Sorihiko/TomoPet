/** 测试共用的假数据：tosu 一帧的样子（照搬 SurfCore test-osu-watch.mjs）。 */
export const MAP = { checksum: 'abc123', title: 'SONG_TITLE', titleUnicode: 'SONG_TITLE', artist: 'ARTIST', version: 'Insane', mapper: 'MAPPER', time: { live: 0, firstObject: 1000, lastObject: 101_000 }, stats: { stars: { total: 4.83 }, maxCombo: 800 } };
export const frame = ({ state = 2, time = 0, score = 0, acc = 100, hp = 200, miss = 0, sb = 0, combo = 0, maxCombo = combo, mods = '', player = 'OWNER', me = 'OWNER', map = MAP, results = null, failed = undefined, n100 = 0, n50 = 0, isBreak = false, board = null, pp = 120 } = {}) => ({
  state: { number: state, name: { 0: 'menu', 2: 'play', 5: 'selectPlay', 7: 'resultScreen', 12: 'matchSetup', 14: 'rankingVs' }[state] ?? 'unknown' },
  profile: { name: me },
  beatmap: { ...map, isBreak, time: { ...map.time, live: time } },
  ...(board ? { leaderboard: board.map(([name, slotScore]) => ({ name, score: slotScore, isFailed: false })) } : {}),
  play: { ...(failed === undefined ? {} : { failed }), playerName: player, score, accuracy: acc, healthBar: { normal: hp }, hits: { 0: miss, 100: n100, 50: n50, sliderBreaks: sb }, combo: { current: combo, max: maxCombo }, mods: { name: mods }, rank: { current: 'A' }, pp: { current: pp } },
  resultsScreen: results ?? {},
});
export const kinds = (events) => events.map((event) => event.kind);
