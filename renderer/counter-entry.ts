/**
 * OBS 里的角色（tosu counter 页）的入口。打包成 dist/counter-renderer.js，由 core/tosu-counter.js 拷进 tosu 的 static 文件夹。
 *
 * 皮肤从同目录 ./skin/ 读（同步时拷进去的）；命令由 counter.js 发（她说话时 talk-start / talk-stop）。
 * 这里只负责把她画出来，并把 counter.js 要用的东西挂到 window 上：
 *   __rig / __skin（气泡定位用）、__counterPet.command(cmd)、__counterPet.mouth(track)（下一句话的口型轨）、
 *   __counterPet.setRing(on)（脚下的 pp 地台环开不开，tosu 里这个 counter 的设置）。
 * SurfCore 里这一层是「桌宠的 renderer.js + 假的 window.pet（shim.js）」，这里直接自己写入口，不需要 shim。
 *
 * 脚下的 pp 地台环（renderer/pp-ring.ts，2026-11-21）：这一页本来就在 tosu 里，直接连 tosu 的 websocket/v2 拿实时的 pp、
 * 100 / 50 / miss、进度，不经过 TomoPet。开着时窗口底下留一截（footroomFor），脚贴在留白上面。
 */
import { fitScale, loadManifest, makeRig, showFatal } from './boot';
import { createPpRing, footroomFor, hudFromTosu, labelLayoutOf, ringFootroom } from './pp-ring';
import { curveFromGraph } from '../core/strain-curve.js';

const HEADROOM = 0.22;

async function boot() {
  const baseUrl = new URL('./skin/', location.href).href;
  const manifest = await loadManifest(baseUrl);
  const rig = makeRig(manifest, baseUrl);
  const w = window as any;
  let ringOn = true;
  let curveOn = true;
  let layout = labelLayoutOf(undefined); // pp 那块字的样子（tosu 里这个 counter 的「pp 那块字的样子」），留白跟着它 // 环上的难度带（tosu 里这个 counter 的设置「环上画难度曲线」）
  const hbW = Number((manifest as any).hitbox?.w) || Number(manifest.canvas?.w) || 512;
  // 环开着时脚下留多少：先按窗口高度粗留一截算出缩放，再按那个缩放下环实际要多大（core/pp-ring-size.js）
  const footroom = () => {
    if (!ringOn) return 0;
    const rough = fitScale(manifest, HEADROOM, window.innerWidth, window.innerHeight - footroomFor(window.innerHeight));
    // 最多留窗口高的四成：卡片 / 成绩条有最小尺寸（小字不小于 11 像素），原来的四分之一在很矮的浏览器源（低于约 236 像素）里装不下，
    // 卡片会被顶到环上（复核发现）
    return Math.min(Math.round(window.innerHeight * 0.4), ringFootroom(hbW, rough, window.innerWidth * 0.4, curveOn, layout));
  };
  const fit = () => fitScale(manifest, HEADROOM, window.innerWidth, window.innerHeight - footroom());
  w.__tomopetFootroom = footroom();
  rig.scale = fit();
  await rig.init(document.body);
  rig.setScale(fit());
  const ring = createPpRing(() => rig, () => manifest);
  ring.setLabelLayout(layout);
  const relayout = () => { w.__tomopetFootroom = footroom(); rig.setScale(fit()); ring.layout(); };
  window.addEventListener('resize', relayout);
  w.__rig = rig;
  w.__skin = manifest;
  w.__ring = ring;
  w.__counterPet = {
    command: (cmd: string) => { try { rig.playCommand(cmd); } catch { /* 不认识的命令忽略 */ } },
    mouth: (track: string) => { try { (rig as any).setMouthTrack?.(String(track || '')); } catch { /* 忽略 */ } },
    setRing: (on: boolean) => {
      if (Boolean(on) === ringOn) return;
      ringOn = Boolean(on);
      if (!ringOn) ring.update({ on: false });
      relayout();
    },
    setRingCurve: (on: boolean) => {
      if (Boolean(on) === curveOn) return;
      curveOn = Boolean(on);
      if (!curveOn) ring.setCurve(null);
      lastCurveKey = '';
      relayout();
    },
    // 难度曲线画成柱子还是墙（tosu 里这个 counter 的「难度曲线的样子」）
    setRingCurveStyle: (s: string) => ring.setCurveStyle(s),
    // pp 那行字的摆法（「pp 那行字的摆法」：环下面一行 / 沿着环）、「572 if FC」显示不显示（「显示 if FC」）
    setRingLayout: (s: string) => {
      const next = labelLayoutOf(s);
      if (next === layout) return;
      layout = next;
      ring.setLabelLayout(next);
      relayout(); // 不同样子要的留白不一样
    },
    setRingInk: (s: string) => ring.setLabelInk(s),
    setRingFc: (s: string) => ring.setShowFc(s),
  };
  // 难度带：tosu 的难度曲线变了（换图、换 mod）才重新压成一圈
  let lastCurveKey = '';
  const onCurve = (raw: any) => {
    if (!curveOn) return;
    const g = raw?.performance?.graph;
    const t = raw?.beatmap?.time || {};
    const rate = Number(raw?.play?.mods?.rate) || 1;
    const xs = Array.isArray(g?.xaxis) ? g.xaxis : [];
    // 加上谱面和 mod 的 checksum：同一个谱面集里首尾物件时间一样的难度、同一张图开关 HR，曲线的时间轴一样但数值不一样（复核发现）
    const key = `${raw?.beatmap?.checksum}|${raw?.play?.mods?.checksum ?? raw?.play?.mods?.name}|${xs.length}|${xs[0]}|${xs[xs.length - 1]}|${t.firstObject}|${t.lastObject}|${rate}`;
    if (key === lastCurveKey) return;
    lastCurveKey = key;
    ring.setCurve(curveFromGraph(g, { first: t.firstObject, last: t.lastObject, rate }));
  };
  connectTosu(ring, () => ringOn, onCurve);
  console.log(`[TomoPet] skin loaded: ${manifest.name} (${(manifest as any).rig})`);
}

/** 连 tosu 的 websocket/v2：每一帧更新地台环；断了两秒后重连。不在 tosu 里打开（直接双击文件）就不连。 */
function connectTosu(ring: ReturnType<typeof createPpRing>, enabled: () => boolean, onFrame: (raw: any) => void = () => {}) {
  if (!/^https?:$/.test(location.protocol)) return;
  let ws: WebSocket;
  try { ws = new WebSocket(`ws://${location.host}/websocket/v2`); } catch { return; }
  ws.onmessage = (event) => {
    if (!enabled()) return;
    try { const raw = JSON.parse(String(event.data)); onFrame(raw); ring.update(hudFromTosu(raw)); } catch { /* 不认识的帧忽略 */ }
  };
  ws.onclose = () => { ring.update({ on: false }); setTimeout(() => connectTosu(ring, enabled, onFrame), 2000); };
}

boot().catch(showFatal);
