/**
 * 三区：便捷 Tag。
 *
 * 这里同时是两种拖拽的起点和终点：
 *   - Tag 拖出去 → 二区课程格接收 = 布置作业
 *   - 格内作业拖回来 → 本区接收 = 撤销布置
 * 视图只管把状态画出来，拖拽语义由 main.js 接线。
 *
 * Tag 一律中性色：它落在哪门课，才染上那门课的颜色。
 */

import { el, replayAnimation } from '../core/dom.js';
import { buildTagIndex, MAX_TAG_LABEL, MAX_CUSTOM_TAGS } from '../data/tags.js';
import { selectTag, addCustomTag, removeCustomTag } from '../core/actions.js';
import { iconGrip, iconClose } from './icons.js';

/** 页码那一段的宽度跟着位数走：空着留两位，填了就缩成刚好一行数字 */
function syncPageWidth(node, text) {
  node.style.setProperty('--page-ch', String(Math.max(2, text.length)));
}

export function createTagsPanel({ mount, store, dnd, keypad }) {
  const list = el('div', { class: 'tags-body' });
  const nodes = new Map();        // tagId -> 节点句柄
  let justDragged = false;

  const addButton = el('button', {
    class: 'tag-add',
    type: 'button',
    on: { click: () => openCompose() },
  }, [
    el('span', { class: 'tag-add__plus', text: '+' }),
    el('span', { text: '自定义 Tag' }),
  ]);

  const compose = createCompose();

  // 顺序固定：Tag 一律插在「+ 自定义 Tag」之前
  list.append(addButton, compose.root);

  mount.append(
    el('div', { class: 'panel-head' }, [
      el('h2', { class: 'panel-head__title', text: '便捷 Tag' }),
      el('span', {
        class: 'panel-head__note',
        text: '拖到课程上布置，拖回这里撤销',
      }),
    ]),
    list,
  );

  // 本区接收「从格内拖回来的作业」；拖 Tag 本身回来则不算 —— 它本来就在这
  dnd.registerTarget(list, { kind: 'tray' });

  // 点三区空白处取消点选
  list.addEventListener('click', (event) => {
    if (event.target === list) selectTag(store, null);
  });

  /* ------------------------------------------------------------ 单个 Tag */

  function createTagNode(tag) {
    const label = el('span', { class: 'tag__label', text: tag.label });
    const grab = el('button', { class: 'tag__grab', type: 'button' }, [iconGrip('tag__grip'), label]);

    const parts = [grab];
    const handle = { root: null, label, grab, page: null, remove: null };

    // 页码是一个按钮，不是一个输入框：这个软件给触屏用，输入框一点就弹系统
    // 输入法，盖掉大半个屏幕。所有 Tag 都有页码，自建的也一样。
    // 输入走内置键盘（views/keypad.js），所以这里不需要任何键盘/失焦处理。
    const pageButton = el('button', {
      class: 'tag__page',
      type: 'button',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      // 点开键盘。不 stopPropagation —— 点选与拖拽各自有 .tag__page-wrap 的
      // guard 挡着（见下面 root 的 click 与 dnd.attachSource）。
      on: {
        click: () => keypad.open({ tagId: tag.id, label: tag.label, anchor: pageButton }),
      },
    });

    syncPageWidth(pageButton, '');

    handle.page = pageButton;
    parts.push(el('span', { class: 'tag__page-wrap' }, [
      el('span', { class: 'tag__dash', text: '-' }),
      pageButton,
      el('span', { class: 'tag__unit', text: '页' }),
    ]));

    // 只有自建 Tag 能删；默认 Tag 是固定清单
    if (tag.custom) {
      const remove = el('button', {
        class: 'tag__remove',
        type: 'button',
        'aria-label': `删除 ${tag.label}`,
        on: {
          click: (event) => {
            event.stopPropagation();
            removeCustomTag(store, tag.id);
          },
        },
      }, [iconClose(10)]);

      handle.remove = remove;
      parts.push(remove);
    }

    const root = el('div', {
      class: `tag${tag.custom ? ' tag--custom' : ''}`,
      dataset: { tagId: tag.id },
    }, parts);

    root.addEventListener('click', (event) => {
      // 页码区与删除键有自己的职责，不参与点选
      if (event.target.closest('.tag__page-wrap') || event.target.closest('.tag__remove')) return;
      if (justDragged) return;
      const selected = store.getState().ui.selectedTagId;
      selectTag(store, selected === tag.id ? null : tag.id);
    });

    dnd.attachSource(root, (event) => {
      // 在页码上按下是要开键盘，不是要拖
      if (event.target.closest('.tag__page-wrap')) return null;
      if (event.target.closest('.tag__remove')) return null;
      return { kind: 'tag', tagId: tag.id };
    }, {
      onStart: () => {
        root.classList.add('is-dragging');
        // Tag 拖回自己家没有意义，这时候别让本区亮起接收态
        list.classList.add('is-dragging-tag');
      },
      onEnd: (wasActive) => {
        root.classList.remove('is-dragging');
        list.classList.remove('is-dragging-tag');
        if (!wasActive) return;
        justDragged = true;
        setTimeout(() => { justDragged = false; }, 0);
      },
    });

    handle.root = root;
    return handle;
  }

  /* --------------------------------------------------------- 自定义 Tag */

  function createCompose() {
    const input = el('input', {
      class: 'tag-compose__input',
      type: 'text',
      maxlength: MAX_TAG_LABEL,
      placeholder: 'Tag 名称',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': '自定义 Tag 名称',
    });

    const root = el('form', { class: 'tag-compose', hidden: true }, [
      input,
      el('button', { class: 'tag-compose__ok', type: 'submit', text: '添加' }),
      el('button', {
        class: 'tag-compose__cancel',
        type: 'button',
        text: '取消',
        on: { click: () => closeCompose() },
      }),
    ]);

    root.addEventListener('submit', (event) => {
      event.preventDefault();
      commit();
    });

    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();     // 别让 Esc 冒到全局去清空点选
      closeCompose();
    });

    // 焦点离开整行才收起；否则点「取消」会先触发 blur 把按钮挪走
    root.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!root.contains(document.activeElement)) closeCompose();
      }, 0);
    });

    function commit() {
      const result = addCustomTag(store, input.value);

      if (result.created) {
        input.value = '';
        closeCompose();
        replayAnimation(nodes.get(result.tag.id)?.root ?? addButton, 'is-created');
        return;
      }

      // 重名时指向已有的那枚，比单纯拒绝更能说明问题
      if (result.reason === 'duplicate') {
        replayAnimation(nodes.get(result.tagId)?.root ?? addButton, 'is-created');
        input.select();
        return;
      }

      replayAnimation(root, 'is-invalid');
      input.focus();
    }

    return { root, input, commit };
  }

  function openCompose() {
    compose.root.hidden = false;
    addButton.hidden = true;
    compose.input.focus();
  }

  function closeCompose() {
    if (compose.root.hidden) return;
    compose.root.hidden = true;
    addButton.hidden = false;
    compose.input.value = '';
    compose.root.classList.remove('is-invalid');
  }

  /* -------------------------------------------------------------- 渲染 */

  function render(state) {
    const index = buildTagIndex(state.tags.custom);
    const pages = state.tags.pages;

    // 新 Tag 插到「+ 自定义 Tag」之前。已在位的节点不再搬动 ——
    // 每次输入页码都会触发一轮渲染，搬动 DOM 会把输入焦点顶掉。
    for (const tag of index.all) {
      let handle = nodes.get(tag.id);
      if (!handle) {
        handle = createTagNode(tag);
        nodes.set(tag.id, handle);
        list.insertBefore(handle.root, addButton);
      }

      if (handle.label.textContent !== tag.label) handle.label.textContent = tag.label;
      handle.grab.setAttribute('aria-label', `${tag.label}，拖动到课程即可布置`);
      handle.root.classList.toggle('is-selected', state.ui.selectedTagId === tag.id);

      const page = pages[tag.id];
      const text = page ? String(page) : '';
      if (handle.page.textContent !== text) handle.page.textContent = text;
      handle.page.classList.toggle('is-empty', !page);
      handle.page.setAttribute('aria-label', `${tag.label}的页码${page ? `，${page}` : '，未填'}`);
      syncPageWidth(handle.page, text);
    }

    for (const [id, handle] of nodes) {
      if (index.has(id)) continue;
      handle.root.remove();
      nodes.delete(id);
    }

    const full = state.tags.custom.length >= MAX_CUSTOM_TAGS;
    addButton.disabled = full;
    addButton.title = full ? `最多 ${MAX_CUSTOM_TAGS} 个自定义 Tag` : '';
  }

  store.subscribe(render);
  render(store.getState());

  /** 供二区把「撤销后的作业」飞回它出发的那枚 Tag */
  return {
    anchorFor: (tagId) => nodes.get(tagId)?.root ?? null,
  };
}
