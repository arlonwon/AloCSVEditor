// 撤销栈：history + 指针经典模型（DESIGN.md §6.11 / M7）。
// seq 单调递增、分支安全：新提交永远拿新号，undo 回到保存点即判定为干净。
// change 结构：{cells:[{r,c,before,after}], grewRows?, grewCols?}（粘贴扩展用）。
// 零 DOM 依赖：可被 Node 直接 import 跑单测。
export class UndoStack {
  constructor(limit = 200) {
    this.limit = limit;
    this.history = [];
    this.index = -1;
    this.seq = 0;
    this.savedSeq = 0;
  }

  get canUndo() {
    return this.index >= 0;
  }

  get canRedo() {
    return this.index + 1 < this.history.length;
  }

  currentSeq() {
    return this.index >= 0 ? this.history[this.index].seq : 0;
  }

  push(change) {
    // 新提交丢弃 redo 分支（Excel 同样语义）。
    this.history.length = this.index + 1;
    const entry = { seq: ++this.seq, change };
    this.history.push(entry);
    if (this.history.length > this.limit) this.history.shift();
    this.index = this.history.length - 1;
    return entry;
  }

  undo() {
    if (!this.canUndo) return null;
    return this.history[this.index--];
  }

  redo() {
    if (!this.canRedo) return null;
    return this.history[++this.index];
  }

  clear() {
    this.history.length = 0;
    this.index = -1;
  }

  markSaved() {
    this.savedSeq = this.currentSeq();
  }

  isDirty() {
    return this.currentSeq() !== this.savedSeq;
  }
}

// ---------- M9：排序与行列纯函数（DOM-free，可单测） ----------

// 格值比较（升序语义）：两边都是数字按数值，否则按中文 locale 字符串比。
// 返回负数/0/正数（供 sortRows 乘方向系数）。
export function compareCells(a, b) {
  const an = toNumber(a);
  const bn = toNumber(b);
  if (an !== null && bn !== null) return an - bn;
  return String(a).localeCompare(String(b), 'zh');
}

function toNumber(v) {
  const s = String(v ?? '').trim();
  return s !== '' && !Number.isNaN(Number(s)) ? Number(s) : null;
}

// 原地稳定排序（Array.sort 稳定，同键保持原相对顺序），返回 rows 方便链式。
export function sortRows(rows, col, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  rows.sort((ra, rb) => sign * compareCells(ra[col] ?? '', rb[col] ?? ''));
  return rows;
}

// 在 index 处插入 count 个空行（nCols 列），返回插入的行对象数组。
export function insertBlankRows(rows, index, count, nCols) {
  const made = [];
  for (let i = 0; i < count; i++) made.push(new Array(nCols).fill(''));
  rows.splice(index, 0, ...made);
  return made;
}

// 删除 [index, index+count) 行，返回删掉的行对象数组（原样保留，供撤销插回）。
export function removeRows(rows, index, count) {
  return rows.splice(index, count);
}

// 在 index 处插入 count 个空列。
export function insertBlankCols(rows, index, count) {
  for (const r of rows) r.splice(index, 0, ...new Array(count).fill(''));
}

// 删除 [index, index+count) 列，返回每行删掉的值（与行下标对齐）。
export function removeCols(rows, index, count) {
  return rows.map((r) => r.splice(index, count));
}
