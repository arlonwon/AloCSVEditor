// 设置持久化（#5）：%AppData%\AloCsvEditor\settings.json。
// C# 拥有文件（窗口位置/大小自己读写）；JS 经 saveSettings 把自己的键合并进来；
// 启动时 C# 把"文件里实际存过的键"原样发 settings，缺省由 JS 默认值 + 旧 localStorage 迁移补齐。
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AloCsvEditor;

internal sealed class SettingsService
{
    public static string DefaultPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "AloCsvEditor", "settings.json");

    private readonly string _path;
    private JsonObject _store = new();

    public SettingsService(string? path = null)
    {
        _path = path ?? DefaultPath;
    }

    public void Load()
    {
        try
        {
            if (!File.Exists(_path)) return;
            if (JsonNode.Parse(File.ReadAllText(_path)) is JsonObject obj)
                _store = obj;
        }
        catch
        {
            _store = new(); // 文件损坏就丢弃用缺省，不弹框打断启动
        }
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            File.WriteAllText(_path,
                _store.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }
        catch
        {
            // 写失败不打断（只影响下次记忆）
        }
    }

    // 没显式存过返回 fallback。
    public T Get<T>(string key, T fallback)
    {
        try
        {
            if (_store.TryGetPropertyValue(key, out JsonNode? node) && node is not null)
            {
                T? v = node.Deserialize<T>();
                if (v is not null) return v;
            }
        }
        catch { }
        return fallback;
    }

    public void Set<T>(string key, T value)
    {
        _store[key] = JsonValue.Create(value);
    }

    // JS 发来的部分设置合并进来并落盘（窗口键不受影响，只增改 JS 的键）。
    public void Merge(JsonElement obj)
    {
        try
        {
            foreach (JsonProperty p in obj.EnumerateObject())
                _store[p.Name] = JsonNode.Parse(p.Value.GetRawText());
            Save();
        }
        catch { }
    }

    // 发给 JS 的是"实际存过的键"快照（缺省由 JS 补）。
    public JsonObject Snapshot() => (JsonObject)_store.DeepClone();
}
