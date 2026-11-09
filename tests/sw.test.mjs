// 오프라인 저장 목록(sw.js PRECACHE)에 앱 파일이 빠지지 않았는지 확인.  실행: node tests/sw.test.mjs
// 빠지면 업데이트 직후 오프라인에서 앱을 열 때 그 파일을 못 불러와 화면이 안 뜹니다.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const block = (sw.match(/const PRECACHE = \[([\s\S]*?)\];/) || [])[1];
if (!block) { console.error('FAIL: PRECACHE list not found in sw.js'); process.exit(1); }
const listed = new Set(Array.from(block.matchAll(/'([^']+)'/g), (m) => m[1]));

const want = ['./', './index.html', './app.js', './style.css', './charts.css', './lock.css', './manifest.webmanifest']
  .concat(readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => './js/' + f))
  .concat(readdirSync(root).filter((f) => /^icon-.*\.png$/.test(f)).map((f) => './' + f));

let n = 0;
const missing = want.filter((f) => { n++; return !listed.has(f); });
const stale = Array.from(listed).filter((f) => f !== './' && !want.includes(f));
if (missing.length) { console.error('FAIL: not in sw.js PRECACHE: ' + missing.join(', ')); process.exit(1); }
if (stale.length) { console.error('FAIL: PRECACHE lists files that do not exist: ' + stale.join(', ')); process.exit(1); }
console.log('sw precache tests passed (' + n + ' files)');
