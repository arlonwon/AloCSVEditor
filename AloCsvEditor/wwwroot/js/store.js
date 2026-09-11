// 全局状态 + 脏标记上报。
// setDirty 由 M5 起的编辑模块调用；M3 的保存流程调用它清标记。
// bridge 引用由 main.js 经 initStore 注入，避免模块循环依赖。

export const state = {
  // 当前文件：{path,fileName,text,encoding,delimiter,newline,hasBom,endsWithNewline} | null
  file: null,
  dirty: false,
  // 解析统计：{rows,cols,warnings} | null（M5 起 fileOpened 时设置）
  stats: null,
};

let bridgeRef = null;

export function initStore(bridge) {
  bridgeRef = bridge;
}

export function setDirty(v) {
  state.dirty = !!v;
  bridgeRef?.post('setDirty', { dirty: state.dirty });
}
