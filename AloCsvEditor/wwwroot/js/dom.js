// DOM 判定小工具（全局按键 / 剪贴板守卫共用）。
//
// 背景：网格为了让输入法有目标，常驻一个隐形可编辑元素 key-sink（见 grid.js buildDom）。
// 它虽然"长得像输入框"（textarea），但语义上属于网格本身——复制/粘贴/快捷键仍必须归网格处理。
// 这类判定此前在 clipboard / main / find 里各写了一份，结果漏改一处就把 Ctrl+F 打回了
// WebView2 的默认查找（系统搜索框）。集中到这里，新增全局按键处理时只需调用这两个函数。

// 是不是网格的按键接收器（key-sink）——不算"用户的输入控件"。
export function isKeySink(el) {
  return el instanceof HTMLElement && el.dataset?.keysink === '1';
}

// 是不是真正的用户可编辑控件（输入框 / 文本域 / 可编辑区）——
// 落在这些地方时，全局按键与剪贴板一律交还浏览器原生行为。
export function isEditableTarget(el) {
  return el instanceof HTMLElement
    && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

// 事件该不该交还浏览器原生行为：落在用户输入控件里、且不是网格的 key-sink。
// 事件目标优先，当前焦点元素兜底（焦点与目标不一致时也不漏判）。
export function isNativeInputContext(target, active = document.activeElement) {
  if (isKeySink(target) || isKeySink(active)) return false;
  return isEditableTarget(target) || isEditableTarget(active);
}
