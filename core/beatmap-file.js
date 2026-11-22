/**
 * 读当前谱面的 .osu（难段预告 core/heads-up.js 和「这是张什么图」core/map-info.js 共用）。
 *
 * 先按 tosu 给的路径（Songs 文件夹 + 相对路径）读本地文件，读不到再问 tosu 要（/files/beatmap/file）；
 * 有 checksum 就核对（换图途中读到别的图就不要）。都按原始字节拿：osu! 的 checksum 是文件字节的 MD5，
 * 转成文字再转回去，不是 UTF-8 的老谱面会对不上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** tosu 的 websocket 地址 → 它的 HTTP 地址。 */
export function tosuHttpBase(wsUrl) {
  try {
    const u = new URL(String(wsUrl || 'ws://127.0.0.1:24050/websocket/v2'));
    return `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}`;
  } catch { return 'http://127.0.0.1:24050'; }
}

const md5 = (data) => createHash('md5').update(data).digest('hex');

export const defaultReadFile = (file) => fs.readFileSync(file);
export const defaultFetchBytes = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

/**
 * map：normalizeSnapshot 里的 map（key 是 checksum，songsDir / file 是路径）。
 * 返回 .osu 的文字；读不到抛 { code: 'map.unreadable' }。
 */
export async function readBeatmapText(map, { readFile = defaultReadFile, fetchText = defaultFetchBytes, tosuUrl = '' } = {}) {
  const want = /^[0-9a-f]{32}$/.test(String(map?.key || '')) ? map.key : '';
  const tries = [];
  if (map?.songsDir && map?.file) tries.push(() => readFile(path.join(map.songsDir, map.file)));
  tries.push(() => fetchText(`${tosuHttpBase(tosuUrl)}/files/beatmap/file`));
  let lastProblem = '';
  for (const attempt of tries) {
    try {
      const data = await attempt();
      if (want && md5(data) !== want) { lastProblem = '读到的谱面和现在打的这张对不上'; continue; }
      return Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    } catch (error) { lastProblem = String(error?.message ?? error).slice(0, 120); }
  }
  throw Object.assign(new Error(lastProblem || '读不到谱面文件'), { code: 'map.unreadable' });
}
