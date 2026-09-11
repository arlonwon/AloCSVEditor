// 自检模式：AloCsvEditor.exe --selftest 跑编码与格式识别自检（DESIGN.md F-20 / §8.2）。
// 约定：全部通过返回 0，有失败返回 1。临时文件只放系统临时目录，不入库。
using System.Text;

namespace AloCsvEditor;

public static class SelfTest
{
    public static int Run()
    {
        int failed = 0;

        void Check(string name, Func<bool> test)
        {
            bool ok;
            try
            {
                ok = test();
            }
            catch (Exception ex)
            {
                ok = false;
                Console.WriteLine("  异常：" + ex.GetType().Name + "：" + ex.Message);
            }
            Console.WriteLine((ok ? "PASS " : "FAIL ") + name);
            if (!ok)
                failed++;
        }

        // T1 空文件 → 默认 utf-8。
        Check("T1 空文件默认utf-8", () =>
            FileService.DetectEncoding([]) is { Name: "utf-8", PreambleLength: 0 });

        // T2 UTF-8 中文（无 BOM）→ utf-8 且解码正确。
        Check("T2 UTF-8中文识别", () =>
        {
            byte[] b = Encoding.UTF8.GetBytes("姓名,年龄\r\n张三,20\r\n");
            FileService.DetectedEncoding d = FileService.DetectEncoding(b);
            return d.Name == "utf-8"
                && FileService.Decode(b, d.Name, out _) == "姓名,年龄\r\n张三,20\r\n";
        });

        // T3 GBK 字节 "中文,测试\r\n" → gb18030（中=D6D0 文=CEC4 测=B2E2 试=CAD4）。
        Check("T3 GBK识别为gb18030", () =>
        {
            byte[] b = [0xD6, 0xD0, 0xCE, 0xC4, 0x2C, 0xB2, 0xE2, 0xCA, 0xD4, 0x0D, 0x0A];
            FileService.DetectedEncoding d = FileService.DetectEncoding(b);
            return d.Name == "gb18030"
                && FileService.Decode(b, d.Name, out _) == "中文,测试\r\n";
        });

        // T4 UTF-16LE BOM："a,\r\n"。
        Check("T4 UTF-16LE BOM识别", () =>
        {
            byte[] b = [0xFF, 0xFE, 0x61, 0x00, 0x2C, 0x00, 0x0D, 0x00, 0x0A, 0x00];
            FileService.DetectedEncoding d = FileService.DetectEncoding(b);
            return d is { Name: "utf-16le", PreambleLength: 2 }
                && FileService.Decode(b, d.Name, out bool bom) == "a,\r\n"
                && bom;
        });

        // T5 gb18030 写→读 roundtrip，字节级一致。
        Check("T5 GB18030写读一致", () =>
        {
            string tmp = Path.Combine(Path.GetTempPath(), "alocsv_selftest_gbk.csv");
            try
            {
                const string text = "中文,测试\r\n第二行,1,2\r\n";
                FileService.Save(tmp, text, new FileService.SaveOptions("gb18030", ',', "\r\n", false));
                FileService.LoadedFile f = FileService.Load(tmp);
                return f.Text == text && f.EncodingName == "gb18030";
            }
            finally
            {
                File.Delete(tmp);
            }
        });

        // T6 分号分隔识别。
        Check("T6 分号分隔符识别", () =>
            FileService.DetectDelimiter("a;b;c\r\n1;2;3\r\n") == ';');

        // T7 LF 换行识别。
        Check("T7 LF换行识别", () =>
            FileService.DetectNewline("a,b\n1,2\n") == "\n");

        // T8 手动指定 "gbk" 可解码（归一到 gb18030）。字节："中文,测试"
        // （中=D6D0 文=CEC4 ，=2C 测=B2E2 试=CAD4）。
        Check("T8 手动指定gbk解码", () =>
        {
            byte[] b = [0xD6, 0xD0, 0xCE, 0xC4, 0x2C, 0xB2, 0xE2, 0xCA, 0xD4];
            return FileService.Decode(b, "gbk", out _) == "中文,测试";
        });

        Console.WriteLine(failed == 0 ? "ALL PASS" : failed + " FAILED");
        return failed == 0 ? 0 : 1;
    }
}
