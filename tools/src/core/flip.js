/**
 * FLIP：把「删除中间一项导致后续元素瞬间位移」变成一次平滑过渡。
 *
 * 先量旧位置（First），改完 DOM 再量新位置（Last），
 * 然后用一个从旧位置到新位置的 transform 动画补上差值（Invert / Play）。
 * 全程只动 transform，不触发重排，所以不会连累别的动画。
 */

const DEFAULT_DURATION = 160;
const DEFAULT_EASING = 'cubic-bezier(.22,.61,.36,1)';

/**
 * @param {() => Element[]} measure 变更前可量测的元素集合
 * @param {() => void} mutate 实际改动 DOM 的操作
 */
export function flip(measure, mutate, options = {}) {
  if (prefersReducedMotion()) {
    mutate();
    return;
  }

  const { duration = DEFAULT_DURATION, easing = DEFAULT_EASING } = options;

  const before = new Map();
  for (const node of measure()) before.set(node, node.getBoundingClientRect());

  mutate();

  for (const [node, first] of before) {
    if (!node.isConnected) continue;

    const last = node.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (dx === 0 && dy === 0) continue;

    node.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration, easing },
    );
  }
}

/** 动画时长统一从根节点的类名判断，与 CSS 的降级规则保持同一条开关 */
export function prefersReducedMotion() {
  return document.documentElement.classList.contains('reduce-motion');
}
