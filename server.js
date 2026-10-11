import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLicenseStatus, markOnboarded, activateLicenseOnline, deactivateLicense } from './lib/license.js';
import { WEBHOOK_PATH, CLAIM_PATH, verifySingapaySignature, fulfillPaymentLink, claimByReff, findLatestOrderAfter, paymentOptions } from './lib/payment.js';
import { searchInstagramAccounts, fetchInstagramProfile } from './lib/instagram.js';
import { exportInstagramLeadsToExcel } from './lib/excel.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const PUBLIC_DIR = path.join(__dirname, 'public');

let instagramSession = { sessionId: null, csrfToken: null, userId: null };
let activeLeads = [];
let isScraping = false;
let sseClients = [];

function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => c.write(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, leadsCount: activeLeads.length, token: process.env.GMST_TOKEN || null, hasSession: Boolean(instagramSession.sessionId) }));
    return;
  }

  // SSE Stream
  if (pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }

  // Set Session Cookie
  if (pathname === '/api/session' && req.method === 'POST') {
    const payload = await readJsonBody(req);
    instagramSession = { ...instagramSession, ...payload };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, hasSession: Boolean(instagramSession.sessionId) }));
    return;
  }

  // Ambil Leads
  if (pathname === '/api/leads' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ leads: activeLeads }));
    return;
  }

  // Start Scrape Instagram
  if (pathname === '/api/scrape/start' && req.method === 'POST') {
    const lic = getLicenseStatus();
    if (lic.blocked) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Masa trial habis. Silakan aktivasi lisensi.' }));
      return;
    }
    if (isScraping) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Scraping sedang berjalan.' }));
      return;
    }

    const payload = await readJsonBody(req);
    const query = (payload.query || '').trim();
    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Query wajib diisi' }));
      return;
    }

    isScraping = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Scraping dimulai' }));
    broadcastSSE({ type: 'status', running: true, message: `Mencari akun untuk: ${query}` });

    (async () => {
      try {
        const accounts = await searchInstagramAccounts(query, instagramSession);
        broadcastSSE({ type: 'log', message: `Ditemukan ${accounts.length} akun potensial. Mengambil profil & analitik...` });

        for (let i = 0; i < accounts.length; i++) {
          const acc = accounts[i];
          try {
            const detail = await fetchInstagramProfile(acc.username, instagramSession);
            activeLeads.push(detail);
            broadcastSSE({
              type: 'lead',
              lead: detail,
              progress: Math.round(((i + 1) / accounts.length) * 100),
              message: `[${i + 1}/${accounts.length}] Selesai analisa @${detail.username} (${detail.followerCount.toLocaleString()} followers)`
            });
            // Human-like delay 1.5 - 2.5 detik
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
          } catch (e) {
            broadcastSSE({ type: 'log', message: `Gagal ambil detail @${acc.username}: ${e.message}` });
          }
        }
      } catch (err) {
        broadcastSSE({ type: 'log', message: `Error search: ${err.message}` });
      } finally {
        isScraping = false;
        broadcastSSE({ type: 'status', running: false, finished: true });
      }
    })();
    return;
  }

  // Export Excel
  if (pathname === '/api/export' && req.method === 'GET') {
    const lic = getLicenseStatus();
    if (lic.blocked) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Lisensi diperlukan');
      return;
    }
    const tmp = path.join(__dirname, `Insta_Leads_${Date.now()}.xlsx`);
    await exportInstagramLeadsToExcel(activeLeads, tmp);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="Instagram_Leads_Analytics.xlsx"'
    });
    fs.createReadStream(tmp).pipe(res).on('finish', () => { try { fs.unlinkSync(tmp); } catch {} });
    return;
  }

  // Lisensi & Payment Endpoints
  if (pathname === '/api/license/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getLicenseStatus()));
    return;
  }
  if (pathname === '/api/license/onboard' && req.method === 'POST') {
    await readJsonBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, status: markOnboarded() }));
    return;
  }
  if (pathname === '/api/license/activate' && req.method === 'POST') {
    const p = await readJsonBody(req);
    const r = await activateLicenseOnline(p?.serial);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return;
  }
  if (pathname === '/api/license/deactivate' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, status: deactivateLicense() }));
    return;
  }
  if (pathname === '/api/payment/options' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ currency: 'IDR', claimUrl: CLAIM_PATH, plans: paymentOptions() }));
    return;
  }
  if (pathname === '/api/payment/auto-activate' && req.method === 'POST') {
    const p = await readJsonBody(req);
    let order = p.reff ? claimByReff(p.reff) : (p.since ? findLatestOrderAfter(p.since) : null);
    if (!order) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ found: false }));
      return;
    }
    const act = await activateLicenseOnline(order.serial, new Date(), { plan: order.plan, durationDays: order.days });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ found: true, plan: order.plan, days: order.days, status: act.status }));
    return;
  }

  // Webhook Singapay
  if (pathname === WEBHOOK_PATH && req.method === 'POST') {
    const secret = process.env.SINGAPAY_CLIENT_SECRET || '';
    if (!secret) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: 'Payment belum diset' }));
      return;
    }
    const raw = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
    if (!verifySingapaySignature({ rawBody: raw, headers, clientSecret: secret, endpointPath: pathname })) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: 'Invalid signature' }));
      return;
    }
    const resFul = fulfillPaymentLink(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', plan: resFul.plan, days: resFul.days }));
    return;
  }

  // Static File Serving
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Insta Scraper Studio running at http://localhost:${PORT}`);
});
