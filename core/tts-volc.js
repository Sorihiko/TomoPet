/**
 * 语音合成：火山引擎（豆包语音）V3 单向流式接口。可选——不开「念出来」就用不到。
 *
 * 接口契约（照 SurfCore 语音包 voxd/engine/cloud.py，2026-10 实测）：
 *   POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 *   头：X-Api-App-Key / X-Api-Access-Key / X-Api-Resource-Id / X-Api-Request-Id
 *   体：{ user:{uid}, req_params:{ text, speaker, audio_params:{ format:'wav', sample_rate:24000[, speech_rate] } } }
 *   回：多行 JSON，每行的 data 是 base64 的一段 WAV；首段带 RIFF 头但长度字段是 0xFFFFFFFF（流式），要自己切出 PCM 再补头。
 *   成功码有两种：0 和 20000000（后者 data 为 null，是结束帧）。
 *
 * 资源编号按音色 ID 选（SurfCore 案例 2026-11-19-voice-official-speakers）：
 *   复刻的 S_… → seed-icl-2.0；官方 2.0 …_uranus_bigtts → seed-tts-2.0；其他官方 …_bigtts → seed-tts-1.0；手填的优先。
 *
 * 失败一律抛带 code / hint 的错（tts.*），由 watch.js 记成 osu.voice-failed 显示在界面上，字幕照出。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { codedError } from './store.js';
import { pcmToWav, speakableText, wavDurationMs } from './speakable.js';

export const VOLC_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const OK_CODES = new Set([0, 20000000]);
const SAMPLE_RATE = 24000;
const CACHE_KEEP = 200;

/** 音色 ID → 资源编号；认不出来返回空串（让用户手填）。 */
export function resourceFor(speaker, explicit = '') {
  if (explicit) return explicit;
  const id = String(speaker || '');
  if (/^S_/.test(id)) return 'seed-icl-2.0';
  if (/_uranus_bigtts$/.test(id)) return 'seed-tts-2.0';
  if (/_bigtts$/.test(id)) return 'seed-tts-1.0';
  return '';
}

/** 多行 JSON → PCM（跳过流式 WAV 头）。返回 Buffer；接口报错时抛 tts.api。 */
export function extractPcm(raw) {
  const chunks = [];
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const code = obj?.code;
    if (code !== undefined && code !== null && !OK_CODES.has(Number(code))) {
      const message = String(obj.message ?? '').slice(0, 200);
      const mismatch = /resource id is mismatched/i.test(message);
      throw codedError('tts.api', `火山返回错误 ${code}：${message}`,
        mismatch ? '音色和资源编号对不上：复刻音色（S_ 开头）用 seed-icl-2.0，官方 2.0 音色用 seed-tts-2.0，其他官方音色用 seed-tts-1.0。把「资源编号」清空让它自动选。'
          : '检查 App ID、Access Key、音色 ID 是不是同一个账号下的，音色有没有开通。');
    }
    if (typeof obj?.data === 'string' && obj.data) {
      try { chunks.push(Buffer.from(obj.data, 'base64')); } catch {}
    }
  }
  const blob = Buffer.concat(chunks);
  if (!blob.length) return Buffer.alloc(0);
  let pcm = blob;
  if (blob.length >= 12 && blob.toString('ascii', 0, 4) === 'RIFF') {
    let off = 12;
    pcm = Buffer.alloc(0);
    while (off + 8 <= blob.length) {
      const id = blob.toString('ascii', off, off + 4);
      const size = blob.readUInt32LE(off + 4);
      if (id === 'data') { pcm = blob.subarray(off + 8); break; }
      off += 8 + size + (size % 2);
    }
  }
  return pcm.subarray(0, Math.floor(pcm.length / 2) * 2);
}

/**
 * @param {object} opts
 * @param {() => object} opts.config     tts 那一段设置（密钥已解密）
 * @param {string} opts.cacheDir
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createVolcTts({ config, cacheDir, fetchImpl = globalThis.fetch, timeoutMs = 15_000, now = Date.now } = {}) {
  /** 能不能合成：{ ok:true } 或结构化失败。 */
  function ready() {
    const cfg = config() || {};
    if (!cfg.appId || !cfg.accessKey) return { ok: false, code: 'tts.no-key', error: '还没填火山引擎的 App ID / Access Key', hint: '在设置「语音」里填上（火山引擎控制台 → 豆包语音 → API 接入）。' };
    if (!cfg.speaker) return { ok: false, code: 'tts.no-speaker', error: '还没填音色 ID', hint: '在设置「语音」里填音色 ID：自己复刻的是 S_ 开头，官方音色在火山的音色库里找。' };
    if (!resourceFor(cfg.speaker, cfg.resourceId)) return { ok: false, code: 'tts.no-resource', error: `认不出音色「${cfg.speaker}」该用哪个资源编号`, hint: '在「资源编号」里手填（seed-icl-2.0 / seed-tts-2.0 / seed-tts-1.0）。' };
    return { ok: true };
  }

  function cacheFile(say, cfg, resource) {
    const key = crypto.createHash('sha1').update(JSON.stringify([resource, cfg.speaker, Number(cfg.speed) || 1, say])).digest('hex');
    return path.join(cacheDir, `${key}.wav`);
  }

  function prune() {
    try {
      const files = fs.readdirSync(cacheDir).filter((name) => name.endsWith('.wav')).map((name) => ({ name, at: fs.statSync(path.join(cacheDir, name)).mtimeMs }));
      if (files.length <= CACHE_KEEP) return;
      files.sort((a, b) => a.at - b.at);
      for (const file of files.slice(0, files.length - CACHE_KEEP)) fs.rmSync(path.join(cacheDir, file.name), { force: true });
    } catch {}
  }

  /** 一句话 → { bytes, durationMs, cached }。失败抛 tts.*。 */
  async function synthesize(text) {
    const state = ready();
    if (!state.ok) throw codedError(state.code, state.error, state.hint);
    const cfg = config();
    const say = speakableText(String(text ?? '').trim());
    if (!say) throw codedError('tts.empty-text', '要合成的内容是空的', '这是程序的问题，看日志。');
    const resource = resourceFor(cfg.speaker, cfg.resourceId);
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = cacheFile(say, cfg, resource);
    try {
      const bytes = fs.readFileSync(file);
      if (bytes.length > 44) {
        // 用到一次就把时间刷新：缓存满了删最久没用的，常用的（难段预告那几句提示）不会被挤掉、再花一次合成（2026-11-21）。
        try { const t = new Date(now()); fs.utimesSync(file, t, t); } catch {}
        return { bytes, durationMs: wavDurationMs(bytes), cached: true };
      }
    } catch {}

    const audioParams = { format: 'wav', sample_rate: SAMPLE_RATE };
    const speed = Number(cfg.speed) || 1;
    if (Math.abs(speed - 1) > 0.01) audioParams.speech_rate = Math.round((speed - 1) * 100);
    let res;
    try {
      res = await fetchImpl(VOLC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-App-Key': cfg.appId,
          'X-Api-Access-Key': cfg.accessKey,
          'X-Api-Resource-Id': resource,
          'X-Api-Request-Id': `osu-pet-${now()}-${Math.random().toString(16).slice(2, 8)}`,
        },
        body: JSON.stringify({ user: { uid: 'osu-pet' }, req_params: { text: say, speaker: cfg.speaker, audio_params: audioParams } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw codedError('tts.timeout', `火山 ${timeoutMs / 1000} 秒没回`, '网络慢或火山那边忙；这一句只出字。');
      throw codedError('tts.network', `连不上火山引擎：${String(error?.message ?? error).slice(0, 120)}`, '检查网络（代理 / 防火墙）。');
    }
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) throw codedError('tts.auth', `火山拒绝了密钥（HTTP ${res.status}）`, '检查 App ID 和 Access Key 有没有填反、是不是同一个应用的。');
    if (!res.ok) throw codedError('tts.http', `火山返回 HTTP ${res.status}：${body.slice(0, 160)}`, '看返回的信息；资源编号不对时清空它让程序自动选。');
    const pcm = extractPcm(body);
    if (!pcm.length) throw codedError('tts.empty', '火山的返回里没有音频', '音色 ID 可能不对，或者这个音色没开通。');
    const bytes = pcmToWav(pcm, SAMPLE_RATE);
    try { fs.writeFileSync(file, bytes); prune(); } catch {}
    return { bytes, durationMs: wavDurationMs(bytes), cached: false };
  }

  return { ready, synthesize };
}
