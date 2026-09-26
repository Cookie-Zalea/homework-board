/**
 * 极简 DOM 构建辅助。
 *
 * 刻意不提供 innerHTML 入口：软件信息是用户输入的文本，
 * 一律走 textContent 写入，从根上避免注入问题。
 */

/**
 * @param {string} tag
 * @param {object} props  class / text / dataset / style / on / 其余作为属性或属性值
 * @param {Array<Node|string|null|false>} children
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'on' && typeof value === 'object') {
      for (const [type, handler] of Object.entries(value)) node.addEventListener(type, handler);
    } else if (key in node) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }

  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return parent;
}

/** 在同一帧内重放一次 CSS 动画（先摘掉类，强制回流，再加回去） */
export function replayAnimation(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}
