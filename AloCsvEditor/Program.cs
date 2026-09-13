// 程序入口：--selftest 走自检（F-20，不起窗口）；否则启动 WinForms。
// 命令行文件参数透传给主窗口（双击/"打开方式"关联用）。
using System.Runtime.InteropServices;
using System.Text;
using AloCsvEditor;
using Microsoft.Web.WebView2.Core;

namespace AloCsvEditor;

internal static partial class Program
{
    private const int AttachParentProcess = -1;

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AttachConsole(int dwProcessId);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool FreeConsole();

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AllocConsole();

    [STAThread]
    private static int Main(string[] args)
    {
        // GB18030/Big5 等编码需先注册 CodePages 提供程序，否则 GetEncoding 抛异常。
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

        if (args.Contains("--selftest", StringComparer.OrdinalIgnoreCase))
        {
            // WinExe 默认不挂控制台：先挂父进程的，挂不上（如无控制台的启动器）则自己弹一个。
            if (!AttachConsole(AttachParentProcess))
                AllocConsole();
            try
            {
                return SelfTest.Run();
            }
            finally
            {
                FreeConsole();
            }
        }

        ApplicationConfiguration.Initialize();
        // 发布版在别的电脑上跑：WebView2 Runtime 缺失直接给人话提示（不留晦涩报错）。
        // Evergreen 绝大多数 Win10/Win11 自带；缺的装最新版 Edge（自带）或搜「WebView2 Runtime」装即可。
        string? wvVersion = null;
        try { wvVersion = CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch { }
        if (string.IsNullOrEmpty(wvVersion))
        {
            System.Windows.Forms.MessageBox.Show(
                "未检测到 WebView2 Runtime，AloCsvEditor 跑不起来。\n\n装最新版 Edge 浏览器（自带），或搜「WebView2 Runtime」装 Evergreen 版，然后重开本软件。",
                "AloCsvEditor",
                System.Windows.Forms.MessageBoxButtons.OK,
                System.Windows.Forms.MessageBoxIcon.Warning);
            return 3;
        }
        Application.Run(new MainForm(args));
        return 0;
    }
}
