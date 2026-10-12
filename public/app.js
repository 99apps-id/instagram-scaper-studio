let activeLeads = [];
let licenseState = null;
let licenseModalMode = 'onboard';
let cachedPaymentPlans = null;
let autoActivationTimer = null;
let checkoutStartedAt = null;
let chartEngagement = null;
let chartHashtags = null;
let hasInstagramSession = false;
let sessionValid = null; // true | false | null (belum terverifikasi)

// Payment endpoint: polling lokal bila ENGINE_URL kosong,
// proxy ke VPS engine bila dikonfigurasi (webhook hanya ada di VPS).
const PAYMENT_API = (() => {
  const base = (typeof window !== 'undefined' && window.__ENGINE_URL__) || '';
  return base ? `${String(base).replace(/\/+$/, '')}/api/payment/auto-activate` : '/api/payment/auto-activate';
})();

async function postAutoActivate(body) {
  const res = await fetch(PAYMENT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

// DOM Elements
const tableBody = document.getElementById('tableBody');
const btnStartScrape = document.getElementById('btnStartScrape');
const btnStopScrape = document.getElementById('btnStopScrape');
const checkDeepScan = document.getElementById('checkDeepScan');
const inputQuery = document.getElementById('inputQuery');
const btnConnectIG = document.getElementById('btnConnectIG');
const btnLogoutIG = document.getElementById('btnLogoutIG');
const sessionStatusDot = document.getElementById('sessionStatusDot');
const sessionStatusText = document.getElementById('sessionStatusText');

const sessionAlertBanner = document.getElementById('sessionAlertBanner');
const btnBannerConnect = document.getElementById('btnBannerConnect');

const scrapeRadar = document.getElementById('scrapeRadar');
const radarStatus = document.getElementById('radarStatus');
const radarCounter = document.getElementById('radarCounter');
const scrapeProgress = document.getElementById('scrapeProgress');
const scrapeProgressFill = document.getElementById('scrapeProgressFill');
const consoleLiveBox = document.getElementById('consoleLiveBox');

// Tampilkan/sembunyikan radar + bilah progres sekaligus
function setRadarVisible(on) {
  if (scrapeRadar) scrapeRadar.style.display = on ? 'flex' : 'none';
  if (scrapeProgress) scrapeProgress.hidden = !on;
}

// Update % + kilau bilah progres
function setScrapeProgress(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  if (radarCounter) radarCounter.textContent = `${p}%`;
  if (scrapeProgressFill) scrapeProgressFill.style.width = `${p}%`;
  if (scrapeProgress) scrapeProgress.setAttribute('aria-valuenow', String(p));
}

function appendLog(message, kind = '') {
  if (!consoleLiveBox) return;
  consoleLiveBox.hidden = false;
  const line = document.createElement('div');
  if (kind) line.className = kind;
  const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
  line.textContent = `[${time}] ${message}`;
  consoleLiveBox.appendChild(line);
  while (consoleLiveBox.children.length > 60) consoleLiveBox.firstChild.remove();
  consoleLiveBox.scrollTop = consoleLiveBox.scrollHeight;
}

function clearLog() {
  if (consoleLiveBox) {
    consoleLiveBox.innerHTML = '';
    consoleLiveBox.hidden = true;
  }
}

// License Modal & UI
const licensePill = document.getElementById('licensePill');
const licenseDot = document.getElementById('licenseDot');
const licensePillText = document.getElementById('licensePillText');
const licenseModal = document.getElementById('licenseModal');
const licenseTitle = document.getElementById('licenseTitle');
const licenseDesc = document.getElementById('licenseDesc');
const licenseSerialInput = document.getElementById('licenseSerialInput');
const licenseError = document.getElementById('licenseError');
const btnActivateLicense = document.getElementById('btnActivateLicense');
const btnContinueTrial = document.getElementById('btnContinueTrial');
const btnContinueTrialText = document.getElementById('btnContinueTrialText');
const btnDeactivateLicense = document.getElementById('btnDeactivateLicense');
const licenseInstallId = document.getElementById('licenseInstallId');
const titlebarLicense = document.getElementById('titlebarLicense');
const inputQuickReff = document.getElementById('inputQuickReff');
const btnVerifyQuickReff = document.getElementById('btnVerifyQuickReff');

// Settings & Export Dropdown
const btnSettingsMenu = document.getElementById('btnSettingsMenu');
const settingsMenu = document.getElementById('settingsMenu');
const menuLicense = document.getElementById('menuLicense');
const menuFAQ = document.getElementById('menuFAQ');
const menuAbout = document.getElementById('menuAbout');
const menuExit = document.getElementById('menuExit');

const btnExportMenu = document.getElementById('btnExportMenu');
const dropdownMenu = document.getElementById('dropdownMenu');
const btnReloadDataset = document.getElementById('btnReloadDataset');

// FAQ & About Modals
const faqModal = document.getElementById('faqModal');
const aboutModal = document.getElementById('aboutModal');
const btnFaqClose = document.getElementById('btnFaqClose');
const btnAboutClose = document.getElementById('btnAboutClose');
const aboutInstallId = document.getElementById('aboutInstallId');
const aboutLicenseState = document.getElementById('aboutLicenseState');

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  if (type === 'success') toast.style.background = 'var(--accent-emerald)';
  else if (type === 'error') toast.style.background = 'var(--accent-rose)';
  else if (type === 'warn' || type === 'warning') toast.style.background = 'var(--accent-amber)';
  else toast.style.background = 'var(--ink-secondary)';

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('exiting');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function copyToClipboard(text, alertMsg) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    showToast(alertMsg || 'Disalin ke clipboard!', 'success');
  }).catch(() => {
    showToast('Gagal menyalin.', 'error');
  });
}

async function loadPersistedLeads() {
  try {
    const res = await fetch('/api/leads');
    const data = await res.json();
    if (Array.isArray(data.leads) && data.leads.length > 0) {
      activeLeads = data.leads;
      renderTable();
    }
  } catch {}
}

async function checkHealth(withSessionCheck = false) {
  try {
    const res = await fetch(withSessionCheck ? '/api/health?session=check' : '/api/health');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    hasInstagramSession = Boolean(data.hasSession);
    // sessionValid: true | false | null (null = belum terverifikasi)
    sessionValid = data.hasSession ? data.sessionValid : false;

    if (hasInstagramSession && sessionValid === false) {
      // Sesi ada tapi mati: tampilkan status kedaluwarsa + tombol putus
      if (sessionStatusDot) sessionStatusDot.style.background = '#b45309';
      if (sessionStatusText) sessionStatusText.textContent = 'Sesi Kedaluwarsa — Hubungkan Ulang';
      if (sessionAlertBanner) {
        sessionAlertBanner.style.display = 'flex';
        const bannerText = sessionAlertBanner.querySelector('span');
        if (bannerText) bannerText.textContent = 'Sesi Instagram kedaluwarsa. Hubungkan ulang akun IG Anda untuk melanjutkan scraping.';
      }
      if (btnConnectIG) btnConnectIG.title = 'Sesi kedaluwarsa — klik untuk login ulang';
    } else if (hasInstagramSession) {
      if (sessionStatusDot) sessionStatusDot.style.background = '#047857';
      if (sessionStatusText) sessionStatusText.textContent = 'Instagram Terhubung';
      if (sessionAlertBanner) sessionAlertBanner.style.display = 'none';
      if (btnConnectIG) btnConnectIG.title = 'Sesi Instagram aktif dan tersimpan';
    } else {
      if (sessionStatusDot) sessionStatusDot.style.background = '#e11d48';
      if (sessionStatusText) sessionStatusText.textContent = 'Hubungkan Instagram';
      if (sessionAlertBanner) sessionAlertBanner.style.display = 'flex';
      if (btnConnectIG) btnConnectIG.title = 'Klik untuk menghubungkan sesi akun Instagram Anda';
    }
    if (btnLogoutIG) btnLogoutIG.style.display = hasInstagramSession ? '' : 'none';
  } catch {
    if (sessionStatusText) sessionStatusText.textContent = 'Server tidak merespons';
  }
}

async function logoutInstagram() {
  if (!confirm('Putuskan sesi Instagram di perangkat ini? Anda perlu login ulang untuk scraping.')) return;
  try {
    await fetch('/api/session', { method: 'DELETE' });
  } catch {}
  try {
    if (window.electronAPI && typeof window.electronAPI.clearInstagramSession === 'function') {
      await window.electronAPI.clearInstagramSession();
    }
  } catch {}
  hasInstagramSession = false;
  sessionValid = false;
  await checkHealth();
  showToast('Sesi Instagram diputus.', 'info');
}

function handleSessionExpired(message) {
  hasInstagramSession = true;
  sessionValid = false;
  checkHealth();
  showToast(message || 'Sesi Instagram kedaluwarsa. Menghubungkan ulang...', 'warning');
  // Tawarkan login ulang langsung
  triggerConnectInstagram();
}

async function fetchLicense() {
  try {
    const res = await fetch('/api/license/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    licenseState = await res.json();
  } catch {
    licenseState = null;
  }
  renderLicense();
}

function renderLicense() {
  const lic = licenseState;
  if (!lic) {
    if (licensePillText) licensePillText.textContent = 'Server tidak merespons';
    if (licenseDot) licenseDot.className = 'license-dot bad';
    applyLicenseGate(false);
    return;
  }

  if (licenseInstallId) licenseInstallId.textContent = lic.installId || '-';

  let label, dotClass;
  if (lic.activated) {
    label = `Aktif${lic.serialMasked ? ` (${lic.serialMasked})` : ''}`;
    dotClass = 'ok';
  } else if (lic.expired) {
    label = 'Trial habis';
    dotClass = 'bad';
  } else {
    label = `Trial: ${lic.daysLeft} hari`;
    dotClass = lic.daysLeft <= 1 ? 'warn' : 'ok';
  }

  if (licensePillText) licensePillText.textContent = label;
  if (licenseDot) licenseDot.className = `license-dot ${dotClass}`;
  if (titlebarLicense) titlebarLicense.textContent = label;

  applyLicenseGate(lic.blocked);

  // Modal: onboarding pertama kali, atau blokir saat kedaluwarsa
  if (!lic.onboarded) {
    openLicenseModal('onboard');
  } else if (lic.blocked) {
    openLicenseModal('expired');
  } else {
    closeLicenseModal();
  }
}

function applyLicenseGate(blocked) {
  if (btnStartScrape) {
    btnStartScrape.disabled = blocked;
    btnStartScrape.title = blocked ? 'Masa trial habis — aktivasi untuk scraping' : '';
  }
  const btnExport = document.getElementById('btnExport');
  if (btnExport) {
    btnExport.classList.toggle('disabled', blocked);
    btnExport.title = blocked ? 'Masa trial habis — aktivasi untuk mengunduh' : '';
  }
  if (btnExportMenu) {
    btnExportMenu.classList.toggle('disabled', blocked);
    btnExportMenu.title = blocked ? 'Masa trial habis — aktivasi untuk mengunduh' : '';
  }
}

function openLicenseModal(mode) {
  if (!licenseModal) return;
  licenseModalMode = mode;
  if (licenseError) licenseError.hidden = true;

  if (mode === 'expired') {
    if (licenseTitle) licenseTitle.textContent = 'Masa Trial Telah Habis';
    if (licenseDesc) licenseDesc.textContent = 'Scraping dan unduhan data (Excel/CSV/JSON) dikunci. Masukkan kode aktivasi untuk membuka kembali semua fitur.';
    if (btnContinueTrial) btnContinueTrial.style.display = 'none';
  } else if (mode === 'status') {
    const lic = licenseState;
    if (licenseTitle) licenseTitle.textContent = 'Status Lisensi';
    if (licenseDesc) {
      if (lic?.activated) {
        const planTxt = lic.plan ? ` (paket ${lic.plan})` : '';
        const expTxt = lic.expiresAt
          ? ` hingga ${new Date(lic.expiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`
          : ' permanen';
        licenseDesc.textContent = `Lisensi AKTIF${lic.serialMasked ? ` (${lic.serialMasked})` : ''}${planTxt}${expTxt}. Semua fitur terbuka.`;
      } else {
        licenseDesc.textContent = `Mode TRIAL — tersisa ${lic?.daysLeft ?? 3} hari (hingga ${lic?.trialEndsAt ? new Date(lic.trialEndsAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '-'}). Setelah habis, scraping & unduhan dikunci sampai aktivasi.`;
      }
    }
    if (btnContinueTrial) btnContinueTrial.style.display = '';
    if (btnContinueTrialText) btnContinueTrialText.textContent = 'Tutup';
  } else {
    // Mode onboard
    if (licenseTitle) licenseTitle.textContent = 'Selamat Datang';
    if (licenseDesc) licenseDesc.textContent = 'Masukkan kode aktivasi jika Anda sudah memilikinya, atau lanjutkan untuk memakai gratis selama 3 hari penuh.';
    if (btnContinueTrial) btnContinueTrial.style.display = '';
    if (btnContinueTrialText) {
      const d = licenseState?.daysLeft ?? 3;
      btnContinueTrialText.textContent = `Lanjutkan gratis selama ${d} hari`;
    }
  }

  licenseModal.hidden = false;

  // Tombol nonaktifkan hanya relevan bila sudah aktivasi
  if (btnDeactivateLicense) {
    btnDeactivateLicense.hidden = !(mode === 'status' && licenseState?.activated);
  }

  // Kilau kartu setiap kali dibuka/diklik ulang
  const card = licenseModal.querySelector('.license-card');
  if (card) {
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
  }

  loadPaymentPlans();
}

function closeLicenseModal() {
  if (licenseModal) licenseModal.hidden = true;
  stopAutoActivationPolling();
  const statusBox = document.getElementById('licenseAutoStatus');
  if (statusBox) statusBox.hidden = true;
}

async function loadPaymentPlans() {
  const container = document.getElementById('licensePlansGrid');
  if (!container) return;

  if (cachedPaymentPlans && cachedPaymentPlans.length > 0) {
    renderPaymentPlans(cachedPaymentPlans);
    return;
  }

  try {
    const res = await fetch('/api/payment/options');
    if (!res.ok) throw new Error('options fetch failed');
    const data = await res.json();
    if (Array.isArray(data.plans) && data.plans.length > 0) {
      cachedPaymentPlans = data.plans;
      renderPaymentPlans(cachedPaymentPlans);
    }
  } catch {
    const fallback = [
      { id: 'harian', label: 'Paket 1 Hari', shortLabel: '1 Hari', amountLabel: 'Rp15.000', days: 1, url: 'https://payment-link.singapay.id/b2b/PL202610111742326acb6818a083e' },
      { id: 'mingguan', label: 'Paket 7 Hari', shortLabel: '7 Hari', amountLabel: 'Rp50.000', days: 7, url: 'https://payment-link.singapay.id/b2b/PL202610111745086acb68b4360e7' }
    ];
    renderPaymentPlans(fallback);
  }
}

function renderPaymentPlans(plans) {
  const container = document.getElementById('licensePlansGrid');
  if (!container) return;

  const sorted = [...plans].sort((a, b) => (a.days || 0) - (b.days || 0));

  container.innerHTML = sorted.map((p) => {
    const isWeek = p.days >= 7;
    const badgeHtml = isWeek ? '<span class="license-plan-badge">Hemat</span>' : '';
    return `
      <div class="license-plan-card" data-url="${escapeHtml(p.url)}" role="button" tabindex="0" title="Beli ${escapeHtml(p.label)} (${escapeHtml(p.amountLabel)})">
        ${badgeHtml}
        <div class="license-plan-name">${escapeHtml(p.shortLabel || p.label)}</div>
        <div class="license-plan-price">${escapeHtml(p.amountLabel)}</div>
        <div class="license-plan-cta">
          <span>Beli Paket</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.license-plan-card').forEach((card) => {
    const handleOpen = () => {
      const url = card.dataset.url;
      if (!url) return;
      if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') {
        window.electronAPI.openExternal(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      showToast('Halaman checkout Singapay dibuka. Aplikasi akan aktif otomatis setelah pembayaran selesai.', 'info');
      startAutoActivationPolling();
    };
    card.addEventListener('click', handleOpen);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleOpen();
      }
    });
  });
}

function startAutoActivationPolling() {
  checkoutStartedAt = new Date().toISOString();
  const statusBox = document.getElementById('licenseAutoStatus');
  const statusTxt = document.getElementById('licenseAutoStatusText');
  if (statusBox) statusBox.hidden = false;
  if (statusTxt) statusTxt.textContent = 'Menunggu pembayaran Singapay... (aplikasi aktif otomatis)';

  stopAutoActivationPolling();

  let attempts = 0;
  const maxAttempts = 100; // ~5 menit polling (setiap 3 detik)

  autoActivationTimer = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts || licenseState?.activated) {
      stopAutoActivationPolling();
      return;
    }

    try {
      const data = await postAutoActivate({ since: checkoutStartedAt });
      if (data.found && data.status) {
        licenseState = data.status;
        renderLicense();
        stopAutoActivationPolling();
        showToast(`Pembayaran Singapay terverifikasi! Lisensi (${data.plan || 'berbayar'}) aktif otomatis.`, 'success');
      }
    } catch {}
  }, 3000);
}

function stopAutoActivationPolling() {
  if (autoActivationTimer) {
    clearInterval(autoActivationTimer);
    autoActivationTimer = null;
  }
}

async function handleQuickReffActivation() {
  const reff = (inputQuickReff?.value || '').trim();
  if (!reff) {
    showToast('Masukkan nomor referensi transaksi Singapay.', 'warn');
    return;
  }

  if (btnVerifyQuickReff) btnVerifyQuickReff.disabled = true;
  try {
    const data = await postAutoActivate({ reff });
    if (!data.found) {
      throw new Error(data.message || data.error || 'Referensi belum ditemukan. Pastikan pembayaran sudah lunas.');
    }

    licenseState = data.status;
    renderLicense();
    if (inputQuickReff) inputQuickReff.value = '';
    stopAutoActivationPolling();
    showToast(`Sukses! Pembayaran diverifikasi dan lisensi paket ${data.plan || ''} telah aktif.`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btnVerifyQuickReff) btnVerifyQuickReff.disabled = false;
  }
}

async function handleActivate() {
  const serial = (licenseSerialInput?.value || '').trim();
  if (!serial) {
    showToast('Isi kode aktivasi terlebih dahulu.', 'warn');
    return;
  }
  if (btnActivateLicense) btnActivateLicense.disabled = true;
  try {
    const res = await fetch('/api/license/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serial })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Aktivasi gagal');
    licenseState = data.status || await (await fetch('/api/license/status')).json();
    if (licenseSerialInput) licenseSerialInput.value = '';
    renderLicense();
    showToast('Lisensi aktif! Semua fitur terbuka.', 'success');
  } catch (err) {
    if (licenseError) {
      licenseError.textContent = err.message;
      licenseError.hidden = false;
    } else {
      showToast(err.message, 'error');
    }
  } finally {
    if (btnActivateLicense) btnActivateLicense.disabled = false;
  }
}

async function handleContinueTrial() {
  if (licenseModalMode === 'status') {
    closeLicenseModal();
    return;
  }
  try {
    const res = await fetch('/api/license/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (res.ok) {
      const data = await res.json();
      licenseState = data.status || licenseState;
    } else {
      await fetchLicense();
    }
  } catch {
    await fetchLicense();
  }
  renderLicense();
  showToast(`Mode trial aktif — ${licenseState?.daysLeft ?? 3} hari tersisa.`, 'success');
}

function updateKPIs() {
  const total = activeLeads.length;
  const withWa = activeLeads.filter(l => Boolean(l.phone)).length;
  const withEmail = activeLeads.filter(l => Boolean(l.email)).length;
  const erList = activeLeads.map(l => l.engagementRate).filter(e => typeof e === 'number' && e > 0);
  const avgEr = erList.length > 0 ? (erList.reduce((a, b) => a + b, 0) / erList.length).toFixed(1) : 0;

  const elTotal = document.getElementById('kpiTotal');
  const elWa = document.getElementById('kpiWa');
  const elWaPct = document.getElementById('kpiWaPct');
  const elEmail = document.getElementById('kpiEmail');
  const elAvgEr = document.getElementById('kpiAvgEr');

  if (elTotal) elTotal.textContent = total.toLocaleString('id-ID');
  if (elWa) elWa.textContent = withWa.toLocaleString('id-ID');
  if (elWaPct) elWaPct.textContent = `${total > 0 ? Math.round((withWa / total) * 100) : 0}% memiliki nomor WA`;
  if (elEmail) elEmail.textContent = withEmail.toLocaleString('id-ID');
  if (elAvgEr) elAvgEr.textContent = `${avgEr}%`;

  updateCharts();
}

function initCharts() {
  if (typeof Chart === 'undefined') return;

  const ctxEngage = document.getElementById('chartEngagement')?.getContext('2d');
  if (ctxEngage) {
    chartEngagement = new Chart(ctxEngage, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: 'Engagement Rate (%)',
          data: [],
          backgroundColor: '#be123c',
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 } } },
          y: { beginAtZero: true, ticks: { font: { size: 10 } } }
        }
      }
    });
  }

  const ctxHash = document.getElementById('chartHashtags')?.getContext('2d');
  if (ctxHash) {
    chartHashtags = new Chart(ctxHash, {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{
          data: [],
          backgroundColor: ['#be123c', '#e11d48', '#fb7185', '#fda4af', '#fecdd3']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 10 } } } }
      }
    });
  }
}

function updateCharts() {
  if (!chartEngagement || !chartHashtags) return;

  const topAccounts = [...activeLeads].sort((a, b) => (b.followerCount || 0) - (a.followerCount || 0)).slice(0, 6);
  chartEngagement.data.labels = topAccounts.map(a => `@${a.username}`);
  chartEngagement.data.datasets[0].data = topAccounts.map(a => a.engagementRate || 0);
  chartEngagement.update();

  const tagCounts = {};
  activeLeads.forEach(l => {
    (l.topHashtags || []).forEach(t => {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    });
  });
  const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  chartHashtags.data.labels = sortedTags.map(s => s[0]);
  chartHashtags.data.datasets[0].data = sortedTags.map(s => s[1]);
  chartHashtags.update();
}

function renderTable() {
  if (!tableBody) return;
  if (activeLeads.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 3rem; color: var(--ink-muted);">Belum ada data leads. Masukkan kata kunci di atas untuk memulai pencarian.</td></tr>`;
    return;
  }
  tableBody.innerHTML = activeLeads.map((l, idx) => {
    const waLink = l.phone ? `<a href="https://wa.me/${l.phone}" target="_blank" rel="noopener" class="btn btn-surface btn-sm" style="color: #047857; padding: 0.2rem 0.5rem; text-decoration: none;">Chat WA</a>` : '-';
    const emailLink = l.email ? `<a href="mailto:${escapeHtml(l.email)}" style="color: #1d4ed8; text-decoration: none;">${escapeHtml(l.email)}</a>` : '-';
    const tagsHtml = (l.topHashtags || []).slice(0, 3).map(t => `<span class="badge-tag">${escapeHtml(t)}</span>`).join(' ') || '-';
    const viaBadge = l.via === 'fallback' ? ` <span class="badge-tag" title="Username dari pencarian publik, tanpa metrik (butuh sesi IG untuk data lengkap)">publik</span>` : '';
    const rowClass = idx === activeLeads.length - 1 ? ' class="lead-row-new"' : '';

    return `
      <tr${rowClass}>
        <td style="text-align: center; color: var(--ink-muted); font-variant-numeric: tabular-nums;">${idx + 1}</td>
        <td>
          <div style="font-weight: 700; color: var(--ink-primary);">${escapeHtml(l.fullName || l.username)}</div>
          <a href="${escapeHtml(l.profileUrl || `https://www.instagram.com/${l.username}/`)}" target="_blank" rel="noopener" style="font-size: 0.725rem; color: var(--accent-rose); text-decoration: none;">@${escapeHtml(l.username)}</a>${viaBadge}
        </td>
        <td><span class="badge-tag">${escapeHtml(l.category || 'General')}</span></td>
        <td>
          ${l.phone ? `<span style="font-family: var(--font-mono); font-size: 0.76rem; font-weight: 600;">${escapeHtml(l.phone)}</span>` : '<span style="color: var(--ink-muted);">-</span>'}
        </td>
        <td style="font-size: 0.76rem;">${emailLink}</td>
        <td style="text-align: right; font-weight: 600; font-variant-numeric: tabular-nums;">${(l.followerCount || 0).toLocaleString('id-ID')}</td>
        <td style="text-align: center;"><span class="badge-er">${l.engagementRate || 0}%</span></td>
        <td>${tagsHtml}</td>
        <td style="text-align: center;">${waLink}</td>
      </tr>
    `;
  }).join('');
  updateKPIs();
}

function connectSSE() {
  let retryMs = 3000;
  const connect = () => {
    let es;
    try {
      es = new EventSource('/api/stream');
    } catch {
      setTimeout(connect, retryMs);
      return;
    }
    es.onmessage = (e) => {
      retryMs = 3000;
      try {
        const data = JSON.parse(e.data);
      if (data.type === 'status') {
        if (data.running) {
          setRadarVisible(true);
          if (btnStopScrape) btnStopScrape.style.display = 'inline-flex';
          if (btnStartScrape) btnStartScrape.disabled = true;
          if (radarStatus) radarStatus.textContent = data.message || 'Memproses pencarian...';
        } else {
          setRadarVisible(false);
          if (btnStopScrape) btnStopScrape.style.display = 'none';
          if (btnStartScrape) btnStartScrape.disabled = Boolean(licenseState?.blocked);
          if (data.sessionExpired) {
            handleSessionExpired(data.error);
          } else if (data.error) {
            appendLog(data.error, 'log-err');
            showToast(data.error, 'error');
          } else if (data.finished) {
            appendLog(`Selesai — ${activeLeads.length} leads terkumpul.`, 'log-ok');
          }
        }
      }
      if (data.type === 'log') {
        if (radarStatus) radarStatus.textContent = data.message;
        const msg = String(data.message || '');
        const kind = /gagal|error|batas|limit|ditolak|kedaluwarsa/i.test(msg) ? 'log-err'
          : /menunggu|membatasi|tanpa sesi|terbatas/i.test(msg) ? 'log-warn' : '';
        appendLog(msg, kind);
      }
      if (data.type === 'lead') {
        const exists = activeLeads.some(item => item.username?.toLowerCase() === data.lead.username?.toLowerCase());
        if (!exists) {
          activeLeads.push(data.lead);
          renderTable();
        }
        if (radarStatus) radarStatus.textContent = data.message;
        setScrapeProgress(data.progress || 0);
      }
      } catch {}
    };
    es.onerror = () => {
      try { es.close(); } catch {}
      retryMs = Math.min(retryMs * 2, 30000);
      setTimeout(connect, retryMs);
    };
  };
  connect();
}

async function triggerConnectInstagram() {
  if (window.electronAPI && typeof window.electronAPI.connectInstagram === 'function') {
    const res = await window.electronAPI.connectInstagram();
    if (res.success && res.session) {
      await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(res.session)
      });
      checkHealth();
      showToast('Akun Instagram berhasil terhubung! Sesi login Anda tersimpan.', 'success');
    }
  } else {
    // Mode browser/dev: tempel cookie manual (Electron tak tersedia)
    openSessionModal();
  }
}

function parseCookieInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  // Terima header Cookie lengkap ATAU nilai sessionid mentah
  const jar = text.includes('=') ? text : `sessionid=${text}`;
  const get = (name) => {
    const m = jar.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return m ? m[1].trim() : null;
  };
  const sessionId = get('sessionid');
  if (!sessionId || sessionId.length < 10) return null;
  const out = {
    sessionId,
    csrfToken: get('csrftoken'),
    userId: get('ds_user_id'),
  };
  // Simpan jar lengkap bila memang format cookie (butuh mid/ig_did/dll)
  if (text.includes('=')) out.cookies = jar;
  return out;
}

function openSessionModal() {
  const m = document.getElementById('sessionModal');
  if (m) {
    m.hidden = false;
    const input = document.getElementById('sessionCookieInput');
    if (input) setTimeout(() => input.focus(), 50);
  }
}

function closeSessionModal() {
  const m = document.getElementById('sessionModal');
  if (m) m.hidden = true;
}

async function handleSaveSession() {
  const input = document.getElementById('sessionCookieInput');
  const errBox = document.getElementById('sessionError');
  const showErr = (msg) => { if (errBox) { errBox.textContent = msg; errBox.style.display = 'block'; } };
  const session = parseCookieInput(input ? input.value : '');
  if (!session) {
    showErr('Cookie tidak valid — pastikan memuat sessionid.');
    return;
  }
  if (errBox) errBox.style.display = 'none';
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session),
    });
    if (!res.ok) throw new Error('Server menolak sesi');
    closeSessionModal();
    if (input) input.value = '';
    await checkHealth(true);
    showToast('Sesi Instagram tersimpan di perangkat ini.', 'success');
  } catch {
    showErr('Gagal menyimpan sesi. Pastikan server berjalan lalu coba lagi.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  checkHealth(true); // verifikasi validitas sesi saat buka (cache 5 mnt di server)
  loadPersistedLeads();
  fetchLicense();
  connectSSE();

  // Putuskan sesi Instagram
  if (btnLogoutIG) btnLogoutIG.addEventListener('click', logoutInstagram);

  // Modal sesi manual (mode browser/dev)
  const sessionClose = document.getElementById('sessionClose');
  const btnSaveSession = document.getElementById('btnSaveSession');
  const sessionModal = document.getElementById('sessionModal');
  if (sessionClose) sessionClose.addEventListener('click', closeSessionModal);
  if (btnSaveSession) btnSaveSession.addEventListener('click', handleSaveSession);
  if (sessionModal) sessionModal.addEventListener('click', (e) => { if (e.target === sessionModal) closeSessionModal(); });

  // Start Scrape
  if (btnStartScrape) {
    btnStartScrape.addEventListener('click', async () => {
      // Trial masih berlaku: JANGAN blokir. Izinkan scraping agar tidak
      // muncul "gagal scraping masalah lisensi" saat trial 3 hari.
      if (licenseState?.blocked) {
        openLicenseModal('expired');
        return;
      }

      // Tanpa sesi IG: tetap izinkan scraping via VPS engine (hasil mungkin
      // terbatas), cukup beri peringatan — JANGAN return agar trial bisa jalan.
      if (!hasInstagramSession) {
        showToast('Akun Instagram belum terhubung. Scraping tetap dijalankan via VPS engine (hasil terbatas). Hubungkan IG untuk data lengkap.', 'warn');
      }

      const query = (inputQuery?.value || '').trim();
      if (!query) {
        showToast('Masukkan kata kunci pencarian.', 'warn');
        return;
      }
      const deepMode = checkDeepScan ? checkDeepScan.checked : false;

      btnStartScrape.disabled = true;
      setRadarVisible(true);
      if (btnStopScrape) btnStopScrape.style.display = 'inline-flex';
      clearLog();
      appendLog(`Mencari "${query}"...`);

      if (radarStatus) radarStatus.textContent = `Mencari profil Instagram untuk: ${query}...`;
      setScrapeProgress(0);

      try {
        const res = await fetch('/api/scrape/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, deepMode })
        });
        if (!res.ok) {
          let msg = 'Gagal memulai scraping';
          try {
            const err = await res.json();
            msg = err.error || msg;
            if (err.code === 'LICENSE_REQUIRED') openLicenseModal('expired');
          } catch {}
          showToast(msg, 'error');
          setRadarVisible(false);
          if (btnStopScrape) btnStopScrape.style.display = 'none';
          btnStartScrape.disabled = Boolean(licenseState?.blocked);
        }
      } catch {
        showToast('Server tidak merespons. Pastikan aplikasi terbuka penuh lalu coba lagi.', 'error');
        btnStartScrape.disabled = Boolean(licenseState?.blocked);
        setRadarVisible(false);
        if (btnStopScrape) btnStopScrape.style.display = 'none';
      }
    });
  }

  // Stop Scrape
  if (btnStopScrape) {
    btnStopScrape.addEventListener('click', async () => {
      btnStopScrape.disabled = true;
      try {
        await fetch('/api/scrape/stop', { method: 'POST', body: '{}' });
      } catch {}
      setTimeout(() => { btnStopScrape.disabled = false; }, 1000);
    });
  }

  // Connect IG buttons
  if (btnConnectIG) btnConnectIG.addEventListener('click', triggerConnectInstagram);
  if (btnBannerConnect) btnBannerConnect.addEventListener('click', triggerConnectInstagram);

  // License Pill Click
  if (licensePill) {
    licensePill.addEventListener('click', () => {
      if (licenseState?.blocked) {
        openLicenseModal('expired');
      } else if (licenseState?.onboarded) {
        openLicenseModal('status');
      } else {
        openLicenseModal('onboard');
      }
    });
  }

  // License Activation Button
  if (btnActivateLicense) btnActivateLicense.addEventListener('click', handleActivate);
  if (btnContinueTrial) btnContinueTrial.addEventListener('click', handleContinueTrial);

  // Quick Reff Activation
  if (btnVerifyQuickReff) btnVerifyQuickReff.addEventListener('click', handleQuickReffActivation);
  if (inputQuickReff) {
    inputQuickReff.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleQuickReffActivation();
      }
    });
  }

  // Deactivate License
  if (btnDeactivateLicense) {
    btnDeactivateLicense.addEventListener('click', async () => {
      if (!confirm('Nonaktifkan lisensi di perangkat ini? Kode yang sama dapat digunakan di komputer lain.')) return;
      try {
        const res = await fetch('/api/license/deactivate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Gagal menonaktifkan lisensi');
        licenseState = data.status || null;
        renderLicense();
        showToast('Lisensi perangkat dinonaktifkan.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Copy Install ID
  const btnCopyId = document.getElementById('btnCopyInstallId');
  if (btnCopyId) {
    btnCopyId.addEventListener('click', () => {
      if (licenseState?.installId) {
        copyToClipboard(licenseState.installId, 'ID instalasi disalin!');
      }
    });
  }

  // Settings Dropdown
  if (btnSettingsMenu && settingsMenu) {
    btnSettingsMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = settingsMenu.classList.toggle('show');
      btnSettingsMenu.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
    settingsMenu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => {
      settingsMenu.classList.remove('show');
      btnSettingsMenu.setAttribute('aria-expanded', 'false');
    });
  }

  // Settings Menu Items
  if (menuLicense) {
    menuLicense.addEventListener('click', (e) => {
      e.preventDefault();
      settingsMenu.classList.remove('show');
      btnSettingsMenu.setAttribute('aria-expanded', 'false');
      if (licenseState?.blocked) openLicenseModal('expired');
      else if (licenseState?.onboarded) openLicenseModal('status');
      else openLicenseModal('onboard');
    });
  }

  if (menuFAQ) {
    menuFAQ.addEventListener('click', (e) => {
      e.preventDefault();
      settingsMenu.classList.remove('show');
      btnSettingsMenu.setAttribute('aria-expanded', 'false');
      if (faqModal) faqModal.hidden = false;
    });
  }

  if (menuAbout) {
    menuAbout.addEventListener('click', (e) => {
      e.preventDefault();
      settingsMenu.classList.remove('show');
      btnSettingsMenu.setAttribute('aria-expanded', 'false');
      if (aboutInstallId) aboutInstallId.textContent = licenseState?.installId || '-';
      if (aboutLicenseState) {
        aboutLicenseState.textContent = !licenseState ? '-' :
          licenseState.activated ? `Aktif${licenseState.serialMasked ? ` (${licenseState.serialMasked})` : ''}` :
          licenseState.expired ? 'Trial habis' : `Trial ${licenseState.daysLeft} hari`;
      }
      if (aboutModal) aboutModal.hidden = false;
    });
  }

  if (menuExit) {
    menuExit.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.electronAPI && typeof window.electronAPI.windowControl === 'function') {
        window.electronAPI.windowControl('close');
      } else {
        showToast('Untuk keluar, cukup tutup jendela aplikasi.', 'info');
      }
    });
  }

  // FAQ Modal Close
  if (btnFaqClose) btnFaqClose.addEventListener('click', () => { if (faqModal) faqModal.hidden = true; });
  if (faqModal) faqModal.addEventListener('click', (e) => { if (e.target === faqModal) faqModal.hidden = true; });

  // About Modal Close
  if (btnAboutClose) btnAboutClose.addEventListener('click', () => { if (aboutModal) aboutModal.hidden = true; });
  if (aboutModal) aboutModal.addEventListener('click', (e) => { if (e.target === aboutModal) aboutModal.hidden = true; });

  // License Modal Backdrop Click: allow closing only when not blocking
  if (licenseModal) {
    licenseModal.addEventListener('click', (e) => {
      if (e.target === licenseModal && licenseModalMode === 'status') {
        closeLicenseModal();
      }
    });
  }

  // Export Dropdown
  if (btnExportMenu && dropdownMenu) {
    btnExportMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = dropdownMenu.classList.toggle('show');
      btnExportMenu.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    dropdownMenu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => {
      dropdownMenu.classList.remove('show');
      btnExportMenu.setAttribute('aria-expanded', 'false');
    });
  }

  // Reload Master Dataset
  if (btnReloadDataset) {
    btnReloadDataset.addEventListener('click', () => {
      loadPersistedLeads();
      checkHealth();
      fetchLicense();
      showToast('Data diperbarui dari penyimpanan lokal.', 'info');
    });
  }

  // Keyboard Shortcuts: Esc to close modals
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (faqModal && !faqModal.hidden) faqModal.hidden = true;
      if (aboutModal && !aboutModal.hidden) aboutModal.hidden = true;
      if (licenseModal && !licenseModal.hidden && licenseModalMode === 'status') closeLicenseModal();
      if (settingsMenu) settingsMenu.classList.remove('show');
      if (dropdownMenu) dropdownMenu.classList.remove('show');
    }
  });

  // Electron Titlebar Controls
  if (window.electronAPI) {
    const titlebar = document.getElementById('appTitlebar');
    if (titlebar) titlebar.hidden = false;
    const btnMin = document.getElementById('winMinimize');
    const btnMax = document.getElementById('winMaximize');
    const btnClose = document.getElementById('winClose');
    if (btnMin) btnMin.onclick = () => window.electronAPI.windowControl('minimize');
    if (btnMax) btnMax.onclick = () => window.electronAPI.windowControl('maximize');
    if (btnClose) btnClose.onclick = () => window.electronAPI.windowControl('close');
  }
});