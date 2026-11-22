/**
 * 「这是张什么图」（2026-11-21 用户：「能识别到 user tags 吗，这是玩家加的标签，可以直观的知道是张什么图」「不是所有图都有」）。
 *
 * 选到一张图（选歌 / 多人房 / 开打）时，在后台准备两样，开局点评时一起给模型（core/watch.js describeEvent）：
 *   tags     玩家标签：osu! 官网上玩家投票加的（core/osu-api.js，要在设置「高级」里填自己的 OAuth 应用；没填 / 官网上没有就空）
 *   profile  从谱面本身看：串多不多、有没有断开的串 / 宽间距串、大跳几段、变速（core/patterns.js mapProfile）——每张图都有
 * 都是后台慢慢准备的：开局那一下还没好就先不说，不等。
 *
 * 不能把官网问烦（复核发现）：选歌界面里同一张图停 1 秒以上才去查（开打时马上查），滚图时不会一张张都查；
 * 查失败了 1 分钟后再试、读谱失败 5 秒后再试，两样分开重试，不会每一帧都重来一遍。
 */
import { readBeatmapText } from './beatmap-file.js';
import { mapProfile, parseOsu, profileText } from './patterns.js';
import { tagNameZh } from './tag-names.js';

const KEEP = 20; // 最近几张图的结果留着（来回切图不用重算）
const SETTLE_MS = 1000; // 选歌界面停在同一张图多久才去准备
const TAGS_RETRY_MS = 60_000;
const PROFILE_RETRY_MS = 5_000;

/**
 * @param {object} opts
 * @param {() => object} opts.config      完整设置（读 tosu 地址）
 * @param {{ready():object, userTags(o:object):Promise<object>}} [opts.osuApi]
 * @param {object} [opts.deps]   测试用：readFile、fetchText（同 core/beatmap-file.js）、now
 */
export function createMapInfo({ config, osuApi = null, log = () => {}, deps = {} } = {}) {
  const d = { now: Date.now, ...deps };
  // key（checksum + 倍速 + CS）→ info
  const infos = new Map();
  let lastKey = '';
  let seen = { key: '', since: 0 };

  // 谱面分析按倍速和 CS 算（开 HR / EZ 时 CS 变了，叠串 / 宽间距按半径算会不一样；复核发现）
  // AR 也算进去：开 HR / EZ 时同屏多久不一样，「难读」跟着变
  const keyOf = (map) => `${map.key}|${Number(map.rate) || 1}|${Number(map.cs) || 0}|${Number(map.ar) || 0}`;

  function infoFor(map, key) {
    let info = infos.get(key);
    if (!info) {
      info = { title: map.title, version: map.version, tags: null, tagsReason: '', tagsError: null, tagsBusy: false, tagsRetryAt: 0, profile: null, profileText: '', profileBusy: false, profileRetryAt: 0, error: null };
    }
    infos.delete(key);
    infos.set(key, info);
    while (infos.size > KEEP) infos.delete(infos.keys().next().value);
    return info;
  }

  function prepare(map, now) {
    const key = keyOf(map);
    lastKey = key;
    const info = infoFor(map, key);
    // 玩家标签（官网）：没填 OAuth 应用就不查；查到了（有没有标签都算）不再查；失败的过一会儿再试
    const apiOk = Boolean(osuApi && osuApi.ready?.().ok);
    if (!apiOk) { if (info.tags === null) info.tagsReason = 'no-key'; }
    else if (!info.tagsBusy && (info.tags === null || info.tagsReason === 'no-key' || (info.tagsError && now >= info.tagsRetryAt))) {
      info.tagsBusy = true;
      void osuApi.userTags({ setId: map.setId, beatmapId: map.id, checksum: /^[0-9a-f]{32}$/.test(String(map.key)) ? map.key : '' })
        .then((r) => { info.tags = r.tags || []; info.tagsReason = r.reason || ''; info.tagsError = null; })
        .catch((error) => {
          info.tags = [];
          info.tagsReason = '';
          info.tagsError = { code: error?.code || 'osuapi.failed', error: String(error?.message ?? error).slice(0, 160), hint: error?.hint || '' };
          info.tagsRetryAt = d.now() + TAGS_RETRY_MS;
          log('[map-info] 查玩家标签失败：', info.tagsError.error);
        })
        .finally(() => { info.tagsBusy = false; });
    }
    // 从谱面看：读到了不再读；一时读不到（文件正被写）的过几秒再试
    if (!info.profile && !info.profileBusy && now >= info.profileRetryAt) {
      info.profileBusy = true;
      void readBeatmapText(map, { readFile: d.readFile, fetchText: d.fetchText, tosuUrl: config()?.watch?.url })
        .then((text) => {
          const parsed = parseOsu(text);
          if (!parsed) { info.error = '不是 osu! 标准模式的图'; info.profileRetryAt = Infinity; return; }
          // tosu 给了 AR（看不开 mod 的原值有没有）就照用算上 mod 的：EZ + HT 时能是负数，也照用（复核发现原来会退回谱面里的 AR，把难读算低）
          info.profile = mapProfile(parsed, { rate: map.rate, cs: map.cs > 0 ? map.cs : null, ar: map.arOriginal > 0 && Number.isFinite(Number(map.ar)) ? Number(map.ar) : null });
          info.profileText = profileText(info.profile);
          info.error = null;
        })
        .catch((error) => {
          info.error = String(error?.message ?? error).slice(0, 120);
          info.profileRetryAt = d.now() + PROFILE_RETRY_MS;
        })
        .finally(() => { info.profileBusy = false; });
    }
  }

  /** 每一帧：选到 / 打开一张图就准备（选歌界面要停一会儿才算选到）。 */
  function onFrame(snap, now = d.now()) {
    if (!snap) return;
    const map = snap.map || {};
    if (!map.key || !(snap.state === 'play' || snap.state === 'select' || snap.state === 'multi')) return;
    const key = keyOf(map);
    if (seen.key !== key) seen = { key, since: now };
    if (snap.state !== 'play' && now - seen.since < SETTLE_MS) return;
    prepare(map, now);
  }

  /** 开局点评用：这张图准备好了的部分。map 是事件里的 map（要有 key、rate、cs）。 */
  function get(map) {
    if (!map?.key) return null;
    const info = infos.get(keyOf(map));
    return info ? { tags: info.tags || [], profileText: info.profileText } : null;
  }

  /** 设置页：上一张图的情况。 */
  function status() {
    const info = infos.get(lastKey);
    return {
      apiReady: osuApi ? osuApi.ready?.() ?? null : null,
      last: info ? { title: info.title, version: info.version, tags: info.tags, tagsReason: info.tagsReason, tagsError: info.tagsError, profileText: info.profileText, error: info.error } : null,
    };
  }

  return { onFrame, get, status };
}

/** 给模型看的那一段：「玩家给这张图打的标签（osu! 官网投票，票多的在前）：…。从谱面看：…。」没有就空串。 */
export function mapInfoText(info) {
  if (!info) return '';
  const parts = [];
  // 标签用中文叫法（core/tag-names.js），念出来顺；表里没有的原样给
  if (info.tags?.length) parts.push(`玩家在 osu! 官网给这张图打的标签（票多的在前）：${info.tags.slice(0, 6).map((t) => tagNameZh(t.name)).join('、')}。`);
  if (info.profileText) parts.push(`从谱面看：${info.profileText}。`);
  return parts.join('');
}
