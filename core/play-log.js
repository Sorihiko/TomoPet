/**
 * 日志里「当时打成什么样」的那几段字（core/watch.js 用）。
 *
 * 2026-11-23 用户：「log 记录的东西是不是详细点更好，这样我们也知道 ai 什么时候说的话和游戏数据有什么关系」。
 * 所以每一句话、每一次没说、每一局的开头和结尾，都带上当时的游戏数据，比如：
 *
 *   [osu] 说了（断连，念了）：又断了，手别抖
 *   [osu]   当时：断了 412 combo，FC 没了｜Alive [Insane] +HD｜谱面 1:42（63%）｜97.80%｜连击 0（最高 412 / 1500）｜100×18 50×1 miss×2｜241pp｜事件后 2.4 秒说出｜模型 deepseek-chat 1.8 秒，语音 0.6 秒
 *
 * 只写对局本身的数：不写人设、提示词、Key，也不写多人房里别人的名字（朋友把日志发过来时不该带上这些；
 * 她说的话里提到对方时，watch.js 用 hideNames 换成「对方」）。
 * 读不到的项不写（tosu 版本不同，有些字段可能没有）。都是一行，方便按时间看、按「说了 / 没说」搜。
 */

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

/** 毫秒 → 「1:42」（谱面里的位置，不随 DT / HT 变）。 */
export function clock(ms) {
  if (!isNum(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 秒数，一位小数：1834 → 「1.8 秒」。 */
export function seconds(ms) {
  return isNum(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)} 秒` : '';
}

const pct = (fraction) => (isNum(fraction) ? `${Math.round(fraction * 100)}%` : '');
// tosu 给的准度是百分数（97.42），不是小数
const acc = (value) => (isNum(value) && value > 0 ? `${value.toFixed(2)}%` : '');
const pp = (value) => (isNum(value) && value > 0 ? `${Math.round(value)}pp` : '');
const mods = (value) => (value ? `+${String(value).replace(/[\s,]+/g, '')}` : '');

/** 「Alive [Insane] +HD」 */
export function mapName(event = {}) {
  const map = event.map || {};
  const name = [map.title || '（不知道哪张图）', map.version ? `[${map.version}]` : ''].filter(Boolean).join(' ');
  return [name, mods(event.mods)].filter(Boolean).join(' ');
}

/** 「谱面 1:42（63%）」：打到哪了。 */
function position(event) {
  const at = clock(event.timeMs);
  const done = pct(event.progress);
  if (at && done) return `谱面 ${at}（${done}）`;
  if (at) return `谱面 ${at}`;
  return done ? `打到 ${done}` : '';
}

/** 「连击 0（最高 412 / 1500）」 */
function combo(event) {
  const max = event.map?.maxCombo;
  const peak = isNum(event.peakCombo) ? `最高 ${event.peakCombo}${isNum(max) && max > 0 ? ` / ${max}` : ''}` : '';
  if (isNum(event.combo)) return `连击 ${event.combo}${peak ? `（${peak}）` : ''}`;
  return peak ? `连击${peak}` : '';
}

/** 「100×18 50×1 miss×2」 */
function hits(event) {
  const parts = [];
  if (isNum(event.n100)) parts.push(`100×${event.n100}`);
  if (isNum(event.n50)) parts.push(`50×${event.n50}`);
  if (isNum(event.miss)) parts.push(`miss×${event.miss}`);
  return parts.join(' ');
}

/** 这一刻的成绩（不带图名）：位置、准度、连击、100 / 50 / miss、pp。 */
export function statsOf(event = {}) {
  return [position(event), acc(event.acc), combo(event), hits(event), pp(event.pp)].filter(Boolean).join('｜');
}

/** 这一刻的成绩：图、位置、准度、连击、100 / 50 / miss、pp。 */
export function stateOf(event = {}) {
  return [mapName(event), statsOf(event)].filter(Boolean).join('｜');
}

/** 这件事本身：断了多少、过了哪个关口、名次从几到几…… */
export function detailOf(event = {}) {
  switch (event.kind) {
    case 'start': return event.retries > 0 ? `开局（第 ${event.retries} 次重开）` : '开局';
    case 'retry': {
      const before = event.before || {};
      const was = [pct(before.progress) && `上一把打到 ${pct(before.progress)}`, isNum(before.miss) && `miss×${before.miss}`].filter(Boolean).join('，');
      return `${isNum(event.retries) && event.retries > 0 ? `第 ${event.retries} 次重开` : '重开'}${was ? `（${was}）` : ''}`;
    }
    case 'combo-break': return [`断了 ${event.lostCombo ?? '?'} combo`, event.sliderBreak && '滑条没跟住', event.fcLost && 'FC 没了'].filter(Boolean).join('，');
    case 'combo': return `过了 ${event.mark ?? '?'} combo`;
    case 'acc-drop': {
      const added = [event.new100 > 0 && `${event.new100} 个 100`, event.new50 > 0 && `${event.new50} 个 50`].filter(Boolean).join('、');
      const fell = acc(event.accFrom) && acc(event.acc) ? `，准度 ${acc(event.accFrom)} → ${acc(event.acc)}` : '';
      return `${event.seconds ?? '?'} 秒里多了 ${added || '几个 100 / 50'}${fell}`;
    }
    case 'break': return '进了休息段';
    case 'break-end': return '休息段结束';
    case 'rank-up':
    case 'rank-down': return `多人房第 ${event.from ?? '?'} → 第 ${event.to ?? '?'}${event.players ? `（${event.players} 人）` : ''}`;
    case 'finish': {
      const place = event.place?.rank ? `多人房第 ${event.place.rank} / ${event.place.players}` : '';
      return [`打完${event.rank ? `，评级 ${event.rank}` : ''}`, event.fullCombo && 'FC', place].filter(Boolean).join('，');
    }
    case 'fail': return `失败${pct(event.progress) ? `，打到 ${pct(event.progress)}` : ''}`;
    case 'quit': return `退出${pct(event.progress) ? `，打到 ${pct(event.progress)}` : ''}`;
    default: return String(event.kind ?? '');
  }
}

/** 开局那一行：「Alive [Insane] +HD｜7.12 星｜BPM 225｜AR 10.3｜CS 4｜第 2 次重开」。 */
export function startLine(event = {}) {
  const map = event.map || {};
  const parts = [mapName(event)];
  if (isNum(map.stars) && map.stars > 0) parts.push(`${map.stars} 星`);
  if (isNum(map.bpm) && map.bpm > 0) parts.push(`BPM ${Math.round(map.bpm)}`);
  if (isNum(map.ar) && map.ar > 0) parts.push(`AR ${Math.round(map.ar * 10) / 10}`);
  if (isNum(map.cs) && map.cs > 0) parts.push(`CS ${Math.round(map.cs * 10) / 10}`);
  if (isNum(map.maxCombo) && map.maxCombo > 0) parts.push(`${map.maxCombo} combo`);
  if (event.retries > 0) parts.push(`第 ${event.retries} 次重开`);
  if (event.multi) parts.push('多人房');
  if (event.replay) parts.push('回放 / 观战，不说话');
  return parts.join('｜');
}

/**
 * 模型写的话里把别人的名字换成「对方」：多人房超人 / 被超时模型拿到了对方的名字（最多 3 个），写出来的话可能带着。
 * 长的名字先换（「Bob」和「Bobby」都在时不把 Bobby 换成「对方by」）。
 */
export function hideNames(text, names) {
  let out = String(text ?? '');
  const list = (Array.isArray(names) ? names : []).map((name) => String(name ?? '').trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const name of list) out = out.split(name).join('对方');
  return out;
}

/** 「她说的这句话和当时的游戏」：事件本身 + 当时的成绩。 */
export function contextOf(event = {}) {
  return [detailOf(event), stateOf(event)].filter(Boolean).join('｜');
}

/**
 * 「事件后 2.4 秒说出｜模型 deepseek-chat 1.8 秒（输入 812 / 输出 21 token），语音 0.6 秒」。
 * timing：{ eventAt, saidAt, llmMs, ttsMs, model, input, output }，没有的项不写。
 */
export function timingOf(timing = {}) {
  const parts = [];
  if (isNum(timing.eventAt) && isNum(timing.saidAt) && timing.eventAt > 0) parts.push(`事件后 ${seconds(Math.max(0, timing.saidAt - timing.eventAt))}${timing.dropped ? '' : '说出'}`);
  const tokens = isNum(timing.input) && isNum(timing.output) && (timing.input || timing.output) ? `（输入 ${timing.input} / 输出 ${timing.output} token）` : '';
  const model = isNum(timing.llmMs) ? `模型${timing.model ? ` ${timing.model}` : ''} ${seconds(timing.llmMs)}${tokens}` : '';
  // 开着「念出来」但没合成出来（没配、超时、报错）：写原因，不写一个像是念了的时长
  const voice = timing.ttsFail
    ? `语音没念出来（${String(timing.ttsFail).slice(0, 60)}${isNum(timing.ttsMs) ? `，等了 ${seconds(timing.ttsMs)}` : ''}）`
    : isNum(timing.ttsMs) ? `语音 ${seconds(timing.ttsMs)}` : '';
  const spent = [model, voice].filter(Boolean).join('，');
  if (spent) parts.push(spent);
  return parts.join('｜');
}
