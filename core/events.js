/**
 * 看主人打 osu! · 从 tosu 的数据里认出「值得说一句」的时刻（纯函数，不碰网络和文件）
 *
 * tosu（https://github.com/tosuapp/tosu，第三方工具）读 osu! 的内存，在本机
 * ws://127.0.0.1:24050/websocket/v2 上不停地推一份很大的 JSON：现在在哪个界面、哪张图、
 * 分数 / 准确率 / 连击 / miss。这里做两件事：
 *
 *   normalizeSnapshot(raw)   把那份 JSON 压成我们用得到的十几个字段（字段缺了不抛）
 *   createOsuTracker()       喂进一连串快照，吐出事件：
 *       start        开始打一张图
 *       combo        连击越过一个整数关口（100 / 200 / 300 / 500 / …）
 *       combo-break  一段不短的连击断了
 *       acc-drop     十来秒里连着出了好几个 100 / 50，准确率掉了一截
 *       break        进了休息段（带着到现在为止的 pp、100 的个数等）
 *       break-end    休息段结束（只用来换姿势，不说话；osu-pet 加的）
 *       rank-up      多人房里超过了别人
 *       rank-down    多人房里被别人超过了
 *       retry        同一张图重开了
 *       finish       打完了（带结算数据；多人房里带名次）
 *       fail         失败了
 *       quit         中途退出
 *
 * 界面状态同时认编号和名字：tosu 沿用 osu!stable 的编号（2 = 打图，7 = 结算，5 = 选歌，11–13 = 多人房），
 * 名字是这些编号的英文名（真机上见过 menu / selectPlay / play / resultScreen / exit），认不出的一律当「别的界面」。
 */

const COMBO_MARKS = [100, 200, 300, 500, 750, 1000, 1500, 2000, 3000];
/** 「突然掉准度」看多长的一段。 */
const ACC_WINDOW_MS = 12_000;
/** 这一段里至少多出这么多个不准的（100 算 1 个，50 算 2 个）。 */
const ACC_DROP_HITS = 5;
/** 而且准确率至少掉了这么多个百分点。 */
const ACC_DROP_POINTS = 0.6;
/** 名次变了之后要稳住这么久才算数：两个人分数咬得很紧时会来回跳。 */
const RANK_SETTLE_MS = 2500;

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const text = (value, max = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function stateOf(state) {
  const number = Number(state?.number);
  const name = String(state?.name ?? '').toLowerCase();
  if (number === 2 || /^play/.test(name)) return 'play';
  if ([7, 14, 17, 18].includes(number) || /result|ranking/.test(name)) return 'results';
  // 多人房的大厅 / 房间 / 房间里选歌：要排在「选歌」前面认（selectMulti 也带 select）。
  if ([11, 12, 13].includes(number) || /lobby|matchsetup|multi/.test(name)) return 'multi';
  if ([4, 5].includes(number) || /select/.test(name)) return 'select';
  if (number === 0 || /menu/.test(name)) return 'menu';
  return 'other';
}

/** tosu 的一帧 → 我们用的形状。raw 不是对象就返回 null。 */
export function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const beatmap = raw.beatmap ?? {};
  const play = raw.play ?? {};
  const results = raw.resultsScreen ?? {};
  const title = text(beatmap.titleUnicode || beatmap.title);
  const artist = text(beatmap.artistUnicode || beatmap.artist, 80);
  const version = text(beatmap.version, 80);
  return {
    state: stateOf(raw.state),
    me: text(raw.profile?.name, 40),
    player: text(play.playerName, 40),
    map: {
      key: text(beatmap.checksum, 64) || `${artist}|${title}|${version}`,
      title,
      artist,
      version,
      mapper: text(beatmap.mapper, 40),
      // 官网上的谱面编号 / 谱面集编号（查玩家标签用，core/osu-api.js）；本地图是 0
      id: Math.max(0, Math.trunc(num(beatmap.id))),
      setId: Math.max(0, Math.trunc(num(beatmap.set))),
      stars: Math.round(num(beatmap.stats?.stars?.total) * 100) / 100,
      // aim / 手速 / 读图各自的星数、滑条占比（tosu 算好的，算上 mod；2026-11-21 开局说「偏 aim 还是偏手速」用）。读不到是 0
      starsAim: Math.round(num(beatmap.stats?.stars?.aim) * 100) / 100,
      starsSpeed: Math.round(num(beatmap.stats?.stars?.speed) * 100) / 100,
      starsReading: Math.round(num(beatmap.stats?.stars?.reading) * 100) / 100,
      sliderFactor: Math.round(num(beatmap.stats?.stars?.sliderFactor) * 1000) / 1000,
      maxCombo: Math.round(num(beatmap.stats?.maxCombo)),
      // 下面这几样 tosu 给的都是算上当前 mod 之后的（tosu 源码：commonBPM = bpm × clockRate；AR / CS 的 converted 在套用 mod 之后算）。
      bpm: Math.round(num(beatmap.stats?.bpm?.common || beatmap.stats?.bpm?.max)),
      bpmMin: Math.round(num(beatmap.stats?.bpm?.min)),
      bpmMax: Math.round(num(beatmap.stats?.bpm?.max)),
      ar: Math.round(num(beatmap.stats?.ar?.converted, num(beatmap.stats?.ar?.original)) * 10) / 10,
      arOriginal: Math.round(num(beatmap.stats?.ar?.original) * 10) / 10,
      cs: Math.round(num(beatmap.stats?.cs?.converted, num(beatmap.stats?.cs?.original)) * 10) / 10,
      csOriginal: Math.round(num(beatmap.stats?.cs?.original) * 10) / 10,
      rate: num(play.mods?.rate, 1) || 1,
      timeLive: num(beatmap.time?.live),
      timeFirst: num(beatmap.time?.firstObject),
      timeLast: num(beatmap.time?.lastObject),
      // 谱面里的休息段（中间一段没有圈）。
      isBreak: beatmap.isBreak === true,
      // 谱面文件在哪（难段预告读它，core/heads-up.js）：Songs 文件夹 + 相对它的路径。路径原样留着（不压空白）。
      songsDir: String(raw.folders?.songs ?? '').slice(0, 400),
      file: String(raw.directPath?.beatmapFile ?? '').slice(0, 400),
    },
    play: {
      score: num(play.score),
      acc: Math.round(num(play.accuracy) * 100) / 100,
      hp: num(play.healthBar?.normal, -1),
      // tosu 自己给的「这一把失败了」（真机上的 tosu 有这个字段；老版本没有时是 null，退回看血条）。
      failed: typeof play.failed === 'boolean' ? play.failed : null,
      miss: Math.round(num(play.hits?.['0'])),
      n100: Math.round(num(play.hits?.['100'])),
      n50: Math.round(num(play.hits?.['50'])),
      sliderBreaks: Math.round(num(play.hits?.sliderBreaks)),
      combo: Math.round(num(play.combo?.current)),
      maxCombo: Math.round(num(play.combo?.max)),
      mods: text(play.mods?.name, 40),
      rank: text(play.rank?.current, 4),
      pp: Math.round(num(play.pp?.current)),
      // 这一把要是全连能拿多少 pp（脚下的 pp 环上显示，2026-11-21）
      ppFc: Math.round(num(play.pp?.fc)),
    },
    // 难度曲线（tosu 算好的：每段约 400 毫秒一个峰值，aim / speed / reading 等几条；xaxis 是真实毫秒，开 DT 时要乘回倍速）。
    // 只是引用，不拷贝；难段预告拿它补漏（core/heads-up.js）
    graph: raw.performance?.graph && Array.isArray(raw.performance.graph.series) && Array.isArray(raw.performance.graph.xaxis) ? raw.performance.graph : null,
    // 游戏里左边那一列分数：多人房里是同房的人，单人时是排行榜上别人的旧成绩。只留名字和分数。
    board: (Array.isArray(raw.leaderboard) ? raw.leaderboard : []).slice(0, 64).map((slot) => ({
      name: text(slot?.name, 40),
      score: num(slot?.score),
      failed: slot?.isFailed === true,
    })).filter((slot) => slot.name),
    results: {
      score: num(results.score),
      acc: Math.round(num(results.accuracy) * 100) / 100,
      miss: Math.round(num(results.hits?.['0'])),
      maxCombo: Math.round(num(results.maxCombo)),
      mods: text(results.mods?.name, 40),
      rank: text(results.rank, 4),
      pp: Math.round(num(results.pp?.current)),
    },
  };
}

/** 打到哪了（0–1）；图的长度读不到时是 null。 */
export function progressOf(map, timeLive = map?.timeLive) {
  const span = num(map?.timeLast) - num(map?.timeFirst);
  if (!(span > 1000)) return null;
  return Math.min(1, Math.max(0, (num(timeLive) - num(map.timeFirst)) / span));
}

/**
 * 多人房里他现在第几。不靠榜上有没有他自己那一行（不同版本的 tosu 不一定带），
 * 直接拿他的分数和别人的比：第几 = 1 + 分数比他高的人数。
 */
export function standingOf(snapshot) {
  const mine = [snapshot.player, snapshot.me].filter(Boolean);
  const others = snapshot.board.filter((slot) => !mine.includes(slot.name));
  if (!others.length) return null;
  const ahead = others.filter((slot) => slot.score > snapshot.play.score);
  return { rank: ahead.length + 1, players: others.length + 1, ahead: ahead.map((slot) => slot.name), others };
}

/**
 * @param {object} [options]
 * @param {number} [options.comboBreakMin]  断掉的连击至少这么长才算一件事（短连击断了不值得说）
 */
export function createOsuTracker({ comboBreakMin = 50 } = {}) {
  let prevState = 'other';
  // 进打图界面之前最后待过的界面是不是多人房：是的话这一把算多人（左边那列是同房的人，名次才有意义）。
  let fromMulti = false;
  let run = null;

  const mapInfo = (map) => ({
    title: map.title, artist: map.artist, version: map.version, stars: map.stars, maxCombo: map.maxCombo,
    bpm: map.bpm, bpmMin: map.bpmMin, bpmMax: map.bpmMax, ar: map.ar, arOriginal: map.arOriginal, cs: map.cs, csOriginal: map.csOriginal, rate: map.rate,
    // 开局点评时找「这是张什么图」（core/map-info.js 按 key + 倍速存的）
    key: map.key,
    starsAim: map.starsAim, starsSpeed: map.starsSpeed, starsReading: map.starsReading, sliderFactor: map.sliderFactor,
  });
  const base = (kind, now, extra = {}) => ({
    kind,
    at: now,
    map: mapInfo(run.map),
    mods: run.mods,
    replay: run.replay,
    multi: run.multi,
    retries: run.retries,
    progress: run.progress,
    // 谱面里打到第几毫秒（日志里写「谱面 1:42」，和难段预告的时间对得上）
    timeMs: Number.isFinite(run.map?.timeLive) ? run.map.timeLive : null,
    acc: run.acc,
    miss: run.miss,
    n100: run.n100,
    n50: run.n50,
    pp: run.pp,
    combo: run.combo,
    peakCombo: run.peakCombo,
    ...extra,
  });

  function begin(snapshot, now, retries = 0, live = false) {
    run = {
      key: snapshot.map.key,
      // 刚进打图界面的头一两帧是残留数据（见 feed 里的说明）：等真的开始了才算数。
      live,
      waited: 0,
      map: snapshot.map,
      startedAt: now,
      retries,
      multi: fromMulti,
      // 自己的名字和打图的人都读得到、而且不一样：这是在看回放或观战，不是他自己在打。
      replay: Boolean(snapshot.me && snapshot.player && snapshot.me !== snapshot.player),
      mods: snapshot.play.mods,
      combo: 0,
      peakCombo: 0,
      miss: 0,
      n100: 0,
      n50: 0,
      sliderBreaks: 0,
      score: 0,
      acc: snapshot.play.acc,
      rank: '',
      pp: 0,
      maxTime: snapshot.map.timeLive,
      progress: progressOf(snapshot.map),
      hpSeen: false,
      hpZero: false,
      failFlagSeen: false,
      failed: false,
      marks: new Set(),
      // 突然掉准度：留最近十来秒的样本（时间、不准的个数、准确率）。
      samples: [],
      inBreak: false,
      // 多人房名次：place 是已经报过的名次；pending 是刚变、还没稳住的。
      place: null,
      pending: null,
    };
  }

  function absorb(snapshot) {
    const play = snapshot.play;
    run.map = { ...snapshot.map };
    run.mods = play.mods || run.mods;
    run.combo = play.combo;
    run.peakCombo = Math.max(run.peakCombo, play.combo, play.maxCombo);
    run.miss = play.miss;
    run.n100 = play.n100;
    run.n50 = play.n50;
    run.sliderBreaks = play.sliderBreaks;
    run.score = play.score;
    run.acc = play.acc;
    run.rank = play.rank || run.rank;
    run.pp = play.pp;
    run.maxTime = Math.max(run.maxTime, snapshot.map.timeLive);
    run.progress = progressOf(snapshot.map, run.maxTime);
    if (play.hp > 0) run.hpSeen = true;
    // 见过血条有值之后又掉到 0：没血了。（有些模式 / mod 下血条一直是 0，那种不算。）
    if (run.hpSeen && play.hp >= 0 && play.hp <= 0.0001) run.hpZero = true;
    if (play.failed !== null) run.failFlagSeen = true;
    if (play.failed === true) run.failed = true;
  }

  /** 十来秒里连着出了好几个 100 / 50，准确率掉了一截。报过一次就从头再攒。 */
  function accDrop(snapshot, now) {
    const play = snapshot.play;
    const off = play.n100 + play.n50 * 2;
    run.samples.push({ at: now, off, acc: play.acc, n100: play.n100, n50: play.n50 });
    // 只和这十来秒之内最早的那个样本比：更早的一律丢掉（不能拿半分钟前的准确率当基准）。
    while (run.samples.length > 1 && now - run.samples[0].at > ACC_WINDOW_MS) run.samples.shift();
    const first = run.samples[0];
    // 刚开打那几下准确率本来就大起大落（第一个 100 就能掉几个点）：打过一小段再看。
    if (!(run.progress > 0.04)) return null;
    if (off - first.off < ACC_DROP_HITS || first.acc - play.acc < ACC_DROP_POINTS) return null;
    const event = { new100: play.n100 - first.n100, new50: play.n50 - first.n50, accFrom: first.acc, seconds: Math.max(1, Math.round((now - first.at) / 1000)) };
    run.samples = [{ at: now, off, acc: play.acc, n100: play.n100, n50: play.n50 }];
    return event;
  }

  /** 多人房里的名次变化：稳住一小会儿才算，一次只报最终的变化。 */
  function rankChange(snapshot, now) {
    if (!run.multi) return null;
    const standing = standingOf(snapshot);
    if (!standing) return null;
    // 开头大家分数都很低，名次乱跳：打过一小段再开始看。
    if (!(run.progress > 0.08)) { run.place = standing; run.pending = null; return null; }
    if (!run.place) { run.place = standing; return null; }
    if (standing.rank === run.place.rank) { run.pending = null; return null; }
    if (!run.pending || run.pending.rank !== standing.rank) { run.pending = { rank: standing.rank, since: now }; return null; }
    if (now - run.pending.since < RANK_SETTLE_MS) return null;
    const before = run.place;
    run.place = standing;
    run.pending = null;
    const up = standing.rank < before.rank;
    // 被谁超了：现在排在他前面、之前不在前面的人。超了谁：之前在他前面、现在不在了的人。
    const names = up ? before.ahead.filter((name) => !standing.ahead.includes(name)) : standing.ahead.filter((name) => !before.ahead.includes(name));
    return { kind: up ? 'rank-up' : 'rank-down', from: before.rank, to: standing.rank, players: standing.players, names: names.slice(0, 3) };
  }

  function end(snapshot, now) {
    const events = [];
    const results = snapshot.results;
    // 结算界面的数（resultsScreen）只在像是这一把的时候才信：tosu 刚切到结算界面的头几帧，里面可能还是上一次结算的数。
    // 真机（2026-11-22，Alive [Insane] DT 连打两把）：第二把 4 miss、94.35%、272pp，她却说「8 个 miss 还能有 199pp」——
    // 报的、存进成绩的全是上一把的 acc / miss / pp / 连击。所以要分数对得上（不比打图时最后看到的少、多也多不了多少）、
    // miss 不比打图时少、也多不了几个；对不上就用打图时最后一帧的数（脚下 counter 显示的就是这些）。
    const hasResults = snapshot.state === 'results' && (results.rank || results.score > 0)
      && run.score > 0 && results.score >= run.score && results.score - run.score <= Math.max(20_000, run.score * 0.05)
      && results.miss >= run.miss && results.miss <= run.miss + 3;
    const reachedEnd = run.progress !== null && run.progress >= 0.97;
    // 有 tosu 的失败标记就只信它（开了 NoFail 时血条到 0 不算失败）；没有才看血条。
    const failed = run.failFlagSeen ? run.failed : run.hpZero;
    const place = run.multi && run.place ? { rank: run.place.rank, players: run.place.players } : null;
    if (snapshot.state === 'results' || (reachedEnd && !failed)) {
      const miss = hasResults ? results.miss : run.miss;
      const maxCombo = hasResults ? Math.max(results.maxCombo, 0) || run.peakCombo : run.peakCombo;
      events.push(base('finish', now, {
        progress: 1,
        acc: hasResults && results.acc > 0 ? results.acc : run.acc,
        miss,
        peakCombo: maxCombo,
        rank: (hasResults && results.rank) || run.rank,
        pp: (hasResults && results.pp) || run.pp,
        mods: (hasResults && results.mods) || run.mods,
        fullCombo: miss === 0 && run.sliderBreaks === 0 && run.map.maxCombo > 0 && maxCombo >= run.map.maxCombo - 1,
        place,
      }));
    } else {
      events.push(base(failed ? 'fail' : 'quit', now, { place }));
    }
    run = null;
    return events;
  }

  /** 喂一帧，返回这一帧里发生的事（大多数时候是空数组）。 */
  function feed(snapshot, now = Date.now()) {
    if (!snapshot) return [];
    const events = [];
    const playing = snapshot.state === 'play';
    if (!playing && snapshot.state !== 'results' && snapshot.state !== 'other') fromMulti = snapshot.state === 'multi';

    if (run && (!playing || snapshot.map.key !== run.key)) {
      // 还没真的开始就离开了（点进去马上退出）：当没发生过。
      if (run.live) events.push(...end(snapshot, now));
      else run = null;
    }

    if (playing && !run) begin(snapshot, now);
    if (playing && run && !run.live) {
      // 真机（stable + tosu，2026-11-19）：界面状态刚变成「打图」的头一帧，时间还是选歌界面试听到的位置
      // （比如 183 秒），打图的人的名字是空的，血条是 0；下一帧才是真的从头开始。
      // 头一帧就当成开始，这一把的进度会一直卡在那个残留的位置上。所以等到名字、血条、分数任一样有了才算开始；
      // 一直等不到（某些模式）就在十几帧之后放行。
      const play = snapshot.play;
      run.waited += 1;
      if (snapshot.player || play.hp > 0 || play.score > 0 || run.waited > 15) {
        begin(snapshot, now, run.retries, true);
        absorb(snapshot);
        events.push(base('start', now));
      }
    } else if (playing && run) {
      const play = snapshot.play;
      // 重开：时间倒回去一大截，而且分数清零了。
      if (snapshot.map.timeLive < run.maxTime - 5000 && play.score < run.score && play.combo <= 1) {
        const retries = run.retries + 1;
        const before = { progress: run.progress, acc: run.acc, miss: run.miss, peakCombo: run.peakCombo };
        begin(snapshot, now, retries, true);
        absorb(snapshot);
        events.push(base('retry', now, { before }));
      } else {
        const lost = run.combo;
        const missed = play.miss > run.miss;
        const slid = play.sliderBreaks > run.sliderBreaks;
        const broke = play.combo < lost && (missed || slid || play.combo === 0);
        // 这一把到现在为止一个都没漏过：这一断，全连（FC）就没了。不管断在多长的连击上都值得说一句。
        const fcLost = broke && run.miss === 0 && run.sliderBreaks === 0 && !run.broken;
        const crossed = COMBO_MARKS.filter((mark) => lost < mark && play.combo >= mark && !run.marks.has(mark));
        absorb(snapshot);
        if (broke) run.broken = true;
        // 断在滑条上（没 miss，是滑条没跟住）：用户说过「sliderbreak 之后她没反应」，要让她知道是哪一种。
        if (broke && lost >= comboBreakMin) events.push(base('combo-break', now, { lostCombo: lost, sliderBreak: slid && !missed, fcLost }));
        if (crossed.length) {
          for (const mark of crossed) run.marks.add(mark);
          events.push(base('combo', now, { mark: crossed.at(-1) }));
        }
        const drop = accDrop(snapshot, now);
        if (drop) events.push(base('acc-drop', now, drop));
        // 休息段：刚进去的那一下报一次。开头还没打到第一个圈的那段不算。
        const resting = snapshot.map.isBreak && run.progress > 0.02;
        if (resting && !run.inBreak) events.push(base('break', now));
        // 休息段结束（osu-pet 2026-11-20 加的，SurfCore 原版没有）：角色在休息段里喝水，得知道什么时候放下杯子。
        // 只用来换姿势，不说话（watch.js 的闸门直接放过它）。
        else if (!resting && run.inBreak) events.push(base('break-end', now));
        run.inBreak = resting;
        const moved = rankChange(snapshot, now);
        if (moved) events.push(base(moved.kind, now, { from: moved.from, to: moved.to, players: moved.players, names: moved.names }));
      }
    }
    prevState = snapshot.state;
    return events;
  }

  /** 现在这一把的样子（给状态页看）；没在打就是 null。 */
  function current() {
    if (!run || !run.live) return null;
    return {
      map: mapInfo(run.map), mods: run.mods, replay: run.replay, multi: run.multi, retries: run.retries, progress: run.progress,
      acc: run.acc, miss: run.miss, combo: run.combo, peakCombo: run.peakCombo, startedAt: run.startedAt,
      place: run.multi && run.place ? { rank: run.place.rank, players: run.place.players } : null,
    };
  }

  return { feed, current, state: () => prevState };
}
