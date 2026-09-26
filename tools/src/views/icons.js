/**
 * 少量内联图标。
 * 只在「图标本身就是功能标识」的地方使用（拖拽抓手 / 设置 / 关闭），
 * 不用图标填充版面。颜色一律 currentColor，随文字色走。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function shape(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function svg(attrs, children) {
  const node = document.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

/** 拖拽抓手：明确告诉用户「这里可以按住拖」 */
export function iconGrip(className = '') {
  const dots = [];
  for (const cy of [1.5, 5, 8.5]) {
    for (const cx of [1.5, 4.5]) dots.push(shape('circle', { cx, cy, r: 1 }));
  }

  return svg(
    {
      viewBox: '0 0 6 10', width: 6, height: 10,
      fill: 'currentColor', class: className,
      'aria-hidden': 'true', focusable: 'false',
    },
    dots,
  );
}

export function iconClose(size = 11, className = '') {
  return svg(
    {
      viewBox: '0 0 16 16', width: size, height: size,
      fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7,
      'stroke-linecap': 'round', class: className,
      'aria-hidden': 'true', focusable: 'false',
    },
    [shape('path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' })],
  );
}

/** 进入全屏：四角向外撑开 */
export function iconExpand(className = '') {
  return svg(
    {
      viewBox: '0 0 16 16', width: 13, height: 13,
      fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: className,
      'aria-hidden': 'true', focusable: 'false',
    },
    [
      shape('path', { d: 'M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10' }),
      shape('path', { d: 'M2.5 2.5L6.4 6.4M13.5 2.5L9.6 6.4M2.5 13.5l3.9-3.9M13.5 13.5L9.6 9.6' }),
    ],
  );
}

/** 退出全屏：四角向内收 */
export function iconCollapse(className = '') {
  return svg(
    {
      viewBox: '0 0 16 16', width: 13, height: 13,
      fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: className,
      'aria-hidden': 'true', focusable: 'false',
    },
    [
      shape('path', { d: 'M2.5 6H6V2.5M13.5 6H10V2.5M2.5 10H6v3.5M13.5 10H10v3.5' }),
      shape('path', { d: 'M6.4 6.4L2.5 2.5M9.6 6.4l3.9-3.9M6.4 9.6l-3.9 3.9M9.6 9.6l3.9 3.9' }),
    ],
  );
}

/** 设置入口图标：滑杆，语义直白，不抢戏 */
export function iconSliders(className = '') {
  return svg(
    {
      viewBox: '0 0 16 16', width: 14, height: 14,
      fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3,
      'stroke-linecap': 'round', class: className,
      'aria-hidden': 'true', focusable: 'false',
    },
    [
      shape('path', { d: 'M2.5 5h3.15M8.9 5h4.6M2.5 11h4.65M10.4 11h3.1' }),
      shape('circle', { cx: 7.25, cy: 5, r: 1.6 }),
      shape('circle', { cx: 8.75, cy: 11, r: 1.6 }),
    ],
  );
}

/** 历史入口图标：时钟。指针停在 10:10 之外，避免变成一个「笑着的脸」 */
export function iconClock(className = '') {
  return svg(
    {
      viewBox: '0 0 16 16', width: 14, height: 14,
      fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: className,
      'aria-hidden': 'true', focusable: 'false',
    },
    [
      shape('circle', { cx: 8, cy: 8, r: 5.6 }),
      shape('path', { d: 'M8 4.7V8l2.3 1.5' }),
    ],
  );
}
