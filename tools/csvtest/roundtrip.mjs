// 保存链路 E2E 比对：node tools/csvtest/roundtrip.mjs <orig> <saved> [delimiter]
// 用同一解析器解析两边，比对行数据一致（字节允许最小引号规范化差异）。
import { readFileSync } from 'fs';
import { parse } from '../../AloCsvEditor/wwwroot/js/csv.js';

const [orig, saved, delim = ',', enc = 'utf-8'] = process.argv.slice(2);
if (!orig || !saved) {
  console.log('用法: node tools/csvtest/roundtrip.mjs <orig> <saved> [delimiter] [encoding]');
  process.exit(2);
}
const dec = new TextDecoder(enc);
const a = parse(dec.decode(readFileSync(orig)), delim).rows;
const b = parse(dec.decode(readFileSync(saved)), delim).rows;
const ok = JSON.stringify(a) === JSON.stringify(b);
console.log(ok ? 'ROUNDTRIP PASS' : 'ROUNDTRIP FAIL');
if (!ok) {
  console.log(`orig rows=${a.length} saved rows=${b.length}`);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
      console.log(`首个差异行 ${i}: orig=${JSON.stringify(a[i])} saved=${JSON.stringify(b[i])}`);
      break;
    }
  }
}
process.exit(ok ? 0 : 1);
