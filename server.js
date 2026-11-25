const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const dns = require('node:dns').promises;
const net = require('node:net');
const crypto = require('node:crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ADMIN_COOKIE = 'smarttap_admin_session';
const ADMIN_SESSION_SECONDS = 12 * 60 * 60;
const loginAttempts = new Map();
const DATABASE_URL = process.env.DATABASE_URL || '';
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
}) : null;
const memory = new Map();

app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const slugify = value => String(value || '').toLowerCase().trim()
  .replace(/[^a-z0-9а-яё\s-]/gi, '').replace(/[\s_]+/g, '-')
  .replace(/-+/g, '-').replace(/^-|-$/g, '');

function normalizePhones(data) {
  const source = Array.isArray(data.phone_numbers) ? data.phone_numbers : (data.phone ? [data.phone] : []);
  return source.map(value => String(value || '').trim()).filter(Boolean).slice(0, 10);
}

function normalizeBranches(data) {
  const source = Array.isArray(data.branches) ? data.branches : [];
  return source.slice(0, 20).map((branch, index) => ({
    name: String(branch.name || '').trim().slice(0, 100),
    address: String(branch.address || '').trim().slice(0, 300),
    map_url: safeHttpUrl(branch.map_url),
    hours: String(branch.hours || '').trim().slice(0, 120),
    phone: String(branch.phone || '').trim().slice(0, 40)
  })).filter(branch => branch.name || branch.address || branch.map_url || branch.hours || branch.phone);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_) {
    return '';
  }
}

function safeLogo(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length <= 4_000_000 &&
      /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(raw)) return raw;
  return safeHttpUrl(raw);
}

function phoneHref(value) {
  const clean = String(value || '').replace(/[^\d+]/g, '');
  return clean ? 'tel:' + clean : '';
}

async function getClient(slug) {
  if (pool) {
    const result = await pool.query('SELECT * FROM clients WHERE slug = $1', [slug]);
    return result.rows[0] || null;
  }
  return memory.get(slug) || null;
}

async function listClients() {
  if (pool) return (await pool.query('SELECT * FROM clients ORDER BY created_at DESC')).rows;
  return Array.from(memory.values());
}

async function saveClient(data, slug) {
  const phones = normalizePhones(data);
  const branches = normalizeBranches(data);
  const fields = ['business_name', 'tagline', 'logo_url', 'phone', 'whatsapp',
    'instagram', 'telegram', 'address', 'website', 'description', 'accent_color'];
  const values = fields.map(field => {
    if (field === 'phone') return phones[0] || String(data.phone || '').trim();
    if (field === 'logo_url') return safeLogo(data.logo_url);
    if (field === 'accent_color') {
      const color = String(data.accent_color || '').trim();
      return /^#[0-9a-f]{6}$/i.test(color) ? color : '#8d5368';
    }
    return String(data[field] || '');
  });
  const whiteLabel = data.white_label === true || data.white_label === 'true';

  if (pool) {
    const columns = ['slug'].concat(fields, ['phone_numbers', 'branches', 'white_label']);
    const allValues = [slug].concat(values, [JSON.stringify(phones), JSON.stringify(branches), whiteLabel]);
    const placeholders = allValues.map((value, index) => '$' + (index + 1)).join(', ');
    const updates = fields.map(field => field + ' = EXCLUDED.' + field).join(', ');
    const sql = 'INSERT INTO clients (' + columns.join(', ') + ') VALUES (' + placeholders + ') ' +
      'ON CONFLICT (slug) DO UPDATE SET ' + updates +
      ', phone_numbers = EXCLUDED.phone_numbers, branches = EXCLUDED.branches, white_label = EXCLUDED.white_label, updated_at = NOW() RETURNING *';
    return (await pool.query(sql, allValues)).rows[0];
  }

  const client = { slug };
  fields.forEach((field, index) => { client[field] = values[index]; });
  client.phone_numbers = phones;
  client.branches = branches;
  client.white_label = whiteLabel;
  client.is_active = true;
  client.created_at = new Date().toISOString();
  memory.set(slug, client);
  return client;
}
 
function createAdminToken() {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', ADMIN_KEY).update(payload).digest('base64url');
  return payload + '.' + signature;
}

function validAdminToken(req) {
  if (!ADMIN_KEY) return false;
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\\s*)smarttap_admin_session=([^;]*)/);
  let token = '';
  try { token = match ? decodeURIComponent(match[1]) : ''; } catch (_) { return false; }
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = crypto.createHmac('sha256', ADMIN_KEY).update(payload).digest();
  let provided;
  try { provided = Buffer.from(signature, 'base64url'); } catch (_) { return false; }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(data.exp) && data.exp > Math.floor(Date.now() / 1000);
  } catch (_) { return false; }
}

function setAdminCookie(res, token, req) {
  const secure = (req && req.secure) || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', ADMIN_COOKIE + '=' + encodeURIComponent(token) +
    '; HttpOnly; Path=/; SameSite=Strict; Max-Age=' + ADMIN_SESSION_SECONDS + secure);
}

function clearAdminCookie(res, req) {
  const secure = (req && req.secure) || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', ADMIN_COOKIE + '=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0' + secure);
}

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'ADMIN_KEY не настроен в Render Environment' });
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.blockedUntil > now) {
    return res.status(429).json({ error: 'Слишком много попыток. Попробуй позже.' });
  }
  const supplied = crypto.createHash('sha256').update(String(req.body.password || '')).digest();
  const expected = crypto.createHash('sha256').update(ADMIN_KEY).digest();
  if (!crypto.timingSafeEqual(supplied, expected)) {
    const count = (attempt && attempt.windowUntil > now ? attempt.count : 0) + 1;
    loginAttempts.set(ip, {
      count,
      windowUntil: now + 15 * 60 * 1000,
      blockedUntil: count >= 8 ? now + 15 * 60 * 1000 : 0
    });
    return res.status(401).json({ error: 'Неверный пароль администратора' });
  }
  loginAttempts.delete(ip);
  setAdminCookie(res, createAdminToken(), req);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, expiresIn: ADMIN_SESSION_SECONDS });
});

app.get('/api/admin/session', (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ authenticated: false, error: 'ADMIN_KEY не настроен' });
  res.set('Cache-Control', 'no-store');
  res.json({ authenticated: validAdminToken(req) });
});

app.post('/api/admin/logout', (req, res) => {
  clearAdminCookie(res, req);
  res.json({ ok: true });
});

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Set ADMIN_KEY in Render Environment first' });
  if (!validAdminToken(req)) return res.status(401).json({ error: 'Нужна авторизация администратора' });
  next();
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

app.get('/api/health', async (req, res) => {
  let database = 'memory-demo';
  if (pool) {
    try { await pool.query('SELECT 1'); database = 'connected'; }
    catch (_) { database = 'error'; }
  }
  res.json({ ok: true, service: 'SMART TAP', database, version: '0.2.0' });
});

app.get('/api/clients', requireAdmin, async (req, res) => {
  try { res.json(await listClients()); }
  catch (error) { console.error(error); res.status(500).json({ error: 'Could not load clients' }); }
});


function isPrivateIp(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const parts = address.split('.').map(Number);
    const [a,b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized === '::' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.');
  }
  return true;
}

async function validatePublicUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Разрешены только HTTP и HTTPS ссылки');
  if (parsed.username || parsed.password) throw new Error('Ссылка не должна содержать логин или пароль');
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Локальные адреса нельзя импортировать');
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Локальные IP-адреса нельзя импортировать');
  } else {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(entry => isPrivateIp(entry.address))) {
      throw new Error('Сайт указывает на локальный или недоступный IP-адрес');
    }
  }
  return parsed;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function extractSiteData(html, pageUrl) {
  const metas = {};
  for (const match of html.matchAll(/<meta\b([^>]+)>/gi)) {
    const attrs = {};
    for (const attr of match[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[attr[1].toLowerCase()] = decodeHtml(attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content) metas[key] = attrs.content;
  }
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1Tag = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const strip = value => decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  const title = strip(metas['og:site_name'] || metas['og:title'] || (titleTag && titleTag[1]) || (h1Tag && h1Tag[1]));
  const description = strip(metas['og:description'] || metas.description || metas['twitter:description'] || '');
  let logo = metas['og:logo'] || metas['twitter:image'] || metas['og:image'] || '';
  const iconTag = [...html.matchAll(/<link\b([^>]+)>/gi)].map(match => {
    const attrs = {};
    for (const attr of match[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[attr[1].toLowerCase()] = decodeHtml(attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    return attrs;
  }).find(attrs => /apple-touch-icon|icon/i.test(attrs.rel || '') && attrs.href);
  if (iconTag && iconTag.href) logo = iconTag.href;
  if (logo) {
    try { logo = new URL(logo, pageUrl).href; } catch (_) { logo = ''; }
  }

  const phones = [];
  const text = strip(html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' '));
  for (const match of text.matchAll(/(?:\+\s?\d{1,3}[\s().-]?)?(?:\(?\d{2,4}\)?[\s().-]?){2,4}\d{2,4}/g)) {
    const candidate = match[0].trim().replace(/\s+/g, ' ');
    const digits = candidate.replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 15 && !phones.includes(candidate)) phones.push(candidate);
    if (phones.length >= 5) break;
  }

  const foundLinks = [...html.matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi)]
    .map(match => decodeHtml(match[1] || match[2] || match[3] || ''));
  const findLink = pattern => {
    const link = foundLinks.find(value => {
      try { return pattern.test(new URL(value, pageUrl).hostname + new URL(value, pageUrl).pathname); }
      catch (_) { return false; }
    });
    if (!link) return '';
    try { return new URL(link, pageUrl).href; } catch (_) { return ''; }
  };
  return {
    business_name: title.slice(0, 160),
    description: description.slice(0, 1200),
    logo_url: logo,
    phone_numbers: phones,
    instagram: findLink(/instagram\.com/i),
    telegram: findLink(/(?:t\.me|telegram\.me)/i),
    whatsapp: findLink(/(?:wa\.me|api\.whatsapp\.com|whatsapp\.com)/i),
    address: findLink(/(?:maps\.app\.goo\.gl|google\.[^/]+\/maps|yandex\.[^/]+\/maps|2gis\.)/i),
    website: pageUrl,
    accent_color: /^#[0-9a-f]{6}$/i.test(metas['theme-color'] || '') ? metas['theme-color'] : ''
  };
}

app.post('/api/import-site', requireAdmin, async (req, res) => {
  let current;
  try {
    current = await validatePublicUrl(String(req.body.url || '').trim());
    let response;
    for (let attempt = 0; attempt <= 3; attempt++) {
      response = await fetch(current.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(12000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SMART-TAP-Site-Importer/1.0)',
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'
        }
      });
      if ([301,302,303,307,308].includes(response.status)) {
        if (attempt === 3) throw new Error('Слишком много перенаправлений');
        const location = response.headers.get('location');
        if (!location) throw new Error('Сайт перенаправляет на неизвестный адрес');
        current = await validatePublicUrl(new URL(location, current).href);
        continue;
      }
      break;
    }
    if (!response || !response.ok) throw new Error('Сайт ответил ошибкой HTTP ' + (response ? response.status : ''));
    const contentType = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error('По этой ссылке открывается не HTML-страница. Укажи адрес главной страницы сайта.');
    }
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > 2_000_000) throw new Error('Страница слишком большая для импорта');
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > 2_000_000) throw new Error('Страница слишком большая для импорта');
    const data = extractSiteData(body, current.href);
    if (!data.business_name && !data.description && !data.logo_url) {
      throw new Error('Не удалось найти название, описание или логотип. Возможно, сайт формируется JavaScript или защищён от чтения.');
    }
    res.json({ ok: true, source: current.href, data });
  } catch (error) {
    console.warn('Site import failed:', error.message);
    res.status(422).json({ error: error.message || 'Не удалось прочитать сайт' });
  }
});

app.post('/api/clients', requireAdmin, async (req, res) => {
  const name = String(req.body.business_name || '').trim();
  const slug = slugify(req.body.slug || name);
  if (!name || !slug) return res.status(400).json({ error: 'Business name and slug required' });
  if (req.body.logo_url && !safeLogo(req.body.logo_url)) {
    return res.status(400).json({ error: 'Logo must be an image upload or a valid http(s) URL' });
  }
  try { res.status(201).json(await saveClient(req.body, slug)); }
  catch (error) { console.error('Save client:', error); res.status(500).json({ error: 'Save failed; check unique slug' }); }
});

app.delete('/api/clients/:slug', requireAdmin, async (req, res) => {
  try {
    if (pool) {
      const result = await pool.query('DELETE FROM clients WHERE slug = $1 RETURNING slug', [req.params.slug]);
      if (!result.rowCount) return res.status(404).json({ error: 'Client not found' });
    } else if (!memory.delete(req.params.slug)) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.json({ ok: true });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Delete failed' }); }
});

app.get('/api/public/:slug', async (req, res) => {
  try {
    const client = await getClient(req.params.slug);
    if (!client) return res.status(404).json({ error: 'Not found' });
    res.json(client);
  } catch (error) { console.error(error); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/clients/:slug/qr', async (req, res) => {
  try {
    const client = await getClient(req.params.slug);
    if (!client) return res.status(404).json({ error: 'Not found' });
    const url = req.protocol + '://' + req.get('host') + '/t/' + encodeURIComponent(client.slug);
    const png = await QRCode.toBuffer(url, {
      type: 'png', width: 900, margin: 2, errorCorrectionLevel: 'H'
    });
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', 'inline; filename="smart-tap-' + client.slug + '.png"');
    res.set('Cache-Control', 'no-store');
    res.send(png);
  } catch (error) { console.error('QR generation:', error); res.status(500).json({ error: 'QR generation failed' }); }
});

app.get('/t/:slug', async (req, res) => {
  try {
    const client = await getClient(req.params.slug);
    if (!client) return res.status(404).sendFile(path.join(__dirname, 'public', 'not-found.html'));

    const phones = Array.isArray(client.phone_numbers) && client.phone_numbers.length
      ? client.phone_numbers : (client.phone ? [client.phone] : []);
    const accent = /^#[0-9a-f]{6}$/i.test(String(client.accent_color || '')) ? client.accent_color : '#8d5368';
    const logo = safeLogo(client.logo_url);
    const title = escapeHtml(client.business_name);
    const tagline = escapeHtml(client.tagline || '');
    const description = escapeHtml(client.description || '');
    const links = [];
    const icon = {
      phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h3l2 5-2.4 1.7a14 14 0 0 0 4.7 4.7L16 12l5 2v3a3 3 0 0 1-3 3A16 16 0 0 1 4 6a3 3 0 0 1 3-3Z"/></svg>',
      instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5h.01"/></svg>',
      telegram: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 3-7.1 18-3.5-7.3L3 10.2 21 3Z"/><path d="m10.4 13.7 4.5-4.3"/></svg>',
      whatsapp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 11.5a8.5 8.5 0 0 1-12.8 7.3L3 20l1.2-4.5A8.5 8.5 0 1 1 20.5 11.5Z"/><path d="M8 8.2c.4 2.7 2.1 4.4 4.8 5"/></svg>',
      web: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
      map: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>'
    };
    for (const phone of phones) {
      const href = phoneHref(phone);
      if (href) links.push({ kind: 'phone', label: 'Позвонить', detail: phone, href, primary: links.length === 0 });
    }
    const add = (kind, label, value, detail) => {
      const href = safeHttpUrl(value);
      if (href) links.push({ kind, label, detail: detail || '', href, primary: false });
    };
    add('whatsapp', 'WhatsApp', client.whatsapp, 'Написать в чат');
    add('instagram', 'Instagram', client.instagram, 'Открыть профиль');
    add('telegram', 'Telegram', client.telegram, 'Связаться в Telegram');
    add('web', 'Официальный сайт', client.website, 'Перейти на сайт');
    add('map', 'Как добраться', client.address, 'Открыть карту');

    const branches = Array.isArray(client.branches) ? client.branches : [];
    const branchCards = branches.map((branch, index) => {
      const mapUrl = safeHttpUrl(branch.map_url);
      const tel = phoneHref(branch.phone);
      return '<article class="branch-card"><div class="branch-number">0' + (index + 1) + '</div>' +
        '<div class="branch-info"><h3>' + escapeHtml(branch.name || ('Филиал ' + (index + 1))) + '</h3>' +
        (branch.address ? '<p>' + escapeHtml(branch.address) + '</p>' : '') +
        (branch.hours ? '<small>' + escapeHtml(branch.hours) + '</small>' : '') +
        '<div class="branch-actions">' +
        (mapUrl ? '<a href="' + escapeHtml(mapUrl) + '" target="_blank" rel="noopener noreferrer">Открыть карту ↗</a>' : '') +
        (tel ? '<a href="' + escapeHtml(tel) + '">Позвонить ' + escapeHtml(branch.phone) + '</a>' : '') +
        '</div></div></article>';
    }).join('');
    const branchSection = branchCards ? '<section class="branch-section"><div class="branch-heading"><span>OUR LOCATIONS</span><h2>Наши филиалы</h2></div><div class="branch-grid">' + branchCards + '</div></section>' : '';

    const footer = client.white_label ? '' :
      '<footer class="powered"><span class="powered-mark">ST</span><span>SMART TAP</span><i>Digital identity for business</i></footer>';
    const initials = escapeHtml(String(client.business_name || 'ST').trim().split(/\s+/).slice(0,2).map(part => part[0] || '').join('').toUpperCase());
    const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
      '<meta name="theme-color" content="' + escapeHtml(accent) + '">' +
      '<meta name="description" content="' + description.slice(0, 180) + '">' +
      '<title>' + title + (client.white_label ? '' : ' — SMART TAP') + '</title>' +
      '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
      '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:wght@500;600;700&display=swap" rel="stylesheet">' +
      '<style>' +
      ':root{--a:' + escapeHtml(accent) + ';--ink:color-mix(in srgb,var(--a) 74%,#211c20);--mist:color-mix(in srgb,var(--a) 8%,#fff);--line:color-mix(in srgb,var(--a) 20%,#fff);--deep:color-mix(in srgb,var(--a) 88%,#21151b)}' +
      '*{box-sizing:border-box}html{min-height:100%;background:#f7f4f1}body{margin:0;min-height:100vh;color:#2d292b;font:15px/1.6 "DM Sans",Arial,sans-serif;background:radial-gradient(ellipse at 12% 8%,color-mix(in srgb,var(--a) 15%,transparent),transparent 38%),radial-gradient(ellipse at 88% 85%,color-mix(in srgb,var(--a) 13%,transparent),transparent 34%),linear-gradient(135deg,#fbfaf8,#f1eeeb);display:flex;align-items:center;justify-content:center;padding:38px 22px;overflow-x:hidden}' +
      '.ambient{position:fixed;inset:0;pointer-events:none;overflow:hidden}.ambient:before,.ambient:after{content:"";position:absolute;border:1px solid color-mix(in srgb,var(--a) 16%,transparent);border-radius:50%;width:460px;height:460px}.ambient:before{top:-280px;right:-130px}.ambient:after{bottom:-340px;left:-190px;width:600px;height:600px}' +
      '.shell{position:relative;width:min(100%,1040px);margin:auto}.topline{display:flex;align-items:center;justify-content:space-between;margin:0 0 18px;padding:0 5px;color:color-mix(in srgb,var(--a) 65%,#766d70);font-size:11px;letter-spacing:2.2px;text-transform:uppercase}.topline .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--a);margin-right:8px;box-shadow:0 0 0 5px color-mix(in srgb,var(--a) 12%,transparent)}' +
      '.card{position:relative;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(330px,.95fr);min-height:590px;background:#ffffffd9;border:1px solid #ffffff;border-radius:34px;box-shadow:0 35px 90px #2e20251a,0 2px 10px #2e20250a;overflow:hidden;backdrop-filter:blur(16px)}' +
      '.intro{position:relative;padding:66px 58px;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;background:linear-gradient(145deg,#fff, color-mix(in srgb,var(--a) 5%,#fff));}' +
      '.intro:after{content:"";position:absolute;width:330px;height:330px;border:1px solid color-mix(in srgb,var(--a) 13%,transparent);border-radius:50%;right:-210px;bottom:-205px;box-shadow:0 0 0 34px color-mix(in srgb,var(--a) 3%,transparent),0 0 0 75px color-mix(in srgb,var(--a) 2%,transparent)}' +
      '.brand-symbol{width:116px;height:116px;border-radius:30px;display:grid;place-items:center;background:#fff;border:1px solid var(--line);box-shadow:0 18px 40px color-mix(in srgb,var(--a) 12%,transparent);margin-bottom:30px;position:relative;z-index:1;overflow:hidden}.brand-symbol img{width:100%;height:100%;object-fit:contain;padding:10px}.brand-symbol .initials{font:600 38px "Playfair Display",serif;color:var(--a)}' +
      '.eyebrow{font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:700;color:var(--a);margin-bottom:14px}.intro h1{font:600 clamp(40px,5vw,66px)/1.04 "Playfair Display",Georgia,serif;letter-spacing:-1.5px;color:var(--ink);margin:0;max-width:520px;overflow-wrap:anywhere}.rule{width:54px;height:2px;background:var(--a);margin:26px 0 18px;opacity:.65}.tagline{font-size:18px;font-weight:600;color:var(--ink);margin:0 0 8px;max-width:460px}.description{max-width:450px;font-size:14px;line-height:1.9;color:#7b7276;margin:0;white-space:pre-line}.intro-note{margin-top:32px;font-size:10px;letter-spacing:1.8px;color:#a49a9c;text-transform:uppercase}' +
      '.contact-panel{padding:58px 42px;display:flex;flex-direction:column;justify-content:center;background:linear-gradient(160deg,#f9f7f5,#fff 70%)}.contact-heading{font:600 22px "Playfair Display",serif;color:var(--ink);margin:0 0 6px}.contact-sub{color:#a1989a;font-size:12px;margin:0 0 23px}.links{display:grid;gap:11px}.link{display:flex;align-items:center;gap:15px;text-decoration:none;color:var(--ink);padding:14px 16px;min-height:70px;border:1px solid var(--line);border-radius:17px;background:#ffffffc9;box-shadow:0 6px 18px #34242908;transition:transform .2s,box-shadow .2s,border-color .2s}.link:hover{transform:translateY(-2px);box-shadow:0 13px 24px color-mix(in srgb,var(--a) 11%,transparent);border-color:color-mix(in srgb,var(--a) 42%,white)}.link.primary{background:linear-gradient(135deg,var(--deep),var(--a));border-color:transparent;color:white;box-shadow:0 12px 25px color-mix(in srgb,var(--a) 24%,transparent)}.link-icon{width:40px;height:40px;flex:0 0 40px;border-radius:13px;background:var(--mist);display:grid;place-items:center;color:var(--a)}.link.primary .link-icon{background:#ffffff25;color:white}.link-icon svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.link-copy{min-width:0;display:grid;line-height:1.35}.link-copy strong{font-size:13px;font-weight:700}.link-copy small{color:#9b9093;font-size:11px;margin-top:4px;overflow-wrap:anywhere}.link.primary small{color:#ffffffc9}.arrow{margin-left:auto;font-size:18px;opacity:.45}.link.primary .arrow{opacity:.8}.branch-section{grid-column:1/-1;padding:34px 42px 40px;background:linear-gradient(160deg,#fff,color-mix(in srgb,var(--a) 4%,#fff));border-top:1px solid var(--line)}.branch-heading{margin-bottom:18px}.branch-heading span{font-size:9px;letter-spacing:2px;color:var(--a);font-weight:700}.branch-heading h2{margin:5px 0 0;font:600 26px "Playfair Display",serif;color:var(--ink)}.branch-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.branch-card{display:flex;gap:15px;align-items:flex-start;background:#ffffffd9;border:1px solid var(--line);border-radius:17px;padding:17px}.branch-number{font:600 22px "Playfair Display",serif;color:color-mix(in srgb,var(--a) 48%,white)}.branch-info{min-width:0}.branch-info h3{font-size:14px;color:var(--ink);margin:0 0 5px}.branch-info p{font-size:12px;color:#7b7276;line-height:1.55;margin:0 0 5px}.branch-info small{color:#9b9093;font-size:11px}.branch-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px}.branch-actions a{color:var(--a);font-size:11px;font-weight:700;text-decoration:none}.powered{display:flex;align-items:center;gap:9px;margin-top:28px;color:#a9a0a2;font-size:9px;letter-spacing:1.8px}.powered-mark{display:grid;place-items:center;width:23px;height:23px;border-radius:8px;background:var(--ink);color:white;font:700 9px Arial;letter-spacing:0}.powered i{font-style:normal;letter-spacing:.2px;margin-left:auto;font-size:10px}.bottomline{text-align:center;color:#aaa0a1;font-size:10px;letter-spacing:1.5px;margin-top:19px;text-transform:uppercase}' +
      '@media(max-width:760px){body{padding:18px 13px 26px}.topline{margin-bottom:12px;font-size:9px;letter-spacing:1.5px}.card{grid-template-columns:1fr;min-height:0;border-radius:27px}.intro{padding:34px 28px 30px;align-items:center;text-align:center}.brand-symbol{width:98px;height:98px;border-radius:25px;margin-bottom:22px}.intro h1{font-size:43px}.rule{margin:18px auto 14px}.tagline{font-size:16px}.description{font-size:13px}.intro-note{margin-top:21px}.contact-panel{padding:29px 22px 30px}.branch-section{padding:26px 20px 29px}.branch-grid{grid-template-columns:1fr}.branch-heading h2{font-size:23px}.contact-heading{font-size:21px}.links{gap:9px}.link{min-height:66px;padding:12px 13px}.bottomline{font-size:9px}}' +
      '@media(prefers-reduced-motion:reduce){.link{transition:none}.link:hover{transform:none}}' +
      '</style></head><body><div class="ambient" aria-hidden="true"></div><main class="shell">' +
      '<div class="topline"><span><i class="dot"></i>Business profile</span><span>Digital identity</span></div>' +
      '<section class="card"><div class="intro"><div class="brand-symbol">' +
      (logo ? '<img src="' + escapeHtml(logo) + '" alt="' + title + ' logo">' : '<span class="initials">' + initials + '</span>') +
      '</div><div class="eyebrow">Welcome</div><h1>' + title + '</h1><div class="rule"></div>' +
      (tagline ? '<p class="tagline">' + tagline + '</p>' : '') +
      (description ? '<p class="description">' + description + '</p>' : '') +
      '<div class="intro-note">A better way to connect</div></div>' +
      '<aside class="contact-panel"><h2 class="contact-heading">Связаться с нами</h2><p class="contact-sub">Выберите удобный способ связи</p><nav class="links">' +
      links.map(item => '<a class="link' + (item.primary ? ' primary' : '') + '" href="' + escapeHtml(item.href) + '" ' +
        (item.href.startsWith('tel:') ? '' : 'target="_blank" rel="noopener noreferrer"') + '><span class="link-icon">' + icon[item.kind] +
        '</span><span class="link-copy"><strong>' + escapeHtml(item.label) + '</strong>' +
        (item.detail ? '<small>' + escapeHtml(item.detail) + '</small>' : '') + '</span><span class="arrow">↗</span></a>').join('') +
      '</nav>' + footer + '</aside>' + branchSection + '</section><div class="bottomline">' + (client.white_label ? escapeHtml(client.business_name) : 'A premium digital business card · SMART TAP') +
      '</div></main></body></html>';

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('html').send(html);
  } catch (error) {
    console.error('Render public profile:', error);
    res.status(500).send('SMART TAP temporarily unavailable');
  }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

(async () => {
  if (pool) {
    try {
      await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
      await pool.query('ALTER TABLE clients ADD COLUMN IF NOT EXISTS white_label BOOLEAN NOT NULL DEFAULT FALSE');
      await pool.query("ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone_numbers JSONB NOT NULL DEFAULT '[]'::jsonb");
      await pool.query("ALTER TABLE clients ADD COLUMN IF NOT EXISTS branches JSONB NOT NULL DEFAULT '[]'::jsonb");
      console.log('Database schema ready');
    } catch (error) {
      console.error('DB init:', error);
    }
  }
  app.listen(PORT, '0.0.0.0', () => console.log('SMART TAP listening on ' + PORT));
})();
