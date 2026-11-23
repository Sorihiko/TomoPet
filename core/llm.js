/**
 * 模型调用：用户自己配的 Key。两种接口：
 *
 *   openai     POST {baseUrl}/chat/completions（DeepSeek、通义、Kimi、OpenRouter、本地 Ollama 等「OpenAI 兼容」的都走这个）
 *   anthropic  官方 SDK（@anthropic-ai/sdk）的 messages 接口
 *
 * 统一成 complete({ system, user, maxTokens }) → { text, usage:{ input, output }, model }。
 * 失败抛带 code / hint 的错（llm.*），watch.js 会把它显示在界面上「上一次没说成」那一行。
 *
 * 这里每次只写一句十几个字的话，而且打图中的话超过 9 秒就过时了：
 *   · OpenAI 兼容：temperature 1（和 SurfCore 一样，话要有变化）；
 *   · Anthropic：Claude Opus 5.5 的思考不能关，用 effort: low 让它少想、快回；不发 temperature（新模型会拒绝）；
 *     打开服务端的拒答兜底（fallbacks: "default"），万一被安全分类器误拦，由兜底模型接着写，不至于这一句直接没了。
 */
import Anthropic from '@anthropic-ai/sdk';
import { codedError } from './store.js';

export const PROVIDER_PRESETS = Object.freeze({
  openai: Object.freeze({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }),
  anthropic: Object.freeze({ baseUrl: '', model: 'claude-opus-5-5' }),
});

/** 支持服务端拒答兜底的模型（fallbacks: "default"）。 */
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const LLM_TIMEOUT_MS = 20_000;

function httpFailure(status, detail, provider) {
  if (status === 401 || status === 403) return codedError('llm.auth', `模型服务拒绝了 API Key（HTTP ${status}）`, '在设置「模型」里检查 Key 有没有填错、有没有过期、这个 Key 能不能用这个模型。');
  if (status === 404) return codedError('llm.http', `模型服务返回 404：${detail}`, provider === 'openai' ? '检查「接口地址」（一般以 /v1 结尾）和「模型名」。' : '检查「模型名」。');
  if (status === 429) return codedError('llm.rate-limit', '模型服务说请求太多了 / 额度用完了（HTTP 429）', '等一会儿她会接着说；一直这样就去模型服务的控制台看余额和限额。');
  return codedError('llm.http', `模型服务返回 HTTP ${status}：${detail}`, '看返回的信息；服务那边出问题时等一会儿再试。');
}

/**
 * @param {object} opts
 * @param {() => object} opts.config            llm 那一段设置（Key 已解密）
 * @param {typeof fetch} [opts.fetchImpl]       OpenAI 兼容接口用
 * @param {(options:object) => any} [opts.anthropicClient]  测试用：造一个假的 Anthropic 客户端
 */
export function createLlm({ config, fetchImpl = globalThis.fetch, anthropicClient = (options) => new Anthropic(options), timeoutMs = LLM_TIMEOUT_MS } = {}) {
  function ready() {
    const cfg = config() || {};
    if (!cfg.apiKey) return { ok: false, code: 'llm.no-key', error: '还没填模型的 API Key', hint: '在设置「模型」里选接口、填 Key 和模型名，然后点「测试」。' };
    if (!cfg.model) return { ok: false, code: 'llm.no-model', error: '还没填模型名', hint: '在设置「模型」里填模型名（比如 deepseek-chat、claude-opus-5-5）。' };
    if (cfg.provider === 'openai' && !cfg.baseUrl) return { ok: false, code: 'llm.no-url', error: '还没填接口地址', hint: '在设置「模型」里填 OpenAI 兼容接口的地址（一般以 /v1 结尾）。' };
    return { ok: true };
  }

  async function completeOpenAI(cfg, { system, user, maxTokens }) {
    let res;
    try {
      res = await fetchImpl(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, temperature: 1, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw codedError('llm.timeout', `模型 ${timeoutMs / 1000} 秒没回`, '网络慢或服务忙；下一次照常。');
      throw codedError('llm.network', `连不上模型服务：${String(error?.message ?? error).slice(0, 120)}`, '检查网络（代理 / 防火墙）和「接口地址」。');
    }
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      let detail = raw.slice(0, 160);
      try { detail = String(JSON.parse(raw)?.error?.message ?? detail).slice(0, 160); } catch {}
      throw httpFailure(res.status, detail, 'openai');
    }
    let data;
    try { data = JSON.parse(raw); } catch { throw codedError('llm.bad-response', '模型服务回的不是 JSON', '「接口地址」可能填成了网页地址；OpenAI 兼容接口一般以 /v1 结尾。'); }
    const choice = data?.choices?.[0];
    const text = String(choice?.message?.content ?? '').trim();
    // 会先「思考」的模型（GLM-4.5 / 4.6、deepseek-reasoner、Qwen3 等）把想的放在 reasoning_content 里，也算在 max_tokens 里
    const reasoning = String(choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '');
    return { text, finish: String(choice?.finish_reason ?? ''), reasoningChars: reasoning.length, usage: { input: Number(data?.usage?.prompt_tokens) || 0, output: Number(data?.usage?.completion_tokens) || 0 }, model: String(data?.model || cfg.model) };
  }

  async function completeAnthropic(cfg, { system, user, maxTokens }) {
    const client = anthropicClient({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}), timeout: timeoutMs, maxRetries: 1 });
    // 兜底参数只发给官方地址：代理 / 转发服务不一定认这个 beta。
    const fallback = FALLBACK_MODELS.has(cfg.model) && !cfg.baseUrl;
    const params = {
      model: cfg.model,
      // 思考也算在 max_tokens 里：只要一句话，但得给思考留地方。
      max_tokens: Math.max(2000, maxTokens),
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low' },
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
    };
    let response;
    try {
      response = fallback ? await client.beta.messages.create(params) : await client.messages.create(params);
    } catch (error) {
      if (error instanceof Anthropic.APIConnectionTimeoutError) throw codedError('llm.timeout', `模型 ${timeoutMs / 1000} 秒没回`, '网络慢或服务忙；下一次照常。');
      if (error instanceof Anthropic.APIConnectionError) throw codedError('llm.network', `连不上 Anthropic：${String(error.message).slice(0, 120)}`, '检查网络（代理 / 防火墙）。');
      if (typeof error?.status === 'number') throw httpFailure(error.status, String(error?.error?.error?.message ?? error.message ?? '').slice(0, 160), 'anthropic');
      throw error;
    }
    if (response?.stop_reason === 'refusal') {
      const category = response?.stop_details?.category;
      throw codedError('llm.refused', `模型拒绝写这一句${category ? `（${category}）` : ''}`, '偶尔会误拦；下一次照常。一直这样就换个模型。');
    }
    const text = (Array.isArray(response?.content) ? response.content : []).filter((block) => block?.type === 'text').map((block) => block.text).join('').trim();
    const thinking = (Array.isArray(response?.content) ? response.content : []).filter((block) => block?.type === 'thinking').map((block) => String(block.thinking ?? '')).join('');
    return { text, finish: String(response?.stop_reason ?? ''), reasoningChars: thinking.length, usage: { input: Number(response?.usage?.input_tokens) || 0, output: Number(response?.usage?.output_tokens) || 0 }, model: String(response?.model || cfg.model) };
  }

  /** 写一句话。失败抛 llm.*。 */
  async function complete({ system, user, maxTokens = 200 } = {}) {
    const state = ready();
    if (!state.ok) throw codedError(state.code, state.error, state.hint);
    const cfg = config();
    const result = cfg.provider === 'anthropic' ? await completeAnthropic(cfg, { system, user, maxTokens }) : await completeOpenAI(cfg, { system, user, maxTokens });
    if (!result.text) {
      // 说清楚为什么空（2026-11-22：朋友用智谱 GLM 一直「模型回了个空的」，原因是会思考的模型想到一半就到了字数上限）
      const cut = result.finish === 'length' || result.finish === 'max_tokens';
      if (cut && result.reasoningChars > 0) throw codedError('llm.empty', `模型还在思考就用完了字数，没写出回答（${result.model}）`, '这是会先「思考」的模型：换成不带思考的，比如智谱的 glm-4-flash / glm-4-air、DeepSeek 的 deepseek-chat。');
      if (cut) throw codedError('llm.empty', `模型的回答被字数上限截成了空的（${result.model}）`, '换个模型试试；一直这样把日志发给开发者。');
      throw codedError('llm.empty', `模型回了个空的${result.finish ? `（结束原因：${result.finish}）` : ''}`, '偶尔会这样；一直这样就换个模型。');
    }
    const { finish: _finish, reasoningChars: _reasoning, ...out } = result; // 只在上面判断空回答时用
    return out;
  }

  return { ready, complete };
}
