/**
 * 语音合成：按设置「语音」里选的那一家转过去（tts.provider：volc 火山 / breeze BreezeBlue 云端）。
 * 2026-11-21 用户：「再放个 breezetts 进去吧，做成切换的」。每次调用时看设置，切换马上生效，不用重开。
 *
 * 对外和每一家一样：ready()、synthesize(text) → { bytes, durationMs, cached }；外加 provider()、listVoices()（只有 Breeze 有）。
 */
import { codedError } from './store.js';
import { createVolcTts } from './tts-volc.js';
import { createBreezeTts } from './tts-breeze.js';

export const TTS_PROVIDERS = Object.freeze({ volc: '火山引擎', breeze: 'Breeze（云端）' });

export function createTts({ config, cacheDir, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const engines = {
    volc: createVolcTts({ config, cacheDir, fetchImpl, now }),
    breeze: createBreezeTts({ config, cacheDir, fetchImpl, now }),
  };
  const provider = () => { const p = config()?.provider; return engines[p] ? p : 'volc'; };
  const engine = () => engines[provider()];
  return {
    provider,
    ready: () => engine().ready(),
    synthesize: (text) => engine().synthesize(text),
    async listVoices() {
      if (provider() !== 'breeze') throw codedError('tts.no-voice-list', '只有 Breeze 能列出官方音色', '火山的音色 ID 在火山控制台的音色库里找。');
      return engines.breeze.listVoices();
    },
  };
}
