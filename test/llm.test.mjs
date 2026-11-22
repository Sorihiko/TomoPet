/**
 * 模型调用（core/llm.js）：两家接口的请求形状、返回解析、每种失败码。不发真的请求（假 fetch / 假 Anthropic 客户端）。
 */
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { PROVIDER_PRESETS, createLlm } from '../core/llm.js';

const expectCode = async (promise, code) => assert.rejects(promise, (error) => { assert.equal(error.code, code, `${error.code}：${error.message}`); assert.ok(error.message && error.hint, `${code} 要带 error 和 hint`); return true; });
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

// ── 还没配好 ─────────────────────────────────────────────────────────────────
{
  const cfg = { provider: 'openai', baseUrl: 'https://api.example/v1', model: 'm', apiKey: '' };
  const llm = createLlm({ config: () => cfg, fetchImpl: async () => { throw new Error('不该发请求'); } });
  assert.deepEqual([llm.ready().ok, llm.ready().code], [false, 'llm.no-key']);
  await expectCode(llm.complete({ system: 's', user: 'u' }), 'llm.no-key');
  cfg.apiKey = 'sk-x'; cfg.model = '';
  assert.equal(llm.ready().code, 'llm.no-model');
  cfg.model = 'm'; cfg.baseUrl = '';
  assert.equal(llm.ready().code, 'llm.no-url');
  cfg.provider = 'anthropic';
  assert.equal(llm.ready().ok, true, 'Anthropic 不用填地址');
  assert.deepEqual(PROVIDER_PRESETS.anthropic, { baseUrl: '', model: 'claude-opus-5-5' });
}

// ── OpenAI 兼容 ──────────────────────────────────────────────────────────────
{
  const cfg = { provider: 'openai', baseUrl: 'https://api.example/v1/', model: 'deepseek-chat', apiKey: 'sk-OPENAI' };
  const sent = [];
  let reply = () => response(200, { model: 'deepseek-chat-0001', choices: [{ message: { content: '  这把稳啊 \n' } }], usage: { prompt_tokens: 321, completion_tokens: 9 } });
  const llm = createLlm({ config: () => cfg, fetchImpl: async (url, init) => { sent.push({ url, init }); return reply(); } });
  const out = await llm.complete({ system: 'SYSTEM', user: 'USER', maxTokens: 200 });
  assert.deepEqual(out, { text: '这把稳啊', usage: { input: 321, output: 9 }, model: 'deepseek-chat-0001' });
  assert.equal(sent[0].url, 'https://api.example/v1/chat/completions', '地址末尾多的斜杠不碍事');
  assert.equal(sent[0].init.headers.Authorization, 'Bearer sk-OPENAI');
  assert.deepEqual(JSON.parse(sent[0].init.body), { model: 'deepseek-chat', max_tokens: 200, temperature: 1, messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'USER' }] });
  assert.ok(sent[0].init.signal, '带超时');
  // 失败的各种样子。
  reply = () => response(401, { error: { message: 'Invalid API key' } });
  await expectCode(llm.complete({ system: 's', user: 'u' }), 'llm.auth');
  reply = () => response(429, { error: { message: 'quota' } });
  await expectCode(llm.complete({ system: 's', user: 'u' }), 'llm.rate-limit');
  reply = () => response(404, 'not found');
  await assert.rejects(llm.complete({ system: 's', user: 'u' }), (e) => e.code === 'llm.http' && e.hint.includes('接口地址'));
  reply = () => response(500, { error: { message: 'upstream exploded' } });
  await assert.rejects(llm.complete({ system: 's', user: 'u' }), (e) => e.code === 'llm.http' && e.message.includes('upstream exploded'));
  reply = () => response(200, '<html>网页</html>');
  await expectCode(llm.complete({ system: 's', user: 'u' }), 'llm.bad-response');
  reply = () => response(200, { choices: [{ message: { content: '   ' } }] });
  await expectCode(llm.complete({ system: 's', user: 'u' }), 'llm.empty');
  reply = () => { throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }); };
  await expectCode(llm.complete({ system: 's', user: 'u' }), 'llm.network');
  reply = () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); };
  await expectCode(llm.complete({ system: 's', user: 'u' }), 'llm.timeout');
  // 错误信息里不带 Key。
  reply = () => response(401, { error: { message: 'bad key' } });
  await assert.rejects(llm.complete({ system: 's', user: 'u' }), (e) => !`${e.message}${e.hint}`.includes('sk-OPENAI'));
}

// ── Anthropic（官方 SDK）────────────────────────────────────────────────────
{
  const cfg = { provider: 'anthropic', baseUrl: '', model: 'claude-opus-5-5', apiKey: 'sk-ant-KEY' };
  const made = [];
  const calls = { beta: [], plain: [] };
  let reply = async () => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '断了，可惜' }], usage: { input_tokens: 400, output_tokens: 30 } });
  const fake = (options) => {
    made.push(options);
    return { beta: { messages: { create: async (params) => { calls.beta.push(params); return reply(params); } } }, messages: { create: async (params) => { calls.plain.push(params); return reply(params); } } };
  };
  const llm = createLlm({ config: () => cfg, anthropicClient: fake });
  const out = await llm.complete({ system: 'SYSTEM', user: 'USER', maxTokens: 200 });
  assert.deepEqual(out, { text: '断了，可惜', usage: { input: 400, output: 30 }, model: 'claude-opus-5-5' }, '只取 text 块，思考块不算');
  assert.deepEqual([made[0].apiKey, 'baseURL' in made[0], typeof made[0].timeout], ['sk-ant-KEY', false, 'number']);
  const params = calls.beta[0];
  assert.deepEqual([params.model, params.system, params.messages], ['claude-opus-5-5', 'SYSTEM', [{ role: 'user', content: 'USER' }]]);
  assert.deepEqual(params.output_config, { effort: 'low' }, '只写一句话：少想、快回');
  assert.ok(params.max_tokens >= 2000, '思考也算在 max_tokens 里，得留地方');
  assert.ok(!('temperature' in params) && !('thinking' in params), '新模型不收 temperature；思考不用显式配');
  assert.deepEqual([params.betas, params.fallbacks], [['server-side-fallback-2026-07-01'], 'default'], '被误拦时由兜底模型接着写');
  // 走代理 / 老模型：不带兜底参数，用普通接口。
  cfg.baseUrl = 'https://proxy.example';
  await llm.complete({ system: 's', user: 'u' });
  assert.deepEqual([made.at(-1).baseURL, calls.plain.length, 'fallbacks' in calls.plain[0]], ['https://proxy.example', 1, false]);
  cfg.baseUrl = ''; cfg.model = 'claude-haiku-5-5';
  await llm.complete({ system: 's', user: 'u' });
  assert.equal(calls.plain.length, 2);
  cfg.model = 'claude-opus-5-5';
  // 拒答、空、各种错。
  reply = async () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] });
  await assert.rejects(llm.complete({ system: 's', user: 'u' }), (e) => e.code === 'llm.refused' && e.message.includes('cyber') && Boolean(e.hint));
  reply = async () => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }] });
  await expectCode(llm.complete({ system: 's', user: 'u' }), 'llm.empty');
  reply = async () => { throw Object.assign(new Error('401 invalid x-api-key'), { status: 401 }); };
  await expectCode(llm.complete({ system: 's', user: 'u' }), 'llm.auth');
  reply = async () => { throw Object.assign(new Error('429'), { status: 429 }); };
  await expectCode(llm.complete({ system: 's', user: 'u' }), 'llm.rate-limit');
  reply = async () => { throw Object.assign(new Error('overloaded'), { status: 529 }); };
  await expectCode(llm.complete({ system: 's', user: 'u' }), 'llm.http');
  reply = async () => { throw new Anthropic.APIConnectionTimeoutError(); };
  await expectCode(llm.complete({ system: 's', user: 'u' }), 'llm.timeout');
  reply = async () => { throw new Anthropic.APIConnectionError({ message: 'ECONNREFUSED' }); };
  await expectCode(llm.complete({ system: 's', user: 'u' }), 'llm.network');
}

console.log('llm: ok');
