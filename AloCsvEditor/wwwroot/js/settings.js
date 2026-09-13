// 持久化设置（#5）：唯一真相源在 C# settings.json；这里是 JS 侧镜像 + 防抖回写。
// 服务端发来的 settings 只含"存过的键"，其余走 defaults；旧 localStorage 键由 main.js 迁移进来。
export const settingDefaults = {
  theme: 'dark',
  zoom: 1,
  sysFs: 13,
  crosshair: true,
  zebra: true,
  defaultDelimiter: ',',
  headerMode: true,
  commentPrefixes: ['#', '//'], // 通栏注释行首标记（## 被 # 覆盖）；空格分隔手填
};

export const settings = { ...settingDefaults };

let bridgeRef = null;

export function initSettings(bridge) {
  bridgeRef = bridge;
}

// 合并优先级：defaults ← stored（服务端快照） ← legacy（旧 localStorage，无则 {}）。
export function loadSettings(stored = {}, legacy = {}) {
  Object.assign(settings, settingDefaults, stored, legacy);
  normalize();
}

function normalize() {
  if (settings.theme !== 'light' && settings.theme !== 'dark') settings.theme = 'dark';
  settings.zoom = Math.min(2, Math.max(0.7, +settings.zoom || 1));
  settings.sysFs = Math.min(20, Math.max(11, Math.round(+settings.sysFs || 13)));
  settings.crosshair = !!settings.crosshair;
  settings.zebra = !!settings.zebra;
  if (typeof settings.defaultDelimiter !== 'string' || settings.defaultDelimiter === '') {
    settings.defaultDelimiter = ',';
  }
  settings.headerMode = settings.headerMode !== false;
  // 注释标记归一化：数组留非空串；字符串按空白切（手填兼容）；其他回默认。
  if (typeof settings.commentPrefixes === 'string') {
    settings.commentPrefixes = settings.commentPrefixes.split(/\s+/).filter(Boolean);
  }
  if (!Array.isArray(settings.commentPrefixes)) {
    settings.commentPrefixes = [...settingDefaults.commentPrefixes];
  } else {
    settings.commentPrefixes = settings.commentPrefixes.filter((p) => typeof p === 'string' && p !== '');
    if (settings.commentPrefixes.length === 0) settings.commentPrefixes = [...settingDefaults.commentPrefixes];
  }
}

export function setSetting(key, value) {
  settings[key] = value;
  normalize();
  saveSoon();
}

// 全量回写：C# 侧做合并，窗口键不受影响。
export function saveSoon() {
  bridgeRef?.post('saveSettings', { settings: { ...settings } });
}
