/**
 * 应用装配。
 *
 * 这里是唯一把「课程格」与「Tag」两套语义接起来的地方：
 * 拖拽引擎、状态容器、四个视图彼此互不认识，全靠这个文件接线。
 *
 * 拖拽一共三条路径，都在下面的 onDrop 里分流：
 *   三区 Tag   → 课程格  布置
 *   格内作业   → 课程格  改课（颜色随新课程走）
 *   格内作业   → 三区    撤销
 */

import { createStore } from './core/store.js';
import { loadState, watchPersistence } from './core/persist.js';
import { createDragManager } from './core/dnd.js';
import { selectTag } from './core/actions.js';
import { FONT_CLASS_NAMES, fontClassName } from './data/prefs.js';
import { createToolsPanel } from './views/panel-tools.js';
import { createBoardPanel } from './views/panel-board.js';
import { createTagsPanel } from './views/panel-tags.js';
import { createKeypad } from './views/keypad.js';
import { createSettingsPanel } from './views/settings.js';
import { createHistoryPanel } from './views/panel-history.js';

const store = createStore(loadState());

/**
 * 全局偏好作用在根节点上：CSS 与 JS 读的是同一个判断。
 * 两个偏好都是「订阅 + 先手动调一次」，因为首屏渲染发生在订阅之前的就有一帧。
 */
const applyMotionPref = (state) => {
  document.documentElement.classList.toggle('reduce-motion', state.prefs.reduceMotion);
};

/** 字号只切换根节点的类名，真正的缩放全在 CSS 里（base.css 的 --fs-scale） */
const applyFontPref = (state) => {
  const next = fontClassName(state.prefs.fontScale);
  const root = document.documentElement;
  for (const name of FONT_CLASS_NAMES) {
    if (name !== next) root.classList.remove(name);
  }
  root.classList.add(next);
};

for (const apply of [applyMotionPref, applyFontPref]) {
  store.subscribe(apply);
  apply(store.getState());
}

watchPersistence(store);

let settings = null;
let history = null;
let board = null;
let tagsPanel = null;

const dnd = createDragManager({
  onDrop: ({ payload, target, ghost, ghostLeft, ghostTop }) => {
    const drop = { ghost, ghostLeft, ghostTop };

    if (target.kind === 'cell') {
      if (payload.kind === 'tag') board.place(target.subjectId, payload.tagId, drop);
      else if (payload.kind === 'assignment') {
        board.move(payload.subjectId, target.subjectId, payload.tagId, drop);
      }
      return;
    }

    if (target.kind === 'tray' && payload.kind === 'assignment') {
      // 拖回三区 = 撤销这次布置，拖影飞回它出发的那枚 Tag
      board.retract(payload.subjectId, payload.tagId, {
        ...drop,
        anchor: tagsPanel.anchorFor(payload.tagId),
      });
      return;
    }

    // 落在没有意义的地方（例如把 Tag 拖回它自己家）：什么都不改
    ghost?.remove();
  },

  onCancel: ({ ghost }) => ghost?.remove(),
});

// 键盘先建：三区要拿它当页码的输入手段
const keypad = createKeypad({ store });

board = createBoardPanel({ mount: document.getElementById('zone-board'), store, dnd });
tagsPanel = createTagsPanel({ mount: document.getElementById('zone-tags'), store, dnd, keypad });
createToolsPanel({
  mount: document.getElementById('zone-info'),
  store,
  // 抽屉一开就把键盘收掉：抽屉的遮罩压不住它（它挂在 #overlay-root，
  // 不在会被设成 inert 的 #app 里），留着会浮在抽屉上面还能点。
  onOpenSettings: () => { keypad.close(); settings.open(); },
  onOpenHistory: () => { keypad.close(); history.open(); },
});
settings = createSettingsPanel({ store });
history = createHistoryPanel({ store });

/**
 * Esc 的优先级：正在拖拽 > 页码键盘 > 设置抽屉 > 历史抽屉 > 全屏 > 取消 Tag 点选。
 * 拖拽中的 Esc 归拖拽引擎处理，这里不能抢，否则取消一次拖拽会顺手退出全屏。
 * 键盘自己没有 Esc 监听 —— 两个地方都监听会出现「按一次关掉两个东西」。
 */
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (dnd.isDragging()) return;
  if (keypad.isOpen()) { keypad.close(); return; }
  if (settings.isOpen()) { settings.close(); return; }
  if (history.isOpen()) { history.close(); return; }
  if (document.fullscreenElement) { board.exitFullscreen(); return; }
  selectTag(store, null);
});
