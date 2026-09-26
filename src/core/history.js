/**
 * 历史记录。
 *
 * 每一条是「某个时刻整块板子长什么样」的快照，不是流水账。区别在于：
 * 流水账只能看，快照能退回去 —— 所以这里的恢复按钮顺带就是撤销功能。
 *
 * 记的时机是「布置 / 撤下 / 改课 / 清空 / 恢复」，光在三区填页码不记：
 * 页码输入每敲一个数字都会产生一次状态变更，按变更记的话打「20」
 * 就会留下「2」和「20」两条历史，那不是历史，那是键盘记录。
 *
 * 快照里只有 assignments：页码长在每条布置自己身上，跟着一起回滚。
 * 三区那个页码缓冲不是板子的一部分，不进快照、不参与恢复。
 *
 * 纯函数，不碰 store 也不碰 DOM，自检可以直接在 node 里跑。
 */

import { SUBJECT_ORDER, getSubject } from '../data/subjects.js';
import { tagDisplay } from '../data/tags.js';

/** 上限。再多也没有人会往回翻，而 localStorage 是大家一起用的。 */
export const HISTORY_LIMIT = 40;

/** 条目描述的长度上限，载入时按这个截断（描述里嵌着用户写的 Tag 名） */
export const MAX_HISTORY_LABEL = 60;

/**
 * 追加一条并淘汰最老的。
 * 返回新数组，不改原数组 —— 和 state 的其它部分一样按不可变处理。
 */
export function pushSnapshot(history, entry) {
  const list = [...(history ?? []), entry];
  return list.length > HISTORY_LIMIT ? list.slice(list.length - HISTORY_LIMIT) : list;
}

/**
 * 下一个可用的条目编号。
 *
 * 快照不能靠时间戳认身份：同一次改动可能会连着写两条（见 actions.js 的
 * commit），它们的时间戳一模一样，按 at 去找会永远命中前一条。
 * 载入时会把编号重排成 1..n，所以这里只要取当前最大值加一即可。
 */
export function nextSnapshotId(history) {
  let max = 0;
  for (const item of history ?? []) {
    if (Number.isInteger(item?.id) && item.id > max) max = item.id;
  }
  return max + 1;
}

/**
 * 两份布置记录是否一模一样。恢复时的空操作判断要用。
 *
 * 比的是「同一个位置上是不是同一条、页码也一样」。位置算在内，因为格内条目
 * 按布置先后排列，换了顺序用户是看得见的。页码当然也要比 —— 快照写着
 * 「必刷题-20页」而当前是 25 页时，不比页码的话恢复按钮会变成死的。
 */
export function sameAssignments(a, b) {
  for (const subjectId of SUBJECT_ORDER) {
    const left = a?.[subjectId] ?? [];
    const right = b?.[subjectId] ?? [];
    if (left.length !== right.length) return false;
    if (left.some((item, i) => item.tagId !== right[i]?.tagId
      || (item.page ?? null) !== (right[i]?.page ?? null))) return false;
  }
  return true;
}

/**
 * 把一份布置记录压成「哪门课有什么」的一行摘要，给历史列表看。
 *
 * 返回数组而不是拼好的字符串：视图要按课程上色（颜色只有一个来源，
 * 就是 data/subjects.js），拼成字符串就没法分了。
 *
 * 页码从每条布置自己身上读，不再另收一张页码表 —— 那是三区的输入缓冲，
 * 跟快照里这些已经落地的条目没有关系。
 *
 * @param {object} assignments
 * @param {{get: (id: string) => object}} index buildTagIndex() 的结果
 * @returns {Array<{subjectId: string, glyph: string, text: string}>}
 */
export function summarize(assignments, index) {
  const out = [];

  for (const subjectId of SUBJECT_ORDER) {
    const list = assignments?.[subjectId] ?? [];
    if (list.length === 0) continue;

    // 快照里可能留着已经被删掉的自定义 Tag，取不到名字的就跳过
    const text = list
      .map((item) => tagDisplay(index.get(item.tagId), item.page))
      .filter(Boolean)
      .join('、');

    if (!text) continue;
    out.push({ subjectId, glyph: getSubject(subjectId)?.glyph ?? subjectId, text });
  }

  return out;
}
