/**
 * 送去语音合成之前，把数字换成念得出来的写法；以及从 wav 头算时长。
 * 照搬 SurfCore src/voice-tts.js 的 speakableText() / wavDurationMs()。
 *
 * 为什么（2026-11-19，用户：「4.8 星她读成 48 星，这种问题出现好几次了」）：
 * 合成那一侧可能把英文的 `.`、`%`、`:` 当成杂质删掉，于是 4.8 → 48、97.42% → 9742、17:38 → 1738。
 * 字幕里的文字不受影响，只改送去合成的那一份。
 *
 *   97.42%  → 百分之97点四二    （先处理百分号，再处理小数点）
 *   17:38   → 17点38            （只认像时间的「时:分」）
 *   4.8     → 4点八             （小数部分逐位写成汉字：给数字的话「3点14159」可能被念成「三点一万四千……」）
 *   6个     → 六个              （数字紧跟「个」写成汉字；2个 → 两个）
 *   998 combo → 九百九十八 combo（连击数同理，「998 连」也是；免得被念成「九九八」）
 *
 * 「个」那条（2026-11-20，用户：「6个miss就溜」她读成了「6，miss就溜」）：
 * 送去合成的原文就是「6个miss就溜」，是合成那一侧把「数字 + 个 + 英文」里的「个」吞了、还停了一下。
 * 写成「六个」就没有可吞的了；汉字数字在中文里本来就是「个」前面的正常写法。
 *
 * 多音字「还」原来会换成同音字（先「孩」、后「骸」，给火山把 hái 念成 huán 打的补丁），
 * 2026-11-22 用户：「还就用还吧，别搞什么骸了」——不换了，原样送去合成。
 */
const DIGIT_WORDS = '零一二三四五六七八九';

/** 0–99999999 的整数 → 汉字（十一、一百零五、一千零五十、两万……的「二」写法见下）。超出范围返回 null。 */
export function chineseNumber(n) {
  if (!Number.isInteger(n) || n < 0 || n > 99_999_999) return null;
  if (n === 0) return '零';
  const below10k = (x) => {
    const units = ['千', '百', '十', ''];
    const digits = String(x).padStart(4, '0').split('').map(Number);
    let out = '';
    let zero = false;
    digits.forEach((d, i) => {
      if (d === 0) { zero = out !== ''; return; }
      if (zero) { out += '零'; zero = false; }
      out += DIGIT_WORDS[d] + units[i];
    });
    return out;
  };
  const high = Math.floor(n / 10_000);
  const low = n % 10_000;
  let out = high ? `${below10k(high)}万` : '';
  if (low) out += (high && low < 1000 ? '零' : '') + below10k(low);
  // 十几：「一十二」→「十二」（只在最前面）
  return out.replace(/^一十/, '十');
}

export function speakableText(text) {
  return String(text ?? '')
    .replace(/(\d+(?:[.．]\d+)?)\s*[%％]/g, '百分之$1')
    .replace(/(?<!\d)([01]?\d|2[0-3])[:：]([0-5]\d)(?!\d)/g, '$1点$2')
    .replace(/\d+(?:[.．]\d+)+/g, (match) => {
      const [whole, ...rest] = match.split(/[.．]/);
      return [whole, ...rest.map((part) => part.replace(/\d/g, (d) => DIGIT_WORDS[Number(d)]))].join('点');
    })
    // 数字紧跟「个」（中间可以有空格）：写成汉字。2 个 → 两个（「二个」不是这么说的）。
    .replace(/(?<![\d.．])(\d{1,8})\s*个/g, (match, digits) => {
      const n = Number(digits);
      const words = n === 2 ? '两' : chineseNumber(n);
      return words ? `${words}个` : match;
    })
    // 连击数（998 combo / 998 连）：写成汉字，免得被念成「九九八」（2026-11-20 用户：「应该是 998 combo 断了，不是九九八断了」）。
    .replace(/(?<![\d.．])(\d{1,8})(\s*)(combo|连)/gi, (match, digits, space, unit) => {
      const words = chineseNumber(Number(digits));
      return words ? `${words}${space}${unit}` : match;
    });
}

/** 从 wav 头算时长（毫秒）。坏文件返回 0，不抛。 */
export function wavDurationMs(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return 0;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 20 <= buf.length) byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') {
      if (!byteRate || !size) return 0;
      return Math.round((size / byteRate) * 1000);
    }
    off += 8 + size + (size % 2);
  }
  return 0;
}

/** 16 位单声道 PCM → 完整的 wav 文件。 */
export function pcmToWav(pcm, sampleRate = 24000) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ── 口型轨（2026-11-21 说话时动嘴）──────────────────────────────────────────────
// 一句话的嘴怎么动：每 MOUTH_STEP_MS 一档，'0' 闭、'1' 半张、'2' 张大，拼成一个字符串（一分钟的话也就 1000 个字符）。
// 桌面角色和 OBS 页面拿到它，从开口那一刻起按时间一档一档换嘴（渲染器里没有声音可听：声音是字幕窗口放的）。
export const MOUTH_STEP_MS = 60;

/** 读 wav 的格式和数据段：只认 16 位 PCM（火山合成出来的就是这种）。读不了返回 null。 */
function readWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 24 <= buf.length) {
      fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    }
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || !fmt.channels || !fmt.rate) return null;
      return { ...fmt, data: buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)) };
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/**
 * 从合成出来的声音算口型：每一小段的响度（RMS）和这句话里响的那几段比，轻的闭嘴、中等半张、响的张大。
 * 只有一两段的突变（一档夹在两个别的中间）抹平，免得嘴抽动。读不了的声音返回 ''（渲染器退回按字数假装说话）。
 */
export function mouthTrackFromWav(buf, stepMs = MOUTH_STEP_MS) {
  const wav = readWav(buf);
  if (!wav) return '';
  const frameBytes = 2 * wav.channels;
  const frames = Math.floor(wav.data.length / frameBytes);
  const per = Math.max(1, Math.round((wav.rate * stepMs) / 1000));
  const rms = [];
  for (let start = 0; start < frames; start += per) {
    const end = Math.min(frames, start + per);
    let sum = 0;
    for (let i = start; i < end; i += 1) {
      const v = wav.data.readInt16LE(i * frameBytes); // 第一个声道就够了
      sum += v * v;
    }
    rms.push(Math.sqrt(sum / Math.max(1, end - start)));
  }
  if (!rms.length) return '';
  // 「响」以这句话里第 90 百分位为准（不用最大值：一个爆音会让别的段全被当成轻声）。
  const loud = [...rms].sort((a, b) => a - b)[Math.min(rms.length - 1, Math.floor(rms.length * 0.9))];
  if (loud < 200) return '0'.repeat(rms.length); // 整句几乎没声
  const levels = rms.map((v) => (v < loud * 0.16 ? 0 : v < loud * 0.5 ? 1 : 2));
  for (let i = 1; i < levels.length - 1; i += 1) {
    if (levels[i - 1] === levels[i + 1] && levels[i] !== levels[i - 1] && Math.abs(levels[i] - levels[i - 1]) === 1) levels[i] = levels[i - 1];
  }
  return levels.join('');
}

/**
 * 没有声音时（没开语音、合成失败）按字假装说话：每个字张一下嘴再合上，标点停顿。总长对上 durationMs。
 * 拼音、数字、英文按字符算；空白和标点是停顿。
 */
export function mouthTrackFromText(text, durationMs, stepMs = MOUTH_STEP_MS) {
  const steps = Math.max(1, Math.round((Number(durationMs) || 0) / stepMs));
  const chars = Array.from(String(text || ''));
  const units = chars.map((c) => (/[\s，。！？、,.!?…~～；;：:“”"'‘’（）()《》—-]/.test(c) ? 'pause' : 'say'));
  if (!units.includes('say')) return '0'.repeat(steps);
  const out = [];
  const per = steps / units.length;
  units.forEach((u, i) => {
    const from = Math.round(i * per);
    const to = Math.round((i + 1) * per);
    for (let k = from; k < to; k += 1) {
      if (u === 'pause') { out.push(0); continue; }
      const t = (k - from) / Math.max(1, to - from); // 一个字里：张开 → 合上
      out.push(t < 0.2 ? 1 : t < 0.65 ? (i % 3 === 1 ? 1 : 2) : t < 0.85 ? 1 : 0);
    }
  });
  return out.join('').slice(0, steps).padEnd(steps, '0');
}

/** 口型轨只留 0/1/2，最长 2000 档（两分钟）：从别处传来的东西先过一遍再发给网页。 */
export function cleanMouthTrack(track) {
  return String(track || '').replace(/[^012]/g, '').slice(0, 2000);
}
