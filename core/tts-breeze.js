/**
 * BreezeBlue 云端语音合成（Breeze TTS 2，https://breezeblue.ai）：和 core/tts-volc.js 一样的接口，设置「语音」里可以切换。
 *
 * 为什么（2026-11-21 用户：「再放个 breezetts 进去吧，做成切换的，可以火山可以 breeze」，选的是「只接云端」）。
 *
 *   POST https://api.breeze.blue/v1/text-to-speech/{voice_id}?output_format=wav_24000
 *   头：xi-api-key: brz_…；体：{ text, language_code:'zh', voice_settings:{ speed }, instructions? }
 *   回：24kHz 16 位单声道 WAV（和火山合成出来的格式一样，后面的口型、缓存、播放都不用改）。
 *   音色：GET /v1/voices?voice_type=default&language_code=zh&accent_mode=unmarked（官方的普通话音色），设置里列出来挑。
 *
 * 额度：免费档每天约 400 credits（1 credit = 10 字符，汉字按 2 个算，约 2000 个汉字），用完回 402。
 * 合成过的句子存在本机（和火山同一个缓存文件夹，键里带上 breeze 和音色），同一句话不会再花额度。
 * 服务器在境外：等 20 秒没回就算超时，这一句只出字。
 * 授权：BreezeBlue 平台生成的声音按它平台的条款（免费档不能商用；TomoPet 不商用）。
 *
 * 失败都抛 tts.*（{ code, error, hint }），和火山那边一样。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { codedError } from './store.js';
import { speakableText, wavDurationMs } from './speakable.js';

export const BREEZE_API = 'https://api.breeze.blue/v1';
const CACHE_KEEP = 200;

/**
 * @param {object} opts
 * @param {() => object} opts.config    设置里的 tts 那一段（breezeKey 已解密）
 * @param {string} opts.cacheDir
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createBreezeTts({ config, cacheDir, fetchImpl = globalThis.fetch, timeoutMs = 20_000, now = Date.now } = {}) {
  function ready() {
    const cfg = config() || {};
    if (!cfg.breezeKey) return { ok: false, code: 'tts.no-key', error: '还没填 Breeze 的 API Key', hint: '到 breezeblue.ai 注册登录，在 Developer → API Keys 生成一个（brz_ 开头），填进设置「语音」。' };
    if (!cfg.breezeVoice) return { ok: false, code: 'tts.no-speaker', error: '还没选 Breeze 的音色', hint: '在设置「语音」里点「列出官方中文音色」挑一个，或者直接填 voice_id。' };
    return { ok: true };
  }

  function cacheFile(say, cfg) {
    const key = crypto.createHash('sha1').update(JSON.stringify(['breeze', cfg.breezeVoice, Number(cfg.speed) || 1, cfg.breezeInstructions || '', say])).digest('hex');
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

  /** Breeze 回的错误（{ ok:false, code, detail, error }）→ 我们的 tts.*。 */
  function failureFrom(status, body) {
    let info = {};
    try { info = JSON.parse(body); } catch {}
    const code = String(info?.code || '');
    const detail = String(info?.detail || info?.error || body || '').slice(0, 160);
    if (status === 401 || code.startsWith('AUTH_')) return codedError('tts.auth', `Breeze 不认这个 API Key（HTTP ${status}）`, '检查 Key 有没有复制全（brz_ 开头），或者在 breezeblue.ai 重新生成一个。');
    if (status === 402 || code === 'BILLING_INSUFFICIENT_CREDITS' || code === 'API_KEY_CREDIT_LIMIT_EXCEEDED') {
      return codedError('tts.quota', code === 'API_KEY_CREDIT_LIMIT_EXCEEDED' ? '这个 Breeze Key 的额度上限用完了' : 'Breeze 的额度用完了', '免费档每天要在 breezeblue.ai 上手动领一次额度（约 2000 个汉字）；也可以先切回火山。这一句只出字。');
    }
    if (status === 404 || code === 'RESOURCE_NOT_FOUND') return codedError('tts.no-speaker', `Breeze 找不到这个音色：${detail}`, '在设置「语音」里重新点「列出官方中文音色」挑一个。');
    if (status === 403) return codedError('tts.forbidden', `Breeze 不让这样用（HTTP 403）：${detail}`, '「语气说明」可能要付费账号才能用：先把它清空再试。');
    if (status === 400 || status === 422) return codedError('tts.http', `Breeze 说请求不对（HTTP ${status}）：${detail}`, '音色 ID 或语气说明可能填得不对；清空语气说明再试。');
    if (status === 429 || status === 503 || status === 504) return codedError('tts.busy', `Breeze 这会儿忙（HTTP ${status}）`, '过一会儿再试；这一句只出字。');
    return codedError('tts.http', `Breeze 返回 HTTP ${status}：${detail}`, '看返回的信息；一直这样就先切回火山。');
  }

  async function request(url, init) {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw codedError('tts.timeout', `Breeze ${timeoutMs / 1000} 秒没回`, '它的服务器在境外，网络慢时会这样；这一句只出字。一直超时就切回火山。');
      throw codedError('tts.network', `连不上 Breeze：${String(error?.message ?? error).slice(0, 120)}`, '检查网络（它的服务器在境外，可能要代理）。');
    }
  }

  /** 一句话 → { bytes, durationMs, cached }。失败抛 tts.*。 */
  async function synthesize(text) {
    const state = ready();
    if (!state.ok) throw codedError(state.code, state.error, state.hint);
    const cfg = config();
    // 数字读法照样换（4.8 → 4点八）；「还」不换成同音字：那是给火山读错多音字打的补丁。
    const say = speakableText(String(text ?? '').trim());
    if (!say) throw codedError('tts.empty-text', '要合成的内容是空的', '这是程序的问题，看日志。');
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = cacheFile(say, cfg);
    try {
      const bytes = fs.readFileSync(file);
      if (bytes.length > 44) {
        try { const t = new Date(now()); fs.utimesSync(file, t, t); } catch {}
        return { bytes, durationMs: wavDurationMs(bytes), cached: true };
      }
    } catch {}

    const body = { text: say, language_code: 'zh', voice_settings: { speed: Math.min(2, Math.max(0.5, Number(cfg.speed) || 1)) } };
    const instructions = String(cfg.breezeInstructions || '').trim();
    // 语气说明（比如「活泼的少女，语气俏皮」）：官方建议配上更高的 guidance_scale 才听得出来。
    if (instructions) { body.instructions = instructions; body.voice_settings.guidance_scale = 4; }
    const res = await request(`${BREEZE_API}/text-to-speech/${encodeURIComponent(cfg.breezeVoice)}?output_format=wav_24000`, {
      method: 'POST',
      headers: { 'xi-api-key': cfg.breezeKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw failureFrom(res.status, await res.text().catch(() => ''));
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length <= 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') throw codedError('tts.empty', 'Breeze 的返回里没有能播的音频', '音色可能不支持中文：换一个官方中文音色试试。');
    try { fs.writeFileSync(file, bytes); prune(); } catch {}
    return { bytes, durationMs: wavDurationMs(bytes), cached: false };
  }

  /**
   * 官方的普通话音色（设置里挑）：[{ id, name, gender, age, tone, description }]。
   * 只要 Key（不用先选音色）；失败抛 tts.*。
   */
  async function listVoices() {
    const cfg = config() || {};
    if (!cfg.breezeKey) throw codedError('tts.no-key', '还没填 Breeze 的 API Key', '先把 Key 填上，再列音色。');
    const res = await request(`${BREEZE_API}/voices?voice_type=default&language_code=zh&accent_mode=unmarked&page_size=100`, { headers: { 'xi-api-key': cfg.breezeKey } });
    if (!res.ok) throw failureFrom(res.status, await res.text().catch(() => ''));
    let data = {};
    try { data = await res.json(); } catch { throw codedError('tts.http', 'Breeze 的音色列表读不懂', '过一会儿再试。'); }
    return (Array.isArray(data?.voices) ? data.voices : []).slice(0, 100).map((v) => ({
      id: String(v.voice_id || '').slice(0, 80),
      name: String(v.name || v.voice_id || '').slice(0, 60),
      gender: typeof v.gender === 'string' ? v.gender : '',
      age: typeof v.age === 'string' ? v.age : '',
      tone: Array.isArray(v.tone) ? v.tone.map(String).slice(0, 3) : [],
      description: String(v.description || '').slice(0, 120),
    })).filter((v) => /^[A-Za-z0-9._-]+$/.test(v.id));
  }

  return { ready, synthesize, listVoices };
}
