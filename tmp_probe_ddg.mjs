import { searchInstagramAccounts } from './lib/instagram.js';
import fs from 'node:fs';
const f = 'tmp_ddg.html';
try {
  await searchInstagramAccounts('kopi jakarta', { debugPath: f });
} catch (e) {
  console.log('ERR', e.message);
}
const html = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
console.log('saved', html.length);
console.log(html.slice(0, 1200));
