// csv.js 单测（DESIGN.md §8.1）：node tools/csvtest/run.mjs
// 约定：全部通过退出码 0，有失败非 0。
import { parse, serialize, quoteIfNeeded } from '../../AloCsvEditor/wwwroot/js/csv.js';
import { rangeToTsv, rangesToTsv, writeBlock } from '../../AloCsvEditor/wwwroot/js/clipboard.js';
import { UndoStack } from '../../AloCsvEditor/wwwroot/js/commands.js';
import { fillValueAt, computeFill, findFillBoundary } from '../../AloCsvEditor/wwwroot/js/fill.js';
import {
  compareCells, sortRows, insertBlankRows, removeRows, insertBlankCols, removeCols,
} from '../../AloCsvEditor/wwwroot/js/commands.js';
import { rowMatches, computeHidden } from '../../AloCsvEditor/wwwroot/js/filter.js';
import { findMatches, replaceInCell } from '../../AloCsvEditor/wwwroot/js/find.js';

let failed = 0;
let passed = 0;

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function check(name, fn) {
  let ok = false;
  try {
    ok = fn() === true;
  } catch (e) {
    console.log('  EX: ' + (e && e.message));
  }
  if (ok) {
    passed++;
    console.log('PASS ' + name);
  } else {
    failed++;
    console.log('FAIL ' + name);
  }
}

// 基本逗号分隔
check('T01 basic', () =>
  eq(parse('a,b,c\n1,2,3\n').rows, [['a', 'b', 'c'], ['1', '2', '3']]));

// 引号内逗号
check('T02 quoted-comma', () => eq(parse('"a,b",c\n').rows, [['a,b', 'c']]));

// 引号内换行（含 CRLF 内嵌）
check('T03 quoted-newline', () => eq(parse('"a\nb",c\r\n').rows, [['a\nb', 'c']]));

// 转义引号
check('T04 escaped-quote', () => eq(parse('"a""b",c').rows, [['a"b', 'c']]));

// 空字段
check('T05 empty-fields', () => eq(parse('a,,c\n').rows, [['a', '', 'c']]));

// 空行保留为 [""]，末尾换行不产生多余行
check('T06 blank-lines', () => eq(parse('a\n\nb\n').rows, [['a'], [''], ['b']]));

// 末尾无换行
check('T07 no-trailing-nl', () => {
  const r = parse('a\nb');
  return eq(r.rows, [['a'], ['b']]) && r.endsWithNewline === false;
});

// 参差行补齐
check('T08 ragged-rows', () => {
  const r = parse('a,b\nc\n');
  return eq(r.rows, [['a', 'b'], ['c', '']]) && r.maxCols === 2;
});

// 普通字段里的裸引号是普通字符
check('T09 bare-quote-in-field', () => eq(parse('a"b,c\n').rows, [['a"b', 'c']]));

// 闭合引号后杂散字符：容错并入 + 计 warnings
check('T10 stray-after-quote', () => {
  const r = parse('"ab"cd,ef\n');
  return eq(r.rows, [['abcd', 'ef']]) && r.warnings === 1;
});

// 引号未闭合：容错收下剩余内容
check('T11 unclosed-quote', () => {
  const r = parse('"abc,def');
  return eq(r.rows, [['abc,def']]) && r.warnings === 1;
});

// 空文件
check('T12 empty-file', () => {
  const r = parse('');
  return eq(r.rows, []) && r.endsWithNewline === false;
});

// 仅一个换行：一个空行
check('T13 lone-newline', () => eq(parse('\n').rows, [['']]));

// 分号分隔
check('T14 semicolon', () => eq(parse('a;b\n1;2\n', ';').rows, [['a', 'b'], ['1', '2']]));

// Tab 分隔
check('T15 tab', () => eq(parse('a\tb\n', '\t').rows, [['a', 'b']]));

// roundtrip：解析→序列化→再解析，行数据一致
check('T16 roundtrip', () => {
  const src = 'name,note,num\r\n"a,b","x\ny",1\r\nplain,,3\r\n';
  const once = parse(src);
  const text2 = serialize(once.rows, { delimiter: ',', newline: '\r\n', trailingNewline: once.endsWithNewline });
  const twice = parse(text2);
  return eq(once.rows, twice.rows);
});

// 序列化引号策略
check('T17 serialize-quoting', () =>
  serialize([['a,b', 'c"d', 'e\nf', 'g', ' h ']]) === '"a,b","c""d","e\nf",g, h \r\n');

// 序列化空表
check('T18 serialize-empty', () => serialize([]) === '');

// 首尾空格不加引号
check('T19 spaces-not-quoted', () => quoteIfNeeded(' h ', ',') === ' h ');

// ---- M7：剪贴板纯函数 ----
check('T20 rangeToTsv', () => {
  const rows = [['a', 'b\tc', 'd"e', 'f\ng']];
  return rangeToTsv(rows, 0, 0, 0, 3) === 'a\t"b\tc"\t"d""e"\t"f\ng"';
});

// writeBlock 测试用假网格（只实现用到的最小接口）。
function fakeGrid(rows) {
  return {
    rows: rows.map((r) => [...r]),
    nCols: Math.max(...rows.map((r) => r.length)),
    colW: [],
    layout() {},
    ensureSize(nR, nC) {
      while (this.nCols < nC) {
        for (const r of this.rows) r.push('');
        this.colW.push(120);
        this.nCols++;
      }
      while (this.rows.length < nR) this.rows.push(new Array(this.nCols).fill(''));
    },
  };
}

check('T21 writeBlock-basic', () => {
  const g = fakeGrid([['a', 'b'], ['c', 'd']]);
  const res = writeBlock(g, 0, 0, 'x\ty\r\n');
  return res && eq(g.rows, [['x', 'y'], ['c', 'd']])
    && eq([res.range.r1, res.range.c1, res.range.r2, res.range.c2], [0, 0, 0, 1])
    && res.grewRows === 0 && res.grewCols === 0
    && res.cells.length === 2; // 只收录变化的格
});

check('T22 writeBlock-trailing-nl', () => {
  // Excel 复制末尾自带换行：多余全空行去掉，只写一行。
  const g = fakeGrid([['a', 'b'], ['c', 'd']]);
  const res = writeBlock(g, 1, 0, 'x\ty\r\n');
  return res && eq(g.rows, [['a', 'b'], ['x', 'y']]) && res.range.r2 === 1;
});

check('T23 writeBlock-grow', () => {
  const g = fakeGrid([['a']]);
  const res = writeBlock(g, 2, 1, 'p\tq\r\n');
  return res && g.rows.length === 3 && g.nCols === 3
    && g.rows[2][1] === 'p' && g.rows[2][2] === 'q'
    && res.grewRows === 2 && res.grewCols === 2;
});

// ---- M7：撤销栈 mechanics ----
check('T24 undo-basic-dirty', () => {
  const s = new UndoStack(200);
  const clean0 = !s.isDirty();
  s.push({ cells: [] });
  const dirty1 = s.isDirty();
  s.undo();
  const clean2 = !s.isDirty(); // 指针回到保存点即干净
  s.redo();
  const dirty3 = s.isDirty();
  return clean0 && dirty1 && clean2 && dirty3 && !s.canUndo === false;
});

check('T25 undo-branch', () => {
  const s = new UndoStack(200);
  s.push({ cells: [{ r: 0, c: 0, before: 'a', after: 'b' }] });
  s.push({ cells: [{ r: 0, c: 0, before: 'b', after: 'c' }] });
  s.undo();
  s.push({ cells: [{ r: 0, c: 0, before: 'b', after: 'X' }] }); // 分支：redo 应被丢弃
  return !s.canRedo && s.history.length === 2;
});

check('T26 undo-cap', () => {
  const s = new UndoStack(10);
  for (let i = 0; i < 15; i++) s.push({ cells: [] });
  let n = 0;
  while (s.canUndo) {
    s.undo();
    n++;
  }
  return s.history.length === 10 && n === 10;
});

check('T27 undo-markSaved', () => {
  const s = new UndoStack(200);
  s.push({ cells: [] });
  s.markSaved();
  const clean = !s.isDirty();
  s.push({ cells: [] });
  const dirty = s.isDirty();
  s.undo();
  s.undo();
  const cleanAgain = !s.isDirty(); // 回到空栈：seq 0 vs savedSeq 1？注意：保存点在 seq1，退到 0 仍是脏！
  return clean && dirty && !cleanAgain;
});

// ---- M8：填充纯函数 ----
check('T28 fill-single', () =>
  fillValueAt(['x'], 0) === 'x' && fillValueAt(['x'], 5) === 'x');

check('T29 fill-series', () =>
  fillValueAt(['1', '2'], 2) === '3'
  && fillValueAt(['1', '2'], 3) === '4'
  && fillValueAt(['0.1', '0.2'], 2) === '0.3'); // 浮点去抖

check('T30 fill-nonsense-cycle', () =>
  fillValueAt(['1', '2', '4'], 3) === '1' && fillValueAt(['1', '2', '4'], 4) === '2');

check('T31 fill-text-cycle', () =>
  fillValueAt(['a', 'b'], 2) === 'a' && fillValueAt(['a', 'b'], 3) === 'b');

check('T32 fill-up', () =>
  fillValueAt(['5', '7'], -1) === '3' && fillValueAt(['5', '7'], -2) === '1');

check('T33 fill-boundary', () => {
  const rows = [['h', 'v'], ['a', '1'], ['b', ''], ['', '']];
  const leftFirst = findFillBoundary(rows, 1, 0) === 2; // 左邻优先
  const rows2 = [['h', 'v', 'r'], ['', '1', 'x'], ['', '2', 'y'], ['', '', '']];
  const rightFallback = findFillBoundary(rows2, 1, 0) === 2; // 左邻无数据用右邻
  const rows3 = [['h', 'v'], ['a', '1']];
  const noneDo = findFillBoundary(rows3, 1, 1) === 1; // 已到底：无处可填
  return leftFirst && rightFallback && noneDo;
});

check('T34 compute-fill-block', () => {
  const g = [['h'], ['1'], ['2'], [''], ['']];
  const src = { r1: 1, c1: 0, r2: 2, c2: 0, get: (r, c) => g[r][c] };
  const out = computeFill(src, { r1: 1, c1: 0, r2: 4, c2: 0 });
  return eq(out.map((o) => o.value), ['1', '2', '3', '4']);
});

// ---- M9：排序与行列纯函数 ----
check('T35 compare-cells', () =>
  compareCells('10', '9') > 0 && compareCells('b', 'a') > 0
  && compareCells('', 'a') < 0 && compareCells('x', 'x') === 0);

check('T36 sort-rows', () => {
  const rows = [['b', '2'], ['a', '10'], ['c', '1'], ['a', '3']];
  sortRows(rows, 0, 'asc');
  const ascOk = eq(rows.map((r) => r[0]), ['a', 'a', 'b', 'c'])
    && eq(rows.map((r) => r[1]), ['10', '3', '2', '1']); // 同键稳定：a 行保持原相对顺序
  sortRows(rows, 1, 'desc');
  return ascOk && eq(rows.map((r) => r[1]), ['10', '3', '2', '1']);
});

check('T37 insert-remove-rows', () => {
  const rows = [['a'], ['b']];
  const made = insertBlankRows(rows, 1, 2, 1);
  const ok1 = eq(rows, [['a'], [''], [''], ['b']]) && made.length === 2;
  const removed = removeRows(rows, 1, 2);
  return ok1 && eq(rows, [['a'], ['b']]) && eq(removed, [[''], ['']]);
});

check('T38 insert-remove-cols', () => {
  const rows = [['a', 'b'], ['c', 'd']];
  insertBlankCols(rows, 1, 1);
  const ok1 = eq(rows, [['a', '', 'b'], ['c', '', 'd']]);
  const removed = removeCols(rows, 1, 1);
  return ok1 && eq(rows, [['a', 'b'], ['c', 'd']]) && eq(removed, [[''], ['']]);
});

// ---- M9b-2：筛选纯函数 ----
check('T39 row-matches', () =>
  rowMatches(['Abc', 'x'], 'bc', -1) === true // 大小写不敏感
  && rowMatches(['Abc', 'x'], 'bc', 1) === false // 指定列不含
  && rowMatches(['Abc', 'x'], '', 0) === true // 空关键字不过滤
  && rowMatches(['a'], 'z', -1) === false);

check('T40 compute-hidden', () => {
  const rows = [['h'], ['apple'], ['banana'], ['cherry']];
  const h1 = computeHidden(rows, 'an', -1, 1); // 跳过首行（表头）
  const ok1 = h1.size === 2 && h1.has(1) && h1.has(3);
  const h2 = computeHidden(rows, 'an', -1, 0); // 不跳过：首行 h 不含 an → 也隐藏
  const ok2 = h2.size === 3 && h2.has(0);
  const h3 = computeHidden(rows, '', -1, 0); // 空关键字：不过滤
  return ok1 && ok2 && h3.size === 0;
});

// ---- M9c：查找纯函数 ----
check('T41 find-basic', () => {
  const rows = [['abc', 'x'], ['def', 'ABC']];
  const r = findMatches(rows, new Set(), 'abc', {});
  return eq(r.matches, [[0, 0], [1, 1]]) && r.capped === false; // 大小写不敏感
});

check('T42 find-hidden-skip', () => {
  const rows = [['ax'], ['bx'], ['cx']];
  const r = findMatches(rows, new Set([1]), 'x', {});
  return eq(r.matches, [[0, 0], [2, 0]]);
});

check('T43 find-regex', () => {
  const rows = [['abc123'], ['def']];
  const r1 = findMatches(rows, new Set(), '\\d+', { regex: true });
  const ok1 = eq(r1.matches, [[0, 0]]);
  let threw = false;
  try {
    findMatches(rows, new Set(), '([', { regex: true });
  } catch (e) {
    threw = e && e.code === 'invalid-regex';
  }
  return ok1 && threw;
});

check('T44 replace-incell', () =>
  replaceInCell('aaa', 'a', 'b', { all: false }) === 'baa'
  && replaceInCell('aaa', 'a', 'b', { all: true }) === 'bbb'
  && replaceInCell('Abc', 'abc', 'x', {}) === 'x' // 大小写不敏感
  && replaceInCell('a1b2', '\\d', '#', { regex: true, all: true }) === 'a#b#');

// #9 多区复制：块之间空一行；单区退化为 rangeToTsv
check('T45 ranges-to-tsv', () => {
  const rows = [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']];
  const multi = rangesToTsv(rows, [
    { r1: 0, c1: 0, r2: 0, c2: 1 },
    { r1: 2, c1: 2, r2: 2, c2: 2 },
  ]);
  return multi === 'a\tb\r\n\r\ni'
    && rangesToTsv(rows, [{ r1: 1, c1: 0, r2: 1, c2: 2 }]) === 'd\te\tf';
});

// #7 尾巴数字递增：单格默认递增、补零保留、前缀一致多格等差、前缀不一/数字不在尾巴回落复制
check('T46 fill-trailing-num', () =>
  fillValueAt(['A001'], 1) === 'A002'
  && fillValueAt(['A001'], 3) === 'A004'
  && fillValueAt(['第3'], 2) === '第5'
  && fillValueAt(['A1', 'A2'], 3) === 'A4'
  && fillValueAt(['5'], 2) === '5' // 纯数字单格默认仍复制
  && fillValueAt(['A1', 'B2'], 2) === 'A1' // 前缀不一回落循环
  && fillValueAt(['第1周'], 2) === '第1周'); // 数字不在尾巴：复制（Excel 一致）

// #7 Ctrl 强制序列：单数字 +1 步进
check('T47 fill-force-seq', () =>
  fillValueAt(['5'], 0, true) === '5'
  && fillValueAt(['5'], 2, true) === '7'
  && fillValueAt(['A001'], 1, true) === 'A002');

// 性能基线：5 万行 × 20 列解析+序列化计时（只打印，不判失败）
{
  const cols = 20;
  const lines = [];
  for (let r = 0; r < 50000; r++) {
    const cells = [];
    for (let c = 0; c < cols; c++) cells.push(`r${r}c${c}`);
    lines.push(cells.join(','));
  }
  const big = lines.join('\r\n') + '\r\n';
  const t0 = Date.now();
  const pr = parse(big);
  const t1 = Date.now();
  serialize(pr.rows, { delimiter: ',', newline: '\r\n', trailingNewline: true });
  const t2 = Date.now();
  console.log(`PERF parse50k=${t1 - t0}ms serialize50k=${t2 - t1}ms rows=${pr.rows.length}`);
}

console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED (${passed} passed)`);
process.exit(failed === 0 ? 0 : 1);
