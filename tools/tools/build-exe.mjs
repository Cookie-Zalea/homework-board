/**
 * 打包成单文件 exe。
 *
 * 用系统自带的 C# 编译器（.NET Framework 的 csc.exe，Win7 起每台机器都有），
 * 把 index.html 与 src/** 作为**内嵌资源**编进 tools/exe/Launcher.cs，
 * 产出一个双击就跑的 dist\作业发布系统.exe —— 不需要 Node、不需要 Python、
 * 不需要 .NET SDK，也不弹控制台窗口。
 *
 * 图标：src/assets/icon.ico 会**同时**以两种方式进去 ——
 *   · 作为内嵌资源（它就在 src/** 里，跟着一起收集），托盘图标从里面读；
 *   · 用 /win32icon 打进 PE 头，这是资源管理器里那个文件图标。
 * 一个文件，三处显示（还有一处是网页 favicon，由 index.html 引用）。
 *
 * 为什么不做压缩：全部内容约 300KB，压不压对体积没多大区别，换来的是不依赖
 * 任何 zip/Deflate 库 —— 少一个环节就少一种坏法。
 *
 * 用法：npm run build:exe
 *   改完 src/** 要重新跑一次 —— exe 里的网页内容是构建那一刻的**快照**。
 *   开发时照旧 node tools/serve.mjs（或双击 start.cmd），那条路径读的是磁盘。
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const OUT_DIR = join(ROOT, 'dist');
const OUT = join(OUT_DIR, '作业发布系统.exe');
const LAUNCHER = join(ROOT, 'tools', 'exe', 'Launcher.cs');
const ICON = join(ROOT, 'src', 'assets', 'icon.ico');

/* 64 位系统上一定有这份编译器；32 位系统走 Framework 那一份 */
const CSC = process.env.CSC
  || join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

/** 目录树里所有文件（只有 src/** 这一处需要递归） */
async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full));
    else found.push(full);
  }
  return found;
}

const pages = [join(ROOT, 'index.html'), ...await walk(join(ROOT, 'src'))];

for (const path of [CSC, LAUNCHER, ICON]) {
  try {
    await stat(path);
  } catch {
    console.error(`找不到 ${path}`);
    console.error('C# 编译器不在默认位置时，用环境变量指定：set CSC=<csc.exe 的完整路径>');
    process.exit(1);
  }
}

/* 资源名写成 app/<相对路径>：Launcher.cs 那边去掉前缀就是 URL 路径。
   显式指定名字（而不是让编译器从文件名推）是为了避免同名文件撞车 ——
   src/styles 和 src/views 里各有一个 settings.js / settings.css 之类。 */
const resources = pages.map((file) => {
  const rel = relative(ROOT, file).split(sep).join('/');
  return `-resource:${file},app/${rel}`;
});

const args = [
  '-nologo',
  '-target:winexe',
  '-optimize+',
  '-codepage:65001',            // 源码里的中文是 UTF-8：不指定的话 csc 会按 GBK 读
  `-out:${OUT}`,
  `-win32icon:${ICON}`,         // 资源管理器里那个文件图标
  '-r:System.dll',
  '-r:System.Drawing.dll',
  '-r:System.Windows.Forms.dll',
  ...resources,
  LAUNCHER,
];

await mkdir(OUT_DIR, { recursive: true });

/* dist 里只该有这一个 exe。改过名（作业布置软件 → 作业发布系统），
   不扫一遍的话旧名字那个会一直躺在旁边，双击哪个全凭记性。 */
for (const entry of await readdir(OUT_DIR)) {
  const stale = join(OUT_DIR, entry);
  if (entry.toLowerCase().endsWith('.exe') && stale !== OUT) {
    await rm(stale).then(
      () => console.log(`清掉旧产物 ${entry}`),
      (error) => { console.error(`旧的 ${entry} 删不掉（多半还开着），先关掉它再构建：${error.message}`); process.exit(1); },
    );
  }
}

console.log(`打包 ${pages.length} 个文件 → ${OUT}`);

try {
  await run(CSC, args);
} catch (error) {
  console.error('编译失败：');
  console.error(error.stdout || '');
  console.error(error.stderr || error.message);
  process.exit(1);
}

const info = await stat(OUT);
console.log(`完成：${OUT}`);
console.log(`${pages.length} 个文件内嵌其中，exe ${(info.size / 1024).toFixed(0)} KB，双击即可运行。`);
