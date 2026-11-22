/** 依次跑 test/ 下所有 *.test.mjs（各自一个进程，互不影响）。有一个失败就以非零退出。 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test');
const only = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).filter((name) => !only.length || only.some((word) => name.includes(word))).sort();
let failed = 0;
// 程序自带的 CrossPet 角色（skins-bundled/）是按这台机器上的 art/ 转出来的：测试里换成一个不存在的文件夹，结果不随机器变。
// 要测它的测试自己设 OSU_PET_BUNDLED_DIR。
const bundled = path.join(dir, '..', 'node_modules', '.osu-pet-test-no-bundled');
for (const name of files) {
  const run = spawnSync(process.execPath, [path.join(dir, name)], { stdio: 'inherit', env: { ...process.env, OSU_PET_BUNDLED_DIR: process.env.OSU_PET_BUNDLED_DIR || bundled } });
  if (run.status !== 0) { failed += 1; console.error(`✗ ${name}（退出码 ${run.status}）`); }
}
console.log(`\n${files.length - failed} / ${files.length} 个测试文件通过`);
process.exit(failed ? 1 : 0);
