/**
 * 设置：<数据目录>/config.json
 *
 *   · 读：任何字段缺了、类型不对、超范围，都回落 / 收敛到默认值（不抛）。
 *   · 改：只认白名单里的键 + 类型检查；写之前备份；API Key 交给 secretBox 加密（Electron 的 safeStorage）。
 *   · 给界面看的版本（publicConfig）里密钥只说「有没有」，不带值。
 *
 * 规则来源：SurfCore lib/osu/watch.js 的 osuWatchConfig / saveOsuWatchConfig（照搬收敛范围和本机地址限制）。
 */
import { backupFile, codedError, dataPath, isPlainObject, readJson, writeJsonAtomic } from './store.js';

export const DEFAULT_TOSU_URL = 'ws://127.0.0.1:24050/websocket/v2';

export const DEFAULTS = Object.freeze({
  watch: Object.freeze({
    enabled: true,
    url: DEFAULT_TOSU_URL,
    // 怎么说：subtitle = 屏幕下方一行字幕；bubble = 桌面角色头顶的气泡；none = 不出字，只念出来（要开 voice）。
    // 2026-11-22 用户给的默认值（截图）：头顶气泡、念出来、过程中也说、两句至少隔 10 秒、每首最多 10 句、每天最多 1000 句、难段提醒、每张图最多报 8 次
    output: 'bubble',
    voice: true,
    midPlay: true,
    minGapSec: 10,
    perSongMax: 10,
    dailyLimit: 1000,
    remember: true,
    // 难段预告（core/heads-up.js，2026-11-21）：off 不报 / voice 念一句短提示。默认开（2026-11-22 用户）。
    // 原来还有 viewers（只给 OBS 观众看），2026-11-22 用户说不需要，去掉了；老设置里的 viewers 读进来当 off。
    headsUp: 'voice',
    headsUpMax: 8,
  }),
  persona: Object.freeze({ name: '小鲸鱼', ownerName: '主人', ownerPronoun: '他' }),
  llm: Object.freeze({ provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' }),
  // 语音合成：provider 选哪一家（volc 火山 / breeze BreezeBlue 云端，2026-11-21 加）；speed 两家共用。
  tts: Object.freeze({ provider: 'volc', appId: '', accessKey: '', speaker: '', resourceId: '', speed: 1, breezeKey: '', breezeVoice: '', breezeInstructions: '' }),
  counter: Object.freeze({ enabled: true, tosuDir: '' }),
  // 默认皮肤：程序自带的 DeepSeek（女仆装）。没有它时 core/skins.js 自动换成第一套能用的。
  // hud：脚下的 pp 地台环（打图时显示，renderer/pp-ring.ts，2026-11-21）；hudCurve：环上画难度曲线；hudCurveStyle：画成一圈柱子（bars）还是一圈墙（wall）；
  // hudLayout：pp 那块字的样子，card 黑底卡片 / paper 浅色成绩条 / type 只有字 / line 环下面一行 / arc 沿着环；
  // hudInk：「只有字」的字色（light / dark）；hudFc：显示不显示「572 if FC」
  // 2026-11-22 用户给的默认值（截图）：难度曲线画成墙、不显示 if FC，其余照旧
  pet: Object.freeze({ enabled: true, skin: 'crosspet-deepseek', scale: 0.4, hud: true, hudCurve: true, hudCurveStyle: 'wall', hudLayout: 'card', hudInk: 'light', hudFc: false, x: null, y: null }),
  // 快慢的尺子（2026-11-19 用户给的：「240bpm 很快我点不动，140 这图 bpm 比较慢」「ar9 以上是普通，9 以下算慢」）。
  rulers: Object.freeze({ bpmVeryFast: 230, bpmVeryFastNote: '他自己说过 240 左右就点不动了', bpmFast: 200, bpmSlowMax: 150, arSlowBelow: 9, arFastAbove: 10 }),
  // osu! 官网 API（core/osu-api.js，2026-11-21 用户选「只用官方接口」）：查谱面的玩家标签（User Tags）。
  // 用户自己在 osu! 官网建的 OAuth 应用；没填就不查。
  osuApi: Object.freeze({ clientId: '', clientSecret: '' }),
  // 自动更新（core/updater.js，2026-11-22）：打开程序时和每隔 6 小时去 GitHub 看有没有新版本。
  update: Object.freeze({ autoCheck: true }),
});

/** 字段类型表：决定读的时候怎么收敛、改的时候怎么检查。 */
const SCHEMA = {
  watch: {
    enabled: { type: 'boolean' },
    url: { type: 'tosuUrl' },
    output: { type: 'enum', values: ['subtitle', 'bubble', 'none'] },
    voice: { type: 'boolean' },
    midPlay: { type: 'boolean' },
    minGapSec: { type: 'int', min: 10, max: 600 },
    perSongMax: { type: 'int', min: 0, max: 10 },
    dailyLimit: { type: 'int', min: 1, max: 1000 },
    remember: { type: 'boolean' },
    headsUp: { type: 'enum', values: ['off', 'voice'] },
    headsUpMax: { type: 'int', min: 1, max: 8 },
  },
  persona: {
    name: { type: 'string', max: 40, nonEmpty: true },
    ownerName: { type: 'string', max: 40, nonEmpty: true },
    ownerPronoun: { type: 'enum', values: ['他', '她', 'TA'] },
  },
  llm: {
    provider: { type: 'enum', values: ['openai', 'anthropic'] },
    baseUrl: { type: 'httpUrl', allowEmpty: true },
    model: { type: 'string', max: 120 },
    apiKey: { type: 'secret' },
  },
  tts: {
    provider: { type: 'enum', values: ['volc', 'breeze'] },
    appId: { type: 'string', max: 120 },
    accessKey: { type: 'secret' },
    speaker: { type: 'speaker' },
    resourceId: { type: 'string', max: 60, pattern: /^[A-Za-z0-9._-]*$/ },
    speed: { type: 'number', min: 0.5, max: 2 },
    breezeKey: { type: 'secret' },
    breezeVoice: { type: 'string', max: 80, pattern: /^[A-Za-z0-9._-]*$/ },
    breezeInstructions: { type: 'string', max: 200 },
  },
  counter: {
    enabled: { type: 'boolean' },
    tosuDir: { type: 'string', max: 400 },
  },
  pet: {
    enabled: { type: 'boolean' },
    skin: { type: 'string', max: 80, pattern: /^[A-Za-z0-9._-]+$/ },
    scale: { type: 'number', min: 0.1, max: 1.5 },
    hud: { type: 'boolean' },
    hudCurve: { type: 'boolean' },
    hudCurveStyle: { type: 'enum', values: ['bars', 'wall'] },
    hudLayout: { type: 'enum', values: ['card', 'paper', 'type', 'line', 'arc'] },
    hudInk: { type: 'enum', values: ['light', 'dark'] },
    hudFc: { type: 'boolean' },
    x: { type: 'coord' },
    y: { type: 'coord' },
  },
  rulers: {
    bpmVeryFast: { type: 'int', min: 60, max: 500 },
    bpmVeryFastNote: { type: 'string', max: 80 },
    bpmFast: { type: 'int', min: 60, max: 500 },
    bpmSlowMax: { type: 'int', min: 30, max: 500 },
    arSlowBelow: { type: 'number', min: 0, max: 11 },
    arFastAbove: { type: 'number', min: 0, max: 11 },
  },
  osuApi: {
    clientId: { type: 'string', max: 20, pattern: /^[0-9]*$/ },
    clientSecret: { type: 'secret' },
  },
  update: {
    autoCheck: { type: 'boolean' },
  },
};

export const CONFIG_FILE = () => dataPath('config.json');

/** 只允许连本机：这是读本机游戏状态的功能，不该被配置成去连别的机器。 */
export function isLocalTosuUrl(value) {
  try {
    const url = new URL(String(value));
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

const isHttpUrl = (value) => {
  try { const url = new URL(String(value)); return url.protocol === 'https:' || url.protocol === 'http:'; } catch { return false; }
};

/** 读的时候收敛一个值：不合格就用默认值。 */
function coerce(spec, value, fallback) {
  switch (spec.type) {
    case 'boolean': return typeof value === 'boolean' ? value : fallback;
    case 'enum': return spec.values.includes(value) ? value : fallback;
    case 'int': {
      const n = Math.round(Number(value));
      return value !== null && value !== '' && Number.isFinite(n) ? Math.min(spec.max, Math.max(spec.min, n)) : fallback;
    }
    case 'number': {
      const n = Number(value);
      return value !== null && value !== '' && Number.isFinite(n) ? Math.min(spec.max, Math.max(spec.min, n)) : fallback;
    }
    case 'coord': return value === null || value === undefined ? null : (Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback);
    case 'tosuUrl': return isLocalTosuUrl(value) ? String(value) : fallback;
    case 'httpUrl': return typeof value === 'string' && (isHttpUrl(value) || (spec.allowEmpty && value === '')) ? value.replace(/\/+$/, '') : fallback;
    case 'speaker': return typeof value === 'string' && /^[A-Za-z0-9._-]{0,120}$/.test(value) ? value : fallback;
    case 'string': {
      if (typeof value !== 'string') return fallback;
      const text = value.trim().slice(0, spec.max);
      if (spec.nonEmpty && !text) return fallback;
      if (spec.pattern && !spec.pattern.test(text)) return fallback;
      return text;
    }
    case 'secret': return isPlainObject(value) || typeof value === 'string' ? value : fallback;
    default: return fallback;
  }
}

/** 磁盘上的样子 → 收敛过的完整设置（密钥还是存储形式，没解密）。 */
export function normalizeConfig(raw = {}) {
  const src = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const [section, fields] of Object.entries(SCHEMA)) {
    const given = isPlainObject(src[section]) ? src[section] : {};
    out[section] = {};
    for (const [key, spec] of Object.entries(fields)) out[section][key] = coerce(spec, given[key], DEFAULTS[section][key]);
  }
  // 老设置里的难段预告「只给观众看」（viewers，2026-11-22 去掉了）：那时选它的人不要给自己念提醒，读进来当关。
  // 原来靠「不认识的值退回默认（关）」；默认改成「给我提个醒」以后得明着写
  if (isPlainObject(src.watch) && src.watch.headsUp === 'viewers') out.watch.headsUp = 'off';
  return out;
}

/** 不加密的盒子（测试、或者系统不支持加密时用）。存成 { plain }，界面上会提示「没加密」。 */
export const plainSecretBox = Object.freeze({
  available: false,
  seal: (text) => ({ plain: String(text) }),
  open: (stored) => (typeof stored === 'string' ? stored : isPlainObject(stored) && typeof stored.plain === 'string' ? stored.plain : ''),
});

/**
 * Electron safeStorage 包一层：存成 { enc: 'safe', data: base64 }。解不开（换了电脑 / 换了用户）就当没填。
 * @param {{isEncryptionAvailable():boolean, encryptString(s:string):Buffer, decryptString(b:Buffer):string}} safeStorage
 */
export function safeStorageBox(safeStorage) {
  const available = (() => { try { return safeStorage.isEncryptionAvailable() === true; } catch { return false; } })();
  if (!available) return plainSecretBox;
  return {
    available: true,
    seal: (text) => ({ enc: 'safe', data: safeStorage.encryptString(String(text)).toString('base64') }),
    open: (stored) => {
      if (isPlainObject(stored) && stored.enc === 'safe' && typeof stored.data === 'string') {
        try { return safeStorage.decryptString(Buffer.from(stored.data, 'base64')); } catch { return ''; }
      }
      return plainSecretBox.open(stored);
    },
  };
}

/**
 * @param {object} [opts]
 * @param {object} [opts.secretBox]  加密方式（默认不加密）
 * @param {() => number} [opts.now]
 */
export function createConfigStore({ secretBox = plainSecretBox, now = Date.now } = {}) {
  function readRaw() {
    const raw = readJson(CONFIG_FILE(), {});
    return isPlainObject(raw) ? raw : null;
  }

  /** 完整设置，密钥已解密成明文（只给服务内部用，别发给界面）。 */
  function get() {
    const cfg = normalizeConfig(readRaw() ?? {});
    cfg.llm.apiKey = secretBox.open(cfg.llm.apiKey);
    cfg.tts.accessKey = secretBox.open(cfg.tts.accessKey);
    cfg.tts.breezeKey = secretBox.open(cfg.tts.breezeKey);
    cfg.osuApi.clientSecret = secretBox.open(cfg.osuApi.clientSecret);
    return cfg;
  }

  /** 给界面看：密钥换成 { set: true/false }。 */
  function publicView() {
    const cfg = get();
    return {
      ...cfg,
      llm: { ...cfg.llm, apiKey: undefined, hasApiKey: Boolean(cfg.llm.apiKey) },
      tts: { ...cfg.tts, accessKey: undefined, hasAccessKey: Boolean(cfg.tts.accessKey), breezeKey: undefined, hasBreezeKey: Boolean(cfg.tts.breezeKey) },
      osuApi: { ...cfg.osuApi, clientSecret: undefined, hasClientSecret: Boolean(cfg.osuApi.clientSecret) },
      secretsEncrypted: secretBox.available === true,
    };
  }

  /**
   * 改设置：patch 形如 { watch: { enabled: true }, llm: { apiKey: 'sk-…' } }。
   * 不认识的段 / 键、类型不对、值不合格 → 抛 config.invalid（一个字都不写）。密钥传空串表示清掉。
   */
  function save(patch = {}) {
    if (!isPlainObject(patch)) throw codedError('config.invalid', '设置必须是一个对象', '只传要改的那几项，比如 { watch: { enabled: true } }。');
    const clean = {};
    for (const [section, fields] of Object.entries(patch)) {
      const schema = SCHEMA[section];
      if (!schema) throw codedError('config.invalid', `不认识的设置段：${section}`, `支持：${Object.keys(SCHEMA).join(' / ')}。`);
      if (!isPlainObject(fields)) throw codedError('config.invalid', `${section} 必须是一个对象`, '比如 { watch: { enabled: true } }。');
      for (const [key, value] of Object.entries(fields)) {
        const spec = schema[key];
        if (!spec) throw codedError('config.invalid', `不认识的设置项：${section}.${key}`, `支持：${Object.keys(schema).join(' / ')}。`);
        clean[section] ??= {};
        clean[section][key] = validate(section, key, spec, value);
      }
    }
    if (!Object.keys(clean).length) return { changed: false, backup: null };
    const raw = readRaw();
    if (raw === null) throw codedError('config.unreadable', 'config.json 不是一个对象，没有改动它', `先检查 ${CONFIG_FILE()} 的内容（或者删掉它，用默认设置重来）。`);
    const next = { ...raw };
    for (const [section, fields] of Object.entries(clean)) next[section] = { ...(isPlainObject(raw[section]) ? raw[section] : {}), ...fields };
    const backup = backupFile(CONFIG_FILE(), 'config', { now });
    writeJsonAtomic(CONFIG_FILE(), next);
    return { changed: true, backup };
  }

  function validate(section, key, spec, value) {
    const bad = (hint) => { throw codedError('config.invalid', `${section}.${key} 的值不对`, hint); };
    switch (spec.type) {
      case 'boolean': if (typeof value !== 'boolean') bad('传 true 或 false。'); return value;
      case 'enum': if (!spec.values.includes(value)) bad(`只能是 ${spec.values.join(' / ')}。`); return value;
      case 'int': case 'number': if (value === null || value === '' || !Number.isFinite(Number(value))) bad('填一个数字。'); return coerce(spec, value, 0);
      case 'coord': if (value !== null && !Number.isFinite(Number(value))) bad('填一个数字或 null。'); return value === null ? null : Math.round(Number(value));
      case 'tosuUrl':
        if (!isLocalTosuUrl(value)) throw codedError('osu.url-not-local', 'tosu 的地址只能是本机', `用默认的 ${DEFAULT_TOSU_URL}，或者 127.0.0.1 上的别的端口。`);
        return String(value);
      case 'httpUrl':
        if (typeof value !== 'string' || !(isHttpUrl(value) || (spec.allowEmpty && value === ''))) bad('填一个 http:// 或 https:// 开头的地址。');
        return value.replace(/\/+$/, '');
      case 'speaker': if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{0,120}$/.test(value)) bad('音色 ID 只能有字母、数字、下划线、点和连字符。'); return value;
      case 'string': {
        if (typeof value !== 'string') bad('填一段文字。');
        const text = value.trim();
        if (text.length > spec.max) bad(`最多 ${spec.max} 个字。`);
        if (spec.nonEmpty && !text) bad('不能是空的。');
        if (spec.pattern && !spec.pattern.test(text)) bad('只能有字母、数字、下划线、点和连字符。');
        return text;
      }
      case 'secret':
        if (typeof value !== 'string') bad('填一段文字。');
        return value.trim() ? secretBox.seal(value.trim()) : '';
      default: return bad('不支持的类型。');
    }
  }

  return { get, publicView, save, secretsEncrypted: secretBox.available === true };
}
