/**
 * Instagram Scraping Engine — Public Web API (no auth required for basic profile)
 * Rate-limit aware, session-aware, robust error handling.
 */
import fs from 'node:fs';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const INSTAGRAM_APP_ID = '936619743392459'; // Official Instagram Web App ID

// Rate limit tracking per session
const rateLimitState = new Map(); // sessionId -> { count, resetAt, challenged }

function getRateLimitKey(session) {
  return session.sessionId || 'anonymous';
}

function checkRateLimit(session, maxRequests = 30, windowMs = 60000) {
  const key = getRateLimitKey(session);
  const now = Date.now();
  const state = rateLimitState.get(key) || { count: 0, resetAt: now + windowMs, challenged: false };
  
  if (now > state.resetAt) {
    state.count = 0;
    state.resetAt = now + windowMs;
    state.challenged = false;
  }
  
  state.count++;
  rateLimitState.set(key, state);
  
  return {
    allowed: state.count <= maxRequests && !state.challenged,
    remaining: Math.max(0, maxRequests - state.count),
    retryAfter: state.challenged ? state.resetAt - now : 0
  };
}

function markChallenged(session) {
  const key = getRateLimitKey(session);
  const state = rateLimitState.get(key) || { count: 0, resetAt: Date.now() + 60000, challenged: false };
  state.challenged = true;
  state.resetAt = Date.now() + 300000; // 5 min cooldown after challenge
  rateLimitState.set(key, state);
}

export function buildHeaders(session, referer) {
  const headers = {
    'User-Agent': DEFAULT_USER_AGENT,
    'X-IG-App-ID': INSTAGRAM_APP_ID,
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': '*/*',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': referer || 'https://www.instagram.com/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };

  // Utamakan cookie jar lengkap dari browser (mid, ig_did, datr, ...).
  // Kuki parsial (hanya sessionid) mudah dinilai otomasi oleh IG.
  if (session.cookies) {
    headers['Cookie'] = session.cookies;
  } else if (session.sessionId) {
    const cookieParts = [];
    if (session.sessionId) cookieParts.push(`sessionid=${session.sessionId}`);
    if (session.csrfToken) cookieParts.push(`csrftoken=${session.csrfToken}`);
    if (session.userId) cookieParts.push(`ds_user_id=${session.userId}`);
    headers['Cookie'] = cookieParts.join('; ');
  }

  if (session.csrfToken) {
    headers['X-CSRFToken'] = session.csrfToken;
  }

  return headers;
}

async function fetchWithRetry(url, options, retries = 3, baseDelay = 1000) {
  let lastRetryAfterMs = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);

      // Rate limited: hormati Retry-After, backoff eksponensial
      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const waitMs = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1000 || 0, 120000)
          : Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 1000, 30000);
        lastRetryAfterMs = waitMs;
        try { await res.text().catch(() => {}); } catch {}
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw Object.assign(new Error('Instagram membatasi permintaan (429). Tunggu sejenak lalu coba lagi.'), { status: 429, code: 'RATE_LIMITED', retryAfter: waitMs });
      }

      // Challenge required (login wall)
      if (res.status === 400 || res.status === 403) {
        const text = await res.text();
        if (text.includes('challenge_required') || text.includes('login_required')) {
          throw Object.assign(new Error('CHALLENGE_REQUIRED'), { status: res.status, challenge: true });
        }
      }

      return res;
    } catch (err) {
      if (err && (err.status === 429 || err.code === 'RATE_LIMITED')) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, lastRetryAfterMs || baseDelay * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }
      if (attempt === retries) throw err;
      if (err.name === 'TypeError' && err.message.includes('fetch')) {
        // Network error, retry
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
        continue;
      }
      throw err;
    }
  }
  // Tidak terjangkau: semua percobaan habis tanpa respons valid
  throw Object.assign(new Error('Instagram membatasi permintaan (429). Tunggu sejenak lalu coba lagi.'), { status: 429, code: 'RATE_LIMITED', retryAfter: lastRetryAfterMs });
}

/**
 * Extract phone number from text (Indonesian format)
 */
export function extractPhoneNumber(text) {
  if (!text || typeof text !== 'string') return '';
  
  // Indonesian patterns: +62, 08, 02x (landline)
  const patterns = [
    /(\+62\s?[2-9]\d{1,2}[\s.-]?\d{3,4}[\s.-]?\d{3,5})/g,  // +62 xx xxxx xxxx
    /(08\d{1,2}[\s.-]?\d{3,4}[\s.-]?\d{3,5})/g,            // 08xx xxxx xxxx
    /(02\d{1}[\s.-]?\d{3,4}[\s.-]?\d{3,4})/g,               // 02x xxxx xxxx (landline)
    /(\(02\d{1}\)[\s.-]?\d{3,4}[\s.-]?\d{3,4})/g,           // (02x) xxxx xxxx
  ];
  
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      // Clean: keep only digits, normalize to 62 format
      let clean = matches[0].replace(/[^\d]/g, '');
      if (clean.startsWith('0')) clean = '62' + clean.slice(1);
      if (clean.startsWith('62') && clean.length >= 10 && clean.length <= 13) {
        return clean;
      }
    }
  }
  
  return '';
}

/**
 * Extract email from text
 */
export function extractEmail(text) {
  if (!text || typeof text !== 'string') return '';
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0].toLowerCase() : '';
}

/**
 * Calculate engagement rate from posts
 */
export function calculateEngagementRate(posts, followerCount) {
  if (!Array.isArray(posts) || posts.length === 0 || !followerCount || followerCount <= 0) {
    return { er: 0, avgLikes: 0, avgComments: 0, avgViews: 0 };
  }
  
  let totalLikes = 0;
  let totalComments = 0;
  let totalViews = 0;
  let videoCount = 0;
  
  posts.forEach(p => {
    totalLikes += (p.likeCount || 0);
    totalComments += (p.commentCount || 0);
    if (p.isVideo && p.viewCount) {
      totalViews += p.viewCount;
      videoCount++;
    }
  });
  
  const avgLikes = Math.round(totalLikes / posts.length);
  const avgComments = Math.round(totalComments / posts.length);
  const avgViews = videoCount > 0 ? Math.round(totalViews / videoCount) : 0;
  const er = Number((((avgLikes + avgComments) / followerCount) * 100).toFixed(2));
  
  return { er, avgLikes, avgComments, avgViews };
}

/**
 * Search Instagram accounts by keyword/hashtag.
 * API resmi butuh sesi login (tanpa sessionid -> HTTP 401 dari IG).
 * Fallback publik: DuckDuckGo html (site:instagram.com) agar tanpa login
 * tetap ada kandidat walau tanpa metrik follower.
 */
export async function searchInstagramAccounts(query, session = {}, debug = null) {
  const q = String(query || '').trim();
  const hasSession = Boolean(session.sessionId);

  if (hasSession) {
    try {
      return await searchViaOfficialApi(q, session);
    } catch (err) {
      // 401/403 = sesi kedaluwarsa -> lempar agar UI meminta login ulang
      if (err && (err.status === 401 || err.challenge)) {
        throw Object.assign(new Error('Sesi Instagram kedaluwarsa. Hubungkan ulang akun IG Anda.'), { status: 401, code: 'SESSION_EXPIRED' });
      }
      // 429 = rate limit -> fallback publik tetap dicoba
    }
  }
  return searchViaPublicFallback(q, debug);
}

async function searchViaOfficialApi(query, session) {
  const encQuery = encodeURIComponent(query);
  const url = `https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query=${encQuery}&include_reel=false`;

  const rl = checkRateLimit(session);
  if (!rl.allowed) {
    throw Object.assign(new Error('Rate limit exceeded. Please wait.'), { status: 429, retryAfter: rl.retryAfter });
  }

  const headers = buildHeaders(session, 'https://www.instagram.com/');
  const res = await fetchWithRetry(url, { headers });

  if (!res.ok) {
    if (res.status === 429) markChallenged(session);
    throw Object.assign(new Error(`Search failed HTTP ${res.status}`), { status: res.status });
  }

  const data = await res.json();

  const accounts = [];
  for (const item of (data.users || [])) {
    const u = item.user;
    if (u && u.username) {
      accounts.push({
        pk: u.pk,
        username: u.username,
        fullName: u.full_name || '',
        isVerified: Boolean(u.is_verified),
        profilePicUrl: u.profile_pic_url || '',
        isPrivate: Boolean(u.is_private),
        followerCount: u.follower_count || 0,
        via: 'api',
      });
    }
  }

  return accounts;
}

/** Fallback tanpa login: DuckDuckGo HTML site:instagram.com.
 * Pola doh-mcp: host di-resolve via DNS-over-HTTPS (Cloudflare/Google),
 * koneksi dial langsung ke IP hasil resolve agar blokir/poisoning DNS
 * sistem tidak menggagalkan fetch (kasus: html.duckduckgo.com NXDOMAIN). */
const DOH_RESOLVERS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
];

async function resolveViaDoH(host) {
  const errors = [];
  for (const endpoint of DOH_RESOLVERS) {
    try {
      const ips = await queryDoH(endpoint, host);
      if (ips.length > 0) return ips;
    } catch (e) {
      errors.push(`${endpoint}: ${e.message}`);
    }
  }
  throw new Error(`DoH resolve gagal untuk ${host} (${errors.join('; ')})`);
}

async function queryDoH(endpoint, host) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    let url;
    if (endpoint.includes('dns.google')) {
      url = `${endpoint}?name=${encodeURIComponent(host)}&type=A`;
    } else {
      url = `${endpoint}?name=${encodeURIComponent(host)}&type=A`;
    }
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/dns-json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ips = [];
    for (const a of (data.Answer || [])) {
      const ip = String(a.data || '').trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ips.includes(ip)) ips.push(ip);
    }
    return ips;
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetch dengan DoH ala doh-mcp: resolve host via DoH, dial TCP ke IP
 * hasil resolve dengan SNI hostname asli (TLS tetap valid).
 * Mengatasi DNS sistem yang memblokir/meracuni host tertentu.
 * Catatan: AbortSignal dari caller tidak diteruskan ke koneksi manual
 * (hanya dipakai untuk fetch normal) agar tidak ada abort prematur. */
export async function fetchWithDoH(url, options = {}, debug = null) {
  const { signal, ...noSignalOpts } = options || {};
  try {
    return await fetch(url, { ...options, signal });
  } catch (err) {
    if (debug) debug.directFail = String(err.message || err).slice(0, 80);
    const isDns = /fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo|no such host/i.test(err.message || String(err));
    if (!isDns) throw err;
  }
  const { lookup } = await import('node:dns/promises').catch(() => ({ lookup: null }));
  const u = new URL(url);
  // 1) Coba resolver sistem eksplisit via lookup (bypass cache proses)
  if (lookup) {
    try {
      const rec = await lookup(u.hostname, { all: true });
      if (rec && rec.length > 0) return fetch(url, noSignalOpts);
    } catch { /* lanjut ke DoH */ }
  }
  // 2) DoH resolve -> dial via undici dispatcher ke IP dengan SNI asli.
  // Node fetch tidak mendukung custom dialer; gunakan http(s) manual.
  const ips = await resolveViaDoH(u.hostname);
  if (debug) debug.dohIps = ips.slice(0, 3).join(',');
  const mod = u.protocol === 'https:' ? await import('node:https') : await import('node:http');
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  const path = u.pathname + u.search;
  let lastErr = null;
  for (const ip of ips.slice(0, 3)) {
    try {
      const text = await new Promise((resolve, reject) => {
        const req = mod.get({
          host: ip,
          port,
          path,
          servername: u.hostname,
          headers: { Host: u.hostname, ...(noSignalOpts.headers || {}) },
          timeout: 25000,
          rejectUnauthorized: true,
        }, (res) => {
          // Ikuti redirect 301/302/307/308 (wajib untuk DDG/Bing)
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            fetchWithDoH(new URL(res.headers.location, url).toString(), noSignalOpts)
              .then((r) => r.text().then(resolve, reject), reject);
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Pencarian publik gagal HTTP ${res.statusCode}`));
            res.resume();
            return;
          }
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve(body));
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', reject);
      });
      return new Response(text, { status: 200, headers: { 'content-type': 'text/html' } });
    } catch (e) {
      lastErr = e;
      if (debug) debug['ip_' + ip] = String(e.message || e).slice(0, 80);
    }
  }
  throw lastErr || new Error('DoH fetch gagal');
}

async function searchViaPublicFallback(query, debug = null) {
  const errors = [];
  const ddgDebug = debug || {};

  // Provider 1: Bing HTML site:instagram.com (Terbukti stabil & menghasilkan kandidat profil)
  try {
    const r = await searchViaBing(query);
    if (r.length > 0) return r;
    errors.push('Bing: 0 hasil');
  } catch (e) {
    errors.push(`Bing: ${e.message}`);
  }

  // Provider 2: DuckDuckGo HTML via DoH (cadangan)
  try {
    const r = await searchViaDuckDuckGo(query, ddgDebug);
    if (r.length > 0) return r;
    errors.push(`DuckDuckGo: 0 hasil`);
  } catch (e) {
    errors.push(`DuckDuckGo: ${e.message}`);
  }

  throw Object.assign(
    new Error(`Tidak ada akun ditemukan untuk kata kunci ini (${errors.join('; ') || 'fallback gagal'}). Coba kata kunci lain atau hubungkan akun IG.`),
    { code: 'NO_RESULTS' }
  );
}

function decodeBingU(uStr) {
  try {
    let clean = uStr;
    if (clean.startsWith('a1')) clean = clean.slice(2);
    clean = clean.replace(/-/g, '+').replace(/_/g, '/');
    while (clean.length % 4 !== 0) clean += '=';
    const decoded = Buffer.from(clean, 'base64').toString('utf8');
    return decoded;
  } catch {
    return '';
  }
}

function extractUsernames(html, limit = 30) {
  const seen = new Set();
  const accounts = [];
  const add = (raw) => {
    if (!raw) return;
    const mm = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{2,30})(?:\/|"|'|\)|\s|\?|$)/i.exec(raw);
    if (!mm) return;
    const uname = mm[1].toLowerCase();
    if (['p','reel','explore','accounts','direct','stories','intent','about','developer','help','legal','terms','privacy','directory','tags'].includes(uname) || seen.has(uname)) return;
    seen.add(uname);
    accounts.push({ username: mm[1], fullName: '', isVerified: false, profilePicUrl: '', isPrivate: false, followerCount: 0, via: 'fallback' });
  };
  const addCite = (citeText) => {
    if (!citeText) return;
    // Format cite Bing: "instagram.com › kopi › username" atau "www.instagram.com/username"
    const m = /instagram\.com[\s\/›>]+([A-Za-z0-9._]{2,30})/i.exec(citeText);
    if (m) add('https://instagram.com/' + m[1]);
  };

  // 1) Bing format 1: <li class="b_algo">...<a href="...ck/a?...u=a1aHR0c...
  const bingAlgoURe = /<li\s+class="b_algo"[\s\S]*?<a\s+[^>]*href="[^"]*\/ck\/a\?[^"]*u=([A-Za-z0-9_-]+)/gi;
  let bu;
  while ((bu = bingAlgoURe.exec(html)) && accounts.length < limit) {
    const rawTarget = decodeBingU(bu[1]);
    add(rawTarget);
  }

  // 2) Bing format 2: direct href di b_algo (seperti www.bing.com/search pada regional tertentu)
  const bingAlgoDirectRe = /<li\s+class="b_algo"[\s\S]*?<a\s+[^>]*href="(https?:\/\/(?:www\.)?instagram\.com\/[^"]+)"/gi;
  let bd;
  while ((bd = bingAlgoDirectRe.exec(html)) && accounts.length < limit) {
    add(bd[1]);
  }

  // 3) General u= parameter di link ck/a manapun
  const generalURe = /[?&]u=([A-Za-z0-9_-]{20,})/gi;
  let gu;
  while ((gu = generalURe.exec(html)) && accounts.length < limit) {
    const rawTarget = decodeBingU(gu[1]);
    if (rawTarget.includes('instagram.com/')) add(rawTarget);
  }

  // 4) DuckDuckGo /l/?uddg= link
  const uddgRe = /\/l\/\?uddg=([^'")\s]+)/g;
  let ud;
  while ((ud = uddgRe.exec(html)) && accounts.length < limit) add(decodeURIComponent(ud[1]));

  const hrefRe = /href="(\/l\/\?uddg=[^"]+)"/g;
  let hr;
  while ((hr = hrefRe.exec(html)) && accounts.length < limit) {
    const target = decodeURIComponent(hr[1].split('uddg=')[1] || '');
    add(target);
  }

  // 5) Bare instagram.com URL (slash akhir opsional)
  const bareRe = /instagram\.com\/([A-Za-z0-9._]{2,30})(?=[\/"'\)\s?#]|$)/gi;
  let m;
  while ((m = bareRe.exec(html)) && accounts.length < limit) add(m[0]);

  // 6) Teks <cite> Bing ("instagram.com › user" / "www.instagram.com/user")
  const citeRe = /<cite[^>]*>([\s\S]{0,160}?)<\/cite>/gi;
  let cm;
  while ((cm = citeRe.exec(html)) && accounts.length < limit) {
    addCite(cm[1].replace(/<[^>]+>/g, ' '));
  }

  return accounts;
}

export { extractUsernames, decodeBingU };

async function searchViaDuckDuckGo(query, debug = null) {
  const encQuery = encodeURIComponent(`site:instagram.com ${query}`);
  const url = `https://html.duckduckgo.com/html/?q=${encQuery}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetchWithDoH(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'text/html',
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.7',
      },
    }, debug);
    const text = await res.text();
    if (debug) {
      debug.ddgLen = text.length;
      debug.ddgStart = text.slice(0, 400);
      if (debug.debugPath) {
        try { await fs.promises.writeFile(debug.debugPath, text, 'utf8'); } catch {}
      }
    }
    // DuckDuckGo HTML sering tanpa username, fallback untuk ekstrak teksnya saja.
    // Kita hasilkan 0 username dari sini dan biarkan caller mencoba next provider.
    return extractUsernames(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function searchViaBing(query) {
  // JANGAN pakai operator site: — terbukti Bing mengabaikannya untuk
  // instagram.com (0 hasil IG dari 10 b_algo). Ambil hasil umum lalu
  // saring URL instagram.com/... dari target ter-decode & teks cite.
  const variants = [`"${query}" instagram`, `${query} instagram profile`];
  const seen = new Set();
  const out = [];
  const errors = [];
  for (let vi = 0; vi < variants.length; vi++) {
    // Halaman 1 (+ halaman 2 untuk varian pertama bila masih kurang)
    const pages = vi === 0 ? ['', '&first=11'] : [''];
    for (const page of pages) {
      if (out.length >= 30) break;
      const encQuery = encodeURIComponent(variants[vi]);
      const url = `https://www.bing.com/search?q=${encQuery}${page}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': DEFAULT_USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'id-ID,id;q=0.9,en;q=0.7',
          },
        });
        if (!res.ok) {
          errors.push(`HTTP ${res.status}`);
          continue;
        }
        for (const a of extractUsernames(await res.text())) {
          const k = a.username.toLowerCase();
          if (!seen.has(k)) { seen.add(k); out.push(a); }
        }
      } catch (e) {
        errors.push(e.message);
      } finally {
        clearTimeout(timeout);
      }
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 800));
    }
    if (out.length >= 10) break;
  }
  if (out.length > 0) return out;
  throw Object.assign(
    new Error(`Pencarian Bing 0 hasil${errors.length ? ` (${errors.slice(0, 2).join('; ')})` : ''}`),
    { code: 'FALLBACK_EMPTY' }
  );
}

/**
 * Fetch detailed Instagram profile + recent posts for lead analysis.
 * Tanpa sesi login, API resmi menolak (401/429 dari IP datacenter).
 * Untuk kandidat fallback (via:'fallback'), kembalikan profil dasar agar
 * scraping tetap membuahkan hasil walau tanpa metrik detail.
 */
export async function fetchInstagramProfile(username, session = {}) {
  const cleanUsername = String(username || '').replace(/^@/, '').trim();

  if (!session.sessionId) {
    return {
      username: cleanUsername,
      fullName: '',
      biography: '',
      category: 'Bisnis / Kreator',
      phone: '',
      email: '',
      externalUrl: '',
      followerCount: 0,
      followingCount: 0,
      totalPosts: 0,
      isVerified: false,
      isBusinessAccount: false,
      engagementRate: 0,
      avgLikes: 0,
      avgComments: 0,
      avgViews: 0,
      topHashtags: [],
      profileUrl: `https://www.instagram.com/${cleanUsername}/`,
      profilePicUrl: '',
      recentPosts: [],
      via: 'fallback',
    };
  }

  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(cleanUsername)}`;
  
  const rl = checkRateLimit(session);
  if (!rl.allowed) {
    throw Object.assign(new Error('Rate limit exceeded. Please wait.'), { status: 429, retryAfter: rl.retryAfter });
  }
  
  const headers = buildHeaders(session, `https://www.instagram.com/${cleanUsername}/`);
  
  const res = await fetchWithRetry(url, { headers });

  if (!res.ok) {
    if (res.status === 429) markChallenged(session);
    if (res.status === 404) throw Object.assign(new Error('Profile not found'), { status: 404 });
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error('Sesi Instagram kedaluwarsa. Hubungkan ulang akun IG Anda.'), { status: res.status, code: 'SESSION_EXPIRED' });
    }
    throw Object.assign(new Error(`Profile fetch failed HTTP ${res.status}`), { status: res.status });
  }
  
  const json = await res.json();
  const u = json?.data?.user;
  if (!u) throw new Error('Data profil tidak ditemukan');
  
  // Basic info
  const bio = u.biography || '';
  const businessPhone = u.business_phone_number || extractPhoneNumber(bio);
  const businessEmail = u.business_email || extractEmail(bio);
  const followerCount = u.edge_followed_by?.count || 0;
  const followingCount = u.edge_follow?.count || 0;
  const totalPosts = u.edge_owner_to_timeline_media?.count || 0;
  const category = u.category_name || u.business_category_name || 'Bisnis / Kreator';
  
  // Analyze recent posts (up to 12)
  const posts = [];
  const edges = u.edge_owner_to_timeline_media?.edges || [];
  const hashtagsMap = {};
  let totalLikes = 0;
  let totalComments = 0;
  let totalViews = 0;
  let videoCount = 0;
  
  for (const edge of edges.slice(0, 12)) {
    const node = edge.node;
    if (!node) continue;
    
    const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
    const likes = node.edge_liked_by?.count || 0;
    const comments = node.edge_media_to_comment?.count || 0;
    const isVideo = node.is_video === true;
    const viewCount = isVideo ? (node.video_view_count || 0) : 0;
    
    totalLikes += likes;
    totalComments += comments;
    if (isVideo) { totalViews += viewCount; videoCount++; }
    
    // Extract hashtags from caption
    const foundTags = caption.match(/#[a-zA-Z0-9_]+/g) || [];
    foundTags.forEach(t => {
      const tagLower = t.toLowerCase();
      hashtagsMap[tagLower] = (hashtagsMap[tagLower] || 0) + 1;
    });
    
    posts.push({
      id: node.id,
      shortcode: node.shortcode,
      postUrl: `https://www.instagram.com/p/${node.shortcode}/`,
      caption: caption.slice(0, 300),
      likeCount: likes,
      commentCount: comments,
      viewCount,
      isVideo,
      takenAt: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null,
      displayUrl: node.display_url || node.thumbnail_src || '',
    });
  }
  
  const { er, avgLikes, avgComments, avgViews } = calculateEngagementRate(posts, followerCount);
  
  const topHashtags = Object.entries(hashtagsMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(entry => entry[0]);
  
  return {
    username: u.username,
    fullName: u.full_name || '',
    biography: bio,
    category,
    phone: businessPhone,
    email: businessEmail,
    externalUrl: u.external_url || '',
    followerCount,
    followingCount,
    totalPosts,
    isVerified: Boolean(u.is_verified),
    isBusinessAccount: Boolean(u.is_business_account),
    engagementRate: er,
    avgLikes,
    avgComments,
    avgViews,
    topHashtags,
    profileUrl: `https://www.instagram.com/${u.username}/`,
    profilePicUrl: u.profile_pic_url_hd || u.profile_pic_url || '',
    recentPosts: posts,
  };
}

/**
 * Validate session by fetching own profile
 */
export async function validateSession(session) {
  if (!session.sessionId) return { valid: false, reason: 'NO_SESSION' };
  
  try {
    const url = 'https://www.instagram.com/api/v1/accounts/edit/web_form_data/';
    const headers = buildHeaders(session, 'https://www.instagram.com/');
    headers['X-CSRFToken'] = session.csrfToken || '';
    headers['X-Requested-With'] = 'XMLHttpRequest';
    
    const res = await fetch(url, { headers, method: 'GET' });
    
    if (res.ok) return { valid: true };
    if (res.status === 403 || res.status === 401) return { valid: false, reason: 'SESSION_EXPIRED' };
    return { valid: false, reason: `HTTP_${res.status}` };
  } catch {
    return { valid: false, reason: 'NETWORK_ERROR' };
  }
}

/**
 * Get rate limit status for debugging
 */
export function getRateLimitStatus(session) {
  const key = getRateLimitKey(session);
  return rateLimitState.get(key) || { count: 0, resetAt: Date.now() + 60000, challenged: false };
}