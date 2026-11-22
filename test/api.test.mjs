/**
 * 设置窗口的接口（app/api.js）和「下一步」提示（core/next-step.js）。
 * 钉住：每个操作都返回 { ok } 或 { ok:false, code, error, hint }（不抛给页面）；返回值里没有密钥；
 * 只开允许的地址；每种挡路的情况都有一条看得见的提示。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-api-'));
process.env.OSU_PET_HOME = path.join(sandbox, 'home');
// 程序自带的皮肤：临时目录里放一套假的（不读真的 skins-bundled/）。
process.env.OSU_PET_BUNDLED_DIR = path.join(sandbox, 'bundled');
{
  const dir = path.join(sandbox, 'bundled', 'bundled-one');
  fs.mkdirSync(path.join(dir, 'art'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'bundled-one', name: '自带的一套', rig: 'layered', canvas: { w: 10, h: 10 }, hitbox: { x: 0, y: 0, w: 10, h: 10 }, layers: [{ id: 'm', file: 'art/m.png', group: 'head', role: 'mouth' }] }));
  fs.writeFileSync(path.join(dir, 'art', 'm.png'), 'M');
}
const { createApi } = await import('../app/api.js');
const { createConfigStore } = await import('../core/config.js');
const { codedError } = await import('../core/store.js');
const { nextSteps } = await import('../core/next-step.js');
const skins = await import('../core/skins.js');

// ── 「下一步」────────────────────────────────────────────────────────────────
const baseStatus = () => ({
  ok: true,
  watch: { enabled: true, output: 'subtitle', voice: false },
  tosu: { connected: true, lastFrameAt: 5, error: null },
  llm: { ok: true },
  voice: { enabled: false, ready: { ok: true }, lastError: null },
  overlay: { lastError: null },
  pet: { enabled: true, visible: true, fallback: null, lastError: null },
  counter: { enabled: true, installed: true, lastError: null, lastSync: null },
  persona: { personaChars: 120 },
  playing: null,
  lastError: null,
});
{
  assert.deepEqual(nextSteps(baseStatus()), [], '都好的时候什么都不显示');
  const codes = (status, opts) => nextSteps(status, opts).map((step) => step.code);
  const every = (steps) => steps.every((step) => step.text && step.section && ['error', 'warn', 'info'].includes(step.level));
  let s = baseStatus();
  s.llm = { ok: false, code: 'llm.no-key', error: '还没填模型的 API Key', hint: '在设置「模型」里填 Key。' };
  s.tosu = { connected: false, error: { code: 'osu.tosu-offline', error: '连不上 tosu', hint: '先打开 tosu.exe' } };
  assert.deepEqual(codes(s), ['llm.no-key', 'osu.tosu-offline'], '最挡路的在前');
  assert.ok(every(nextSteps(s)) && nextSteps(s).every((step) => step.hint));
  s = baseStatus(); s.watch.enabled = false; s.tosu = { connected: false, error: null };
  assert.deepEqual(codes(s), ['osu.disabled']);
  s = baseStatus(); s.tosu.lastFrameAt = null;
  assert.deepEqual(codes(s), ['osu.no-frames'], '连上了但 osu! 没开');
  s = baseStatus(); s.watch.output = 'none';
  assert.deepEqual(codes(s), ['osu.no-output']);
  s = baseStatus(); s.watch.voice = true; s.voice = { enabled: true, ready: { ok: false, code: 'tts.no-key', error: '还没填火山引擎的 App ID / Access Key', hint: '填上' }, lastError: { code: 'osu.voice-failed', error: '这一句没念出来：x', hint: '试听' } };
  assert.deepEqual(codes(s), ['tts.no-key', 'osu.voice-failed']);
  s = baseStatus(); s.watch.output = 'bubble'; s.pet.visible = false;
  assert.deepEqual(nextSteps(s).map((step) => [step.code, step.level]), [['osu.bubble-obs-only', 'info']], '桌面角色藏着但 OBS 角色装好了：只是提醒，不算出错');
  s.counter.installed = false;
  assert.deepEqual(codes(s), ['osu.pet-hidden']);
  s.counter = { enabled: false, installed: true, lastError: null, lastSync: null };
  assert.deepEqual(codes(s), ['osu.pet-hidden'], 'OBS 关了也不算');
  s.watch.voice = true;
  assert.deepEqual(nextSteps(s).map((step) => [step.code, step.level]), [['osu.bubble-voice-only', 'warn']], '只能出声');
  s.voice = { enabled: true, ready: { ok: false, code: 'tts.no-key', error: '还没填火山引擎的 App ID / Access Key', hint: '填上' }, lastError: null };
  assert.deepEqual(codes(s), ['tts.no-key', 'osu.pet-hidden'], '语音没配好：念不出来，和没开一样');
  s = baseStatus(); s.watch.output = 'bubble'; s.pet.visible = false; s.counter.lastError = { code: 'osu.counter-write', error: '写 tosu 文件夹失败', hint: '检查能不能写' };
  assert.deepEqual(codes(s), ['osu.pet-hidden', 'osu.counter-write'], 'OBS 写不进去：不说「气泡只出在 OBS 里」');
  // 复核：桌面角色出不来是因为没有皮肤：只报皮肤那一条，不再说「藏着」。
  s = baseStatus(); s.watch.output = 'bubble'; s.pet.visible = false; s.counter.installed = false;
  s.pet.lastError = { code: 'skin.none', error: '一套能用的皮肤都没有', hint: '放 art/crosspet/' };
  assert.deepEqual(codes(s), ['skin.none']);
  // SurfCore 的小鲸鱼也在看：提醒只留一个。
  s = baseStatus(); s.counter.otherWatcher = { folder: 'surfcore-xiaojingyu', at: '2026-11-20T21:33:29.000Z' };
  assert.deepEqual(nextSteps(s).map((step) => [step.code, step.level, step.section]), [['osu.other-watcher', 'warn', 'watch']]);
  assert.ok(nextSteps(s)[0].hint.includes('看你打 osu!') && nextSteps(s)[0].hint.includes('surfcore-xiaojingyu') && nextSteps(s)[0].hint.includes('最多半小时自己消失'));
  const local = new Date('2026-11-20T21:33:29.000Z');
  assert.ok(nextSteps(s)[0].text.includes(`${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')} 还在 tosu 里说过话`), nextSteps(s)[0].text);
  s.counter.otherWatcher = { folder: 'surfcore-xiaojingyu', at: '坏的' };
  assert.ok(nextSteps(s)[0].text.includes('最近 30 分钟'));
  s.watch.enabled = false;
  assert.deepEqual(codes(s), ['osu.disabled'], '自己关着时不提醒');
  s = baseStatus(); s.pet.lastError = { code: 'pet.skin-failed', error: '桌面角色没画出来', hint: '换回占位皮肤' }; s.pet.fallback = { code: 'skin.not-found', error: '没找到皮肤', hint: '重新选' };
  assert.deepEqual(codes(s), ['pet.skin-failed', 'skin.not-found']);
  s = baseStatus(); s.counter.lastError = { code: 'osu.counter-write', error: '写 tosu 文件夹失败', hint: '检查能不能写' };
  assert.deepEqual(nextSteps(s).map((step) => [step.code, step.level, step.section]), [['osu.counter-write', 'error', 'obs']]);
  s.counter.lastError = { code: 'osu.counter-no-tosu', error: '没找到正在运行的 tosu', hint: '先打开 tosu.exe' };
  assert.equal(nextSteps(s)[0].level, 'info', 'tosu 没开不算出错');
  s = baseStatus(); s.lastError = { code: 'llm.auth', error: '模型服务拒绝了 API Key', hint: '检查 Key' };
  assert.deepEqual([nextSteps(s)[0].code, nextSteps(s)[0].text], ['llm.auth', '上一次没说成：模型服务拒绝了 API Key']);
  s = baseStatus(); s.persona.personaChars = 0;
  assert.deepEqual(codes(s), ['persona.empty']);
  assert.deepEqual(codes(baseStatus(), { rendererBuilt: false, secretsEncrypted: false, logoFound: false }), ['app.no-renderer', 'config.plain-secrets', 'app.no-logo']);
  assert.ok(nextSteps(baseStatus(), { rendererBuilt: false })[0].hint.includes('npm run build'));
  assert.equal(nextSteps(null)[0].text, '读不到状态');
}

// ── 接口 ─────────────────────────────────────────────────────────────────────
{
  const configStore = createConfigStore();
  configStore.save({ llm: { apiKey: 'sk-SECRET-KEY' }, tts: { accessKey: 'VOLC-SECRET', appId: 'APP', speaker: 'S_x' } });
  const calls = { act: [], changed: 0, opened: [], copied: [], external: [], overlay: [], petCommands: [], logs: [], autostart: [] };
  const state = { pick: '', llmFails: false, statusThrows: false };
  const service = {
    status: () => { if (state.statusThrows) throw new Error('STATUS_DOWN'); return { ...baseStatus(), today: { said: 0 }, plays: [], skipped: [] }; },
    act: async (body) => {
      calls.act.push(body.action);
      if (body.action === 'test') return { said: 'TEST_LINE' };
      if (body.action === 'counter-sync') throw codedError('osu.counter-no-tosu', '没找到正在运行的 tosu', '先打开 tosu.exe');
      return {};
    },
  };
  const api = createApi({
    configStore, service, skins,
    llm: { complete: async () => { if (state.llmFails) throw codedError('llm.auth', '模型服务拒绝了 API Key（HTTP 401）', '检查 Key'); return { text: '收到', model: 'MODEL', usage: { input: 20, output: 2 } }; } },
    tts: { synthesize: async (text) => ({ bytes: Buffer.from('WAV'), durationMs: 2400, cached: false, text }) },
    autostart: { supported: true, get: () => state.autoOn === true, set: (on) => { calls.autostart.push(on); if (!state.autoStuck) state.autoOn = on; if (state.autoThrows) throw new Error('ACCESS_DENIED'); return state.autoOn === true; } },
    overlay: { say: (line) => calls.overlay.push(line) },
    pet: { recenter: () => true, command: (cmd) => calls.petCommands.push(cmd) },
    shell: { openPath: async (target) => { calls.opened.push(target); }, pickFolder: async () => state.pick, copyText: (text) => calls.copied.push(text), openExternal: async (url) => { calls.external.push(url); } },
    info: { version: '9.9.9', dataDir: process.env.OSU_PET_HOME, personaFile: path.join(process.env.OSU_PET_HOME, 'persona.md'), rendererBuilt: () => true, logoFound: () => false, logoUrl: 'osupet://local/assets/logo.png' },
    onConfigChanged: () => { calls.changed += 1; },
    log: (...args) => calls.logs.push(args.join(' ')),
  });
  const failed = (result, code) => { assert.equal(result.ok, false, JSON.stringify(result).slice(0, 200)); assert.equal(result.code, code); assert.ok(result.error && result.hint, `${code} 要带 error 和 hint`); };

  const full = await api.call('state');
  assert.equal(full.ok, true);
  // 开机自启：状态照系统里的，开 / 关走 app.autostart（不在设置文件里）
  assert.deepEqual(full.app.autostart, { supported: true, on: false });
  const turnedOn = await api.call('app.autostart', { on: true });
  assert.deepEqual([turnedOn.ok, turnedOn.autostart, turnedOn.app.autostart.on, calls.autostart], [true, true, true, [true]]);
  failed(await api.call('app.autostart', { on: 'yes' }), 'api.bad-argument');
  state.autoStuck = true;
  failed(await api.call('app.autostart', { on: false }), 'app.autostart-failed');
  state.autoStuck = false;
  state.autoThrows = true;
  failed(await api.call('app.autostart', { on: false }), 'app.autostart-failed');
  state.autoThrows = false;
  assert.ok(!JSON.stringify(full).includes('SECRET'), '返回给页面的东西里没有密钥');
  assert.deepEqual([full.config.llm.hasApiKey, full.config.tts.hasAccessKey, full.app.version, full.app.logoUrl], [true, true, '9.9.9', '']);
  assert.deepEqual(full.skins.map((skin) => [skin.id, skin.source, 'dir' in skin]), [['bundled-one', 'bundled', false]], '皮肤列表不带磁盘路径');
  assert.ok(full.nextSteps.some((step) => step.code === 'app.no-logo'));
  assert.deepEqual(full.presets.anthropic.model, 'claude-opus-5-5');

  // 改设置：存进去、通知各处对齐；不合格的被拒，带 code / hint。
  const saved = await api.call('config.save', { patch: { watch: { minGapSec: 25 } } });
  assert.deepEqual([saved.ok, saved.changed, saved.config.watch.minGapSec, calls.changed], [true, true, 25, 1]);
  failed(await api.call('config.save', { patch: { watch: { url: 'ws://10.0.0.2:1/x' } } }), 'osu.url-not-local');
  failed(await api.call('config.save', { patch: { watch: { output: 'hologram' } } }), 'config.invalid');
  failed(await api.call('config.save'), 'config.invalid');
  assert.equal(calls.changed, 1, '被拒的不触发对齐');

  assert.equal((await api.call('watch.test')).said, 'TEST_LINE');
  failed(await api.call('counter.sync'), 'osu.counter-no-tosu');
  assert.equal((await api.call('plays.clear')).ok, true);
  assert.deepEqual(calls.act, ['test', 'counter-sync', 'clear-plays']);

  const tested = await api.call('llm.test');
  assert.deepEqual([tested.ok, tested.text, tested.model, tested.tokens], [true, '收到', 'MODEL', 22]);
  state.llmFails = true;
  failed(await api.call('llm.test'), 'llm.auth');
  const heard = await api.call('tts.test');
  assert.deepEqual([heard.ok, heard.durationMs], [true, 2400]);
  assert.ok(heard.text.includes('4.8') && heard.text.includes('%'), '试听的那句带小数和百分号');
  assert.deepEqual([calls.overlay[0].audio.toString(), calls.overlay[0].ms], ['WAV', 3900]);

  // 导入皮肤：取消 / 选错 / 成功（成功后直接换上）。
  assert.deepEqual(await api.call('skin.import'), { ok: true, canceled: true });
  state.pick = path.join(sandbox, 'not-a-skin');
  fs.mkdirSync(state.pick, { recursive: true });
  failed(await api.call('skin.import'), 'skin.no-manifest');
  state.pick = path.join(sandbox, 'my-skin');
  fs.mkdirSync(path.join(state.pick, 'art'), { recursive: true });
  fs.writeFileSync(path.join(state.pick, 'manifest.json'), JSON.stringify({ id: 'my-skin', name: '我的角色', rig: 'layered', canvas: { w: 10, h: 10 }, hitbox: { x: 0, y: 0, w: 10, h: 10 }, layers: [{ id: 'm', file: 'art/m.png', group: 'head', role: 'mouth' }] }));
  fs.writeFileSync(path.join(state.pick, 'art', 'm.png'), 'M');
  const imported = await api.call('skin.import');
  assert.deepEqual([imported.ok, imported.imported.id, imported.config.pet.skin, imported.skins.map((skin) => skin.id)], [true, 'my-skin', 'my-skin', ['my-skin', 'bundled-one']], '用户的在前、自带的在后');

  // 「导入 CrossPet 角色」那个按钮去掉了（2026-11-20 用户：「不需要导入 crosspet 选项，默认就全有」）。
  failed(await api.call('skin.importCrossPet'), 'api.unknown');

  // 手动选 tosu 的位置：里面得有 tosu.exe。
  state.pick = path.join(sandbox, 'no-tosu');
  fs.mkdirSync(state.pick, { recursive: true });
  failed(await api.call('tosu.pickDir'), 'osu.counter-bad-dir');
  state.pick = path.join(sandbox, 'tosu');
  fs.mkdirSync(state.pick, { recursive: true });
  fs.writeFileSync(path.join(state.pick, 'tosu.exe'), '');
  assert.equal((await api.call('tosu.pickDir')).config.counter.tosuDir, state.pick);

  // 打开文件夹 / 复制 / 开网页：只开允许的。
  await api.call('persona.open'); await api.call('data.open'); await api.call('skins.open');
  assert.deepEqual(calls.opened, [path.join(process.env.OSU_PET_HOME, 'persona.md'), process.env.OSU_PET_HOME, skins.userSkinsDir()]);
  await api.call('clipboard.copy', { text: 'http://127.0.0.1:24050/fatfish-osu/' });
  assert.deepEqual(calls.copied, ['http://127.0.0.1:24050/fatfish-osu/']);
  for (const ok of ['http://127.0.0.1:24050/fatfish-osu/', 'http://localhost:24050/', 'https://github.com/tosuapp/tosu/releases']) assert.equal((await api.call('external.open', { url: ok })).ok, true, ok);
  for (const bad of ['https://evil.example/', 'file:///C:/Windows/system32/calc.exe', 'http://127.0.0.1.evil.example/', 'javascript:alert(1)', '', undefined]) failed(await api.call('external.open', { url: bad }), 'api.bad-argument');
  assert.equal(calls.external.length, 3);
  assert.equal((await api.call('pet.recenter')).moved, true);
  await api.call('pet.command', { command: 'blink' });
  failed(await api.call('pet.command', { command: 'rm -rf' }), 'api.bad-argument');
  assert.deepEqual(calls.petCommands, ['blink']);

  // 不认识的操作、原型上的名字、服务自己炸了：都不抛。
  failed(await api.call('nope'), 'api.unknown');
  failed(await api.call('constructor'), 'api.unknown');
  failed(await api.call('__proto__'), 'api.unknown');
  state.statusThrows = true;
  const down = await api.call('state');
  assert.deepEqual([down.ok, down.code, down.error], [false, 'app.unexpected', 'STATUS_DOWN']);
  assert.ok(down.hint);
  assert.ok(calls.logs.some((line) => line.includes('llm.test') && line.includes('llm.auth')), '失败记了日志');
  assert.ok(!calls.logs.join('\n').includes('SECRET'), '日志里没有密钥');
}

// ── 开机自启（2026-11-21）──────────────────────────────────────────────────────
{
  const { createAutostart } = await import('../app/autostart.js');
  // 打包版注册 TomoPet.exe --hidden；从源码跑注册 electron.exe <程序文件夹> --hidden。读和写用同一组路径和参数。
  const seen = [];
  const fakeApp = (packaged) => ({ isPackaged: packaged, getAppPath: () => 'D:/Projects/TomoPet', getLoginItemSettings: (o) => { seen.push(['get', o]); return { openAtLogin: fakeApp.on === true }; }, setLoginItemSettings: (o) => { seen.push(['set', o]); fakeApp.on = o.openAtLogin; } });
  const packed = createAutostart({ app: fakeApp(true), execPath: 'C:/TomoPet/TomoPet.exe', platform: 'win32' });
  assert.equal(packed.get(), false);
  assert.equal(packed.set(true), true);
  assert.deepEqual(seen.find((x) => x[0] === 'set')[1], { openAtLogin: true, path: 'C:/TomoPet/TomoPet.exe', args: ['--hidden'] });
  const dev = createAutostart({ app: fakeApp(false), execPath: 'D:/node_modules/electron/dist/electron.exe', platform: 'win32' });
  dev.set(false);
  assert.deepEqual(seen.at(-2)[1], { openAtLogin: false, path: 'D:/node_modules/electron/dist/electron.exe', args: ['D:/Projects/TomoPet', '--hidden'] });
  const linux = createAutostart({ app: fakeApp(true), platform: 'linux' });
  assert.deepEqual([linux.supported, linux.get(), linux.set(true)], [false, false, false]);
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('api: ok');
