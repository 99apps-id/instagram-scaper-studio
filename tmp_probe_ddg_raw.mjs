import { fetchWithDoH } from './lib/instagram.js';
import fs from 'node:fs';
const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent('site:instagram.com kopi jakarta');
const res = await fetchWithDoH(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } });
const text = await res.text();
fs.writeFileSync('ig-debug.html', text);
console.log('status', res.status, 'len', text.length);
console.log(text.slice(0, 1200));
