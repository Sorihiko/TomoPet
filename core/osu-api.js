/**
 * osu! 官网 API v2：查谱面的玩家标签（User Tags，比如 tech/aim control、skillset/alt、streams/flow aim）。
 *
 * 为什么（2026-11-21 用户：「能识别到 user tags 吗，这是玩家加的标签，可以直观的知道是张什么图」；三种取法里选了「只用官方接口」）。
 * 标签是玩家在官网上投票加的，不在本地的 .osu 里（.osu 的 Tags: 是作图者自己写的关键词，是另一回事）；不是每张图都有。
 *
 *   令牌：POST https://osu.ppy.sh/oauth/token  { client_id, client_secret, grant_type: 'client_credentials', scope: 'public' }
 *         → access_token（24 小时），存在内存里。用的是用户自己在官网建的 OAuth 应用，不用登录。
 *   标签：GET  https://osu.ppy.sh/api/v2/beatmapsets/{谱面集}  （Authorization: Bearer …）
 *         beatmaps[].top_tag_ids = [{ tag_id, count }]（每个难度单独投票），related_tags = [{ id, name, description }]
 *   照官网的规矩只要 5 票以上的，按票数从多到少（同票按名字）。按谱面集编号查，找 tosu 给的那个难度；
 *   本地改过的难度（checksum 和官网对不上）不用官网的标签。
 *
 * 官网 API 的条款：每分钟不超过 60 次、要缓存、不能当数据库批量抓。这里每换一张图最多查一次，查过的存在本机
 * （数据目录 osu-tags.json）：有结果的 7 天内不再查，官网上没有的（没上传 / 本地图）1 天内不再查。
 * 只发谱面集编号，不发用户的任何信息。
 *
 * 失败都抛 osuapi.*（{ code, error, hint }）。
 */
import { codedError, readJson, writeJsonAtomic } from './store.js';

export const OSU_SITE = 'https://osu.ppy.sh';
/** 官网显示标签的门槛（osu-web 的 tags_min_votes_display）。 */
export const MIN_TAG_VOTES = 5;
const KEEP_MS = 7 * 24 * 3600 * 1000;
const MISSING_KEEP_MS = 24 * 3600 * 1000;
const CACHE_MAX_SETS = 3000;
/** 每分钟最多请求几次（官网条款是 60，留点余量）：超了这一次就不问，算「忙」（复核发现选歌时快速滚图会超）。 */
const MAX_PER_MINUTE = 50;

/**
 * @param {object} opts
 * @param {() => {clientId?:string, clientSecret?:string}} opts.config   设置里的 osuApi 那一段（secret 已解密）
 * @param {string} [opts.cacheFile]   缓存文件（不给就只缓存在内存里）
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createOsuApi({ config, cacheFile = '', fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000, log = () => {} } = {}) {
  let token = null; // { value, until, who }
  let tokenJob = null; // 正在拿的令牌（同时查几个谱面集时共用这一次，复核发现会重复拿）
  const sentAt = []; // 最近一分钟发出去的请求时间
  let cache = null; // { sets: { [setId]: { at, missing?, beatmaps: { [id]: { checksum, tags } } } } }
  const inflight = new Map();

  function ready() {
    const cfg = config() || {};
    if (!cfg.clientId || !cfg.clientSecret) {
      return { ok: false, code: 'osuapi.no-key', error: '还没填 osu! 官网的 OAuth 应用', hint: 'osu! 官网 → 右上角头像 → 设置 → OAuth → 新的 OAuth 应用（名字随便填，回调地址随便填，比如 http://localhost），把 Client ID 和 Client Secret 填进设置「高级」。' };
    }
    return { ok: true };
  }

  function loadCache() {
    if (cache) return cache;
    const raw = cacheFile ? readJson(cacheFile, null) : null;
    // 文件坏了（不是对象、sets 是数组之类）就当没有：sets 是数组时按谱面集编号写进去会撑出几十 MB 的文件（复核发现）
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.sets && typeof raw.sets === 'object' && !Array.isArray(raw.sets) ? raw : { sets: {} };
    return cache;
  }
  function saveCache() {
    if (!cacheFile || !cache) return;
    const ids = Object.keys(cache.sets);
    if (ids.length > CACHE_MAX_SETS) {
      ids.sort((a, b) => (cache.sets[a].at || 0) - (cache.sets[b].at || 0));
      for (const id of ids.slice(0, ids.length - CACHE_MAX_SETS)) delete cache.sets[id];
    }
    try { writeJsonAtomic(cacheFile, cache); } catch (error) { log('[osu-api] 存缓存失败：', String(error?.message ?? error).slice(0, 120)); }
  }

  async function request(url, init) {
    const t = now();
    while (sentAt.length && t - sentAt[0] >= 60_000) sentAt.shift();
    if (sentAt.length >= MAX_PER_MINUTE) throw codedError('osuapi.busy', '这一分钟问 osu! 官网问得太多了', '过一会儿再试；选歌时别滚太快。');
    sentAt.push(t);
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw codedError('osuapi.timeout', `osu! 官网 ${timeoutMs / 1000} 秒没回`, '网络慢时会这样，换张图会再试。');
      throw codedError('osuapi.network', `连不上 osu! 官网：${String(error?.message ?? error).slice(0, 120)}`, '检查网络；连不上时只是这张图没有玩家标签，别的照常。');
    }
  }

  /** 拿令牌（24 小时，提前一分钟换）。client ID / secret 换了就重新拿；同时要的共用一次请求。 */
  async function accessToken() {
    const r = ready();
    if (!r.ok) throw codedError(r.code, r.error, r.hint);
    const cfg = config();
    const who = `${cfg.clientId}:${cfg.clientSecret}`;
    if (token && token.who === who && now() < token.until) return token.value;
    if (tokenJob && tokenJob.who === who) return tokenJob.promise;
    const job = { who, promise: fetchToken(cfg, who).finally(() => { if (tokenJob === job) tokenJob = null; }) };
    tokenJob = job;
    return job.promise;
  }

  async function fetchToken(cfg, who) {
    const res = await request(`${OSU_SITE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: Number(cfg.clientId) || cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'client_credentials', scope: 'public' }),
    });
    if (res.status === 400 || res.status === 401) throw codedError('osuapi.auth', `osu! 官网不认这个 Client ID / Secret（HTTP ${res.status}）`, '回 osu! 官网 → 设置 → OAuth 看一下，Client ID 是一串数字，Secret 要点「显示客户端密钥」再复制全。');
    if (!res.ok) throw codedError('osuapi.http', `osu! 官网拿令牌时返回 HTTP ${res.status}`, '过一会儿再试。');
    let body = null;
    try { body = await res.json(); } catch {}
    if (!body?.access_token) throw codedError('osuapi.http', 'osu! 官网没给令牌', '过一会儿再试。');
    token = { value: String(body.access_token), until: now() + Math.max(60, Number(body.expires_in) || 86400) * 1000 - 60_000, who };
    return token.value;
  }

  /** 官网的一个谱面集 → 我们存的样子：每个难度的 checksum 和 5 票以上的标签（按票数排好）。 */
  function digest(json) {
    const names = new Map();
    for (const t of Array.isArray(json?.related_tags) ? json.related_tags : []) {
      if (t && Number.isFinite(Number(t.id)) && typeof t.name === 'string') names.set(Number(t.id), String(t.name).slice(0, 60));
    }
    const beatmaps = {};
    for (const b of Array.isArray(json?.beatmaps) ? json.beatmaps : []) {
      if (!b || !Number.isFinite(Number(b.id))) continue;
      const tags = (Array.isArray(b.top_tag_ids) ? b.top_tag_ids : [])
        .map((x) => ({ name: names.get(Number(x?.tag_id)), count: Math.round(Number(x?.count) || 0) }))
        .filter((x) => x.name && x.count >= MIN_TAG_VOTES)
        .sort((a, b2) => b2.count - a.count || a.name.localeCompare(b2.name))
        .slice(0, 12);
      beatmaps[String(b.id)] = { checksum: typeof b.checksum === 'string' ? b.checksum.toLowerCase() : '', tags };
    }
    return beatmaps;
  }

  async function fetchSet(setId) {
    const value = await accessToken();
    const res = await request(`${OSU_SITE}/api/v2/beatmapsets/${setId}`, { headers: { authorization: `Bearer ${value}`, accept: 'application/json' } });
    if (res.status === 404) return null; // 官网上没有（没上传 / 删了）
    if (res.status === 401) { token = null; throw codedError('osuapi.auth', 'osu! 官网说令牌不对（HTTP 401）', '回 osu! 官网 → 设置 → OAuth 检查 Client ID / Secret。'); }
    if (res.status === 429) throw codedError('osuapi.busy', 'osu! 官网说请求太多了（HTTP 429）', '过一会儿再试；换图别太快。');
    if (!res.ok) throw codedError('osuapi.http', `osu! 官网返回 HTTP ${res.status}`, '过一会儿再试。');
    try { return digest(await res.json()); } catch { throw codedError('osuapi.http', 'osu! 官网回的东西看不懂', '过一会儿再试。'); }
  }

  /**
   * 一个难度的玩家标签。map：{ setId, beatmapId, checksum }（tosu 给的）。
   * 返回 { tags: [{ name, count }], cached, reason? }；reason：'no-set'（本地图、没有谱面集编号）/ 'not-on-site' / 'edited'（本地改过）/ 'no-tags'。
   */
  async function userTags({ setId, beatmapId, checksum = '' } = {}) {
    const set = Math.trunc(Number(setId));
    const id = String(Math.trunc(Number(beatmapId)));
    if (!(set > 0) || !(Number(id) > 0)) return { tags: [], cached: true, reason: 'no-set' };
    const c = loadCache();
    let entry = c.sets[set];
    let cached = true;
    const fresh = entry && now() - (entry.at || 0) < (entry.missing ? MISSING_KEEP_MS : KEEP_MS);
    if (!fresh) {
      cached = false;
      if (!inflight.has(set)) inflight.set(set, fetchSet(set).finally(() => inflight.delete(set)));
      const beatmaps = await inflight.get(set);
      entry = beatmaps ? { at: now(), beatmaps } : { at: now(), missing: true, beatmaps: {} };
      c.sets[set] = entry;
      saveCache();
    }
    if (entry.missing) return { tags: [], cached, reason: 'not-on-site' };
    const b = entry.beatmaps?.[id];
    if (!b) return { tags: [], cached, reason: 'not-on-site' };
    if (checksum && b.checksum && String(checksum).toLowerCase() !== b.checksum) return { tags: [], cached, reason: 'edited' };
    return { tags: b.tags || [], cached, reason: b.tags?.length ? undefined : 'no-tags' };
  }

  /** 设置里的「试一下」：拿一次令牌。 */
  async function test() {
    token = null;
    tokenJob = null;
    await accessToken();
    return { ok: true };
  }

  return { ready, userTags, test };
}
