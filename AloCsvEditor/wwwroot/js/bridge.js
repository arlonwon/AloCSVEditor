// C#↔JS 消息桥客户端（协议见 DESIGN.md §6.3）。
// WebView2 会注入 window.chrome.webview；纯浏览器直接打开调试时降级为空桥（页面照常渲染）。
export function createBridge() {
  const handlers = new Map();
  const native = window.chrome?.webview;
  if (native) {
    native.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg || typeof msg.type !== 'string') return;
      const h = handlers.get(msg.type);
      if (h) h(msg); // 未知 type 忽略（向前兼容）
    });
  }
  return {
    on(type, fn) {
      handlers.set(type, fn);
    },
    post(type, payload = {}) {
      if (native) native.postMessage({ type, ...payload });
    },
    get available() {
      return !!native;
    },
  };
}
