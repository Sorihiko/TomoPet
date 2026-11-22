/**
 * 一场打完的小结：<数据目录>/summaries.json，最近 20 场。
 * SurfCore 是写进它的记忆系统；这里自己存，提示词里带最近几场（替代原来的「记忆卡」那一段）。
 */
import { dataPath, readJson, writeJsonAtomic } from './store.js';

const KEEP = 20;
const FILE = () => dataPath('summaries.json');

function load() {
  const value = readJson(FILE(), null);
  return value?.version === 1 && Array.isArray(value.items) ? value.items : [];
}

export function createJournal() {
  return {
    /** 记一条：{ at, text }。返回 true / false。 */
    append({ at = Date.now(), text } = {}) {
      const line = String(text ?? '').trim().slice(0, 600);
      if (!line) return false;
      const items = [...load(), { at, text: line }].slice(-KEEP);
      writeJsonAtomic(FILE(), { version: 1, items });
      return true;
    },
    /** 最近 n 条（早的在前）。 */
    recent(n = 3) {
      return load().slice(-Math.max(0, n));
    },
    clear() {
      writeJsonAtomic(FILE(), { version: 1, items: [] });
    },
  };
}
