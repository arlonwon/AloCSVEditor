// 应用入口（M3）：桥接 + 工具栏/状态栏/主题。
// M4 起接入 csv.js 解析，M5 起接入 grid.js 网格。
import { createBridge } from './bridge.js';
import { state, initStore, setDirty } from './store.js';
import { parse, serialize, isCommentRow } from './csv.js';
import { Grid, colName } from './grid.js';
import { initFind } from './find.js';
import { Editor } from './editor.js';
import { initClipboard, selectionCopyText, pasteText } from './clipboard.js';
import { UndoStack, sortWithComments } from './commands.js';
import { initFill } from './fill.js';
import { computeHidden } from './filter.js';
import { showMenu, initMenu } from './menu.js';
import { DEFAULT_COL_W } from './grid.js';
import { settings, initSettings, loadSettings, setSetting, saveSoon } from './settings.js';

const $ = (id) => document.getElementById(id);
const bridge = createBridge();
initStore(bridge);
initSettings(bridge);

// 服务端下发的候选（编码/分隔符）：打开文件时用 fileOpened 的，新建文档时用这份。
let serverEncodings = [];
let serverDelimiters = [];

// 网格（M5）：挂在 #grid-host 下，替换提示语。
const gridHost = $('grid-host');
gridHost.innerHTML = '';
const grid = new Grid(gridHost);

// 里程碑验证用诊断钩子：headless 检查渲染管线（行数/渲染行数/选区/多选区/显示开关），生产无影响。
window.__alocsvDiag = () => JSON.stringify({
  rows: state.stats?.rows ?? -1,
  cols: state.stats?.cols ?? -1,
  rendered: document.querySelectorAll('.grid-row').length,
  cells: document.querySelectorAll('.gc').length,
  sel: grid.sel ? [grid.sel.ar, grid.sel.ac, grid.sel.fr, grid.sel.fc] : null,
  extras: grid.extra.length,
  headerRow: grid.headerRow,
  cross: !!grid.crosshair,
  zebra: !!grid.zebra,
  zoom: grid.zoom ?? 1,
});

// 编辑器 + 剪贴板（M6）；撤销栈（M7）。
const undoStack = new UndoStack(200);
const editor = new Editor(grid, {
  // cells 数组：数据行 1 格；注释行编辑整行文本，重解析后可能多格。
  onCommit: (cells) => commitChange({ cells }),
  // 注释行换行消毒：整行文本单行不变量，Alt+Enter 进来的换行替换为空格并提示。
  onSanitizeComment: (value) => {
    toast('注释行不支持换行，已替换为空格');
    return value.replace(/\r?\n/g, ' ');
  },
  // 注释行整行文本按分隔符重解析（取消注释即恢复多列）。
  parseLine: (text) => parse(text, state.file?.delimiter ?? ',').rows[0] ?? [],
});
grid.hooks.onEditRequest = (r, c, initial) => {
  if (r < 0 || r >= grid.rows.length || c < 0 || c >= grid.nCols) return;
  editor.begin(r, c, initial);
};
grid.hooks.onModify = (change) => commitChange(change || null);
grid.hooks.onUndo = () => undoOnce();
grid.hooks.onRedo = () => redoOnce();
grid.hooks.onInsertRow = (below = true) => doInsertRows(below);
grid.hooks.onInsertCol = (right = true) => doInsertCols(right);
// Delete 语义（#4）：整行选中删行，整列选中删列（筛选拦截/撤销走现有函数）；
// 全选或普通区域只清内容（不清结构，防误触清表）。
grid.hooks.onDeleteKey = () => {
  const range = grid.normSel();
  if (!range) return;
  const allRows = range.r1 === 0 && range.r2 === grid.rows.length - 1;
  const allCols = range.c1 === 0 && range.c2 === grid.nCols - 1;
  if (!allRows && range.c1 === 0 && range.c2 === grid.nCols - 1) doDeleteRows();
  else if (!allCols && range.r1 === 0 && range.r2 === grid.rows.length - 1) doDeleteCols();
  else grid.clearSelection();
};

// 任一数据修改后：入撤销栈 + 标脏 + 刷新统计。change 为 null 表示无实质修改（只刷新）。
function commitChange(change) {
  if (change) {
    // 超大单步修改仍执行，但提示撤销可能较慢（DESIGN.md §11）。
    if (change.cells && change.cells.length > 200000) {
      toast('单次修改超 20 万格，已执行；撤销可能较慢', 4000);
    }
    undoStack.push(change);
  }
  findApi?.clearMarks(false); // 数据变了高亮失效（查询文本保留，回车重查）；调用方随后统一 render
  refreshDirty();
  refreshStats();
}

// 脏标记由撤销栈版本派生：指针回到保存点即干净（分支安全，见 commands.js）。
function refreshDirty() {
  setDirty(undoStack.isDirty());
}

function refreshStats() {
  state.stats = {
    rows: grid.rows.length,
    cols: grid.nCols,
    warnings: state.stats?.warnings ?? 0,
  };
  syncScopeOptions();
  // 筛选重算放这里：所有数据变化路径（提交/撤销/重做/打开）都经过它，不会漏。
  // 隐藏集合变化时 setHiddenRows 内部会 render。
  if (state.file) {
    const text = filterText.value.trim();
    let col = parseInt(filterScope.value ?? '-1', 10);
    if (Number.isNaN(col) || col < -1 || col >= grid.nCols) col = -1;
    // 跳过表头之前（含表头）；注释行永不隐藏（标注性内容，筛选中保持可见）。
    const skip = grid.headerMode ? grid.headerRow + 1 : 0;
    const hidden = text ? computeHidden(grid.rows, text, col, skip) : new Set();
    if (hidden.size > 0) {
      for (let r = 0; r < grid.rows.length; r++) {
        if (isCommentRow(grid.rows[r], grid.commentPrefixes)) hidden.delete(r);
      }
    }
    const changed = hidden.size !== grid.hidden.size
      || [...hidden].some((r) => !grid.hidden.has(r));
    if (changed) grid.setHiddenRows(hidden);
  }
  updateClearBtn();
  renderAll();
}

function updateClearBtn() {
  const el = $('st-clear-filter');
  if (el) el.style.display = grid.hidden.size > 0 ? '' : 'none';
}

function applyCells(cells, which) {
  for (const d of cells) {
    const row = grid.rows[d.r];
    if (!row) continue;
    while (row.length <= d.c) row.push(''); // 注释行整行改写可能加长：先补齐再写（撤销同理）
    row[d.c] = which === 'undo' ? d.before : d.after;
  }
}

function undoOnce() {
  const entry = undoStack.undo();
  if (!entry) {
    toast('没有可撤销的操作');
    return;
  }
  const ch = entry.change;
  if (ch.struct) {
    applyStruct(ch.struct, false);
  } else {
    // 先恢复格值（此时扩展的行列尚在），再截掉粘贴时扩展的部分。
    if (ch.cells) applyCells(ch.cells, 'undo');
    if (ch.grewRows) grid.rows.length -= ch.grewRows;
    if (ch.grewCols) {
      for (const r of grid.rows) r.length -= ch.grewCols;
      grid.nCols -= ch.grewCols;
      grid.colW.length -= ch.grewCols;
    }
    if (ch.grewRows || ch.grewCols) grid.layout();
  }
  grid.render();
  fixSel();
  refreshDirty();
  refreshStats();
}

function redoOnce() {
  const entry = undoStack.redo();
  if (!entry) {
    toast('没有可重做的操作');
    return;
  }
  const ch = entry.change;
  if (ch.struct) {
    applyStruct(ch.struct, true);
  } else {
    if (ch.grewRows || ch.grewCols) {
      grid.ensureSize(grid.rows.length + (ch.grewRows || 0), grid.nCols + (ch.grewCols || 0));
    }
    if (ch.cells) applyCells(ch.cells, 'redo');
  }
  grid.render();
  fixSel();
  refreshDirty();
  refreshStats();
}

initClipboard({ grid, editor, toast, onModify: (change) => commitChange(change || null) });
initFill({ grid, editor, toast, onModify: (change) => commitChange(change || null) });
initMenu(grid.scroller);
const findApi = initFind({ grid, toast, onModify: (change) => commitChange(change || null) });

// 首个内容行（跳过注释行）：打开文件的默认表头；全注释文件返回 length（=无表头）。
function firstContentRow() {
  for (let r = 0; r < grid.rows.length; r++) {
    if (!isCommentRow(grid.rows[r], grid.commentPrefixes)) return r;
  }
  return grid.rows.length;
}

// 右键行号“设为表头行”：会话内有效（打开新文件重置为首个内容行）。
function setHeaderRowFromMenu() {
  if (!grid.sel) return;
  grid.setHeaderRow(grid.sel.fr);
  refreshStats();
  toast(`表头行：第 ${grid.sel.fr + 1} 行`);
}

// ---------- 表头模式（M9b）：加粗 + 冻结 + 排序排除，默认开，进 settings.json ----------
function applyHeaderMode(on, silent) {
  grid.setHeaderMode(on);
  const btn = $('btn-header');
  if (btn) btn.classList.toggle('on', grid.headerMode);
  if (!silent) setSetting('headerMode', grid.headerMode);
  renderAll();
}

function loadHeaderMode() {
  // 模块加载时 settings 还没到（缺省 true）；settings 消息到达后会重应用一次。
  return settings.headerMode;
}
$('btn-header').addEventListener('click', () => {
  applyHeaderMode(!grid.headerMode);
  toast(grid.headerMode ? '表头行：开（冻结，不参与排序）' : '表头行：关');
});
applyHeaderMode(loadHeaderMode(), true);

// ---------- 显示开关（#6/#10）：工具栏 + 设置面板双入口，同写 settings ----------
function syncDisplayToggles() {
  $('btn-cross')?.classList.toggle('on', grid.crosshair);
  $('btn-zebra')?.classList.toggle('on', grid.zebra);
}

$('btn-cross').addEventListener('click', () => {
  grid.setCrosshair(!grid.crosshair);
  setSetting('crosshair', grid.crosshair);
  syncDisplayToggles();
});

$('btn-zebra').addEventListener('click', () => {
  grid.setZebra(!grid.zebra);
  setSetting('zebra', grid.zebra);
  syncDisplayToggles();
});

// ---------- 筛选（M9b-2）：关键字过滤行，表头行永不隐藏 ----------

const filterText = $('filter-text');
const filterScope = $('filter-scope');
let filterTimer = 0;
// 作用列下拉：全部列 + A/B/C…（打开文件后按列数重建）。
function rebuildScopeOptions() {

  filterScope.innerHTML = '';
  const all = document.createElement('option');
  all.value = '-1';
  all.textContent = '全部列';
  filterScope.append(all);
  for (let c = 0; c < grid.nCols; c++) {
    const opt = document.createElement('option');
    opt.value = String(c);
    opt.textContent = `${colName(c)}列`;
    filterScope.append(opt);
  }
  filterScope.value = '-1';
}

// 列数变了（增删列/撤销/粘贴扩展）重建作用列下拉；合法的老选择保留，越界回全部列。
// 打开/新建走 resetFilterUI 全重置；这里只处理"数量对不上"的增量场景。
function syncScopeOptions() {
  if (filterScope.options.length === grid.nCols + 1) return;
  const cur = filterScope.value;
  rebuildScopeOptions();
  if ([...filterScope.options].some((o) => o.value === cur)) filterScope.value = cur;
}

function resetFilterUI() {
  filterText.value = '';
  rebuildScopeOptions();
}

function clearFilter() {
  filterText.value = '';
  filterScope.value = '-1';
  clearTimeout(filterTimer);
  refreshStats();
  grid.scroller.focus({ preventScroll: true });
}

filterText.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => refreshStats(), 150);
});
filterText.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') clearFilter();
  else if (e.key === 'Enter') {
    clearTimeout(filterTimer);
    refreshStats();
  }
});
filterScope.addEventListener('change', () => refreshStats());
$('st-clear-filter').addEventListener('click', clearFilter);

// ---------- 行列操作 + 排序（M9） ----------

// 结构性修改后钳制选区（删超界时回到 A1）。
function fixSel() {
  if (!grid.normSel()) {
    grid.sel = grid.rows.length > 0 && grid.nCols > 0 ? { ar: 0, ac: 0, fr: 0, fc: 0 } : null;
  }
}

function doInsertRows(below) {
  if (grid.hidden.size > 0) {
    toast('筛选状态下不可插入行，请先清除筛选');
    return;
  }
  if (grid.rows.length === 0 || grid.nCols === 0) {
    toast('没有可操作的数据');
    return;
  }
  const at = grid.sel
    ? Math.max(0, Math.min(grid.rows.length, grid.sel.fr + (below ? 1 : 0)))
    : grid.rows.length;
  grid.insertRows(at, 1);
  const c = grid.sel ? Math.max(0, Math.min(grid.nCols - 1, grid.sel.fc)) : 0;
  grid.sel = { ar: at, ac: c, fr: at, fc: c };
  grid.ensureVisible(at, c);
  grid.render();
  commitChange({ struct: { op: 'insertRows', index: at, count: 1 } });
}

function doDeleteRows() {
  if (grid.hidden.size > 0) {
    toast('筛选状态下不可删除行，请先清除筛选');
    return;
  }
  const range = grid.normSel();
  if (!range) return;
  const snap = grid.deleteRows(range.r1, range.r2);
  commitChange({ struct: { op: 'deleteRows', ...snap } });
  fixSel();
  grid.render();
}

function doInsertCols(right) {
  if (grid.hidden.size > 0) {
    toast('筛选状态下不可插入列，请先清除筛选');
    return;
  }
  if (grid.rows.length === 0) {
    toast('没有可操作的数据');
    return;
  }
  const at = grid.sel
    ? Math.max(0, Math.min(grid.nCols, grid.sel.fc + (right ? 1 : 0)))
    : grid.nCols;
  const r = grid.sel ? Math.max(0, Math.min(grid.rows.length - 1, grid.sel.fr)) : 0;
  grid.insertCols(at, 1);
  grid.sel = { ar: r, ac: at, fr: r, fc: at };
  grid.ensureVisible(r, at);
  grid.render();
  commitChange({ struct: { op: 'insertCols', index: at, count: 1 } });
}

function doDeleteCols() {
  if (grid.hidden.size > 0) {
    toast('筛选状态下不可删除列，请先清除筛选');
    return;
  }
  const range = grid.normSel();
  if (!range) return;
  const snap = grid.deleteCols(range.c1, range.c2);
  commitChange({ struct: { op: 'deleteCols', ...snap } });
  fixSel();
  grid.render();
}

function sortBy(col, dir) {
  if (grid.hidden.size > 0) {
    toast('筛选状态下不可排序，请先清除筛选');
    return;
  }
  // 表头模式：表头行之前不动；注释行钉原位，只排数据行（sortWithComments）。
  const start = grid.headerMode ? grid.headerRow + 1 : 0;
  if (grid.rows.length <= start) {
    toast('没有可排序的数据行');
    return;
  }
  const prevOrder = [...grid.rows];
  const prevMark = grid.sortMark;
  grid.rows = sortWithComments(grid.rows, start, col, dir,
    (row) => isCommentRow(row, grid.commentPrefixes));
  grid.sortMark = { col, dir };
  grid.render();
  commitChange({ struct: { op: 'sort', col, dir, start, prevOrder, prevMark } });
}

function clearSort() {
  if (grid.hidden.size > 0) {
    toast('筛选状态下不可操作排序，请先清除筛选');
    return;
  }
  if (grid.rows.length === 0) return;
  const prevOrder = [...grid.rows];
  const prevMark = grid.sortMark;
  grid.restoreOriginalOrder();
  grid.sortMark = null;
  grid.render();
  commitChange({ struct: { op: 'sort', col: -1, dir: 'orig', prevOrder, prevMark } });
}

// 结构性修改应用：redo=false 撤销，true 重做。快照数组视为不可变（恢复时切片，不别名）。
function applyStruct(s, redo) {
  const g = grid;
  switch (s.op) {
    case 'insertRows':
      if (redo) g.insertRows(s.index, s.count);
      else g.rows.splice(s.index, s.count);
      break;
    case 'deleteRows':
      if (redo) g.rows.splice(s.index, s.rows.length);
      else g.rows.splice(s.index, 0, ...s.rows);
      break;
    case 'insertCols':
      if (redo) {
        g.insertCols(s.index, s.count);
      } else {
        for (const r of g.rows) r.splice(s.index, s.count);
        g.nCols -= s.count;
        g.colW.splice(s.index, s.count);
      }
      break;
    case 'deleteCols':
      if (redo) {
        for (const r of g.rows) r.splice(s.index, s.count);
        g.nCols -= s.count;
        g.colW.splice(s.index, s.count);
      } else {
        for (const e of s.perRow) e.row.splice(s.index, 0, ...e.values);
        g.nCols += s.count;
        g.colW.splice(s.index, 0, ...new Array(s.count).fill(DEFAULT_COL_W));
      }
      break;
    case 'sort':
      if (redo) {
        if (s.col < 0) g.restoreOriginalOrder();
        else g.rows = sortWithComments(g.rows, s.start ?? 0, s.col, s.dir,
          (row) => isCommentRow(row, grid.commentPrefixes));
      } else {
        g.rows = s.prevOrder.slice();
      }
      g.sortMark = redo ? (s.col < 0 ? null : { col: s.col, dir: s.dir }) : (s.prevMark ?? null);
      break;
  }
  // 结构性修改后统一重建索引 + 画布（行列数可能变了；排序场景下无害）。
  grid.layout();
}

// ---------- 右键菜单接线（M9，F-18） ----------

grid.scroller.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (editor.isEditing() || grid.rows.length === 0) return;
  const t = e.target;
  let kind = 'cell';
  if (t.closest('.grid-head')) {
    kind = t.closest('.gchead') ? 'col' : 'corner';
  } else if (t.closest('.grc')) {
    kind = 'row';
  }
  // 右键先选中（Excel 行为）：点在任一选区内则保持多选，否则单选该格/行/列。
  const all = grid.allRanges();
  const inSel = (r, c) => all.some((x) => r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2);
  if (kind === 'cell') {
    const cell = t.closest('.gc');
    if (cell) {
      const r = +cell.dataset.r;
      const c = +cell.dataset.c;
      if (!inSel(r, c)) grid.sel = { ar: r, ac: c, fr: r, fc: c };
    }
  } else if (kind === 'row') {
    const r = +t.closest('.grc').dataset.r;
    grid.sel = { ar: r, ac: 0, fr: r, fc: grid.nCols - 1 };
  } else if (kind === 'col') {
    const c = +t.closest('.gchead').dataset.c;
    grid.sel = { ar: 0, ac: c, fr: grid.rows.length - 1, fc: c };
  } else {
    grid.selectAll();
  }
  grid.render();
  grid.scroller.focus({ preventScroll: true });
  showMenu(e.clientX, e.clientY, buildMenu(kind));
});

function buildMenu(kind) {
  const editItems = [
    { label: '复制', action: () => copySelToClipboard(false) },
    { label: '剪切', action: () => copySelToClipboard(true) },
    { sep: true },
  ];
  const rowItems = [
    { label: '在上方插入行', hint: 'Ctrl+U', action: () => doInsertRows(false) },
    { label: '在下方插入行', hint: 'Ctrl+I', action: () => doInsertRows(true) },
    { label: '删除行', hint: 'Del', action: () => doDeleteRows() },
  ];
  const colItems = [
    { label: '在左侧插入列', hint: 'Ctrl+K', action: () => doInsertCols(false) },
    { label: '在右侧插入列', hint: 'Ctrl+J', action: () => doInsertCols(true) },
    { label: '删除列', hint: 'Del', action: () => doDeleteCols() },
  ];
  if (kind === 'row') {
    // 右键时 sel 已是该整行：当前表头打勾。
    const hr = grid.sel ? grid.sel.fr : -1;
    return [
      {
        label: (grid.headerMode && hr === grid.headerRow ? '✓ ' : '') + '设为表头行',
        action: () => setHeaderRowFromMenu(),
      },
      ...rowItems,
    ];
  }
  if (kind === 'col') {
    const c = grid.sel ? grid.sel.fc : 0;
    return [
      { label: '升序排列', action: () => sortBy(c, 'asc') },
      { label: '降序排列', action: () => sortBy(c, 'desc') },
      { label: '清除排序', action: () => clearSort() },
      { sep: true },
      ...colItems,
    ];
  }
  if (kind === 'corner') return [...rowItems, { sep: true }, ...colItems];
  const items = [
    { label: '查找替换…', action: () => findApi.open() },
    { sep: true },
    ...editItems,
    { label: '粘贴', action: () => pasteFromClipboard() },
    ...rowItems, { sep: true }, ...colItems,
  ];
  if (grid.hidden.size > 0) {
    items.push({ sep: true }, { label: '清除筛选', action: () => clearFilter() });
  }
  return items;
}

async function pasteFromClipboard() {
  // navigator.clipboard.readText 在 WebView2 桌面端通常直接允许；失败则 toast 引导 Ctrl+V。
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    pasteText({ grid, onModify: (change) => commitChange(change || null) }, text);
  } catch {
    toast('读取剪贴板失败，请用 Ctrl+V 粘贴');
  }
}

async function copySelToClipboard(cut) {
  if (grid.allRanges().length === 0) return;
  try {
    await navigator.clipboard.writeText(selectionCopyText(grid));
    if (cut) {
      grid.clearSelection(); // 自带入栈 + render
      toast('已剪切');
    } else {
      toast('已复制');
    }
  } catch {
    toast(cut ? '剪切失败，请用 Ctrl+X' : '复制失败，请用 Ctrl+C');
  }
}

const selEncoding = $('sel-encoding');
const selDelimiter = $('sel-delimiter');

// ---------- 轻提示（同步写一份到状态栏） ----------
function toast(msg, ms = 2500) {
  const div = document.createElement('div');
  div.className = 'toast';
  div.textContent = msg;
  $('toast-host').appendChild(div);
  setTimeout(() => div.remove(), ms);
  $('st-msg').textContent = msg;
}

// ---------- 渲染 ----------
const DELIMITER_NAMES = { ',': '逗号(,)', ';': '分号(;)', '\t': 'Tab', '|': '竖线(|)' };

function buildSelects(encodings, delimiters) {
  selEncoding.innerHTML = '';
  for (const enc of encodings) {
    const opt = document.createElement('option');
    opt.value = enc;
    opt.textContent = enc;
    selEncoding.appendChild(opt);
  }
  selDelimiter.innerHTML = '';
  for (const d of delimiters) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = DELIMITER_NAMES[d] ?? JSON.stringify(d);
    selDelimiter.appendChild(opt);
  }
}

function renderAll() {
  const f = state.file;
  // #5：标题栏显示全路径（CSS 省略号兜长）；状态栏保留短文件名。
  $('file-label').textContent = f ? (f.path ?? f.fileName) : '未打开文件';
  $('st-file').textContent = f ? f.fileName : '未打开文件';
  if (!f) {
    $('st-meta').textContent = '';
    return;
  }
  selEncoding.value = f.encoding;
  if (![...selDelimiter.options].some((o) => o.value === f.delimiter)) {
    // 识别出的分隔符不在候选里（极少见）：临时加一项，保证显示正确。
    const opt = document.createElement('option');
    opt.value = f.delimiter;
    opt.textContent = JSON.stringify(f.delimiter);
    selDelimiter.appendChild(opt);
  }
  selDelimiter.value = f.delimiter;
  const nlName = f.newline === '\r\n' ? 'CRLF' : f.newline === '\n' ? 'LF' : 'CR';
  const delimName = DELIMITER_NAMES[f.delimiter] ?? JSON.stringify(f.delimiter);
  let meta = `编码 ${f.encoding} · 分隔符 ${delimName} · ${nlName} · ${f.text.length} 字符`;
  if (state.stats) {
    meta += ` · ${state.stats.rows} 行 × ${state.stats.cols} 列`;
    if (state.stats.warnings > 0) meta += ` · ${state.stats.warnings} 处容错`;
  }
  if (grid.headerMode && grid.headerRow < grid.rows.length) meta += ` · 表头：第${grid.headerRow + 1}行`;
  let commentCount = 0;
  for (const row of grid.rows) {
    if (isCommentRow(row, grid.commentPrefixes)) commentCount++;
  }
  if (commentCount > 0) meta += ` · 注释 ${commentCount} 行`;
  if (grid.hidden.size > 0) meta += ` · 已隐藏 ${grid.hidden.size} 行`;
  $('st-meta').textContent = meta;
}

// ---------- 拖放打开（#1 轮）：WebView2 子窗口吞掉 OLE，Form 层收不到，必须页面自己接 ----------
// 浏览器拿不到真实路径：读 base64 发 C# 走识别管线；保存时弹对话框（与新建同语义）。
// 不接的话 Chromium 会直接导航到文件把页面换掉，所以 dragover/drop 必须 preventDefault。
const DROP_MAX = 50 * 1024 * 1024;

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (state.dirty) {
    toast('有未保存的修改，请先保存后再拖入文件');
    return;
  }
  if (file.size > DROP_MAX) {
    toast('文件超 50MB，请用“打开”分批处理');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result ?? '');
    bridge.post('dropFile', { fileName: file.name || '拖放文件.csv', base64: url.slice(url.indexOf(',') + 1) });
  };
  reader.onerror = () => toast('读取拖放文件失败');
  reader.readAsDataURL(file);
});

// ---------- 文件消息 ----------
bridge.on('fileOpened', (msg) => {
  state.file = {
    path: msg.path ?? null,
    fileName: msg.fileName ?? '未命名',
    text: msg.text ?? '',
    encoding: msg.encoding ?? 'utf-8',
    delimiter: msg.delimiter ?? ',',
    newline: msg.newline ?? '\r\n',
    hasBom: !!msg.hasBom,
  };
  // 新文件上下文：清空历史并以当前点为保存点（干净）。
  undoStack.clear();
  undoStack.markSaved();
  setDirty(false);
  buildSelects(msg.supportedEncodings ?? [], msg.supportedDelimiters ?? []);
  // 解析并渲染（M5）；解析失败则清空网格并提示（解析器本身是容错的，这里是兜底）。
  try {
    grid.commentPrefixes = settings.commentPrefixes;
    grid.delimiter = state.file.delimiter;
    const parsed = parse(state.file.text, state.file.delimiter, { commentPrefixes: grid.commentPrefixes });
    grid.setData(parsed.rows);
    // 默认表头 = 跳过注释后的首个内容行（每次打开重置；右键可改，会话内有效）。
    grid.setHeaderRow(firstContentRow());
    state.file.endsWithNewline = parsed.endsWithNewline;
    state.stats = { rows: parsed.rows.length, cols: parsed.maxCols, warnings: parsed.warnings };
    resetFilterUI();
    findApi?.close();
  } catch (err) {
    grid.setData([]);
    state.stats = { rows: 0, cols: 0, warnings: 0 };
    resetFilterUI();
    findApi?.close();
    toast('解析失败：' + (err && err.message));
  }
  refreshStats();
  syncSettingsPanel();
  toast(`已打开 ${state.file.fileName}`);
  // 回执：证明页面确实收到并处理了文件；C# 据此更新标题（桥接双向验证点）。
  bridge.post('fileOpenedAck', { fileName: state.file.fileName, chars: state.file.text.length });
});

bridge.on('fileSaved', (msg) => {
  if (state.file && msg.path) state.file.path = msg.path;
  undoStack.markSaved();
  refreshDirty();
  renderAll();
  toast('已保存');
});

// ---------- 关闭前保存（#5）：C# 三选框选"是"后到这里；无文件则 save 内部弹另存框 ----------
// 另存被取消/保存失败 → 无 fileSaved → 无 closeReply → 停留在窗口（正确语义）。
let pendingCloseAfterSave = false;

bridge.on('saveAndClose', () => {
  const p = collectSavePayload();
  if (!p) {
    pendingCloseAfterSave = false;
    return; // 脏必有上下文，理论上到不了；到了也不关
  }
  pendingCloseAfterSave = true;
  bridge.post('save', p);
});

// C# 每次保存（成功/取消/失败）都回执：只有"关闭等待中 + 成功"才继续关，
// 其余一律清标记留窗口（修过期标记 bug：取消后下次手动保存不再误关）。
bridge.on('saveResult', (msg) => {
  const wasPending = pendingCloseAfterSave;
  pendingCloseAfterSave = false;
  if (msg.ok && wasPending) bridge.post('closeReply', { ok: true });
});

bridge.on('error', (msg) => toast('错误：' + (msg.message ?? '未知错误'), 5000));

// ---------- 无边框标题栏（#2）：拖动/双击/三键走 bridge，C# 执行窗口动作 ----------
// 纯浏览器调试时 bridge.post 是空操作，无害。
const titlebar = $('titlebar');
titlebar.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  if (!e.isTrusted) return; // 同上：拖动窗体只认真实手势
  bridge.post('winDrag');
});
titlebar.addEventListener('dblclick', (e) => {
  if (e.target.closest('button')) return;
  bridge.post('winToggleMax');
});
$('win-min').addEventListener('click', () => bridge.post('winMin'));
$('win-max').addEventListener('click', () => bridge.post('winToggleMax'));
$('win-close').addEventListener('click', () => bridge.post('winClose'));
bridge.on('winState', (msg) => {
  document.body.classList.toggle('maxed', !!msg.max);
});

// ---------- 窗体边缘缩放（#3）：视口最外 8px 归窗体（OS 通例），优先于列宽/标题栏拖动 ----------
// Form 层 NCHITTEST 收不到（WebView2 子窗口吞掉），这里判定后让 C# 进原生 sizing 循环。
const WIN_EDGE = 8;

function windowEdgeAt(x, y) {
  if (document.body.classList.contains('maxed')) return '';
  const w = window.innerWidth;
  const h = window.innerHeight;
  const l = x < WIN_EDGE;
  const r = x >= w - WIN_EDGE;
  const t = y < WIN_EDGE;
  const b = y >= h - WIN_EDGE;
  if (t && l) return 'NW';
  if (t && r) return 'NE';
  if (b && l) return 'SW';
  if (b && r) return 'SE';
  if (l) return 'W';
  if (r) return 'E';
  if (t) return 'N';
  if (b) return 'S';
  return '';
}

const EDGE_CURSOR = {
  N: 'ns-resize', S: 'ns-resize', E: 'ew-resize', W: 'ew-resize',
  NE: 'nesw-resize', SW: 'nesw-resize', NW: 'nwse-resize', SE: 'nwse-resize',
};
// HT* 10..17：与 C# SC_SIZE 映射对齐（W=10,E=11,N=12,NW=13,NE=14,S=15,SW=16,SE=17）。
const EDGE_HT = { W: 10, E: 11, N: 12, NW: 13, NE: 14, S: 15, SW: 16, SE: 17 };

document.addEventListener('mousemove', (e) => {
  const dir = windowEdgeAt(e.clientX, e.clientY);
  if (dir) {
    document.body.dataset.edge = dir;
    document.body.style.cursor = EDGE_CURSOR[dir];
  } else if (document.body.dataset.edge) {
    delete document.body.dataset.edge;
    document.body.style.cursor = '';
  }
});

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  // 只响应真实用户手势：合成事件无可信坐标（clientX/Y 常为 0，会误判成左上角），
  // 且编程式按下绝不能进 OS modal 循环。
  if (!e.isTrusted) return;
  // 标题栏窗口按钮优先：边缘 8px 与三键重叠时点按钮（否则点最大化会误触发缩放）。
  if (e.target.closest?.('#titlebar button')) return;
  const dir = windowEdgeAt(e.clientX, e.clientY);
  if (!dir) return;
  // 边缘优先：吞掉，不让网格/标题栏开始拖拽。
  e.stopPropagation();
  e.preventDefault();
  bridge.post('winResize', { ht: EDGE_HT[dir] });
}, true);

// ---------- 内容缩放（#8）：Ctrl+滚轮只缩放内容区（字号+行高），系统区不动，持久化 ----------
grid.scroller.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const step = e.deltaY < 0 ? 0.1 : -0.1;
  const z = Math.min(2, Math.max(0.7, Math.round((grid.zoom + step) * 10) / 10));
  if (z === grid.zoom) return;
  grid.setZoom(z);
  setSetting('zoom', z);
  applySysFs(); // --content-fs 跟 zoom 走
  $('st-msg').textContent = `内容缩放 ${Math.round(z * 100)}%`;
}, { passive: false });

// ---------- 工具栏 ----------
function collectSavePayload() {
  const f = state.file;
  if (!f) {
    toast('没有打开的文件');
    return null;
  }
  // M6 起：保存网格数据序列化结果（M5 及之前是原文回写；含引号换行的字段按最小引号策略处理）。
  // 注释行原样回写（commentPrefixes 透传，见 csv.js）。
  const text = serialize(grid.rows, {
    delimiter: f.delimiter,
    newline: f.newline,
    trailingNewline: f.endsWithNewline ?? true,
    commentPrefixes: settings.commentPrefixes,
  });
  return {
    path: f.path,
    text,
    encoding: f.encoding,
    delimiter: f.delimiter,
    newline: f.newline,
    hasBom: f.hasBom,
  };
}

function doSave() {
  const p = collectSavePayload();
  if (p) bridge.post('save', p);
}

$('btn-open').addEventListener('click', () => bridge.post('openFileDialog'));
$('btn-new').addEventListener('click', newDocument);
$('btn-save').addEventListener('click', doSave);
$('btn-saveas').addEventListener('click', () => {
  const p = collectSavePayload();
  if (p) bridge.post('saveAs', p);
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (e.shiftKey) $('btn-saveas').click();
    else doSave();
  }
});

// ---------- 新建文档（#1）：空表 + 未命名上下文，保存时弹对话框，按选定的分隔符写 ----------
const NEW_ROWS = 10;
const NEW_COLS = 6;

function newDocument() {
  if (state.dirty) {
    // v1 语义：脏时不丢数据，中断并提示先保存（不做三选确认框）。
    toast('有未保存的修改，请先保存后再新建');
    return;
  }
  state.file = {
    path: null,
    fileName: '未命名.csv',
    text: '',
    encoding: 'utf-8',
    delimiter: settings.defaultDelimiter,
    newline: '\r\n',
    hasBom: false,
    endsWithNewline: true,
  };
  undoStack.clear();
  undoStack.markSaved();
  setDirty(false);
  if (serverEncodings.length > 0 && serverDelimiters.length > 0) {
    buildSelects(serverEncodings, serverDelimiters);
  }
  grid.commentPrefixes = settings.commentPrefixes;
  grid.delimiter = state.file.delimiter;
  grid.setData(Array.from({ length: NEW_ROWS }, () => new Array(NEW_COLS).fill('')));
  grid.setHeaderRow(firstContentRow()); // 空表：第 0 行
  state.stats = { rows: NEW_ROWS, cols: NEW_COLS, warnings: 0 };
  resetFilterUI();
  findApi?.close();
  refreshStats();
  syncSettingsPanel();
  bridge.post('fileOpenedAck', { fileName: state.file.fileName, chars: 0 });
  toast('已新建空文档（保存时按选定的分隔符写入）');
}

// ---------- 编码/分隔符切换 → 按新格式重载当前文件 ----------
function reloadWithFormat() {
  if (!state.file) return;
  if (!state.file.path) {
    // 未命名文档：无文件可重载，只换上下文（保存时生效）。
    state.file.encoding = selEncoding.value;
    state.file.delimiter = selDelimiter.value;
    renderAll();
    toast('新建文档：已切换，保存时生效');
    return;
  }
  bridge.post('reloadWithEncoding', {
    encoding: selEncoding.value,
    delimiter: selDelimiter.value,
  });
}
selEncoding.addEventListener('change', reloadWithFormat);
selDelimiter.addEventListener('change', reloadWithFormat);

// ---------- 主题（#5：进 settings.json，旧 localStorage 一次性迁移） ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function applySysFs() {
  document.documentElement.style.setProperty('--sys-fs', settings.sysFs + 'px');
  document.documentElement.style.setProperty('--content-fs', Math.round(13 * settings.zoom) + 'px');
}

$('btn-theme').addEventListener('click', () => {
  setSetting('theme', settings.theme === 'light' ? 'dark' : 'light');
  applyTheme(settings.theme);
});
applyTheme(settings.theme);
applySysFs();

// C# 下发设置快照：defaults ← 存过的值 ← 旧 localStorage（仅缺键时迁移一次）。
bridge.on('settings', (msg) => {
  const stored = (msg.settings && typeof msg.settings === 'object') ? msg.settings : {};
  serverEncodings = msg.supportedEncodings ?? [];
  serverDelimiters = msg.supportedDelimiters ?? [];
  if (msg.appVersion) $('about-ver').textContent = 'v' + msg.appVersion;
  const legacy = {};
  try {
    const lt = localStorage.getItem('alocsv-theme');
    if (lt && !('theme' in stored)) legacy.theme = lt;
    const lh = localStorage.getItem('alocsv-header');
    if (lh !== null && !('headerMode' in stored)) legacy.headerMode = lh === '1';
    localStorage.removeItem('alocsv-theme');
    localStorage.removeItem('alocsv-header');
  } catch { /* 存储不可用时忽略 */ }
  loadSettings(stored, legacy);
  applyTheme(settings.theme);
  applySysFs();
  applyHeaderMode(settings.headerMode, true);
  grid.setZoom?.(settings.zoom);
  grid.setCrosshair?.(settings.crosshair);
  grid.setZebra?.(settings.zebra);
  grid.commentPrefixes = settings.commentPrefixes;
  syncDisplayToggles();
  syncSettingsPanel();
  if (Object.keys(legacy).length > 0) saveSoon();
});

// ---------- 设置面板（#8）：主题/内容缩放/系统字号/默认分隔符/三开关 ----------
// 浮层定位工具栏下右侧；外面按下/Esc 关闭。
function syncSettingsPanel() {
  $('set-theme').value = settings.theme;
  $('set-zoom').value = Math.round(settings.zoom * 100);
  $('set-zoom-v').textContent = Math.round(settings.zoom * 100) + '%';
  $('set-sysfs').value = settings.sysFs;
  $('set-sysfs-v').textContent = settings.sysFs + 'px';
  $('set-cross').checked = grid.crosshair;
  $('set-zebra').checked = grid.zebra;
  $('set-header').checked = grid.headerMode;
  $('set-headerrow').value = grid.headerRow + 1;
  $('set-prefixes').value = settings.commentPrefixes.join(' ');
  // 默认分隔符候选跟工具栏分隔符下拉保持一致（同一真相源）。
  const sd = $('set-delim');
  const want = [...selDelimiter.options].map((o) => [o.value, o.textContent]);
  if (want.map(([v]) => v).join('\0') !== [...sd.options].map((o) => o.value).join('\0')) {
    sd.innerHTML = '';
    for (const [v, t] of want) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = t;
      sd.append(opt);
    }
  }
  if ([...sd.options].some((o) => o.value === settings.defaultDelimiter)) {
    sd.value = settings.defaultDelimiter;
  }
}

$('btn-settings').addEventListener('click', () => {
  const p = $('settings-panel');
  syncSettingsPanel();
  p.hidden = !p.hidden;
});

// ---------- 格式弹出框（#4）：编码/分隔符，平时收起；切换逻辑不变（reloadWithFormat） ----------
$('btn-format').addEventListener('click', () => {
  $('format-panel').hidden = !$('format-panel').hidden;
});

document.addEventListener('pointerdown', (e) => {
  const p = $('format-panel');
  if (p.hidden) return;
  if (e.target.closest?.('#format-panel') || e.target.closest?.('#btn-format')) return;
  p.hidden = true;
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('format-panel').hidden = true;
});

document.addEventListener('pointerdown', (e) => {
  const p = $('settings-panel');
  if (p.hidden) return;
  if (e.target.closest?.('#settings-panel') || e.target.closest?.('#btn-settings')) return;
  p.hidden = true;
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('settings-panel').hidden = true;
});

$('set-theme').addEventListener('change', (e) => {
  setSetting('theme', e.target.value);
  applyTheme(settings.theme);
});
$('set-zoom').addEventListener('input', (e) => {
  const z = +e.target.value / 100;
  grid.setZoom(z);
  setSetting('zoom', z);
  applySysFs();
  $('set-zoom-v').textContent = e.target.value + '%';
});
$('set-sysfs').addEventListener('input', (e) => {
  setSetting('sysFs', +e.target.value);
  applySysFs();
  $('set-sysfs-v').textContent = e.target.value + 'px';
});
$('set-delim').addEventListener('change', (e) => {
  setSetting('defaultDelimiter', e.target.value);
  toast('默认分隔符已记住，新建文档时使用');
});
$('set-cross').addEventListener('change', (e) => {
  grid.setCrosshair(e.target.checked);
  setSetting('crosshair', e.target.checked);
  syncDisplayToggles();
});
$('set-zebra').addEventListener('change', (e) => {
  grid.setZebra(e.target.checked);
  setSetting('zebra', e.target.checked);
  syncDisplayToggles();
});
$('set-header').addEventListener('change', (e) => {
  applyHeaderMode(e.target.checked);
});
$('set-headerrow').addEventListener('change', (e) => {
  // 1-based 显示；会话内有效（打开新文件重置为首个内容行，不持久化）。
  const v = Math.max(1, Math.round(+e.target.value || 1));
  e.target.value = v;
  grid.setHeaderRow(v - 1);
  refreshStats();
  toast(`表头行：第 ${v} 行`);
});
$('set-prefixes').addEventListener('change', (e) => {
  // 空白分隔；置空回退到 #（至少保留一个标记，否则注释功能名存实亡）。
  const arr = String(e.target.value ?? '').split(/\s+/).filter(Boolean);
  setSetting('commentPrefixes', arr.length > 0 ? arr : ['#']);
  grid.commentPrefixes = settings.commentPrefixes;
  grid.render();
  refreshStats();
  toast('注释标记已更新：' + settings.commentPrefixes.join(' '));
});

// ---------- 关于对话框（作者/开源信息；版本号由 C# settings 下发） ----------
const aboutModal = $('about-modal');

$('btn-about').addEventListener('click', () => {
  $('settings-panel').hidden = true;
  aboutModal.hidden = false;
});
$('about-close').addEventListener('click', () => { aboutModal.hidden = true; });
aboutModal.addEventListener('pointerdown', (e) => {
  if (e.target === aboutModal) aboutModal.hidden = true; // 点遮罩关闭
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') aboutModal.hidden = true;
});

// ---------- 启动握手 ----------
bridge.post('ready');
