const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
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
    const columns = ['slug'].concat(fields, ['phone_numbers', 'white_label']);
    const allValues = [slug].concat(values, [JSON.stringify(phones), whiteLabel]);
    const placeholders = allValues.map((value, index) => '$' + (index + 1)).join(', ');
    const updates = fields.map(field => field + ' = EXCLUDED.' + field).join(', ');
    const sql = 'INSERT INTO clients (' + columns.join(', ') + ') VALUES (' + placeholders + ') ' +
      'ON CONFLICT (slug) DO UPDATE SET ' + updates +
      ', phone_numbers = EXCLUDED.phone_numbers, white_label = EXCLUDED.white_label, updated_at = NOW() RETURNING *';
    return (await pool.query(sql, allValues)).rows[0];
  }

  const client = { slug };
  fields.forEach((field, index) => { client[field] = values[index]; });
  client.phone_numbers = phones;
  client.white_label = whiteLabel;
  client.is_active = true;
  client.created_at = new Date().toISOString();
  memory.set(slug, client);
  return client;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Set ADMIN_KEY in environment first' });
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
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
    const links = [
      ...phones.map(phone => ['Позвонить', phoneHref(phone), phone]),
      ['WhatsApp', safeHttpUrl(client.whatsapp), ''],
      ['Instagram', safeHttpUrl(client.instagram), ''],
      ['Telegram', safeHttpUrl(client.telegram), ''],
      ['Сайт', safeHttpUrl(client.website), ''],
      ['Открыть карту', safeHttpUrl(client.address), '']
    ].filter(item => item[1]);
    const logo = safeLogo(client.logo_url);
    const title = escapeHtml(client.business_name);
    const accent = /^#[0-9a-f]{6}$/i.test(String(client.accent_color || '')) ? client.accent_color : '#8d5368';
    const footer = client.white_label ? '' :
      '<div class="powered">SMART TAP · YOUR BUSINESS. ONE TAP.</div>';

    const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="robots" content="noindex"><meta name="theme-color" content="' + escapeHtml(accent) + '"><title>' + title +
      (client.white_label ? '' : ' — SMART TAP') + '</title>' +
      '<style>:root{--accent:' + escapeHtml(accent) + ';--tint:color-mix(in srgb,var(--accent) 9%,white);--line:color-mix(in srgb,var(--accent) 25%,white);--ink:color-mix(in srgb,var(--accent) 70%,#241d21)}' +
      '*{box-sizing:border-box}body{margin:0;background:linear-gradient(160deg,var(--tint),#fff 65%,color-mix(in srgb,var(--accent) 14%,white));color:#292329;font:16px/1.5 Arial,sans-serif;min-height:100vh;display:grid;place-items:center;padding:22px}' +
      '.card{width:min(100%,430px);background:#ffffffeb;border:1px solid var(--line);border-radius:26px;padding:30px 25px;text-align:center;box-shadow:0 18px 55px color-mix(in srgb,var(--accent) 13%,transparent)}' +
      '.logo{width:112px;height:112px;object-fit:contain;border-radius:25px;background:white;padding:5px;border:1px solid var(--line)}h1{color:var(--ink);font-size:28px;margin:17px 0 4px}.tag{color:var(--accent);font-weight:600}.desc{color:#766b72}' +
      '.links{display:grid;gap:10px;margin-top:24px}.links a{padding:14px 15px;border-radius:14px;background:white;border:1px solid var(--line);color:var(--ink);text-decoration:none;font-weight:600}.links a:first-child{background:var(--accent);color:white;border-color:var(--accent)}' +
      '.powered{margin-top:24px;color:#988e94;font-size:11px;letter-spacing:1.5px}</style></head><body><main class="card">' +
      (logo ? '<img class="logo" src="' + escapeHtml(logo) + '" alt="Логотип">' :
        '<div class="logo" style="display:inline-grid;place-items:center;font-size:34px">✦</div>') +
      '<h1>' + title + '</h1><div class="tag">' + escapeHtml(client.tagline) +
      '</div><p class="desc">' + escapeHtml(client.description) + '</p><nav class="links">' +
      links.map(item => '<a href="' + escapeHtml(item[1]) +
        '" ' + (item[1].startsWith('tel:') ? '' : 'target="_blank" rel="noopener"') + '>' +
        escapeHtml(item[0]) + (item[2] ? '<br><small>' + escapeHtml(item[2]) + '</small>' : '') + '</a>').join('') +
      '</nav>' + footer + '</main></body></html>';

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
      console.log('Database schema ready');
    } catch (error) {
      console.error('DB init:', error);
    }
  }
  app.listen(PORT, '0.0.0.0', () => console.log('SMART TAP listening on ' + PORT));
})();
