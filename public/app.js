let activeLeads = [];
let licenseState = null;
let chartEngagement = null;
let chartHashtags = null;
let hasInstagramSession = false;

const tableBody = document.getElementById('tableBody');
const btnStartScrape = document.getElementById('btnStartScrape');
const btnStopScrape = document.getElementById('btnStopScrape');
const checkDeepScan = document.getElementById('checkDeepScan');
const inputQuery = document.getElementById('inputQuery');
const btnConnectIG = document.getElementById('btnConnectIG');
const sessionStatusDot = document.getElementById('sessionStatusDot');
const sessionStatusText = document.getElementById('sessionStatusText');

const sessionAlertBanner = document.getElementById('sessionAlertBanner');
const btnBannerConnect = document.getElementById('btnBannerConnect');

const scrapeRadar = document.getElementById('scrapeRadar');
const radarStatus = document.getElementById('radarStatus');
const radarCounter = document.getElementById('radarCounter');

const licensePill = document.getElementById('licensePill');
const licenseDot = document.getElementById('licenseDot');
const licensePillText = document.getElementById('licensePillText');
const licenseDrawer = document.getElementById('licenseDrawer');
const licenseDrawerBackdrop = document.getElementById('licenseDrawerBackdrop');
const licenseDrawerClose = document.getElementById('licenseDrawerClose');
const btnContinueTrial = document.getElementById('btnContinueTrial');
const btnActivateLicense = document.getElementById('btnActivateLicense');
const licenseSerialInput = document.getElementById('licenseSerialInput');
const licenseError = document.getElementById('licenseError');
const btnDeactivateLicense = document.getElementById('btnDeactivateLicense');
const btnCopyInstallId = document.getElementById('btnCopyInstallId');
const drawerInstallId = document.getElementById('drawerInstallId');
const licensePlansContainer = document.getElementById('licensePlansContainer');

// Settings Dropdown elements
const btnSettingsMenu = document.getElementById('btnSettingsMenu');
const settingsMenu = document.getElementById('settingsMenu');
const menuLicense = document.getElementById('menuLicense');
const menuFAQ = document.getElementById('menuFAQ');
const menuAbout = document.getElementById('menuAbout');
const menuExit = document.getElementById('menuExit');

// FAQ & About Modals
const faqModal = document.getElementById('faqModal');
const aboutModal = document.getElementById('aboutModal');
const faqClose = document.getElementById('faqClose');
const aboutClose = document.getElementById('aboutClose');
const aboutInstallId = document.getElementById('aboutInstallId');
const aboutLicenseState = document.getElementById('aboutLicenseState');

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

async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    hasInstagramSession = Boolean(data.hasSession);

    if (hasInstagramSession) {
      sessionStatusDot.style.background = '#047857';
      sessionStatusText.textContent = 'Instagram Terhubung';
      if (sessionAlertBanner) sessionAlertBanner.style.display = 'none';
      if (btnConnectIG) btnConnectIG.title = 'Sesi Instagram aktif dan tersimpan';
    } else {
      sessionStatusDot.style.background = '#e11d48';
      sessionStatusText.textContent = 'Hubungkan Instagram';
      if (sessionAlertBanner) sessionAlertBanner.style.display = 'flex';
      if (btnConnectIG) btnConnectIG.title = 'Klik untuk menghubungkan sesi akun Instagram Anda';
    }
  } catch {}
}

async function fetchLicense() {
  try {
    const res = await fetch('/api/license/status');
    licenseState = await res.json();
    renderLicense();
  } catch {}
}

function renderLicense() {
  const lic = licenseState;
  if (!lic) return;
  
  // Update license pill
  licensePillText.textContent = lic.activated ? 'Aktif' : (lic.expired ? 'Trial Habis' : `Trial: ${lic.daysLeft} hari`);
  licenseDot.className = `license-dot ${lic.activated ? 'ok' : (lic.expired ? 'bad' : 'warn')}`;
  
  // Update titlebar license
  const titlebarLicense = document.getElementById('titlebarLicense');
  if (titlebarLicense) titlebarLicense.textContent = licensePillText.textContent;
  
  // Determine drawer state and button behavior
  const isTrialActive = !lic.expired && !lic.activated;
  const isOnboarded = lic.onboarded;
  const isBlocked = lic.blocked;
  
  // Show drawer if: not onboarded yet, OR trial expired/blocked
  if (!isOnboarded || isBlocked) {
    licenseDrawer.hidden = false;
    licenseDrawer.classList.add('open');
    licenseDrawerBackdrop.classList.add('open');
    loadPaymentPlans();
  } else {
    licenseDrawer.hidden = true;
    licenseDrawer.classList.remove('open');
    licenseDrawerBackdrop.classList.remove('open');
  }
  
  // Update trial button text and behavior
  if (btnContinueTrial) {
    if (isTrialActive && !isOnboarded) {
      // Trial not started yet
      btnContinueTrial.textContent = `Lanjutkan gratis ${lic.daysLeft} hari`;
      btnContinueTrial.style.display = 'block';
      btnContinueTrial.onclick = async () => {
        await fetch('/api/license/onboard', { method: 'POST', body: '{}' });
        fetchLicense();
      };
    } else if (isTrialActive && isOnboarded) {
      // Trial active, already onboarded - don't show button in drawer (drawer is hidden)
      btnContinueTrial.style.display = 'none';
    } else {
      // Trial expired or blocked
      btnContinueTrial.textContent = 'Tutup';
      btnContinueTrial.style.display = 'block';
      btnContinueTrial.onclick = () => {
        licenseDrawer.hidden = true;
        licenseDrawer.classList.remove('open');
        licenseDrawerBackdrop.classList.remove('open');
      };
    }
  }
  
  // Update deactivate section visibility
  if (btnDeactivateLicense) {
    btnDeactivateLicense.style.display = lic.activated ? 'block' : 'none';
  }
  // Update install ID
  if (drawerInstallId) drawerInstallId.textContent = lic.installId || '-';
}

async function loadPaymentPlans() {
  const grid = document.getElementById('licensePlansContainer');
  if (!grid) return;
  try {
    const res = await fetch('/api/payment/options');
    const data = await res.json();
    grid.innerHTML = (data.plans || []).map(p => `
      <div class="license-plan-card" onclick="window.open('${p.url}', '_blank')">
        <div class="license-plan-name">${p.label}</div>
        <div class="license-plan-price">${p.amountLabel}</div>
        <div class="license-plan-cta">Beli Paket</div>
      </div>
    `).join('');
  } catch {}
}

function updateKPIs() {
  const total = activeLeads.length;
  const withWa = activeLeads.filter(l => Boolean(l.phone)).length;
  const withEmail = activeLeads.filter(l => Boolean(l.email)).length;
  const erList = activeLeads.map(l => l.engagementRate).filter(e => typeof e === 'number' && e > 0);
  const avgEr = erList.length > 0 ? (erList.reduce((a, b) => a + b, 0) / erList.length).toFixed(1) : 0;

  document.getElementById('kpiTotal').textContent = total.toLocaleString('id-ID');
  document.getElementById('kpiWa').textContent = withWa.toLocaleString('id-ID');
  document.getElementById('kpiWaPct').textContent = `${total > 0 ? Math.round((withWa / total) * 100) : 0}% memiliki nomor WA`;
  document.getElementById('kpiEmail').textContent = withEmail.toLocaleString('id-ID');
  document.getElementById('kpiAvgEr').textContent = `${avgEr}%`;

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
  if (activeLeads.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 3rem; color: var(--ink-muted);">Belum ada data leads.</td></tr>`;
    return;
  }
  tableBody.innerHTML = activeLeads.map((l, idx) => {
    const waLink = l.phone ? `<a href="https://wa.me/${l.phone}" target="_blank" class="btn btn-surface btn-sm" style="color: #047857; padding: 0.2rem 0.5rem; text-decoration: none;">Chat WA</a>` : '-';
    const emailLink = l.email ? `<a href="mailto:${l.email}" style="color: #1d4ed8; text-decoration: none;">${l.email}</a>` : '-';
    const tagsHtml = (l.topHashtags || []).slice(0, 3).map(t => `<span class="badge-tag">${t}</span>`).join(' ') || '-';

    return `
      <tr>
        <td style="text-align: center; color: var(--ink-muted); font-variant-numeric: tabular-nums;">${idx + 1}</td>
        <td>
          <div style="font-weight: 700; color: var(--ink-primary);">${l.fullName || l.username}</div>
          <a href="${l.profileUrl}" target="_blank" style="font-size: 0.725rem; color: var(--accent-rose); text-decoration: none;">@${l.username}</a>
        </td>
        <td><span class="badge-tag">${l.category}</span></td>
        <td>
          ${l.phone ? `<span style="font-family: var(--font-mono); font-size: 0.76rem; font-weight: 600;">${l.phone}</span>` : '<span style="color: var(--ink-faint);">-</span>'}
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
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'status') {
        if (data.running) {
          scrapeRadar.style.display = 'flex';
          btnStopScrape.style.display = 'inline-flex';
          btnStartScrape.disabled = true;
          radarStatus.textContent = data.message || 'Memproses pencarian...';
        } else {
          scrapeRadar.style.display = 'none';
          btnStopScrape.style.display = 'none';
          btnStartScrape.disabled = false;
        }
      }
      if (data.type === 'lead') {
        // Add if not seen
        const exists = activeLeads.some(item => item.username?.toLowerCase() === data.lead.username?.toLowerCase());
        if (!exists) {
          activeLeads.push(data.lead);
          renderTable();
        }
        radarStatus.textContent = data.message;
        radarCounter.textContent = `${data.progress || 0}%`;
      }
    } catch {}
  };
}

async function triggerConnectInstagram() {
  if (window.electronAPI && window.electronAPI.connectInstagram) {
    const res = await window.electronAPI.connectInstagram();
    if (res.success && res.session) {
      await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(res.session)
      });
      checkHealth();
      alert('Akun Instagram berhasil terhubung! Sesi login Anda telah tersimpan secara permanen.');
    }
  } else {
    alert('Buka aplikasi desktop Insta Scraper Studio untuk menghubungkan akun Instagram Anda secara instan.');
  }
}

// Toast notification system
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toast.style.cssText = `
    pointer-events: auto;
    padding: 0.75rem 1rem;
    border-radius: var(--radius-sm);
    font-size: 0.8rem;
    font-weight: 500;
    background: var(--ink-primary);
    color: #fff;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: toast-in 0.3s ease-out;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 280px;
    max-width: 420px;
  `;
  
  if (type === 'success') toast.style.background = 'var(--accent-emerald)';
  else if (type === 'error') toast.style.background = 'var(--accent-rose)';
  else if (type === 'warning') toast.style.background = 'var(--accent-amber)';
  else toast.style.background = 'var(--ink-secondary)';
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'toast-out 0.3s ease-in forwards';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  checkHealth();
  loadPersistedLeads();
  fetchLicense();
  connectSSE();

  btnStartScrape.addEventListener('click', async () => {
    if (!hasInstagramSession) {
      alert('Perhatian: Anda belum menghubungkan akun Instagram!\n\nUntuk menghindari limit rate dan mendapatkan data lengkap (WhatsApp, Email & Engagement), silakan klik tombol "Hubungkan Akun IG" terlebih dahulu.');
      triggerConnectInstagram();
      return;
    }

    const query = (inputQuery.value || '').trim();
    if (!query) return alert('Masukkan kata kunci pencarian');
    const deepMode = checkDeepScan ? checkDeepScan.checked : false;

    btnStartScrape.disabled = true;
    scrapeRadar.style.display = 'flex';
    if (btnStopScrape) btnStopScrape.style.display = 'inline-flex';

    radarStatus.textContent = `Mencari profil Instagram untuk: ${query}...`;
    radarCounter.textContent = '0%';

    try {
      const res = await fetch('/api/scrape/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, deepMode })
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Gagal memulai scraping');
        scrapeRadar.style.display = 'none';
        if (btnStopScrape) btnStopScrape.style.display = 'none';
        btnStartScrape.disabled = false;
      }
    } catch {
      btnStartScrape.disabled = false;
      scrapeRadar.style.display = 'none';
      if (btnStopScrape) btnStopScrape.style.display = 'none';
    }
  });

  if (btnStopScrape) {
    btnStopScrape.addEventListener('click', async () => {
      btnStopScrape.disabled = true;
      try {
        await fetch('/api/scrape/stop', { method: 'POST', body: '{}' });
      } catch {}
      setTimeout(() => { btnStopScrape.disabled = false; }, 1000);
    });
  }

  if (btnConnectIG) btnConnectIG.addEventListener('click', triggerConnectInstagram);
  if (btnBannerConnect) btnBannerConnect.addEventListener('click', triggerConnectInstagram);

  if (licensePill) licensePill.addEventListener('click', () => {
    licenseDrawer.hidden = false;
    licenseDrawer.classList.add('open');
    licenseDrawerBackdrop.classList.add('open');
    loadPaymentPlans();
  });

  if (btnActivateLicense) {
    btnActivateLicense.addEventListener('click', async () => {
      const serial = (licenseSerialInput.value || '').trim();
      if (!serial) return alert('Isi kode aktivasi');
      const res = await fetch('/api/license/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serial }) });
      if (res.ok) { alert('Lisensi aktif!'); fetchLicense(); }
      else alert('Kode aktivasi tidak valid');
    });
  }

  // Settings Dropdown
  if (btnSettingsMenu && settingsMenu) {
    btnSettingsMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = settingsMenu.classList.toggle('show');
      btnSettingsMenu.setAttribute('aria-expanded', isOpen);
    });
    document.addEventListener('click', (e) => {
      if (!settingsMenu.contains(e.target) && !btnSettingsMenu.contains(e.target)) {
        settingsMenu.classList.remove('show');
        btnSettingsMenu.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Settings Menu Items
  if (menuLicense) menuLicense.addEventListener('click', (e) => {
    e.preventDefault();
    settingsMenu.classList.remove('show');
    btnSettingsMenu.setAttribute('aria-expanded', 'false');
    licenseDrawer.hidden = false;
    licenseDrawer.classList.add('open');
    licenseDrawerBackdrop.classList.add('open');
    loadPaymentPlans();
  });
  if (menuFAQ) menuFAQ.addEventListener('click', (e) => {
    e.preventDefault();
    settingsMenu.classList.remove('show');
    btnSettingsMenu.setAttribute('aria-expanded', 'false');
    faqModal.hidden = false;
  });
  if (menuAbout) menuAbout.addEventListener('click', (e) => {
    e.preventDefault();
    settingsMenu.classList.remove('show');
    btnSettingsMenu.setAttribute('aria-expanded', 'false');
    if (aboutInstallId) aboutInstallId.textContent = licenseState?.installId || '-';
    if (aboutLicenseState) aboutLicenseState.textContent = licenseState?.activated ? 'Aktif' : (licenseState?.expired ? 'Trial Habis' : `Trial ${licenseState?.daysLeft} hari`);
    aboutModal.hidden = false;
  });
  if (menuExit) menuExit.addEventListener('click', (e) => {
    e.preventDefault();
    if (window.electronAPI) {
      window.electronAPI.windowControl('close');
    } else {
      window.close();
    }
  });

  // FAQ Modal
  if (faqClose) faqClose.addEventListener('click', () => { faqModal.hidden = true; });
  if (faqModal) faqModal.addEventListener('click', (e) => { if (e.target === faqModal) faqModal.hidden = true; });

  // About Modal
  if (aboutClose) aboutClose.addEventListener('click', () => { aboutModal.hidden = true; });
  if (aboutModal) aboutModal.addEventListener('click', (e) => { if (e.target === aboutModal) aboutModal.hidden = true; });

  // License Drawer Close
  if (licenseDrawerClose) licenseDrawerClose.addEventListener('click', () => {
    licenseDrawer.hidden = true;
    licenseDrawer.classList.remove('open');
    licenseDrawerBackdrop.classList.remove('open');
  });
  if (licenseDrawerBackdrop) licenseDrawerBackdrop.addEventListener('click', () => {
    licenseDrawer.hidden = true;
    licenseDrawer.classList.remove('open');
    licenseDrawerBackdrop.classList.remove('open');
  });

  // Copy Install ID
  if (btnCopyInstallId) btnCopyInstallId.addEventListener('click', () => {
    if (licenseState?.installId) {
      navigator.clipboard.writeText(licenseState.installId);
      showToast('ID Instalasi disalin!', 'success');
    }
  });

  // Deactivate License
  if (btnDeactivateLicense) {
    btnDeactivateLicense.addEventListener('click', async () => {
      if (!confirm('Nonaktifkan lisensi di perangkat ini? Kode aktivasi bisa dipakai di perangkat lain.')) return;
      try {
        const res = await fetch('/api/license/deactivate', { method: 'POST', body: '{}' });
        const data = await res.json();
        if (res.ok) { fetchLicense(); showToast('Lisensi dinonaktifkan.', 'success'); }
        else showToast(data.error || 'Gagal menonaktifkan', 'error');
      } catch { showToast('Error jaringan', 'error'); }
    });
  }

  if (window.electronAPI) {
    document.getElementById('appTitlebar').hidden = false;
    document.getElementById('winMinimize').onclick = () => window.electronAPI.windowControl('minimize');
    document.getElementById('winMaximize').onclick = () => window.electronAPI.windowControl('maximize');
    document.getElementById('winClose').onclick = () => window.electronAPI.windowControl('close');
  }
});