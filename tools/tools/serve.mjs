/**
 * 零依赖静态服务。
 *
 * 为什么不能直接双击 index.html：应用用的是原生 ES Module，
 * file:// 协议下浏览器会按 CORS 规则拒绝加载模块脚本。
 * 所以起一个本地 http 服务，仅此而已 —— 不做构建、不做转译。
 *
 * 用法：node tools/serve.mjs   （端口可用 PORT 环境变量覆盖）
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const PORT = Number(process.env.PORT || 8777);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    let requestPath = decodeURIComponent(pathname);
    if (requestPath.endsWith('/')) requestPath += 'index.html';

    const target = normalize(join(ROOT, requestPath));
    // 目录穿越防护：只允许读取项目目录内的文件
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      respond(res, 403, 'text/plain; charset=utf-8', '403 越界访问');
      return;
    }

    const info = await stat(target);
    if (!info.isFile()) {
      respond(res, 404, 'text/plain; charset=utf-8', '404 未找到');
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    respond(res, 404, 'text/plain; charset=utf-8', '404 未找到');
  }
});

function respond(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function openBrowser(url) {
  if (process.env.NO_OPEN) return;   // 自动化测试时不要弹浏览器
  const commands = { win32: ['cmd', ['/c', 'start', '', url]], darwin: ['open', [url]] };
  const [command, args] = commands[process.platform] ?? ['xdg-open', [url]];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打不开就算了，地址已经打印出来了 */
  }
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。换个端口再试，例如：`);
    console.error(`  set PORT=8899 && node tools\\serve.mjs`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`作业发布系统已启动：${url}`);
  console.log('按 Ctrl+C 停止。');
  openBrowser(url);
});
