/**
 * 作业发布系统 —— 桌面启动器（C# 5 / WinForms，用系统自带的 csc.exe 编成单文件 exe）
 *
 * 做三件事：
 *   1. 在本机 8777 端口起一个极小的静态服务，网页内容全部内嵌在本 exe 里；
 *   2. 用 Edge / Chrome 的「应用窗口」打开它 —— 没有地址栏、没有标签页，
 *      看起来就是个桌面软件；
 *   3. 挂一个托盘图标（这是唯一的出口：本程序是 /target:winexe，没有控制台）。
 *
 * 为什么不用 HttpListener：它对非管理员有 URL ACL 限制，双击运行会直接
 * 「拒绝访问」。TcpListener 是普通 socket，不挑权限。
 *
 * 为什么只绑环回：这是给本机一个人用的软件，绑 0.0.0.0 就等于把它挂到局域网
 * 上，同事随手就能打开、还共用同一个 localStorage。绑两个环回（127.0.0.1 和
 * ::1）是因为 Windows 11 上 localhost 常常先解析到 ::1，只绑 IPv4 会连不上。
 *
 * 为什么读内嵌资源而不是磁盘上的文件：这样才是一个自包含的单文件 exe，
 * 拷到哪儿都能跑。代价是 exe 里的网页内容是**冻结**的 —— 改了 src/** 要重新
 * 构建（开发时照旧用 node tools/serve.mjs）。
 *
 * 端口固定 8777 是为了让存档（localStorage，按 origin 隔离）在 exe 与
 * 开发服务之间是同一个 origin。
 *
 * 图标只有一份：src/assets/icon.ico。它同时是 exe 的文件图标（构建时用
 * csc 的 /win32icon 打进去）、托盘图标（从内嵌资源里读）、以及网页的
 * favicon（应用窗口和任务栏认的是它）。
 *
 * 出问题不要静默：所有失败都弹一个说人话的对话框，并往
 * %LOCALAPPDATA%\作业发布系统\launcher.log 追加一行。
 */

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace HomeworkBoard
{
    internal static class Program
    {
        private const int Port = 8777;
        private const string Url = "http://localhost:8777/";
        private const string Marker = "X-Homework-Board";    // 认出「端口上是不是自己人」
        private const string Prefix = "app/";                // 内嵌资源名的前缀
        private const string DataDirName = "作业发布系统";
        private const string LegacyDataDirName = "作业布置软件";   // 改名前的目录名，见 DataRoot()
        private const string IconResource = "/src/assets/icon.ico";

        private const int Free = 0, Ours = 1, Foreign = 2;

        /* 这两行的先后是有意的：DataRoot 在算的过程中可能记下一句话（搬迁失败），
           而「记」这个动作要等服务目录定下来。所以先声明记事本，再算目录。 */
        private static string startupNote;
        private static readonly string DataRoot = ResolveDataRoot();

        private static readonly Dictionary<string, string> Files = IndexResources();

        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (startupNote != null) Log(startupNote);

            int probe = ProbePort();
            if (probe == Ours)
            {
                // 十有八九是又双击了一下图标：不起第二份，只把窗口叫出来
                Log("已在运行，只开窗口");
                OpenWindow();
                return;
            }
            if (probe == Foreign)
            {
                Warn("端口 " + Port + " 被别的程序占用了，作业发布系统没法启动自己的服务。\r\n\r\n"
                   + "请关掉占用这个端口的程序再试（多半是另一个开发服务器），"
                   + "或者重启一次电脑。");
                return;
            }

            List<TcpListener> listeners = Listen();
            if (listeners.Count == 0)
            {
                Warn("没能启动本地服务（端口 " + Port + "）。\r\n\r\n"
                   + "可能是端口被占用、或者防火墙拦住了本机回环地址。"
                   + "详细信息记在：\r\n" + LogPath());
                return;
            }

            foreach (TcpListener listener in listeners) Serve(listener);
            Log("服务已启动，监听 " + listeners.Count + " 个环回地址");
            OpenWindow();

            // 托盘是唯一的界面：菜单里有「打开窗口」和「退出」
            Application.Run(new TrayApp(listeners));
        }

        /* ------------------------------------------------------------ 静态服务 */

        private static Dictionary<string, string> IndexResources()
        {
            Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.Ordinal);
            Assembly self = Assembly.GetExecutingAssembly();
            foreach (string name in self.GetManifestResourceNames())
            {
                // 构建时写的是 app/<相对路径>，名字原样保留，所以这里能直接还原路径
                if (name.StartsWith(Prefix, StringComparison.Ordinal))
                {
                    map["/" + name.Substring(Prefix.Length)] = name;
                }
            }
            return map;
        }

        private static List<TcpListener> Listen()
        {
            List<TcpListener> bound = new List<TcpListener>();
            IPAddress[] addresses = new IPAddress[] { IPAddress.Loopback, IPAddress.IPv6Loopback };
            foreach (IPAddress address in addresses)
            {
                try
                {
                    TcpListener listener = new TcpListener(address, Port);
                    listener.Start();
                    bound.Add(listener);
                }
                catch (Exception error)
                {
                    Log("绑定 " + address + " 失败：" + error.Message);
                }
            }
            return bound;
        }

        private static void Serve(TcpListener listener)
        {
            Thread thread = new Thread(delegate()
            {
                while (true)
                {
                    TcpClient client;
                    try { client = listener.AcceptTcpClient(); }
                    catch { return; }        // 监听器被关掉了（退出时），收工
                    ThreadPool.QueueUserWorkItem(delegate(object state) { Handle((TcpClient)state); }, client);
                }
            });
            thread.IsBackground = true;
            thread.Start();
        }

        private static void Handle(TcpClient client)
        {
            using (client)
            {
                try
                {
                    client.ReceiveTimeout = 5000;
                    client.SendTimeout = 10000;
                    NetworkStream stream = client.GetStream();

                    string path = RequestPath(ReadHead(stream));
                    byte[] body;
                    string type;
                    int status;

                    if (path == null || !TryRead(path, out body, out type))
                    {
                        status = 404;
                        type = "text/plain; charset=utf-8";
                        body = Encoding.UTF8.GetBytes("404 未找到");
                    }
                    else
                    {
                        status = 200;
                    }
                    Write(stream, status, type, body);
                }
                catch
                {
                    // 单个连接出错不能把整个服务带下去（页面里任何一次失败
                    // 都只是那一个文件没加载出来），所以这里什么也不做。
                }
            }
        }

        /** 只读请求头：本机页面自己请求自己，没有正文，读到空行就够 */
        private static string ReadHead(NetworkStream stream)
        {
            MemoryStream buffer = new MemoryStream();
            byte[] chunk = new byte[1024];
            while (buffer.Length < 8192)
            {
                int read = stream.Read(chunk, 0, chunk.Length);
                if (read <= 0) break;
                buffer.Write(chunk, 0, read);

                byte[] all = buffer.GetBuffer();
                int end = (int)buffer.Length;
                for (int i = Math.Max(0, end - read - 3); i <= end - 4; i++)
                {
                    if (all[i] == 13 && all[i + 1] == 10 && all[i + 2] == 13 && all[i + 3] == 10)
                    {
                        return Encoding.ASCII.GetString(all, 0, i);
                    }
                }
            }
            return buffer.Length > 0 ? Encoding.ASCII.GetString(buffer.ToArray()) : null;
        }

        /** 从「GET /src/main.js HTTP/1.1」里取出 /src/main.js */
        private static string RequestPath(string head)
        {
            if (head == null) return null;
            string[] lines = head.Split('\n');
            if (lines.Length == 0) return null;
            string[] parts = lines[0].Trim().Split(' ');
            if (parts.Length < 2) return null;

            string path = parts[1];
            int query = path.IndexOf('?');
            if (query >= 0) path = path.Substring(0, query);
            try { path = Uri.UnescapeDataString(path); }
            catch { return null; }

            if (path.Length == 0 || path[0] != '/') return null;
            if (path.IndexOf("..", StringComparison.Ordinal) >= 0) return null;   // 目录穿越防护
            if (path.EndsWith("/", StringComparison.Ordinal)) path += "index.html";
            return path;
        }

        private static bool TryRead(string path, out byte[] body, out string type)
        {
            body = null;
            type = null;
            string name;
            if (!Files.TryGetValue(path, out name)) return false;

            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            {
                if (stream == null) return false;
                body = new byte[stream.Length];
                int offset = 0;
                while (offset < body.Length)
                {
                    int read = stream.Read(body, offset, body.Length - offset);
                    if (read <= 0) break;
                    offset += read;
                }
            }
            type = MimeOf(path);
            return true;
        }

        private static string MimeOf(string path)
        {
            // 照抄 tools/serve.mjs 的那张表，两边别走偏
            string ext = Path.GetExtension(path).ToLowerInvariant();
            switch (ext)
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": return "text/javascript; charset=utf-8";
                case ".mjs": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json": return "application/json; charset=utf-8";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                case ".jpg": return "image/jpeg";
                case ".ico": return "image/x-icon";
                case ".woff2": return "font/woff2";
                default: return "application/octet-stream";
            }
        }

        private static void Write(NetworkStream stream, int status, string type, byte[] body)
        {
            string reason = status == 200 ? "OK" : "Not Found";
            string head = "HTTP/1.1 " + status.ToString(CultureInfo.InvariantCulture) + " " + reason + "\r\n"
                        + "Content-Type: " + type + "\r\n"
                        + "Content-Length: " + body.Length.ToString(CultureInfo.InvariantCulture) + "\r\n"
                        + "Cache-Control: no-store\r\n"          // 和开发服务一致：改完刷新就能看到
                        + Marker + ": 1\r\n"                     // 第二次双击时靠它认出自己
                        + "Connection: close\r\n\r\n";
            byte[] headBytes = Encoding.ASCII.GetBytes(head);
            stream.Write(headBytes, 0, headBytes.Length);
            stream.Write(body, 0, body.Length);
            stream.Flush();
        }

        /* -------------------------------------------------------------- 认人 */

        /** 端口上有人吗？是自己人还是别的程序？ */
        private static int ProbePort()
        {
            int v4 = ProbeOne(AddressFamily.InterNetwork);
            if (v4 == Ours) return Ours;
            int v6 = ProbeOne(AddressFamily.InterNetworkV6);
            if (v6 == Ours) return Ours;
            return (v4 == Foreign || v6 == Foreign) ? Foreign : Free;
        }

        private static int ProbeOne(AddressFamily family)
        {
            try
            {
                IPAddress address = family == AddressFamily.InterNetwork
                    ? IPAddress.Loopback : IPAddress.IPv6Loopback;

                using (TcpClient client = new TcpClient(family))
                {
                    IAsyncResult connect = client.BeginConnect(address, Port, null, null);
                    if (!connect.AsyncWaitHandle.WaitOne(400)) return Free;   // 连不上 = 没人在
                    client.EndConnect(connect);

                    using (NetworkStream stream = client.GetStream())
                    {
                        byte[] ask = Encoding.ASCII.GetBytes("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
                        stream.Write(ask, 0, ask.Length);
                        string head = ReadHead(stream);
                        return head != null && head.Contains(Marker) ? Ours : Foreign;
                    }
                }
            }
            catch
            {
                // 拒绝连接、超时、中途断掉，都当作「没人在」；真是别人占着，
                // 下面的 Listen 会失败，那时还有一次说明白的机会
                return Free;
            }
        }

        /* -------------------------------------------------------------- 开窗 */

        private static string FindBrowser()
        {
            string[] candidates = new string[]
            {
                Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                        @"Microsoft\Edge\Application\msedge.exe"),
                Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                        @"Microsoft\Edge\Application\msedge.exe"),
                Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        @"Microsoft\Edge\Application\msedge.exe"),
                Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                        @"Google\Chrome\Application\chrome.exe"),
                Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                        @"Google\Chrome\Application\chrome.exe"),
                Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        @"Google\Chrome\Application\chrome.exe"),
            };
            foreach (string path in candidates)
            {
                if (path != null && File.Exists(path)) return path;
            }
            return null;
        }

        private static string Combine(string root, string rest)
        {
            return string.IsNullOrEmpty(root) ? null : Path.Combine(root, rest);
        }

        private static string ProfileDir()
        {
            string dir = Path.Combine(DataRoot, "browser");
            try { Directory.CreateDirectory(dir); } catch { /* 建不出来就让浏览器自己建 */ }
            return dir;
        }

        /**
         * 用应用窗口打开。专用配置目录（不是老师日常那个浏览器配置）有两个好处：
         *   · 存档不会被「清理浏览数据」顺手删掉；
         *   · 不受日常浏览器里的扩展、插件、代理设置影响。
         * 代价是这份存档和「在普通浏览器里打开 localhost:8777」看到的不是同一份，
         * README 里写明了。
         */
        private static void OpenWindow()
        {
            string browser = FindBrowser();
            if (browser != null)
            {
                try
                {
                    ProcessStartInfo info = new ProcessStartInfo(browser);
                    info.Arguments = "--app=" + Url
                                   + " --user-data-dir=\"" + ProfileDir() + "\""
                                   + " --no-first-run --no-default-browser-check";
                    info.UseShellExecute = false;
                    Process.Start(info);
                    Log("已用 " + browser + " 开窗");
                    return;
                }
                catch (Exception error)
                {
                    Log("用 " + browser + " 开窗失败：" + error.Message);
                }
            }

            // 没装 Edge / Chrome，或者启动失败：交给系统默认浏览器
            try
            {
                Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
                Log("已用系统默认浏览器打开");
            }
            catch (Exception error)
            {
                Warn("打不开浏览器窗口：" + error.Message + "\r\n\r\n请手动访问 " + Url);
            }
        }

        /* -------------------------------------------------------------- 日志 */

        /**
         * %LOCALAPPDATA% 下属于本软件的那个目录。为什么不能只是拼一下路径：
         * 软件改过一次名，而老目录里放着**浏览器配置目录** —— 老师的存档
         * （localStorage）就在那里面。第一次用新名字启动时把老目录整个搬过来，
         * 老用户打开还是他那块板子，不会看见一块空板。
         *
         * 搬不动（比如老窗口还开着占着文件）就**继续用老目录**：目录名叫什么
         * 是小事，让人打开看见空板子是大事。这件事记在 startupNote 里，
         * 等服务目录定下来再写进日志。
         */
        private static string ResolveDataRoot()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string root = Path.Combine(local, DataDirName);
            string legacy = Path.Combine(local, LegacyDataDirName);

            try
            {
                if (!Directory.Exists(root) && Directory.Exists(legacy))
                {
                    Directory.Move(legacy, root);
                    startupNote = "已把旧目录 " + LegacyDataDirName + " 改名为 " + DataDirName;
                    return root;
                }
            }
            catch (Exception error)
            {
                startupNote = "旧目录 " + LegacyDataDirName + " 改名失败，继续用它（存档还在里面）："
                            + error.Message;
                return legacy;
            }
            return root;
        }

        private static string LogPath()
        {
            return Path.Combine(DataRoot, "launcher.log");
        }

        /** 没有控制台，出问题总得留下点什么 */
        private static void Log(string message)
        {
            try
            {
                string path = LogPath();
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                                         + "  " + message + Environment.NewLine, Encoding.UTF8);
            }
            catch { /* 连日志都写不了就只好算了，不能因此挡住启动 */ }
        }

        private static void Warn(string message)
        {
            Log(message.Replace("\r\n", " "));
            MessageBox.Show(message, DataDirName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        /* -------------------------------------------------------------- 托盘 */

        private sealed class TrayApp : ApplicationContext
        {
            private readonly NotifyIcon icon;
            private readonly List<TcpListener> listeners;

            public TrayApp(List<TcpListener> listeners)
            {
                this.listeners = listeners;

                ContextMenuStrip menu = new ContextMenuStrip();
                menu.Items.Add("打开窗口", null, delegate { OpenWindow(); });
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("退出", null, delegate { Quit(); });

                icon = new NotifyIcon();
                icon.Icon = AppIcon();
                icon.Text = DataDirName;               // 托盘提示上限 63 个字符
                icon.ContextMenuStrip = menu;
                icon.DoubleClick += delegate { OpenWindow(); };
                icon.Visible = true;
            }

            /** 托盘用软件自己的图标：读 exe 里内嵌的那一份（和网页 favicon 同一个文件）。
                读不出来不是不能启动的理由，退回系统图标。

                尺寸得指名道姓。new Icon(stream) 是按**大**图标尺寸（32）挑帧的，托盘只有
                16，于是 Windows 把 32 那张缩下来 —— 而 .ico 里 16/24 两张是照着托盘尺寸
                另画的（线更少更粗）。实测：屏幕上的托盘像素与「32 缩到 16」差 4.3、
                与我们自己那张 16 差 15.4 —— 也就是说手绘的小尺寸帧被顶掉了，白画。
                按 SmallIconSize 挑，才是那两张的用武之地。 */
            private static Icon AppIcon()
            {
                try
                {
                    string name;
                    if (Files.TryGetValue(IconResource, out name))
                    {
                        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
                        {
                            if (stream != null) return new Icon(stream, SystemInformation.SmallIconSize);
                        }
                    }
                }
                catch { /* 下面那句兜底 */ }
                return SystemIcons.Application;
            }

            private void Quit()
            {
                foreach (TcpListener listener in listeners)
                {
                    try { listener.Stop(); } catch { }
                }
                icon.Visible = false;
                icon.Dispose();
                Log("退出");
                ExitThread();
            }
        }
    }
}
