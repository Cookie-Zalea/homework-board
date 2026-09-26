/**
 * 右侧滑出抽屉的共用外壳。
 *
 * 设置与历史记录内容完全不同，但外壳一模一样：遮罩、滑入、打开时把整页
 * 设成 inert、Esc 关闭、关掉之后把焦点还给打开它的那个按钮。
 * 这套机关写两遍，迟早会只有一边被修好，所以抽在这里。
 *
 * 外壳只认「标题」和一个内容容器，不认识里面装的是什么。
 */

import { el } from '../core/dom.js';
import { iconClose } from './icons.js';

/**
 * 同时打开的抽屉数。
 *
 * 关闭时要判断「还有没有别的抽屉开着」才能决定要不要解除整页的 inert，
 * 不能关一个就无条件解开 —— 那样两个抽屉叠着时，关掉上面那个会把下面
 * 那个也变成可点的背景。
 */
let openCount = 0;

function syncAppInert() {
  const app = document.getElementById('app');
  if (app) app.inert = openCount > 0;
}

/**
 * @param {string} options.title     标题栏文字
 * @param {string} options.variant   变体名，根节点会多一个 drawer--<variant>
 *                                   类，供样式与自检区分是哪一只抽屉
 * @param {string} [options.ariaLabel]
 * @returns {{body: HTMLElement, root: HTMLElement, open: Function, close: Function, isOpen: Function}}
 */
export function createDrawer({
  title,
  variant,
  ariaLabel = title,
  mount = document.getElementById('overlay-root'),
}) {
  const scrim = el('div', { class: 'scrim' });
  const body = el('div', { class: 'drawer__body' });

  const root = el('aside', {
    class: `drawer drawer--${variant}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': ariaLabel,
    tabindex: -1,
  }, [
    el('div', { class: 'drawer__head' }, [
      el('h2', { class: 'drawer__title', text: title }),
      el('button', {
        class: 'drawer__close',
        type: 'button',
        'aria-label': `关闭${title}`,
        on: { click: () => close() },
      }, [iconClose(13)]),
    ]),
    body,
  ]);

  mount.append(scrim, root);

  let isOpen = false;
  let lastFocused = null;

  // 关闭态用 inert 从交互树里摘掉，否则遮罩会挡住底下整个界面
  setInteraction(false);

  scrim.addEventListener('click', () => close());

  function setInteraction(enabled) {
    scrim.inert = !enabled;
    root.inert = !enabled;
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    lastFocused = document.activeElement;

    setInteraction(true);
    scrim.classList.add('is-open');
    root.classList.add('is-open');

    openCount += 1;
    syncAppInert();
    root.focus();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;

    setInteraction(false);
    scrim.classList.remove('is-open');
    root.classList.remove('is-open');

    openCount = Math.max(0, openCount - 1);
    syncAppInert();

    // 焦点还给打开它的那个按钮，键盘用户不会掉到页面开头
    lastFocused?.focus?.();
  }

  return { body, root, open, close, isOpen: () => isOpen };
}
