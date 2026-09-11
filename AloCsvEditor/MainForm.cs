// 主窗口壳：承载 WebView2，加载本地前端页面；C# 侧文件操作的统一出口。
// M3：桥接处理函数接线（打开对话框/保存/另存/重载/回执/脏标记），窗口标题归 C# 所有。
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AloCsvEditor;

public sealed class MainForm : Form
{
    // 虚拟域名：把输出目录下的 wwwroot 文件夹映射为 https 站点，
    // 解决 file:// 下 ES Module 被浏览器 CORS 拦截的问题。
    private const string AppHost = "alocsv.local";

    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly Bridge _bridge;

    // 启动参数（支持 AloCsvEditor.exe xxx.csv 直接打开）。
    private readonly string[] _startupArgs;

    // 当前文件元数据（文本本身在 JS 侧；保存/重载时用）。
    private string? _currentPath;
    private string _currentEncoding = "utf-8";
    private char _currentDelimiter = ',';

    // 标题归 C# 所有：基础标题 + 脏标记后缀（JS 只上报 setDirty，不直接改标题）。
    private string _baseTitle = "AloCsvEditor — 就绪";
    private bool _dirty;

    // 关闭流程（#5 真实现，替代 M3 留空的挂接点）：脏时 C# 弹三选框；
    // 选"是"发 saveAndClose 给 JS；JS 存完 C# 回 saveResult{ok}，ok 才关；
    // 另存取消/保存失败一律回 ok:false，停留在窗口（无过期标记 bug）。
    private bool _closingAfterSave;

    // 设置持久化（#5）：窗口位置/大小归 C# 管，其余键归 JS。
    private readonly SettingsService _settings = new();
    private readonly System.Windows.Forms.Timer _boundsTimer = new() { Interval = 800 };

    public MainForm(string[] startupArgs)
    {
        _startupArgs = startupArgs;
        Text = _baseTitle;
        FormBorderStyle = FormBorderStyle.None; // #2：无边框，标题栏/缩放全部自绘
        ClientSize = new Size(1280, 800);
        MaximizedBounds = Screen.FromHandle(Handle).WorkingArea;
        MinimumSize = new Size(800, 600);
        _settings.Load();
        StartPosition = FormStartPosition.CenterScreen; // 缺省；ApplyWindowBounds 成功时改成 Manual
        ApplyWindowBounds();
        _bridge = new Bridge(_webView);
        RegisterBridgeHandlers();
        Controls.Add(_webView);
        Load += OnLoad;

        // 窗口位置/大小记忆：拖完/挪完落盘（#5）。
        _boundsTimer.Tick += (_, _) => { _boundsTimer.Stop(); SaveWindowBounds(); };
        ResizeEnd += (_, _) => SaveWindowBounds();
        LocationChanged += (_, _) =>
        {
            if (WindowState == FormWindowState.Normal)
            {
                _boundsTimer.Stop();
                _boundsTimer.Start();
            }
        };

        // 从资源管理器拖文件进来打开。
        AllowDrop = true;
        DragEnter += OnDragEnter;
        DragDrop += OnDragDrop;
        FormClosing += OnFormClosing;
    }

    private void RegisterBridgeHandlers()
    {
        _bridge.On("openFileDialog", _ => OpenFileWithDialog());
        _bridge.On("save", root => SaveFromJs(root, saveAs: false));
        _bridge.On("saveAs", root => SaveFromJs(root, saveAs: true));
        _bridge.On("reloadWithEncoding", ReloadWithEncoding);
        _bridge.On("fileOpenedAck", OnFileOpenedAck);
        _bridge.On("ready", _ => SendSettings());
        _bridge.On("saveSettings", MergeSettings);
        _bridge.On("winDrag", _ =>
        {
            // 最大化时先还原再拖（按当前光标相对拖，无跳变）。
            if (WindowState == FormWindowState.Maximized)
                WindowState = FormWindowState.Normal;
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
        });
        _bridge.On("winMin", _ => WindowState = FormWindowState.Minimized);
        _bridge.On("winToggleMax", _ => ToggleMax());
        _bridge.On("winClose", _ => Close());
        _bridge.On("winResize", BeginWindowResize);
        _bridge.On("dropFile", DropFileFromJs);
        _bridge.On("closeReply", _ =>
        {
            _closingAfterSave = true;
            Close();
        });
        _bridge.On("setDirty", root =>
        {
            _dirty = root.TryGetProperty("dirty", out JsonElement d) && d.GetBoolean();
            UpdateTitle();
        });
    }

    private async void OnLoad(object? sender, EventArgs e)
    {
        try
        {
            // 初始化 WebView2（使用系统已装的 Evergreen Runtime）。
            await _webView.EnsureCoreWebView2Async();
            CoreWebView2 core = _webView.CoreWebView2;

            // 关掉浏览器默认右键菜单（页面内自绘右键菜单，F-18）。
            core.Settings.AreDefaultContextMenusEnabled = false;

            // 本地资源映射：<输出目录>\wwwroot → https://alocsv.local/
            string wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
            core.SetVirtualHostNameToFolderMapping(
                AppHost, wwwroot, CoreWebView2HostResourceAccessKind.Allow);

            // 本地资源走虚拟域名：禁用 Chromium 缓存，每次都从磁盘读最新文件。
            // （用户数据目录跨版本保留，禁缓存可避免更新后命中旧页面；本地加载无性能损失。）
            await core.CallDevToolsProtocolMethodAsync(
                "Network.setCacheDisabled", "{\"cacheDisabled\":true}");

            core.NavigationCompleted += OnNavigationCompleted;
            core.Navigate($"https://{AppHost}/index.html");
        }
        catch (Exception ex)
        {
            // 初始化失败直接显示在标题栏。
            _baseTitle = "AloCsvEditor — 初始化失败：" + ex.Message;
            UpdateTitle();
        }
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
        {
            _baseTitle = "AloCsvEditor — 页面加载失败：" + e.WebErrorStatus;
            UpdateTitle();
            return;
        }
        _baseTitle = "AloCsvEditor — 就绪";
        UpdateTitle();

        // 命令行带文件：第一个"看起来像路径且存在"的参数直接载入。
        string? startupFile = _startupArgs
            .FirstOrDefault(f => !f.StartsWith('-') && File.Exists(f));
        if (startupFile is not null)
            OpenFile(startupFile);
    }

    // 统一载入入口：对话框 / 拖放 / 命令行都走这里。
    // 读字节→识别→解码后经 Bridge 发 fileOpened 给 JS；标题等 JS 回执后再更新。
    private void OpenFile(string path, string? encodingName = null, char? delimiter = null)
    {
        try
        {
            FileService.LoadedFile f = FileService.Load(path, encodingName, delimiter);
            PublishLoadedFile(f, f.Path, f.Path);
        }
        catch (Exception ex)
        {
            _bridge.Post("error", new { message = "打开文件失败：" + ex.Message });
        }
    }

    // 页面拖拽载入（#1 轮）：JS 发 base64 字节（浏览器拿不到真实路径）；
    // pathForJs 记 null → JS 视为未命名（保存弹框，与新建同语义）。
    private void DropFileFromJs(JsonElement root)
    {
        try
        {
            string? b64 = GetString(root, "base64");
            string name = GetString(root, "fileName") ?? "拖放文件.csv";
            if (string.IsNullOrEmpty(b64))
            {
                _bridge.Post("error", new { message = "读取拖放文件失败" });
                return;
            }
            FileService.LoadedFile f = FileService.LoadFromBytes(Convert.FromBase64String(b64), name);
            PublishLoadedFile(f, null, null);
        }
        catch (Exception ex)
        {
            _bridge.Post("error", new { message = "打开拖放文件失败：" + ex.Message });
        }
    }

    // 发布载入结果：currentPath 记盘路径（null 则保存弹框），pathForJs 发给 JS。
    private void PublishLoadedFile(FileService.LoadedFile f, string? currentPath, string? pathForJs)
    {
        _currentPath = currentPath;
        _currentEncoding = f.EncodingName;
        _currentDelimiter = f.Delimiter;
        _bridge.Post("fileOpened", new
        {
            path = pathForJs,
            fileName = Path.GetFileName(f.Path),
            text = f.Text,
            encoding = f.EncodingName,
            delimiter = f.Delimiter.ToString(),
            newline = f.Newline,
            hasBom = f.HasBom,
            // 唯一真相源：JS 据此生成编码/分隔符下拉框（两边不用硬编码同步）。
            supportedEncodings = FileService.SupportedEncodings,
            supportedDelimiters = FileService.SupportedDelimiters.Select(d => d.ToString()).ToArray(),
        });
    }

    private void OpenFileWithDialog()
    {
        using OpenFileDialog dlg = new()
        {
            Filter = "表格文本文件 (*.csv;*.tsv;*.txt)|*.csv;*.tsv;*.txt|所有文件 (*.*)|*.*",
            Title = "打开 CSV 文件",
        };
        if (dlg.ShowDialog(this) == DialogResult.OK)
            OpenFile(dlg.FileName);
    }

    // JS 发来的保存请求：按给定编码写字节。saveAs 或 path 为空时先弹对话框；
    // 对话框取消则不回包，JS 保持脏标记（正确语义）。
    private void SaveFromJs(JsonElement root, bool saveAs)
    {
        try
        {
            string? path = GetString(root, "path") is { Length: > 0 } p ? p : _currentPath;
            if (saveAs || string.IsNullOrEmpty(path))
            {
                using SaveFileDialog dlg = new()
                {
                    Filter = "CSV 文件 (*.csv)|*.csv|TSV 文件 (*.tsv)|*.tsv|文本文件 (*.txt)|*.txt|所有文件 (*.*)|*.*",
                    FileName = _currentPath is null ? "未命名.csv" : Path.GetFileName(_currentPath),
                    Title = "保存 CSV 文件",
                };
                if (dlg.ShowDialog(this) != DialogResult.OK)
                {
                    // 对话框取消：明确回执，JS 清掉关闭等待（否则下次手动保存会误关）。
                    _bridge.Post("saveResult", new { ok = false });
                    return;
                }
                path = dlg.FileName;
            }
            var options = new FileService.SaveOptions(
                GetString(root, "encoding") ?? _currentEncoding,
                GetString(root, "delimiter") is { Length: > 0 } d ? d[0] : _currentDelimiter,
                GetString(root, "newline") ?? "\r\n",
                GetBool(root, "hasBom", false));
            FileService.Save(path, GetString(root, "text") ?? "", options);
            _currentPath = path;
            _currentEncoding = options.EncodingName;
            _currentDelimiter = options.Delimiter;
            _bridge.Post("fileSaved", new { path });
            _bridge.Post("saveResult", new { ok = true });
            _baseTitle = Path.GetFileName(path) + " — AloCsvEditor";
            UpdateTitle();
        }
        catch (Exception ex)
        {
            _bridge.Post("error", new { message = "保存失败：" + ex.Message });
            _bridge.Post("saveResult", new { ok = false });
        }
    }

    // 按指定编码/分隔符重载当前文件（工具栏下拉框切换时用）。
    private void ReloadWithEncoding(JsonElement root)
    {
        if (_currentPath is null)
        {
            _bridge.Post("error", new { message = "没有打开的文件" });
            return;
        }
        string? delimStr = GetString(root, "delimiter");
        OpenFile(_currentPath,
            GetString(root, "encoding"),
            delimStr is { Length: > 0 } ? delimStr[0] : null);
    }

    // JS ready 后下发设置快照 + 编码/分隔符候选（新建文档也要用候选建下拉框）。
    private void SendSettings()
    {
        _bridge.Post("settings", new
        {
            settings = _settings.Snapshot(),
            supportedEncodings = FileService.SupportedEncodings,
            supportedDelimiters = FileService.SupportedDelimiters.Select(d => d.ToString()).ToArray(),
        });
    }

    // JS 侧设置变更合并落盘（窗口键不受影响，只增改 JS 的键）。
    private void MergeSettings(JsonElement root)
    {
        if (root.TryGetProperty("settings", out JsonElement s)
            && s.ValueKind == JsonValueKind.Object)
            _settings.Merge(s);
    }

    // 启动恢复窗口位置/大小（#5）；存过最大化则最大化；位置非法回 CenterScreen。
    private void ApplyWindowBounds()
    {
        int x = _settings.Get("winX", int.MinValue);
        int y = _settings.Get("winY", int.MinValue);
        int w = _settings.Get("winW", 0);
        int h = _settings.Get("winH", 0);
        if (x != int.MinValue && w >= MinimumSize.Width && h >= MinimumSize.Height)
        {
            var rect = new Rectangle(x, y, w, h);
            if (Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(rect)))
            {
                StartPosition = FormStartPosition.Manual;
                DesktopBounds = rect;
            }
        }
        if (_settings.Get("winMax", false))
            WindowState = FormWindowState.Maximized;
    }

    private void SaveWindowBounds()
    {
        if (WindowState == FormWindowState.Normal)
        {
            _settings.Set("winMax", false);
            _settings.Set("winX", DesktopBounds.X);
            _settings.Set("winY", DesktopBounds.Y);
            _settings.Set("winW", DesktopBounds.Width);
            _settings.Set("winH", DesktopBounds.Height);
        }
        else if (WindowState == FormWindowState.Maximized)
        {
            _settings.Set("winMax", true);
        }
        _settings.Save();
    }

    // JS 确认已收到并处理文件 → 更新标题。这条回执同时证明桥接双向通畅（M3 验证点）。
    private void OnFileOpenedAck(JsonElement root)
    {
        string name = GetString(root, "fileName") ?? "未命名";
        _baseTitle = name + " — AloCsvEditor";
        UpdateTitle();
    }

    private void UpdateTitle() => Text = _dirty ? _baseTitle + " *" : _baseTitle;

    // ---------- 无边框窗体（#2/#3）：阴影 + 标题栏三键/拖动 + JS 边缘缩放 ----------

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

    private const int WM_NCLBUTTONDOWN = 0xA1;
    private const int HTCAPTION = 2;
    private const int WM_SYSCOMMAND = 0x0112;
    private const int SC_SIZE = 0xF000;

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ClassStyle |= 0x20000; // CS_DROPSHADOW：无边框阴影
            return cp;
        }
    }

    // 窗体缩放（#3）：Form 层 WM_NCHITTEST 是死代码——WebView2 子 HWND 吞掉全部 hit-test，
    // 父窗口永远收不到（WebView2Feedback #446/#704）。改由 JS 判定视口边缘，
    // 这里直接进 OS 原生 sizing 循环（Aero 贴靠免费；ht 10..17 → SC_SIZE+1..8）。
    // SendMessage 返回即循环结束（鼠标松开），随后落盘窗口大小。
    private void BeginWindowResize(JsonElement root)
    {
        if (WindowState != FormWindowState.Normal) return;
        int ht = GetInt(root, "ht", 0);
        if (ht < 10 || ht > 17) return;
        ReleaseCapture();
        SendMessage(Handle, WM_SYSCOMMAND, SC_SIZE + ht - 9, 0);
        SaveWindowBounds();
    }

    private void ToggleMax()
    {
        if (WindowState == FormWindowState.Maximized)
        {
            WindowState = FormWindowState.Normal;
        }
        else
        {
            MaximizedBounds = Screen.FromHandle(Handle).WorkingArea; // 不盖任务栏
            WindowState = FormWindowState.Maximized;
        }
        PostWinState();
    }

    private bool _wasMax;

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        bool max = WindowState == FormWindowState.Maximized;
        if (max != _wasMax)
        {
            _wasMax = max;
            PostWinState(); // 同步标题栏最大化图标（页面未就绪时 Post 自动丢弃，无害）
        }
    }

    private void PostWinState() =>
        _bridge.Post("winState", new { max = WindowState == FormWindowState.Maximized });

    private static string? GetString(JsonElement root, string name) =>
        root.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    private static bool GetBool(JsonElement root, string name, bool fallback) =>
        root.TryGetProperty(name, out JsonElement v)
        && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False)
            ? v.GetBoolean() : fallback;

    private static int GetInt(JsonElement root, string name, int fallback) =>
        root.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.Number
        && v.TryGetInt32(out int n) ? n : fallback;

    private void OnDragEnter(object? sender, DragEventArgs e)
    {
        if (e.Data?.GetDataPresent(DataFormats.FileDrop) == true)
            e.Effect = DragDropEffects.Copy;
    }

    private void OnDragDrop(object? sender, DragEventArgs e)
    {
        if (e.Data?.GetData(DataFormats.FileDrop) is string[] files && files.Length > 0)
            OpenFile(files[0]);
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        SaveWindowBounds(); // 最后位置一定落盘（#5）
        if (!_dirty || _closingAfterSave)
            return;
        e.Cancel = true;
        DialogResult r = MessageBox.Show(this, "文件尚未保存，是否保存后关闭？", "AloCsvEditor",
            MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
        if (r == DialogResult.Cancel)
            return;
        if (r == DialogResult.No)
        {
            _closingAfterSave = true;
            Close();
            return;
        }
        _bridge.Post("saveAndClose");
    }
}
