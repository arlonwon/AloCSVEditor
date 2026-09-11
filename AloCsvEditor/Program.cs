// 程序入口：--selftest 走自检（F-20，不起窗口）；否则启动 WinForms。
// 命令行文件参数透传给主窗口（双击/"打开方式"关联用）。
using System.Runtime.InteropServices;
using System.Text;
using AloCsvEditor;

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
        Application.Run(new MainForm(args));
        return 0;
    }
}
