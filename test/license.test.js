import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolasi: file lisensi sementara + secret uji
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'insta-lic-'));
process.env.LICENSE_FILE = path.join(tmpDir, 'license.json');
process.env.LICENSE_SECRET = 'uji-secret-16-karakter-xx';
delete process.env.LICENSE_SERVER_URL;

const lic = await import('../lib/license.js');

test('Trial baru: 3 hari, belum aktif, belum diblokir', () => {
  const st = lic.getLicenseStatus(new Date());
  assert.equal(st.activated, false);
  assert.equal(st.blocked, false);
  assert.equal(st.expired, false);
  assert.equal(st.trialDays, 3);
  assert.ok(st.daysLeft >= 2 && st.daysLeft <= 3);
  assert.ok(st.installId);
  assert.equal(st.onboarded, false);
});

test('Serial: generate -> valid; salah ketik -> CHECKSUM', () => {
  const code = lic.generateSerial(process.env.LICENSE_SECRET);
  assert.match(code, /^GMST-\d{4}-[A-Z2-9]{6}$/);
  assert.equal(lic.validateSerial(code, process.env.LICENSE_SECRET).ok, true);

  const typo = code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A');
  const bad = lic.validateSerial(typo, process.env.LICENSE_SECRET);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'CHECKSUM');

  assert.equal(lic.validateSerial('SALAH-FORMAT', process.env.LICENSE_SECRET).ok, false);
});

test('Serial beda secret -> CHECKSUM (anti-palsu)', () => {
  const code = lic.generateSerial('secret-lain-16-karakter');
  const v = lic.validateSerial(code, process.env.LICENSE_SECRET);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'CHECKSUM');
});

test('YYMM masa depan & terlalu tua ditolak', () => {
  const future = lic.generateSerial(process.env.LICENSE_SECRET, '9912');
  assert.equal(lic.validateSerial(future, process.env.LICENSE_SECRET).reason, 'YYMM_FUTURE');
  const old = lic.generateSerial(process.env.LICENSE_SECRET, '0001');
  assert.equal(lic.validateSerial(old, process.env.LICENSE_SECRET).reason, 'YYMM_TOO_OLD');
});

test('Aktivasi: status menjadi aktif & onboarded', () => {
  const code = lic.generateSerial(process.env.LICENSE_SECRET);
  const res = lic.activateLicense(code);
  assert.equal(res.success, true);
  const st = lic.getLicenseStatus();
  assert.equal(st.activated, true);
  assert.equal(st.blocked, false);
  assert.equal(st.onboarded, true);
  assert.ok(st.serialMasked && !st.serialMasked.includes(code.slice(6, 12)));
});

test('Deactivate: aktivasi dicabut, trial kedaluwarsa -> blocked lagi', () => {
  const code = lic.generateSerial(process.env.LICENSE_SECRET);
  lic.activateLicense(code);
  assert.equal(lic.getLicenseStatus().activated, true);
  const f = process.env.LICENSE_FILE;
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  raw.firstRun = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  raw.lastSeen = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(f, JSON.stringify(raw));
  const st = lic.deactivateLicense();
  assert.equal(st.activated, false);
  assert.equal(st.blocked, true);
});

test('Trial kedaluwarsa (tanpa aktivasi) -> blocked', () => {
  const f = process.env.LICENSE_FILE;
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  raw.activated = null;
  raw.onboarded = true;
  raw.firstRun = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  raw.lastSeen = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(f, JSON.stringify(raw));
  const st = lic.getLicenseStatus();
  assert.equal(st.expired, true);
  assert.equal(st.blocked, true);
  assert.equal(st.daysLeft, 0);
});

test('Jam sistem diputar balik -> tampered & blocked', () => {
  const f = process.env.LICENSE_FILE;
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  raw.activated = null;
  raw.firstRun = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  raw.lastSeen = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(raw));
  const st = lic.getLicenseStatus();
  assert.equal(st.tampered, true);
  assert.equal(st.blocked, true);
});
