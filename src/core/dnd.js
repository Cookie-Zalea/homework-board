/**
 * 拖拽引擎。
 *
 * 只认识两件事：「拖拽源」和「放置目标」。它不知道课程、Tag 或任何业务字段 ——
 * 业务含义全部由调用方在回调里解释。二区注册课程格作为目标，三区注册 Tag 作为源，
 * 两者互不引用，以后把同样的 Tag 拖到别的地方也不用改这个文件。
 *
 * 用 Pointer Events 而不是 HTML5 拖放，原因：
 *   1. 原生拖影跟手性差，且无法自定义，做不出「落位」动画
 *   2. 触屏 / 触控笔走同一套逻辑，不需要另写一份
 *
 * 位置更新只改 transform，全部在合成层完成，不触发重排，所以拖起来是跟手的。
 */

const THRESHOLD = 4;        // 超过这个位移才算拖拽，否则视为点击
const GHOST_SAFETY_MS = 1200; // 兜底清理：调用方万一没接管拖影，也不会残留

/**
 * 把一个元素身上算出来的自定义属性（--hue / --tint / --fit …）抄到另一个元素上。
 *
 * 拖影与它的落点克隆都是被搬到 body 下的孤儿，脱离了原来的祖先链：课程色、
 * --fit、--glyph-size 这些用 var() 消费的令牌一个都继承不到，颜色和字号会当场
 * 变成另一套值。抄成内联值，克隆出来的那一段才和原位长得一样。
 *
 * @returns {CSSStyleDeclaration} 顺手把刚算出来的那份 style 交回去 —— 调用方
 *   往往还要从里面取别的值（字号、盒子尺寸），省得再量一次。
 */
export function inheritCustomProps(fromEl, toEl) {
  const computed = getComputedStyle(fromEl);
  for (const name of computed) {
    if (name.startsWith('--')) toEl.style.setProperty(name, computed.getPropertyValue(name));
  }
  return computed;
}

export function createDragManager({ onDrop, onCancel } = {}) {
  /** @type {Map<Element, any>} 放置目标 → 调用方自定义的数据 */
  const targets = new Map();
  let session = null;

  /* ------------------------------------------------------------ 注册接口 */

  /** 注册一个放置目标，返回注销函数 */
  function registerTarget(element, data) {
    targets.set(element, data);
    return () => targets.delete(element);
  }

  /**
   * 把某个元素变成拖拽源。
   * @param {Element} element
   * @param {(event: PointerEvent) => any} getPayload 按下时取一次载荷，
   *        参数是原始事件 —— 源内部有输入框之类不该触发拖拽的子元素时，
   *        由调用方在这里按 event.target 判断并返回假值
   * @param {{onStart?: Function, onEnd?: Function}} handlers 供视图切换自身状态
   */
  function attachSource(element, getPayload, handlers = {}) {
    const onPointerDown = (event) => {
      if (session) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      const payload = getPayload(event);
      if (!payload) return;

      session = {
        source: element,
        payload,
        handlers,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        grabX: 0,
        grabY: 0,
        ghost: null,
        rects: [],
        active: false,
        hovered: null,
      };

      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('keydown', onKeyDown);
    };

    element.addEventListener('pointerdown', onPointerDown);

    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      if (session?.source === element) cancelSession();
    };
  }

  /* ---------------------------------------------------------------- 过程 */

  function onPointerMove(event) {
    if (!session || event.pointerId !== session.pointerId) return;

    if (!session.active) {
      const moved = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
      if (moved < THRESHOLD) return;
      lift(event);
    }

    event.preventDefault();
    moveGhost(event.clientX, event.clientY);
    updateHover(event.clientX, event.clientY);
  }

  function lift(event) {
    const source = session.source;
    const rect = source.getBoundingClientRect();

    session.active = true;
    session.grabX = session.startX - rect.left;
    session.grabY = session.startY - rect.top;
    session.rects = collectRects();

    // 拖影：外层负责跟手位移，内层负责缩放与淡出。拆成两层，
    // 「跟手」和「落位」两段动画就不会互相覆盖 transform。
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    const inner = source.cloneNode(true);
    inner.classList.add('drag-ghost__inner');
    inner.removeAttribute('id');
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;

    // 拖影被搬到 body 下，脱离了原来的祖先，会丢掉继承来的自定义属性。
    // 格内作业的颜色正是从所在课程格继承的 —— 逐条抄过来，拖影才和原位长得一样。
    const computed = inheritCustomProps(source, ghost);

    // 字号也要钉住，理由和上面一样，而且更要紧：三区 Tag 与格内条目的字号
    // 都不是自己写死的，是从所在容器量出来的（.tags-body 的 cqh、.board-block
    // 的 cqh）。拖影一搬到 body，这两个容器就都不在祖先链上了，字号会当场变成
    // 另一套值 —— 文字要么涨出拖影的框，要么缩成一小团。抄成内联值之后，
    // 内的那些 em（内边距、间距、图标尺寸）也就跟着全对了。
    ghost.style.fontSize = computed.fontSize;

    ghost.append(inner);
    document.body.append(ghost);

    session.ghost = ghost;
    requestAnimationFrame(() => ghost.classList.add('is-lifted'));

    source.classList.add('is-dragging');
    document.body.classList.add('is-dragging');
    session.handlers.onStart?.();

    moveGhost(event.clientX, event.clientY);
  }

  function moveGhost(clientX, clientY) {
    const ghost = session.ghost;
    if (!ghost) return;
    ghost.style.transform =
      `translate3d(${clientX - session.grabX}px, ${clientY - session.grabY}px, 0)`;
  }

  function updateHover(clientX, clientY) {
    const next = hitTest(clientX, clientY);
    if (next === session.hovered) return;

    session.hovered?.element.classList.remove('is-drop-target');
    session.hovered = next;
    next?.element.classList.add('is-drop-target');
  }

  function clearHover() {
    session?.hovered?.element.classList.remove('is-drop-target');
    if (session) session.hovered = null;
  }

  /** 拖拽开始时缓存一次目标矩形：期间布局不会变，比每次 elementFromPoint 更稳、更快 */
  function collectRects() {
    const rects = [];
    for (const [element, data] of targets) {
      if (!element.isConnected) continue;
      rects.push({ element, data, rect: element.getBoundingClientRect() });
    }
    return rects;
  }

  function hitTest(clientX, clientY) {
    for (const entry of session.rects) {
      const { rect } = entry;
      if (clientX >= rect.left && clientX <= rect.right &&
          clientY >= rect.top && clientY <= rect.bottom) {
        return entry;
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- 收尾 */

  function teardown() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown);
    document.body.classList.remove('is-dragging');
  }

  function onPointerUp(event) {
    if (!session || event.pointerId !== session.pointerId) return;

    const current = session;
    const hit = current.active ? hitTest(event.clientX, event.clientY) : null;
    finish();

    if (!current.active) {
      current.ghost?.remove();
      return;
    }

    const ghost = current.ghost;
    // 拖影的最终归属交给调用方（要播放落位动画），这里只上保险丝
    if (ghost) setTimeout(() => ghost.remove(), GHOST_SAFETY_MS);
    cleanupSource(current);

    if (hit) {
      onDrop?.({
        payload: current.payload,
        target: hit.data,
        ghost,
        clientX: event.clientX,
        clientY: event.clientY,
        ghostLeft: event.clientX - current.grabX,
        ghostTop: event.clientY - current.grabY,
      });
    } else {
      onCancel?.({ payload: current.payload, ghost });
    }
  }

  function onPointerCancel(event) {
    if (!session || event.pointerId !== session.pointerId) return;
    cancelSession();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && session) {
      event.preventDefault();
      cancelSession();
    }
  }

  function cancelSession() {
    const current = session;
    if (!current) return;

    clearHover();
    finish();
    cleanupSource(current);

    if (current.active) onCancel?.({ payload: current.payload, ghost: current.ghost });
    else current.ghost?.remove();
  }

  function cleanupSource(current) {
    current.source.classList.remove('is-dragging');
    // 把「这次到底是不是拖拽」告诉视图：拖完落回源元素时浏览器仍会补一个
    // click，源需要据此吞掉它，否则会误触发点选。
    current.handlers.onEnd?.(current.active);
  }

  function finish() {
    clearHover();
    teardown();
    session = null;
  }

  /** 是否正有一次拖拽在进行（用于 Esc 之类不该和拖拽抢的全局按键） */
  function isDragging() {
    return session?.active === true;
  }

  return { registerTarget, attachSource, isDragging };
}
