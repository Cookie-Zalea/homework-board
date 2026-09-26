/**
 * 界面上可调的偏好档位。
 *
 * 字号是这里唯一有「档位」概念的东西：它需要在三个地方保持一致 ——
 * 功能区要画出四个按钮、持久化要判断存进来的值合不合法、自检要按档位
 * 断言计算后的字号。所以清单放在这里，三方共用一份。
 *
 * 注意：真正决定「紧凑 = 0.9 倍」的是 base.css 里的 --fs-scale，
 * 不是这个文件。这里只有 id 与中文名。CSS 是缩放的唯一实现处。
 */

export const FONT_STEPS = [
  { id: 'compact',  label: '紧凑' },
  { id: 'standard', label: '标准' },
  { id: 'large',    label: '大' },
  { id: 'xlarge',   label: '特大' },
];

/** 标准档就是现在这个样子，也是旧数据没有这个字段时的落点 */
export const DEFAULT_FONT_STEP = 'standard';

export function isFontStep(id) {
  return FONT_STEPS.some((step) => step.id === id);
}

/**
 * 档位对应的根节点类名。
 * 缩放写成类而不是内联样式，是为了让窄屏的媒体查询还能把它压回来 ——
 * 内联的 --fs-scale 优先级高于任何样式表规则，加上去就再也改不动了。
 */
export function fontClassName(id) {
  return `fs-${isFontStep(id) ? id : DEFAULT_FONT_STEP}`;
}

/** 全部档位类名，用于切换时先摘干净 */
export const FONT_CLASS_NAMES = FONT_STEPS.map((step) => fontClassName(step.id));
