/**
 * 开机自启（2026-11-21 用户：「加个开机自启选项」）：用 Electron 的登录项（Windows 上写进当前用户的启动项）。
 *
 * 开机时带 --hidden 启动：只待在托盘、不弹设置窗口，tosu 一开她就照样在看（app/main.js）。
 * 开没开着以系统里的为准（不另外存一份设置，免得两边对不上，比如在任务管理器的「启动」里被关掉了）。
 *
 * 打包版：TomoPet.exe --hidden。从源码跑（npm start）：electron.exe <程序文件夹> --hidden，不然开机拉起的是个空的 Electron。
 * Windows 认登录项时要路径和参数都一样，所以读和写用同一组。
 */
export function createAutostart({ app, execPath = process.execPath, platform = process.platform } = {}) {
  const supported = platform === 'win32' || platform === 'darwin';
  const opts = () => ({ path: execPath, args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'] });

  function get() {
    if (!supported) return false;
    try { return app.getLoginItemSettings(opts()).openAtLogin === true; } catch { return false; }
  }

  /** 打开 / 关掉。返回改完之后系统里的状态。 */
  function set(on) {
    if (!supported) return false;
    app.setLoginItemSettings({ openAtLogin: on === true, ...opts() });
    return get();
  }

  return { supported, get, set };
}
