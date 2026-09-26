/**
 * 全部业务写操作的唯一入口。
 * 视图与拖拽引擎都不直接改 state，只调用这里的动作。
 *
 * Tag 是否合法依赖 state（用户可以自建 Tag），所以校验放在 producer 内部，
 * 用当前 state 合成一次索引来判断，而不是拿一份静态 id 表。
 */

import { SUBJECT_ORDER, getSubject } from '../data/subjects.js';
import {
  buildTagIndex, makeCustomTag, normalizePage, tagDisplay, MAX_TAG_LABEL, MAX_CUSTOM_TAGS,
} from '../data/tags.js';
import { pushSnapshot, nextSnapshotId, sameAssignments } from './history.js';
import { formatStamp } from './time.js';

const SUBJECT_IDS = new Set(SUBJECT_ORDER);

const indexOf = (state) => buildTagIndex(state.tags?.custom ?? []);

const glyphOf = (subjectId) => getSubject(subjectId)?.glyph ?? subjectId;

/**
 * 一条布置的历史写法。页码要显式传进来，不能去读 state.tags.pages ——
 * 那张表现在只是三区的输入缓冲，跟已经落在格子里的条目早就没关系了：
 * 写「撤下必刷题」的时候去读缓冲，读到的可能是用户正在给下一门课填的页数。
 */
const tagTextOf = (state, tagId, page) => tagDisplay(indexOf(state).get(tagId), page);

function withSubject(state, subjectId, list) {
  return { ...state.assignments, [subjectId]: list };
}

const listOf = (state, subjectId) => state.assignments[subjectId] ?? [];

const entryOf = (list, tagId) => list.find((item) => item.tagId === tagId) ?? null;

const hasTag = (list, tagId) => list.some((item) => item.tagId === tagId);

/**
 * 把一枚 Tag 在三区填的那个页码消费掉：布置完成，输入缓冲清空。
 *
 * 「页码每次用过就重置」就落在这里 —— 而且是只在这里。撤销、改课、清空、
 * 恢复历史都不碰缓冲：那些动作没有「用掉」谁的页码，硬要一起清的话，
 * 用户点一下撤销就会把手里正填着的数字弄没。
 */
function consumePage(state, tagId) {
  if (!(tagId in state.tags.pages)) return state.tags.pages;
  const pages = { ...state.tags.pages };
  delete pages[tagId];
  return pages;
}

/* -------------------------------------------------------------- 改动收尾 */

function makeEntry(history, label, assignments, pages, at) {
  return { id: nextSnapshotId(history), at, label, assignments, pages };
}

/**
 * 布置类改动的统一收尾：盖「上次布置」时间戳 + 记一条历史。
 *
 * 所有改动作业的动作都必须走这里，不要各自去拼 {...state, assignments} ——
 * 时间戳和历史记录漏一个地方就会出现「板子变了但历史没记」的静默不一致。
 *
 * 注意这里没有「放好之后清页码」的钩子，那是故意的：本函数是所有改动的漏斗，
 * 撤销、改课、清空、恢复历史都经过它，挂在这里就会误伤。清缓冲只属于
 * 「把 Tag 放进格子」这一个动作，见 assignTag / assignTagToAllSubjects 里的
 * consumePage。
 *
 * @param {object} state
 * @param {object} assignments 改动后的布置记录
 * @param {string} label       这条历史怎么写
 * @param {number} at
 * @param {object} pages       改动后的三区页码缓冲；不传就保持原样
 */
function commit(state, assignments, label, at = Date.now(), pages = state.tags.pages) {
  let history = state.history;

  // 头一次改动时，把改动前的样子也留一条。否则「清空全部」按错就再无退路：
  // 那条快照是唯一一次能退回改动前的机会（history 一旦非空就不再补）。
  if (history.length === 0) {
    history = pushSnapshot(history, makeEntry(history, '改动前', state.assignments, state.tags.pages, at));
  }

  return {
    ...state,
    assignments,
    tags: pages === state.tags.pages ? state.tags : { ...state.tags, pages },
    updatedAt: at,
    history: pushSnapshot(history, makeEntry(history, label, assignments, pages, at)),
  };
}

/* -------------------------------------------------------------- 布置 / 撤下 */

/**
 * 布置作业。同一门课同一枚 Tag 只保留一条，重复布置返回 false。
 *
 * 页码从三区的输入缓冲取一次，写进这条布置自己身上（之后就各记各的），
 * 并把缓冲清空 —— 下一次布置重新填。
 */
export function assignTag(store, subjectId, tagId) {
  if (!SUBJECT_IDS.has(subjectId)) return false;

  return store.update((state) => {
    if (!indexOf(state).has(tagId)) return state;
    const list = listOf(state, subjectId);
    if (hasTag(list, tagId)) return state;

    const page = state.tags.pages[tagId] ?? null;
    return commit(
      state,
      withSubject(state, subjectId, [...list, { tagId, page }]),
      `${glyphOf(subjectId)} 布置 ${tagTextOf(state, tagId, page)}`,
      undefined,
      consumePage(state, tagId),
    );
  });
}

/** 撤下一条作业布置 */
export function unassignTag(store, subjectId, tagId) {
  if (!SUBJECT_IDS.has(subjectId)) return false;

  return store.update((state) => {
    const list = listOf(state, subjectId);
    const entry = entryOf(list, tagId);
    if (!entry) return state;
    return commit(
      state,
      withSubject(state, subjectId, list.filter((item) => item.tagId !== tagId)),
      `${glyphOf(subjectId)} 撤下 ${tagTextOf(state, tagId, entry.page)}`,
    );
  });
}

/**
 * 把一条布置从一门课挪到另一门课。页码跟着这条布置一起走。
 * 目标课已经有同一枚 Tag 时只做移除，不会出现两条。
 */
export function moveAssignment(store, fromSubjectId, toSubjectId, tagId) {
  if (!SUBJECT_IDS.has(fromSubjectId) || !SUBJECT_IDS.has(toSubjectId)) return false;
  if (fromSubjectId === toSubjectId) return false;

  return store.update((state) => {
    const from = listOf(state, fromSubjectId);
    const entry = entryOf(from, tagId);
    if (!entry) return state;

    const assignments = { ...state.assignments, [fromSubjectId]: from.filter((item) => item.tagId !== tagId) };
    const to = listOf(state, toSubjectId);
    if (!hasTag(to, tagId)) assignments[toSubjectId] = [...to, entry];

    return commit(
      state,
      assignments,
      `${tagTextOf(state, tagId, entry.page)} 从 ${glyphOf(fromSubjectId)} 改到 ${glyphOf(toSubjectId)}`,
    );
  });
}

/**
 * 一键把一枚 Tag 布置给全部六门课。
 *
 * 只发一次 store.update，而不是循环调六次 assignTag：那样会通知六轮、
 * 渲染六轮，还会把持久化的防抖计时器反复重置。已经有的课跳过，重复点不会叠加。
 * 六门课拿到的是同一个页码 —— 用户只填了一次，这条布置本来就只填了一个页数。
 */
export function assignTagToAllSubjects(store, tagId) {
  return store.update((state) => {
    const index = indexOf(state);
    if (!index.has(tagId)) return state;

    const page = state.tags.pages[tagId] ?? null;
    const assignments = { ...state.assignments };
    let added = 0;

    for (const subjectId of SUBJECT_ORDER) {
      const list = assignments[subjectId] ?? [];
      if (hasTag(list, tagId)) continue;
      assignments[subjectId] = [...list, { tagId, page }];
      added += 1;
    }

    if (added === 0) return state;
    return commit(
      state,
      assignments,
      `全部课程 布置 ${tagTextOf(state, tagId, page)}`,
      undefined,
      consumePage(state, tagId),
    );
  });
}

export function clearAssignments(store) {
  return store.update((state) => {
    const isEmpty = SUBJECT_ORDER.every((id) => (state.assignments[id] ?? []).length === 0);
    if (isEmpty) return state;

    const assignments = {};
    for (const id of SUBJECT_ORDER) assignments[id] = [];
    return commit(state, assignments, '清空全部');
  });
}

/* ---------------------------------------------------------------- 历史 */

/**
 * 把板子退回某一条历史记录。
 *
 * 恢复的是「那一刻的整块板子」：每条布置连着它自己的页码一起回去，否则快照
 * 摘要写着「必刷题-20页」、恢复出来却是没页码的，对不上。
 * 恢复本身也记一条历史，所以恢复之后还能再恢复回来。
 *
 * 三区的输入缓冲不在快照里，恢复也不动它 —— 它是「用户手里正填着的东西」，
 * 不是板子的一部分，跟 Tag 名输入框里没提交的草稿是一类。所以 commit 这里
 * 不传 pages 实参，走默认的「缓冲保持原样」。
 *
 * 快照里可能留着已经被删掉的自定义 Tag，一律按当前 Tag 集合过滤一遍 ——
 * 历史不该把删掉的东西带回来。
 */
export function restoreSnapshot(store, snapshotId) {
  return store.update((state) => {
    const entry = state.history.find((item) => item.id === snapshotId);
    if (!entry) return state;

    const index = indexOf(state);

    const assignments = {};
    for (const subjectId of SUBJECT_ORDER) {
      assignments[subjectId] = (entry.assignments?.[subjectId] ?? [])
        .filter((item) => index.has(item.tagId))
        .map((item) => ({ tagId: item.tagId, page: item.page ?? null }));
    }

    // 已经停在这一刻了：不写历史，也不让按钮产生「点了但没反应」的错觉
    if (sameAssignments(state.assignments, assignments)) return state;

    return commit(state, assignments, `恢复到 ${formatStamp(entry.at)} 的状态`);
  });
}

/* ------------------------------------------------------------ 自定义 Tag */

/**
 * 新建一个自定义 Tag。
 * @returns {{created: true, tag: object}
 *         | {created: false, reason: 'empty'}
 *         | {created: false, reason: 'duplicate', tagId: string}
 *         | {created: false, reason: 'full'}}
 */
export function addCustomTag(store, rawLabel) {
  const label = String(rawLabel ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LABEL);
  if (!label) return { created: false, reason: 'empty' };

  const state = store.getState();
  const index = indexOf(state);

  // 重名会让三区出现两个一模一样的 Tag，无法分辨，直接指向已有的那个
  const same = index.all.find((tag) => tag.label === label);
  if (same) return { created: false, reason: 'duplicate', tagId: same.id };

  if (state.tags.custom.length >= MAX_CUSTOM_TAGS) return { created: false, reason: 'full' };

  const tag = makeCustomTag(`ct-${Date.now().toString(36)}-${state.tags.custom.length.toString(36)}`, label);
  const changed = store.update((now) => ({
    ...now,
    tags: { ...now.tags, custom: [...now.tags.custom, tag] },
  }));

  return changed ? { created: true, tag } : { created: false, reason: 'empty' };
}

/**
 * 删除一个自定义 Tag，连同它的布置记录与页码一起清掉，不留孤儿数据。
 * 这会一并抹掉它已布置的每一条，所以也要记一条历史 —— 删错了还能退回来。
 */
export function removeCustomTag(store, tagId) {
  return store.update((state) => {
    const tag = state.tags.custom.find((item) => item.id === tagId);
    if (!tag) return state;

    const assignments = {};
    for (const subjectId of SUBJECT_ORDER) {
      assignments[subjectId] = (state.assignments[subjectId] ?? []).filter((item) => item.tagId !== tagId);
    }

    const pages = { ...state.tags.pages };
    delete pages[tagId];

    const next = {
      ...state,
      tags: { custom: state.tags.custom.filter((item) => item.id !== tagId), pages },
      ui: state.ui.selectedTagId === tagId ? { ...state.ui, selectedTagId: null } : state.ui,
    };

    return commit(next, assignments, `删除「${tag.label}」及其布置`);
  });
}

/* ------------------------------------------------------------------ 页码 */

/** 写一个 Tag 的页码。传空或非法值表示清空。默认 Tag 与自定义 Tag 一视同仁。 */
export function setTagPage(store, tagId, rawPage) {
  const page = normalizePage(rawPage);

  return store.update((state) => {
    const tag = indexOf(state).get(tagId);
    if (!tag) return state;

    const before = state.tags.pages[tagId] ?? null;
    if (before === page) return state;

    const pages = { ...state.tags.pages };
    if (page === null) delete pages[tagId];
    else pages[tagId] = page;

    return { ...state, tags: { ...state.tags, pages } };
  });
}

/* -------------------------------------------------------------- 其他设置 */

/** 写一区「软件信息」里的一项 */
export function setAppInfo(store, key, value) {
  return store.update((state) => {
    if (state.appInfo[key] === value) return state;
    return { ...state, appInfo: { ...state.appInfo, [key]: value } };
  });
}

/** 写一项偏好设置 */
export function setPref(store, key, value) {
  return store.update((state) => {
    if (state.prefs[key] === value) return state;
    return { ...state, prefs: { ...state.prefs, [key]: value } };
  });
}

/** 点选中的便捷 Tag（点选后点击课程即可布置） */
export function selectTag(store, tagId) {
  return store.update((state) => {
    if (state.ui.selectedTagId === tagId) return state;
    // 已经被删掉的 Tag 不允许被选中
    if (tagId !== null && !indexOf(state).has(tagId)) return state;
    return { ...state, ui: { ...state.ui, selectedTagId: tagId } };
  });
}
