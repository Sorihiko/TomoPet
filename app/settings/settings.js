/**
 * 设置窗口的页面脚本。只通过 window.api.call(name, payload) 和主进程说话（app/api.js）。
 *
 * 规矩：
 *   · 每个操作的结果都显示出来：成功是一条会自己消失的提示；失败是红色提示（哪里不对 + 现在该点什么 + 错误码），要手动关。
 *   · 所有来自外面的文字（歌名、她说的话、错误信息）只用 textContent 放进页面。
 *   · 开关 / 选项一改就存；输入框改完离开（或回车）就存。存不进去的值会被拒绝并提示，输入框回到原来的值。
 *   · 分页（2026-11-20 改版）：左边每一项是一页，地址栏 #overview / #watch / … 决定显示哪一页；「下一步」点了跳到对应那页。
 */
(function () {
  'use strict';
  const api = window.api;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  let latest = null;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child) node.append(child);
    return node;
  }

  // ── 提示 ───────────────────────────────────────────────────────────────────
  function toast(title, { detail = '', code = '', error = false } = {}) {
    const box = el('div', { class: `toast${error ? ' error' : ''}` }, el('div', { class: 'title', text: title }));
    if (detail) box.append(el('div', { text: detail }));
    if (code) box.append(el('div', { class: 'code', text: code }));
    if (error) {
      const close = el('button', { text: '知道了' });
      close.addEventListener('click', () => box.remove());
      box.append(close);
    } else {
      setTimeout(() => box.remove(), 3200);
    }
    $('#toasts').append(box);
    while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
  }
  const showFailure = (result) => toast(result.error || '没成功', { detail: result.hint || '', code: result.code || '', error: true });

  async function call(name, payload) {
    let result;
    try { result = await api.call(name, payload); } catch (error) { result = { ok: false, code: 'api.unreachable', error: `和主程序说不上话：${String(error && error.message ? error.message : error)}`, hint: '重开程序。' }; }
    if (!result || result.ok !== true) { showFailure(result || { error: '没有返回' }); return result || { ok: false }; }
    if (result.status && result.config) { latest = result; render(); }
    return result;
  }

  // ── 设置项：读 / 写 ────────────────────────────────────────────────────────
  const getPath = (object, dotted) => dotted.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);
  const patchFor = (dotted, value) => { const [section, key] = dotted.split('.'); return { [section]: { [key]: value } }; };

  function fillInputs() {
    const config = latest.config;
    for (const input of $$('[data-cfg]')) {
      if (input === document.activeElement && input.type !== 'checkbox' && input.type !== 'radio') continue; // 正在改的不动
      const value = getPath(config, input.dataset.cfg);
      if (input.type === 'checkbox') input.checked = value === true;
      else if (input.type === 'radio') input.checked = input.value === value;
      else if (input.tagName === 'SELECT') { if ([...input.options].some((option) => option.value === String(value))) input.value = String(value); }
      else input.value = value ?? '';
    }
    for (const input of $$('[data-secret]')) {
      if (input === document.activeElement || input.value) continue;
      const has = { 'llm.apiKey': config.llm.hasApiKey, 'tts.accessKey': config.tts.hasAccessKey, 'tts.breezeKey': config.tts.hasBreezeKey, 'osuApi.clientSecret': config.osuApi && config.osuApi.hasClientSecret }[input.dataset.secret] === true;
      input.placeholder = has ? '已填（不显示）；要换就直接输入新的' : '还没填';
    }
  }

  async function saveField(input) {
    let value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'number' || input.type === 'range') value = input.value === '' ? '' : Number(input.value);
    else value = input.value;
    let patch = patchFor(input.dataset.cfg, value);
    // 换接口时把地址和模型名换成那一家的常用值（之后可以再改）。
    if (input.dataset.cfg === 'llm.provider' && latest && latest.presets[value]) patch = { llm: { provider: value, ...latest.presets[value] } };
    const result = await call('config.save', { patch });
    if (!result.ok) { input.blur(); fillInputs(); return; }
    if (input.type !== 'range') toast('已保存');
  }

  document.addEventListener('change', (event) => {
    const input = event.target;
    // 开机自启：存在系统的登录项里，不在设置文件里
    if (input.id === 'autostart') {
      input.disabled = true;
      call('app.autostart', { on: input.checked }).then((result) => {
        input.disabled = false;
        if (result.ok) toast(result.autostart ? '开机会自动启动了' : '开机不再自动启动', { detail: result.autostart ? '开机后只待在右下角托盘，不弹设置窗口。' : '' });
        else input.checked = !input.checked;
      });
      return;
    }
    if (input.dataset && input.dataset.cfg) saveField(input);
    else if (input.dataset && input.dataset.secret) {
      const text = input.value.trim();
      if (!text) return;
      call('config.save', { patch: patchFor(input.dataset.secret, text) }).then((result) => {
        input.value = '';
        if (result.ok) toast('Key 已保存');
        fillInputs();
      });
    }
  });
  // 滑块拖过的那段上色：样式里的 --pct 按当前值算（CSS 拿不到 range 的值）。
  const paintRange = (input) => {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct))}%`);
  };
  document.addEventListener('input', (event) => {
    if (event.target.type === 'range') paintRange(event.target);
    if (event.target.dataset && event.target.dataset.cfg === 'pet.scale') $('#scale-value').textContent = `${Math.round(Number(event.target.value) * 100)}%`;
  });

  // ── 分页 ───────────────────────────────────────────────────────────────────
  const PAGES = ['overview', 'pet', 'watch', 'persona', 'llm', 'tts', 'obs', 'advanced']; // 2026-11-22 用户：角色挪到总览后面
  // 「下一步」那一条说的是哪一块（core/next-step.js 的 section）→ 在哪一页。
  const PAGE_OF_SECTION = { status: 'overview', watch: 'watch', persona: 'persona', llm: 'llm', tts: 'tts', pet: 'pet', obs: 'obs', about: 'advanced', rulers: 'advanced', plays: 'advanced' };
  function showPage(name) {
    const page = PAGES.includes(name) ? name : 'overview';
    for (const section of $$('main > .page')) section.hidden = section.dataset.page !== page;
    for (const link of $$('#pages-nav a')) link.classList.toggle('active', link.dataset.page === page);
    $('main').scrollTop = 0;
  }
  function goto(section) {
    const page = PAGE_OF_SECTION[section] || section;
    if (location.hash.slice(1) !== page) location.hash = page; else showPage(page);
  }
  window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));
  showPage(location.hash.slice(1));

  // ── 皮肤卡片：点一下就换（桌面和 OBS 用同一套） ─────────────────────────────
  // 鼠标停在别的角色卡上不再切换展示台（2026-11-22 用户：没选中的时候上面的预览不用切换角色）；点一下换上才换
  document.addEventListener('click', async (event) => {
    const card = event.target.closest('.skin-card');
    if (!card || card.classList.contains('broken') || card.classList.contains('selected')) return;
    card.disabled = true;
    const result = await call('config.save', { patch: { pet: { skin: card.dataset.skin } } });
    card.disabled = false;
    if (result.ok) toast('换好了', { detail: card.querySelector('.skin-name').firstChild.textContent });
  });

  // ── 按钮 ───────────────────────────────────────────────────────────────────
  const DONE = {
    'watch.test': (r) => ['她说了', r.said],
    'counter.sync': (r) => ['已装进 tosu', r.counterSynced && r.counterSynced.dir],
    'plays.clear': () => ['已清空', ''],
    'llm.test': (r) => ['模型通了', `${r.model} 回了「${r.text}」，用了 ${(r.ms / 1000).toFixed(1)} 秒、${r.tokens} 个 token`],
    'tts.test': (r) => ['正在念', `${(r.durationMs / 1000).toFixed(1)} 秒${r.cached ? '（用的缓存）' : ''}：${r.text}`],
    'osuapi.test': () => ['osu! 官网通了', '下次选图时她就会去看这张图的玩家标签。'],
    'tts.voices': (r) => { fillBreezeVoices(r.voices); return [`找到 ${r.voices.length} 个官方中文音色`, r.voices.length ? '在旁边的下拉框里挑一个，试听一下。' : '一个都没有：过一会儿再试。']; },
    'skin.import': (r) => (r.canceled ? null : ['皮肤已导入并换上', `${r.imported.name}${r.imported.warnings.length ? `。注意：${r.imported.warnings.join('；')}` : ''}`]),
    'tosu.pickDir': (r) => (r.canceled ? null : ['已记下 tosu 的位置', '']),
    'update.check': (r) => { const u = r.app && r.app.update; if (!u) return null; return u.available && u.latest ? [`有新版本 ${u.latest.version}`, u.canInstall ? '点「更新」：下载完程序会退出、装好后自己重新打开，设置和数据不受影响。' : '从源码运行的：在项目文件夹里 git pull 更新。'] : ['已经是最新版', `现在是 ${u.current}`]; },
    'update.install': () => ['开始下载新版本', '下载完程序会退出，装好后自己重新打开。'],
    'pet.recenter': (r) => (r.moved ? ['回去了', ''] : ['桌面角色没开着', '先在「角色」里打开「在桌面上显示角色」。']),
  };
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button, a');
    if (!button) return;
    const data = button.dataset;
    if (data.call) {
      if (data.confirm && !window.confirm(data.confirm)) return;
      button.disabled = true;
      try {
        const result = await call(data.call);
        const message = result.ok && DONE[data.call] ? DONE[data.call](result) : null;
        if (message) toast(message[0], { detail: message[1] || '' });
      } finally {
        button.disabled = false;
      }
    } else if (data.copy) {
      const result = await call('clipboard.copy', { text: $(`#${data.copy}`).textContent });
      if (result.ok) toast('已复制');
    } else if (data.open) {
      call('external.open', { url: $(`#${data.open}`).textContent });
    } else if (data.openUrl) {
      event.preventDefault();
      call('external.open', { url: data.openUrl });
    } else if (button.id === 'btn-clear-tosudir') {
      const result = await call('config.save', { patch: { counter: { tosuDir: '' } } });
      if (result.ok) toast('改成自动找正在运行的 tosu');
    }
  });

  // 自动更新那一行：现在的版本、查的结果、下载进度；有新版本时露出「更新」和「看看改了什么」
  function renderUpdate(u) {
    const info = $('#update-info');
    if (!info) return;
    const install = $('#update-install');
    const notes = $('#update-notes');
    if (!u) { info.textContent = ''; install.hidden = true; notes.hidden = true; return; }
    const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
    let text = `现在是 ${u.current}`;
    if (u.phase === 'downloading' && u.progress) text = `正在下载 ${u.latest.version}：${mb(u.progress.received)} / ${mb(u.progress.total)}`;
    else if (u.phase === 'extracting') text = `正在解压 ${u.latest.version}…`;
    else if (u.phase === 'restarting') text = '马上退出，装好后自己重新打开';
    else if (u.checking) text += '，正在检查…';
    else {
      // 有新版本和出错可能同时有（比如点了「更新」但没装上）：两样都写出来（复核发现原来出错被「有新版本」盖住了）
      if (u.available && u.latest) text += `，有新版本 ${u.latest.version}${u.latest.hasAsset ? '' : '（还没有安装包）'}${u.canInstall ? '' : '（从源码运行的：用 git pull 更新）'}`;
      else if (!u.error && u.lastChecked) text += '，已经是最新版';
      if (u.error) text += `。没成功：${u.error.error}（${u.error.hint}）`;
    }
    info.textContent = text;
    install.hidden = !(u.available && u.latest && u.latest.hasAsset && u.canInstall);
    install.disabled = Boolean(u.phase);
    if (u.latest) install.textContent = `更新到 ${u.latest.version}`;
    $('#update-check').disabled = Boolean(u.checking || u.phase);
    notes.hidden = !(u.available && u.latest && u.latest.pageUrl);
    if (u.latest) notes.dataset.openUrl = u.latest.pageUrl;
  }

  // ── 显示 ───────────────────────────────────────────────────────────────────
  const KIND = { start: '开局', combo: '连击关口', 'combo-break': '断连', 'acc-drop': '掉准度', break: '休息段', 'rank-up': '超人', 'rank-down': '被超', retry: '重开', finish: '打完', fail: '失败', quit: '退出' };
  const RESULT = { finish: '打完', fail: '失败', quit: '退出' };
  const clock = (at) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const pill = (text, kind) => el('span', { class: `pill ${kind}`, text });
  const setChildren = (node, ...children) => node.replaceChildren(...children.filter(Boolean));
  // 皮肤缩略图的地址：页面和皮肤同源（osupet://local），走主进程的本地文件协议（core/local-files.js）。
  const thumbUrl = (skin) => (skin && skin.thumb ? `/skin/${encodeURIComponent(skin.id)}/${skin.thumb.split('/').map(encodeURIComponent).join('/')}` : '');
  const initialOf = (name) => Array.from(String(name || '?').replace(/（.*$/, ''))[0] || '?';
  // 一张图：有地址就显示图，没有就显示名字首字。
  function setArt(img, initial, url, name) {
    if (url) { if (img.getAttribute('src') !== url) img.src = url; img.hidden = false; initial.hidden = true; }
    else { img.hidden = true; img.removeAttribute('src'); initial.hidden = false; initial.textContent = initialOf(name); }
  }
  let skinGridKey = '';
  function renderSkinGrid(skins, selected) {
    // 每 1.5 秒刷新一次状态：列表和选中的没变就不重画（不然缩略图会闪）。
    const key = JSON.stringify([selected, skins.map((s) => [s.id, s.name, s.ok, s.thumb])]);
    if (key === skinGridKey) return;
    skinGridKey = key;
    const cards = skins.map((skin) => {
      const art = el('div', { class: 'skin-art' });
      const url = skin.ok ? thumbUrl(skin) : '';
      if (url) { // 不用 loading=lazy：卡片的 clip-path（鼠标放上去探出框）会让 Chromium 的懒加载一直不触发，缩略图空白（离屏自检发现）；15 张本地小图直接加载
        const img = el('img', { alt: '', src: url }); img.addEventListener('error', () => { img.replaceWith(el('div', { class: 'skin-initial', text: initialOf(skin.name) })); }); art.append(img); }
      else art.append(el('div', { class: 'skin-initial', text: initialOf(skin.name) }));
      // 卡片上的小字只在有话说时出现：自己导入的、坏了的（2026-11-21 用户：「姿势皮肤」这种类型名对人没用）。
      const meta = skin.ok ? (skin.source === 'user' ? '自己导入的' : '') : '有问题，用不了';
      const name = el('div', { class: 'skin-name' }, document.createTextNode(skin.name), ...(meta ? [el('span', { class: 'skin-meta', text: meta })] : []));
      const card = el('button', { class: `skin-card${skin.id === selected ? ' selected' : ''}${skin.ok ? '' : ' broken'}`, type: 'button', title: skin.ok ? skin.name : `${skin.error.error}。${skin.error.hint}` }, art, name);
      card.dataset.skin = skin.id;
      return card;
    });
    setChildren($('#skin-grid'), ...(cards.length ? cards : [el('p', { class: 'note', text: '一套皮肤都没有：把 CrossPet 的 characters 文件夹放进程序文件夹的 art/crosspet/ 再 npm start，或者点「导入皮肤」。' })]));
    $('#skin-count').textContent = skins.length ? `${skins.length} 位` : '';
  }

  // ── 角色页的展示台：大图在聚光灯下，几个姿势轮着换（2026-11-21：像游戏选角色）──────────────
  // 展示选中的那位（stage.hover 留着但一直是 null：鼠标停在卡片上预览已经去掉）。两张图交替淡入淡出，不会闪。
  const stage = { hover: null, shownId: '', poses: [], index: 0, front: 0, timer: null, pinnedUntil: 0 };
  const SKIN_URL = (skinId, file) => `/skin/${encodeURIComponent(skinId)}/${String(file).split('/').map(encodeURIComponent).join('/')}`;
  function stageSkin() {
    const skins = (latest && latest.skins) || [];
    const id = stage.hover || stage.selected;
    return skins.find((s) => s.id === id && s.ok) || skins.find((s) => s.id === stage.selected) || null;
  }
  function stageShowPose(i) {
    const skin = stageSkin();
    if (!skin || !stage.poses.length) return;
    stage.index = (i + stage.poses.length) % stage.poses.length;
    const imgs = [$('#stage-img-a'), $('#stage-img-b')];
    const next = imgs[1 - stage.front];
    const url = SKIN_URL(skin.id, stage.poses[stage.index].file);
    const reveal = () => { next.classList.add('on'); imgs[stage.front].classList.remove('on'); stage.front = 1 - stage.front; };
    if (next.getAttribute('src') === url && next.complete) reveal();
    else { next.onload = reveal; next.src = url; }
    for (const [k, b] of [...$('#stage-poses').children].entries()) b.classList.toggle('on', k === stage.index);
  }
  function showStage() {
    const skin = stageSkin();
    const previewing = Boolean(stage.hover && skin && skin.id !== stage.selected);
    const eyebrow = $('#stage-eyebrow');
    eyebrow.textContent = previewing ? '点一下换上' : '使用中';
    eyebrow.classList.toggle('preview', previewing);
    if (!skin) { $('#stage-name').textContent = '还没有角色'; return; }
    if (skin.id === stage.shownId) return;
    stage.shownId = skin.id;
    // 名字「DeepSeek·女仆装」：大字是角色，下面一块是服装
    const [who, ...outfit] = String(skin.name).split('·');
    $('#stage-name').textContent = who;
    $('#stage-outfit').textContent = outfit.join('·');
    stage.poses = skin.poses && skin.poses.length ? skin.poses : skin.thumb ? [{ key: 'idle', label: '待机', file: skin.thumb }] : [];
    $('#stage-initial').hidden = stage.poses.length > 0;
    $('#stage-initial').textContent = initialOf(skin.name);
    for (const img of [$('#stage-img-a'), $('#stage-img-b')]) if (!stage.poses.length) img.classList.remove('on');
    setChildren($('#stage-poses'), ...(stage.poses.length > 1 ? stage.poses.map((pose, i) => {
      const b = el('button', { type: 'button', text: pose.label });
      b.addEventListener('click', () => { stage.pinnedUntil = Date.now() + 6000; stageShowPose(i); });
      return b;
    }) : []));
    stageShowPose(0);
  }
  // 每 2.6 秒换下一个姿势（刚点过姿势按钮的 6 秒内不换；不在角色页、窗口藏着时也不换）
  stage.timer = setInterval(() => {
    if (document.hidden || $('#pet').hidden || stage.poses.length < 2 || Date.now() < stage.pinnedUntil) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    stageShowPose(stage.index + 1);
  }, 2600);
  const RANK_CLASS = (rank) => `r-${String(rank || '').toLowerCase()}`;
  function playResult(play) {
    if (play.result === 'finish') return `${play.rank || '?'}${play.fullCombo ? ' 全连' : ''}${play.pp ? ` ${play.pp}pp` : ''}`;
    return `${RESULT[play.result] || play.result}${play.progress != null ? ` ${Math.round(play.progress * 100)}%` : ''}`;
  }

  /** Breeze 的官方音色填进下拉框（选了就存成 tts.breezeVoice）。 */
  function fillBreezeVoices(voices) {
    const select = $('#breeze-voices');
    const GENDER = { female: '女', male: '男', neutral: '中性' };
    select.textContent = '';
    const head = document.createElement('option');
    head.value = '';
    head.textContent = '— 选一个音色 —';
    select.append(head);
    for (const v of voices) {
      const option = document.createElement('option');
      option.value = v.id;
      option.textContent = [v.name, GENDER[v.gender] || '', v.tone.join(' ')].filter(Boolean).join(' · ');
      if (v.description) option.title = v.description;
      select.append(option);
    }
    select.hidden = false;
    select.value = latest.config.tts.breezeVoice || '';
  }

  /** 玩家标签（osu! 官网）：上一张图查到了什么；没填 / 没有 / 出错说清楚。 */
  function mapInfoText(m) {
    if (!m) return '';
    if (m.apiReady && m.apiReady.ok === false) return '还没填：填好之后点「试一下」。';
    const last = m.last;
    if (!last) return '选一张图后，这里显示它的玩家标签。';
    const name = `${last.title}${last.version ? ` [${last.version}]` : ''}`;
    if (last.tagsError) return `${name}：查标签失败（${last.tagsError.error}）${last.tagsError.hint ? ` ${last.tagsError.hint}` : ''}`;
    if (last.tags === null) return `${name}：正在查……`;
    if (last.tags.length) return `${name}：${last.tags.map((t) => `${t.name}（${t.count} 票）`).join('、')}`;
    const why = { 'no-set': '这张是本地图，官网上没有', 'not-on-site': '官网上找不到这张图', edited: '这张图本地改过，和官网的对不上', 'no-tags': '官网上还没人给它打够 5 票的标签' }[last.tagsReason] || '没有玩家标签';
    return `${name}：${why}${last.profileText ? `；从谱面看：${last.profileText}` : ''}`;
  }

  /** 难段预告的状态：上一张图找到了哪几段、提示语音准备好没有。 */
  function headsUpText(h) {
    if (!h || h.mode === 'off') return '';
    const KINDS = { stream: '串', jump: '大跳', 'stream-jump': '先串后跳', 'jump-stream': '先跳后串', alternate: '串跳轮着来', speed: '变速' };
    const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
    const parts = [];
    if (h.map) {
      // 串的样子（core/patterns.js streamShape）：宽间距串、断开的串……
      const SHAPES = { spaced: '宽间距串', cut: '断开的串', stacked: '叠串', jumpy: '来回跳的串' };
      const nameOf = (s) => {
        // 难度曲线上的高峰（规则没认出来的难处）：按主要考什么叫
        if (s.kind === 'peak') return { aim: 'aim 难点', speed: '手速难点', reading: '读图难点' }[s.sub] || '难点';
        if (s.kind !== 'stream' || !SHAPES[s.sub]) return KINDS[s.kind] || s.kind;
        // 几截并起来的长串，中间有一截样子特别的
        return s.mixed ? `长串（中间有${SHAPES[s.sub]}）` : SHAPES[s.sub];
      };
      const list = h.map.sections.map((s) => `${mmss(s.start)} ${nameOf(s)}${s.count ? ` ${s.count} 下` : ''}`).join('、');
      parts.push(h.map.error ? `${h.map.title}：${h.map.error}` : `${h.map.title} [${h.map.version}]：${list || '没有明显的难段'}`);
    } else parts.push('打开一张图后，这里显示找到的难段。');
    if (h.blocked === 'replay') parts.push('在看回放 / 观战，不报。');
    if (h.mode === 'voice') parts.push(h.voices.error ? `提示语音：${h.voices.error.error}` : `提示语音 ${h.voices.ready} / ${h.voices.total} 句已合成`);
    if (h.lastFired) parts.push(`上一次：${clock(h.lastFired.at)}「${h.lastFired.cue}」`);
    return parts.join('　');
  }

  function render() {
    const { status, config, skins, nextSteps, app } = latest;
    fillInputs();
    if (app.logoUrl && $('#logo').hidden) { $('#logo').src = app.logoUrl; $('#logo').hidden = false; }
    $('#scale-value').textContent = `${Math.round(config.pet.scale * 100)}%`;
    for (const range of $$('input[type="range"]')) paintRange(range);
    $('#secret-note').textContent = config.secretsEncrypted ? '（用系统的加密存着）' : '（这台电脑上系统加密不可用，是明文存的）';
    $('#headsup-info').textContent = headsUpText(status.headsUp);
    $('#osuapi-info').textContent = mapInfoText(status.mapInfo);
    // 开机自启的开关照系统里的状态（正在改的那一下不动）
    const auto = app.autostart || { supported: false, on: false };
    const autoBox = $('#autostart');
    if (!autoBox.disabled) autoBox.checked = auto.on === true;
    autoBox.closest('.toggle').hidden = auto.supported !== true;
    // 脚下的 pp 环：环关着时下面的选项变淡、点不了；「字色」只对「只有字」有用，别的样子时变淡；没画曲线时曲线样子变淡
    $('.hud-opts').classList.toggle('off', config.pet.hud === false);
    $('#hud-ink').classList.toggle('dim', config.pet.hudLayout !== 'type');
    $('#hud-curve-style').classList.toggle('dim', config.pet.hudCurve === false);
    renderUpdate(app.update);
    // 语音页：只显示选中那一家要填的东西
    $('#tts-volc').hidden = config.tts.provider === 'breeze';
    $('#tts-breeze').hidden = config.tts.provider !== 'breeze';

    // 总开关
    const master = $('.master');
    master.classList.toggle('on', config.watch.enabled === true);
    $('#master-state').textContent = config.watch.enabled ? (status.tosu.connected ? '在看 · tosu 已连上' : '在等 tosu') : '关着';

    // 下一步（点一条跳到对应那页）；总览页签上挂一个数字
    $('#steps-card').hidden = nextSteps.length === 0;
    setChildren($('#steps'), ...nextSteps.map((step) => {
      const item = el('li', { class: step.level }, el('div', { class: 'what', text: step.text }), step.hint ? el('div', { class: 'how', text: step.hint }) : null, step.code ? el('div', { class: 'code', text: step.code }) : null);
      item.addEventListener('click', () => goto(step.section));
      return item;
    }));
    const errors = nextSteps.filter((s) => s.level === 'error').length;
    const warns = nextSteps.filter((s) => s.level === 'warn').length;
    const badge = $('#nav-badge');
    badge.hidden = errors + warns === 0;
    badge.textContent = String(errors || warns);
    badge.classList.toggle('warn', errors === 0);

    // 总览：角色
    const current = skins.find((s) => s.id === (status.pet?.skinId || config.pet.skin)) || skins.find((s) => s.id === config.pet.skin) || null;
    $('#hero-name').textContent = status.persona.name || '她';
    $('#hero-skin').textContent = current ? current.name : '还没有皮肤';
    setArt($('#hero-img'), $('#hero-initial'), current && current.ok ? thumbUrl(current) : '', current ? current.name : status.persona.name);

    // 总览：她刚说的那句（对话气泡）
    const last = status.lastComment;
    $('#last-bubble').classList.toggle('empty', !last);
    $('#st-last-meta').textContent = last ? `${clock(last.at)} · ${KIND[last.kind] || last.kind}${last.voiced ? ' · 念了' : ''}` : '上一句';
    $('#st-last').textContent = last ? last.text : '还没说过话。打一把，或者点下面「让她说一句试试」。';

    // 总览：四块数据卡
    const tosu = status.tosu;
    setChildren($('#st-tosu'), !status.watch.enabled ? pill('关着', 'idle') : tosu.connected ? pill('已连上', 'ok') : pill('还没连上', 'bad'));
    $('#st-tosu-url').textContent = tosu.url;
    const pct = Math.min(100, Math.round((status.today.said / Math.max(1, status.today.limit)) * 100));
    $('#st-today-count').textContent = `${status.today.said} / ${status.today.limit} 句`;
    $('#st-today-bar').style.setProperty('--pct', `${pct}%`);
    $('#st-today-pct').textContent = `${pct}%`;
    $('#st-llm-calls').textContent = `${status.today.llmCalls} 次`;
    $('#st-today').textContent = `约 ${status.today.tokens} 个 token（从这次打开程序算起）`;
    const playing = status.playing;
    $('#tile-playing').classList.toggle('live', Boolean(playing));
    $('#st-playing-label').textContent = playing ? (playing.replay ? '在看回放' : '正在打') : '现在';
    $('#st-playing').textContent = playing ? `${playing.map.title || '（读不到歌名）'}${playing.map.version ? ` [${playing.map.version}]` : ''}` : (tosu.connected ? '没在打图' : '—');
    $('#st-playing').title = $('#st-playing').textContent;
    $('#st-playing-sub').textContent = playing
      ? [playing.map.stars ? `${playing.map.stars}★` : '', playing.mods ? `+${playing.mods}` : '', `${playing.acc}%`, `${playing.combo} 连`, `miss ${playing.miss}`, playing.retries ? `重开 ${playing.retries} 次` : ''].filter(Boolean).join(' · ')
      : (tosu.connected ? '进一张图就会显示' : '先打开 tosu 和 osu!');

    // 总览：最近没说的（时间线）
    setChildren($('#st-skipped'), ...(status.skipped.length ? status.skipped.slice(0, 5).map((item) => el('li', {},
      el('div', { class: 'tl-head' },
        el('span', { class: 'tl-time', text: clock(item.at) }),
        el('span', { class: 'tl-kind', text: `${item.sliderBreak ? '滑条断' : KIND[item.kind] || item.kind}${item.lostCombo ? ` · ${item.lostCombo} 连${item.maxCombo ? ` / ${item.maxCombo}` : ''}` : ''}` })),
      el('div', { class: 'tl-why', text: item.why }))) : [el('li', { class: 'empty', text: '没有。该说的她都说了。' })]));

    // 总览：最近几把（前 5 把）
    setChildren($('#plays-mini'), ...(status.plays.length ? status.plays.slice(0, 5).map((play) => {
      const rankText = play.result === 'finish' ? (play.fullCombo ? 'FC' : (play.rank || '?')) : (play.result === 'fail' ? '失败' : '退出');
      const rankClass = play.result === 'finish' ? (play.fullCombo ? 'fc' : RANK_CLASS(play.rank)) : 'fail';
      const detail = [play.version ? `[${play.version}]` : '', play.stars ? `${play.stars}★` : '', play.mods ? `+${play.mods}` : '',
        play.result === 'finish' ? `${play.peakCombo}${play.maxCombo ? `/${play.maxCombo}` : ''} 连` : (play.progress != null ? `打到 ${Math.round(play.progress * 100)}%` : ''), play.miss ? `${play.miss} miss` : ''].filter(Boolean).join(' · ');
      return el('li', {},
        el('span', { class: `rank ${rankClass}${play.result !== 'finish' ? ' small' : ''}`, text: rankText }),
        el('span', { class: 'song', title: `${play.title || ''}\n${detail}` }, el('b', { text: play.title || '（读不到歌名）' }), el('small', { text: detail })),
        el('span', { class: 'acc' }, el('b', { text: `${play.acc}%` }), el('small', { text: clock(play.at) })));
    }) : [el('li', { class: 'empty', text: '还没有成绩。打一把就有了。' })]));

    // 人设 / 模型 / 语音
    $('#persona-info').textContent = status.persona.personaChars ? `现在有 ${status.persona.personaChars} 个字${status.persona.personaChars > 3200 ? '（只用前 3200 字）' : ''}` : '还是空的';
    $('#llm-info').textContent = status.llm.ok ? '看起来配好了，点「测试」真的问一次。' : `${status.llm.error}。${status.llm.hint || ''}`;

    // 角色：皮肤卡片墙。设置里写的那套不在列表里（以前版本的默认值 placeholder、或者那套没了）：标实际在用的那套。
    const selected = skins.some((skin) => skin.id === config.pet.skin) ? config.pet.skin : status.pet?.skinId;
    renderSkinGrid(skins, selected);
    stage.selected = selected;
    showStage();
    const notes = [];
    for (const skin of skins) {
      if (!skin.ok) notes.push(`「${skin.id}」用不了：${skin.error.error}。${skin.error.hint}`);
      else if (skin.id === config.pet.skin) for (const warning of skin.warnings) notes.push(warning);
    }
    if (status.pet) notes.unshift(`桌面角色：${status.pet.enabled ? (status.pet.visible ? '显示着' : '开着，但现在没显示出来') : '关着'}`);
    setChildren($('#skin-notes'), ...notes.map((text) => el('li', { text })));

    // OBS
    const counter = status.counter;
    if (counter) {
      setChildren($('#obs-status'), !counter.enabled ? pill('关着', 'idle') : counter.installed ? pill('已装好', 'ok') : pill('还没装', 'bad'),
        document.createTextNode(counter.installed ? ` 皮肤 ${counter.skinId}，装在 ${counter.dir}` : counter.lastError ? ` ${counter.lastError.error}。${counter.lastError.hint}` : ' 连上 tosu 时会自动装。'));
      $('#obs-url').textContent = counter.url;
      $('#obs-suburl').textContent = counter.subtitleUrl;
    }
    $('#obs-tosudir').textContent = config.counter.tosuDir || '自动找正在运行的 tosu.exe';

    // 成绩
    setChildren($('#plays-table tbody'), ...(status.plays.length ? status.plays.map((play) => el('tr', {},
      el('td', { text: new Date(play.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }),
      el('td', { class: 'song', text: `${play.title}${play.version ? ` [${play.version}]` : ''}` }),
      el('td', { text: `${play.stars ? `${play.stars}★` : '—'}${play.mods ? ` +${play.mods}` : ''}` }),
      el('td', { text: playResult(play) }),
      el('td', { text: `${play.acc}%` }),
      el('td', { text: `${play.peakCombo}${play.maxCombo ? ` / ${play.maxCombo}` : ''}` }),
      el('td', { text: String(play.miss) }),
    )) : [el('tr', {}, el('td', { colspan: '7', text: '还没有成绩。' }))]));

    $('#about-data').textContent = app.dataDir;
  }

  async function refresh() {
    let result;
    try { result = await api.call('state'); } catch (error) { result = null; }
    if (result && result.ok) { latest = result; render(); }
    else if (!refresh.failed) { refresh.failed = true; showFailure(result || { error: '读不到状态', hint: '重开程序。', code: 'api.unreachable' }); }
  }

  refresh();
  setInterval(refresh, 1500);
  window.__refresh = refresh;
})();
