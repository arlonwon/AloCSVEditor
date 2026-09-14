// 虚拟滚动网格 + 选区（DESIGN.md §6.5–§6.6）。
// M5 范围：渲染、滚动、选区（拖选/Shift/键盘/行列头点选/全选）、列宽拖拽、双击自动列宽。
// M6 编辑覆盖层，M8 填充柄，M9 行列结构操作 + 排序指示。
// 事件全部委托在容器层，行重建不丢失监听。
import { insertBlankRows, removeRows, insertBlankCols, removeCols } from './commands.js';
import { isCommentRow, commentLineText } from './csv.js';

// ROW_NUM_W 须与 CSS .grc/.grid-corner 宽度保持一致；三者导出给 editor.js 定位覆盖层用。
export const ROW_H = 28;
export const HEADER_H = 30;
export const ROW_NUM_W = 53;
// main.js 撤销删列恢复列宽用，导出。
export const DEFAULT_COL_W = 120;
const MIN_COL_W = 48;
const MAX_COL_W = 480;
const OVERSCAN = 20;
const EDGE_ZONE = 12; // 列头边界左右各 12px 判定"改列宽"（#3：好抓；左边缘归前一列）
const AUTO_EDGE = 24; // 拖选时距视口边缘多少像素触发自动滚动
const AUTO_STEP = 60;

// 列号转 Excel 列名：0→A … 25→Z，26→AA。
export function colName(i) {
  let s = '';
  i++;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

export class Grid {
  constructor(host) {
    this.host = host;
    this.rows = [];
    this.nCols = 0;
    this.colW = [];
    this.sel = null; // 活动区 {ar,ac,fr,fc}：anchor + focus（编辑/填充/删除/排序只作用它）
    this.extra = []; // 多选区（#9）：已规范化的 {r1,c1,r2,c2} 列表，只参与显示 + 复制
    this.dragging = false;
    this.dragMode = null; // cells | cols | rows | resize
    this.resizeCol = -1;
    this.resizeStartX = 0;
    this.resizeStartW = 0;
    this.lastClick = null; // {r,c,t} 双击自判（#4：不依赖浏览器发不发 dblclick）
    this._cursorHc = null; // 当前给了 ew-resize 的列头格（#6：离开时清掉）
    this.scrollRaf = 0;
    this.autoTimer = 0;
    this.lastMouse = null;
    // main.js 挂接：{onEditRequest(r,c,initial), onModify(change), onUndo, onRedo}。
    this.hooks = {};
    this.sortMark = null; // {col, dir} 当前排序指示（M9），列头渲染用
    // 表头/冻结/筛选索引（M9b）：headerMode 时首行为表头（加粗+冻结+排序排除）；
    // hidden 为筛选隐藏行集合；frozenList/bodyList/visPos 由 layout 重建。
    this.headerMode = false;
    this.hidden = new Set();
    this.frozenList = [];
    this.bodyList = [];
    this.visPos = new Int32Array(0);
    // 查找高亮（M9c）：matchSet 为 "r,c" 集合，matchCur 为当前项。
    this.matchSet = null;
    this.matchCur = null;
    // 显示开关（#6/#10）：crosshair 十字高亮（跟活动格），zebra 斑马纹（奇数行）。
    this.crosshair = false;
    this.zebra = false;
    this.zoom = 1; // 内容缩放（#8）：0.7–2.0，行高 = 基准 × zoom
    this.headerRow = 0; // 表头行（绝对行号；会话态，打开文件时自动指向首个内容行）
    this.commentPrefixes = []; // 通栏注释行首标记（# // …），main 从设置同步
    this.delimiter = ','; // 当前分隔符（注释行整行文本拼接/解析用），main 打开文件时同步
    this.buildDom();
    this.bindEvents();
  }

  buildDom() {
    this.scroller = document.createElement('div');
    this.scroller.className = 'grid-scroll';
    this.scroller.tabIndex = 0;
    this.canvas = document.createElement('div');
    this.canvas.className = 'grid-canvas';
    this.head = document.createElement('div');
    this.head.className = 'grid-head';
    this.rangeEl = document.createElement('div');
    this.rangeEl.className = 'grid-range';
    this.rangeEl.style.display = 'none';
    this.activeEl = document.createElement('div');
    this.activeEl.className = 'grid-active';
    this.activeEl.style.display = 'none';
    // 填充柄（M8）：选区右下角方块，渲染归 Grid，行为归 fill.js。
    this.handleEl = document.createElement('div');
    this.handleEl.className = 'fill-handle';
    this.handleEl.style.display = 'none';
    // 冻结区（M9b）：sticky 容器 + 区内覆盖层（选区/焦点/手柄各一套，随内容钉住）。
    this.frozenBox = document.createElement('div');
    this.frozenBox.className = 'grid-frozen';
    this.frozenBox.style.top = HEADER_H + 'px';
    this.rangeF = document.createElement('div');
    this.rangeF.className = 'grid-range';
    this.rangeF.style.display = 'none';
    this.activeF = document.createElement('div');
    this.activeF.className = 'grid-active';
    this.activeF.style.display = 'none';
    this.handleF = document.createElement('div');
    this.handleF.className = 'fill-handle';
    this.handleF.style.display = 'none';
    this.frozenBox.append(this.rangeF, this.activeF, this.handleF);
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'empty-hint';
    this.emptyEl.textContent = '打开 CSV 文件开始（工具栏“打开”，或把文件拖进来，或双击 csv 文件）';
    this.canvas.append(this.head, this.frozenBox, this.rangeEl, this.activeEl, this.handleEl);
    // 输入法靶子（key-sink）：一个隐形但**可聚焦**的 textarea，网格有焦点时它常驻焦点。
    // 为什么必须这么做：输入法（IME）只对「当前已聚焦的可编辑元素」生效。若焦点落在不可编辑的
    // scroller 上，用户按下的第一个拼音字母会被输入法当作普通按键放过去，形成孤立英文字母，
    // 后面的字母才开始组字——这正是"首字母进不了输入法"的根因。
    // 解决：让焦点常驻可编辑元素，输入法从第一个键起就有目标。
    // display:none / visibility:hidden 的元素**拿不到焦点**，所以用 1px + opacity:0 藏起来。
    this.keySink = document.createElement('textarea');
    this.keySink.className = 'key-sink';
    this.keySink.dataset.keysink = '1'; // 供剪贴板/快捷键判断"这是网格的按键接收器，不是用户的输入框"
    this.keySink.tabIndex = -1;
    this.keySink.spellcheck = false;
    this.keySink.setAttribute('aria-hidden', 'true');
    // 焦点重定向：任何 scroller.focus() 实际都落到 key-sink（一处顶掉全部调用点）。
    this.scroller.addEventListener('focus', () => {
      if (document.activeElement !== this.keySink) this.keySink.focus({ preventScroll: true });
    });
    // 打进来的字符（含输入法组字结果）→ 作为初值进入编辑；取完即清空，避免攒字。
    this.keySink.addEventListener('input', (e) => {
      if (!e.isComposing) this.takeKeySink();
    });
    this.keySink.addEventListener('compositionend', () => this.takeKeySink());
    this.scroller.append(this.canvas, this.keySink);
    this.scroller.style.display = 'none';
    this.host.append(this.scroller, this.emptyEl);
    // 溢出提示（#9）：自绘 div（原生 title 字体不可控），跟系统字体。
    this.tipEl = document.createElement('div');
    this.tipEl.className = 'grid-tip';
    this.tipEl.style.display = 'none';
    document.body.append(this.tipEl);
    this.tipCell = null;
  }

  hideTip() {
    this.tipCell = null;
    if (this.tipEl) this.tipEl.style.display = 'none';
  }

  bindEvents() {
    this.scroller.addEventListener('scroll', () => {
      this.hideTip();
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = 0;
        this.renderRows();
        this.positionSel();
      });
    });
    this.scroller.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.scroller.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.scroller.addEventListener('keydown', (e) => this.onKeyDown(e));
    // 拖拽中鼠标可能离开网格：挂 window 上统一收尾。
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', () => this.endDrag());
    // 溢出省略的格悬停显示全文本（#9）；拖拽中不打扰。
    this.scroller.addEventListener('mousemove', (e) => {
      if (this.dragging) {
        this.hideTip();
        return;
      }
      const cell = e.target.closest?.('.gc');
      // 阈值 0：哪怕只遮 1px 也提示（scrollWidth/clientWidth 都是整数，无抖动误报）。
      if (!cell || !this.scroller.contains(cell) || cell.scrollWidth <= cell.clientWidth) {
        this.hideTip();
        return;
      }
      if (this.tipCell !== cell) {
        this.tipCell = cell;
        this.tipEl.textContent = cell.textContent;
        this.tipEl.style.display = '';
      }
      this.tipEl.style.left = (e.clientX + 12) + 'px';
      this.tipEl.style.top = (e.clientY + 16) + 'px';
    });
    this.scroller.addEventListener('mouseleave', () => this.hideTip());
    // 列头边缘悬停给改宽光标（#6 真修：必须设在目标格元素上——
    // 子元素自带的 CSS cursor（如 .gchead 的 pointer）永远盖掉从容器继承来的光标）。
    this.head.addEventListener('mousemove', (e) => {
      if (this.dragging) return;
      const hc = e.target.closest('.gchead');
      if (this._cursorHc && this._cursorHc !== hc) {
        this._cursorHc.style.cursor = '';
        this._cursorHc = null;
      }
      if (!hc || !this.head.contains(hc)) return;
      const c = +hc.dataset.c;
      const rect = hc.getBoundingClientRect();
      const nearR = e.clientX >= rect.right - EDGE_ZONE;
      const nearL = c > 0 && e.clientX <= rect.left + EDGE_ZONE;
      if (nearR || nearL) {
        hc.style.cursor = 'ew-resize';
        this._cursorHc = hc;
      }
    });
    this.head.addEventListener('mouseleave', () => {
      if (this._cursorHc) {
        this._cursorHc.style.cursor = '';
        this._cursorHc = null;
      }
    });
  }

  // ---------- 数据 ----------

  setData(rows) {
    this.rows = rows;
    this.nCols = 0;
    for (const r of rows) if (r.length > this.nCols) this.nCols = r.length;
    this.colW = new Array(this.nCols).fill(DEFAULT_COL_W);
    // 原始顺序 id（清除排序用；插入行按插入先后编号，删行不回收）。
    this._oi = new WeakMap();
    this._oiNext = 0;
    for (const r of rows) this._oi.set(r, this._oiNext++);
    this.sel = rows.length > 0 && this.nCols > 0 ? { ar: 0, ac: 0, fr: 0, fc: 0 } : null;
    this.extra = []; // 新数据上下文：多选区清掉
    this.scroller.scrollTop = 0;
    this.scroller.scrollLeft = 0;
    const empty = rows.length === 0;
    this.scroller.style.display = empty ? 'none' : '';
    this.emptyEl.style.display = empty ? '' : 'none';
    if (empty) this.emptyEl.textContent = '空文件';
    this.layout();
    this.render();
  }

  getStats() {
    return { rows: this.rows.length, cols: this.nCols };
  }

  // 筛选隐藏行（M9b）：重建索引 + 重绘。调用方（main）负责维护 hidden 集合内容。
  setHiddenRows(set) {
    this.hidden = set;
    this.layout();
    this.render();
  }

  // 显示开关（#6/#10）：改旗标即重绘，调用方（main）负责落盘。
  setCrosshair(on) {
    this.crosshair = !!on;
    this.render();
  }

  setZebra(on) {
    this.zebra = !!on;
    this.render();
  }

  // 实例行高（#8）：基准 × zoom；CSS --row-h 同步写 scroller，行高类样式跟它。
  rh() {
    return Math.max(18, Math.round(ROW_H * this.zoom));
  }

  setZoom(z) {
    z = Math.min(2, Math.max(0.7, +z || 1));
    if (z === this.zoom) return;
    this.zoom = z;
    this.scroller.style.setProperty('--row-h', this.rh() + 'px');
    this.layout();
    this.render();
  }

  // 表头行指定（会话态，不持久化）：钳制到 [0, rows.length]（==length 表示无表头）。
  setHeaderRow(r) {
    r = Number.isInteger(r) ? r : 0;
    this.headerRow = Math.max(0, Math.min(this.rows.length, r));
    this.layout();
    this.render();
  }

  // 取走 key-sink 里已产生的文本（普通打字或输入法提交的结果），作为编辑初值进入编辑；取完清空。
  // compositionend 之后还会跟一个 input 事件，靠"值为空即忽略"天然去重。
  takeKeySink() {
    const text = this.keySink.value;
    if (!text) return;
    this.keySink.value = '';
    if (!this.sel) return;
    this.hooks.onEditRequest?.(this.sel.fr, this.sel.fc, text);
  }

  // 冻结（只读）闸门：所有会改动数据的入口（编辑/删除/粘贴/填充/插删行列/排序/替换）
  // 先调这个；命中则调用方直接 return。this.locked 由 main.js 的「冻结」按钮切换
  // （未初始化即 undefined，按未冻结处理）。
  // 提示做了节流：连续按键时不会刷屏（默认 4s 的 toast 叠一屏很难看）。
  blockEdit(toast) {
    if (!this.locked) return false;
    const now = Date.now();
    if (!this._blockToastAt || now - this._blockToastAt > 1500) {
      this._blockToastAt = now;
      toast?.('已冻结（只读）：请先点工具栏的「冻结」按钮解冻，再编辑');
    }
    return true;
  }

  // 通栏注释行（内容推导：单字段 + 行首标记；结构操作不得破坏该不变量）。
  isComment(r) {
    return isCommentRow(this.rows[r], this.commentPrefixes);
  }

  // 注释行整行文本（显示/编辑/复制/回写统一入口）。
  commentText(r) {
    return commentLineText(this.rows[r], this.delimiter);
  }

  // 整行写入（注释行编辑用）：逐格算 diff；解析出的字段多于现有长度时补长。返回 cells 供撤销。
  writeRowFromLine(r, values) {
    const row = this.rows[r];
    if (!row) return [];
    const cells = [];
    const n = Math.max(row.length, values.length);
    for (let c = 0; c < n; c++) {
      const before = row[c] ?? '';
      const after = values[c] ?? '';
      if (before !== after) {
        cells.push({ r, c, before, after });
        while (row.length <= c) row.push('');
        row[c] = after;
      }
    }
    return cells;
  }

  // 全宽（通栏注释行用）。
  totalW() {
    let w = 0;
    for (const cw of this.colW) w += cw;
    return w;
  }

  // 表头模式开关（M9b）：首行加粗 + 冻结 + 排序排除（排序逻辑在 main）。
  setHeaderMode(on) {
    this.headerMode = !!on;
    this.layout();
    this.render();
  }

  colX(c) {
    let x = 0;
    for (let i = 0; i < c && i < this.colW.length; i++) x += this.colW[i];
    return x;
  }

  // 重建可见性索引（数据/筛选/表头/结构变化的唯一 choke 点；滚动/选区只读，不重建）。
  // frozenList：可见冻结行（绝对行号，有序，v1 最多首行）；bodyList：可见非冻结行（有序）；
  // visPos：绝对行→bodyList 下标（隐藏/冻结为 -1）。
  layout() {
    // 冻结行 = 表头行（headerMode 开且下标合法；注释行也可当表头，照样冻结通栏显示）。
    const frz = this.headerMode && this.headerRow >= 0 && this.headerRow < this.rows.length
      && !this.hidden.has(this.headerRow) ? this.headerRow : -1;
    this.frozenList = [];
    this.bodyList = [];
    this.visPos = new Int32Array(this.rows.length).fill(-1);
    for (let r = 0; r < this.rows.length; r++) {
      if (this.hidden.has(r)) continue;
      if (r === frz) this.frozenList.push(r);
      else {
        this.visPos[r] = this.bodyList.length;
        this.bodyList.push(r);
      }
    }
    const fh = this.frozenList.length * this.rh();
    let w = ROW_NUM_W;
    for (const cw of this.colW) w += cw;
    this.frozenBox.style.width = w + 'px';
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = HEADER_H + fh + this.bodyList.length * this.rh() + 'px';
  }

  frozenHeight() {
    return this.frozenList.length * this.rh();
  }

  // body 序位转画布 Y。
  bodyY(p) {
    return HEADER_H + this.frozenHeight() + p * this.rh();
  }

  // 绝对行区间切分为冻结段/滚动段（选区覆盖层与填充预览共用）。
  // frozen: {r1,r2,y,h}（冻结容器内坐标）；body: {p1,p2}（body 序位）。
  // 注：只覆盖已存在行；拖出末尾的扩展区预览不管（落点仍正确扩展），v1 简化。
  splitRows(r1, r2) {
    let f1 = -1, f2 = -1, fy = 0;
    for (let i = 0; i < this.frozenList.length; i++) {
      const r = this.frozenList[i];
      if (r < r1) continue;
      if (r > r2) break;
      if (f1 < 0) {
        f1 = r;
        fy = i * this.rh();
      }
      f2 = r;
    }
    let b1 = -1, b2 = -1;
    const end = Math.min(r2, this.rows.length - 1);
    for (let r = Math.max(0, r1); r <= end; r++) {
      const p = this.visPos[r];
      if (p >= 0) {
        if (b1 < 0) b1 = p;
        b2 = p;
      }
    }
    return {
      frozen: f1 >= 0 ? { r1: f1, r2: f2, y: fy, h: (f2 - f1 + 1) * this.rh() } : null,
      body: b1 >= 0 ? { p1: b1, p2: b2 } : null,
    };
  }

  // ---------- 渲染 ----------

  render() {
    this.hideTip();
    this.renderHeads();
    this.renderFrozen();
    this.renderRows();
    this.positionSel();
    this.renderExtra();
  }

  // 通栏注释单元格：一个 div 占满整宽，不按列拆（dataset.c=0，选中/编辑/查找走单格逻辑）。
  appendCommentCell(div, r) {
    const fr = this.sel ? this.sel.fr : -1;
    const fc = this.sel ? this.sel.fc : -1;
    const isHeader = this.headerMode && r === this.headerRow;
    const cell = document.createElement('div');
    cell.className = 'gc comment-row'
      + (isHeader ? ' header-cell' : '')
      + (this.crosshair && (r === fr || 0 === fc) ? ' cross' : '');
    cell.style.width = this.totalW() + 'px';
    cell.textContent = this.commentText(r);
    if (this.matchSet) {
      const k = r + ',0';
      if (k === this.matchCur) cell.classList.add('match-cur');
      else if (this.matchSet.has(k)) cell.classList.add('match');
    }
    cell.dataset.r = r;
    cell.dataset.c = 0;
    div.append(cell);
  }

  // 冻结行渲染（M9b）：行数极少，全量重建无压力；表头行加 header-cell 样式。
  renderFrozen() {
    this.frozenBox.querySelectorAll('.grid-frow').forEach((el) => el.remove());
    if (this.frozenList.length === 0) return;
    const range = this.normSel();
    const fr = this.sel ? this.sel.fr : -1;
    const fc = this.sel ? this.sel.fc : -1;
    const frag = document.createDocumentFragment();
    for (const r of this.frozenList) {
      const rowData = this.rows[r];
      const div = document.createElement('div');
      div.className = 'grid-frow';
      const num = document.createElement('div');
      num.className = 'grc' + (range && r >= range.r1 && r <= range.r2 ? ' row-active' : '')
        + (this.crosshair && r === fr ? ' cross-row' : '');
      num.textContent = r + 1;
      num.dataset.r = r;
      num.title = `第${r + 1}行（点击选整行）`;
      div.append(num);
      const isHeader = this.headerMode && r === this.headerRow;
      if (this.isComment(r)) {
        this.appendCommentCell(div, r);
      } else for (let c = 0; c < this.nCols; c++) {
        const cell = document.createElement('div');
        cell.className = 'gc' + (isHeader ? ' header-cell' : '')
          + (!isHeader && this.zebra && r % 2 === 1 ? ' zebra' : '')
          + (this.crosshair && (r === fr || c === fc) ? ' cross' : '');
        cell.style.width = this.colW[c] + 'px';
        const v = rowData[c] ?? '';
        cell.textContent = v;
        if (this.matchSet) {
          const k = r + ',' + c;
          if (k === this.matchCur) cell.classList.add('match-cur');
          else if (this.matchSet.has(k)) cell.classList.add('match');
        }
        cell.dataset.r = r;
        cell.dataset.c = c;
        div.append(cell);
      }
      frag.append(div);
    }
    this.frozenBox.append(frag);
  }

  renderHeads() {
    this.head.replaceChildren();
    const corner = document.createElement('div');
    corner.className = 'grid-corner';
    corner.title = '全选';
    this.head.append(corner);
    const range = this.normSel();
    const focusC = this.sel ? this.sel.fc : -1;
    for (let c = 0; c < this.nCols; c++) {
      const h = document.createElement('div');
      h.className = 'gchead' + (range && c >= range.c1 && c <= range.c2 ? ' col-active' : '')
        + (this.sortMark && this.sortMark.col === c ? ' sorted' : '')
        + (this.crosshair && c === focusC ? ' cross-col' : '');
      h.style.width = this.colW[c] + 'px';
      h.textContent = colName(c)
        + (this.sortMark && this.sortMark.col === c ? (this.sortMark.dir === 'desc' ? ' ▼' : ' ▲') : '');
      h.dataset.c = c;
      h.title = `${colName(c)}列（点击选整列，拖边缘改列宽，双击自适应）`;
      this.head.append(h);
    }
  }

  renderRows() {
    if (this.bodyList.length === 0) {
      // body 为空时清掉旧行（冻结行由 renderFrozen 管）。
      this.canvas.querySelectorAll('.grid-row').forEach((el) => el.remove());
      return;
    }
    const st = this.scroller.scrollTop;
    const vh = this.scroller.clientHeight || 600;
    const fh = this.frozenHeight();
    const first = Math.max(0, Math.floor((st - HEADER_H - fh) / this.rh()) - OVERSCAN);
    const count = Math.ceil(vh / this.rh()) + 1 + OVERSCAN * 2;
    const last = Math.min(this.bodyList.length - 1, first + count);
    const range = this.normSel();
    const fr = this.sel ? this.sel.fr : -1;
    const fc = this.sel ? this.sel.fc : -1;
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      const r = this.bodyList[i];
      const rowData = this.rows[r];
      const div = document.createElement('div');
      div.className = 'grid-row';
      div.style.top = this.bodyY(i) + 'px';
      const num = document.createElement('div');
      num.className = 'grc' + (range && r >= range.r1 && r <= range.r2 ? ' row-active' : '')
        + (this.crosshair && r === fr ? ' cross-row' : '');
      num.textContent = r + 1;
      num.dataset.r = r;
      num.title = `第${r + 1}行（点击选整行）`;
      div.append(num);
      if (this.isComment(r)) {
        this.appendCommentCell(div, r);
        frag.append(div);
        continue;
      }
      for (let c = 0; c < this.nCols; c++) {
        const cell = document.createElement('div');
        cell.className = 'gc'
          + (this.zebra && r % 2 === 1 ? ' zebra' : '')
          + (this.crosshair && (r === fr || c === fc) ? ' cross' : '');
        cell.style.width = this.colW[c] + 'px';
        const v = rowData[c] ?? '';
        cell.textContent = v;
        if (this.matchSet) {
          const k = r + ',' + c;
          if (k === this.matchCur) cell.classList.add('match-cur');
          else if (this.matchSet.has(k)) cell.classList.add('match');
        }
        cell.dataset.r = r;
        cell.dataset.c = c;
        div.append(cell);
      }
      frag.append(div);
    }
    // 行容器就是 canvas 本体：先清旧行（列头/覆盖层不受影响，各自独立元素）。
    this.canvas.querySelectorAll('.grid-row').forEach((el) => el.remove());
    this.canvas.append(frag);
  }

  // 选区覆盖层定位（不重建行，滚动时高频调用；冻结段/滚动段各一套 div）。
  positionSel() {
    const range = this.normSel();
    if (!range) {
      this.rangeEl.style.display = 'none';
      this.activeEl.style.display = 'none';
      this.handleEl.style.display = 'none';
      this.rangeF.style.display = 'none';
      this.activeF.style.display = 'none';
      this.handleF.style.display = 'none';
      return;
    }
    const x1 = ROW_NUM_W + this.colX(range.c1);
    const x2 = ROW_NUM_W + this.colX(range.c2 + 1);
    const w = x2 - x1;
    const split = this.splitRows(range.r1, range.r2);
    // 滚动段
    if (split.body) {
      this.rangeEl.style.display = '';
      this.rangeEl.style.left = x1 + 'px';
      this.rangeEl.style.top = this.bodyY(split.body.p1) + 'px';
      this.rangeEl.style.width = w + 'px';
      this.rangeEl.style.height = (split.body.p2 - split.body.p1 + 1) * this.rh() + 'px';
    } else {
      this.rangeEl.style.display = 'none';
    }
    // 冻结段（冻结容器内坐标）
    if (split.frozen) {
      const f = split.frozen;
      this.rangeF.style.display = '';
      this.rangeF.style.left = x1 + 'px';
      this.rangeF.style.top = f.y + 'px';
      this.rangeF.style.width = w + 'px';
      this.rangeF.style.height = f.h + 'px';
    } else {
      this.rangeF.style.display = 'none';
    }
    // 焦点格：落在哪个段显示哪个
    const fr = this.sel.fr;
    const fc = this.sel.fc;
    const fx = ROW_NUM_W + this.colX(fc);
    const fw = this.colW[fc];
    const fIdx = this.frozenList.indexOf(fr);
    const bodyP = fr >= 0 && fr < this.rows.length ? this.visPos[fr] : -1;
    if (fIdx >= 0) {
      this.activeF.style.display = '';
      this.activeF.style.left = fx + 'px';
      this.activeF.style.top = fIdx * this.rh() + 'px';
      this.activeF.style.width = fw + 'px';
      this.activeF.style.height = this.rh() + 'px';
      this.activeEl.style.display = 'none';
    } else if (bodyP >= 0) {
      this.activeEl.style.display = '';
      this.activeEl.style.left = fx + 'px';
      this.activeEl.style.top = this.bodyY(bodyP) + 'px';
      this.activeEl.style.width = fw + 'px';
      this.activeEl.style.height = this.rh() + 'px';
      this.activeF.style.display = 'none';
    } else {
      this.activeEl.style.display = 'none';
      this.activeF.style.display = 'none';
    }
    // 填充柄：跟随选区角（r2,c2）所在段
    const cr = range.r2;
    const hx = ROW_NUM_W + this.colX(range.c2 + 1) - 5;
    const cfi = this.frozenList.indexOf(cr);
    const cbp = cr >= 0 && cr < this.rows.length ? this.visPos[cr] : -1;
    if (cfi >= 0) {
      this.handleF.style.display = '';
      this.handleF.style.left = hx + 'px';
      this.handleF.style.top = (cfi * this.rh() + this.rh() - 5) + 'px';
      this.handleEl.style.display = 'none';
    } else if (cbp >= 0) {
      this.handleEl.style.display = '';
      this.handleEl.style.left = hx + 'px';
      this.handleEl.style.top = (this.bodyY(cbp) + this.rh() - 5) + 'px';
      this.handleF.style.display = 'none';
    } else {
      this.handleEl.style.display = 'none';
      this.handleF.style.display = 'none';
    }
  }

  // 规范化选区并钳制到数据范围内；无数据返回 null。
  normSel() {
    if (!this.sel || this.rows.length === 0 || this.nCols === 0) return null;
    const r1 = Math.max(0, Math.min(this.sel.ar, this.sel.fr));
    const r2 = Math.min(this.rows.length - 1, Math.max(this.sel.ar, this.sel.fr));
    const c1 = Math.max(0, Math.min(this.sel.ac, this.sel.fc));
    const c2 = Math.min(this.nCols - 1, Math.max(this.sel.ac, this.sel.fc));
    if (r2 < r1 || c2 < c1) return null;
    return { r1, c1, r2, c2 };
  }

  selectAll() {
    if (this.rows.length === 0 || this.nCols === 0) return;
    this.sel = { ar: 0, ac: 0, fr: this.rows.length - 1, fc: this.nCols - 1 };
    this.extra = [];
  }

  // 全选区列表：活动区 + 多选区（复制用；编辑类操作只读 normSel）。
  allRanges() {
    const out = [];
    const a = this.normSel();
    if (a) out.push(a);
    for (const x of this.extra) out.push(x);
    return out;
  }

  // Ctrl+单击切换单格多选区（#9）：已在 extra 里则摘掉；在活动区内则忽略（矩形无洞，
  // 避免复制重复）；否则新增。调用方直接 render 返回，不开拖选。
  toggleExtra(r, c) {
    const i = this.extra.findIndex((x) => x.r1 === r && x.c1 === c && x.r2 === r && x.c2 === c);
    if (i >= 0) {
      this.extra.splice(i, 1);
      return;
    }
    const a = this.normSel();
    if (a && r >= a.r1 && r <= a.r2 && c >= a.c1 && c <= a.c2) return;
    this.extra.push({ r1: r, c1: c, r2: r, c2: c });
  }

  clearExtra() {
    if (this.extra.length === 0) return false;
    this.extra = [];
    this.render();
    return true;
  }

  // 多选区覆盖层（#9）：数量少，全量重建；分 body/冻结两段挂。
  renderExtra() {
    this.canvas.querySelectorAll('.grid-range-extra').forEach((el) => el.remove());
    this.frozenBox.querySelectorAll('.grid-range-extra').forEach((el) => el.remove());
    if (this.extra.length === 0) return;
    const fragB = document.createDocumentFragment();
    const fragF = document.createDocumentFragment();
    for (const x of this.extra) {
      const x1 = ROW_NUM_W + this.colX(x.c1);
      const w = this.colX(x.c2 + 1) - this.colX(x.c1);
      const split = this.splitRows(x.r1, x.r2);
      if (split.body) {
        const d = document.createElement('div');
        d.className = 'grid-range grid-range-extra';
        d.style.left = x1 + 'px';
        d.style.top = this.bodyY(split.body.p1) + 'px';
        d.style.width = w + 'px';
        d.style.height = (split.body.p2 - split.body.p1 + 1) * this.rh() + 'px';
        fragB.append(d);
      }
      if (split.frozen) {
        const d = document.createElement('div');
        d.className = 'grid-range grid-range-extra';
        d.style.left = x1 + 'px';
        d.style.top = split.frozen.y + 'px';
        d.style.width = w + 'px';
        d.style.height = split.frozen.h + 'px';
        fragF.append(d);
      }
    }
    this.canvas.append(fragB);
    this.frozenBox.append(fragF);
  }

  // 写单个格（编辑提交用）；越界返回 false。
  setCell(r, c, v) {
    if (r < 0 || r >= this.rows.length || c < 0 || c >= this.nCols) return false;
    this.rows[r][c] = v;
    return true;
  }

  // 确保至少 nRows 行 × nCols 列（粘贴扩展用）；扩展后重算布局。
  // 注释行跳过补齐（保持单字段不变量；粘贴正文写进注释行是另一回事，写完它自然变数据行）。
  ensureSize(nRows, nCols) {
    let grown = false;
    while (this.nCols < nCols) {
      for (let i = 0; i < this.rows.length; i++) {
        if (!this.isComment(i)) this.rows[i].push('');
      }
      this.colW.push(DEFAULT_COL_W);
      this.nCols++;
      grown = true;
    }
    while (this.rows.length < nRows) {
      this.rows.push(new Array(this.nCols).fill(''));
      grown = true;
    }
    if (grown) this.layout();
    return grown;
  }

  // 清空选区（Delete/Backspace，M6；M7 上报 diff 供撤销，无实质修改时传 null）。
  clearSelection() {
    const range = this.normSel();
    if (!range) return;
    const cells = [];
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c <= range.c2; c++) {
        // ?? ''：参差/注释短行越界读到 undefined 不算修改，也不扩展数组。
        const before = this.rows[r][c] ?? '';
        if (before !== '') {
          cells.push({ r, c, before, after: '' });
          this.rows[r][c] = '';
        }
      }
    }
    this.hooks.onModify?.(cells.length > 0 ? { cells } : null);
    this.render();
  }

  // ---- 结构性修改（M9）：只改数据不 render，调用方负责 render + 入栈 ----

  tagOi(row) {
    this._oi.set(row, this._oiNext++);
  }

  insertRows(at, count) {
    at = Math.max(0, Math.min(this.rows.length, at));
    const made = insertBlankRows(this.rows, at, count, this.nCols);
    for (const r of made) this.tagOi(r);
    this.layout();
  }

  // 删行：返回快照 {index, rows}（行对象原样保留，供撤销插回；LIFO 下索引安全）。
  deleteRows(r1, r2) {
    r1 = Math.max(0, r1);
    r2 = Math.min(this.rows.length - 1, r2);
    if (r2 < r1) return { index: r1, rows: [] };
    const removed = removeRows(this.rows, r1, r2 - r1 + 1);
    this.layout();
    return { index: r1, rows: removed };
  }

  insertCols(at, count) {
    at = Math.max(0, Math.min(this.nCols, at));
    // 注释行保持单字段：先记下标，删掉刚插入的空位（否则长度>1 破坏注释不变量）。
    const commentIdx = [];
    for (let i = 0; i < this.rows.length; i++) {
      if (this.isComment(i)) commentIdx.push(i);
    }
    insertBlankCols(this.rows, at, count);
    for (const i of commentIdx) this.rows[i].splice(at, count);
    this.colW.splice(at, 0, ...new Array(count).fill(DEFAULT_COL_W));
    this.nCols += count;
    this.layout();
  }

  // 删列：返回快照 {index, count, perRow:[{row, values}]}（按行对象对齐，排序后撤销依然正确）。
  deleteCols(c1, c2) {
    c1 = Math.max(0, c1);
    c2 = Math.min(this.nCols - 1, c2);
    if (c2 < c1) return { index: c1, count: 0, perRow: [] };
    const vals = removeCols(this.rows, c1, c2 - c1 + 1);
    this.colW.splice(c1, c2 - c1 + 1);
    this.nCols -= c2 - c1 + 1;
    this.layout();
    return { index: c1, count: c2 - c1 + 1, perRow: this.rows.map((r, i) => ({ row: r, values: vals[i] })) };
  }

  // 恢复原始顺序（清除排序用；插入行按插入先后排最后）。
  restoreOriginalOrder() {
    const id = (r) => this._oi.get(r) ?? Infinity;
    this.rows.sort((a, b) => id(a) - id(b)); // Array.sort 稳定
    this.layout();
  }

  ensureVisible(r, c) {
    const sc = this.scroller;
    // 冻结可见行永远可见：跳过纵向滚动（横向照常）。
    const frozenVisible = this.headerMode && r === this.headerRow && !this.hidden.has(this.headerRow);
    if (!frozenVisible) {
      const p = r >= 0 && r < this.rows.length ? this.visPos[r] : -1;
      if (p < 0) return; // 隐藏行：不滚动
      const top = this.bodyY(p);
      if (top < sc.scrollTop + HEADER_H) sc.scrollTop = top - HEADER_H;
      else if (top + this.rh() > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + this.rh() - sc.clientHeight;
    }
    const left = ROW_NUM_W + this.colX(c);
    if (left < sc.scrollLeft + ROW_NUM_W) sc.scrollLeft = left - ROW_NUM_W;
    else if (left + this.colW[c] > sc.scrollLeft + sc.clientWidth) {
      sc.scrollLeft = left + this.colW[c] - sc.clientWidth;
    }
  }

  autoFit(c) {
    let max = 0;
    const sample = Math.min(this.rows.length, 200);
    for (let r = 0; r < sample; r++) {
      const v = this.rows[r][c] ?? '';
      if (v.length > max) max = v.length;
      if (max > 60) break; // 够宽了，不用再量
    }
    this.colW[c] = Math.max(MIN_COL_W, Math.min(MAX_COL_W, max * 8 + 18));
    this.layout();
    this.render();
  }

  // ---------- 鼠标 ----------

  onMouseDown(e) {
    if (e.button !== 0 || this.rows.length === 0) return;
    // 编辑框内的按下：不夺焦、不开拖选。
    // （否则冒泡到本函数 scroller.focus() 会让 textarea 失焦 → blur 提交，编辑中途被打断。）
    if (e.target.closest?.('.cell-editor')) {
      // textarea 上放行原生行为（点哪光标落哪、拖选文字）；框边缘等防默认夺焦。
      if (e.target.tagName !== 'TEXTAREA') e.preventDefault();
      return;
    }
    this.hideTip();
    this.scroller.focus({ preventScroll: true });
    const t = e.target;
    // 列头区：拐角=全选；左右边缘=改列宽（左边缘归前一列）；否则整列选中
    if (this.head.contains(t)) {
      const hc = t.closest('.gchead');
      if (!hc) {
        this.selectAll();
        this.render();
      } else {
        const c = +hc.dataset.c;
        const rect = hc.getBoundingClientRect();
        if (e.clientX >= rect.right - EDGE_ZONE) {
          this.startResize(c, e);
        } else if (c > 0 && e.clientX <= rect.left + EDGE_ZONE) {
          this.startResize(c - 1, e);
        } else {
          this.sel = { ar: 0, ac: c, fr: this.rows.length - 1, fc: c };
          this.beginSelect('cols', e);
          this.render();
        }
      }
      e.preventDefault();
      return;
    }
    const num = t.closest('.grc');
    if (num) {
      const r = +num.dataset.r;
      this.sel = { ar: r, ac: 0, fr: r, fc: this.nCols - 1 };
      this.beginSelect('rows', e);
      this.render();
      e.preventDefault();
      return;
    }
    const cell = t.closest('.gc');
    if (cell) {
      const r = +cell.dataset.r;
      const c = +cell.dataset.c;
      if (e.ctrlKey || e.metaKey) {
        // #9：Ctrl+单击切换多选区，不开拖选。
        this.toggleExtra(r, c);
        this.render();
        e.preventDefault();
        return;
      }
      // #4：同一格 400ms 内第二次按下 = 双击，直接进编辑（不开拖选，编辑框接管）。
      const now = Date.now();
      if (this.lastClick && this.lastClick.r === r && this.lastClick.c === c
          && now - this.lastClick.t < 400) {
        this.lastClick = null;
        this.hooks.onEditRequest?.(r, c, null);
        e.preventDefault();
        return;
      }
      this.lastClick = { r, c, t: now };
      if (e.shiftKey && this.sel) {
        this.sel.fr = r;
        this.sel.fc = c;
      } else {
        this.sel = { ar: r, ac: c, fr: r, fc: c };
      }
      this.beginSelect('cells', e);
      this.render();
      e.preventDefault();
      return;
    }
    // 点在空白处：保持选区不动。
  }

  startResize(c, e) {
    this.dragMode = 'resize';
    this.resizeCol = c;
    this.resizeStartX = e.clientX;
    this.resizeStartW = this.colW[c];
    this.dragging = true;
    this.scroller.style.cursor = 'ew-resize';
    // 拖拽中鼠标满屏跑：body 级锁光标（子类 cursor 会盖掉容器级的，只能 !important 压）。
    document.body.classList.add('col-dragging');
  }

  beginSelect(mode, e) {
    this.dragging = true;
    this.dragMode = mode;
    this.lastMouse = { x: e.clientX, y: e.clientY };
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = setInterval(() => this.autoScrollTick(), 50);
  }

  onMouseMove(e) {
    if (!this.dragging) return;
    this.lastMouse = { x: e.clientX, y: e.clientY };
    if (this.dragMode === 'resize') {
      const w = Math.max(MIN_COL_W, Math.min(MAX_COL_W, this.resizeStartW + e.clientX - this.resizeStartX));
      if (w !== this.colW[this.resizeCol]) {
        this.colW[this.resizeCol] = w;
        this.layout();
        this.render();
      }
      return;
    }
    // 拖选：按鼠标下的格子扩展 focus。
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    const cell = el.closest('.gc');
    const hc = el.closest('.gchead');
    const num = el.closest('.grc');
    if (this.dragMode === 'cells') {
      if (cell) {
        this.sel.fr = +cell.dataset.r;
        this.sel.fc = +cell.dataset.c;
      } else if (hc && this.head.contains(hc)) {
        this.sel.fc = +hc.dataset.c;
      } else if (num) {
        this.sel.fr = +num.dataset.r;
      } else {
        return;
      }
    } else if (this.dragMode === 'cols') {
      const target = hc && this.head.contains(hc) ? hc : cell;
      if (!target) return;
      this.sel.fc = +(target.dataset.c ?? this.sel.fc);
    } else if (this.dragMode === 'rows') {
      const target = num ?? cell;
      if (!target) return;
      this.sel.fr = +(target.dataset.r ?? this.sel.fr);
    }
    this.render();
  }

  endDrag() {
    if (!this.dragging) return;
    this.dragging = false;
    this.dragMode = null;
    this.scroller.style.cursor = '';
    document.body.classList.remove('col-dragging');
    if (this._cursorHc) {
      this._cursorHc.style.cursor = '';
      this._cursorHc = null;
    }
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
      this.autoTimer = 0;
    }
  }

  // 拖选中靠近视口边缘时自动滚动（Excel 既视感）。
  autoScrollTick() {
    if (!this.dragging || !this.lastMouse || this.dragMode === 'resize') return;
    const rect = this.scroller.getBoundingClientRect();
    const { x, y } = this.lastMouse;
    if (y < rect.top + AUTO_EDGE) this.scroller.scrollTop -= AUTO_STEP;
    else if (y > rect.bottom - AUTO_EDGE) this.scroller.scrollTop += AUTO_STEP;
    if (x < rect.left + AUTO_EDGE) this.scroller.scrollLeft -= AUTO_STEP;
    else if (x > rect.right - AUTO_EDGE) this.scroller.scrollLeft += AUTO_STEP;
  }

  onDblClick(e) {
    const hc = e.target.closest('.gchead');
    if (hc && this.head.contains(hc)) {
      // 双击边缘自动列宽（左边缘归前一列，与拖拽一致）。
      const c = +hc.dataset.c;
      const rect = hc.getBoundingClientRect();
      if (e.clientX >= rect.right - EDGE_ZONE) this.autoFit(c);
      else if (c > 0 && e.clientX <= rect.left + EDGE_ZONE) this.autoFit(c - 1);
      return;
    }
    // M6：双击数据格进入编辑（保留原值）。#4 自判已覆盖多数情况，这里是兜底。
    const cell = e.target.closest('.gc');
    if (cell) this.hooks.onEditRequest?.(+cell.dataset.r, +cell.dataset.c, null);
  }

  // ---------- 键盘 ----------

  onKeyDown(e) {
    if (!this.sel || this.rows.length === 0) return;
    // #9：Esc 先清多选区（有才吃掉，否则继续走别的分支）。
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && this.clearExtra()) {
      e.preventDefault();
      return;
    }
    // M7：Ctrl+Z 撤销，Ctrl+Y / Ctrl+Shift+Z 重做。
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      e.preventDefault();
      this.hooks.onUndo?.();
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey
        && ((e.key === 'y' || e.key === 'Y') || (e.key === 'Z' && e.shiftKey))) {
      e.preventDefault();
      this.hooks.onRedo?.();
      return;
    }
    // 行列快捷键（#3/#6）：Ctrl+I 下方插行 / Ctrl+U 上方插行 / Ctrl+J 右侧插列 / Ctrl+K 左侧插列。
    // 注：Ctrl+U 在 WebView2 是页面级（同 Ctrl+S 可拦截），若某环境被宿主吞掉再换键。
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'i' || e.key === 'I')) {
      e.preventDefault();
      this.hooks.onInsertRow?.(true);
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'u' || e.key === 'U')) {
      e.preventDefault();
      this.hooks.onInsertRow?.(false);
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'j' || e.key === 'J')) {
      e.preventDefault();
      this.hooks.onInsertCol?.(true);
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      this.hooks.onInsertCol?.(false);
      return;
    }
    // M6：F2 进入编辑；Delete 智能删除（整行/整列选中删行列，其余清内容，main 定）；Backspace 清内容。
    if ((e.key === 'F2' || e.key === 'Delete' || e.key === 'Backspace')
        && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (e.key === 'F2') this.hooks.onEditRequest?.(this.sel.fr, this.sel.fc, null);
      else if (e.key === 'Delete') this.hooks.onDeleteKey?.();
      else this.clearSelection();
      return;
    }
    // 可打印字符不再在这里处理：焦点常驻 key-sink（可编辑），字符会正常落进去，
    // 再由 input / compositionend 触发进入编辑——这样才能走输入法。见 buildDom 里 keySink 注释。
    const s = this.sel;
    const page = Math.max(1, Math.floor(this.scroller.clientHeight / this.rh()) - 1);
    const ext = e.shiftKey;
    // 落点隐藏时沿移动方向找最近可见行（筛选场景）；列无隐藏，直接钳制。
    const visRow = (r, dir) => {
      r = Math.max(0, Math.min(this.rows.length - 1, r));
      while (r >= 0 && r < this.rows.length && this.hidden.has(r)) r += dir;
      return Math.max(0, Math.min(this.rows.length - 1, r));
    };
    const move = (r, c, dr = 0) => {
      r = visRow(r, dr >= 0 ? 1 : -1);
      c = Math.max(0, Math.min(this.nCols - 1, c));
      if (ext) {
        s.fr = r;
        s.fc = c;
      } else {
        s.ar = s.fr = r;
        s.ac = s.fc = c;
      }
    };
    let handled = true;
    switch (e.key) {
      case 'ArrowUp': move(s.fr - 1, s.fc, -1); break;
      case 'ArrowDown': move(s.fr + 1, s.fc, 1); break;
      case 'ArrowLeft': move(s.fr, s.fc - 1, 0); break;
      case 'ArrowRight': move(s.fr, s.fc + 1, 0); break;
      case 'PageUp': move(s.fr - page, s.fc, -1); break;
      case 'PageDown': move(s.fr + page, s.fc, 1); break;
      case 'Home': e.ctrlKey ? move(0, 0, -1) : move(s.fr, 0, 0); break;
      case 'End': e.ctrlKey ? move(this.rows.length - 1, this.nCols - 1, 1) : move(s.fr, this.nCols - 1, 0); break;
      case 'a':
      case 'A':
        if (e.ctrlKey) this.selectAll();
        else handled = false;
        break;
      case 'Tab':
        move(s.fr, s.fc + (e.shiftKey ? -1 : 1));
        break;
      case 'Enter':
        move(s.fr + (e.shiftKey ? -1 : 1), s.fc);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      this.ensureVisible(s.fr, s.fc);
      this.render();
    }
  }
}
