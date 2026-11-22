/**
 * 语音合成（core/tts-volc.js、core/speakable.js）：数字读法、资源编号、多行 JSON 拼 PCM、补 WAV 头、缓存、每种失败码。
 * 不发真的请求（假 fetch）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chineseNumber, pcmToWav, speakableText, wavDurationMs } from '../core/speakable.js';
import { VOLC_URL, createVolcTts, extractPcm, resourceFor } from '../core/tts-volc.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-tts-'));
const expectCode = async (promise, code) => assert.rejects(promise, (error) => { assert.equal(error.code, code, `${error.code}：${error.message}`); assert.ok(error.message && error.hint, `${code} 要带 error 和 hint`); return true; });

// ── 数字读法（用户：「4.8 星她读成 48 星，这种问题出现好几次了」）──────────────────────
{
  assert.equal(speakableText('这张 4.8 星'), '这张 4点八 星');
  assert.equal(speakableText('准确率 97.42%'), '准确率 百分之97点四二');
  assert.equal(speakableText('100% 全连'), '百分之100 全连');
  assert.equal(speakableText('17:38 了'), '17点38 了');
  assert.equal(speakableText('版本 0.8.9'), '版本 0点八点九');
  assert.equal(speakableText('圆周率 3.14159'), '圆周率 3点一四一五九');
  // 不该动的。
  for (const same of ['连击 486', '打完了。', 'A.B', '12:75', '240 BPM']) assert.equal(speakableText(same), same);
  // 多音字「还」不再换成同音字（2026-11-22 用户：「还就用还吧，别搞什么骸了」）：原样送去合成。
  for (const same of ['还行', '还差一点', '还给你', '钱还没还。']) assert.equal(speakableText(same), same, same);
  assert.equal(speakableText('还有 3 个 miss'), '还有 三个 miss');
  // 连击数（2026-11-20 用户：「应该是 998 combo 断了，不是九九八断了」）。
  assert.equal(speakableText('啊 998 combo 断了'), '啊 九百九十八 combo 断了');
  assert.equal(speakableText('346 连都白搭了 死在半路'), '三百四十六 连都白搭了 死在半路');
  assert.equal(speakableText('1000Combo'), '一千Combo');
  assert.equal(speakableText(null), '');
  // 数字 + 个（2026-11-20 用户：「6个miss就溜」她读成了「6，miss就溜」，「个」被合成那一侧吞了）。
  assert.equal(speakableText('6个miss就溜'), '六个miss就溜');
  assert.equal(speakableText('就2个miss'), '就两个miss');
  assert.equal(speakableText('12 个 100'), '十二个 100');
  assert.equal(speakableText('一把漏了 105个'), '一把漏了 一百零五个');
  assert.equal(speakableText('20个300'), '二十个300');
  assert.equal(speakableText('4.5个'), '4点五个', '小数不当整数改');
  assert.equal(speakableText('123456789个'), '123456789个', '太长的不改');
}
{
  const cases = [[0, '零'], [1, '一'], [10, '十'], [11, '十一'], [20, '二十'], [105, '一百零五'], [110, '一百一十'], [1000, '一千'], [1005, '一千零五'], [1050, '一千零五十'], [10000, '一万'], [10001, '一万零一'], [10100, '一万零一百'], [21000, '二万一千'], [110000, '十一万'], [1234567, '一百二十三万四千五百六十七'], [99999999, '九千九百九十九万九千九百九十九']];
  for (const [n, words] of cases) assert.equal(chineseNumber(n), words, String(n));
  for (const bad of [-1, 1.5, 100_000_000, NaN]) assert.equal(chineseNumber(bad), null);
}

// ── wav ─────────────────────────────────────────────────────────────────────
{
  const pcm = Buffer.alloc(24000 * 2); // 1 秒
  const wav = pcmToWav(pcm, 24000);
  assert.deepEqual([wav.toString('ascii', 0, 4), wav.readUInt32LE(4), wav.readUInt32LE(40), wav.length], ['RIFF', 36 + pcm.length, pcm.length, 44 + pcm.length]);
  assert.equal(wavDurationMs(wav), 1000);
  assert.equal(wavDurationMs(Buffer.from('not a wav')), 0, '坏文件返回 0，不抛');
  assert.equal(wavDurationMs('x'), 0);
}

// ── 资源编号 ─────────────────────────────────────────────────────────────────
{
  assert.equal(resourceFor('S_abc123'), 'seed-icl-2.0', '复刻音色');
  assert.equal(resourceFor('zh_female_roumeinvyou_uranus_bigtts'), 'seed-tts-2.0', '官方 2.0');
  assert.equal(resourceFor('zh_female_shuangkuaisisi_moon_bigtts'), 'seed-tts-1.0', '其他官方');
  assert.equal(resourceFor('mystery'), '', '认不出来的不猜');
  assert.equal(resourceFor('S_abc', 'seed-tts-2.0'), 'seed-tts-2.0', '手填的优先');
}

// ── 多行 JSON → PCM ──────────────────────────────────────────────────────────
// 火山的流式返回：首段带 RIFF 头，但长度字段是 0xFFFFFFFF；后面的段是裸 PCM；最后一行是结束帧。
function streamBody(pcm) {
  const head = pcmToWav(Buffer.alloc(0), 24000);
  head.writeUInt32LE(0xFFFFFFFF, 4);
  head.writeUInt32LE(0xFFFFFFFF, 40);
  const first = Buffer.concat([head, pcm.subarray(0, 100)]);
  return [
    JSON.stringify({ code: 0, message: '', data: first.toString('base64') }),
    '',
    JSON.stringify({ code: 0, data: pcm.subarray(100).toString('base64') }),
    '这一行不是 JSON',
    JSON.stringify({ code: 20000000, message: 'ok', data: null }),
  ].join('\n');
}
const PCM = Buffer.from(Array.from({ length: 4801 }, (_, i) => i % 251)); // 奇数个字节：最后半个采样要丢掉
{
  const pcm = extractPcm(streamBody(PCM));
  assert.equal(pcm.length, 4800);
  assert.ok(pcm.equals(PCM.subarray(0, 4800)), '去掉流式 WAV 头，各段按顺序拼起来');
  assert.equal(extractPcm('').length, 0);
  assert.equal(extractPcm(JSON.stringify({ code: 20000000, data: null })).length, 0);
  assert.throws(() => extractPcm(JSON.stringify({ code: 45000000, message: 'resource ID is mismatched with speaker related resource' })), (e) => e.code === 'tts.api' && e.hint.includes('seed-icl-2.0') && e.hint.includes('清空'));
  assert.throws(() => extractPcm(JSON.stringify({ code: 40000001, message: 'quota exceeded' })), (e) => e.code === 'tts.api' && e.message.includes('quota exceeded') && Boolean(e.hint));
}

// ── 合成 ─────────────────────────────────────────────────────────────────────
{
  const cfg = { provider: 'volc', appId: '', accessKey: '', speaker: '', resourceId: '', speed: 1 };
  const sent = [];
  let reply = () => ({ ok: true, status: 200, text: async () => streamBody(PCM) });
  const tts = createVolcTts({ config: () => cfg, cacheDir: path.join(sandbox, 'tts-cache'), fetchImpl: async (url, init) => { sent.push({ url, init }); return reply(); }, now: () => 1_800_000_000_000 });
  assert.equal(tts.ready().code, 'tts.no-key');
  await expectCode(tts.synthesize('你好'), 'tts.no-key');
  cfg.appId = 'APP'; cfg.accessKey = 'ACCESS-SECRET';
  assert.equal(tts.ready().code, 'tts.no-speaker');
  cfg.speaker = 'mystery';
  assert.equal(tts.ready().code, 'tts.no-resource');
  cfg.speaker = 'S_voice1';
  assert.deepEqual(tts.ready(), { ok: true });
  assert.equal(sent.length, 0, '没配好不发请求');

  const out = await tts.synthesize('这张 4.8 星');
  assert.deepEqual([out.cached, out.durationMs, out.bytes.toString('ascii', 0, 4), out.bytes.readUInt32LE(40)], [false, 100, 'RIFF', 4800], '补了一个长度正确的 WAV 头');
  assert.equal(sent[0].url, VOLC_URL);
  const headers = sent[0].init.headers;
  assert.deepEqual([headers['X-Api-App-Key'], headers['X-Api-Access-Key'], headers['X-Api-Resource-Id']], ['APP', 'ACCESS-SECRET', 'seed-icl-2.0']);
  assert.ok(headers['X-Api-Request-Id'].startsWith('osu-pet-'));
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.req_params, { text: '这张 4点八 星', speaker: 'S_voice1', audio_params: { format: 'wav', sample_rate: 24000 } }, '送去合成的是换过读法的文字');
  // 同一句再来：用缓存，不发请求。
  const cached = fs.readdirSync(path.join(sandbox, 'tts-cache')).filter((n) => n.endsWith('.wav')).map((n) => path.join(sandbox, 'tts-cache', n))[0];
  fs.utimesSync(cached, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const again = await tts.synthesize('这张 4.8 星');
  assert.deepEqual([again.cached, sent.length, again.bytes.equals(out.bytes)], [true, 1, true]);
  // 用到一次就刷新文件时间：缓存满了删最久没用的，常用的那几句（难段预告的提示）不会被挤掉、再花一次合成（2026-11-21）。
  assert.equal(Math.round(fs.statSync(cached).mtimeMs), 1_800_000_000_000);
  // 语速、官方音色。
  cfg.speed = 1.2; cfg.speaker = 'zh_female_roumeinvyou_uranus_bigtts';
  await tts.synthesize('这张 4.8 星');
  assert.equal(sent.length, 2, '换了音色 / 语速不用旧缓存');
  assert.deepEqual([sent[1].init.headers['X-Api-Resource-Id'], JSON.parse(sent[1].init.body).req_params.audio_params.speech_rate], ['seed-tts-2.0', 20]);
  cfg.speed = 1;

  // 失败的各种样子。
  reply = () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await expectCode(tts.synthesize('甲'), 'tts.auth');
  reply = () => ({ ok: false, status: 500, text: async () => 'server error' });
  await expectCode(tts.synthesize('乙'), 'tts.http');
  reply = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 45000000, message: 'resource ID is mismatched with speaker related resource' }) });
  await expectCode(tts.synthesize('丙'), 'tts.api');
  reply = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 20000000, data: null }) });
  await expectCode(tts.synthesize('丁'), 'tts.empty');
  reply = () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); };
  await expectCode(tts.synthesize('戊'), 'tts.timeout');
  reply = () => { throw new Error('getaddrinfo ENOTFOUND'); };
  await expectCode(tts.synthesize('己'), 'tts.network');
  await expectCode(tts.synthesize('   '), 'tts.empty-text');
  // 错误信息里不带密钥。
  reply = () => ({ ok: false, status: 403, text: async () => 'forbidden' });
  await assert.rejects(tts.synthesize('庚'), (e) => !`${e.message}${e.hint}`.includes('ACCESS-SECRET'));
  assert.ok(fs.readdirSync(path.join(sandbox, 'tts-cache')).every((name) => name.endsWith('.wav')), '失败的不留缓存文件');
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('tts-volc: ok');
