/**
 * 设置面板的 schema。
 *
 * 设置界面的结构完全由这份数据驱动：新增一个设置项 = 往 fields 里加一条，
 * 新增一个分区 = 往数组里加一个对象。视图（views/settings.js）不认识任何具体字段。
 *
 * 字段类型：
 *   text    文本输入，写回 state[store][key]
 *   toggle  开关，写回 state[store][key]
 *   action  执行一个已注册的动作
 *
 * desc 可以是字符串，也可以是 (state) => string，用于展示实时信息。
 */

export const SETTINGS_SCHEMA = [
  {
    id: 'about',
    title: '软件信息',
    desc: '显示在一区。留空的项目会显示为「未设置」。',
    store: 'appInfo',
    fields: [
      { key: 'name',    type: 'text', label: '名称',   placeholder: '未设置', maxLength: 24 },
      { key: 'version', type: 'text', label: '版本',   placeholder: '未设置', maxLength: 16 },
      { key: 'author',  type: 'text', label: '开发者', placeholder: '未设置', maxLength: 24 },
    ],
  },
  {
    id: 'motion',
    title: '动效',
    desc: '控制界面的过渡动画。',
    store: 'prefs',
    fields: [
      {
        key: 'reduceMotion',
        type: 'toggle',
        label: '减少动画',
        hint: '默认跟随系统设置',
      },
    ],
  },
  {
    id: 'data',
    title: '布置数据',
    desc: (state) => {
      const total = Object.values(state.assignments).reduce((sum, list) => sum + list.length, 0);
      return total > 0
        ? `当前共 ${total} 项作业布置，保存在本机浏览器中，刷新不会丢失。`
        : '当前还没有布置任何作业。布置记录保存在本机浏览器中。';
    },
    fields: [
      {
        key: 'clearAssignments',
        type: 'action',
        action: 'clearAssignments',
        label: '清空全部作业布置',
        confirmLabel: '确认清空',
        tone: 'danger',
      },
    ],
  },
];
