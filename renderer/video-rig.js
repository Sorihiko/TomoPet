/* surfcore:video-rig v1 — 由 SurfCore 拷进桌宠的 dist/surfcore-video-rig.js，别在桌宠目录里手改（每次启动桌宠前会被覆盖）。
 * 源文件：plugins/surfcore/lib/pet-video/video-rig.js
 *
 * 「视频皮肤」播放器：皮肤清单里 rig 是 "video" 时，桌宠渲染层用它代替原来的分图层 PetRig。
 * 第一个用到它的是 Claude 娘（Claude-Chan 的 Q 版素材，见 lib/pet-skin-claude-chan.js）。
 *
 * 两部分：
 *   · ClipPlanner：纯逻辑，决定下一段播哪个片段（状态之间怎么过渡：直达片段 / 退场 → 换中心姿势 → 进场）。
 *   · VideoRig：两层 <img> 交替播放动态 AVIF（换片段时可淡入淡出），命中遮罩，接桌宠的命令。
 *
 * 和 PetRig 对外的方法一样（index.ts 只调这些）：scale、init、buildMask、setPointer、setDragging、hitTest、
 * regionAt、cursorAt、setHeadHover、regionHoverClosesEyes、playCommand、playSound、setScale。
 *
 * 小鲸鱼的状态 → 片段状态 由清单的 video.roles 决定（默认见 DEFAULT_ROLES）：
 *   平时 idle｜等她回 think｜她说话 talk｜摸头 pat｜戳她 poke｜专注模式 focus｜很久没动静 drowsy
 */
(function (root) {
  'use strict';

  var DEFAULT_ROLES = { idle: 'idle', think: 'thinking', talk: 'confirmation', pat: 'complete', poke: 'error', focus: 'reading', drowsy: 'drowsy' };
  var TIMING = {
    crossfadeMs: 220,        // 打断时两段之间淡入淡出
    preloadMs: 450,          // 提前这么久开始解码下一段，到点无缝换上
    drowsyAfterMs: 5 * 60 * 1000,
    thinkStopGraceMs: 600,   // 回复到了先等一下：紧跟着的「开始说话」直接接上，不先播「想完了」
    talkDemoMs: 2600,        // 菜单「说句话」这种没给时长的
    patHoldMs: 5500,         // 摸头后开心多久（进场动画本身约 5 秒）
    eventChance: 0.3,        // 一轮循环播完，有这个概率插一段小动作（喝茶、翻书…）
    eventCooldownMs: 12000,
  };

  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /* ───────────────────────── 排程（纯逻辑）───────────────────────── */

  function ClipPlanner(video, opts) {
    opts = opts || {};
    this.states = (video && video.states) || {};
    this.clips = (video && Array.isArray(video.clips)) ? video.clips : [];
    this.random = opts.random || Math.random;
    this.eventChance = typeof opts.eventChance === 'number' ? opts.eventChance : TIMING.eventChance;
    this.lastEventAt = {};
  }

  ClipPlanner.prototype.has = function (state) { return Boolean(state && this.states[state]); };
  ClipPlanner.prototype.hubOf = function (state) { return (this.states[state] && this.states[state].hub) || null; };
  ClipPlanner.prototype.atHub = function (state) { return Boolean(this.states[state] && this.states[state].atHub === true); };
  ClipPlanner.prototype.find = function (pred) {
    for (var i = 0; i < this.clips.length; i += 1) if (pred(this.clips[i])) return this.clips[i];
    return null;
  };
  ClipPlanner.prototype.filter = function (pred) { return this.clips.filter(pred); };
  ClipPlanner.prototype.loopsOf = function (state) { return this.filter(function (c) { return c.type === 'loop' && c.state === state; }); };
  ClipPlanner.prototype.hasLoop = function (state) { return this.loopsOf(state).length > 0; };
  ClipPlanner.prototype.pick = function (list) { return list.length ? list[Math.min(list.length - 1, Math.floor(this.random() * list.length))] : null; };

  /** 这段播完后她处在什么姿势：{ state, hub }（state 为 null 表示「在中心姿势上、还没进任何状态」） */
  ClipPlanner.prototype.poseAfter = function (clip) {
    if (!clip) return null;
    if (clip.type === 'loop' || clip.type === 'event' || clip.type === 'intro') return { state: clip.state, hub: this.hubOf(clip.state) };
    if (clip.type === 'direct') return { state: clip.to, hub: this.hubOf(clip.to) };
    if (clip.type === 'outro' || clip.type === 'transition') return { state: null, hub: clip.to || null };
    return null;
  };

  /** 循环片段：多段时尽量别连着播同一段。 */
  ClipPlanner.prototype.pickLoop = function (state, avoidId) {
    var loops = this.loopsOf(state);
    if (loops.length > 1 && avoidId) {
      var others = loops.filter(function (c) { return c.id !== avoidId; });
      if (others.length) return this.pick(others);
    }
    return this.pick(loops);
  };

  /** 一轮循环播完时，按概率挑一段小动作（尊重片段自己的 chance / cooldownMs / group）。 */
  ClipPlanner.prototype.pickEvent = function (state, at) {
    var self = this;
    var events = this.filter(function (c) { return c.type === 'event' && c.state === state; });
    if (!events.length || this.random() >= this.eventChance) return null;
    var ready = events.filter(function (c) {
      var key = c.group || c.id;
      var last = self.lastEventAt[key];
      return last === undefined || at - last >= (typeof c.cooldownMs === 'number' ? c.cooldownMs : TIMING.eventCooldownMs);
    });
    var chosen = this.pick(ready);
    if (!chosen) return null;
    if (typeof chosen.chance === 'number' && this.random() >= chosen.chance) return null;
    this.lastEventAt[chosen.group || chosen.id] = at;
    return chosen;
  };

  /**
   * 从 pose 走到 target 状态要播的过渡片段（不含 target 的循环）。
   * 有直达片段就用直达；否则 退场（不在中心姿势时）→ 换中心姿势（A↔B）→ 进场（target 不在中心姿势时）。
   * skipIntro：不播进场，调用方直接淡入 target 的循环（她说话时要马上有反应，进场动画要 5 秒）。
   */
  ClipPlanner.prototype.path = function (pose, target, opts) {
    var skipIntro = Boolean(opts && opts.skipIntro);
    var from = pose && pose.state;
    var hub = (pose && pose.hub) || this.hubOf(from);
    if (from === target) return [];
    var seq = [];
    if (from) {
      var direct = this.find(function (c) { return c.type === 'direct' && c.from === from && c.to === target; });
      if (direct) return [direct];
      if (!this.atHub(from)) {
        var outro = this.find(function (c) { return c.type === 'outro' && c.state === from; });
        if (outro) seq.push(outro);
      }
      hub = this.hubOf(from) || hub;
    }
    var toHub = this.hubOf(target);
    if (hub && toHub && hub !== toHub) {
      var hop = this.find(function (c) { return c.type === 'transition' && c.from === hub && c.to === toHub; });
      if (hop) seq.push(hop);
    }
    if (!this.atHub(target) && !skipIntro) {
      var intro = this.find(function (c) { return c.type === 'intro' && c.state === target; });
      if (intro) seq.push(intro);
    }
    return seq;
  };

  function kindOf(clip) {
    if (!clip) return 'none';
    return clip.type === 'loop' || clip.type === 'event' ? 'loop' : 'transition';
  }

  /* ───────────────────────── 状态机（纯逻辑：决定下一段）───────────────────────── */

  /**
   * 不碰 DOM 的「导演」：收命令、记标志，到点给出下一段要播什么。VideoRig 负责真的播放。
   * 单独拆出来是为了在 node 里测（scripts/test-pet-video-skin.mjs）。
   */
  function Director(video, opts) {
    opts = opts || {};
    this.planner = new ClipPlanner(video, opts);
    var roles = {};
    var given = (video && video.roles) || {};
    for (var k in DEFAULT_ROLES) roles[k] = given[k] || DEFAULT_ROLES[k];
    // 清单里没有的状态退回 idle（对应写错也不至于卡住）
    for (var r in roles) if (!this.planner.has(roles[r])) roles[r] = roles.idle;
    this.roles = roles;
    this.timing = {};
    for (var t in TIMING) this.timing[t] = TIMING[t];
    if (opts.timing) for (var t2 in opts.timing) this.timing[t2] = opts.timing[t2];
    this.pose = { state: null, hub: this.planner.hubOf(roles.idle) };
    this.queue = [];
    this.current = null;      // { clip, kind, endsAt }
    this.talking = false;
    this.talkUntil = 0;
    this.thinking = false;
    this.thinkStopAt = 0;
    this.focus = Boolean(opts.focus);
    this.reaction = null;     // { state, until, reached }
    this.cut = null;          // { skipIntro, force }
    this.wake = false;
    this.lastActivity = opts.at || 0;
  }

  Director.prototype.desired = function (at) {
    var r = this.roles;
    if (this.reaction && (!this.reaction.reached || at < this.reaction.until)) return this.reaction.state;
    if (this.reaction) this.reaction = null;
    if (this.thinkStopAt && at >= this.thinkStopAt) { this.thinking = false; this.thinkStopAt = 0; }
    if (this.talking || at < this.talkUntil) return r.talk;
    if (this.thinking) return r.think;
    if (this.focus) return r.focus;
    if (at - this.lastActivity > this.timing.drowsyAfterMs) return r.drowsy;
    return r.idle;
  };

  Director.prototype.activity = function (at) {
    // 只有真睡着了（超时后的第一下动静）才「惊醒」；醒着时鼠标在她身上来回移动不算
    var asleep = at - this.lastActivity > this.timing.drowsyAfterMs;
    var drowsy = this.roles.drowsy;
    if (asleep && (this.pose.state === drowsy || (this.current && this.current.clip && this.current.clip.state === drowsy))) {
      if (!this.wake) { this.wake = true; this.requestCut({}); }
    }
    this.lastActivity = at;
  };

  /**
   * 打断请求：
   *   skipIntro —— 不播进场，直接淡入目标循环（说话）；
   *   direct    —— 不走「退场 → 换中心姿势」，直接淡入目标的进场动画（摸头 / 戳她：要马上有反应）；
   *   force     —— 连进场 / 退场这种过渡也打断（skipIntro、direct 都隐含 force）。
   */
  Director.prototype.requestCut = function (cut) {
    var prev = this.cut || {};
    var skipIntro = Boolean(cut.skipIntro || prev.skipIntro);
    var direct = Boolean(cut.direct || prev.direct);
    this.cut = { skipIntro: skipIntro, direct: direct, force: Boolean(cut.force || prev.force || skipIntro || direct) };
  };

  /** 命令（来自桌宠主进程 pet:command 或点击）。返回是否认得。 */
  Director.prototype.command = function (cmd, at) {
    var r = this.roles;
    switch (cmd) {
      case 'talk-start':
        this.talking = true;
        this.activity(at);
        this.requestCut({ skipIntro: true });
        return true;
      case 'talk-stop':
        this.talking = false;
        return true;
      case 'talk':
        this.talkUntil = Math.max(this.talkUntil, at + this.timing.talkDemoMs);
        this.activity(at);
        this.requestCut({ skipIntro: true });
        return true;
      case 'think-start':
        this.thinking = true;
        this.thinkStopAt = 0;
        this.activity(at);
        this.requestCut({});
        return true;
      case 'think-stop':
        if (this.thinking) this.thinkStopAt = at + this.timing.thinkStopGraceMs;
        return true;
      case 'focus-on':
        this.focus = true;
        return true;
      case 'focus-off':
        this.focus = false;
        this.activity(at);
        return true;
      case 'pat':
      case 'tailpet':
      case 'wag':
        this.activity(at);
        if (this.reaction && this.reaction.state === r.pat) { this.reaction.until = Math.max(this.reaction.until, at + this.timing.patHoldMs); return true; }
        this.reaction = { state: r.pat, until: at + this.timing.patHoldMs, reached: false };
        // 摸头要马上有反应：打断任何片段（包括打瞌睡、进场退场），直接淡入「抱书」的循环，不播进场。
        // （2026-11-19 用户两次反馈「摸头和戳她没有用」：她常在打瞌睡，原来要先播 10 秒惊醒 + 5 秒退场；
        //   而抱书的进场动画前 2 秒几乎和待机一样，3～4 秒后才看得出来。）
        this.requestCut({ skipIntro: true });
        return true;
      case 'poke':
      case 'hop':
        this.activity(at);
        if (this.reaction && this.reaction.state === r.poke && !this.reaction.reached) return true;
        this.reaction = { state: r.poke, until: 0, reached: false };
        this.requestCut({ direct: true });
        return true;
      case 'blink':
      case 'mouth':
        this.activity(at);
        return true;
      default:
        return false;
    }
  };

  /** 现在该不该换片段（到点、或者有打断请求且当前片段可以打断）。 */
  Director.prototype.due = function (at, leadMs) {
    if (!this.current) return true;
    if (this.cut && (this.cut.force || this.current.kind === 'loop')) return true;
    return at >= this.current.endsAt - (leadMs || 0);
  };

  /**
   * 决定下一段并记账（pose、队列、事件冷却）。返回 { clip, fade, interrupted } 或 null（没有可播的）。
   * startAt：这段开始播放的时刻（预加载时是当前片段的结束时刻）。
   */
  Director.prototype.next = function (at, startAt) {
    var p = this.planner;
    var cut = this.cut;
    var interrupted = Boolean(cut && this.current && (cut.force || this.current.kind === 'loop') && at < this.current.endsAt);
    this.cut = null;
    var want = this.desired(at);
    var clip = null;
    var fade = interrupted;
    if (cut) this.queue = [];

    // 被吵醒：先播一段「惊醒」，再走正常路线
    if (this.wake) {
      this.wake = false;
      var drowsy = this.roles.drowsy;
      // 被摸 / 被戳 / 开口说话吵醒的：反应本身就是「醒了」，不再先播惊醒（只有鼠标移上去才播）
      if (this.pose.state === drowsy && want !== drowsy && !(cut && (cut.direct || cut.skipIntro))) {
        var jolt = p.find(function (c) { return c.type === 'event' && c.state === drowsy && /jolt/.test(c.id); });
        if (jolt) this.queue = [jolt];
      }
    }

    if (!this.queue.length && this.pose.state !== want) {
      if (cut && cut.skipIntro) {
        // 要马上有反应：不走过渡，直接淡入目标状态的循环
        this.pose = { state: want, hub: p.hubOf(want) };
        fade = true;
      } else if (cut && cut.direct) {
        // 摸 / 戳：跳过退场和换姿势，直接淡入目标的进场（没有进场就直接淡入循环）
        var intro = p.atHub(want) ? null : p.find(function (c) { return c.type === 'intro' && c.state === want; });
        if (intro) this.queue = [intro];
        else this.pose = { state: want, hub: p.hubOf(want) };
        fade = true;
      } else {
        this.queue = p.path(this.pose, want);
        if (!this.queue.length) {
          // 已经在中心姿势上（退场刚播完）就能直接接循环，不用淡入；从别的状态硬切才淡入
          fade = fade || Boolean(this.pose.state);
          this.pose = { state: want, hub: p.hubOf(want) };
        }
      }
    }

    if (this.queue.length) clip = this.queue.shift();
    else {
      var s = this.pose.state;
      if (s && p.hasLoop(s)) {
        var prevId = this.current && this.current.clip && this.current.clip.id;
        var wasEvent = this.current && this.current.clip && this.current.clip.type === 'event';
        // 小动作只在一轮循环正常播完后才插（开局第一段、刚被打断、刚播完小动作都不插）
        var afterLoop = Boolean(this.current && this.current.kind === 'loop' && !wasEvent);
        clip = (afterLoop && !interrupted && s === want) ? p.pickEvent(s, startAt) : null;
        clip = clip || p.pickLoop(s, prevId);
      } else {
        // 停在中心姿势或「一次性」状态的末尾：回到待机循环
        clip = p.pickLoop(this.roles.idle);
        if (clip) fade = fade || Boolean(s && s !== this.roles.idle);
      }
    }
    if (!clip) return null;
    this.pose = p.poseAfter(clip) || this.pose;
    if (this.reaction && !this.reaction.reached && this.pose.state === this.reaction.state) {
      this.reaction.reached = true;
      if (!this.reaction.until) this.reaction.until = 0;
    }
    return { clip: clip, fade: fade, interrupted: interrupted };
  };

  /** 片段真正开始播放时调用（解码完、换上那一刻）。 */
  Director.prototype.started = function (clip, at) {
    this.current = { clip: clip, kind: kindOf(clip), endsAt: at + (Number(clip.durationMs) || 5000) };
  };

  Director.prototype.snapshot = function () {
    return {
      pose: this.pose,
      current: this.current && this.current.clip ? this.current.clip.id : null,
      queue: this.queue.map(function (c) { return c.id; }),
      talking: this.talking,
      thinking: this.thinking,
      focus: this.focus,
      reaction: this.reaction ? this.reaction.state : null,
    };
  };

  /* ───────────────────────── 播放（DOM）───────────────────────── */

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function VideoRig(manifest, baseUrl, skin) {
    this.manifest = manifest;
    this.baseUrl = baseUrl;
    this.video = manifest.video || {};
    this.scale = (manifest.display && manifest.display.scale) || 0.44;
    this.director = new Director(this.video, { focus: Boolean(skin && skin.focus), at: now() });
    this.mask = null;
    this.maskW = 0;
    this.maskH = 0;
    this.serial = 0;
    this.pending = null;
    this.stageX = 0;
    this.stageY = 0;
  }

  VideoRig.prototype.init = function (host) {
    var self = this;
    var stage = document.createElement('div');
    stage.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
    this.stage = stage;
    // 两层图包在 body 里：摸 / 戳时整个人弹一下、抖一下（变形原点在脚底）
    var body = document.createElement('div');
    body.style.cssText = 'position:absolute;left:0;top:0;will-change:transform;';
    this.bodyEl = body;
    stage.appendChild(body);
    this.layers = [0, 1].map(function () {
      var img = document.createElement('img');
      img.decoding = 'async';
      img.draggable = false;
      img.alt = '';
      img.style.cssText = 'position:absolute;left:0;top:0;opacity:0;visibility:hidden;will-change:opacity;';
      body.appendChild(img);
      return img;
    });
    // 即时反馈层：爱心、汗滴这些叠在视频上面
    var fx = document.createElement('div');
    fx.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;';
    this.fxEl = fx;
    stage.appendChild(fx);
    this.front = this.layers[0];
    this.back = this.layers[1];
    host.appendChild(stage);
    this.loadMask();
    this.layout();
    window.addEventListener('resize', function () { self.layout(); });
    this.timer = setInterval(function () { self.tick(); }, 40);
    this.tick();
    return Promise.resolve();
  };

  VideoRig.prototype.loadMask = function () {
    var m = this.video.mask;
    if (!m || !m.data || !m.w || !m.h) return;
    try {
      var raw = atob(m.data);
      var bits = new Uint8Array(m.w * m.h);
      for (var i = 0; i < bits.length && i < raw.length; i += 1) bits[i] = raw.charCodeAt(i) ? 1 : 0;
      this.mask = bits;
      this.maskW = m.w;
      this.maskH = m.h;
    } catch (e) {
      this.mask = null;
    }
  };

  VideoRig.prototype.layout = function () {
    var w = window.innerWidth;
    // 脚下留白（renderer/pp-ring.ts 的地台环和字写在这一截里）：脚贴在留白上面
    var h = window.innerHeight - (Number(window.__tomopetFootroom) || 0);
    var c = this.manifest.canvas;
    var cw = c.w * this.scale;
    var ch = c.h * this.scale;
    // 和 PetRig.layout 同一套规则：装得下脚底贴窗口底边；装不下平滑过渡到头顶对齐。
    var headroom = 40;
    var sFit = (h - headroom) / c.h;
    var t = sFit > 0 ? clamp((this.scale - sFit) / (0.35 * sFit), 0, 1) : 0;
    var yBottom = h - ch;
    var yHead = headroom - this.manifest.hitbox.y * this.scale;
    this.stageX = (w - cw) / 2;
    this.stageY = yBottom + (yHead - yBottom) * t;
    this.stage.style.transform = 'translate(' + this.stageX + 'px,' + this.stageY + 'px)';
    this.bodyEl.style.width = cw + 'px';
    this.bodyEl.style.height = ch + 'px';
    this.bodyEl.style.transformOrigin = '50% ' + Math.round(((this.manifest.hitbox.y + this.manifest.hitbox.h) / c.h) * 100) + '%';
    for (var i = 0; i < this.layers.length; i += 1) {
      this.layers[i].style.width = cw + 'px';
      this.layers[i].style.height = ch + 'px';
    }
  };

  VideoRig.prototype.tick = function () {
    var at = now();
    var d = this.director;
    // 已经在解码下一段：让它照常换上（排程已经按它记了姿势），打断请求留到下一拍处理
    if (this.pending) return;
    if (!d.due(at, this.director.timing.preloadMs)) return;
    var interruptNow = Boolean(d.cut && d.current && (d.cut.force || d.current.kind === 'loop'));
    var startAt = interruptNow || !d.current ? at : Math.max(at, d.current.endsAt);
    var plan = d.next(at, startAt);
    if (!plan) return;
    if (plan.interrupted || plan.clip.type !== 'loop') this.log('播放 ' + plan.clip.id + (plan.interrupted ? '（打断上一段）' : '') + (plan.fade ? '（淡入）' : ''));
    this.prepare(plan.clip, plan.fade, plan.interrupted || !d.current ? at : startAt, plan.interrupted);
  };

  VideoRig.prototype.prepare = function (clip, fade, swapAt, interrupted) {
    var self = this;
    var serial = (this.serial += 1);
    var img = this.back;
    this.pending = { clip: clip, interrupted: interrupted };
    img.style.transition = 'none';
    img.style.opacity = '0';
    img.style.visibility = 'hidden';
    // 每次换一个查询串：同一个地址的动图在 Chromium 里共用一条时间线，不换就不会从第一帧开始
    img.src = this.baseUrl + clip.file + '?p=' + serial;
    var go = function () {
      if (serial !== self.serial) return;
      var wait = Math.max(0, swapAt - now());
      setTimeout(function () {
        if (serial !== self.serial) return;
        self.swap(img, clip, fade);
      }, wait);
    };
    var p = img.decode ? img.decode() : Promise.resolve();
    p.then(go, go);
  };

  VideoRig.prototype.swap = function (img, clip, fade) {
    var old = this.front;
    var ms = this.director.timing.crossfadeMs;
    img.style.visibility = 'visible';
    var tr = fade ? 'opacity ' + ms + 'ms linear' : 'none';
    img.style.transition = tr;
    old.style.transition = tr;
    void img.offsetWidth;
    img.style.opacity = '1';
    old.style.opacity = '0';
    this.front = img;
    this.back = old;
    this.pending = null;
    this.director.started(clip, now());
    var serial = this.serial;
    setTimeout(function () {
      if (old.style.opacity === '0') {
        old.style.visibility = 'hidden';
        if (serial === this.serial) old.removeAttribute('src');
      }
    }.bind(this), fade ? ms + 60 : 60);
  };

  VideoRig.prototype.toCanvas = function (x, y) {
    return { x: (x - this.stageX) / this.scale, y: (y - this.stageY) / this.scale };
  };

  VideoRig.prototype.hitTest = function (x, y) {
    var c = this.toCanvas(x, y);
    var hb = this.manifest.hitbox;
    if (c.x < hb.x || c.x > hb.x + hb.w || c.y < hb.y || c.y > hb.y + hb.h) return false;
    if (!this.mask) return true;
    var mx = Math.floor((c.x / this.manifest.canvas.w) * this.maskW);
    var my = Math.floor((c.y / this.manifest.canvas.h) * this.maskH);
    if (mx < 0 || my < 0 || mx >= this.maskW || my >= this.maskH) return false;
    return this.mask[my * this.maskW + mx] === 1;
  };

  VideoRig.prototype.regionAt = function (x, y) {
    if (!this.hitTest(x, y)) return null;
    var regions = (this.manifest.interaction && this.manifest.interaction.regions) || [];
    var c = this.toCanvas(x, y);
    for (var i = 0; i < regions.length; i += 1) {
      var s = regions[i].shape;
      if (!s) continue;
      if (s.type === 'ellipse') {
        var dx = (c.x - s.cx) / s.rx;
        var dy = (c.y - s.cy) / s.ry;
        if (dx * dx + dy * dy <= 1) return regions[i];
      } else if (c.x >= s.x && c.x <= s.x + s.w && c.y >= s.y && c.y <= s.y + s.h) return regions[i];
    }
    return null;
  };

  VideoRig.prototype.cursorAt = function (x, y) {
    if (!this.hitTest(x, y)) return null;
    var r = this.regionAt(x, y);
    return (r && r.cursor) || (this.manifest.interaction && this.manifest.interaction.cursor) || 'pointer';
  };

  /** 交给主进程做「透明处点穿」的遮罩（主进程每 16ms 用它判断鼠标在不在她身上）。 */
  VideoRig.prototype.buildMask = function () {
    if (!this.mask) return null;
    return { w: this.maskW, h: this.maskH, bits: this.mask };
  };

  VideoRig.prototype.setPointer = function () { this.director.activity(now()); };
  VideoRig.prototype.setDragging = function () { this.director.activity(now()); };
  VideoRig.prototype.setHeadHover = function () {};
  VideoRig.prototype.regionHoverClosesEyes = function () { return false; };
  VideoRig.prototype.playSound = function () { return false; };
  VideoRig.prototype.setScale = function (scale) { this.scale = scale; this.layout(); };
  /** 写进桌宠日志（start.log 里的 [renderer] 行）。只记命令和过渡片段，循环不记，量很小。 */
  VideoRig.prototype.log = function (text) {
    try { if (root.pet && typeof root.pet.log === 'function') root.pet.log('[video] ' + text); } catch (e) { /* 日志失败不影响播放 */ }
  };

  /* ── 即时反馈：视频动作是固定的、换起来要时间，摸 / 戳那一下要马上看得出「她感觉到了」 ──
   * 2026-11-19 用户：「看不出是在回应我」——日志里命令都到了、也换成了抱书，但抱书和待机差别小。
   * 所以每碰一下都叠一层：摸头 → 整个人轻轻弹一下 + 头顶飘爱心；戳她 → 抖一下 + 冒「!」和汗滴。 */

  /** 头部区域中心（画布坐标）：清单 regions 里 gesture=pat 的椭圆；没有就用包围盒上部。 */
  VideoRig.prototype.headPoint = function () {
    var regions = (this.manifest.interaction && this.manifest.interaction.regions) || [];
    for (var i = 0; i < regions.length; i += 1) {
      var s = regions[i].shape;
      if (regions[i].gesture === 'pat' && s && s.type === 'ellipse') return { x: s.cx, y: s.cy, rx: s.rx, ry: s.ry };
    }
    var hb = this.manifest.hitbox;
    return { x: hb.x + hb.w / 2, y: hb.y + hb.h * 0.2, rx: hb.w * 0.3, ry: hb.h * 0.17 };
  };

  VideoRig.prototype.wobble = function (kind) {
    var el = this.bodyEl;
    if (!el || typeof el.animate !== 'function') return;
    try {
      if (this.wobbleAnim) this.wobbleAnim.cancel();
      var frames = kind === 'poke'
        ? [{ transform: 'translateX(0) scale(1,1)' }, { transform: 'translateX(-5px) scale(1.03,0.96)' }, { transform: 'translateX(5px) scale(0.98,1.02)' },
           { transform: 'translateX(-3px) scale(1.01,0.99)' }, { transform: 'translateX(0) scale(1,1)' }]
        : [{ transform: 'scale(1,1)' }, { transform: 'scale(1.035,0.955)' }, { transform: 'scale(0.985,1.025)' }, { transform: 'scale(1,1)' }];
      this.wobbleAnim = el.animate(frames, { duration: kind === 'poke' ? 360 : 460, easing: 'ease-out' });
    } catch (e) { /* 动画失败不影响别的 */ }
  };

  /** 在头附近冒几个字符，往上飘、淡出。 */
  VideoRig.prototype.burst = function (kind) {
    var fx = this.fxEl;
    if (!fx || typeof document === 'undefined') return;
    var head = this.headPoint();
    var s = this.scale;
    var items = kind === 'poke'
      ? [{ ch: '!', color: '#ff8a3d', size: 38, dx: 0.95, dy: -0.75, weight: 900 }, { ch: '💦', color: '', size: 22, dx: -0.95, dy: -0.35, weight: 400 }]
      : [{ ch: '♥', color: '#ff5d8f', size: 22, dx: -0.55, dy: -0.95, weight: 400 }, { ch: '♥', color: '#ff86ad', size: 16, dx: 0.1, dy: -1.15, weight: 400 },
         { ch: '♥', color: '#ff5d8f', size: 19, dx: 0.7, dy: -0.9, weight: 400 }];
    for (var i = 0; i < items.length; i += 1) {
      var it = items[i];
      var span = document.createElement('span');
      span.textContent = it.ch;
      var jitter = (Math.random() - 0.5) * 0.25;
      var x = (head.x + head.rx * (it.dx + jitter)) * s;
      var y = (head.y + head.ry * it.dy) * s;
      span.style.cssText = 'position:absolute;left:' + x + 'px;top:' + y + 'px;transform:translate(-50%,-50%);font-size:' + it.size + 'px;font-weight:' + it.weight +
        ';line-height:1;white-space:nowrap;' + (it.color ? 'color:' + it.color + ';' : '') +
        'text-shadow:0 1px 2px rgba(0,0,0,.35);font-family:"Segoe UI Emoji","Segoe UI Symbol",sans-serif;';
      fx.appendChild(span);
      var rise = kind === 'poke' ? 14 : 34;
      var dur = kind === 'poke' ? 900 : 1300;
      var anim = null;
      try {
        anim = span.animate([
          { opacity: 0, transform: 'translate(-50%,-50%) scale(0.4)' },
          { opacity: 1, transform: 'translate(-50%,-70%) scale(1.15)', offset: 0.18 },
          { opacity: 1, transform: 'translate(-50%,' + (-50 - rise) + '%) scale(1)', offset: 0.7 },
          { opacity: 0, transform: 'translate(-50%,' + (-50 - rise * 1.6) + '%) scale(0.9)' },
        ], { duration: dur, delay: i * 90, easing: 'ease-out', fill: 'both' });
      } catch (e) { anim = null; }
      (function (node) {
        var done = function () { if (node.parentNode) node.parentNode.removeChild(node); };
        if (anim && anim.finished) anim.finished.then(done, done);
        else setTimeout(done, dur + 400);
      })(span);
    }
  };

  VideoRig.prototype.playCommand = function (cmd) {
    var name = String(cmd || '');
    var before = this.director.snapshot();
    if (/^(pat|tailpet|wag)$/.test(name)) { this.wobble('pat'); this.burst('pat'); }
    else if (/^(poke|hop)$/.test(name)) { this.wobble('poke'); this.burst('poke'); }
    var known = this.director.command(name, now());
    if (known && !/^(blink|mouth)$/.test(name)) {
      this.log('命令 ' + name + '（当时在播 ' + (before.current || '无') + '，姿势 ' + (before.pose.state || '中心') + (this.pending ? '，下一段正在解码' : '') + '）');
    }
    this.tick();
  };
  /** 调试：window.__rig.debugState() */
  VideoRig.prototype.debugState = function () { return this.director.snapshot(); };

  root.__SurfcoreVideoRig = VideoRig;
  root.__SurfcoreVideoDirector = Director;
  root.__SurfcoreClipPlanner = ClipPlanner;
  root.__SurfcoreVideoRoles = DEFAULT_ROLES;
})(typeof window !== 'undefined' ? window : globalThis);
