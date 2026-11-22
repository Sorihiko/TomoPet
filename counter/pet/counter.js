/* 角色（tosu counter）：她说话时张嘴，并按设置显示这句话。照搬 SurfCore lib/osu/tosu-counter/counter.js。
 * osu-pet 每说一句往同目录 state.json 写 { seq, text, durationMs, rev }；这里每 0.4 秒读一次（同源，不跨域）。
 *   · seq 变了 → 张嘴（talk-start，durationMs 后 talk-stop），按「说话时」显示：气泡（头顶）/ 人物下方字幕 / 都不显示；
 *   · rev 变了 → 皮肤换过了（设置里换了皮肤），整页重载；
 *   · reactSeq 变了 → 换姿势（react:<时刻>）；playing / playingAt → 打图中（play-on / play-off）。只有姿势皮肤（rig: sprite）会用到，别的皮肤忽略这些命令。
 * 设置在 tosu 的 counter 设置里改（settings.json：lineStyle / fontSize），用 tosu 的 commands websocket 读。
 * 像视频字幕那样在整个画面底部显示：用另一个 counter「osu-pet 字幕」（fatfish-osu-subtitle），读的是同一份 state.json。 */
(function () {
  'use strict';
  var sub = document.getElementById('sub');
  var bubble = document.getElementById('bubble');
  var err = document.getElementById('err');
  // 旧版设置只有 showSubtitle：true 当作「人物下方字幕」，false 当作「都不显示」
  var settings = { lineStyle: '气泡', fontSize: 30, ppRing: '显示', ppRingCurve: '显示', ppRingCurveStyle: '墙', ppLabelStyle: '黑底卡片', ppRingInk: '浅色', ppRingFc: '不显示' };
  var lastCurve = null; // 上一次告诉渲染层的「环上画难度曲线」开关
  var lastCurveStyle = null; // 上一次告诉渲染层的「难度曲线的样子」（柱子 / 墙）
  var lastLayout = null; // 上一次告诉渲染层的「pp 那块字的样子」（id 是 ppLabelStyle：2026-11-22 换了默认值，换个 id，昨天装过的不会留着旧默认「环下面一行」）
  var lastFc = null; // 上一次告诉渲染层的「显示 if FC」
  var lastInk = null; // 上一次告诉渲染层的「只有字的字色」
  var lastRing = null; // 上一次告诉渲染层的「脚下 pp 环」开关（渲染层还没好时下一次再告诉）
  var lastSeq = null;
  var lastRev = null;
  // 游戏时刻（osu-pet 2026-11-20 加的）：reactSeq 变了 → 角色换姿势（react:<时刻>）；playing → 打图时专注的姿势。
  // playingAt 是 osu-pet 的心跳时间，90 秒没更新就当不打了（osu-pet 崩了也不会让她一直停在打图的姿势）。
  var lastReactSeq = null;
  var lastPlaying = null;
  var lastResting = false;
  var PLAY_TTL_MS = 90000;
  var talkTimer = null;
  var lineTimer = null;
  var failures = 0;

  function showError(text) {
    if (!err) return;
    err.textContent = text;
    err.style.display = text ? 'block' : 'none';
  }

  function fontPx() {
    return Math.max(12, Math.min(96, Number(settings.fontSize) || 30));
  }

  function applySettings() {
    var px = fontPx() + 'px';
    if (sub) sub.style.fontSize = px;
    // 气泡里的字小一号：气泡挤在她左上角，字号和字幕一样大就太占地方
    if (bubble) bubble.style.fontSize = Math.round(fontPx() * 0.8) + 'px';
    if (settings.lineStyle !== '人物下方字幕' && sub) sub.classList.remove('on');
    if (settings.lineStyle !== '气泡' && bubble) bubble.classList.remove('on');
    applyRing();
  }

  /** 脚下的 pp 地台环（renderer/pp-ring.ts）开不开：tosu 里这个 counter 的设置「脚下的 pp 环」。 */
  function applyRing() {
    var pet = window.__counterPet;
    if (!pet) return;
    var on = settings.ppRing !== '不显示';
    if (on !== lastRing && pet.setRing) { lastRing = on; pet.setRing(on); }
    var curve = settings.ppRingCurve !== '不显示';
    if (curve !== lastCurve && pet.setRingCurve) { lastCurve = curve; pet.setRingCurve(curve); }
    if (settings.ppRingCurveStyle !== lastCurveStyle && pet.setRingCurveStyle) { lastCurveStyle = settings.ppRingCurveStyle; pet.setRingCurveStyle(lastCurveStyle); }
    if (settings.ppLabelStyle !== lastLayout && pet.setRingLayout) { lastLayout = settings.ppLabelStyle; pet.setRingLayout(lastLayout); }
    if (settings.ppRingFc !== lastFc && pet.setRingFc) { lastFc = settings.ppRingFc; pet.setRingFc(lastFc); }
    if (settings.ppRingInk !== lastInk && pet.setRingInk) { lastInk = settings.ppRingInk; pet.setRingInk(lastInk); }
  }

  /**
   * 她头的左上角在窗口里的位置（像素）：气泡的尾巴指向这里。
   * 分图层皮肤看 PetRig.root，视频皮肤看 VideoRig.stageX/Y；头用皮肤里「摸头」那个椭圆，没有就用包围盒上部。
   */
  function headAnchor() {
    var rig = window.__rig;
    var m = window.__skin || (rig && rig.manifest);
    if (!rig || !m || !m.hitbox) return { x: window.innerWidth * 0.42, y: window.innerHeight * 0.2 };
    var ox = rig.root ? rig.root.x : (rig.stageX || 0);
    var oy = rig.root ? rig.root.y : (rig.stageY || 0);
    var s = rig.scale || 1;
    var head = { cx: m.hitbox.x + m.hitbox.w / 2, cy: m.hitbox.y + m.hitbox.h * 0.2, rx: m.hitbox.w * 0.3, ry: m.hitbox.h * 0.17 };
    var regions = (m.interaction && m.interaction.regions) || [];
    for (var i = 0; i < regions.length; i += 1) {
      var shape = regions[i].shape;
      if (regions[i].gesture === 'pat' && shape && shape.type === 'ellipse') { head = shape; break; }
    }
    // 椭圆左上方那一段（约 10 点半方向），不要贴到头顶正中
    return { x: ox + (head.cx - head.rx * 0.55) * s, y: oy + (head.cy - head.ry * 0.7) * s };
  }

  function showBubble(text, ms) {
    if (!bubble) return;
    var head = headAnchor();
    var margin = 6;
    // 气泡在头的左上方：最宽到画面的 62%（太宽会盖过她的头顶），右边缘对着头
    bubble.style.setProperty('--max-w', Math.max(180, Math.min(window.innerWidth * 0.86, Math.max(head.x + 40, window.innerWidth * 0.62))) + 'px');
    bubble.textContent = text;
    bubble.style.left = '0px';
    bubble.style.top = '0px';
    bubble.classList.add('on');
    var rect = bubble.getBoundingClientRect();
    var w = rect.width;
    var h = rect.height;
    // 右下角对着头的左上角：气泡右边缘在锚点右边一点点，底边在锚点上方（留出尾巴的长度）
    var left = Math.max(margin, Math.min(window.innerWidth - margin - w, head.x + 18 - w));
    var top = Math.max(margin, head.y - h - 16);
    bubble.style.left = left + 'px';
    bubble.style.top = top + 'px';
    // 尾巴尖落在锚点附近（气泡被挤到右边时，尾巴跟着往左挪）
    var tailRight = Math.max(14, Math.min(w - 40, left + w - head.x - 4));
    bubble.style.setProperty('--tail-right', tailRight + 'px');
    clearTimeout(lineTimer);
    lineTimer = setTimeout(function () { bubble.classList.remove('on'); }, Math.max(2600, ms + 800));
  }

  function showSub(text, ms) {
    if (!sub) return;
    sub.textContent = text;
    sub.classList.add('on');
    clearTimeout(lineTimer);
    lineTimer = setTimeout(function () { sub.classList.remove('on'); }, Math.max(2600, ms + 800));
  }

  function speak(text, durationMs, mouth, at) {
    var given = Number(durationMs) || 0;
    var ms = given > 0 ? Math.max(900, Math.min(60000, given)) : Math.max(1200, Math.min(6000, Array.from(String(text || '')).length * 230));
    // 口型轨：这边每 0.4 秒才读一次 state.json，比声音晚开口一点；按 TomoPet 写下的时刻（同一台电脑的钟）把落下的几档跳过去。
    // 整条都被跳过了（很短的一句、或者页面读晚了）就是「已经说完」：给 '0' 闭嘴，不给空串（空串 / 不给 = 没有轨，会假装说）。
    var track = typeof mouth === 'string' ? mouth : '';
    var late = Date.now() - (Number(at) || 0);
    if (track && late > 0 && late < 3000) track = track.slice(Math.floor(late / 60)) || '0';
    if (track && window.__counterPet && window.__counterPet.mouth) window.__counterPet.mouth(track);
    if (window.__counterPet) window.__counterPet.command('talk-start');
    clearTimeout(talkTimer);
    talkTimer = setTimeout(function () { if (window.__counterPet) window.__counterPet.command('talk-stop'); }, ms);
    if (!text) return;
    if (settings.lineStyle === '气泡') showBubble(text, ms);
    else if (settings.lineStyle === '人物下方字幕') showSub(text, ms);
  }

  /** 姿势：角色还没加载好（__counterPet 还没有）时先不动，下一次再试。刚打开不重放上一个时刻，但「在不在打图」照着现在的来。 */
  function applyPose(s) {
    var pet = window.__counterPet;
    if (!pet) return;
    var on = s.playing === true && Date.now() - (Number(s.playingAt) || 0) < PLAY_TTL_MS;
    if (on !== lastPlaying) { lastPlaying = on; pet.command(on ? 'play-on' : 'play-off'); }
    // 休息段是一个状态（resting），按状态对齐：两个时刻挨得近被这边漏看、或者页面重载后，也能接着喝水 / 放下杯子。
    var rest = on && s.resting === true;
    if (rest !== lastResting) { lastResting = rest; pet.command(rest ? 'react:break' : 'react:break-end'); }
    if (lastReactSeq === null) { lastReactSeq = s.reactSeq === undefined ? 0 : s.reactSeq; return; }
    if (s.reactSeq !== undefined && s.reactSeq !== lastReactSeq) {
      lastReactSeq = s.reactSeq;
      if (typeof s.react === 'string' && /^[a-z-]{1,40}$/.test(s.react)) pet.command('react:' + s.react);
    }
  }

  function poll() {
    fetch('./state.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (s) {
        failures = 0;
        showError('');
        if (lastRev !== null && s.rev !== lastRev) { location.reload(); return; }
        lastRev = s.rev;
        applyRing();
        applyPose(s);
        if (lastSeq === null) { lastSeq = s.seq; return; } // 刚打开不重放上一句
        if (s.seq !== lastSeq) {
          lastSeq = s.seq;
          speak(s.text, s.durationMs, s.mouth, s.at);
        }
      })
      .catch(function () {
        failures += 1;
        // state.json 还没有（她还没开过口）是正常的；连续很久读不到才提示
        if (failures > 75 && lastRev === null) showError('读不到 state.json：打开 TomoPet 的设置窗口，看「OBS」那一块的提示');
      });
  }

  function loadSettings() {
    try {
      var folder = location.pathname.replace(/^\/+|\/+$/g, '').replace(/\/index\.html$/, '');
      var ws = new WebSocket('ws://' + location.host + '/websocket/commands');
      ws.onopen = function () { ws.send('getSettings:' + encodeURI(folder)); };
      ws.onmessage = function (event) {
        try {
          var data = JSON.parse(event.data);
          if (data && data.command === 'getSettings' && data.message) {
            var msg = data.message;
            if (typeof msg.lineStyle === 'string' && msg.lineStyle) settings.lineStyle = msg.lineStyle;
            else if (typeof msg.showSubtitle === 'boolean') settings.lineStyle = msg.showSubtitle ? '人物下方字幕' : '都不显示';
            if (msg.fontSize !== undefined) settings.fontSize = Number(msg.fontSize) || 30;
            if (typeof msg.ppRing === 'string' && msg.ppRing) settings.ppRing = msg.ppRing;
            if (typeof msg.ppRingCurve === 'string' && msg.ppRingCurve) settings.ppRingCurve = msg.ppRingCurve;
            if (typeof msg.ppRingCurveStyle === 'string' && msg.ppRingCurveStyle) settings.ppRingCurveStyle = msg.ppRingCurveStyle;
            if (typeof msg.ppLabelStyle === 'string' && msg.ppLabelStyle) settings.ppLabelStyle = msg.ppLabelStyle;
            if (typeof msg.ppRingFc === 'string' && msg.ppRingFc) settings.ppRingFc = msg.ppRingFc;
            if (typeof msg.ppRingInk === 'string' && msg.ppRingInk) settings.ppRingInk = msg.ppRingInk;
            applySettings();
          }
        } catch (e) {}
      };
    } catch (e) { /* 不在 tosu 里打开（比如直接双击文件）就用默认设置 */ }
  }

  applySettings();
  loadSettings();
  poll();
  setInterval(poll, 400);
  window.addEventListener('error', function (event) {
    if (String(event.message || '').indexOf('manifest') >= 0) showError('皮肤没装好：' + event.message);
  });
  // 调试 / 测试用
  window.__counterSpeak = speak;
  window.__counterSettings = settings;
})();
