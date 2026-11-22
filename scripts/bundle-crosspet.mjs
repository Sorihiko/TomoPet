/**
 * 把程序文件夹里的 CrossPet 角色（art/crosspet/）转成皮肤，放进 skins-bundled/。两个文件夹都不进 git。
 * 程序启动时把 skins-bundled/ 里的角色列在「皮肤」下拉框里，不用导入；给别人的安装包里也带着它（scripts/package-win.mjs）。
 *
 *   node scripts/bundle-crosspet.mjs               每个角色都重新转（有没转成的就以非零退出）
 *   node scripts/bundle-crosspet.mjs --if-missing  转过、源文件没变的跳过（npm start 用）：出了问题只提示，
 *                                                  照样以 0 退出——不能因为一套皮肤没转成就不让程序启动
 *
 * art/crosspet/ 放什么：CrossPet（github.com/lokicorvus/crosspet）仓库里的 characters 文件夹
 * （或者整个仓库）。没有就不转（已经转好的留着）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ART_DIR, bundleCrossPet } from '../core/crosspet-import.js';
import { BUNDLED_DIR } from '../core/skins.js';

const ifMissing = process.argv.includes('--if-missing');
const rel = (p) => path.relative(process.cwd(), p) || p;
const fail = (code, error, hint) => {
  console.error(`[crosspet] 没转成（${code}）：${error}\n[crosspet] 下一步：${hint}`);
  process.exit(ifMissing ? 0 : 1);
};

let result;
try {
  result = bundleCrossPet({ artDir: ART_DIR, outDir: BUNDLED_DIR, ifMissing });
} catch (error) {
  fail('crosspet.bundle-failed', String(error?.message ?? error).slice(0, 200), `检查 ${rel(BUNDLED_DIR)} 能不能写（关掉占着它的程序），再跑一次 npm run bundle-crosspet。`);
}
if (!result.ok) fail(result.code, result.error, result.hint);

if (!result.artFound) {
  const have = (() => { try { return fs.readdirSync(BUNDLED_DIR).filter((n) => n.startsWith('crosspet-')).length; } catch { return 0; } })();
  console.log(`[crosspet] ${rel(ART_DIR)} 里没找到 CrossPet 的角色${have ? `，已经转好的 ${have} 套留着没动` : '（程序里一套皮肤都没有，桌面角色和 OBS 角色都出不来）'}。`);
  console.log('[crosspet] 要放的是 CrossPet 仓库里的 characters 文件夹（art/crosspet/characters/<角色>/character.json），或者整个仓库（art/crosspet/characters/…）；别多套一层文件夹。');
} else {
  for (const item of result.built) {
    const subs = Object.entries(item.substituted).map(([pose, src]) => `${pose}→${src}`).join('、');
    console.log(`[crosspet] ✓ ${item.id}  ${item.name}  ${item.poses} 个姿势、${item.files} 张图${subs ? `；代替：${subs}` : ''}${item.missing.length ? `；缺：${item.missing.join('、')}` : ''}${item.mouth ? '，带张嘴口型' : item.mouthSkipped && item.mouthSkipped !== '没有口型' ? `；口型没带上：${item.mouthSkipped}` : ''}`);
  }
  for (const id of result.removed) console.log(`[crosspet] - ${id}（源里已经没有了，删掉）`);
  for (const item of result.skipped) console.log(`[crosspet] ✗ ${item.folder}（${item.code}）：${item.error}\n[crosspet]   下一步：${item.hint}`);
  console.log(`[crosspet] ${result.built.length} 个新转的、${result.kept.length} 个没变${result.skipped.length ? `、${result.skipped.length} 个没转成` : ''}，在 ${rel(BUNDLED_DIR)}。`);
}
if (!ifMissing && result.skipped.length) process.exit(1);
