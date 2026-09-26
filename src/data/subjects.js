/**
 * 六门课程的唯一数据源。
 *
 * 课程名称、课程颜色、在二区 2×3 网格中的固定位置都只在这里定义。
 * 视图不硬编码任何一门课，改这一处即可全局生效。
 *
 * 颜色是硬性映射，不得交换：
 *   语 = 红   数 = 蓝   外 = 黄   物 = 浅蓝   化 = 紫   生 = 绿
 *
 * 每个色相给出五个层次，只是同一色相的明度/饱和度变化，色相类别不变：
 *   hue   主色，用于课程色条 —— 识别课程
 *   deep  深色，用于 Tag 文字 —— 保证可读性
 *   tint  Tag 底色
 *   edge  Tag 描边
 *   drop  拖拽悬停时的格底
 */

/**
 * slot 对应参考图片2 的格位编号：
 *   1 左上  2 左中  3 左下      4 右上  5 右中  6 右下
 */
export const SUBJECTS = [
  {
    id: 'yu',
    glyph: '语',
    slot: 1,
    color: { hue: '#c4392f', deep: '#93261e', tint: '#fceeec', edge: '#eec6c1', drop: '#fbe3e0' },
  },
  {
    id: 'shu',
    glyph: '数',
    slot: 2,
    color: { hue: '#1f5fa9', deep: '#17477c', tint: '#ecf2fa', edge: '#c5d7ed', drop: '#dee9f7' },
  },
  {
    id: 'wai',
    glyph: '外',
    slot: 3,
    color: { hue: '#cc9508', deep: '#8a6200', tint: '#fdf4e0', edge: '#efdcaa', drop: '#fbecc6' },
  },
  {
    id: 'wu',
    glyph: '物',
    slot: 4,
    color: { hue: '#3f96c8', deep: '#2c6f97', tint: '#eaf5fb', edge: '#c2dff0', drop: '#d8ecf7' },
  },
  {
    id: 'hua',
    glyph: '化',
    slot: 5,
    color: { hue: '#7a4fa8', deep: '#5c3a82', tint: '#f3edfa', edge: '#dbc9ef', drop: '#ebe0f6' },
  },
  {
    id: 'sheng',
    glyph: '生',
    slot: 6,
    color: { hue: '#3f7d3a', deep: '#2e5d2a', tint: '#edf5eb', edge: '#c8dfc3', drop: '#dbedda' },
  },
];

const BY_ID = new Map(SUBJECTS.map((subject) => [subject.id, subject]));

/** 六门课程的 id，顺序即 slot 1→6 */
export const SUBJECT_ORDER = SUBJECTS.map((subject) => subject.id);

/** 左列（slot 1-3）与右列（slot 4-6），二区的两个表格块 */
export const SUBJECT_COLUMNS = [
  SUBJECTS.filter((subject) => subject.slot <= 3),
  SUBJECTS.filter((subject) => subject.slot > 3),
];

export function getSubject(id) {
  return BY_ID.get(id) ?? null;
}
