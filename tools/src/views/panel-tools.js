/**
 * 一区：功能区。
 *
 * 左栏原来是只读的软件信息陈列，现在是日常操作的地方：调字号、一键布置给
 * 全部课程、翻历史记录。软件信息压缩后留在栏底，由一条细分隔线分开 ——
 * 它只是「这是哪个版本、谁做的」，不该占掉半栏。
 *
 * 三块工具的排布原则：越常用的越靠上。字号是「设一次就不动」的，但它决定了
 * 下面两块的字有多大，所以它必须在最上面 —— 否则调完字号还得往下找别的按钮。
 *
 * 和别的视图一样：只调 actions，不自己改 state。
 */

import { el } from '../core/dom.js';
import { APP_NAME } from '../core/persist.js';
import { FONT_STEPS } from '../data/prefs.js';
import { buildTagIndex, tagLabelOf } from '../data/tags.js';
import { setPref, assignTagToAllSubjects, clearAssignments } from '../core/actions.js';
import { formatWhen } from '../core/time.js';
import { iconSliders, iconClock } from './icons.js';
import { createConfirmButton } from './confirm-button.js';

const UNSET = '未设置';

export function createToolsPanel({ mount, store, onOpenSettings, onOpenHistory }) {
  /* ---------------------------------------------------------------- 字号 */

  const fontButtons = new Map();
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': '字号' });

  for (const step of FONT_STEPS) {
    const button = el('button', {
      class: 'seg__btn',
      type: 'button',
      text: step.label,
      'aria-pressed': 'false',
      dataset: { fontStep: step.id },
      on: { click: () => setPref(store, 'fontScale', step.id) },
    });
    fontButtons.set(step.id, button);
    seg.append(button);
  }

  /* ---------------------------------------------------------------- 快捷 */

  // 三块各有一条说明文字，都叫 tools-note。给它们一个名字，别让读的人
  // （包括自检）靠数下标去找：「快捷」里插一条说明就会把后面的全挪位。
  const selectedNote = el('p', { class: 'tools-note', dataset: { note: 'selected' } });

  const placeAllButton = el('button', {
    class: 'btn btn--block',
    type: 'button',
    text: '布置给全部课程',
    dataset: { tool: 'place-all' },
    on: {
      click: () => {
        const tagId = store.getState().ui.selectedTagId;
        if (tagId) assignTagToAllSubjects(store, tagId);
      },
    },
  });

  /* 「一键清除」放在一区，因为它是日常动作：换一天、换一节课，要把上一个班的
     布置整个抹掉重来，不该先翻进设置里找。动作本身和设置里那条是同一个
     （core/actions.js 的 clearAssignments），这里只是把它提到手边。

     清掉的只有二区：三区的 Tag 与历史记录都原样留着 —— 清 Tag 是另一件事，
     历史更是「抹掉证据」，都不该混进这个按钮。文案要把这件事说清楚，否则
     「清除所有」听起来像是把整个软件还原成出厂状态。 */
  const clearNote = el('p', { class: 'tools-note', dataset: { note: 'clear' } });

  const clearButton = createConfirmButton({
    label: '清空全部作业布置',
    confirmLabel: '确认清空',
    className: 'btn btn--block btn--danger',
    onConfirm: () => clearAssignments(store),
  });
  clearButton.button.dataset.tool = 'clear-assignments';

  /* ---------------------------------------------------------------- 历史 */

  const lastNote = el('p', { class: 'tools-note', dataset: { note: 'last' } });

  const historyButton = el('button', {
    class: 'btn btn--block',
    type: 'button',
    dataset: { tool: 'history' },
    on: { click: () => onOpenHistory() },
  }, [iconClock('btn__icon'), el('span', { text: '历史记录' })]);

  /* ------------------------------------------------------- 软件信息（栏底） */

  const nameNode = el('h1', { class: 'info-id__name' });
  const versionNode = el('span', { class: 'info-row__value' });
  const authorNode = el('span', { class: 'info-row__value' });

  const settingsButton = el('button', {
    class: 'btn btn--block',
    type: 'button',
    on: { click: () => onOpenSettings() },
  }, [iconSliders('btn__icon'), el('span', { text: '设置' })]);

  mount.append(
    el('div', { class: 'panel-head' }, [
      el('h2', { class: 'panel-head__title', text: '功能区' }),
    ]),
    el('div', { class: 'tools-body' }, [
      block('字号', [seg]),
      block('快捷', [
        el('div', { class: 'tools-stack' }, [placeAllButton, clearButton.button]),
        selectedNote,
        clearNote,
      ]),
      block('历史', [
        el('div', { class: 'tools-stack' }, [historyButton]),
        lastNote,
      ]),
    ]),
    el('div', { class: 'info-foot' }, [
      el('div', { class: 'info-id' }, [nameNode]),
      el('div', { class: 'info-list' }, [
        infoRow('版本', versionNode),
        infoRow('开发者', authorNode),
      ]),
      settingsButton,
    ]),
  );

  /* ---------------------------------------------------------------- 渲染 */

  function render(state) {
    const title = state.appInfo.name.trim() || APP_NAME;
    nameNode.textContent = title;
    document.title = title;
    setValue(versionNode, state.appInfo.version);
    setValue(authorNode, state.appInfo.author);

    // 档位是单选，用 aria-pressed 表达而不是换个类名 —— 读屏软件也认得出
    for (const [id, button] of fontButtons) {
      button.setAttribute('aria-pressed', String(id === state.prefs.fontScale));
    }

    // 「布置给全部课程」得先有东西可布置。没选 Tag 时按钮禁用，
    // 并说清楚去哪儿选，而不是让人对着一个灰按钮猜。
    const tagId = state.ui.selectedTagId;
    const tagText = tagId
      ? tagLabelOf(buildTagIndex(state.tags.custom), tagId, state.tags.pages)
      : '';

    placeAllButton.disabled = !tagText;
    selectedNote.textContent = tagText ? `已选中：${tagText}` : '先在三区点选一枚 Tag';

    // 二区空着的时候没有可清的东西。禁用并说清楚，而不是让人对着一个灰按钮猜
    // （和上面那枚按钮同一个路数）。禁用前先让它退出确认态：一个停住的
    // 「确认清空」被置灰，是最容易被误读成「坏了」的样子。
    const total = Object.values(state.assignments).reduce((sum, list) => sum + list.length, 0);
    clearButton.button.disabled = total === 0;
    if (total === 0) clearButton.reset();
    clearNote.textContent = total === 0
      ? '二区还没有布置。'
      : `把二区这 ${total} 项全部撤下。三区的 Tag 与历史记录都保留。`;

    const when = formatWhen(state.updatedAt);
    lastNote.textContent = when ? `上次布置：${when}` : '还没有布置过';
  }

  store.subscribe(render);
  render(store.getState());
}

/* ---------------------------------------------------------------- 小件 */

function block(title, children) {
  return el('section', { class: 'tools-block' }, [
    el('h3', { class: 'tools-block__title', text: title }),
    ...children,
  ]);
}

function infoRow(label, valueNode) {
  return el('div', { class: 'info-row' }, [
    el('span', { class: 'info-row__label', text: label }),
    valueNode,
  ]);
}

function setValue(node, raw) {
  const text = (raw ?? '').trim();
  node.textContent = text || UNSET;
  node.classList.toggle('is-unset', text === '');
  node.title = text;
}
