/**
 * 两个入口（OBS 里的 counter 页、桌面角色窗口）共用的启动逻辑：读皮肤清单、挑渲染器、算缩放。
 *
 * 皮肤清单的 rig 是 "video" 用视频皮肤播放器（video-rig.js，挂在 window.__SurfcoreVideoRig 上），
 * 是 "sprite" 用姿势皮肤渲染器（sprite-rig.ts，一张图一个姿势，按游戏时刻换），否则用分图层的 PetRig。
 * 三种渲染器对外的方法一样：scale / init / setScale / playCommand / hitTest / regionAt / cursorAt / setPointer …
 */
import './video-rig.js';
import { PetRig, type Manifest } from './rig';
import { SpriteRig } from './sprite-rig';

export type AnyRig = PetRig & { stageX?: number; stageY?: number };

export async function loadManifest(baseUrl: string): Promise<Manifest> {
  const res = await fetch(new URL('manifest.json', baseUrl).href + '?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`读不到皮肤清单 manifest.json（HTTP ${res.status}）`);
  return (await res.json()) as Manifest;
}

export function makeRig(manifest: Manifest, baseUrl: string): AnyRig {
  const Video = (window as any).__SurfcoreVideoRig;
  if ((manifest as any).rig === 'video') {
    if (!Video) throw new Error('这是视频皮肤，但视频播放器没加载上');
    return new Video(manifest, baseUrl, { focus: false }) as AnyRig;
  }
  if ((manifest as any).rig === 'sprite') return new SpriteRig(manifest, baseUrl) as unknown as AnyRig;
  return new PetRig(manifest, baseUrl) as AnyRig;
}

/**
 * 按窗口大小算缩放：人（hitbox 顶到画布底）占窗口高度的 (1 - headroom)，脚贴底边，顶上留给气泡；
 * 同时整张画布宽、高都不超过窗口。照搬 SurfCore tosu-counter/shim.js 的 fitScale。
 * 2026-11-19 第一版画布整张塞满，头离顶边太近，气泡只能压到脸上。
 */
export function fitScale(manifest: Manifest, headroom = 0.22, w = window.innerWidth || 400, h = window.innerHeight || 600): number {
  if (!manifest || !manifest.canvas) return 0.4;
  const hb = manifest.hitbox || { x: 0, y: 0, w: manifest.canvas.w, h: manifest.canvas.h };
  const byHeight = (h * (1 - headroom)) / Math.max(1, manifest.canvas.h - hb.y);
  return Math.max(0.05, Math.min(w / manifest.canvas.w, byHeight, h / manifest.canvas.h));
}

/**
 * 她头的左上角在窗口里的位置（像素）：气泡的尾巴指向这里。
 * 分图层皮肤看 PetRig.root，视频皮肤看 VideoRig.stageX/Y；头用皮肤里「摸头」那个椭圆，没有就用包围盒上部。
 * 照搬 SurfCore tosu-counter/counter.js 的 headAnchor。
 */
export function headAnchor(rig: AnyRig | null, manifest: Manifest | null): { x: number; y: number } {
  if (!rig || !manifest || !manifest.hitbox) return { x: window.innerWidth * 0.42, y: window.innerHeight * 0.2 };
  const anyRig = rig as any;
  const ox = anyRig.root ? anyRig.root.x : anyRig.stageX || 0;
  const oy = anyRig.root ? anyRig.root.y : anyRig.stageY || 0;
  const s = anyRig.scale || 1;
  const hb = manifest.hitbox;
  let head: { cx: number; cy: number; rx: number; ry: number } = { cx: hb.x + hb.w / 2, cy: hb.y + hb.h * 0.2, rx: hb.w * 0.3, ry: hb.h * 0.17 };
  for (const region of manifest.interaction?.regions ?? []) {
    if (region.gesture === 'pat' && region.shape?.type === 'ellipse') { head = region.shape; break; }
  }
  return { x: ox + (head.cx - head.rx * 0.55) * s, y: oy + (head.cy - head.ry * 0.7) * s };
}

export function showFatal(error: unknown) {
  const el = document.getElementById('err');
  const text = `皮肤没加载出来：${String((error as any)?.message ?? error)}`;
  if (el) { el.textContent = text; el.style.display = 'block'; }
  console.error(error);
}
