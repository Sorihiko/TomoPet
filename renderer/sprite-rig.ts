/**
 * 姿势皮肤（rig: "sprite"）的渲染器：一张图一个姿势，按游戏时刻换姿势。桌面角色窗口和 OBS 页面共用（boot.ts makeRig）。
 *
 * 为什么要它（2026-11-20）：CrossPet（github.com/lokicorvus/crosspet）给每个角色画了约 60 张姿势（开心、呜哇、晕、喝水、生气……），
 * 正好对得上 osu! 的时刻。它们是静态图，没有张嘴的帧，所以不走分图层的 PetRig，也不走放动态图片段的 VideoRig。
 *
 * 做的事：
 *   · 每张姿势图一个（预载时已经解码好的）<img>，换姿势时新图叠在旧图上面淡入、旧图先保持不透明，新图出来了再把旧图淡掉
 *     （2026-11-21 用户：挂机时她换个动作就闪一下。原来两张同时一个淡出一个淡入，中间那一刻两张都半透明、透出后面的桌面，
 *     而且换图时临时改 src 还要重新解码）；图片按 object-fit: contain 底边居中放进画布，宽窄不一的姿势不会被拉伸；
 *   · 整个人的小动作（上下浮、跳、摇、抖、晕……）是 CSS 动画，动作的写法改编自 CrossPet app/web/index.html（MIT）；
 *   · 说话时：皮肤有口型（sprite.mouth，scripts/mouths/ 做的只有嘴的叠加图）就在主图上按口型轨换嘴（闭 / 半张 / 张大）；
 *     没有口型的皮肤整个人轻轻快速上下点；
 *   · 待机时在主图上偶尔眨一下眼（叠一张眨眼帧 140 毫秒）；
 *   · 点没点在她身上：先看包围盒，再看当前这张图那一点是不是透明的。
 * 该摆什么姿势由 renderer/sprite-director.js 决定。
 *
 * 对外的方法和 PetRig / VideoRig 一样：scale、init、layout、setScale、playCommand、hitTest、regionAt、cursorAt、buildMask、
 * setPointer、setDragging、setHeadHover、regionHoverClosesEyes、playSound，外加 stageX / stageY（气泡定位用）。
 */
import { createSpriteDirector } from './sprite-director.js';

const STYLE_ID = 'osu-pet-sprite-rig-style';
// 动作的关键帧改编自 CrossPet app/web/index.html（MIT，Copyright (c) 2026 lokicorvus and CrossPet contributors）。
const CSS = `
.sp-stage { position: absolute; left: 0; top: 0; pointer-events: none; }
.sp-motion, .sp-talk { position: absolute; left: 0; top: 0; width: 100%; height: 100%; transform-origin: 50% 100%; will-change: transform; }
.sp-img { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: contain; object-position: 50% 100%;
  opacity: 0; transition: opacity .25s ease; user-select: none; -webkit-user-drag: none; z-index: 1; }
.sp-img.on { opacity: 1; }
.sp-img.sp-top { z-index: 2; }
.sp-img.sp-blink, .sp-img.sp-mouth { transition: none; z-index: 3; }
.sp-img:not([src]) { visibility: hidden; }
.m-bob   { animation: sp-bob 3.2s ease-in-out infinite; }
.m-hop   { animation: sp-bob-big .8s ease-in-out infinite; }
.m-jump  { animation: sp-jump .7s ease-in-out infinite; }
.m-quick { animation: sp-bob-small .45s ease-in-out infinite; }
.m-rock  { animation: sp-rock 3s ease-in-out infinite; }
.m-sway  { animation: sp-rock 1.8s ease-in-out infinite; }
.m-slow  { animation: sp-bob-tiny 4.5s ease-in-out infinite; }
.m-shake { animation: sp-shake 1.4s ease-in-out infinite; }
.m-angry { animation: sp-angry .14s linear infinite; }
.m-angry .sp-img { filter: drop-shadow(0 0 7px rgba(255, 60, 30, .75)) saturate(1.15); }
.m-dizzy { animation: sp-dizzy 1.1s ease-in-out infinite; }
.m-squish { animation: sp-squish 1.6s ease-in-out infinite; }
.m-jolt  { animation: sp-jolt .55s cubic-bezier(.3,1.6,.5,1) 1, sp-bob 3.2s ease-in-out .55s infinite; }
@keyframes sp-bob { 50% { transform: translateY(-2.5%); } }
@keyframes sp-bob-big { 50% { transform: translateY(-5%); } }
@keyframes sp-bob-small { 50% { transform: translateY(-1.8%); } }
@keyframes sp-bob-tiny { 50% { transform: translateY(-.8%) scale(1.01, 1.015); } }
@keyframes sp-jump { 0%,100% { transform: translateY(0) scale(1.02,.98); } 50% { transform: translateY(-9%) scale(.98,1.02); } }
@keyframes sp-rock { 0%,100% { transform: rotate(-2.5deg); } 50% { transform: rotate(2.5deg); } }
@keyframes sp-shake { 0%,50%,100% { transform: translateX(0); } 10% { transform: translateX(-3%); } 20% { transform: translateX(3%); } 30% { transform: translateX(-2%); } 40% { transform: translateX(2%); } }
@keyframes sp-angry { 0%,100% { transform: translate(0,0); } 25% { transform: translate(-1.2%,.4%); } 50% { transform: translate(1.2%,-.4%); } 75% { transform: translate(-.8%,-.3%); } }
@keyframes sp-dizzy { 0%,100% { transform: rotate(-6deg); } 50% { transform: rotate(6deg); } }
@keyframes sp-squish { 50% { transform: scale(.96, 1.05); } }
@keyframes sp-jolt { 0% { transform: translate(0,0) rotate(0); } 25% { transform: translate(-3%,-4%) rotate(-4deg) scale(.97,1.04); } 60% { transform: translate(1%,0) rotate(1.5deg); } 100% { transform: none; } }
`;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ALPHA_STEP = 4; // 透明度判断用缩小 4 倍的图（够准，也省内存）
const FADE_MS = 250; // 新姿势淡入多久（和 CSS 的 transition 一样）；淡完再把旧的淡掉
const MOUTH_STEP_MS = 60; // 口型轨一档多长（和 core/speakable.js 的 MOUTH_STEP_MS 一样）
// 没拿到口型轨时（菜单「说句话」、离屏自检）：按这个节奏一张一合地假装说。
const MOUTH_IDLE_PATTERN = '0122101221001221012100';

export class SpriteRig {
  manifest: any;
  baseUrl: string;
  scale: number;
  stageX = 0;
  stageY = 0;
  director: any;
  private stage!: HTMLDivElement;
  private motionEl!: HTMLDivElement;
  private talkEl!: HTMLDivElement;
  private layers = new Map<string, HTMLImageElement>(); // 姿势图 → 它自己那个 <img>（预载时解码好的那个）
  private current: HTMLImageElement | null = null;
  private blinkImg: HTMLImageElement | null = null;
  private mouthImg: HTMLImageElement | null = null;
  private mouthFiles: { closed?: string; half?: string; wide?: string } = {};
  private mouthShown = '';
  // track 为 null：没拿到口型轨（菜单「说句话」、老版本的 TomoPet），按固定节奏假装说；是字符串：照着走，走完（或者空串）闭嘴。
  private mouthTrack: { track: string | null; at: number } = { track: null, at: 0 };
  private pendingMouth: string | null = null;
  private mouthTimer: ReturnType<typeof setInterval> | null = null;
  private shown = { file: '', motion: '', talking: false };
  private swapping = false;
  private swappedAt = 0;
  private images = new Map<string, HTMLImageElement>();
  private alpha = new Map<string, { w: number; h: number; data: Uint8ClampedArray } | null>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(manifest: any, baseUrl: string) {
    this.manifest = manifest;
    this.baseUrl = baseUrl;
    this.scale = (manifest.display && manifest.display.scale) || 0.5;
    this.director = createSpriteDirector(manifest.sprite || {}, { now: Date.now() });
  }

  private url(file: string) {
    return new URL(file, this.baseUrl).href;
  }

  /** 先把所有姿势的图都载进来（换姿势时不会闪一下空白）。主图载不出来就报错（皮肤坏了）。 */
  private async preload() {
    const files: string[] = this.director.files();
    await Promise.all(files.map(async (file) => {
      const img = new Image();
      img.decoding = 'async';
      img.src = this.url(file);
      // 个别姿势坏了：记一笔，用到时退回平时那张主图（tick 里），不卡在上一个姿势上。
      try { await img.decode(); this.images.set(file, img); } catch (error) { console.warn('[sprite] 姿势图载不出来：', file, error); }
    }));
    const main = this.director.mainFile();
    if (!this.images.has(main)) throw new Error(`读不到皮肤的主图：${main}（检查皮肤文件夹里有没有这张图）`);
  }

  async init(host: HTMLElement) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    await this.preload();
    const stage = document.createElement('div');
    stage.className = 'sp-stage';
    const motionEl = document.createElement('div');
    motionEl.className = 'sp-motion';
    const talkEl = document.createElement('div');
    talkEl.className = 'sp-talk';
    motionEl.appendChild(talkEl);
    stage.appendChild(motionEl);
    // 每张姿势图一层：直接用预载时解码好的那个 <img>，换姿势时不用再改 src、再解码（眨眼图和嘴另外叠在上面）。
    const blinkFile = this.manifest.sprite?.blink?.file;
    const overlays = new Set<string>([blinkFile, ...Object.values(this.director.mouthLevels())].filter(Boolean) as string[]);
    for (const [file, img] of this.images) {
      if (overlays.has(file)) continue;
      img.className = 'sp-img';
      img.alt = '';
      img.draggable = false;
      talkEl.appendChild(img);
      this.layers.set(file, img);
    }
    if (blinkFile && this.images.has(blinkFile)) {
      const blink = document.createElement('img');
      blink.className = 'sp-img sp-blink';
      blink.alt = '';
      blink.draggable = false;
      blink.src = this.url(blinkFile);
      talkEl.appendChild(blink);
      this.blinkImg = blink;
    }
    // 嘴叠在眨眼图上面（眨眼时嘴照样在动）。几张嘴图有没载出来的就当没有。
    const levels = this.director.mouthLevels();
    this.mouthFiles = Object.fromEntries(Object.entries(levels).filter(([, f]) => this.images.has(f as string))) as any;
    if (this.mouthFiles.half || this.mouthFiles.wide) {
      const mouth = document.createElement('img');
      mouth.className = 'sp-img sp-mouth';
      mouth.alt = '';
      mouth.draggable = false;
      talkEl.appendChild(mouth);
      this.mouthImg = mouth;
    }
    this.stage = stage;
    this.motionEl = motionEl;
    this.talkEl = talkEl;
    host.appendChild(stage);
    this.layout();
    window.addEventListener('resize', () => this.layout());
    this.tick();
    this.timer = setInterval(() => this.tick(), 100);
    this.blinkLoop();
  }

  /** 和 PetRig / VideoRig 同一套规则：装得下脚底贴窗口底边；装不下平滑过渡到头顶对齐。 */
  layout() {
    if (!this.stage) return;
    const w = window.innerWidth;
    // 脚下留白（renderer/pp-ring.ts 的地台环和字写在这一截里）：脚贴在留白上面
    const h = window.innerHeight - (Number((window as any).__tomopetFootroom) || 0);
    const c = this.manifest.canvas;
    const cw = c.w * this.scale;
    const ch = c.h * this.scale;
    const headroom = 40;
    const sFit = (h - headroom) / c.h;
    const t = sFit > 0 ? clamp((this.scale - sFit) / (0.35 * sFit), 0, 1) : 0;
    const yBottom = h - ch;
    const yHead = headroom - this.manifest.hitbox.y * this.scale;
    this.stageX = (w - cw) / 2;
    this.stageY = yBottom + (yHead - yBottom) * t;
    this.stage.style.transform = `translate(${this.stageX}px, ${this.stageY}px)`;
    this.stage.style.width = `${cw}px`;
    this.stage.style.height = `${ch}px`;
  }

  private tick() {
    const cur = this.director.current(Date.now());
    const file = this.images.has(cur.file) ? cur.file : this.director.mainFile();
    if (file !== this.shown.file) this.swap(file);
    if (cur.motion !== this.shown.motion) {
      this.motionEl.className = `sp-motion m-${cur.motion}`;
      this.shown.motion = cur.motion;
    }
    // 说话时整个人轻轻快速点头；说话姿势本身已经是快速点头的、或者嘴在动的，就不再叠一层。
    const bob = cur.talking && cur.motion !== 'quick' && !(cur.mouth && this.mouthImg);
    if (bob !== this.shown.talking) {
      this.talkEl.className = bob ? 'sp-talk m-quick' : 'sp-talk';
      this.shown.talking = bob;
    }
    if (this.director.takeBlinkRequest()) this.blink(cur);
    this.updateMouth(cur);
  }

  /** 口型轨这一刻是第几档：'0' 闭、'1' 半张、'2' 张大。轨走完了就闭嘴；没有轨就按固定节奏假装说。 */
  private mouthLevelAt(now: number) {
    const step = Math.floor((now - this.mouthTrack.at) / MOUTH_STEP_MS);
    if (step < 0) return '0';
    if (this.mouthTrack.track !== null) return this.mouthTrack.track[step] ?? '0';
    return MOUTH_IDLE_PATTERN[step % MOUTH_IDLE_PATTERN.length];
  }

  private updateMouth(cur = this.director.current(Date.now())) {
    const img = this.mouthImg;
    if (!img) return;
    const now = Date.now();
    if (!cur.talking && this.mouthTimer) { clearInterval(this.mouthTimer); this.mouthTimer = null; }
    // 只在屏幕上正显示着那张主图时换嘴（刚换姿势、还在淡入时不叠，免得嘴浮在别的姿势上）。
    const ok = cur.talking && cur.mouth && cur.file === this.shown.file && !this.swapping && now - this.swappedAt >= 350;
    const level = ok ? this.mouthLevelAt(now) : '';
    const f = this.mouthFiles;
    const file = level === '2' ? (f.wide || f.half) : level === '1' ? (f.half || f.wide) : level === '0' ? f.closed : '';
    if (!file) { img.classList.remove('on'); return; }
    if (this.mouthShown !== file) { img.src = this.url(file); this.mouthShown = file; }
    img.classList.add('on');
  }

  /** 下一句话的口型轨（core/speakable.js 算的），紧接着的 talk-start 用它。 */
  setMouthTrack(track: string) {
    this.pendingMouth = String(track || '').replace(/[^012]/g, '').slice(0, 2000);
  }

  private swap(file: string) {
    const next = this.layers.get(file);
    if (!next) return;
    this.shown.file = file;
    this.blinkImg?.classList.remove('on');
    const prev = this.current;
    this.current = next;
    // 新的叠在最上面淡入；刚才那张保持不透明垫在下面（人不会有半透明的一刻），等新的淡完再淡掉它露在外面的部分。
    // 连着换好几次（开局、打完时常有）：更早的那些直接开始淡出，只留刚才那张垫底。
    for (const [, img] of this.layers) {
      if (img !== next && img !== prev) img.classList.remove('on', 'sp-top');
    }
    prev?.classList.remove('sp-top');
    next.classList.add('sp-top', 'on');
    this.swapping = true;
    this.swappedAt = Date.now();
    const at = this.swappedAt;
    setTimeout(() => {
      if (prev && this.current !== prev) prev.classList.remove('on');
      if (this.swappedAt === at) setTimeout(() => { if (this.swappedAt === at) this.swapping = false; }, FADE_MS);
    }, FADE_MS);
  }

  private blink(cur: any) {
    // 只在屏幕上正显示着那张能眨眼的主图时眨（姿势刚换、图还没换上时不眨，免得闭眼的待机图盖在别的姿势上）。
    if (!this.blinkImg || !cur.blinkable || cur.file !== this.shown.file || this.swapping || Date.now() - this.swappedAt < 600) return;
    const img = this.blinkImg;
    img.classList.add('on');
    setTimeout(() => img.classList.remove('on'), 140);
  }

  /** 待机时 3–6.5 秒眨一次（CrossPet 的节奏）。 */
  private blinkLoop() {
    setTimeout(() => {
      this.blink(this.director.current(Date.now()));
      this.blinkLoop();
    }, 3000 + Math.random() * 3500);
  }

  /**
   * 屏幕坐标 → 画布坐标。她正在跳、晃、抖（CSS 动作）时，要把这一帧的变形倒回去，点到的才是画出来的那个位置。
   * 变形原点是脚底中间（transform-origin: 50% 100%），外层是动作、内层是说话时的点头。
   */
  toCanvas(x: number, y: number) {
    let px = x - this.stageX;
    let py = y - this.stageY;
    if (this.motionEl && typeof DOMMatrix !== 'undefined') {
      const cw = this.manifest.canvas.w * this.scale;
      const ch = this.manifest.canvas.h * this.scale;
      for (const el of [this.motionEl, this.talkEl]) {
        const t = getComputedStyle(el).transform;
        if (!t || t === 'none') continue;
        try {
          const m = new DOMMatrix(t);
          const inv = new DOMMatrix().translate(cw / 2, ch).multiply(m).translate(-cw / 2, -ch).inverse();
          const p = inv.transformPoint(new DOMPoint(px, py));
          px = p.x;
          py = p.y;
        } catch { /* 读不了就按没变形算 */ }
      }
    }
    return { x: px / this.scale, y: py / this.scale };
  }

  /** 当前这张图缩小后的透明度数据（第一次用到时才算）。读不了（跨域之类）就记 null，退回只看包围盒。 */
  private alphaOf(file: string) {
    if (this.alpha.has(file)) return this.alpha.get(file) || null;
    const img = this.images.get(file);
    let result: { w: number; h: number; data: Uint8ClampedArray } | null = null;
    if (img && img.naturalWidth) {
      try {
        const w = Math.max(1, Math.round(img.naturalWidth / ALPHA_STEP));
        const h = Math.max(1, Math.round(img.naturalHeight / ALPHA_STEP));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(img, 0, 0, w, h);
          result = { w, h, data: ctx.getImageData(0, 0, w, h).data };
        }
      } catch { result = null; }
    }
    this.alpha.set(file, result);
    return result;
  }

  /** 先看包围盒，再看当前这张图那一点透不透明（图按 contain、底边居中放进画布）。 */
  hitTest(x: number, y: number): boolean {
    const c = this.toCanvas(x, y);
    const hb = this.manifest.hitbox;
    if (c.x < hb.x || c.x > hb.x + hb.w || c.y < hb.y || c.y > hb.y + hb.h) return false;
    const file = this.shown.file;
    const img = this.images.get(file);
    const a = this.alphaOf(file);
    if (!img || !a) return true;
    const W = this.manifest.canvas.w;
    const H = this.manifest.canvas.h;
    const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
    const ox = (W - img.naturalWidth * s) / 2;
    const oy = H - img.naturalHeight * s;
    const px = Math.floor(((c.x - ox) / s) / ALPHA_STEP);
    const py = Math.floor(((c.y - oy) / s) / ALPHA_STEP);
    if (px < 0 || py < 0 || px >= a.w || py >= a.h) return false;
    return a.data[(py * a.w + px) * 4 + 3] > 40;
  }

  regionAt(x: number, y: number) {
    if (!this.hitTest(x, y)) return null;
    const regions = this.manifest.interaction?.regions ?? [];
    const c = this.toCanvas(x, y);
    for (const r of regions) {
      const s = r.shape;
      if (!s) continue;
      if (s.type === 'ellipse') {
        const dx = (c.x - s.cx) / s.rx;
        const dy = (c.y - s.cy) / s.ry;
        if (dx * dx + dy * dy <= 1) return r;
      } else if (c.x >= s.x && c.x <= s.x + s.w && c.y >= s.y && c.y <= s.y + s.h) return r;
    }
    return null;
  }

  cursorAt(x: number, y: number) {
    if (!this.hitTest(x, y)) return null;
    const r = this.regionAt(x, y);
    return (r && r.cursor) || this.manifest.interaction?.cursor || 'pointer';
  }

  buildMask() { return null; }
  setPointer() { this.director.activity(Date.now()); }
  setDragging() { this.director.activity(Date.now()); }
  setHeadHover() {}
  regionHoverClosesEyes() { return false; }
  playSound() { return false; }
  setScale(scale: number) { this.scale = scale; this.layout(); }

  playCommand(cmd: string) {
    const wasTalking = this.director.debug().talking === true;
    this.director.command(cmd, Date.now());
    // 开口：从这一刻起按口型轨走（菜单「说句话」在正说着一句真话时不打断那句的轨）。
    if (cmd === 'talk-start' || (cmd === 'talk' && !wasTalking)) {
      this.mouthTrack = { track: cmd === 'talk-start' ? this.pendingMouth : null, at: Date.now() };
      this.pendingMouth = null;
      if (this.mouthImg && !this.mouthTimer) this.mouthTimer = setInterval(() => this.updateMouth(), 50);
    }
    if (this.stage) this.tick();
  }

  /** 调试 / 离屏自检用：window.__rig.debugState() */
  debugState() {
    return { shown: { ...this.shown }, mouth: { has: Boolean(this.mouthImg), on: Boolean(this.mouthImg?.classList.contains('on')), file: this.mouthShown, track: this.mouthTrack.track === null ? null : this.mouthTrack.track.length }, director: this.director.debug() };
  }
}
