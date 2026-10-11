/**
 * Security Middleware & Helpers
 * Mirrors google-maps-scrapper security patterns.
 */

import crypto from 'crypto';
import path from 'path';

// Security headers for all responses
export function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

// Body size limit (2MB default)
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload terlalu besar'), { status: 413 }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('Body JSON tidak valid'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Path traversal protection for static file serving
// Parameters: safeStaticPath(pathname, publicDir)
export function safeStaticPath(pathname, publicDir) {
  if (!pathname || typeof pathname !== 'string') return null;
  const cleanPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(publicDir, cleanPath);
  const normalizedPublic = path.resolve(publicDir);
  if (resolved.startsWith(normalizedPublic + path.sep) || resolved === path.join(normalizedPublic, 'index.html')) {
    return resolved;
  }
  return null;
}

// CSV formula injection protection (OWASP)
export function csvCell(v) {
  if (v === null || v === undefined) return '""';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

// Input sanitization
export function cleanStr(v, max = 80) {
  return String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

// Timing-safe string comparison
export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Simple in-memory rate limiter (per IP)
const rateLimitMap = new Map();

export function checkRateLimit(key, maxPerWindow, windowMs) {
  const now = Date.now();
  const rec = rateLimitMap.get(key);
  if (!rec || now > rec.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxPerWindow - 1 };
  }
  rec.count++;
  if (rec.count > maxPerWindow) {
    return { allowed: false, remaining: 0, retryAfter: rec.resetAt - now };
  }
  return { allowed: true, remaining: maxPerWindow - rec.count };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap) {
    if (now > v.resetAt) rateLimitMap.delete(k);
  }
}, 60000);
