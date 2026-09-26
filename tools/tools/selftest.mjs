/**
 * 端到端自检。
 *
 * 用 Chrome DevTools Protocol 驱动**真实的鼠标输入事件**（Input.dispatchMouseEvent
 * 会走浏览器完整的输入管线，产生受信任的 pointerdown/pointermove/pointerup），
 * 所以测的是真的拖拽，不是直接改 state 的假通过。
 *
 * 检查项对应规格第十六、十七条：
 *   结构 / 课程位置 / 课程颜色 / Tag 存在性 / 四条拖拽路径 / 撤下 / 清空 / 控制台报错
 *
 * 用法：先起服务，再 node tools/selftest.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
// 直接读课程数据源：颜色断言要和 data/subjects.js 对得上，而不是和「上次截图」对得上
import { SUBJECTS } from '../src/data/subjects.js';
import { buildTagIndex, DEFAULT_TAGS } from '../src/data/tags.js';
// 纯函数直接 import 进来跑：这些逻辑不该只靠「界面上看着对」来验证
import { FONT_STEPS, DEFAULT_FONT_STEP, fontClassName, FONT_CLASS_NAMES } from '../src/data/prefs.js';
import { formatWhen, formatStamp } from '../src/core/time.js';
import { pushSnapshot, nextSnapshotId, sameAssignments, summarize, HISTORY_LIMIT } from '../src/core/history.js';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const APP_URL = process.env.APP_URL || 'http://localhost:8777/';
const PORT = Number(process.env.CDP_PORT || 9333);
const OUT_DIR = resolve(ROOT, '.review');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 断言 */

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
}

function checkEqual(name, actual, expected) {
  const ok = actual === expected;
  check(name, ok, ok ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 数组 / 对象按内容比较 */
function checkList(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, a === b ? '' : `期望 ${b}，实际 ${a}`);
}

/* -------------------------------------------------------------- CDP 客户端 */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
        return;
      }
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      const detail = exceptionDetails.exception?.description
        ?? exceptionDetails.exception?.value
        ?? exceptionDetails.text
        ?? '未知错误';
      throw new Error(`页面内求值失败：${detail}\n表达式：${expression.trim().slice(0, 120)}`);
    }
    return result.value;
  }
}

async function connect() {
  const endpoint = `http://127.0.0.1:${PORT}/json/list`;
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(endpoint)).json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 浏览器还没起来 */
    }
    await sleep(250);
  }
  throw new Error('连不上 Chrome 调试端口');
}

/* -------------------------------------------------------------- 拖拽模拟 */

/** 用真实鼠标事件走一次完整拖拽：按下 → 分步移动 → 松开 */
async function drag(cdp, from, to, options = {}) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1,
  });

  const STEPS = 14;
  const pauseAt = Math.ceil(STEPS * (options.at ?? 0.75));   // 采样点：默认走到 3/4 处

  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      button: 'left',
      buttons: 1,
    });
    await sleep(10);
    if (options.onProgress && i === pauseAt) await options.onProgress();
  }

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1,
  });
  await sleep(420);   // 等落位动画走完
}

async function capture(cdp, filename) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(OUT_DIR, filename), Buffer.from(shot.data, 'base64'));
}

/**
 * 拖一次，同时把拖影逐帧录下来。
 *
 * 「拖进去之后变大」有两半，缺一不可：往大里变，而且是个过程（中间有过渡值，
 * 不是一帧跳到位）。还得证明**在三区里没变** —— 录制从按下就开始，松手那一刻
 * 单独打一个标记，前后两段分开看。
 *
 * 录的是三个盒子（getBoundingClientRect 会把元素自己的 transform 算进去，
 * 所以它们就是屏幕上真实的像素大小）：
 *   g    —— 拖影外层。它是拿起来那一刻克隆的源元素（三区那枚 Tag），跟手期间
 *           屏幕上看到的就是它；落位期间原地淡出，尺寸不再变（放大不归它管，
 *           见 flyGhost 与 tags.css）
 *   arr  —— 落点层。松手那一刻才出现，克隆自目标条目，从「出发时的字号」长到
 *           条目自己的大小。它是「变大」那一段，也是这次要钉住的东西：它
 *           **从头到尾都不该比落点条目大**（用户报的毛病正是拖影长过头、
 *           交接时又缩回去 —— 那一版是把这个 Tag 盒子按字号放大到 1.8 倍）
 *   chip —— 落点那一枚的真实 rect，上面两个读数的标尺
 *
 * 另外三个读数是为了钉住「这个过程看得见」（用户：「从三区到二区，从小变大的
 * 过程要做动画」）：
 *   o  —— 出发层的不透明度。它该在前三分之一里淡掉，不留残影
 *   ao —— 落点层的不透明度。长到九成的那一刻它必须已经实了
 *   es —— 正在入场的条目被写上的 --enter-scale。拖拽落位这一路应当是 1
 *         （变大归拖影的落点层管），点选那一路才是「Tag ÷ 条目」那个比例
 *
 * @returns {Promise<Array<{t:number, g:{w:number,h:number}, arr:{w:number,h:number}|null,
 *                          af:string|null, chip:{w:number,h:number}|null, o:number|null,
 *                          ao:number|null, released:boolean, entering:boolean, es:string|null}>>}
 */
async function dragRecordingScale(cdp, fromSelector, toSelector) {
  const from = await centerOf(cdp, fromSelector);
  const to = await centerOf(cdp, toSelector);
  if (!from || !to) throw new Error(`拖拽端点不存在：${fromSelector} → ${toSelector}`);

  await cdp.evaluate(`
    window.__ghost = [];
    window.__released = false;
    const t0 = performance.now();
    const box = (n) => {
      const b = n.getBoundingClientRect();
      return { w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
    };
    const opacity = (n) => +Number.parseFloat(getComputedStyle(n).opacity).toFixed(2);
    (function tick() {
      const g = document.querySelector('.drag-ghost');
      // 拖影只在拖拽期间存在，它一没录制就自然停 —— 不用另设结束条件
      if (g) {
        const inner = g.querySelector('.drag-ghost__inner');
        const arr = g.querySelector('.drag-ghost__arrival');
        const chip = document.querySelector('[data-subject="yu"] .asg');
        const entering = !!chip && chip.classList.contains('is-entering');
        window.__ghost.push({
          t: Math.round(performance.now() - t0),
          g: box(g),
          arr: arr ? box(arr) : null,
          af: arr ? arr.style.getPropertyValue('--arrival-from') : null,
          // 入场动画会把条目挪 3px 再缩放，那几帧的 rect 不作数
          chip: chip && !entering ? box(chip) : null,
          o: inner ? opacity(inner) : null,
          ao: arr ? opacity(arr) : null,
          released: window.__released,
          entering,
          es: entering ? chip.style.getPropertyValue('--enter-scale') : null,
        });
      }
      if (performance.now() - t0 < 1200) requestAnimationFrame(tick);
    })();
    return true;
  `);

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1,
  });
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      button: 'left',
      buttons: 1,
    });
    await sleep(12);
  }

  await cdp.evaluate(`window.__released = true; return true;`);   // 松手那一刻的分界
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1,
  });
  await sleep(700);   // 飞完 + 淡出 + 拖影自己移除

  return cdp.evaluate(`return window.__ghost;`);
}

/**
 * 元素中心点（视口坐标），先保证它真的在画面里。
 *
 * 三区是个内部可滚动的盒子（Tag 缩到 20px 之后 15 枚在 1440×900 下正好一屏，
 * 但窄屏、矮窗口下照样会滚，「+ 自定义 Tag」那一枚常常在折线以下）—— 而鼠标
 * 事件打在视口外面，浏览器直接丢掉，点击就静默失败。
 * 真人也是先滚再点，这里照做：中心不在视口里就滚进来再量。
 * scrollIntoView 只滚「最近的可滚动祖先」，二区和整页都不动。
 */
async function centerOf(cdp, selector) {
  return cdp.evaluate(`
    const n = document.querySelector(${JSON.stringify(selector)});
    if (!n) return null;
    const probe = () => {
      const b = n.getBoundingClientRect();
      const x = Math.round(b.left + b.width / 2);
      const y = Math.round(b.top + b.height / 2);
      const at = document.elementFromPoint(x, y);
      return { x, y, ok: !!at && (at === n || n.contains(at)) };
    };
    let p = probe();
    // 「在视口里」不等于「看得见」：三区自己是个滚动盒子，滚出去的那几枚 rect 还
    // 落在二区上，照那个坐标点下去会点到格子里的作业条目（踩过一次：想点必刷题，
    // 结果点到语里的卷子，还静默成功了）。所以以「这个点上真的是它」为准，
    // 不对就滚进来再量一次。
    if (!p.ok) {
      n.scrollIntoView({ block: 'center', inline: 'nearest' });
      p = probe();
    }
    return { x: p.x, y: p.y };
  `);
}

/** 用真实鼠标事件点一下某个元素 */
async function clickEl(cdp, selector) {
  const point = await centerOf(cdp, selector);
  if (!point) throw new Error(`找不到元素：${selector}`);

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await sleep(20);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
  });
  await sleep(200);
}

/** 在视口的指定坐标上点一下（用来点「空白处」这类没有选择器的地方） */
async function clickPoint(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await sleep(20);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  });
  await sleep(200);
}

/** 从一个元素拖到另一个元素 */
async function dragBetween(cdp, fromSelector, toSelector) {
  const from = await centerOf(cdp, fromSelector);
  const to = await centerOf(cdp, toSelector);
  if (!from || !to) throw new Error(`拖拽端点不存在：${fromSelector} → ${toSelector}`);
  await drag(cdp, from, to);
}

/* ------------------------------------------------------------ 页码键盘 */

/*
  页码只能用内置键盘改了，所以自检里的「输入页码」也必须是点键 ——
  这不是为了绕开什么，而是这本来就是用户唯一的改页码路径。写进
  .tag__page 的 .value 是改不动的，它现在是个按钮。
*/

const KEYPAD = '#overlay-root .keypad';
const keypadKey = (id) => `${KEYPAD} .keypad__key[data-key="${id}"]`;
const KEYPAD_DONE = `${KEYPAD} .keypad__done`;

/** 点开某枚 Tag 的页码键盘 */
async function openKeypad(cdp, tagId) {
  await clickEl(cdp, `.tag[data-tag-id="${tagId}"] .tag__page`);
  await sleep(120);
}

/** 通过内置键盘把某枚 Tag 的页码设成 digits（''＝清空），最后按「完成」收起 */
async function setPageViaKeypad(cdp, tagId, digits) {
  await openKeypad(cdp, tagId);
  await clickEl(cdp, keypadKey('clear'));
  for (const ch of String(digits)) await clickEl(cdp, keypadKey(ch));
  await clickEl(cdp, KEYPAD_DONE);
  await sleep(200);
}

// 一区现在是功能区，按钮不止一个，选择器要指名道姓 ——
// 用 '#zone-info .btn' 会点到第一个工具按钮上。
const SETTINGS_BTN = '#zone-info .info-foot .btn';
const HISTORY_BTN = '#zone-info [data-tool="history"]';
const PLACE_ALL_BTN = '#zone-info [data-tool="place-all"]';
const fontStepBtn = (id) => `#zone-info [data-font-step="${id}"]`;

/** 点开设置抽屉 */
const openSettings = (cdp) => clickEl(cdp, SETTINGS_BTN);

/** 点开历史记录抽屉 */
const openHistory = (cdp) => clickEl(cdp, HISTORY_BTN);

/**
 * 某个课程格内当前显示的作业文案。
 *
 * 读的是整条 .asg 的 textContent，它由 .asg__label（名字）与 .asg__page（页码）
 * 两段拼成，中间没有空白节点 —— 所以得到的就是「必刷题-20页」这样一个词。
 * 两段分开渲染是为了页码不被省略号吃掉（见 data/tags.js 的 splitTagText），
 * 那两段之间不许有空格，读法也就跟着是拼接而不是连接。
 */
async function chipsIn(cdp, subjectId) {
  return cdp.evaluate(`
    return [...document.querySelectorAll('[data-subject="${subjectId}"] .asg')]
      .map((n) => n.textContent.trim());
  `);
}

const hexToRgb = (hex) => {
  const value = Number.parseInt(String(hex).replace('#', ''), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
};

/** 用真实输入事件往输入框里打字（先全选，再 insertText 覆盖） */
async function typeInto(cdp, selector, text) {
  await cdp.evaluate(`
    const n = document.querySelector(${JSON.stringify(selector)});
    n.focus();
    n.setSelectionRange(0, n.value.length);
    return true;
  `);
  await cdp.send('Input.insertText', { text });
}

/* -------------------------------------------------------------------- 主流程 */

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p)) ?? CHROME_CANDIDATES[0];

await mkdir(OUT_DIR, { recursive: true });

const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${resolve(OUT_DIR, 'selftest-profile')}`,
  '--window-size=1440,900',
  APP_URL,
], { stdio: 'ignore' });

let cdp = null;

try {
  const wsUrl = await connect();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  cdp = new Cdp(ws);

  const consoleErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) =>
    consoleErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '未知异常'));
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description).join(' '));
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // 显式导航一次，确保拿到的是应用页面本身而不是启动时的 about:blank
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(1500);

  // 干净起步：清掉上一次跑留下的本地数据
  await cdp.evaluate(`localStorage.clear(); return true;`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1500);

  await capture(cdp, '01-overview.png');   // 首次打开的样子（每次都重拍，免得留旧图）

  /* --------------------------------------------------- I. 纯函数（不进浏览器）
     时间、历史上限、快照比较这些逻辑，界面上「看着对」说明不了什么。
     这里直接 import 进来断言，并注入固定的「现在」——否则「今天/昨天」这种
     文案的期望值会随着跑测试的钟点变。 */

  const NOW = new Date(2026, 8, 25, 16, 20).getTime();     // 2026-09-25 周五 16:20
  const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm).getTime();

  checkEqual('formatWhen：同一天写「今天 时:分」', formatWhen(at(2026, 9, 25, 8, 5), NOW), '今天 08:05');
  checkEqual('formatWhen：前一天写「昨天 时:分」', formatWhen(at(2026, 9, 24, 16, 20), NOW), '昨天 16:20');
  checkEqual('formatWhen：再往前写月日', formatWhen(at(2026, 9, 23, 7, 0), NOW), '9月23日 07:00');
  checkEqual('formatWhen：跨年补上年份', formatWhen(at(2025, 12, 31, 23, 59), NOW), '2025年12月31日 23:59');
  checkEqual('formatWhen：没有时间就是空串（一区据此显示「还没有布置过」）', formatWhen(0), '');
  // 差一小时但跨了自然日：按 24 小时算会写成「今天」，那就错了
  checkEqual('formatWhen：按自然日判定，不是按 24 小时',
    formatWhen(at(2026, 9, 24, 23, 30), at(2026, 9, 25, 0, 30)), '昨天 23:30');

  checkEqual('formatStamp：绝对时间，不随「现在」漂移',
    formatStamp(at(2026, 9, 24, 16, 20)), '9月24日 16:20');

  const full40 = Array.from({ length: HISTORY_LIMIT }, (_, i) => ({ at: i + 1 }));
  const grown = pushSnapshot(full40, { at: 999 });
  checkEqual('pushSnapshot：超过上限后长度不再涨', grown.length, HISTORY_LIMIT);
  checkEqual('pushSnapshot：追加的排在最后', grown[grown.length - 1].at, 999);
  check('pushSnapshot：淘汰掉的确实是最老那条', !grown.some((e) => e.at === 1), '');
  checkEqual('pushSnapshot：历史为空也能追加（首次改动）', pushSnapshot(undefined, { at: 1 }).length, 1);

  checkEqual('nextSnapshotId：空历史从 1 开始', nextSnapshotId([]), 1);
  checkEqual('nextSnapshotId：取最大 id 加一', nextSnapshotId([{ id: 3 }, { id: 7 }, { id: 5 }]), 8);
  // 首次改动会在同一次 commit 里写下「改动前」和本条，两条 at 相同 —— 只能靠 id 认
  checkEqual('nextSnapshotId：同一毫秒的两条不会撞号', nextSnapshotId([{ id: 1 }, { id: 1 }]), 2);

  // 页码搬进布置之后，比较的对象就从「一张页码表」变成「整份布置记录」。
  // 这几条是恢复按钮的判活依据：判等错了，按钮要么永远是死的，要么乱给。
  checkEqual('sameAssignments：两条一模一样的布置',
    sameAssignments({ yu: [{ tagId: 'bishuati', page: 20 }] }, { yu: [{ tagId: 'bishuati', page: 20 }] }), true);
  checkEqual('sameAssignments：顺序不同就算不同（格内按布置先后排列，用户看得见）',
    sameAssignments({ yu: [{ tagId: 'a' }, { tagId: 'b' }] }, { yu: [{ tagId: 'b' }, { tagId: 'a' }] }), false);
  checkEqual('sameAssignments：页码不同就算不同（否则快照写着 20 页、板子是 25 页，按钮却是死的）',
    sameAssignments({ yu: [{ tagId: 'a', page: 20 }] }, { yu: [{ tagId: 'a', page: 25 }] }), false);
  checkEqual('sameAssignments：page 缺省与 null 等价',
    sameAssignments({ yu: [{ tagId: 'a' }] }, { yu: [{ tagId: 'a', page: null }] }), true);
  checkEqual('sameAssignments：少一条就算不同',
    sameAssignments({ yu: [{ tagId: 'a' }] }, { yu: [] }), false);
  checkEqual('sameAssignments：两个空板相同', sameAssignments({}, {}), true);
  checkEqual('sameAssignments：undefined 当空板处理', sameAssignments(undefined, {}), true);

  const defaultIndex = buildTagIndex([]);
  const oneSummary = summarize({ yu: [{ tagId: 'bishuati', page: 20 }], shu: [] }, defaultIndex);
  checkEqual('summarize：只列出真的布置了的课程', oneSummary.length, 1);
  checkEqual('summarize：带上课程字与「Tag-页码」（页码从布置自己身上读）',
    `${oneSummary[0]?.glyph} ${oneSummary[0]?.text}`,
    `${SUBJECTS.find((s) => s.id === oneSummary[0]?.subjectId)?.glyph} 必刷题-20页`);
  checkEqual('summarize：没页码的那条只写名字',
    summarize({ yu: [{ tagId: 'bishuati' }] }, defaultIndex)[0]?.text, '必刷题');
  checkEqual('summarize：空板给空数组（抽屉显示「空板」）', summarize({}, defaultIndex).length, 0);

  checkEqual('字号：标准是默认档', DEFAULT_FONT_STEP, 'standard');
  check('字号：每个档位都有 id 和中文名', FONT_STEPS.every((s) => s.id && s.label), JSON.stringify(FONT_STEPS));
  checkEqual('fontClassName：认得档位', fontClassName('xlarge'), 'fs-xlarge');
  checkEqual('fontClassName：不认得的档位回落到标准', fontClassName('huge'), 'fs-standard');
  checkEqual('fontClassName：空值也回落', fontClassName(undefined), 'fs-standard');
  checkEqual('FONT_CLASS_NAMES：与档位一一对应', FONT_CLASS_NAMES.length, FONT_STEPS.length);

  // 档位表在 JS，缩放系数在 CSS。两边对不上时（加了档位忘了写 CSS）这里会红。
  const baseCss = await readFile(resolve(ROOT, 'src/styles/base.css'), 'utf8');
  const CSS_SCALE = { standard: 1 };
  for (const m of baseCss.matchAll(/:root\.fs-([a-z]+)\s*\{[^}]*?--fs-scale:\s*([\d.]+)/g)) {
    CSS_SCALE[m[1]] = Number(m[2]);
  }
  checkList('每个档位在 base.css 里都有 --fs-scale',
    FONT_STEPS.map((s) => s.id).filter((id) => !(id in CSS_SCALE)), []);
  checkList('base.css 里没有多余的 fs-* 档位',
    Object.keys(CSS_SCALE).filter((id) => !FONT_STEPS.some((s) => s.id === id)), []);
  check('档位单调递增（紧凑 < 标准 < 大 < 特大）',
    FONT_STEPS.every((s, i) => i === 0 || CSS_SCALE[s.id] > CSS_SCALE[FONT_STEPS[i - 1].id]),
    JSON.stringify(CSS_SCALE));

  // 正文阶梯的基准像素也从 CSS 里读，不写死。写死的话，以后上调一次正文基准，
  // J 段那一串「计算值 = Npx × 系数」会集体变红，而它们想验的（系数挂对了没有）
  // 其实没坏 —— 红的是断言自己。这里读出来，红就只可能是真的坏了。
  // 基准字号写成 calc(15px * var(--fs-scale))，所以数字前面隔着一个 calc( ——
  // 直接从文件里读出来，而不是在这里抄一个 15：抄的数会跟 CSS 各走各的。
  const FS_BASE = Number(baseCss.match(/--fs-base:\s*(?:calc\()?\s*([\d.]+)px/)?.[1]);
  check('base.css 里定义了 --fs-base（正文基准字号）', Number.isFinite(FS_BASE), String(FS_BASE));

  // 课程大字是第二条阶梯，同样落在 base.css 里，同样要对着档位表查一遍。
  const GLYPH_SCALE = { standard: Number(baseCss.match(/--glyph-scale:\s*([\d.]+)/)?.[1]) };
  for (const m of baseCss.matchAll(/:root\.fs-([a-z]+)\s*\{[^}]*?--glyph-scale:\s*([\d.]+)/g)) {
    GLYPH_SCALE[m[1]] = Number(m[2]);
  }
  checkList('每个档位在 base.css 里都有 --glyph-scale',
    FONT_STEPS.map((s) => s.id).filter((id) => !(id in GLYPH_SCALE) || Number.isNaN(GLYPH_SCALE[id])), []);
  check('大字档位单调递增（紧凑 < 标准 < 大 < 特大）',
    FONT_STEPS.every((s, i) => i === 0 || GLYPH_SCALE[s.id] > GLYPH_SCALE[FONT_STEPS[i - 1].id]),
    JSON.stringify(GLYPH_SCALE));
  // 大字阶梯必须比正文阶梯陡得多，否则「特大占半格」和「紧凑 = 旧特大」不可能同时成立。
  // 正文四档只有 1.39 倍，大字有 3 倍出头 —— 这是两条阶梯分家的理由本身。
  const glyphSpan = GLYPH_SCALE[FONT_STEPS.at(-1).id] / GLYPH_SCALE[FONT_STEPS[0].id];
  check('大字四档跨度 ≥ 3 倍（正文阶梯只有 1.4 倍，两者不是同一条）',
    glyphSpan >= 3, `实测 ${glyphSpan.toFixed(2)} 倍`);
  check('大字阶梯确实与正文阶梯不同源',
    FONT_STEPS.some((s) => Math.abs(GLYPH_SCALE[s.id] - CSS_SCALE[s.id]) > 0.05),
    FONT_STEPS.map((s) => `${s.id}: 正文 ${CSS_SCALE[s.id]} / 大字 ${GLYPH_SCALE[s.id]}`).join('，'));

  // --glyph-half 是「特大档字身盒 = 半格高」这一步的常数。
  // 块的 content box 三等分就是三个格子，所以半格高 = 1/6 ≈ 16.67cqh；
  // 再除以墨迹率（中文笔画只占字身盒的 96%~98%）才是字身盒该给的值。
  const GLYPH_HALF = Number(baseCss.match(/--glyph-half:\s*([\d.]+)cqh/)?.[1]);
  check('base.css 里定义了 --glyph-half（带 cqh 单位）', Number.isFinite(GLYPH_HALF), String(GLYPH_HALF));
  check('--glyph-half 落在「半格高 / 墨迹率」该在的区间里',
    GLYPH_HALF > 16.67 && GLYPH_HALF < 18,
    `期望 16.67~18（16.67 是纯几何的半格高，再除以 .96~.98 的墨迹率），实际 ${GLYPH_HALF}`);
  check('--glyph-half 是 cqh 而不是 px（否则窗口一变就不是半格了）',
    /--glyph-half:\s*[\d.]+cqh/.test(baseCss) && !/--glyph-half:\s*[\d.]+px/.test(baseCss), '是 cqh');

  /* ---------------------------------------------------------- 结构检查 */

  checkEqual('一区存在', await cdp.evaluate(`return !!document.getElementById('zone-info');`), true);
  checkEqual('二区存在', await cdp.evaluate(`return !!document.getElementById('zone-board');`), true);
  checkEqual('三区存在', await cdp.evaluate(`return !!document.getElementById('zone-tags');`), true);

  // 一区在左通栏、二区在上、三区在下
  const shell = await cdp.evaluate(`
    const info = document.getElementById('zone-info').getBoundingClientRect();
    const board = document.getElementById('zone-board').getBoundingClientRect();
    const tags = document.getElementById('zone-tags').getBoundingClientRect();
    return { infoLeft: info.left, infoRight: info.right, infoHeight: info.height,
             boardTop: board.top, boardLeft: board.left, boardBottom: board.bottom,
             tagsTop: tags.top, tagsLeft: tags.left, vh: innerHeight };
  `);
  check('一区在左侧且通栏', shell.infoLeft === 0 && shell.infoHeight >= shell.vh - 2,
    `left=${shell.infoLeft} height=${shell.infoHeight} vh=${shell.vh}`);
  check('二区在一区右侧', shell.boardLeft >= shell.infoRight - 1, `board.left=${shell.boardLeft}`);
  check('三区在二区下方', shell.tagsTop >= shell.boardBottom - 1, `tags.top=${shell.tagsTop} board.bottom=${shell.boardBottom}`);
  check('三区仍在一区右侧（二区/三区结构未被改动）', shell.tagsLeft >= shell.infoRight - 1, `tags.left=${shell.tagsLeft}`);

  /* ------------------------------------------------------ 2×3 与课程位置 */

  const grid = await cdp.evaluate(`
    const blocks = [...document.querySelectorAll('.board-block')];
    return {
      blockCount: blocks.length,
      rows: blocks.map((b) => b.children.length),
      layout: blocks.map((b) => [...b.children].map((c) => c.dataset.subject)),
      gutter: (() => {
        if (blocks.length < 2) return -1;
        const a = blocks[0].getBoundingClientRect(), b = blocks[1].getBoundingClientRect();
        return Math.round(b.left - a.right);
      })(),
      cols: (() => {
        const b = blocks[0];
        const first = b.children[0].getBoundingClientRect();
        const second = b.children[1].getBoundingClientRect();
        return second.top >= first.bottom - 1 ? 'stacked' : 'side-by-side';
      })(),
    };
  `);

  checkEqual('二区为两个表格块', grid.blockCount, 2);
  checkEqual('每块三行', JSON.stringify(grid.rows), JSON.stringify([3, 3]));
  checkEqual('列内自上而下排列', grid.cols, 'stacked');
  check('中间保留窄分隔带', grid.gutter > 0 && grid.gutter < 60, `gutter=${grid.gutter}px`);

  // 位置映射（规格核心）：左上语 左中数 左下外 / 右上物 右中化 右下生
  checkEqual('左上 = 语', grid.layout[0][0], 'yu');
  checkEqual('左中 = 数', grid.layout[0][1], 'shu');
  checkEqual('左下 = 外', grid.layout[0][2], 'wai');
  checkEqual('右上 = 物', grid.layout[1][0], 'wu');
  checkEqual('右中 = 化', grid.layout[1][1], 'hua');
  checkEqual('右下 = 生', grid.layout[1][2], 'sheng');

  const glyphs = await cdp.evaluate(`
    return [...document.querySelectorAll('.course-cell')].map((c) => c.querySelector('.course-cell__glyph').textContent);
  `);
  checkEqual('六门课程名称未改动、未使用全称', JSON.stringify(glyphs), JSON.stringify(['语', '数', '外', '物', '化', '生']));

  /* ---------------------------------------------------------- 颜色检查 */

  const colors = await cdp.evaluate(`
    const toHex = (rgb) => {
      const m = rgb.match(/\\d+/g).map(Number);
      return '#' + m.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
    };
    return [...document.querySelectorAll('.course-cell')].map((c) => ({
      glyph: c.querySelector('.course-cell__glyph').textContent,
      hue: toHex(getComputedStyle(c, '::before').backgroundColor),
    }));
  `);

  const expectedHues = { 语: '#c4392f', 数: '#1f5fa9', 外: '#cc9508', 物: '#3f96c8', 化: '#7a4fa8', 生: '#3f7d3a' };
  for (const entry of colors) {
    checkEqual(`课程色条 ${entry.glyph}`, entry.hue, expectedHues[entry.glyph]);
  }

  /* ------------------------------------------------------------ 三区 Tag */

  const tagLabels = await cdp.evaluate(`
    return [...document.querySelectorAll('#zone-tags .tag__label')].map((n) => n.textContent);
  `);
  check('存在「必刷题」', tagLabels.includes('必刷题'), `实际：${JSON.stringify(tagLabels)}`);
  check('存在「U加课堂」', tagLabels.includes('U加课堂'), `实际：${JSON.stringify(tagLabels)}`);
  check('存在「U加课后」', tagLabels.includes('U加课后'), `实际：${JSON.stringify(tagLabels)}`);

  /* ---------------------------------------------------------- 拖拽路径 */

  const rects = await cdp.evaluate(`
    const center = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
    const tags = {};
    for (const t of document.querySelectorAll('#zone-tags .tag')) tags[t.dataset.tagId] = center(t);
    const cells = {};
    for (const c of document.querySelectorAll('.course-cell')) cells[c.dataset.subject] = center(c);
    return { tags, cells };
  `);

  const assignedIn = (subjectId) => cdp.evaluate(`
    return [...document.querySelectorAll('[data-subject="${subjectId}"] .asg')]
      .map((n) => n.textContent.trim());
  `);

  // 规格第九条要求实际测试的四条路径
  const paths = [
    { tag: 'bishuati', subject: 'yu', label: '必刷题', name: '必刷题 → 语' },
    { tag: 'bishuati', subject: 'shu', label: '必刷题', name: '必刷题 → 数' },
    { tag: 'ujia', subject: 'wu', label: 'U加课堂', name: 'U加课堂 → 物' },
    { tag: 'ujiakehou', subject: 'sheng', label: 'U加课后', name: 'U加课后 → 生' },
  ];

  for (const path of paths) {
    // 走拖拽而不是缓存的坐标：三区会滚（窗口一矮就滚），缓存的中心点会随着
    // 滚动失效（见 centerOf）
    await dragBetween(cdp, `.tag[data-tag-id="${path.tag}"] .tag__grab`, `[data-subject="${path.subject}"]`);
    const list = await assignedIn(path.subject);
    check(`拖拽：${path.name}`, list.includes(path.label), `该格实际内容：${JSON.stringify(list)}`);
  }

  // 拖拽后三区 Tag 必须还在（是模板，不是被消耗掉的）
  const tagsAfter = await cdp.evaluate(`
    return [...document.querySelectorAll('#zone-tags .tag__label')].map((n) => n.textContent);
  `);
  checkEqual('拖拽后三区 Tag 未被消耗', JSON.stringify(tagsAfter), JSON.stringify(DEFAULT_TAGS.map((t) => t.label)));

  // 拖动过程中不残留拖影；布局不因拖拽而位移
  checkEqual('拖拽结束无残留拖影', await cdp.evaluate(`return document.querySelectorAll('.drag-ghost').length;`), 0);
  checkEqual('拖拽结束无残留目标高亮', await cdp.evaluate(`return document.querySelectorAll('.is-drop-target').length;`), 0);
  checkEqual('拖拽结束未残留全局拖拽态', await cdp.evaluate(`return document.body.classList.contains('is-dragging');`), false);

  // 计数与面板状态
  const counts = await cdp.evaluate(`
    return [...document.querySelectorAll('.course-cell')].map((c) => c.querySelector('.course-cell__count').textContent);
  `);
  checkEqual('计数与布置情况同步', JSON.stringify(counts), JSON.stringify(['1 项', '1 项', '未布置', '1 项', '未布置', '1 项']));
  checkEqual('二区标题同步已布置门数', await cdp.evaluate(`return document.querySelector('#zone-board .panel-head__note').textContent;`), '已布置 4 / 6');

  /* -------------------------------------------- 拖拽悬停反馈与中途取消 */

  const outsideBoard = { x: 160, y: 700 };   // 一区空白处，不在任何课程格上
  const origin = rects.tags.bishuati;
  const hoverTarget = rects.cells.hua;

  const mouse = (type, point, buttons) => cdp.send('Input.dispatchMouseEvent', {
    type, x: point.x, y: point.y, button: 'left', buttons, clickCount: 1,
  });

  // 按住并分步移动到「化」，中途停住观察 drag-over 反馈
  await mouse('mousePressed', origin, 1);
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    await mouse('mouseMoved', {
      x: origin.x + (hoverTarget.x - origin.x) * t,
      y: origin.y + (hoverTarget.y - origin.y) * t,
    }, 1);
    await sleep(12);
  }

  const hover = await cdp.evaluate(`
    const target = document.querySelector('[data-subject="hua"]');
    const ghost = document.querySelector('.drag-ghost');
    const r = ghost?.getBoundingClientRect();
    return {
      targetHighlighted: target.classList.contains('is-drop-target'),
      highlightedCount: document.querySelectorAll('.course-cell.is-drop-target').length,
      ghostCount: document.querySelectorAll('.drag-ghost').length,
      ghostVisible: !!r && r.width > 0 && r.height > 0,
      ghostNearPointer: !!r && Math.abs((r.left + r.width / 2) - ${hoverTarget.x}) < 60
                            && Math.abs((r.top + r.height / 2) - ${hoverTarget.y}) < 60,
      sourceDimmed: document.querySelector('#zone-tags .tag[data-tag-id="bishuati"]').classList.contains('is-dragging'),
    };
  `);

  check('拖拽中：目标课程格高亮', hover.targetHighlighted, JSON.stringify(hover));
  check('拖拽中：只有当前目标高亮', hover.highlightedCount === 1, `高亮格数=${hover.highlightedCount}`);
  check('拖拽中：拖影存在且跟手', hover.ghostCount === 1 && hover.ghostVisible && hover.ghostNearPointer, JSON.stringify(hover));
  check('拖拽中：源 Tag 变淡以示正在拖动', hover.sourceDimmed, JSON.stringify(hover));
  await capture(cdp, '03-drag-over.png');

  // 移出二区再松手：验证拖拽可以中途放弃
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    await mouse('mouseMoved', {
      x: hoverTarget.x + (outsideBoard.x - hoverTarget.x) * t,
      y: hoverTarget.y + (outsideBoard.y - hoverTarget.y) * t,
    }, 1);
    await sleep(12);
  }
  await mouse('mouseReleased', outsideBoard, 0);
  await sleep(400);

  checkEqual('拖拽可中途放弃：移开目标后松手不入账', JSON.stringify(await assignedIn('hua')), JSON.stringify([]));
  checkEqual('取消后无残留拖影', await cdp.evaluate(`return document.querySelectorAll('.drag-ghost').length;`), 0);
  checkEqual('取消后无残留目标高亮', await cdp.evaluate(`return document.querySelectorAll('.is-drop-target').length;`), 0);
  checkEqual('取消后源 Tag 恢复正常', await cdp.evaluate(`return document.querySelector('#zone-tags .tag[data-tag-id="bishuati"]').classList.contains('is-dragging');`), false);

  /* ------------------------------------------------------ 重复布置与撤下 */

  await drag(cdp, rects.tags.bishuati, rects.cells.yu);
  checkEqual('重复布置同一 Tag 不会产生第二条', JSON.stringify(await assignedIn('yu')), JSON.stringify(['必刷题']));

  await cdp.evaluate(`
    document.querySelector('[data-subject="yu"] .asg__remove').click();
    return true;
  `);
  await sleep(320);
  checkEqual('可撤下已布置的作业', JSON.stringify(await assignedIn('yu')), JSON.stringify([]));

  /* -------------------------------------------------------- 刷新后保持 */

  await sleep(500);   // 等持久化落盘
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1200);
  const afterReload = await cdp.evaluate(`
    return [...document.querySelectorAll('[data-subject="shu"] .asg')].map((n) => n.textContent);
  `);
  checkEqual('刷新后布置记录仍在', JSON.stringify(afterReload), JSON.stringify(['必刷题']));

  /* ------------------------------------------------------------ 设置面板 */

  await openSettings(cdp);
  await sleep(360);
  const panelOpen = await cdp.evaluate(`
    const p = document.querySelector('.drawer--settings');
    const r = p.getBoundingClientRect();
    return { open: p.classList.contains('is-open'), onScreen: r.right <= innerWidth + 1 && r.left < innerWidth };
  `);
  check('设置面板可打开且完整滑入', panelOpen.open && panelOpen.onScreen, JSON.stringify(panelOpen));
  checkEqual('设置分区数量（about / motion / data）',
    await cdp.evaluate(`return document.querySelectorAll('.set-section').length;`), 3);
  checkEqual('设置打开时底层界面不可交互（inert）',
    await cdp.evaluate(`return document.getElementById('app').inert;`), true);

  await capture(cdp, '04-settings.png');

  await cdp.evaluate(`document.querySelector('.drawer--settings .drawer__close').click(); return true;`);
  await sleep(360);
  checkEqual('设置面板可关闭', await cdp.evaluate(`return document.querySelector('.drawer--settings').classList.contains('is-open');`), false);

  /* ------------------------------------------------------ 布置满六个后的观感 */

  await cdp.evaluate(`document.querySelector('#app').focus?.(); return true;`);
  for (const [tagId, subjectId] of [['ujia', 'yu'], ['ujia', 'shu'], ['bishuati', 'wai'], ['bishuati', 'hua'], ['ujia', 'hua']]) {
    const r = await cdp.evaluate(`
      const c = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; };
      return { from: c(document.querySelector('#zone-tags .tag[data-tag-id="${tagId}"]')), to: c(document.querySelector('[data-subject="${subjectId}"]')) };
    `);
    await drag(cdp, r.from, r.to);
  }

  await capture(cdp, '02-assigned.png');

  /* ------------------------------------------------------------ 窄屏回归 */

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 420, height: 860, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(500);

  const narrow = await cdp.evaluate(`
    const info = document.getElementById('zone-info').getBoundingClientRect();
    const board = document.getElementById('zone-board').getBoundingClientRect();
    const tags = document.getElementById('zone-tags').getBoundingClientRect();
    return {
      infoOnTop: info.top <= 1 && info.width >= innerWidth - 1,
      boardBelowInfo: board.top >= info.bottom - 1,
      tagsBelowBoard: tags.top >= board.bottom - 1,
      glyphs: document.querySelectorAll('.course-cell__glyph').length,
      blocks: document.querySelectorAll('.board-block').length,
      tagsVisible: document.querySelectorAll('#zone-tags .tag').length,
      noHorizontalScroll: document.documentElement.scrollWidth <= innerWidth + 1,
    };
  `);

  check('窄屏：一区改为在上、二区三区依次在下', narrow.infoOnTop && narrow.boardBelowInfo && narrow.tagsBelowBoard, JSON.stringify(narrow));
  checkEqual('窄屏：六门课程仍在', narrow.glyphs, 6);
  checkEqual('窄屏：2×3 两个表格块未被打散', narrow.blocks, 2);
  checkEqual('窄屏：三区的 Tag 一枚不少', narrow.tagsVisible, DEFAULT_TAGS.length);
  check('窄屏：不出现横向滚动', narrow.noHorizontalScroll, JSON.stringify(narrow));

  await capture(cdp, '05-narrow.png');

  /* -------------------------------------------------- 更小尺寸下仍能操作 */

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 340, height: 720, deviceScaleFactor: 1, mobile: true,
  });
  await sleep(500);

  const tiny = await cdp.evaluate(`
    const cells = [...document.querySelectorAll('.course-cell')];
    const hues = cells.map((c) => getComputedStyle(c, '::before').backgroundColor);
    const bars = cells.map((c) => c.getBoundingClientRect().left + 2);
    return {
      glyphs: document.querySelectorAll('.course-cell__glyph').length,
      distinctHues: new Set(hues).size,
      // 色条是否真的贴在每个格子的左缘（而不是被挤没）
      barsVisible: bars.every((x, i) => x > 0 && x < innerWidth),
      cellWidth: Math.round(cells[0].getBoundingClientRect().width),
      noHorizontalScroll: document.documentElement.scrollWidth <= innerWidth + 1,
      // 一区是竖排布局里最高的一块，它一高，课表就得靠滚才能看到。
      // 这里不断言具体高度（内容可以合理增减），只要求它别把课表顶出去太远。
      infoH: Math.round(document.getElementById('zone-info').getBoundingClientRect().height),
      // 一区排在竖排布局的最上面，它一高，课表就被顶下去。这里不规定它必须
      // 多矮（工具可以合理增减），只要求它没有把课表挤出首屏。
      firstRowBottom: (() => {
        const cells = [...document.querySelectorAll('.course-cell')].map((c) => c.getBoundingClientRect());
        const top = Math.min(...cells.map((b) => b.top));
        return Math.round(Math.max(...cells.filter((b) => Math.abs(b.top - top) < 2).map((b) => b.bottom)));
      })(),
      innerH: innerHeight,
    };
  `);
  check('340px：一区没有把课表挤出首屏（首行课程格完整可见）',
    tiny.firstRowBottom < tiny.innerH,
    `一区 ${tiny.infoH}px，首行格底 ${tiny.firstRowBottom}px，视口 ${tiny.innerH}px`);

  checkEqual('340px：六门课程仍在', tiny.glyphs, 6);
  checkEqual('340px：六种课程色仍可区分', tiny.distinctHues, 6);
  check('340px：课程色条仍贴在格子上', tiny.barsVisible === true && tiny.cellWidth > 100, JSON.stringify(tiny));
  check('340px：不出现横向滚动', tiny.noHorizontalScroll === true, JSON.stringify(tiny));

  // 340px 下三区叠在一区和二区底下，整页比屏幕高，得滚动才够得着 —— 真人也是
  // 这么做的。先把课表滚到顶：二区 62vh 加三区 128px 一共不到 720，于是这一格
  // 课表和紧挨在它下面的三区 Tag 会同时落在屏内。
  await cdp.evaluate(`
    document.getElementById('zone-board').scrollIntoView({ block: 'start' });
    return true;
  `);
  await sleep(300);

  // 最小尺寸下真的拖一次，确认不是「看起来还在」而已
  const tinyDrag = await cdp.evaluate(`
    const c = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; };
    const onScreen = (p) => p.y > 0 && p.y < innerHeight;
    const from = c(document.querySelector('#zone-tags .tag[data-tag-id="bishuati"]'));
    const to = c(document.querySelector('[data-subject="sheng"]'));
    return {
      before: document.querySelectorAll('[data-subject="sheng"] .asg').length,
      from, to,
      // 两个端点都得真的在屏幕里，拖拽才是在测落位，而不是在测鼠标飘到屏幕外
      reachable: onScreen(from) && onScreen(to),
    };
  `);
  check('340px：滚一下就能同时够到 Tag 与课程格', tinyDrag.reachable === true, JSON.stringify(tinyDrag));

  await drag(cdp, tinyDrag.from, tinyDrag.to);
  await sleep(260);

  checkEqual('340px：拖拽仍然可用（生 上 +1 项）',
    await cdp.evaluate(`return document.querySelectorAll('[data-subject="sheng"] .asg').length;`),
    tinyDrag.before + 1);
  check('340px：落位后无残留拖影',
    (await cdp.evaluate(`return document.querySelectorAll('.drag-ghost').length;`)) === 0);

  await cdp.evaluate(`
    const chips = [...document.querySelectorAll('[data-subject="sheng"] .asg')];
    chips[chips.length - 1].querySelector('.asg__remove').click();
    return true;
  `);
  await sleep(200);

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);

  /* ------------------------------------------------ 设置真正的写入路径
     设置面板不是摆设：改软件信息要立刻反映到一区，「减少动画」要真的把
     过渡压掉，危险操作要真的清空。全部走真实输入事件。 */

  await openSettings(cdp);
  await sleep(360);

  await typeInto(cdp, '#set-about-name', '课堂作业看板');
  await typeInto(cdp, '#set-about-version', 'v0.3.1');
  await typeInto(cdp, '#set-about-author', '张老师');
  await sleep(140);

  const info = await cdp.evaluate(`
    const rows = [...document.querySelectorAll('#zone-info .info-row')].map((r) => r.textContent.trim());
    return {
      name: document.querySelector('.info-id__name').textContent.trim(),
      docTitle: document.title,
      rows: rows.join(' | '),
    };
  `);

  checkEqual('一区软件信息随输入即时更新（名称）', info.name, '课堂作业看板');
  check('一区软件信息随输入即时更新（版本 / 开发者）',
    info.rows.includes('v0.3.1') && info.rows.includes('张老师'), info.rows);
  check('浏览器标题同步软件名称', info.docTitle.includes('课堂作业看板'), info.docTitle);

  /* ------------------------------------------------------ 减少动画开关 */

  const motionBefore = await cdp.evaluate(`
    return {
      on: document.documentElement.classList.contains('reduce-motion'),
      dur: getComputedStyle(document.querySelector('.course-cell')).transitionDuration,
    };
  `);

  await cdp.evaluate(`document.querySelector('.switch[aria-label="减少动画"]').click(); return true;`);
  await sleep(160);

  const motionAfter = await cdp.evaluate(`
    return {
      on: document.documentElement.classList.contains('reduce-motion'),
      checked: document.querySelector('.switch[aria-label="减少动画"]').getAttribute('aria-checked'),
      dur: getComputedStyle(document.querySelector('.course-cell')).transitionDuration,
    };
  `);

  check('「减少动画」开关改变了界面状态',
    motionBefore.on === false && motionAfter.on === true,
    `${JSON.stringify(motionBefore)} → ${JSON.stringify(motionAfter)}`);
  checkEqual('「减少动画」开关自身状态同步（aria-checked）', motionAfter.checked, 'true');
  check('「减少动画」确实压掉了过渡时长',
    parseFloat(motionAfter.dur) <= 0.002 && parseFloat(motionBefore.dur) > 0.05,
    `${motionBefore.dur} → ${motionAfter.dur}`);

  // 设置打开时底层界面是 inert 的：拖拽应当完全打不进去。
  // 这是对 inert 是否真正生效的功能验证，不是看属性值。
  const inertProbe = await cdp.evaluate(`
    const c = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; };
    const tag = document.querySelector('#zone-tags .tag[data-tag-id="bishuati"]');
    return { chips: document.querySelectorAll('.asg').length, from: c(tag), to: c(document.querySelector('[data-subject="wai"]')) };
  `);
  await drag(cdp, inertProbe.from, inertProbe.to);

  const inertAfter = await cdp.evaluate(`
    return { chips: document.querySelectorAll('.asg').length, ghosts: document.querySelectorAll('.drag-ghost').length };
  `);
  check('设置打开时底层被 inert 真正挡住，拖拽打不进去',
    inertProbe.chips > 0 && inertAfter.chips === inertProbe.chips && inertAfter.ghosts === 0,
    `${inertProbe.chips} → ${JSON.stringify(inertAfter)}`);

  await cdp.evaluate(`document.querySelector('.drawer--settings .drawer__close').click(); return true;`);
  await sleep(340);

  // 关掉动画后拖拽逻辑必须照常：动画只是表现层，不能和业务耦合
  const reducedRun = await cdp.evaluate(`
    const c = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; };
    return {
      before: document.querySelectorAll('[data-subject="yu"] .asg').length,
      from: c(document.querySelector('#zone-tags .tag[data-tag-id="bishuati"]')),
      to: c(document.querySelector('[data-subject="yu"]')),
    };
  `);
  await drag(cdp, reducedRun.from, reducedRun.to);
  await sleep(260);

  checkEqual('减少动画时拖拽仍然生效（语 上 +1 项）',
    await cdp.evaluate(`return document.querySelectorAll('[data-subject="yu"] .asg').length;`),
    reducedRun.before + 1);

  await cdp.evaluate(`
    const chips = [...document.querySelectorAll('[data-subject="yu"] .asg')];
    chips[chips.length - 1].querySelector('.asg__remove').click();
    return true;
  `);
  await sleep(200);

  /* -------------------------------------------------- 危险操作就地二次确认 */

  await openSettings(cdp);
  await sleep(360);

  const armed = await cdp.evaluate(`
    const b = document.querySelector('#overlay-root .btn--danger');
    const before = b.textContent.trim();
    b.click();
    return { before, after: b.textContent.trim(), confirming: b.classList.contains('is-confirming') };
  `);
  await sleep(140);

  check('清空按钮第一次点击只进入确认态，不动数据',
    armed.after !== armed.before && armed.confirming === true, JSON.stringify(armed));
  check('确认态下数据确实还在',
    (await cdp.evaluate(`return document.querySelectorAll('.asg').length;`)) > 0);

  await capture(cdp, '06-confirm.png');

  await cdp.evaluate(`document.querySelector('#overlay-root .btn--danger').click(); return true;`);
  await sleep(320);

  const cleared = await cdp.evaluate(`
    const descs = [...document.querySelectorAll('.set-section__desc')];
    return {
      chips: document.querySelectorAll('.asg').length,
      unassigned: [...document.querySelectorAll('.course-cell__count')].filter((n) => n.textContent.trim() === '未布置').length,
      note: document.querySelector('#zone-board .panel-head__note').textContent.trim(),
      desc: descs[descs.length - 1].textContent.trim(),
      stored: JSON.parse(localStorage.getItem('homework-board:v1') || '{}').assignments ?? null,
    };
  `);

  checkEqual('二次确认后作业全部清空', cleared.chips, 0);
  checkEqual('清空后六门课程都回到「未布置」', cleared.unassigned, 6);
  check('清空后二区标题归零', cleared.note.includes('已布置 0 / 6'), cleared.note);
  check('清空后设置里的数据描述同步', cleared.desc.includes('还没有布置'), cleared.desc);
  check('清空后写入 localStorage 的记录也空了',
    cleared.stored !== null && Object.values(cleared.stored).every((list) => list.length === 0),
    JSON.stringify(cleared.stored));

  /* ---------------------------------------- 复位：软件信息留给用户自己填 */

  await typeInto(cdp, '#set-about-name', '作业发布系统');
  await typeInto(cdp, '#set-about-version', '');
  await typeInto(cdp, '#set-about-author', '');
  await cdp.evaluate(`document.querySelector('.switch[aria-label="减少动画"]').click(); return true;`);
  await sleep(200);
  await cdp.evaluate(`document.querySelector('.drawer--settings .drawer__close').click(); return true;`);
  await sleep(340);

  const restored = await cdp.evaluate(`
    return {
      name: document.querySelector('.info-id__name').textContent.trim(),
      unset: document.querySelector('#zone-info').textContent.includes('未设置'),
      motion: document.documentElement.classList.contains('reduce-motion'),
    };
  `);
  checkEqual('复位后名称回到默认', restored.name, '作业发布系统');
  check('复位后版本 / 开发者回到「未设置」', restored.unset === true, JSON.stringify(restored));
  check('复位后动画开关回到关闭', restored.motion === false, JSON.stringify(restored));

  /* ==================================================================
     增量功能：默认 Tag 清单 / 页码 / 自定义 Tag / 双向拖拽 / 颜色跟随 / 全屏

     到这里二区已经被「清空」过一次，所以本节从一个确定的空盘开始，
     每一条断言都能指认具体是哪一次操作产生的。
     ================================================================== */

  const tagGrab = (id) => `.tag[data-tag-id="${id}"] .tag__grab`;
  const pageOf = (id) => `.tag[data-tag-id="${id}"] .tag__page`;

  /* ------------------------------------------------ A. 默认 Tag 与页码占位 */

  const defaultTags = await cdp.evaluate(`
    return [...document.querySelectorAll('.tags-body .tag')].map((n) => ({
      id: n.dataset.tagId,
      label: n.querySelector('.tag__label').textContent.trim(),
      custom: n.classList.contains('tag--custom'),
      pageTag: n.querySelector('.tag__page')?.tagName ?? null,
      hasRemove: !!n.querySelector('.tag__remove'),
    }));
  `);

  // 默认 Tag 是用户点名要的那一份清单，按他给的顺序逐个写死在这里：
  // 拿 tags.js 去比 tags.js 只能证明「自己等于自己」，漏掉一个也不会报。
  checkList('三区默认 Tag 就是用户点名的那 15 枚（顺序也照他给的）',
    defaultTags.map((t) => t.label),
    ['必刷题', 'U加课堂', 'U加课后', '卷子',
      '阅读理解', '七选五', '完形填空', '单句填空', '课文改编填空', '语法填空',
      'A篇', 'B篇', 'C篇', 'D篇', '白皮书']);
  check('默认 Tag 都带页码、都没有删除键（删不掉的是默认，自建的才有 ×）',
    defaultTags.every((t) => t.pageTag === 'BUTTON' && !t.hasRemove), JSON.stringify(defaultTags));

  // 用户的原话是「输入页码时不要调用系统键盘」。系统软键盘是被输入元素唤起的，
  // 所以最硬的证据是：页码控件压根不是输入框。
  checkList('页码控件是 <button> 而不是输入框 —— 没有输入框就弹不出系统键盘',
    [...new Set(defaultTags.map((t) => t.pageTag))], ['BUTTON']);

  const emptyPage = await cdp.evaluate(`
    const n = document.querySelector('.tag[data-tag-id="bishuati"]');
    const page = n.querySelector('.tag__page');
    return {
      text: page.textContent,
      shown: n.querySelector('.tag__label').textContent.trim()
        + n.querySelector('.tag__dash').textContent + page.textContent + n.querySelector('.tag__unit').textContent,
      dashed: page.classList.contains('is-empty'),
    };
  `);
  check('没填页码时显示为「必刷题-页」',
    emptyPage.text === '' && emptyPage.shown === '必刷题-页' && emptyPage.dashed === true,
    JSON.stringify(emptyPage));

  /* ------------------------------------------ B. 页码只能走内置数字键盘 */

  // 在页码上按住往外拖 100px：这是「我要开键盘」，绝不能被当成拖拽
  const pagePoint = await centerOf(cdp, pageOf('bishuati'));
  await drag(cdp, pagePoint, { x: pagePoint.x + 70, y: pagePoint.y + 100 });
  const pageDrag = await cdp.evaluate(`
    return {
      ghosts: document.querySelectorAll('.drag-ghost').length,
      bodyDragging: document.body.classList.contains('is-dragging'),
      tagDimmed: document.querySelector('.tag[data-tag-id="bishuati"]').classList.contains('is-dragging'),
      chips: document.querySelectorAll('.asg').length,
    };
  `);
  check('从页码区拖动不会误触发拖拽',
    pageDrag.ghosts === 0 && !pageDrag.bodyDragging && !pageDrag.tagDimmed && pageDrag.chips === 0,
    JSON.stringify(pageDrag));

  await openKeypad(cdp, 'bishuati');
  const opened = await cdp.evaluate(`
    const pad = document.querySelector('.keypad');
    const btn = document.querySelector('.tag[data-tag-id="bishuati"] .tag__page');
    const active = document.activeElement;
    return {
      open: pad.classList.contains('is-open'),
      inert: pad.inert,
      expanded: btn.getAttribute('aria-expanded'),
      focusedInside: pad.contains(active),
      // 用户要求的那一条：这一刻全页没有任何输入元素拿着焦点
      softKeyboard: !!(active && active.matches('input, textarea, [contenteditable]')),
      visibleInputs: [...document.querySelectorAll('input, textarea, [contenteditable]')]
        .filter((n) => n.offsetParent !== null).length,
    };
  `);
  check('点页码即打开内置键盘，焦点进到键盘里',
    opened.open && !opened.inert && opened.expanded === 'true' && opened.focusedInside === true,
    JSON.stringify(opened));
  check('打开键盘时没有任何输入元素被聚焦 —— 不可能唤起系统键盘',
    opened.softKeyboard === false, JSON.stringify(opened));

  // 贴在 Tag 上方浮出，左右都不出屏
  const padBox = await cdp.evaluate(`
    const pad = document.querySelector('.keypad').getBoundingClientRect();
    const btn = document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').getBoundingClientRect();
    return {
      above: pad.bottom <= btn.top,
      inX: pad.left >= 0 && pad.right <= window.innerWidth,
      gap: Math.round(btn.top - pad.bottom),
    };
  `);
  check('键盘贴在 Tag 上方浮出，横向也没出屏',
    padBox.above && padBox.inX, JSON.stringify(padBox));

  // 触摸目标：按键高度得撑得住手指
  const keyBox = await cdp.evaluate(`
    const keys = [...document.querySelectorAll('.keypad__key')];
    return {
      count: keys.length,
      minH: Math.min(...keys.map((n) => n.getBoundingClientRect().height)),
      digits: keys.filter((n) => /^[0-9]$/.test(n.dataset.key)).length,
    };
  `);
  check('键盘 12 个键：0-9 加清空、退格',
    keyBox.count === 12 && keyBox.digits === 10, JSON.stringify(keyBox));
  check('每个按键的高度 ≥ 44px（手指的尺寸）', keyBox.minH >= 44, `最小 ${keyBox.minH}px`);

  for (const ch of '20') await clickEl(cdp, keypadKey(ch));
  await sleep(200);
  const typedPage = await cdp.evaluate(`
    const n = document.querySelector('.tag[data-tag-id="bishuati"]');
    const page = n.querySelector('.tag__page');
    return {
      text: page.textContent,
      shown: n.querySelector('.tag__label').textContent.trim()
        + n.querySelector('.tag__dash').textContent + page.textContent + n.querySelector('.tag__unit').textContent,
    };
  `);
  check('按数字键 2、0 后 Tag 立刻显示为「必刷题-20页」',
    typedPage.text === '20' && typedPage.shown === '必刷题-20页', JSON.stringify(typedPage));
  await capture(cdp, '14-keypad.png');

  // 三位封顶
  await clickEl(cdp, keypadKey('9'));
  await sleep(160);
  checkEqual('页码最多三位，第四位按键被忽略',
    await cdp.evaluate(`return document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').textContent;`), '209');

  await clickEl(cdp, keypadKey('back'));
  await sleep(160);
  checkEqual('退格去掉最后一位',
    await cdp.evaluate(`return document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').textContent;`), '20');

  // 首位 0 忽略：否则 normalizePage 会把「05」归一成 5，显示和状态从此对不上
  await clickEl(cdp, keypadKey('clear'));
  await sleep(120);
  await clickEl(cdp, keypadKey('0'));
  await sleep(160);
  const afterLeadingZero = await cdp.evaluate(`
    return {
      text: document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').textContent,
      // 空页码时两个功能键没有可清、可退的东西，应当禁用
      clearDisabled: document.querySelector('.keypad__key[data-key="clear"]').disabled,
      backDisabled: document.querySelector('.keypad__key[data-key="back"]').disabled,
    };
  `);
  check('首位按 0 不生效，「05」这类会被归一成 5 的输入进不来',
    afterLeadingZero.text === '', JSON.stringify(afterLeadingZero));
  check('页码为空时「清空」「退格」是禁用的',
    afterLeadingZero.clearDisabled === true && afterLeadingZero.backDisabled === true,
    JSON.stringify(afterLeadingZero));

  // 物理数字键：键盘开着的时候也能用，桌面端不必去点
  for (const ch of '20') await clickEl(cdp, keypadKey(ch));
  await sleep(160);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: '3', text: '3', windowsVirtualKeyCode: 51, nativeVirtualKeyCode: 51,
  });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '3', windowsVirtualKeyCode: 51, nativeVirtualKeyCode: 51 });
  await sleep(200);
  checkEqual('键盘打开时物理数字键也能输',
    await cdp.evaluate(`return document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').textContent;`), '203');

  // 三种关法：完成、Esc、点键盘外面
  await clickEl(cdp, KEYPAD_DONE);
  const afterDone = await cdp.evaluate(`
    return {
      padOpen: document.querySelector('.keypad').classList.contains('is-open'),
      text: document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').textContent,
    };
  `);
  check('按「完成」关闭键盘，页码留在 203',
    afterDone.padOpen === false && afterDone.text === '203', JSON.stringify(afterDone));

  await openKeypad(cdp, 'bishuati');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(220);
  const afterEsc = await cdp.evaluate(`
    return {
      padOpen: document.querySelector('.keypad').classList.contains('is-open'),
      expanded: document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').getAttribute('aria-expanded'),
      // Esc 只关键盘，不该顺手把点选或全屏一起取消掉
      selected: document.querySelectorAll('.tag.is-selected').length,
    };
  `);
  check('Esc 关掉键盘，且只关键盘',
    afterEsc.padOpen === false && afterEsc.expanded === 'false', JSON.stringify(afterEsc));

  await openKeypad(cdp, 'bishuati');
  await clickPoint(cdp, 20, 20);   // 视口左上角：键盘在 x≥300 那一带，够不着
  check('点键盘外面也关',
    (await cdp.evaluate(`return document.querySelector('.keypad').classList.contains('is-open');`)) === false);

  // 换一枚 Tag：非模态键盘原地改指，不用先关再开
  await clickEl(cdp, pageOf('bishuati'));
  await sleep(140);
  await clickEl(cdp, pageOf('juanzi'));
  await sleep(200);
  const retarget = await cdp.evaluate(`
    const title = document.querySelector('.keypad__title').textContent;
    return {
      open: document.querySelector('.keypad').classList.contains('is-open'),
      title,
      former: document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').getAttribute('aria-expanded'),
      current: document.querySelector('.tag[data-tag-id="juanzi"] .tag__page').getAttribute('aria-expanded'),
    };
  `);
  check('键盘开着时直接点另一枚 Tag 的页码，键盘原地改指（非模态）',
    retarget.open && retarget.title.startsWith('卷子')
      && retarget.former === 'false' && retarget.current === 'true',
    JSON.stringify(retarget));
  await clickEl(cdp, KEYPAD_DONE);
  await sleep(160);

  /* ------------------- C. 页码属于布置：用过即重置，各记各的
     用户的原话是「页码每次使用过后都要重置」。所以页码不能挂在 Tag 上 ——
     挂上去就成了「必刷题在语上是 20 页、拖到数学上还是 20 页」，除非手动改。
     现在三区那个数字是**输入缓冲**：落进格子的那一刻，它被这条布置带走并清空，
     下一次重新填。缓冲改了不牵动已经落位的那条，两者从落位起就脱钩了。 */

  await dragBetween(cdp, tagGrab('bishuati'), '[data-subject="yu"]');
  checkList('带页码的 Tag 拖进「语」，格内就是「必刷题-203页」',
    await chipsIn(cdp, 'yu'), ['必刷题-203页']);

  const afterPlace = await cdp.evaluate(`
    const n = document.querySelector('.tag[data-tag-id="bishuati"]');
    const page = n.querySelector('.tag__page');
    const stored = (JSON.parse(localStorage.getItem('homework-board:v1') || '{}').assignments || {}).yu;
    return {
      tagPage: page.textContent,
      tagEmpty: page.classList.contains('is-empty'),
      stored,
    };
  `);
  check('用过即重置：落位之后三区那枚 Tag 的页码自己清空',
    afterPlace.tagPage === '' && afterPlace.tagEmpty === true, JSON.stringify(afterPlace));
  check('而这条布置自己带着页码（写进了 state，不只是画在界面上）',
    Array.isArray(afterPlace.stored)
      && afterPlace.stored[0]?.tagId === 'bishuati' && afterPlace.stored[0]?.page === 203,
    JSON.stringify(afterPlace.stored));

  // 缓冲改了不牵动已落位的那条 —— 它已经跟这枚 Tag 脱钩了
  await setPageViaKeypad(cdp, 'bishuati', '38');
  checkList('改三区缓冲的页码，已经布置在格内的那条纹丝不动',
    await chipsIn(cdp, 'yu'), ['必刷题-203页']);

  // 同一枚 Tag 放到另一门课：拿到的是这次填的 38
  await dragBetween(cdp, tagGrab('bishuati'), '[data-subject="shu"]');
  checkList('同一枚 Tag 放到另一门课，带的是这次填的页码', await chipsIn(cdp, 'shu'), ['必刷题-38页']);
  checkList('先放的那门课仍是自己的页码（各记各的）', await chipsIn(cdp, 'yu'), ['必刷题-203页']);
  checkEqual('第二次落位后缓冲又清空了',
    await cdp.evaluate(`return document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').textContent;`), '');

  // 缓冲空着的时候落位，那条布置就没有页码 —— 「用过的页码不会跟着下一门课走」
  await dragBetween(cdp, tagGrab('bishuati'), '[data-subject="wu"]');
  checkList('缓冲是空的时候落位，那一条就没有页码', await chipsIn(cdp, 'wu'), ['必刷题']);

  // 名字与页码是两个节点：名字可以被省略号截短，页码不许被截
  const chipNodes = await cdp.evaluate(`
    const n = document.querySelector('[data-subject="yu"] .asg');
    const page = n.querySelector('.asg__page');
    return {
      label: n.querySelector('.asg__label').textContent,
      page: page.textContent,
      pageOverflow: page.scrollWidth - page.clientWidth,
      flex: getComputedStyle(page).flexGrow + '/' + getComputedStyle(page).flexShrink,
    };
  `);
  check('格内作业的名字与页码是两个节点，各管各的省略',
    chipNodes.label === '必刷题' && chipNodes.page === '-203页', JSON.stringify(chipNodes));
  check('页码那一段不参与压缩（flex: none），永远不会被省略号吃掉',
    chipNodes.flex === '0/0', JSON.stringify(chipNodes));

  /* ------------------------------------------------ D. 颜色跟随目标课程 */

  for (const subject of SUBJECTS) {
    await dragBetween(cdp, tagGrab('juanzi'), `[data-subject="${subject.id}"]`);
  }

  const colorAudit = await cdp.evaluate(`
    const toHexRgb = (hex) => {
      const v = parseInt(String(hex).replace('#', ''), 16);
      return 'rgb(' + ((v >> 16) & 255) + ', ' + ((v >> 8) & 255) + ', ' + (v & 255) + ')';
    };
    return [...document.querySelectorAll('.course-cell')].map((cell) => {
      const chips = [...cell.querySelectorAll('.asg')];
      const deep = cell.style.getPropertyValue('--deep');
      const edge = cell.style.getPropertyValue('--edge');
      return {
        subject: cell.dataset.subject,
        count: chips.length,
        deep,
        allTextMatch: chips.every((c) => getComputedStyle(c).color === toHexRgb(deep)),
        allEdgeMatch: chips.every((c) => getComputedStyle(c).borderTopColor === toHexRgb(edge)),
        firstText: chips.length ? getComputedStyle(chips[0]).color : null,
      };
    });
  `);

  for (const row of colorAudit) {
    const subject = SUBJECTS.find((s) => s.id === row.subject);
    check(`「卷子」落到 ${subject.glyph} 上就长成 ${subject.glyph} 的颜色`,
      row.count > 0
        && row.allTextMatch
        && row.allEdgeMatch
        && row.firstText === hexToRgb(subject.color.deep)
        && row.deep === subject.color.deep,
      `${JSON.stringify(row)} 期望 ${subject.color.deep}`);
  }
  checkEqual('六门课的作业文字色两两不同',
    new Set(colorAudit.map((row) => row.firstText)).size, 6);

  const trayNeutral = await cdp.evaluate(`
    const tag = document.querySelector('.tag[data-tag-id="juanzi"]');
    const cs = getComputedStyle(tag);
    return {
      color: cs.color,
      background: cs.backgroundColor,
      border: cs.borderTopColor,
      cellTexts: [...document.querySelectorAll('.course-cell .asg')].map((c) => getComputedStyle(c).color),
      cellTints: [...document.querySelectorAll('.course-cell .asg')].map((c) => getComputedStyle(c).backgroundColor),
    };
  `);
  check('三区里的 Tag 不预先带任何课程色（落下才染色）',
    !trayNeutral.cellTexts.includes(trayNeutral.color)
      && !trayNeutral.cellTints.includes(trayNeutral.background),
    JSON.stringify({ color: trayNeutral.color, background: trayNeutral.background }));

  /* ---------------------------------------------------- E. 自定义 Tag */

  await clickEl(cdp, '.tag-add');
  const composeOpen = await cdp.evaluate(`
    const form = document.querySelector('.tag-compose');
    return {
      open: !form.hidden,
      focused: document.activeElement === form.querySelector('.tag-compose__input'),
      addHidden: document.querySelector('.tag-add').hidden,
    };
  `);
  check('点「+ 自定义 Tag」展开输入行并聚焦',
    composeOpen.open && composeOpen.focused && composeOpen.addHidden, JSON.stringify(composeOpen));

  await clickEl(cdp, '.tag-compose__ok');
  checkEqual('空名字不会创建出 Tag（还是默认那几枚）',
    await cdp.evaluate(`return document.querySelectorAll('.tags-body .tag').length;`), DEFAULT_TAGS.length);

  await typeInto(cdp, '.tag-compose__input', '数学作业');
  await clickEl(cdp, '.tag-compose__ok');
  await sleep(240);

  const created = await cdp.evaluate(`
    const n = document.querySelector('.tags-body .tag--custom');
    return n ? {
      id: n.dataset.tagId,
      label: n.querySelector('.tag__label').textContent.trim(),
      removable: !!n.querySelector('.tag__remove'),
    } : null;
  `);
  check('自定义 Tag 建好就出现在三区，名字就是输入的名字',
    created !== null && created.label === '数学作业', JSON.stringify(created));
  checkEqual('创建后三区多了一枚（默认 + 自建）',
    await cdp.evaluate(`return document.querySelectorAll('.tags-body .tag').length;`), DEFAULT_TAGS.length + 1);

  await dragBetween(cdp, tagGrab(created.id), '[data-subject="hua"]');
  checkList('自定义 Tag 和默认 Tag 走同一套拖拽逻辑',
    await chipsIn(cdp, 'hua'), ['卷子', '数学作业']);

  const customColor = await cdp.evaluate(`
    const cell = document.querySelector('[data-subject="hua"]');
    const chip = [...cell.querySelectorAll('.asg')].find((n) => n.textContent.includes('数学作业'));
    const v = parseInt(cell.style.getPropertyValue('--deep').replace('#', ''), 16);
    return {
      chip: getComputedStyle(chip).color,
      deep: 'rgb(' + ((v >> 16) & 255) + ', ' + ((v >> 8) & 255) + ', ' + (v & 255) + ')',
    };
  `);
  check('自定义 Tag 进课程后同样继承该课程的颜色',
    customColor.chip === customColor.deep, JSON.stringify(customColor));

  /* ------------------------------- E2. 自定义 Tag 也能填页码
     这是用户这次直接提的第一件事。以前 makeCustomTag 把 supportsPage 写死
     成 false，写入与显示两处都把它挡在外面，README 里还专门写着「不支持」。 */

  const customPageUi = await cdp.evaluate(`
    const n = document.querySelector('.tags-body .tag--custom');
    const page = n.querySelector('.tag__page');
    return { tag: page?.tagName ?? null, empty: page?.classList.contains('is-empty') };
  `);
  check('自定义 Tag 上就有页码控件，和默认 Tag 一模一样',
    customPageUi.tag === 'BUTTON' && customPageUi.empty === true, JSON.stringify(customPageUi));

  await setPageViaKeypad(cdp, created.id, '20');
  await sleep(400);
  const customPaged = await cdp.evaluate(`
    const n = document.querySelector('.tags-body .tag--custom');
    const stored = JSON.parse(localStorage.getItem('homework-board:v1') || '{}');
    return {
      shown: n.querySelector('.tag__label').textContent.trim()
        + n.querySelector('.tag__page-wrap').textContent,
      hua: [...document.querySelectorAll('[data-subject="hua"] .asg')].map((x) => x.textContent.trim()),
      stored: (stored.tags?.pages ?? {})[${JSON.stringify(created.id)}] ?? null,
    };
  `);
  checkEqual('自定义 Tag 填了页码，Tag 上显示「数学作业-20页」',
    customPaged.shown, '数学作业-20页');
  checkList('但已经落进格内的那条不跟着变 —— 页码在落位那一刻就归它自己了',
    customPaged.hua, ['卷子', '数学作业']);
  check('填进缓冲的页码真的落进了 state（不只是画在界面上）',
    customPaged.stored === 20, JSON.stringify(customPaged));

  // 缓冲里的 20 页没有丢，它等的是下一次落位
  await dragBetween(cdp, tagGrab(created.id), '[data-subject="wu"]');
  // 「物」上先有 C 段落位的那条必刷题、再有 D 段给六门课都放的卷子，这条排第三
  checkList('同一枚自定义 Tag 再放到「物」上，这次带着 20 页',
    await chipsIn(cdp, 'wu'), ['必刷题', '卷子', '数学作业-20页']);
  checkList('「化」上先放的那条仍然没有页码（各记各的，不回头改）',
    await chipsIn(cdp, 'hua'), ['卷子', '数学作业']);

  await capture(cdp, '07-tags-page.png');

  await clickEl(cdp, '.tag-add');
  await typeInto(cdp, '.tag-compose__input', '数学作业');
  await clickEl(cdp, '.tag-compose__ok');
  await sleep(240);
  checkEqual('重名不会建出第二个（还是这么多）',
    await cdp.evaluate(`return document.querySelectorAll('.tags-body .tag').length;`), DEFAULT_TAGS.length + 1);
  await clickEl(cdp, '.tag-compose__cancel');
  check('取消后回到「+ 自定义 Tag」',
    (await cdp.evaluate(`return document.querySelector('.tag-add').hidden === false && document.querySelector('.tag-compose').hidden === true;`)) === true);

  // 多个自定义 Tag 同时存在，各自独立
  await clickEl(cdp, '.tag-add');
  await typeInto(cdp, '.tag-compose__input', '周记');
  await clickEl(cdp, '.tag-compose__ok');
  await sleep(260);

  checkList('两个自定义 Tag 可以同时存在',
    await cdp.evaluate(`return [...document.querySelectorAll('.tags-body .tag--custom .tag__label')].map((n) => n.textContent.trim());`),
    ['数学作业', '周记']);

  const secondId = await cdp.evaluate(`
    const n = [...document.querySelectorAll('.tags-body .tag--custom')]
      .find((el2) => el2.textContent.includes('周记'));
    return n ? n.dataset.tagId : null;
  `);
  await dragBetween(cdp, tagGrab(secondId), '[data-subject="wai"]');

  const huaAfter = await chipsIn(cdp, 'hua');
  const waiAfter = await chipsIn(cdp, 'wai');
  // 「化」上那条数学作业是先落位、后填的页码，所以它身上没有页码（各记各的）；
  // 带 20 页的是「物」上那一条，见上面。
  checkList('两个自定义 Tag 各自独立，互不影响',
    [huaAfter, waiAfter], [['卷子', '数学作业'], ['卷子', '周记']]);

  await clickEl(cdp, `.tag[data-tag-id="${secondId}"] .tag__remove`);
  await sleep(280);
  checkList('删掉第二个只影响它自己：外的作业被清掉', await chipsIn(cdp, 'wai'), ['卷子']);
  checkEqual('第一个自定义 Tag 与它的布置纹丝不动',
    await cdp.evaluate(`return document.querySelectorAll('.tags-body .tag--custom').length;`), 1);
  checkList('第一个自定义 Tag 的布置仍在', await chipsIn(cdp, 'hua'), ['卷子', '数学作业']);

  /* -------------------------------------------------- 刷新后这些都还在 */

  await sleep(500);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1400);

  const afterIncrementReload = await cdp.evaluate(`
    const n = document.querySelector('.tags-body .tag--custom');
    return {
      tags: document.querySelectorAll('.tags-body .tag').length,
      custom: n ? n.querySelector('.tag__label').textContent.trim() : null,
      customPage: n ? n.querySelector('.tag__page').textContent : null,
      page: document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').textContent,
      hua: [...document.querySelectorAll('[data-subject="hua"] .asg')].map((x) => x.textContent.trim()),
      wu: [...document.querySelectorAll('[data-subject="wu"] .asg')].map((x) => x.textContent.trim()),
      yu: [...document.querySelectorAll('[data-subject="yu"] .asg')].map((x) => x.textContent.trim()),
    };
  `);
  check('刷新后自定义 Tag 还在', afterIncrementReload.custom === '数学作业', JSON.stringify(afterIncrementReload));
  checkList('刷新后带页码的布置还在（页码跟着布置一起恢复）',
    afterIncrementReload.yu, ['必刷题-203页', '卷子']);
  checkList('刷新后自定义 Tag 的布置还在，各是各的页码',
    afterIncrementReload.hua, ['卷子', '数学作业']);
  checkList('同一枚自定义 Tag 落到别处那条，页码也在',
    afterIncrementReload.wu, ['必刷题', '卷子', '数学作业-20页']);
  // 落位时清掉的缓冲不该被刷新「捞」回来：页码已经在布置身上，回填只会让它
  // 出现在下一门课上。这条断了，用户就会看到「明明用过了，三区又冒出个 20」。
  checkEqual('刷新后三区的页码缓冲仍然是空的（用过的页码没有回填）',
    afterIncrementReload.page, '');
  checkEqual('自定义 Tag 上的缓冲同样是空的', afterIncrementReload.customPage, '');

  /* ------------------------------------------- F. 格内作业拖回三区 = 撤销 */

  const retractFrom = await centerOf(cdp, '[data-subject="yu"] .asg:first-child .asg__label');
  const retractTo = await centerOf(cdp, '#zone-tags .tags-body');
  let retractMid = null;
  await drag(cdp, retractFrom, retractTo, {
    at: 1,   // 采样点放在最后一步：这一刻指针确实压在三区上
    onProgress: async () => {
      retractMid = await cdp.evaluate(`
        return {
          ghosts: document.querySelectorAll('.drag-ghost').length,
          chipDimmed: document.querySelector('[data-subject="yu"] .asg').classList.contains('is-dragging'),
          trayLit: document.querySelector('.tags-body').classList.contains('is-drop-target'),
          trayDimmedRule: document.querySelector('.tags-body').classList.contains('is-dragging-tag'),
        };
      `);
    },
  });

  checkList('把「必刷题-20页」拖回三区，语这一格就撤销了',
    await chipsIn(cdp, 'yu'), ['卷子']);
  check('撤销途中：拖影在、原条目变淡、三区亮起接收态',
    retractMid !== null && retractMid.ghosts === 1 && retractMid.chipDimmed
      && retractMid.trayLit && !retractMid.trayDimmedRule,
    JSON.stringify(retractMid));

  const afterRetract = await cdp.evaluate(`
    const t = document.querySelector('.tag[data-tag-id="bishuati"]');
    return {
      ghosts: document.querySelectorAll('.drag-ghost').length,
      tagPresent: !!t,
      tagDimmed: t.classList.contains('is-dragging'),
      trayHeld: document.querySelector('.tags-body').classList.contains('is-dragging-tag'),
      page: t.querySelector('.tag__page').textContent,
      stored: (JSON.parse(localStorage.getItem('homework-board:v1') || '{}').assignments || {}).yu,
    };
  `);
  check('撤销后：不留拖影、Tag 回到原位不变淡',
    afterRetract.ghosts === 0 && afterRetract.tagPresent
      && !afterRetract.tagDimmed && !afterRetract.trayHeld,
    JSON.stringify(afterRetract));
  check('撤销是真改数据（localStorage 里语也没了这一条）',
    afterRetract.stored !== undefined && !afterRetract.stored.includes('bishuati'),
    JSON.stringify(afterRetract.stored));
  // 旧模型下这里验的是「撤销不会把页码清掉」—— 那时页码挂在 Tag 上。现在反过来：
  // 落位那一刻缓冲就清了，撤销没有「谁的页码」可以还。硬要还的话，用户手里正给
  // 下一门课填的数字会被一次撤销弄没。所以撤销之后三区是空的，要重新填。
  check('撤销不会把用过的页码塞回三区（缓冲仍然是空的）',
    afterRetract.page === '', JSON.stringify(afterRetract.page));

  await setPageViaKeypad(cdp, 'bishuati', '20');   // 撤销之后重新填 —— 「用过即重置」的代价
  await dragBetween(cdp, tagGrab('bishuati'), '[data-subject="yu"]');
  checkList('撤销之后的 Tag 可以重新拖进去（填了新页码，就带新的）',
    await chipsIn(cdp, 'yu'), ['卷子', '必刷题-20页']);

  /* ------------------------------------------------------- G. 格 → 格 改课 */

  await dragBetween(cdp, '[data-subject="sheng"] .asg:first-child .asg__label', '[data-subject="shu"]');
  checkList('拖到已经有这一条的课上：原格撤下，目标格不重复',
    await chipsIn(cdp, 'sheng'), []);
  checkEqual('目标格里的「卷子」仍然只有一条',
    (await chipsIn(cdp, 'shu')).filter((t) => t === '卷子').length, 1);

  await dragBetween(cdp, '[data-subject="yu"] .asg:nth-child(2) .asg__label', '[data-subject="sheng"]');
  const movedColor = await cdp.evaluate(`
    const cell = document.querySelector('[data-subject="sheng"]');
    const chip = cell.querySelector('.asg');
    const v = parseInt(cell.style.getPropertyValue('--deep').replace('#', ''), 16);
    return {
      sheng: [...cell.querySelectorAll('.asg')].map((n) => n.textContent.trim()),
      yu: [...document.querySelectorAll('[data-subject="yu"] .asg')].map((n) => n.textContent.trim()),
      chip: getComputedStyle(chip).color,
      deep: 'rgb(' + ((v >> 16) & 255) + ', ' + ((v >> 8) & 255) + ', ' + (v & 255) + ')',
      page: chip.querySelector('.asg__page').textContent === '-20页',
    };
  `);
  checkList('格到格：作业换了一门课', movedColor.sheng, ['必刷题-20页']);
  checkList('格到格：原来那一格已经撤下', movedColor.yu, ['卷子']);
  check('改课后颜色随之变成新课程的颜色', movedColor.chip === movedColor.deep, JSON.stringify(movedColor));
  check('改课后页码跟着一起走', movedColor.page === true, JSON.stringify(movedColor));

  /* -------------------------------------------------- 删除自定义 Tag */

  await clickEl(cdp, `.tag[data-tag-id="${created.id}"] .tag__remove`);
  await sleep(280);
  checkEqual('删掉自定义 Tag，三区回到默认那些',
    await cdp.evaluate(`return document.querySelectorAll('.tags-body .tag').length;`), DEFAULT_TAGS.length);
  checkList('删掉自定义 Tag，它已布置的那条也一起清掉',
    await chipsIn(cdp, 'hua'), ['卷子']);

  /* --------------------------------------------------- H. 二区独立全屏 */

  const fsBefore = await cdp.evaluate(`
    const btn = document.querySelector('#zone-board .head-btn');
    const foot = document.querySelector('#zone-board .panel-foot');
    const board = document.querySelector('#zone-board .board-body');
    const b = btn.getBoundingClientRect();
    const f = foot.getBoundingClientRect();
    return {
      label: btn.querySelector('.head-btn__text').textContent.trim(),
      inFoot: foot.contains(btn),
      inHead: !!document.querySelector('#zone-board .panel-head .head-btn'),
      belowBoard: f.top >= board.getBoundingClientRect().bottom - 1,
      rightAligned: b.right <= f.right + 1 && b.left > f.left + f.width / 2,
      btnH: b.height,
      inZone: document.getElementById('zone-board').contains(foot),
      chips: document.querySelectorAll('.asg').length,
      page: document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').textContent,
      assignment: JSON.stringify(JSON.parse(localStorage.getItem('homework-board:v1') || '{}').assignments),
    };
  `);
  check('全屏入口是二区上一个小按钮，不是满屏大按钮',
    fsBefore.label === '全屏' && fsBefore.btnH < 40, JSON.stringify(fsBefore));
  check('全屏入口在二区页脚，标题条上已经没有了（用户：「全屏改到二区下方」）',
    fsBefore.inFoot === true && fsBefore.inHead === false, JSON.stringify(fsBefore));
  check('页脚压在课程表下沿，按钮靠右',
    fsBefore.belowBoard === true && fsBefore.rightAligned === true && fsBefore.inZone === true,
    JSON.stringify(fsBefore));

  await clickEl(cdp, '#zone-board .head-btn');
  await sleep(600);

  const fsOn = await cdp.evaluate(`
    const el = document.getElementById('zone-board');
    const r = el.getBoundingClientRect();
    return {
      fullscreenId: document.fullscreenElement ? document.fullscreenElement.id : null,
      isBoard: document.fullscreenElement === el,
      coversWidth: Math.abs(r.width - window.innerWidth) <= 1,
      coversHeight: Math.abs(r.height - window.innerHeight) <= 1,
      appFullscreen: document.fullscreenElement === document.getElementById('app'),
      siblingsAlive: ['zone-info', 'zone-tags'].every((id) => !!document.getElementById(id)),
      label: el.querySelector('.head-btn__text').textContent.trim(),
      order: [...document.querySelectorAll('.course-cell')]
        .map((c) => c.querySelector('.course-cell__glyph').textContent.trim() + ':' + c.dataset.subject),
      blocks: document.querySelectorAll('.board-block').length,
      chips: document.querySelectorAll('.asg').length,
      assignment: JSON.stringify(JSON.parse(localStorage.getItem('homework-board:v1') || '{}').assignments),
    };
  `);

  check('点全屏后进全屏的只有作业安排表这一块',
    fsOn.isBoard === true, JSON.stringify({ fullscreenId: fsOn.fullscreenId, isBoard: fsOn.isBoard }));
  check('全屏后作业安排表铺满整个可用画面',
    fsOn.coversWidth && fsOn.coversHeight, JSON.stringify({ w: fsOn.coversWidth, h: fsOn.coversHeight }));
  check('全屏的是二区本身，不是整个应用，一区三区也没有被拆掉',
    fsOn.appFullscreen === false && fsOn.siblingsAlive === true, JSON.stringify(fsOn.siblingsAlive));
  checkList('全屏后 2×3 课程位置一个没动',
    fsOn.order, SUBJECTS.map((s) => `${s.glyph}:${s.id}`));
  checkEqual('全屏后仍是左右两个表格块', fsOn.blocks, 2);
  checkEqual('全屏后已布置的作业没有丢', fsOn.chips, fsBefore.chips);
  check('进全屏不改动任何数据', fsOn.assignment === fsBefore.assignment, fsOn.assignment);
  check('全屏后按钮变成「退出全屏」', fsOn.label === '退出全屏', fsOn.label);

  await capture(cdp, '08-fullscreen.png');

  // Esc 退出（浏览器自身的退出键，也是我们约定的快捷键）
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await sleep(600);

  const fsOff = await cdp.evaluate(`
    return {
      fullscreen: document.fullscreenElement ? document.fullscreenElement.id : null,
      label: document.querySelector('#zone-board .head-btn__text').textContent.trim(),
      chips: document.querySelectorAll('.asg').length,
      page: document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').textContent,
      inLayout: document.getElementById('zone-board').getBoundingClientRect().width
        < window.innerWidth,
    };
  `);
  check('Esc 能退出全屏', fsOff.fullscreen === null, JSON.stringify(fsOff));
  check('退出后按钮回到「全屏」', fsOff.label === '全屏', fsOff.label);
  check('退出全屏后回到原来的分区布局', fsOff.inLayout === true, String(fsOff.inLayout));
  checkEqual('退出全屏后作业数量不变', fsOff.chips, fsOn.chips);
  checkEqual('退出全屏后三区的页码缓冲不变', fsOff.page, fsBefore.page);

  // 再进一次，这回用按钮退出
  await clickEl(cdp, '#zone-board .head-btn');
  await sleep(600);
  await clickEl(cdp, '#zone-board .head-btn');
  await sleep(600);
  const fsBtnOff = await cdp.evaluate(`
    return {
      fullscreen: document.fullscreenElement ? document.fullscreenElement.id : null,
      chips: document.querySelectorAll('.asg').length,
      yu: [...document.querySelectorAll('[data-subject="yu"] .asg')].map((n) => n.textContent.trim()),
    };
  `);
  check('按钮也能退出全屏', fsBtnOff.fullscreen === null, JSON.stringify(fsBtnOff));
  checkList('两次进出全屏之后布置仍然是原样', fsBtnOff.yu, ['卷子']);

  /* ================================================================ J. 字号
     前面测过的都是「原有功能没坏」，从这里开始测这次新加的东西。
     先清干净重来，字号和历史都从初始状态起步。 */

  await cdp.evaluate(`localStorage.clear(); return true;`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1400);

  /* -------------------------------------------- 一区改版后原功能仍在
     这三样是「一区真的还是原来那个一区」的验尸点：软件名、两个信息行、
     设置入口。改版把 .info-foot / .info-row 原样留在栏底，就是为了它们。 */

  const reshaped = await cdp.evaluate(`
    const rows = [...document.querySelectorAll('#zone-info .info-row')];
    return {
      head: document.querySelector('#zone-info .panel-head__title')?.textContent.trim(),
      hasFoot: !!document.querySelector('#zone-info .info-foot'),
      name: document.querySelector('.info-id__name')?.textContent.trim(),
      rowLabels: rows.map((r) => r.querySelector('.info-row__label').textContent.trim()),
      rowValues: rows.map((r) => r.querySelector('.info-row__value').textContent.trim()),
      unsetCount: (document.getElementById('zone-info').textContent.match(/未设置/g) ?? []).length,
      ariaLabel: document.getElementById('zone-info').getAttribute('aria-label'),
      blocks: [...document.querySelectorAll('#zone-info .tools-block__title')].map((n) => n.textContent.trim()),
      segCount: document.querySelectorAll('#zone-info .seg__btn').length,
    };
  `);

  checkEqual('一区标题是「功能区」', reshaped.head, '功能区');
  checkEqual('一区读屏名称改成「功能区」', reshaped.ariaLabel, '功能区');
  checkEqual('软件名仍在', reshaped.name, '作业发布系统');
  checkEqual('版本 / 开发者两行仍在', reshaped.rowLabels.join('/'), '版本/开发者');
  checkEqual('两个值都还是「未设置」', reshaped.rowValues.join('/'), '未设置/未设置');
  checkEqual('软件信息仍在栏底', reshaped.hasFoot, true);
  check('「未设置」在一区里读得到（不是被藏起来或删掉）', reshaped.unsetCount === 2, String(reshaped.unsetCount));
  checkList('三块工具按 字号 / 快捷 / 历史 排', reshaped.blocks, ['字号', '快捷', '历史']);
  checkEqual('字号档位四个按钮', reshaped.segCount, FONT_STEPS.length);

  await clickEl(cdp, SETTINGS_BTN);
  await sleep(380);
  // 抽屉的根节点一直在 DOM 里，开着的时候才有 is-open —— 只能按这个判断
  checkEqual('栏底的设置入口仍然打开设置抽屉',
    await cdp.evaluate(`return !!document.querySelector('.drawer--settings.is-open');`), true);
  checkEqual('设置抽屉打开时一区被 inert 挡住',
    await cdp.evaluate(`return document.getElementById('app').inert === true;`), true);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(380);

  /* ------------------------------------------------ 四个档位真的改字号
     断言的是**计算出来的字号**，不是根节点的类名 —— 类名挂对了但 CSS 没跟上
     是最容易出的错，只有读计算值才抓得住。要跟着变的是两处、两条阶梯：
     正文字号来自 --fs-base(13px) × --fs-scale，
     课程格大字来自 --glyph-half × --glyph-scale × 块内容盒高 / 100。

     大字那条不能写成「= 某个 px × 系数」：它的尺寸由格子高推出来，格子高又
     由窗口决定。所以这里把块的内容盒高一起量回来，再算期望值 —— 关系对不对
     与窗口多大无关。大字的墨迹也一并量了，用来验用户真正提的那两件事。 */

  const fontTable = [];
  for (const step of FONT_STEPS) {
    await clickEl(cdp, fontStepBtn(step.id));
    await sleep(320);

    const seen = await cdp.evaluate(`
      const cell = document.querySelector('.course-cell');
      const block = cell.closest('.board-block');
      const glyph = cell.querySelector('.course-cell__glyph');
      const cs = getComputedStyle(document.body);
      const gcs = getComputedStyle(glyph);
      const bcs = getComputedStyle(block);
      const bb = block.getBoundingClientRect();
      const cb = cell.getBoundingClientRect();
      // cqh 量的是容器的内容盒，所以期望值也要按内容盒算，不能拿外框高糊过去
      const contentH = bb.height
        - Number.parseFloat(bcs.borderTopWidth) - Number.parseFloat(bcs.borderBottomWidth);
      const fontPx = Number.parseFloat(gcs.fontSize);
      // 墨迹要用**当前这个字号**量，不能用 1000px 的替身 —— 字形微调随字号变
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = gcs.fontWeight + ' ' + fontPx + 'px ' + gcs.fontFamily;
      const mt = ctx.measureText(glyph.textContent.trim());
      return {
        scale: cs.getPropertyValue('--fs-scale').trim(),
        glyphScale: gcs.getPropertyValue('--glyph-scale').trim(),
        glyphHalf: gcs.getPropertyValue('--glyph-half').trim(),
        body: Number.parseFloat(cs.fontSize),
        glyph: fontPx,
        ink: mt.actualBoundingBoxAscent + mt.actualBoundingBoxDescent,
        cellH: cb.height,
        contentH,
        glyphText: glyph.textContent.trim(),
        rootClasses: [...document.documentElement.classList].filter((c) => c.startsWith('fs-')),
        pressed: [...document.querySelectorAll('#zone-info .seg__btn')]
          .filter((b) => b.getAttribute('aria-pressed') === 'true')
          .map((b) => b.dataset.fontStep),
        bodyFontSizeRaw: cs.fontSize,
      };
    `);

    const want = CSS_SCALE[step.id];
    const wantGlyph = (GLYPH_HALF / 100) * seen.contentH * GLYPH_SCALE[step.id];
    fontTable.push(`${step.id}:${seen.bodyFontSizeRaw}/${seen.glyph.toFixed(1)}px`);
    check(`字号「${step.label}」：正文计算值 = ${FS_BASE}px × ${want}`, Math.abs(seen.body - FS_BASE * want) < 0.05,
      `期望 ${FS_BASE * want}，实际 ${seen.body}`);
    check(`字号「${step.label}」：课程格大字 = ${GLYPH_HALF}cqh × ${GLYPH_SCALE[step.id]} × 块内容盒高`,
      Math.abs(seen.glyph - wantGlyph) < 0.15,
      `期望 ${wantGlyph.toFixed(2)}（内容盒 ${seen.contentH.toFixed(1)} × ${GLYPH_HALF}% × ${GLYPH_SCALE[step.id]}），实际 ${seen.glyph}`);
    // 比数值不比字符串：自定义属性拿到的是 CSS 里那一行原文，
    // 源码写 `.317`、JS 里是 0.317，文本比对会假红。
    check(`字号「${step.label}」：--glyph-scale 与 --glyph-half 真的解析到了格子上`,
      Math.abs(Number.parseFloat(seen.glyphScale) - GLYPH_SCALE[step.id]) < 0.0005
        && Math.abs(Number.parseFloat(seen.glyphHalf) - GLYPH_HALF) < 0.05,
      `--glyph-scale=${seen.glyphScale}（期望 ${GLYPH_SCALE[step.id]}），`
        + `--glyph-half=${seen.glyphHalf}（期望 ${GLYPH_HALF}cqh）`);
    checkEqual(`字号「${step.label}」：根节点只挂一个档位类`, seen.rootClasses.join(','), fontClassName(step.id));
    checkEqual(`字号「${step.label}」：只有这一个按钮是按下态`, seen.pressed.join(','), step.id);

    // 用户提的两条，逐档当场验：
    //   特大 —— 那个字的**墨迹**（看得见的笔画，不是字身盒）占科目框高的一半
    //   紧凑 —— 等于改版前「特大」档的大小，即当时的 22px × 1.25
    if (step.id === 'xlarge') {
      const inkPct = (seen.ink / seen.cellH) * 100;
      check(`字号「特大」：「${seen.glyphText}」的墨迹占科目框高的一半`,
        Math.abs(inkPct - 50) < 1.2,
        `格高 ${seen.cellH.toFixed(1)}，墨迹 ${seen.ink.toFixed(1)} = ${inkPct.toFixed(1)}%（期望 50%±1.2）`);
    }
    if (step.id === 'compact') {
      // 比的是**比例**而不是 px：改版前特大档是写死的 22px × 1.25 = 27.5px，
      // 落在当时 166.8px 高的格子里就是 16.5%。现在这个比例由 --glyph-half
      // 与 --glyph-scale 定死，换窗口也不变，所以拿比例比才是稳的。
      const sizePct = (seen.glyph / seen.cellH) * 100;
      check('字号「紧凑」：课程格大字 ＝改版前「特大」档的比例（27.5px / 166.8px 格高）',
        Math.abs(sizePct - 16.5) < 0.5,
        `${sizePct.toFixed(2)}%（1440×900 下 ${seen.glyph.toFixed(1)}px，改版前特大档是 27.5px）`);
    }

    await capture(cdp, `09-font-${step.id}.png`);
  }
  console.log(`    字号实测 ${fontTable.join('  ')}（正文/课程格大字）`);

  /* ------------------------------------------------ 特大档下没有文字被压扁
     字放大之后最容易坏的不是字号本身，是那些固定高度的容器：字撑破了框，
     内容被裁掉一半，而字号断言完全看不出来。逐个量 scrollHeight。 */

  await clickEl(cdp, fontStepBtn('xlarge'));
  await sleep(320);

  const clipped = await cdp.evaluate(`
    const probe = (sel, axis) => [...document.querySelectorAll(sel)].map((n) => {
      const over = axis === 'x' ? n.scrollWidth - n.clientWidth : n.scrollHeight - n.clientHeight;
      return { sel, over, text: (n.textContent || '').trim().slice(0, 12) };
    }).filter((r) => r.over > 1);

    /* .tag 不能进上面这个 probe：.tag__page 的 ::after 是一圈**故意**伸出框外的
       透明触摸热区（tags.css，上下 .5em、左右 .33em），量 scrollHeight 恒定超 3px。
       那不是被裁掉的文字，是手指要够得着的地方。所以这里改量「字有没有跑出 Tag」：
       量的是 .tag__label / .tag__page 自己的边框盒（::after 不算在 getBoundingClientRect
       里），跑出 Tag 的框就是真的溢出来了。 */
    const spill = [...document.querySelectorAll('.tags-body .tag')].map((t) => {
      const box = t.getBoundingClientRect();
      const worst = Math.max(...[...t.querySelectorAll('.tag__label, .tag__page')].map((k) => {
        const r = k.getBoundingClientRect();
        return Math.max(box.left - r.left, r.right - box.right, box.top - r.top, r.bottom - box.bottom);
      }));
      return { sel: '.tag 里的字', over: Math.round(worst), text: (t.textContent || '').trim().slice(0, 12) };
    }).filter((r) => r.over > 1);

    return [
      ...probe('.head-btn'),
      ...spill,
      ...probe('.seg__btn'),
      ...probe('#zone-info .tools-stack .btn'),
      ...probe('#zone-info .info-foot .btn'),
      ...probe('.tools-note'),
    ];
  `);
  check('特大档下功能区与三区的文字都没被裁掉', clipped.length === 0,
    clipped.map((c) => `${c.sel}超${c.over}px「${c.text}」`).join(' | '));

  // 大字占掉半格之后，最该出问题的是它自己：字太大，把格内的作业区挤没了。
  // 这条专抓那个 —— 字号断言只看字多大，看不出它把旁边的东西顶到哪儿去了。
  const glyphFit = await cdp.evaluate(`
    return [...document.querySelectorAll('.course-cell')].map((cell) => {
      const cb = cell.getBoundingClientRect();
      const cs = getComputedStyle(cell);
      const lead = cell.querySelector('.course-cell__lead').getBoundingClientRect();
      const slots = cell.querySelector('.course-cell__slots').getBoundingClientRect();
      const contentBottom = cb.bottom - Number.parseFloat(cs.paddingBottom);
      return {
        subject: cell.dataset.subject,
        headOver: Math.round((lead.bottom - contentBottom) * 10) / 10,
        slotsH: Math.round(slots.height * 10) / 10,
        headH: Math.round(lead.height * 10) / 10,
      };
    });
  `);
  const headSpill = glyphFit.filter((c) => c.headOver > 0.5);
  check('特大档下科目名那一栏没有顶出格子',
    headSpill.length === 0,
    headSpill.map((c) => `${c.subject} 顶出 ${c.headOver}px`).join(' | '));
  // 科目名与作业槽位改成了同一行里并排的两栏之后，槽位拿到的是整格高度而不是
  // 「科目名底下剩下的那一条」。这条守着那个改动：一旦有人把它们改回上下排，
  // 槽位高度会掉到 24px 上下，这里立刻红。
  const noRoom = glyphFit.filter((c) => c.slotsH < 24);
  check('特大档下每格的作业槽位仍有一行的余量（科目名与作业并排，不是上下摞）',
    noRoom.length === 0,
    `实测每格槽位 ${glyphFit.map((c) => c.slotsH).join('/')}px（科目名栏 ${glyphFit[0]?.headH}px）`);

  // 设置抽屉里的输入框和开关也要跟着过一遍 —— 它们的固定高度是另一个风险点
  await clickEl(cdp, SETTINGS_BTN);
  await sleep(400);
  const clippedInDrawer = await cdp.evaluate(`
    const probe = (sel) => [...document.querySelectorAll(sel)].map((n) => {
      const over = Math.max(n.scrollHeight - n.clientHeight, n.scrollWidth - n.clientWidth);
      return { sel, over, text: (n.textContent || n.value || '').trim().slice(0, 12) };
    }).filter((r) => r.over > 1);
    return [
      ...probe('.drawer--settings .field__label'),
      ...probe('.drawer--settings .input'),
      ...probe('.drawer--settings .switch'),
      ...probe('.drawer--settings .set-section__title'),
    ];
  `);
  check('特大档下设置抽屉里的文字也没被裁掉', clippedInDrawer.length === 0,
    clippedInDrawer.map((c) => `${c.sel}超${c.over}px「${c.text}」`).join(' | '));
  await capture(cdp, '10-font-xlarge-settings.png');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(380);

  /* ------------------------------------------------ 特大档刷新后还在
     这条专抓「写进了 localStorage 但载入时没校验 / 没读回来」。 */

  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1500);
  const xlAfterReload = await cdp.evaluate(`
    const cs = getComputedStyle(document.body);
    const on = [...document.querySelectorAll('#zone-info .seg__btn')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.fontStep);
    return { fontSize: Number.parseFloat(cs.fontSize), pressed: on.join(',') };
  `);
  check('特大档在刷新之后仍然是特大（且按钮状态对得上）',
    Math.abs(xlAfterReload.fontSize - FS_BASE * CSS_SCALE.xlarge) < 0.05 && xlAfterReload.pressed === 'xlarge',
    JSON.stringify(xlAfterReload));

  /* --------------------------------------- 更小尺寸下的特大档：封顶但不失效 */

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 340, height: 720, deviceScaleFactor: 1, mobile: true,
  });
  await sleep(500);

  const tinyXl = await cdp.evaluate(`
    const cs = getComputedStyle(document.documentElement);
    const scale = Number.parseFloat(cs.getPropertyValue('--fs-scale'));
    const tags = [...document.querySelectorAll('.tag')];
    return {
      scale,
      body: Number.parseFloat(getComputedStyle(document.body).fontSize),
      noHorizontalScroll: document.documentElement.scrollWidth <= innerWidth + 1,
      // 默认 Tag 的文字有没有被省略号吃掉（Tag 多了之后更容易被挤）
      tagsClipped: tags.filter((t) => {
        const label = t.querySelector('.tag__label') ?? t;
        return label.scrollWidth > label.clientWidth + 1;
      }).length,
      tagCount: tags.length,
    };
  `);
  check('340px + 特大：仍然比「大」档大（封顶不等于退回原样）',
    tinyXl.scale > CSS_SCALE.large, `实测 --fs-scale=${tinyXl.scale}，大档=${CSS_SCALE.large}`);
  check('340px + 特大：也不超过桌面特大', tinyXl.scale <= CSS_SCALE.xlarge, String(tinyXl.scale));
  check('340px + 特大：不出现横向滚动', tinyXl.noHorizontalScroll === true, JSON.stringify(tinyXl));
  check('340px + 特大：默认 Tag 的文字没有被截断',
    tinyXl.tagCount === DEFAULT_TAGS.length && tinyXl.tagsClipped === 0, JSON.stringify(tinyXl));
  await capture(cdp, '11-font-xlarge-narrow.png');

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);
  const backToDesktop = await cdp.evaluate(`return Number.parseFloat(getComputedStyle(document.body).fontSize);`);
  check('回到宽屏后特大档恢复原值（窄屏封顶没有写回状态）',
    Math.abs(backToDesktop - FS_BASE * CSS_SCALE.xlarge) < 0.05, String(backToDesktop));

  /* =============== J2. 三区 Tag 的字号 + 格内条目与科目字号的比例 + 拖入放大
     这一段要往板子上放一条作业才量得到 .asg，所以放在 J 的收尾之前 ——
     那之前的板子一直是空的（J 开头清过 localStorage）。放下的那条最后会撤掉，
     K 段的计数断言才是确定的。

     用户要的三件事，各有一个数：
       三区 Tag  = 定值，**四档完全一样**（「三区的 tag 大小不要随字号变化而变化」）
       格内条目  = 0.9 × 科目大字（「拖进去之后变大」，不封顶）
       拖入放大  = 条目 ÷ Tag，四档因此各不相同（紧凑档反过来小于 1，见 README 取舍）
     比例稳不稳，只有四档都量一遍才知道：单量一档对得上，可能只是在那一档凑巧。 */

  await clickEl(cdp, fontStepBtn('standard'));
  await sleep(320);

  const scaleTrace = await dragRecordingScale(cdp, tagGrab('bishuati'), '[data-subject="yu"]');
  const trayFrames = scaleTrace.filter((f) => !f.released);
  const flyFrames = scaleTrace.filter((f) => f.released);
  const arrFrames = flyFrames.filter((f) => f.arr);
  const chipFrames = scaleTrace.filter((f) => f.chip);
  const chipBox = chipFrames[chipFrames.length - 1]?.chip;   // 落点那一枚的真实尺寸
  const arrSizes = [...new Set(arrFrames.map((f) => f.arr.w))];

  check('拖影录到了（拖拽真的起来了，下面的读数才有意义）',
    scaleTrace.length >= 8, `${scaleTrace.length} 帧`);
  check('在三区里拖的时候，屏幕上就是那枚 Tag 本身（还没有落点层，尺寸也没变）',
    trayFrames.length > 0 && trayFrames.every((f) => f.arr === null),
    `按下到松手之间 ${trayFrames.length} 帧`);
  // 落点该有多大的直接读数：落点条目与源 Tag 的字号之比（落点层的起步缩放就是它的倒数）
  const dropFonts = await cdp.evaluate(`
    const f = (s) => Number.parseFloat(getComputedStyle(document.querySelector(s)).fontSize);
    return { tag: f('.tag'), asg: f('[data-subject="yu"] .asg') };
  `);
  const expectGrow = dropFonts.asg / dropFonts.tag;
  const arrivalFrom = Number(arrFrames[0]?.af);

  check('标准档这一档确实是在「变大」而不是变小',
    expectGrow > 1.1, `倍数 ${expectGrow.toFixed(3)}（tag ${dropFonts.tag}px → asg ${dropFonts.asg}px）`);
  check('落点层起步就是出发时的字号（1/放大倍数，交接处文字大小因此是连续的）',
    Math.abs(1 / arrivalFrom - expectGrow) < 0.02,
    `--arrival-from ${arrFrames[0]?.af} → 起步 ${(1 / arrivalFrom).toFixed(3)} 倍，期望 ${expectGrow.toFixed(3)}`);
  check('拖进去之后变大：落点层长完就是条目本身的大小（缩放走到 1）',
    !!chipBox && !!arrFrames.length &&
      Math.abs(arrFrames[arrFrames.length - 1].arr.w - chipBox.w) < 1.5 &&
      Math.abs(arrFrames[arrFrames.length - 1].arr.h - chipBox.h) < 1.5,
    `长完 ${arrFrames[arrFrames.length - 1]?.arr.w}×${arrFrames[arrFrames.length - 1]?.arr.h}，条目 ${chipBox?.w}×${chipBox?.h}`);
  /* 这条是用户报的毛病本身：「拖影会先变得超级大，然后再缩小成原来的样子」。
     从前是把出发那个 Tag 盒子按字号放大（同字号下它比条目宽 1.8 倍），于是
     空中最大的一团是落点的 1.8 倍，交接时又缩回去。现在盯着**空中最大的那
     一团**（出发层与落点层取大者），任何一帧都不许超过落点。 */
  const maxSeenW = Math.max(...flyFrames.map((f) => Math.max(f.g.w, f.arr ? f.arr.w : 0)));
  const maxSeenH = Math.max(...flyFrames.map((f) => Math.max(f.g.h, f.arr ? f.arr.h : 0)));
  check('不再「先超大再缩回」：飞在空中的那一团，任何一帧都不比落点条目大',
    !!chipBox && maxSeenW <= chipBox.w * 1.02 && maxSeenH <= chipBox.h * 1.02,
    `空中最大 ${maxSeenW}×${maxSeenH}，落点 ${chipBox?.w}×${chipBox?.h}`);
  check('变大是个过程，不是一帧跳到位',
    arrSizes.length >= 3,
    `松手后 ${flyFrames.length} 帧里落点层出现 ${arrSizes.length} 个不同的宽度：${arrSizes.join('/')}`);

  /* 「看得见」这一条是本段的重点。取长到九成的**第一帧**看它当时有多透明：
     落点层的淡入若被推到后半程，这一刻的 opacity 会掉到 0.5 以下，
     也就是最大的一截变大发生在拖影近乎透明的时候。 */
  const grownFrame = arrFrames.find((f) => f.arr.w >= (chipBox?.w ?? 0) * .9);
  check('变大看得见：长到九成的那一刻，落点层已经实了（opacity > .5）',
    !!grownFrame && grownFrame.ao > .5,
    grownFrame
      ? `第 ${grownFrame.t}ms 长到 ${grownFrame.arr.w}×${grownFrame.arr.h}，此刻 opacity ${grownFrame.ao}`
      : '没有任何一帧长到九成');
  check('出发那一层（三区那枚 Tag）在落位途中淡掉，不是被硬删掉的',
    flyFrames.some((f) => f.o !== null && f.o < .1),
    `松手后 opacity 最低 ${Math.min(...flyFrames.map((f) => f.o ?? 1))}`);

  const enteringFrames = flyFrames.filter((f) => f.entering);
  check('落位的同时真实条目在播入场动画（.asg.is-entering）',
    enteringFrames.length > 0,
    `松手后 ${flyFrames.length} 帧里 is-entering 出现 ${enteringFrames.length} 次`);
  check('落位不再二次放大：拖入期间条目的入场起点被钉成 1（变大归拖影管）',
    enteringFrames.length > 0 && enteringFrames.every((f) => f.es === '1'),
    `--enter-scale 取值 ${[...new Set(enteringFrames.map((f) => f.es))].join('/')}`);
  await capture(cdp, '17-drop-scale.png');

  /* 点选路径（没有拖影飞过来）也要「从三区 Tag 的大小长起来」—— 它才是
     --enter-scale 真正被用上的地方：拖拽那一路已经把它钉成 1 了。
     拿「外」这一格做：J3 只动「语」和「数」，互不打扰；这一段收尾时
     localStorage 会被清掉重载，这条试放的作业不留痕迹。 */
  await cdp.evaluate(`
    window.__enter = [];
    const t0 = performance.now();
    (function tick() {
      const c = document.querySelector('.asg.is-entering');
      if (c) window.__enter.push(c.style.getPropertyValue('--enter-scale'));
      if (performance.now() - t0 < 700) requestAnimationFrame(tick);
    })();
    return true;
  `);
  await clickEl(cdp, '.tag[data-tag-id="bishuati"] .tag__label');
  await clickEl(cdp, '[data-subject="wai"] .course-cell__lead');
  await sleep(760);

  const tapEnter = await cdp.evaluate(`return window.__enter;`);
  const tapFonts = await cdp.evaluate(`
    const f = (s) => Number.parseFloat(getComputedStyle(document.querySelector(s)).fontSize);
    return { tag: f('.tag'), asg: f('[data-subject="wai"] .asg') };
  `);
  const tapWant = tapFonts.tag / tapFonts.asg;
  check('点选布置：入场起点是「三区 Tag 字号 ÷ 条目字号」',
    tapEnter.length > 0 && Math.abs(Number(tapEnter[0]) - tapWant) < 0.03,
    `起点 ${tapEnter[0]}，期望 ${tapWant.toFixed(3)}（tag ${tapFonts.tag}px / asg ${tapFonts.asg}px）`);
  check('标准档下这个起点小于 1 —— 点选也是从小长到大的',
    tapEnter.length > 0 && Number(tapEnter[0]) < 0.95, `起点 ${tapEnter[0]}`);

  const ratioRows = [];
  const tagPx = new Map();     // 四档下三区 Tag 的实测字号：应当完全一样
  const glyphPx = new Map();   // 科目大字：应当逐档变大（对照组，证明四档真的切过去了）
  const growX = new Map();     // 拖入放大的倍数 = 条目 ÷ Tag：逐档不同
  for (const step of FONT_STEPS) {
    await clickEl(cdp, fontStepBtn(step.id));
    await sleep(320);

    const seen = await cdp.evaluate(`
      const fs = (sel) => {
        const n = document.querySelector(sel);
        return n ? Number.parseFloat(getComputedStyle(n).fontSize) : null;
      };
      const slots = document.querySelector('[data-subject="yu"] .course-cell__slots');
      const chip = document.querySelector('[data-subject="yu"] .asg');
      const label = chip.querySelector('.asg__label');
      const cb = chip.getBoundingClientRect();
      return {
        glyph: fs('.course-cell__glyph'), tag: fs('.tag'), asg: fs('.asg'),
        chipH: cb.height,
        slotsH: slots.getBoundingClientRect().height,
        labelCut: label.scrollWidth - label.clientWidth,
      };
    `);
    tagPx.set(step.id, seen.tag);
    glyphPx.set(step.id, seen.glyph);
    growX.set(step.id, seen.asg / seen.tag);
    ratioRows.push(`${step.id}: tag ${seen.tag.toFixed(1)}px，asg/glyph ${(seen.asg / seen.glyph).toFixed(3)}，拖入放大 ${(seen.asg / seen.tag).toFixed(2)}×`);

    check(`字号「${step.label}」：格内条目 = 0.9 × 科目大字`,
      Math.abs(seen.asg / seen.glyph - 0.9) < 0.02,
      `asg/glyph = ${(seen.asg / seen.glyph).toFixed(3)}（条目 ${seen.asg}px，科目 ${seen.glyph}px）`);
    // 字号对得上不代表放得下：条目和科目名挤在同一行里，盒子高过槽位就会被裁。
    // 这一条抓的正是「字很大、但渲染成一条空白」那种坏法。
    check(`字号「${step.label}」：条目装得进格子里，名字也没被截掉`,
      seen.chipH <= seen.slotsH + 0.5 && seen.labelCut <= 1,
      `条目盒 ${seen.chipH.toFixed(1)}px / 槽位 ${seen.slotsH.toFixed(1)}px，名字被截 ${seen.labelCut}px`);
  }

  /* 三区 Tag 现在是定值（tags.css 的 2.484cqh ≈ 20px），四档必须量出同一个数。
     从前这里是「Tag ≈ 0.75 × 科目大字」，那条比例已经取消 —— 改成钉住新的规则。 */
  const tagFonts = FONT_STEPS.map((s) => tagPx.get(s.id));
  const glyphFonts = FONT_STEPS.map((s) => glyphPx.get(s.id));
  check('四档字号下三区 Tag 的大小完全不变（Tag 不随字号变化）',
    Math.max(...tagFonts) - Math.min(...tagFonts) < 0.5,
    `四档实测 ${tagFonts.map((n) => n.toFixed(1)).join(' / ')}px`);
  check('（对照）四档的科目大字确实各不相同 —— 上面那条不是因为四档没切过去',
    Math.max(...glyphFonts) - Math.min(...glyphFonts) > 10,
    `四档实测 ${glyphFonts.map((n) => n.toFixed(1)).join(' / ')}px`);
  check('（对照）拖入放大的倍数逐档不同 —— 所以它只能现读，不能写死一个 .83',
    new Set([...growX.values()].map((n) => n.toFixed(2))).size >= 3,
    FONT_STEPS.map((s) => `${s.id} ${growX.get(s.id).toFixed(2)}×`).join('，'));
  console.log(`    字号比例 ${ratioRows.join('  ')}`);

  /* 记一个数给 README 用：15 枚默认 Tag 在托盘里要滚几屏。Tag 固定成定值之后
     它就是个常数（跟档无关）—— 用户当初正是在「跟着档走」与「固定成标准档大小」
     之间选了后者，这个屏数就是那个选择的直接代价。 */
  const tray = await cdp.evaluate(`
    const body = document.querySelector('.tags-body');
    const tag = document.querySelector('.tag');
    return {
      tagH: tag.getBoundingClientRect().height,
      scroll: body.scrollHeight / body.clientHeight,
      count: document.querySelectorAll('.tag').length,
    };
  `);
  console.log(`    三区：Tag 高 ${tray.tagH.toFixed(1)}px，${tray.count} 枚要滚 ${tray.scroll.toFixed(2)} 屏`);

  /* 把落位那一趟的动画原样打出来（每帧「落点层宽 × 出发层透明度」）。上面几条
     断言说的是「有这个性质」，这一行是让人一眼看出它的形状：宽度从小长到落点
     条目的宽度就停住（不越过它），出发层在前几帧里淡掉。 */
  console.log(`    落位逐帧（落点层宽 × 出发层透明度）  ${
    flyFrames.map((f) => `${f.arr ? f.arr.w : '—'}${f.o === null ? '' : '/' + f.o}`).join(' → ')}`);

  /* 窄屏是另一套比例（board.css 把 --glyph-size 压到 --glyph-cap，Tag 取它的
     0.75 倍），所以「条目比 Tag 大」这件事要单独量一遍：宽屏那边四档的倍数由
     两个各自独立的字号算出来，窄屏这边是同一个 cap 乘两个定数，比例恒为 1.2。
     一屏六门课的地方本来就摆不下四档字号，所以窄屏量到「四档一样大」是设计、
     不是没切过去：拿 --fs-scale 当对照，它必须逐档不同，否则下面几条是空转。 */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 340, height: 720, deviceScaleFactor: 1, mobile: true,
  });
  await sleep(500);

  const narrowRows = [];
  for (const step of FONT_STEPS) {
    await clickEl(cdp, fontStepBtn(step.id));
    await sleep(320);
    const seen = await cdp.evaluate(`
      const f = (s) => {
        const n = document.querySelector(s);
        return n ? Number.parseFloat(getComputedStyle(n).fontSize) : null;
      };
      return {
        scale: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs-scale')),
        glyph: f('.course-cell__glyph'), tag: f('.tag'), asg: f('[data-subject="yu"] .asg'),
      };
    `);
    narrowRows.push(seen);
  }

  check('窄屏四档真的切过去了（对照：--fs-scale 逐档不同，下面几条才不是空转）',
    new Set(narrowRows.map((r) => r.scale)).size === FONT_STEPS.length,
    narrowRows.map((r, i) => `${FONT_STEPS[i].id} ${r.scale}`).join('，'));
  check('窄屏：科目大字封顶在 17px（--glyph-cap），四档都不超过它',
    narrowRows.every((r) => r.glyph !== null && r.glyph <= 17.05),
    `四档实测 ${narrowRows.map((r) => r.glyph.toFixed(1)).join(' / ')}px`);
  check('窄屏：四个档位在二区、三区看起来一样大（与宽屏正好相反，这是刻意的）',
    narrowRows.every((r) => Math.abs(r.glyph - narrowRows[0].glyph) < .5
                          && Math.abs(r.tag - narrowRows[0].tag) < .5),
    `大字 ${narrowRows.map((r) => r.glyph.toFixed(1)).join('/')}px，Tag ${narrowRows.map((r) => r.tag.toFixed(1)).join('/')}px`);
  check('窄屏：Tag 一律比格内条目小 —— 「拖进去变大」四档都成立，不会反过来',
    narrowRows.every((r) => r.tag < r.asg - .5),
    narrowRows.map((r, i) => `${FONT_STEPS[i].id} ${r.tag.toFixed(1)}→${r.asg.toFixed(1)}`).join('，'));
  console.log(`    窄屏比例 ${narrowRows.map((r, i) => `${FONT_STEPS[i].id}: 大字 ${r.glyph.toFixed(1)}px，tag ${r.tag.toFixed(1)}px，asg ${r.asg.toFixed(1)}px，落位 ${(r.asg / r.tag).toFixed(2)}×`).join('  ')}`);

  /* 页脚在窄屏也是页脚。窄屏的整列高度由内容决定（.stack 退回 container-type:
     normal），最容易出的坏法是那条 flex 带子被折行吃掉或者缩成 0 宽 ——
     桌面量得到不等于窄屏也量得到，所以在这里重量一遍。 */
  const narrowFoot = await cdp.evaluate(`
    const btn = document.querySelector('#zone-board .head-btn');
    const foot = document.querySelector('#zone-board .panel-foot');
    const board = document.querySelector('#zone-board .board-body');
    const b = btn.getBoundingClientRect();
    const f = foot.getBoundingClientRect();
    return {
      below: f.top >= board.getBoundingClientRect().bottom - 1,
      rightAligned: b.right <= f.right + 1 && b.left > f.left + f.width / 2,
      w: b.width, h: b.height,
    };
  `);
  check('窄屏：全屏入口仍在二区页脚（课程表下面、靠着右边、没被折行吃掉）',
    narrowFoot.below === true && narrowFoot.rightAligned === true
      && narrowFoot.w > 20 && narrowFoot.h > 10,
    JSON.stringify(narrowFoot));

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);
  await clickEl(cdp, fontStepBtn('xlarge'));   // J3 起手是特大档，量完窄屏恢复回去
  await sleep(400);

  /* =============== J3. 装不下就自己缩小（而不是滚动条）
     用户的原话：「当作业放不下的时候，就自动缩小 tag，把放不下的 tag 显示到
     空出来的地方 —— 而不是像现在这样滚动。」

     上面只往语里放了一条，那一格装得下，所以 --fit 没写上去。这里放到三条
     （其中一条带三位页码），要钉的是：① 竖向没有溢出 —— 也就是**没有滚动条**，
     这正是用户不要的那个东西 ② 每一条都整个留在槽位框里（撤下键也没被挤出去）
     ③ 名字要么完整、要么带着省略号，不许是竖着切开的半个字 ④ 页码一位不少
     ⑤ 只缩挤的那一格：对照格子的条目仍然是 0.9 × 科目大字，三区更是一点没动。 */

  await setPageViaKeypad(cdp, 'ujia', '200');
  await clickEl(cdp, '.tag[data-tag-id="ujia"] .tag__label');
  await clickEl(cdp, '[data-subject="yu"] .course-cell__lead');
  await sleep(300);
  await clickEl(cdp, '.tag[data-tag-id="juanzi"] .tag__label');
  await clickEl(cdp, '[data-subject="yu"] .course-cell__lead');
  await sleep(300);
  // 对照组：另一格里只有一条，它不该被缩
  await clickEl(cdp, '.tag[data-tag-id="bishuati"] .tag__label');
  const controlArmed = await cdp.evaluate(`
    return document.querySelector('#zone-info [data-note="selected"]').textContent.trim();
  `);
  check('对照组那一下真的点选上了「必刷题」（点选了才有得放，静默没选中会连带下面全错）',
    controlArmed === '已选中：必刷题', controlArmed);
  await clickEl(cdp, '[data-subject="shu"] .course-cell__lead');
  await sleep(360);

  const readFit = (cdp) => cdp.evaluate(`
    const read = (id) => {
      const cell = document.querySelector('[data-subject="' + id + '"]');
      const slots = cell.querySelector('.course-cell__slots');
      const chips = [...slots.querySelectorAll('.asg')];
      const sr = slots.getBoundingClientRect();
      const raw = getComputedStyle(slots).getPropertyValue('--fit').trim();
      return {
        fit: raw === '' ? 1 : Number(raw),
        chips: chips.length,
        text: chips.map((n) => n.textContent.trim()),
        // 滚动条只在缩到下限还放不下时才该出现 —— 正常情况必须是 0
        gapY: slots.scrollHeight - slots.clientHeight,
        gapX: slots.scrollWidth - slots.clientWidth,
        font: Number.parseFloat(getComputedStyle(chips[0]).fontSize),
        glyph: Number.parseFloat(getComputedStyle(cell.querySelector('.course-cell__glyph')).fontSize),
        // 每一条整个都在槽位框里：页码、悬停才显形的撤下键都算在内
        inside: chips.every((n) => {
          const r = n.getBoundingClientRect();
          return r.left >= sr.left - 0.5 && r.right <= sr.right + 0.5
              && r.top >= sr.top - 0.5 && r.bottom <= sr.bottom + 0.5;
        }),
        // 名字要么完整，要么留得下至少一个字的宽度（否则浏览器会把第一个字竖着切一刀）。
        // 第三种过关的情形是名字整个收起来了（.is-nameless，只留页码）—— 那是窄到
        // 连一个省略号都放不下时的最后一招，见 board.css 与 fitCell 的 halfGlyph。
        labelOk: chips.every((n) => {
          if (n.classList.contains('is-nameless')) return true;
          const l = n.querySelector('.asg__label');
          const em = Number.parseFloat(getComputedStyle(n).fontSize);
          return l.scrollWidth <= l.clientWidth + 1 || l.clientWidth >= em * 0.9;
        }),
        nameless: chips.filter((n) => n.classList.contains('is-nameless')).length,
        // 名字被收起来时改挂在 title 上，屏幕上没有的要有别的地方看得见。
        // 没被收起来的必须是空串 —— 不然每条都顶一个多余的提示框。
        titles: chips.map((n) => n.title),
        // 每条名字的实际状态，断言失败时要一眼看出是哪种坏法
        label: chips.map((n) => {
          const l = n.querySelector('.asg__label');
          const em = Number.parseFloat(getComputedStyle(n).fontSize);
          if (n.classList.contains('is-nameless')) return '收起来了';
          return (l.scrollWidth <= l.clientWidth + 1
            ? '完整'
            : (l.clientWidth >= em * 0.9 ? '省略号' : '半个字!'))
            + '(' + Math.round(l.clientWidth) + '/' + Math.round(l.scrollWidth) + ' em' + Math.round(em) + ')';
        }),
        pageCut: chips.reduce((m, n) => {
          const pg = n.querySelector('.asg__page');
          return Math.max(m, pg.scrollWidth - pg.clientWidth);
        }, 0),
      };
    };
    return { yu: read('yu'), shu: read('shu') };
  `);

  const crowded = await readFit(cdp);
  check('三条作业都在格子里', crowded.yu.chips === 3, JSON.stringify(crowded.yu));
  check('三条作业时不再有滚动条（要的是缩小，不是滚动）',
    crowded.yu.gapY === 0 && crowded.yu.gapX === 0,
    `竖向溢出 ${crowded.yu.gapY}px，横向溢出 ${crowded.yu.gapX}px`);
  check('装不下就真的缩了（这一格的 --fit 小于 1）',
    crowded.yu.fit < 1, `--fit=${crowded.yu.fit}，条目 ${crowded.yu.font}px / 科目大字 ${crowded.yu.glyph}px`);
  check('每一条都整个留在槽位框里（撤下键也没被挤出可视区）',
    crowded.yu.inside === true, JSON.stringify(crowded.yu));
  check('名字要么完整、要么带省略号，不会只露半个字',
    crowded.yu.labelOk === true, `名字状态 ${crowded.yu.label.join(' | ')}`);
  check('页码一位不少：先让名字、再让撤下键，页码不让步',
    crowded.yu.pageCut === 0, `被裁 ${crowded.yu.pageCut}px`);
  check('缩到哪儿都守得住下限 15px（标准档的界面正文大小）',
    crowded.yu.font >= 14.9, `${crowded.yu.font}px`);
  check('只缩挤的那一格：另一格里的一条仍然是 0.9 × 科目大字',
    crowded.shu.chips === 1 && crowded.shu.fit === 1
      && Math.abs(crowded.shu.font / crowded.shu.glyph - 0.9) < 0.02,
    JSON.stringify(crowded.shu));
  check('对照格里就是刚点选的那一枚', JSON.stringify(crowded.shu.text), JSON.stringify(['必刷题']));
  await capture(cdp, '20-fit-xlarge.png');

  /* 撤下一条：缩多少是按「当时有几条」算的，所以剩下的应该自己长回来一些 ——
     缩小不是一次性写死的字号，而是每次渲染重新量的。 */
  await clickEl(cdp, '[data-subject="yu"] .asg:nth-child(3) .asg__remove');
  await sleep(360);
  const relaxed = await readFit(cdp);
  check('撤下一条之后剩下的自己重新排：字号变大了', relaxed.yu.font > crowded.yu.font,
    `${crowded.yu.font}px → ${relaxed.yu.font}px`);
  check('长回来之后仍然全都看得见，也没有滚动条',
    relaxed.yu.chips === 2 && relaxed.yu.gapY === 0 && relaxed.yu.inside === true
      && relaxed.yu.labelOk === true, JSON.stringify(relaxed.yu));

  /* 最窄的那一档 + 最长的名字 + 三位页码，是「半个字」最容易露头的地方：
     名字那一段只剩几个像素，浏览器会把第一个字竖着切一刀，屏幕上像个错字。
     这里把刚撤下的那条放回去，再压到 340px 量一次 —— 缩得下去就缩（留成
     「U加练…」），缩到 15px 下限还不行就把名字整个收起来只留页码。 */
  await clickEl(cdp, '.tag[data-tag-id="juanzi"] .tag__label');
  await clickEl(cdp, '[data-subject="yu"] .course-cell__lead');
  await sleep(320);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 340, height: 720, deviceScaleFactor: 1, mobile: true,
  });
  await sleep(320);
  await clickEl(cdp, fontStepBtn('standard'));
  await sleep(500);

  const tight = (await readFit(cdp)).yu;
  check('340px + 三条作业（含一条三位页码）：仍然没有滚动条',
    tight.chips === 3 && tight.gapY === 0 && tight.gapX === 0, JSON.stringify(tight));
  check('340px：每一条仍然整个留在格子里',
    tight.inside === true, JSON.stringify(tight));
  check('340px：名字不会只露半个字（放不下一个省略号就整个收起来，只留页码）',
    tight.labelOk === true, `名字状态 ${tight.label.join(' | ')}`);
  check('340px：缩到一半也守得住 15px 下限，且页码一位不少',
    tight.font >= 14.9 && tight.pageCut === 0,
    `条目 ${tight.font}px，页码被裁 ${tight.pageCut}px`);
  {
    const i = tight.label.indexOf('收起来了');
    const tip = i < 0 ? '' : tight.titles[i];
    check('340px：名字被收起来的那条，鼠标停上去还看得到完整文案',
      i >= 0 && tip.includes('U加课堂') && tip.includes('-200页'),
      `title=${JSON.stringify(tight.titles)}，收起来的是第 ${i} 条`);
    check('340px：没被收起来的条目不带多余的提示框',
      tight.titles.filter((t) => t !== '').length === tight.nameless,
      `title=${JSON.stringify(tight.titles)}，收起来的有 ${tight.nameless} 条`);
  }
  await capture(cdp, '21-fit-narrow.png');

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);

  await clickEl(cdp, fontStepBtn('standard'));
  await sleep(320);
  /* J2 试放的那条要处理掉：K 段从空板起步，那里的计数才是确定的。
     这里清干净重来，而不是点一下「撤下」——撤下同样是一次改动，会在历史里留下
     「语 布置」「语 撤下」两条；后面 L 段要验的正是「历史里有哪几条、条数怎么变」，
     凭空多出两条就会让那些断言全部对不上。清空重载等于把这一段没发生过。 */
  await cdp.evaluate(`localStorage.clear(); return true;`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1400);
  checkEqual('J2 收尾：试放的那条不留痕迹，板子回到空的',
    await cdp.evaluate(`return document.querySelectorAll('.asg').length;`), 0);

  /* ------------------------------------------------------- 收尾：字号复位 */

  await clickEl(cdp, fontStepBtn('standard'));
  await sleep(320);
  checkEqual('字号可以调回标准档',
    await cdp.evaluate(`return Number.parseFloat(getComputedStyle(document.body).fontSize);`), FS_BASE);

  /* ============================================ K. 一键布置给全部课程
     走真实点击。板子是从 J 段清干净重来之后的空板，所以计数是确定的。 */

  const placeAllState = async () => cdp.evaluate(`
    return {
      disabled: document.querySelector('[data-tool="place-all"]').disabled,
      // 按名字取，不数下标：「快捷」里插一条说明就会把后面的全挪位
      note: document.querySelector('#zone-info [data-note="selected"]').textContent.trim(),
      clear: document.querySelector('#zone-info [data-note="clear"]').textContent.trim(),
      last: document.querySelector('#zone-info [data-note="last"]').textContent.trim(),
      perSubject: [...document.querySelectorAll('.course-cell')].map((c) => ({
        id: c.dataset.subject,
        chips: c.querySelectorAll('.asg').length,
        text: [...c.querySelectorAll('.asg')].map((n) => n.textContent.trim()),
      })),
      total: document.querySelectorAll('.asg').length,
    };
  `);

  const beforePlace = await placeAllState();
  checkEqual('没选 Tag 时「布置给全部课程」是禁用的', beforePlace.disabled, true);
  checkEqual('并说清楚去哪儿选', beforePlace.note, '先在三区点选一枚 Tag');

  await clickEl(cdp, '#zone-tags .tag[data-tag-id="bishuati"] .tag__label');
  await sleep(300);
  const selected = await placeAllState();
  checkEqual('点选 Tag 后按钮可用', selected.disabled, false);
  checkEqual('一区显示当前选中的是哪一个', selected.note, '已选中：必刷题');

  await clickEl(cdp, PLACE_ALL_BTN);
  await sleep(420);

  const placed = await placeAllState();
  checkList('六门课各多了一条', placed.perSubject.map((s) => s.chips), [1, 1, 1, 1, 1, 1]);
  checkEqual('六个格子都是刚选的那枚 Tag', placed.total, 6);
  check('每格里的文案都是「必刷题」',
    placed.perSubject.every((s) => s.text.length === 1 && s.text[0] === '必刷题'),
    JSON.stringify(placed.perSubject.map((s) => s.text)));
  check('一次点击只发一轮渲染（六门课都到位，没有半路停下的）', placed.total === 6, String(placed.total));
  check('上次布置时间立刻写进一区', /^上次布置：今天 \d{2}:\d{2}$/.test(placed.last), placed.last);

  /* 再点一次：已经有的课要跳过，不能变成每格两条 */
  await clickEl(cdp, PLACE_ALL_BTN);
  await sleep(420);
  const placedTwice = await placeAllState();
  checkList('重复点击不会叠加', placedTwice.perSubject.map((s) => s.chips), [1, 1, 1, 1, 1, 1]);
  checkEqual('板子总数还是 6', placedTwice.total, 6);

  /* ================================================== L. 历史记录抽屉
     先开抽屉看刚布置完的样子，再改页码，验证「改页码不记账」。 */

  await capture(cdp, '12-tools-panel.png');

  await clickEl(cdp, HISTORY_BTN);
  await sleep(420);

  const histState = async () => cdp.evaluate(`
    return {
      open: !!document.querySelector('.drawer--history.is-open'),
      trapped: document.getElementById('app').inert === true,
      items: [...document.querySelectorAll('.hist-item')].map((n) => ({
        label: n.querySelector('.hist-item__label').textContent.trim(),
        time: n.querySelector('.hist-item__time').textContent.trim(),
        subs: [...n.querySelectorAll('.hist-sub')].map((s) =>
          s.querySelector('.hist-sub__glyph').textContent + s.lastElementChild.textContent),
        summary: n.querySelector('.hist-item__summary').textContent.trim(),
        current: !!n.querySelector('.hist-item__current'),
        canRestore: !!n.querySelector('.hist-item__restore'),
      })),
    };
  `);

  const hist0 = await histState();
  checkEqual('历史抽屉打开了', hist0.open, true);
  checkEqual('打开历史时底层被 inert 挡住', hist0.trapped, true);
  // 首次改动会先补一条「改动前」，所以是 2 条：改动前 + 这次的全部课程布置
  checkList('历史里有「改动前」和这次布置两条（改页码没多记）',
    hist0.items.map((i) => i.label), ['全部课程 布置 必刷题', '改动前']);
  check('最新的一条在最上面', hist0.items[0].time.startsWith('今天'), hist0.items[0].time);
  check('最上面那条被标成「当前」，不给恢复按钮',
    hist0.items[0].current === true && hist0.items[0].canRestore === false, JSON.stringify(hist0.items[0]));
  check('「改动前」那条可以恢复', hist0.items[1].canRestore === true, JSON.stringify(hist0.items[1]));
  checkList('摘要按课程分段，六门课都写出来',
    hist0.items[0].subs,
    ['语必刷题', '数必刷题', '外必刷题', '物必刷题', '化必刷题', '生必刷题']);
  checkEqual('空板那条摘要写「空板」', hist0.items[1].summary, '空板');
  await capture(cdp, '13-history.png');

  /* ------------------------------------------------ 改页码不记历史
     页码是每按一个数字键就写一次的东西，记进历史会把 40 条全冲掉。
     走键盘的真实点击，而不是直接改 state —— 这本来就是用户唯一的路径。 */

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(420);

  await setPageViaKeypad(cdp, 'bishuati', '20');

  const pageSet = await cdp.evaluate(`
    const n = document.querySelector('.tag[data-tag-id="bishuati"]');
    const page = n.querySelector('.tag__page');
    return {
      text: page.textContent,
      shown: n.querySelector('.tag__label').textContent.trim()
        + n.querySelector('.tag__dash').textContent + page.textContent + n.querySelector('.tag__unit').textContent,
      chips: [...document.querySelectorAll('[data-subject="yu"] .asg')].map((x) => x.textContent.trim()),
    };
  `);
  checkEqual('页码改完，Tag 上显示「必刷题-20页」',
    pageSet.shown, '必刷题-20页');
  checkList('但板子上那六条不受影响 —— 缓冲改动不牵动已经落位的布置',
    pageSet.chips, ['必刷题']);
  checkEqual('六门课都还是没页码的样子',
    await cdp.evaluate(`return document.querySelectorAll('.asg__page:not([hidden])').length;`), 0);

  await clickEl(cdp, HISTORY_BTN);
  await sleep(420);
  const histPage = await histState();
  checkEqual('改页码没有多记历史', histPage.items.length, 2);
  // 缓冲不是板子的一部分，板子一点没变 —— 所以这一条仍然是「当前」，
  // 不给恢复按钮。上面那条「改页码不记账」和这条是同一个道理的两面。
  check('只改三区缓冲时，最新那条快照仍然是「当前」（板子没变）',
    histPage.items[0].current === true && histPage.items[0].canRestore === false,
    JSON.stringify(histPage.items[0]));

  /* --------------------------------------- 恢复到「改动前」= 板子退回空板 */

  await cdp.evaluate(`document.querySelectorAll('.hist-item')[1].querySelector('.hist-item__restore').click(); return true;`);
  await sleep(450);

  const afterUndo = await cdp.evaluate(`
    return { total: document.querySelectorAll('.asg').length, page: document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').textContent };
  `);
  checkEqual('恢复到「改动前」：板子退回空板', afterUndo.total, 0);
  // 恢复是整块板子的事，三区那张输入缓冲不在板子上 —— 恢复不动它。
  // 这里那 20 页是刚填进去、还没落位的，恢复完它应该还在原地等着。
  checkEqual('三区的页码缓冲不受恢复影响（那 20 页还在等着落位）', afterUndo.page, '20');

  const hist1 = await histState();
  check('恢复本身也记了一条，放在最上面',
    /^恢复到 \d+月\d+日 \d{2}:\d{2} 的状态$/.test(hist1.items[0]?.label ?? ''), hist1.items[0]?.label);
  checkEqual('恢复条下面是刚才那条布置', hist1.items[1]?.label, '全部课程 布置 必刷题');
  check('恢复之后「当前」标记跟着移到最新一条',
    hist1.items[0]?.current === true && hist1.items[1]?.canRestore === true, JSON.stringify(hist1.items.slice(0, 2)));
  checkEqual('历史条数从 2 变成 3', hist1.items.length, 3);

  /* ------------------------------------ 再恢复回去：证明恢复真的可再撤销 */

  await cdp.evaluate(`document.querySelectorAll('.hist-item')[1].querySelector('.hist-item__restore').click(); return true;`);
  await sleep(450);

  const afterRedo = await cdp.evaluate(`
    return {
      total: document.querySelectorAll('.asg').length,
      yu: [...document.querySelectorAll('[data-subject="yu"] .asg')].map((n) => n.textContent.trim()),
      page: document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').textContent,
    };
  `);
  checkEqual('再恢复一次：六门课的布置全回来了', afterRedo.total, 6);
  checkList('格内文案也是那一刻的样子', afterRedo.yu, ['必刷题']);
  // 同上：这条快照是六条无页码的必刷题，板子回到那一刻；三区的缓冲照旧不动。
  checkEqual('板子回到那一刻（那时还没有页码），缓冲仍然动都没动', afterRedo.page, '20');
  checkEqual('历史现在有 4 条', (await histState()).items.length, 4);

  /* --------------------------------- 页码真的会跟着快照走（两个方向都测）
     上面两条快照里都没有页码，证明不了「页码会一起回滚」。这里让一条**带页码**
     的布置进快照，再往两边各恢复一次，看它是不是跟着布置一起没、一起回。 */

  // 抽屉开着的时候遮罩会吃掉所有点击，改页码和拖拽都得先把它关掉
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(420);

  // 页码填在「卷子」上再拖，这样进快照的那一条是带页码的
  await setPageViaKeypad(cdp, 'juanzi', '20');
  await dragBetween(cdp, tagGrab('juanzi'), '[data-subject="yu"]');
  await sleep(320);

  await clickEl(cdp, HISTORY_BTN);
  await sleep(420);
  const hist2 = await histState();
  checkEqual('新布置记在最上面', hist2.items[0]?.label, '语 布置 卷子-20页');
  checkList('这条快照的摘要带着当时的页码（20 页）；语 上是新加的那枚', hist2.items[0]?.subs,
    ['语必刷题、卷子-20页', '数必刷题', '外必刷题', '物必刷题', '化必刷题', '生必刷题']);

  // 往回退：退到「只有六门必刷题」那一刻，那条带页码的卷子该跟着没
  await cdp.evaluate(`document.querySelectorAll('.hist-item')[1].querySelector('.hist-item__restore').click(); return true;`);
  await sleep(450);
  const undonePage = await cdp.evaluate(`
    return {
      yu: [...document.querySelectorAll('[data-subject="yu"] .asg')].map((n) => n.textContent.trim()),
      bishuatiPage: document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').textContent,
      juanziPage: document.querySelector('.tag[data-tag-id="juanzi"] .tag__page').textContent,
    };
  `);
  checkList('退回去：卷子没了', undonePage.yu, ['必刷题']);
  checkEqual('三区那 20 页缓冲仍在（退的是板子，不是缓冲区）', undonePage.bishuatiPage, '20');
  checkEqual('而「卷子」上的缓冲是落位时清掉的，恢复没有把它填回来', undonePage.juanziPage, '');

  // 再往前：退到「卷子-20页」那一刻，页码必须跟着回来
  await cdp.evaluate(`document.querySelectorAll('.hist-item')[1].querySelector('.hist-item__restore').click(); return true;`);
  await sleep(450);
  const redonePage = await cdp.evaluate(`
    return {
      total: document.querySelectorAll('.asg').length,
      yu: [...document.querySelectorAll('[data-subject="yu"] .asg')].map((n) => n.textContent.trim()),
      other: [...document.querySelectorAll('[data-subject="shu"] .asg')].map((n) => n.textContent.trim()),
      juanziPage: document.querySelector('.tag[data-tag-id="juanzi"] .tag__page').textContent,
    };
  `);
  checkEqual('再往前：卷子回来了', redonePage.total, 7);
  checkList('语 上多了一枚卷子（原有的必刷题还在）', redonePage.yu, ['必刷题', '卷子-20页']);
  checkList('其余五门是没有页码的必刷题', redonePage.other, ['必刷题']);
  // 这一条是本段的落点：那条布置**带着 20 页**回来了，而三区「卷子」上
  // 仍然是空的 —— 同一个数字在两处各有各的归属，恢复只动板子上那一份。
  checkEqual('三区「卷子」上仍是空的（页码长在布置上，不在 Tag 上）', redonePage.juanziPage, '');

  /* ---------------------------------------------- Esc 关抽屉，历史留在那 */

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(420);
  const closed = await cdp.evaluate(`
    return { open: !!document.querySelector('.drawer--history.is-open'), inert: document.getElementById('app').inert };
  `);
  checkEqual('Esc 关掉历史抽屉', closed.open, false);
  checkEqual('关掉之后底层解除 inert', closed.inert, false);
  checkEqual('恢复出来的板子在关掉抽屉后仍然是原样',
    await cdp.evaluate(`return document.querySelectorAll('.asg').length;`), 7);

  /* ============================== M. 340px 窄屏：键盘摆位与长名字的格子
     这一段故意放在最后。它要往三区加一枚自定义 Tag、往格子里多放一条布置，
     前面那些按数目计数的断言（六门课各一条、板子总数 7）会因此失效，
     所以等它们都跑完再做。 */

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 340, height: 720, deviceScaleFactor: 1, mobile: true,
  });
  await sleep(600);

  /* 窄屏里三区排在二区后面，多半不在画面里。点之前先滚过去 —— 真人也是这么够着的，
     而 clickEl 打的是视口坐标，元素在屏幕外时那一下会打空。 */
  const scrollTo = async (selector) => {
    await cdp.evaluate(`
      document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center' });
      return true;
    `);
    await sleep(360);
  };

  await scrollTo('.tag[data-tag-id="bishuati"] .tag__page');
  await openKeypad(cdp, 'bishuati');

  const narrowPad = await cdp.evaluate(`
    const pad = document.querySelector('.keypad');
    const r = pad.getBoundingClientRect();
    const btn = document.querySelector('.tag[data-tag-id="bishuati"] .tag__page').getBoundingClientRect();
    return {
      open: pad.classList.contains('is-open'),
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      inX: r.left >= -1 && r.right <= innerWidth + 1,
      inY: r.top >= -1 && r.bottom <= innerHeight + 1,
      clear: r.bottom <= btn.top + 1 || r.top >= btn.bottom - 1,
      noScrollX: document.documentElement.scrollWidth <= innerWidth + 1,
    };
  `);
  check('340px 下键盘整块留在画面里（左右上下都没出屏）',
    narrowPad.open && narrowPad.inX && narrowPad.inY, JSON.stringify(narrowPad));
  check('340px 下键盘不盖住它所属的那枚 Tag',
    narrowPad.clear === true, JSON.stringify(narrowPad));
  check('340px 下键盘不撑出横向滚动',
    narrowPad.noScrollX === true, JSON.stringify(narrowPad));
  await capture(cdp, '15-keypad-narrow.png');

  await clickEl(cdp, KEYPAD_DONE);
  await sleep(220);

  /* ---- 12 字的名字（名称上限）配三位页码，塞进 340px 的格子里 ---- */

  await scrollTo('.tag-add');
  await clickEl(cdp, '.tag-add');
  await typeInto(cdp, '.tag-compose__input', '第三单元综合练习卷附加题');
  await scrollTo('.tag-compose__ok');
  await clickEl(cdp, '.tag-compose__ok');
  await sleep(320);

  const longTag = await cdp.evaluate(`
    const n = [...document.querySelectorAll('.tags-body .tag--custom')]
      .find((t) => t.querySelector('.tag__label').textContent.trim().length === 12);
    return n ? { id: n.dataset.tagId, label: n.querySelector('.tag__label').textContent.trim() } : null;
  `);
  check('12 字（名称上限）的自定义 Tag 建得出来',
    longTag !== null && longTag.label === '第三单元综合练习卷附加题', JSON.stringify(longTag));

  await scrollTo(`.tag[data-tag-id="${longTag.id}"] .tag__page`);
  await openKeypad(cdp, longTag.id);
  const narrowCap = await cdp.evaluate(`
    const pad = document.querySelector('.keypad').getBoundingClientRect();
    return { inX: pad.left >= -1 && pad.right <= innerWidth + 1, inY: pad.top >= -1 && pad.bottom <= innerHeight + 1 };
  `);
  check('340px 下键盘照样收得住（它比 Tag 宽得多）',
    narrowCap.inX && narrowCap.inY, JSON.stringify(narrowCap));
  await clickEl(cdp, keypadKey('clear'));
  for (const ch of '999') await clickEl(cdp, keypadKey(ch));
  await clickEl(cdp, KEYPAD_DONE);
  await sleep(240);

  checkEqual('自定义 Tag 的页码能填到上限 999',
    await cdp.evaluate(`return document.querySelector('.tag[data-tag-id="${longTag.id}"] .tag__page').textContent;`), '999');

  /* 窄屏下三区与二区不能同时在画面里，拖拽够不着 —— 用点选 + 点课程格这条路。
     放「生」不放「语」：语上已经有两条（必刷题、卷子），第三条在 148px 高的格子里
     会被挤到槽位的滚动区外面 —— 断言照样过，截图却拍不到那条，等于没有证据。
     生上只有一条，长名字这条一定在画面里。
     点格子靠下沿而不是正中：格子顶端躺着已有的 chip，别把点选当成撤下。 */
  await scrollTo(`.tag[data-tag-id="${longTag.id}"] .tag__label`);
  await clickEl(cdp, `.tag[data-tag-id="${longTag.id}"] .tag__label`);
  await scrollTo('[data-subject="sheng"]');
  const shengPoint = await cdp.evaluate(`
    const b = document.querySelector('[data-subject="sheng"]').getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.bottom - 12) };
  `);
  await clickPoint(cdp, shengPoint.x, shengPoint.y);
  await sleep(420);

  const longChip = await cdp.evaluate(`
    const chip = [...document.querySelectorAll('[data-subject="sheng"] .asg')]
      .find((n) => n.querySelector('.asg__label').textContent.startsWith('第三单元'));
    if (!chip) return null;
    const label = chip.querySelector('.asg__label');
    const page = chip.querySelector('.asg__page');
    const b = chip.getBoundingClientRect();
    return {
      label: label.textContent,
      page: page.textContent,
      // 名字整段收起来了（340px 下 12 字 + 三位页码，名字那段连一个字都放不下，
      // 见 board.css 的 .is-nameless）—— 这也算「让了步」，而且是让得最彻底的一种
      nameless: chip.classList.contains('is-nameless'),
      labelCut: label.scrollWidth - label.clientWidth,
      pageCut: page.scrollWidth - page.clientWidth,
      chipCut: chip.scrollWidth - chip.clientWidth,
      noScrollX: document.documentElement.scrollWidth <= innerWidth + 1,
      // 截屏里真能看见它 —— 量一个滚到画面外的东西，结论再对也没有证据
      inView: b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth,
    };
  `);
  check('窄格里 12 字的名字确实让了步（截短，或者整段收起只留页码），而且这一条就在画面里',
    longChip !== null && (longChip.nameless || longChip.labelCut > 1) && longChip.inView === true,
    JSON.stringify(longChip));
  check('窄格里「-999页」一位不少地完整显示，没被省略号吃掉',
    longChip !== null && longChip.page === '-999页'
      && longChip.pageCut <= 0 && longChip.chipCut <= 0, JSON.stringify(longChip));
  check('窄格里长名字 + 三位页码也没有撑出横向滚动',
    longChip !== null && longChip.noScrollX === true, JSON.stringify(longChip));
  await capture(cdp, '16-long-tag-narrow.png');

  /* ---- 键盘开着时那一枚 Tag 没了，键盘要自己收掉 ----
     用 .click() 而不是 clickEl：真人删不掉，他一按删除键，pointerdown 就先把键盘
     关掉了，走的是「点外面」那条。这里要验的是另一条路 —— 键盘开着的时候 Tag
     被别处抽走（恢复历史、重置设置都会）。所以跳过 pointerdown，直接给 click，
     让 removeCustomTag 去触发 keypad 的 resync。 */
  await scrollTo(`.tag[data-tag-id="${longTag.id}"] .tag__page`);
  await openKeypad(cdp, longTag.id);
  const beforeRemove = await cdp.evaluate(`return document.querySelector('.keypad').classList.contains('is-open');`);
  await cdp.evaluate(`
    document.querySelector('.tag[data-tag-id="${longTag.id}"] .tag__remove').click();
    return true;
  `);
  await sleep(360);
  const afterRemove = await cdp.evaluate(`
    return {
      open: document.querySelector('.keypad').classList.contains('is-open'),
      inert: document.querySelector('.keypad').inert,
      gone: !document.querySelector('.tag[data-tag-id="${longTag.id}"]'),
    };
  `);
  check('键盘开着时删掉那一枚 Tag，键盘自己收掉',
    beforeRemove === true && afterRemove.gone === true
      && afterRemove.open === false && afterRemove.inert === true,
    JSON.stringify({ beforeRemove, ...afterRemove }));

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(500);

  /* ================================ N. 一区「快捷」里的一键清除
     它是破坏性操作：清掉的只有二区，三区的 Tag 与历史记录都留着 —— 这既是
     用户明确选的行为，也是这个按钮最容易让人误会的地方（「清除全部」听起来
     像还原出厂）。所以三件事一起验：清之前如实说明清的是什么、第一次点只变
     文案、清完之后三区与历史一条不少。 */

  const CLEAR_BTN = '#zone-info [data-tool="clear-assignments"]';

  const clearState = async () => cdp.evaluate(`
    const btn = document.querySelector(${JSON.stringify(CLEAR_BTN)});
    const block = btn.closest('.tools-block');
    return {
      blockTitle: block.querySelector('.tools-block__title').textContent.trim(),
      label: btn.textContent.trim(),
      confirming: btn.classList.contains('is-confirming'),
      disabled: btn.disabled,
      note: document.querySelector('#zone-info [data-note="clear"]').textContent.trim(),
      chips: document.querySelectorAll('.asg').length,
      tags: document.querySelectorAll('.tags-body .tag').length,
    };
  `);

  const beforeClear = await clearState();
  checkEqual('清除按钮就在一区「快捷」这一块里', beforeClear.blockTitle, '快捷');
  checkEqual('平时是一句普通的按钮文案', beforeClear.label, '清空全部作业布置');
  checkEqual('二区有东西时按钮可用', beforeClear.disabled, false);
  checkEqual('二区这时是 7 项（M 段建的那枚长名字 Tag 已经删掉，它那条布置也跟着走了）',
    beforeClear.chips, 7);
  // 文案必须把「清什么、留什么」说全：这句是用户点下去之前唯一能看到的说明。
  checkEqual('说明如实写出要清几项、以及三区与历史都保留',
    beforeClear.note, '把二区这 7 项全部撤下。三区的 Tag 与历史记录都保留。');

  await clickEl(cdp, HISTORY_BTN);
  await sleep(420);
  const histBeforeClear = await histState();
  const histCountBefore = histBeforeClear.items.length;
  // 不写死条数：上面几段各自攒了几条不是这一段要管的事，这里只需要一个基准，
  // 好在清完之后验「只多了一条」。
  check('清之前历史里本来就有东西', histCountBefore > 1, String(histCountBefore));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(420);

  /* 第一次点：只换文案，什么都不清。这一步是给误触留的退路，不能省。 */
  await clickEl(cdp, CLEAR_BTN);
  const clearArmed = await clearState();
  checkEqual('第一次点，按钮变成待确认', clearArmed.confirming, true);
  checkEqual('待确认时的文案是「确认清空」', clearArmed.label, '确认清空');
  checkEqual('第一次点不清任何东西：二区还是 7 项', clearArmed.chips, 7);
  await capture(cdp, '18-clear-confirm.png');
  // 截屏要花几百毫秒，而确认态几秒后会自己超时退回 —— 这一条顺手把
  // 「拍完照它还举着」钉住，否则下面那一下可能只是又把它举起来一次，测试白跑。
  checkEqual('（拍完照）确认态仍在，等着第二下', (await clearState()).confirming, true);

  /* 第二次点：真的清。清的只有二区。 */
  await clickEl(cdp, CLEAR_BTN);
  await sleep(320);
  const afterClear = await clearState();
  checkEqual('第二次点才真的清掉二区', afterClear.chips, 0);
  checkEqual('三区的 Tag 一枚不少（清二区不是清 Tag）', afterClear.tags, DEFAULT_TAGS.length);
  checkEqual('清完按钮退回常态文案', afterClear.label, '清空全部作业布置');
  checkEqual('二区空了，按钮自己禁用', afterClear.disabled, true);
  checkEqual('说明也换成「二区还没有布置。」', afterClear.note, '二区还没有布置。');

  await clickEl(cdp, HISTORY_BTN);
  await sleep(420);
  const histAfterClear = await histState();
  checkEqual('清空只记一条历史', histAfterClear.items.length, histCountBefore + 1);
  checkEqual('这一条写着做了什么', histAfterClear.items[0].label, '清空全部');
  checkEqual('它是当前状态', histAfterClear.items[0].current, true);
  checkEqual('上一条（清之前那条）变成可恢复 —— 清空是能退回来的',
    histAfterClear.items[1].canRestore, true);
  checkEqual('清空这条的摘要写着空板', histAfterClear.items[0].summary, '空板');
  await capture(cdp, '19-history-cleared.png');

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(420);

  /* ------------------------------------------- 收尾：把自检写的数据清干净 */

  await cdp.evaluate(`localStorage.clear(); return true;`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1400);
  const pristine = await cdp.evaluate(`
    return {
      tags: document.querySelectorAll('.tags-body .tag').length,
      chips: document.querySelectorAll('.asg').length,
      pages: [...document.querySelectorAll('.tag__page')].map((n) => n.textContent),
      custom: document.querySelectorAll('.tag--custom').length,
    };
  `);
  check('收尾清理后回到初始状态（默认 Tag、无布置、无页码）',
    pristine.tags === DEFAULT_TAGS.length && pristine.chips === 0 && pristine.custom === 0
      && pristine.pages.length === DEFAULT_TAGS.length && pristine.pages.every((v) => v === ''),
    JSON.stringify(pristine));

  /* ------------------------------------------------------------ 控制台 */

  check('运行期无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  /* -------------------------------------------------------------- 汇总 */

  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.detail ? `   ${r.detail}` : ''}`);
  }
  console.log('');
  console.log(`共 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项。`);
  console.log(`截图：${OUT_DIR}`);

  process.exitCode = failed > 0 ? 1 : 0;
} catch (error) {
  console.error('自检执行失败：', error);
  process.exitCode = 1;
} finally {
  cdp?.ws.close();
  chrome.kill();
}
