/**
 * 本地字幕窗口：屏幕下方居中出一行字（可以同时放一段语音），放完就藏起来。
 *
 * 用户试过气泡后说：「做成视频字幕那样的，不要冒气泡，太影响注意力了」「想让她说话有语音」。
 * 窗口参数照搬 SurfCore lib/osu/overlay/main.cjs：
 *   · 透明、无边框、置顶；鼠标点不到它（点击直接穿过去）；不进任务栏；永远不拿焦点——不能把正在打的游戏切走。
 *   · 没有字幕的时候窗口是藏起来的。要说第一句话时才建，之后留着复用；功能关掉时收掉。
 * 和 SurfCore 不同的地方：那边是另外拉一个 Electron 子进程、走进程间消息；这里本来就在 Electron 里，直接开窗口。
 *
 * 限制：osu! 用「全屏独占」时，任何别的窗口都盖不上去，字幕看不到（声音照常）。窗口化 / 无边框没问题。
 * 「不显示字幕 / 气泡」时也用它放声音（hidden：不出字；它本来就透明、点不到，看不见）。
 *
 * 这个文件不直接 import electron：要用的东西从参数传进来，测试可以塞假的。
 */
import { codedError } from '../core/store.js';

/**
 * @param {object} opts
 * @param {any} opts.BrowserWindow
 * @param {any} opts.screen
 * @param {string} opts.pageUrl       字幕页面的地址
 * @param {string} opts.preload       preload 脚本的路径
 */
export function createOverlayWindow({ BrowserWindow, screen, pageUrl, preload, log = () => {} } = {}) {
  let win = null;
  let ready = false;
  let nextId = 1;
  let lastError = null;
  let queue = [];

  function place() {
    const area = screen.getPrimaryDisplay().bounds;
    // 按屏幕高度缩放：1080p 上字是 30px，4K 上跟着变大。
    const scale = Math.min(2.4, Math.max(0.8, area.height / 1080));
    const width = Math.round(area.width * 0.84);
    const height = Math.round(200 * scale);
    win.setBounds({ x: area.x + Math.round((area.width - width) / 2), y: area.y + area.height - height - Math.round(area.height * 0.07), width, height });
    return scale;
  }

  function show(message) {
    if (!win || win.isDestroyed()) return;
    const scale = place();
    win.showInactive();
    // 有些全屏 / 无边框程序会把自己重新顶到最上面：每次出字幕都再顶一次。
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.send('overlay:say', { ...message, scale });
  }

  function fail(reason) {
    lastError = { code: 'overlay.failed', error: `字幕窗口出错：${String(reason).slice(0, 120)}`, hint: '下一句会重新开字幕窗口；一直这样就把「怎么说」改成气泡，并把日志发给开发者。' };
    log('[overlay] 出错：', String(reason).slice(0, 160));
  }

  function ensure() {
    if (win && !win.isDestroyed()) return;
    ready = false;
    queue = [];
    const created = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win = created;
    created.setAlwaysOnTop(true, 'screen-saver');
    created.setIgnoreMouseEvents(true);
    created.setMenu?.(null);
    created.on('closed', () => { if (win === created) { win = null; ready = false; } });
    created.webContents.on('render-process-gone', (_event, details) => { fail(`页面进程没了（${details?.reason ?? '未知原因'}）`); try { created.destroy(); } catch {} });
    created.webContents.once('did-finish-load', () => {
      if (win !== created) return;
      ready = true;
      for (const message of queue.splice(0)) show(message);
    });
    Promise.resolve(created.loadURL(pageUrl)).catch((error) => { fail(error?.message ?? error); try { created.destroy(); } catch {} });
  }

  /**
   * 出一行字幕（可以带一段语音）。窗口还没准备好也没关系，先排着。
   * @param {{text:string, audio?:Buffer|null, ms?:number, hidden?:boolean}} line   hidden：不出字，只放声音
   */
  function say({ text, audio = null, ms = 4000, hidden = false } = {}) {
    try {
      ensure();
    } catch (error) {
      fail(error?.message ?? error);
      throw codedError('overlay.failed', `字幕窗口开不了：${String(error?.message ?? error).slice(0, 120)}`, lastError.hint);
    }
    const id = nextId++;
    const message = { id, text: String(text ?? ''), ms: Math.round(Number(ms) || 4000), hidden: hidden === true, audio: audio ? Buffer.from(audio).toString('base64') : '' };
    if (ready) show(message);
    else queue.push(message);
    lastError = null;
    return { ok: true, id };
  }

  /** 页面说「这一句放完了」：把窗口藏起来（除非这期间又来了新的一句——页面只会为最新的那句发 done）。 */
  function done(id) {
    if (win && !win.isDestroyed() && id === nextId - 1) win.hide();
  }

  function stop() {
    const old = win;
    win = null;
    ready = false;
    queue = [];
    if (old && !old.isDestroyed()) { try { old.destroy(); } catch {} }
  }

  function status() {
    return { running: Boolean(win && !win.isDestroyed()), ready, lastError };
  }

  return { say, done, stop, status };
}
