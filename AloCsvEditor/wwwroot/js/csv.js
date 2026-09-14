// CSV 解析器 + 序列化器（DESIGN.md §6.4：RFC 4180 + 容错）。
// 零 DOM 依赖：可被 Node 直接 import 跑单测（tools/csvtest/run.mjs）。

// 解析：状态机单遍扫描。
//   状态 0=字段开始，1=普通字段中，2=引号字段中，3=引号结束。
//   容错规则：引号未闭合/裸引号后杂散字符一律并入字段并计 warnings（Excel 式宽容，不丢数据）。
//   参差行按最大列数补 ""（注释行除外，见下）。
//   注释行（opts.commentPrefixes）：行首命中标记 → 整行收为单字段，分隔符不拆；
//   不参与补齐（保持长度 1，grid 凭"单字段+行首标记"推导注释性，无需额外状态）。
// 返回 {rows, maxCols, warnings, endsWithNewline}。
export function parse(text, delimiter = ',', opts = {}) {
  const commentPrefixes = opts.commentPrefixes ?? [];
  const rows = [];
  const commentIdx = new Set(); // 注释行下标：补齐时跳过
  let row = [];
  let field = '';
  let st = 0;
  let warnings = 0;
  let maxCols = 0;
  const n = text.length;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    rows.push(row);
    if (row.length > maxCols) maxCols = row.length;
    row = [];
  };
  // 换行结束当前字段+行，回到"字段开始"。
  const endRow = () => {
    pushField();
    pushRow();
    st = 0;
  };

  // 行首注释判定：st===0 且空字段空行 ⟺ 行首（分隔符后的空字段行非空，排除在外）。
  const tryCommentEnd = (i) => {
    for (const p of commentPrefixes) {
      if (p && text.startsWith(p, i)) {
        let j = i + p.length;
        while (j < n && text[j] !== '\n' && text[j] !== '\r') j++;
        return j;
      }
    }
    return -1;
  };

  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (st === 0) {
      if (field === '' && row.length === 0) {
        const j = tryCommentEnd(i);
        if (j >= 0) {
          // 整行收单字段，直接收行；消费一个换行（CRLF 算一个），EOF 则自然结束。
          field = text.slice(i, j);
          pushField();
          pushRow();
          commentIdx.add(rows.length - 1);
          if (text[j] === '\r' && text[j + 1] === '\n') i = j + 1;
          else if (text[j] === '\n' || text[j] === '\r') i = j;
          else i = j - 1;
          continue;
        }
      }
      if (ch === '"') {
        st = 2;
      } else if (ch === delimiter) {
        pushField();
      } else if (ch === '\r') {
        if (text[i + 1] === '\n') i++; // CRLF 算一个换行
        endRow();
      } else if (ch === '\n') {
        endRow();
      } else {
        field += ch;
        st = 1;
      }
    } else if (st === 1) {
      if (ch === delimiter) {
        pushField();
        st = 0;
      } else if (ch === '\r') {
        if (text[i + 1] === '\n') i++;
        endRow();
      } else if (ch === '\n') {
        endRow();
      } else {
        field += ch; // 普通字段里的引号是普通字符
      }
    } else if (st === 2) {
      if (ch === '"') {
        st = 3;
      } else {
        field += ch; // 引号内换行/分隔符都是内容
      }
    } else {
      // st === 3 引号结束
      if (ch === '"') {
        field += '"'; // 转义："" 表示一个引号
        st = 2;
      } else if (ch === delimiter) {
        pushField();
        st = 0;
      } else if (ch === '\r') {
        if (text[i + 1] === '\n') i++;
        endRow();
      } else if (ch === '\n') {
        endRow();
      } else {
        // 容错：闭合引号后紧跟杂散字符，并入字段。
        warnings++;
        field += ch;
        st = 1;
      }
    }
  }

  // 收尾：文件末尾的字段/行。引号未闭合也容错收下。
  if (st === 2 || st === 3) warnings += st === 2 ? 1 : 0;
  const endsWithNewline = n > 0 && (text[n - 1] === '\n' || text[n - 1] === '\r');
  // 文件以换行结尾时不产生额外空行：此时 st===0 且无待写内容。
  if (st !== 0 || field !== '' || row.length > 0) {
    pushField();
    pushRow();
  }

  // 参差行补齐到最大列数（注释行跳过，保持单字段不变量）。
  for (let i = 0; i < rows.length; i++) {
    if (commentIdx.has(i)) continue;
    while (rows[i].length < maxCols) rows[i].push('');
  }
  return { rows, maxCols, warnings, endsWithNewline };
}

// 行首标记判定（grid/排序/筛选共用）。
export function startsWithMarker(text, prefixes) {
  if (!prefixes) return false;
  for (const p of prefixes) {
    if (p && String(text ?? '').startsWith(p)) return true;
  }
  return false;
}

// 通栏注释行判定：首字段行首命中标记即成立（不要求单字段——用户在首列随时补标记，
// 该行立刻变注释行；解析产物本就是单字段）。内容推导，无额外状态。
export function isCommentRow(row, prefixes) {
  return Array.isArray(row) && startsWithMarker(row[0], prefixes);
}

// 注释行的显示/回写文本：整行按分隔符拼接（尾部空字段裁掉，避免 undo 残留多余逗号）。
// 语义：注释行是不透明整行文本，其内部的分隔符不再当分隔符用；取消注释时才重新解析。
export function commentLineText(row, delimiter = ',') {
  if (!Array.isArray(row)) return '';
  let end = row.length;
  while (end > 0 && String(row[end - 1] ?? '') === '') end--;
  return row.slice(0, end).map((f) => String(f ?? '')).join(delimiter);
}

// 注释行开关：已是注释行则去掉命中的那个前缀，否则在行首加上 prefixes[0]
//（注释字符取设置里的第一个，见 settings.commentPrefixes）。
// 返回“整行文本”：注释行是不透明单字段文本，取消注释后由调用方按分隔符重解析恢复多列。
export function toggleCommentText(row, prefixes, delimiter = ',') {
  const text = commentLineText(row, delimiter);
  if (isCommentRow(row, prefixes)) {
    for (const p of prefixes ?? []) {
      if (p && text.startsWith(p)) return text.slice(p.length);
    }
    return text;
  }
  const p = (prefixes && prefixes[0]) || '#';
  return p + text;
}

// 序列化引号策略（最小化 diff）：仅当字段含分隔符/引号/换行/回车时加引号，内部引号双写。
// 首尾空格不加引号（与 Excel 行为一致）。
export function quoteIfNeeded(value, delimiter) {
  const f = String(value ?? '');
  if (f.includes(delimiter) || f.includes('"') || f.includes('\n') || f.includes('\r')) {
    return '"' + f.replace(/"/g, '""') + '"';
  }
  return f;
}

export function serialize(rows, { delimiter = ',', newline = '\r\n', trailingNewline = true, commentPrefixes = [] } = {}) {
  if (rows.length === 0) return '';
  const body = rows.map((r) => {
    // 注释行整行原样回写（不加引号、不再拆分号）：它是不透明文本，重解析仍整行命中标记。
    if (isCommentRow(r, commentPrefixes)) return commentLineText(r, delimiter);
    return r.map((f) => quoteIfNeeded(f, delimiter)).join(delimiter);
  }).join(newline);
  return trailingNewline ? body + newline : body;
}
