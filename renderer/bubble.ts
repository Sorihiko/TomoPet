/**
 * 头顶的气泡（桌面角色窗口用）。定位规则照搬 SurfCore tosu-counter/counter.js 的 showBubble：
 * 气泡在她头的左上方，右下角伸出尾巴斜指着头；装不下就贴边，尾巴跟着挪。
 * 2026-11-19 用户画图：气泡应该在人左上角，不是正中间。
 */
import { headAnchor, type AnyRig } from './boot';
import type { Manifest } from './rig';

export function createBubble(el: HTMLElement, getRig: () => AnyRig | null, getManifest: () => Manifest | null) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    show(text: string, ms: number) {
      const head = headAnchor(getRig(), getManifest());
      const margin = 6;
      el.style.setProperty('--max-w', Math.max(180, Math.min(window.innerWidth * 0.86, Math.max(head.x + 40, window.innerWidth * 0.62))) + 'px');
      el.textContent = text; // 她说的话只当文字放进去
      el.style.left = '0px';
      el.style.top = '0px';
      el.classList.add('on');
      const rect = el.getBoundingClientRect();
      const left = Math.max(margin, Math.min(window.innerWidth - margin - rect.width, head.x + 18 - rect.width));
      const top = Math.max(margin, head.y - rect.height - 16);
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.setProperty('--tail-right', Math.max(14, Math.min(rect.width - 40, left + rect.width - head.x - 4)) + 'px');
      clearTimeout(timer);
      timer = setTimeout(() => el.classList.remove('on'), Math.max(2600, ms + 800));
    },
    hide() {
      clearTimeout(timer);
      el.classList.remove('on');
    },
  };
}
