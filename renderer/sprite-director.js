/**
 * 姿势皮肤（rig: "sprite"）的导演：现在该摆哪个姿势、做哪个动作。纯逻辑，不碰 DOM，Node 测试直接用。
 * renderer/sprite-rig.ts 每 100 毫秒问它一次 current(now)，变了就换图 / 换动作。
 *
 * 一张图一个姿势（CrossPet 那种立绘），所以「活」全靠：按游戏时刻换姿势、整个人的小动作（CSS）、换图淡入、待机时偶尔眨眼。
 *
 * 优先级（从高到低）：
 *   1. 反应：游戏时刻（react:<时刻>）、摸头、戳她。持续 holdMs；新的反应优先级低、而且旧的才开始不到 minHoldMs 时不打断。
 *      她开口时：反应是最近 talkKeepMs 内开始的，就陪着这句话一直摆着（她说的就是这件事）。
 *   2. 说话：talk-start 到 talk-stop 之间摆「说话」姿势（张嘴的那张）。
 *      皮肤有口型（mouth）时改成摆待机主图、渲染器在上面换嘴（current().mouth 为真）。
 *   3. 打图中（play-on / play-off）：专注的姿势；休息段（react:break 到 react:break-end）喝水。
 *   4. 待机：idle（有几张就隔一会儿换一张），很久没动静先打哈欠、再睡着。打图中不会困。
 *
 * spec（来自 manifest.sprite）：
 *   poses      { 姿势名: [图片文件, …] }（第一张是主图，眨眼只在主图上眨）
 *   blink      { base: 'idle', file }（可选）
 *   mouth      { base: 'idle', levels: { closed?, half?, wide? } }（可选，2026-11-21）：和主图一样大、只有嘴的叠加图，说话时按口型轨换
 *   base       { idle, playing, resting, talk, drowsy, sleep }：各状态用哪个姿势
 *   reactions  { 时刻: { pose, motion, holdMs, priority } }
 *   motions    { 姿势: 动作 }（反应没写动作时用）
 *   timing     { minHoldMs, talkKeepMs, drowsyAfterMs, sleepAfterMs, idleSwapMs }
 */

export const DEFAULT_TIMING = Object.freeze({
  minHoldMs: 2500,
  talkKeepMs: 12_000,
  drowsyAfterMs: 9 * 60_000,
  sleepAfterMs: 10 * 60_000,
  idleSwapMs: 9000,
  patHoldMs: 3500,
  pokeHoldMs: 2800,
  pokeWindowMs: 6000,
});

/** 动作名（renderer/sprite-rig.ts 里的 CSS 类 m-<名字>）。 */
export const MOTIONS = Object.freeze(['none', 'bob', 'hop', 'jump', 'quick', 'rock', 'sway', 'slow', 'shake', 'angry', 'dizzy', 'squish', 'jolt']);

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** 戳她：6 秒内连着戳，一次比一次生气（osu-pet 自己的设计，不是 CrossPet 的）。 */
const POKE_LADDER = [
  { pose: 'surprised', motion: 'jolt' },
  { pose: 'annoyed', motion: 'rock' },
  { pose: 'puffed', motion: 'jolt' },
  { pose: 'redhot', motion: 'angry' },
];

export function createSpriteDirector(spec = {}, { now = Date.now(), random = Math.random } = {}) {
  const poses = isObj(spec.poses) ? spec.poses : {};
  const base = { idle: 'idle', playing: 'listening', resting: 'drink', talk: 'listening', drowsy: 'yawn', sleep: 'sleeping', ...(isObj(spec.base) ? spec.base : {}) };
  const reactions = isObj(spec.reactions) ? spec.reactions : {};
  const motions = isObj(spec.motions) ? spec.motions : {};
  const timing = { ...DEFAULT_TIMING, ...(isObj(spec.timing) ? spec.timing : {}) };

  const framesOf = (pose) => {
    const list = poses[pose];
    return Array.isArray(list) ? list.filter((f) => typeof f === 'string') : typeof list === 'string' ? [list] : [];
  };
  const has = (pose) => framesOf(pose).length > 0;
  // 口型：至少有一张张嘴图、底下那个姿势存在才算（缺了就照旧摆「说话」姿势）。
  const mouthSpec = isObj(spec.mouth) && isObj(spec.mouth.levels) ? spec.mouth : null;
  const mouthLevels = mouthSpec ? Object.fromEntries(['closed', 'half', 'wide'].filter((k) => typeof mouthSpec.levels[k] === 'string' && mouthSpec.levels[k]).map((k) => [k, mouthSpec.levels[k]])) : {};
  const mouthBase = mouthSpec && (mouthLevels.half || mouthLevels.wide) && has(mouthSpec.base || 'idle') ? (mouthSpec.base || 'idle') : null;
  /** 姿势不存在就退回：反应 → 现在的底姿势；底姿势 → idle。 */
  const pick = (pose, fallback) => (has(pose) ? pose : has(fallback) ? fallback : 'idle');

  const state = {
    playing: false,
    resting: false,
    talking: false,
    talkSince: 0,
    reaction: null, // { pose, motion, until, priority, startedAt, moment, talkExtended?, coax? }
    lastReaction: null, // 刚过期的那个（见 talk-start）
    lastActivity: now,
    idleFrame: 0,
    idleSince: now,
    pokes: [],
    angryUntil: 0,
  };

  function activity(at) { state.lastActivity = at; }

  /** 开始一个反应。返回是否真的换上了。 */
  function startReaction({ pose, motion, holdMs, priority = 1, moment = null }, at) {
    const cur = state.reaction;
    if (cur && at < cur.until && priority < cur.priority && at - cur.startedAt < timing.minHoldMs) return false;
    const resolved = pick(pose, baseNow().pose);
    state.reaction = {
      pose: resolved,
      motion: motion || motions[resolved] || 'bob',
      until: at + Math.max(500, Number(holdMs) || 4000),
      priority,
      startedAt: at,
      moment,
    };
    return true;
  }

  function baseNow(at = state.lastActivity) {
    if (state.playing) return state.resting ? { pose: pick(base.resting, base.playing), motion: motions[base.resting] || 'slow' } : { pose: pick(base.playing, base.idle), motion: 'slow' };
    const quiet = at - state.lastActivity;
    if (quiet >= timing.sleepAfterMs) return { pose: pick(base.sleep, base.idle), motion: 'slow' };
    if (quiet >= timing.drowsyAfterMs) return { pose: pick(base.drowsy, base.idle), motion: 'squish' };
    return { pose: pick(base.idle, 'idle'), motion: 'bob' };
  }

  /**
   * 收一条命令（和别的渲染器同一套名字）：
   *   react:<时刻>  play-on  play-off  talk-start  talk-stop  talk  pat  poke  hop  blink
   * 不认识的直接忽略。返回 true 表示认得。
   */
  function command(cmd, at = Date.now()) {
    const name = String(cmd || '');
    if (name.startsWith('react:')) {
      const moment = name.slice(6);
      activity(at);
      if (moment === 'break') state.resting = true;
      if (moment === 'break-end') { state.resting = false; return true; }
      if (moment === 'start' || moment.startsWith('retry')) state.resting = false;
      const r = reactions[moment];
      if (!isObj(r)) return true;
      // 休息段的喝水是底姿势，不当成会过期的反应。
      if (moment === 'break' && (!r.pose || r.pose === base.resting)) return true;
      startReaction({ ...r, moment }, at);
      return true;
    }
    switch (name) {
      case 'play-on': state.playing = true; activity(at); return true;
      case 'play-off': state.playing = false; state.resting = false; activity(at); return true;
      case 'talk-start': {
        activity(at);
        state.talking = true;
        state.talkSince = at;
        // 真的开口了：菜单「说句话」的 2.6 秒计时作废（不然会在这句话中间收嘴）。
        state.talkUntil = 0;
        // 刚发生的游戏时刻：陪着这句话一直摆下去（她说的就是这件事）。模型写一句话要几秒，
        // 那时反应多半已经过期了，所以也看刚过期的那个（lastReaction）；两个都在窗口里就挑优先级高的。
        const candidates = [state.reaction, state.lastReaction].filter((r) => r && r.moment && at - r.startedAt < timing.talkKeepMs);
        const keep = candidates.sort((a, b) => b.priority - a.priority || b.startedAt - a.startedAt)[0];
        if (keep) {
          keep.until = Math.max(keep.until, at + 60_000);
          keep.talkExtended = true;
          state.reaction = keep;
        }
        return true;
      }
      case 'talk-stop':
        activity(at);
        state.talking = false;
        state.talkUntil = 0;
        // 只收陪说话延长过的那个反应（话说完再留一小会儿）；说话途中新开始的反应（比如打完时的全连）照原来的时长摆。
        if (state.reaction && state.reaction.talkExtended && state.reaction.until > at + 1500) state.reaction.until = at + 1500;
        return true;
      case 'talk': {
        // 菜单「说句话」：没在说话时说 2.6 秒；正在说一句真的话时什么都不改（不安排收嘴）。
        // talk-start 会清掉 talkUntil：2.6 秒内连点两次时把原来的计时放回去，不然她会一直说下去（复核发现）。
        const wasTalking = state.talking;
        const keepUntil = state.talkUntil;
        command('talk-start', at);
        state.talkUntil = wasTalking ? keepUntil : at + 2600;
        return true;
      }
      case 'pat': {
        activity(at);
        // 生着气被摸头：先被哄（coaxed），再摸就原谅了（forgiven）。按哄到第几步记，不按姿势名字（皮肤缺姿势时名字会变）。
        if (at < state.angryUntil) {
          const coaxedAlready = Boolean(state.reaction && at < state.reaction.until && state.reaction.coax);
          startReaction({ pose: coaxedAlready ? pick('forgiven', 'pat') : pick('coaxed', 'pat'), motion: 'hop', holdMs: timing.patHoldMs, priority: 2 }, at);
          if (coaxedAlready) { state.angryUntil = 0; state.pokes = []; } else if (state.reaction) state.reaction.coax = true;
          return true;
        }
        startReaction({ pose: 'pat', motion: 'hop', holdMs: timing.patHoldMs, priority: 2 }, at);
        return true;
      }
      case 'poke': {
        activity(at);
        state.pokes = state.pokes.filter((t) => at - t < timing.pokeWindowMs).concat(at);
        const step = POKE_LADDER[Math.min(POKE_LADDER.length - 1, state.pokes.length - 1)];
        if (state.pokes.length >= 2) state.angryUntil = at + 20_000;
        startReaction({ ...step, holdMs: timing.pokeHoldMs, priority: 2 }, at);
        return true;
      }
      case 'hop':
        activity(at);
        startReaction({ pose: 'happy', motion: 'jump', holdMs: 2000, priority: 1 }, at);
        return true;
      case 'blink':
        state.blinkRequested = true;
        return true;
      default:
        return false;
    }
  }

  /**
   * 现在该显示什么：{ pose, file, motion, talking, blinkable, mouth }。
   * file 是要显示的图片（相对皮肤目录）；blinkable 表示现在显示的是能眨眼的那张主图；mouth 表示该在主图上换嘴了（说话中、皮肤有口型）。
   */
  function current(at = Date.now()) {
    if (state.talkUntil && at >= state.talkUntil) { state.talkUntil = 0; command('talk-stop', at); }
    let pose;
    let motion;
    let mouthing = false;
    const r = state.reaction;
    if (r && at < r.until) {
      pose = r.pose;
      motion = r.motion;
    } else {
      // 过期的反应先留着（lastReaction）：她的话晚几秒才到时还能把这个姿势请回来陪着说。
      if (r) { state.lastReaction = r; state.reaction = null; }
      if (state.talking && mouthBase) {
        // 有口型：摆主图（嘴是对着它做的），人轻轻浮着，不再快速点头（嘴在动就够了）。
        pose = mouthBase;
        motion = 'bob';
        mouthing = true;
      } else if (state.talking) {
        pose = pick(base.talk, base.idle);
        motion = 'quick';
      } else {
        const b = baseNow(at);
        pose = b.pose;
        motion = b.motion;
      }
    }
    const frames = framesOf(pose);
    let file = frames[0] || '';
    // 待机：有几张就隔一会儿换一张（CrossPet 的 idle / idle-2 / idle-3）。
    if (mouthing) {
      // 嘴只对得上主图（第一张）。
      state.idleSince = at;
      state.idleFrame = 0;
    } else if (pose === pick(base.idle, 'idle') && frames.length > 1) {
      if (at - state.idleSince >= timing.idleSwapMs) {
        state.idleSince = at;
        // 主图多放一会儿（眨眼只在主图上）：一半的机会回到主图。
        state.idleFrame = random() < 0.5 ? 0 : 1 + Math.floor(random() * (frames.length - 1));
      }
      file = frames[Math.min(frames.length - 1, state.idleFrame)] || frames[0];
    } else {
      state.idleSince = at;
      state.idleFrame = 0;
    }
    const blink = isObj(spec.blink) ? spec.blink : null;
    const blinkable = Boolean(blink && blink.file && pose === (blink.base || 'idle') && file === framesOf(pose)[0]);
    return { pose, file, motion: MOTIONS.includes(motion) ? motion : 'bob', talking: state.talking, blinkable, mouth: mouthing };
  }

  /** 要不要眨一下（rig 的眨眼计时到了、或者收到 blink 命令时问）。 */
  function takeBlinkRequest() {
    const v = state.blinkRequested === true;
    state.blinkRequested = false;
    return v;
  }

  return {
    command, current, activity, takeBlinkRequest,
    files: () => [...new Set(Object.keys(poses).flatMap(framesOf).concat(isObj(spec.blink) && spec.blink.file ? [spec.blink.file] : [], mouthBase ? Object.values(mouthLevels) : []))],
    /** 口型的几张图：{ closed?, half?, wide? }；皮肤没有口型时是空对象。 */
    mouthLevels: () => (mouthBase ? { ...mouthLevels } : {}),
    /** 平时那张主图（预载时保证它在；别的姿势载不出来时退回它）。 */
    mainFile: () => framesOf(pick(base.idle, 'idle'))[0] || '',
    debug: () => ({ ...state, reaction: state.reaction ? { ...state.reaction } : null, lastReaction: state.lastReaction ? { ...state.lastReaction } : null }),
  };
}
