/**
 * 本地持久化。
 *
 * 只保存 assignments / tags / appInfo / prefs / updatedAt / history ——
 * ui 是瞬时状态，不入库。
 * 读取时逐字段校验：旧版本残留或手工改坏的 localStorage 不能让界面崩掉。
 *
 * 自定义 Tag、页码、历史记录、字号都是后加的字段，老数据里没有，
 * 缺失时按各自的默认值处理即可，不需要迁移脚本。
 *
 * 唯一算得上「迁移」的是页码搬过一次家（Tag 的属性 → 布置的属性）。
 * 那也没升版本号：`sanitizeAssignments` 直接吃两种元素形态，
 * 老存档照读不误，见那里的注释。
 */

import { SUBJECT_ORDER } from '../data/subjects.js';
import {
  DEFAULT_TAG_IDS, makeCustomTag, normalizePage, MAX_TAG_LABEL, MAX_CUSTOM_TAGS,
} from '../data/tags.js';
import { DEFAULT_FONT_STEP, isFontStep } from '../data/prefs.js';
import { HISTORY_LIMIT, MAX_HISTORY_LABEL } from './history.js';

/* 存储键**故意不跟着软件改名**：localStorage 是按 origin 隔离的，
   键一改，用户已经布置好的板子和自定义 Tag 就全看不见了。软件叫什么是软件的事，
   存档叫什么名字不该跟着动。 */
const STORAGE_KEY = 'homework-board:v1';
const WRITE_DELAY = 300;

/** 软件名。一区栏底的标题与浏览器标签都用它，只在这里定义一次。 */
export const APP_NAME = '作业发布系统';

/* 改名前的默认名。存档里存着这个字符串的，是当年那个默认值、不是用户填的
   —— 见 loadState 里的用法。 */
const LEGACY_APP_NAMES = new Set(['作业布置软件']);

/** 软件的初始状态。软件信息用中性默认值，不编造具体版本号与作者。 */
export function emptyState() {
  const assignments = {};
  for (const id of SUBJECT_ORDER) assignments[id] = [];

  return {
    assignments,
    tags: { custom: [], pages: {} },
    appInfo: { name: APP_NAME, version: '', author: '' },
    prefs: { reduceMotion: false, fontScale: DEFAULT_FONT_STEP },
    updatedAt: 0,          // 上次布置时间；0 = 还没有布置过
    history: [],           // 见 core/history.js
    ui: { selectedTagId: null },
  };
}

function sanitizeText(value, fallback, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : fallback;
}

/**
 * 软件名。改过一次名（作业布置软件 → 作业发布系统），所以这里要给老存档对齐：
 * 存档里存着**当年那个默认名**的，说明用户从来没填过这一栏，换成新名字；
 * 用户自己填过的（包括他自己就填了「作业布置软件」）一个字都不动。
 *
 * 为什么不能只改 emptyState 的默认值：默认值只在第一次打开时出现，
 * 用过一阵子的存档里早就把旧默认名写进去了，光改默认值等于没改。
 */
function sanitizeAppName(value, fallback) {
  const text = sanitizeText(value, fallback, 24);
  return LEGACY_APP_NAMES.has(text.trim()) ? fallback : text;
}

function sanitizeCustomTags(raw) {
  if (!Array.isArray(raw)) return [];

  const seen = new Set(DEFAULT_TAG_IDS);
  const out = [];

  for (const entry of raw) {
    if (out.length >= MAX_CUSTOM_TAGS) break;

    const id = typeof entry?.id === 'string' ? entry.id.slice(0, 48) : '';
    const label = sanitizeText(entry?.label, '', MAX_TAG_LABEL).replace(/\s+/g, ' ').trim();
    if (!id || !label || seen.has(id)) continue;

    seen.add(id);
    out.push(makeCustomTag(id, label));
  }

  return out;
}

/** 合法的 Tag id 集合 = 默认 Tag + 通过校验的自定义 Tag */
function validTagIds(customTags) {
  return new Set([...DEFAULT_TAG_IDS, ...customTags.map((tag) => tag.id)]);
}

/**
 * 布置记录的校验。
 *
 * **同时吃两种元素形态**，因为页码搬过一次家：以前 `assignments` 里是裸的
 * Tag id 字符串，页码统一记在旁边那张 `tags.pages` 表里（一个 Tag 一个页数，
 * 拖到哪门课都是它）；现在页码长在每条布置自己身上，元素是 `{tagId, page}`。
 *
 * 读到字符串就按「当时那个 Tag 的页数」补上 —— `bufferPages` 传的就是同一份
 * 存档里那张旧表，所以老数据读进来就是用户当初看到的样子。这样就不用版本号
 * 迁移，也不用把老用户的板子丢掉。
 *
 * @param {object} raw
 * @param {Set<string>} ids 合法的 Tag id
 * @param {object} bufferPages 旧存档里的页码表，只用来给字符串元素补页码
 */
function sanitizeAssignments(raw, ids, bufferPages) {
  const assignments = {};

  for (const subjectId of SUBJECT_ORDER) {
    const list = Array.isArray(raw?.[subjectId]) ? raw[subjectId] : [];
    const out = [];
    const seen = new Set();

    for (const item of list) {
      const legacy = typeof item === 'string';
      const tagId = legacy ? item : item?.tagId;

      // 去重 + 剔除已经不存在的 Tag id。以 tagId 去重而不是整个元素：
      // 同一门课里同一枚 Tag 只能有一条（见 core/actions.js 的 hasTag）。
      if (typeof tagId !== 'string' || !ids.has(tagId) || seen.has(tagId)) continue;
      seen.add(tagId);

      out.push({ tagId, page: normalizePage(legacy ? bufferPages?.[tagId] : item?.page) });
    }

    assignments[subjectId] = out;
  }

  return assignments;
}

function sanitizePages(raw, ids) {
  const pages = {};
  if (!raw || typeof raw !== 'object') return pages;

  for (const [tagId, value] of Object.entries(raw)) {
    if (!ids.has(tagId)) continue;
    const page = normalizePage(value);
    if (page !== null) pages[tagId] = page;
  }

  return pages;
}

export function loadState() {
  const base = emptyState();
  let saved = null;

  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    saved = null;
  }

  if (!saved || typeof saved !== 'object') return base;

  // 顺序有依赖：先定下 Tag 集合，再拿它校验页码与布置记录 ——
  // 布置记录要用页码表给老格式的字符串元素补页码
  const custom = sanitizeCustomTags(saved.tags?.custom);
  const ids = validTagIds(custom);
  const pages = sanitizePages(saved.tags?.pages, ids);

  return {
    assignments: sanitizeAssignments(saved.assignments, ids, pages),
    tags: { custom, pages },
    appInfo: {
      name: sanitizeAppName(saved.appInfo?.name, base.appInfo.name),
      version: sanitizeText(saved.appInfo?.version, '', 16),
      author: sanitizeText(saved.appInfo?.author, '', 24),
    },
    prefs: {
      reduceMotion: saved.prefs?.reduceMotion === true,
      // 老数据没有这个字段，落到标准档 —— 也就是它本来一直显示的样子
      fontScale: isFontStep(saved.prefs?.fontScale) ? saved.prefs.fontScale : DEFAULT_FONT_STEP,
    },
    updatedAt: Number.isFinite(saved.updatedAt) && saved.updatedAt > 0 ? saved.updatedAt : 0,
    history: sanitizeHistory(saved.history, ids),
    ui: { selectedTagId: null },
  };
}

/**
 * 历史快照的校验。
 *
 * 快照里引用的自定义 Tag 可能已经被删掉了（删 Tag 只清理当下这一份布置记录，
 * 不去翻旧账），这里按当前的 Tag 集合过滤 —— 被删掉的东西不该从历史里回来。
 * 编号一律重排成 1..n：编号只需要在这一份列表里唯一，重排比修复更省事。
 *
 * 老快照里同样有 `pages` 那张表 + 字符串元素，同样按布置记录那条路补页码；
 * 新的快照没有 pages 字段，`sanitizePages(undefined)` 给空表，不影响。
 */
function sanitizeHistory(raw, ids) {
  if (!Array.isArray(raw)) return [];

  const out = [];
  for (const entry of raw) {
    const at = Number.isFinite(entry?.at) && entry.at > 0 ? entry.at : 0;
    if (!at) continue;

    out.push({
      at,
      label: sanitizeText(entry?.label, '', MAX_HISTORY_LABEL),
      assignments: sanitizeAssignments(entry?.assignments, ids, sanitizePages(entry?.pages, ids)),
    });
  }

  return out.slice(-HISTORY_LIMIT).map((entry, i) => ({ id: i + 1, ...entry }));
}

/**
 * 订阅 store 并在空闲时落盘。
 * 直接写 localStorage 会在连续输入时产生同步 IO 抖动，所以做一次合并。
 */
export function watchPersistence(store) {
  let timer = null;

  const flush = () => {
    timer = null;
    const { assignments, tags, appInfo, prefs, updatedAt, history } = store.getState();
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ assignments, tags, appInfo, prefs, updatedAt, history }),
      );
    } catch {
      /* 隐私模式或配额用尽：功能照常，只是这次没存下 */
    }
  };

  store.subscribe(() => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, WRITE_DELAY);
  });

  window.addEventListener('pagehide', () => {
    if (timer !== null) {
      clearTimeout(timer);
      flush();
    }
  });
}
