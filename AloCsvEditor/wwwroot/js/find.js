// 查找替换（M9c）：纯搜索核可单测；UI 控制器经 initFind 挂接。
// 约定：只搜可见行（含表头行）；以格为单位匹配；上限 50000，超了 toast 并截断。
import { isNativeInputContext } from './dom.js';

const MATCH_LIMIT = 50000;

export function findMatches(rows, hidden, query, opts = {}) {
  const { regex = false, caseSensitive = false, limit = MATCH_LIMIT } = opts;
  const matches = [];
  if (!query) return { matches, capped: false };
  let re = null;
  if (regex) {
    try {
      re = new RegExp(query, caseSensitive ? 'g' : 'gi');
    } catch {
      const err = new Error('正则表达式无效');
      err.code = 'invalid-regex';
      throw err;
    }
  }
  const q = caseSensitive ? query : query.toLowerCase();
  let capped = false;
  outer:
  for (let r = 0; r < rows.length; r++) {
    if (hidden.has(r)) continue;
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const v = row[c] ?? '';
      let hit;
      if (re) {
        re.lastIndex = 0; // g 标记的 test 有状态，每次重置
        hit = re.test(v);
      } else {
        hit = (caseSensitive ? v : v.toLowerCase()).includes(q);
      }
      if (hit) {
        matches.push([r, c]);
        if (matches.length >= limit) {
          capped = true;
          break outer;
        }
      }
    }
  }
  return { matches, capped };
}

// 单格替换。all=false 只换首个匹配。
export function replaceInCell(value, query, repl, opts = {}) {
  const { regex = false, caseSensitive = false, all = false } = opts;
  const v = String(value ?? '');
  if (!query) return v;
  if (regex) {
    let re;
    try {
      re = new RegExp(query, (caseSensitive ? '' : 'i') + (all ? 'g' : ''));
    } catch {
      return v; // 调用方已校验，这里兜底原样返回
    }
    return v.replace(re, repl);
  }
  if (!caseSensitive) {
    if (all) return v.split(new RegExp(escapeReg(query), 'gi')).join(repl);
    const i = v.toLowerCase().indexOf(query.toLowerCase());
    if (i < 0) return v;
    return v.slice(0, i) + repl + v.slice(i + query.length);
  }
  if (all) return v.split(query).join(repl);
  return v.includes(query) ? v.replace(query, repl) : v;
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function initFind(ctx) {
  const { grid, toast, onModify } = ctx;
  const bar = document.getElementById('findbar');
  const input = document.getElementById('find-text');
  const count = document.getElementById('find-count');
  const replInput = document.getElementById('find-replace');
  const st = { matches: [], idx: -1 };

  const opts = () => ({
    regex: document.getElementById('find-regex').checked,
    caseSensitive: document.getElementById('find-case').checked,
  });

  function paint() {
    if (st.matches.length === 0) {
      count.textContent = input.value ? '无匹配' : '';
      return;
    }
    count.textContent = `${st.idx + 1} / ${st.matches.length}`;
  }

  function highlight() {
    grid.matchSet = st.matches.length > 0
      ? new Set(st.matches.map(([r, c]) => r + ',' + c)) : null;
    grid.matchCur = st.idx >= 0 ? st.matches[st.idx].join(',') : null;
  }

  function gotoMatch() {
    highlight();
    if (st.idx < 0) {
      grid.render();
      paint();
      return;
    }
    const [r, c] = st.matches[st.idx];
    grid.sel = { ar: r, ac: c, fr: r, fc: c };
    grid.ensureVisible(r, c);
    grid.render();
    paint();
  }

  function runSearch() {
    const q = input.value;
    if (!q) {
      st.matches = [];
      st.idx = -1;
      highlight();
      grid.render();
      paint();
      return;
    }
    let res;
    try {
      res = findMatches(grid.rows, grid.hidden, q, opts());
    } catch (e) {
      toast(e && e.code === 'invalid-regex' ? '正则表达式无效' : '查找失败');
      return;
    }
    st.matches = res.matches;
    st.idx = res.matches.length > 0 ? 0 : -1;
    if (res.capped) toast('匹配过多，只显示前 50000 个');
    gotoMatch();
  }

  // 数据变化后高亮失效（查询文本保留，回车重查）。rerender=false 时由调用方统一 render。
  function clearMarks(rerender = true) {
    st.matches = [];
    st.idx = -1;
    grid.matchSet = null;
    grid.matchCur = null;
    if (rerender) grid.render();
    paint();
  }

  function step(d) {
    if (st.matches.length === 0) {
      runSearch();
      return;
    }
    st.idx = (st.idx + d + st.matches.length) % st.matches.length;
    gotoMatch();
  }

  function replaceCurrent() {
    if (grid.blockEdit(toast)) return; // 冻结（只读）
    if (st.idx < 0) return;
    const [r, c] = st.matches[st.idx];
    const before = grid.rows[r]?.[c] ?? '';
    const nv = replaceInCell(before, input.value, replInput.value, { ...opts(), all: false });
    if (nv !== before) {
      grid.rows[r][c] = nv;
      onModify({ cells: [{ r, c, before, after: nv }] });
      grid.render();
    }
    // 重查并尽量停在同一格
    const q = input.value;
    if (!q) return;
    let res;
    try {
      res = findMatches(grid.rows, grid.hidden, q, opts());
    } catch {
      return;
    }
    st.matches = res.matches;
    st.idx = Math.max(0, res.matches.findIndex(([rr, cc]) => rr === r && cc === c));
    gotoMatch();
  }

  function replaceAll() {
    if (grid.blockEdit(toast)) return; // 冻结（只读）
    if (st.matches.length === 0) return;
    const q = input.value;
    const o = { ...opts(), all: true };
    const cells = [];
    const seen = new Set();
    for (const [r, c] of st.matches) {
      const k = r + ',' + c;
      if (seen.has(k)) continue;
      seen.add(k);
      const before = grid.rows[r]?.[c] ?? '';
      const nv = replaceInCell(before, q, replInput.value, o);
      if (nv !== before) {
        grid.rows[r][c] = nv;
        cells.push({ r, c, before, after: nv });
      }
    }
    if (cells.length > 0) {
      onModify({ cells });
      grid.render();
    }
    runSearch();
  }

  function open() {
    bar.hidden = false;
    // 单格选中非空值时预填（VSCode 行为）
    const s = grid.normSel();
    if (s && s.r1 === s.r2 && s.c1 === s.c2) {
      const v = grid.rows[s.r1]?.[s.c1] ?? '';
      if (v) input.value = v;
    }
    input.focus();
    input.select();
    runSearch();
  }

  function close() {
    if (bar.hidden) return;
    bar.hidden = true;
    clearMarks();
    grid.scroller.focus({ preventScroll: true });
  }

  document.getElementById('find-prev').addEventListener('click', () => step(-1));
  document.getElementById('find-next').addEventListener('click', () => step(1));
  document.getElementById('find-close').addEventListener('click', close);
  document.getElementById('find-rep-one').addEventListener('click', replaceCurrent);
  document.getElementById('find-rep-all').addEventListener('click', replaceAll);
  document.getElementById('find-case').addEventListener('change', runSearch);
  document.getElementById('find-regex').addEventListener('change', runSearch);
  input.addEventListener('input', () => {
    clearTimeout(input._t);
    input._t = setTimeout(runSearch, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(input._t);
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  replInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      replaceCurrent();
    } else if (e.key === 'Escape') {
      close();
    }
  });
  // 全局 Ctrl+F（编辑 textarea 里除外，由编辑器自己处理按键）。
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      // 用户输入框内不抢（编辑器/筛选框/查找框各有自己的处理）；但网格的 key-sink 不算输入框，
      // 否则会被提前 return 掉、Ctrl+F 落到 WebView2 的默认查找（系统搜索框）。
      if (isNativeInputContext(e.target)) return;
      e.preventDefault();
      open();
    }
  });

  return { open, close, clearMarks, runSearch };
}
