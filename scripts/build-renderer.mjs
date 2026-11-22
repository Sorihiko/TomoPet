/**
 * 把 renderer/ 下的两个入口打成浏览器能直接加载的单文件（PixiJS 一起打进去）：
 *   dist/counter-renderer.js   OBS 里的 tosu counter 页用（拷进 tosu 的 static 文件夹）
 *   dist/pet-renderer.js       桌面角色窗口用
 *
 * 用法：node scripts/build-renderer.mjs               每次都重新打
 *       node scripts/build-renderer.mjs --if-missing  产物都在、而且比源文件新就跳过（npm start 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIST = path.join(ROOT, 'dist');
export const OUTPUTS = { counter: path.join(DIST, 'counter-renderer.js'), pet: path.join(DIST, 'pet-renderer.js') };
const SRC = path.join(ROOT, 'renderer');

function upToDate() {
  try {
    const newestSource = Math.max(...fs.readdirSync(SRC).map((name) => fs.statSync(path.join(SRC, name)).mtimeMs));
    return Object.values(OUTPUTS).every((file) => fs.statSync(file).mtimeMs >= newestSource);
  } catch {
    return false;
  }
}

/**
 * 打包渲染层。返回 { built, inputs }（inputs：打进去的源文件，相对项目根；打包脚本拿它找打进去的第三方包，写进 THIRD-PARTY-NOTICES.txt）。
 * outdir 只给 scripts/package-win.mjs 用：给别人的那份打到别处，不动项目里的 dist/。
 */
export async function buildRenderer({ ifMissing = false, log = console.log, outdir = DIST } = {}) {
  if (ifMissing && outdir === DIST && upToDate()) return { built: false, inputs: [] };
  const esbuild = await import('esbuild');
  fs.mkdirSync(outdir, { recursive: true });
  const result = await esbuild.build({
    entryPoints: { 'counter-renderer': path.join(SRC, 'counter-entry.ts'), 'pet-renderer': path.join(SRC, 'pet-entry.ts') },
    outdir,
    metafile: true,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    // OBS 的浏览器源是 Chromium 内核（OBS 30 是 103 起），别用太新的语法。
    target: ['chrome103'],
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  });
  for (const name of ['counter-renderer.js', 'pet-renderer.js']) log(`built ${path.relative(ROOT, path.join(outdir, name))}  ${(fs.statSync(path.join(outdir, name)).size / 1024).toFixed(0)} KB`);
  const inputs = Object.keys(result.metafile?.inputs ?? {}).map((p) => p.split(path.sep).join('/')).sort();
  return { built: true, inputs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRenderer({ ifMissing: process.argv.includes('--if-missing') }).catch((error) => {
    console.error('渲染层打包失败：', error?.message ?? error);
    console.error('先确认跑过 npm install（需要 esbuild 和 pixi.js）。');
    process.exit(1);
  });
}
