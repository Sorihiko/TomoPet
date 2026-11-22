/**
 * 离屏自检的隔离（app/smoke-guard.js）：自检不连真的 tosu、不往真的 tosu 文件夹写、不改真的数据目录。
 * 2026-11-20 复核发现原来自检会连上正在跑的 tosu，并把占位皮肤拷进用户 OBS 用的 fatfish-osu。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMOKE_TOSU_URL, findNoTosu, isolateConfig, smokePreflight } from '../app/smoke-guard.js';
import { createTosuCounter, COUNTER_FOLDER } from '../core/tosu-counter.js';
import { DEFAULTS } from '../core/config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 设置隔离 ─────────────────────────────────────────────────────────────────
{
  const real = { ...DEFAULTS, watch: { ...DEFAULTS.watch, enabled: true, url: 'ws://127.0.0.1:24050/websocket/v2' }, counter: { enabled: true, tosuDir: 'D:\\游戏用' }, pet: { ...DEFAULTS.pet, skin: 'crosspet-deepseek' } };
  const iso = isolateConfig(real);
  assert.equal(iso.watch.url, SMOKE_TOSU_URL, 'tosu 地址换成连不上的');
  assert.match(SMOKE_TOSU_URL, /^ws:\/\/127\.0\.0\.1:1\//, '本机端口 1：没人监听');
  assert.deepEqual(iso.counter, { enabled: false, tosuDir: '' }, 'OBS 页面关掉，也不用设置里写死的 tosu 目录');
  assert.equal(iso.watch.enabled, true, '「看你打 osu!」照常跑（自检要测它），只是连不上');
  assert.equal(iso.pet.skin, 'crosspet-deepseek', '别的设置不动');
  assert.equal(real.watch.url, 'ws://127.0.0.1:24050/websocket/v2', '不改原对象');
  assert.deepEqual(isolateConfig(null).counter, { enabled: false, tosuDir: '' });
  assert.equal(await findNoTosu(), '');
}

// ── 必须有临时数据目录 ───────────────────────────────────────────────────────
{
  assert.deepEqual(smokePreflight({}), { ok: true, smoke: false }, '平时启动不受影响');
  const bad = smokePreflight({ OSU_PET_SMOKE: 'out' });
  assert.deepEqual([bad.ok, bad.code], [false, 'smoke.no-home']);
  assert.ok(bad.error.includes('OSU_PET_HOME') && bad.hint.includes('OSU_PET_HOME='));
  assert.equal(smokePreflight({ OSU_PET_SMOKE: 'out', OSU_PET_HOME: '   ' }).ok, false);
  assert.deepEqual(smokePreflight({ OSU_PET_SMOKE: 'out', OSU_PET_HOME: 'C:\\tmp\\x' }), { ok: true, smoke: true });
}

// ── 隔离后的 OBS 页面：就算有一个「正在跑的 tosu」，也一个文件都不写 ─────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-smoke-guard-'));
  try {
    const tosuDir = path.join(root, 'tosu');
    fs.mkdirSync(path.join(tosuDir, 'static'), { recursive: true });
    let asked = 0;
    const real = { counter: { enabled: true, tosuDir: '' }, pet: { skin: 'crosspet-deepseek' }, watch: { url: 'ws://127.0.0.1:24050/websocket/v2' } };
    const cfg = () => isolateConfig(real);
    const counter = createTosuCounter({
      config: () => { const c = cfg(); return { enabled: c.counter.enabled, tosuDir: c.counter.tosuDir, skinId: c.pet.skin, tosuUrl: c.watch.url }; },
      resolveSkin: () => { throw new Error('不该走到装皮肤'); },
      findTosu: findNoTosu,
    });
    assert.deepEqual(await counter.sync(), { ok: true, disabled: true });
    assert.equal(counter.say({ text: 'x' }), false);
    assert.equal(counter.react({ moment: 'fc', playing: true }), false);
    assert.equal(asked, 0);
    assert.deepEqual(fs.readdirSync(path.join(tosuDir, 'static')), [], `static 里不该出现 ${COUNTER_FOLDER}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── main.js 真的用上了隔离（源码里接好了） ───────────────────────────────────
{
  const main = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');
  assert.ok(main.includes("from './smoke-guard.js'"));
  assert.ok(/const smoke = smokePreflight\(process\.env\);[\s\S]*?if \(!smoke\.ok\)[\s\S]*?app\.exit\(2\)[\s\S]*?setDataDir/.test(main), '没有临时数据目录就退出，而且在定数据目录之前');
  assert.ok(main.includes('smoke.smoke ? () => isolateConfig(configStore.get())'), '自检时程序读到的是隔离后的设置');
  assert.ok(main.includes('findTosu: smoke.smoke ? findNoTosu : undefined'), '自检时 OBS 页面不去找真的 tosu.exe');
}

console.log('smoke-guard: ok');
