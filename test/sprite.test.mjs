/**
 * 姿势皮肤：导演逻辑（renderer/sprite-director.js）、CrossPet 导入（core/crosspet-import.js）、皮肤校验（rig: sprite）、
 * OBS 那一头（tosu-counter 的 react 和 counter.js 读 state.json）、渲染层产物里有姿势渲染器。
 * 不碰真的 CrossPet：在临时目录里造一个假的（假 WebP 文件头 + character.json + LICENSE.md）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-sprite-'));
process.env.OSU_PET_HOME = path.join(sandbox, '数据');
// 程序自带的角色转到临时目录里（单独跑这个测试文件时也不碰真的 skins-bundled/）。
process.env.OSU_PET_BUNDLED_DIR = path.join(sandbox, 'skins-bundled');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSpriteDirector, DEFAULT_TIMING } = await import('../renderer/sprite-director.js');
const importer = await import('../core/crosspet-import.js');
const skins = await import('../core/skins.js');
const { createTosuCounter, skinFingerprint } = await import('../core/tosu-counter.js');
const expectFail = (result, code) => { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.code, code); assert.ok(result.error && result.hint, `${code} 要带 error 和 hint`); };

// ── 导演 ─────────────────────────────────────────────────────────────────────
const SPEC = {
  poses: {
    idle: ['art/idle.webp', 'art/idle-2.webp'], listening: ['art/listening.webp'], running: ['art/running.webp'], happy: ['art/happy.webp'],
    oops: ['art/oops.webp'], dizzy: ['art/dizzy.webp'], surprised: ['art/surprised.webp'], annoyed: ['art/annoyed.webp'], drink: ['art/drink.webp'],
    puffed: ['art/puffed.webp'], redhot: ['art/redhot.webp'], proud: ['art/proud.webp'], pat: ['art/pat.webp'], coaxed: ['art/coaxed.webp'],
    forgiven: ['art/forgiven.webp'], yawn: ['art/yawn.webp'], sleeping: ['art/sleeping.webp'],
  },
  blink: { base: 'idle', file: 'art/idle-blink.webp' },
  base: { idle: 'idle', playing: 'listening', resting: 'drink', talk: 'listening', drowsy: 'yawn', sleep: 'sleeping' },
  reactions: {
    start: { pose: 'running', motion: 'jolt', holdMs: 2200, priority: 1 },
    combo: { pose: 'happy', motion: 'jump', holdMs: 4500, priority: 1 },
    'combo-break': { pose: 'oops', motion: 'shake', holdMs: 4000, priority: 2 },
    'fc-lost': { pose: 'dizzy', motion: 'dizzy', holdMs: 5000, priority: 3 },
    fc: { pose: 'proud', motion: 'hop', holdMs: 6000, priority: 4 },
    'rank-up': { pose: 'nonexistent', motion: 'hop', holdMs: 3000, priority: 1 },
  },
  motions: { drink: 'slow' },
};
{
  let t = 1_000_000;
  const d = createSpriteDirector(SPEC, { now: t, random: () => 0.9 });
  const cur = () => d.current(t);
  assert.deepEqual([cur().pose, cur().file, cur().motion, cur().blinkable], ['idle', 'art/idle.webp', 'bob', true], '平时：待机主图，能眨眼');
  // 打图：开局冲一下 → 专注；连击关口开心一下又回到专注。
  d.command('play-on', t);
  d.command('react:start', t);
  assert.deepEqual([cur().pose, cur().motion], ['running', 'jolt']);
  t += 2300;
  assert.deepEqual([cur().pose, cur().motion, cur().blinkable], ['listening', 'slow', false], '打图中：专注的姿势，不眨眼');
  d.command('react:combo', t);
  assert.equal(cur().pose, 'happy');
  // 低优先级的不打断刚开始的高优先级；高的打断低的。
  t += 500;
  d.command('react:combo-break', t);
  assert.equal(cur().pose, 'oops', '断连（2）打断连击（1）');
  t += 500;
  d.command('react:combo', t);
  assert.equal(cur().pose, 'oops', '连击（1）不打断刚开始 0.5 秒的断连（2）');
  t += DEFAULT_TIMING.minHoldMs;
  d.command('react:combo', t);
  assert.equal(cur().pose, 'happy', '过了最短停留时间就可以换');
  // 休息段：喝水是底姿势，反应结束后回到喝水；结束后回到专注。
  t += 5000;
  d.command('react:break', t);
  assert.deepEqual([cur().pose, cur().motion], ['drink', 'slow']);
  t += 60_000;
  assert.equal(cur().pose, 'drink', '一直喝到休息段结束');
  d.command('react:break-end', t);
  assert.equal(cur().pose, 'listening');
  // 说话：刚发生的事陪着这句话一直摆着；话说完 1.5 秒后收。
  d.command('react:fc-lost', t);
  t += 3000;
  d.command('talk-start', t);
  t += 20_000;
  assert.deepEqual([cur().pose, cur().talking], ['dizzy', true], '她说的就是这件事：姿势陪着说话');
  d.command('talk-stop', t);
  t += 1000;
  assert.equal(cur().pose, 'dizzy');
  t += 600;
  assert.equal(cur().pose, 'listening', '话说完就收');
  // 很早以前的反应早就过期：说话时摆「说话」姿势。
  d.command('talk-start', t);
  assert.deepEqual([cur().pose, cur().motion, cur().talking], ['listening', 'quick', true]);
  d.command('talk-stop', t);
  // 打完：全连骄傲；离开打图回到待机。
  d.command('react:fc', t);
  d.command('play-off', t);
  assert.equal(cur().pose, 'proud');
  t += 6100;
  assert.equal(cur().pose, 'idle');
  // 反应表里写了不存在的姿势：退回底姿势，不报错。
  d.command('react:rank-up', t);
  assert.equal(cur().pose, 'idle');
  assert.equal(d.command('react:never-heard', t), true, '不认识的时刻：认得这个命令，但什么都不做');
  assert.equal(d.command('think-start', t), false, '别的渲染器的命令：忽略');
  // 摸头 / 戳她：戳几下越来越生气；生着气摸头先被哄、再摸原谅。
  t += 10_000;
  d.command('poke', t);
  assert.equal(cur().pose, 'surprised');
  d.command('poke', t + 100);
  assert.equal(cur().pose, 'annoyed');
  d.command('poke', t + 200);
  d.command('poke', t + 300);
  assert.deepEqual([cur().pose, cur().motion], ['redhot', 'angry']);
  t += 400;
  d.command('pat', t);
  assert.equal(cur().pose, 'coaxed');
  d.command('pat', t + 100);
  assert.equal(cur().pose, 'forgiven');
  t += 3700;
  d.command('pat', t);
  assert.equal(cur().pose, 'pat', '不生气时摸头就是摸头');
  // 很久没动静：先打哈欠再睡着；打图中不会困。
  t += 4000;
  const quiet = t;
  t = quiet + DEFAULT_TIMING.drowsyAfterMs + 1;
  assert.deepEqual([cur().pose, cur().motion], ['yawn', 'squish']);
  t = quiet + DEFAULT_TIMING.sleepAfterMs + 1;
  assert.equal(cur().pose, 'sleeping');
  d.command('play-on', t);
  t += DEFAULT_TIMING.sleepAfterMs * 3;
  assert.equal(cur().pose, 'listening', '打图中不会困');
  d.command('play-off', t);
  // 待机轮换：隔一会儿换一张，不在主图上不眨眼。
  t += DEFAULT_TIMING.idleSwapMs + 1;
  const swapped = cur();
  assert.deepEqual([swapped.pose, swapped.file, swapped.blinkable], ['idle', 'art/idle-2.webp', false]);
  // 菜单「说句话」：说 2.6 秒自己停。
  d.command('talk', t);
  assert.equal(cur().talking, true);
  t += 2700;
  assert.equal(cur().talking, false);
  // 眨眼请求只给一次。
  d.command('blink', t);
  assert.deepEqual([d.takeBlinkRequest(), d.takeBlinkRequest()], [true, false]);
  assert.ok(d.files().includes('art/idle-blink.webp') && d.files().includes('art/idle-2.webp'), '预载清单里有所有图');
  // 没有 spec 也不崩。
  const empty = createSpriteDirector({}, { now: 0 });
  assert.deepEqual([empty.current(0).pose, empty.current(0).file], ['idle', '']);
  assert.equal(d.mainFile(), 'art/idle.webp');
}

// ── 导演：像真的渲染器那样每 100 毫秒问一次（复核发现的问题都按真实节奏钉住）────────────────
{
  /** 从 from 到 to 每 100 毫秒调一次 current()，返回最后一次的结果。 */
  const run = (d, from, to) => { let last = null; for (let t = from; t <= to; t += 100) last = d.current(t); return last; };
  // 1. 她的话晚几秒才到：刚过期的反应被请回来陪着这句话；话说完 1.5 秒后收。
  {
    const d = createSpriteDirector(SPEC, { now: 0, random: () => 0 });
    d.command('play-on', 0);
    d.command('react:fc-lost', 0); // dizzy，摆 5 秒
    assert.equal(run(d, 0, 5900).pose, 'listening', '6 秒时反应已经过期');
    d.command('talk-start', 6000);
    assert.deepEqual([run(d, 6000, 9900).pose, d.current(9900).talking], ['dizzy', true], '她说的就是这件事：dizzy 被请回来');
    d.command('talk-stop', 10_000);
    assert.equal(run(d, 10_000, 11_400).pose, 'dizzy');
    assert.equal(run(d, 11_500, 11_600).pose, 'listening', '话说完 1.5 秒后收');
    // 12 秒以前的事不请回来。
    d.command('react:combo', 20_000);
    run(d, 20_000, 33_000);
    d.command('talk-start', 33_000);
    assert.deepEqual([d.current(33_000).pose, d.current(33_000).motion], ['listening', 'quick'], '太久以前的事：摆说话的姿势');
    d.command('talk-stop', 35_000);
    // 摸头 / 戳她不会被请回来陪说话（她说的是游戏里的事）。
    d.command('poke', 40_000);
    run(d, 40_000, 43_000);
    d.command('talk-start', 43_000);
    assert.equal(d.current(43_000).pose, 'listening');
    d.command('talk-stop', 44_000);
  }
  // 2. 窗口里两个都在：挑优先级高的（断连 2 比连击 1 重要）。
  {
    const d = createSpriteDirector(SPEC, { now: 0 });
    d.command('play-on', 0);
    d.command('react:combo-break', 0); // oops 4 秒
    run(d, 0, 4500);
    d.command('react:combo', 4500); // happy，正摆着
    d.command('talk-start', 6000);
    assert.equal(run(d, 6000, 8000).pose, 'oops');
  }
  // 3. 说话途中新开始的反应（打完时的全连）不会被上一句话的 talk-stop 截短。
  {
    const d = createSpriteDirector(SPEC, { now: 0 });
    d.command('play-on', 0);
    d.command('talk-start', 0);
    d.command('play-off', 3000);
    d.command('react:fc', 3000); // proud 6 秒，到 9 秒
    d.command('talk-stop', 4000);
    assert.equal(run(d, 4000, 8900).pose, 'proud', '全连的姿势照原来的时长摆');
    assert.equal(run(d, 9000, 9200).pose, 'idle');
  }
  // 4. 菜单「说句话」的计时不会在一句真的话中间收嘴；真的话说着时点菜单也不安排收嘴。
  {
    const d = createSpriteDirector(SPEC, { now: 0 });
    d.command('talk', 0);
    d.command('react:combo-break', 1000);
    d.command('talk-start', 1000); // 真的一句话，到 9 秒
    assert.equal(run(d, 1000, 8900).talking, true, '2.6 秒时没有被收嘴');
    d.command('talk-stop', 9000);
    assert.equal(d.current(9000).talking, false);
    d.command('talk-start', 10_000);
    d.command('talk', 11_000);
    assert.equal(run(d, 11_000, 15_000).talking, true, '说着话时点菜单：不安排 2.6 秒后收嘴');
    d.command('talk-stop', 15_000);
    d.command('talk', 16_000);
    assert.equal(run(d, 16_000, 18_700).talking, false, '没在说话时点菜单：说 2.6 秒自己停');
  }
  // 5. 皮肤没有 coaxed / forgiven：生气时摸头照样能哄好（按步数记，不按姿势名字）。
  {
    const poses = { ...SPEC.poses };
    delete poses.coaxed;
    delete poses.forgiven;
    const d = createSpriteDirector({ ...SPEC, poses }, { now: 0 });
    d.command('poke', 0);
    d.command('poke', 100);
    d.command('pat', 500);
    assert.equal(d.current(500).pose, 'pat', '没有 coaxed：用 pat 代替');
    d.command('pat', 700);
    assert.equal(d.debug().angryUntil, 0, '第二下就原谅了');
    d.command('pat', 5000);
    assert.equal(d.current(5000).pose, 'pat');
  }
}

// ── 造一个假 CrossPet ────────────────────────────────────────────────────────
function webp(w, h) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(22, 4); b.write('WEBP', 8, 'ascii'); b.write('VP8X', 12, 'ascii'); b.writeUInt32LE(10, 16);
  b[20] = 0x10; b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}
const CP = path.join(sandbox, 'crosspet-main');
const ALL = ['idle', 'idle-2', 'idle-3', 'idle-blink', 'listening', 'running', 'happy', 'oops', 'dizzy', 'surprised', 'annoyed', 'drink', 'hum', 'puffed', 'sulk', 'tired', 'redhot', 'proud', 'pat', 'coaxed', 'forgiven', 'yawn', 'sleeping', 'bye', 'roll_call', 'reading', 'eat', 'edge_left', 'avatar', 'fest_spring'];
function makeChar(id, { skip = [], extra = [], name = id, outfit, skinName } = {}) {
  const dir = path.join(CP, 'characters', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'character.json'), JSON.stringify({ name, ...(outfit ? { outfit } : {}), ...(skinName ? { skinName } : {}), lines: { idle: ['不该被拷走的台词'] } }));
  ALL.filter((p) => !skip.includes(p)).concat(extra).forEach((p, i) => fs.writeFileSync(path.join(dir, `${p}.webp`), webp(p === 'idle' ? 616 : 480 + (i % 7) * 20, 640)));
  return dir;
}
makeChar('deepseek', { name: 'DeepSeek', outfit: '女仆装' });
makeChar('deepseek-hoodie', { name: 'DeepSeek', skinName: 'Claude 卫衣' });
// 真的 CrossPet 里 Claude 没有 happy / pat / sleeping，但有 happy-2 / pat-2 / sleeping-2（复核发现）。
makeChar('claude', { name: 'Claude', skip: ['happy', 'pat', 'sleeping', 'reading'], extra: ['happy-2', 'pat-2', 'sleeping-2', 'coaxed-2'] });
makeChar('gemini', { name: 'Gemini', skip: ['idle-blink'] });
fs.mkdirSync(path.join(CP, 'characters', 'egg-qwen'), { recursive: true });
fs.writeFileSync(path.join(CP, 'characters', 'egg-qwen', 'character.json'), '{}');
fs.writeFileSync(path.join(CP, 'characters', 'LICENSE.md'), [
  '# 授权', '| 角色 | 设定来源 |', '|---|---|',
  '| DeepSeek | 原型「溟月」：**上善无形**（2025-06，CC BY-NC-SA 4.0）；深蓝女仆鲸鱼娘（「大肥鱼」）：B 站 **ZipZipPipe** |',
  '| Claude | 社区流行的 Claude 娘设定（铜橙色长发、橙花发饰、书） |',
].join('\n'));

// ── 导入 ─────────────────────────────────────────────────────────────────────
{
  assert.deepEqual(importer.webpSize(webp(616, 640)), { w: 616, h: 640 });
  assert.equal(importer.webpSize(Buffer.from('not a webp at all, not at all')), null);
  // 找角色：选整个 CrossPet、characters、某个角色都行；彩蛋不算。
  const names = (src) => importer.findCharacterDirs(src).map((d) => path.basename(d));
  assert.deepEqual(names(CP), ['claude', 'deepseek', 'deepseek-hoodie', 'gemini']);
  assert.deepEqual(names(path.join(CP, 'characters')), ['claude', 'deepseek', 'deepseek-hoodie', 'gemini']);
  assert.deepEqual(names(path.join(CP, 'characters', 'deepseek')), ['deepseek']);
  assert.deepEqual(names(path.join(sandbox, 'nowhere')), []);
  assert.equal(importer.creditLine(path.join(CP, 'characters', 'deepseek-hoodie')), '原型「溟月」：上善无形（2025-06，CC BY-NC-SA 4.0）；深蓝女仆鲸鱼娘（「大肥鱼」）：B 站 ZipZipPipe', '换装用原角色那一行，去掉加粗');
  assert.equal(importer.creditLine(path.join(CP, 'characters', 'gemini')), '', '表里没有就空着');
  expectFail(importer.importCrossPet(path.join(sandbox, 'nowhere')), 'crosspet.not-found');
  expectFail(importer.importCrossPet(path.join(CP, 'characters', 'egg-qwen')), 'crosspet.bad-character');

  const result = importer.importCrossPet(CP, { now: () => 1_800_000_000_000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.imported.map((i) => i.id), ['crosspet-claude', 'crosspet-deepseek', 'crosspet-deepseek-hoodie', 'crosspet-gemini']);
  const byId = Object.fromEntries(result.imported.map((i) => [i.id, i]));
  assert.deepEqual(byId['crosspet-claude'].substituted, {}, 'Claude 的 happy-2 / pat-2 / sleeping-2 认得出来，不用代替');
  const claudeManifest = JSON.parse(fs.readFileSync(path.join(process.env.OSU_PET_HOME, 'skins', 'crosspet-claude', 'manifest.json'), 'utf8'));
  assert.deepEqual([claudeManifest.sprite.poses.happy, claudeManifest.sprite.poses.pat, claudeManifest.sprite.poses.coaxed], [['art/happy-2.webp'], ['art/pat-2.webp'], ['art/coaxed.webp', 'art/coaxed-2.webp']]);
  assert.deepEqual([byId['crosspet-deepseek'].name, byId['crosspet-deepseek-hoodie'].name], ['DeepSeek·女仆装', 'DeepSeek·Claude 卫衣'], '换装用 CrossPet 自己的名字（skinName），不会同名');
  // 名字里不带「（CrossPet）」（2026-11-20 用户：括号删了）；来源照样写在 manifest 的 author 和 CREDITS.md 里。
  assert.ok(result.imported.every((i) => !i.name.includes('CrossPet') && !/[（(]/.test(i.name)), result.imported.map((i) => i.name).join('、'));
  // 真没有的姿势才换成最接近的。
  const noHappy = makeChar('glm', { name: 'GLM', skip: ['happy'] });
  const glm = importer.importCrossPet(noHappy);
  assert.deepEqual(glm.imported[0].substituted, { happy: 'roll_call' });
  fs.rmSync(noHappy, { recursive: true, force: true });
  fs.rmSync(path.join(process.env.OSU_PET_HOME, 'skins', 'crosspet-glm'), { recursive: true, force: true });

  const dir = path.join(process.env.OSU_PET_HOME, 'skins', 'crosspet-deepseek');
  const checked = skins.validateSkin(dir);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.deepEqual(checked.warnings, []);
  const m = checked.manifest;
  assert.deepEqual([m.rig, m.canvas, m.hitbox], ['sprite', { w: 616, h: 640 }, { x: 0, y: 0, w: 616, h: 640 }]);
  assert.deepEqual(m.sprite.poses.idle, ['art/idle.webp', 'art/idle-2.webp', 'art/idle-3.webp']);
  assert.deepEqual(m.sprite.blink, { base: 'idle', file: 'art/idle-blink.webp' });
  assert.equal(m.sprite.base.resting, 'drink');
  for (const moment of ['start', 'combo', 'combo-break', 'slider-break', 'fc-lost', 'acc-drop', 'rank-up', 'rank-down', 'retry', 'retry-sulk', 'retry-tired', 'retry-rage', 'fc', 'pass-good', 'pass', 'fail', 'quit']) {
    const r = m.sprite.reactions[moment];
    assert.ok(r && m.sprite.poses[r.pose], `${moment} 有反应，而且姿势存在`);
  }
  assert.ok(m.interaction.regions.some((r) => r.gesture === 'pat' && r.shape.type === 'ellipse'), '有摸头区域（气泡靠它定位）');
  // 只拷用得上的图；不拷台词、头像、节日图。
  const art = fs.readdirSync(path.join(dir, 'art')).sort();
  for (const notCopied of ['avatar.webp', 'fest_spring.webp', 'eat.webp', 'edge_left.webp']) assert.ok(!art.includes(notCopied), `不拷 ${notCopied}`);
  assert.ok(!fs.existsSync(path.join(dir, 'character.json')), '不拷 character.json（里面的台词也是 CC BY-NC-SA）');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['CREDITS.md', 'art', 'manifest.json']);
  // 图原样拷贝。
  assert.ok(fs.readFileSync(path.join(dir, 'art', 'oops.webp')).equals(fs.readFileSync(path.join(CP, 'characters', 'deepseek', 'oops.webp'))));
  const credits = fs.readFileSync(path.join(dir, 'CREDITS.md'), 'utf8');
  for (const wanted of ['CrossPet（https://github.com/lokicorvus/crosspet）', 'CC BY-NC-SA 4.0', '上善无形', 'ZipZipPipe', '不得商用', 'AI 生图', '没有修改']) assert.ok(credits.includes(wanted), `CREDITS 缺「${wanted}」`);
  assert.ok(m.author.includes('CrossPet') && m.author.includes('ZipZipPipe'));
  const geminiCredits = fs.readFileSync(path.join(process.env.OSU_PET_HOME, 'skins', 'crosspet-gemini', 'CREDITS.md'), 'utf8');
  assert.ok(!geminiCredits.includes('用别的姿势代替'), '没有代替就不写那一节');
  // Gemini 没有眨眼帧：不写 blink。
  assert.equal(skins.validateSkin(path.join(process.env.OSU_PET_HOME, 'skins', 'crosspet-gemini')).manifest.sprite.blink, undefined);
  // 再导入一次：替换，不留临时文件。
  const again = importer.importCrossPet(path.join(CP, 'characters', 'deepseek'));
  assert.deepEqual([again.imported.length, again.imported[0].replaced], [1, true]);
  assert.deepEqual(fs.readdirSync(path.join(process.env.OSU_PET_HOME, 'skins')).sort(), ['crosspet-claude', 'crosspet-deepseek', 'crosspet-deepseek-hoodie', 'crosspet-gemini']);
  // 坏的角色文件夹：跳过并说明，别的照常。
  const broken = makeChar('broken', { skip: ['idle'] });
  fs.writeFileSync(path.join(broken, 'idle.webp'), 'not a webp');
  const mixed = importer.importCrossPet(CP);
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.skipped.map((s) => [s.folder, s.code]), [['broken', 'crosspet.bad-character']]);
  fs.rmSync(broken, { recursive: true, force: true });
  // 列表里认得出姿势皮肤。
  assert.ok(skins.listSkins().some((s) => s.id === 'crosspet-deepseek' && s.rig === 'sprite' && s.ok));
}

// ── 程序自带的 CrossPet 角色（2026-11-20 用户：「不需要导入 crosspet 选项，默认就全有」）──────────
{
  const out = skins.BUNDLED_DIR;
  assert.equal(out, path.join(sandbox, 'skins-bundled'), '测试里转到临时目录');
  // 没放 art：不算失败，什么都不做。
  const none = importer.bundleCrossPet({ artDir: path.join(sandbox, 'no-art'), outDir: out });
  assert.deepEqual([none.ok, none.artFound, none.built.length], [true, false, 0]);
  expectFail(importer.bundleCrossPet({ artDir: CP }), 'crosspet.no-out');

  const first = importer.bundleCrossPet({ artDir: path.join(CP, 'characters'), outDir: out });
  assert.equal(first.ok, true);
  assert.deepEqual(first.built.map((b) => b.id), ['crosspet-claude', 'crosspet-deepseek', 'crosspet-deepseek-hoodie', 'crosspet-gemini'], '彩蛋不转');
  assert.deepEqual(fs.readdirSync(out).sort(), ['crosspet-claude', 'crosspet-deepseek', 'crosspet-deepseek-hoodie', 'crosspet-gemini'], '不留临时文件夹');
  const dsDir = path.join(out, 'crosspet-deepseek');
  assert.deepEqual(fs.readdirSync(dsDir).sort(), ['.bundled.json', 'CREDITS.md', 'art', 'manifest.json']);
  assert.ok(skins.validateSkin(dsDir).ok);
  assert.ok(fs.readFileSync(path.join(dsDir, 'CREDITS.md'), 'utf8').includes('ZipZipPipe'), '署名照样写');

  // 列表：程序自带的排在用户的后面、占位小人前面。
  // 数据目录里以前用「导入 CrossPet 角色」导进来的同名旧副本（上面导入过）让给自带的：旧的没法再更新了（复核）。
  const listed = skins.listSkins();
  assert.deepEqual(listed.filter((s) => s.id.startsWith('crosspet-')).map((s) => [s.id, s.source]), [
    // DeepSeek 的在最前（2026-11-22 用户：第一排全是 deepseek）
    ['crosspet-deepseek', 'bundled'], ['crosspet-deepseek-hoodie', 'bundled'], ['crosspet-claude', 'bundled'], ['crosspet-gemini', 'bundled'],
  ], '以前导入的旧副本不盖过自带的');
  assert.equal(skins.resolveSkin('crosspet-deepseek').dir, path.join(out, 'crosspet-deepseek'));
  assert.equal(skins.skinDirFor('crosspet-deepseek'), path.join(out, 'crosspet-deepseek'), '本地文件协议也从同一个文件夹出图');
  // 用户自己做的同名皮肤（不是旧导入按钮写的）照样优先。
  const own = path.join(process.env.OSU_PET_HOME, 'skins', 'crosspet-gemini', 'manifest.json');
  const ownManifest = JSON.parse(fs.readFileSync(own, 'utf8'));
  fs.writeFileSync(own, JSON.stringify({ ...ownManifest, name: '我改过的 Gemini', source: { from: 'me' } }));
  assert.deepEqual(skins.listSkins().filter((s) => s.id === 'crosspet-gemini').map((s) => [s.source, s.name]), [['user', '我改过的 Gemini']]);
  assert.equal(skins.skinDirFor('crosspet-gemini'), path.dirname(own));
  fs.writeFileSync(own, JSON.stringify(ownManifest));
  // 自带的那套坏了：旧副本不让位（还能用就用它）。
  const dsManifest = path.join(out, 'crosspet-deepseek', 'manifest.json');
  const dsSaved = fs.readFileSync(dsManifest);
  fs.writeFileSync(dsManifest, '{坏的');
  assert.equal(skins.resolveSkin('crosspet-deepseek').dir, path.join(process.env.OSU_PET_HOME, 'skins', 'crosspet-deepseek'));
  fs.writeFileSync(dsManifest, dsSaved);
  assert.equal(skins.skinDirFor('nope'), '');
  assert.equal(skins.skinDirFor('../x'), '');
  const userSkins = path.join(process.env.OSU_PET_HOME, 'skins');
  fs.renameSync(userSkins, `${userSkins}-aside`); // 后面的测试还要用，测完挪回来
  const listed2 = skins.listSkins();
  assert.deepEqual(listed2.map((s) => [s.id, s.source]), [
    ['crosspet-deepseek', 'bundled'], ['crosspet-deepseek-hoodie', 'bundled'], ['crosspet-claude', 'bundled'], ['crosspet-gemini', 'bundled'],
  ], '不用导入，自带的全在列表里；占位小人不列（用户：「太丑」）；DeepSeek 的在最前');
  // 没选过（设置里还是 placeholder）、选的那套没了：都用 DeepSeek（女仆装）。
  assert.equal(skins.defaultSkinId(), 'crosspet-deepseek');
  assert.deepEqual([skins.resolveSkin('placeholder').id, skins.resolveSkin('placeholder').fallback], ['crosspet-deepseek', null]);
  const goneSkin = skins.resolveSkin('crosspet-nope');
  assert.deepEqual([goneSkin.id, goneSkin.fallback.code], ['crosspet-deepseek', 'skin.not-found']);
  assert.ok(goneSkin.fallback.error.includes('先用「DeepSeek·女仆装」'), goneSkin.fallback.error);
  assert.deepEqual([skins.resolveSkin('crosspet-gemini').ok, skins.resolveSkin('crosspet-gemini').dir, skins.resolveSkin('crosspet-gemini').fallback], [true, path.join(out, 'crosspet-gemini'), null]);

  // --if-missing：没变的跳过；源文件变了、导入程序变了才重转；坏了（manifest 丢了）也重转。
  const kept = importer.bundleCrossPet({ artDir: path.join(CP, 'characters'), outDir: out, ifMissing: true });
  assert.deepEqual([kept.built.length, kept.kept.length], [0, 4]);
  const oops = path.join(CP, 'characters', 'gemini', 'oops.webp');
  fs.writeFileSync(oops, webp(500, 640));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(oops, later, later);
  fs.rmSync(path.join(out, 'crosspet-claude', 'manifest.json'));
  const changed = importer.bundleCrossPet({ artDir: path.join(CP, 'characters'), outDir: out, ifMissing: true });
  assert.deepEqual(changed.built.map((b) => b.id).sort(), ['crosspet-claude', 'crosspet-gemini']);
  assert.equal(changed.kept.length, 2);

  // 源里删掉的角色：自己转出来的删掉；别人放进来的文件夹（没有记号）不碰。
  fs.mkdirSync(path.join(out, 'someone-else'), { recursive: true });
  fs.renameSync(path.join(CP, 'characters', 'deepseek-hoodie'), path.join(sandbox, 'hoodie-moved'));
  const pruned = importer.bundleCrossPet({ artDir: path.join(CP, 'characters'), outDir: out, ifMissing: true });
  assert.deepEqual(pruned.removed, ['crosspet-deepseek-hoodie']);
  assert.ok(fs.existsSync(path.join(out, 'someone-else')));
  fs.renameSync(path.join(sandbox, 'hoodie-moved'), path.join(CP, 'characters', 'deepseek-hoodie'));

  // 一个角色坏了：跳过并说明，别的照常。
  const broken = makeChar('broken2', { skip: ['idle'] });
  const withBroken = importer.bundleCrossPet({ artDir: path.join(CP, 'characters'), outDir: out, ifMissing: true });
  assert.deepEqual(withBroken.skipped.map((s) => s.folder), []);
  fs.writeFileSync(path.join(broken, 'idle.webp'), 'not a webp');
  const withBroken2 = importer.bundleCrossPet({ artDir: path.join(CP, 'characters'), outDir: out, ifMissing: true });
  assert.deepEqual(withBroken2.skipped.map((s) => [s.folder, s.code]), [['broken2', 'crosspet.bad-character']]);
  assert.ok(!fs.existsSync(path.join(out, 'crosspet-broken2')));
  fs.rmSync(broken, { recursive: true, force: true });

  // 复核：换上新的那一步被拒（Windows 上文件正被占用）：旧的那套原样留着，记进 skipped，别的照常，不抛。
  {
    const gem = path.join(CP, 'characters', 'gemini', 'oops.webp');
    const t = new Date(Date.now() + 20_000);
    fs.utimesSync(gem, t, t);
    const busy = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    const fsOps = { renameSync: (from, to) => { if (String(from).includes('.tmp-') && to.endsWith('crosspet-gemini')) throw busy; return fs.renameSync(from, to); } };
    const r = importer.bundleCrossPet({ artDir: path.join(CP, 'characters'), outDir: out, ifMissing: true, fsOps });
    assert.deepEqual(r.skipped.map((s) => [s.folder, s.code]), [['gemini', 'crosspet.bundle-write']]);
    assert.ok(r.skipped[0].error.includes('EPERM') && r.skipped[0].hint.includes('旧的那套还在'));
    assert.ok(skins.validateSkin(path.join(out, 'crosspet-gemini')).ok, '旧的挪回来了，照样能用');
    assert.ok(!fs.readdirSync(out).some((n) => /\.(tmp|old)-\d+$/.test(n)), '不留临时文件夹');
    // 偶尔被拒一两次：等一下重试就过去了。
    let refusals = 2;
    const flaky = { renameSync: (from, to) => { if (String(from).includes('.tmp-') && refusals > 0) { refusals -= 1; throw busy; } return fs.renameSync(from, to); } };
    const r2 = importer.bundleCrossPet({ artDir: path.join(CP, 'characters'), outDir: out, ifMissing: true, fsOps: flaky });
    assert.deepEqual([r2.built.map((b) => b.id), r2.skipped.length], [['crosspet-gemini'], 0]);
  }

  // 复核：一个角色都没找到（art 没放 / 解压多套了一层）：已经转好的一个都不删。
  {
    const nested = path.join(sandbox, 'art-nested');
    fs.mkdirSync(path.join(nested, 'crosspet-main'), { recursive: true });
    const before = fs.readdirSync(out).sort();
    for (const artDir of [nested, path.join(sandbox, 'no-art-at-all')]) {
      const r = importer.bundleCrossPet({ artDir, outDir: out, ifMissing: true });
      assert.deepEqual([r.artFound, r.removed], [false, []]);
      assert.deepEqual(fs.readdirSync(out).sort(), before);
    }
  }
  fs.renameSync(`${userSkins}-aside`, userSkins);

  // 桌面角色窗口和 OBS 都能从自带的那套读图（本地文件协议的皮肤根目录里有它）。
  const mainJs = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');
  assert.ok(mainJs.includes('const dir = skins.skinDirFor(id);') && mainJs.includes('resolveLocalUrl(request.url, { appRoot: ROOT, skinDir })'), '本地文件协议按 skinDirFor 出图');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.start.includes('bundle-crosspet.mjs --if-missing') && pkg.scripts.build.includes('bundle-crosspet.mjs'), 'npm start / npm run build 时转');
  assert.ok(!pkg.scripts['import-crosspet']);
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.ok(/^\/art\/$/m.test(gitignore) && /^\/skins-bundled\/$/m.test(gitignore), '立绘和转出来的皮肤都不进仓库');
  const settingsHtml = fs.readFileSync(path.join(ROOT, 'app', 'settings', 'index.html'), 'utf8');
  assert.ok(!settingsHtml.includes('skin.importCrossPet'), '设置里没有「导入 CrossPet 角色」按钮了');
}

// ── 皮肤校验（rig: sprite）────────────────────────────────────────────────────
{
  const make = (name, manifest, files = []) => {
    const dir = path.join(sandbox, 'sprite-skins', name);
    fs.mkdirSync(path.join(dir, 'art'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
    return dir;
  };
  const base = { rig: 'sprite', canvas: { w: 10, h: 10 }, hitbox: { x: 0, y: 0, w: 10, h: 10 } };
  expectFail(skins.validateSkin(make('noposes', base)), 'skin.bad-manifest');
  expectFail(skins.validateSkin(make('noidle', { ...base, sprite: { poses: { happy: 'art/a.webp' } } }, ['art/a.webp'])), 'skin.bad-manifest');
  expectFail(skins.validateSkin(make('badlist', { ...base, sprite: { poses: { idle: [1, 2] } } })), 'skin.bad-manifest');
  expectFail(skins.validateSkin(make('missing', { ...base, sprite: { poses: { idle: 'art/idle.webp' } } })), 'skin.missing-file');
  expectFail(skins.validateSkin(make('escape', { ...base, sprite: { poses: { idle: '../../x.webp' } } })), 'skin.bad-path');
  expectFail(skins.validateSkin(make('blinkmissing', { ...base, sprite: { poses: { idle: 'art/idle.webp' }, blink: { file: 'art/b.webp' } } }, ['art/idle.webp'])), 'skin.missing-file');
  const warned = skins.validateSkin(make('warn', { ...base, sprite: { poses: { idle: 'art/idle.webp' }, reactions: { combo: { pose: 'happy' } } } }, ['art/idle.webp']));
  assert.ok(warned.ok && warned.warnings[0].includes('happy'), '反应表指向没有的姿势：能用，但提醒');
}

// ── OBS 那一头 ───────────────────────────────────────────────────────────────
{
  const tosuDir = path.join(sandbox, 'tosu');
  fs.mkdirSync(tosuDir, { recursive: true });
  const rendererFile = path.join(sandbox, 'renderer.js');
  fs.writeFileSync(rendererFile, 'R');
  const skinDir = skins.resolveSkin('crosspet-deepseek').dir; // 正在用的那一份（自带的盖过以前导入的旧副本）
  let clock = 1_800_000_000_000;
  const counter = createTosuCounter({ config: () => ({ enabled: true, tosuDir, skinId: 'crosspet-deepseek', tosuUrl: 'ws://127.0.0.1:24050/websocket/v2' }), resolveSkin: skins.resolveSkin, rendererFile, findTosu: async () => '', now: () => clock });
  assert.equal(counter.react({ moment: 'combo', playing: true }), false, '没装好时什么都不做');
  assert.equal((await counter.sync()).ok, true);
  const statePath = path.join(tosuDir, 'static', 'fatfish-osu', 'state.json');
  const st = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(fs.existsSync(path.join(tosuDir, 'static', 'fatfish-osu', 'skin', 'art', 'oops.webp')), '姿势图跟着装进 tosu');
  assert.equal(counter.react({ moment: 'start', playing: true }), true);
  assert.deepEqual([st().reactSeq, st().react, st().playing, st().playingAt], [1, 'start', true, clock]);
  clock += 30_000;
  counter.react({ moment: null, playing: true });
  assert.deepEqual([st().reactSeq, st().react, st().playingAt], [1, 'start', clock], '心跳：只更新时间，不算新的时刻');
  // 休息段是一个状态（resting）：页面漏看了时刻、或者重载后也能接着喝水。
  counter.react({ moment: 'break', playing: true });
  assert.equal(st().resting, true);
  counter.react({ moment: 'combo', playing: true });
  assert.equal(st().resting, true, '休息段里来了别的时刻：还在休息');
  counter.react({ moment: null, playing: true });
  assert.equal(st().resting, true, '心跳不改休息状态');
  counter.react({ moment: 'break-end', playing: true });
  assert.equal(st().resting, false);
  counter.react({ moment: 'break', playing: true });
  counter.react({ moment: 'retry', playing: true });
  assert.equal(st().resting, false, '重开：不在休息');
  counter.react({ moment: 'break', playing: true });
  counter.react({ moment: 'fc', playing: false });
  assert.deepEqual([st().reactSeq, st().react, st().playing, st().resting], [8, 'fc', false, false], '不打了：也不在休息');
  counter.say({ text: 'X', durationMs: 1000 });
  assert.deepEqual([st().seq, st().reactSeq], [1, 8], '说话和换姿势各记各的');
  // 只换了图、清单没变：指纹也变（2026-11-20 复核发现原来只看 manifest.json）。
  const before = skinFingerprint(skinDir);
  fs.writeFileSync(path.join(skinDir, 'art', 'oops.webp'), Buffer.concat([fs.readFileSync(path.join(skinDir, 'art', 'oops.webp')), Buffer.from('more')]));
  assert.notEqual(skinFingerprint(skinDir), before);
  const rev = st().rev;
  await counter.sync();
  assert.equal(st().rev, rev + 1, '换了图：重拷并让网页重载');
  // 页面脚本：读 reactSeq / playing / playingAt，换成渲染器的命令；时刻名只认小写字母和连字符。
  const page = fs.readFileSync(path.join(ROOT, 'counter', 'pet', 'counter.js'), 'utf8');
  for (const wanted of ['reactSeq', "'react:' + s.react", 'play-on', 'play-off', 'PLAY_TTL_MS = 90000', '/^[a-z-]{1,40}$/', 's.resting === true', "'react:break-end'"]) assert.ok(page.includes(wanted), `counter.js 缺 ${wanted}`);
  // 页面脚本按真实的样子跑一遍（假的 window / fetch）：刚打开不重放上一个时刻；在打图、在休息照着现在的来；TTL 过了放下。
  {
    const commands = [];
    let state = { seq: 5, rev: 1, reactSeq: 7, react: 'combo', playing: true, playingAt: Date.now(), resting: true };
    const timers = [];
    const sandboxWin = { __counterPet: { command: (c) => commands.push(c) }, addEventListener() {}, innerWidth: 600, innerHeight: 700 };
    const fakeDoc = { getElementById: () => ({ style: { setProperty() {} }, classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({ width: 10, height: 10 }) }) };
    const run = new Function('window', 'document', 'fetch', 'WebSocket', 'location', 'setInterval', 'setTimeout', 'clearTimeout', page);
    const fakeFetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(state) });
    run(sandboxWin, fakeDoc, fakeFetch, function () { throw new Error('no ws'); }, { host: 'x', pathname: '/fatfish-osu/', reload() {} }, (fn) => timers.push(fn), () => 0, () => {});
    const poll = async () => { timers[0](); await new Promise((r) => setTimeout(r, 5)); };
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(commands, ['play-on', 'react:break'], '刚打开：照着现在的打图 / 休息状态，不重放上一个时刻');
    state = { ...state, reactSeq: 8, react: 'combo-break', playingAt: Date.now() };
    await poll();
    assert.deepEqual(commands.slice(2), ['react:combo-break']);
    state = { ...state, reactSeq: 9, react: 'evil<script>', resting: false };
    await poll();
    assert.deepEqual(commands.slice(3), ['react:break-end'], '不合格的时刻名不转发；休息结束照着状态放下杯子');
    state = { ...state, playingAt: Date.now() - 91_000 };
    await poll();
    assert.deepEqual(commands.slice(4), ['play-off'], '90 秒没心跳：放下「打图中」');
  }
}

// ── 渲染层产物 ───────────────────────────────────────────────────────────────
{
  const { OUTPUTS, buildRenderer } = await import('../scripts/build-renderer.mjs');
  await buildRenderer({ ifMissing: true, log: () => {} });
  for (const file of Object.values(OUTPUTS)) {
    const code = fs.readFileSync(file, 'utf8');
    for (const wanted of ['sp-motion', 'react:', 'play-on', 'sp-blink']) assert.ok(code.includes(wanted), `${path.basename(file)} 里要有姿势渲染器（${wanted}）`);
  }
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('sprite: ok');
