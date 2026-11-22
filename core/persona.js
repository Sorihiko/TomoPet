/**
 * 人设：用户自己写的 <数据目录>/persona.md（第一次启动时从仓库里的 persona.example.md 复制一份）。
 * 名字、怎么称呼玩家、他 / 她 / TA 在设置里改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPath } from './store.js';

export const PERSONA_MAX = 3200;
const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'persona.example.md');
export const personaFile = () => dataPath('persona.md');

/** 没有 persona.md 就从示例复制一份。返回文件路径。 */
export function ensurePersonaFile() {
  const file = personaFile();
  if (!fs.existsSync(file)) {
    try { fs.copyFileSync(EXAMPLE, file); } catch { fs.writeFileSync(file, '', 'utf8'); }
  }
  return file;
}

/** @param {() => {name:string, ownerName:string, ownerPronoun:string}} personaConfig */
export function createPersona(personaConfig) {
  return {
    info() {
      const cfg = personaConfig() || {};
      let text = '';
      try { text = fs.readFileSync(personaFile(), 'utf8').replace(/^﻿/, '').trim(); } catch {}
      return { name: cfg.name || '小鲸鱼', ownerName: cfg.ownerName || '主人', pronoun: cfg.ownerPronoun || '他', persona: text.slice(0, PERSONA_MAX), personaChars: text.length };
    },
  };
}
