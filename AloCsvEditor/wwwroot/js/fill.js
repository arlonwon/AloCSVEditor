// 拖动填充 + 拖动移动（DESIGN.md §6.9 / M8）。
// 与 Grid 解耦：Grid 只渲染填充柄，全部手势由本模块以 capture 监听接管
// （stopPropagation 后 Grid 的冒泡监听收不到，天然互斥，无需改 Grid 事件）。
// 范围计算铁律（SmoothCSV 教训）：所有目标范围先钳制再使用，逐格写入，
// 绝不用推导出的长度去 new Array(n)；扩展行列走 grid.ensureSize。
import { HEADER_H, ROW_NUM_W } from './grid.js';

const HANDLE_SIZE = 10; // 与 CSS .fill-handle、grid.js 定位偏移保持一致
const BORDER_ZONE = 4; // 选区边框判定带宽（移动手势）
const MAX_ROWS = 1000000;
const MAX_COLS = 1000;
const FILL_AUTO_EDGE = 24;
const FILL_AUTO_STEP = 60;

// ---------- 纯函数（可单测） ----------

// 沿轴取某位置的值。seed 为源线上按序值，idx 为相对源起点偏移（可负：上/左填）。
// 规则：单值复制；全数字等差则延续（浮点取 12 位有效数字去抖）；
// 尾巴数字（A001/第1周）后缀递增、补零位宽保留；否则循环重复。
// forceSeq（Ctrl 拖）：单数字强制 +1 步进（默认单值是复制）。
export function fillValueAt(seed, idx, forceSeq = false) {
  const n = seed.length;
  if (n === 0) return '';
  if (n === 1) {
    const v = seed[0];
    if (v.trim() !== '' && !Number.isNaN(Number(v))) {
      // 纯数字单格：默认复制，Ctrl 强制序列。
      if (!forceSeq) return v;
      const num = Number(v) + idx;
      return String(Number.isInteger(num) ? num : Number(num.toPrecision(12)));
    }
    // 非纯数字：尾巴数字默认就递增（Excel 行为）。
    const t = splitTrail(v);
    if (t) return t.prefix + padNum(Number(t.num) + idx, t.num.length);
    return v;
  }
  const nums = seed.map((v) => (v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null));
  if (nums.every((x) => x !== null)) {
    const step = nums[1] - nums[0];
    let arithmetic = true;
    for (let i = 2; i < n; i++) {
      if (Math.abs(nums[i] - (nums[i - 1] + step)) > 1e-9) {
        arithmetic = false;
        break;
      }
    }
    if (arithmetic) {
      const val = nums[0] + step * idx;
      const clean = val === 0 ? 0 : val;
      return String(Number.isInteger(clean) ? clean : Number(clean.toPrecision(12)));
    }
  }
  // 尾巴数字同前缀：后缀等差（如 A1,A2 → A4）。
  const trails = seed.map(splitTrail);
  if (trails.every((t) => t !== null && t.prefix === trails[0].prefix)) {
    const tnums = trails.map((t) => Number(t.num));
    const step = tnums[1] - tnums[0];
    let ok = true;
    for (let i = 2; i < n; i++) {
      if (tnums[i] - tnums[i - 1] !== step) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const width = Math.max(...trails.map((t) => t.num.length));
      return trails[0].prefix + padNum(tnums[0] + step * idx, width);
    }
  }
  // 循环重复（负索引正确回绕）。
  return seed[((idx % n) + n) % n];
}

// 拆尾巴数字："A001"→{prefix:'A',num:'001'}；纯数字→{prefix:'',num}；无数字后缀→null。
function splitTrail(v) {
  const m = /^(.*?)(\d+)$/.exec(String(v ?? ''));
  return m ? { prefix: m[1], num: m[2] } : null;
}

// 补零：padNum(2,3)='002'；超宽自然增长（999+1→1000）；负数保符号。
function padNum(v, width) {
  const neg = v < 0;
  const s = String(Math.abs(Math.trunc(v)));
  return (neg ? '-' : '') + s.padStart(width, '0');
}

// 整块填充计算：source（含 get(r,c) 取值函数）沿单轴扩展到 target（须包含 source）。
// 方向由 target 相对 source 的位置隐含（idx 可正可负）。返回全量值，调用方收窄 diff。
// forceSeq 透传给 fillValueAt（Ctrl 拖强制序列）。
export function computeFill(source, target, forceSeq = false) {
  const out = [];
  const vertical = target.r1 < source.r1 || target.r2 > source.r2;
  if (vertical) {
    for (let c = source.c1; c <= source.c2; c++) {
      const seed = [];
      for (let r = source.r1; r <= source.r2; r++) seed.push(source.get(r, c));
      for (let r = target.r1; r <= target.r2; r++) {
        out.push({ r, c, value: fillValueAt(seed, r - source.r1, forceSeq) });
      }
    }
  } else {
    for (let r = source.r1; r <= source.r2; r++) {
      const seed = [];
      for (let c = source.c1; c <= source.c2; c++) seed.push(source.get(r, c));
      for (let c = target.c1; c <= target.c2; c++) {
        out.push({ r, c, value: fillValueAt(seed, c - source.c1, forceSeq) });
      }
    }
  }
  return out;
}

// 双击填充边界：从 startRow+1 起沿邻列找连续非空区末尾；左邻优先，无数据返回 startRow。
export function findFillBoundary(rows, col, startRow) {
  const n = rows.length;
  const extent = (nc) => {
    let r = startRow + 1;
    while (r < n && (rows[r]?.[nc] ?? '') !== '') r++;
    return r - 1;
  };
  if (col - 1 >= 0) {
    const left = extent(col - 1);
    if (left > startRow) return left;
  }
  const right = extent(col + 1);
  return right > startRow ? right : startRow;
}

// 目标钳制：下界 0，上界 MAX。调用方对 clamped 负责提示（每拖只提示一次）。
export function clampTarget(t) {
  const r1 = Math.max(0, t.r1);
  const c1 = Math.max(0, t.c1);
  const r2 = Math.min(MAX_ROWS - 1, t.r2);
  const c2 = Math.min(MAX_COLS - 1, t.c2);
  const clamped = r1 !== t.r1 || c1 !== t.c1 || r2 !== t.r2 || c2 !== t.c2;
  return { target: { r1, c1, r2, c2 }, clamped };
}

// ---------- 手势控制器 ----------

export function initFill(ctx) {
  const { grid, editor, toast, onModify } = ctx;

  // 预览框（填充/移动共用）。
  const preview = document.createElement('div');
  preview.className = 'drop-preview';
  preview.style.display = 'none';
  grid.canvas.append(preview);
  // 冻结段预览（钉住，随冻结盒；M9b）。
  const previewF = document.createElement('div');
  previewF.className = 'drop-preview';
  previewF.style.display = 'none';
  grid.frozenBox.append(previewF);

  // 拖拽状态机。mode: null | 'fill' | 'move'
  const st = { mode: null, source: null, target: null, grab: null, copyMode: false, seqForce: false, last: null, timer: 0, clampNoted: false };

  // 视口坐标→格子：按实际 DOM 命中解析，天然兼容冻结行/筛选隐藏/列宽变化。
  // 返回 null 表示空白处；列头/行号处返回 r/c=-1（调用方钳制）。
  // 注：覆盖层（选区/预览）均为 pointer-events:none，不会拦截命中。
  const cellFromPoint = (clientX, clientY) => {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return null;
    const cell = el.closest('.gc');
    if (cell) return { r: +cell.dataset.r, c: +cell.dataset.c };
    const hc = el.closest('.gchead');
    if (hc && grid.head.contains(hc)) return { r: -1, c: +hc.dataset.c };
    const num = el.closest('.grc');
    if (num) return { r: +num.dataset.r, c: -1 };
    return null;
  };

  // 选区边框判定（4px 带）：移动手势与悬停光标用。冻结段/滚动段分别判定。
  const onSelBorder = (clientX, clientY) => {
    const range = grid.normSel();
    if (!range) return false;
    const rect = grid.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const x1 = ROW_NUM_W + grid.colX(range.c1);
    const x2 = ROW_NUM_W + grid.colX(range.c2 + 1);
    if (x < x1 || x > x2) return false;
    const inBand = (y1, y2) => y >= y1 && y <= y2
      && (x - x1 < BORDER_ZONE || x2 - x < BORDER_ZONE
        || y - y1 < BORDER_ZONE || y2 - y < BORDER_ZONE);
    const split = grid.splitRows(range.r1, range.r2);
    if (split.frozen) {
      const f = split.frozen;
      if (inBand(HEADER_H + f.y, HEADER_H + f.y + f.h)) return true;
    }
    if (split.body) {
      if (inBand(grid.bodyY(split.body.p1), grid.bodyY(split.body.p2) + grid.rh())) return true;
    }
    return false;
  };

  // 填充/移动预览：冻结段与滚动段各画各的（后者在画布坐标，前者在冻结盒坐标）。
  const showPreview = (t) => {
    if (!t) {
      preview.style.display = 'none';
      previewF.style.display = 'none';
      return;
    }
    let w = 0;
    for (let c = t.c1; c <= t.c2; c++) w += grid.colW[c] ?? 120; // 扩展列按默认宽估算
    const x = ROW_NUM_W + grid.colX(t.c1);
    const split = grid.splitRows(t.r1, t.r2);
    if (split.body) {
      preview.style.display = '';
      preview.style.left = x + 'px';
      preview.style.top = grid.bodyY(split.body.p1) + 'px';
      preview.style.width = w + 'px';
      preview.style.height = (split.body.p2 - split.body.p1 + 1) * grid.rh() + 'px';
    } else {
      preview.style.display = 'none';
    }
    if (split.frozen) {
      const f = split.frozen;
      previewF.style.display = '';
      previewF.style.left = x + 'px';
      previewF.style.top = f.y + 'px';
      previewF.style.width = w + 'px';
      previewF.style.height = f.h + 'px';
    } else {
      previewF.style.display = 'none';
    }
  };

  // 全量目标值收窄为 diff 后入栈（与 M7 粘贴同一 change 结构，复用撤销逻辑）。
  const commitCells = (filled, grewRows, grewCols) => {
    const cells = [];
    for (const f of filled) {
      const before = grid.rows[f.r]?.[f.c] ?? '';
      if (before !== f.value) {
        grid.rows[f.r][f.c] = f.value;
        cells.push({ r: f.r, c: f.c, before, after: f.value });
      }
    }
    if (cells.length > 0 || grewRows > 0 || grewCols > 0) {
      onModify({ cells, grewRows, grewCols });
    }
    grid.render();
  };

  const noteClamped = () => {
    if (st.clampNoted) return;
    st.clampNoted = true;
    toast('已达到行列上限，目标被钳制', 3000);
  };

  const startAutoScroll = () => {
    stopAutoScroll();
    st.timer = setInterval(() => {
      if (!st.mode || !st.last) return;
      const rect = grid.scroller.getBoundingClientRect();
      const { x, y } = st.last;
      if (y < rect.top + FILL_AUTO_EDGE) grid.scroller.scrollTop -= FILL_AUTO_STEP;
      else if (y > rect.bottom - FILL_AUTO_EDGE) grid.scroller.scrollTop += FILL_AUTO_STEP;
      if (x < rect.left + FILL_AUTO_EDGE) grid.scroller.scrollLeft -= FILL_AUTO_STEP;
      else if (x > rect.right - FILL_AUTO_EDGE) grid.scroller.scrollLeft += FILL_AUTO_STEP;
    }, 50);
  };

  const stopAutoScroll = () => {
    if (st.timer) {
      clearInterval(st.timer);
      st.timer = 0;
    }
  };

  const resetDrag = () => {
    st.mode = null;
    st.source = null;
    st.target = null;
    st.grab = null;
    st.seqForce = false;
    st.last = null;
    st.clampNoted = false;
    stopAutoScroll();
    showPreview(null);
    grid.scroller.style.cursor = '';
  };

  // ---- 填充 ----

  const targetForPointer = (source, cell) => {
    const r = Math.max(0, cell.r);
    const c = Math.max(0, cell.c);
    const dx = c < source.c1 ? source.c1 - c : c > source.c2 ? c - source.c2 : 0;
    const dy = r < source.r1 ? source.r1 - r : r > source.r2 ? r - source.r2 : 0;
    if (dx === 0 && dy === 0) return null; // 还在源内：无操作
    // 对角拖拽取主轴（距离大者），目标钳制为单轴扩展，语义确定。
    let t;
    if (dy >= dx) {
      t = { r1: Math.min(source.r1, r), c1: source.c1, r2: Math.max(source.r2, r), c2: source.c2 };
    } else {
      t = { r1: source.r1, c1: Math.min(source.c1, c), r2: source.r2, c2: Math.max(source.c2, c) };
    }
    const { target, clamped } = clampTarget(t);
    if (clamped) noteClamped();
    return target;
  };

  const applyFill = (source, target, forceSeq) => {
    const prevRows = grid.rows.length;
    const prevCols = grid.nCols;
    grid.ensureSize(target.r2 + 1, target.c2 + 1);
    const get = (r, c) => grid.rows[r]?.[c] ?? '';
    const filled = computeFill({ ...source, get }, target, forceSeq);
    commitCells(filled, grid.rows.length - prevRows, grid.nCols - prevCols);
    grid.sel = { ar: target.r1, ac: target.c1, fr: target.r2, fc: target.c2 };
    grid.render();
  };

  // ---- 移动 ----

  const applyMove = (source, target, copy) => {
    if (target.r1 === source.r1 && target.c1 === source.c1) return; // 零位移
    // 先整体读源（重叠安全），再清源（复制模式跳过），再写目标；diff 一次算清。
    const block = [];
    for (let r = source.r1; r <= source.r2; r++) {
      const line = [];
      for (let c = source.c1; c <= source.c2; c++) line.push(grid.rows[r]?.[c] ?? '');
      block.push(line);
    }
    const inTarget = (r, c) =>
      r >= target.r1 && r <= target.r2 && c >= target.c1 && c <= target.c2;
    const prevRows = grid.rows.length;
    const prevCols = grid.nCols;
    grid.ensureSize(target.r2 + 1, target.c2 + 1);
    const cells = [];
    const push = (r, c, after) => {
      const before = grid.rows[r]?.[c] ?? '';
      if (before !== after) {
        grid.rows[r][c] = after;
        cells.push({ r, c, before, after });
      }
    };
    for (let r = 0; r < block.length; r++) {
      for (let c = 0; c < block[r].length; c++) push(target.r1 + r, target.c1 + c, block[r][c]);
    }
    if (!copy) {
      for (let r = source.r1; r <= source.r2; r++) {
        for (let c = source.c1; c <= source.c2; c++) {
          if (!inTarget(r, c)) push(r, c, '');
        }
      }
    }
    const grewRows = grid.rows.length - prevRows;
    const grewCols = grid.nCols - prevCols;
    if (cells.length > 0 || grewRows > 0 || grewCols > 0) {
      onModify({ cells, grewRows, grewCols });
    }
    grid.sel = { ar: target.r1, ac: target.c1, fr: target.r2, fc: target.c2 };
    grid.render();
  };

  // ---- 手势接管（capture，先于 Grid 的冒泡监听） ----

  grid.scroller.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || editor.isEditing() || !grid.normSel()) return;
    if (e.target.closest('.fill-handle')) {
      e.stopPropagation();
      e.preventDefault();
      st.mode = 'fill';
      st.source = grid.normSel();
      st.target = null;
      st.seqForce = e.ctrlKey; // 按住 Ctrl 起拖 = 强制序列（#7）
      st.last = { x: e.clientX, y: e.clientY };
      startAutoScroll();
      grid.scroller.style.cursor = 'crosshair';
      return;
    }
    if (onSelBorder(e.clientX, e.clientY)) {
      e.stopPropagation();
      e.preventDefault();
      const cell = cellFromPoint(e.clientX, e.clientY);
      if (!cell) return; // 空白处（理论上到不了，防御）
      st.mode = 'move';
      st.source = grid.normSel();
      st.grab = { r: Math.max(0, cell.r), c: Math.max(0, cell.c) };
      st.target = null;
      st.copyMode = e.ctrlKey;
      st.last = { x: e.clientX, y: e.clientY };
      startAutoScroll();
      grid.scroller.style.cursor = st.copyMode ? 'copy' : 'move';
    }
  }, true);

  window.addEventListener('mousemove', (e) => {
    if (!st.mode) return;
    st.last = { x: e.clientX, y: e.clientY };
    if (st.mode === 'fill') {
      st.seqForce = e.ctrlKey; // Ctrl 实时切换复制/序列（Excel 行为，与移动的 copyMode 对齐）
      const cell = cellFromPoint(e.clientX, e.clientY);
      st.target = cell ? targetForPointer(st.source, cell) : null;
      showPreview(st.target);
    } else {
      st.copyMode = e.ctrlKey; // Ctrl 实时切换移动/复制（Excel 行为）
      const cell = cellFromPoint(e.clientX, e.clientY);
      if (!cell) return;
      const dr = Math.max(0, cell.r) - st.grab.r;
      const dc = Math.max(0, cell.c) - st.grab.c;
      const t = {
        r1: st.source.r1 + dr, c1: st.source.c1 + dc,
        r2: st.source.r2 + dr, c2: st.source.c2 + dc,
      };
      const res = clampTarget(t);
      if (res.clamped) noteClamped();
      st.target = res.target;
      showPreview(st.target);
      grid.scroller.style.cursor = st.copyMode ? 'copy' : 'move';
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (!st.mode || e.button !== 0) return;
    if (st.mode === 'fill') {
      if (st.target) applyFill(st.source, st.target, st.seqForce);
    } else {
      const t = st.target;
      const s = st.source;
      if (t && !(t.r1 === s.r1 && t.c1 === s.c1)) applyMove(s, t, st.copyMode);
    }
    resetDrag();
  });

  window.addEventListener('keydown', (e) => {
    if (st.mode && e.key === 'Escape') resetDrag(); // Esc 取消拖拽
  });

  // 悬停光标（无拖拽、非列头区时）：手柄十字，边框移动。
  grid.scroller.addEventListener('mousemove', (e) => {
    if (st.mode || grid.dragging) return;
    if (e.target.closest?.('.grid-head')) return; // 列头光标归 Grid 管
    if (e.target.closest?.('.fill-handle')) {
      grid.scroller.style.cursor = 'crosshair';
      return;
    }
    grid.scroller.style.cursor =
      (grid.normSel() && onSelBorder(e.clientX, e.clientY)) ? 'move' : '';
  });

  // 双击手柄：每列向下填到邻列数据末尾，整列一个撤销。
  grid.scroller.addEventListener('dblclick', (e) => {
    if (editor.isEditing()) return;
    if (!e.target.closest?.('.fill-handle')) return;
    const range = grid.normSel();
    if (!range) return;
    const prevRows = grid.rows.length;
    const prevCols = grid.nCols;
    const allCells = [];
    let filledAny = false;
    for (let c = range.c1; c <= range.c2; c++) {
      const b = findFillBoundary(grid.rows, c, range.r2);
      if (b <= range.r2) continue;
      grid.ensureSize(b + 1, c + 1);
      const src = {
        r1: range.r1, c1: c, r2: range.r2, c2: c,
        get: (r, cc) => grid.rows[r]?.[cc] ?? '',
      };
      for (const f of computeFill(src, { r1: range.r1, c1: c, r2: b, c2: c }, e.ctrlKey)) {
        const before = grid.rows[f.r][f.c];
        if (before !== f.value) {
          grid.rows[f.r][f.c] = f.value;
          allCells.push({ r: f.r, c: f.c, before, after: f.value });
        }
      }
      filledAny = true;
    }
    if (!filledAny) {
      toast('没有可填充的区域（邻列无数据）');
      return;
    }
    const grewRows = grid.rows.length - prevRows;
    const grewCols = grid.nCols - prevCols;
    if (allCells.length > 0 || grewRows > 0 || grewCols > 0) {
      onModify({ cells: allCells, grewRows, grewCols });
    }
    grid.render();
  });
}
