/**
 * osu! 官网玩家标签（User Tags）的中文叫法：开局点评时给模型看中文，念出来顺（2026-11-21 用户：开局应该优先报玩家标签的信息）。
 *
 * 标签的意思照 osu! wiki「Beatmap/Beatmap_tags」中文版的说明（https://osu.ppy.sh/wiki/zh/Beatmap/Beatmap_tags），
 * 这里的叫法是按那些说明自己起的短名字（不是照抄 wiki 原文）。只收 osu! 标准模式用得到的；不在表里的原样给（英文）。
 */
export const TAG_NAMES_ZH = Object.freeze({
  // 技能
  'skillset/jumps': '跳图',
  'skillset/streams': '串图',
  'skillset/alt': 'alt 图（得两只手指交替点）',
  'skillset/tech': 'tech 图（考非常规技巧）',
  'skillset/precision': '小圈精准',
  'skillset/reading': '读图',
  'skillset/gimmick': '整活玩法',
  // 跳
  'jumps/sharp': '锐角跳',
  'jumps/wide': '钝角跳',
  'jumps/linear': '直线跳',
  'jumps/triangles': '三角跳',
  'jumps/squares': '方块跳',
  'jumps/stars': '星形跳',
  'jumps/back and forth': '来回跳',
  'jumps/freeform': '没规律的跳',
  'jumps/cross-screen': '跨屏大跳',
  'jumps/stamina': '跳的耐力',
  // 串
  'streams/doubles': '二连',
  'streams/quads': '四连',
  'streams/bursts': '短串（爆发）',
  'streams/stamina': '串的耐力',
  'streams/speed': '手速',
  'streams/flow aim': '顺着走的串（flow aim）',
  'streams/spaced streams': '宽间距串',
  'streams/cutstreams': '断开的串',
  // tech
  'tech/slider tech': '滑条 tech',
  'tech/aim control': 'aim control（方向和速度别扭）',
  'tech/finger control': 'finger control（节奏复杂）',
  // 读图
  'reading/overlaps': '重叠难读',
  'reading/overlap reading': '重叠难读',
  'reading/perfect stacks': '完美叠',
  'reading/visually dense': '一屏好多圈',
  // 整活
  'gimmick/aspire': 'Aspire 整活',
  'gimmick/tag': '接力图',
  'gimmick/2B': '2B（同一时间好几个物件）',
  'gimmick/memory': '背谱',
  'gimmick/storyboard': '故事板玩法',
  'gimmick/video': '跟视频走的玩法',
  'gimmick/playfield constraint': '只用一块游玩区',
  'gimmick/circle only': '全是圈',
  'gimmick/slider only': '全是滑条',
  'gimmick/ninja spinners': '超短转盘',
  // 风格
  'style/symmetrical': '对称',
  'style/distance snap': '等距（DS）',
  'style/grid snap': '网格排布',
  'style/hexgrid': '六边形网格',
  'style/geometric': '几何图形',
  'style/clean': '排得干净',
  'style/freeform': '自由排布',
  'style/messy': '故意排得乱',
  'style/avant-garde': '前卫实验',
  // 表现
  'expression/simple': '简单直观',
  'expression/difficulty spike': '有突然变难的地方',
  'expression/high contrast': '段落反差大',
  'expression/progression': '越打越难',
  'expression/repetition': '重复的排列多',
  'expression/iNiS-style': 'iNiS 风格',
  'expression/old-style revival': '复古风格',
  'expression/inspo': '致敬别的图',
  'expression/improvisation': '即兴的排列',
  'expression/chaotic': '乱、猜不到',
  'expression/playfield usage': '刻意用满游玩区',
  'expression/conceptual': '概念图',
  // 滑条
  'sliders/low sv': '滑条很慢',
  'sliders/high sv': '滑条很快',
  'sliders/complex sv': '滑条变速复杂',
  'sliders/complex slidershapes': '滑条形状花',
  // 附加
  'additions/combo colours': '颜色跟着歌变',
  'additions/keysounds': '键音',
  'additions/custom skin': '自带皮肤',
  // 元信息
  'meta/collab': '合作图',
  'meta/mega collab': '大合作图',
  'meta/swing': '摇摆节奏',
  'meta/accelerating bpm': '越来越快',
  'meta/variable timing': '节奏不固定（好多红线）',
  'meta/time signatures': '拍号奇怪',
  'meta/multi-song': '好几首歌拼的',
  'context/custom song': '专门写的歌',
  'context/mapping contest': '作图比赛的图',
  'context/tournament custom': '比赛专用图',
});

/** 标签名 → 中文叫法；表里没有就原样。 */
export function tagNameZh(name) {
  return TAG_NAMES_ZH[String(name)] || String(name);
}
