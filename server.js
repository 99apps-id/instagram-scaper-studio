/**
 * Insta Scraper Studio — Web Dashboard Server
 * Security-hardened, license-aware, SSE telemetry, modular routes.
 * Mirrors google-maps-scrapper architecture.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getLicenseStatus,
  markOnboarded,
  activateLicenseOnline,
  deactivateLicense,
  loadLicenseState,
} from './lib/license.js';
import {
  WEBHOOK_PATH,
  CLAIM_PATH,
  verifySingapaySignature,
  fulfillPaymentLink,
  claimByReff,
  findLatestOrderAfter,
  paymentOptions,
  paymentStoreFile,
} from './lib/payment.js';
import { searchInstagramAccounts, fetchInstagramProfile } from './lib/instagram.js';
import { exportInstagramLeadsToExcel } from './lib/excel.js';
import {
  setSecurityHeaders,
  readJsonBody,
  safeStaticPath,
  csvCell,
  MAX_BODY_BYTES,
} from './lib/security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Path persistence session Instagram di folder data
const SESSION_FILE = process.env.INSTA_SESSION_FILE || path.join(__dirname, 'instagram_session.json');

// In-memory state
let instagramSession = { sessionId: null, csrfToken: null, userId: null };
let activeLeads = [];
let isScraping = false;
let sseClients = [];
let serverStartTime = Date.now();

// Muat sesi tersimpan saat server start
function loadPersistedSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (data && data.sessionId) {
        instagramSession = data;
        console.log('[Session] Sesi Instagram aktif dimuat dari penyimpanan persisten.');
      }
    }
  } catch (err) {
    console.warn('[Session] Gagal memuat sesi Instagram:', err.message);
  }
}
loadPersistedSession();

function savePersistedSession(sessionData) {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
    console.log('[Session] Sesi Instagram berhasil disimpan secara permanen.');
  } catch (err) {
    console.warn('[Session] Gagal menyimpan sesi:', err.message);
  }
}

// SSE broadcast with heartbeat
function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => {
    try { c.write(payload); } catch { /* disconnected */ }
  });
}

// Heartbeat interval
const HEARTBEAT_INTERVAL = setInterval(() => {
  broadcastSSE({ type: 'heartbeat', timestamp: Date.now() });
}, 25000);

// Server creation
const server = http.createServer(async (req, res) => {
  // Security headers on ALL responses
  setSecurityHeaders(res);

  let urlObj;
  try {
    urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }
  const pathname = urlObj.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ============================================================
  // HEALTH CHECK (with token for Electron anti-collision)
  // ============================================================
  if (pathname === '/api/health' && req.method === 'GET') {
    const lic = getLicenseStatus();
    const token = process.env.GMST_TOKEN || process.env.INSTA_TOKEN || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      leadsCount: activeLeads.length,
      token,
      hasSession: Boolean(instagramSession.sessionId),
      uptimeMs: Date.now() - serverStartTime,
      version: '0.1.0',
    }));
    return;
  }

  // ============================================================
  // SSE STREAM
  // ============================================================
  if (pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"connected"}\n\n');
    sseClients.push(res);
    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res);
    });
    return;
  }

  // ============================================================
  // SESSION COOKIE (Instagram login & persisten save)
  // ============================================================
  if (pathname === '/api/session' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      instagramSession = { ...instagramSession, ...payload };
      savePersistedSession(instagramSession);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, hasSession: Boolean(instagramSession.sessionId) }));
    } catch (err) {
      res.writeHead(err.status || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ============================================================
  // LEADS DATA
  // ============================================================
  if (pathname === '/api/leads' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ leads: activeLeads }));
    return;
  }

  // ============================================================
  // SCRAPE START (with rate limit guard & session verification)
  // ============================================================
  if (pathname === '/api/scrape/start' && req.method === 'POST') {
    const lic = getLicenseStatus();
    if (lic.blocked) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: lic.tampered
          ? 'Jam sistem tidak valid. Perbaiki tanggal & jam perangkat, atau aktivasi lisensi.'
          : 'Masa trial habis. Silakan aktivasi lisensi.',
        code: 'LICENSE_REQUIRED',
        license: { expired: lic.expired, daysLeft: lic.daysLeft }
      }));
      return;
    }
    if (isScraping) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Scraping sedang berjalan.' }));
      return;
    }

    try {
      const payload = await readJsonBody(req);
      const query = (payload.query || '').trim();
      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Query wajib diisi' }));
        return;
      }

      isScraping = true;
      activeLeads = []; // Reset leads for new scrape
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Scraping dimulai' }));
      broadcastSSE({ type: 'status', running: true, message: `Mencari akun untuk: ${query}` });

      // Background scraping job dengan Rate-Limit Guard & Adaptive Jitter
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
              // Rate-Limit Guard: Jitter alami 2.2 - 4.2 detik antar profil
              const delayMs = 2200 + Math.floor(Math.random() * 2000);
              await new Promise(r => setTimeout(r, delayMs));
            } catch (e) {
              broadcastSSE({ type: 'log', message: `Gagal ambil detail @${acc.username}: ${e.message}` });
            }
          }
        } catch (err) {
          broadcastSSE({ type: 'log', message: `Error search: ${err.message}` });
        } finally {
          isScraping = false;
          broadcastSSE({ type: 'status', running: false, finished: true, totalLeads: activeLeads.length });
        }
      })();
    } catch (err) {
      isScraping = false;
      res.writeHead(err.status || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ============================================================
  // EXPORT EXCEL
  // ============================================================
  if (pathname === '/api/export' && req.method === 'GET') {
    const lic = getLicenseStatus();
    if (lic.blocked) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Masa trial habis. Aktivasi untuk mengunduh data.',
        code: 'LICENSE_REQUIRED',
      }));
      return;
    }

    const tmpPath = path.join(__dirname, `Insta_Leads_${Date.now()}.xlsx`);
    try {
      await exportInstagramLeadsToExcel(activeLeads, tmpPath);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="Instagram_Leads_Analytics.xlsx"',
      });
      fs.createReadStream(tmpPath)
        .pipe(res)
        .on('finish', () => {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Gagal export: ${err.message}` }));
    }
    return;
  }

  // ============================================================
  // LICENSE ROUTES
  // ============================================================
  if (pathname === '/api/license/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getLicenseStatus()));
    return;
  }

  if (pathname === '/api/license/onboard' && req.method === 'POST') {
    try {
      await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, status: markOnboarded() }));
    } catch (err) {
      res.writeHead(err.status || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/api/license/deactivate' && req.method === 'POST') {
    try {
      await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, status: deactivateLicense() }));
    } catch (err) {
      res.writeHead(err.status || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/api/license/activate' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const serial = String(payload?.serial || '').trim();
      if (!serial) throw Object.assign(new Error('Kode aktivasi wajib diisi'), { status: 400 });
      const result = await activateLicenseOnline(serial);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(err.status || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, code: err.code || 'ACTIVATE_FAILED' }));
    }
    return;
  }

  // ============================================================
  // PAYMENT ROUTES (Singapay)
  // ============================================================
  if (pathname === '/api/payment/options' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    res.end(JSON.stringify({ currency: 'IDR', claimUrl: CLAIM_PATH, plans: paymentOptions() }));
    return;
  }

  if (pathname === '/api/payment/auto-activate' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const reff = String(payload?.reff || '').trim();
      const since = String(payload?.since || '').trim();

      let order = null;
      if (reff) {
        order = claimByReff(reff);
      } else if (since) {
        order = findLatestOrderAfter(since);
      }

      if (!order || !order.serial) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ found: false, message: 'Pembayaran belum ditemukan atau masih diproses' }));
        return;
      }

      const planOpts = { plan: order.plan || 'berbayar', durationDays: order.days || 1 };
      const activateRes = await activateLicenseOnline(order.serial, new Date(), planOpts);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        found: true,
        serial: order.serial,
        plan: order.plan,
        days: order.days,
        status: activateRes.status,
      }));
    } catch (err) {
      res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ found: false, error: err.message }));
    }
    return;
  }

  if (pathname === WEBHOOK_PATH && req.method === 'POST') {
    const secret = process.env.SINGAPAY_CLIENT_SECRET || '';
    if (!secret) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: 'Payment belum dikonfigurasi' }));
      return;
    }
    try {
      const rawBody = await new Promise((resolve, reject) => {
        let size = 0;
        let body = '';
        req.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            reject(Object.assign(new Error('Payload terlalu besar'), { status: 413 }));
            req.destroy();
            return;
          }
          body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
      });

      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;

      if (!verifySingapaySignature({ rawBody, headers, clientSecret: secret, endpointPath: pathname })) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Invalid signature' }));
        return;
      }

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Body JSON tidak valid' }));
        return;
      }

      const result = fulfillPaymentLink(payload);
      console.log(`[Payment] Fulfilled ${result.plan} ${result.serial} untuk ${result.email || '?'} (reff ${result.reff_no})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', plan: result.plan, days: result.days }));
    } catch (err) {
      const code = err.status === 422 ? 422 : 500;
      if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // ============================================================
  // STATIC FILE SERVING (path-traversal protected)
  // ============================================================
  const safePath = safeStaticPath(pathname, PUBLIC_DIR);
  if (!safePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
    const ext = path.extname(safePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
    });
    fs.createReadStream(safePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Insta Scraper Studio running at http://localhost:${PORT}`);
});
