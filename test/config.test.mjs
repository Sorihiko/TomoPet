/**
 * 设置（core/config.js）和数据目录（core/store.js）。
 * 钉住：默认值、乱填的值收敛回安全范围、只连本机的 tosu、白名单 + 类型检查、被拒的改动一个字都不写、
 * 改之前备份、API Key 加密存 / 给界面看的版本不带 Key。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-config-'));
process.env.OSU_PET_HOME = sandbox;
const { CONFIG_FILE, DEFAULTS, createConfigStore, isLocalTosuUrl, normalizeConfig, plainSecretBox, safeStorageBox } = await import('../core/config.js');
const store = await import('../core/store.js');

assert.equal(store.dataDir(), sandbox, '数据目录跟着 OSU_PET_HOME 走');
assert.ok(!store.dataDir().includes('.dsh'), '不碰 ~/.dsh');

// ── 读：默认值和收敛 ─────────────────────────────────────────────────────────
{
  const cfg = normalizeConfig({});
  assert.deepEqual(cfg.watch, { enabled: true, url: 'ws://127.0.0.1:24050/websocket/v2', output: 'bubble', voice: true, midPlay: true, minGapSec: 10, perSongMax: 10, dailyLimit: 1000, remember: true, headsUp: 'voice', headsUpMax: 8 }, '2026-11-22 用户给的默认值');
  assert.deepEqual(cfg.rulers, DEFAULTS.rulers, '快慢的尺子默认是用户定的那套');
  assert.deepEqual([cfg.persona.ownerPronoun, cfg.counter.enabled, cfg.pet.enabled, cfg.pet.skin], ['他', true, true, 'crosspet-deepseek']);
  const odd = normalizeConfig({
    watch: { enabled: 'yes', url: 'ws://evil.example/x', output: 'hologram', minGapSec: 1, perSongMax: 99, dailyLimit: -5, midPlay: false, voice: 'yes' },
    persona: { name: '  ', ownerPronoun: '两行\n不行' }, pet: { scale: 9, skin: '../../etc' }, llm: { provider: 'gpt', baseUrl: 'ftp://x' }, tts: { speaker: 'S_abc; rm -rf' }, rulers: 'nope',
  });
  assert.deepEqual([odd.watch.enabled, odd.watch.url, odd.watch.output, odd.watch.minGapSec, odd.watch.perSongMax, odd.watch.dailyLimit, odd.watch.midPlay, odd.watch.voice], [true, 'ws://127.0.0.1:24050/websocket/v2', DEFAULTS.watch.output, 10, 10, 1, false, DEFAULTS.watch.voice], '乱填的值收敛回安全范围（不认识的回到默认值）；别的机器的地址不认');
  assert.deepEqual([odd.persona.name, odd.persona.ownerPronoun, odd.pet.scale, odd.pet.skin, odd.llm.provider, odd.llm.baseUrl, odd.tts.speaker], ['小鲸鱼', '他', 1.5, 'crosspet-deepseek', 'openai', DEFAULTS.llm.baseUrl, '']);
  assert.deepEqual(odd.rulers, DEFAULTS.rulers);
  // 「提到你时用」可以自己写（2026-11-27：「可以叫我大狗」）：一行、最多 10 个字，空的回到「他」
  for (const [given, want] of [['大狗', '大狗'], [' 你 ', '他'], ['我', '他'], [' 大狗 ', '大狗'], ['TA', 'TA'], ['', '他'], ['   ', '他'], ['一二三四五六七八九十十一', '一二三四五六七八九十'], [42, '他']]) {
    assert.equal(normalizeConfig({ persona: { ownerPronoun: given } }).persona.ownerPronoun, want, JSON.stringify(given));
  }
  // 在设置里填「你」「我」、带 Tab 的：拒绝，并说清楚为什么（不是「只能有字母、数字……」那句）
  {
    const cfgStore = createConfigStore();
    assert.throws(() => cfgStore.save({ persona: { ownerPronoun: '你' } }), (error) => error.code === 'config.invalid' && error.hint.includes('「你」是她自己') && error.hint.includes('大狗'));
    assert.throws(() => cfgStore.save({ persona: { ownerPronoun: '大\t狗' } }), (error) => error.hint === '只能写一行，不能有换行或 Tab。');
    cfgStore.save({ persona: { ownerPronoun: '大狗' } });
    assert.equal(cfgStore.get().persona.ownerPronoun, '大狗');
    cfgStore.save({ persona: { ownerPronoun: '他' } });
  }
  assert.deepEqual(normalizeConfig(null).watch, DEFAULTS.watch);
  for (const out of ['subtitle', 'bubble', 'none']) assert.equal(normalizeConfig({ watch: { output: out } }).watch.output, out);
  assert.equal(isLocalTosuUrl('ws://localhost:1234/websocket/v2'), true);
  for (const bad of ['http://127.0.0.1:24050', 'ws://192.168.1.5:24050/websocket/v2', 'ws://127.0.0.1.evil.example/x', '', null]) assert.equal(isLocalTosuUrl(bad), false, String(bad));
}

// ── 改：白名单、类型、备份 ───────────────────────────────────────────────────
{
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify({ watch: { minGapSec: 60 }, somethingElse: { keep: 1 } }));
  const config = createConfigStore();
  const saved = config.save({ watch: { enabled: false, minGapSec: 25 }, persona: { name: ' 阿鲸 ' } });
  assert.equal(saved.changed, true);
  assert.ok(saved.backup && fs.existsSync(saved.backup), '改之前留了备份');
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
  assert.deepEqual(onDisk.somethingElse, { keep: 1 }, '不认识的段原样留着');
  assert.deepEqual(onDisk.watch, { minGapSec: 25, enabled: false }, '只写改了的那几项');
  assert.deepEqual([config.get().watch.minGapSec, config.get().watch.enabled, config.get().persona.name], [25, false, '阿鲸']);
  assert.equal(config.save({}).changed, false);
  assert.equal(config.save({ watch: { minGapSec: 5 } }).changed, true);
  assert.equal(config.get().watch.minGapSec, 10, '存的时候也收敛');
  const before = fs.readFileSync(CONFIG_FILE(), 'utf8');
  const expectCode = (fn, code) => assert.throws(fn, (error) => { assert.equal(error.code, code); assert.ok(error.message && error.hint, `${code} 要带 error 和 hint`); return true; });
  expectCode(() => config.save({ watch: { url: 'ws://10.0.0.2:24050/websocket/v2' } }), 'osu.url-not-local');
  expectCode(() => config.save({ watch: { enabled: 'yes' } }), 'config.invalid');
  expectCode(() => config.save({ watch: { volume: 3 } }), 'config.invalid');
  expectCode(() => config.save({ watch: { output: 'hologram' } }), 'config.invalid');
  // 难段预告（2026-11-21）：三档，每张图 1–8 次
  expectCode(() => config.save({ watch: { headsUp: 'always' } }), 'config.invalid');
  expectCode(() => config.save({ watch: { minGapSec: 'abc' } }), 'config.invalid');
  expectCode(() => config.save({ nope: { a: 1 } }), 'config.invalid');
  expectCode(() => config.save({ watch: 'on' }), 'config.invalid');
  expectCode(() => config.save('nope'), 'config.invalid');
  expectCode(() => config.save({ tts: { speaker: 'S_x\n[evil]' } }), 'config.invalid');
  expectCode(() => config.save({ pet: { skin: '../outside' } }), 'config.invalid');
  expectCode(() => config.save({ llm: { baseUrl: 'javascript:alert(1)' } }), 'config.invalid');
  expectCode(() => config.save({ llm: { apiKey: 123 } }), 'config.invalid');
  expectCode(() => config.save({ watch: { enabled: true }, llm: { provider: 'gpt' } }), 'config.invalid');
  assert.equal(fs.readFileSync(CONFIG_FILE(), 'utf8'), before, '被拒的改动一个字都没写（哪怕同一次里有合格的项）');
  // config.json 坏了：不改它，说清楚。
  fs.writeFileSync(CONFIG_FILE(), '[1,2,3]');
  expectCode(() => config.save({ watch: { enabled: true } }), 'config.unreadable');
  assert.equal(fs.readFileSync(CONFIG_FILE(), 'utf8'), '[1,2,3]');
  assert.deepEqual(config.get().watch, DEFAULTS.watch, '读的时候回落到默认值，不抛');
  fs.writeFileSync(CONFIG_FILE(), '{}');
  // 备份只留最近 10 份。
  for (let i = 0; i < 14; i += 1) createConfigStore({ now: () => 1_800_000_000_000 + i * 1000 }).save({ watch: { minGapSec: 20 + i } });
  assert.equal(fs.readdirSync(path.join(sandbox, 'backups')).filter((n) => n.startsWith('config-')).length, 10);
}

// ── 密钥 ─────────────────────────────────────────────────────────────────────
{
  fs.writeFileSync(CONFIG_FILE(), '{}');
  // 假的 safeStorage：加密 = 反转 + 前缀。
  const fakeSafe = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`ENC:${[...s].reverse().join('')}`),
    decryptString: (b) => { const t = b.toString(); if (!t.startsWith('ENC:')) throw new Error('bad'); return [...t.slice(4)].reverse().join(''); },
  };
  const config = createConfigStore({ secretBox: safeStorageBox(fakeSafe) });
  config.save({ llm: { apiKey: '  sk-SECRET-123  ' }, tts: { accessKey: 'VOLC-SECRET', appId: '12345' } });
  const raw = fs.readFileSync(CONFIG_FILE(), 'utf8');
  assert.ok(!raw.includes('sk-SECRET-123') && !raw.includes('VOLC-SECRET'), '磁盘上没有明文 Key');
  assert.equal(JSON.parse(raw).llm.apiKey.enc, 'safe');
  assert.deepEqual([config.get().llm.apiKey, config.get().tts.accessKey], ['sk-SECRET-123', 'VOLC-SECRET'], '服务内部拿得到明文');
  const view = config.publicView();
  assert.ok(!JSON.stringify(view).includes('SECRET'), '给界面看的版本不带 Key');
  assert.deepEqual([view.llm.hasApiKey, view.tts.hasAccessKey, view.secretsEncrypted, view.tts.appId], [true, true, true, '12345']);
  // 清掉：传空串。
  config.save({ llm: { apiKey: '' } });
  assert.deepEqual([config.get().llm.apiKey, config.publicView().llm.hasApiKey], ['', false]);
  // 解不开（换了电脑 / 换了用户）：当没填，不抛。
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify({ llm: { apiKey: { enc: 'safe', data: Buffer.from('garbage').toString('base64') } } }));
  assert.equal(config.get().llm.apiKey, '');
  // 系统不支持加密：退回明文盒子，界面上能看出来没加密。
  assert.equal(safeStorageBox({ isEncryptionAvailable: () => false }), plainSecretBox);
  const plain = createConfigStore();
  plain.save({ llm: { apiKey: 'sk-PLAIN' } });
  assert.deepEqual([plain.get().llm.apiKey, plain.publicView().secretsEncrypted], ['sk-PLAIN', false]);
}

// ── 结构化失败 ───────────────────────────────────────────────────────────────
{
  assert.deepEqual(store.failureOf(store.codedError('llm.auth', '被拒了', '检查 Key')), { ok: false, code: 'llm.auth', error: '被拒了', hint: '检查 Key' });
  const plain = store.failureOf(new Error('boom'));
  assert.deepEqual([plain.code, plain.error, Boolean(plain.hint)], ['app.unexpected', 'boom', true]);
  assert.equal(store.failureOf(Object.assign(new Error('x'), { code: 'ENOENT' })).code, 'app.unexpected', '系统的错误码不冒充成我们的');
}

// 难段预告（2026-11-21）：两档（关 / 给我提个醒），每张图 1–8 次，存得进去、读得出来
{
  const store2 = createConfigStore();
  assert.equal(store2.save({ watch: { headsUp: 'voice', headsUpMax: 3 } }).changed, true);
  assert.deepEqual([store2.get().watch.headsUp, store2.get().watch.headsUpMax], ['voice', 3]);
  // 「只给观众看」（viewers）2026-11-22 用户说不需要，去掉了：存不进去；老设置里的读进来当关
  assert.throws(() => store2.save({ watch: { headsUp: 'viewers' } }), (e) => e.code === 'config.invalid');
  assert.equal(normalizeConfig({ watch: { headsUp: 'viewers' } }).watch.headsUp, 'off');
  assert.equal(normalizeConfig({ watch: { headsUp: 'loud', headsUpMax: 99 } }).watch.headsUp, DEFAULTS.watch.headsUp, '读到不认识的值退回默认');
  assert.equal(normalizeConfig({ watch: { headsUpMax: 99 } }).watch.headsUpMax, 8, '次数超了收到上限');
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('config: ok');
