/**
 * 打包给别人用的 Windows 版：一个文件夹（再压成 zip），解压就能跑，自带 CrossPet 的全部角色。
 *
 *   npm run package              → release/TomoPet-<版本>-win-x64/ 和同名 .zip
 *   npm run package -- --no-zip  → 只出文件夹
 *   npm run package -- --no-icon → 不换 exe 图标（换图标出问题时的退路）
 *   npm run package -- --no-version → 不改 exe 版本信息（同上）
 *
 * TomoPet.exe 的图标换成 assets/logo.png（2026-11-20 用户：「把 exe 图标也换成我的 logo」），见 scripts/exe-icon.mjs；
 * 版本信息（任务管理器里的「描述」、属性里的产品名）写成 TomoPet（「把描述改成 TomoPet」），见 scripts/exe-version.mjs。
 *
 * 为什么这样（2026-11-20 用户：「这个程序别人下载下来应该自带所有 crosspet 的皮肤」，选的是「打成安装包时带上」）：
 * git 仓库照旧只放代码（以后开源也干净）；给别人下载的是这个包，里面带转好的 skins-bundled/、每套的 CREDITS.md 和授权说明。
 *
 * 做法是 Electron 官方文档里的「手动打包」：拷一份 node_modules/electron/dist（electron.exe 改名 TomoPet.exe），
 * 程序文件放进 resources/app/。不用额外下载任何东西（electron-builder 之类要联网下工具）。
 * 只拷运行时要的：app/ core/ counter/ dist/ assets/ skins-bundled/ + 生产依赖（@anthropic-ai/sdk 和它依赖的包）；
 * 不拷 art/（原图）、renderer/（源码，已经打进 dist/）、scripts/、test/、docs/。
 *
 * 失败都打印 code / error / hint，并以非零退出。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// 给别人看到的程序名（exe、包名、说明、版本信息）。数据目录还是 %APPDATA%\osu-pet（见 app/main.js 的 DATA_FOLDER）。
export const APP_NAME = 'TomoPet';
// 程序运行时要的文件夹和文件（相对项目根）。
export const APP_DIRS = ['app', 'core', 'counter', 'dist', 'assets', 'skins-bundled', 'licenses'];
export const APP_FILES = ['package.json', 'LICENSE', 'NOTICE', 'README.md', 'persona.example.md'];

export class PackageError extends Error {
  constructor(code, message, hint) { super(message); this.code = code; this.hint = hint; }
}

/**
 * 生产依赖要拷哪些包文件夹（相对 root，比如 node_modules/@anthropic-ai/sdk）。
 * 按 Node 找包的规则：先找这个包自己的 node_modules，再一层层往上找，直到项目根。只看 dependencies（和 optionalDependencies 里装了的）。
 */
export function prodPackageDirs(root, deps) {
  const found = new Set();
  const missing = [];
  const visit = (fromDir, name, optional) => {
    let dir = fromDir;
    for (;;) {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        const rel = path.relative(root, candidate);
        if (found.has(rel)) return;
        found.add(rel);
        let pkg = {};
        try { pkg = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8')); } catch {}
        for (const dep of Object.keys(pkg.dependencies || {})) visit(candidate, dep, false);
        for (const dep of Object.keys(pkg.optionalDependencies || {})) visit(candidate, dep, true);
        return;
      }
      if (path.resolve(dir) === path.resolve(root)) break;
      const up = path.dirname(dir);
      // 从 node_modules/a/node_modules/b 往上跳过 node_modules 那一层
      dir = path.basename(up) === 'node_modules' ? path.dirname(up) : up;
      if (path.relative(root, dir).startsWith('..')) break;
    }
    if (!optional) missing.push(name);
  };
  for (const name of Object.keys(deps || {})) visit(root, name, false);
  return { dirs: [...found].sort(), missing };
}

/** 拷文件夹（不跟符号链接，跳过 .tmp-* / .old-* 这种中途留下的）。 */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (/\.(tmp|old)-\d+$/.test(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/** 包里那份 package.json：去掉开发用的脚本和依赖（包里没有那些文件）。 */
export function packagedManifest(pkg) {
  const { devDependencies: _dev, scripts: _scripts, ...rest } = pkg;
  return { ...rest, main: 'app/main.js' };
}

/** 授权说明（放在包的最外层）。credits：每套皮肤 CREDITS.md 里的署名行。 */
export function licenseText({ name, version, skins }) {
  const lines = skins.map((s) => `  - ${s.name}${s.credit ? `（设定来源：${s.credit}）` : ''}${s.mouth ? '（带张嘴口型）' : ''}`);
  const mouths = skins.filter((s) => s.mouth).length;
  // 说话时叠在立绘上的嘴（2026-11-21）：取自 hunmer/aboutme-pets，同样是 CC BY-NC-SA 4.0，要单独署名、写明改动。
  const mouthText = mouths ? `
  张嘴口型（其中 ${mouths} 套说话时叠在立绘上的那几张嘴）
  来自 hunmer/aboutme-pets（https://github.com/hunmer/aboutme-pets，作者 hunmer，据说明由 AI 生成），协议同样是 CC BY-NC-SA 4.0。
  - 署名：公开时请同时写明「张嘴口型：hunmer/aboutme-pets，CC BY-NC-SA 4.0」。
  - 改动：${name} 从它的「碎碎念」动画里截取了几帧的嘴部，对齐、缩放、调色后做成只有嘴的叠加图；
    没有对应动画的角色用别的角色的嘴移植。每套用的哪段动画见它的 CREDITS.md。
` : '';
  return `${name} ${version} 授权说明
==============================

一、程序本身（${name} 的代码）：MIT，见 resources\\app\\LICENSE 和 NOTICE。
    其中照搬 / 改编自上游的代码也都是 MIT：SurfCore、surfpet（桌宠 feiyu-pet，分图层皮肤的渲染器 rig.ts）、CrossPet（动作关键帧），
    各自的版权行和许可全文见 resources\\app\\licenses\\，也收在 THIRD-PARTY-NOTICES.txt 的最前面。

二、角色立绘（自带的 ${skins.length} 套皮肤，在 resources\\app\\skins-bundled\\）
  来自 CrossPet（https://github.com/lokicorvus/crosspet），协议 CC BY-NC-SA 4.0
  （https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans）。${name} 只是原样拷贝了其中一部分图，没有修改${mouths ? '（说话时叠加的口型图除外，见下面「张嘴口型」）' : ''}。
  - 署名：直播、录像、截图公开时请写明「角色立绘：CrossPet（github.com/lokicorvus/crosspet）及原作者，CC BY-NC-SA 4.0」，
    并带上你用的那个角色的设定来源（下面每一行括号里的，比如 DeepSeek 要写上「上善无形」和「ZipZipPipe」）。
    CrossPet 要求署名同时写 CrossPet 和原作者。
  - 不得商用：这个包和里面的立绘都不能卖、不能用来赚钱。
  - 相同方式共享：转发、改编这些图时用同一个协议。
  - 据 CrossPet 说明，这些立绘由 AI 生图工具按社区设定重新绘制。CrossPet 的授权只覆盖它自己有权授权的部分；
    社区既有设定（例如 B 站 ZipZipPipe 设计的 DeepSeek「大肥鱼」等）的权利以各自来源为准，公开使用前最好先问原作者。
  每一套的署名和来源见它文件夹里的 CREDITS.md：
${lines.join('\n')}
${mouthText}
三、Electron（MIT）和 Chromium 等第三方组件：见同目录的 LICENSE 和 LICENSES.chromium.html。
四、程序带着的其它第三方代码（PixiJS 等是 MIT，@anthropic-ai/sdk 是 Apache-2.0，它依赖的几个包有 MIT / Apache-2.0 / Unlicense 等）：
    每个包的名字、版本、协议和授权全文见同目录的 THIRD-PARTY-NOTICES.txt。
`;
}

/**
 * THIRD-PARTY-NOTICES.txt：包里带着的每个第三方包的名字、版本、协议、作者和授权全文（MIT / Apache 都要求随附）。
 * 没带授权文件的包，写明 package.json 里的协议和作者。
 */
export function thirdPartyNotices(root, dirs, { licensesDir = path.join(root, 'licenses') } = {}) {
  // 源码里照搬 / 改编的上游代码（SurfCore、surfpet、CrossPet）：licenses/ 里每份许可全文放在最前面。
  const sourceBlocks = (() => {
    try {
      return fs.readdirSync(licensesDir).filter((n) => n.endsWith('.txt')).sort()
        .map((n) => `${n.replace(/\.txt$/, '')}（源码里照搬 / 改编的代码）\n${fs.readFileSync(path.join(licensesDir, n), 'utf8').trim()}`);
    } catch { return []; }
  })();
  const blocks = [...sourceBlocks];
  for (const rel of [...new Set(dirs)].sort()) {
    const dir = path.join(root, rel);
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
    const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name || '';
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
    const files = (() => { try { return fs.readdirSync(dir).filter((n) => /^(licen[cs]e|copying|notice)/i.test(n)).sort(); } catch { return []; } })();
    const texts = files.map((n) => { try { return `--- ${n} ---\n${fs.readFileSync(path.join(dir, n), 'utf8').trim()}`; } catch { return ''; } }).filter(Boolean);
    blocks.push([
      `${pkg.name || rel}${pkg.version ? ` ${pkg.version}` : ''}`,
      `协议：${pkg.license || '（package.json 没写）'}${author ? `；作者：${author}` : ''}${repo ? `；来源：${repo}` : ''}`,
      texts.length ? texts.join('\n\n') : `（这个包没带授权文件；按 package.json 写的 ${pkg.license || '协议'} 使用。）`,
    ].join('\n'));
  }
  return `TomoPet 带着的第三方代码\n========================\n\nElectron / Chromium 的授权见同目录的 LICENSE 和 LICENSES.chromium.html。\n先是源码里照搬 / 改编的上游代码，后面是带着的 npm 包（含打进渲染层的）。\n\n${blocks.join('\n\n==============================\n\n')}\n`;
}

/** 删旧文件：被占用（打包版还开着、zip 正被别的程序打开）时给一句能照着做的话，不吐原始的系统错误。 */
function removeOld(target, what) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    if (['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(error?.code)) {
      throw new PackageError('package.busy', `删不掉上一次打的${what}（${error.code}）：${target}`, '打包版的 TomoPet 可能还开着：右键托盘图标 →「退出」；也关掉正打开着这个 zip / 文件夹的程序，再打包。');
    }
    throw error;
  }
}

const README_TXT = (name, version) => `${name} ${version}（Windows 64 位）
==============================

看你打 osu! 的桌宠：连上 tosu，在断连、全连、失败这些时刻换姿势、说一句（本地字幕 / 语音 / 桌面角色 / OBS 叠加）。

怎么用
  1. 双击 ${name}.exe，会打开设置窗口（关掉后它还在右下角托盘里，点托盘图标再打开）。
  2. 在设置「模型」里填 API Key（DeepSeek、Claude 等），点「测试」。
  3. 打开 tosu（https://github.com/tosuapp/tosu）和 osu!，打一把。
  4. 角色在设置「角色」→「皮肤」里选，自带 CrossPet 的全部角色。
  5. OBS：设置「OBS」那一块有两条地址，加成浏览器源。

设置、日志、自己导入的皮肤都在 %APPDATA%\\osu-pet\\（设置「关于」里有「打开」按钮；TomoPet 以前叫 osu-pet，文件夹名没改）。
授权：见同目录的「授权说明.txt」——立绘是 CC BY-NC-SA 4.0，不能商用，公开时要署名。
`;

/**
 * 压成 zip。用 Windows 10 起自带的 C:\Windows\System32\tar.exe（bsdtar，-a 按扩展名出 zip）——
 * 不能直接写 tar：从 Git Bash 里跑时 PATH 里先找到 Git 自带的 GNU tar，它不会出 zip，还把「D:\…」的「D:」当成远程主机
 * （2026-11-20 真机第一次打包就这样失败了）。没有 bsdtar 就用 PowerShell 的 Compress-Archive。
 */
export function zipFolder(out, folder, zipFile, { run = execFileSync, exists = fs.existsSync, systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  const bsdtar = path.join(systemRoot, 'System32', 'tar.exe');
  const errors = [];
  if (exists(bsdtar)) {
    // hdrcharset=UTF-8：文件名按 UTF-8 存（并打上 UTF-8 标记）。不加的话中文文件名全变成「????」，
    // 「授权说明.txt」「使用说明.txt」还会撞成同一个名字（2026-11-20 真机打包发现）。
    try { run(bsdtar, ['--options', 'hdrcharset=UTF-8', '-a', '-c', '-f', zipFile, '-C', out, folder], { stdio: 'ignore' }); return 'tar'; } catch (error) { errors.push(`tar：${String(error?.message ?? error).slice(0, 80)}`); }
  }
  try {
    const ps = `Compress-Archive -LiteralPath '${path.join(out, folder).replace(/'/g, "''")}' -DestinationPath '${zipFile.replace(/'/g, "''")}' -Force`;
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
    return 'powershell';
  } catch (error) {
    errors.push(`Compress-Archive：${String(error?.message ?? error).slice(0, 80)}`);
  }
  throw new PackageError('package.zip-failed', `压缩失败：${errors.join('；')}`, `文件夹已经拼好了（${path.join(out, folder)}），可以自己右键「压缩为 ZIP 文件」；或者用 npm run package -- --no-zip。`);
}

/**
 * 压完打开 zip 看一眼：要紧的几个文件在不在、中文名字有没有变成问号。用 .NET 的 ZipFile 读（认 zip64），输出按 UTF-8。
 * 返回 zip 里的文件名列表；少了就抛 package.zip-broken。
 */
export function verifyZip(zipFile, mustHave, { run = execFileSync } = {}) {
  const ps = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead('${zipFile.replace(/'/g, "''")}'); try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }`;
  let names;
  try {
    names = String(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).map((n) => n.replace(/\\/g, '/'));
  } catch (error) {
    throw new PackageError('package.zip-broken', `打开压好的 zip 检查失败：${String(error?.message ?? error).slice(0, 120)}`, '删掉 release 文件夹重新打包；还不行用 npm run package -- --no-zip，自己右键压缩。');
  }
  const missing = mustHave.filter((name) => !names.includes(name));
  if (missing.length) throw new PackageError('package.zip-broken', `zip 里缺这些（或者中文名变成了问号）：${missing.join('、')}`, '删掉 release 文件夹重新打包；还不行用 npm run package -- --no-zip，自己右键压缩。');
  return names;
}

/**
 * 打包。返回 { dir, zip, skins, bytes }；失败抛 PackageError（code / message / hint）。
 * steps 可以注入（测试用）：build（转皮肤）、renderer(outdir)（打渲染层，返回 { inputs }）、icon(exe, logo)（换 exe 图标）、
 * version(exe, want)（改 exe 版本信息）、zip（压缩）。
 */
export async function packageWin({ root = ROOT, out = path.join(root, 'release'), zip = true, icon = true, version = true, steps = {}, log = console.log } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  // 程序叫 TomoPet（2026-11-20 用户）：exe 是 TomoPet.exe，包是 TomoPet-<版本>-win-x64.zip。
  const name = APP_NAME;
  const folder = `${name}-${pkg.version}-win-x64`;
  const stage = path.join(out, folder);

  // 1. 皮肤是最新的
  if (steps.build) await steps.build();
  else {
    const { ART_DIR, bundleCrossPet } = await import('../core/crosspet-import.js');
    const result = bundleCrossPet({ artDir: ART_DIR, outDir: path.join(root, 'skins-bundled'), ifMissing: true });
    if (!result.ok) throw new PackageError(result.code, result.error, result.hint);
    if (result.skipped.length) throw new PackageError('package.skin-failed', `有 ${result.skipped.length} 套皮肤没转成：${result.skipped.map((s) => `${s.folder}（${s.error}）`).join('；').slice(0, 200)}`, '先跑 npm run bundle-crosspet 看原因，修好再打包（给别人的包要带全）。');
  }
  // 渲染层：给别人的这份单独打一遍到临时文件夹（拿到打进去的第三方包清单，写授权用；不动项目里的 dist/）。
  const rendererOut = path.join(out, '.renderer-for-package');
  removeOld(rendererOut, '渲染层临时文件夹');
  let rendered;
  try {
    rendered = steps.renderer
      ? await steps.renderer(rendererOut)
      : await (await import('./build-renderer.mjs')).buildRenderer({ outdir: rendererOut, log: () => {} });
  } catch (error) {
    throw new PackageError('package.no-renderer', `渲染层打包失败：${String(error?.message ?? error).slice(0, 160)}`, '先跑 npm install（要 esbuild），再打包。');
  }
  for (const file of ['counter-renderer.js', 'pet-renderer.js']) {
    if (!fs.existsSync(path.join(rendererOut, file))) throw new PackageError('package.no-renderer', `渲染层没打出来：${file} 不在`, '先跑 npm install（要 esbuild），再打包。');
  }
  const inputs = rendered?.inputs ?? [];
  if (!fs.existsSync(path.join(root, 'licenses'))) throw new PackageError('package.no-licenses', '项目里没有 licenses/ 文件夹（上游代码的许可全文）', '从仓库还原 licenses/（git checkout -- licenses），再打包。');
  // 打进渲染层的第三方包（node_modules/…）也要随附授权。
  const bundledPackages = [...new Set(inputs.map((p) => /^(node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(p)?.[1]).filter(Boolean))];
  const skinsDir = path.join(root, 'skins-bundled');
  const skins = (() => { try { return fs.readdirSync(skinsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !/\.(tmp|old)-\d+$/.test(e.name) && fs.existsSync(path.join(skinsDir, e.name, 'manifest.json'))).map((e) => e.name).sort(); } catch { return []; } })();
  if (!skins.length) throw new PackageError('package.no-skins', '没有自带的皮肤（skins-bundled/ 是空的）', '把 CrossPet 仓库里的 characters 文件夹放进 art/crosspet/，再打包。给别人的包要自带全部角色。');

  // 2. Electron
  const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) throw new PackageError('package.no-electron', '找不到 node_modules/electron/dist/electron.exe', '在项目文件夹里跑一次 npm install。');

  // 3. 生产依赖都在
  const deps = prodPackageDirs(root, pkg.dependencies);
  if (deps.missing.length) throw new PackageError('package.missing-deps', `缺依赖：${deps.missing.join('、')}`, '在项目文件夹里跑一次 npm install。');

  // 4. 拼文件夹
  log(`[package] 拼 ${path.relative(root, stage)} …`);
  removeOld(stage, '文件夹');
  copyTree(electronDist, stage);
  fs.renameSync(path.join(stage, 'electron.exe'), path.join(stage, `${name}.exe`));
  fs.rmSync(path.join(stage, 'resources', 'default_app.asar'), { force: true });
  // exe 图标换成 logo（资源管理器、任务栏、Alt+Tab 里看到的）。
  let iconInfo = null;
  if (icon) {
    const exe = path.join(stage, `${name}.exe`);
    const logo = path.join(root, 'assets', 'logo.png');
    log('[package] 换 exe 图标 …');
    try {
      if (steps.icon) iconInfo = await steps.icon(exe, logo);
      else {
        const { buildIco, setExeIcon } = await import('./exe-icon.mjs');
        const ico = path.join(out, '.osu-pet-icon.ico');
        try { buildIco(logo, ico); iconInfo = setExeIcon(exe, ico); } finally { fs.rmSync(ico, { force: true }); }
      }
    } catch (error) {
      throw new PackageError(error?.code || 'icon.failed', `换 exe 图标失败：${String(error?.message ?? error).slice(0, 200)}`, error?.hint || '先用 npm run package -- --no-icon 打包。');
    }
  }
  // exe 版本信息：任务管理器里的「描述」、属性里的产品名 / 公司 / 版权 / 版本号（原来全是 Electron 的）。
  let versionInfo = null;
  if (version) {
    const exe = path.join(stage, `${name}.exe`);
    const copyright = (() => { try { return /^Copyright .+$/m.exec(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'))?.[0] ?? ''; } catch { return ''; } })();
    const want = { description: name, product: name, version: pkg.version, company: name, copyright };
    log('[package] 改 exe 版本信息 …');
    try {
      versionInfo = steps.version ? await steps.version(exe, want) : (await import('./exe-version.mjs')).setExeVersion(exe, want);
    } catch (error) {
      throw new PackageError(error?.code || 'version.failed', `改 exe 版本信息失败：${String(error?.message ?? error).slice(0, 200)}`, error?.hint || '先用 npm run package -- --no-version 打包。');
    }
  }
  const appDir = path.join(stage, 'resources', 'app');
  for (const dir of APP_DIRS) copyTree(dir === 'dist' ? rendererOut : path.join(root, dir), path.join(appDir, dir));
  removeOld(rendererOut, '渲染层临时文件夹');
  for (const file of APP_FILES) if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), path.join(appDir, file));
  fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(packagedManifest(pkg), null, 2)}\n`);
  for (const rel of deps.dirs) copyTree(path.join(root, rel), path.join(appDir, rel));

  // 5. 授权说明和使用说明
  const skinInfo = skins.map((id) => {
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(skinsDir, id, 'manifest.json'), 'utf8')); } catch {}
    // author 是「CrossPet …；设定来源：…；张嘴口型：…」，只取设定来源那一段。
    const credit = (String(manifest.author || '').split('设定来源：')[1] || '').split('；张嘴口型：')[0];
    return { id, name: String(manifest.name || id), credit, mouth: Boolean(manifest.sprite?.mouth) };
  });
  fs.writeFileSync(path.join(stage, '授权说明.txt'), `﻿${licenseText({ name, version: pkg.version, skins: skinInfo })}`.replace(/\n/g, '\r\n'));
  fs.writeFileSync(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), `﻿${thirdPartyNotices(root, [...deps.dirs, ...bundledPackages])}`.replace(/\r?\n/g, '\r\n'));
  fs.writeFileSync(path.join(stage, '使用说明.txt'), `﻿${README_TXT(name, pkg.version)}`.replace(/\n/g, '\r\n'));

  // 6. 压缩
  let zipFile = '';
  if (zip) {
    zipFile = path.join(out, `${folder}.zip`);
    removeOld(zipFile, ' zip');
    log(`[package] 压缩 ${path.relative(root, zipFile)} …`);
    if (steps.zip) await steps.zip(stage, zipFile);
    else {
      zipFolder(out, folder, zipFile);
      verifyZip(zipFile, [`${folder}/${name}.exe`, `${folder}/授权说明.txt`, `${folder}/使用说明.txt`, `${folder}/THIRD-PARTY-NOTICES.txt`, `${folder}/resources/app/package.json`, ...skins.map((id) => `${folder}/resources/app/skins-bundled/${id}/manifest.json`)]);
    }
  }
  const bytes = (function size(p) { const st = fs.statSync(p); return st.isDirectory() ? fs.readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0) : st.size; })(stage);
  return { dir: stage, zip: zipFile, skins, bytes, icon: iconInfo, version: versionInfo };
}

// 直接运行
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = await packageWin({ zip: !process.argv.includes('--no-zip'), icon: !process.argv.includes('--no-icon'), version: !process.argv.includes('--no-version') });
    console.log(`[package] 好了：${r.dir}（${Math.round(r.bytes / 1048576)} MB，自带 ${r.skins.length} 套皮肤${r.icon ? `，exe 图标换成了 logo（${r.icon.sizes.join(' / ')} 像素）` : ''}）`);
    if (r.zip) console.log(`[package] 给别人的：${r.zip}（${Math.round(fs.statSync(r.zip).size / 1048576)} MB）`);
  } catch (error) {
    console.error(`[package] 没打成（${error.code || 'package.failed'}）：${error.message}\n[package] 下一步：${error.hint || '看上面的输出。'}`);
    process.exit(1);
  }
}
