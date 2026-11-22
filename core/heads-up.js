/**
 * 难段预告：打图时在长串 / 大跳 / 先串后跳 / 先跳后串 / 变速前三四秒提醒一句（2026-11-21 用户：「让桌宠识别到后面即将会来的排列然后提前通知玩家」）。
 *
 * 和平时说话分开走：平时那条路（模型写一句 → 合成语音 → 过时就不说）要好几秒，等打到那儿再写就晚了。
 * 这里在开图时就把难段算好（core/patterns.js），提示是几句固定的人话（「后面先跳一阵，跳完马上接串」），事先合成好放在内存里，到点直接放。
 *
 * 两档（设置「说话」→ 难段预告，watch.headsUp）：
 *   off      不报（默认）
 *   voice    给我提个醒：念那一句提示（字幕窗口放声音，不出字），桌面角色和 OBS 里她冒气泡、张嘴说这句
 * 原来还有一档「只给观众看」（不出声、摆个冲的姿势），2026-11-22 用户说不需要，去掉了。
 * 开 HD / FL、多人房里照样报（2026-11-21 用户：「多人房和 HD / FL 也能报」）；只有看回放 / 观战时不报（打的不是你）。
 *
 * 只读本地的 .osu 文件和 tosu 的数据，不改缩圈、不碰操作和画面：性质和直播时观众在弹幕里提醒差不多（2026-11-21 用户的看法）。默认关。
 *
 * 时间：tosu 的 beatmap.time.live 是谱面时间（开 DT 时每真实一秒走 1500 毫秒），和 .osu 里物件的时间是同一套；
 * 两帧之间按「真实时间 × 倍速」往前推，到点前不到一帧时用定时器卡准。
 * 暂停：live 停住不动就当暂停，不报；重开：live 往回跳，报过的清掉重来。
 */
import { defaultFetchBytes, defaultReadFile, readBeatmapText, tosuHttpBase } from './beatmap-file.js';
import { CUE_PHRASES, cueOf, findHardSections, findStrainPeaks, leadSecOf, parseOsu } from './patterns.js';
import { mouthTrackFromWav, mouthTrackFromText } from './speakable.js';

const MODES = new Set(['off', 'voice']);
/** 离开始不到这么多真实毫秒才轮到它：已经来不及念完，不报了。 */
const TOO_LATE_MS = 700;
/** live 多久没动算暂停（tosu 每 150 毫秒推一帧）。 */
const PAUSE_MS = 450;
/** 两帧之间最多往前推多少真实毫秒：大约一帧多一点。推多了，按下暂停的那半秒里会在暂停菜单里报出来（复核发现）。 */
const EXTRAPOLATE_MS = 220;
/** 读谱面一时失败（文件正被写、tosu 刚启动）：过几秒再试。 */
const RETRY_MS = 5000;
/** 难段前后多久压住平时的点评（真实毫秒）：难的地方别说话。 */
const QUIET_BEFORE_MS = 6000;
const QUIET_AFTER_MS = 1000;
/** 提前量的上下限（真实秒）：一句提示念两秒多，再留一秒反应。 */
const LEAD_MIN_SEC = 3.5;
const LEAD_MAX_SEC = 4.5;

// 读谱面文件的地方挪到了 core/beatmap-file.js（和 core/map-info.js 共用）；这里照旧导出，老的调用不用改。
export { tosuHttpBase };

/**
 * @param {object} opts
 * @param {() => object} opts.config   完整设置
 * @param {{ready():object, synthesize(t:string):Promise<{bytes:Buffer,durationMs:number}>}} [opts.tts]
 * @param {{say(o:object):any}} [opts.overlay]   字幕窗口（放声音）
 * @param {{react(o:object):any}} [opts.pet]      桌面角色
 * @param {{react(o:object):any, say(o:object):any}} [opts.counter]  OBS 页面
 * @param {object} [opts.deps]  测试用：now()、readFile(path)、fetchText(url)、setTimeout / clearTimeout
 */
export function createHeadsUp({ config, tts = null, overlay = null, pet = null, counter = null, log = () => {}, deps = {} } = {}) {
  const d = {
    now: Date.now,
    // 都按原始字节拿（core/beatmap-file.js）
    readFile: defaultReadFile,
    fetchText: defaultFetchBytes,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    ...deps,
  };
  const modeOf = () => { const m = config()?.watch?.headsUp; return MODES.has(m) ? m : 'off'; };
  const maxOf = () => Math.max(1, Math.min(8, Number(config()?.watch?.headsUpMax) || 4));

  // 这一张图（key = 谱面 checksum + 倍速 + CS）：解析出来的难段、报过哪几段。
  let plan = null; // { key, title, rate, sections:[…], fired:Set<number>, error }
  let loading = null;
  let live = { t: 0, at: 0, moving: false };
  // 进图的头一两帧还是选歌试听的时间（events.js 同样的问题）：等名字 / 血条 / 分数有了（或者等十几帧）才开始算。
  let started = false;
  let waited = 0;
  let active = false; // 正在打、而且该报（不是看回放 / 观战）
  let blockedWhy = '';
  let timer = null;
  let lastFired = null;
  let lastError = null;
  // 提示语音：短句 → { bytes, durationMs }；换了音色 / 语速就清掉重合成。
  const voices = new Map();
  let voiceKey = '';
  let preparing = null;
  let voiceError = null;
  let voiceRetryAt = 0; // 合成失败过：一分钟内不再试（每帧都会问一次，不能每帧都去请求火山）

  function ttsKey() {
    const t = config()?.tts || {};
    // 换了哪一家、哪个音色、语速、语气说明：之前合成好的提示都作废，重新合成。
    return JSON.stringify([t.provider || 'volc', t.appId, t.speaker, t.resourceId, Number(t.speed) || 1, t.breezeVoice, t.breezeInstructions]);
  }

  /** 把几句提示事先合成好（只在「给我提个醒」那档、语音配好了时）。已经在合成就等那一次。 */
  function prepareVoices() {
    if (modeOf() !== 'voice' || !tts) return Promise.resolve(false);
    try { if (tts.ready?.()?.ok === false) { voiceError = tts.ready(); return Promise.resolve(false); } } catch { return Promise.resolve(false); }
    const key = ttsKey();
    if (key !== voiceKey) { voices.clear(); voiceKey = key; }
    const missing = [...new Set(Object.values(CUE_PHRASES))].filter((p) => !voices.has(p));
    // 配好了、几句也都在：之前挂着的「没配好」之类的错清掉（复核发现：只改 Access Key 时一直挂着）。
    if (!missing.length) { voiceError = null; return Promise.resolve(true); }
    if (String(voiceError?.code || '').startsWith('tts.no-')) voiceError = null;
    if (preparing) return preparing;
    if (d.now() < voiceRetryAt) return Promise.resolve(false);
    preparing = (async () => {
      for (const phrase of missing) {
        try {
          const r = await tts.synthesize(phrase);
          if (ttsKey() !== key) return false; // 合成途中换了音色：这批作废
          if (r?.bytes?.length) voices.set(phrase, { bytes: r.bytes, durationMs: Number(r.durationMs) || 1000 });
          voiceError = null;
        } catch (error) {
          voiceError = { code: error?.code || 'tts.failed', error: `难段提示合成不出来：${String(error?.message ?? error).slice(0, 120)}`, hint: error?.hint || '到设置「语音」里点「试听」看能不能出声。' };
          log('[heads-up] 提示语音合成失败：', voiceError.error);
          voiceRetryAt = d.now() + 60_000;
          return false;
        }
      }
      return true;
    })().finally(() => { preparing = null; });
    return preparing;
  }

  /** 读当前谱面的 .osu（core/beatmap-file.js：本地文件 → 问 tosu 要；核对 checksum）。 */
  async function loadMapText(map) {
    try {
      return await readBeatmapText(map, { readFile: d.readFile, fetchText: d.fetchText, tosuUrl: config()?.watch?.url });
    } catch (error) {
      throw Object.assign(error, { code: 'headsup.map-unreadable' });
    }
  }

  // 改了「每张图最多报几次」也要重算（复核发现）。
  function planKey(map) { return `${map.key}|${map.rate}|${map.cs}|${maxOf()}`; }

  function load(map) {
    const key = planKey(map);
    if (loading?.key === key) return;
    // 一时读不到（文件正被写、tosu 刚启动）的过几秒再试；读到了、或者确定不是标准模式的不再读。
    if (plan?.key === key && !(plan.retryAt && d.now() >= plan.retryAt)) return;
    const job = { key };
    loading = job;
    plan = null;
    void (async () => {
      try {
        const text = await loadMapText(map);
        const parsed = parseOsu(text);
        if (loading !== job) return;
        if (!parsed) { plan = { key, title: map.title, rate: map.rate, sections: [], fired: new Set(), error: '不是 osu! 标准模式的图' }; return; }
        const sections = sectionsFor(parsed, map, null);
        plan = { key, title: map.title, version: map.version, rate: map.rate, sections, fired: new Set(), error: null, parsed, map, peaks: null };
        lastError = null;
        logPlan(map, sections, '');
      } catch (error) {
        if (loading !== job) return;
        plan = { key, title: map.title, rate: map.rate, sections: [], fired: new Set(), error: String(error?.message ?? error).slice(0, 120), retryAt: d.now() + RETRY_MS };
        lastError = { code: error?.code || 'headsup.failed', error: `难段预告读不到这张图：${plan.error}`, hint: 'tosu 要开着；谱面文件在 osu! 的 Songs 文件夹里。' };
        log('[heads-up] 读谱面失败：', plan.error);
      } finally {
        if (loading === job) loading = null;
      }
    })();
  }

  /** 一张图的难段（peaks：tosu 难度曲线上的高峰，没有就 null）。提示是一整句话（念两秒多），提前量大约三秒半：开头来不及报的、挨着要并的都按这个算。 */
  function sectionsFor(parsed, map, peaks) {
    const beat = parsed.reds[0]?.beatLength || 500;
    return findHardSections(parsed, { rate: map.rate, cs: map.cs > 0 ? map.cs : null, max: maxOf(), leadSec: Math.max(LEAD_MIN_SEC, leadSecOf(beat, map.rate)), peaks })
      .map((s, i) => {
        const b = parsed.objects.find((o) => o.t >= s.start)?.beat || beat;
        return { ...s, id: i, cue: cueOf(s), leadSec: leadSecOf(b, map.rate) };
      });
  }

  function logPlan(map, sections, note) {
    log(`[heads-up] ${map.title} [${map.version}]：${sections.length} 段难段${note}（${sections.map((s) => `${(s.start / 1000).toFixed(1)}s ${s.kind}${s.sub && s.sub !== 'normal' ? `(${s.sub})` : ''}`).join('，') || '没有'}）`);
  }

  /**
   * tosu 的难度曲线到了（snap.graph）：拿它的高峰补一下难段（2026-11-21 用户：用 tosu 的难度曲线补难段预告）。
   * 只在开打之前用（打到一半换难段，提醒会乱）；曲线要和这张图对得上（换图的时候 tosu 的曲线可能还是上一张的）：
   *   第一段真数据的时间（tosu 填的是第一个不是转盘的物件 ÷ 倍速，取整）乘回倍速，和谱面里那个物件差不到 3 毫秒——
   *   同一个谱面集的几个难度结尾差不多，只看结尾分不出来（复核发现）；最后一段和最后一个物件差不到 3 秒。
   * 曲线换了（长度、首尾变了）而且还没开打，就重新算一次。
   */
  function applyGraph(graph) {
    if (!plan || !plan.parsed || started || !graph) return;
    const xs = graph.xaxis;
    const aim = (graph.series.find((x) => x && x.name === 'aim')?.data) || [];
    const n = Math.min(xs.length, aim.length);
    let firstReal = -1;
    let lastReal = -1;
    for (let i = 0; i < n; i += 1) if (Number(aim[i]) >= 0) { firstReal = i; break; }
    for (let i = n - 1; i >= 0; i -= 1) if (Number(aim[i]) >= 0) { lastReal = i; break; }
    if (firstReal < 0) return;
    // 曲线的「指纹」：长度、首尾时间、aim / 手速两条的总和（tosu 重算过、数值变了也认得出）
    const speed = (graph.series.find((x) => x && x.name === 'speed')?.data) || [];
    const sum = (arr) => arr.reduce((t, v) => t + (Number(v) > 0 ? Number(v) : 0), 0);
    const sig = `${xs.length}|${xs[firstReal]}|${xs[lastReal]}|${sum(aim).toFixed(3)}|${sum(speed).toFixed(3)}`;
    if (plan.graphSig === sig) return;
    const rate = plan.rate || 1;
    const objs = plan.parsed.objects;
    const firstHit = objs.find((o) => o.kind !== 'spinner') || objs[0];
    const lastObj = objs[objs.length - 1];
    if (Math.abs(Number(xs[firstReal]) * rate - Math.round(firstHit.t)) > 3 * rate || Math.abs(Number(xs[lastReal]) * rate - lastObj.t) > 3000) return;
    const peaks = findStrainPeaks(graph, { rate });
    plan.graphSig = sig;
    plan.peaks = peaks;
    plan.sections = sectionsFor(plan.parsed, plan.map, peaks);
    logPlan(plan.map, plan.sections, `（按 tosu 的难度曲线补过：${peaks.length} 个高峰）`);
  }

  /** 现在大概播到谱面的哪一毫秒（两帧之间按真实时间 × 倍速往前推）。暂停时不推。 */
  function liveNow(now = d.now()) {
    if (!live.at) return 0;
    if (!live.moving) return live.t;
    return live.t + Math.min(EXTRAPOLATE_MS, Math.max(0, now - live.at)) * (plan?.rate || 1);
  }

  /** 一句话大约念多久（没合成出声音时按字数估，一个字 0.22 秒）。 */
  function speechMs(phrase) { return Math.max(1200, Array.from(String(phrase)).length * 220); }

  /**
   * 这一段提前多少真实秒开口：节拍算出来的（2 秒和 4 拍取长）和「念完这句 + 1 秒反应」取长，最多 4.5 秒。
   * 提示是一整句人话（2026-11-21 用户：别单蹦一个词），念完要两秒多，所以按实际念多久来算。
   */
  function leadOf(s) {
    const v = voices.get(s.cue);
    const speak = (v ? v.durationMs : speechMs(s.cue)) / 1000;
    return Math.min(LEAD_MAX_SEC, Math.max(s.leadSec, speak + 1));
  }

  function fire(section) {
    const mode = modeOf();
    const phrase = section.cue;
    if (!phrase || mode === 'off') return;
    const voice = voices.get(phrase);
    const ms = voice ? voice.durationMs : speechMs(phrase);
    if (mode === 'voice') {
      if (voice) {
        try { overlay?.say?.({ text: phrase, audio: voice.bytes, ms: ms + 600, hidden: true }); } catch (error) { log('[heads-up] 放提示声音失败：', String(error?.message ?? error).slice(0, 120)); }
      } else {
        void prepareVoices(); // 还没合成好（刚打开、或者合成失败过）：这一次只换姿势，下次再试
      }
    }
    // 桌面角色和 OBS 都冒气泡、张嘴说这一句（2026-11-21 用户：桌宠不弹气泡）。
    const mouth = voice ? mouthTrackFromWav(voice.bytes) : mouthTrackFromText(phrase, ms);
    try { counter?.say?.({ text: phrase, durationMs: ms, mouth }); } catch {}
    try { pet?.speak?.({ text: phrase, durationMs: ms, bubble: true, mouth }); } catch (error) { log('[heads-up] 桌面角色冒气泡失败：', String(error?.message ?? error).slice(0, 120)); }
    lastFired = { at: d.now(), kind: section.kind, cue: phrase, start: section.start, voiced: mode === 'voice' && Boolean(voice) };
  }

  /** 看看有没有到点的段：到点就报；不到一帧就到点的，用定时器卡准。 */
  function check(now = d.now()) {
    if (timer) { d.clearTimeout(timer); timer = null; }
    if (!active || !plan?.sections?.length || !live.moving) return;
    const rate = plan.rate || 1;
    const t = liveNow(now);
    let soonest = Infinity;
    for (const s of plan.sections) {
      if (plan.fired.has(s.id)) continue;
      const fireAt = s.start - leadOf(s) * 1000 * rate;
      if (t >= fireAt) {
        plan.fired.add(s.id);
        if ((s.start - t) / rate >= TOO_LATE_MS) fire(s);
      } else {
        soonest = Math.min(soonest, (fireAt - t) / rate);
      }
    }
    if (soonest < 200) timer = d.setTimeout(() => { timer = null; check(); }, Math.max(0, soonest));
  }

  /**
   * 每一帧都喂进来（watch.js handleFrame，不节流）。snap 是 normalizeSnapshot 的结果；run 是 tracker.current()（这一把的信息）。
   */
  function onFrame(snap, run, now = d.now()) {
    const mode = modeOf();
    if (mode === 'off' || !snap) { active = false; blockedWhy = mode === 'off' ? 'off' : ''; if (timer) { d.clearTimeout(timer); timer = null; } return; }
    if (mode === 'voice') void prepareVoices();
    const map = snap.map || {};
    // 开图前（选歌界面）就先把这张图读好：进去的那一下不用等。
    if ((snap.state === 'play' || snap.state === 'select' || snap.state === 'multi') && map.key) load(map);
    if (snap.graph && plan?.key === planKey(map)) { try { applyGraph(snap.graph); } catch (error) { log('[heads-up] 用难度曲线出错：', String(error?.message ?? error).slice(0, 120)); } }
    if (snap.state !== 'play') { active = false; started = false; waited = 0; live = { t: 0, at: 0, moving: false }; return; }
    if (!started) {
      waited += 1;
      const p = snap.play || {};
      if (!(snap.player || p.hp > 0 || p.score > 0 || waited > 15)) { active = false; return; }
      // 真的开局了：报过的清掉（同一张图打完再打一遍也要从头报；复核发现：原来只靠残留帧碰巧清掉）。
      started = true;
      if (plan) plan.fired.clear();
      live = { t: 0, at: 0, moving: false };
    }
    blockedWhy = run?.replay || (snap.player && snap.me && snap.player !== snap.me) ? 'replay' : '';
    active = !blockedWhy;
    const t = Number(map.timeLive) || 0;
    if (live.at && t < live.t - 1500 && plan) plan.fired.clear(); // 重开 / 往回跳：重来
    if (t !== live.t || !live.at) live = { t, at: now, moving: Boolean(live.at) && t !== live.t };
    else if (live.moving && now - live.at > PAUSE_MS) {
      // live 停住：暂停了。按往前推的时间报出去、其实还没打到的那段（真实位置还没到它的报点）放回去，继续打时再报。
      live.moving = false;
      if (plan) for (const s of plan.sections) if (plan.fired.has(s.id) && s.start - leadOf(s) * 1000 * (plan.rate || 1) > live.t) plan.fired.delete(s.id);
    }
    check(now);
  }

  /** 现在是不是难段前后（平时的点评先别说）。 */
  function quiet(now = d.now()) {
    if (modeOf() === 'off' || !active || !plan?.sections?.length) return false;
    const rate = plan.rate || 1;
    const t = liveNow(now);
    return plan.sections.some((s) => t >= s.start - QUIET_BEFORE_MS * rate && t <= s.end + QUIET_AFTER_MS * rate);
  }

  function status() {
    return {
      mode: modeOf(),
      active,
      blocked: blockedWhy || null,
      map: plan ? { title: plan.title, version: plan.version || '', sections: plan.sections.map((s) => ({ kind: s.kind, sub: s.sub, mixed: s.mixed === true, start: s.start, end: s.end, count: s.count, cue: s.cue })), error: plan.error } : null,
      lastFired,
      voices: { ready: voices.size, total: new Set(Object.values(CUE_PHRASES)).size, error: modeOf() === 'voice' ? voiceError : null },
      lastError,
    };
  }

  return { onFrame, quiet, status, prepareVoices, liveNow };
}
