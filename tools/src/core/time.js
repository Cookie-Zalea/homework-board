/**
 * 时间显示。
 *
 * 只做一件事：把时间戳说成人话（「今天 16:20」）。功能区那行「上次布置」
 * 和历史记录的每一条都要用，所以放在这里而不是塞进哪个视图里。
 *
 * now 由调用方注入：默认取当前时间，但自检要断言确定的字符串，
 * 传一个固定的 now 进去就行 —— 这类函数不该自己去读时钟。
 */

function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function clockText(date) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 按「日历天」而不是「24 小时」算今天昨天 —— 昨晚 23:00 的改动，
 * 今早 01:00 来看应该是「昨天」，哪怕只过去两小时。
 *
 * @param {number} at  时间戳；0 / null 表示还没有过
 * @param {number} now 参照时刻
 * @returns {string} 还没有过时返回空串，由调用方决定怎么措辞
 */
export function formatWhen(at, now = Date.now()) {
  if (!at) return '';

  const then = new Date(at);
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86400000);
  const clock = clockText(then);

  if (days === 0) return `今天 ${clock}`;
  if (days === 1) return `昨天 ${clock}`;

  const md = `${then.getMonth() + 1}月${then.getDate()}日`;
  if (then.getFullYear() === new Date(now).getFullYear()) return `${md} ${clock}`;

  return `${then.getFullYear()}年${md} ${clock}`;
}

/**
 * 绝对时间，不带「今天 / 昨天」。
 *
 * 给会长期留在数据里的文字用：历史记录里的描述是写入那一刻定格下来的，
 * 用 formatWhen 的话，一周后那条记录还会写着「今天 16:20」。
 */
export function formatStamp(at) {
  if (!at) return '';
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${clockText(d)}`;
}
