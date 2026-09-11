// C#↔JS 消息桥：JSON 收发 + 按 type 分发（协议见 DESIGN.md §6.3）。
// M2 建好基础设施与发送端；MainForm 在 M3 挂接具体的文件操作处理函数。
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AloCsvEditor;

public sealed class Bridge
{
    private readonly WebView2 _webView;
    private readonly Dictionary<string, Action<JsonElement>> _handlers = new(StringComparer.Ordinal);

    public Bridge(WebView2 webView)
    {
        _webView = webView;
        _webView.WebMessageReceived += OnWebMessageReceived;
    }

    // 注册某类消息的处理函数。
    public void On(string type, Action<JsonElement> handler) => _handlers[type] = handler;

    // 发消息给 JS。注：超大文本（如几十 MB 文件内容）走单条消息，v1 范围内可接受；
    // M10 性能实测若发现瓶颈再改分片传输。页面未就绪时直接丢弃（调用方保证时序）。
    public void Post(string type, object? payload = null)
    {
        CoreWebView2? core = _webView.CoreWebView2;
        if (core is null)
            return;
        string json = payload is null
            ? JsonSerializer.Serialize(new { type })
            : MergeType(type, payload);
        core.PostWebMessageAsJson(json);
    }

    // 中文不转义（默认会把中文转成 \uXXXX，中文 CSV 体积膨胀数倍）。
    // 安全：消息只走 postMessage，不进 innerHTML，不存在注入问题。
    private static readonly JsonSerializerOptions RelaxedJson =
        new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private static string MergeType(string type, object payload)
    {
        JsonObject obj = JsonSerializer.SerializeToNode(payload) as JsonObject ?? new JsonObject();
        obj["type"] = type;
        return obj.ToJsonString(RelaxedJson);
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // 注意：JS 侧 post 的是对象（native.postMessage({type, …})），必须用
        // WebMessageAsJson 属性取 JSON；TryGetWebMessageAsString 只对字符串消息有效，
        // 对对象消息返回 null（曾因此静默丢掉所有消息，M3 定位修复）。
        string json = e.WebMessageAsJson;
        if (string.IsNullOrEmpty(json))
            return;
        try
        {
            using JsonDocument doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("type", out JsonElement t))
                return;
            string? type = t.GetString();
            // 未知 type 直接忽略（向前兼容：新版 JS 配旧版壳不炸）。
            if (type is not null && _handlers.TryGetValue(type, out Action<JsonElement>? handler))
                handler(doc.RootElement);
        }
        catch (JsonException)
        {
            // 坏消息忽略。
        }
    }
}
