/**
 * 页码用的内置数字键盘。
 *
 * 这个软件是给教室里的触屏用的。页码原来是一个 <input inputmode="numeric">，
 * 在平板上点一下会弹出系统输入法，盖掉大半个屏幕 —— 而输入法那套候选词、
 * 联想、中英切换，对一个只可能是 1~999 的整数毫无用处。所以页码控件改成了
 * 按钮，输入只走这里：没有输入框，任何设备、任何输入法都不可能弹出来。
 *
 * 三个刻意的决定：
 *
 * - **非模态**。没有遮罩，不给 #app 设 inert。键盘开着的时候可以直接去点
 *   另一枚 Tag 的页码，键盘原地改指那一枚 —— 比「先关掉再点开」少一步。
 *   抽屉那套 openCount / inert 的机关因此完全用不上，别照抄。
 *
 * - **常驻 DOM，用 .is-open 类开关**，不用 hidden 属性。el() 的 hidden 设的
 *   是 property，而 CSS 的 display 会盖掉它 —— 仓库里 .tag-compose 已经为此
 *   补过一条 [hidden] { display: none }，这里换条路走，不必再来一次。
 *   关着的时候靠 inert 从交互树里摘掉，否则它会挡住底下整片界面。
 *
 * - **Esc 不在这里处理**。全局只有一个 Esc 入口（main.js 那条优先级链），
 *   两处都监听会出现「按一次 Esc 关掉两个东西」。
 *
 * 键盘只在编辑页码时开着，所以物理数字键归它接管并不违反 README 里
 * 「不做数字键快捷键」那条：那条的理由是数字键属于页码框和 Tag 名输入框，
 * 现在页码框没有了。Tag 名输入框仍有一道保险，见下面的 keydown。
 */

import { el } from '../core/dom.js';
import { buildTagIndex, MAX_PAGE, normalizePage } from '../data/tags.js';
import { setTagPage } from '../core/actions.js';

const MAX_DIGITS = String(MAX_PAGE).length;   // 999 → 最多三位
const GAP = 8;                                // 键盘与 Tag 之间的空当
const EDGE = 8;                               // 离屏幕边缘至少留这么多

/* 3 列 4 行。清空与退格和数字同宽 —— 触屏上手指不挑键，但要挑位置。 */
const KEYS = [
  { id: '1' }, { id: '2' }, { id: '3' },
  { id: '4' }, { id: '5' }, { id: '6' },
  { id: '7' }, { id: '8' }, { id: '9' },
  { id: 'clear', text: '清空', util: true },
  { id: '0' },
  { id: 'back', text: '退格', util: true },
];

/**
 * @param {object} options
 * @param {object} options.store
 * @param {HTMLElement} [options.mount]
 * @returns {{open: Function, close: Function, isOpen: Function, root: HTMLElement}}
 */
export function createKeypad({ store, mount = document.getElementById('overlay-root') }) {
  const titleNode = el('span', { class: 'keypad__title' });
  const valueNode = el('span', { class: 'keypad__value', 'aria-live': 'polite' });

  const keyButtons = new Map();

  const grid = el('div', { class: 'keypad__grid' }, KEYS.map((spec) => {
    const button = el('button', {
      class: `keypad__key${spec.util ? ' keypad__key--util' : ''}`,
      type: 'button',
      text: spec.text ?? spec.id,
      dataset: { key: spec.id },   // 自检按这个找键，比按可见文字稳
      'aria-label': spec.util ? spec.text : `数字 ${spec.id}`,
      on: { click: () => press(spec.id) },
    });
    keyButtons.set(spec.id, button);
    return button;
  }));

  const doneButton = el('button', {
    class: 'keypad__done',
    type: 'button',
    text: '完成',
    on: { click: () => close() },
  });

  const root = el('div', {
    class: 'keypad',
    role: 'dialog',
    'aria-label': '页码键盘',
    tabindex: -1,
  }, [
    el('div', { class: 'keypad__head' }, [titleNode, valueNode, doneButton]),
    grid,
  ]);

  mount.append(root);

  let isOpen = false;
  let tagId = null;
  let label = '';
  let anchor = null;
  let digits = '';          // 正在编辑的那串数字，是权威 —— state 是它的落地结果
  let lastFocused = null;

  root.inert = true;

  /* ------------------------------------------------------------ 按键 */

  function press(id) {
    if (!isOpen || !tagId) return;

    if (id === 'clear') {
      digits = '';
    } else if (id === 'back') {
      digits = digits.slice(0, -1);
    } else {
      // 三位封顶；首位 0 忽略 —— 「05」会被 normalizePage 归一成 5，
      // 显示和状态从此对不上，不如从一开始就不收。
      if (digits.length >= MAX_DIGITS) return;
      if (digits === '' && id === '0') return;
      digits += id;
    }

    setTagPage(store, tagId, digits);   // 每按一下就落一次 state，格内立刻同步
    paint();
  }

  /* ------------------------------------------------------------ 绘制 */

  function paint() {
    titleNode.textContent = `${label} · 页码`;
    valueNode.textContent = digits === '' ? '未填' : digits;
    valueNode.classList.toggle('is-empty', digits === '');

    const empty = digits === '';
    keyButtons.get('clear').disabled = empty;
    keyButtons.get('back').disabled = empty;

    // 刚按下的那个键可能因为数字清空了而当场禁用，焦点会掉到 body。
    // 拉回键盘根节点，否则接着按物理数字键时焦点已经在页面别处了。
    if (!root.inert && !root.contains(document.activeElement)) root.focus();

    // 页码多一位，那枚 Tag 就宽一点，锚点也跟着挪。放到下一帧再量：
    // 本函数可能跑在 panel-tags 重渲染之前，那时候宽度还是旧的。
    requestAnimationFrame(() => { if (isOpen) place(); });
  }

  /* ------------------------------------------------------------ 摆位 */

  function place() {
    if (!isOpen) return;
    if (!anchor?.isConnected) { close({ restoreFocus: false }); return; }

    const w = root.offsetWidth;
    const h = root.offsetHeight;
    const rect = anchor.getBoundingClientRect();

    // 左右居中于那枚 Tag，但不许出屏
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.min(Math.max(EDGE, left), Math.max(EDGE, window.innerWidth - w - EDGE));

    // 默认贴在 Tag 上方；上面顶到屏幕了就翻到下方，还不行就贴边
    let top = rect.top - h - GAP;
    if (top < EDGE) top = rect.bottom + GAP;
    top = Math.max(EDGE, Math.min(top, window.innerHeight - h - EDGE));

    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
  }

  /* ------------------------------------------------------------ 开关 */

  /** aria-expanded 挂在被点的那枚页码按钮上，由这里维护：只有键盘知道自己是开是关 */
  function markAnchor(node, expanded) {
    if (node?.isConnected) node.setAttribute('aria-expanded', String(expanded));
  }

  function open({ tagId: id, label: text, anchor: anchorNode }) {
    const first = !isOpen;

    // 键盘开着时改点另一枚 Tag：先把上一枚的 aria-expanded 收回去
    if (anchor && anchor !== anchorNode) markAnchor(anchor, false);

    tagId = id;
    label = text;
    anchor = anchorNode ?? null;

    // 焦点还回打开它的那枚页码按钮。用锚点而不是 document.activeElement：
    // 键盘开着时改点另一枚 Tag，焦点这时还在键盘自己身上。
    lastFocused = anchorNode ?? document.activeElement;

    const page = store.getState().tags.pages[id] ?? null;
    digits = page === null ? '' : String(page);

    if (first) {
      isOpen = true;
      root.inert = false;
      root.classList.add('is-open');
      window.addEventListener('resize', place);
      // scroll 不冒泡，要捕获阶段才收得到
      document.addEventListener('scroll', place, { capture: true, passive: true });
    }

    paint();
    place();
    markAnchor(anchorNode, true);
    root.focus();
  }

  function close({ restoreFocus = true } = {}) {
    if (!isOpen) return;
    isOpen = false;
    tagId = null;

    markAnchor(anchor, false);
    anchor = null;

    root.classList.remove('is-open');
    root.inert = true;

    window.removeEventListener('resize', place);
    document.removeEventListener('scroll', place, { capture: true });

    if (restoreFocus) lastFocused?.focus?.();
    lastFocused = null;
  }

  /* ------------------------------------------------------------ 外部点击 */

  document.addEventListener('pointerdown', (event) => {
    if (!isOpen) return;
    if (root.contains(event.target)) return;
    // 点在另一枚 Tag 的页码上不是「点外面」，那是要换个编辑对象 ——
    // 交给 panel-tags 的 click 去 open()，键盘原地改指就行。
    if (event.target.closest?.('.tag__page')) return;
    // 焦点不还回去了：用户正点向别处，硬拉回来会平白闪一个焦点框
    close({ restoreFocus: false });
  });

  /* ------------------------------------------------------------ 物理键盘 */

  document.addEventListener('keydown', (event) => {
    if (!isOpen) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    // 别抢 Tag 名输入框：键盘开着的时候它照样要能打字
    const target = event.target;
    if (target instanceof HTMLElement
      && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    if (event.key === 'Backspace') { event.preventDefault(); press('back'); return; }
    if (event.key === 'Enter') { event.preventDefault(); close(); return; }
    if (/^[0-9]$/.test(event.key)) { event.preventDefault(); press(event.key); }
  });

  /* ------------------------------------------------------------ 跟随状态 */

  function resync(state) {
    if (!isOpen || !tagId) return;

    // 正在编辑的 Tag 被删了，键盘没有留下来的理由
    if (!buildTagIndex(state.tags.custom).has(tagId)) {
      close({ restoreFocus: false });
      return;
    }

    // 别处改了页码（恢复历史）就跟着回到 state，否则显示会和状态分家
    const current = state.tags.pages[tagId] ?? null;
    if (current !== normalizePage(digits)) digits = current === null ? '' : String(current);

    paint();
  }

  store.subscribe(resync);

  return { open, close, isOpen: () => isOpen, root };
}
