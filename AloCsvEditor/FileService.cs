// 文件读写服务：编码识别/解码、分隔符与换行识别、按指定编码回写。
// 设计见 DESIGN.md §6.1–§6.2。所有"猜"都遵循：BOM → 严格 UTF-8 校验 → GB18030 兜底。
using System.Text;

namespace AloCsvEditor;

public static class FileService
{
    // 载入结果：解码后的文本 + 识别出的格式元数据（M3 起发给 JS 解析渲染）。
    public sealed record LoadedFile(
        string Path, string Text, string EncodingName, char Delimiter, string Newline, bool HasBom);

    // 保存选项：M3 起由 JS 序列化后连同文本一起发过来；C# 只管按编码写字节。
    public sealed record SaveOptions(string EncodingName, char Delimiter, string Newline, bool HasBom);

    // 状态栏手动切换列表。注：gbk/gb2312 是 gb18030 的子集，列出来只是为了让用户
    // “看到自己认识的名字”，内部统一按 gb18030 解码。
    public static readonly string[] SupportedEncodings =
    [
        "utf-8", "utf-8-sig", "gb18030", "gbk", "gb2312",
        "big5", "utf-16le", "utf-16be", "windows-1252",
    ];

    public static readonly char[] SupportedDelimiters = [',', ';', '\t', '|'];

    // 严格 UTF-8：坏字节直接抛异常，用于判定“到底是不是 UTF-8”。
    private static readonly Encoding Utf8Strict =
        Encoding.GetEncoding("utf-8", EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback);

    public readonly record struct DetectedEncoding(string Name, int PreambleLength);

    public static LoadedFile Load(string path, string? encodingName = null, char? delimiter = null)
    {
        return LoadFromBytes(File.ReadAllBytes(path), path, encodingName, delimiter);
    }

    // 字节流载入（页面拖拽用）：浏览器拿不到真实路径，path 记文件名；
    // 识别管线与 Load 完全同一套。
    public static LoadedFile LoadFromBytes(byte[] bytes, string path, string? encodingName = null, char? delimiter = null)
    {
        string enc = encodingName ?? DetectEncoding(bytes).Name;
        string text = Decode(bytes, enc, out bool hasBom);
        return new LoadedFile(
            path, text, enc, delimiter ?? DetectDelimiter(text), DetectNewline(text), hasBom);
    }

    public static void Save(string path, string text, SaveOptions options)
    {
        File.WriteAllBytes(path, GetEncoder(options.EncodingName, options.HasBom).GetBytes(text));
    }

    // 编码识别：BOM → 严格 UTF-8 校验 → GB18030 兜底；空文件默认 utf-8。
    public static DetectedEncoding DetectEncoding(byte[] bytes)
    {
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
            return new DetectedEncoding("utf-8-sig", 3);
        if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
            return new DetectedEncoding("utf-16le", 2);
        if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF)
            return new DetectedEncoding("utf-16be", 2);
        if (bytes.Length == 0)
            return new DetectedEncoding("utf-8", 0);
        try
        {
            Utf8Strict.GetString(bytes);
            return new DetectedEncoding("utf-8", 0);
        }
        catch (DecoderFallbackException)
        {
            // 不是合法 UTF-8：中文场景下落到 GB18030（覆盖 GBK/GB2312）。
            return new DetectedEncoding("gb18030", 0);
        }
    }

    // 按指定编码解码；hasBom 表示原文是否带 BOM（保存时原样保留用）。
    public static string Decode(byte[] bytes, string encodingName, out bool hasBom)
    {
        string name = NormalizeEncodingName(encodingName);
        int preamble = name switch
        {
            "utf-8-sig" => HasPreamble(bytes, [0xEF, 0xBB, 0xBF]) ? 3 : 0,
            "utf-16le" => HasPreamble(bytes, [0xFF, 0xFE]) ? 2 : 0,
            "utf-16be" => HasPreamble(bytes, [0xFE, 0xFF]) ? 2 : 0,
            _ => 0,
        };
        hasBom = preamble > 0;
        byte[] body = preamble == 0 ? bytes : bytes[preamble..];
        return GetDecoder(name).GetString(body);
    }

    // 分隔符识别：采样前 5 个非空行，要求各行"引号外出现次数"一致且 > 0；
    // 并列时按候选顺序 , ; Tab | ；单列文件回落逗号。
    public static char DetectDelimiter(string text)
    {
        string[] lines = text.Split('\n')
            .Select(l => l.TrimEnd('\r'))
            .Where(l => l.Length > 0)
            .Take(5)
            .ToArray();
        if (lines.Length == 0)
            return ',';
        foreach (char d in SupportedDelimiters)
        {
            int[] counts = lines.Select(l => CountOutsideQuotes(l, d)).ToArray();
            if (counts[0] > 0 && counts.All(c => c == counts[0]))
                return d;
        }
        return ',';
    }

    // 换行识别：取第一个换行符的样式；空/单行文件默认 CRLF。
    public static string DetectNewline(string text)
    {
        int lf = text.IndexOf('\n');
        if (lf >= 0)
            return (lf > 0 && text[lf - 1] == '\r') ? "\r\n" : "\n";
        return text.IndexOf('\r') >= 0 ? "\r" : "\r\n";
    }

    // 引号外计数："" 转义整体跳过，保证引号内的分隔符不干扰打分。
    private static int CountOutsideQuotes(string line, char delimiter)
    {
        int count = 0;
        bool inQuotes = false;
        for (int i = 0; i < line.Length; i++)
        {
            char ch = line[i];
            if (ch == '"')
            {
                if (inQuotes && i + 1 < line.Length && line[i + 1] == '"')
                {
                    i++;
                    continue;
                }
                inQuotes = !inQuotes;
            }
            else if (ch == delimiter && !inQuotes)
            {
                count++;
            }
        }
        return count;
    }

    private static string NormalizeEncodingName(string name)
    {
        string n = name.Trim().ToLowerInvariant();
        // 子集归一：内部统一按 gb18030 处理。
        if (n is "gbk" or "gb2312")
            return "gb18030";
        if (!SupportedEncodings.Contains(n) && n != "gb18030")
            throw new ArgumentException("不支持的编码：" + name);
        return n;
    }

    private static bool HasPreamble(byte[] bytes, byte[] preamble)
    {
        if (bytes.Length < preamble.Length)
            return false;
        for (int i = 0; i < preamble.Length; i++)
        {
            if (bytes[i] != preamble[i])
                return false;
        }
        return true;
    }

    private static Encoding GetDecoder(string normalizedName) => normalizedName switch
    {
        // 强制指定用严格模式：用户手动选错编码时直接报错，而不是静默乱码。
        "utf-8" or "utf-8-sig" => Utf8Strict,
        "utf-16le" => new UnicodeEncoding(false, true),
        "utf-16be" => new UnicodeEncoding(true, true),
        // 以下需 Program.Main 已注册 CodePagesEncodingProvider。
        "gb18030" => Encoding.GetEncoding("GB18030"),
        "big5" => Encoding.GetEncoding("big5"),
        "windows-1252" => Encoding.GetEncoding(1252),
        _ => throw new ArgumentException("不支持的编码：" + normalizedName),
    };

    private static Encoding GetEncoder(string encodingName, bool hasBom)
    {
        string name = NormalizeEncodingName(encodingName);
        return name switch
        {
            // "utf-8-sig" 恒带 BOM；"utf-8" 按原文有无 BOM 回写。
            "utf-8" => new UTF8Encoding(hasBom, true),
            "utf-8-sig" => new UTF8Encoding(true, true),
            "utf-16le" => new UnicodeEncoding(false, hasBom, true),
            "utf-16be" => new UnicodeEncoding(true, hasBom, true),
            // 单字节/多字节中文编码无 BOM 概念。
            _ => GetDecoder(name),
        };
    }
}
