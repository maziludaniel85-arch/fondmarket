// FondMarket: serverul (Express + MySQL). Servește aplicația din /b2b și API-ul din /api.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const mail = require('./mail');
const ai = require('./ai');
const supplierPage = require('./supplier-page');

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  console.error('Lipsește JWT_SECRET (minim 32 de caractere). Adaugă-l în variabilele de mediu.');
  process.exit(1);
}
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());

/* ---------- utilitare ---------- */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (status, message) => Object.assign(new Error(message), { status });
const emailOk = e => /^\S+@\S+\.\S+$/.test(String(e || ''));
const specTxt = s => (typeof s[1] === 'number' ? `${s[0]} ≥ ${s[1]}${s[2] ? ' ' + s[2] : ''}` : s[1] ? `${s[0]}: ${s[1]}` : String(s[0]));
const round2 = n => Math.round(n * 100) / 100;

function setSession(res, user) {
  const token = jwt.sign({ id: user.id, role: user.role }, SECRET, { expiresIn: '30d' });
  res.cookie('fm', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 864e5 });
}
function auth(req, _res, next) {
  try { req.user = jwt.verify(req.cookies.fm || '', SECRET); } catch (_) { req.user = null; }
  next();
}
const needUser = (req, _res, next) => (req.user ? next() : next(bad(401, 'Intră în cont ca să continui.')));
const needAdmin = (req, _res, next) => (req.user && req.user.role === 'admin' ? next() : next(bad(403, 'Doar administratorul are acces aici.')));
app.use(auth);

async function prices() {
  const r = await db.one('SELECT v FROM settings WHERE k = ?', ['prices']);
  return r ? db.json(r.v) : db.DEFAULT_PRICES;
}
const EXTRA_LABEL = { ver: 'Verificare independență ofertanți', exp: 'Verificare dosar de un expert', cert: 'Pregătire vizită de certificare' };

/* ---------- stare ---------- */
app.get('/api/health', (_req, res) => res.json({ ok: true, ai: !!process.env.ANTHROPIC_API_KEY, mail: !!process.env.SMTP_HOST, cardPayments: process.env.DEMO_PAYMENTS === '1' }));

/* ---------- conturi ---------- */
const authLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 30, standardHeaders: true, legacyHeaders: false });

app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  const { email, password, name, firm } = req.body || {};
  if (!emailOk(email)) throw bad(400, 'Introdu o adresă de email validă.');
  if (String(password || '').length < 8) throw bad(400, 'Parola trebuie să aibă cel puțin 8 caractere.');
  if (await db.one('SELECT id FROM users WHERE email = ?', [email.toLowerCase()])) throw bad(409, 'Există deja un cont cu acest email. Intră în cont.');
  const r = await db.run('INSERT INTO users (email, pass, role, name) VALUES (?, ?, ?, ?)', [email.toLowerCase(), await bcrypt.hash(password, 10), 'beneficiar', String(name || '').slice(0, 190)]);
  const f = firm || {};
  await db.run('INSERT INTO firms (user_id, cui, name, addr, reg, email, person, project) VALUES (?,?,?,?,?,?,?,?)',
    [r.insertId, String(f.cui || '').slice(0, 20), String(f.name || '').slice(0, 190), '', '', email.toLowerCase(), String(name || '').slice(0, 190), String(f.project || '').slice(0, 255)]);
  const user = { id: r.insertId, role: 'beneficiar' };
  setSession(res, user);
  res.json({ ok: true });
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const u = await db.one('SELECT * FROM users WHERE email = ?', [String(email || '').toLowerCase()]);
  if (!u || !(await bcrypt.compare(String(password || ''), u.pass))) throw bad(401, 'Email sau parolă greșită.');
  setSession(res, u);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', (_req, res) => { res.clearCookie('fm'); res.json({ ok: true }); });

app.get('/api/me', wrap(async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const u = await db.one('SELECT id, email, role, name FROM users WHERE id = ?', [req.user.id]);
  if (!u) { res.clearCookie('fm'); return res.json({ user: null }); }
  const firm = await db.one('SELECT cui, name, addr, reg, email, person, project FROM firms WHERE user_id = ?', [u.id]);
  res.json({ user: u, firm });
}));

app.put('/api/firm', needUser, wrap(async (req, res) => {
  const f = req.body || {};
  if (f.email && !emailOk(f.email)) throw bad(400, 'Introdu o adresă de email validă pentru facturi.');
  await db.run(`INSERT INTO firms (user_id, cui, name, addr, reg, email, person, project) VALUES (?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE cui=VALUES(cui), name=VALUES(name), addr=VALUES(addr), reg=VALUES(reg), email=VALUES(email), person=VALUES(person), project=VALUES(project)`,
  [req.user.id, ...['cui', 'name', 'addr', 'reg', 'email', 'person', 'project'].map(k => String(f[k] || '').slice(0, 255))]);
  res.json({ ok: true });
}));

/* ---------- date firmă din ANAF (serviciul public de verificare TVA) ---------- */
app.get('/api/anaf/:cui', needUser, wrap(async (req, res) => {
  const cui = String(req.params.cui).replace(/\D/g, '');
  if (cui.length < 2 || cui.length > 10) throw bad(400, 'Introdu un CUI valid.');
  const r = await fetch('https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ cui: Number(cui), data: new Date().toISOString().slice(0, 10) }]),
  }).catch(() => null);
  if (!r || !r.ok) throw bad(502, 'ANAF nu răspunde acum. Completează datele manual.');
  const j = await r.json().catch(() => ({}));
  const g = j.found && j.found[0] && j.found[0].date_generale;
  if (!g) throw bad(404, 'ANAF nu are o firmă cu acest CUI.');
  res.json({ cui: (j.found[0].inregistrare_scop_Tva && j.found[0].inregistrare_scop_Tva.scpTVA ? 'RO' : '') + cui, name: g.denumire || '', addr: g.adresa || '', reg: g.nrRegCom || '' });
}));

/* ---------- proiectul beneficiarului (echipamente, dosare) ---------- */
app.get('/api/state', needUser, wrap(async (req, res) => {
  const r = await db.one('SELECT state FROM project_state WHERE user_id = ?', [req.user.id]);
  res.json({ state: r ? db.json(r.state) : null });
}));
app.put('/api/state', needUser, wrap(async (req, res) => {
  const s = JSON.stringify(req.body && req.body.state ? req.body.state : {});
  if (s.length > 2e6) throw bad(413, 'Proiectul e prea mare pentru a fi salvat.');
  await db.run('INSERT INTO project_state (user_id, state) VALUES (?, ?) ON DUPLICATE KEY UPDATE state = VALUES(state)', [req.user.id, s]);
  res.json({ ok: true });
}));

/* ---------- citirea ofertelor cu AI ---------- */
const aiLimiter = rateLimit({ windowMs: 60 * 60e3, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Ai citit multe documente într-o oră. Încearcă din nou mai târziu.' } });
app.post('/api/extract', aiLimiter, wrap(async (req, res) => {
  const { text, pdfBase64, images } = req.body || {};
  if (!text && !pdfBase64 && !(images || []).length) throw bad(400, 'Trimite textul sau documentul ofertei.');
  if (pdfBase64 && pdfBase64.length > 24e6) throw bad(413, 'PDF-ul e prea mare (maximum ~18 MB).');
  res.json(await ai.extract({ text, pdfBase64, images }));
}));

/* ---------- prețuri ---------- */
app.get('/api/settings', wrap(async (_req, res) => res.json({ prices: await prices(), payment: { company: process.env.PAY_COMPANY || 'FondMarket SRL', iban: process.env.PAY_IBAN || '' } })));
app.put('/api/settings', needAdmin, wrap(async (req, res) => {
  const p = req.body && req.body.prices;
  const num = v => { const n = Number(v); if (!(n >= 0 && n < 100000)) throw bad(400, 'Prețurile trebuie să fie numere pozitive.'); return n; };
  const next = { dosar: num(p.dosar), proiect: num(p.proiect), extra: { ver: num(p.extra.ver), exp: num(p.extra.exp), cert: num(p.extra.cert) }, vat: (await prices()).vat };
  await db.run('UPDATE settings SET v = ? WHERE k = ?', [JSON.stringify(next), 'prices']);
  res.json({ prices: next });
}));

/* ---------- comenzi ---------- */
function orderNo() { return 'FM-' + new Date().getFullYear() + '-' + crypto.randomInt(10000, 99999); }
const mapOrder = o => ({ ...o, lines: db.json(o.lines_json), lines_json: undefined, subtotal: Number(o.subtotal), vat: Number(o.vat), tot: Number(o.tot) });

app.post('/api/orders', needUser, wrap(async (req, res) => {
  const { pkg_key, ver, extras = [], lot = '', lotLabel = '', method } = req.body || {};
  if (!['dosar', 'proiect'].includes(pkg_key)) throw bad(400, 'Alege un pachet.');
  if (!['card', 'op'].includes(method)) throw bad(400, 'Alege metoda de plată.');
  if (method === 'card' && process.env.DEMO_PAYMENTS !== '1') throw bad(400, 'Plata cu cardul nu e încă activă. Alege ordin de plată.');
  const p = await prices();
  const firm = await db.one('SELECT * FROM firms WHERE user_id = ?', [req.user.id]);
  if (!firm || !firm.name || !firm.cui) throw bad(400, 'Completează datele firmei (denumire și CUI) înainte de comandă.');
  const bought = new Set((await db.all("SELECT lines_json FROM orders WHERE user_id = ? AND status = 'plătită'", [req.user.id]))
    .flatMap(o => db.json(o.lines_json).map(l => l.key)).filter(k => k === 'exp' || k === 'cert'));
  const lines = pkg_key === 'proiect'
    ? [{ key: 'proiect', t: 'Proiect complet', d: 'toate dosarele până la 08.12.2027, verificarea ofertanților inclusă', p: p.proiect }]
    : [{ key: 'dosar', t: 'Dosar per achiziție', d: String(lotLabel).slice(0, 120), p: p.dosar }, ...(ver ? [{ key: 'ver', t: EXTRA_LABEL.ver, d: 'pentru acest dosar', p: p.extra.ver }] : [])];
  for (const k of ['exp', 'cert']) if (extras.includes(k) && !bought.has(k)) lines.push({ key: k, t: EXTRA_LABEL[k], d: 'pe proiect', p: p.extra[k] });
  const subtotal = round2(lines.reduce((a, l) => a + l.p, 0));
  const vat = round2(subtotal * p.vat);
  const tot = round2(subtotal + vat);
  const no = orderNo();
  const status = method === 'card' ? 'plătită' : 'așteaptă plata';
  await db.run(`INSERT INTO orders (no, user_id, client, cui, pkg, pkg_key, lot, lines_json, subtotal, vat, tot, method, status, paid_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [no, req.user.id, firm.name, firm.cui, pkg_key === 'proiect' ? 'Proiect complet' : 'Dosar per achiziție', pkg_key, String(lot).slice(0, 40), JSON.stringify(lines), subtotal, vat, tot, method, status, status === 'plătită' ? new Date() : null]);
  const rows = lines.map(l => `<tr><td style="padding:6px 0">${mail.esc(l.t)}</td><td style="text-align:right">${l.p.toFixed(2)} lei</td></tr>`).join('');
  const pay = method === 'op'
    ? `<p>Plătește prin ordin de plată:</p><p>Beneficiar: <b>${mail.esc(process.env.PAY_COMPANY || 'FondMarket SRL')}</b><br>IBAN: <b>${mail.esc(process.env.PAY_IBAN || '(se completează)')}</b><br>Sumă: <b>${tot.toFixed(2)} lei</b><br>Mențiune: <b>${no}</b></p><p>Activăm pachetul imediat ce încasăm suma.</p>`
    : '<p>Plata a fost încasată. Pachetul e activ.</p>';
  mail.send({ to: firm.email, subject: `${method === 'op' ? 'Proformă' : 'Confirmare plată'} ${no}`, html: mail.layout(method === 'op' ? `Proforma pentru comanda ${no}` : `Comanda ${no} e plătită`, `<table style="width:100%;font-size:14px">${rows}<tr><td style="padding-top:8px;border-top:1px solid #e2e8f0">TVA ${Math.round(p.vat * 100)}%</td><td style="text-align:right;border-top:1px solid #e2e8f0">${vat.toFixed(2)} lei</td></tr><tr><td><b>Total</b></td><td style="text-align:right"><b>${tot.toFixed(2)} lei</b></td></tr></table>${pay}`) }).catch(e => console.error('[mail]', e.message));
  res.json({ order: mapOrder(await db.one('SELECT * FROM orders WHERE no = ?', [no])) });
}));

app.get('/api/orders', needUser, wrap(async (req, res) => {
  const rows = req.user.role === 'admin'
    ? await db.all('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500')
    : await db.all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.json({ orders: rows.map(mapOrder) });
}));

app.post('/api/orders/:no/paid', needAdmin, wrap(async (req, res) => {
  const o = await db.one('SELECT o.*, f.email AS femail FROM orders o LEFT JOIN firms f ON f.user_id = o.user_id WHERE o.no = ?', [req.params.no]);
  if (!o) throw bad(404, 'Comanda nu există.');
  if (o.status !== 'plătită') {
    await db.run("UPDATE orders SET status = 'plătită', paid_at = NOW() WHERE no = ?", [o.no]);
    if (o.femail) mail.send({ to: o.femail, subject: `Am încasat plata pentru ${o.no}`, html: mail.layout('Pachetul tău e activ', `<p>Am încasat ${Number(o.tot).toFixed(2)} lei pentru comanda <b>${mail.esc(o.no)}</b> (${mail.esc(o.pkg)}).</p><p>Poți trimite cererile de ofertă din platformă: <a href="${PUBLIC_URL}/">${PUBLIC_URL || 'FondMarket'}</a>.</p>`) }).catch(e => console.error('[mail]', e.message));
  }
  res.json({ order: mapOrder(await db.one('SELECT * FROM orders WHERE no = ?', [o.no])) });
}));

/* ---------- beneficiari (admin) ---------- */
app.get('/api/beneficiaries', needAdmin, wrap(async (_req, res) => {
  const rows = await db.all(`SELECT u.id, u.email, u.created_at, f.name AS firm, f.cui, f.project,
      (SELECT pkg FROM orders o WHERE o.user_id = u.id AND o.status = 'plătită' ORDER BY (o.pkg_key = 'proiect') DESC, o.created_at DESC LIMIT 1) AS pkg,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status = 'așteaptă plata') AS pending,
      (SELECT COUNT(*) FROM rfqs r WHERE r.user_id = u.id) AS rfqs,
      (SELECT updated_at FROM project_state s WHERE s.user_id = u.id) AS last
    FROM users u LEFT JOIN firms f ON f.user_id = u.id WHERE u.role = 'beneficiar' ORDER BY u.created_at DESC`);
  res.json({ beneficiaries: rows });
}));

/* ---------- furnizori ---------- */
const mapSup = s => ({ ...s, cats: db.json(s.cats) });
app.get('/api/suppliers', needUser, wrap(async (req, res) => {
  const rows = await db.all(`SELECT s.*, (SELECT COUNT(*) FROM rfq_sends x WHERE x.supplier_id = s.id) AS rfq,
      (SELECT ROUND(100 * SUM(x.answered_at IS NOT NULL) / NULLIF(COUNT(*),0)) FROM rfq_sends x WHERE x.supplier_id = s.id) AS resp
    FROM suppliers s WHERE s.status <> 'inactiv' ORDER BY s.name`);
  const out = rows.map(mapSup).map(s => (req.user.role === 'admin' ? s : { id: s.id, name: s.name, cats: s.cats }));
  res.json({ suppliers: out });
}));

app.post('/api/suppliers', needAdmin, wrap(async (req, res) => {
  const { name, cui = '', email, cats = [] } = req.body || {};
  if (String(name || '').trim().length < 3) throw bad(400, 'Scrie denumirea firmei.');
  if (!emailOk(email)) throw bad(400, 'Introdu emailul la care primește cererile de ofertă.');
  if (!Array.isArray(cats) || !cats.length) throw bad(400, 'Alege cel puțin o categorie.');
  const r = await db.run('INSERT INTO suppliers (name, cui, email, cats, status) VALUES (?,?,?,?,?)', [name.trim(), String(cui).slice(0, 20), email.toLowerCase(), JSON.stringify(cats.filter(c => ai.CATS.includes(c))), 'invitat']);
  mail.send({ to: email, subject: 'Primești cereri de ofertă prin FondMarket', html: mail.layout('Ai fost înregistrat ca furnizor', `<p>Bună ziua,</p><p><b>${mail.esc(name)}</b> a fost înregistrat pe FondMarket ca furnizor pentru: ${mail.esc(cats.join(', '))}.</p><p>Vei primi pe acest email cereri de ofertă de la beneficiari Start-Up Nation care cumpără echipamente din categoriile tale. Răspunzi direct din linkul din email, fără cont și fără costuri.</p>`) }).catch(e => console.error('[mail]', e.message));
  res.json({ supplier: mapSup(await db.one('SELECT * FROM suppliers WHERE id = ?', [r.insertId])) });
}));

/* ---------- cereri de ofertă ---------- */
app.post('/api/rfqs', needUser, wrap(async (req, res) => {
  const { title, items = [], supplierIds = [], deadlineDays = 7, lot = '' } = req.body || {};
  if (!items.length) throw bad(400, 'Cererea nu are echipamente.');
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin) {
    const paid = await db.one(`SELECT no FROM orders WHERE user_id = ? AND status = 'plătită' AND (pkg_key = 'proiect' OR lot = ?) LIMIT 1`, [req.user.id, String(lot)]);
    if (!paid) throw bad(402, 'Dosarul nu e plătit încă. Alege și plătește un pachet ca să trimiți cererile.');
  }
  const sups = supplierIds.length ? await db.all("SELECT * FROM suppliers WHERE id IN (?) AND status <> 'inactiv'", [supplierIds.slice(0, 10)]) : [];
  if (sups.length < 1) throw bad(400, 'Alege furnizorii cărora le trimiți cererea.');
  const firm = await db.one('SELECT * FROM firms WHERE user_id = ?', [req.user.id]);
  const deadline = new Date(Date.now() + Math.min(30, Math.max(3, Number(deadlineDays) || 7)) * 864e5);
  const r = await db.run('INSERT INTO rfqs (user_id, title, items, deadline) VALUES (?,?,?,?)', [req.user.id, String(title || 'Cerere de ofertă').slice(0, 255), JSON.stringify(items.slice(0, 60)), deadline.toISOString().slice(0, 10)]);
  const list = items.map(it => `<li><b>${mail.esc(it.name)}</b> × ${Number(it.qty) || 1}${(it.specs || []).length ? `<br><span style="color:#475569">Minim: ${mail.esc(it.specs.map(specTxt).join('; '))}</span>` : ''}</li>`).join('');
  const sends = [];
  for (const s of sups) {
    const token = crypto.randomBytes(16).toString('hex');
    await db.run('INSERT INTO rfq_sends (token, rfq_id, supplier_id) VALUES (?,?,?)', [token, r.insertId, s.id]);
    const link = `${PUBLIC_URL}/oferta/${token}`;
    sends.push({ supplier: s.name, token, sent_at: new Date().toISOString() });
    mail.send({
      to: s.email,
      replyTo: firm && firm.email ? firm.email : undefined,
      subject: `Cerere de ofertă: ${title || 'echipamente'} (${firm ? firm.name : 'beneficiar Start-Up Nation'})`,
      html: mail.layout('Cerere de ofertă', `<p>Bună ziua,</p><p><b>${mail.esc(firm ? firm.name : 'Un beneficiar')}</b>, beneficiar Start-Up Nation, vă roagă să transmiteți o ofertă de preț pentru:</p><ul>${list}</ul><p>Ofertele care nu îndeplinesc specificațiile minime nu vor fi luate în considerare. Termen de răspuns: <b>${deadline.toLocaleDateString('ro-RO')}</b>.</p><p><a href="${link}" style="display:inline-block;background:#1e3a8a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Trimite oferta</a></p>`),
    }).catch(e => console.error('[mail]', e.message));
  }
  res.json({ rfq: { id: r.insertId, deadline: deadline.toISOString().slice(0, 10), sends } });
}));

app.get('/api/rfqs', needUser, wrap(async (req, res) => {
  const where = req.user.role === 'admin' ? '1=1' : 'r.user_id = ?';
  const rows = await db.all(`SELECT r.id, r.title, r.items, r.deadline, r.created_at, s.name AS supplier, x.token, x.sent_at, x.opened_at, x.answered_at, x.price, x.note, x.file_name
    FROM rfqs r JOIN rfq_sends x ON x.rfq_id = r.id JOIN suppliers s ON s.id = x.supplier_id WHERE ${where} ORDER BY r.created_at DESC`, [req.user.id]);
  const by = {};
  for (const row of rows) {
    by[row.id] = by[row.id] || { id: row.id, title: row.title, items: db.json(row.items), deadline: row.deadline, created_at: row.created_at, sends: [] };
    by[row.id].sends.push({ supplier: row.supplier, token: row.token, sent_at: row.sent_at, opened_at: row.opened_at, answered_at: row.answered_at, price: row.price == null ? null : Number(row.price), note: row.note, file_name: row.file_name });
  }
  res.json({ rfqs: Object.values(by) });
}));

app.get('/api/rfqs/file/:token', needUser, wrap(async (req, res) => {
  const x = await db.one('SELECT x.file, x.file_name, r.user_id FROM rfq_sends x JOIN rfqs r ON r.id = x.rfq_id WHERE x.token = ?', [req.params.token]);
  if (!x || !x.file || (req.user.role !== 'admin' && x.user_id !== req.user.id)) throw bad(404, 'Fișierul nu există.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(x.file_name || 'oferta.pdf')}"`);
  res.send(x.file);
}));

/* ---------- pagina furnizorului (fără cont) ---------- */
async function sendByToken(token) {
  return db.one(`SELECT x.*, r.title, r.items, r.deadline, s.name AS supplier, f.name AS firm, f.email AS femail
    FROM rfq_sends x JOIN rfqs r ON r.id = x.rfq_id JOIN suppliers s ON s.id = x.supplier_id LEFT JOIN firms f ON f.user_id = r.user_id WHERE x.token = ?`, [token]);
}
app.get('/oferta/:token', wrap(async (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.token)) return res.status(404).send(supplierPage.notFound());
  const x = await sendByToken(req.params.token);
  if (!x) return res.status(404).send(supplierPage.notFound());
  if (!x.opened_at) await db.run('UPDATE rfq_sends SET opened_at = NOW() WHERE token = ?', [x.token]);
  await db.run("UPDATE suppliers SET status = 'activ' WHERE id = ? AND status = 'invitat'", [x.supplier_id]);
  res.send(supplierPage.render({ ...x, items: db.json(x.items) }));
}));
const offerLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 20 });
app.post('/api/oferta/:token', offerLimiter, wrap(async (req, res) => {
  const x = await sendByToken(req.params.token);
  if (!x) throw bad(404, 'Linkul nu mai e valid.');
  const price = Number(String(req.body.price || '').replace(/\./g, '').replace(',', '.'));
  if (!(price > 0)) throw bad(400, 'Introdu prețul total fără TVA.');
  let file = null; let fileName = null;
  if (req.body.fileBase64) {
    file = Buffer.from(String(req.body.fileBase64), 'base64');
    if (file.length > 15e6) throw bad(413, 'Fișierul e prea mare (maximum 15 MB).');
    if (file.slice(0, 4).toString() !== '%PDF') throw bad(400, 'Încarcă oferta ca PDF.');
    fileName = String(req.body.fileName || 'oferta.pdf').slice(0, 190);
  }
  await db.run('UPDATE rfq_sends SET answered_at = NOW(), price = ?, note = ?, file = COALESCE(?, file), file_name = COALESCE(?, file_name) WHERE token = ?', [price, String(req.body.note || '').slice(0, 4000), file, fileName, x.token]);
  if (x.femail) mail.send({ to: x.femail, subject: `Ofertă nouă: ${x.supplier}`, html: mail.layout('Ai primit o ofertă', `<p><b>${mail.esc(x.supplier)}</b> a răspuns la cererea „${mail.esc(x.title)}”: <b>${price.toLocaleString('ro-RO')} lei</b> fără TVA.</p><p>Vezi oferta și comparația cu oferta de la depunere în <a href="${PUBLIC_URL}/">FondMarket</a>.</p>`) }).catch(e => console.error('[mail]', e.message));
  res.json({ ok: true });
}));

/* ---------- aplicația ---------- */
const B2B = process.env.STATIC_DIR || path.join(__dirname, '..', 'b2b');
app.use(express.static(B2B, { index: 'index.html', extensions: ['html'], maxAge: '1h' }));
app.get('/', (_req, res) => res.sendFile(path.join(B2B, 'index.html')));

app.use('/api', (_req, _res, next) => next(bad(404, 'Adresa nu există.')));
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !err.expose && !err.status ? 'A apărut o eroare pe server. Încearcă din nou.' : err.message });
});

(async () => {
  await db.migrate();
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const e = process.env.ADMIN_EMAIL.toLowerCase();
    if (!(await db.one('SELECT id FROM users WHERE email = ?', [e]))) {
      await db.run('INSERT INTO users (email, pass, role, name) VALUES (?,?,?,?)', [e, await bcrypt.hash(process.env.ADMIN_PASSWORD, 10), 'admin', 'Administrator']);
      console.log('Cont de administrator creat:', e);
    }
  }
  app.listen(PORT, () => console.log(`FondMarket pornit pe portul ${PORT}`));
})().catch(e => { console.error('Pornire eșuată:', e.message); process.exit(1); });
