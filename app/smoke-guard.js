/**
 * 离屏自检（app/smoke.js）的隔离：自检只许碰临时的东西，不许碰真的 tosu、真的 osu!、真的数据目录。
 * 纯函数，不依赖 Electron（test/smoke-guard.test.mjs 直接测）。
 *
 * 为什么（2026-11-20 复核发现）：自检把整个程序跑起来，原来
 *   · 「看你打 osu!」默认开着，会连上正在跑的真 tosu（ws://127.0.0.1:24050），一边自检一边点评你正在打的那把；
 *   · 连上后同步 OBS 页面：自己去找正在跑的 tosu.exe，把自检用的皮肤拷进真的 static/fatfish-osu，
 *     你 OBS 里的角色被换掉；
 *   · 没设 OSU_PET_HOME 时用的是真的数据目录，「say」那一步会把模型设置改成假的服务和假 Key。
 */

// 一个肯定连不上的本机地址（端口 1 没人监听）：自检里「看你打 osu!」照常跑，只是永远连不上。
export const SMOKE_TOSU_URL = 'ws://127.0.0.1:1/websocket/v2';

/** 自检时程序读到的设置：tosu 地址换成连不上的，OBS 页面关掉。别的照原样（自检要测它们）。 */
export function isolateConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  return {
    ...c,
    watch: { ...(c.watch || {}), url: SMOKE_TOSU_URL },
    counter: { ...(c.counter || {}), enabled: false, tosuDir: '' },
  };
}

/** 自检时给 OBS 页面用的「找 tosu」：永远找不到（不去看正在跑的 tosu.exe）。 */
export const findNoTosu = async () => '';

/** 能不能开始自检：必须用临时数据目录。不行返回 { ok:false, code, error, hint }。 */
export function smokePreflight(env = {}) {
  if (!env.OSU_PET_SMOKE) return { ok: true, smoke: false };
  if (!String(env.OSU_PET_HOME || '').trim()) {
    return {
      ok: false,
      code: 'smoke.no-home',
      error: '离屏自检必须指定临时数据目录（OSU_PET_HOME），不然会改掉你真的设置（模型 Key 会被换成假的）',
      hint: '这样跑：OSU_PET_HOME=<临时文件夹> OSU_PET_SMOKE=<输出文件夹> npx electron .',
    };
  }
  return { ok: true, smoke: true };
}
