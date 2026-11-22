/**
 * 看你打 osu! · 服务：连 tosu、认出时刻、过闸、让模型写一句、显示 / 念出来。
 *
 *   tosu（本机 24050）──WebSocket──▶ events.js 认出时刻 ──▶ 过闸 ──▶ 模型写一句 ──▶ 字幕 / 气泡 / 声音 / OBS
 *
 * 照搬 SurfCore lib/osu/watch.js（闸门规则、提示词、整理那一句、过时丢弃、排队、成绩、小结），依赖换成本项目自己的：
 *   人设（persona.js）、模型（llm.js）、语音（tts-volc.js）、小结（journal.js）、
 *   本地字幕窗口（overlay）、桌面角色（pet）、OBS counter（tosu-counter.js）。
 *
 * 几条写死的规矩（和 SurfCore 一样）：
 *   · 只连本机的 tosu（地址必须是 127.0.0.1 / localhost）。数据只有对局本身。
 *   · 说了没人看得见 / 听得见时不调模型（白花钱）。
 *   · 打的过程中说的话要短，而且有间隔、每首有上限；模型慢了、话过时了就丢掉，不在结算后才蹦出一句「断了」。
 *   · 一场打完后只记一条小结。看回放 / 观战时不说话。
 *   · 失败都带 code / error / hint，设置窗口上看得见。
 */
import fs from 'node:fs';
import { codedError, dataPath, failureOf, isPlainObject } from './store.js';
import { DEFAULTS } from './config.js';
import { createOsuTracker, normalizeSnapshot, progressOf } from './events.js';
import { momentOf, playingAfter } from './moments.js';
import { mouthTrackFromText, mouthTrackFromWav } from './speakable.js';
import { createHeadsUp } from './heads-up.js';
import { createMapInfo, mapInfoText } from './map-info.js';
import { curveFromGraph } from './strain-curve.js';

const PLAYS_KEEP = 60;
/** 模型写一句话用了这么久还没回来，打图中的话就算过时了。 */
export const STALE_MS = 9000;
/** 要念出来时还得等语音合成：多给几秒。 */
export const STALE_VOICE_MS = 16_000;
/** 语音合成最多等这么久；等不到就只出字。 */
const VOICE_WAIT_MS = 12_000;
/** 这么久没有新的一把，算这一场结束（写小结）。 */
const SESSION_IDLE_MS = 15 * 60 * 1000;
const FRAME_GAP_MS = 200;
const RETRY_MARKS = new Set([3, 6, 10, 15, 20, 30]);
/** 休息段里说话：一首歌最多几次、离上一句至少多久。 */
const BREAK_MAX_PER_SONG = 2;
const BREAK_GAP_MS = 15_000;
/** 同一张图开局点评过之后，这么久之内再进来不再点评。 */
const START_REPEAT_MS = 10 * 60_000;
/** 没说的原因 → 给人看的话（设置窗口「最近没说的」）。 */
export const SKIP_TEXT = {
  'heads-up-quiet': '难段前后先不说（难段预告开着：难的地方别插嘴）',
  'mid-play-off': '「打的过程中也说」关着',
  'combo-break-small': '断掉的连击相对这张图太短（不到总连击数的 15%）',
  'combo-mark-small': '这个连击关口相对这张图太小',
  'per-song-max': '这首歌的过程中已经说够了',
  'break-max': '这首歌的休息段已经说过两次',
  'too-soon': '离上一句太近',
  'start-same-map': '这张图十分钟内已经开局点评过',
  'daily-limit': '今天说够了',
  busy: '她正在说上一句',
};
/**
 * 一段连击相对这张图够不够长：至少 floor，而且至少是这张图总连击数的 15%。
 * 真机上 7–8 星的图十几秒就断一次（一首歌里断了六次，长度 58–325），每次都说就成了噪音；
 * 按图的总连击数来看，325 / 1569 值得说，77 / 1569 不值得。读不到总连击数时只看 floor。
 */
const bigEnough = (value, maxCombo, floor) => value >= Math.max(floor, Math.round((Number(maxCombo) || 0) * 0.15));

const rulersOf = (rulers) => (isPlainObject(rulers) ? { ...DEFAULTS.rulers, ...rulers } : DEFAULTS.rulers);

const dayKey = (now) => new Date(now).toLocaleDateString('sv-SE');
const percent = (value) => (value === null || value === undefined ? '' : `${Math.round(value * 100)}%`);
/**
 * 「哪张图、多难」。tosu 给的星数是**算上当前 mod 之后**的（开 DT 的 7.12 星，不开可能只有 5 星多）。
 * 用户说过：「我开完 dt 才 7.12 星，她以为我拿 7.12 星开 dt」——所以有 mod 时要写成「开了 DT，算上 mod 是 7.12 星」。
 */
const starsText = (stars, mods) => (stars ? (mods ? `开了 ${mods}，算上 mod 是 ${stars} 星` : `${stars} 星`) : (mods ? `开了 ${mods}` : ''));

/**
 * 这张图的速度：快慢在这里判断好再交给模型，不让她自己换算（开了 DT 之后的数她换算不对）。
 * 尺子在设置的 rulers 里，默认值是 2026-11-19 用户给的：「240bpm 很快我点不动，140 这图 bpm 比较慢」「ar9 以上是普通，9 以下算慢」。
 */
export function bpmFeel(bpm, rulers) {
  const r = rulersOf(rulers);
  if (!(bpm > 0)) return '';
  if (bpm >= r.bpmVeryFast) return r.bpmVeryFastNote ? `很快，${r.bpmVeryFastNote}` : '很快';
  if (bpm >= r.bpmFast) return '偏快';
  if (bpm > r.bpmSlowMax) return '中等';
  return '偏慢';
}
/**
 * AR（圈出现得多快）。2026-11-20 用户纠正：「ar10 以下 ar 越低谱面越难，ar10 以上才是越高越难」。
 * AR 低不是「简单」：圈在屏幕上留得久、挤在一起，更难读。所以「慢 / 快」后面直接写上难不难，
 * 不让模型从「偏慢」推出「好打」。
 * 难度的分界固定是 10（游戏本身的规律，用户说的就是 10），不跟尺子走；尺子（arSlowBelow / arFastAbove）只决定叫不叫「偏慢 / 偏快」。
 */
export const AR_PIVOT = 10;
export function arFeel(ar, rulers) {
  const r = rulersOf(rulers);
  if (!(ar > 0)) return '';
  if (ar < r.arSlowBelow) return `偏慢（他觉得 ${r.arSlowBelow} 以下就算慢${ar < AR_PIVOT ? `；AR ${AR_PIVOT} 以下是越低越难读，这个 AR 更难读` : ''}）`;
  if (ar > r.arFastAbove) return ar > AR_PIVOT ? `偏快（AR ${AR_PIVOT} 以上越高越难）` : '偏快';
  return '普通';
}

/** mods 里有没有某个 mod（tosu 给的是连写的两位代号，比如 "HDDT"、"EZ"；也认用逗号 / 空格隔开的）。 */
export function hasMod(mods, code) {
  return (String(mods || '').toUpperCase().match(/[A-Z0-9]{2}/g) ?? []).includes(String(code).toUpperCase());
}

/**
 * EZ（Easy）名字叫「简单」，实际是**增加难度**的（2026-11-20 用户纠正：「EZ mod 是增加难度的不是降低难度的」）：
 * 它把 AR 压得很低，圈挤在一起更难读。偏偏 EZ 会把星数算低，模型一看「开了 EZ、星数低」就会说成「降难度」。
 * 所以只要 mods 里有 EZ，就在图的描述后面跟一句说明。
 * 不写「星数变小了」：EZ 和 DT 一起开时星数其实是变大的，而且模型手里没有不开 mod 的星数可以比。
 */
const EZ_NOTE = '（EZ 是增加难度的 mod：它把 AR 压低、圈更难读；EZ 会把星数算低，别拿星数说它简单）';
function csFeel(cs) {
  if (!(cs > 0)) return '';
  if (cs >= 5) return '圈很小';
  if (cs <= 3) return '圈很大';
  return '';
}
/** 「BPM 225（算上 DT），很快…；AR 10.3（不开 mod 是 9），偏快；CS 4」——读不到的项不写。 */
export function mapDetail(map = {}, mods = '', rulers) {
  const parts = [];
  if (map.bpm > 0) {
    const notes = [
      mods && Math.abs((Number(map.rate) || 1) - 1) > 0.01 ? `算上 ${mods}` : '',
      map.bpmMin > 0 && map.bpmMax > 0 && map.bpmMax - map.bpmMin >= 5 ? `有变速，${map.bpmMin}–${map.bpmMax}` : '',
    ].filter(Boolean);
    parts.push(`BPM ${map.bpm}${notes.length ? `（${notes.join('，')}）` : ''}，${bpmFeel(map.bpm, rulers)}`);
  }
  if (map.ar > 0) {
    const was = map.arOriginal > 0 && Math.abs(map.arOriginal - map.ar) >= 0.05 ? `（不开 mod 是 ${map.arOriginal}）` : '';
    parts.push(`AR ${map.ar}${was}，${arFeel(map.ar, rulers)}`);
  }
  if (map.cs > 0) {
    const was = map.csOriginal > 0 && Math.abs(map.csOriginal - map.cs) >= 0.05 ? `（不开 mod 是 ${map.csOriginal}）` : '';
    const feel = csFeel(map.cs);
    parts.push(`CS ${map.cs}${was}${feel ? `，${feel}` : ''}`);
  }
  return parts.join('；');
}

/**
 * 这张图主要考什么（2026-11-21 用户：用 tosu 算好的 aim / 手速星数，开局说「偏 aim 还是偏手速」）。纯函数。
 * tosu 的 beatmap.stats.stars.aim / speed（算上 mod）。aim 星数一般本来就比手速高一点，所以：
 *   aim ≥ 手速 × AIM_HEAVY_RATIO 才算偏 aim；手速比 aim 还高就算偏手速；中间说差不多。门槛是估的，听着不对再调。
 * sliderFactor（去掉滑条的 aim / 全部 aim）小于 0.9：滑条占了不少难度。读不到星数返回空串。
 */
export const AIM_HEAVY_RATIO = 1.4;
export function skillFeel(map = {}) {
  const aim = Number(map.starsAim) || 0;
  const speed = Number(map.starsSpeed) || 0;
  if (!(aim > 0 && speed > 0)) return '';
  const nums = `aim ${aim} 星、手速 ${speed} 星`;
  const main = aim >= speed * AIM_HEAVY_RATIO ? `偏 aim（${nums}）` : speed > aim ? `偏手速（${nums}）` : `aim 和手速差不多（${nums}）`;
  const sf = Number(map.sliderFactor) || 0;
  return `${main}${sf > 0 && sf < 0.9 ? '，滑条也占了不少难度' : ''}`;
}

const mapLine = (map, mods) => {
  const level = starsText(map.stars, mods);
  return `《${map.title || '（读不到歌名）'}》${map.version ? ` [${map.version}]` : ''}${level ? `，${level}` : ''}${hasMod(mods, 'EZ') ? EZ_NOTE : ''}`;
};

/**
 * 把一个事件写成给模型看的「刚才发生了什么」。纯函数。
 * @param {object} event
 * @param {{pronoun?:string, rulers?:object}} [opts]  pronoun：他 / 她 / TA（默认「他」）
 */
export function describeEvent(event, { pronoun = '他', rulers, mapInfo = null } = {}) {
  const p = pronoun || '他';
  const where = event.progress === null || event.progress === undefined ? '' : `（打到 ${percent(event.progress)}）`;
  const song = mapLine(event.map, event.mods);
  const place = event.multi && event.place ? `这是多人房（mp），${p}排第 ${event.place.rank}（一共 ${event.place.players} 个人）。` : '';
  const who = Array.isArray(event.names) && event.names.length ? event.names.map((name) => `「${name}」`).join('、') : '';
  // 速度和圈的大小只在开局那一句带上（用户：「改成开局说吧」）。
  const detail = event.kind === 'start' ? mapDetail(event.map, event.mods, rulers) : '';
  switch (event.kind) {
    case 'start': {
      // 这是张什么图：玩家标签（osu! 官网）+ 从谱面看（core/map-info.js，2026-11-21）。还没准备好就不说。
      // 「这是张什么图」放在 BPM 这些数前面（2026-11-21 用户：开局应该优先报玩家标签的信息）
      const kind = mapInfoText(mapInfo);
      // 主要考什么：偏 aim 还是偏手速（tosu 算好的星数）
      const skill = skillFeel(event.map);
      return `${p}刚开始打一张图：${song}。${kind}${skill ? `主要考的：${skill}。` : ''}${detail ? `这张图：${detail}。` : ''}${event.retries ? `这张已经重开了 ${event.retries} 次。` : ''}`;
    }
    case 'combo':
      return `${p}正在打${song}，连击刚过 ${event.mark}${where}，现在准确率 ${event.acc}%，miss ${event.miss} 个。`;
    case 'combo-break': {
      const how = event.sliderBreak ? '断在了滑条上（slider break：没漏点，是滑条没跟住）' : '断了';
      const fc = event.fcLost ? '这一把之前一个都没漏过，这一断全连（FC）就没了。' : '';
      return `${p}正在打${song}，${event.lostCombo} 连${how}${where}。${fc}现在准确率 ${event.acc}%，miss ${event.miss} 个。`;
    }
    case 'acc-drop': {
      const bad = [event.new100 > 0 ? `${event.new100} 个 100` : '', event.new50 > 0 ? `${event.new50} 个 50` : ''].filter(Boolean).join('、');
      return `${p}正在打${song}，刚才 ${event.seconds} 秒里连着出了 ${bad}，准确率从 ${event.accFrom}% 掉到 ${event.acc}%${where}。到现在一共 ${event.n100} 个 100、miss ${event.miss} 个。`;
    }
    case 'break':
      return `${p}正在打${song}，现在到了休息段${where}，手是闲着的。到现在：${event.pp ? `${event.pp}pp，` : ''}准确率 ${event.acc}%，100 有 ${event.n100} 个${event.n50 ? `，50 有 ${event.n50} 个` : ''}，miss ${event.miss} 个，最长 ${event.peakCombo} 连。${detail ? `这张图：${detail}。` : ''}`;
    case 'rank-up':
      return `${p}在多人房（mp）里打${song}，刚${who ? `超过了${who}` : '往上超了人'}，从第 ${event.from} 升到第 ${event.to}（一共 ${event.players} 个人）${where}。`;
    case 'rank-down':
      return `${p}在多人房（mp）里打${song}，刚${who ? `被${who}超过了` : '被人超过了'}，从第 ${event.from} 掉到第 ${event.to}（一共 ${event.players} 个人）${where}。`;
    case 'retry':
      return `${p}把${song}重开了，这是第 ${event.retries} 次重开。上一把${event.before?.progress != null ? `打到 ${percent(event.before.progress)}` : '没打多远'}，准确率 ${event.before?.acc ?? '?'}%，miss ${event.before?.miss ?? '?'} 个。`;
    case 'finish':
      return `${p}打完了${song}。成绩：评级 ${event.rank || '?'}，准确率 ${event.acc}%，最大连击 ${event.peakCombo}${event.map.maxCombo ? ` / ${event.map.maxCombo}` : ''}，miss ${event.miss} 个${event.pp ? `，${event.pp}pp` : ''}。${event.fullCombo ? '是全连（FC）。' : ''}${event.retries ? `这张之前重开了 ${event.retries} 次。` : ''}${place}`;
    case 'fail':
      return `${p}打${song}的时候没血了，失败${where}。当时准确率 ${event.acc}%，miss ${event.miss} 个，最长 ${event.peakCombo} 连。${place}`;
    case 'quit':
      return `${p}打${song}打到一半退出了${where}。当时准确率 ${event.acc}%，miss ${event.miss} 个。`;
    default:
      return '';
  }
}

/**
 * 断连 / 连击关口那一句里，连击数后面没带单位（「啊 998 断了」）：补上「combo」。纯函数。
 * 2026-11-20 真机：打图中的话限 18 个字，模型为了省字把单位丢了，用户：「应该是 998 combo 断了，不是九九八断了」。
 * 已经带了单位（998 连 / 998combo / 998x / 998 个……）或者前面就是「连击 / combo」的不动。
 */
const COMBO_UNIT_AFTER = /^\s*(?:连|combo|x|个|次|下|分|pp|%|％|星|bpm|miss|点)/i;
const COMBO_WORD_BEFORE = /(?:连击|连|combo)\s*$/i;
export function unitizeCombo(line, event) {
  const n = event?.kind === 'combo-break' ? event.lostCombo : event?.kind === 'combo' ? event.mark : null;
  if (!Number.isInteger(n) || n <= 0 || typeof line !== 'string') return line;
  return line.replace(new RegExp(`(?<![\\d.．])${n}(?![\\d.．])`, 'g'), (num, offset, str) => {
    if (COMBO_UNIT_AFTER.test(str.slice(offset + num.length)) || COMBO_WORD_BEFORE.test(str.slice(Math.max(0, offset - 6), offset))) return num;
    const next = str.charAt(offset + num.length);
    // 后面紧跟着字（「998断了」）就空一格；后面是空格、标点或结尾就不加。
    return /[\p{L}\p{N}]/u.test(next) ? `${num} combo ` : `${num} combo`;
  });
}

const END_KINDS = new Set(['finish', 'fail', 'quit']);
// 「气泡没地方出」的几种错：桌面角色打开 / OBS 角色装好以后就不成立了。
const BUBBLE_BLOCKED = new Set(['osu.pet-hidden', 'osu.pet-unavailable']);

/** 一句话按字数算的「张嘴时长」（没有声音时）。 */
export const talkMsFor = (line) => Math.min(6000, Math.max(1200, Array.from(String(line)).length * 230));

/**
 * @param {object} opts
 * @param {() => object} opts.config      完整设置（config.js 的 get()）
 * @param {{info():object}} opts.persona
 * @param {{ready():object, complete(o:object):Promise<object>}} opts.llm
 * @param {{ready():object, synthesize(t:string):Promise<{bytes:Buffer,durationMs:number}>}} [opts.tts]
 * @param {{say(o:object):any, stop():void, status():object}} opts.overlay   本地字幕窗口（也负责放声音）
 * @param {{status():object, speak(o:object):any}} [opts.pet]   桌面角色
 * @param {{sync(o:object):Promise<object>, say(o:object):boolean, status():object}} [opts.counter]  OBS counter
 * @param {{append(o:object):boolean, recent(n:number):object[]}} [opts.journal]
 * @param {(…args:any[]) => void} [opts.log]
 * @param {object} [opts.deps]  测试用：connect(url) / now()
 */
export function createOsuWatchService({ config, persona, llm, tts = null, overlay, pet = null, counter = null, journal = null, osuApi = null, log = () => {}, deps = {} } = {}) {
  const d = { now: Date.now, connect: (url) => new WebSocket(url), playsFile: () => dataPath('plays.json'), ...deps };
  const fullConfig = () => config();
  const watchOf = () => fullConfig().watch;
  const tracker = createOsuTracker();
  // 难段预告（core/heads-up.js）：和平时说话分开走，每一帧都喂（不节流），到点直接放事先合成好的短句。
  const headsUp = deps.headsUp || createHeadsUp({ config: fullConfig, tts, overlay, pet, counter, log, deps: { now: () => d.now() } });
  // 这是张什么图（玩家标签 + 从谱面看）：选到图就在后台准备，开局点评时带上。
  const mapInfo = deps.mapInfo || createMapInfo({ config: fullConfig, osuApi, log });
  let socket = null;
  let stopped = true;
  let reconnectTimer = null;
  let configTimer = null;
  let connectedUrl = '';
  let connected = false;
  let lastFrameAt = 0;
  let lastHandledAt = 0;
  let connectError = null;
  let lastError = null;
  let voiceError = null;
  let lastComment = null;
  let skipped = [];
  let lastSaidAt = 0;
  let busy = false;
  let pendingEnd = null;
  // 每结束一把加一：模型写打图中的那句话时，如果这一把已经结束了，那句话就过时了。
  let endSeq = 0;
  // 角色的姿势：在不在打图（打图时专注、休息段喝水），上一次告诉 OBS 页面「还在打」是什么时候（心跳，见 sync）。
  let playing = false;
  let lastPlayBeat = 0;
  // 上一次 sync 时功能开没开（null = 还没 sync 过）：关掉的那一下收字幕窗口，之后不再反复收。
  let wasEnabled = null;
  let song = { key: '', said: 0, breakSaid: 0 };
  // 开局点评过的图 → 什么时候说的（同一张图十分钟内不重复点评）。
  const opened = new Map();
  const openedRecently = (event, now) => {
    for (const [key, at] of opened) if (now - at > START_REPEAT_MS) opened.delete(key);
    return opened.has(`${event.map.title}|${event.map.version}`);
  };
  let recentLines = [];
  let session = { startedAt: 0, lastAt: 0, plays: [] };
  const usage = { day: '', calls: 0, input: 0, output: 0 };
  let store = readPlays();

  function readPlays() {
    try {
      const value = JSON.parse(fs.readFileSync(d.playsFile(), 'utf8'));
      if (value?.version === 1 && Array.isArray(value.items)) return { items: value.items, said: isPlainObject(value.said) ? value.said : {} };
    } catch {}
    return { items: [], said: {} };
  }

  function persist() {
    try {
      const file = d.playsFile();
      const days = Object.keys(store.said).sort().slice(-7);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, items: store.items.slice(-PLAYS_KEEP), said: Object.fromEntries(days.map((day) => [day, store.said[day]])) }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) { log('[osu] 写记录失败：', String(error?.message ?? error).slice(0, 120)); }
  }

  const saidToday = (now) => Number(store.said[dayKey(now)]) || 0;

  function recordPlay(event) {
    const item = {
      at: event.at, result: event.kind, title: event.map.title, artist: event.map.artist, version: event.map.version, stars: event.map.stars,
      mods: event.mods || '', rank: event.kind === 'finish' ? event.rank || '' : '', acc: event.acc, peakCombo: event.peakCombo, maxCombo: event.map.maxCombo,
      miss: event.miss, pp: event.kind === 'finish' ? event.pp || 0 : 0, progress: event.progress, fullCombo: event.fullCombo === true, retries: event.retries,
    };
    store.items = [...store.items, item].slice(-PLAYS_KEEP);
    if (!session.startedAt) session.startedAt = event.at;
    session.lastAt = event.at;
    session.plays.push(item);
    persist();
  }

  /** 一场打完（很久没有新的一把，或者功能被关掉）：只记一条小结。 */
  function closeSession(now, wcfg) {
    const plays = session.plays;
    session = { startedAt: 0, lastAt: 0, plays: [] };
    recentLines = [];
    if (!plays.length || !wcfg.remember || !journal) return false;
    const passed = plays.filter((play) => play.result === 'finish');
    if (!passed.length && plays.length < 3) return false; // 随手点开又退出的不值得记
    const p = personaInfo().pronoun;
    const best = [...passed].sort((a, b) => b.stars - a.stars || b.acc - a.acc)[0];
    const parts = [`【看${p}打 osu】这一场看${p}打了 ${plays.length} 把，打完 ${passed.length} 把。`];
    // 只说「星数最高」，不说「最难」：星数算上了 mod，而 EZ 会把星数算低、实际却更难（2026-11-20 用户纠正），按星数排出来的不一定最难。
    const ezMark = (play) => (hasMod(play.mods, 'EZ') ? '；EZ 是增加难度的 mod，别拿星数说它简单' : '');
    if (best) parts.push(`星数最高的一把是《${best.title}》${best.version ? ` [${best.version}]` : ''}（${starsText(best.stars, best.mods) || '读不到难度'}${ezMark(best)}）：${best.rank || '?'}，准确率 ${best.acc}%，${best.fullCombo ? '全连' : `miss ${best.miss} 个`}。`);
    // 开着 EZ 打完的另记一笔，免得因为星数低被上面那句盖掉。
    const ez = passed.find((play) => play !== best && hasMod(play.mods, 'EZ'));
    if (ez) parts.push(`还开着 EZ 打完了《${ez.title}》${ez.version ? ` [${ez.version}]` : ''}（${starsText(ez.stars, ez.mods) || '读不到难度'}${ezMark(ez)}）。`);
    const stuck = [...plays].sort((a, b) => b.retries - a.retries)[0];
    if (stuck && stuck.retries >= 5) parts.push(`《${stuck.title}》重开了 ${stuck.retries} 次。`);
    try { return journal.append({ at: now, text: parts.join('') }) !== false; } catch { return false; }
  }

  function personaInfo() {
    try { return persona.info(); } catch { return { name: '小鲸鱼', ownerName: '主人', pronoun: '他', persona: '' }; }
  }

  function buildPrompt(event) {
    const role = personaInfo();
    const p = role.pronoun || '他';
    let memory = '';
    try { memory = (journal?.recent(3) ?? []).map((item) => `- ${new Date(item.at).toLocaleDateString('sv-SE')}：${item.text}`).join('\n'); } catch {}
    const during = !END_KINDS.has(event.kind);
    const resting = event.kind === 'break';
    const opening = event.kind === 'start';
    const maxChars = resting || opening ? 30 : during ? 18 : 40;
    // 开局：这是张什么图（core/map-info.js）。有玩家标签就让她先说这个（2026-11-21 用户：开局应该优先报玩家标签的信息；
    // 原来排在 BPM 后面、规则又只说「可以提一两个数」，她总挑 BPM 和星数说，话太长还被截掉）。
    const info = opening ? safe(() => mapInfo.get(event.map), null) : null;
    const hasTags = Boolean(info?.tags?.length);
    const system = [
      `你是「${role.name}」，现在待在${role.ownerName}的电脑桌面上（一只桌宠），正坐在旁边看${p}打 osu!（一个跟着音乐点圈圈的节奏游戏）。`,
      '',
      ...(role.persona ? ['【人设（你就是这个人）】', String(role.persona).slice(0, 3200), ''] : []),
      ...(memory ? [`【最近几场你看${p}打的（越早的记得越模糊）】`, memory.slice(0, 1400), ''] : []),
      '【这次说话的规则】',
      `- 只说一句，不超过 ${maxChars} 个字。${opening ? `这一把刚开始（还在前奏），像开局前那样点评一句这张图：快不快、难不难、你觉得${p}打不打得动。` : resting ? `现在是休息段，${p}手和眼睛都闲着，可以像中场那样点评一句。` : during ? `${p}正在打，手和眼睛都忙着，所以要特别短，像旁边的人随口蹦出来的一声。` : '这一把结束了，可以正常说一句。'}`,
      `- 像真的在看${p}打：可以夸、可以损、可以心疼、可以起哄，按你的性格来；不要每次都夸。`,
      opening && hasTags
        ? '- 先说这是张什么图：照「玩家给这张图打的标签」挑最有代表性的一两个，用中文说法说（比如「alt 图」「跳图」「断开的串」），再带一句你的看法；BPM、星数这些数最多顺带提一个，也可以不提。'
        : opening
        ? '- 可以提一两个数（比如 BPM、星数、AR），再带一句你的看法；不要把所有数都念一遍。'
        : resting
        ? '- 可以报一两个数（比如现在多少 pp、出了多少个 100），再带一句你的看法；不要把所有数都念一遍。'
        : '- 不要念数据流水账（不要把准确率、连击数一个个报一遍），最多提一个数。',
      '- 不懂的术语别硬用。知道这些就够了：miss 是没点到；连击断了很可惜；全连（FC）是一个都没漏，很厉害；评级从高到低是 SS、S、A、B、C、D；星数越高越难，这里给你的星数都是算上 mod 之后的（开了 DT 之类会变难，星数已经包含了）；BPM 是节奏快慢，AR 是圈出现得多快，CS 是圈的大小，快慢已经替你判断好了，照着说，别自己换算；100 和 50 是点到了但不够准，会掉准确率；pp 是这一把的表现分，越高越好；mp 是多人房，几个人同时打同一张图比分数。',
      // 2026-11-20 用户纠正：「EZ mod 是增加难度的不是降低难度的，ar10 以下 ar 越低谱面越难，ar10 以上才是越高越难」。
      `- 关于难度别想当然：AR 不是越低越简单——AR ${AR_PIVOT} 以下是越低越难（圈在屏幕上留得久、挤在一起，更难读），AR ${AR_PIVOT} 以上才是越高越难。EZ 这个 mod 名字叫「简单」，实际是增加难度的（它把 AR 压低，更难读）：开了 EZ 别说成「降难度」「变简单了」，EZ 会把星数算低，别拿星数说它简单。`,
      // 2026-11-19 真机：5.91 星被写成「五倍九硬开 DT」——模型自己把数字改写成汉字写歪了。念出来时会把数字转成读音，这里不用它管。
      '- 提到数字时照上面给的阿拉伯数字写（比如 5.91 星、240 BPM、98.2%），不要改写成汉字，也不要自己换算。',
      // 2026-11-20 真机：气泡里是「啊 998 断了」，用户：「应该是 998 combo 断了，不是九九八断了」——字数紧时模型把单位省了。
      '- 数字后面一定带上它是什么（998 combo、6 个 miss、5.91 星、300pp），不要光说一个数：「998 断了」听的人不知道是什么断了，要说「998 combo 断了」。',
      '- 不要写动作、旁白、括号、表情符号以外的修饰；不要加引号；不要以自己的名字开头。',
      `- 绝不要提 AI / 模型 / 提示词 / 数据 / 工具 / 读内存；你就是在看${p}的屏幕。`,
      ...(recentLines.length ? ['', '你这一场已经说过这些了，别重复同样的话：', ...recentLines.slice(-4).map((line) => `- ${line}`)] : []),
    ].join('\n');
    const user = `${describeEvent(event, { pronoun: p, rulers: fullConfig().rulers, mapInfo: info })}\n\n对${p}说一句。`;
    return { system, user, maxChars };
  }

  function shape(raw, maxChars) {
    let line = String(raw ?? '').split('\n').map((part) => part.trim()).filter(Boolean)[0] ?? '';
    line = line.replace(/^["“「『]+|["”」』]+$/g, '').replace(/[（(][^（()）]{0,30}[)）]/g, '').trim();
    const name = personaInfo().name;
    if (name && line.startsWith(name)) line = line.slice(name.length).replace(/^[\s:：，,]+/, '');
    const chars = Array.from(line);
    // 上限留一点余量：模型多写两三个字不值得截成半句。
    if (chars.length <= maxChars + 8) return line;
    // 真的太长：在上限以内最后一个标点那里收住，不截成半句（2026-11-21 真机：「……不过有 240 …」截在数字中间）；
    // 前面太短（不到上限的一半）才硬截
    const head = chars.slice(0, maxChars + 6);
    let cut = -1;
    for (let i = head.length - 1; i >= Math.floor(maxChars / 2); i -= 1) if ('，。！？!?；;…~～、,'.includes(head[i])) { cut = i; break; }
    if (cut >= 0) return head.slice(0, cut).join('').replace(/[，、,；;\s]+$/, '') + (/[。！？!?…~～]/.test(head[cut]) ? head[cut] : '');
    return `${head.join('')}…`;
  }

  /** 记一笔「这件事没说，因为……」：只在内存里留最近 12 条，不落盘。回放、刚开打就退出这种不值得提的不记。 */
  function noteSkip(event, reason, now) {
    if (reason === 'replay' || reason === 'quit-early' || reason === 'retry-not-marked' || reason === 'pose-only') return;
    skipped = [...skipped, { at: now, kind: event.kind, reason, why: SKIP_TEXT[reason] || reason, lostCombo: event.lostCombo ?? null, maxCombo: event.map?.maxCombo ?? null, sliderBreak: event.sliderBreak === true }].slice(-12);
  }

  /** 这个事件要不要说。返回 null 表示说；否则是不说的原因。 */
  function gate(event, wcfg, now) {
    if (event.replay) return 'replay';
    // 休息段结束只用来换姿势（放下水杯），不说话。
    if (event.kind === 'break-end') return 'pose-only';
    const ending = END_KINDS.has(event.kind);
    if (!ending && !wcfg.midPlay) return 'mid-play-off';
    if (event.kind === 'quit' && !(event.progress >= 0.3)) return 'quit-early';
    if (event.kind === 'retry' && !RETRY_MARKS.has(event.retries)) return 'retry-not-marked';
    // 全连没了的那一断不看长短（下限 50 已经在识别时卡过了）。
    if (event.kind === 'combo-break' && !event.fcLost && !bigEnough(event.lostCombo, event.map?.maxCombo, 50)) return 'combo-break-small';
    if (event.kind === 'combo' && !bigEnough(event.mark, event.map?.maxCombo, 100)) return 'combo-mark-small';
    // 休息段是打图中最适合说话的时候：不占每首的那几句名额、间隔也短，但一首最多说两次。
    if (event.kind === 'break') {
      if (song.breakSaid >= BREAK_MAX_PER_SONG) return 'break-max';
    } else if (event.kind === 'start') {
      // 开局那一句每张图都说（不占每首的名额）；同一张图十分钟内又进来就不再说一遍。
      if (openedRecently(event, now)) return 'start-same-map';
    } else if (!ending && song.said >= wcfg.perSongMax) return 'per-song-max';
    // 难段前后（难段预告开着时）：打图中途的点评先别说。
    if (!ending && event.kind !== 'start' && event.kind !== 'break' && safe(() => headsUp.quiet(now), false)) return 'heads-up-quiet';
    const gap = ending || event.kind === 'start' ? 6000 : event.kind === 'break' ? BREAK_GAP_MS : wcfg.minGapSec * 1000;
    if (now - lastSaidAt < gap) return 'too-soon';
    if (saidToday(now) >= wcfg.dailyLimit) return 'daily-limit';
    return null;
  }

  const petVisible = () => { try { return pet?.status?.().visible === true; } catch { return false; } };
  // OBS 里的角色装好了（tosu counter），而且 state.json 写得进去：气泡也会出在那里。
  const counterShowing = () => { try { const s = counter?.status?.(); return s?.enabled === true && s?.installed === true && s?.lastError?.code !== 'osu.counter-write'; } catch { return false; } };
  // 「念出来」开着而且语音配好了（没填 Key 时开着也念不出来）。
  const voiceReady = (wcfg) => { if (!wcfg.voice) return false; if (!tts) return true; try { return tts.ready?.()?.ok !== false; } catch { return false; } };
  // 刚启动时还没找过 tosu（不知道 static 文件夹在哪），installed 一直是 false：气泡模式只靠 OBS 的话先找一次，别把开局那句丢掉。
  async function locateCounter() {
    try {
      const s = counter?.status?.();
      if (s?.enabled === true && !s.dir) await counter.sync();
    } catch {}
  }

  /**
   * 说之前先看说了有没有人看得见 / 听得见；不行就抛（不调模型）。
   * 气泡：桌面角色、OBS 里的角色，哪边显示着就在哪边冒；两边都没有但开了「念出来」也照说（只出声）。
   * 2026-11-20 用户：直播 / 录制只用 OBS 那份，把桌面角色藏了，结果 OBS 里一句都没有——原来桌面角色藏着就整句不说。
   */
  function preflight(wcfg) {
    if (wcfg.output === 'bubble' && !petVisible() && !counterShowing() && !voiceReady(wcfg)) {
      if (!pet) throw codedError('osu.pet-unavailable', '「怎么说」选了气泡，但桌面角色没有开，OBS 里的角色也没装好', '在设置「角色」里打开桌面角色，或者看「OBS」那一块把角色装进 tosu；也可以把「怎么说」改成字幕。');
      // 桌面角色出不来是因为没有能用的皮肤（skin.*）：说真正的原因，不说「藏着、点显示角色」（复核：那个开关本来就开着）。
      const petError = (() => { try { return pet.status?.().lastError; } catch { return null; } })();
      if (String(petError?.code || '').startsWith('skin.')) throw codedError(petError.code, `「怎么说」选了气泡，但桌面角色出不来：${petError.error}`, petError.hint || '在设置「角色」里选一套皮肤。');
      throw codedError('osu.pet-hidden', '「怎么说」选了气泡，但桌面角色现在藏着，OBS 里的角色也没装好', '托盘菜单里点「显示角色」，或看设置「OBS」那一块把角色装进 tosu；也可以打开「念出来」，或者把「怎么说」改成字幕。');
    }
    if (wcfg.output === 'none' && !wcfg.voice) throw codedError('osu.no-output', '「怎么说」选了不显示字幕，又没开「念出来」，她说了你也听不到', '打开「念出来」；或者把「怎么说」改回字幕 / 气泡。');
    const state = llm.ready();
    if (!state.ok) throw codedError(state.code, state.error, state.hint);
  }

  function recordUsage(result, now) {
    const day = dayKey(now);
    if (usage.day !== day) Object.assign(usage, { day, calls: 0, input: 0, output: 0 });
    usage.calls += 1;
    usage.input += Number(result?.usage?.input) || 0;
    usage.output += Number(result?.usage?.output) || 0;
  }

  async function synthesizeVoice(line, wcfg) {
    if (!wcfg.voice) return { voice: null, failure: null };
    if (!tts) return { voice: null, failure: '没有配置语音合成' };
    try {
      let timer;
      const result = await Promise.race([
        tts.synthesize(line),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), VOICE_WAIT_MS); timer.unref?.(); }),
      ]);
      clearTimeout(timer);
      if (result?.timeout) return { voice: null, failure: `等了 ${VOICE_WAIT_MS / 1000} 秒还没合成出来` };
      if (result?.bytes?.length) return { voice: { bytes: result.bytes, durationMs: Number(result.durationMs) || 0 }, failure: null };
      return { voice: null, failure: '合成出来的音频是空的' };
    } catch (error) {
      return { voice: null, failure: `${String(error?.message ?? error)}${error?.code ? `（${error.code}）` : ''}` };
    }
  }

  async function say(event, wcfg) {
    const startedAt = d.now();
    const seqAtStart = endSeq;
    const during = !END_KINDS.has(event.kind);
    try {
      if (wcfg.output === 'bubble' && !petVisible() && !counterShowing()) await locateCounter();
      preflight(wcfg);
      const prompt = buildPrompt(event);
      const result = await llm.complete({ system: prompt.system, user: prompt.user, maxTokens: 200 });
      recordUsage(result, d.now());
      const line = unitizeCombo(shape(result.text, prompt.maxChars), event);
      if (!line) return { ok: false, reason: 'empty' };
      // 念出来：合成不出来（没配 / 超时 / 报错）就只出字，不为了声音把这句话丢掉。
      const { voice, failure } = await synthesizeVoice(line, wcfg);
      // 字有没有地方显示：字幕；或者气泡模式下桌面 / OBS 里有一个角色看得见。
      const shown = wcfg.output === 'subtitle' || (wcfg.output === 'bubble' && (petVisible() || counterShowing()));
      const lostHint = wcfg.output === 'none' ? '「不显示字幕」时没声音这句就没了。' : '桌面角色藏着、OBS 里的角色也没装好，没声音这句就没了。';
      voiceError = failure
        ? { code: 'osu.voice-failed', error: `这一句没念出来：${failure.slice(0, 160)}`, hint: `${shown ? '字照常显示。' : lostHint}到设置「语音」里点「试听」看能不能出声。`, at: new Date(d.now()).toISOString() }
        : (wcfg.voice ? null : voiceError);
      // 没合成出声音，字又没地方显示（不出字；或者气泡模式下桌面和 OBS 的角色都看不见）：这句话没法让你知道，算没说。
      if (!voice && !shown) {
        lastError = voiceError ? { ...voiceError } : { code: 'osu.voice-failed', error: '这一句没念出来', hint: '到设置「语音」里点「试听」看能不能出声。', at: new Date(d.now()).toISOString() };
        log(`[osu] 没说成（${lastError.code}，字没地方显示又没声音）`);
        return { ok: false, reason: 'no-voice' };
      }
      const now = d.now();
      // 打图中的话过时了就不说：模型或语音合成慢了，或者这一把已经结束了。要念出来时多给几秒。
      if (during && (now - startedAt > (wcfg.voice ? STALE_VOICE_MS : STALE_MS) || endSeq !== seqAtStart)) return { ok: false, reason: 'stale' };
      // 写这一句的几秒里打到了难段前后（难段预告开着）：不说了，免得撞上提示音、或者在难的地方插嘴（复核发现：闸门那一刻还不在，写完时已经在了）。
      // 开局和休息段那两句和闸门一样不压。
      if (during && event.kind !== 'start' && event.kind !== 'break' && safe(() => headsUp.quiet(now), false)) { noteSkip(event, 'heads-up-quiet', now); return { ok: false, reason: 'heads-up-quiet' }; }
      const chars = Array.from(line).length;
      const talkMs = Math.round(voice && voice.durationMs > 0 ? voice.durationMs : talkMsFor(line));
      // 嘴怎么动：有声音按声音的响度，没有就按字数假装说（皮肤有张嘴图时用得上，没有的皮肤忽略它）。
      const mouth = (voice && mouthTrackFromWav(voice.bytes)) || mouthTrackFromText(line, talkMs);
      // 字幕留多久：有语音就等它念完（时长只当保险）；没有就按字数算，像视频字幕那样一闪而过但读得完。
      const subtitleMs = voice ? (voice.durationMs > 0 ? voice.durationMs + 2000 : 15_000) : Math.min(7000, Math.max(2600, 1400 + chars * 210));
      // 本地字幕窗口：出字幕；不出字（气泡 / 只念）时也由它放声音（透明、点不到，看不见）。
      if (wcfg.output === 'subtitle' || voice) overlay.say({ text: line, audio: voice?.bytes ?? null, ms: subtitleMs, hidden: wcfg.output !== 'subtitle' });
      // 桌面角色：显示着就跟着张嘴；气泡模式在她头顶冒气泡。
      let onDesktop = false;
      try { if (petVisible()) onDesktop = pet.speak({ text: line, durationMs: talkMs, bubble: wcfg.output === 'bubble', mouth }) !== false; } catch {}
      // OBS 里的角色（tosu counter）：同一句话同步张嘴 + 气泡 / 字幕。
      let onObs = false;
      try { onObs = counter?.say({ text: line, durationMs: talkMs, mouth }) === true; } catch {}
      // 气泡模式、没声音：桌面和 OBS 两边都没显示出来（比如 state.json 刚好写不进去），这句就没人知道，算没说。
      if (wcfg.output === 'bubble' && !voice && !onDesktop && !onObs) {
        const counterError = safe(() => counter?.status?.().lastError, null);
        lastError = counterError?.code ? { ...counterError, at: new Date(d.now()).toISOString() } : { code: 'osu.bubble-nowhere', error: '这一句气泡哪边都没显示出来', hint: '看设置「角色」和「OBS」那两块的提示。', at: new Date(d.now()).toISOString() };
        delete lastError.ok;
        log(`[osu] 没说成（${lastError.code}，气泡哪边都没显示出来）`);
        return { ok: false, reason: lastError.code };
      }
      lastSaidAt = now;
      if (event.kind === 'break') song.breakSaid += 1;
      else if (event.kind === 'start') opened.set(`${event.map.title}|${event.map.version}`, now);
      else if (during) song.said += 1;
      store.said[dayKey(now)] = saidToday(now) + 1;
      recentLines = [...recentLines, line].slice(-8);
      lastComment = { at: now, kind: event.kind, text: line, voiced: Boolean(voice) };
      lastError = null;
      persist();
      return { ok: true, text: line };
    } catch (error) {
      lastError = { ...failureOf(error, '看日志里 [osu] 开头的行。'), at: new Date(d.now()).toISOString() };
      delete lastError.ok;
      log(`[osu] 没说成（${lastError.code}）：${lastError.error}`);
      return { ok: false, reason: lastError.code };
    }
  }

  async function drain(wcfg) {
    if (busy) return;
    busy = true;
    try {
      while (pendingEnd) {
        const event = pendingEnd;
        pendingEnd = null;
        await say(event, wcfg);
      }
    } finally {
      busy = false;
    }
  }

  /** 把时刻和「在不在打图」告诉桌面角色和 OBS 页面（没有这两样时什么都不做；出错不影响说话）。 */
  function sendReaction(payload) {
    try { pet?.react?.(payload); } catch (error) { log('[osu] 桌面角色换姿势失败：', String(error?.message ?? error).slice(0, 120)); }
    try { counter?.react?.(payload); } catch (error) { log('[osu] OBS 页面换姿势失败：', String(error?.message ?? error).slice(0, 120)); }
  }

  function react(event, now) {
    const moment = momentOf(event);
    const next = playingAfter(event);
    const changed = next !== null && next !== playing;
    if (changed) playing = next;
    if (!moment && !changed) return;
    lastPlayBeat = now;
    sendReaction({ moment, playing });
  }

  /** 不是由事件带来的「不打了」：tosu 断了、功能关了、程序退出、对局悄悄没了（osu! 被关掉）。 */
  function setPlaying(on, now = d.now()) {
    if (playing === on) return;
    playing = on;
    lastPlayBeat = now;
    sendReaction({ moment: null, playing });
  }

  /** 处理一个事件（测试直接调）。返回做了什么。 */
  async function handleEvent(event, wcfg = watchOf()) {
    const now = d.now();
    if (event.kind === 'start' || event.kind === 'retry') {
      const key = `${event.map.title}|${event.map.version}`;
      if (song.key !== key) song = { key, said: 0, breakSaid: 0 };
    }
    if (END_KINDS.has(event.kind)) endSeq += 1;
    if (END_KINDS.has(event.kind) && !event.replay && (event.kind !== 'quit' || event.progress >= 0.1)) recordPlay(event);
    // 先换姿势、再过说话的闸门：断连了就该露出「呜哇」的样子，哪怕这一下她没说话。
    react(event, now);
    const reason = gate(event, wcfg, now);
    if (reason) {
      noteSkip(event, reason, now);
      return { said: false, reason };
    }
    if (busy) {
      // 正在写上一句：打图中的事就算了；结束的事排着（只留最新的一个）。
      if (!END_KINDS.has(event.kind)) { noteSkip(event, 'busy', now); return { said: false, reason: 'busy' }; }
      pendingEnd = event;
      return { said: false, reason: 'queued' };
    }
    busy = true;
    let result;
    try { result = await say(event, wcfg); } finally { busy = false; }
    if (pendingEnd) void drain(wcfg);
    return result.ok ? { said: true, text: result.text } : { said: false, reason: result.reason };
  }

  // 脚下的 pp 地台环开着没有（最后发的是不是 on）：tosu 断了、关掉看 osu!、程序停了、很久没数据时收起来
  // （复核发现：原来只在收到非打图的帧时才收，打到一半关掉 osu! 环就一直挂在桌面上）
  let hudShown = false;
  function sendHud(data) {
    if (!pet?.hud) return;
    hudShown = data.on === true;
    try { pet.hud(data); } catch {}
  }
  function hideHud() { if (hudShown) sendHud({ on: false }); }

  /** 喂一帧 tosu 的数据（测试直接调）。 */
  function handleFrame(raw, wcfg = watchOf()) {
    const now = d.now();
    lastFrameAt = now;
    const snap = normalizeSnapshot(raw);
    // 难段预告每一帧都看（时间要准），出错不影响别的。
    try { headsUp.onFrame(snap, tracker.current(), now); } catch (error) { log('[heads-up] 出错：', String(error?.message ?? error).slice(0, 120)); }
    try { mapInfo.onFrame(snap, now); } catch (error) { log('[map-info] 出错：', String(error?.message ?? error).slice(0, 120)); }
    // 脚下的 pp 地台环（桌面角色，2026-11-21）：每一帧给，桌面窗口那边一样就不重发
    if (snap) sendHud({ on: snap.state === 'play', pp: snap.play.pp, fc: snap.play.ppFc, n100: snap.play.n100, n50: snap.play.n50, miss: snap.play.miss, progress: progressOf(snap.map) });
    // 环上的难度带（2026-11-21）：tosu 的难度曲线按进度压成一圈；选歌 / 打图时才算（菜单里 tosu 的曲线可能还是别的图的）
    if (snap && pet?.hudCurve && (snap.state === 'play' || snap.state === 'select' || snap.state === 'multi')) {
      try { pet.hudCurve(curveFromGraph(snap.graph, { first: snap.map.timeFirst, last: snap.map.timeLast, rate: snap.map.rate })); } catch {}
    }
    if (now - lastHandledAt < FRAME_GAP_MS) return [];
    lastHandledAt = now;
    const events = tracker.feed(snap, now);
    for (const event of events) void handleEvent(event, wcfg).catch((error) => log('[osu] 处理事件失败：', String(error?.message ?? error).slice(0, 120)));
    // 「打图中」以 tracker 为准：tosu 断了又连上、功能关了又开、osu! 卡住又恢复时，这一把还在 tracker 里，但没有新的开局事件。
    // 有帧进来、tracker 里有一把正在打（不是回放）就补上 play-on。结束事件在上面已经同步处理过，那时 current() 是 null。
    const cur = tracker.current();
    if (!playing && cur && !cur.replay) setPlaying(true, now);
    return events;
  }

  function disconnect() {
    connected = false;
    connectedUrl = '';
    const old = socket;
    socket = null;
    try { old?.close(); } catch {}
  }

  function scheduleReconnect(delayMs) {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; sync(); }, delayMs);
    reconnectTimer.unref?.();
  }

  const TOSU_HINT = '先打开 tosu.exe（没装的话到 github.com/tosuapp/tosu 的发布页下载），并且让 osu! 开着。它开着的时候这里会自动连上。';

  function connect(wcfg) {
    let ws;
    try {
      ws = d.connect(wcfg.url);
    } catch {
      connectError = failureOf(codedError('osu.tosu-offline', '连不上 tosu', TOSU_HINT));
      scheduleReconnect(10_000);
      return;
    }
    socket = ws;
    connectedUrl = wcfg.url;
    ws.addEventListener('open', () => {
      if (socket !== ws) return;
      connected = true; connectError = null; log('[osu] 已连上 tosu');
      // 连上 tosu 时把 OBS 用的页面装进 / 更新到 tosu。失败只记下来，显示在设置窗口上。
      syncCounter(false);
    });
    ws.addEventListener('message', (message) => {
      if (socket !== ws) return;
      let raw = null;
      try { raw = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data)); } catch { return; }
      try { handleFrame(raw); } catch (error) { log('[osu] 处理数据失败：', String(error?.message ?? error).slice(0, 120)); }
    });
    const dropped = () => {
      if (socket !== ws) return;
      const wasConnected = connected;
      disconnect();
      // 打到一半 tosu 断了：没有结束事件，得自己告诉角色「不打了」，不然 OBS 里她会一直停在打图的姿势。
      setPlaying(false);
      hideHud();
      connectError = failureOf(codedError('osu.tosu-offline', wasConnected ? '和 tosu 的连接断了' : '连不上 tosu', TOSU_HINT));
      scheduleReconnect(wasConnected ? 3000 : 10_000);
    };
    ws.addEventListener('close', dropped);
    ws.addEventListener('error', dropped);
  }

  /** 按现在的设置对齐连接状态（开关变了、地址变了都走这里）。 */
  function sync() {
    if (stopped) return;
    let wcfg;
    try { wcfg = watchOf(); } catch { return; }
    const now = d.now();
    if (session.plays.length && now - session.lastAt > SESSION_IDLE_MS) closeSession(now, wcfg);
    if (!wcfg.enabled) {
      if (socket) { disconnect(); closeSession(now, wcfg); log('[osu] 已关闭'); }
      setPlaying(false, now);
      hideHud();
      connectError = null;
      // 只在刚关掉的那一下收字幕窗口：关着时每 5 秒都收一次，会把「让她说一句试试」正在念的那句掐断（2026-11-20 离屏自检发现）。
      if (wasEnabled !== false) overlay.stop();
      wasEnabled = false;
      return;
    }
    wasEnabled = true;
    if (socket && connectedUrl !== wcfg.url) disconnect();
    if (!socket && !reconnectTimer) connect(wcfg);
    // 打图中：对局悄悄没了（osu! 被关掉、tosu 不再推数据）就当不打了；还在打就每 30 秒给 OBS 页面一次心跳——
    // 页面那边 90 秒没收到心跳会自己放下「打图中」，osu-pet 崩了也不会让她一直停在打图的姿势。
    if (playing) {
      if (!connected || !tracker.current() || now - lastFrameAt > 15_000) setPlaying(false, now);
      else if (now - lastPlayBeat > 30_000) { lastPlayBeat = now; try { counter?.react?.({ moment: null, playing: true }); } catch {} }
    }
    // 连着 tosu 时每分钟对一次：换了皮肤、程序更新过，就把 counter 里的皮肤 / 渲染层跟着换掉。
    if (connected && now - lastCounterSync > 60_000) syncCounter(false);
    if (now - lastFrameAt > 15_000) hideHud();
  }

  let lastCounterSync = 0;
  function syncCounter(force) {
    if (!counter) return;
    lastCounterSync = d.now();
    Promise.resolve().then(() => counter.sync({ force })).then((r) => {
      if (r && r.ok === false) log(`[osu] OBS 页面没装进 tosu（${r.code}）`);
    }).catch((error) => log('[osu] 同步 tosu counter 出错：', String(error?.message ?? error).slice(0, 120)));
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    sync();
    configTimer = setInterval(sync, 5000);
    configTimer.unref?.();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (configTimer) clearInterval(configTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    configTimer = null;
    reconnectTimer = null;
    let wcfg = null;
    try { wcfg = watchOf(); } catch {}
    disconnect();
    setPlaying(false);
    hideHud();
    overlay.stop();
    if (wcfg) closeSession(d.now(), wcfg);
  }

  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  function status() {
    const now = d.now();
    const cfg = safe(fullConfig, null);
    const wcfg = cfg?.watch ?? { ...DEFAULTS.watch };
    return {
      ok: true,
      watch: wcfg,
      tosu: { connected, url: wcfg.url, lastFrameAt: lastFrameAt || null, error: wcfg.enabled && !connected ? connectError : null },
      llm: safe(() => llm.ready(), { ok: false, code: 'llm.unknown', error: '读不到模型状态', hint: '' }),
      voice: { enabled: wcfg.voice, ready: tts ? safe(() => tts.ready(), null) : null, lastError: wcfg.voice ? voiceError : null },
      overlay: safe(() => overlay.status(), { running: false, lastError: null }),
      pet: pet ? safe(() => pet.status(), null) : null,
      counter: counter ? safe(() => counter.status(), null) : null,
      persona: (() => { const info = personaInfo(); return { name: info.name, ownerName: info.ownerName, pronoun: info.pronoun, personaChars: info.personaChars ?? String(info.persona || '').length }; })(),
      // 很久没收到数据：tosu 连着，但 osu! 可能没开。
      playing: connected && now - lastFrameAt < 5000 ? tracker.current() : null,
      // 角色那边认为「在打图」（打图时专注的姿势、休息段喝水）。
      posePlaying: playing,
      headsUp: safe(() => headsUp.status(), null),
      mapInfo: safe(() => mapInfo.status(), null),
      today: { said: saidToday(now), limit: wcfg.dailyLimit, llmCalls: usage.day === dayKey(now) ? usage.calls : 0, tokens: usage.day === dayKey(now) ? usage.input + usage.output : 0 },
      lastComment,
      // 最近没说的事和原因（最新在前）：「为什么那一下她没反应」直接看这里。
      skipped: [...skipped].reverse(),
      // 「气泡没地方出」的错已经不成立了（桌面角色打开了 / OBS 角色装好了）：不再挂着，免得和新的提示互相矛盾。
      lastError: lastError && BUBBLE_BLOCKED.has(lastError.code) && (petVisible() || counterShowing()) ? null : lastError,
      plays: [...store.items].reverse().slice(0, 12),
      checkedAt: new Date(now).toISOString(),
    };
  }

  /** 设置窗口的操作：test（让她说一句试试）/ counter-sync / clear-plays。完成后返回最新状态。 */
  async function act(body = {}) {
    const action = typeof body?.action === 'string' ? body.action : '';
    let extra = {};
    if (action === 'test') {
      // 用一把假的成绩走完整条链路（过闸除外）：验证「模型写得出 + 显示 / 念得出来」。不记进成绩和小结。
      const event = {
        kind: 'finish', at: d.now(), replay: false, retries: 0, progress: 1, acc: 97.42, miss: 2, combo: 0, peakCombo: 486, rank: 'A', pp: 0, fullCombo: false,
        mods: '', map: { title: '（试一下）', artist: '', version: 'Insane', stars: 4.8, maxCombo: 812 },
      };
      if (busy) throw codedError('osu.busy', '她正在说上一句', '等几秒再点。');
      busy = true;
      let result;
      try { result = await say(event, watchOf()); } finally { busy = false; }
      if (!result.ok) throw codedError(lastError?.code || 'osu.test-failed', lastError?.error || '没说出来', lastError?.hint || '看上面的状态里哪一项不对。');
      extra = { said: result.text };
    } else if (action === 'counter-sync') {
      if (!counter) throw codedError('osu.counter-unavailable', '没有 tosu counter', '这是程序的问题，看日志。');
      const r = await counter.sync({ force: true });
      if (!r.ok) throw codedError(r.code, r.error, r.hint);
      extra = { counterSynced: r };
    } else if (action === 'clear-plays') {
      store = { items: [], said: store.said };
      persist();
    } else {
      throw codedError('osu.action-unknown', `不认识的操作：${action || '（空）'}`, '支持 test / counter-sync / clear-plays。');
    }
    return { ...status(), ...extra };
  }

  return { start, stop, status, act, handleFrame, handleEvent, sync };
}
