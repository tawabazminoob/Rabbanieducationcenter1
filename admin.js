'use strict';
/* =====================================================================================
 * RABBANI EDUCATION CIRCLE - admin.js
 * Private admin interface (HTML/CSS/JS inlined) + protected REST API, packaged as ONE
 * Vercel serverless function. Routed here by vercel.json for:
 *   /admin                -> admin login + dashboard page
 *   /api/admin/login      -> POST   (rate limited, bcrypt verification)
 *   /api/admin/logout     -> POST   (invalidates all sessions for the admin)
 *   /api/admin/me         -> GET    (session probe + CSRF token)
 *   /api/admin/admissions -> GET    (server-side paginated, filtered, searchable)
 *   /api/admin/admissions/:id -> GET / PATCH (status, notes) / DELETE
 *   /api/admin/stats      -> GET    (counts computed in MongoDB, date-filterable)
 *   /api/admin/export     -> GET    (CSV download, same filters)
 *
 * SECURITY DESIGN
 *   - Passwords: bcrypt hashes only (bcryptjs), compared in near-constant time.
 *   - Sessions: HMAC-SHA256 signed tokens (HttpOnly cookie, SameSite=Lax, Secure in
 *     production) + server-side tokenVersion so logout revokes every outstanding token.
 *   - CSRF: stateless double-submit token derived from the session token + secret,
 *     required on every mutating endpoint, plus Origin/Referer validation.
 *   - Login lockout: per-email failed-attempt counter and per-IP attempt counter,
 *     both stored in MongoDB so they survive across serverless instances.
 *   - First admin is bootstrapped ONLY from environment variables (ADMIN_EMAIL +
 *     ADMIN_PASSWORD_HASH) while the admins collection is empty. No default password,
 *     no public registration, ever.
 * ===================================================================================== */

const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const IS_PROD = process.env.NODE_ENV === 'production';
const DB_NAME = process.env.MONGODB_DB_NAME || 'rabbani_education_circle';
const BODY_LIMIT = 16 * 1024;
const COOKIE_NAME = 'rec_admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const STATUSES = ['pending', 'contacted', 'approved', 'rejected'];
const LEARNING_MODES = ['online', 'offline'];
const EXPORT_CAP = 5000;

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status; this.code = code; this.extra = extra || {};
  }
}

function redact(msg) {
  let out = String(msg == null ? '' : msg);
  for (const k of ['MONGODB_URI', 'SESSION_SECRET', 'ADMIN_PASSWORD_HASH']) {
    const v = process.env[k];
    if (v) out = out.split(v).join('***');
  }
  return out;
}

/* ---- Response helpers -------------------------------------------------------------- */
function applyBaseHeaders(res, extra) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (extra) for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

function sendJson(res, status, obj, extra) {
  applyBaseHeaders(res, extra);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.statusCode = status;
  res.end(JSON.stringify(obj));
}

function sendHtml(res, status, html, nonce) {
  applyBaseHeaders(res, {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'nonce-" + nonce + "'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'"
    ].join('; '),
    'Cache-Control': 'no-store, max-age=0'
  });
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.statusCode = status;
  res.end(html);
}

function requestPath(req) {
  let p = '/';
  try { p = decodeURIComponent(new URL(req.url || '/', 'http://internal').pathname); } catch (e) {}
  if (p === '/admin.js') p = '/admin';
  if (p.endsWith('/') && p !== '/') p = p.slice(0, -1);
  return p;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) {
    const first = fwd.split(',')[0].trim();
    if (first) return first;
  }
  return (req.socket && req.socket.remoteAddress) || '0.0.0.0';
}
function hashClient(req) {
  const salt = process.env.SESSION_SECRET || 'rec-rate-salt';
  return crypto.createHash('sha256').update(salt + '|' + clientIp(req)).digest('hex').slice(0, 32);
}

async function readJsonBody(req, limitBytes) {
  const declared = parseInt(String(req.headers['content-length'] || '0'), 10);
  if (declared > limitBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.'); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
  }
  return data;
}

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function findOneAndUpdateDoc(coll, filter, update, opts) {
  const r = await coll.findOneAndUpdate(filter, update, opts);
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    if ('value' in r) return r.value;
    return r;
  }
  return null;
}

/* ---- MongoDB (cached connection) --------------------------------------------------- */
let _mongoCache = (typeof globalThis !== 'undefined' && globalThis.__recMongoAdmin) || null;

async function getDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri || !/^mongodb(\+srv)?:\/\//i.test(uri)) {
    throw new HttpError(503, 'CONFIG_MISSING', 'The admin service is not configured. Set MONGODB_URI.');
  }
  if (!_mongoCache || !_mongoCache.promise) {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000,
      maxIdleTimeMS: 30 * 1000, retryWrites: true
    });
    _mongoCache = { promise: client.connect().then(c => ({ client, db: c.db(DB_NAME) })) };
    if (typeof globalThis !== 'undefined') globalThis.__recMongoAdmin = _mongoCache;
    _mongoCache.promise.catch(() => { _mongoCache = null; if (globalThis.__recMongoAdmin) globalThis.__recMongoAdmin = null; });
  }
  try {
    return (await _mongoCache.promise).db;
  } catch (e) {
    _mongoCache = null;
    if (globalThis.__recMongoAdmin) globalThis.__recMongoAdmin = null;
    throw new HttpError(503, 'DB_UNAVAILABLE', 'Database is temporarily unavailable. Please try again shortly.');
  }
}

async function ensureSchema(db) {
  if (db.__recAdminSchemaReady) return;
  try {
    await Promise.all([
      db.collection('admins').createIndex({ email: 1 }, { unique: true }),
      db.collection('admissions').createIndex({ appId: 1 }, { unique: true }),
      db.collection('admissions').createIndex({ idempotencyKey: 1 }, { unique: true }),
      db.collection('admissions').createIndex({ createdAt: -1 }),
      db.collection('admissions').createIndex({ status: 1, createdAt: -1 }),
      db.collection('admissions').createIndex({ courseId: 1 }),
      db.collection('admissions').createIndex({ mobile: 1 }),
      db.collection('rate_limits').createIndex({ exp: 1 }, { expireAfterSeconds: 0 })
    ]);
    db.__recAdminSchemaReady = true;
  } catch (e) {
    console.error('[db] admin index setup skipped:', redact(e.message));
  }
}

async function rateBucketCount(db, bucket, idHash, windowMs) {
  const bucketNo = Math.floor(Date.now() / windowMs);
  const key = bucket + ':' + idHash + ':' + bucketNo;
  const doc = await findOneAndUpdateDoc(
    db.collection('rate_limits'),
    { _id: key },
    { $inc: { n: 1 }, $setOnInsert: { exp: new Date(Date.now() + windowMs + 60 * 1000) } },
    { upsert: true, returnDocument: 'after' }
  );
  return doc && typeof doc.n === 'number' ? doc.n : 1;
}

/* =====================================================================================
 * AUTH CORE
 * ===================================================================================== */
function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new HttpError(503, 'CONFIG_MISSING', 'The admin service is not configured. Set SESSION_SECRET (at least 32 random characters).');
  }
  return s;
}

const b64url = buf => Buffer.from(buf).toString('base64url');
const hmacOf = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest();

function signToken(payload) {
  const secret = sessionSecret();
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(hmacOf(secret, body));
  return body + '.' + sig;
}

function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const secret = sessionSecret();
  let expected;
  try { expected = b64url(hmacOf(secret, parts[0])); } catch (e) { return null; }
  const got = parts[1];
  if (expected.length !== got.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got))) return null;
  } catch (e) { return null; }
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (typeof payload.sub !== 'string' || !/^[a-f0-9]{24}$/.test(payload.sub)) return null;
    return payload;
  } catch (e) { return null; }
}

function csrfTokenFor(token) {
  return b64url(hmacOf(sessionSecret(), 'csrf|' + token));
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (typeof h !== 'string' || !h) return out;
  h.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function setSessionCookie(res, token) {
  const parts = [
    COOKIE_NAME + '=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000)
  ];
  if (IS_PROD) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const all = Array.isArray(prev) ? prev.concat(parts.join('; ')) : (prev ? [prev, parts.join('; ')] : parts.join('; '));
  res.setHeader('Set-Cookie', all);
}

function clearSessionCookie(res) {
  const parts = [COOKIE_NAME + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (IS_PROD) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/* ---- First-admin bootstrap (environment-variable driven, one-time, idempotent) ------ */
async function ensureAdminBootstrap(db) {
  const admins = db.collection('admins');
  const count = await admins.countDocuments({}, { maxTimeMS: 5000 });
  if (count > 0) return;
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const hash = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
  if (!email || !EMAIL_RE.test(email) || !BCRYPT_HASH_RE.test(hash)) {
    throw new HttpError(503, 'ADMIN_NOT_INITIALIZED',
      'No administrator account exists yet. Initialize one by setting ADMIN_EMAIL and ADMIN_PASSWORD_HASH (a bcrypt hash) in the environment variables.');
  }
  const now = new Date();
  await admins.insertOne({
    email, passwordHash: hash, name: 'Administrator', role: 'admin',
    tokenVersion: 0, source: 'env-bootstrap', createdAt: now, updatedAt: now, lastLoginAt: null
  });
  console.log('[admin] initial administrator bootstrapped from environment variables');
}

/* ---- Request authentication ---------------------------------------------------------- */
async function authenticate(req, db) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const admin = await db.collection('admins').findOne({ _id: new ObjectId(payload.sub) }, { maxTimeMS: 5000 });
  if (!admin) return null;
  if ((admin.tokenVersion || 0) !== (payload.v | 0)) return null; // revoked (logout)
  return { admin, token };
}

function requireAuth(result) {
  if (!result) throw new HttpError(401, 'UNAUTHORIZED', 'Please sign in to continue.');
  return result;
}

function expectedOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || (IS_PROD ? 'https' : 'http')).split(',')[0].trim();
  const host = req.headers.host;
  return host ? proto + '://' + host : null;
}

function sameOriginOk(req) {
  const expected = expectedOrigin(req);
  if (!expected) return true; // no host information (unusual) - cookie+CSRF still protect us
  const origin = String(req.headers.origin || '');
  if (origin) return origin === expected;
  const referer = String(req.headers.referer || '');
  if (referer) return referer.indexOf(expected + '/') === 0 || referer === expected;
  return false; // mutations must come with Origin or Referer
}

function csrfOk(req, session) {
  const header = String(req.headers['x-csrf-token'] || '');
  if (!header) return false;
  const expected = csrfTokenFor(session.token);
  if (header.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected)); }
  catch (e) { return false; }
}

function guardMutation(req, session) {
  if (!sameOriginOk(req)) throw new HttpError(403, 'FORBIDDEN', 'Request origin verification failed.');
  if (!csrfOk(req, session)) throw new HttpError(403, 'CSRF', 'Security token mismatch. Refresh the page and try again.');
}

const { ObjectId } = require('mongodb');
function isValidObjectId(s) { return typeof s === 'string' && /^[a-f0-9]{24}$/.test(s); }

function sanitizeApplication(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    appId: doc.appId,
    studentName: doc.studentName,
    guardianName: doc.guardianName || null,
    mobile: doc.mobile,
    guardianMobile: doc.guardianMobile || null,
    email: doc.email || null,
    className: doc.className,
    courseId: doc.courseId,
    courseName: doc.courseName,
    subjects: Array.isArray(doc.subjects) ? doc.subjects : [],
    learningMode: doc.learningMode,
    preferredBatch: doc.preferredBatch,
    school: doc.school || null,
    city: doc.city,
    message: doc.message || null,
    status: doc.status,
    adminNotes: doc.adminNotes || '',
    updatedBy: doc.updatedBy || null,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* =====================================================================================
 * SECTION 2 - ADMIN API HANDLERS
 * ===================================================================================== */

function queryParams(req) {
  try { return new URL(req.url || '/', 'http://internal').searchParams; }
  catch (e) { return new URLSearchParams(); }
}

function parseDateParam(raw, endOfDay) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return null;
  const d = new Date(s.length === 10 ? s + (endOfDay ? 'T23:59:59.999' : 'T00:00:00.000') : s);
  return isNaN(d.getTime()) ? null : d;
}

function buildAdmissionFilter(sp) {
  const f = {};
  const status = String(sp.get('status') || '').toLowerCase();
  if (STATUSES.includes(status)) f.status = status;
  const course = String(sp.get('course') || '');
  if (/^[a-z0-9-]{2,40}$/.test(course)) f.courseId = course;
  const mode = String(sp.get('mode') || '').toLowerCase();
  if (LEARNING_MODES.includes(mode)) f.learningMode = mode;
  const from = parseDateParam(sp.get('from'), false);
  const to = parseDateParam(sp.get('to'), true);
  if (from || to) {
    f.createdAt = {};
    if (from) f.createdAt.$gte = from;
    if (to) f.createdAt.$lte = to;
  }
  const qtext = String(sp.get('q') || '').slice(0, 80).trim();
  if (qtext) {
    const rx = new RegExp(escapeRegExp(qtext), 'i');
    const ors = [{ studentName: rx }, { appId: rx }, { city: rx }, { email: rx }];
    const digits = qtext.replace(/\D/g, '');
    if (digits.length >= 4) ors.push({ mobile: new RegExp(escapeRegExp(digits)) });
    f.$or = ors;
  }
  return f;
}

async function findApplication(db, idRaw) {
  const idStr = String(idRaw || '');
  let query = null;
  if (isValidObjectId(idStr)) query = { _id: new ObjectId(idStr) };
  else if (/^REC-\d{2}-\d{4,8}$/.test(idStr)) query = { appId: idStr };
  if (!query) return null;
  return db.collection('admissions').findOne(query, { maxTimeMS: 8000 });
}

/* ---- POST /api/admin/login ----------------------------------------------------------- */
let _dummyHash = null;
function dummyHash() {
  if (!_dummyHash) _dummyHash = bcrypt.hashSync('rec-timing-equalizer-' + Math.random(), 10);
  return _dummyHash;
}

async function handleLogin(req, res) {
  const db = await getDb();
  await ensureSchema(db);
  await ensureAdminBootstrap(db);
  if (!sameOriginOk(req)) throw new HttpError(403, 'FORBIDDEN', 'Request origin verification failed.');
  const body = await readJsonBody(req, BODY_LIMIT);

  const LOCK_WINDOW = 15 * 60 * 1000;
  const ipAttempts = await rateBucketCount(db, 'lgnip', hashClient(req), LOCK_WINDOW);
  if (ipAttempts > 20) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many login attempts from this connection. Try again in about 15 minutes.', { retryAfterSec: 900 });
  }

  const email = String(body.email == null ? '' : body.email).trim().toLowerCase();
  const password = String(body.password == null ? '' : body.password);
  const genericFail = new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
  if (!EMAIL_RE.test(email) || password.length < 1 || password.length > 200) throw genericFail;

  // Per-email failure lockout (counter stored in MongoDB, shared across instances)
  const failBucket = Math.floor(Date.now() / LOCK_WINDOW);
  const failKey = 'lgnfail:' + crypto.createHash('sha256').update(email + '|' + hashClient(req)).digest('hex').slice(0, 24) + ':' + failBucket;
  const failDoc = await db.collection('rate_limits').findOne({ _id: failKey });
  if (failDoc && typeof failDoc.n === 'number' && failDoc.n >= 5) {
    throw new HttpError(429, 'RATE_LIMITED', 'This account is temporarily locked after repeated failed logins. Try again in about 15 minutes.', { retryAfterSec: 900 });
  }

  const admin = await db.collection('admins').findOne({ email }, { maxTimeMS: 8000 });
  let valid = false;
  try {
    valid = await bcrypt.compare(password, admin ? admin.passwordHash : dummyHash());
  } catch (e) { valid = false; }
  if (!admin || !valid) {
    await db.collection('rate_limits').updateOne(
      { _id: failKey },
      { $inc: { n: 1 }, $setOnInsert: { exp: new Date(Date.now() + LOCK_WINDOW + 60 * 1000) } },
      { upsert: true }
    );
    await sleep(120 + Math.floor(Math.random() * 200)); // smooth response timing
    throw genericFail;
  }

  const now = Date.now();
  const token = signToken({
    sub: String(admin._id), em: admin.email, v: admin.tokenVersion | 0,
    iat: now, exp: now + SESSION_TTL_MS
  });
  await db.collection('rate_limits').updateOne(
    { _id: failKey },
    { $set: { n: 0 } }
  ).catch(() => {}); // successful sign-in resets the failure window
  await db.collection('admins').updateOne(
    { _id: admin._id },
    { $set: { lastLoginAt: new Date(now), updatedAt: new Date(now) } }
  );
  setSessionCookie(res, token);
  sendJson(res, 200, {
    ok: true,
    admin: { name: admin.name || 'Administrator', email: admin.email },
    csrfToken: csrfTokenFor(token)
  });
}

/* ---- POST /api/admin/logout ----------------------------------------------------------- */
async function handleLogout(req, res, session) {
  guardMutation(req, session);
  const db = await getDb();
  await db.collection('admins').updateOne(
    { _id: session.admin._id },
    { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date() } }
  );
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true, message: 'Signed out. All sessions for this account have been revoked.' });
}

/* ---- GET /api/admin/me ------------------------------------------------------------------ */
async function handleMe(req, res, session) {
  sendJson(res, 200, {
    ok: true,
    admin: { name: session.admin.name || 'Administrator', email: session.admin.email },
    csrfToken: csrfTokenFor(session.token)
  });
}

/* ---- GET /api/admin/admissions ----------------------------------------------------------- */
async function handleList(req, res, session) {
  const db = await getDb();
  const sp = queryParams(req);
  const page = Math.max(1, Math.min(10000, parseInt(String(sp.get('page') || '1'), 10) || 1));
  const limit = Math.max(1, Math.min(100, parseInt(String(sp.get('limit') || '10'), 10) || 10));
  const filter = buildAdmissionFilter(sp);
  const total = await db.collection('admissions').countDocuments(filter, { maxTimeMS: 8000 });
  const pages = Math.max(1, Math.ceil(total / limit));
  const docs = await db.collection('admissions')
    .find(filter, { projection: { idempotencyKey: 0 }, maxTimeMS: 8000 })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();
  sendJson(res, 200, {
    ok: true, page, pages, total, limit,
    items: docs.map(sanitizeApplication)
  });
}

/* ---- GET /api/admin/admissions/:id --------------------------------------------------------- */
async function handleDetail(req, res, session, idRaw) {
  const doc = await findApplication(await getDb(), idRaw);
  if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Application not found.');
  sendJson(res, 200, { ok: true, application: sanitizeApplication(doc) });
}

/* ---- PATCH /api/admin/admissions/:id -------------------------------------------------------- */
async function handlePatch(req, res, session, idRaw) {
  guardMutation(req, session);
  const db = await getDb();
  const doc = await findApplication(db, idRaw);
  if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Application not found.');
  const body = await readJsonBody(req, BODY_LIMIT);

  const updates = {};
  if (body.status !== undefined) {
    const status = String(body.status || '').toLowerCase();
    if (!STATUSES.includes(status)) throw new HttpError(400, 'VALIDATION', 'Status must be one of: ' + STATUSES.join(', ') + '.');
    updates.status = status;
  }
  if (body.adminNotes !== undefined) {
    const notes = String(body.adminNotes == null ? '' : body.adminNotes).replace(CONTROL_CHARS_RE, '').trim();
    if (notes.length > 2000) throw new HttpError(400, 'VALIDATION', 'Notes must be at most 2000 characters.');
    updates.adminNotes = notes;
  }
  if (!Object.keys(updates).length) {
    throw new HttpError(400, 'VALIDATION', 'Provide at least one field to update (status or adminNotes).');
  }
  updates.updatedAt = new Date();
  updates.updatedBy = session.admin.email;

  await db.collection('admissions').updateOne({ _id: doc._id }, { $set: updates }, { maxTimeMS: 8000 });
  const fresh = await db.collection('admissions').findOne({ _id: doc._id }, { maxTimeMS: 8000 });
  sendJson(res, 200, { ok: true, application: sanitizeApplication(fresh) });
}

/* ---- DELETE /api/admin/admissions/:id -------------------------------------------------------- */
async function handleDelete(req, res, session, idRaw) {
  guardMutation(req, session);
  const db = await getDb();
  const doc = await findApplication(db, idRaw);
  if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Application not found.');
  const r = await db.collection('admissions').deleteOne({ _id: doc._id }, { maxTimeMS: 8000 });
  if (!r.deletedCount) throw new HttpError(404, 'NOT_FOUND', 'Application not found.');
  sendJson(res, 200, { ok: true, deletedId: doc.appId });
}

/* ---- GET /api/admin/stats ---------------------------------------------------------------------- */
async function handleStats(req, res, session) {
  const db = await getDb();
  const sp = queryParams(req);
  const filter = buildAdmissionFilter(sp);
  const dateFilter = filter.createdAt || {};

  const facetRes = await db.collection('admissions').aggregate([
    { $match: filter },
    { $facet: {
      byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
      byMode: [{ $group: { _id: '$learningMode', n: { $sum: 1 } } }],
      byCourse: [{ $group: { _id: '$courseId', name: { $first: '$courseName' }, n: { $sum: 1 } } }]
    } }
  ], { maxTimeMS: 8000 }).toArray();

  const facet = (facetRes && facetRes[0]) || {};
  const counts = { total: 0, pending: 0, contacted: 0, approved: 0, rejected: 0 };
  ((facet.byStatus) || []).forEach(row => {
    if (row._id && row._id in counts) counts[row._id] = row.n;
    counts.total += row.n || 0;
  });
  const byMode = { online: 0, offline: 0 };
  ((facet.byMode) || []).forEach(row => { if (row._id && row._id in byMode) byMode[row._id] = row.n; });
  const byCourse = ((facet.byCourse) || [])
    .map(row => ({ id: row._id || 'unknown', name: row.name || 'Unknown course', count: row.n || 0 }))
    .sort((a, b) => b.count - a.count);

  const recentDocs = await db.collection('admissions')
    .find(filter, { projection: { idempotencyKey: 0 }, maxTimeMS: 8000 })
    .sort({ createdAt: -1 }).limit(5).toArray();
  const contactCount = await db.collection('contact_messages').countDocuments(
    Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}, { maxTimeMS: 8000 });

  sendJson(res, 200, {
    ok: true,
    counts,
    byMode,
    byCourse,
    recent: recentDocs.map(sanitizeApplication),
    contactMessages: contactCount,
    filtered: !!(dateFilter.$gte || dateFilter.$lte)
  });
}

/* ---- GET /api/admin/export (CSV) --------------------------------------------------------------- */
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
}

async function handleExport(req, res, session) {
  const db = await getDb();
  const sp = queryParams(req);
  const filter = buildAdmissionFilter(sp);
  const docs = await db.collection('admissions')
    .find(filter, { projection: { idempotencyKey: 0 }, maxTimeMS: 15000 })
    .sort({ createdAt: -1 })
    .limit(EXPORT_CAP + 1)
    .toArray();
  const truncated = docs.length > EXPORT_CAP;
  if (truncated) docs.length = EXPORT_CAP;

  const header = ['Reference ID', 'Submitted At', 'Student Name', 'Guardian Name', 'Mobile', 'Guardian Mobile',
    'Email', 'Class', 'Course', 'Learning Mode', 'Preferred Batch', 'Subjects', 'School', 'City',
    'Status', 'Last Updated By', 'Admin Notes', 'Message'];
  const lines = [header.map(csvCell).join(',')];
  for (const d of docs) {
    lines.push([
      d.appId, d.createdAt instanceof Date ? d.createdAt.toISOString() : d.createdAt,
      d.studentName, d.guardianName || '', d.mobile, d.guardianMobile || '', d.email || '',
      d.className, d.courseName, d.learningMode, d.preferredBatch,
      Array.isArray(d.subjects) ? d.subjects.join('; ') : '', d.school || '', d.city,
      d.status, d.updatedBy || '', d.adminNotes || '', d.message || ''
    ].map(csvCell).join(','));
  }
  const csv = '\ufeff' + lines.join('\r\n') + '\r\n';
  const filename = 'rabbani-admissions-' + new Date().toISOString().slice(0, 10) + '.csv';
  applyBaseHeaders(res);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Export-Rows', String(docs.length));
  if (truncated) res.setHeader('X-Export-Truncated', 'true');
  res.statusCode = 200;
  res.end(csv);
}

/* =====================================================================================
 * SECTION 3 - ADMIN DASHBOARD STYLES (same design tokens as the public site)
 * ===================================================================================== */

const ADMIN_CSS = `
:root {
  --ink: #10143a; --ink-soft: rgba(16, 20, 58, 0.74); --ink-faint: rgba(16, 20, 58, 0.55);
  --bg: #edf1fd;
  --surface: rgba(255, 255, 255, 0.66); --surface-2: rgba(255, 255, 255, 0.42);
  --stroke: rgba(255, 255, 255, 0.75); --stroke-soft: rgba(16, 20, 58, 0.10);
  --brand-1: #4f46e5; --brand-2: #7c3aed; --brand-3: #06b6d4; --brand-4: #ec4899;
  --ok: #059669; --warn: #b45309; --bad: #dc2626;
  --radius: 22px; --radius-sm: 14px;
  --shadow: 0 18px 50px -18px rgba(31, 25, 96, 0.35);
  --shadow-soft: 0 10px 34px -14px rgba(31, 25, 96, 0.25);
  --font: "Plus Jakarta Sans", "Noto Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --grad-brand: linear-gradient(135deg, #4f46e5 0%, #7c3aed 55%, #06b6d4 130%);
}
html[data-theme="dark"] {
  --ink: #edf0ff; --ink-soft: rgba(237, 240, 255, 0.75); --ink-faint: rgba(237, 240, 255, 0.55);
  --bg: #060a18;
  --surface: rgba(19, 26, 54, 0.55); --surface-2: rgba(19, 26, 54, 0.35);
  --stroke: rgba(148, 158, 226, 0.20); --stroke-soft: rgba(148, 158, 226, 0.14);
  --ok: #34d399; --warn: #fbbf24; --bad: #f87171;
  --shadow: 0 22px 60px -20px rgba(0, 0, 0, 0.65); --shadow-soft: 0 12px 40px -16px rgba(0, 0, 0, 0.55);
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0; font-family: var(--font); color: var(--ink); font-size: 15.5px; line-height: 1.6;
  -webkit-font-smoothing: antialiased; min-height: 100vh;
  background:
    radial-gradient(1000px 560px at 90% -10%, rgba(124, 58, 237, 0.20), transparent 62%),
    radial-gradient(820px 500px at -10% 20%, rgba(6, 182, 212, 0.16), transparent 60%),
    radial-gradient(700px 480px at 55% 115%, rgba(236, 72, 153, 0.12), transparent 62%),
    var(--bg);
  background-attachment: fixed;
}
::selection { background: rgba(124, 58, 237, 0.3); }
a { color: inherit; text-decoration: none; }
h1, h2, h3, h4 { margin: 0 0 0.45em; font-weight: 800; letter-spacing: -0.01em; }
p { color: var(--ink-soft); }
:focus-visible { outline: 3px solid rgba(6, 182, 212, 0.65); outline-offset: 2px; border-radius: 6px; }
.glass {
  background: var(--surface); -webkit-backdrop-filter: blur(18px) saturate(150%);
  backdrop-filter: blur(18px) saturate(150%); border: 1px solid var(--stroke);
  border-radius: var(--radius); box-shadow: var(--shadow-soft);
}
.grad-text { background: linear-gradient(92deg, var(--brand-1), var(--brand-2) 48%, var(--brand-3)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 9px;
  font: inherit; font-weight: 700; cursor: pointer; border: 1px solid transparent;
  padding: 12px 20px; border-radius: 999px; min-height: 46px; transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.btn-primary { background: var(--grad-brand); color: #fff; box-shadow: 0 14px 30px -10px rgba(79, 70, 229, 0.55); }
.btn-primary:hover { transform: translateY(-2px); }
.btn-ghost { background: var(--surface-2); color: var(--ink); border-color: var(--stroke); }
.btn-ghost:hover { transform: translateY(-2px); }
.btn-danger { background: linear-gradient(135deg, #dc2626, #b91c1c); color: #fff; }
.btn-sm { padding: 8px 15px; min-height: 38px; font-size: 0.88rem; }
.btn[disabled] { opacity: 0.55; cursor: progress; transform: none !important; }
.btn .spin { width: 16px; height: 16px; border-radius: 50%; border: 2.5px solid rgba(255,255,255,.4); border-top-color: #fff; animation: spin 0.7s linear infinite; display: none; }
.btn.loading .spin { display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }
.icon-btn { width: 42px; height: 42px; border-radius: 13px; display: grid; place-items: center; cursor: pointer; background: var(--surface-2); border: 1px solid var(--stroke); color: var(--ink); }
.icon-btn:hover { transform: translateY(-2px); }
html[data-theme="dark"] .theme-toggle .sun { display: none; }
html:not([data-theme="dark"]) .theme-toggle .moon { display: none; }
.logo-mark { width: 42px; height: 42px; border-radius: 13px; display: grid; place-items: center; color: #fff; background: var(--grad-brand); box-shadow: 0 10px 22px -8px rgba(79, 70, 229, 0.6); flex: none; }
.hidden { display: none !important; }

/* ---------- Login ---------- */
.login-wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.login-card { width: min(420px, 100%); padding: 34px; text-align: center; }
.login-card .logo { display: inline-flex; align-items: center; gap: 12px; font-weight: 800; }
.login-card .logo span:last-child { text-align: left; line-height: 1.2; }
.login-card .logo small { display: block; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.08em; color: var(--ink-faint); text-transform: uppercase; }
.login-form { display: grid; gap: 14px; margin-top: 24px; text-align: left; }
.field { display: grid; gap: 6px; }
.field label { font-weight: 700; font-size: 0.9rem; }
.field input, .field select, .field textarea {
  font: inherit; color: var(--ink); width: 100%; padding: 12px 14px; border-radius: 13px;
  border: 1.5px solid var(--stroke-soft); background: var(--surface-2);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: var(--brand-2); box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.4); }
.field.invalid input, .field.invalid select, .field.invalid textarea { border-color: var(--bad); }
.ferr { color: var(--bad); font-size: 0.83rem; font-weight: 600; min-height: 1em; margin: 0; }
.login-note { font-size: 0.82rem; color: var(--ink-faint); margin: 16px 0 0; }
.alert-banner { padding: 11px 15px; border-radius: 12px; font-size: 0.87rem; font-weight: 600; margin-top: 16px; display: none; }
.alert-banner.show { display: block; }
.alert-err { background: rgba(220, 38, 38, 0.12); color: var(--bad); border: 1px solid rgba(220, 38, 38, 0.3); }
.alert-warn { background: rgba(180, 83, 9, 0.12); color: var(--warn); border: 1px solid rgba(180, 83, 9, 0.3); }

/* ---------- App shell ---------- */
.shell { display: grid; grid-template-columns: 250px 1fr; min-height: 100vh; }
.sidebar { padding: 22px 18px; display: flex; flex-direction: column; gap: 8px; position: sticky; top: 0; height: 100vh; }
.sidebar .brand { display: flex; gap: 12px; align-items: center; font-weight: 800; padding: 6px 8px 18px; }
.sidebar .brand small { display: block; font-size: 0.64rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); }
.side-nav { display: grid; gap: 6px; }
.side-link {
  display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 14px;
  font-weight: 700; font-size: 0.94rem; cursor: pointer; background: none; border: none;
  color: var(--ink-soft); text-align: left; transition: background 0.2s ease, color 0.2s ease;
}
.side-link:hover { background: var(--surface-2); color: var(--ink); }
.side-link.active { background: var(--grad-brand); color: #fff; box-shadow: 0 12px 26px -10px rgba(124, 58, 237, 0.55); }
.side-foot { margin-top: auto; display: grid; gap: 10px; }
.side-user { font-size: 0.8rem; color: var(--ink-faint); padding: 0 8px; }
.side-user strong { color: var(--ink-soft); display: block; word-break: break-all; }
.main { padding: 26px clamp(18px, 3vw, 38px) 60px; min-width: 0; }
.topbar { display: none; }

/* ---------- Dashboard ---------- */
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-bottom: 22px; }
.page-head h1 { font-size: 1.5rem; margin: 0; }
.page-head .sub { color: var(--ink-faint); font-size: 0.88rem; margin: 4px 0 0; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 22px; }
.stat-card { padding: 20px; display: grid; gap: 6px; }
.stat-card .n { font-size: 1.9rem; font-weight: 800; line-height: 1.1; }
.stat-card .l { font-size: 0.82rem; font-weight: 700; color: var(--ink-faint); display: flex; gap: 8px; align-items: center; }
.stat-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.d-total { background: #4f46e5; } .d-pending { background: #f59e0b; } .d-contacted { background: #06b6d4; }
.d-approved { background: #10b981; } .d-rejected { background: #ef4444; }
.panel { padding: 22px; margin-bottom: 22px; }
.panel h2 { font-size: 1.08rem; display: flex; align-items: center; gap: 10px; }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
.mode-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px dashed var(--stroke-soft); font-weight: 600; }
.mode-row:last-child { border-bottom: 0; }
.bar-row { margin: 12px 0; }
.bar-row .t { display: flex; justify-content: space-between; font-size: 0.85rem; font-weight: 600; margin-bottom: 6px; }
.bar { height: 10px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: 999px; background: var(--grad-brand); }
.recent-list { display: grid; gap: 10px; }
.recent-item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 14px; background: var(--surface-2); border: 1px solid var(--stroke-soft); }
.recent-item .info { min-width: 0; }
.recent-item .info strong { display: block; font-size: 0.92rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.recent-item .info span { font-size: 0.78rem; color: var(--ink-faint); }
.recent-item .right { margin-left: auto; text-align: right; flex: none; }
.status-pill {
  display: inline-flex; align-items: center; gap: 6px; font-size: 0.74rem; font-weight: 800;
  padding: 4px 11px; border-radius: 999px; text-transform: capitalize;
}
.st-pending { background: rgba(245, 158, 11, 0.15); color: #b45309; border: 1px solid rgba(245, 158, 11, 0.4); }
.st-contacted { background: rgba(6, 182, 212, 0.15); color: #0e7490; border: 1px solid rgba(6, 182, 212, 0.4); }
.st-approved { background: rgba(16, 185, 129, 0.15); color: #047857; border: 1px solid rgba(16, 185, 129, 0.4); }
.st-rejected { background: rgba(239, 68, 68, 0.15); color: #b91c1c; border: 1px solid rgba(239, 68, 68, 0.4); }
html[data-theme="dark"] .st-pending { color: #fbbf24; }
html[data-theme="dark"] .st-contacted { color: #67e8f9; }
html[data-theme="dark"] .st-approved { color: #34d399; }
html[data-theme="dark"] .st-rejected { color: #f87171; }
.mode-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 0.74rem; font-weight: 800; padding: 4px 10px; border-radius: 999px; }
.md-online { background: rgba(6, 182, 212, 0.13); color: #0e7490; border: 1px solid rgba(6, 182, 212, 0.35); }
.md-offline { background: rgba(236, 72, 153, 0.13); color: #be185d; border: 1px solid rgba(236, 72, 153, 0.35); }
html[data-theme="dark"] .md-online { color: #67e8f9; }
html[data-theme="dark"] .md-offline { color: #f9a8d4; }

/* ---------- Filters + table ---------- */
.filter-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; margin-bottom: 18px; }
.filter-bar .field { min-width: 130px; }
.filter-bar .field.grow { flex: 1; min-width: 200px; }
.filter-bar input, .filter-bar select { padding: 10px 12px; border-radius: 12px; font-size: 0.9rem; }
.table-wrap { overflow-x: auto; border-radius: 16px; border: 1px solid var(--stroke-soft); }
table { border-collapse: collapse; width: 100%; min-width: 900px; }
th, td { text-align: left; padding: 12px 14px; font-size: 0.88rem; border-bottom: 1px solid var(--stroke-soft); white-space: nowrap; }
th { font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-faint); font-weight: 800; background: var(--surface-2); position: sticky; top: 0; }
tbody tr { cursor: pointer; transition: background 0.15s ease; }
tbody tr:hover { background: var(--surface-2); }
td .mono { font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace; font-weight: 700; font-size: 0.82rem; }
td a { color: var(--brand-1); font-weight: 700; }
html[data-theme="dark"] td a { color: #a5b4fc; }
.empty-row { text-align: center; color: var(--ink-faint); padding: 34px 14px !important; cursor: default; }
.pager { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-top: 16px; }
.pager .info { font-size: 0.85rem; color: var(--ink-faint); font-weight: 600; }
.pager-btns { display: flex; gap: 8px; }

/* ---------- Dialogs ---------- */
dialog.rec-dialog { border: 1px solid var(--stroke); border-radius: 24px; padding: 0; background: var(--surface); color: var(--ink); width: min(640px, calc(100vw - 36px)); box-shadow: var(--shadow); -webkit-backdrop-filter: blur(18px) saturate(160%); backdrop-filter: blur(18px) saturate(160%); }
dialog.rec-dialog::backdrop { background: rgba(6, 10, 30, 0.55); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
.dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 20px 24px 0; }
.dialog-head h3 { margin: 0; font-size: 1.15rem; }
.dialog-body { padding: 16px 24px 24px; max-height: 68vh; overflow: auto; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 13px 18px; }
.d-item { display: grid; gap: 2px; }
.d-item .k { font-size: 0.7rem; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); }
.d-item .v { font-weight: 600; word-break: break-word; }
.d-item.full { grid-column: 1 / -1; }
.section-label { margin: 20px 0 10px; font-size: 0.78rem; font-weight: 800; letter-spacing: 0.07em; text-transform: uppercase; color: var(--brand-2); }
html[data-theme="dark"] .section-label { color: #c4b5fd; }
.status-select { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.status-select select { flex: 1; min-width: 150px; }
.danger-zone { border: 1px solid rgba(220, 38, 38, 0.35); border-radius: 16px; padding: 16px; background: rgba(220, 38, 38, 0.06); }
.danger-zone h4 { color: var(--bad); margin: 0 0 6px; font-size: 0.9rem; }
.danger-zone p { font-size: 0.82rem; margin: 0 0 12px; }
.confirm-text { font-size: 0.95rem; font-weight: 600; margin: 4px 0 18px; }
dialog .dialog-actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }

/* ---------- Toasts / loading ---------- */
.toasts { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); z-index: 400; display: grid; gap: 10px; width: min(420px, calc(100vw - 36px)); }
.toast { display: flex; gap: 12px; align-items: flex-start; padding: 13px 17px; border-radius: 15px; background: rgba(16, 20, 42, 0.92); color: #fff; font-size: 0.92rem; font-weight: 600; border: 1px solid rgba(148, 158, 226, 0.25); box-shadow: var(--shadow); animation: toastIn 0.3s ease; }
.toast.ok svg { color: #34d399; } .toast.err svg { color: #f87171; } .toast.info svg { color: #67e8f9; }
.toast.ok svg { color: #34d399; } .toast.err svg { color: #f87171; }
@keyframes toastIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
.busy-overlay { position: fixed; inset: 0; z-index: 300; display: none; place-items: center; background: rgba(6, 10, 30, 0.35); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
.busy-overlay.show { display: grid; }
.busy-box { padding: 18px 26px; border-radius: 18px; background: var(--surface); border: 1px solid var(--stroke); display: grid; gap: 12px; justify-items: center; font-weight: 700; }
.busy-box .spin { width: 26px; height: 26px; border-radius: 50%; border: 3px solid rgba(124, 58, 237, 0.3); border-top-color: var(--brand-2); animation: spin 0.8s linear infinite; }

@media (max-width: 940px) {
  .shell { grid-template-columns: 1fr; }
  .sidebar { display: none; }
  .topbar { display: flex; align-items: center; gap: 12px; padding: 14px 16px; position: sticky; top: 0; z-index: 50; background: var(--surface); border-bottom: 1px solid var(--stroke-soft); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); }
  .topbar .side-nav { display: flex; gap: 8px; margin-left: auto; }
  .topbar .side-link { padding: 9px 13px; border-radius: 12px; }
  .split { grid-template-columns: 1fr; }
  .detail-grid { grid-template-columns: 1fr; }
  .main { padding-top: 20px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.001s !important; transition-duration: 0.001s !important; }
}
`;

/* =====================================================================================
 * SECTION 4 - ADMIN PAGE HTML (login + dashboard shell in one document; the correct
 * view is shown after the session probe GET /api/admin/me succeeds).
 * ===================================================================================== */

const ADMIN_FAVICON = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%234f46e5%22%2F%3E%3Cstop%20offset%3D%22.55%22%20stop-color%3D%22%237c3aed%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%2306b6d4%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2216%22%20fill%3D%22url(%23g)%22%2F%3E%3Cpath%20d%3D%22M50%2026%20L32%2017%2014%2026%20l18%209%2018-9z%22%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-width%3D%223%22%20stroke-linejoin%3D%22round%22%2F%3E%3Cpath%20d%3D%22M22%2031v7c0%202.5%204.5%204.5%2010%204.5s10-2%2010-4.5v-7%22%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-width%3D%223%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E';

function renderAdminPage(nonce) {
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
  '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<title>Admin - Rabbani Education Circle</title>\n' +
  '<meta name="robots" content="noindex, nofollow">\n' +
  '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#edf1fd">\n' +
  '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#060a18">\n' +
  '<link rel="icon" type="image/svg+xml" href="' + ADMIN_FAVICON + '">\n' +
  '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap">\n' +
  '<script nonce="' + nonce + '">(function(){try{var t=localStorage.getItem("rec-theme");if(t==="dark"||(!t&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.setAttribute("data-theme","dark");}}catch(e){}})();<\/script>\n' +
  '<style nonce="' + nonce + '">' + ADMIN_CSS + '</style>\n' +
  '</head>\n<body>\n' +

  '<div id="loginView" class="login-wrap">\n' +
  '<div class="glass login-card">\n' +
  '<div class="logo"><span class="logo-mark">' + aIcon('cap') + '</span><span>Rabbani Education Circle<small>Admin sign-in</small></span></div>\n' +
  '<form id="loginForm" class="login-form" novalidate>\n' +
  '<div class="field"><label for="l-email">Email</label><input id="l-email" name="email" type="email" autocomplete="username" required placeholder="admin@example.com"><p class="ferr" id="lerr-email"></p></div>\n' +
  '<div class="field"><label for="l-pass">Password</label><input id="l-pass" name="password" type="password" autocomplete="current-password" required placeholder="Your admin password"><p class="ferr" id="lerr-password"></p></div>\n' +
  '<button type="submit" class="btn btn-primary" id="loginBtn">' + aIcon('lock') + '<span class="spin" aria-hidden="true"></span> Sign In</button>\n' +
  '</form>\n' +
  '<div class="alert-banner alert-err" id="loginErr" role="alert"></div>\n' +
  '<div class="alert-banner alert-warn" id="loginInit" role="alert"></div>\n' +
  '<p class="login-note">Authorised staff only. All sign-in attempts are rate limited and logged. <a href="/" style="font-weight:700;color:var(--brand-1)">Back to website</a></p>\n' +
  '</div>\n</div>\n' +

  '<div id="dashView" class="shell hidden">\n' +
  '<aside class="sidebar glass">\n' +
  '<div class="brand"><span class="logo-mark">' + aIcon('cap') + '</span><span>Rabbani Education Circle<small>Admin dashboard</small></span></div>\n' +
  '<nav class="side-nav" aria-label="Admin sections">\n' +
  '<button type="button" class="side-link active" data-view="overview" id="navOverview">' + aIcon('grid') + ' Overview</button>\n' +
  '<button type="button" class="side-link" data-view="applications" id="navApplications">' + aIcon('list') + ' Applications</button>\n' +
  '</nav>\n' +
  '<div class="side-foot">\n' +
  '<button type="button" class="icon-btn theme-toggle" id="adminTheme" aria-label="Toggle dark mode">' + aIcon('sun') + aIcon('moon') + '</button>\n' +
  '<div class="side-user" id="sideUser">Signed in</div>\n' +
  '<button type="button" class="btn btn-ghost btn-sm" id="logoutBtn">' + aIcon('logout') + ' Sign out</button>\n' +
  '</div>\n' +
  '</aside>\n' +
  '<div class="topbar">\n' +
  '<span class="logo-mark">' + aIcon('cap') + '</span>\n' +
  '<nav class="side-nav" aria-label="Admin sections">\n' +
  '<button type="button" class="side-link active" data-view="overview">' + aIcon('grid') + ' Overview</button>\n' +
  '<button type="button" class="side-link" data-view="applications">' + aIcon('list') + ' Applications</button>\n' +
  '</nav>\n' +
  '<button type="button" class="btn btn-ghost btn-sm" id="logoutBtnTop">' + aIcon('logout') + ' Sign out</button>\n' +
  '</div>\n' +
  '<main class="main">\n' +

  '<section id="viewOverview" aria-label="Overview">\n' +
  '<div class="page-head"><div><h1>Overview</h1><p class="sub" id="overviewSub">Admission snapshot</p></div></div>\n' +
  '<div class="stat-grid" id="statGrid"></div>\n' +
  '<div class="split">\n' +
  '<div class="glass panel"><h2>' + aIcon('monitor') + ' Learning mode split</h2><div id="modeSplit"></div><h2 style="margin-top:18px">' + aIcon('book') + ' Applications by course</h2><div id="courseBars"></div></div>\n' +
  '<div class="glass panel"><h2>' + aIcon('clock') + ' Recent applications</h2><div class="recent-list" id="recentList"></div></div>\n' +
  '</div>\n' +
  '</section>\n' +

  '<section id="viewApplications" class="hidden" aria-label="Applications">\n' +
  '<div class="page-head">\n<div><h1>Applications</h1><p class="sub" id="listSub">All admission applications</p></div>\n' +
  '<a class="btn btn-ghost btn-sm" id="exportBtn" href="/api/admin/export">' + aIcon('download') + ' Export CSV</a>\n</div>\n' +
  '<div class="glass panel">\n' +
  '<div class="filter-bar">\n' +
  '<div class="field grow"><label for="fq">Search</label><input id="fq" type="search" placeholder="Name, mobile, reference ID, city..." maxlength="80"></div>\n' +
  '<div class="field"><label for="fstatus">Status</label><select id="fstatus"><option value="">All statuses</option><option value="pending">Pending</option><option value="contacted">Contacted</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></div>\n' +
  '<div class="field"><label for="fcourse">Course</label><select id="fcourse"><option value="">All courses</option></select></div>\n' +
  '<div class="field"><label for="fmode">Mode</label><select id="fmode"><option value="">Both modes</option><option value="online">Online</option><option value="offline">Offline</option></select></div>\n' +
  '<div class="field"><label for="ffrom">From</label><input id="ffrom" type="date"></div>\n' +
  '<div class="field"><label for="fto">To</label><input id="fto" type="date"></div>\n' +
  '<button type="button" class="btn btn-primary btn-sm" id="applyFilters">' + aIcon('filter') + ' Apply</button>\n' +
  '<button type="button" class="btn btn-ghost btn-sm" id="resetFilters">Reset</button>\n' +
  '</div>\n' +
  '<div class="table-wrap"><table id="admTable">\n' +
  '<thead><tr><th>Reference</th><th>Student</th><th>Course</th><th>Mode</th><th>Mobile</th><th>City</th><th>Status</th><th>Submitted</th><th></th></tr></thead>\n' +
  '<tbody id="admBody"></tbody>\n' +
  '</table></div>\n' +
  '<div class="pager">\n<div class="info" id="pageInfo">-</div>\n' +
  '<div class="pager-btns"><button type="button" class="btn btn-ghost btn-sm" id="prevPage">Previous</button><button type="button" class="btn btn-ghost btn-sm" id="nextPage">Next</button></div>\n' +
  '</div>\n' +
  '</div>\n' +
  '</section>\n' +
  '</main>\n</div>\n' +

  '<dialog class="rec-dialog" id="detailDialog" aria-labelledby="detailTitle">\n' +
  '<div class="dialog-head"><h3 id="detailTitle">Application</h3><button type="button" class="icon-btn" data-close-dialog aria-label="Close">' + aIcon('x') + '</button></div>\n' +
  '<div class="dialog-body" id="detailBody"></div>\n' +
  '</dialog>\n' +
  '<dialog class="rec-dialog" id="confirmDialog" aria-labelledby="confirmTitle">\n' +
  '<div class="dialog-head"><h3 id="confirmTitle">Please confirm</h3><button type="button" class="icon-btn" data-close-dialog aria-label="Close">' + aIcon('x') + '</button></div>\n' +
  '<div class="dialog-body" id="confirmBody"></div>\n' +
  '</dialog>\n' +
  '<div class="toasts" id="toasts" aria-live="polite"></div>\n' +
  '<div class="busy-overlay" id="busy"><div class="glass busy-box"><div class="spin" aria-hidden="true"></div><span id="busyText">Working...</span></div></div>\n' +
  '<script nonce="' + nonce + '">' + ADMIN_APP_JS + '<\/script>\n' +
  '</body>\n</html>';
}

/* Minimal icon set for the admin UI */
const ADMIN_ICONS = {
  cap: '<path d="M22 9.5 12 4.5 2 9.5l10 5 10-5z"/><path d="M6 11.9V17c0 1.6 2.7 2.9 6 2.9s6-1.3 6-2.9v-5.1"/><path d="M22 9.5v5"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  filter: '<polygon points="22 3 2 3 10 12.5 10 19 14 21 14 12.5 22 3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'
};
function aIcon(name, size) {
  const s = size || 18;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ADMIN_ICONS[name] || '') + '</svg>';
}

/* =====================================================================================
 * SECTION 5 - ADMIN DASHBOARD BROWSER LOGIC
 * (No template literals inside - it is embedded in a Node template literal.
 *  Every piece of application data is rendered via textContent / createElement,
 *  so stored student data can never inject HTML into the dashboard.)
 * ===================================================================================== */

const ADMIN_APP_JS = `
(function () {
  'use strict';
  var ICONS = {
    ok: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    err: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>',
    info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>'
  };
  var state = { csrf: '', admin: null, page: 1, pages: 1, total: 0, limit: 10, wired: false };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function fmtDate(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function toast(msg, type) {
    var box = $('toasts');
    if (!box) return;
    var t = el('div', 'toast ' + (type || 'info'));
    t.innerHTML = ICONS[type || 'info'] || ICONS.info;
    t.appendChild(el('span', null, msg));
    box.appendChild(t);
    var kill = function () { if (t.parentNode) t.parentNode.removeChild(t); };
    t.addEventListener('click', kill);
    setTimeout(kill, 5200);
  }
  function busy(on, text) {
    var b = $('busy');
    if (!b) return;
    if (text) $('busyText').textContent = text;
    b.classList.toggle('show', !!on);
  }

  function api(method, url, body) {
    var headers = { 'accept': 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (state.csrf && method !== 'GET') headers['x-csrf-token'] = state.csrf;
    return fetch(url, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401) { showLogin(); toast('Your session ended. Please sign in again.', 'info'); }
        return { status: r.status, data: data };
      });
    });
  }

  function showLogin() {
    $('dashView').classList.add('hidden');
    $('loginView').classList.remove('hidden');
    state.csrf = '';
  }
  function showDash() {
    $('loginView').classList.add('hidden');
    $('dashView').classList.remove('hidden');
  }

  function boot() {
    api('GET', '/api/admin/me').then(function (r) {
      if (r.status === 200 && r.data && r.data.ok) {
        state.csrf = r.data.csrfToken;
        state.admin = r.data.admin;
        enterDashboard();
      } else {
        showLogin();
        if (r.data && r.data.error && r.data.error.code === 'ADMIN_NOT_INITIALIZED') {
          var banner = $('loginInit');
          banner.textContent = 'No administrator account exists yet. Initialize it with the ADMIN_EMAIL and ADMIN_PASSWORD_HASH environment variables.';
          banner.classList.add('show');
        } else if (r.data && r.data.error && r.data.error.code === 'CONFIG_MISSING') {
          var b2 = $('loginInit');
          b2.textContent = 'Server configuration incomplete: ' + r.data.error.message;
          b2.classList.add('show');
        }
      }
    }).catch(function () { showLogin(); toast('Cannot reach the server.', 'err'); });
  }

  function enterDashboard() {
    showDash();
    var su = $('sideUser');
    if (su && state.admin) {
      su.textContent = '';
      su.appendChild(el('strong', null, state.admin.name || 'Administrator'));
      su.appendChild(document.createTextNode(state.admin.email || ''));
    }
    wireOnce();
    loadStats();
    loadList();
  }

  /* ---------- login / logout ---------- */
  var loginForm = $('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      $('loginErr').classList.remove('show');
      ['email', 'password'].forEach(function (k) {
        $('lerr-' + k).textContent = '';
      });
      var email = $('l-email').value.trim();
      var password = $('l-pass').value;
      if (!email || !password) {
        if (!email) $('lerr-email').textContent = 'Please enter your email.';
        if (!password) $('lerr-password').textContent = 'Please enter your password.';
        return;
      }
      var btn = $('loginBtn');
      btn.disabled = true;
      btn.classList.add('loading');
      api('POST', '/api/admin/login', { email: email, password: password }).then(function (r) {
        if (r.status === 200 && r.data && r.data.ok) {
          state.csrf = r.data.csrfToken;
          state.admin = r.data.admin;
          $('l-pass').value = '';
          enterDashboard();
          toast('Welcome back, ' + ((r.data.admin && r.data.admin.name) || 'Administrator') + '!', 'ok');
        } else {
          var msg = (r.data && r.data.error && r.data.error.message) || 'Sign-in failed.';
          var box = $('loginErr');
          box.textContent = msg;
          box.classList.add('show');
        }
      }).catch(function () {
        var box = $('loginErr');
        box.textContent = 'Cannot reach the server. Please try again.';
        box.classList.add('show');
      }).finally(function () {
        btn.disabled = false;
        btn.classList.remove('loading');
      });
    });
  }

  function doLogout() {
    api('POST', '/api/admin/logout', {}).then(function (r) {
      if (r.status === 200) toast('Signed out.', 'ok');
      setTimeout(function () { window.location.href = '/admin'; }, 300);
    }).catch(function () { window.location.href = '/admin'; });
  }

  /* ---------- views ---------- */
  function viewId(name) { return name === 'overview' ? 'viewOverview' : 'viewApplications'; }
  function switchView(name) {
    $(viewId('overview')).classList.toggle('hidden', name !== 'overview');
    $(viewId('applications')).classList.toggle('hidden', name !== 'applications');
    document.querySelectorAll('.side-link[data-view]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === name);
    });
    if (name === 'applications') loadList();
    if (name === 'overview') loadStats();
  }

  /* ---------- filters ---------- */
  function filterParams() {
    var p = new URLSearchParams();
    var q = $('fq').value.trim();
    if (q) p.set('q', q);
    if ($('fstatus').value) p.set('status', $('fstatus').value);
    if ($('fcourse').value) p.set('course', $('fcourse').value);
    if ($('fmode').value) p.set('mode', $('fmode').value);
    if ($('ffrom').value) p.set('from', $('ffrom').value);
    if ($('fto').value) p.set('to', $('fto').value);
    return p;
  }
  function resetFilters() {
    ['fq', 'fstatus', 'fcourse', 'fmode', 'ffrom', 'fto'].forEach(function (id) { $(id).value = ''; });
  }

  /* ---------- stats ---------- */
  function statCard(label, value, dotClass) {
    var card = el('div', 'glass stat-card');
    card.appendChild(el('div', 'n', value));
    var l = el('div', 'l');
    var dot = el('span', 'stat-dot ' + dotClass);
    l.appendChild(dot);
    l.appendChild(document.createTextNode(label));
    card.appendChild(l);
    return card;
  }
  function loadStats() {
    var p = filterParams();
    api('GET', '/api/admin/stats?' + p.toString()).then(function (r) {
      if (r.status !== 200 || !r.data || !r.data.ok) return;
      var c = r.data.counts;
      var grid = $('statGrid');
      grid.textContent = '';
      grid.appendChild(statCard('Total applications', c.total, 'd-total'));
      grid.appendChild(statCard('Pending', c.pending, 'd-pending'));
      grid.appendChild(statCard('Contacted', c.contacted, 'd-contacted'));
      grid.appendChild(statCard('Approved', c.approved, 'd-approved'));
      grid.appendChild(statCard('Rejected', c.rejected, 'd-rejected'));
      var ms = $('modeSplit');
      ms.textContent = '';
      var m1 = el('div', 'mode-row');
      m1.appendChild(el('span', null, 'Online applications'));
      m1.appendChild(el('span', null, r.data.byMode.online));
      ms.appendChild(m1);
      var m2 = el('div', 'mode-row');
      m2.appendChild(el('span', null, 'Offline applications'));
      m2.appendChild(el('span', null, r.data.byMode.offline));
      ms.appendChild(m2);
      var m3 = el('div', 'mode-row');
      m3.appendChild(el('span', null, 'Contact enquiries'));
      m3.appendChild(el('span', null, r.data.contactMessages));
      ms.appendChild(m3);
      var cb = $('courseBars');
      cb.textContent = '';
      var max = 1;
      r.data.byCourse.forEach(function (row) { if (row.count > max) max = row.count; });
      if (!r.data.byCourse.length) cb.appendChild(el('p', null, 'No applications yet.'));
      r.data.byCourse.forEach(function (row) {
        var wrap = el('div', 'bar-row');
        var t = el('div', 't');
        t.appendChild(el('span', null, row.name));
        t.appendChild(el('span', null, row.count));
        wrap.appendChild(t);
        var bar = el('div', 'bar');
        var fill = el('i');
        fill.style.width = Math.round((row.count / max) * 100) + '%';
        bar.appendChild(fill);
        wrap.appendChild(bar);
        cb.appendChild(wrap);
      });
      var rl = $('recentList');
      rl.textContent = '';
      if (!r.data.recent.length) rl.appendChild(el('p', null, 'No applications yet.'));
      r.data.recent.forEach(function (a) {
        var item = el('div', 'recent-item');
        var info = el('div', 'info');
        info.appendChild(el('strong', null, a.studentName + ' - ' + a.className));
        info.appendChild(el('span', null, a.courseName + ' / ' + a.city));
        item.appendChild(info);
        var right = el('div', 'right');
        right.appendChild(el('span', 'status-pill st-' + a.status, a.status));
        right.appendChild(el('div', null, fmtDate(a.createdAt)));
        item.appendChild(right);
        item.addEventListener('click', function () { openDetail(a.id); });
        rl.appendChild(item);
      });
      $('overviewSub').textContent = r.data.filtered ? 'Filtered admission snapshot' : 'Admission snapshot (all time)';
      $('listSub').textContent = r.data.filtered ? 'Filtered applications' : 'All admission applications';
    });
  }

  /* ---------- table ---------- */
  function modePill(mode) {
    return el('span', 'mode-pill md-' + mode, mode === 'online' ? 'Online' : 'Offline');
  }
  function renderRows(items) {
    var body = $('admBody');
    body.textContent = '';
    if (!items.length) {
      var tr = el('tr', 'empty-row');
      var td = el('td', null, 'No applications found for the current filters.');
      td.colSpan = 9;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    items.forEach(function (a) {
      var tr = document.createElement('tr');
      tr.tabIndex = 0;
      tr.setAttribute('data-id', a.id);
      var cells = [
        el('td', null, ''), el('td', null, ''), el('td', null, ''), el('td', null, ''),
        el('td', null, ''), el('td', null, ''), el('td', null, ''), el('td', null, ''), el('td', null, '')
      ];
      var ref = el('span', 'mono', a.appId);
      cells[0].appendChild(ref);
      cells[1].appendChild(el('strong', null, a.studentName));
      cells[1].appendChild(el('div', null, a.className));
      cells[2].appendChild(document.createTextNode(a.courseName));
      cells[3].appendChild(modePill(a.learningMode));
      var tel = el('a', null, a.mobile);
      tel.href = 'tel:+91' + a.mobile;
      cells[4].appendChild(tel);
      cells[5].appendChild(document.createTextNode(a.city));
      cells[6].appendChild(el('span', 'status-pill st-' + a.status, a.status));
      cells[7].appendChild(document.createTextNode(fmtDate(a.createdAt)));
      var viewBtn = el('button', 'btn btn-ghost btn-sm', 'View');
      viewBtn.setAttribute('data-id', a.id);
      cells[8].appendChild(viewBtn);
      cells.forEach(function (c) { tr.appendChild(c); });
      tr.addEventListener('click', function () { openDetail(a.id); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') openDetail(a.id); });
      body.appendChild(tr);
    });
  }
  function loadList() {
    var p = filterParams();
    p.set('page', String(state.page));
    p.set('limit', String(state.limit));
    api('GET', '/api/admin/admissions?' + p.toString()).then(function (r) {
      if (r.status !== 200 || !r.data || !r.data.ok) return;
      state.pages = r.data.pages;
      state.total = r.data.total;
      renderRows(r.data.items);
      $('pageInfo').textContent = 'Showing ' + ((r.data.page - 1) * r.data.limit + (r.data.items.length ? 1 : 0)) +
        '-' + ((r.data.page - 1) * r.data.limit + r.data.items.length) + ' of ' + r.data.total +
        ' (page ' + r.data.page + ' / ' + r.data.pages + ')';
      $('prevPage').disabled = r.data.page <= 1;
      $('nextPage').disabled = r.data.page >= r.data.pages;
    });
  }

  /* ---------- detail dialog ---------- */
  function detailItem(k, v, full) {
    var d = el('div', 'd-item' + (full ? ' full' : ''));
    d.appendChild(el('div', 'k', k));
    d.appendChild(el('div', 'v', v === null || v === undefined || v === '' ? '-' : v));
    return d;
  }
  function openDetail(id) {
    busy(true, 'Loading application...');
    api('GET', '/api/admin/admissions/' + encodeURIComponent(id)).then(function (r) {
      if (r.status !== 200 || !r.data || !r.data.ok) { toast('Could not load the application.', 'err'); return; }
      renderDetail(r.data.application);
    }).finally(function () { busy(false); });
  }
  function renderDetail(a) {
    var body = $('detailBody');
    body.textContent = '';
    $('detailTitle').textContent = 'Application ' + a.appId;
    var grid = el('div', 'detail-grid');
    grid.appendChild(detailItem('Student name', a.studentName));
    grid.appendChild(detailItem('Class', a.className));
    grid.appendChild(detailItem('Guardian', a.guardianName));
    grid.appendChild(detailItem('Course', a.courseName));
    grid.appendChild(detailItem('Student mobile', a.mobile));
    grid.appendChild(detailItem('Guardian mobile', a.guardianMobile));
    grid.appendChild(detailItem('Email', a.email));
    grid.appendChild(detailItem('Learning mode', a.learningMode));
    grid.appendChild(detailItem('Preferred batch', a.preferredBatch));
    grid.appendChild(detailItem('Subjects', a.subjects.join(', ')));
    grid.appendChild(detailItem('School', a.school));
    grid.appendChild(detailItem('City / locality', a.city));
    grid.appendChild(detailItem('Submitted', fmtDate(a.createdAt)));
    grid.appendChild(detailItem('Last updated', fmtDate(a.updatedAt)));
    grid.appendChild(detailItem('Last updated by', a.updatedBy));
    grid.appendChild(detailItem('Current status', '', false));
    grid.lastChild.appendChild(el('span', 'status-pill st-' + a.status, a.status));
    body.appendChild(grid);
    if (a.message) {
      body.appendChild(el('div', 'section-label', 'Student message'));
      body.appendChild(el('p', null, a.message));
    }

    body.appendChild(el('div', 'section-label', 'Update status'));
    var statusRow = el('div', 'status-select');
    var sel = el('select');
    ['pending', 'contacted', 'approved', 'rejected'].forEach(function (s) {
      var o = el('option', null, s.charAt(0).toUpperCase() + s.slice(1));
      o.value = s;
      if (s === a.status) o.selected = true;
      sel.appendChild(o);
    });
    statusRow.appendChild(sel);
    var saveBtn = el('button', 'btn btn-primary btn-sm', 'Save Status');
    statusRow.appendChild(saveBtn);
    body.appendChild(statusRow);
    saveBtn.addEventListener('click', function () {
      var next = sel.value;
      if (next === a.status) { toast('Status unchanged.', 'info'); return; }
      confirmDialog({
        title: 'Change status',
        message: 'Change application ' + a.appId + ' from "' + a.status + '" to "' + next + '"?',
        confirmLabel: 'Yes, change it'
      }).then(function (yes) {
        if (!yes) return;
        busy(true, 'Updating status...');
        api('PATCH', '/api/admin/admissions/' + a.id, { status: next }).then(function (r) {
          if (r.status === 200 && r.data && r.data.ok) {
            toast('Status updated to ' + next + '.', 'ok');
            renderDetail(r.data.application);
            loadList(); loadStats();
          } else {
            toast((r.data && r.data.error && r.data.error.message) || 'Update failed.', 'err');
          }
        }).finally(function () { busy(false); });
      });
    });

    body.appendChild(el('div', 'section-label', 'Internal notes (not visible to students)'));
    var notesRow = el('div', 'status-select');
    var notes = el('textarea');
    notes.rows = 3;
    notes.maxLength = 2000;
    notes.value = a.adminNotes || '';
    notes.style.flex = '1';
    notes.style.minWidth = '220px';
    notesRow.appendChild(notes);
    var noteBtn = el('button', 'btn btn-ghost btn-sm', 'Save Notes');
    notesRow.appendChild(noteBtn);
    body.appendChild(notesRow);
    noteBtn.addEventListener('click', function () {
      busy(true, 'Saving notes...');
      api('PATCH', '/api/admin/admissions/' + a.id, { adminNotes: notes.value }).then(function (r) {
        if (r.status === 200 && r.data && r.data.ok) {
          toast('Notes saved.', 'ok');
          a.adminNotes = r.data.application.adminNotes;
        } else {
          toast((r.data && r.data.error && r.data.error.message) || 'Could not save notes.', 'err');
        }
      }).finally(function () { busy(false); });
    });

    body.appendChild(el('div', 'section-label', 'Danger zone'));
    var dz = el('div', 'danger-zone');
    dz.appendChild(el('h4', null, 'Delete this application'));
    dz.appendChild(el('p', null, 'Permanently removes ' + a.appId + ' (' + a.studentName + ') from the database. This cannot be undone.'));
    var delBtn = el('button', 'btn btn-danger btn-sm', 'Delete application');
    dz.appendChild(delBtn);
    body.appendChild(dz);
    delBtn.addEventListener('click', function () {
      confirmDialog({
        title: 'Delete application',
        message: 'This permanently deletes ' + a.appId + ' - ' + a.studentName + '.',
        confirmLabel: 'Delete forever',
        danger: true,
        typed: 'DELETE'
      }).then(function (yes) {
        if (!yes) return;
        busy(true, 'Deleting...');
        api('DELETE', '/api/admin/admissions/' + a.id).then(function (r) {
          if (r.status === 200 && r.data && r.data.ok) {
            toast('Application ' + r.data.deletedId + ' deleted.', 'ok');
            $('detailDialog').close();
            loadList(); loadStats();
          } else {
            toast((r.data && r.data.error && r.data.error.message) || 'Delete failed.', 'err');
          }
        }).finally(function () { busy(false); });
      });
    });

    $('detailDialog').showModal();
  }

  /* ---------- generic confirmation dialog ---------- */
  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      var dlg = $('confirmDialog');
      var body = $('confirmBody');
      body.textContent = '';
      var msg = el('p', 'confirm-text', opts.message);
      body.appendChild(msg);
      var typedInput = null;
      if (opts.typed) {
        var wrap = el('div', 'field');
        wrap.appendChild(el('label', null, 'Type ' + opts.typed + ' to confirm'));
        typedInput = el('input');
        typedInput.type = 'text';
        typedInput.placeholder = opts.typed;
        typedInput.autocomplete = 'off';
        wrap.appendChild(typedInput);
        body.appendChild(wrap);
      }
      var actions = el('div', 'dialog-actions');
      var cancel = el('button', 'btn btn-ghost btn-sm', 'Cancel');
      var ok = el('button', 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + ' btn-sm', opts.confirmLabel || 'Confirm');
      actions.appendChild(cancel);
      actions.appendChild(ok);
      body.appendChild(actions);
      function done(val) { dlg.close(); resolve(val); }
      cancel.addEventListener('click', function () { done(false); });
      ok.addEventListener('click', function () {
        if (typedInput && typedInput.value.trim().toUpperCase() !== opts.typed) {
          toast('Please type ' + opts.typed + ' exactly to confirm.', 'err');
          return;
        }
        done(true);
      });
      dlg.addEventListener('close', function () { resolve(false); }, { once: true });
      dlg.showModal();
      if (typedInput) typedInput.focus();
    });
  }

  /* ---------- wiring ---------- */
  function wireOnce() {
    if (state.wired) return;
    state.wired = true;
    document.querySelectorAll('.side-link[data-view]').forEach(function (b) {
      b.addEventListener('click', function () { switchView(b.getAttribute('data-view')); });
    });
    $('logoutBtn').addEventListener('click', doLogout);
    $('logoutBtnTop').addEventListener('click', doLogout);
    var themeBtn = $('adminTheme');
    if (themeBtn) {
      themeBtn.addEventListener('click', function () {
        var root = document.documentElement;
        var dark = root.getAttribute('data-theme') === 'dark';
        root.setAttribute('data-theme', dark ? 'light' : 'dark');
        try { localStorage.setItem('rec-theme', dark ? 'light' : 'dark'); } catch (e) {}
      });
    }
    $('applyFilters').addEventListener('click', function () { state.page = 1; loadList(); loadStats(); });
    $('resetFilters').addEventListener('click', function () { resetFilters(); state.page = 1; loadList(); loadStats(); });
    var debounceTimer = null;
    $('fq').addEventListener('input', function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () { state.page = 1; loadList(); }, 400);
    });
    $('prevPage').addEventListener('click', function () { if (state.page > 1) { state.page--; loadList(); } });
    $('nextPage').addEventListener('click', function () { if (state.page < state.pages) { state.page++; loadList(); } });
    [$('detailDialog'), $('confirmDialog')].forEach(function (dlg) {
      dlg.querySelectorAll('[data-close-dialog]').forEach(function (c) {
        c.addEventListener('click', function () { dlg.close(); });
      });
      dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    });
    var exportBtn = $('exportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        var p = filterParams();
        window.location.href = '/api/admin/export' + (p.toString() ? '?' + p.toString() : '');
      });
    }
  }

  boot();
})();
`;

/* =====================================================================================
 * SECTION 6 - ADMIN ROUTER (the exported Vercel handler)
 * ===================================================================================== */
async function authOrNull(req) {
  const db = await getDb();
  return authenticate(req, db);
}

function methodNotAllowed(res, allowed) {
  return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Allowed methods: ' + allowed + '.' } }, { Allow: allowed });
}

async function adminHandler(req, res) {
  const started = Date.now();
  let status = 500;
  try {
    const path = requestPath(req);
    const method = (req.method || 'GET').toUpperCase();

    /* ---------- Protected JSON API ---------- */
    if (path === '/api/admin' || path === '/api/admin/') {
      status = 404;
      return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown admin API endpoint.' } });
    }
    if (path.startsWith('/api/admin/')) {
      const sub = path.slice('/api/admin/'.length - 1); // keeps leading '/'

      if (sub === '/login') {
        if (method !== 'POST') { status = 405; return methodNotAllowed(res, 'POST'); }
        await handleLogin(req, res);
        status = res.statusCode;
        return;
      }
      if (sub === '/logout') {
        if (method !== 'POST') { status = 405; return methodNotAllowed(res, 'POST'); }
        const session = requireAuth(await authOrNull(req));
        await handleLogout(req, res, session);
        status = res.statusCode;
        return;
      }
      if (sub === '/me') {
        if (method !== 'GET' && method !== 'HEAD') { status = 405; return methodNotAllowed(res, 'GET, HEAD'); }
        const session = requireAuth(await authOrNull(req));
        await handleMe(req, res, session);
        status = res.statusCode;
        return;
      }
      if (sub === '/admissions') {
        if (method !== 'GET' && method !== 'HEAD') { status = 405; return methodNotAllowed(res, 'GET, HEAD'); }
        const session = requireAuth(await authOrNull(req));
        await handleList(req, res, session);
        status = res.statusCode;
        return;
      }
      if (sub.startsWith('/admissions/')) {
        const idRaw = decodeURIComponent(sub.slice('/admissions/'.length));
        if (!idRaw || idRaw.includes('/') || idRaw.length > 64) {
          status = 404;
          return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Application not found.' } });
        }
        const session = requireAuth(await authOrNull(req));
        if (method === 'GET' || method === 'HEAD') {
          await handleDetail(req, res, session, idRaw);
        } else if (method === 'PATCH') {
          await handlePatch(req, res, session, idRaw);
        } else if (method === 'DELETE') {
          await handleDelete(req, res, session, idRaw);
        } else {
          status = 405;
          return methodNotAllowed(res, 'GET, PATCH, DELETE');
        }
        status = res.statusCode;
        return;
      }
      if (sub === '/stats') {
        if (method !== 'GET' && method !== 'HEAD') { status = 405; return methodNotAllowed(res, 'GET, HEAD'); }
        const session = requireAuth(await authOrNull(req));
        await handleStats(req, res, session);
        status = res.statusCode;
        return;
      }
      if (sub === '/export') {
        if (method !== 'GET' && method !== 'HEAD') { status = 405; return methodNotAllowed(res, 'GET, HEAD'); }
        const session = requireAuth(await authOrNull(req));
        await handleExport(req, res, session);
        status = res.statusCode;
        return;
      }
      status = 404;
      return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown admin API endpoint.' } });
    }

    /* ---------- Admin page ---------- */
    if (path === '/admin' || path.startsWith('/admin')) {
      if (method !== 'GET' && method !== 'HEAD') { status = 405; return methodNotAllowed(res, 'GET, HEAD'); }
      status = 200;
      const nonce = crypto.randomBytes(16).toString('base64');
      return sendHtml(res, 200, renderAdminPage(nonce), nonce);
    }

    status = 404;
    return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
  } catch (e) {
    if (e instanceof HttpError) {
      status = e.status;
      const extra = e.extra && e.extra.retryAfterSec ? { 'Retry-After': String(e.extra.retryAfterSec) } : undefined;
      const payload = { ok: false, error: { code: e.code, message: e.message } };
      if (e.extra && e.extra.fields) payload.error.fields = e.extra.fields;
      return sendJson(res, e.status, payload, extra);
    }
    status = 500;
    console.error('[admin-error]', req && req.method, req && req.url, redact(e && e.message));
    return sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
  } finally {
    console.log('[admin-req]', (req && req.method) || '-', req && req.url, status, (Date.now() - started) + 'ms');
  }
}

module.exports = adminHandler;
