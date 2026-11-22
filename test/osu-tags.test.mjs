/**
 * 玩家标签（2026-11-21）：core/osu-api.js 查 osu! 官网、core/map-info.js 选图时准备「这是张什么图」、
 * core/patterns.js mapProfile / profileText 从谱面看。不连真的官网：fetch 换成假的。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tomopet-tags-'));
process.env.OSU_PET_HOME = path.join(sandbox, '数据');
const { createOsuApi, MIN_TAG_VOTES, OSU_SITE } = await import('../core/osu-api.js');
const { createMapInfo, mapInfoText } = await import('../core/map-info.js');
const { mapProfile, profileText, parseOsu } = await import('../core/patterns.js');
const expectCode = async (promise, code) => { await assert.rejects(promise, (e) => { assert.equal(e.code, code, e.message); assert.ok(e.message && e.hint, `${code} 要带 error 和 hint`); return true; }); };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// 官网 /api/v2/beatmapsets/{id} 的样子（只留用得到的）
const SET = {
  id: 2104327,
  beatmaps: [
    { id: 4415495, checksum: 'AAAABBBBCCCCDDDDEEEEFFFF00001111', top_tag_ids: [{ tag_id: 19, count: 20 }, { tag_id: 53, count: 18 }, { tag_id: 2, count: 9 }, { tag_id: 20, count: 9 }, { tag_id: 71, count: 3 }] },
    { id: 4415496, checksum: 'ffffeeeeddddccccbbbbaaaa99998888', top_tag_ids: [] },
  ],
  related_tags: [
    { id: 19, name: 'skillset/jumps', ruleset_id: 0, description: 'Focuses heavily on jumps' },
    { id: 53, name: 'expression/difficulty spike', ruleset_id: null },
    { id: 2, name: 'tech/aim control', ruleset_id: 0 },
    { id: 20, name: 'skillset/alt', ruleset_id: 0 },
    { id: 71, name: 'streams/flow aim', ruleset_id: 0 },
  ],
};

{
  const cfg = { clientId: '', clientSecret: '' };
  let clock = 1_800_000_000_000;
  const sent = [];
  let reply = (url) => (String(url).endsWith('/oauth/token') ? json(200, { access_token: 'TOKEN_1', expires_in: 86400, token_type: 'Bearer' }) : json(200, SET));
  const cacheFile = path.join(sandbox, 'osu-tags.json');
  const make = () => createOsuApi({ config: () => cfg, cacheFile, now: () => clock, fetchImpl: async (url, init) => { sent.push({ url: String(url), init }); return reply(url, init); } });
  let api = make();
  // 没填：不查，说清楚去哪建
  assert.equal(api.ready().code, 'osuapi.no-key');
  assert.ok(api.ready().hint.includes('OAuth'));
  await expectCode(api.test(), 'osuapi.no-key');
  cfg.clientId = '12345';
  cfg.clientSecret = 'SECRET_X';
  assert.equal(api.ready().ok, true);

  // 查一个难度：令牌 → 谱面集；只要 5 票以上、按票数排（同票按名字）
  const r = await api.userTags({ setId: 2104327, beatmapId: 4415495, checksum: 'aaaabbbbccccddddeeeeffff00001111' });
  assert.deepEqual(r.tags, [{ name: 'skillset/jumps', count: 20 }, { name: 'expression/difficulty spike', count: 18 }, { name: 'skillset/alt', count: 9 }, { name: 'tech/aim control', count: 9 }]);
  assert.equal(r.cached, false);
  assert.ok(!r.tags.some((t) => t.count < MIN_TAG_VOTES));
  assert.equal(sent[0].url, `${OSU_SITE}/oauth/token`);
  assert.deepEqual(JSON.parse(sent[0].init.body), { client_id: 12345, client_secret: 'SECRET_X', grant_type: 'client_credentials', scope: 'public' });
  assert.equal(sent[1].url, `${OSU_SITE}/api/v2/beatmapsets/2104327`);
  assert.equal(sent[1].init.headers.authorization, 'Bearer TOKEN_1');
  assert.ok(!JSON.stringify(sent).includes('osu-pet') && !sent.some((s) => /user|me\b/.test(s.url)), '只发谱面集编号');
  // 同一个谱面集的另一个难度：用缓存，不再请求；没人打够 5 票
  const other = await api.userTags({ setId: 2104327, beatmapId: 4415496 });
  assert.deepEqual([other.tags, other.reason, other.cached, sent.length], [[], 'no-tags', true, 2]);
  // 本地改过（checksum 对不上）：不用官网的标签
  assert.equal((await api.userTags({ setId: 2104327, beatmapId: 4415495, checksum: '0'.repeat(32) })).reason, 'edited');
  // 本地图（没有谱面集编号）：不查
  assert.deepEqual(await api.userTags({ setId: 0, beatmapId: 0 }), { tags: [], cached: true, reason: 'no-set' });
  // 缓存存在本机：重开程序也不用再查；7 天后再查一次
  api = make();
  assert.equal((await api.userTags({ setId: 2104327, beatmapId: 4415495 })).cached, true);
  assert.equal(sent.length, 2);
  clock += 8 * 24 * 3600 * 1000;
  assert.equal((await api.userTags({ setId: 2104327, beatmapId: 4415495 })).cached, false);
  assert.equal(sent.length, 4, '过期了：重新拿令牌（新实例）再查');
  // 令牌 24 小时内复用；换了 secret 重新拿
  reply = (url) => (String(url).endsWith('/oauth/token') ? json(200, { access_token: 'TOKEN_2', expires_in: 86400 }) : json(200, { ...SET, id: 1 }));
  await api.userTags({ setId: 1, beatmapId: 4415495 });
  assert.equal(sent.at(-1).init.headers.authorization, 'Bearer TOKEN_1', '令牌复用');
  cfg.clientSecret = 'SECRET_Y';
  await api.userTags({ setId: 2, beatmapId: 4415495 });
  assert.equal(sent.at(-1).init.headers.authorization, 'Bearer TOKEN_2', '换了 secret 重新拿');

  // 官网上没有（404）：记 1 天，这一天里不再问
  reply = (url) => (String(url).endsWith('/oauth/token') ? json(200, { access_token: 'T', expires_in: 86400 }) : json(404, { error: null }));
  const before = sent.length;
  assert.equal((await api.userTags({ setId: 99, beatmapId: 5 })).reason, 'not-on-site');
  assert.equal((await api.userTags({ setId: 99, beatmapId: 5 })).reason, 'not-on-site');
  assert.equal(sent.length, before + 1);
  clock += 25 * 3600 * 1000;
  await api.userTags({ setId: 99, beatmapId: 5 });
  assert.equal(sent.length > before + 1, true, '过了一天再问');

  // 同一个谱面集同时问两次：只请求一次
  reply = (url) => (String(url).endsWith('/oauth/token') ? json(200, { access_token: 'T', expires_in: 86400 }) : json(200, { ...SET, id: 7 }));
  const n = sent.length;
  await Promise.all([api.userTags({ setId: 7, beatmapId: 4415495 }), api.userTags({ setId: 7, beatmapId: 4415495 })]);
  assert.equal(sent.filter((s, i) => i >= n && s.url.includes('/beatmapsets/7')).length, 1);

  // 报错 → 中文的 osuapi.*
  const fresh = (status) => createOsuApi({ config: () => cfg, now: () => clock, fetchImpl: async (url) => (String(url).endsWith('/oauth/token') ? (status === 'auth' ? json(401, {}) : json(200, { access_token: 'T', expires_in: 86400 })) : json(status, {})) });
  await expectCode(fresh('auth').test(), 'osuapi.auth');
  await expectCode(fresh(429).userTags({ setId: 1, beatmapId: 1 }), 'osuapi.busy');
  await expectCode(fresh(500).userTags({ setId: 1, beatmapId: 1 }), 'osuapi.http');
  await expectCode(fresh(401).userTags({ setId: 1, beatmapId: 1 }), 'osuapi.auth');
  await expectCode(createOsuApi({ config: () => cfg, fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } }).test(), 'osuapi.timeout');
  await expectCode(createOsuApi({ config: () => cfg, fetchImpl: async () => { throw new Error('ENOTFOUND osu.ppy.sh'); } }).test(), 'osuapi.network');
  assert.equal((await fresh(200).test()).ok, true);
}

// ── 从谱面看 ─────────────────────────────────────────────────────────────────
const BEAT = 60000 / 180;
const R = 54.4 - 4.48 * 4;
function mapText({ stream = true, jumps = true } = {}) {
  const objs = [];
  for (let t = 1000; t < 9000; t += BEAT) objs.push(`${256 + (objs.length % 2) * 40},192,${Math.round(t)},1,0`);
  if (stream) for (let i = 0; i < 40; i += 1) objs.push(`${200 + (i % 4) * 15},200,${Math.round(10000 + i * BEAT / 4)},1,0`);
  for (let t = 15000; t < 20000; t += BEAT) objs.push(`${256 + (objs.length % 2) * 40},192,${Math.round(t)},1,0`);
  if (jumps) for (let i = 0; i < 14; i += 1) objs.push(`${i % 2 ? 470 : 50},192,${Math.round(21000 + i * BEAT / 2)},1,0`);
  for (let t = 24000; t < 40000; t += BEAT) objs.push(`${256 + (objs.length % 2) * 40},192,${Math.round(t)},1,0`);
  return ['[General]', 'Mode: 0', '[Difficulty]', 'CircleSize:4', 'SliderMultiplier:1.4', '[TimingPoints]', `0,${BEAT},4,2,0,60,1,0`, '[HitObjects]', ...objs].join('\n');
}
{
  const p = mapProfile(parseOsu(mapText()));
  assert.deepEqual([p.streams, p.longStreams, p.jumps], [1, 1, 1]);
  const text = profileText(p);
  assert.ok(text.includes('串 1 段') && text.includes('1 段长串') && text.includes('大跳 1 段'), text);
  assert.equal(profileText(mapProfile(parseOsu(mapText({ stream: false, jumps: false })))), '没有明显的长串和大跳');
  assert.equal(profileText(null), '');
  assert.deepEqual(mapProfile(null).streams, 0);
}

// ── 滑条变速、难读（2026-11-21） ───────────────────────────────────────────────
{
  const { sliderSpeedChanges, overlapShare, preemptMs, SLIDER_SPEED_MANY, OVERLAP_MANY } = await import('../core/patterns.js');
  // AR 公式：AR5 = 1200ms，AR10 = 450ms，AR0 = 1800ms
  assert.deepEqual([preemptMs(5), preemptMs(10), preemptMs(0)], [1200, 450, 1800]);
  // 滑条速度：绿线一会儿 1 倍一会儿 2 倍 → 每次换都算变速；同速的不算
  const sliderMap = (svs) => {
    const timing = [`0,${BEAT},4,2,0,60,1,0`];
    const objs = [];
    svs.forEach((sv, i) => {
      const t = 1000 + i * BEAT * 2;
      timing.push(`${t - 10},${-100 / sv},4,2,0,60,0,0`);
      objs.push(`100,192,${Math.round(t)},2,0,L|200:192,1,70`);
    });
    return parseOsu(['[General]', 'Mode: 0', '[Difficulty]', 'CircleSize:4', 'SliderMultiplier:1.4', '[TimingPoints]', ...timing, '[HitObjects]', ...objs].join('\n'));
  };
  const alt = sliderSpeedChanges(sliderMap(Array.from({ length: 40 }, (_, i) => (i % 2 ? 2 : 1))).objects);
  assert.deepEqual([alt.sliders, alt.changes, alt.rate], [40, 39, 1]);
  const same = sliderSpeedChanges(sliderMap(Array(40).fill(1)).objects);
  assert.deepEqual([same.changes, same.rate], [0, 0]);
  assert.ok(sliderSpeedChanges(sliderMap(Array.from({ length: 40 }, (_, i) => (i % 2 ? 1.1 : 1))).objects).changes === 0, '差 10% 不算');
  assert.ok(profileText(mapProfile(sliderMap(Array.from({ length: 40 }, (_, i) => (i % 2 ? 2 : 1))))).includes('滑条变速多'), '变得多：说出来');
  assert.ok(!profileText(mapProfile(sliderMap(Array(40).fill(1)))).includes('滑条变速'));
  assert.ok(SLIDER_SPEED_MANY > 0 && OVERLAP_MANY > 0);
  // 难读：一条串绕一圈回来压住自己（同屏时）→ 算；叠在原地的长串 → 不算（全库校准时长串练习图全排在最前）
  const circleBack = (ar, pointsPerLap) => {
    const objs = [];
    for (let i = 0; i < 120; i += 1) { const a = (i / pointsPerLap) * 2 * Math.PI; objs.push({ t: 1000 + i * 80, end: 1000 + i * 80, x: 256 + 120 * Math.cos(a), y: 192 + 120 * Math.sin(a), kind: 'circle' }); }
    return overlapShare(objs, { radius: R, windowMs: preemptMs(ar) });
  };
  // 一圈 6 个、0.48 秒就绕回来（AR9 一个圈在屏幕上停 0.6 秒）：压住还没消失的自己
  assert.ok(circleBack(9, 6) > 0.8, `绕回来压住自己：${circleBack(9, 6)}`);
  assert.equal(circleBack(9, 12), 0, '一圈 0.96 秒：AR9 下前面那圈已经消失了');
  assert.equal(circleBack(9, 40), 0, '一圈 40 个（3.2 秒）才绕回来：前面的早消失了');
  assert.ok(circleBack(0, 20) > circleBack(10, 20), 'AR 越低同屏越久，越难读');
  const stacked = Array.from({ length: 120 }, (_, i) => ({ t: 1000 + i * 80, end: 1000 + i * 80, x: 256 + (i % 2) * 2, y: 192, kind: 'circle' }));
  assert.equal(overlapShare(stacked, { radius: R, windowMs: preemptMs(9) }), 0, '叠在原地不算难读');
  assert.equal(overlapShare([], { radius: R }), 0);
  // EZ + HT 时 tosu 给的 AR 能是负数：照用（同屏更久），不退回谱面里的 AR（复核发现）
  const lowAr = parseOsu(mapText().replace('CircleSize:4', 'CircleSize:4\nApproachRate:9'));
  assert.ok(preemptMs(-2) > preemptMs(9));
  assert.ok(mapProfile(lowAr, { ar: -2 }).overlap >= mapProfile(lowAr, { ar: null }).overlap);
}

// ── 选图时准备「这是张什么图」 ──────────────────────────────────────────────────
{
  const text = mapText();
  const key = createHash('md5').update(text).digest('hex');
  const tick = () => new Promise((r) => setTimeout(r, 20));
  let clock = 1_000_000;
  // 选歌界面要在同一张图上停 1 秒才算选到：先喂一帧、过 1.1 秒再喂一帧
  const settle = async (mi, snap) => { mi.onFrame(snap, clock); clock += 1100; mi.onFrame(snap, clock); await tick(); };
  const asked = [];
  const osuApi = { ready: () => ({ ok: true }), userTags: async (q) => { asked.push(q); return { tags: [{ name: 'skillset/jumps', count: 20 }], cached: false }; } };
  const make = (api, readFile = () => Buffer.from(text)) => createMapInfo({ config: () => ({ watch: {} }), osuApi: api, deps: { now: () => clock, readFile, fetchText: async () => { throw new Error('tosu 没开'); } } });
  const snap = { state: 'select', map: { key, title: 'T', version: 'V', id: 4415495, setId: 2104327, rate: 1, cs: 4, songsDir: 'S', file: 'f.osu' } };
  const info = make(osuApi);
  assert.equal(info.get(snap.map), null, '还没选过');
  await settle(info, snap);
  for (let i = 0; i < 30; i += 1) { clock += 150; info.onFrame(snap, clock); } // 一直停在这张图：不重复查
  await tick();
  assert.deepEqual(asked, [{ setId: 2104327, beatmapId: 4415495, checksum: key }]);
  const got = info.get({ key, rate: 1, cs: 4 });
  assert.deepEqual(got.tags, [{ name: 'skillset/jumps', count: 20 }]);
  assert.ok(got.profileText.includes('大跳 1 段'), got.profileText);
  assert.ok(mapInfoText(got).startsWith('玩家在 osu! 官网给这张图打的标签（票多的在前）：跳图。从谱面看：'), mapInfoText(got));
  assert.equal(info.status().last.tags.length, 1);
  assert.equal(info.get({ key, rate: 1.5, cs: 4 }), null, '开了 DT 是另一份（谱面分析按倍速算）');
  assert.equal(info.get({ key, rate: 1, cs: 5.2 }), null, '开了 HR（CS 变了）也是另一份（复核发现）');
  assert.equal(mapInfoText(null), '');
  assert.equal(mapInfoText({ tags: [], profileText: '' }), '');

  // 选歌时快速滚图（每张停不到 1 秒）：一张都不查；开打马上查（复核发现原来每张都查，超过官网每分钟 60 次）
  const scrolled = [];
  const scroller = make({ ready: () => ({ ok: true }), userTags: async (q) => { scrolled.push(q); return { tags: [] }; } });
  for (let i = 0; i < 40; i += 1) { clock += 120; scroller.onFrame({ state: 'select', map: { ...snap.map, key: `${i}`.padStart(32, 'a'), setId: 1000 + i } }, clock); }
  await tick();
  assert.equal(scrolled.length, 0, '滚过去的不查');
  scroller.onFrame({ state: 'play', map: { ...snap.map, key: 'f'.repeat(32), setId: 5 } }, clock);
  await tick();
  assert.equal(scrolled.length, 1, '开打马上查');

  // 没填 OAuth 应用：不查标签，只从谱面看
  const asked2 = [];
  const noKey = make({ ready: () => ({ ok: false, code: 'osuapi.no-key' }), userTags: async (q) => { asked2.push(q); return { tags: [] }; } });
  await settle(noKey, snap);
  assert.equal(asked2.length, 0);
  assert.deepEqual([noKey.status().last.tagsReason, noKey.get({ key, rate: 1, cs: 4 }).tags], ['no-key', []]);
  assert.ok(noKey.get({ key, rate: 1, cs: 4 }).profileText.includes('串'));

  // 查标签失败：记下错误，谱面分析照常；1 分钟内不再问（复核发现读谱也失败时原来每一帧都去问官网）
  let failCalls = 0;
  const failing = make({ ready: () => ({ ok: true }), userTags: async () => { failCalls += 1; throw Object.assign(new Error('连不上 osu! 官网'), { code: 'osuapi.network', hint: '检查网络' }); } }, () => { throw new Error('EBUSY'); });
  await settle(failing, snap);
  for (let i = 0; i < 100; i += 1) { clock += 150; failing.onFrame(snap, clock); await Promise.resolve(); }
  await tick();
  assert.equal(failCalls, 1, '15 秒里只问了一次');
  assert.equal(failing.status().last.tagsError.code, 'osuapi.network', '设置页看得到出了什么错');
  clock += 60_000;
  failing.onFrame(snap, clock);
  await tick();
  assert.equal(failCalls, 2, '过了一分钟再试');

  // 读不到谱面（文件正被写）：过几秒再读；标签不跟着重查
  let reads = 0;
  const tagCalls = [];
  const flaky = make({ ready: () => ({ ok: true }), userTags: async (q) => { tagCalls.push(q); return { tags: [] }; } }, () => { reads += 1; if (reads === 1) throw new Error('EBUSY'); return Buffer.from(text); });
  await settle(flaky, snap);
  assert.equal(flaky.get({ key, rate: 1, cs: 4 }).profileText, '');
  clock += 1000; flaky.onFrame(snap, clock); await tick();
  assert.equal(reads, 1, '5 秒内不重读');
  clock += 5000; flaky.onFrame(snap, clock); await tick();
  assert.ok(flaky.get({ key, rate: 1, cs: 4 }).profileText.includes('串'), '过几秒读到了');
  assert.equal(tagCalls.length, 1, '标签不跟着重查');
  // 菜单 / 结算界面不准备
  const idle = make(osuApi);
  idle.onFrame({ state: 'menu', map: snap.map }, clock);
  assert.equal(idle.status().last, null);
}

// ── 官网那边：限速、令牌共用、缓存文件坏了 ─────────────────────────────────────
{
  const cfg = { clientId: '1', clientSecret: 'S' };
  let clock = 2_000_000_000_000;
  const sent = [];
  const api = createOsuApi({ config: () => cfg, now: () => clock, fetchImpl: async (url) => { sent.push(String(url)); await new Promise((r) => setTimeout(r, 5)); return String(url).endsWith('/oauth/token') ? json(200, { access_token: 'T', expires_in: 86400 }) : json(200, { beatmaps: [], related_tags: [] }); } });
  // 同时查几个谱面集：令牌只拿一次（复核发现会重复拿）
  await Promise.all([1, 2, 3].map((n) => api.userTags({ setId: n, beatmapId: 1 })));
  assert.equal(sent.filter((u) => u.endsWith('/oauth/token')).length, 1);
  // 一分钟最多 50 次：再多就算「忙」，不发请求
  for (let n = 10; sent.length < 50; n += 1) await api.userTags({ setId: n, beatmapId: 1 });
  await expectCode(api.userTags({ setId: 999, beatmapId: 1 }), 'osuapi.busy');
  assert.equal(sent.length, 50);
  clock += 61_000;
  await api.userTags({ setId: 999, beatmapId: 1 });
  assert.equal(sent.length, 51, '过了一分钟又能问了');
  // 缓存文件坏了（sets 是数组）：当没有，不会撑出几十 MB 的文件
  const bad = path.join(sandbox, 'bad-tags.json');
  fs.writeFileSync(bad, JSON.stringify({ sets: [] }));
  const api2 = createOsuApi({ config: () => cfg, cacheFile: bad, now: () => clock, fetchImpl: async (url) => (String(url).endsWith('/oauth/token') ? json(200, { access_token: 'T', expires_in: 86400 }) : json(200, SET)) });
  assert.equal((await api2.userTags({ setId: 2104327, beatmapId: 4415495 })).tags.length, 4);
  assert.ok(fs.statSync(bad).size < 10_000, `缓存文件 ${fs.statSync(bad).size} 字节`);
  fs.writeFileSync(bad, '[1,2,3]');
  assert.equal((await createOsuApi({ config: () => cfg, cacheFile: bad, now: () => clock, fetchImpl: async (url) => (String(url).endsWith('/oauth/token') ? json(200, { access_token: 'T', expires_in: 86400 }) : json(200, SET)) }).userTags({ setId: 2104327, beatmapId: 4415495 })).tags.length, 4);
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('osu-tags: ok');
