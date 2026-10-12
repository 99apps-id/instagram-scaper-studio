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
  validateSerial,
} from './lib/license.js';
import {
  WEBHOOK_PATH,
  CLAIM_PATH,
  verifySingapaySignature,
  fulfillPaymentLink,
  claimByReff,
  findLatestOrderAfter,
  normalizeLicenseEntries,
  normalizeRevoked,
  findPlanForSerial,
  paymentOptions,
  paymentStoreFile,
} from './lib/payment.js';
import { executeScrapePlan } from './lib/scrape-runner.js';

// NOTE: ./lib/excel.js (exceljs + rantai native unzipper) di-load LAZY saat
// export agar child server Electron tidak crash bila resolver asar gagal
// menemukan sub-dependensi (kasus: Cannot find module 'function-bind').
// Lihat lazyExportExcel() di handler /api/export.

// NOTE: ./lib/instagram.js (engine scraping Instagram) TIDAK diimpor statis.
// Ia di-load lazy oleh scrape-runner agar paket klien (ENGINE_MODE=client)
// dapat diedarkan TANPA file engine — hasil bedah tidak bisa scraping.
// Pola sama dengan GMST (lib/scraper.js).
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
const ENGINE_URL = (process.env.ENGINE_URL || '').replace(/\/+$/, '');
const ENGINE_ALLOWLIST_FILE = process.env.ENGINE_ALLOWLIST_FILE || null;

// Session & Dataset Persistence
const SESSION_FILE = process.env.INSTA_SESSION_FILE || path.join(__dirname, 'instagram_session.json');
const CLIENT_DATASET_FILE = process.env.INSTA_DATASET_FILE || path.join(__dirname, 'dataset.json');

let instagramSession = { sessionId: null, csrfToken: null, userId: null, cookies: null };
let activeLeads = [];
let seenUsernames = new Set();
let isScraping = false;
let currentScrapeJob = { abort: false, running: false };
let sseClients = [];
let serverStartTime = Date.now();
let clientSaveTimer = null;
let clientSaving = false;
// Cache hasil validasi sesi (TTL 5 menit) agar health-check tidak
// menghantam API Instagram setiap poll.
let sessionValidityCache = null; // { at, valid, reason }

async function getSessionValidity() {
  if (!instagramSession.sessionId) return { valid: false, reason: 'NO_SESSION' };
  const now = Date.now();
  if (sessionValidityCache && now - sessionValidityCache.at < 5 * 60 * 1000) {
    return { valid: sessionValidityCache.valid, reason: sessionValidityCache.reason };
  }
  try {
    const engine = await import('./lib/instagram.js');
    const r = await engine.validateSession(instagramSession);
    sessionValidityCache = { at: now, valid: r.valid === true, reason: r.reason || null };
  } catch {
    sessionValidityCache = { at: now, valid: null, reason: 'ENGINE_MISSING' };
  }
  return { valid: sessionValidityCache.valid, reason: sessionValidityCache.reason };
}

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

// ---------------------------------------------------------------------------
// VPS ENGINE (ENGINE_MODE=engine): eksekusi scraping di server vendor.
// Klien paket (ENGINE_MODE=client) mem-proxy ke sini; engine & secret
// tidak pernah dikirim ke aplikasi yang diedarkan. Pola sama dengan GMST.
// ---------------------------------------------------------------------------

function readEngineAllowlist() {
  // Format: {"licenses":[... | {serial,plan,days} ...], "revoked":[...]}
  const candidates = [
    ENGINE_ALLOWLIST_FILE,
    path.join(__dirname, 'licenses.json'),
    process.env.LICENSE_ALLOWLIST || null,
    process.env.PAYMENT_STORE_FILE || null,
  ].filter(Boolean);
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) {
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (Array.isArray(data.licenses)) {
          const entries = normalizeLicenseEntries(data);
          return {
            licenses: new Set(entries.map((e) => e.serial)),
            revoked: normalizeRevoked(data),
            entries,
          };
        }
      }
    } catch { /* abaikan, lanjut kandidat berikut */ }
  }
  return null;
}

/** Durasi paket berbayar untuk serial (aktivasi perangkat ikut kedaluwarsa). */
function planDurationForSerial(serial) {
  const files = [
    process.env.PAYMENT_STORE_FILE || null,
    ENGINE_ALLOWLIST_FILE,
    path.join(__dirname, 'licenses.json'),
  ].filter(Boolean);
  const hit = findPlanForSerial(String(serial || '').trim().toUpperCase(), files);
  if (hit && hit.days) return { plan: hit.plan, durationDays: hit.days };
  return null;
}

function authorizeEngineSerial(serial) {
  const s = String(serial || '').trim();
  // Trial tanpa serial: diizinkan dengan caps ketat + rate limit (anti-abuse).
  if (!s) {
    if (process.env.ENGINE_REQUIRE_SERIAL === '1') {
      throw Object.assign(new Error('Aktivasi diperlukan untuk VPS engine.'), { status: 403, code: 'ENGINE_AUTH' });
    }
    return { trial: true, listed: false };
  }
  const check = validateSerial(s);
  if (!check.ok) {
    throw Object.assign(new Error(`Serial ditolak (${check.reason})`), { status: 403, code: 'ENGINE_AUTH' });
  }
  const needle = s.toUpperCase();
  const list = readEngineAllowlist();
  if (list) {
    if (list.revoked.has(needle)) {
      throw Object.assign(new Error('Serial telah dicabut (revoked).'), { status: 403, code: 'ENGINE_REVOKED' });
    }
    const strict = process.env.ENGINE_STRICT === '1';
    if (strict && !list.licenses.has(needle)) {
      throw Object.assign(new Error('Serial tidak terdaftar di VPS.'), { status: 403, code: 'ENGINE_NOT_LISTED' });
    }
    return { trial: false, listed: list.licenses.has(needle) };
  }
  return { trial: false, listed: true };
}

// Rate limit sederhana per IP untuk job trial (anti-abuse VPS).
const engineTrialHits = new Map();
function checkEngineTrialLimit(ip) {
  const maxPerHour = Math.max(1, parseInt(process.env.ENGINE_TRIAL_PER_HOUR || '5', 10) || 5);
  const now = Date.now();
  const rec = engineTrialHits.get(ip);
  if (!rec || now > rec.resetAt) {
    engineTrialHits.set(ip, { count: 1, resetAt: now + 3600 * 1000 });
    return true;
  }
  rec.count++;
  if (rec.count > maxPerHour) return false;
  if (engineTrialHits.size > 5000 && Math.random() < 0.01) {
    for (const [k, v] of engineTrialHits) if (now > v.resetAt) engineTrialHits.delete(k);
  }
  return true;
}

function engineClientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (/^[0-9a-fA-F:.]{3,45}$/.test(fwd)) return fwd;
  return req.socket?.remoteAddress || 'unknown';
}

// Proxy job klien -> VPS engine, teruskan event SSE-nya ke klien lokal.
async function proxyScrapeToEngine({ job }) {
  if (!ENGINE_URL) {
    throw Object.assign(new Error('ENGINE_URL belum dikonfigurasi di aplikasi ini.'), { status: 503, code: 'ENGINE_NO_URL' });
  }
  let licState = null;
  try { licState = loadLicenseState(); } catch { /* abaikan */ }
  const licNow = getLicenseStatus();
  const controller = new AbortController();
  const abortWatcher = setInterval(() => {
    if (currentScrapeJob?.abort) controller.abort();
  }, 500);

  try {
    const upstream = await fetch(`${ENGINE_URL}/api/engine/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serial: licState?.activated?.serial || '',
        installId: licNow.installId,
        job,
        // Sesi IG user diteruskan per-job (in-memory di VPS selama job
        // berjalan, tidak disimpan) — tanpa ini IP datacenter VPS
        // di-redirect Instagram (302) dan hasil selalu 0.
        // Sertakan cookie jar lengkap bila ada (penanda browser asli).
        session: instagramSession.sessionId ? {
          sessionId: instagramSession.sessionId,
          csrfToken: instagramSession.csrfToken || null,
          userId: instagramSession.userId || null,
          ...(instagramSession.cookies ? { cookies: instagramSession.cookies } : {}),
        } : null,
      }),
      signal: controller.signal,
    });
    if (!upstream.ok || !upstream.body) {
      let msg = `VPS engine menolak (${upstream.status})`;
      try {
        const data = JSON.parse(await upstream.text());
        if (data && data.error) msg = data.error;
      } catch { /* pakai pesan default */ }
      throw Object.assign(new Error(msg), { status: 502, code: 'ENGINE_UPSTREAM' });
    }

    broadcastSSE({ type: 'log', message: 'Terhubung ke VPS engine — query diproses di server.' });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const handleEvent = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (obj.type === 'lead' && obj.lead && obj.lead.username) {
        const uKey = String(obj.lead.username).toLowerCase();
        if (!seenUsernames.has(uKey)) {
          seenUsernames.add(uKey);
          activeLeads.push(obj.lead);
          scheduleDatasetSave();
        }
      }
      broadcastSSE(obj);
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          try { handleEvent(JSON.parse(t.slice(5).trim())); } catch { /* abaikan */ }
        }
      }
    }
  } finally {
    clearInterval(abortWatcher);
  }
}

// Eksekusi lokal via scrape-runner (lazy engine). Melempar ENGINE_MISSING
// 503 bila lib/instagram.js tidak ada di instalasi ini (paket klien).
async function runLocalScrapeJob({ query, deepMode }) {
  broadcastSSE({ type: 'status', running: true, message: `Mencari akun ${deepMode ? '(Deep Scan)' : ''} untuk: ${query}` });
  try {
    const { aborted } = await executeScrapePlan(
      { query, deepMode },
      {
        session: instagramSession,
        dataset: activeLeads,
        seen: seenUsernames,
        onLog: (message) => broadcastSSE({ type: 'log', message }),
        onLead: (lead, progress, message) => {
          scheduleDatasetSave();
          broadcastSSE({ type: 'lead', lead, progress, message });
        },
        shouldAbort: () => currentScrapeJob.abort,
      }
    );
    if (aborted) broadcastSSE({ type: 'log', message: 'Scraping dihentikan sebelum semua profil selesai.' });
  } catch (err) {
    broadcastSSE({ type: 'log', message: `Error search: ${err.message}` });
    if (err && (err.code === 'ENGINE_MISSING' || err.status === 503)) {
      broadcastSSE({ type: 'status', running: false, error: err.message, code: err.code });
      throw err;
    }
    if (err && (err.code === 'SESSION_EXPIRED' || err.status === 401)) {
      broadcastSSE({ type: 'status', running: false, error: err.message, code: 'SESSION_EXPIRED', sessionExpired: true });
    }
  } finally {
    currentScrapeJob.running = false;
    broadcastSSE({ type: 'status', running: false, finished: !currentScrapeJob.abort, totalLeads: activeLeads.length });
  }
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
    const token = process.env.INSTA_TOKEN || process.env.GMST_TOKEN || null;
    const lic = getLicenseStatus();
    const wantSessionCheck = urlObj.searchParams.get('session') === 'check';
    const sessionInfo = wantSessionCheck ? await getSessionValidity() : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      leadsCount: activeLeads.length,
      token,
      hasSession: Boolean(instagramSession.sessionId),
      // sessionValid: true | false | null (null = belum dicek / engine absen)
      sessionValid: sessionInfo ? sessionInfo.valid : (sessionValidityCache ? sessionValidityCache.valid : null),
      sessionReason: sessionInfo ? sessionInfo.reason : (sessionValidityCache ? sessionValidityCache.reason : null),
      scraping: Boolean(currentScrapeJob?.running),
      engineMode: ENGINE_MODE,
      uptimeMs: Date.now() - serverStartTime,
      version: '0.1.0',
      license: { activated: lic.activated, expired: lic.expired, blocked: lic.blocked, daysLeft: lic.daysLeft },
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
      sessionValidityCache = null; // reset cache validitas
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, hasSession: Boolean(instagramSession.sessionId) }));
    } catch (err) {
      res.writeHead(err.status || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Logout Instagram: hapus sesi tersimpan (file + memori) agar tidak
  // ada kredensial kedaluwarsa yang dipakai diam-diam.
  if (pathname === '/api/session' && req.method === 'DELETE') {
    try {
      instagramSession = { sessionId: null, csrfToken: null, userId: null, cookies: null };
      try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch {}
      sessionValidityCache = null;
      // Bersihkan juga cookie Electron bila tersedia
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, hasSession: false }));
      broadcastSSE({ type: 'status', running: false, message: 'Sesi Instagram diputus.' });
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

  // START SCRAPE — mode-aware (local / client-proxy / engine-only).
  // - local  : eksekusi via scrape-runner di mesin ini (butuh lib/instagram.js).
  // - client : paket publik — job di-proxy ke VPS engine, hasil di-relay via SSE.
  // - engine : VPS vendor — publik tidak boleh memicu dari sini.
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
      if (query.length > 120) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Query terlalu panjang (maks 120 karakter)' }));
        return;
      }

      currentScrapeJob = { abort: false, running: true };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Scraping dimulai',
        deepMode,
        engine: ENGINE_MODE === 'client' ? 'vps' : ENGINE_MODE,
      }));

      if (ENGINE_MODE === 'client') {
        // Mode aplikasi paket: eksekusi di VPS, hasil di-relay via SSE lokal.
        broadcastSSE({ type: 'status', running: true, message: `Menghubungkan ke VPS engine untuk: ${query}` });
        proxyScrapeToEngine({ job: { query, deepMode } })
          .catch((err) => {
            broadcastSSE({ type: 'log', message: `Error VPS engine: ${err.message}` });
            broadcastSSE({ type: 'status', running: false, error: err.message, code: err.code || 'ENGINE_FAILED' });
          })
          .finally(() => { currentScrapeJob.running = false; });
        return;
      }

      if (ENGINE_MODE === 'engine') {
        currentScrapeJob.running = false;
        broadcastSSE({ type: 'status', running: false });
        return;
      }

      // Mode local (dev & VPS-engine standalone): jalan di mesin ini.
      runLocalScrapeJob({ query, deepMode }).catch(() => {});
    } catch (err) {
      currentScrapeJob.running = false;
      if (!res.headersSent) {
        res.writeHead(err.status || 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, code: err.code || 'SCRAPE_FAILED' }));
      }
    }
    return;
  }

  // VPS ENGINE: verifikasi serial tanpa membocorkan daftar (jawab ya/tidak).
  //   GET /api/license/verify?serial=GMST-...  -> {valid:true|false}
  if (pathname === '/api/license/verify' && req.method === 'GET') {
    if (ENGINE_MODE !== 'engine') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Endpoint verifikasi hanya aktif di VPS engine.' }));
      return;
    }
    const serial = String(urlObj.searchParams.get('serial') || '').trim();
    let valid = false;
    let plan = null;
    let days = null;
    try {
      if (serial) {
        const auth = authorizeEngineSerial(serial);
        valid = true;
        if (!auth.trial) {
          const pd = planDurationForSerial(serial);
          if (pd) { plan = pd.plan; days = pd.durationDays; }
        }
      }
    } catch { valid = false; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ valid, plan, days }));
    return;
  }

  // VPS ENGINE RUN (hanya ENGINE_MODE=engine) — eksekusi di server vendor.
  if (pathname === '/api/engine/run' && req.method === 'POST') {
    if (ENGINE_MODE !== 'engine') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Engine tidak aktif di server ini.' }));
      return;
    }
    try {
      const payload = await readJsonBody(req);
      const serial = String(payload?.serial || '').trim();
      const auth = authorizeEngineSerial(serial);
      const rawJob = payload?.job || {};
      const query = String(rawJob.query || '').trim();
      const deepMode = Boolean(rawJob.deepMode);
      if (!query) throw Object.assign(new Error('Query wajib diisi'), { status: 400 });
      if (query.length > 120) throw Object.assign(new Error('Query terlalu panjang'), { status: 400 });

      const listed = auth.listed;
      if (!listed) {
        if (auth.trial) {
          const ip = engineClientIp(req);
          if (!checkEngineTrialLimit(ip)) {
            throw Object.assign(new Error('Batas trial VPS tercapai (maksimal 5 job/jam). Aktivasi untuk tanpa batas.'), { status: 429, code: 'ENGINE_RATE_LIMIT' });
          }
        }
      }

      // Sesi untuk job ini: prioritas sesi klien per-job (in-memory,
      // tidak disimpan), fallback ke sesi service VPS (INSTA_SESSION_FILE),
      // terakhir tanpa sesi (hasil dari IP datacenter biasanya dibatasi IG).
      const reqSession = payload?.session || {};
      const effSession = reqSession.sessionId
        ? {
            sessionId: reqSession.sessionId,
            csrfToken: reqSession.csrfToken || null,
            userId: reqSession.userId || null,
            ...(reqSession.cookies ? { cookies: reqSession.cookies } : {}),
          }
        : (instagramSession.sessionId ? { ...instagramSession } : {});
      const hasSession = Boolean(effSession.sessionId);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const send = (obj) => {
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* putus */ }
      };
      let aborted = false;
      req.on('close', () => { aborted = true; });

      const dataset = [];
      const seen = new Set();
      send({ type: 'status', running: true, message: `Mencari akun untuk: ${query}` });
      if (!hasSession) {
        send({ type: 'log', message: 'Mode tanpa sesi Instagram: hasil dari IP server dapat dibatasi (0 akun). Hubungkan akun IG di aplikasi untuk hasil penuh.' });
      }
      try {
        await executeScrapePlan(
          { query, deepMode },
          {
            session: effSession,
            dataset,
            seen,
            onLog: (message) => send({ type: 'log', message }),
            onLead: (lead, progress, message) => send({ type: 'lead', lead, progress, message }),
            shouldAbort: () => aborted,
          }
        );
        send({ type: 'status', running: false, finished: !aborted, totalLeads: dataset.length });
      } catch (err) {
        send({ type: 'log', message: `Error engine: ${err.message}` });
        send({
          type: 'status', running: false, error: err.message, code: err.code || 'ENGINE_FAILED',
          ...(err && (err.code === 'SESSION_EXPIRED' || err.status === 401) ? { sessionExpired: true } : {}),
        });
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) res.writeHead(err.status || 400, { 'Content-Type': 'application/json' });
      try { res.end(JSON.stringify({ error: err.message, code: err.code || 'ENGINE_FAILED' })); } catch { /* abaikan */ }
    }
    return;
  }

  // EXPORT DATA (XLSX, CSV, JSON)
  if (pathname === '/api/export' && req.method === 'GET') {
    const lic = getLicenseStatus();
    if (lic.blocked) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Masa trial habis. Aktivasi untuk mengunduh data.', code: 'LICENSE_REQUIRED' }));
      return;
    }

    const format = String(urlObj.searchParams.get('format') || 'xlsx').toLowerCase();
    const safeLabel = `Instagram_Leads_${Date.now()}`;

    if (format === 'csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeLabel}.csv"`,
      });
      res.write('\uFEFF'); // UTF-8 BOM
      res.write('No,Username,Nama Bisnis / Profil,Kategori,WhatsApp / Telepon,Email Bisnis,Followers,Following,Total Post,Engagement Rate (%),Rata-rata Likes,Rata-rata Komentar,Top Hashtags,Bio Lengkap,Website / Link Bio,URL Profil\n');

      activeLeads.forEach((item, idx) => {
        const line = [
          idx + 1,
          csvCell(item.username ? `@${item.username}` : ''),
          csvCell(item.fullName || ''),
          csvCell(item.category || ''),
          csvCell(item.phone || ''),
          csvCell(item.email || ''),
          item.followerCount || 0,
          item.followingCount || 0,
          item.totalPosts || 0,
          csvCell(item.engagementRate ? `${item.engagementRate}%` : '0%'),
          item.avgLikes || 0,
          item.avgComments || 0,
          csvCell(Array.isArray(item.topHashtags) ? item.topHashtags.join(', ') : ''),
          csvCell(item.biography || ''),
          csvCell(item.externalUrl || ''),
          csvCell(item.profileUrl || `https://www.instagram.com/${item.username}/`),
        ].join(',');
        res.write(line + '\n');
      });
      res.end();
      return;
    }

    if (format === 'json') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeLabel}.json"`,
      });
      res.end(JSON.stringify({ total: activeLeads.length, exportedAt: new Date().toISOString(), leads: activeLeads }, null, 2));
      return;
    }

    // Default XLSX (lazy-load exceljs agar startup server tidak bergantung
    // pada rantai dependensi berat unzipper/archiver di dalam asar)
    const tmpPath = path.join(os.tmpdir(), `${safeLabel}.xlsx`);
    try {
      const { exportInstagramLeadsToExcel } = await import('./lib/excel.js');
      await exportInstagramLeadsToExcel(activeLeads, tmpPath);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="Instagram_Leads_Analytics.xlsx"`,
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

      // Mode client (aplikasi terinstal): order hanya ada di VPS engine
      // (webhook Singapay terdaftar ke gmst.dewa.ai.id). Proxy polling
      // ke VPS agar auto-activate jalan tanpa input serial.
      if (ENGINE_MODE === 'client' && ENGINE_URL && !reff) {
        try {
          const upstream = await fetch(`${ENGINE_URL}/api/payment/auto-activate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ since: since || new Date(Date.now() - 10 * 60 * 1000).toISOString() }),
          });
          const data = await upstream.json().catch(() => ({}));
          if (data && data.found && data.serial) {
            const planOpts = { plan: data.plan || 'berbayar', durationDays: data.days || 1 };
            const activateRes = await activateLicenseOnline(data.serial, new Date(), planOpts);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              found: true,
              serial: data.serial,
              plan: data.plan,
              days: data.days,
              status: activateRes.status,
            }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ found: false, message: data.message || 'Pembayaran belum ditemukan atau masih diproses' }));
          return;
        } catch (proxyErr) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ found: false, message: `VPS belum merespons: ${proxyErr.message}` }));
          return;
        }
      }

      let order = null;
      if (reff) {
        order = claimByReff(reff);
        // Fallback: bila reff tidak ada lokal (mode client / dev tanpa
        // webhook), tanya VPS engine yang menerima webhook Singapay.
        if (!order && ENGINE_URL) {
          try {
            const upstream = await fetch(`${ENGINE_URL}/api/payment/auto-activate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reff }),
            });
            const data = await upstream.json().catch(() => ({}));
            if (data && data.found && data.serial) {
              order = { serial: data.serial, plan: data.plan, days: data.days };
            }
          } catch { /* abaikan, lanjut pesan tidak ditemukan */ }
        }
      } else if (since) {
        order = findLatestOrderAfter(since);
      }

      if (!order || !order.serial) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ found: false, message: 'Pembayaran belum ditemukan atau masih diproses. Jika sudah bayar, gunakan Nomor Referensi struk via tombol "Aktifkan via Ref".' }));
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

  // CLAIM PAGE: success_redirect_url payment link -> .../api/payment/claim?ref=REFF_NO
  if (pathname === CLAIM_PATH && req.method === 'GET') {
    const ref = String(urlObj.searchParams.get('ref') || '').trim();
    const escapeHtmlClaim = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    let inner;
    if (!ref) {
      inner = `<p>Masukkan nomor referensi pembayaran dari struk/kwitansi Singapay Anda:</p>
        <form method="GET" action="${CLAIM_PATH}">
          <input name="ref" placeholder="cth: 18917720251110094037705" autocomplete="off" />
          <button type="submit">Tampilkan Kode</button>
        </form>`;
    } else {
      const rec = claimByReff(ref);
      inner = rec
        ? `<p>Pembayaran terkonfirmasi (paket <b>${escapeHtmlClaim(rec.plan)}</b>, ${rec.days} hari).</p>
           <p>Kode aktivasi Anda:</p>
           <div class="serial">${escapeHtmlClaim(rec.serial)}</div>
           <p>Salin kode di atas ke aplikasi Insta Scraper Studio: menu Pengaturan → Lisensi → Aktivasi.</p>`
        : `<p class="missing">Referensi tidak ditemukan. Periksa kembali nomornya atau hubungi support@99apps.id.</p>
           <p><a href="${CLAIM_PATH}">← Coba lagi</a></p>`;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Klaim Kode Aktivasi Insta Scraper</title>
<style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;display:flex;justify-content:center;padding:2rem 1rem}main{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:1.5rem;max-width:440px;width:100%}h1{font-size:1.05rem}input{width:100%;padding:.55rem;border:1px solid #cbd5e1;border-radius:6px;font-size:.9rem;margin:.5rem 0}button{background:#0f172a;color:#fff;border:none;border-radius:6px;padding:.55rem 1rem;font-weight:700;cursor:pointer}.serial{font-family:monospace;font-size:1.25rem;font-weight:800;letter-spacing:.06em;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:.7rem;text-align:center;color:#047857}.missing{color:#be123c}a{color:#2563eb}</style>
</head><body><main><h1>Klaim Kode Aktivasi</h1>${inner}</main></body></html>`);
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
