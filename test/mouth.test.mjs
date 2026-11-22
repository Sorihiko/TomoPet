/**
 * 说话时动嘴（2026-11-21）：口型轨（core/speakable.js）、导演的 mouth（renderer/sprite-director.js）、
 * 打包皮肤时带上口型（core/crosspet-import.js）、皮肤校验（core/skins.js）、OBS 页面把口型轨交给角色（counter/pet/counter.js）。
 * 不碰真的 art/：在临时目录里造假的 CrossPet 角色和假的口型。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-pet-mouth-'));
process.env.OSU_PET_HOME = path.join(sandbox, '数据');
process.env.OSU_PET_BUNDLED_DIR = path.join(sandbox, 'skins-bundled');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MOUTH_STEP_MS, mouthTrackFromWav, mouthTrackFromText, cleanMouthTrack, pcmToWav } = await import('../core/speakable.js');
const { createSpriteDirector } = await import('../renderer/sprite-director.js');
const importer = await import('../core/crosspet-import.js');
const skins = await import('../core/skins.js');
const expectFail = (result, code) => { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.code, code); assert.ok(result.error && result.hint, `${code} 要带 error 和 hint`); };

// ── 口型轨 ───────────────────────────────────────────────────────────────────
{
  assert.equal(MOUTH_STEP_MS, 60);
  // 24 kHz、16 位单声道：静音 0.3 秒 → 大声 0.3 秒 → 小声 0.3 秒 → 静音 0.3 秒。
  const rate = 24000;
  const seg = (amp, ms) => {
    const n = Math.round((rate * ms) / 1000);
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) b.writeInt16LE(Math.round(amp * Math.sin(i / 3)), i * 2);
    return b;
  };
  const wav = pcmToWav(Buffer.concat([seg(0, 300), seg(12000, 300), seg(3500, 300), seg(0, 300)]), rate);
  const track = mouthTrackFromWav(wav);
  assert.match(track, /^[012]+$/);
  assert.equal(track.length, 20, '1.2 秒 / 60 毫秒 = 20 档');
  assert.equal(track.slice(0, 5), '00000', '静音闭嘴');
  assert.equal(track.slice(5, 10), '22222', '大声张大');
  assert.equal(track.slice(10, 15), '11111', '小声半张');
  assert.equal(track.slice(15), '00000');
  // 只有一档的突变抹平：2 2 1 2 2 → 2 2 2 2 2
  const blip = mouthTrackFromWav(pcmToWav(Buffer.concat([seg(12000, 120), seg(3500, 60), seg(12000, 120)]), rate));
  assert.equal(blip, '22222');
  assert.equal(mouthTrackFromWav(pcmToWav(seg(50, 600), rate)), '0000000000', '几乎没声就一直闭着');
  assert.equal(mouthTrackFromWav(Buffer.from('not a wav file at all, nope nope nope nope nope')), '');
  assert.equal(mouthTrackFromWav(null), '');

  // 没有声音：按字假装说，总长对上时长，标点那里闭嘴。
  const t = mouthTrackFromText('这把稳了，全连！', 2400);
  assert.equal(t.length, 40);
  assert.match(t, /^[012]+$/);
  assert.ok(t.includes('2') && t.includes('0'));
  const per = 40 / 8;
  assert.equal(t.slice(Math.round(4 * per), Math.round(5 * per)), '0'.repeat(Math.round(5 * per) - Math.round(4 * per)), '逗号那一段闭嘴');
  assert.equal(mouthTrackFromText('……', 600), '0000000000');
  assert.equal(mouthTrackFromText('', 0), '0');
  assert.equal(cleanMouthTrack('01x2<script>9'), '012');
  assert.equal(cleanMouthTrack('1'.repeat(5000)).length, 2000);
  assert.equal(cleanMouthTrack(undefined), '');
}

// ── 导演：有口型时说话摆主图、换嘴 ─────────────────────────────────────────────
const SPEC = {
  poses: { idle: ['art/idle.webp', 'art/idle-2.webp'], listening: ['art/listening.webp'], happy: ['art/happy.webp'] },
  blink: { base: 'idle', file: 'art/idle-blink.webp' },
  mouth: { base: 'idle', levels: { closed: 'art/mouth-closed.webp', half: 'art/mouth-half.webp', wide: 'art/mouth-wide.webp' } },
  reactions: { combo: { pose: 'happy', motion: 'jump', holdMs: 4000, priority: 1 } },
};
{
  let t = 1_000_000;
  const d = createSpriteDirector(SPEC, { now: t, random: () => 0.9 });
  assert.equal(d.current(t).mouth, false, '没说话不换嘴');
  assert.deepEqual(d.mouthLevels(), SPEC.mouth.levels);
  for (const f of Object.values(SPEC.mouth.levels)) assert.ok(d.files().includes(f), `预载 ${f}`);
  // 待机轮到第二张图时开口：嘴只对得上主图，换回主图。
  t += 9500;
  assert.equal(d.current(t).file, 'art/idle-2.webp');
  d.command('talk-start', t);
  let cur = d.current(t);
  assert.deepEqual([cur.pose, cur.file, cur.motion, cur.talking, cur.mouth], ['idle', 'art/idle.webp', 'bob', true, true]);
  assert.equal(cur.blinkable, true, '说话时也能眨眼（嘴叠在眨眼图上面）');
  t += 20_000;
  assert.equal(d.current(t).file, 'art/idle.webp', '说话途中不轮换待机图');
  // 说话途中来了游戏时刻：摆反应的姿势，不换嘴。
  d.command('react:combo', t);
  cur = d.current(t);
  assert.deepEqual([cur.pose, cur.mouth, cur.talking], ['happy', false, true]);
  t += 4100;
  d.command('talk-stop', t);
  t += 2000;
  assert.equal(d.current(t).mouth, false);

  // 没有口型（或者只有闭嘴图）：照旧摆「说话」姿势。
  for (const mouth of [undefined, { base: 'idle', levels: { closed: 'art/mouth-closed.webp' } }, { base: 'nope', levels: { half: 'a.webp' } }, 'bad']) {
    const plain = createSpriteDirector({ ...SPEC, mouth }, { now: 0 });
    plain.command('talk-start', 0);
    const c = plain.current(0);
    assert.deepEqual([c.pose, c.motion, c.mouth], ['listening', 'quick', false], JSON.stringify(mouth));
    assert.deepEqual(plain.mouthLevels(), {});
  }

  // 菜单「说句话」2.6 秒内点两次：照第一次的计时收嘴，不会一直说下去（复核发现）。
  const twice = createSpriteDirector(SPEC, { now: 0 });
  twice.command('talk', 1000);
  twice.command('talk', 2000);
  assert.equal(twice.current(3500).talking, true);
  assert.equal(twice.current(3700).talking, false, '1000 + 2600 之后收嘴');
  // 正说着一句真话时点「说句话」：不安排收嘴（等那句话的 talk-stop）。
  const real = createSpriteDirector(SPEC, { now: 0 });
  real.command('talk-start', 0);
  real.command('talk', 500);
  assert.equal(real.current(10_000).talking, true);
}

// ── 打包：art/mouths/<皮肤 id>/ 里的口型拷进皮肤 ─────────────────────────────
function webp(w, h, tag = '') {
  const b = Buffer.alloc(30 + tag.length);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(22 + tag.length, 4); b.write('WEBP', 8, 'ascii'); b.write('VP8X', 12, 'ascii'); b.writeUInt32LE(10, 16);
  b[20] = 0x10; b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  b.write(tag, 30, 'ascii');
  return b;
}
const ART = path.join(sandbox, 'art');
const CHARS = path.join(ART, 'crosspet', 'characters');
const MOUTHS = path.join(ART, 'mouths');
const POSES = ['idle', 'idle-blink', 'listening', 'running', 'happy', 'oops', 'dizzy', 'surprised', 'annoyed', 'drink', 'puffed', 'sulk', 'tired', 'redhot', 'proud', 'pat', 'coaxed', 'forgiven', 'yawn', 'sleeping', 'bye'];
function makeChar(id) {
  const dir = path.join(CHARS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'character.json'), JSON.stringify({ name: id.toUpperCase() }));
  for (const p of POSES) fs.writeFileSync(path.join(dir, `${p}.webp`), webp(p === 'idle' ? 600 : 520, 640, p));
  return dir;
}
function makeMouth(id, { idleSha, size = [600, 640], files = { half: 'mouth-half.webp', wide: 'mouth-wide.webp' }, mode = 'aligned' } = {}) {
  const dir = path.join(MOUTHS, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.values(files)) fs.writeFileSync(path.join(dir, name), webp(size[0], size[1], name));
  const source = mode === 'aligned'
    ? { repo: 'hunmer/aboutme-pets', commit: 'df864c0c7db75857854740b301f6677e50d0b29c', mode, pack: 'claude', action: '碎碎念-对屏碎碎念' }
    : { repo: 'hunmer/aboutme-pets', commit: 'df864c0c7db75857854740b301f6677e50d0b29c', mode, donor: 'crosspet-claude', pack: 'claude', action: '碎碎念-对屏碎碎念' };
  fs.writeFileSync(path.join(dir, 'mouth.json'), JSON.stringify({ base: 'idle', idle: 'idle.webp', idleSha, size, files, source }));
}
{
  const claude = makeChar('claude');
  const deepseek = makeChar('deepseek');
  makeChar('gemini');
  const sha = (dir) => importer.blobSha(fs.readFileSync(path.join(dir, 'idle.webp')));
  makeMouth('crosspet-claude', { idleSha: sha(claude), files: { half: 'mouth-half.webp', wide: 'mouth-wide.webp' } });
  makeMouth('crosspet-deepseek', { idleSha: sha(deepseek), files: { closed: 'mouth-closed.webp', half: 'mouth-half.webp', wide: 'mouth-wide.webp' }, mode: 'transplant' });
  makeMouth('crosspet-gemini', { idleSha: 'f'.repeat(40) }); // 立绘换过了：sha 对不上

  const out = path.join(sandbox, 'out');
  // artDir 旁边的 mouths/ 自动找到（art/crosspet → art/mouths）
  const r = importer.bundleCrossPet({ artDir: CHARS, mouthsDir: MOUTHS, outDir: out });
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = Object.fromEntries(r.built.map((b) => [b.id, b]));
  assert.equal(by['crosspet-claude'].mouth, true);
  assert.equal(by['crosspet-deepseek'].mouth, true);
  assert.equal(by['crosspet-gemini'].mouth, false);
  assert.match(by['crosspet-gemini'].mouthSkipped, /另一张 idle/);

  const man = JSON.parse(fs.readFileSync(path.join(out, 'crosspet-deepseek', 'manifest.json'), 'utf8'));
  assert.deepEqual(man.sprite.mouth, { base: 'idle', levels: { closed: 'art/mouth-closed.webp', half: 'art/mouth-half.webp', wide: 'art/mouth-wide.webp' } });
  assert.match(man.author, /hunmer\/aboutme-pets.*CC BY-NC-SA 4\.0/);
  for (const f of Object.values(man.sprite.mouth.levels)) assert.ok(fs.existsSync(path.join(out, 'crosspet-deepseek', f)), f);
  const credits = fs.readFileSync(path.join(out, 'crosspet-deepseek', 'CREDITS.md'), 'utf8');
  for (const want of ['张嘴口型', 'https://github.com/hunmer/aboutme-pets', 'CC BY-NC-SA 4.0', '移植', '改动', 'df864c0c7db7']) assert.ok(credits.includes(want), `CREDITS.md 里要有「${want}」`);
  const claudeCredits = fs.readFileSync(path.join(out, 'crosspet-claude', 'CREDITS.md'), 'utf8');
  assert.ok(claudeCredits.includes('取自 `pets/claude` 的「碎碎念-对屏碎碎念」'), claudeCredits);
  const gem = JSON.parse(fs.readFileSync(path.join(out, 'crosspet-gemini', 'manifest.json'), 'utf8'));
  assert.equal(gem.sprite.mouth, undefined, 'sha 对不上的不带口型');
  assert.ok(!fs.readFileSync(path.join(out, 'crosspet-gemini', 'CREDITS.md'), 'utf8').includes('hunmer'), '没带口型就不写 hunmer 的署名');
  assert.equal(skins.validateSkin(path.join(out, 'crosspet-deepseek')).ok, true);

  // 口型改了要重新打包（指纹带上口型文件）；没改就跳过。
  const kept = importer.bundleCrossPet({ artDir: CHARS, mouthsDir: MOUTHS, outDir: out, ifMissing: true });
  assert.deepEqual(kept.kept.sort(), ['crosspet-claude', 'crosspet-deepseek', 'crosspet-gemini']);
  makeMouth('crosspet-gemini', { idleSha: sha(path.join(CHARS, 'gemini')) });
  const redo = importer.bundleCrossPet({ artDir: CHARS, mouthsDir: MOUTHS, outDir: out, ifMissing: true });
  assert.deepEqual(redo.built.map((b) => b.id), ['crosspet-gemini']);
  assert.equal(redo.built[0].mouth, true);

  // 口型图和立绘不一样大：不带（嘴会贴歪）。
  makeMouth('crosspet-claude', { idleSha: sha(claude), size: [300, 320] });
  const bad = importer.bundleCrossPet({ artDir: CHARS, mouthsDir: MOUTHS, outDir: out, ifMissing: true });
  assert.match(bad.built.find((b) => b.id === 'crosspet-claude').mouthSkipped, /不一样大/);
  // 只有一张不对（wide 不一样大）：一张都不带，皮肤里不留没署名的嘴图（复核发现）。
  makeMouth('crosspet-claude', { idleSha: sha(claude), files: { closed: 'mouth-closed.webp', half: 'mouth-half.webp', wide: 'mouth-wide.webp' } });
  fs.writeFileSync(path.join(MOUTHS, 'crosspet-claude', 'mouth-wide.webp'), webp(300, 320, 'wide'));
  const partial = importer.bundleCrossPet({ artDir: CHARS, mouthsDir: MOUTHS, outDir: out, ifMissing: true });
  assert.match(partial.built.find((b) => b.id === 'crosspet-claude').mouthSkipped, /mouth-wide\.webp 和 idle\.webp 不一样大/);
  assert.deepEqual(fs.readdirSync(path.join(out, 'crosspet-claude', 'art')).filter((n) => n.startsWith('mouth-')), []);
  // 闭嘴那张来自供体的 CrossPet 立绘：CREDITS 写明出处（复核发现）。
  makeMouth('crosspet-deepseek', { idleSha: sha(deepseek), files: { closed: 'mouth-closed.webp', half: 'mouth-half.webp', wide: 'mouth-wide.webp' }, mode: 'transplant' });
  const metaPath = path.join(MOUTHS, 'crosspet-deepseek', 'mouth.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.source.closedFromCrossPet = 'claude/idle.webp';
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  importer.bundleCrossPet({ artDir: CHARS, mouthsDir: MOUTHS, outDir: out, ifMissing: true });
  const dsCredits = fs.readFileSync(path.join(out, 'crosspet-deepseek', 'CREDITS.md'), 'utf8');
  assert.ok(dsCredits.includes('闭嘴那一张不是 hunmer 的：取自 CrossPet `characters/claude/idle.webp`'), dsCredits);
  assert.ok(dsCredits.includes('立绘原样拷贝，没有修改（说话时叠在上面的口型图是另做的'), '开头不能再说全部原样拷贝');

  // 默认的口型文件夹在 art 旁边。
  const auto = importer.bundleCrossPet({ artDir: CHARS, outDir: path.join(sandbox, 'out2') });
  assert.equal(auto.built.find((b) => b.id === 'crosspet-deepseek').mouth, false, 'characters 旁边没有 mouths/（它在 art/ 下）');
  const auto2 = importer.bundleCrossPet({ artDir: path.join(ART, 'crosspet'), outDir: path.join(sandbox, 'out3') });
  assert.equal(auto2.built.find((b) => b.id === 'crosspet-deepseek').mouth, true, 'art/crosspet 旁边的 art/mouths');
}

// ── 皮肤校验 ─────────────────────────────────────────────────────────────────
{
  const dir = path.join(sandbox, 'out', 'crosspet-deepseek');
  const manifestPath = path.join(dir, 'manifest.json');
  const good = fs.readFileSync(manifestPath, 'utf8');
  const withMouth = (mouth) => { const m = JSON.parse(good); m.sprite.mouth = mouth; fs.writeFileSync(manifestPath, JSON.stringify(m)); return skins.validateSkin(dir); };
  expectFail(withMouth({ base: 'idle', levels: { closed: 'art/mouth-closed.webp' } }), 'skin.bad-manifest');
  expectFail(withMouth({ base: 'idle', levels: { half: 3 } }), 'skin.bad-manifest');
  expectFail(withMouth('art/mouth.webp'), 'skin.bad-manifest');
  expectFail(withMouth({ base: 'nope', levels: { half: 'art/mouth-half.webp' } }), 'skin.bad-manifest');
  expectFail(withMouth({ base: 'idle', levels: { half: 'art/nope.webp' } }), 'skin.missing-file');
  expectFail(withMouth({ base: 'idle', levels: { half: '../../evil.webp' } }), 'skin.bad-path');
  assert.equal(withMouth({ base: 'idle', levels: { wide: 'art/mouth-wide.webp' } }).ok, true, '只有一张张嘴图也行');
  fs.writeFileSync(manifestPath, good);
}

// ── OBS 页面：口型轨交给角色，读晚了的那几档跳过 ───────────────────────────────
{
  const page = fs.readFileSync(path.join(ROOT, 'counter', 'pet', 'counter.js'), 'utf8');
  const calls = [];
  const el = () => ({ classList: { add() {}, remove() {} }, style: {}, textContent: '', set innerHTML(v) {}, appendChild() {} });
  const fakeDoc = { getElementById: () => el(), createElement: () => el(), body: el(), querySelector: () => el() };
  const win = { __counterPet: { command: (c) => calls.push(['cmd', c]), mouth: (t) => calls.push(['mouth', t]) }, addEventListener() {}, innerWidth: 600, innerHeight: 700 };
  const timers = [];
  let state = { seq: 1, rev: 1, text: '', durationMs: 0 };
  const run = new Function('window', 'document', 'fetch', 'WebSocket', 'location', 'setInterval', 'setTimeout', 'clearTimeout', page);
  run(win, fakeDoc, () => Promise.resolve({ ok: true, json: () => Promise.resolve(state) }), function () { throw new Error('no ws'); }, { host: 'x', pathname: '/x/', reload() {} }, (fn) => timers.push(fn), () => 0, () => {});
  await new Promise((r) => setTimeout(r, 5));
  state = { ...state, seq: 2, text: '全连！', durationMs: 1200, mouth: '0123'.replace('3', '2') + '1'.repeat(16), at: Date.now() - 150 };
  timers[0]();
  await new Promise((r) => setTimeout(r, 5));
  const mouthCall = calls.find((c) => c[0] === 'mouth');
  assert.ok(mouthCall, JSON.stringify(calls));
  assert.equal(mouthCall[1], ('0122' + '1'.repeat(16)).slice(2), '晚了约 150 毫秒：跳过前两档');
  const order = calls.map((c) => c[0] === 'cmd' ? c[1] : 'mouth');
  assert.ok(order.indexOf('mouth') < order.indexOf('talk-start'), '先给口型轨再开口');
  // 很短的一句、读晚了整条都跳过：给 '0'（已经说完，闭嘴），不给空串（空串会让角色假装说）。复核发现。
  calls.length = 0;
  state = { ...state, seq: 3, text: '嗯', durationMs: 300, mouth: '1221', at: Date.now() - 500 };
  timers[0]();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls.find((c) => c[0] === 'mouth'), ['mouth', '0']);
  // 老版本的 TomoPet 写的 state.json 没有口型轨：不调 mouth()，角色按固定节奏假装说。
  calls.length = 0;
  state = { seq: 4, rev: 1, text: '老版本', durationMs: 900 };
  timers[0]();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls.map((c) => c[0]), ['cmd'], JSON.stringify(calls));
}

// ── 渲染层产物里有嘴 ─────────────────────────────────────────────────────────
{
  const { OUTPUTS, buildRenderer } = await import('../scripts/build-renderer.mjs');
  await buildRenderer({ ifMissing: false, log: () => {} });
  for (const file of Object.values(OUTPUTS)) {
    const code = fs.readFileSync(file, 'utf8');
    for (const wanted of ['sp-mouth', 'setMouthTrack']) assert.ok(code.includes(wanted), `${path.basename(file)} 里要有 ${wanted}`);
  }
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('mouth: ok');
