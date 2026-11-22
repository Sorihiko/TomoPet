/**
 * 游戏时刻：把 core/events.js 认出来的事件归成一个「时刻」名字，交给角色去换姿势。纯函数。
 *
 * 为什么单独一层：说不说话由 watch.js 的闸门决定（间隔、每首上限、每天上限），但角色的姿势不该跟着闸门走——
 * 断连了就该露出「呜哇」的样子，哪怕这一下她没说话。所以时刻在过闸之前就发出去（watch.js handleEvent）。
 *
 * 时刻名字是皮肤和渲染器之间的约定：皮肤的 manifest.sprite.reactions 按这些名字配姿势（core/crosspet-import.js 写默认表）。
 *
 *   start          开始打一张图
 *   combo          连击过关口
 *   combo-break    普通断连
 *   slider-break   断在滑条上（没漏点）
 *   fc-lost        这一断把全连断没了
 *   acc-drop       突然掉准度
 *   break          进休息段          break-end   休息段结束（events.js 2026-11-20 加的）
 *   rank-up        多人房超人        rank-down   被超
 *   retry          重开（1–2 次）    retry-sulk（3–9 次）  retry-tired（10–19 次）  retry-rage（20 次以上）
 *   fc             全连打完
 *   pass-good      打完，评级 A 以上（含 S / SS 的各种写法）
 *   pass           打完，评级 B 及以下
 *   fail           没血了
 *   quit           打了一段（≥10%）退出；刚点开就退出不算
 *   heads-up       难段预告：后面两三秒有长串 / 大跳（core/heads-up.js 直接发，不经过 momentOf；2026-11-21 加的）
 */

export const MOMENTS = Object.freeze([
  'start', 'combo', 'combo-break', 'slider-break', 'fc-lost', 'acc-drop', 'break', 'break-end',
  'rank-up', 'rank-down', 'retry', 'retry-sulk', 'retry-tired', 'retry-rage', 'fc', 'pass-good', 'pass', 'fail', 'quit', 'heads-up',
]);

/** 评级是不是 A 及以上（osu! 的写法：SS / X、带 HD / FL 的 SSH / XH、S / SH、A）。 */
const GOOD_RANKS = new Set(['XH', 'X', 'SSH', 'SS', 'SH', 'S', 'A']);

/**
 * @param {object} event   events.js 吐出来的事件
 * @returns {string|null}  时刻名字；看回放 / 观战、不值得换姿势的返回 null
 */
export function momentOf(event) {
  if (!event || typeof event !== 'object' || event.replay) return null;
  switch (event.kind) {
    case 'start': return 'start';
    case 'combo': return 'combo';
    case 'combo-break':
      if (event.fcLost) return 'fc-lost';
      if (event.sliderBreak) return 'slider-break';
      return 'combo-break';
    case 'acc-drop': return 'acc-drop';
    case 'break': return 'break';
    case 'break-end': return 'break-end';
    case 'rank-up': return 'rank-up';
    case 'rank-down': return 'rank-down';
    case 'retry': {
      const n = Number(event.retries) || 0;
      if (n >= 20) return 'retry-rage';
      if (n >= 10) return 'retry-tired';
      if (n >= 3) return 'retry-sulk';
      return 'retry';
    }
    case 'finish':
      if (event.fullCombo) return 'fc';
      return GOOD_RANKS.has(String(event.rank || '').toUpperCase()) ? 'pass-good' : 'pass';
    case 'fail': return 'fail';
    case 'quit': return Number(event.progress) >= 0.1 ? 'quit' : null;
    default: return null;
  }
}

/**
 * 这一下之后「在不在打图」：开局 / 重开 → true；打完 / 失败 / 退出 → false；别的不变（返回 null）。
 * 角色打图时保持专注的姿势，休息段里喝水（renderer/sprite-director.js）。
 */
export function playingAfter(event) {
  if (!event || event.replay) return null;
  if (event.kind === 'start' || event.kind === 'retry') return true;
  if (event.kind === 'finish' || event.kind === 'fail' || event.kind === 'quit') return false;
  return null;
}
