/**
 * Breeze 云端语音合成（core/tts-breeze.js）和按设置切换火山 / Breeze（core/tts.js），2026-11-21。
 * 不连真的 Breeze：fetch 换成假的，看发出去的请求、缓存、报错。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-breeze-'));
process.env.OSU_PET_HOME = path.join(sandbox, '数据');
const { createBreezeTts, BREEZE_API } = await import('../core/tts-breeze.js');
const { createTts } = await import('../core/tts.js');
const { pcmToWav } = await import('../core/speakable.js');
const { createConfigStore, plainSecretBox } = await import('../core/config.js');
const expectCode = async (promise, code) => { await assert.rejects(promise, (e) => { assert.equal(e.code, code, e.message); assert.ok(e.message && e.hint, `${code} 要带 error 和 hint`); return true; }); };

const wav = pcmToWav(Buffer.alloc(24000 * 2, 3), 24000); // 1 秒
const okReply = () => new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } });
const errReply = (status, code) => new Response(JSON.stringify({ ok: false, code, detail: `DETAIL_${code}`, error: `DETAIL_${code}` }), { status, headers: { 'content-type': 'application/json' } });

// ── 合成 ─────────────────────────────────────────────────────────────────────
{
  const cfg = { provider: 'breeze', breezeKey: '', breezeVoice: '', breezeInstructions: '', speed: 1 };
  const sent = [];
  let reply = okReply;
  const tts = createBreezeTts({ config: () => cfg, cacheDir: path.join(sandbox, 'cache'), fetchImpl: async (url, init) => { sent.push({ url, init }); return reply(); }, now: () => 1_800_000_000_000 });
  assert.equal(tts.ready().code, 'tts.no-key');
  assert.ok(tts.ready().hint.includes('breezeblue.ai'));
  cfg.breezeKey = 'brz_TEST';
  assert.equal(tts.ready().code, 'tts.no-speaker');
  cfg.breezeVoice = 'voc_abc123';
  assert.equal(tts.ready().ok, true);

  const out = await tts.synthesize('还差 4.8 星');
  assert.deepEqual([out.cached, out.durationMs, out.bytes.toString('ascii', 0, 4)], [false, 1000, 'RIFF']);
  assert.equal(sent[0].url, `${BREEZE_API}/text-to-speech/voc_abc123?output_format=wav_24000`);
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.headers['xi-api-key'], 'brz_TEST');
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body, { text: '还差 4点八 星', language_code: 'zh', voice_settings: { speed: 1 } }, '数字换读法；「还」不换（那是火山的补丁）');
  // 同一句：用缓存，不花额度
  const again = await tts.synthesize('还差 4.8 星');
  assert.deepEqual([again.cached, sent.length], [true, 1]);
  // 换音色、加语气说明：不用旧缓存；语气说明配 guidance_scale 4
  cfg.breezeInstructions = '活泼的少女，语气俏皮';
  cfg.speed = 1.3;
  await tts.synthesize('还差 4.8 星');
  assert.equal(sent.length, 2);
  assert.deepEqual(JSON.parse(sent[1].init.body).voice_settings, { speed: 1.3, guidance_scale: 4 });
  assert.equal(JSON.parse(sent[1].init.body).instructions, '活泼的少女，语气俏皮');

  // 报错 → 中文的 tts.*
  for (const [status, code, want] of [[401, 'AUTH_REQUIRED', 'tts.auth'], [402, 'BILLING_INSUFFICIENT_CREDITS', 'tts.quota'], [402, 'API_KEY_CREDIT_LIMIT_EXCEEDED', 'tts.quota'], [404, 'RESOURCE_NOT_FOUND', 'tts.no-speaker'], [403, 'FORBIDDEN', 'tts.forbidden'], [422, 'VALIDATION_ERROR', 'tts.http'], [429, 'GENERATION_CONCURRENCY_EXCEEDED', 'tts.busy'], [503, 'GENERATION_CAPACITY_EXCEEDED', 'tts.busy'], [500, 'INTERNAL_ERROR', 'tts.http']]) {
    reply = () => errReply(status, code);
    await expectCode(tts.synthesize(`第${status}${code}句`), want);
  }
  reply = () => new Response('not audio', { status: 200 });
  await expectCode(tts.synthesize('不是音频'), 'tts.empty');
  const timeoutTts = createBreezeTts({ config: () => cfg, cacheDir: path.join(sandbox, 'cache'), fetchImpl: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); } });
  await expectCode(timeoutTts.synthesize('超时那句'), 'tts.timeout');
  const offline = createBreezeTts({ config: () => cfg, cacheDir: path.join(sandbox, 'cache'), fetchImpl: async () => { throw new Error('ENOTFOUND api.breeze.blue'); } });
  await expectCode(offline.synthesize('断网那句'), 'tts.network');
  await expectCode(createBreezeTts({ config: () => ({}), cacheDir: sandbox }).synthesize('x'), 'tts.no-key');

  // 官方中文音色
  reply = () => new Response(JSON.stringify({ voices: [
    { voice_id: 'voc_1', name: '小晴', gender: 'female', age: 'young', tone: ['bright', 'playful'], description: '清亮少女' },
    { voice_id: 'bad id!', name: 'X' },
    { voice_id: 'voc_2', name: '阿哲', gender: 'male', tone: [] },
  ], has_more: false, total: 3, page: 1, page_size: 100 }), { status: 200 });
  const voices = await tts.listVoices();
  assert.deepEqual(voices.map((v) => v.id), ['voc_1', 'voc_2'], '不合格的 id 不要');
  assert.deepEqual(voices[0], { id: 'voc_1', name: '小晴', gender: 'female', age: 'young', tone: ['bright', 'playful'], description: '清亮少女' });
  assert.ok(sent.at(-1).url.startsWith(`${BREEZE_API}/voices?voice_type=default&language_code=zh&accent_mode=unmarked`));
  reply = () => errReply(401, 'AUTH_REQUIRED');
  await expectCode(tts.listVoices(), 'tts.auth');
  await expectCode(createBreezeTts({ config: () => ({}), cacheDir: sandbox }).listVoices(), 'tts.no-key');
}

// ── 切换：按设置里的 provider 转到哪一家 ───────────────────────────────────────
{
  const cfg = { provider: 'volc', appId: '', accessKey: '', speaker: '', breezeKey: 'brz_X', breezeVoice: 'voc_9', speed: 1 };
  const urls = [];
  const tts = createTts({ config: () => cfg, cacheDir: path.join(sandbox, 'cache2'), fetchImpl: async (url) => { urls.push(String(url)); return okReply(); } });
  assert.equal(tts.provider(), 'volc');
  assert.equal(tts.ready().code, 'tts.no-key', '火山没填 Key');
  await expectCode(tts.listVoices(), 'tts.no-voice-list');
  cfg.provider = 'breeze';
  assert.equal(tts.provider(), 'breeze');
  assert.equal(tts.ready().ok, true, '切到 Breeze 马上生效');
  await tts.synthesize('切过来了');
  assert.ok(urls[0].startsWith(BREEZE_API));
  cfg.provider = 'nope';
  assert.equal(tts.provider(), 'volc', '不认识的退回火山');
}

// ── 设置：provider 两个值，Breeze 的 Key 加密存、界面上只显示有没有 ─────────────────
{
  const box = { available: true, seal: (v) => ({ sealed: `S:${v}` }), open: (v) => (v && typeof v === 'object' ? String(v.sealed).slice(2) : plainSecretBox.open(v)) };
  const store = createConfigStore({ secretBox: box });
  store.save({ tts: { provider: 'breeze', breezeKey: '  brz_SECRET  ', breezeVoice: 'voc_ok', breezeInstructions: '温柔一点' } });
  assert.deepEqual([store.get().tts.provider, store.get().tts.breezeKey, store.get().tts.breezeVoice], ['breeze', 'brz_SECRET', 'voc_ok']);
  const view = store.publicView();
  assert.deepEqual([view.tts.breezeKey, view.tts.hasBreezeKey], [undefined, true], '界面拿不到 Key 明文');
  assert.ok(!JSON.stringify(view).includes('brz_SECRET'));
  assert.throws(() => store.save({ tts: { provider: 'azure' } }), (e) => e.code === 'config.invalid');
  assert.throws(() => store.save({ tts: { breezeVoice: '../x' } }), (e) => e.code === 'config.invalid');
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('tts-breeze: ok');
