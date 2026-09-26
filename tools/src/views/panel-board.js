/**
 * 二区：课表与作业布置情况预览。
 *
 * 布局固定为 2 列 × 3 行共六个课程区域（参考图片2），中间一条窄分隔带。
 * 六个格位、六门课程、六种颜色全部来自 data/subjects.js，本文件不含任何
 * 课程相关的硬编码。
 *
 * 每个课程格同时是：
 *   - 课表预览（课程名 + 课程色条）
 *   - 作业布置状态预览（格内作业条目 + 计数）
 *   - 作业 Tag 的接收区（拖进来 = 布置）
 * 格内每一条作业本身又是拖拽源（拖回三区 = 撤销，拖到别的课 = 改课）。
 * 条目的颜色不自己定义，全部继承所在课程格的 --tint / --deep / --edge，
 * 所以「拖到哪门课就长哪门课的颜色」是布局本身的结果，不需要额外逻辑。
 */

import { el, replayAnimation } from '../core/dom.js';
import { SUBJECTS, SUBJECT_COLUMNS } from '../data/subjects.js';
import { buildTagIndex, tagDisplay, splitTagText } from '../data/tags.js';
import { flip, prefersReducedMotion } from '../core/flip.js';
import { inheritCustomProps } from '../core/dnd.js';
import { assignTag, unassignTag, moveAssignment } from '../core/actions.js';
import { iconClose, iconExpand, iconCollapse } from './icons.js';

/**
 * 飞行的缓动。**故意不是** base.css 里那条全局的 --ease（.22,.61,.36,1 的快出曲线）。
 *
 * 飞行是被「松手」这一帧推着起跑的，而这一帧主线程要忙 20ms 上下（插条目、
 * 重量那一格、建落点层、强制回流），浏览器画不出中途帧 —— 拖影会在松手点原地
 * 停住十几毫秒。快出曲线在这段停顿之后，第一帧就要走完全程的一成半（实测
 * 142px 的位移，首帧 22.4px）：停顿 + 猛冲，看上去就是「卡一下」。
 *
 * 起手轻的曲线把同一段停顿压到 3px，之后平滑加速，峰值速度与原来相当，
 * 停顿就消失了（实测首帧 22.4px → 3.3px，见 README）。停顿本身消不掉：
 * 那是布置一枚条目必做的活，只能让它看不见。
 */
const FLIGHT_EASE = 'cubic-bezier(.3,.05,.2,1)';
const LANDING_MS = 220;   // 拖影飞向格内条目的基准时长，见 landingMs()
const RETURN_MS = 190;    // 拖影飞回三区：只是平移，不带着「看清变大」的任务
const REVEAL_AT = .76;    // 揭示真实条目的时机（占飞行的比例），见 completeDrop

const keyOf = (subjectId, tagId) => `${subjectId}:${tagId}`;

export function createBoardPanel({ mount, store, dnd }) {
  const cells = new Map();   // subjectId -> { subject, root, slots, count }
  const chips = new Map();   // "subjectId:tagId" -> 格内作业条目元素
  let pending = null;        // 下一枚条目以「待落位」状态出生，等拖影飞到位再揭示
  let justDragged = false;   // 拖完落回课程格时浏览器补发的 click 要吞掉

  /* Tag 索引按 state 缓存：每次渲染都重建一份 Map 是白费，但引用变了就得换 */
  let tagIndex = buildTagIndex([]);
  let tagSource = null;
  function indexFor(state) {
    if (state.tags.custom !== tagSource) {
      tagSource = state.tags.custom;
      tagIndex = buildTagIndex(tagSource);
    }
    return tagIndex;
  }

  const note = el('span', { class: 'panel-head__note' });
  const board = el('div', { class: 'board' });

  /* ------------------------------------------------------------ 全屏入口 */

  let fsIcon = iconExpand('head-btn__icon');
  const fsText = el('span', { class: 'head-btn__text', text: '全屏' });
  const fsButton = el('button', {
    class: 'head-btn',
    type: 'button',
    'aria-pressed': 'false',
    on: { click: () => toggleFullscreen() },
  }, [fsIcon, fsText]);

  /** 只让作业安排表这一块进全屏；数据、布局、Tag 状态都不参与，只是换个显示区域 */
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await mount.requestFullscreen();
    } catch {
      /* 浏览器或环境拒绝时保持现状，不改变任何界面状态 */
    }
  }

  function exitFullscreen() {
    if (!document.fullscreenElement) return;
    document.exitFullscreen().catch(() => {});
  }

  function syncFullscreen() {
    const on = document.fullscreenElement === mount;
    mount.classList.toggle('is-fullscreen', on);
    fsText.textContent = on ? '退出全屏' : '全屏';
    fsButton.setAttribute('aria-pressed', String(on));
    fsButton.setAttribute('aria-label', on ? '退出全屏' : '全屏显示作业安排表');

    const next = on ? iconCollapse('head-btn__icon') : iconExpand('head-btn__icon');
    fsIcon.replaceWith(next);
    fsIcon = next;
  }

  document.addEventListener('fullscreenchange', syncFullscreen);

  /* ---------------------------------------------------------------- 骨架 */

  for (const column of SUBJECT_COLUMNS) {
    const block = el('div', { class: 'board-block' });
    for (const subject of column) {
      const cell = createCell(subject);
      block.append(cell.root);
      cells.set(subject.id, cell);
    }
    board.append(block);
  }

  mount.append(
    el('div', { class: 'panel-head' }, [
      el('h2', { class: 'panel-head__title', text: '课表与作业布置' }),
      note,
    ]),
    el('div', { class: 'board-body' }, [board]),
    // 全屏入口在页脚而不是标题条上（用户：「全屏改到二区下方」）。页脚仍在
    // mount 里面 —— 进全屏之后它是唯一的出口（Esc 之外），跟着 mount 一起
    // 被撑满，位置不变、也仍然够得着。
    el('div', { class: 'panel-foot' }, [fsButton]),
  );

  /* -------------------------------------------------------------- 课程格 */

  function createCell(subject) {
    const count = el('span', { class: 'course-cell__count' });
    const slots = el('div', { class: 'course-cell__slots' });

    // 科目名、作业条目并排在一行里。条目因此能用到整格的高度，而不是
    // 「科目名底下剩下的那一条」—— 那是它此前放不下的原因，见 board.css。
    // 计数缩在科目名底下，不再占一行里的宽度：它和条目抢的是同一寸地方，
    // 而科目名底下本来就是空的。大/特大档差这一寸，条目名字就只剩一个字。
    const root = el('div', {
      class: 'course-cell',
      role: 'group',
      dataset: { subject: subject.id },
    }, [
      el('div', { class: 'course-cell__lead' }, [
        el('span', { class: 'course-cell__glyph', text: subject.glyph }),
        count,
      ]),
      slots,
    ]);

    // 课程颜色的唯一注入点。CSS 只消费 --hue / --deep / --tint / --edge / --drop，
    // 换颜色只需要改 data/subjects.js，不必碰任何样式文件。
    for (const [token, value] of Object.entries(subject.color)) {
      root.style.setProperty(`--${token}`, value);
    }

    root.addEventListener('click', () => activateCell(subject.id));
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activateCell(subject.id);
    });

    // 注册为放置目标：拖拽引擎只知道「这是一块区域」，课程语义由这里赋予
    dnd.registerTarget(root, { kind: 'cell', subjectId: subject.id });

    return { subject, root, slots, count };
  }

  function activateCell(subjectId) {
    if (justDragged) return;
    const tagId = store.getState().ui.selectedTagId;
    if (!tagId) return;
    place(subjectId, tagId, null);
  }

  /* ------------------------------------------------------------ 布置作业 */

  /**
   * 布置作业。拖拽与点选两条路径都走这里。
   * @param {object|null} drop 拖拽落位信息；点选路径传 null
   */
  function place(subjectId, tagId, drop) {
    const state = store.getState();
    if (!indexFor(state).has(tagId)) {
      drop?.ghost?.remove();
      return;
    }

    const isNew = !(state.assignments[subjectId] ?? []).some((item) => item.tagId === tagId);
    if (!isNew) {
      flashChip(subjectId, tagId, drop);
      return;
    }

    pending = { subjectId, tagId };
    assignTag(store, subjectId, tagId);   // 触发渲染，条目以 is-pending 出生
    completeDrop(subjectId, tagId, drop); // 再量测、飞行、揭示
  }

  /** 三区 → 二区：撤销这条布置，拖影飞回它在三区的出发点 */
  function retract(subjectId, tagId, drop) {
    if (!chips.has(keyOf(subjectId, tagId))) {
      drop?.ghost?.remove();
      return;
    }

    unassignTag(store, subjectId, tagId);

    const anchor = drop?.anchor;
    if (!drop?.ghost || !anchor || prefersReducedMotion()) {
      drop?.ghost?.remove();
      return;
    }

    // 回程也走同一套：出发层是那枚条目，落点层克隆自它要回去的那枚 Tag
    // （所以回程是「从条目的大小缩回 Tag 的大小」，尺寸同样最后落在 Tag 上）
    flyGhost(drop.ghost, drop, anchor, RETURN_MS, fontRatio(drop.ghost, anchor));
  }

  /** 格 → 格：把一条作业改到另一门课，颜色随新课程走 */
  function move(fromSubjectId, toSubjectId, tagId, drop) {
    if (fromSubjectId === toSubjectId) {
      drop?.ghost?.remove();
      return;
    }

    const alreadyThere = (store.getState().assignments[toSubjectId] ?? [])
      .some((item) => item.tagId === tagId);
    pending = alreadyThere ? null : { subjectId: toSubjectId, tagId };

    if (!moveAssignment(store, fromSubjectId, toSubjectId, tagId)) {
      pending = null;
      drop?.ghost?.remove();
      return;
    }

    // 目标课本来就有这枚：这次只相当于撤下，让已有那枚闪一下说明情况
    if (alreadyThere) flashChip(toSubjectId, tagId, drop);
    else completeDrop(toSubjectId, tagId, drop);
  }

  function completeDrop(subjectId, tagId, drop) {
    const chip = chips.get(keyOf(subjectId, tagId));
    pending = null;

    if (!chip) {
      drop?.ghost?.remove();
      return;
    }

    if (!drop?.ghost || prefersReducedMotion()) {
      drop?.ghost?.remove();
      reveal(chip);
      return;
    }

    const grow = fontRatio(drop.ghost, chip);
    const ms = landingMs(grow);
    flyGhost(drop.ghost, drop, chip, ms, grow);
    // 揭示的时机按「落点层长到哪儿了」定，不是按时间拍脑袋：FLIGHT_EASE 下
    // 76% 那一刻落点层长到了九成六（和换曲线之前 70% 那一下的进度相同），
    // 剩下的这点和真实条目的淡入重叠交接 —— 落点层的终点就是这枚条目的 rect，
    // 所以看上去只是「拖影松手，条目接手」，中间不会出现两个尺寸的双影。
    // grow: false —— 变大归拖影的落点层管，条目只做淡入 + 落位，不再二次放大。
    setTimeout(() => reveal(chip, { grow: false }), Math.round(ms * REVEAL_AT));
  }

  /**
   * 「拖过去之后变大」到底变多少：两个元素**字号**之比。
   *
   * 不按盒子高矮算。盒子高矮里混着内边距和那个撤下键，量出来的不是「字变大了
   * 多少」；条目的上下留白比 Tag 薄（要挤进格子里，见 board.css），照高矮算
   * 特大档只有 0.87 —— 拖影会在飞过去的路上**缩**一下，正好反了。
   * 字号之比才是「字变大了多少」本身。
   *
   * 这个比值从前恒定是 1.2（Tag 0.75 × 科目大字，条目 0.9 × 科目大字），
   * Tag 固定成 2.484cqh（≈20px）之后逐档不同：紧凑 1.17、标准 1.70、大 2.46、
   * 特大 3.55（实测，见 README）。所以它必须现读，不能写死。格→格两边都是
   * 条目，得 1；格→三区反过来得 Tag÷条目，四档在 0.28~0.85 之间，自动就对。
   *
   * 现读的另一个理由：后手是元素上现成的值 —— 拖影的字号在 dnd.js 里被钉成了
   * 出发时的值，目标元素的字号里则叠着它自己那格的 --fit。
   *
   * 这个比值现在的用处是「落点层起步缩多少」：落点层要长到 1，起步就得是它的
   * 倒数 1/grow（见 flyGhost）。所以它只影响落点的**起点**，终点由落点元素自己
   * 的 rect 直接给出 —— 放大倍数算错也只是起点不齐，终点仍然是严丝合缝的。
   */
  function fontRatio(fromEl, toEl) {
    const from = parseFloat(getComputedStyle(fromEl).fontSize);
    const to = parseFloat(getComputedStyle(toEl).fontSize);
    return from > 0 && to > 0 && Number.isFinite(from) && Number.isFinite(to) ? to / from : 1;
  }

  /**
   * 落位要飞多久。倍数越大给的时间越长 —— 「从小变大」既然要做成看得见的过程，
   * 3.55 倍和 1.17 倍就不能用同一个时长（用户：「从三区到二区，从小变大的过程
   * 要做动画」）。用 log2 是因为观感上的「大了一截」是按倍数走的：
   * 紧凑 1.17 倍 → 约 233ms，标准 1.70 倍 → 约 262ms，特大 3.55 倍 → 约 321ms。
   * 回程不走这里：它是从大往小，也没有让人看清的任务。
   */
  function landingMs(grow) {
    const span = grow > 1 ? Math.log2(grow) : 0;
    return Math.round(LANDING_MS * (1 + span * .25));
  }

  /**
   * 条目入场时的起始缩放 =「三区 Tag 字号 ÷ 条目字号」，交给 board.css 的 chip-in。
   *
   * 现读，不预先算好写进 CSS：Tag 的字号随窗口高度走，条目的字号里又叠着
   * 本格的 --fit，只有揭示这一刻量到的才是准的（调用方 fitCell 已经先把
   * --fit 定下来了）。三区还没有 Tag 时退回 .83，也就是「标准」档那个老值。
   */
  function enterScale(chip) {
    const tag = document.querySelector('.tags-body .tag');
    if (!tag) return .83;
    const ratio = fontRatio(tag, chip);      // 条目 ÷ Tag
    return ratio > 0 ? 1 / ratio : .83;
  }

  /**
   * 落点那一层：克隆一个目标元素，让它起步时正好是出发元素的字号。
   *
   * 盒子按目标的 rect 钉死（宽高与居中偏移都写死），里面的克隆体保持自然尺寸
   * —— 克隆体与目标同内容、同字号，自然尺寸就是那个 rect，所以缩放走到 1 时
   * 它和真实条目严丝合缝：不过界、不被 max-width 截、也用不上省略号。
   */
  function buildArrival(ghost, toEl, toRect, fromScale) {
    const layer = el('div', { class: 'drag-ghost__arrival' });
    layer.style.width = `${toRect.width}px`;
    layer.style.height = `${toRect.height}px`;
    layer.style.marginLeft = `${-toRect.width / 2}px`;
    layer.style.marginTop = `${-toRect.height / 2}px`;
    layer.style.setProperty('--arrival-from', String(fromScale));

    // 颜色与字号都挂在祖先上，克隆体搬出来就是孤儿，得自己带上：自定义属性管
    // 颜色（--tint / --deep / --edge），font-size 管盒子的每一个 em（内边距、
    // 间距、撤下键的尺寸）。少一样它就不像目标了。
    inheritCustomProps(toEl, layer);

    const clone = toEl.cloneNode(true);
    // 目标身上可能挂着只属于「还在原位的那一枚」的状态类，克隆体一律摘掉
    for (const cls of ['is-pending', 'is-entering', 'is-flash', 'is-dragging', 'is-selected', 'is-created']) {
      clone.classList.remove(cls);
    }
    clone.classList.add('drag-ghost__target');
    clone.style.fontSize = getComputedStyle(toEl).fontSize;
    layer.append(clone);

    ghost.append(layer);
    return layer;
  }

  /**
   * 拖影从松手点飞向落点。外层只走 transform（只动合成层，跟手），里面的两层
   * 做交叉交接 —— 「变大」是落点那一层长出来的，不是把出发那一层放大。
   *
   * 为什么不是放大出发层：Tag 与条目不是一个盒子（Tag 有抓手、留白也厚，同样
   * 字号下宽 1.8 倍、高 1.35 倍，实测 175×47 对 344×123）。照字号把 Tag 放大
   * 之后，拖影比落点大出一圈，交接时只好再缩回去 —— 看着就是「先变得超级大，
   * 然后再缩小成原来的样子」（用户报的毛病）。落点层克隆自目标本身，天然是
   * 条目的盒子，从 1/grow 走到 1 正好落在它上面，一格不差。
   *
   * 交叉的那一段两层**字号相同**（落点层起步就是出发层的字号），所以文字大小
   * 在交接处是连续的：变的只是外壳，抓手的厚壳褪去，化成格内那一枚。
   *
   * 两层都以自己的中心对齐拖影中心（外层本来就把两个盒子的中心对齐），
   * 所以缩放不会把落点带偏。
   */
  function flyGhost(ghost, drop, toEl, duration, grow) {
    const toRect = toEl.getBoundingClientRect();
    // 必须在写 transform 之前量：这个 rect 是缩放前的基准，写完之后就不是它了
    const from = ghost.getBoundingClientRect();

    buildArrival(ghost, toEl, toRect, grow > 0 ? 1 / grow : 1);

    // 先把拖影钉回松手时的位置并强制一次回流，保证两层都从各自的起始态出发
    ghost.style.transform = `translate3d(${drop.ghostLeft}px, ${drop.ghostTop}px, 0)`;
    ghost.style.setProperty('--landing-ms', `${duration}ms`);
    // 两层（出发层淡出、落点层长大）的节拍由 CSS 里那两条 transition 走，
    // 曲线得跟外层这条一致，否则「平移已经起手了、字号还愣着」会脱节
    ghost.style.setProperty('--landing-ease', FLIGHT_EASE);
    void ghost.offsetWidth;

    const endLeft = toRect.left + toRect.width / 2 - from.width / 2;
    const endTop = toRect.top + toRect.height / 2 - from.height / 2;

    ghost.style.transition = `transform ${duration}ms ${FLIGHT_EASE}`;
    ghost.style.transform = `translate3d(${endLeft}px, ${endTop}px, 0)`;
    ghost.classList.add('is-landing');

    setTimeout(() => ghost.remove(), duration + 60);
  }

  function flashChip(subjectId, tagId, drop) {
    drop?.ghost?.remove();
    const chip = chips.get(keyOf(subjectId, tagId));
    if (chip) replayAnimation(chip, 'is-flash');   // 已经有了，轻闪一下说明情况
  }

  /**
   * 揭示一枚条目，播入场动画。
   * @param {object} [opts]
   * @param {boolean} [opts.grow=true] 入场时要不要从三区 Tag 的大小长起来。
   *   拖拽落位这一路传 false：变大已经由拖影在飞行途中做完，这里再长一遍就是
   *   两段同时长，反而看不出是哪一段在长（用户要的正是「看得见的那一段」）。
   */
  function reveal(chip, { grow = true } = {}) {
    chip.style.setProperty('--enter-scale', grow ? String(enterScale(chip)) : '1');
    chip.classList.remove('is-pending');
    chip.classList.add('is-entering');
    chip.addEventListener('animationend', () => {
      chip.classList.remove('is-entering');
      chip.style.removeProperty('--enter-scale');   // 下一枚不必继承这一枚的起点
    }, { once: true });
  }

  /* -------------------------------------------------------------- 渲染同步 */

  /** 按 state 增量对齐一个课程格的条目：只增删差量，避免整格重建打断动画 */
  function syncCell(subjectId, state, animate = true) {
    const cell = cells.get(subjectId);
    const tags = indexFor(state);
    const list = state.assignments[subjectId] ?? [];
    const live = list.map((item) => keyOf(subjectId, item.tagId));

    // 先撤下多余的；用 FLIP 让后面的条目平移过去，而不是瞬间跳位
    const stale = [...cell.slots.children].filter((node) => !live.includes(node.dataset.key));
    if (stale.length > 0) {
      flip(
        () => [...cell.slots.children],
        () => {
          for (const node of stale) {
            chips.delete(node.dataset.key);
            node.remove();
          }
        },
      );
    }

    // 再按顺序补齐。页码从这条布置自己身上读 —— 三区那张缓冲表跟已经
    // 落地的条目没关系，改它不该动到这里的显示。
    list.forEach((item, position) => {
      const { tagId } = item;
      const key = keyOf(subjectId, tagId);
      const parts = splitTagText(tags.get(tagId), item.page);
      let node = chips.get(key);

      if (!node) {
        node = createChipNode(subjectId, tagId, parts);
        chips.set(key, node);
        cell.slots.insertBefore(node, cell.slots.children[position] ?? null);

        if (pending?.subjectId === subjectId && pending?.tagId === tagId) {
          node.classList.add('is-pending');   // 等拖影飞到位
        } else if (animate) {
          reveal(node);
        }
      } else {
        syncChipText(node, parts, cell.subject.glyph);   // 页码或名字改了
        if (cell.slots.children[position] !== node) {
          cell.slots.insertBefore(node, cell.slots.children[position] ?? null);
        }
      }
    });

    const total = list.length;
    cell.count.textContent = total > 0 ? `${total} 项` : '未布置';
    cell.count.classList.toggle('is-on', total > 0);

    const labels = list.map((item) => tagDisplay(tags.get(item.tagId), item.page));
    cell.root.setAttribute(
      'aria-label',
      `${cell.subject.glyph}：${labels.length > 0 ? labels.join('、') : '未布置'}`,
    );
  }

  /**
   * 把「名字 + 页码」两段文案同步到一条格内作业上。
   *
   * 为什么是两段而不是一条文本：见 data/tags.js 的 splitTagText —— 名字可以被
   * 省略号截短，页码不能，所以它们是两个节点。
   * aria-label 也要跟着改：它是建节点时烤进去的，只更新可见文字的话，
   * 读屏软件念出来的还是改页之前的旧页码。
   */
  function syncChipText(node, parts, glyph) {
    const labelNode = node.querySelector('.asg__label');
    const pageNode = node.querySelector('.asg__page');

    if (labelNode.textContent !== parts.label) labelNode.textContent = parts.label;
    if (pageNode.textContent !== parts.page) pageNode.textContent = parts.page;

    // 没页码时把后缀整段收起来。只看文字是不够的：空 span 自己不带宽度，
    // 但 .asg 是 flex + gap:4px，留着它就会在名字和撤下键之间多空一格。
    pageNode.hidden = parts.page === '';

    const text = parts.label + parts.page;
    node.setAttribute('aria-label', `${text}，${glyph}`);
    node.querySelector('.asg__remove').setAttribute('aria-label', `撤下 ${text}`);
  }

  function createChipNode(subjectId, tagId, parts) {
    const root = el('span', {
      class: 'asg',
      dataset: { key: keyOf(subjectId, tagId), tagId },
    }, [
      el('span', { class: 'asg__label', text: parts.label }),
      el('span', { class: 'asg__page', text: parts.page }),
      el('button', {
        class: 'asg__remove',
        type: 'button',
        on: {
          click: (event) => {
            event.stopPropagation();
            unassignTag(store, subjectId, tagId);
          },
        },
      }, [iconClose(10, 'asg__icon')]),
    ]);

    syncChipText(root, parts, cells.get(subjectId).subject.glyph);

    // 格内每一条作业都是拖拽源：拖回三区撤销，拖到别的课改课
    dnd.attachSource(root, (event) => {
      if (event.target.closest('.asg__remove')) return null;   // 点在撤下键上不算拖
      return { kind: 'assignment', subjectId, tagId };
    }, {
      onStart: () => root.classList.add('is-dragging'),
      onEnd: (wasActive) => {
        root.classList.remove('is-dragging');
        if (!wasActive) return;
        justDragged = true;
        setTimeout(() => { justDragged = false; }, 0);
      },
    });

    return root;
  }

  /** 只有点选了 Tag，课程格才进入 Tab 序列，避免留下按了没反应的焦点 */
  function syncArmed(state) {
    // 没有 Tag 可选时（例如自定义 Tag 被删光）课程格不进入可点击态
    const armed = state.ui.selectedTagId !== null;
    for (const cell of cells.values()) {
      cell.root.classList.toggle('is-armed', armed);
      if (armed) cell.root.setAttribute('tabindex', '0');
      else cell.root.removeAttribute('tabindex');
    }
  }

  function syncNote(state) {
    const done = SUBJECTS.filter((subject) => (state.assignments[subject.id] ?? []).length > 0).length;
    note.textContent = `已布置 ${done} / ${SUBJECTS.length}`;
  }

  /* ---------------------------------------------------- 装不下就自己缩小

     一格放不下所有作业时，把**这一格**的条目整体缩小，直到全都能看见 ——
     不再用滚动条把放不下的那条藏起来（.course-cell__slots 的 overflow-y 只在
     缩到下限仍然放不下时才出力，那时是真的太多了）。

     缩的是写进 --fit 的一个系数（board.css 的 .asg 乘它），写在 slots 上，所以
     只有挤的那一格让位：别的格子仍然是「0.9 × 科目大字」，三区的 Tag 一点没变。

     两件事谁更紧就按谁缩：
       竖向 —— 条目摞起来比槽位高。条目高与字号成正比，按超出比例一步压到位。
       横向 —— 某一条的内容比槽位宽（悬停才显形的那个撤下键会被挤出可视区），
               或者名字被压得连一个省略号都放不下。

     最后这一种（名字的可用宽度落在 0 到一个字之间、却还在截断）屏幕上就是竖着
     切掉半个字，看着像个错字。它有两层处理：能缩就缩（名字留成「必…」），
     缩到下限还只放得下半个字就把名字整个收起来（.is-nameless，只留页码）——
     340px 的窄屏配一条 12 字的名字 + 三位页码，就是后一种。收起名字要有页码可留，
     没页码的条目没有这一招（收完只剩一个空框，比半个字更糟），只能一直缩到下限。

     注意「名字被省略号截短」本身不算挤：那是原本就定的「名字让步，页码不让步」，
     一格一条的长名字条目该截还是截，不会因为截了就整格缩小。

     缩到下限还放不下就退回原来的滚动条。下限是绝对的 15px（和「标准」档的界面
     正文同号），不乘任何系数：字小到看不清是屏幕前的人说了算，跟格子多大、
     用户选了哪一档字号无关。 */
  const FIT_MIN_PX = 15;   // 条目字号的下限
  const FIT_STEP = .88;    // 横向那一路每一轮退的比例
  const FIT_ROUNDS = 8;    // 粗调上限，也挡住病态输入
  const FIT_FINE = 4;      // 细调的二分轮数

  /** 名字是不是被挤成了「半个字」：在截断，可宽度还不够一个字的 */
  function halfGlyph(chip) {
    const label = chip.querySelector('.asg__label');
    if (label.scrollWidth <= label.clientWidth) return false;
    return label.clientWidth < parseFloat(getComputedStyle(chip).fontSize) * .9;
  }

  /** 这一条能不能靠「把名字收起来」救 —— 得有页码可留，否则收完只剩一个空框 */
  function canDropName(chip) {
    const page = chip.querySelector('.asg__page');
    return !!page && !page.hidden;
  }

  /**
   * 「这一格装得下吗」只取决于这些输入：字号档 + 格内每一条的文案。
   *
   * 有它才能跳过白量的格子。fitCell 一次要：摘掉全格的 is-nameless、清 --fit、
   * 再读 scrollHeight/clientHeight 与每条的 scrollWidth —— 前面两笔让整格样式失效，
   * 后面几笔强制一次布局，而且 `getComputedStyle` / `getBoundingClientRect` 一旦
   * 要算样式就是**整篇文档**一起算，不是只算这一格。
   *
   * 拖一枚 Tag 进二区，六格里只有一格变了，另外五格白算一遍——这一下正好压在
   * 落位那一帧上，把 13ms 的松手处理器顶过 16ms，动画起手就掉一帧（用户报的
   * 「动画会卡一下」）。带签名之后那五格一个字都不用改、一次布局都不用读。
   *
   * 格子的宽窄、窗口大小、全屏这些**不由 state 表达**的变化，仍然走
   * ResizeObserver 那条路（不传签名，每次都量）。
   */
  function fitSignature(subjectId, state, tags) {
    const list = state.assignments[subjectId] ?? [];
    const parts = list.map((item) => {
      const text = splitTagText(tags.get(item.tagId), item.page);
      return `${text.label}\u0000${text.page}`;
    });
    return `${state.prefs.fontScale}\u0001${parts.join('\u0002')}`;
  }

  /**
   * @param {string|null} signature 这一格当前的输入指纹（见 fitSignature）。
   *   与上一次相同就直接返回 —— 输入一样，上一轮量出来的结果仍然成立。
   *   传 null 表示「必须重量」（启动、ResizeObserver）。
   */
  function fitCell(cell, signature = null) {
    if (signature !== null && signature === cell.fitSignature) return;
    // 重量之后这一格的输入指纹就是它（null 不覆盖：布局变了但输入没变，
    // 下一次 state 变化仍然该跳过）
    if (signature !== null) cell.fitSignature = signature;

    const { slots } = cell;
    const chips = [...slots.children];
    if (chips.length === 0) {
      slots.style.removeProperty('--fit');
      return;
    }

    // 先回到自然大小、名字也放回去，再量。留着上一轮的结果量到的是缩小之后的
    // 版式，会越量越小，而且撤下一条之后永远缩不回来。
    slots.style.removeProperty('--fit');
    for (const chip of chips) {
      chip.classList.remove('is-nameless');
      chip.title = '';
    }

    /** 这一格现在是不是「全都看得见」——两个方向都算 */
    const fits = () => {
      // 1px 都不放过：竖向上多出 1px 就可能顶出一条滚动条，而那正是用户不要的
      if (slots.scrollHeight > slots.clientHeight) return false;
      return !chips.some((chip) =>
        chip.scrollWidth > chip.clientWidth + 1 || halfGlyph(chip));
    };

    const natural = parseFloat(getComputedStyle(chips[0]).fontSize);
    const floor = Math.min(1, FIT_MIN_PX / natural);

    let fit = 1;
    for (let round = 0; round < FIT_ROUNDS; round++) {
      if (fits()) break;
      if (fit <= floor + .001) break;
      const tooTall = slots.scrollHeight - slots.clientHeight;
      fit = Math.max(floor, tooTall > 0
        ? fit * (slots.clientHeight / Math.max(slots.scrollHeight, 1))
        : fit * FIT_STEP);
      slots.style.setProperty('--fit', String(fit));
    }

    if (fit < 1) {
      // 上面是「先缩够」，会缩过头：一步到位是按比例估的（条目之间那 5px 行距不
      // 跟着字号缩），横向那一路更是 12% 一档退下来的。再二分几轮长回去，
      // 停在刚好放得下的那一档上 —— 用户要的是「能放下」，不是「尽量小」。
      let lo = fit;
      let hi = Math.min(1, fit * 1.25 + .02);
      for (let round = 0; round < FIT_FINE && hi - lo > .01; round++) {
        const mid = (lo + hi) / 2;
        slots.style.setProperty('--fit', String(mid));
        if (fits()) lo = mid;
        else hi = mid;
      }
      fit = lo;
      slots.style.setProperty('--fit', String(fit));
    }

    if (fit >= 1) slots.style.removeProperty('--fit');

    // 缩到底还是半个字：把名字收起来，只留页码（整条读作「-200页」）。
    // 放在最后：收起之后这一条会变窄，但那点余量不值得再跑一轮。
    // 名字改挂在 title 上 —— 屏幕上没有的东西，鼠标停上去还得能看见。
    // 读屏那一头不用管：aria-label 一直是完整的。
    for (const chip of chips) {
      if (!halfGlyph(chip) || !canDropName(chip)) continue;
      chip.classList.add('is-nameless');
      chip.title = chip.textContent.trim();
    }
  }

  /** 布局一变（窗口、全屏、字号档）能装下的量就跟着变，得重量一遍。
      挂 ResizeObserver 而不是 resize 事件：进全屏时浏览器要等布局定下来才有
      新尺寸，事件那一刻量到的还是旧的。 */
  const fitObserver = new ResizeObserver(() => {
    for (const cell of cells.values()) fitCell(cell);
  });
  fitObserver.observe(board);

  /* ---------------------------------------------------------------- 启动 */

  // 首屏不播入场动画：作业是刷新后恢复的，不是刚布置的
  for (const subjectId of cells.keys()) syncCell(subjectId, store.getState(), false);
  for (const cell of cells.values()) fitCell(cell);
  syncArmed(store.getState());
  syncNote(store.getState());
  syncFullscreen();

  store.subscribe((state) => {
    const tags = indexFor(state);
    for (const subjectId of cells.keys()) syncCell(subjectId, state);
    // 先让这一格的长相定下来，再量：拖影的落点与放大倍数都读条目的实际尺寸
    // （见 completeDrop / fontRatio），这里缩完，飞过来的拖影才和落点严丝合缝。
    // 带上指纹：这一轮真的变了的格子才重量（见 fitSignature）。
    for (const subjectId of cells.keys()) {
      fitCell(cells.get(subjectId), fitSignature(subjectId, state, tags));
    }
    syncArmed(state);
    syncNote(state);
  });

  return { place, retract, move, toggleFullscreen, exitFullscreen };
}
