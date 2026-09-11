// 单元格编辑覆盖层（DESIGN.md M6）。
// 定位在 canvas 内随内容滚动；滚动/失焦自动提交（Excel 语义）。
// 与 Grid 解耦：经 grid.hooks.onEditRequest 进入，经 hooks.onCommit 上报修改。
import { HEADER_H, ROW_NUM_W } from './grid.js';

export class Editor {
  constructor(grid, hooks = {}) {
    this.grid = grid;
    this.hooks = hooks; // {onCommit}
    this.active = null; // {r,c,original}
    this.box = document.createElement('div');
    this.box.className = 'cell-editor';
    this.box.style.display = 'none';
    this.area = document.createElement('textarea');
    this.area.setAttribute('rows', '1');
    this.area.spellcheck = false;
    this.box.append(this.area);
    grid.canvas.append(this.box);
    this.area.addEventListener('keydown', (e) => this.onKey(e));
    this.area.addEventListener('input', () => this.autosize());
    // 失焦/滚动直接提交（M6 简化语义：等同回车下移之外的"原地提交"）。
    this.area.addEventListener('blur', () => {
      if (this.active) this.commit('none');
    });
    grid.scroller.addEventListener('scroll', () => {
      // #4：冻结行编辑时滚动不提交（行钉在原地仍可见）；滚动段行照旧提交。
      if (this.active && !grid.frozenList.includes(this.active.r)) this.commit('none');
    });
  }

  isEditing() {
    return !!this.active;
  }

  // initial == null 表示保留原值进入编辑（F2/双击）；否则为替换用初始值（直接打字）。
  begin(r, c, initial) {
    const g = this.grid;
    if (this.active) this.commit('none');
    if (!g.rows[r] || c < 0 || c >= g.nCols) return;
    // #4：编辑框跟视觉位置——冻结行钉在冻结区（随首行钉住），隐藏行无视觉位置直接拒绝。
    const fi = g.frozenList.indexOf(r);
    const bp = fi < 0 ? g.visPos[r] : -1;
    if (fi < 0 && bp < 0) return;
    const parent = fi >= 0 ? g.frozenBox : g.canvas;
    if (this.box.parentNode !== parent) parent.append(this.box);
    this.active = { r, c, original: g.rows[r][c] ?? '' };
    this.box.style.display = '';
    this.box.style.left = ROW_NUM_W + g.colX(c) + 'px';
    this.box.style.top = (fi >= 0 ? fi * g.rh() : HEADER_H + g.frozenHeight() + bp * g.rh()) + 'px';
    this.box.style.minWidth = g.colW[c] + 'px';
    this.area.value = initial ?? this.active.original;
    this.area.focus();
    this.area.select();
    this.autosize();
  }

  commit(move = 'none') {
    if (!this.active) return;
    const { r, c, original } = this.active;
    const value = this.area.value;
    this.active = null;
    this.box.style.display = 'none';
    if (value !== original) {
      if (this.grid.setCell(r, c, value)) this.hooks.onCommit?.(r, c, original, value);
      this.grid.render();
    }
    this.grid.scroller.focus({ preventScroll: true });
    if (move !== 'none' && this.grid.sel) {
      const d = { down: [1, 0], up: [-1, 0], right: [0, 1], left: [0, -1] }[move];
      if (d) {
        const nr = Math.max(0, Math.min(this.grid.rows.length - 1, r + d[0]));
        const nc = Math.max(0, Math.min(this.grid.nCols - 1, c + d[1]));
        this.grid.sel = { ar: nr, ac: nc, fr: nr, fc: nc };
        this.grid.ensureVisible(nr, nc);
        this.grid.render();
      }
    }
  }

  cancel() {
    if (!this.active) return;
    this.active = null;
    this.box.style.display = 'none';
    this.grid.scroller.focus({ preventScroll: true });
  }

  onKey(e) {
    // 编辑框内按键一律截停，不冒泡到网格（否则方向键会同时移动选区）。
    e.stopPropagation();
    if (e.key === 'Enter' && !e.altKey) {
      e.preventDefault();
      this.commit(e.shiftKey ? 'up' : 'down');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.commit(e.shiftKey ? 'left' : 'right');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.cancel();
    }
    // Alt+Enter 换行走 textarea 默认行为；方向键走原生光标移动。
  }

  autosize() {
    this.area.style.height = 'auto';
    this.area.style.height = Math.min(140, Math.max(24, this.area.scrollHeight)) + 'px';
  }
}
