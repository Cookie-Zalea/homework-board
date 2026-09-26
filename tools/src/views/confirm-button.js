/**
 * 就地二次确认按钮。
 *
 * 破坏性操作不弹系统对话框：那种框和这个工具的语气不搭，还会打断手上的动作。
 * 改成按钮自己变一下 —— 第一次点变成「确认清除」，再点才真的执行；超时或失焦
 * 自动退回原样。误触的代价于是从「数据没了」降到「再点一次」。
 *
 * 一区的「清空全部作业布置」和设置里那一条是同一个动作，两处共用这一份。
 * 别把这段抄第二遍：两边的超时与退场行为必须一模一样，否则同一个动作在两个
 * 入口下的手感会不同。
 */

import { el } from '../core/dom.js';

export const CONFIRM_TIMEOUT = 3500;

/**
 * @param {object} config
 * @param {string} config.label 常态文案
 * @param {string} [config.confirmLabel] 待确认时的文案
 * @param {string} [config.className] 完整类名（如 'btn btn--block btn--danger'）
 * @param {() => void} config.onConfirm 第二次点击时执行
 * @returns {{ button: HTMLButtonElement, reset: () => void, isConfirming: () => boolean }}
 */
export function createConfirmButton({ label, confirmLabel = '确认', className = 'btn', onConfirm }) {
  const button = el('button', { class: className, type: 'button', text: label });

  let timer = null;

  /** 退回常态。调用方在把按钮禁用掉之前也要调一次，否则会停在一个点不动的确认态 */
  function reset() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    button.classList.remove('is-confirming');
    button.textContent = label;
  }

  button.addEventListener('click', () => {
    if (timer === null) {
      button.classList.add('is-confirming');
      button.textContent = confirmLabel;
      timer = setTimeout(reset, CONFIRM_TIMEOUT);
      return;
    }
    reset();
    onConfirm();
  });

  button.addEventListener('blur', reset);

  return { button, reset, isConfirming: () => timer !== null };
}
