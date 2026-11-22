/**
 * 「下一步该干什么」：把服务的状态翻成给人看的提示，按顺序排（最挡路的在前）。纯函数。
 * 设置窗口最上面那一块显示它；每条都带 code（机器读）、text（哪里不对）、hint（现在该点什么）、section（跳到设置的哪一块）。
 * 失败不能只写日志——这里就是「看得见」的那一处。
 */
export function nextSteps(status, { rendererBuilt = true, secretsEncrypted = true, logoFound = true } = {}) {
  const steps = [];
  const add = (level, section, failure, fallbackText) => {
    if (!failure && !fallbackText) return;
    steps.push({ level, section, code: failure?.code || '', text: failure?.error || fallbackText || '', hint: failure?.hint || '' });
  };
  if (!status || status.ok === false) {
    add('error', 'status', status, '读不到状态');
    return steps;
  }
  const watch = status.watch || {};

  if (!rendererBuilt) add('error', 'obs', { code: 'app.no-renderer', error: '角色的渲染层还没打包', hint: '关掉程序，在项目文件夹里跑一次 npm run build，再打开。' });
  if (!watch.enabled) add('info', 'watch', { code: 'osu.disabled', error: '「看你打 osu!」关着', hint: '打开最上面的开关她才会看、才会说。' });
  if (status.llm && status.llm.ok === false) add('error', 'llm', status.llm);
  if (watch.enabled && status.tosu?.error) add('error', 'status', status.tosu.error);
  if (watch.enabled && status.tosu?.connected && !status.playing && !(status.tosu.lastFrameAt > 0)) {
    add('info', 'status', { code: 'osu.no-frames', error: '连上 tosu 了，但还没收到对局数据', hint: '打开 osu!；osu! 开着还是这样的话，更新一下 tosu（lazer 更新后 tosu 要跟着更新）。' });
  }
  if (watch.output === 'none' && !watch.voice) add('error', 'watch', { code: 'osu.no-output', error: '「怎么说」选了不显示字幕，又没开「念出来」', hint: '打开「念出来」，或者把「怎么说」改回字幕 / 气泡。' });
  if (watch.voice && status.voice?.ready && status.voice.ready.ok === false) add('error', 'tts', status.voice.ready);
  if (watch.voice && status.voice?.lastError) add('warn', 'tts', status.voice.lastError);
  // 桌面角色出不来是因为皮肤（skin.*）：下面 status.pet.lastError 那一条会说真正的原因，这里不再说「藏着」。
  if (watch.output === 'bubble' && status.pet && !status.pet.visible && !String(status.pet.lastError?.code || '').startsWith('skin.')) {
    // 和 watch.js 的 preflight 同一条规则：OBS 里的角色装好了，或者开了「念出来」，她照样说。
    const obsReady = status.counter?.enabled === true && status.counter?.installed === true && status.counter?.lastError?.code !== 'osu.counter-write';
    const voiceReady = watch.voice === true && status.voice?.ready?.ok !== false;
    if (obsReady) add('info', 'pet', { code: 'osu.bubble-obs-only', error: '桌面角色藏着：气泡只出在 OBS 里的角色头上', hint: '想在自己屏幕上也看到，就在「角色」里打开桌面角色（或托盘菜单里点「显示角色」）。' });
    else if (voiceReady) add('warn', 'pet', { code: 'osu.bubble-voice-only', error: '桌面角色藏着，OBS 里的角色也没装好：她只出声，不出气泡', hint: '在「角色」里打开桌面角色，或者看「OBS」那一块把角色装进 tosu；也可以把「怎么说」改成字幕。' });
    else add('error', 'pet', { code: 'osu.pet-hidden', error: '「怎么说」选了气泡，但桌面角色没显示，OBS 里的角色也没装好', hint: '在「角色」里打开桌面角色（或托盘菜单里点「显示角色」），或者看「OBS」那一块把角色装进 tosu；也可以把「怎么说」改成字幕。' });
  }
  if (status.pet?.lastError) add('error', 'pet', status.pet.lastError);
  if (status.pet?.fallback) add('warn', 'pet', status.pet.fallback);
  if (status.counter?.enabled && status.counter.lastError) add(status.counter.lastError.code === 'osu.counter-no-tosu' ? 'info' : 'error', 'obs', status.counter.lastError);
  if (watch.enabled && status.counter?.otherWatcher) {
    const at = new Date(status.counter.otherWatcher.at);
    const when = Number.isNaN(at.getTime()) ? '最近 30 分钟' : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    add('warn', 'watch', { code: 'osu.other-watcher', error: `SurfCore 里原来那只小鲸鱼也在看你打 osu!（${when} 还在 tosu 里说过话）：两边会各说一句，声音叠在一起`, hint: '只留一个：在 SurfCore 设置页「桌宠」最下面的「看你打 osu!」里关掉开关；OBS 里把 surfcore-xiaojingyu 那个源删掉或藏起来。关掉以后这条提醒最多半小时自己消失（它只看那边最后一次开口的时间）。' });
  }
  if (status.counter?.lastSync?.skinFallback && !status.pet?.fallback) add('warn', 'pet', status.counter.lastSync.skinFallback);
  if (status.overlay?.lastError) add('warn', 'watch', status.overlay.lastError);
  if (status.lastError) add('warn', 'status', { ...status.lastError, error: `上一次没说成：${status.lastError.error}` });
  if (!status.persona?.personaChars) add('info', 'persona', { code: 'persona.empty', error: '人设还是空的', hint: '点「打开 persona.md」写几句她是谁、怎么说话；不写她就只按默认的口气说。' });
  if (!secretsEncrypted) add('warn', 'llm', { code: 'config.plain-secrets', error: '这台电脑上系统加密不可用，API Key 是明文存在 config.json 里的', hint: '别把数据目录发给别人；能用系统加密的环境（正常登录的 Windows 账户）下重新填一次 Key 就会加密。' });
  if (!logoFound) add('info', 'about', { code: 'app.no-logo', error: '还没放 logo，托盘图标是空白的', hint: '把 logo 图片存成项目文件夹里的 assets/logo.png，重开程序。' });
  return steps;
}
