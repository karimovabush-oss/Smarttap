const express=require('express'),path=require('path'),fs=require('fs');
const {Pool}=require('pg'),QRCode=require('qrcode');
const app=express(),PORT=process.env.PORT||3000,ADMIN_KEY=process.env.ADMIN_KEY||'',DATABASE_URL=process.env.DATABASE_URL||'';
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false}):null;
const memory=new Map();
app.set('trust proxy',1);app.use(express.json({limit:'1mb'}));app.use(express.static(path.join(__dirname,'public')));
const slugify=v=>String(v||'').toLowerCase().trim().replace(/[^a-z0-9а-яё\s-]/gi,'').replace(/[\s_]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
async function getClient(slug){if(pool)return(await pool.query('SELECT * FROM clients WHERE slug=$1',[slug])).rows[0]||null;return memory.get(slug)||null;}
async function listClients(){if(pool)return(await pool.query('SELECT * FROM clients ORDER BY created_at DESC')).rows;return Array.from(memory.values());}
async function saveClient(d,slug){
 const fields=['business_name','tagline','logo_url','phone','whatsapp','instagram','telegram','address','website','description','accent_color'],vals=fields.map(k=>d[k]||'');
 if(pool){const sql='INSERT INTO clients (slug,'+fields.join(',')+') VALUES ($1,'+fields.map((_,i)=>'$'+(i+2)).join(',')+') ON CONFLICT (slug) DO UPDATE SET '+fields.map(k=>k+'=EXCLUDED.'+k).join(',')+',updated_at=NOW() RETURNING *';return(await pool.query(sql,[slug,...vals])).rows[0];}
 const c={slug,...Object.fromEntries(fields.map((k,i)=>[k,vals[i]])),is_active:true,created_at:new Date().toISOString()};memory.set(slug,c);return c;
}
function admin(req,res,next){if(!ADMIN_KEY)return res.status(503).json({error:'Set ADMIN_KEY in environment first'});if(req.get('x-admin-key')!==ADMIN_KEY)return res.status(401).json({error:'Unauthorized'});next();}
app.get('/api/health',async(req,res)=>{let database='memory-demo';if(pool){try{await pool.query('SELECT 1');database='connected';}catch(e){database='error';}}res.json({ok:true,service:'SMART TAP',database,version:'0.1.0'});});
app.get('/api/clients',admin,async(req,res)=>{try{res.json(await listClients());}catch(e){res.status(500).json({error:'Could not load clients'});}});
app.post('/api/clients',admin,async(req,res)=>{const name=String(req.body.business_name||'').trim(),slug=slugify(req.body.slug||name);if(!name||!slug)return res.status(400).json({error:'Business name and slug required'});try{res.status(201).json(await saveClient({...req.body,business_name:name},slug));}catch(e){console.error('Save client:',e.message);res.status(500).json({error:'Save failed; check unique slug'});}});
app.delete('/api/clients/:slug',admin,async(req,res)=>{try{if(pool){const r=await pool.query('DELETE FROM clients WHERE slug=$1 RETURNING slug',[req.params.slug]);if(!r.rowCount)return res.status(404).json({error:'Client not found'});}else{if(!memory.delete(req.params.slug))return res.status(404).json({error:'Client not found'});}res.json({ok:true});}catch(e){res.status(500).json({error:'Delete failed'});}});
app.get('/api/public/:slug',async(req,res)=>{try{const c=await getClient(req.params.slug);if(!c)return res.status(404).json({error:'Not found'});res.json(c);}catch(e){res.status(500).json({error:'Server error'});}});
app.get('/api/clients/:slug/qr',async(req,res)=>{try{const c=await getClient(req.params.slug);if(!c)return res.status(404).json({error:'Not found'});const url=req.protocol+'://'+req.get('host')+'/t/'+encodeURIComponent(c.slug);const png=await QRCode.toBuffer(url,{type:'png',width:900,margin:2,errorCorrectionLevel:'H'});res.set('Content-Type','image/png');res.set('Content-Disposition','inline; filename="smart-tap-'+c.slug+'.png"');res.set('Cache-Control','no-store');res.send(png);}catch(e){console.error('QR generation:',e.message);res.status(500).json({error:'QR generation failed'});}});
app.get('/t/:slug',async(req,res)=>{try{const c=await getClient(req.params.slug);if(!c)return res.status(404).set('Cache-Control','no-store').sendFile(path.join(__dirname,'public','not-found.html'));res.set('Cache-Control','no-store, no-cache, must-revalidate');res.set('Pragma','no-cache');return res.sendFile(path.join(__dirname,'public','client.html'));}catch(e){console.error('Public page route:',e.message);return res.status(500).send('SMART TAP temporarily unavailable');}});
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
(async()=>{if(pool){try{await pool.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));console.log('Database schema ready');}catch(e){console.error('DB init:',e.message);}}app.listen(PORT,'0.0.0.0',()=>console.log('SMART TAP listening on '+PORT));})();