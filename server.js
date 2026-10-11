/**
 * Insta Scraper Studio — Web Dashboard Server
 * Security-hardened, license-aware, SSE telemetry, modular routes.
 * Dataset Persistence & Deep Scraping Engine.
 * Selaras 100% dengan standar arsitektur GMST.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
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

const ENGINE_MODE = (process.env.ENGINE_MODE || 'local').toLowerCase();
const ENGINE_URL = (process.env.ENGINE_URL || 'https://gmst.dewa.ai.id').replace(/\/+$/, '');

// Session & Dataset Persistence
const SESSION_FILE = process.env.INSTA_SESSION_FILE || path.join(__dirname, 'instagram_session.json');
const CLIENT_DATASET_FILE = process.env.INSTA_DATASET_FILE || path.join(__dirname, 'dataset.json');

let instagramSession = { sessionId: null, csrfToken: null, userId: null };
let activeLeads = [];
let seenUsernames = new Set();
let isScraping = false;
let currentScrapeJob = { abort: false, running: false };
let sseClients = [];
let serverStartTime = Date.now();
let clientSaveTimer = null;
let clientSaving = false;

// Muat sesi Instagram tersimpan
function loadPersistedSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (data && data.sessionId) {
        instagramSession = data;
        console.log('[Session] Sesi Instagram aktif dimuat.');
      }
    }
  } catch (err) {
    console.warn('[Session] Gagal membaca sesi:', err.message);
  }
}
loadPersistedSession();

function savePersistedSession(sessionData) {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
    console.log('[Session] Sesi Instagram tersimpan.');
  } catch (err) {
    console.warn('[Session] Gagal menyimpan sesi:', err.message);
  }
}

// Muat dataset tersimpan
function loadPersistedDataset() {
  try {
    if (fs.existsSync(CLIENT_DATASET_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CLIENT_DATASET_FILE, 'utf8'));
      const records = Array.isArray(raw) ? raw : (raw.records || []);
      for (const item of records) {
        if (!item || !item.username) continue;
        const key = String(item.username).toLowerCase();
        if (!seenUsernames.has(key)) {
          seenUsernames.add(key);
          activeLeads.push(item);
        }
      }
      console.log(`[Dataset] Memuat ${activeLeads.length} leads dari arsip dataset lokal.`);
    }
  } catch (err) {
    console.warn('[Dataset] Gagal membaca dataset lokal:', err.message);
  }
}
loadPersistedDataset();

function scheduleDatasetSave() {
  if (clientSaving || clientSaveTimer) return;
  clientSaveTimer = setTimeout(() => {
    clientSaveTimer = null;
    clientSaving = true;
    try {
      fs.mkdirSync(path.dirname(CLIENT_DATASET_FILE), { recursive: true });
      fs.writeFileSync(CLIENT_DATASET_FILE, JSON.stringify({ savedAt: new Date().toISOString(), records: activeLeads }, null, 2));
    } catch (err) {
      console.warn('[Dataset] Gagal menyimpan dataset:', err.message);
    } finally {
      clientSaving = false;
    }
  }, 4000);
}

// SSE broadcast
function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => {
    try { c.write(payload); } catch {}
  });
}

// Heartbeat
setInterval(() => {
  broadcastSSE({ type: 'heartbeat', timestamp: Date.now() });
}, 25000);

const server = http.createServer(async (req, res) => {
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

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (pathname === '/api/health' && req.method === 'GET') {
    const token = process.env.GMST_TOKEN || process.env.INSTA_TOKEN || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      leadsCount: activeLeads.length,
      token,
      hasSession: Boolean(instagramSession.sessionId),
      engineMode: ENGINE_MODE,
      uptimeMs: Date.now() - serverStartTime,
      version: '0.1.0',
    }));
    return;
  }

  // SSE Stream
  if (pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"connected"}\n\n');
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }

  // Sesi Instagram
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

  // Leads Dataset
  if (pathname === '/api/leads' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ leads: activeLeads }));
    return;
  }

  // STOP SCRAPE
  if (pathname === '/api/scrape/stop' && req.method === 'POST') {
    currentScrapeJob.abort = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Scraping dihentikan.' }));
    broadcastSSE({ type: 'status', running: false, aborted: true, message: 'Scraping dihentikan oleh pengguna.' });
    return;
  }

  // START SCRAPE (Deep Scraping Engine dengan Rate Guard)
  if (pathname === '/api/scrape/start' && req.method === 'POST') {
    if (process.env.DISABLE_ENGINE === '1') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Modul scraping dinonaktifkan (integritas aplikasi tidak valid).', code: 'ENGINE_DISABLED' }));
      return;
    }

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

    if (currentScrapeJob.running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Tugas scraping lain sedang berjalan.' }));
      return;
    }

    try {
      const payload = await readJsonBody(req);
      const query = (payload.query || '').trim();
      const deepMode = Boolean(payload.deepMode);
      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Query wajib diisi' }));
        return;
      }

      currentScrapeJob = { abort: false, running: true };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Scraping dimulai', deepMode }));
      broadcastSSE({ type: 'status', running: true, message: `Mencari akun ${deepMode ? '(Deep Scan)' : ''} untuk: ${query}` });

      // Background scraping job
      (async () => {
        try {
          // Deep query expansion jika deepMode aktif
          const queries = [query];
          if (deepMode) {
            queries.push(`${query} official`, `${query} store`, `${query} business`);
          }

          let allCandidates = [];
          for (const q of queries) {
            if (currentScrapeJob.abort) break;
            try {
              const accs = await searchInstagramAccounts(q, instagramSession);
              allCandidates.push(...accs);
            } catch {}
          }

          // Dedup kandidat
          const uniqueAccounts = [];
          const seenCandidate = new Set();
          for (const a of allCandidates) {
            if (!a.username) continue;
            const u = a.username.toLowerCase();
            if (!seenCandidate.has(u)) {
              seenCandidate.add(u);
              uniqueAccounts.push(a);
            }
          }

          broadcastSSE({ type: 'log', message: `Ditemukan ${uniqueAccounts.length} akun potensial. Mengambil profil & kontak...` });

          for (let i = 0; i < uniqueAccounts.length; i++) {
            if (currentScrapeJob.abort) {
              broadcastSSE({ type: 'log', message: 'Scraping dihentikan sebelum semua profil selesai.' });
              break;
            }

            const acc = uniqueAccounts[i];
            try {
              const detail = await fetchInstagramProfile(acc.username, instagramSession);
              const uKey = detail.username.toLowerCase();
              if (!seenUsernames.has(uKey)) {
                seenUsernames.add(uKey);
                activeLeads.push(detail);
                scheduleDatasetSave();
              }

              broadcastSSE({
                type: 'lead',
                lead: detail,
                progress: Math.round(((i + 1) / uniqueAccounts.length) * 100),
                message: `[${i + 1}/${uniqueAccounts.length}] Selesai analisa @${detail.username} (${detail.followerCount.toLocaleString()} followers)`
              });

              // Rate-Limit Guard alami
              const delayMs = 2000 + Math.floor(Math.random() * 2000);
              await new Promise(r => setTimeout(r, delayMs));
            } catch (e) {
              broadcastSSE({ type: 'log', message: `Gagal ambil detail @${acc.username}: ${e.message}` });
            }
          }
        } catch (err) {
          broadcastSSE({ type: 'log', message: `Error search: ${err.message}` });
        } finally {
          currentScrapeJob.running = false;
          broadcastSSE({ type: 'status', running: false, finished: !currentScrapeJob.abort, totalLeads: activeLeads.length });
        }
      })();
    } catch (err) {
      currentScrapeJob.running = false;
      res.writeHead(err.status || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // EXPORT EXCEL
  if (pathname === '/api/export' && req.method === 'GET') {
    const lic = getLicenseStatus();
    if (lic.blocked) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Masa trial habis. Aktivasi untuk mengunduh data.', code: 'LICENSE_REQUIRED' }));
      return;
    }

    const tmpPath = path.join(os.tmpdir(), `Insta_Leads_${Date.now()}.xlsx`);
    try {
      await exportInstagramLeadsToExcel(activeLeads, tmpPath);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="Instagram_Leads_Analytics.xlsx"',
      });
      fs.createReadStream(tmpPath)
        .pipe(res)
        .on('finish', () => {
          try { fs.unlinkSync(tmpPath); } catch {}
        });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Gagal export: ${err.message}` }));
    }
    return;
  }

  // LICENSE ROUTES
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

  // PAYMENT ROUTES (Singapay)
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

  // Static File Serving
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
