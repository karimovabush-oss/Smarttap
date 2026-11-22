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
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const slugify = value => String(value || '').toLowerCase().trim()
  .replace(/[^a-z0-9а-яё\s-]/gi, '').replace(/[\s_]+/g, '-')
  .replace(/-+/g, '-').replace(/^-|-$/g, '');

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
  const fields = ['business_name', 'tagline', 'logo_url', 'phone', 'whatsapp',
    'instagram', 'telegram', 'address', 'website', 'description', 'accent_color'];
  const values = fields.map(field => data[field] || '');
  const whiteLabel = data.white_label === true || data.white_label === 'true';

  if (pool) {
    const columns = ['slug'].concat(fields, ['white_label']);
    const allValues = [slug].concat(values, [whiteLabel]);
    const placeholders = allValues.map((value, index) => '$' + (index + 1)).join(', ');
    const updates = fields.map(field => field + ' = EXCLUDED.' + field).join(', ');
    const sql = 'INSERT INTO clients (' + columns.join(', ') + ') VALUES (' + placeholders + ') ' +
      'ON CONFLICT (slug) DO UPDATE SET ' + updates +
      ', white_label = EXCLUDED.white_label, updated_at = NOW() RETURNING *';
    return (await pool.query(sql, allValues)).rows[0];
  }

  const client = { slug };
  fields.forEach((field, index) => { client[field] = values[index]; });
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

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_) {
    return '';
  }
}

app.get('/api/health', async (req, res) => {
  let database = 'memory-demo';
  if (pool) {
    try { await pool.query('SELECT 1'); database = 'connected'; }
    catch (_) { database = 'error'; }
  }
  res.json({ ok: true, service: 'SMART TAP', database, version: '0.1.0' });
});

app.get('/api/clients', requireAdmin, async (req, res) => {
  try { res.json(await listClients()); }
  catch (error) { console.error(error); res.status(500).json({ error: 'Could not load clients' }); }
});

app.post('/api/clients', requireAdmin, async (req, res) => {
  const name = String(req.body.business_name || '').trim();
  const slug = slugify(req.body.slug || name);
  if (!name || !slug) return res.status(400).json({ error: 'Business name and slug required' });
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

    const links = [
      ['Позвонить', client.phone ? 'tel:' + client.phone : ''],
      ['WhatsApp', safeHttpUrl(client.whatsapp)],
      ['Instagram', safeHttpUrl(client.instagram)],
      ['Telegram', safeHttpUrl(client.telegram)],
      ['Сайт', safeHttpUrl(client.website)],
      ['Открыть карту', safeHttpUrl(client.address)]
    ].filter(item => item[1]);
    const logo = safeHttpUrl(client.logo_url);
    const title = escapeHtml(client.business_name);
    const footer = client.white_label ? '' :
      '<div class="powered">SMART TAP · YOUR BUSINESS. ONE TAP.</div>';

    const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="robots" content="noindex"><title>' + title +
      (client.white_label ? '' : ' — SMART TAP') + '</title>' +
      '<style>*{box-sizing:border-box}body{margin:0;background:#101114;color:#f7f7f8;font:16px/1.5 Arial;min-height:100vh;display:grid;place-items:center;padding:20px}' +
      '.card{width:min(100%,430px);background:#191b21;border:1px solid #30323a;border-radius:24px;padding:28px;text-align:center}' +
      '.logo{width:90px;height:90px;object-fit:cover;border-radius:22px}.desc,.tag{color:#a5a7b0}' +
      '.links{display:grid;gap:10px;margin-top:24px}.links a{padding:13px;border-radius:11px;background:#282b32;color:white;text-decoration:none}' +
      '.powered{margin-top:24px;color:#8a8d98;font-size:12px;letter-spacing:2px}</style></head><body><main class="card">' +
      (logo ? '<img class="logo" src="' + escapeHtml(logo) + '">' :
        '<div class="logo" style="display:inline-grid;place-items:center;font-size:34px">✦</div>') +
      '<h1>' + title + '</h1><div class="tag">' + escapeHtml(client.tagline) +
      '</div><p class="desc">' + escapeHtml(client.description) + '</p><nav class="links">' +
      links.map(item => '<a href="' + escapeHtml(item[1]) +
        '" target="_blank" rel="noopener">' + escapeHtml(item[0]) + '</a>').join('') +
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
      console.log('Database schema ready');
    } catch (error) {
      console.error('DB init:', error);
    }
  }
  app.listen(PORT, '0.0.0.0', () => console.log('SMART TAP listening on ' + PORT));
})();