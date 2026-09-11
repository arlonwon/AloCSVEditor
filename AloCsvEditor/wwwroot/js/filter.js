// 筛选纯函数（M9b-2）：行匹配 + 隐藏集合计算，可单测。
// 约定：col=-1 表示全部列；匹配为大小写不敏感包含；空关键字不过滤。

export function rowMatches(row, text, col) {
  if (!text) return true;
  const q = text.toLowerCase();
  if (col < 0) {
    for (const v of row) {
      if (String(v ?? '').toLowerCase().includes(q)) return true;
    }
    return false;
  }
  return String(row[col] ?? '').toLowerCase().includes(q);
}

// 计算隐藏行集合。skipFirst：前 N 行永不隐藏（表头行，Excel 行为）。
export function computeHidden(rows, text, col, skipFirst = 0) {
  const hidden = new Set();
  if (!text) return hidden;
  for (let r = skipFirst; r < rows.length; r++) {
    if (!rowMatches(rows[r], text, col)) hidden.add(r);
  }
  return hidden;
}
