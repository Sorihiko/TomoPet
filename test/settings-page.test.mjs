/**
 * 设置窗口改版（2026-11-20 用户选的「首页总览 + 分页」「深色、像游戏设置」）：只看页面结构，不开窗口。
 * 钉住：改版前的每个设置项 / 按钮都还在（存和读的逻辑没变，只换了结构）；左边每个页签都有一页；
 * 「下一步」里每个 section 都能跳到一页；离屏自检用到的元素都在；皮肤缩略图取得对。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'app', 'settings', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'app', 'settings', 'settings.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app', 'settings', 'settings.css'), 'utf8');
const all = (re) => [...html.matchAll(re)].map((m) => m[1]);

// ── 设置项和按钮一个不少 ────────────────────────────────────────────────────
{
  const cfg = new Set(all(/data-cfg="([^"]+)"/g));
  const expected = ['watch.enabled', 'watch.output', 'watch.voice', 'watch.midPlay', 'watch.minGapSec', 'watch.perSongMax', 'watch.dailyLimit', 'watch.remember',
    'persona.name', 'persona.ownerName', 'persona.ownerPronoun', 'llm.provider', 'llm.model', 'llm.baseUrl', 'tts.appId', 'tts.speaker', 'tts.resourceId', 'tts.speed',
    'pet.enabled', 'pet.scale', 'counter.enabled', 'rulers.bpmVeryFast', 'rulers.bpmFast', 'rulers.bpmSlowMax', 'rulers.arSlowBelow', 'rulers.arFastAbove', 'rulers.bpmVeryFastNote'];
  for (const key of expected) assert.ok(cfg.has(key), `设置项 ${key} 不见了`);
  assert.deepEqual(new Set(all(/data-secret="([^"]+)"/g)), new Set(['llm.apiKey', 'tts.accessKey', 'tts.breezeKey', 'osuApi.clientSecret']));
  assert.ok(cfg.has('osuApi.clientId'), 'osu! 官网 OAuth 应用的 Client ID');
  const calls = new Set(all(/data-call="([^"]+)"/g));
  for (const name of ['watch.test', 'persona.open', 'llm.test', 'tts.test', 'skin.import', 'skins.open', 'pet.recenter', 'tosu.pickDir', 'counter.sync', 'plays.clear', 'data.open', 'osuapi.test']) assert.ok(calls.has(name), `按钮 ${name} 不见了`);
  assert.equal(all(/value="(subtitle|bubble|none)" data-cfg="watch.output"/g).length, 3, '「怎么说」三个选项');
  assert.ok(!html.includes('skin-select'), '皮肤下拉框换成了卡片墙');
}

// ── 分页 ─────────────────────────────────────────────────────────────────────
{
  const pages = all(/<section class="page" data-page="([^"]+)"/g);
  const navPages = all(/<a href="#[^"]+" data-page="([^"]+)"/g);
  assert.deepEqual(pages, ['overview', 'pet', 'watch', 'persona', 'llm', 'tts', 'obs', 'advanced'], '顺序：总览、角色、说话、人设、模型、语音、OBS、高级（2026-11-22 用户）');
  assert.deepEqual(navPages, pages, '左边每个页签都有一页');
  assert.ok(js.includes(`const PAGES = ${JSON.stringify(pages).replace(/"/g, "'").replace(/,/g, ', ')};`), 'settings.js 认得每一页');
  // 一开始只有总览不藏
  const hidden = [...html.matchAll(/<section class="page" data-page="([^"]+)"[^>]*>/g)].map((m) => [m[1], /\bhidden\b/.test(m[0])]);
  assert.deepEqual(hidden.filter(([, h]) => !h).map(([p]) => p), ['overview']);
  // 「下一步」的每个 section（core/next-step.js）都能跳到一页
  const sections = new Set([...fs.readFileSync(path.join(ROOT, 'core', 'next-step.js'), 'utf8').matchAll(/add\('(?:error|warn|info)', '([a-z]+)'/g)].map((m) => m[1]));
  const map = JSON.parse(/const PAGE_OF_SECTION = (\{[^}]+\});/.exec(js)[1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"'));
  for (const section of sections) assert.ok(pages.includes(map[section]), `「下一步」的 ${section} 跳不到页`);
}

// ── 离屏自检和外面用到的元素都在；样式是深色 ──────────────────────────────────
{
  for (const id of ['steps', 'st-tosu', 'st-playing', 'st-last', 'st-today', 'st-today-count', 'st-today-bar', 'st-skipped', 'logo', 'obs-url', 'obs-suburl', 'obs-status', 'obs-tosudir',
    'skin-grid', 'skin-notes', 'scale-value', 'plays-table', 'plays-mini', 'about-data', 'persona-info', 'llm-info', 'secret-note', 'hero-img', 'hero-name', 'nav-badge', 'master-state', 'toasts', 'btn-clear-tosudir']) {
    assert.ok(html.includes(`id="${id}"`), `缺 #${id}`);
  }
  assert.ok(css.includes('color-scheme: dark') && /--accent:\s*#ff66aa/.test(css), '深色、osu! 粉做强调');
  assert.ok(/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css), '带 hidden 的一律不显示（2026-11-21：展示台大字母被 display: grid 盖过 hidden，选中文字时冒出来）');
  assert.ok(!/style="/.test(html), '页面里没有内联 style（CSP 不许）');
  assert.ok(html.includes("img-src 'self' data:"), '缩略图走本地文件协议，CSP 允许');
}

// ── 皮肤缩略图 ───────────────────────────────────────────────────────────────
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tomopet-thumb-'));
  process.env.OSU_PET_HOME = path.join(sandbox, 'home');
  process.env.OSU_PET_BUNDLED_DIR = path.join(sandbox, 'bundled');
  const { thumbOf } = await import('../core/skins.js');
  const dir = path.join(sandbox, 'skin');
  fs.mkdirSync(path.join(dir, 'art'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'art', 'idle.webp'), 'W');
  assert.equal(thumbOf(dir, { sprite: { poses: { idle: ['art/idle.webp', 'art/idle-2.webp'] } } }), 'art/idle.webp', '姿势皮肤用待机第一张');
  assert.equal(thumbOf(dir, { sprite: { poses: { idle: 'art/idle.webp' } } }), 'art/idle.webp');
  assert.equal(thumbOf(dir, { sprite: { poses: { idle: ['art/missing.webp'] } } }), null, '文件不在就不给');
  assert.equal(thumbOf(dir, { sprite: { poses: { idle: ['../../etc/passwd'] } } }), null, '不许指到皮肤文件夹外面');
  fs.writeFileSync(path.join(dir, 'preview.png'), 'P');
  assert.equal(thumbOf(dir, { rig: 'layered' }), 'preview.png', '别的皮肤用 preview.png');
  assert.equal(thumbOf(dir, null), 'preview.png');
  // 角色页展示台（2026-11-21 像游戏选角）：几个姿势轮着换；缺的、重复的（导入时换成同一张图的）、指到外面的都不要
  const { posePreviews } = await import('../core/skins.js');
  for (const f of ['happy-2.webp', 'oops.webp', 'sleeping.webp']) fs.writeFileSync(path.join(dir, 'art', f), 'W');
  const poses = posePreviews(dir, { sprite: { poses: { idle: ['art/idle.webp'], happy: ['art/happy-2.webp'], proud: ['art/happy-2.webp'], oops: 'art/oops.webp', drink: ['art/missing.webp'], redhot: ['../../x.webp'], sleeping: ['art/sleeping.webp'] } } });
  assert.deepEqual(poses.map((p) => [p.key, p.label, p.file]), [['idle', '待机', 'art/idle.webp'], ['happy', '开心', 'art/happy-2.webp'], ['oops', '呜哇', 'art/oops.webp'], ['sleeping', '睡觉', 'art/sleeping.webp']]);
  assert.deepEqual(posePreviews(dir, { rig: 'layered' }), [], '不是姿势皮肤就没有');
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log('settings-page: ok');
