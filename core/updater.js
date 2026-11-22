/**
 * 自动更新（2026-11-22 用户：「再加个自动更新的功能吧」，选了「一键下载并安装」）。
 *
 * 去 GitHub 上本项目的 Releases 看最新版本（GET /repos/<repo>/releases/latest，不带任何个人信息，User-Agent 是通用的 TomoPet-updater）；
 * 比现在的新、而且附了 npm run package 打出来的 TomoPet-<版本>-win-x64.zip 时，设置页和托盘提示「有新版本」。
 * 点「更新」：下载 zip（按 GitHub 给的大小和 sha256 校验）→ 解压到临时文件夹 → 核对里面的版本 →
 * 起一个独立的 PowerShell 小脚本，等程序退出后把新文件盖到程序文件夹（resources\app 整个换成新的，别的文件覆盖）→ 重新打开程序。
 * 设置、密钥、成绩、导入的皮肤都在 %APPDATA%\osu-pet，不在程序文件夹里，更新不碰它们。
 *
 * 从源码跑（没打包）的只检查不安装：提示用 git pull。只支持 Windows 打包版。
 * 这个文件不 import electron：网络请求（主进程传 electron 的 net.fetch，走系统代理）、退出程序、起进程都从参数传进来，测试可以塞假的。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { codedError, failureOf } from './store.js';

/** 发布新版本的仓库。 */
export const UPDATE_REPO = 'Sorihiko/TomoPet';
export const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`;
/** Releases 里认哪个附件：npm run package 打出来的包。 */
export const ASSET_PATTERN = /^TomoPet-\d+\.\d+\.\d+-win-x64\.zip$/;
export const FIRST_CHECK_MS = 20_000;
export const CHECK_EVERY_MS = 6 * 3600_000;
const CHECK_TIMEOUT_MS = 15_000;
const STALL_MS = 60_000;

/** 'v0.2.0' / '0.2.0' → [0, 2, 0]；看不出来返回 null。 */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

/** a 比 b 新返回正数、旧返回负数、一样（或看不出来）返回 0。 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** GitHub 的一个 release → { version, notes, pageUrl, publishedAt, asset: { name, size, url, sha256 } | null }。 */
export function readRelease(rel) {
  const tag = String(rel?.tag_name ?? '').trim();
  if (!parseVersion(tag)) throw codedError('update.bad-release', `最新发布的标签「${tag.slice(0, 40)}」看不出版本号`, '发布时 tag 写成 v0.2.0 这样（三段数字）。');
  const raw = (Array.isArray(rel?.assets) ? rel.assets : []).find((a) => a && ASSET_PATTERN.test(String(a.name)));
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(raw?.digest ?? ''));
  const pageUrl = String(rel?.html_url ?? '');
  return {
    version: tag.replace(/^v/, ''),
    notes: String(rel?.body ?? '').slice(0, 2000),
    pageUrl: pageUrl.startsWith(`${RELEASES_PAGE}/`) ? pageUrl : RELEASES_PAGE,
    publishedAt: String(rel?.published_at ?? ''),
    asset: raw && /^https:\/\//.test(String(raw.browser_download_url)) && Number(raw.size) > 0
      ? { name: String(raw.name), size: Number(raw.size), url: String(raw.browser_download_url), sha256: digest ? digest[1].toLowerCase() : '' }
      : null,
  };
}

/**
 * 装新文件的 PowerShell 脚本（程序退出后单独跑）。参数从命令行传，脚本里不拼路径。
 * 新版本最外层的每一项（TomoPet.exe、Electron 的文件、resources、说明……）：程序文件夹里原来有的先挪进备份文件夹（同一个盘上挪，一下就好），
 * 再把新的拷进去；中间任何一步失败，把这次拷进去的删掉、备份挪回来——要么全是新版本，要么全是旧版本（复核发现：只备份 resources\app 时，
 * 中途失败会留下一半新一半旧的 Electron 文件，程序起不来）。程序文件夹里新版本没有的东西（用户自己放的）不动。
 * 原来的程序一分钟还没退出就不装（文件被占着，硬拷只会装一半）。-FailOn 只给测试用：拷到这一项时假装失败。
 */
export const INSTALL_SCRIPT = `param([int]$ProcId, [string]$Src, [string]$Dst, [string]$Exe, [string]$Work, [string]$Log, [switch]$NoStart, [string]$FailOn)
function Write-UpdateLog([string]$m) { try { Add-Content -LiteralPath $Log -Value ((Get-Date -Format o) + ' [update] ' + $m) -Encoding UTF8 } catch {} }
function Show-UpdateFailure([string]$m) {
  if ($NoStart) { return }
  try { Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($m, 'TomoPet') } catch {}
}
# 告诉程序「脚本真的跑起来了」（程序看到这个文件才退出；被安全软件或组策略拦掉时程序照常开着，不会消失）
try { Set-Content -LiteralPath (Join-Path $Work 'started') -Value 'ok' } catch {}
# 等原来的程序退出（最多一分钟）；一分钟还在就不装
$alive = $false
try { $p = Get-Process -Id $ProcId -ErrorAction Stop; if (-not $p.WaitForExit(60000)) { $alive = $true } } catch {}
if ($alive) {
  Write-UpdateLog '程序一分钟都没退出，这次不装了'
  Show-UpdateFailure ('TomoPet 没能退出，这次没有更新。重新打开 TomoPet 再点一次「更新」就行。')
  try { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  exit 1
}
Start-Sleep -Milliseconds 800
$ErrorActionPreference = 'Stop'
$backup = Join-Path $Dst ('.update-old-' + $ProcId)
$moved = New-Object System.Collections.ArrayList
$added = New-Object System.Collections.ArrayList
$failed = $null
try {
  # 以前没删干净的备份
  foreach ($old in Get-ChildItem -LiteralPath $Dst -Force -Filter '.update-old-*') { try { Remove-Item -LiteralPath $old.FullName -Recurse -Force } catch {} }
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  foreach ($item in Get-ChildItem -LiteralPath $Src -Force) {
    $target = Join-Path $Dst $item.Name
    if (Test-Path -LiteralPath $target) {
      $ok = $false
      for ($i = 0; $i -lt 10 -and -not $ok; $i++) {
        try { Move-Item -LiteralPath $target -Destination (Join-Path $backup $item.Name); $ok = $true } catch { Start-Sleep -Seconds 1 }
      }
      if (-not $ok) { throw ($item.Name + ' 被占用，挪不开') }
      [void]$moved.Add($item.Name)
    } else {
      [void]$added.Add($item.Name)
    }
    if ($FailOn -and $item.Name -eq $FailOn) { throw ('测试：拷 ' + $item.Name + ' 时失败') }
    Copy-Item -LiteralPath $item.FullName -Destination $target -Recurse -Force
  }
  try { Remove-Item -LiteralPath $backup -Recurse -Force } catch { Write-UpdateLog ('备份没删掉（下次更新时再删）：' + $_.Exception.Message) }
  Write-UpdateLog '新版本装好了'
} catch {
  $failed = $_.Exception.Message
  Write-UpdateLog ('更新没装上：' + $failed)
}
$restored = $true
if ($failed) {
  # 换回旧版本：这次拷进去的删掉，备份挪回来
  foreach ($name in @($moved) + @($added)) {
    $target = Join-Path $Dst $name
    try { if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force } } catch { $restored = $false; Write-UpdateLog ('删不掉装了一半的 ' + $name + '：' + $_.Exception.Message) }
  }
  foreach ($name in $moved) {
    try { Move-Item -LiteralPath (Join-Path $backup $name) -Destination (Join-Path $Dst $name) } catch { $restored = $false; Write-UpdateLog ('挪不回 ' + $name + '：' + $_.Exception.Message) }
  }
  if ($restored) {
    try { Remove-Item -LiteralPath $backup -Recurse -Force } catch {}
    Write-UpdateLog '已经换回旧版本'
    Show-UpdateFailure ('TomoPet 更新没装上：' + $failed + [Environment]::NewLine + [Environment]::NewLine + '已经换回原来的版本。可以再试一次，或者去 GitHub 的发布页自己下载新版。设置和数据不受影响。')
  } else {
    Write-UpdateLog ('换回旧版本没成功，旧文件在 ' + $backup)
    Show-UpdateFailure ('TomoPet 更新没装上，也没能完全换回旧版本。' + [Environment]::NewLine + '原来的文件在：' + $backup + [Environment]::NewLine + [Environment]::NewLine + '请去 GitHub 的发布页下载新版，解压后覆盖程序文件夹。设置和数据不受影响。')
  }
}
if (-not $NoStart -and $restored) { try { Start-Process -FilePath $Exe } catch { Write-UpdateLog ('重新打开程序失败：' + $_.Exception.Message) } }
try { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue } catch {}
`;

/** 解压出来的文件夹里找真正的程序文件夹（里面有 <exe> 和 resources\app\package.json）。最多往下找两层。 */
export function findAppFolder(root, exeName) {
  const ok = (dir) => fs.existsSync(path.join(dir, exeName)) && fs.existsSync(path.join(dir, 'resources', 'app', 'package.json'));
  if (ok(root)) return root;
  for (const a of safeDirs(root)) {
    if (ok(a)) return a;
    for (const b of safeDirs(a)) if (ok(b)) return b;
  }
  return '';
}
function safeDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)); } catch { return []; }
}

/**
 * @param {object} deps
 * @param {string} deps.currentVersion
 * @param {Function} deps.fetchImpl        fetch 兼容的函数（主进程传 electron 的 net.fetch）
 * @param {string} deps.tempDir            放下载和解压的地方（系统临时文件夹）
 * @param {string} deps.exePath            正在跑的程序（process.execPath）
 * @param {boolean} deps.isPackaged        打包版才能装
 * @param {string} deps.logFile            装新文件那一步的结果写到这里（和程序日志同一个文件）
 * @param {Function} deps.quit             退出程序（让脚本去盖文件）
 * @param {Function} [deps.enabled]        要不要自动检查（设置「自动检查更新」）
 * @param {Function} [deps.onChange]       状态变了（托盘菜单、提示）
 */
export function createUpdater({
  currentVersion, fetchImpl, tempDir, exePath, isPackaged, logFile, quit,
  enabled = () => true, onChange = () => {}, log = () => {},
  repo = UPDATE_REPO, apiBase = 'https://api.github.com', platform = process.platform, pid = process.pid,
  run = execFile, spawnImpl = spawn, now = () => Date.now(), openWrite = (file) => fs.createWriteStream(file), scriptStartMs = 15_000,
}) {
  const canInstall = Boolean(isPackaged) && platform === 'win32';
  const state = { checking: false, phase: null, progress: null, latest: null, error: null, lastChecked: 0 };
  let timers = [];

  const available = () => Boolean(state.latest && compareVersions(state.latest.version, currentVersion) > 0);
  function status() {
    const latest = state.latest;
    return {
      current: currentVersion,
      canInstall,
      checking: state.checking,
      phase: state.phase,
      progress: state.progress ? { ...state.progress } : null,
      available: available(),
      latest: latest ? { version: latest.version, notes: latest.notes, pageUrl: latest.pageUrl, size: latest.asset?.size ?? 0, hasAsset: Boolean(latest.asset) } : null,
      error: state.error,
      lastChecked: state.lastChecked,
    };
  }
  const changed = () => { try { onChange(status()); } catch {} };

  /** 查一次 GitHub。失败时记下错误；manual（点了「检查更新」）时把错误抛给设置页显示。 */
  async function check({ manual = false } = {}) {
    if (state.phase) return status();
    state.checking = true;
    changed();
    try {
      let res;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), CHECK_TIMEOUT_MS);
      try {
        res = await fetchImpl(`${apiBase}/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'TomoPet-updater', Accept: 'application/vnd.github+json' }, signal: ctl.signal });
      } catch (error) {
        throw codedError('update.offline', `连不上 GitHub：${String(error?.message ?? error).slice(0, 100)}`, '检查一下网络；GitHub 打不开的话要开代理（程序走系统代理）。');
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 404) throw codedError('update.no-release', 'GitHub 上还没有发布过版本', '作者还没在 Releases 里发版本；或者仓库不是公开的。');
      if (res.status === 403 || res.status === 429) throw codedError('update.rate-limited', 'GitHub 暂时不让查（同一个网络查得太频繁）', '过一个小时再点「检查更新」。');
      if (!res.ok) throw codedError('update.http', `GitHub 返回 ${res.status}`, '过一会儿再试。');
      const latest = readRelease(await res.json());
      const wasAvailable = available() ? state.latest.version : '';
      state.latest = latest;
      state.error = null;
      state.lastChecked = now();
      if (available() && wasAvailable !== latest.version) log(`[update] 有新版本 ${latest.version}（现在 ${currentVersion}）${latest.asset ? '' : '，但没有附 zip'}`);
      return status();
    } catch (error) {
      state.error = failureOf(error, '过一会儿再试。');
      state.lastChecked = now();
      log(`[update] 检查更新失败（${state.error.code}）：${state.error.error}`);
      if (manual) throw error;
      return status();
    } finally {
      state.checking = false;
      changed();
    }
  }

  /** 下载到 file：边下边算 sha256；大小、sha256 对不上就报错。 */
  async function download(asset, file) {
    let res;
    try {
      res = await fetchImpl(asset.url, { headers: { 'User-Agent': 'TomoPet-updater' } });
    } catch (error) {
      throw codedError('update.offline', `下载新版本时连不上 GitHub：${String(error?.message ?? error).slice(0, 100)}`, '检查一下网络或代理，再点一次「更新」。');
    }
    if (!res.ok || !res.body) throw codedError('update.http', `下载新版本失败（GitHub 返回 ${res.status}）`, '过一会儿再点一次「更新」。');
    const hash = crypto.createHash('sha256');
    // 写盘出错（盘满了、打不开）：一开始就接住，变成报错（复核发现：没接的话主进程弹异常、更新一直卡在「正在下载」）
    const out = openWrite(file);
    let writeError = null;
    let wake = () => {};
    out.on('error', (error) => { writeError = error; wake(); });
    const writeFailed = () => codedError('update.write-failed', `下载的文件写不进去：${String(writeError?.message ?? writeError).slice(0, 120)}`, '系统临时文件夹所在的盘可能满了：腾点空间再点一次「更新」。');
    const reader = res.body.getReader();
    state.progress = { received: 0, total: asset.size };
    let lastNotify = 0;
    try {
      for (;;) {
        if (writeError) throw writeFailed();
        let stall;
        const chunk = await Promise.race([reader.read(), new Promise((_, reject) => { stall = setTimeout(() => reject(codedError('update.stalled', '下载卡住了（一分钟没有动静）', '检查一下网络或代理，再点一次「更新」。')), STALL_MS); })]).finally(() => clearTimeout(stall));
        if (chunk.done) break;
        const buf = Buffer.from(chunk.value);
        hash.update(buf);
        state.progress.received += buf.length;
        if (state.progress.received > asset.size) throw codedError('update.download-broken', '下载的文件比 GitHub 说的大', '再点一次「更新」；还不行就去发布页自己下载。');
        if (!out.write(buf)) await new Promise((r) => { wake = r; out.once('drain', r); });
        if (writeError) throw writeFailed();
        if (now() - lastNotify > 500) { lastNotify = now(); changed(); }
      }
      await new Promise((resolve, reject) => {
        if (writeError) { reject(writeFailed()); return; }
        wake = () => reject(writeFailed());
        out.once('finish', resolve);
        out.end();
      });
    } catch (error) {
      try { reader.cancel(); } catch {}
      out.destroy();
      throw error;
    }
    if (state.progress.received !== asset.size) throw codedError('update.download-broken', `下载不完整（${state.progress.received} / ${asset.size} 字节）`, '再点一次「更新」。');
    if (asset.sha256 && hash.digest('hex') !== asset.sha256) throw codedError('update.download-corrupt', '下载的文件校验不对（sha256 不一样）', '再点一次「更新」；还不对就去发布页自己下载。');
  }

  function expand(zip, dest) {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    return new Promise((resolve, reject) => {
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(dest)} -Force`],
        { timeout: 10 * 60_000, windowsHide: true }, (error, _stdout, stderr) => {
          if (error) reject(codedError('update.unzip-failed', `解压新版本失败：${String(stderr || error.message).trim().slice(0, 160)}`, '看看系统临时文件夹所在的盘还有没有空间，再点一次「更新」。'));
          else resolve();
        });
    });
  }

  /** 装之前的检查（同步抛错：设置页点「更新」时能马上看到，复核发现原来在后台被吞掉了）。 */
  function preflight() {
    if (!canInstall) throw codedError('update.not-packaged', '从源码运行的不能自动更新', '在项目文件夹里 git pull，再 npm install、npm start。');
    if (state.phase) throw codedError('update.busy', '正在更新', '等它装完，程序会自己重新打开。');
    if (!available()) throw codedError('update.nothing', '没有新版本可以装', '先点「检查更新」。');
    const latest = state.latest;
    if (!latest.asset) throw codedError('update.no-asset', `新版本 ${latest.version} 没有附 Windows 的安装包`, '去发布页看看，或者等作者补上 zip。');
    const appDir = path.dirname(exePath);
    // 程序文件夹要能写（放在 Program Files 之类的地方写不了）
    try {
      const probe = path.join(appDir, `.tomopet-update-probe-${pid}`);
      fs.writeFileSync(probe, '');
      fs.rmSync(probe, { force: true });
    } catch {
      throw codedError('update.no-permission', `程序文件夹写不进去：${appDir}`, '把 TomoPet 文件夹挪到能写的地方（比如 D:\\TomoPet），或者去发布页自己下载新版解压覆盖。');
    }
    return { latest, appDir, exeName: path.basename(exePath) };
  }

  /** 下载、解压、核对，起装新文件的脚本，等它真的跑起来了再退出程序。 */
  async function install() {
    let pre;
    try {
      pre = preflight();
    } catch (error) {
      if (error.code !== 'update.busy') { state.error = failureOf(error, '去发布页自己下载新版。'); changed(); }
      throw error;
    }
    const { latest, appDir, exeName } = pre;
    const work = path.join(tempDir, 'TomoPet-update');
    state.phase = 'downloading';
    state.error = null;
    changed();
    try {
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work, { recursive: true });
      const zip = path.join(work, latest.asset.name);
      log(`[update] 下载 ${latest.asset.name}（${latest.asset.size} 字节）`);
      await download(latest.asset, zip);
      state.phase = 'extracting';
      changed();
      const unpacked = path.join(work, 'x');
      await expand(zip, unpacked);
      fs.rmSync(zip, { force: true });
      const src = findAppFolder(unpacked, exeName);
      if (!src) throw codedError('update.bad-package', `新版本的包里找不到 ${exeName}`, '这个版本的包不对：去发布页看看，或者自己下载。');
      let newVersion = '';
      try { newVersion = JSON.parse(fs.readFileSync(path.join(src, 'resources', 'app', 'package.json'), 'utf8')).version; } catch {}
      if (newVersion !== latest.version) throw codedError('update.bad-package', `包里的版本是 ${newVersion || '（读不到）'}，不是 ${latest.version}`, '这个版本的包不对：去发布页看看，或者自己下载。');
      const script = path.join(work, 'install.ps1');
      fs.writeFileSync(script, `\uFEFF${INSTALL_SCRIPT}`, 'utf8');
      state.phase = 'restarting';
      changed();
      log(`[update] ${currentVersion} → ${latest.version}：退出程序，装好后重新打开`);
      const child = spawnImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script,
        '-ProcId', String(pid), '-Src', src, '-Dst', appDir, '-Exe', exePath, '-Work', work, '-Log', logFile], { detached: true, stdio: 'ignore', windowsHide: true });
      let spawnError = null;
      child.on?.('error', (error) => { spawnError = error; });
      child.unref?.();
      // 等脚本写出 started 才退出（复核发现：脚本被安全软件 / 组策略拦掉时，程序退了就再也不会打开，看着像闪退）
      const marker = path.join(work, 'started');
      const deadline = now() + scriptStartMs;
      while (!fs.existsSync(marker)) {
        if (spawnError) throw codedError('update.script-blocked', `装新版本的脚本起不来：${String(spawnError.message ?? spawnError).slice(0, 100)}`, '去发布页自己下载新版，解压后覆盖程序文件夹。');
        if (now() > deadline) throw codedError('update.script-blocked', '装新版本的脚本没跑起来（可能被安全软件或系统策略拦了）', '程序照常开着，什么都没改。去发布页自己下载新版，解压后覆盖程序文件夹。');
        await new Promise((r) => setTimeout(r, 200));
      }
      setTimeout(() => quit(), 300);
      return status();
    } catch (error) {
      state.phase = null;
      state.progress = null;
      state.error = failureOf(error, '再点一次「更新」；还不行就去发布页自己下载。');
      log(`[update] 更新失败（${state.error.code}）：${state.error.error}`);
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
      changed();
      throw error;
    }
  }

  /** 设置页点「更新」：先同步检查一遍（有问题马上抛给设置页），再在后台装（下载要一会儿），马上返回；进度看 status()。 */
  function startInstall() {
    preflight();
    install().catch(() => {});
    return status();
  }

  /** 打开程序 20 秒后查一次，之后每 6 小时查一次（设置里关了就不查）。 */
  function start() {
    stop();
    const tick = () => { if (enabled()) check().catch(() => {}); };
    timers = [setTimeout(tick, FIRST_CHECK_MS), setInterval(tick, CHECK_EVERY_MS)];
    for (const t of timers) t.unref?.();
  }
  function stop() {
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers = [];
  }

  return { check, install, startInstall, status, start, stop };
}
