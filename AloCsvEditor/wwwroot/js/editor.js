// 单元格编辑覆盖层（DESIGN.md M6）。
// 定位在 canvas 内随内容滚动；滚动/失焦自动提交（Excel 语义）。
// 与 Grid 解耦：经 grid.hooks.onEditRequest 进入，经 hooks.onCommit 上报修改。
import { HEADER_H, ROW_NUM_W } from './grid.js';

// 把点击坐标换算成 textarea 里的字符偏移。
// 浏览器不对 textarea 做字符级命中测试（caretRangeFromPoint 只返回到元素），
// 所以用一个同字体/同内边距/同宽度、换行方式也一致的隐形镜像 div 来量。
// 命中不到（点在文本外）返回 null，调用方不接管、交给浏览器默认行为。
function caretOffsetAt(ta, clientX, clientY) {
  const cs = getComputedStyle(ta);
  const r = ta.getBoundingClientRect();
  const mirror = document.createElement('div');
  // 两个关键点（实测）：
  //   ① 必须盖在最上层（编辑框 z-index:10）——否则 caretRangeFromPoint 命中的是编辑框本身；
  //   ② **不能用 pointer-events:none** —— caretRangeFromPoint 同样遵循它，加了就完全量不到。
  //      这里不存在误挡鼠标的风险：镜像在同一次同步调用里创建并移除，鼠标事件插不进来。
  mirror.style.cssText = 'position:fixed;opacity:0;overflow:hidden;z-index:2147483647;'
    + `left:${r.left}px;top:${r.top}px;width:${cs.width};height:${cs.height};`
    + `font:${cs.font};line-height:${cs.lineHeight};letter-spacing:${cs.letterSpacing};`
    + `padding:${cs.padding};border:${cs.border};box-sizing:${cs.boxSizing};`
    + `white-space:${cs.whiteSpace};word-wrap:${cs.wordWrap};overflow-wrap:${cs.overflowWrap};`;
  mirror.textContent = ta.value;
  document.body.append(mirror);
  let off = null;
  const cr = document.caretRangeFromPoint?.(clientX, clientY);
  if (cr && cr.startContainer && mirror.contains(cr.startContainer)) off = cr.startOffset;
  mirror.remove();
  return off;
}

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
    // 刚进编辑时（内容已全选）用户往往立刻点一下想落光标。这一下会被浏览器算作"三击"
    // （前两击是进入编辑的那次双击）→ 三击默认行为是"全选"，于是点来点去还是全选、光标进不去。
    // 处理：拦掉三击全选，直接用镜像量出点击处的字符偏移，把光标放过去（见 caretOffsetAt）。
    this.area.addEventListener('mousedown', (e) => {
      if (e.detail < 3) return;
      if (!this._openedAt || Date.now() - this._openedAt > 700) return; // 只针对"刚进编辑"的那种三击
      const pos = caretOffsetAt(this.area, e.clientX, e.clientY);
      if (pos == null) return;
      e.preventDefault();
      this.area.setSelectionRange(pos, pos);
    });
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
    // 注释行：强制 c=0，编辑的是"整行文本"（不拆分隔符），编辑框拉满整宽。
    const comment = g.isComment?.(r) ?? false;
    if (comment) c = 0;
    // #4：编辑框跟视觉位置——冻结行钉在冻结区（随首行钉住），隐藏行无视觉位置直接拒绝。
    const fi = g.frozenList.indexOf(r);
    const bp = fi < 0 ? g.visPos[r] : -1;
    if (fi < 0 && bp < 0) return;
    const parent = fi >= 0 ? g.frozenBox : g.canvas;
    if (this.box.parentNode !== parent) parent.append(this.box);
    const original = comment ? g.commentText(r) : (g.rows[r][c] ?? '');
    this.active = { r, c, original, wasComment: comment };
    this.box.style.display = '';
    this.box.style.left = ROW_NUM_W + g.colX(c) + 'px';
    this.box.style.top = (fi >= 0 ? fi * g.rh() : HEADER_H + g.frozenHeight() + bp * g.rh()) + 'px';
    this.box.style.minWidth = (comment ? g.colX(g.nCols) : g.colW[c]) + 'px';
    this.area.value = initial ?? original;
    this._openedAt = Date.now(); // 供 mousedown 判断"是不是刚进编辑就紧跟的三击"
    this.area.focus();
    // initial 非空 = 直接打字进来的（含输入法提交的整段文本）：光标落到末尾，后续字符追加。
    // initial 为空 = F2/双击：保留原值并全选，方便直接覆盖。
    if (initial == null) this.area.select();
    else this.area.setSelectionRange(this.area.value.length, this.area.value.length);
    this.autosize();
  }

  commit(move = 'none') {
    if (!this.active) return;
    const { r, c, original, wasComment } = this.active;
    let value = this.area.value;
    const isComment = wasComment || (this.grid.isComment?.(r) ?? false);
    // 注释行禁换行（整行文本单行不变量）：有换行消毒为空格并提示，消毒逻辑由调用方经 hooks 注入。
    if (isComment && /[\r\n]/.test(value)) {
      value = this.hooks.onSanitizeComment?.(value) ?? value.replace(/\r?\n/g, ' ');
    }
    this.active = null;
    this.box.style.display = 'none';
    if (value !== original) {
      let cells;
      if (isComment) {
        // 编辑的是整行文本：按分隔符重解析后逐格写回（＝取消注释即恢复多列；仍带标记则继续是注释行）。
        const values = this.hooks.parseLine?.(value) ?? [value];
        cells = this.grid.writeRowFromLine(r, values);
      } else if (this.grid.setCell(r, c, value)) {
        cells = [{ r, c, before: original, after: value }];
      }
      if (cells && cells.length) this.hooks.onCommit?.(cells);
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
