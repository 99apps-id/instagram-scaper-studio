import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'insta-pay-'));
process.env.LICENSE_FILE = path.join(tmpDir, 'license.json');
process.env.LICENSE_SECRET = 'pay-test-secret-16-chars!';
process.env.PAYMENT_STORE_FILE = path.join(tmpDir, 'licenses.json');
process.env.PAYMENT_ORDERS_FILE = path.join(tmpDir, 'payments.json');

const pay = await import('../lib/payment.js');

function signPayload(obj, { secret, token, ts, endpoint }) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = sort(v[k]);
      return o;
    }
    return v;
  };
  const raw = JSON.stringify(obj);
  const hashed = crypto.createHash('sha256').update(JSON.stringify(sort(obj)), 'utf8').digest('hex');
  const s2s = `POST:${endpoint}:${token}:${hashed}:${ts}`;
  const sig = crypto.createHmac('sha512', secret).update(s2s, 'utf8').digest('hex');
  return { raw, headers: { 'x-signature': sig, 'x-timestamp': String(ts), authorization: `Bearer ${token}` } };
}

const SECRET = 'vendor-client-secret-abc';
const TOKEN = 'tok-123';
const ENDPOINT = '/api/payment/singapay';
const ts = () => Math.floor(Date.now() / 1000);

function paidPayload(reff = '18917720251110094037705', amount = '15000.00') {
  return {
    status: 200,
    success: true,
    data: {
      transaction: { reff_no: reff, type: 'pl', status: 'paid', amount: { value: amount, currency: 'IDR' }, tip: null, post_timestamp: '10 Nov 2025 09:46:38', processed_timestamp: '10 Nov 2025 09:46:38' },
      customer: { id: null, name: 'Budi', email: 'budi@example.com', phone: '0811' },
      payment: { method: 'payment_link', additional_info: { payment_link: { id: 1, reff_no: 'PL1', title: 'GMST Harian', payment_date: '2025-11-05T09:09:49.000000Z', payment_url: 'https://x', status: 'open', required_customer_detail: true, max_usage: 1000, current_usage: 1, expired_at: null, total_amount: amount, account_id: 1, created_at: '2025-11-05T09:09:49.000000Z', updated_at: '2025-11-05T09:09:49.000000Z' } } }
    }
  };
}

test('HMAC valid diterima; body diubah ditolak; timestamp basi ditolak', () => {
  const p = paidPayload();
  const good = signPayload(p, { secret: SECRET, token: TOKEN, ts: ts(), endpoint: ENDPOINT });
  assert.equal(pay.verifySingapaySignature({ rawBody: good.raw, headers: good.headers, clientSecret: SECRET, endpointPath: ENDPOINT }), true);

  const tampered = { ...p, success: false };
  assert.equal(pay.verifySingapaySignature({ rawBody: JSON.stringify(tampered), headers: good.headers, clientSecret: SECRET, endpointPath: ENDPOINT }), false);

  const stale = signPayload(p, { secret: SECRET, token: TOKEN, ts: ts() - 3600, endpoint: ENDPOINT });
  assert.equal(pay.verifySingapaySignature({ rawBody: stale.raw, headers: stale.headers, clientSecret: SECRET, endpointPath: ENDPOINT }), false);

  assert.equal(pay.verifySingapaySignature({ rawBody: good.raw, headers: good.headers, clientSecret: 'salah', endpointPath: ENDPOINT }), false);
});

test('Fulfill: paid 15rb -> serial harian; duplikat idempoten', () => {
  const r1 = pay.fulfillPaymentLink(paidPayload('REFF-1', '15000.00'));
  assert.match(r1.serial, /^GMST-\d{4}-[A-Z2-9]{6}$/);
  assert.equal(r1.plan, 'harian');
  assert.equal(r1.days, 1);
  assert.equal(r1.reused, false);

  const r2 = pay.fulfillPaymentLink(paidPayload('REFF-1', '15000.00'));
  assert.equal(r2.serial, r1.serial);
  assert.equal(r2.reused, true);

  const r3 = pay.fulfillPaymentLink(paidPayload('REFF-2', '50000.00'));
  assert.equal(r3.plan, 'mingguan');
  assert.equal(r3.days, 7);

  const store = JSON.parse(fs.readFileSync(process.env.PAYMENT_STORE_FILE, 'utf8'));
  assert.equal(store.licenses.length, 2);
});

test('Fulfill: belum paid & nominal asing ditolak', () => {
  const p = paidPayload('REFF-3', '15000.00');
  p.data.transaction.status = 'pending';
  assert.throws(() => pay.fulfillPaymentLink(p), /bukan paid/);

  const q = paidPayload('REFF-4', '99999.00');
  assert.throws(() => pay.fulfillPaymentLink(q), /tidak cocok/);
});

test('Claim + lookup paket + normalisasi entri lama', () => {
  const hit = pay.claimByReff('REFF-1');
  assert.equal(hit.plan, 'harian');
  assert.ok(hit.serial);
  assert.equal(pay.claimByReff('TAK-ADA'), null);

  const plans = pay.findPlanForSerial(hit.serial, [process.env.PAYMENT_STORE_FILE]);
  assert.deepEqual(plans, { plan: 'harian', days: 1 });

  const norm = pay.normalizeLicenseEntries({ licenses: ['gmst-2601-aaaaaa', { serial: 'GMST-2601-BBBBBB', plan: 'mingguan', days: 7 }], revoked: [] });
  assert.equal(norm[0].serial, 'GMST-2601-AAAAAA');
  assert.equal(norm[0].plan, null);
  assert.equal(norm[1].days, 7);

  const opts = pay.paymentOptions();
  assert.equal(opts.length, 2);
  const opt1 = opts.find(o => o.days === 1);
  const opt7 = opts.find(o => o.days === 7);
  assert.equal(opt1.amount, 15000);
  assert.match(opt1.url, /PL202610111742326acb6818a083e/);
  assert.equal(opt7.amount, 50000);
  assert.match(opt7.url, /PL202610111745086acb68b4360e7/);
});
