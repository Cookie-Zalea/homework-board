/**
 * 便捷 Tag 的数据定义与合并。
 *
 * 默认 Tag 由这里提供；用户自建的 Tag 存在 state.tags.custom 里，
 * 两者结构完全一致，视图不区分对待 —— 只有「能不能删」不同。
 * 页码两种都有：自定义的 Tag 同样可以是「第三单元-20页」。
 *
 * 页码有两种身份，别混：
 *
 * - 三区 Tag 上显示的那个（state.tags.pages[tagId]）是**输入缓冲** ——
 *   用户正在给这枚 Tag 填、还没放进格子的数。
 * - 已经落进格子的条目带着自己的页码（见 assignments 的元素形状），
 *   那条布置交给哪门课就是哪个页数，跟缓冲再无关系。
 *
 * 布置的那一刻缓冲被消费掉（core/actions.js 的 consumePage），所以三区
 * 下一眼看到的又是空的 —— 「页码每次用过就重置」。
 */

export const MAX_TAG_LABEL = 12;
export const MAX_PAGE = 999;
export const MAX_CUSTOM_TAGS = 24;

/* 默认 Tag：装好就有的那些，删不掉（自建的才有删除键）。
   前四条是「一本练习册 / 一张卷子」这类通名，后面是英语卷面上的题型与篇目
   —— 用户报上来的清单，顺序照他给的排。
   id 只是内部键（拖拽、存档、动画都用它），显示的一律是 label，所以
   id 用拼音缩写即可，跟 U加课堂 写作 ujia 是同一个路子。 */
export const DEFAULT_TAGS = [
  { id: 'bishuati',  label: '必刷题',       custom: false },
  // 这一枚原本叫「U加练习册」，用户后来把它拆成了「课堂」与「课后」两枚。
  // id 沿用旧的 ujia：改名不换键，老存档里那枚仍认得出自己（存档按 id 认人，
  // 换 id 等于把已经布置出去的条目当孤儿丢掉，见 core/persist.js 的 sanitize）。
  { id: 'ujia',      label: 'U加课堂',      custom: false },
  { id: 'ujiakehou', label: 'U加课后',      custom: false },
  { id: 'juanzi',    label: '卷子',         custom: false },
  { id: 'yuedu',     label: '阅读理解',     custom: false },
  { id: 'qixuanwu',  label: '七选五',       custom: false },
  { id: 'wanxing',   label: '完形填空',     custom: false },
  { id: 'danju',     label: '单句填空',     custom: false },
  { id: 'kewengai',  label: '课文改编填空', custom: false },
  { id: 'yufa',      label: '语法填空',     custom: false },
  { id: 'apian',     label: 'A篇',          custom: false },
  { id: 'bpian',     label: 'B篇',          custom: false },
  { id: 'cpian',     label: 'C篇',          custom: false },
  { id: 'dpian',     label: 'D篇',          custom: false },
  { id: 'baipishu',  label: '白皮书',       custom: false },
];

/** 六门课程之外，默认 Tag 的固定顺序 */
export const TAG_ORDER = DEFAULT_TAGS.map((tag) => tag.id);

export const DEFAULT_TAG_IDS = new Set(TAG_ORDER);

/** 自定义 Tag 与默认 Tag 同构，只是来源不同（来源只决定能不能删） */
export function makeCustomTag(id, label) {
  return { id, label, custom: true };
}

/**
 * 把默认 Tag 与自定义 Tag 合成一份渲染用的索引。
 * @param {Array} customTags state.tags.custom
 */
export function buildTagIndex(customTags = []) {
  const all = [...DEFAULT_TAGS, ...customTags];
  const byId = new Map(all.map((tag) => [tag.id, tag]));

  return {
    all,
    byId,
    get: (id) => byId.get(id) ?? null,
    has: (id) => byId.has(id),
  };
}

/** 把任意输入归一成合法页码：不是正整数就是 null（表示没填） */
export function normalizePage(value) {
  const digits = String(value ?? '').replace(/\D/g, '').slice(0, String(MAX_PAGE).length);
  if (!digits) return null;
  const page = Number.parseInt(digits, 10);
  return page > 0 ? Math.min(page, MAX_PAGE) : null;
}

/**
 * 一个 Tag 的显示文案：填了页码就带上「-N页」。
 *
 * 名字与页码分开返回是给格内 chip 用的：chip 里名字可以被省略号截短，
 * 页码不行 —— 见 splitTagText。
 */
export function tagDisplay(tag, page) {
  if (!tag) return '';
  if (Number.isInteger(page) && page > 0) return `${tag.label}-${page}页`;
  return tag.label;
}

/**
 * 按 id 取显示文案，视图里少写一层判空。
 *
 * 只给「还在三区、页码取自输入缓冲」的地方用（一区那句「已选中：X」）。
 * 格内条目手里只有一条布置，直接调 tagDisplay(tag, entry.page) 就行 ——
 * 走这里等于把缓冲的页码贴到已经落地的条目上，那是两个不同的数。
 */
export function tagLabelOf(index, tagId, pages) {
  return tagDisplay(index.get(tagId), pages?.[tagId]);
}

/**
 * 把显示文案拆成「名字」与「页码后缀」两段（后缀含前导的「-」，没填就是空串）。
 *
 * 为什么要拆：格内的 chip 是 nowrap + max-width:100%，放不下时靠省略号截短。
 * 整条文案是一段文本的话，被截掉的正好是末尾的页码 —— 而页码恰恰是这条作业
 * 唯一的新信息（「必刷题」人人都知道，「第几页」才是要看的）。拆开之后名字
 * 负责让步，页码固定不压缩（.asg__page 是 flex: none）。
 */
export function splitTagText(tag, page) {
  const label = tag?.label ?? '';
  if (tag && Number.isInteger(page) && page > 0) return { label, page: `-${page}页` };
  return { label, page: '' };
}
