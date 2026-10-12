/**
 * Insta Scrape Runner — inti eksekusi rencana scraping Instagram.
 *
 * File ini SENGAJA tidak mengimpor ./instagram.js secara statis.
 * searchInstagramAccounts & fetchInstagramProfile di-load lazy agar paket
 * klien (ENGINE_MODE=client) dapat diedarkan TANPA file engine — hasil
 * bedah tidak bisa scraping. Pola sama dengan GMST (scrape-runner.js).
 */

let cachedEngine = null;

async function loadEngine() {
  if (!cachedEngine) {
    try {
      cachedEngine = await import('./instagram.js');
    } catch {
      throw Object.assign(
        new Error('Modul engine scraping tidak tersedia di instalasi ini. Gunakan versi resmi / koneksi VPS.'),
        { status: 503, code: 'ENGINE_MISSING' }
      );
    }
  }
  return cachedEngine;
}

/**
 * Eksekusi rencana scraping Instagram.
 * @param {object} plan { query, deepMode }
 * @param {object} ctx {
 *   session, dataset: array, seen: Set,
 *   onLog(text), onLead(lead, progress, message),
 *   shouldAbort() -> bool
 * }
 * @returns {Promise<{newLeads:array, aborted:boolean}>}
 */
export async function executeScrapePlan(plan, ctx) {
  const { query, deepMode = false } = plan;
  const {
    session = {},
    dataset,
    seen,
    onLog = () => {},
    onLead = () => {},
    shouldAbort = () => false,
  } = ctx;

  if (!Array.isArray(dataset) || !(seen instanceof Set)) {
    throw new Error('Runner butuh ctx.dataset (array) & ctx.seen (Set).');
  }

  const engine = await loadEngine();
  const { searchInstagramAccounts, fetchInstagramProfile } = engine;

  // Deep query expansion jika deepMode aktif
  const queries = [query];
  if (deepMode) {
    queries.push(`${query} official`, `${query} store`, `${query} business`);
  }

  let allCandidates = [];
  let searchNote = '';
  let sessionExpiredHits = 0;
  for (const q of queries) {
    if (shouldAbort()) break;
    try {
      const accs = await searchInstagramAccounts(q, session);
      allCandidates.push(...accs);
    } catch (err) {
      // ENGINE_MISSING langsung diteruskan; error query lain dicatat
      if (err && err.code === 'ENGINE_MISSING') throw err;
      if (err && (err.code === 'SESSION_EXPIRED' || err.status === 401)) sessionExpiredHits++;
      onLog(`Pencarian "${q}" gagal: ${err.message}`);
      searchNote = err.message;
    }
  }

  if (allCandidates.length === 0) {
    // Semua query gagal karena sesi mati -> lempar agar UI meminta login ulang
    if (sessionExpiredHits > 0 && sessionExpiredHits >= queries.length) {
      throw Object.assign(new Error('Sesi Instagram kedaluwarsa. Hubungkan ulang akun IG Anda.'), { status: 401, code: 'SESSION_EXPIRED' });
    }
    const hint = searchNote || 'Instagram menolak permintaan tanpa login dari jaringan ini.';
    onLog(`0 akun ditemukan. ${hint}`);
    return { newLeads: [], aborted: shouldAbort() };
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

  onLog(`Ditemukan ${uniqueAccounts.length} akun potensial. Mengambil profil & kontak...`);

  const newLeads = [];
  let consecutive429 = 0;
  for (let i = 0; i < uniqueAccounts.length; i++) {
    if (shouldAbort()) {
      onLog('Scraping dihentikan sebelum semua profil selesai.');
      break;
    }

    const acc = uniqueAccounts[i];
    try {
      const detail = await fetchInstagramProfile(acc.username, session);
      consecutive429 = 0;
      const uKey = detail.username.toLowerCase();
      if (!seen.has(uKey)) {
        seen.add(uKey);
        dataset.push(detail);
        newLeads.push(detail);
      }

      onLead(
        detail,
        Math.round(((i + 1) / uniqueAccounts.length) * 100),
        `[${i + 1}/${uniqueAccounts.length}] Selesai analisa @${detail.username} (${detail.followerCount.toLocaleString()} followers)`
      );

      // Rate-Limit Guard manusiawi: API resmi butuh jeda lebih longgar
      // dari IP datacenter (4-8 dtk), fallback cepat (1-2 dtk).
      const isFallback = !session.sessionId || acc.via === 'fallback';
      const delayMs = isFallback
        ? 800 + Math.floor(Math.random() * 800)
        : 4000 + Math.floor(Math.random() * 4000);
      await new Promise((r) => setTimeout(r, delayMs));
    } catch (e) {
      // 429: tunggu sesuai Retry-After lalu ULANGI akun yang sama sekali
      // lagi sebelum menyerah — jangan hanguskan lead.
      if (e && (e.status === 429 || e.code === 'RATE_LIMITED')) {
        consecutive429++;
        const waitMs = Math.min(Number(e.retryAfter) || 15000, 120000);
        onLog(`Instagram membatasi (@${acc.username}). Menunggu ${(waitMs / 1000).toFixed(0)} dtk lalu mencoba lagi...`);
        await new Promise((r) => setTimeout(r, waitMs));
        try {
          const detail = await fetchInstagramProfile(acc.username, session);
          consecutive429 = 0;
          const uKey = detail.username.toLowerCase();
          if (!seen.has(uKey)) {
            seen.add(uKey);
            dataset.push(detail);
            newLeads.push(detail);
          }
          onLead(
            detail,
            Math.round(((i + 1) / uniqueAccounts.length) * 100),
            `[${i + 1}/${uniqueAccounts.length}] Selesai analisa @${detail.username} (${detail.followerCount.toLocaleString()} followers)`
          );
        } catch (e2) {
          // Akun PERTAMA langsung dibatasi = akun/IP sedang di-throttle
          // keras. Berhenti total agar throttle tidak makin parah.
          if (i === 0) {
            throw Object.assign(
              new Error('Instagram membatasi akun ini untuk membaca profil. Tunggu 15-30 menit tanpa scraping lalu ulangi. (Sesi Anda masih valid.)'),
              { status: 429, code: 'RATE_LIMITED_HARD' }
            );
          }
          onLog(`Gagal ambil detail @${acc.username}: ${e2.message}`);
        }
        if (consecutive429 >= 5) {
          onLog('Instagram terus membatasi. Berhenti sementara — tunggu beberapa menit lalu ulangi.');
          break;
        }
        continue;
      }
      // Sesi mati total: hentikan dengan pesan jelas (ditangani pemanggil).
      if (e && (e.code === 'SESSION_EXPIRED' || e.status === 401)) {
        throw e;
      }
      onLog(`Gagal ambil detail @${acc.username}: ${e.message}`);
    }
  }

  return { newLeads, aborted: shouldAbort() };
}
