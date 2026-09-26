/**
 * 极简状态容器：单一 state 对象 + 订阅通知。
 *
 * 不认识任何业务字段，只负责「状态变了就通知」。视图只读不写，
 * 所有写操作集中在 core/actions.js，方便以后换实现或加中间层。
 */
export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();

  function getState() {
    return state;
  }

  /**
   * @param {(state: object) => object} producer 返回新 state；
   *        返回原对象表示没有变化，不会触发通知。
   * @returns {boolean} 是否发生了变更
   */
  function update(producer) {
    const next = producer(state);
    if (!next || next === state) return false;
    state = next;
    for (const listener of [...listeners]) listener(state);
    return true;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { getState, update, subscribe };
}
