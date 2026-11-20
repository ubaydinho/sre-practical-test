'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const SOURCE_URL = 'https://api.sampleapis.com/coffee/hot';
const SLOW_MS = Number(process.env.SLOW_MS || 1000);
const ERR_LIMIT = 3, ERR_WINDOW_MS = 60000;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------- Logging (JSON lines: access / transaction / error) ----------
function writeLog(file, obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  fs.appendFile(path.join(LOG_DIR, file), line + '\n', () => {});
  console.log(`[${file.replace('.log', '')}] ${line}`);
}
const accessLog = (o) => writeLog('access.log', o);
const txLog = (o) => writeLog('transaction.log', o);
const errorLog = (o) => writeLog('error.log', o);

// ---------- Database ----------
const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- MASTER table (data from Sample APIs / coffee)
CREATE TABLE IF NOT EXISTS coffees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id INTEGER UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  ingredients TEXT,
  image TEXT,
  price INTEGER NOT NULL DEFAULT 25000,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- TRANSACTIONAL table
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  coffee_id INTEGER NOT NULL REFERENCES coffees(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);
if (!db.prepare('SELECT 1 FROM users WHERE username=?').get('admin')) {
  db.prepare('INSERT INTO users(username,password_hash) VALUES(?,?)')
    .run('admin', bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10));
}

// ---------- Alert simulation (in-memory) ----------
const alerts = [];
const recentErrors = [];
function raiseAlert(name, detail) {
  const a = { ts: new Date().toISOString(), alert: name, ...detail };
  alerts.unshift(a); alerts.splice(50);
  writeLog('error.log', { level: 'ALERT', ...a });
}
function trackError() {
  const now = Date.now();
  recentErrors.push(now);
  while (recentErrors.length && now - recentErrors[0] > ERR_WINDOW_MS) recentErrors.shift();
  if (recentErrors.length > ERR_LIMIT) {
    raiseAlert('HighErrorRate', { detail: `${recentErrors.length} errors (5xx) in last 60s, threshold=${ERR_LIMIT}` });
  }
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

const stats = { total: 0, errors: 0, startedAt: Date.now() };
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const endpoint = req.originalUrl.split('?')[0];
    stats.total++;
    accessLog({ method: req.method, endpoint, status: res.statusCode, response_time_ms: +ms.toFixed(1) });
    if (res.statusCode >= 500) { stats.errors++; trackError(); }
    if (ms > SLOW_MS) raiseAlert('SlowResponse', { detail: `${req.method} ${endpoint} took ${ms.toFixed(0)}ms (> ${SLOW_MS}ms)` });
  });
  next();
});

class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isInt = (v) => Number.isInteger(v) && v > 0;

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const [scheme, token] = h.split(' ');
  if (scheme !== 'Bearer' || !token) return next(new HttpError(401, 'Missing Bearer token'));
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { next(new HttpError(401, 'Invalid or expired token')); }
}

// ---------- Public ----------
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime_s: Math.round(process.uptime()), db: 'up',
      requests: stats.total, errors: stats.errors });
  } catch (e) {
    errorLog({ msg: 'health check failed', error: e.message });
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

app.post('/api/auth/register', wrap((req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || username.trim().length < 3) throw new HttpError(400, 'username min 3 chars');
  if (typeof password !== 'string' || password.length < 6) throw new HttpError(400, 'password min 6 chars');
  try {
    const r = db.prepare('INSERT INTO users(username,password_hash) VALUES(?,?)')
      .run(username.trim(), bcrypt.hashSync(password, 10));
    res.status(201).json({ id: r.lastInsertRowid, username: username.trim() });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'username already exists');
    throw e;
  }
}));

app.post('/api/auth/login', wrap((req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) throw new HttpError(400, 'username and password required');
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) throw new HttpError(401, 'Invalid credentials');
  const token = jwt.sign({ sub: u.id, username: u.username }, JWT_SECRET, { expiresIn: '2h' });
  res.json({ token, token_type: 'Bearer', expires_in: 7200 });
}));

// Demo endpoints to simulate alerts (no auth, for testing only)
app.get('/debug/error', (req, res, next) => next(new Error('Simulated failure')));
app.get('/debug/slow', (req, res) => setTimeout(() => res.json({ ok: true }), SLOW_MS + 500));

// ---------- Protected ----------
app.use('/api', auth);

app.get('/api/alerts', (req, res) => res.json({ count: alerts.length, alerts }));

// Fetch from Sample API and save to local DB
const FALLBACK = [
  { id: 1, title: 'Black', description: 'Black coffee is simply water and coffee.', ingredients: ['Coffee'], image: '' },
  { id: 2, title: 'Latte', description: 'Espresso with steamed milk and a little foam.', ingredients: ['Espresso', 'Steamed Milk'], image: '' },
  { id: 3, title: 'Cappuccino', description: 'Espresso, steamed milk and thick foam.', ingredients: ['Espresso', 'Steamed Milk', 'Foam'], image: '' }
];
app.post('/api/sync', wrap(async (req, res) => {
  let items, source = 'sampleapis';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(SOURCE_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(`upstream status ${r.status}`);
    items = await r.json();
    if (!Array.isArray(items)) throw new Error('unexpected upstream payload');
  } catch (e) {
    errorLog({ msg: 'sampleapis fetch failed, using fallback data', error: e.message });
    items = FALLBACK; source = 'fallback';
  }
  const up = db.prepare(`INSERT INTO coffees(external_id,title,description,ingredients,image,price)
    VALUES(@external_id,@title,@description,@ingredients,@image,@price)
    ON CONFLICT(external_id) DO UPDATE SET title=excluded.title, description=excluded.description,
      ingredients=excluded.ingredients, image=excluded.image`);
  const tx = db.transaction((rows) => rows.forEach((c) => up.run({
    external_id: c.id, title: String(c.title || 'Unknown'), description: c.description || '',
    ingredients: JSON.stringify(c.ingredients || []), image: c.image || '',
    price: 20000 + (Number(c.id) % 5) * 2500
  })));
  tx(items);
  txLog({ type: 'SYNC', source, count: items.length, user: req.user.username });
  res.json({ message: 'Sync complete', source, count: items.length });
}));

const parseCoffee = (r) => r && { ...r, ingredients: JSON.parse(r.ingredients || '[]') };

function validateCoffee(b, partial = false) {
  const errs = [];
  if (!partial || b.title !== undefined) if (typeof b.title !== 'string' || !b.title.trim()) errs.push('title is required');
  if (b.price !== undefined && (!Number.isInteger(b.price) || b.price < 0)) errs.push('price must be a non-negative integer');
  if (b.ingredients !== undefined && !Array.isArray(b.ingredients)) errs.push('ingredients must be an array');
  if (errs.length) throw new HttpError(422, 'Validation failed', errs);
}

app.get('/api/coffees', (req, res) => {
  const q = `%${(req.query.q || '').toString()}%`;
  res.json(db.prepare('SELECT * FROM coffees WHERE title LIKE ? ORDER BY id').all(q).map(parseCoffee));
});
app.get('/api/coffees/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM coffees WHERE id=?').get(req.params.id);
  if (!r) throw new HttpError(404, 'Coffee not found');
  res.json(parseCoffee(r));
});
app.post('/api/coffees', wrap((req, res) => {
  const b = req.body || {}; validateCoffee(b);
  const r = db.prepare('INSERT INTO coffees(title,description,ingredients,image,price) VALUES(?,?,?,?,?)')
    .run(b.title.trim(), b.description || '', JSON.stringify(b.ingredients || []), b.image || '', b.price ?? 25000);
  res.status(201).json(parseCoffee(db.prepare('SELECT * FROM coffees WHERE id=?').get(r.lastInsertRowid)));
}));
app.put('/api/coffees/:id', wrap((req, res) => {
  const cur = db.prepare('SELECT * FROM coffees WHERE id=?').get(req.params.id);
  if (!cur) throw new HttpError(404, 'Coffee not found');
  const b = req.body || {}; validateCoffee(b, true);
  db.prepare('UPDATE coffees SET title=?,description=?,ingredients=?,image=?,price=? WHERE id=?').run(
    b.title ?? cur.title, b.description ?? cur.description,
    b.ingredients ? JSON.stringify(b.ingredients) : cur.ingredients, b.image ?? cur.image, b.price ?? cur.price, cur.id);
  res.json(parseCoffee(db.prepare('SELECT * FROM coffees WHERE id=?').get(cur.id)));
}));
app.delete('/api/coffees/:id', wrap((req, res) => {
  try {
    const r = db.prepare('DELETE FROM coffees WHERE id=?').run(req.params.id);
    if (!r.changes) throw new HttpError(404, 'Coffee not found');
  } catch (e) {
    if (String(e.message).includes('FOREIGN KEY')) throw new HttpError(409, 'Coffee is referenced by orders');
    throw e;
  }
  res.status(204).end();
}));

// Orders (transactional)
const ORDER_SQL = `SELECT o.*, c.title AS coffee_title, u.username FROM orders o
  JOIN coffees c ON c.id=o.coffee_id JOIN users u ON u.id=o.user_id`;
const STATUSES = ['pending', 'paid', 'done', 'cancelled'];

app.get('/api/orders', (req, res) => res.json(db.prepare(`${ORDER_SQL} ORDER BY o.id DESC`).all()));
app.get('/api/orders/:id', (req, res) => {
  const r = db.prepare(`${ORDER_SQL} WHERE o.id=?`).get(req.params.id);
  if (!r) throw new HttpError(404, 'Order not found');
  res.json(r);
});
app.post('/api/orders', wrap((req, res) => {
  const { coffee_id, qty, note } = req.body || {};
  const errs = [];
  if (!isInt(coffee_id)) errs.push('coffee_id must be a positive integer');
  if (!isInt(qty) || qty > 100) errs.push('qty must be an integer between 1 and 100');
  if (errs.length) throw new HttpError(422, 'Validation failed', errs);
  const c = db.prepare('SELECT * FROM coffees WHERE id=?').get(coffee_id);
  if (!c) throw new HttpError(404, 'Coffee not found');
  const r = db.prepare('INSERT INTO orders(user_id,coffee_id,qty,total,note) VALUES(?,?,?,?,?)')
    .run(req.user.sub, c.id, qty, c.price * qty, note || null);
  txLog({ type: 'ORDER_CREATED', order_id: r.lastInsertRowid, coffee_id: c.id, qty, total: c.price * qty, user: req.user.username });
  res.status(201).json(db.prepare(`${ORDER_SQL} WHERE o.id=?`).get(r.lastInsertRowid));
}));
app.put('/api/orders/:id', wrap((req, res) => {
  const cur = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!cur) throw new HttpError(404, 'Order not found');
  const { status, qty, note } = req.body || {};
  if (status !== undefined && !STATUSES.includes(status)) throw new HttpError(422, 'Validation failed', [`status must be one of ${STATUSES.join(', ')}`]);
  if (qty !== undefined && (!isInt(qty) || qty > 100)) throw new HttpError(422, 'Validation failed', ['qty must be an integer between 1 and 100']);
  const price = db.prepare('SELECT price FROM coffees WHERE id=?').get(cur.coffee_id).price;
  const nq = qty ?? cur.qty;
  db.prepare('UPDATE orders SET status=?,qty=?,total=?,note=? WHERE id=?')
    .run(status ?? cur.status, nq, price * nq, note ?? cur.note, cur.id);
  txLog({ type: 'ORDER_UPDATED', order_id: cur.id, status: status ?? cur.status, qty: nq, user: req.user.username });
  res.json(db.prepare(`${ORDER_SQL} WHERE o.id=?`).get(cur.id));
}));
app.delete('/api/orders/:id', wrap((req, res) => {
  const r = db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
  if (!r.changes) throw new HttpError(404, 'Order not found');
  txLog({ type: 'ORDER_DELETED', order_id: Number(req.params.id), user: req.user.username });
  res.status(204).end();
}));

app.get('/api/summary', (req, res) => {
  res.json({
    coffees: db.prepare('SELECT COUNT(*) n FROM coffees').get().n,
    orders: db.prepare('SELECT COUNT(*) n FROM orders').get().n,
    revenue: db.prepare("SELECT COALESCE(SUM(total),0) n FROM orders WHERE status!='cancelled'").get().n
  });
});

// ---------- Frontend & error handling ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => next(new HttpError(404, `Route ${req.method} ${req.path} not found`)));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) errorLog({ method: req.method, endpoint: req.originalUrl, status, error: err.message, stack: err.stack });
  res.status(status).json({
    error: status >= 500 ? 'Internal Server Error' : err.message,
    ...(err.details ? { details: err.details } : {})
  });
});

const server = app.listen(PORT, () => console.log(`Listening on :${PORT}`));
function shutdown(sig) {
  console.log(`${sig} received, shutting down gracefully`);
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => errorLog({ msg: 'unhandledRejection', error: String(e) }));
