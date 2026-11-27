/**
 * 设置窗口能调的所有操作（白名单）。页面经 preload 的 api.call(name, payload) 进来，这里分发。
 *
 * 规矩：
 *   · 每个操作都返回 { ok:true, … } 或 { ok:false, code, error, hint }——不抛给页面，页面必须把失败显示出来。
 *   · 返回值里不带任何密钥（设置用 publicView）。
 *   · 这个文件不 import electron：打开文件夹、选文件夹、复制这些由 shell 参数传进来，测试可以塞假的。
 */
import fs from 'node:fs';
import { failureOf, codedError } from '../core/store.js';

/** osu! 官网建 OAuth 应用的地方（设置「高级」里的按钮打开它）。 */
export const OSU_OAUTH_PAGE = 'https://osu.ppy.sh/home/account/edit#oauth';
import { nextSteps } from '../core/next-step.js';
import { RELEASES_PAGE } from '../core/updater.js';
import { PROVIDER_PRESETS } from '../core/llm.js';

// 试听这句里带一个「还」（读 hái）：一听就知道多音字换得对不对（2026-11-21 用户：「还」被念成「孩儿」）。
const TTS_SAMPLE = '这张图 4.8 星，准确率 97.4%，还打得不错嘛。';

/**
 * @param {object} deps
 * @param {object} deps.configStore   core/config.js 的 createConfigStore()
 * @param {object} deps.service       core/watch.js 的服务
 * @param {object} deps.llm
 * @param {object} deps.tts
 * @param {object} deps.overlay       放「试听」的声音
 * @param {object} deps.pet           桌面角色窗口
 * @param {object} deps.skins         { listSkins, importSkin }
 * @param {object} deps.shell         { openPath(path), pickFolder(title) → string|'' , copyText(text), openExternal(url) }
 * @param {object} deps.info          { version, dataDir, personaFile, rendererBuilt(), logoFound(), logoUrl }
 * @param {object} [deps.autostart]   { supported, get(), set(on) }：开机自启（app/autostart.js）
 * @param {object} [deps.updater]     core/updater.js 的 createUpdater()：自动更新
 */
export function createApi({ configStore, service, llm, tts, overlay, pet, skins, shell, info, autostart = null, osuApi = null, updater = null, onConfigChanged = () => {}, log = () => {} }) {
  function state() {
    const status = service.status();
    const config = configStore.publicView();
    return {
      ok: true,
      status,
      config,
      presets: PROVIDER_PRESETS,
      skins: skins.listSkins().map(({ dir: _dir, ...skin }) => skin),
      nextSteps: nextSteps(status, { rendererBuilt: info.rendererBuilt(), secretsEncrypted: config.secretsEncrypted, logoFound: info.logoFound() }),
      app: { version: info.version, dataDir: info.dataDir, personaFile: info.personaFile, logoUrl: info.logoFound() ? info.logoUrl : '', autostart: autostartState(), update: updater ? updater.status() : null },
    };
  }

  /** 开机自启：系统里开没开着（读不了就当没开）。 */
  function autostartState() {
    if (!autostart || !autostart.supported) return { supported: false, on: false };
    try { return { supported: true, on: autostart.get() === true }; } catch { return { supported: true, on: false }; }
  }

  const actions = {
    // 开机自启的开关（「高级」页）：开机后只待在托盘，不弹设置窗口。
    'app.autostart': async ({ on } = {}) => {
      if (typeof on !== 'boolean') throw codedError('api.bad-argument', '没说开还是关', '这是程序的问题：设置页面发来的请求不完整，重开程序。');
      if (!autostart || !autostart.supported) throw codedError('app.autostart-unsupported', '这台电脑上不支持开机自启', '只有 Windows 和 macOS 上能用。');
      let now;
      try { now = autostart.set(on); } catch (error) { throw codedError('app.autostart-failed', `改开机自启没成功：${String(error?.message ?? error).slice(0, 120)}`, '可能被安全软件拦了；也可以在任务管理器的「启动应用」里手动开关。'); }
      if (now !== on) throw codedError('app.autostart-failed', on ? '开机自启没打开' : '开机自启没关掉', '可能被安全软件或系统策略拦了；去任务管理器的「启动应用」里看看。');
      log(`[app] 开机自启${on ? '打开' : '关掉'}了`);
      return { ...state(), autostart: now };
    },

    state: async () => state(),

    'config.save': async ({ patch } = {}) => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw codedError('config.invalid', '没说要改哪一项', '这是程序的问题：设置页面发来的请求不完整，重开程序。');
      const saved = configStore.save(patch);
      if (saved.changed) onConfigChanged();
      return { ...state(), changed: saved.changed };
    },

    'watch.test': async () => { const result = await service.act({ action: 'test' }); return { ...state(), said: result.said }; },
    'counter.sync': async () => { const result = await service.act({ action: 'counter-sync' }); return { ...state(), counterSynced: result.counterSynced }; },
    'plays.clear': async () => { await service.act({ action: 'clear-plays' }); return state(); },
    // 「她最近说的」：再听一遍那句的声音；清空这个列表
    'said.replay': async ({ id } = {}) => { await service.act({ action: 'replay', id: String(id ?? '').slice(0, 40) }); return state(); },
    'said.clear': async () => { await service.act({ action: 'clear-said' }); return state(); },

    // 模型「测试」：真的发一次请求，看 Key、地址、模型名对不对。
    'llm.test': async () => {
      const startedAt = Date.now();
      const result = await llm.complete({ system: '你在帮人测试接口通不通。', user: '只回两个字：收到', maxTokens: 50 });
      return { ok: true, text: result.text.slice(0, 80), model: result.model, ms: Date.now() - startedAt, tokens: result.usage.input + result.usage.output };
    },

    // 语音「试听」：真的合成一句（里面有小数和百分号，顺便听数字念得对不对），用字幕窗口放出来。
    'tts.test': async () => {
      const result = await tts.synthesize(TTS_SAMPLE);
      overlay.say({ text: TTS_SAMPLE, audio: result.bytes, ms: (result.durationMs || 5000) + 1500, hidden: false });
      return { ok: true, durationMs: result.durationMs, cached: result.cached, text: TTS_SAMPLE };
    },

    // Breeze 的官方普通话音色（设置「语音」里挑）。
    'tts.voices': async () => ({ ok: true, voices: await tts.listVoices() }),

    // osu! 官网 OAuth 应用「试一下」：拿一次令牌（core/osu-api.js，查玩家标签用）。
    'osuapi.test': async () => {
      if (!osuApi) throw codedError('osuapi.unavailable', '这个版本没有接 osu! 官网', '重开程序试试。');
      await osuApi.test();
      return { ok: true };
    },

    'skin.import': async () => {
      const folder = await shell.pickFolder('选一个皮肤文件夹（里面直接有 manifest.json）');
      if (!folder) return { ok: true, canceled: true };
      const result = skins.importSkin(folder);
      if (!result.ok) return result;
      // 导入完直接换上。
      configStore.save({ pet: { skin: result.id } });
      onConfigChanged();
      return { ...state(), imported: { id: result.id, name: result.name, replaced: result.replaced, warnings: result.warnings } };
    },

    'tosu.pickDir': async () => {
      const folder = await shell.pickFolder('选 tosu.exe 所在的文件夹');
      if (!folder) return { ok: true, canceled: true };
      if (!fs.existsSync(`${folder}/tosu.exe`) && !fs.existsSync(`${folder}/tosu`)) throw codedError('osu.counter-bad-dir', '这个文件夹里没有 tosu.exe', '选 tosu.exe 所在的那个文件夹（不是它的 static 文件夹）。');
      configStore.save({ counter: { tosuDir: folder } });
      onConfigChanged();
      return state();
    },

    // 自动更新（「高级」页）：查一次；有新版本时「更新」在后台下载、装好后程序自己重开
    'update.check': async () => {
      if (!updater) throw codedError('update.unavailable', '这个版本没有自动更新', '去 GitHub 的发布页看看有没有新版本。');
      await updater.check({ manual: true });
      return state();
    },
    'update.install': async () => {
      if (!updater) throw codedError('update.unavailable', '这个版本没有自动更新', '去 GitHub 的发布页看看有没有新版本。');
      updater.startInstall();
      return state();
    },

    'persona.open': async () => { await shell.openPath(info.personaFile); return { ok: true }; },
    'data.open': async () => { await shell.openPath(info.dataDir); return { ok: true }; },
    'skins.open': async () => { fs.mkdirSync(skins.userSkinsDir(), { recursive: true }); await shell.openPath(skins.userSkinsDir()); return { ok: true }; },
    'clipboard.copy': async ({ text } = {}) => { shell.copyText(String(text ?? '').slice(0, 500)); return { ok: true }; },
    'pet.recenter': async () => ({ ok: true, moved: pet.recenter() }),
    'pet.command': async ({ command } = {}) => { if (!['blink', 'talk', 'pat', 'poke', 'hop'].includes(command)) throw codedError('api.bad-argument', '不认识的动作', '只支持 blink / talk / pat / poke / hop。'); pet.command(command); return { ok: true }; },

    // 只开本机 tosu 的页面和 tosu 的下载页，别的地址一律不开。
    'external.open': async ({ url } = {}) => {
      const target = String(url ?? '');
      const allowed = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(target) || target === 'https://github.com/tosuapp/tosu/releases' || target === OSU_OAUTH_PAGE
        || target === RELEASES_PAGE || target.startsWith(`${RELEASES_PAGE}/`);
      if (!allowed) throw codedError('api.bad-argument', '这个地址不在允许打开的范围里', '只能打开本机 tosu 的页面、tosu 的下载页、osu! 官网的 OAuth 设置页和本程序的发布页。');
      await shell.openExternal(target);
      return { ok: true };
    },
  };

  /** 页面调进来的唯一入口。永远返回对象，不抛。 */
  async function call(name, payload) {
    const action = Object.hasOwn(actions, name) ? actions[name] : null;
    if (!action) return { ok: false, code: 'api.unknown', error: `不认识的操作：${String(name).slice(0, 40)}`, hint: '这是程序的问题：设置页面和主程序的版本对不上，重开程序。' };
    try {
      const result = await action(payload ?? {});
      return result && typeof result === 'object' ? result : { ok: true };
    } catch (error) {
      const failure = failureOf(error, '看日志（托盘菜单 → 打开数据文件夹 → logs）。');
      if (name !== 'state') log(`[api] ${name} 失败（${failure.code}）：${failure.error}`);
      return failure;
    }
  }

  return { call, state, names: Object.keys(actions) };
}
