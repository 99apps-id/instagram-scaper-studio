let activeLeads = [];
let licenseState = null;
let chartEngagement = null;
let chartHashtags = null;
let hasInstagramSession = false;

const tableBody = document.getElementById('tableBody');
const btnStartScrape = document.getElementById('btnStartScrape');
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
const licenseModal = document.getElementById('licenseModal');
const btnContinueTrial = document.getElementById('btnContinueTrial');
const btnActivateLicense = document.getElementById('btnActivateLicense');
const licenseSerialInput = document.getElementById('licenseSerialInput');

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
  licensePillText.textContent = lic.activated ? 'Aktif' : (lic.expired ? 'Trial Habis' : `Trial: ${lic.daysLeft} hari`);
  licenseDot.className = `license-dot ${lic.activated ? 'ok' : (lic.expired ? 'bad' : 'warn')}`;
  if (!lic.onboarded || lic.blocked) {
    licenseModal.hidden = false;
    loadPaymentPlans();
  } else {
    licenseModal.hidden = true;
  }
}

async function loadPaymentPlans() {
  const grid = document.getElementById('licensePlansGrid');
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
          radarStatus.textContent = data.message || 'Memproses pencarian...';
        } else {
          scrapeRadar.style.display = 'none';
          btnStartScrape.disabled = false;
        }
      }
      if (data.type === 'lead') {
        activeLeads.push(data.lead);
        renderTable();
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

document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  checkHealth();
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
    btnStartScrape.disabled = true;
    scrapeRadar.style.display = 'flex';
    radarStatus.textContent = `Mencari profil Instagram untuk: ${query}...`;
    radarCounter.textContent = '0%';
    try {
      const res = await fetch('/api/scrape/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Gagal memulai scraping');
        scrapeRadar.style.display = 'none';
        btnStartScrape.disabled = false;
      }
    } catch {
      btnStartScrape.disabled = false;
      scrapeRadar.style.display = 'none';
    }
  });

  if (btnConnectIG) {
    btnConnectIG.addEventListener('click', triggerConnectInstagram);
  }

  if (btnBannerConnect) {
    btnBannerConnect.addEventListener('click', triggerConnectInstagram);
  }

  if (licensePill) licensePill.addEventListener('click', () => { licenseModal.hidden = false; loadPaymentPlans(); });
  if (btnContinueTrial) btnContinueTrial.addEventListener('click', async () => { await fetch('/api/license/onboard', { method: 'POST', body: '{}' }); fetchLicense(); });

  if (btnActivateLicense) {
    btnActivateLicense.addEventListener('click', async () => {
      const serial = (licenseSerialInput.value || '').trim();
      if (!serial) return alert('Isi kode aktivasi');
      const res = await fetch('/api/license/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serial }) });
      if (res.ok) { alert('Lisensi aktif!'); fetchLicense(); }
      else alert('Kode aktivasi tidak valid');
    });
  }

  if (window.electronAPI) {
    document.getElementById('appTitlebar').hidden = false;
    document.getElementById('winMinimize').onclick = () => window.electronAPI.windowControl('minimize');
    document.getElementById('winMaximize').onclick = () => window.electronAPI.windowControl('maximize');
    document.getElementById('winClose').onclick = () => window.electronAPI.windowControl('close');
  }
});
