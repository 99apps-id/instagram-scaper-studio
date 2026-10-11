let activeLeads = [];
let licenseState = null;

const tableBody = document.getElementById('tableBody');
const btnStartScrape = document.getElementById('btnStartScrape');
const inputQuery = document.getElementById('inputQuery');
const telemetryBox = document.getElementById('telemetryBox');
const telemetryText = document.getElementById('telemetryText');
const btnConnectIG = document.getElementById('btnConnectIG');
const sessionStatusDot = document.getElementById('sessionStatusDot');
const sessionStatusText = document.getElementById('sessionStatusText');

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
    if (data.hasSession) {
      sessionStatusDot.style.background = '#10b981';
      sessionStatusText.textContent = 'Akun IG Terhubung';
    } else {
      sessionStatusDot.style.background = '#94a3b8';
      sessionStatusText.textContent = 'Hubungkan Akun IG';
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
}

function renderTable() {
  if (activeLeads.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 3rem; color: var(--ink-muted);">Belum ada data leads.</td></tr>`;
    return;
  }
  tableBody.innerHTML = activeLeads.map((l, idx) => {
    const waLink = l.phone ? `<a href="https://wa.me/${l.phone}" target="_blank" class="tag tag-emerald" style="text-decoration:none;">Chat WA</a>` : '';
    const emailLink = l.email ? `<a href="mailto:${l.email}" class="tag tag-blue" style="text-decoration:none;">Email</a>` : '-';
    const topTags = (l.topHashtags || []).slice(0, 2).map(t => `<span class="badge-viral">${t}</span>`).join(' ') || '-';

    return `
      <tr style="border-bottom: 1px solid var(--border-light);">
        <td style="padding: 0.65rem 0.85rem; text-align: center; color: var(--ink-muted);">${idx + 1}</td>
        <td style="padding: 0.65rem 0.85rem;">
          <div style="font-weight: 700; color: var(--ink-primary);">${l.fullName || l.username}</div>
          <a href="${l.profileUrl}" target="_blank" style="font-size: 0.75rem; color: var(--accent-rose); text-decoration: none;">@${l.username}</a>
        </td>
        <td style="padding: 0.65rem 0.85rem;"><span class="tag tag-subtle">${l.category}</span></td>
        <td style="padding: 0.65rem 0.85rem;">
          ${l.phone ? `<span style="font-family: var(--font-mono); font-size: 0.78rem;">${l.phone}</span>` : '<span style="color: var(--ink-faint);">-</span>'}
        </td>
        <td style="padding: 0.65rem 0.85rem; font-size: 0.78rem;">${emailLink}</td>
        <td style="padding: 0.65rem 0.85rem; text-align: right; font-weight: 600;">${(l.followerCount || 0).toLocaleString('id-ID')}</td>
        <td style="padding: 0.65rem 0.85rem; text-align: center;"><span class="badge-er">${l.engagementRate || 0}%</span></td>
        <td style="padding: 0.65rem 0.85rem;">${topTags}</td>
        <td style="padding: 0.65rem 0.85rem; text-align: center;">${waLink || '-'}</td>
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
      if (data.type === 'log' || data.type === 'status') {
        telemetryBox.style.display = 'block';
        telemetryText.textContent = data.message || 'Memproses...';
      }
      if (data.type === 'lead') {
        activeLeads.push(data.lead);
        renderTable();
        telemetryText.textContent = data.message;
      }
      if (data.type === 'status' && data.finished) {
        telemetryText.textContent = `Selesai! Berhasil mengumpulkan ${activeLeads.length} leads.`;
        btnStartScrape.disabled = false;
      }
    } catch {}
  };
}

document.addEventListener('DOMContentLoaded', () => {
  checkHealth();
  fetchLicense();
  connectSSE();

  btnStartScrape.addEventListener('click', async () => {
    const query = (inputQuery.value || '').trim();
    if (!query) return alert('Masukkan kata kunci pencarian');
    btnStartScrape.disabled = true;
    telemetryBox.style.display = 'block';
    telemetryText.textContent = `Memulai pencarian untuk: ${query}...`;
    try {
      const res = await fetch('/api/scrape/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Gagal memulai scraping');
        btnStartScrape.disabled = false;
      }
    } catch {
      btnStartScrape.disabled = false;
    }
  });

  if (btnConnectIG) {
    btnConnectIG.addEventListener('click', async () => {
      if (window.electronAPI && window.electronAPI.connectInstagram) {
        const res = await window.electronAPI.connectInstagram();
        if (res.success && res.session) {
          await fetch('/api/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(res.session)
          });
          checkHealth();
          alert('Akun Instagram berhasil terhubung!');
        }
      } else {
        alert('Fitur login Instagram instan aktif pada aplikasi Desktop Electron.');
      }
    });
  }

  if (btnContinueTrial) {
    btnContinueTrial.addEventListener('click', async () => {
      await fetch('/api/license/onboard', { method: 'POST', body: '{}' });
      fetchLicense();
    });
  }

  if (btnActivateLicense) {
    btnActivateLicense.addEventListener('click', async () => {
      const serial = (licenseSerialInput.value || '').trim();
      if (!serial) return alert('Isi kode aktivasi');
      const res = await fetch('/api/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serial })
      });
      const d = await res.json();
      if (res.ok) {
        alert('Lisensi berhasil diaktifkan!');
        fetchLicense();
      } else {
        alert(d.error || 'Aktivasi gagal');
      }
    });
  }

  if (window.electronAPI) {
    document.getElementById('appTitlebar').hidden = false;
    document.getElementById('winMinimize').onclick = () => window.electronAPI.windowControl('minimize');
    document.getElementById('winMaximize').onclick = () => window.electronAPI.windowControl('maximize');
    document.getElementById('winClose').onclick = () => window.electronAPI.windowControl('close');
  }
});
