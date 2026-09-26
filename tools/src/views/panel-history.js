/**
 * 历史记录抽屉。
 *
 * 每一条是「那一刻整块板子长什么样」的快照，最新的在最上面。
 * 每条右边一个「恢复到这里」，所以它同时是撤销功能 —— 手滑撤错了不用
 * 自己回忆刚才有什么，退回上一条就是了。
 *
 * 40 条塞不进一区的窄栏，所以放在抽屉里，外壳与设置共用。
 */

import { el } from '../core/dom.js';
import { getSubject } from '../data/subjects.js';
import { buildTagIndex } from '../data/tags.js';
import { sameAssignments, summarize } from '../core/history.js';
import { formatWhen } from '../core/time.js';
import { restoreSnapshot } from '../core/actions.js';
import { createDrawer } from './drawer.js';

const EMPTY_BOARD = '空板';

export function createHistoryPanel({ store, mount }) {
  const drawer = createDrawer({
    title: '历史记录',
    variant: 'history',
    ariaLabel: '历史记录',
    mount,
  });

  const list = el('div', { class: 'hist-list' });
  const emptyNote = el('p', { class: 'hist-empty', text: '还没有改动过。布置或撤下作业之后，这里会记下每一次。' });

  drawer.body.append(
    el('p', { class: 'hist-note', text: '每次布置、撤下、改课、清空都会记一条，最多保留 40 条。改页码不单独记账。' }),
    emptyNote,
    list,
  );

  /* ---------------------------------------------------------------- 渲染 */

  function render(state) {
    const index = buildTagIndex(state.tags.custom);
    const entries = [...state.history].reverse();   // 最新在最上面

    emptyNote.hidden = entries.length > 0;
    list.replaceChildren(...entries.map((entry) => renderItem(entry, state, index)));
  }

  function renderItem(entry, state, index) {
    // 这一条就是现在板子的样子：不给「恢复」按钮，改成一个「当前」标记。
    // 它同时回答了「我现在停在哪一条上」。只比布置记录 —— 页码长在布置身上，
    // 已经在里面了；三区的输入缓冲跟板子无关，拿它比会让「当前」无端失效。
    const isCurrent = sameAssignments(state.assignments, entry.assignments);

    const head = el('div', { class: 'hist-item__head' }, [
      el('span', { class: 'hist-item__time', text: formatWhen(entry.at) }),
      el('span', { class: 'hist-item__label', text: entry.label }),
    ]);

    const summary = summarize(entry.assignments, index);
    const summaryNode = el('div', { class: 'hist-item__summary' }, summary.length > 0
      ? summary.map((part) => {
        // 课程色只有 data/subjects.js 一个来源，这里跟课程格用同一套变量
        const color = getSubject(part.subjectId)?.color;
        const glyph = el('span', { class: 'hist-sub__glyph', text: part.glyph });
        if (color) glyph.style.setProperty('--hue', color.hue);

        return el('span', { class: 'hist-sub' }, [glyph, el('span', { text: part.text })]);
      })
      : [el('span', { class: 'hist-item__blank', text: EMPTY_BOARD })]);

    const action = isCurrent
      ? el('span', { class: 'hist-item__current', text: '当前' })
      : el('button', {
        class: 'hist-item__restore',
        type: 'button',
        text: '恢复到这里',
        'aria-label': `恢复到 ${formatWhen(entry.at)} 的状态`,
        on: { click: () => restoreSnapshot(store, entry.id) },
      });

    return el('div', { class: `hist-item${isCurrent ? ' is-current' : ''}` }, [
      el('div', { class: 'hist-item__main' }, [head, summaryNode]),
      action,
    ]);
  }

  /* ---------------------------------------------------------------- 打开 */

  const open = () => {
    // 时间是照着「现在」写的（今天 / 昨天），开着不动跨过午夜就会停在前一天
    render(store.getState());
    drawer.open();
  };

  store.subscribe((state) => {
    if (drawer.isOpen()) render(state);
  });
  render(store.getState());

  return { open, close: drawer.close, isOpen: drawer.isOpen };
}
