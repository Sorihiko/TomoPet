/**
 * 桌面角色窗口的入口。打包成 dist/pet-renderer.js，由 app/pet/index.html 加载。
 *
 * 和主进程之间走 preload 提供的 window.petHost：
 *   getSkin() → { baseUrl, scale }        皮肤目录的地址和现在的缩放
 *   setInteractive(bool)                   鼠标在不在她身上（不在时窗口点击穿透）
 *   dragStart() / dragEnd()                按住拖动（主进程跟着鼠标挪窗口）
 *   openMenu()                             右键菜单
 *   onCommand(cb) / onSpeak(cb) / onScale(cb)
 *   log(text) / fatal(text)
 *
 * 鼠标交互照 feiyu-pet 的 src/renderer/index.ts：身上才能点、拖过 4 像素算拖动、在头上来回蹭算摸摸、点一下按区域的手势走。
 */
import { loadManifest, makeRig, showFatal, type AnyRig } from './boot';
import { createBubble } from './bubble';
import { createPpRing, type HudData } from './pp-ring';
import type { Manifest, Region } from './rig';

const DRAG_THRESHOLD = 4;
const STROKE_WINDOW = 700;
const STROKE_TRIGGER = 240;
const PAT_COOLDOWN = 1600;

interface PetHost {
  getSkin(): Promise<{ baseUrl: string; scale: number; playing?: boolean; footroom?: number; curveStyle?: string; hudLayout?: string; hudInk?: string; hudFc?: boolean }>;
  setInteractive(on: boolean): void;
  dragStart(): void;
  dragEnd(): void;
  openMenu(): void;
  zoom(steps: number): void;
  onCommand(cb: (cmd: string) => void): void;
  onSpeak(cb: (line: { text: string; durationMs: number; bubble: boolean; mouth?: string }) => void): void;
  onScale(cb: (scale: number) => void): void;
  onHud?(cb: (data: HudData) => void): void;
  onFootroom?(cb: (px: number) => void): void;
  onHudCurve?(cb: (curve: number[] | null) => void): void;
  hudReady?(): void;
  log(text: string): void;
  fatal(text: string): void;
}

async function boot() {
  const host = (window as any).petHost as PetHost;
  const skin = await host.getSkin();
  const manifest: Manifest = await loadManifest(skin.baseUrl);
  const rig: AnyRig = makeRig(manifest, skin.baseUrl);
  if (typeof skin.scale === 'number') rig.scale = skin.scale;
  // 脚下的 pp 地台环开着时，窗口底下多留了一截（app/pet-window.js FOOT_ROOM）：渲染器 layout 时扣掉，脚贴在留白上面
  const footroom = Math.max(0, Number(skin.footroom) || 0);
  (window as any).__tomopetFootroom = footroom;
  await rig.init(document.body);
  const ring = footroom > 0 ? createPpRing(() => rig, () => manifest) : null;
  // 难度曲线画成柱子还是墙（设置 pet.hudCurveStyle；改了会重开窗口）
  ring?.setCurveStyle(skin.curveStyle);
  // pp 那行字的摆法、「572 if FC」显示不显示（设置 pet.hudLayout / pet.hudFc；改了会重开窗口）
  ring?.setLabelLayout(skin.hudLayout);
  ring?.setLabelInk(skin.hudInk);
  ring?.setShowFc(skin.hudFc !== false);

  const bubble = createBubble(document.getElementById('bubble')!, () => rig, () => manifest);
  let talkTimer: ReturnType<typeof setTimeout> | undefined;

  let pressed = false;
  let dragging = false;
  let moved = false;
  let interactive = false;
  let downAt = { x: 0, y: 0 };
  let downRegion: Region | null = null;
  let last = { x: 0, y: 0 };
  let strokeAccum = 0;
  let strokeStart = 0;
  let lastPatAt = 0;

  const setCursor = (c: string) => { document.body.style.cursor = c; };
  const setInteractive = (on: boolean) => {
    if (on === interactive) return;
    interactive = on;
    host.setInteractive(on);
  };
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    rig.setDragging(false);
    host.dragEnd();
  };

  window.addEventListener('pointermove', (e) => {
    rig.setPointer(e.clientX, e.clientY);
    const now = performance.now();
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    if (pressed && !dragging && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > DRAG_THRESHOLD) {
      dragging = true;
      moved = true;
      rig.setDragging(true);
      setCursor('grabbing');
      host.dragStart();
    }
    if (dragging) return;
    const hit = rig.hitTest(e.clientX, e.clientY);
    // 只有她身上能点；别的地方点击直接穿到下面的窗口。
    setInteractive(hit || pressed);
    if (!hit) {
      setCursor('');
      strokeAccum = 0;
      rig.setHeadHover(false);
      return;
    }
    setCursor(rig.cursorAt(e.clientX, e.clientY) ?? 'pointer');
    const region = rig.regionAt(e.clientX, e.clientY);
    rig.setHeadHover(rig.regionHoverClosesEyes(region));
    if (region?.gesture === 'pat') {
      if (now - strokeStart > STROKE_WINDOW) { strokeAccum = 0; strokeStart = now; }
      strokeAccum += Math.abs(dx) + Math.abs(dy);
      if (strokeAccum > STROKE_TRIGGER && now - lastPatAt > PAT_COOLDOWN) {
        lastPatAt = now;
        strokeAccum = 0;
        rig.playCommand('pat');
      }
    } else {
      strokeAccum = 0;
    }
  });

  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !rig.hitTest(e.clientX, e.clientY)) return;
    // 拖动时窗口一直在动，鼠标很容易跑到窗口外：捕获指针，pointerup 才收得到。
    try { document.body.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    pressed = true;
    moved = false;
    downAt = { x: e.clientX, y: e.clientY };
    last = { x: e.clientX, y: e.clientY };
    downRegion = rig.regionAt(e.clientX, e.clientY);
  });

  window.addEventListener('pointerup', (e) => {
    try { document.body.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
    if (!pressed) return;
    pressed = false;
    if (dragging) {
      endDrag();
      setCursor(rig.cursorAt(last.x, last.y) ?? '');
    } else if (!moved) {
      if (downRegion?.sound) rig.playSound(downRegion.sound);
      rig.playCommand(downRegion?.gesture ?? 'poke');
    }
    downRegion = null;
    setInteractive(rig.hitTest(last.x, last.y));
  });

  window.addEventListener('pointercancel', () => { pressed = false; endDrag(); });
  window.addEventListener('blur', () => { pressed = false; endDrag(); });
  document.addEventListener('mouseleave', () => {
    if (pressed) return;
    setInteractive(false);
    rig.setHeadHover(false);
    setCursor('');
  });
  // Ctrl+滚轮：在她身上滚就调大小（往上变大）。触控板一次给的量小，攒够一格（100）才算一下。
  // 不在她身上时窗口是点击穿透的，滚轮本来就到不了这里；Ctrl+滚轮一律拦下，免得页面自己缩放。
  let wheelAccum = 0;
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (dragging || !rig.hitTest(e.clientX, e.clientY)) { wheelAccum = 0; return; }
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1;
    wheelAccum += -e.deltaY * unit;
    const steps = Math.trunc(wheelAccum / 100);
    if (!steps) return;
    wheelAccum -= steps * 100;
    host.zoom(steps);
  }, { passive: false });
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (rig.hitTest(e.clientX, e.clientY)) host.openMenu();
  });

  host.onScale((scale) => { rig.setScale(scale); ring?.layout(); });
  host.onHud?.((data) => ring?.update(data));
  host.onHudCurve?.((curve) => ring?.setCurve(curve));
  // 改大小时脚下留白跟着变（主进程先发留白、再发缩放）
  host.onFootroom?.((px) => { (window as any).__tomopetFootroom = Math.max(0, Number(px) || 0); });
  if (ring) host.hudReady?.();
  host.onCommand((cmd) => { try { rig.playCommand(cmd); } catch { /* 不认识的命令忽略 */ } });
  // 窗口是打图中重开的（换了皮肤）：取皮肤时顺带拿到了「在打图」，现在收命令的口子接好了，补上。
  if ((skin as any).playing) { try { rig.playCommand('play-on'); } catch { /* 忽略 */ } }
  // 她开口了：张嘴到这句话说完；气泡模式在头顶冒气泡。
  host.onSpeak((line) => {
    const ms = Math.max(900, Math.min(60_000, Number(line.durationMs) || 2000));
    // 口型轨（有张嘴图的皮肤用，别的渲染器没有这个方法）
    // 没带口型轨（老版本的主进程）就不给，渲染器按固定节奏假装说；给了空串反而会一直闭嘴。
    if (typeof line.mouth === 'string' && line.mouth) (rig as any).setMouthTrack?.(line.mouth);
    rig.playCommand('talk-start');
    clearTimeout(talkTimer);
    talkTimer = setTimeout(() => rig.playCommand('talk-stop'), ms);
    if (line.bubble && line.text) bubble.show(String(line.text), ms);
  });

  const w = window as any;
  w.__rig = rig;
  w.__skin = manifest;
  w.__ring = ring;
  host.log(`skin loaded: ${manifest.name} (${(manifest as any).rig})`);
}

boot().catch((error) => {
  showFatal(error);
  try { (window as any).petHost?.fatal(String(error?.message ?? error)); } catch { /* 忽略 */ }
});
