// 剪贴板：复制/剪切/粘贴，TSV 与 Excel 双向互通（DESIGN.md M6）。
// 核心读写是纯函数（rangeToTsv / writeBlock），事件层只做薄封装，便于 headless 验证。
import { parse } from './csv.js';

// 选区转 TSV（Excel 兼容引号规则：含制表/换行/引号才加引号）。
export function rangeToTsv(rows, r1, c1, r2, c2) {
  const out = [];
  for (let r = r1; r <= r2; r++) {
    const line = [];
    for (let c = c1; c <= c2; c++) line.push(tsvQuote(rows[r]?.[c] ?? ''));
    out.push(line.join('\t'));
  }
  return out.join('\r\n');
}

// 多区转 TSV（#9）：块之间空一行；调用方保证块互不全包含（Grid.toggleExtra 已避免常见重复）。
export function rangesToTsv(rows, ranges) {
  return ranges.map((x) => rangeToTsv(rows, x.r1, x.c1, x.r2, x.c2)).join('\r\n\r\n');
}

// 选区复制文本（注释行）：单区且为通栏注释行时直接拷原文（不带多余制表符）。
export function selectionCopyText(grid) {
  const ranges = grid.allRanges();
  if (ranges.length === 1) {
    const x = ranges[0];
    if (x.r1 === x.r2 && grid.isComment?.(x.r1)) return grid.commentText(x.r1);
  }
  return rangesToTsv(grid.rows, ranges);
}

// 超大粘贴确认阈值（格数；之前漏定义会导致粘贴监听直接抛错，本次补上）。
const BIG_PASTE_CELLS = 200000;

function tsvQuote(v) {
  const s = String(v ?? '');
  return s.includes('\t') || s.includes('\n') || s.includes('\r') || s.includes('"')
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

// 从 (r0,c0) 起写入文本块（TSV 解析），自动扩展行列。
// Excel 复制末尾自带换行导致的多余全空行会被去掉（与 Excel 粘贴行为一致）。
// 返回 {range, cells, grewRows, grewCols}；无有效内容返回 null。
// cells 只收录前后值不同的格（稀疏粘贴不膨胀撤销栈）。
export function writeBlock(grid, r0, c0, text) {
  const data = parse(text, '\t').rows;
  while (data.length > 0 && data[data.length - 1].every((v) => v === '')) data.pop();
  if (data.length === 0) return null;
  let nC = 0;
  for (const row of data) if (row.length > nC) nC = row.length;
  const prevRows = grid.rows.length;
  const prevCols = grid.nCols;
  grid.ensureSize(r0 + data.length, c0 + nC);
  const cells = [];
  for (let r = 0; r < data.length; r++) {
    for (let c = 0; c < nC; c++) {
      const before = grid.rows[r0 + r][c0 + c];
      const after = data[r][c] ?? '';
      if (before !== after) {
        grid.rows[r0 + r][c0 + c] = after;
        cells.push({ r: r0 + r, c: c0 + c, before, after });
      }
    }
  }
  return {
    range: { r1: r0, c1: c0, r2: r0 + data.length - 1, c2: c0 + nC - 1 },
    cells,
    grewRows: grid.rows.length - prevRows,
    grewCols: grid.nCols - prevCols,
  };
}

// 从焦点格粘贴文本（事件层与验证共用）：解析→写入→选中已写区域→上报修改。
export function pasteText(ctx, text) {
  const { grid, onModify } = ctx;
  const sel = grid.sel;
  if (!sel || grid.rows.length === 0 || !text) return false;
  const result = writeBlock(grid, sel.fr, sel.fc, text);
  if (!result) return false;
  const { range } = result;
  grid.sel = { ar: range.r1, ac: range.c1, fr: range.r2, fc: range.c2 };
  grid.ensureVisible(range.r2, range.c2);
  grid.render();
  // 无实质修改（值全同且无扩展）则不上栈，避免空转脏标记。
  const { cells, grewRows, grewCols } = result;
  onModify(cells.length > 0 || grewRows > 0 || grewCols > 0
    ? { cells, grewRows, grewCols } : null);
  return true;
}

export function initClipboard({ grid, editor, toast, onModify }) {
  document.addEventListener('copy', (e) => {
    if (editor.isEditing()) return; // 编辑中走原生行为
    if (grid.allRanges().length === 0) return;
    e.clipboardData.setData('text/plain', selectionCopyText(grid));
    e.preventDefault();
  });

  document.addEventListener('cut', (e) => {
    if (editor.isEditing()) return;
    if (grid.allRanges().length === 0) return;
    e.clipboardData.setData('text/plain', selectionCopyText(grid));
    e.preventDefault();
    // #9 决议：剪切只清空活动区（normSel），多选区保留。
    const range = grid.normSel();
    if (!range) return;
    const cells = [];
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c <= range.c2; c++) {
        if (grid.rows[r][c] !== '') {
          cells.push({ r, c, before: grid.rows[r][c], after: '' });
          grid.rows[r][c] = '';
        }
      }
    }
    grid.render();
    onModify(cells.length > 0 ? { cells } : null);
  });

  document.addEventListener('paste', (e) => {
    if (editor.isEditing()) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text || grid.rows.length === 0) return;
    e.preventDefault();
    // 粗略估算格数，超大先确认。
    const estRows = text.split('\n').length;
    const estCols = (text.split('\n', 1)[0] ?? '').split('\t').length;
    if (estRows * estCols > BIG_PASTE_CELLS) {
      if (!confirm(`粘贴约 ${estRows} 行 × ${estCols} 列，可能较慢，继续吗？`)) return;
    }
    pasteText({ grid, onModify }, text);
  });
}
