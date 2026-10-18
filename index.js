'use strict';
/* =====================================================================================
 * RABBANI EDUCATION CIRCLE - index.js
 * Public website (HTML/CSS/JS inlined) + public REST API, packaged as ONE Vercel
 * serverless function (handler signature: module.exports = async (req, res) => {}).
 *
 * Routing (see vercel.json):
 *   /                     -> this function -> public landing page
 *   /api/health           -> this function -> health probe
 *   /api/courses          -> this function -> course catalog JSON
 *   /api/admissions       -> this function -> POST admission application (MongoDB)
 *   /api/contact          -> this function -> POST contact message (MongoDB)
 *   /robots.txt, /sitemap.xml, /favicon.ico -> this function
 *   any other path        -> this function -> styled 404 page
 *   /admin and /api/admin/*-> admin.js function (see admin.js)
 *
 * NOTE ON DEPLOYMENT: This file never calls app.listen() on Vercel - Vercel invokes
 * the exported handler directly. A tiny local preview server is ONLY started when
 * the file is run directly ("node index.js") for local development.
 *
 * No filesystem persistence, no in-memory database: all data lives in MongoDB Atlas.
 * Secrets are read exclusively from environment variables (never hard-coded, never
 * sent to the browser).
 * ===================================================================================== */

const crypto = require('crypto');
const http = require('http'); // used ONLY by the local dev harness at the bottom
const { MongoClient } = require('mongodb');

/* =====================================================================================
 * SECTION 1 - SITE CONFIGURATION (single maintainable content section)
 * All client-supplied facts live here. Anything not supplied by the client is either
 * omitted or clearly marked as a placeholder - nothing is fabricated.
 * ===================================================================================== */

const SITE = {
  // ---- CLIENT INFO (update here when details change) -------------------------------
  name: 'Rabbani Education Circle',
  short: 'REC',
  tagline: 'Created by Spacenode',
  // Replace with the production URL after deployment (used by canonical + Open Graph):
  domain: 'https://YOUR-DEPLOYMENT.vercel.app',
  owner: 'Md. Rahmat Rabbani',
  phoneDisplay: '+91 82525 49170',
  phoneTel: '+918252549170',
  whatsappNumber: '918252549170',
  whatsappPrefill: 'Hello! I would like to know more about admission at Rabbani Education Circle.',
  // Supplied by client exactly as provided ("suppory" spelling kept as given - flagged
  // in the project report as a detail to verify):
  email: 'suppory@spacenode.com',
  addressLine1: 'Rabbani Manzil',
  addressLine2: 'Puranaganj, Bihar 854317',
  addressFull: 'Rabbani Manzil, Puranaganj, Bihar 854317',
  mapEmbed: 'https://www.google.com/maps?q=25.8129186,87.8146799&hl=en&z=15&output=embed',
  // Exact client-supplied Google Maps place link (Get Directions button):
  mapDirections: 'https://www.google.com/maps/place/Rabbani+Education+Center/@25.812893,87.8114879,15.75z/data=!4m12!1m5!8m4!1e2!2s111583557023613138555!3m1!1e1!3m5!1s0x39e5490788fc2abd:0x8e69674b94f93b8b!8m2!3d25.8129186!4d87.8146799!16s%2Fg%2F11kqwxth6h?entry=ttu&g_ep=EgoyMDI2MTAxMy4wIKXMDSoASAFQAw%3D%3D',
  social: {
    youtube: 'https://www.youtube.com/@rabbanieducationcircle',
    facebook: 'https://www.facebook.com/profile.php?id=100066290753907',
    instagram: 'https://www.instagram.com/rabbani_education_circle'
  },
  // Timings were NOT supplied by the client - honest wording instead of invented hours:
  hoursNote: 'Class timings are confirmed during admission - call or WhatsApp us for the current batch schedule.',
  foundedNote: '12 years of offline teaching experience, now online too'
};

// Verified hero trust indicators (client-supplied facts only - no invented statistics):
const TRUST = [
  { icon: 'cap',   label: 'Classes 5 - 12' },
  { icon: 'zap',   label: '12+ Years Teaching' },
  { icon: 'gift',  label: '100% Free Education' },
  { icon: 'globe', label: 'Online + Offline' }
];

// Illustrative photography from Pexels (free license). Alt text is honest - these are
// illustrative stock photos, never presented as institute records. Replace with genuine
// institute photographs when the client supplies them.
const IMAGES = {
  hero: {
    src: 'https://images.pexels.com/photos/28503362/pexels-photo-28503362.jpeg?auto=compress&cs=tinysrgb&w=1200&h=800&fit=crop',
    alt: 'Colourful notebooks and school supplies laid out on a bright background (illustrative photo)',
    w: 1200, h: 800
  },
  about: {
    src: 'https://images.pexels.com/photos/301926/pexels-photo-301926.jpeg?auto=compress&cs=tinysrgb&w=900&h=675&fit=crop',
    alt: 'Dice spelling the word TEACH stacked between books (illustrative photo)',
    w: 900, h: 675
  },
  online: {
    src: 'https://images.pexels.com/photos/4145190/pexels-photo-4145190.jpeg?auto=compress&cs=tinysrgb&w=900&h=675&fit=crop',
    alt: 'Student taking notes during an online video lesson (illustrative photo)',
    w: 900, h: 675
  },
  offline: {
    src: 'https://images.pexels.com/photos/8471835/pexels-photo-8471835.jpeg?auto=compress&cs=tinysrgb&w=900&h=675&fit=crop',
    alt: 'Students performing a hands-on experiment in a classroom (illustrative photo)',
    w: 900, h: 675
  },
  og: 'https://images.pexels.com/photos/28503362/pexels-photo-28503362.jpeg?auto=compress&cs=tinysrgb&w=1200&h=630&fit=crop'
};

/* ---- Course catalog (single source of truth for cards + /api/courses + validation) --
 * Fees are "100% free" per client. Schedules are honestly marked as confirmed at
 * admission because the client did not supply fixed timings. */
const COURSES = [
  {
    id: 'foundation-5-7', name: 'Foundation Builder', tag: 'Classes 5-7',
    subjects: ['Mathematics', 'Science', 'English', 'Hindi'],
    blurb: 'Rock-solid basics across core subjects with concept-first lessons, gentle mentoring and regular practice from an early stage.',
    highlights: ['Concept-first learning', 'Regular practice worksheets', 'Personal attention'],
    modes: ['offline', 'online'], schedule: 'Batch timing confirmed at admission', duration: 'Full academic year'
  },
  {
    id: 'class-8', name: 'Class 8 Complete Preparation', tag: 'Class 8',
    subjects: ['Mathematics', 'Science', 'English', 'Hindi', 'Social Science'],
    blurb: 'All-subject guidance for Class 8 with early orientation towards board-style study habits and answer writing.',
    highlights: ['All core subjects', 'Board-style orientation', 'Monthly checks'],
    modes: ['offline', 'online'], schedule: 'Batch timing confirmed at admission', duration: 'Full academic year'
  },
  {
    id: 'class-9', name: 'Class 9 Science & Maths Focus', tag: 'Class 9',
    subjects: ['Mathematics', 'Physics', 'Chemistry', 'Biology', 'English'],
    blurb: 'Strong conceptual grounding in the subjects that decide Class 10 performance, with clear numericals practice and doubt clearing.',
    highlights: ['Numericals practice', 'Doubt-clearing sessions', 'Concept building'],
    modes: ['offline', 'online'], schedule: 'Batch timing confirmed at admission', duration: 'Full academic year'
  },
  {
    id: 'class-10', name: 'Class 10 Board Excellence', tag: 'Class 10', featured: true,
    subjects: ['Mathematics', 'Science', 'English', 'Social Science'],
    blurb: 'The flagship program: exam-oriented preparation for Class 10 boards with chapter-wise revision, shortcut tricks and practice in board-answer writing.',
    highlights: ['Exam-oriented preparation', 'Shortcut math tricks', 'Board-pattern practice'],
    modes: ['offline', 'online'], schedule: 'Batch timing confirmed at admission', duration: 'Full academic year + revision sprint'
  },
  {
    id: 'class-11', name: 'Class 11 Science Stream', tag: 'Class 11',
    subjects: ['Mathematics', 'Physics', 'Chemistry'],
    blurb: 'For Class 11 science students: deep concept coverage and problem-solving routines that prepare the ground for Class 12 boards.',
    highlights: ['Deep concept coverage', 'Problem-solving routines', 'Doubt support'],
    modes: ['offline', 'online'], schedule: 'Batch timing confirmed at admission', duration: 'Full academic year'
  },
  {
    id: 'class-12', name: 'Class 12 Board Mastery', tag: 'Class 12',
    subjects: ['Mathematics', 'Physics', 'Chemistry'],
    blurb: 'Focused Class 12 board preparation with revision sprints, important-question drills and time-managed practice papers.',
    highlights: ['Revision sprints', 'Important-question drills', 'Timed practice'],
    modes: ['offline', 'online'], schedule: 'Batch timing confirmed at admission', duration: 'Full academic year'
  },
  {
    id: 'math-magic', name: 'Magical Math Tricks', tag: 'All classes',
    subjects: ['Speed Calculation', 'Square & Cube Roots', 'Multiplication Tricks', 'Simplification'],
    blurb: 'The signature "Magical Tricks" series: calculate faster than a calculator - square roots, cube roots, multiplication and simplification in seconds.',
    highlights: ['Faster than a calculator', '10-20 second methods', 'Works for every class'],
    modes: ['online', 'offline'], schedule: 'Daily shorts + regular videos', duration: 'Ongoing series'
  },
  {
    id: 'daily-practice', name: 'Daily Practice & Brain Sharpening', tag: 'All classes',
    subjects: ['Daily Shorts', 'Quizzes', 'Mental Maths'],
    blurb: 'Daily shorts, quizzes and quick problems to keep every student brain sharp between classes - free for everyone, everywhere.',
    highlights: ['Daily updates', 'Quick quizzes', 'Mental maths drills'],
    modes: ['online'], schedule: 'Daily on YouTube', duration: 'Ongoing'
  }
];
const COURSE_MAP = new Map(COURSES.map(c => [c.id, c]));
const CLASS_LEVELS = ['Class 5', 'Class 6', 'Class 7', 'Class 8', 'Class 9', 'Class 10', 'Class 11', 'Class 12'];
const LEARNING_MODES = ['online', 'offline'];
const BATCH_PREFS = ['morning', 'afternoon', 'evening', 'weekend', 'flexible'];
const BATCH_LABELS = {
  morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening',
  weekend: 'Weekend', flexible: 'Flexible / as per guidance'
};

/* ---- Faculty (only verified people; placeholders clearly marked) -------------------
 * The founder card uses ONLY information supplied by the client. Qualification
 * details were not supplied, so they are explicitly marked as pending. */
const FACULTY = [
  {
    id: 'founder', placeholder: false,
    name: 'Md. Rahmat Rabbani',
    role: 'Founder & Lead Educator',
    subjects: ['Mathematics', 'Class 5-12 Mentor', 'Class 10 Boards'],
    experience: '12+ years of offline teaching experience',
    qualifications: 'Qualification details pending verification from the institute',
    bio: 'Teaching is not just my profession; it is my passion. After 12 years of teaching students from Class 5 to 12 offline, I started this online journey to bring the best quality education to every student, everywhere. Mera maqsad hai education ko asaan aur interesting banana - especially for Class 10 students preparing for board exams.',
    initials: 'RR', accent: 258
  },
  {
    id: 'faculty-slot-1', placeholder: true,
    name: 'Faculty profile - awaiting details',
    role: 'Educator (to be announced)',
    subjects: ['Subject to be announced'],
    experience: 'Details pending',
    qualifications: 'Details pending verification',
    bio: 'This slot is reserved for verified faculty information. No unverified teacher details are published on this website.',
    initials: '?', accent: 210
  },
  {
    id: 'faculty-slot-2', placeholder: true,
    name: 'Faculty profile - awaiting details',
    role: 'Educator (to be announced)',
    subjects: ['Subject to be announced'],
    experience: 'Details pending',
    qualifications: 'Details pending verification',
    bio: 'This slot is reserved for verified faculty information. No unverified teacher details are published on this website.',
    initials: '?', accent: 300
  }
];

/* ---- Results & testimonials ---------------------------------------------------------
 * EMPTY until the institute supplies verified achievements with permission.
 * To publish: push objects shaped like the sample below (shown as a comment - it is
 * intentionally NOT rendered because it is unverified):
 *   { student: 'Name (with permission)', achievement: 'Class 10 CBSE 2024 - 94%',
 *     quote: 'Optional approved quote', when: '2024' }
 * The section and its nav link stay hidden while this array is empty. */
const RESULTS = [];

// Teaching methodology pillars (derived from the client-supplied description):
const PILLARS = [
  { icon: 'book', title: 'Concept-First Learning', text: 'Academic subjects for Classes 5-12 explained in a simple, easy way - understanding before memorising.' },
  { icon: 'target', title: 'Exam-Oriented Practice', text: 'Class 10 special focus with in-depth concepts and preparation built around board-exam patterns.' },
  { icon: 'zap', title: 'Magical Shortcuts', text: 'Math shortcut tricks - square roots, cube roots and multiplication faster than a calculator.' },
  { icon: 'sparkles', title: 'Daily Sharpening', text: 'Daily shorts, quizzes and simplification methods that solve complex problems in 10-20 seconds.' }
];

// Frequently asked questions (answers reflect the actual, verified services only):
const FAQS = [
  { q: 'How do I apply for admission?', a: 'Fill the online admission form on this page. You will receive a unique application reference ID immediately - save it. Our team then contacts you to confirm your batch and timings. You can also apply by calling or WhatsApping us, or by visiting the institute.' },
  { q: 'Which classes and subjects do you teach?', a: 'We guide students from Class 5 to Class 12. Core subjects include Mathematics, Science, English, Hindi and Social Science depending on the class, with a special flagship program for Class 10 board preparation and a Magical Math Tricks series open to all.' },
  { q: 'Is there any fee for courses?', a: 'No. Every course at Rabbani Education Circle is 100 percent free - there are no fees or hidden charges of any kind.' },
  { q: 'What is the difference between online and offline classes?', a: 'Offline classes run as classroom batches at our campus in Puranaganj, Bihar with personal attention. Online learning happens on our YouTube channel - concept videos, the Class 10 special series, math shortcut shorts and daily updates - so you can learn anywhere, anytime.' },
  { q: 'What are the class timings?', a: 'Batch timings are shared when your admission is confirmed, because batches are arranged by class and demand. Call or WhatsApp +91 82525 49170 for the current schedule.' },
  { q: 'Can I try a class before joining?', a: 'You can sample the teaching style right away through the free lessons on our YouTube channel. For an offline classroom visit, contact the institute and we will arrange it.' },
  { q: 'How do I join the online classes?', a: 'Open our YouTube channel (youtube.com/@rabbanieducationcircle), subscribe and press the bell icon, then follow the playlists for your class. Everything is free.' },
  { q: 'How can I contact the institute?', a: 'Call or WhatsApp +91 82525 49170, email suppory@spacenode.com, or visit Rabbani Manzil, Puranaganj, Bihar 854317. You can also use the enquiry form on this page.' }
];

/* =====================================================================================
 * SECTION 2 - SERVER CORE (security, validation, MongoDB, rate limiting)
 * A minimal duplicate of this core also lives in admin.js so the two functions stay
 * independently bundleable (small functions = fast cold starts on Vercel).
 * ===================================================================================== */

const IS_PROD = process.env.NODE_ENV === 'production';
const DB_NAME = process.env.MONGODB_DB_NAME || 'rabbani_education_circle';
const BODY_LIMIT = 64 * 1024; // 64 KB - far larger than any legitimate form payload
const ADMISSION_RATE = { limit: 5, windowMs: 10 * 60 * 1000 };   // 5 per 10 min per client
const CONTACT_RATE = { limit: 3, windowMs: 10 * 60 * 1000 };     // 3 per 10 min per client

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

function redact(msg) {
  // Never let a connection string (or any env secret value) reach logs or responses.
  let out = String(msg == null ? '' : msg);
  for (const k of ['MONGODB_URI', 'SESSION_SECRET', 'ADMIN_PASSWORD_HASH']) {
    const v = process.env[k];
    if (v) out = out.split(v).join('***');
  }
  return out;
}

/* ---- Response helpers (uniform security headers on every response) ---------------- */
function applyBaseHeaders(res, extra) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
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
      "img-src 'self' data: https://images.pexels.com",
      "connect-src 'self'",
      "frame-src https://www.google.com https://maps.google.com",
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

function sendText(res, status, text, contentType, extra) {
  applyBaseHeaders(res, extra);
  res.setHeader('Content-Type', contentType || 'text/plain; charset=utf-8');
  res.statusCode = status;
  res.end(text);
}

/* ---- Request helpers --------------------------------------------------------------- */
function requestPath(req) {
  let p = '/';
  try {
    p = decodeURIComponent(new URL(req.url || '/', 'http://internal').pathname);
  } catch (e) { /* malformed URL -> keep '/' */ }
  // When a rewrite routes traffic to this function the original public URL is
  // preserved in req.url. These mappings cover direct destination hits as well.
  if (p === '/index.js' || p === '/index') p = '/';
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
  // Salted one-way hash: rate-limit keys never store raw IP addresses.
  const salt = process.env.SESSION_SECRET || 'rec-rate-salt';
  return crypto.createHash('sha256').update(salt + '|' + clientIp(req)).digest('hex').slice(0, 32);
}

async function readJsonBody(req, limitBytes) {
  const declared = parseInt(String(req.headers['content-length'] || '0'), 10);
  if (declared > limitBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  if (size > limitBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
  }
  return data;
}

/* ---- Escaping (defence in depth; browser code uses safe DOM APIs everywhere) ------ */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ---- Field validators (shared rules used by BOTH browser and backend) ------------- */
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s.'-]{1,78}$/u;
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i;
const CITY_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s.,'()/&-]{0,58}$/u;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const IDEM_RE = /^[A-Za-z0-9_-]{8,64}$/;

const ok = v => ({ ok: true, value: v });
const bad = msg => ({ ok: false, error: msg });

function vName(raw, label) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return bad('Please enter ' + label + '.');
  if (s.length < 3 || s.length > 80) return bad(label + ' must be 3-80 characters long.');
  if (!NAME_RE.test(s)) return bad(label + ' may contain letters, spaces, dots, apostrophes and hyphens only.');
  return ok(s);
}
function vMobile(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!d) return bad('Please enter a mobile number.');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) return bad('Enter a valid 10-digit Indian mobile number (you may include +91).');
  return ok(d);
}
function vEmail(raw, required) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) {
    if (required) return bad('Please enter an email address.');
    return ok(null);
  }
  if (s.length > 254 || !EMAIL_RE.test(s)) return bad('Enter a valid email address.');
  return ok(s);
}
function vEnum(raw, allowed, label) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  const found = allowed.find(a => String(a).toLowerCase() === s);
  if (found === undefined) return bad('Choose a valid ' + label + '.');
  return ok(found);
}
function vCity(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return bad('Please enter your city or locality.');
  if (s.length < 2 || s.length > 60) return bad('City / locality must be 2-60 characters.');
  if (!CITY_RE.test(s)) return bad('City / locality contains characters that are not allowed.');
  return ok(s);
}
function vPlainText(raw, label, min, max, required) {
  const s = String(raw == null ? '' : raw).trim().replace(CONTROL_CHARS_RE, '');
  if (!s) {
    if (required) return bad('Please enter ' + label + '.');
    return ok(null);
  }
  if (s.length < min) return bad(label + ' must be at least ' + min + ' characters.');
  if (s.length > max) return bad(label + ' must be at most ' + max + ' characters.');
  return ok(s);
}
function vBoolTrue(raw, msg) {
  if (raw !== true) return bad(msg);
  return ok(true);
}

/* ---- MongoDB (cached connection reusable across warm invocations) ----------------- */
let _mongoCache = (typeof globalThis !== 'undefined' && globalThis.__recMongo) || null;

async function getDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri || !/^mongodb(\+srv)?:\/\//i.test(uri)) {
    throw new HttpError(503, 'CONFIG_MISSING', 'The admission service is not configured yet. Please try again later or contact the institute directly.');
  }
  if (!_mongoCache || !_mongoCache.promise) {
    const opts = {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      maxIdleTimeMS: 30 * 1000,
      retryWrites: true
    };
    const client = new MongoClient(uri, opts);
    _mongoCache = { promise: client.connect().then(c => ({ client, db: c.db(DB_NAME) })) };
    if (typeof globalThis !== 'undefined') globalThis.__recMongo = _mongoCache;
    _mongoCache.promise.catch(() => { _mongoCache = null; if (globalThis.__recMongo) globalThis.__recMongo = null; });
  }
  try {
    return (await _mongoCache.promise).db;
  } catch (e) {
    _mongoCache = null;
    if (globalThis.__recMongo) globalThis.__recMongo = null;
    throw new HttpError(503, 'DB_UNAVAILABLE', 'We could not save your application just now. Nothing was saved - please try again in a moment.');
  }
}

// Version-agnostic findOneAndUpdate: driver v4/v5 returns {value}, v6 returns the doc.
async function findOneAndUpdateDoc(coll, filter, update, opts) {
  const r = await coll.findOneAndUpdate(filter, update, opts);
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    if ('value' in r) return r.value;
    return r;
  }
  return null;
}

async function ensureSchema(db) {
  if (db.__recSchemaReady) return;
  try {
    await Promise.all([
      db.collection('admissions').createIndex({ appId: 1 }, { unique: true }),
      db.collection('admissions').createIndex({ idempotencyKey: 1 }, { unique: true }),
      db.collection('admissions').createIndex({ createdAt: -1 }),
      db.collection('admissions').createIndex({ status: 1, createdAt: -1 }),
      db.collection('admissions').createIndex({ courseId: 1 }),
      db.collection('admissions').createIndex({ mobile: 1 }),
      db.collection('contact_messages').createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 }),
      db.collection('rate_limits').createIndex({ exp: 1 }, { expireAfterSeconds: 0 }),
      db.collection('counters').createIndex({ _id: 1 })
    ]);
    db.__recSchemaReady = true;
  } catch (e) {
    console.error('[db] index setup skipped:', redact(e.message));
  }
}

/* ---- Rate limiting (MongoDB-backed fixed window - reliable across instances) ------- */
async function enforceRateLimit(db, bucket, hash, limit, windowMs) {
  try {
    const bucketNo = Math.floor(Date.now() / windowMs);
    const key = bucket + ':' + hash + ':' + bucketNo;
    const doc = await findOneAndUpdateDoc(
      db.collection('rate_limits'),
      { _id: key },
      { $inc: { n: 1 }, $setOnInsert: { exp: new Date(Date.now() + windowMs + 60 * 1000) } },
      { upsert: true, returnDocument: 'after' }
    );
    const n = doc && typeof doc.n === 'number' ? doc.n : 1;
    if (n > limit) {
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (Date.now() % windowMs)) / 1000));
      throw new HttpError(429, 'RATE_LIMITED',
        'Too many submissions from your connection. Please wait a few minutes and try again.', { retryAfterSec });
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error('[rate-limit] backend check failed (allowing request):', redact(e.message));
    // If the limiter itself is unreachable we fail open rather than block genuine
    // admission applications; unique-key idempotency still prevents duplicates.
  }
}

/* ---- Human-readable application reference IDs -------------------------------------- */
async function nextAppId(db) {
  const year = String(new Date().getFullYear()).slice(-2);
  const doc = await findOneAndUpdateDoc(
    db.collection('counters'),
    { _id: 'admissions' },
    { $inc: { seq: 1 }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true, returnDocument: 'after' }
  );
  const seq = doc && typeof doc.seq === 'number' ? doc.seq : Math.floor(Math.random() * 90000) + 10000;
  return 'REC-' + year + '-' + String(seq).padStart(5, '0');
}

/* =====================================================================================
 * SECTION 3 - DESIGN SYSTEM (glassmorphism: deep blue / violet / cyan / pink)
 * Shared visual language between the public site and the admin dashboard
 * (admin.js carries a matching token block). No animation libraries - pure CSS,
 * and every animation is disabled under prefers-reduced-motion.
 * ===================================================================================== */

const CSS = `
:root {
  --ink: #10143a;
  --ink-soft: rgba(16, 20, 58, 0.74);
  --ink-faint: rgba(16, 20, 58, 0.55);
  --bg: #edf1fd;
  --surface: rgba(255, 255, 255, 0.66);
  --surface-2: rgba(255, 255, 255, 0.42);
  --stroke: rgba(255, 255, 255, 0.75);
  --stroke-soft: rgba(16, 20, 58, 0.10);
  --brand-1: #4f46e5;
  --brand-2: #7c3aed;
  --brand-3: #06b6d4;
  --brand-4: #ec4899;
  --ok: #059669;
  --warn: #b45309;
  --bad: #dc2626;
  --glass-blur: 18px;
  --radius: 22px;
  --radius-sm: 14px;
  --shadow: 0 18px 50px -18px rgba(31, 25, 96, 0.35);
  --shadow-soft: 0 10px 34px -14px rgba(31, 25, 96, 0.25);
  --focus: 0 0 0 3px rgba(6, 182, 212, 0.45);
  --font: "Plus Jakarta Sans", "Noto Sans", "Noto Sans Devanagari", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --grad-brand: linear-gradient(135deg, #4f46e5 0%, #7c3aed 55%, #06b6d4 130%);
}
html[data-theme="dark"] {
  --ink: #edf0ff;
  --ink-soft: rgba(237, 240, 255, 0.75);
  --ink-faint: rgba(237, 240, 255, 0.55);
  --bg: #060a18;
  --surface: rgba(19, 26, 54, 0.55);
  --surface-2: rgba(19, 26, 54, 0.35);
  --stroke: rgba(148, 158, 226, 0.20);
  --stroke-soft: rgba(148, 158, 226, 0.14);
  --ok: #34d399;
  --warn: #fbbf24;
  --bad: #f87171;
  --shadow: 0 22px 60px -20px rgba(0, 0, 0, 0.65);
  --shadow-soft: 0 12px 40px -16px rgba(0, 0, 0, 0.55);
}
*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 92px; }
body {
  margin: 0;
  font-family: var(--font);
  color: var(--ink);
  font-size: 16.5px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  background:
    radial-gradient(1100px 620px at 88% -12%, rgba(124, 58, 237, 0.20), transparent 62%),
    radial-gradient(900px 540px at -12% 18%, rgba(6, 182, 212, 0.18), transparent 60%),
    radial-gradient(760px 520px at 52% 112%, rgba(236, 72, 153, 0.13), transparent 62%),
    var(--bg);
  background-attachment: fixed;
  min-height: 100vh;
  overflow-x: hidden;
}
::selection { background: rgba(124, 58, 237, 0.30); }
a { color: inherit; text-decoration: none; }
img { max-width: 100%; display: block; }
h1, h2, h3, h4 { line-height: 1.18; margin: 0 0 0.5em; font-weight: 800; letter-spacing: -0.015em; }
p { margin: 0 0 1em; color: var(--ink-soft); }
:focus-visible { outline: 3px solid rgba(6, 182, 212, 0.65); outline-offset: 2px; border-radius: 6px; }
.skip-link {
  position: fixed; top: -60px; left: 16px; z-index: 300;
  background: var(--grad-brand); color: #fff; padding: 10px 18px; border-radius: 12px;
  font-weight: 700; transition: top 0.25s ease;
}
.skip-link:focus { top: 14px; }

/* ---------- Aurora decorative shapes ---------- */
.aurora { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; }
.aurora span {
  position: absolute; border-radius: 50%; filter: blur(90px); opacity: 0.5;
  animation: floatBlob 16s ease-in-out infinite alternate;
}
.aurora span:nth-child(1) { width: 480px; height: 480px; top: -160px; right: -120px; background: rgba(124, 58, 237, 0.55); }
.aurora span:nth-child(2) { width: 420px; height: 420px; bottom: -140px; left: -140px; background: rgba(6, 182, 212, 0.42); animation-delay: -6s; }
.aurora span:nth-child(3) { width: 320px; height: 320px; top: 42%; left: 58%; background: rgba(236, 72, 153, 0.30); animation-delay: -11s; }
html[data-theme="dark"] .aurora span { opacity: 0.38; }
@keyframes floatBlob {
  0% { transform: translate3d(0, 0, 0) scale(1); }
  100% { transform: translate3d(-40px, 46px, 0) scale(1.12); }
}

/* ---------- Layout ---------- */
.wrap { width: min(1160px, calc(100% - 40px)); margin-inline: auto; }
.section { padding: clamp(64px, 9vw, 110px) 0 0; }
.section-head { max-width: 680px; margin-bottom: clamp(28px, 4vw, 44px); }
.eyebrow {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 0.78rem; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase;
  padding: 7px 14px; border-radius: 999px;
  background: var(--surface-2); border: 1px solid var(--stroke); color: var(--brand-1);
  box-shadow: var(--shadow-soft);
}
html[data-theme="dark"] .eyebrow { color: #a5b4fc; }
.section-head h2 { font-size: clamp(1.65rem, 3.4vw, 2.5rem); margin-top: 14px; }
.section-head .lead { font-size: 1.05rem; margin-bottom: 0; }
.grad-text {
  background: linear-gradient(92deg, var(--brand-1), var(--brand-2) 48%, var(--brand-3));
  -webkit-background-clip: text; background-clip: text; color: transparent;
}

/* ---------- Glass primitives ---------- */
.glass {
  background: var(--surface);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(150%);
  backdrop-filter: blur(var(--glass-blur)) saturate(150%);
  border: 1px solid var(--stroke);
  border-radius: var(--radius);
  box-shadow: var(--shadow-soft);
}
.glass-strong { background: var(--surface); box-shadow: var(--shadow); }

/* ---------- Buttons ---------- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 10px;
  font: inherit; font-weight: 700; cursor: pointer; border: 1px solid transparent;
  padding: 13px 24px; border-radius: 999px; min-height: 48px;
  transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease, opacity 0.2s ease;
  text-align: center; line-height: 1.2;
}
.btn svg { flex: none; }
.btn-primary {
  background: var(--grad-brand); color: #fff;
  box-shadow: 0 14px 30px -10px rgba(79, 70, 229, 0.55);
}
.btn-primary:hover { transform: translateY(-2px); box-shadow: 0 20px 40px -12px rgba(79, 70, 229, 0.6); }
.btn-ghost {
  background: var(--surface); color: var(--ink); border-color: var(--stroke);
  -webkit-backdrop-filter: blur(var(--glass-blur)); backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--shadow-soft);
}
.btn-ghost:hover { transform: translateY(-2px); }
.btn-danger { background: linear-gradient(135deg, #dc2626, #b91c1c); color: #fff; }
.btn-sm { padding: 8px 16px; min-height: 40px; font-size: 0.92rem; }
.btn[disabled] { opacity: 0.6; cursor: progress; transform: none !important; }
.btn .spin {
  width: 17px; height: 17px; border-radius: 50%; flex: none;
  border: 2.5px solid rgba(255, 255, 255, 0.4); border-top-color: #fff;
  animation: spin 0.7s linear infinite; display: none;
}
.btn.loading .spin { display: inline-block; }
.btn.loading svg:not(.spin) { display: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.link-arrow { font-weight: 700; display: inline-flex; gap: 8px; align-items: center; color: var(--brand-1); }
html[data-theme="dark"] .link-arrow { color: #a5b4fc; }
.link-arrow:hover { gap: 12px; }

/* ---------- Badges / chips / pills ---------- */
.badge {
  display: inline-flex; align-items: center; gap: 6px; font-size: 0.76rem; font-weight: 800;
  padding: 5px 12px; border-radius: 999px; letter-spacing: 0.02em;
}
.badge-online { background: rgba(6, 182, 212, 0.16); color: #0e7490; border: 1px solid rgba(6, 182, 212, 0.35); }
.badge-offline { background: rgba(236, 72, 153, 0.14); color: #be185d; border: 1px solid rgba(236, 72, 153, 0.35); }
.badge-free { background: rgba(5, 150, 105, 0.14); color: #047857; border: 1px solid rgba(5, 150, 105, 0.35); }
.badge-open { background: rgba(124, 58, 237, 0.14); color: #5b21b6; border: 1px solid rgba(124, 58, 237, 0.35); }
.badge-hero { background: var(--surface-2); color: var(--ink); border: 1px solid var(--stroke); }
html[data-theme="dark"] .badge-online { color: #67e8f9; }
html[data-theme="dark"] .badge-offline { color: #f9a8d4; }
html[data-theme="dark"] .badge-free { color: #6ee7b7; }
html[data-theme="dark"] .badge-open { color: #c4b5fd; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip-subject {
  font-size: 0.78rem; font-weight: 700; padding: 5px 12px; border-radius: 999px;
  background: var(--surface-2); border: 1px solid var(--stroke-soft); color: var(--ink-soft);
}

/* ---------- Navigation ---------- */
.nav {
  position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  transition: background 0.3s ease, box-shadow 0.3s ease, border-color 0.3s ease;
  border-bottom: 1px solid transparent;
}
.nav.scrolled, .nav.menu-open {
  background: var(--surface);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(160%);
  backdrop-filter: blur(var(--glass-blur)) saturate(160%);
  border-bottom-color: var(--stroke-soft);
  box-shadow: var(--shadow-soft);
}
.nav-inner { display: flex; align-items: center; gap: 18px; padding: 14px 0; }
.logo { display: inline-flex; align-items: center; gap: 12px; font-weight: 800; font-size: 1.06rem; }
.logo-mark {
  width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; color: #fff;
  background: var(--grad-brand); box-shadow: 0 10px 22px -8px rgba(79, 70, 229, 0.6); flex: none;
}
.logo-text small { display: block; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.08em; color: var(--ink-faint); text-transform: uppercase; }
.nav-links { display: flex; align-items: center; gap: 4px; margin-left: auto; list-style: none; padding: 0; }
.nav-links a {
  padding: 9px 13px; border-radius: 12px; font-weight: 600; font-size: 0.95rem; color: var(--ink-soft);
  transition: background 0.2s ease, color 0.2s ease;
}
.nav-links a:hover, .nav-links a.active { background: var(--surface-2); color: var(--ink); }
.nav-actions { display: flex; align-items: center; gap: 10px; }
.icon-btn {
  width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; cursor: pointer;
  background: var(--surface-2); border: 1px solid var(--stroke); color: var(--ink);
  transition: transform 0.2s ease, background 0.2s ease;
}
.icon-btn:hover { transform: translateY(-2px); }
html[data-theme="dark"] .theme-toggle .sun { display: none; }
html:not([data-theme="dark"]) .theme-toggle .moon { display: none; }
.burger { display: none; }
.burger span { display: block; width: 20px; height: 2px; border-radius: 2px; background: var(--ink); margin: 2.5px 0; transition: transform 0.25s ease, opacity 0.2s ease; }
.nav.menu-open .burger span:nth-child(1) { transform: translateY(4.5px) rotate(45deg); }
.nav.menu-open .burger span:nth-child(2) { opacity: 0; }
.nav.menu-open .burger span:nth-child(3) { transform: translateY(-4.5px) rotate(-45deg); }
.mobile-menu {
  display: none; position: absolute; top: 100%; left: 12px; right: 12px; border-radius: 20px;
  background: var(--surface); border: 1px solid var(--stroke); box-shadow: var(--shadow);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(160%); backdrop-filter: blur(var(--glass-blur)) saturate(160%);
  padding: 12px; flex-direction: column; gap: 2px;
}
.nav.menu-open .mobile-menu { display: flex; }
.mobile-menu a { padding: 13px 16px; border-radius: 12px; font-weight: 600; }
.mobile-menu a:hover { background: var(--surface-2); }
.mobile-menu .btn { margin-top: 8px; }

/* ---------- Hero ---------- */
.hero { padding: clamp(126px, 16vh, 170px) 0 0; position: relative; }
.hero-grid { display: grid; grid-template-columns: 1.08fr 0.92fr; gap: clamp(28px, 4vw, 56px); align-items: center; }
.hero-badges { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 22px; }
.hero h1 { font-size: clamp(2.15rem, 4.6vw, 3.6rem); margin-bottom: 18px; }
.hero .lead { font-size: clamp(1.02rem, 1.6vw, 1.18rem); max-width: 560px; }
.hero-ctas { display: flex; flex-wrap: wrap; gap: 14px; margin: 26px 0 30px; }
.hero-trust { display: flex; flex-wrap: wrap; gap: 10px; }
.trust-pill {
  display: inline-flex; align-items: center; gap: 9px; font-weight: 700; font-size: 0.88rem;
  padding: 10px 16px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--stroke);
  -webkit-backdrop-filter: blur(var(--glass-blur)); backdrop-filter: blur(var(--glass-blur));
  color: var(--ink-soft);
}
.trust-pill svg { color: var(--brand-2); }
.hero-visual { position: relative; }
.img-frame {
  position: relative; border-radius: 26px; overflow: hidden; aspect-ratio: 3 / 2;
  background: linear-gradient(140deg, rgba(79, 70, 229, 0.75), rgba(124, 58, 237, 0.65) 45%, rgba(6, 182, 212, 0.6));
  border: 1px solid var(--stroke); box-shadow: var(--shadow);
}
.img-frame img { width: 100%; height: 100%; object-fit: cover; }
.img-frame img.img-failed { display: none; }
.img-frame .img-credit {
  position: absolute; bottom: 10px; right: 12px; font-size: 0.66rem; font-weight: 600;
  color: rgba(255, 255, 255, 0.85); background: rgba(10, 12, 34, 0.45);
  padding: 3px 9px; border-radius: 999px;
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
}
.float-card {
  position: absolute; display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  border-radius: 16px; background: var(--surface); border: 1px solid var(--stroke);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(160%); backdrop-filter: blur(var(--glass-blur)) saturate(160%);
  box-shadow: var(--shadow); font-weight: 700; font-size: 0.86rem;
  animation: floatY 6s ease-in-out infinite alternate;
}
.float-card svg { color: var(--brand-3); }
.float-card.fc-1 { top: -22px; left: -26px; animation-delay: -2s; }
.float-card.fc-2 { bottom: 64px; right: -20px; animation-delay: -4s; }
.float-card.fc-3 { bottom: -24px; left: 8%; animation-delay: -1s; }
@keyframes floatY { from { transform: translateY(-8px); } to { transform: translateY(10px); } }

/* ---------- About / pillars ---------- */
.about-grid { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: clamp(26px, 4vw, 54px); align-items: start; }
.about-quote {
  border-left: 4px solid var(--brand-2); padding: 14px 20px; margin: 20px 0;
  background: var(--surface-2); border-radius: 0 16px 16px 0;
  font-size: 1.05rem; font-weight: 600; color: var(--ink);
}
.about-quote footer { font-weight: 700; font-size: 0.85rem; color: var(--ink-faint); margin-top: 6px; }
.pillars { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-top: 34px; }
.pillar { padding: 22px; }
.pillar-icon {
  width: 48px; height: 48px; border-radius: 15px; display: grid; place-items: center; color: #fff;
  background: var(--grad-brand); box-shadow: 0 10px 22px -10px rgba(79, 70, 229, 0.55); margin-bottom: 14px;
}
.pillar h3 { font-size: 1.02rem; }
.pillar p { font-size: 0.92rem; margin: 0; }

/* ---------- Courses ---------- */
.course-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 22px; }
.course-card { padding: 26px; display: flex; flex-direction: column; gap: 14px; position: relative; overflow: hidden; }
.course-card.featured { border-color: rgba(124, 58, 237, 0.45); }
.course-card.featured::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: linear-gradient(140deg, rgba(124, 58, 237, 0.10), transparent 40%, rgba(6, 182, 212, 0.10));
}
.course-top { display: flex; align-items: center; gap: 12px; }
.course-icon {
  width: 52px; height: 52px; border-radius: 16px; display: grid; place-items: center; color: #fff; flex: none;
  background: linear-gradient(135deg, var(--brand-1), var(--brand-2)); box-shadow: 0 12px 26px -10px rgba(124, 58, 237, 0.55);
}
.course-card h3 { font-size: 1.18rem; margin: 0; }
.course-card .course-tag { font-size: 0.78rem; font-weight: 700; color: var(--ink-faint); }
.course-card p { font-size: 0.94rem; margin: 0; }
.course-meta { display: grid; gap: 9px; font-size: 0.87rem; color: var(--ink-soft); }
.course-meta div { display: flex; gap: 9px; align-items: flex-start; }
.course-meta svg { flex: none; margin-top: 3px; color: var(--brand-2); }
.course-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  border-top: 1px solid var(--stroke-soft); padding-top: 16px; margin-top: auto;
}
.course-fee { font-weight: 800; font-size: 1.02rem; color: var(--ok); }
.course-fee small { display: block; font-size: 0.72rem; color: var(--ink-faint); font-weight: 600; }

/* ---------- Mode sections (online / offline) ---------- */
.mode-grid { display: grid; grid-template-columns: 0.95fr 1.05fr; gap: clamp(26px, 4vw, 54px); align-items: center; }
.mode-grid.flip { grid-template-columns: 1.05fr 0.95fr; }
.mode-grid .img-frame { aspect-ratio: 4 / 3; }
.check-list { list-style: none; padding: 0; display: grid; gap: 13px; margin: 22px 0 26px; }
.check-list li { display: flex; gap: 12px; align-items: flex-start; color: var(--ink-soft); font-size: 0.98rem; }
.check-list svg { flex: none; margin-top: 3px; color: var(--ok); }
.mode-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.map-card { padding: 14px; margin-top: 30px; }
.map-frame { border: 0; width: 100%; height: 300px; border-radius: 16px; display: block; filter: saturate(1.05); }
html[data-theme="dark"] .map-frame { filter: invert(0.9) hue-rotate(185deg) saturate(0.9); }

/* ---------- Faculty ---------- */
.faculty-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 22px; }
.faculty-card { padding: 26px; text-align: left; }
.faculty-card .avatar {
  width: 76px; height: 76px; border-radius: 24px; display: grid; place-items: center;
  font-weight: 800; font-size: 1.5rem; color: #fff; margin-bottom: 16px;
  background: linear-gradient(135deg, hsl(258, 80%, 58%), hsl(190, 85%, 45%));
  box-shadow: 0 14px 30px -12px rgba(124, 58, 237, 0.6);
}
.faculty-card h3 { font-size: 1.12rem; margin-bottom: 2px; }
.faculty-role { font-size: 0.88rem; font-weight: 700; color: var(--brand-2); margin-bottom: 12px; }
html[data-theme="dark"] .faculty-role { color: #c4b5fd; }
.faculty-bio { font-size: 0.92rem; margin: 14px 0; }
.faculty-rows { display: grid; gap: 8px; font-size: 0.85rem; color: var(--ink-soft); }
.faculty-rows div { display: flex; gap: 8px; align-items: flex-start; }
.faculty-rows svg { flex: none; margin-top: 3px; color: var(--brand-3); }
.verified-row { display: inline-flex; align-items: center; gap: 7px; font-size: 0.8rem; font-weight: 700; color: var(--ok); }
.pending-row { display: inline-flex; align-items: center; gap: 7px; font-size: 0.8rem; font-weight: 700; color: var(--warn); }
.faculty-card.is-placeholder { border-style: dashed; opacity: 0.85; }

/* ---------- FAQ ---------- */
.faq-list { display: grid; gap: 12px; max-width: 860px; }
details.faq-item { padding: 4px 22px; }
details.faq-item summary {
  list-style: none; cursor: pointer; padding: 18px 0; font-weight: 700; font-size: 1.0rem;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
}
details.faq-item summary::-webkit-details-marker { display: none; }
details.faq-item summary svg { flex: none; transition: transform 0.25s ease; color: var(--brand-2); }
details.faq-item[open] summary svg { transform: rotate(180deg); }
details.faq-item .faq-a { padding: 0 0 20px; color: var(--ink-soft); font-size: 0.96rem; margin: 0; max-width: 92%; }

/* ---------- Forms ---------- */
.form-card { padding: clamp(24px, 3.4vw, 40px); }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px 20px; }
.field { display: grid; gap: 7px; }
.field.full { grid-column: 1 / -1; }
.field label { font-weight: 700; font-size: 0.92rem; }
.field label .opt { font-weight: 600; color: var(--ink-faint); font-size: 0.8rem; }
.field input, .field select, .field textarea {
  font: inherit; color: var(--ink); width: 100%;
  padding: 13px 15px; border-radius: 14px; border: 1.5px solid var(--stroke-soft);
  background: var(--surface-2); transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
}
.field textarea { resize: vertical; min-height: 110px; }
.field input::placeholder, .field textarea::placeholder { color: var(--ink-faint); }
.field input:focus, .field select:focus, .field textarea:focus {
  outline: none; border-color: var(--brand-2); box-shadow: var(--focus); background: var(--surface);
}
.field.invalid input, .field.invalid select, .field.invalid textarea { border-color: var(--bad); }
.ferr { color: var(--bad); font-size: 0.84rem; font-weight: 600; min-height: 1.1em; }
.fhint { color: var(--ink-faint); font-size: 0.8rem; }
.counter { text-align: right; font-size: 0.78rem; color: var(--ink-faint); }
.radio-pills { display: flex; gap: 10px; flex-wrap: wrap; }
.radio-pills input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.radio-pills label {
  cursor: pointer; display: inline-flex; align-items: center; gap: 9px; font-weight: 700; font-size: 0.94rem;
  padding: 11px 18px; border-radius: 999px; border: 1.5px solid var(--stroke-soft);
  background: var(--surface-2); transition: all 0.2s ease;
}
.radio-pills label:hover { border-color: var(--brand-2); }
.radio-pills input:checked + label {
  background: var(--grad-brand); color: #fff; border-color: transparent;
  box-shadow: 0 10px 24px -10px rgba(124, 58, 237, 0.6);
}
.radio-pills input:focus-visible + label { outline: 3px solid rgba(6, 182, 212, 0.65); outline-offset: 2px; }
.subject-chips { display: flex; flex-wrap: wrap; gap: 9px; }
.subject-chips input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.subject-chips label {
  cursor: pointer; font-size: 0.84rem; font-weight: 700; padding: 8px 14px; border-radius: 999px;
  border: 1.5px solid var(--stroke-soft); background: var(--surface-2); transition: all 0.2s ease;
}
.subject-chips input:checked + label { background: rgba(124, 58, 237, 0.16); border-color: var(--brand-2); color: var(--brand-2); }
html[data-theme="dark"] .subject-chips input:checked + label { color: #c4b5fd; }
.subject-chips input:focus-visible + label { outline: 3px solid rgba(6, 182, 212, 0.65); outline-offset: 2px; }
.consent-row { display: flex; gap: 12px; align-items: flex-start; }
.consent-row input { width: 20px; height: 20px; margin-top: 3px; accent-color: var(--brand-2); flex: none; }
.consent-row label { font-size: 0.9rem; font-weight: 600; color: var(--ink-soft); cursor: pointer; }
.form-foot { margin-top: 24px; display: grid; gap: 14px; }
.form-note { font-size: 0.82rem; color: var(--ink-faint); }
.success-panel { text-align: center; padding: 14px 8px 6px; }
.success-panel .ref-box {
  font-size: clamp(1.5rem, 4vw, 2.1rem); font-weight: 800; letter-spacing: 0.06em;
  background: linear-gradient(92deg, var(--brand-1), var(--brand-3));
  -webkit-background-clip: text; background-clip: text; color: transparent; margin: 10px 0 4px;
}
.success-actions { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin-top: 16px; }

/* ---------- Contact ---------- */
.contact-grid { display: grid; grid-template-columns: 0.9fr 1.1fr; gap: clamp(24px, 4vw, 44px); align-items: start; }
.info-cards { display: grid; gap: 14px; }
.info-card { display: flex; gap: 15px; padding: 18px 20px; align-items: center; }
.info-icon {
  width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center; color: #fff; flex: none;
  background: var(--grad-brand); box-shadow: 0 10px 22px -10px rgba(79, 70, 229, 0.55);
}
.info-card h3 { font-size: 0.95rem; margin: 0 0 2px; }
.info-card p { margin: 0; font-size: 0.92rem; }
.info-card a { font-weight: 700; color: var(--brand-1); }
html[data-theme="dark"] .info-card a { color: #a5b4fc; }
.social-row { display: flex; gap: 10px; }
.social-btn {
  width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center; color: #fff;
  background: var(--grad-brand); box-shadow: var(--shadow-soft); transition: transform 0.2s ease;
}
.social-btn:hover { transform: translateY(-3px); }
.social-btn.sv-youtube { background: linear-gradient(135deg, #ff5f5f, #d9302c); }
.social-btn.sv-facebook { background: linear-gradient(135deg, #4f8cff, #1a56db); }
.social-btn.sv-instagram { background: linear-gradient(135deg, #f58529, #dd2a7b 55%, #8134af); }

/* ---------- Footer ---------- */
.footer { margin-top: clamp(70px, 10vw, 120px); padding: 0 0 26px; }
.footer-card { padding: clamp(28px, 4vw, 44px); }
.footer-grid { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1.2fr; gap: 30px; }
.footer h4 { font-size: 0.95rem; margin-bottom: 14px; }
.footer-links { list-style: none; padding: 0; display: grid; gap: 9px; }
.footer-links a { color: var(--ink-soft); font-size: 0.92rem; font-weight: 600; }
.footer-links a:hover { color: var(--brand-2); }
.footer-links button {
  background: none; border: none; padding: 0; font: inherit; cursor: pointer;
  color: var(--ink-soft); font-size: 0.92rem; font-weight: 600; text-align: left;
}
.footer-links button:hover { color: var(--brand-2); }
.footer-brand p { font-size: 0.92rem; }
.footer-bottom {
  display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; align-items: center;
  border-top: 1px solid var(--stroke-soft); margin-top: 30px; padding-top: 20px; font-size: 0.84rem; color: var(--ink-faint);
}

/* ---------- Floating WhatsApp ---------- */
.fab {
  position: fixed; right: 22px; bottom: 22px; z-index: 90; width: 58px; height: 58px; border-radius: 50%;
  display: grid; place-items: center; color: #fff;
  background: linear-gradient(135deg, #34d399, #059669);
  box-shadow: 0 16px 34px -10px rgba(5, 150, 105, 0.65);
  transition: transform 0.2s ease;
}
.fab:hover { transform: translateY(-4px) scale(1.05); }
.fab::after {
  content: ""; position: absolute; inset: -6px; border-radius: 50%;
  border: 2px solid rgba(5, 150, 105, 0.5); animation: fabPulse 2.4s ease-out infinite;
}
@keyframes fabPulse {
  0% { transform: scale(0.9); opacity: 1; }
  100% { transform: scale(1.5); opacity: 0; }
}

/* ---------- Toasts ---------- */
.toasts { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 400; display: grid; gap: 10px; width: min(430px, calc(100vw - 40px)); }
.toast {
  display: flex; gap: 12px; align-items: flex-start; padding: 14px 18px; border-radius: 16px;
  background: rgba(16, 20, 42, 0.92); color: #fff; font-size: 0.94rem; font-weight: 600;
  border: 1px solid rgba(148, 158, 226, 0.25); box-shadow: var(--shadow);
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
  animation: toastIn 0.35s cubic-bezier(0.21, 1.02, 0.73, 1);
}
.toast svg { flex: none; margin-top: 2px; }
.toast.ok svg { color: #34d399; }
.toast.err svg { color: #f87171; }
.toast.info svg { color: #67e8f9; }
@keyframes toastIn { from { opacity: 0; transform: translateY(14px) scale(0.97); } to { opacity: 1; transform: none; } }

/* ---------- Dialogs ---------- */
dialog.rec-dialog {
  border: 1px solid var(--stroke); border-radius: 24px; padding: 0;
  background: var(--surface); color: var(--ink); width: min(620px, calc(100vw - 40px));
  box-shadow: var(--shadow);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(160%); backdrop-filter: blur(var(--glass-blur)) saturate(160%);
}
dialog.rec-dialog::backdrop { background: rgba(6, 10, 30, 0.55); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
.dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 22px 26px 0; }
.dialog-head h3 { margin: 0; font-size: 1.2rem; }
.dialog-body { padding: 18px 26px 26px; max-height: 60vh; overflow: auto; font-size: 0.95rem; }
.dialog-body p { color: var(--ink-soft); }
.dialog-body h4 { margin: 18px 0 6px; font-size: 1rem; }

/* ---------- Scroll reveal ---------- */
.reveal { opacity: 0; transform: translateY(22px); }
.reveal.in { opacity: 1; transform: none; transition: opacity 0.65s ease, transform 0.65s cubic-bezier(0.22, 0.61, 0.36, 1); }

/* ---------- 404 ---------- */
.nf-wrap { min-height: 74vh; display: grid; place-items: center; text-align: center; padding: 130px 20px 60px; }
.nf-code { font-size: clamp(4.4rem, 16vw, 8rem); font-weight: 800; line-height: 1; }

/* ---------- Responsive ---------- */
@media (max-width: 1080px) {
  .footer-grid { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 940px) {
  .hero-grid, .about-grid, .mode-grid, .mode-grid.flip, .contact-grid { grid-template-columns: 1fr; }
  .hero-visual { max-width: 560px; }
  .float-card.fc-1 { left: -8px; }
  .float-card.fc-2 { right: -6px; }
  .nav-links { display: none; }
  .burger { display: grid; place-items: center; }
  .nav-cta { display: none; }
  .pillars { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  body { font-size: 15.5px; }
  .wrap { width: calc(100% - 32px); }
  .form-grid { grid-template-columns: 1fr; }
  .footer-grid { grid-template-columns: 1fr; }
  .float-card { display: none; }
  .hero-ctas .btn { width: 100%; }
  .toasts { width: calc(100vw - 28px); }
}

/* ---------- Reduced motion ---------- */
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation-duration: 0.001s !important; animation-iteration-count: 1 !important;
    transition-duration: 0.001s !important;
  }
  .reveal { opacity: 1; transform: none; }
  .aurora span, .float-card, .fab::after { animation: none !important; }
}
`;

/* =====================================================================================
 * SECTION 4 - PUBLIC WEBSITE HTML (server-rendered string with per-request CSP nonce)
 * ===================================================================================== */

/* ---- Inline SVG icon set (stroke style; brand icons filled) ------------------------ */
const ICON_PATHS = {
  cap: '<path d="M22 9.5 12 4.5 2 9.5l10 5 10-5z"/><path d="M6 11.9V17c0 1.6 2.7 2.9 6 2.9s6-1.3 6-2.9v-5.1"/><path d="M22 9.5v5"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M5 12v9h14v-9"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.1 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.7 2.6a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.5-1.2a2 2 0 0 1 2.1-.5c.8.4 1.7.6 2.6.7a2 2 0 0 1 1.7 2z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  whatsapp: '<path d="M12 3a9 9 0 0 0-7.8 13.4L3 21l4.7-1.2A9 9 0 1 0 12 3z"/><path d="M9 8.5c0 4.1 2.4 6.5 6.5 6.5l1-1.9-2.2-1-.9.9c-1.1-.5-2-1.4-2.5-2.5l.9-.9-1-2.2z"/>',
  youtube: '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="m10 9 5 3-5 3z"/>',
  facebook: '<path d="M15.5 3H13a4 4 0 0 0-4 4v3H6.5v3.5H9V21h3.5v-7.5h2.8l.7-3.5h-3.5V7.2c0-.7.4-1.2 1.2-1.2h1.8z" fill="currentColor" stroke="none"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/>',
  shield: '<path d="M12 22s8-3.6 8-10V5l-8-3-8 3v7c0 6.4 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1"/><path d="M16 3.5a4 4 0 0 1 0 7.5"/><path d="M22 21v-1a6 6 0 0 0-4-5.6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  star: '<polygon points="12 2 15.1 8.6 22 9.6 17 14.5 18.2 21.4 12 18.1 5.8 21.4 7 14.5 2 9.6 8.9 8.6 12 2"/>',
  external: '<path d="M14 3h7v7"/><path d="M21 3 10 14"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>'
};

function icon(name, size) {
  const s = size || 20;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON_PATHS[name] || '') + '</svg>';
}

const FAVICON_DATA = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%234f46e5%22%2F%3E%3Cstop%20offset%3D%22.55%22%20stop-color%3D%22%237c3aed%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%2306b6d4%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2216%22%20fill%3D%22url(%23g)%22%2F%3E%3Cpath%20d%3D%22M50%2026%20L32%2017%2014%2026%20l18%209%2018-9z%22%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-width%3D%223%22%20stroke-linejoin%3D%22round%22%2F%3E%3Cpath%20d%3D%22M22%2031v7c0%202.5%204.5%204.5%2010%204.5s10-2%2010-4.5v-7%22%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-width%3D%223%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E';

/* ---- Small helpers used while composing HTML --------------------------------------- */
const waLink = 'https://wa.me/' + SITE.whatsappNumber + '?text=' + encodeURIComponent(SITE.whatsappPrefill);
function imgTag(key, ratioClass) {
  const im = IMAGES[key];
  return '<img src="' + im.src + '" alt="' + escapeHtml(im.alt) + '" width="' + im.w + '" height="' + im.h +
    '" loading="lazy" decoding="async" data-fallback="1">' +
    '<span class="img-credit" aria-hidden="true">Photo: Pexels</span>';
}

/* ---- <head> ------------------------------------------------------------------------- */
function headHtml(nonce) {
  const title = SITE.name + ' - Free Coaching for Classes 5-12 | Online & Offline';
  const desc = 'Rabbani Education Circle offers 100% free coaching for Classes 5-12 at Puranaganj, Bihar and free online lessons on YouTube. Board-exam preparation for Class 10, magical math shortcut tricks and daily practice - led by Md. Rahmat Rabbani.';
  return '<head>\n' +
  '<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<title>' + escapeHtml(title) + '</title>\n' +
  '<meta name="description" content="' + escapeHtml(desc) + '">\n' +
  '<meta name="generator" content="Rabbani Education Circle website - created by Spacenode">\n' +
  '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#edf1fd">\n' +
  '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#060a18">\n' +
  '<link rel="canonical" href="' + escapeHtml(SITE.domain) + '/">\n' +
  '<meta property="og:type" content="website">\n' +
  '<meta property="og:site_name" content="' + escapeHtml(SITE.name) + '">\n' +
  '<meta property="og:title" content="' + escapeHtml(title) + '">\n' +
  '<meta property="og:description" content="' + escapeHtml(desc) + '">\n' +
  '<meta property="og:url" content="' + escapeHtml(SITE.domain) + '/">\n' +
  (IMAGES.og ? '<meta property="og:image" content="' + escapeHtml(IMAGES.og) + '">\n' : '') +
  '<meta name="twitter:card" content="summary_large_image">\n' +
  '<meta name="twitter:title" content="' + escapeHtml(title) + '">\n' +
  '<meta name="twitter:description" content="' + escapeHtml(desc) + '">\n' +
  (IMAGES.og ? '<meta name="twitter:image" content="' + escapeHtml(IMAGES.og) + '">\n' : '') +
  '<link rel="icon" type="image/svg+xml" href="' + FAVICON_DATA + '">\n' +
  '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Noto+Sans+Devanagari:wght@400;600;700&display=swap">\n' +
  '<script nonce="' + nonce + '">(function(){try{var t=localStorage.getItem("rec-theme");if(t==="dark"||(!t&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.setAttribute("data-theme","dark");}}catch(e){}})();<\/script>\n' +
  '<style nonce="' + nonce + '">' + CSS + '</style>\n' +
  '<script nonce="' + nonce + '" type="application/ld+json">' + JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'EducationalOrganization',
    name: SITE.name,
    description: desc,
    founder: { '@type': 'Person', name: SITE.owner },
    telephone: SITE.phoneTel,
    email: SITE.email,
    isAccessibleForFree: true,
    address: {
      '@type': 'PostalAddress',
      streetAddress: SITE.addressLine1,
      addressLocality: 'Puranaganj',
      addressRegion: 'Bihar',
      postalCode: '854317',
      addressCountry: 'IN'
    },
    sameAs: [SITE.social.youtube, SITE.social.facebook, SITE.social.instagram]
  }) + '</script>\n' +
  '</head>';
}

/* ---- Navigation --------------------------------------------------------------------- */
function navHtml() {
  const links = [
    ['#about', 'About'], ['#courses', 'Courses'], ['#online', 'Online Classes'],
    ['#offline', 'Offline Classes'], ['#faculty', 'Faculty'], ['#faq', 'FAQ'], ['#contact', 'Contact']
  ];
  const linkItems = links.map(l => '<li><a href="' + l[0] + '">' + l[1] + '</a></li>').join('');
  const mobileLinks = links.map(l => '<a href="' + l[0] + '">' + l[1] + '</a>').join('');
  return '<header class="nav" id="nav">\n<div class="wrap nav-inner">\n' +
    '<a class="logo" href="#home" aria-label="' + escapeHtml(SITE.name) + ' - home">\n' +
    '<span class="logo-mark">' + icon('cap', 24) + '</span>\n' +
    '<span class="logo-text">' + escapeHtml(SITE.name) + '<small>' + escapeHtml(SITE.tagline) + '</small></span>\n' +
    '</a>\n' +
    '<nav aria-label="Primary">\n<ul class="nav-links">' + linkItems + '</ul>\n</nav>\n' +
    '<div class="nav-actions">\n' +
    '<button type="button" class="icon-btn theme-toggle" id="themeToggle" aria-label="Toggle dark mode">' + icon('sun', 20) + icon('moon', 20) + '</button>\n' +
    '<a class="btn btn-primary btn-sm nav-cta" href="#admission">Apply for Admission</a>\n' +
    '<button type="button" class="icon-btn burger" id="burger" aria-label="Open menu" aria-expanded="false" aria-controls="mobileMenu"><span></span><span></span><span></span></button>\n' +
    '</div>\n' +
    '<div class="mobile-menu" id="mobileMenu">\n' + mobileLinks +
    '<a class="btn btn-primary" href="#admission">Apply for Admission</a>\n' +
    '</div>\n' +
    '</div>\n</header>';
}

/* ---- Hero --------------------------------------------------------------------------- */
function heroHtml() {
  return '<section class="hero" id="home" aria-label="Introduction">\n<div class="wrap hero-grid">\n' +
    '<div class="reveal">\n' +
    '<div class="hero-badges">\n' +
    '<span class="badge badge-hero">' + icon('cap', 15) + ' Admissions open - Classes 5 to 12</span>\n' +
    '<span class="badge badge-free">' + icon('gift', 15) + ' 100% Free</span>\n' +
    '</div>\n' +
    '<h1>Free, focused coaching for <span class="grad-text">Classes 5-12</span> - online and offline.</h1>\n' +
    '<p class="lead">Welcome to ' + escapeHtml(SITE.name) + '. Led by ' + escapeHtml(SITE.owner) + ' with 12 years of teaching experience, we make education simple and interesting - with special board-exam preparation for Class 10, magical math shortcut tricks and daily practice. Join us at our ' + escapeHtml(SITE.addressLine2) + ' campus, or learn free on YouTube.</p>\n' +
    '<div class="hero-ctas">\n' +
    '<a class="btn btn-primary" href="#admission">' + icon('send', 18) + ' Apply for Admission</a>\n' +
    '<a class="btn btn-ghost" href="#courses">' + icon('book', 18) + ' Explore Courses</a>\n' +
    '</div>\n' +
    '<div class="hero-trust">\n' +
    TRUST.map(t => '<span class="trust-pill">' + icon(t.icon, 16) + ' ' + escapeHtml(t.label) + '</span>').join('\n') +
    '\n</div>\n' +
    '<p style="margin-top:22px;font-size:0.9rem"><a class="link-arrow" href="' + escapeHtml(SITE.social.youtube) + '" target="_blank" rel="noopener noreferrer">Watch free lessons on YouTube ' + icon('arrow', 16) + '</a></p>\n' +
    '</div>\n' +
    '<div class="hero-visual reveal">\n' +
    '<div class="img-frame">' + imgTag('hero') + '</div>\n' +
    '<div class="float-card fc-1">' + icon('zap', 18) + ' Magical Math Tricks</div>\n' +
    '<div class="float-card fc-2">' + icon('target', 18) + ' Board Exam Ready</div>\n' +
    '<div class="float-card fc-3">' + icon('sparkles', 18) + ' Daily Practice</div>\n' +
    '</div>\n' +
    '</div>\n</section>';
}

/* ---- About -------------------------------------------------------------------------- */
function aboutHtml() {
  return '<section class="section" id="about" aria-labelledby="about-title">\n<div class="wrap">\n' +
    '<div class="section-head reveal">\n<span class="eyebrow">' + icon('info', 14) + ' About the institute</span>\n' +
    '<h2 id="about-title">Teaching is not just a profession here - <span class="grad-text">it is a passion</span>.</h2>\n' +
    '</div>\n' +
    '<div class="about-grid">\n' +
    '<div class="reveal">\n' +
    '<p>' + escapeHtml(SITE.name) + ' is a free coaching institute in Puranaganj, Bihar, founded and led by ' + escapeHtml(SITE.owner) + '. For over twelve years he has taught students from Class 5 to Class 12 face-to-face, and has now taken the same classroom energy online so that every student - everywhere - can access the same quality of guidance without any fee.</p>\n' +
    '<blockquote class="about-quote">"Teaching is not just my profession; it is my passion." <footer>- ' + escapeHtml(SITE.owner) + ', Founder</footer></blockquote>\n' +
    '<p><span lang="hi">Mera maqsad hai education ko asaan aur interesting banana</span> - the goal is to make education easy and interesting, especially for Class 10 students preparing for their board exams. Concepts are built first, speed tricks come next, and daily practice keeps every brain sharp.</p>\n' +
    '<p><strong>Two ways to learn:</strong> attend classroom batches at our campus in ' + escapeHtml(SITE.addressFull) + ', or learn anytime on our <a class="link-arrow" href="' + escapeHtml(SITE.social.youtube) + '" target="_blank" rel="noopener noreferrer">YouTube channel</a>. Admission to both is free and open right now.</p>\n' +
    '</div>\n' +
    '<div class="reveal">\n<div class="img-frame">' + imgTag('about') + '</div>\n</div>\n' +
    '</div>\n' +
    '<div class="pillars">\n' +
    PILLARS.map(p =>
      '<div class="glass pillar reveal"><div class="pillar-icon">' + icon(p.icon, 22) + '</div><h3>' + escapeHtml(p.title) + '</h3><p>' + escapeHtml(p.text) + '</p></div>'
    ).join('\n') +
    '\n</div>\n' +
    '</div>\n</section>';
}

/* ---- Courses ------------------------------------------------------------------------- */
function courseIconFor(course) {
  if (course.id === 'math-magic') return 'zap';
  if (course.id === 'daily-practice') return 'sparkles';
  if (course.id === 'foundation-5-7') return 'book';
  if (course.id === 'class-10') return 'target';
  return 'cap';
}
function coursesHtml() {
  const cards = COURSES.map(function (c) {
    const modeBadges = c.modes.map(function (m) {
      return '<span class="badge badge-' + (m === 'online' ? 'online' : 'offline') + '">' + (m === 'online' ? 'Online' : 'Offline') + '</span>';
    }).join(' ');
    return '<article class="glass course-card reveal' + (c.featured ? ' featured' : '') + '">\n' +
      '<div class="course-top">\n<div class="course-icon">' + icon(courseIconFor(c), 24) + '</div>\n' +
      '<div><h3>' + escapeHtml(c.name) + '</h3><div class="course-tag">' + escapeHtml(c.tag) + '</div></div>\n' +
      (c.featured ? '<span class="badge badge-open" style="margin-left:auto">' + icon('star', 13) + ' Flagship</span>' : '') +
      '\n</div>\n' +
      '<p>' + escapeHtml(c.blurb) + '</p>\n' +
      '<div class="chips">' + c.subjects.map(s => '<span class="chip-subject">' + escapeHtml(s) + '</span>').join('') + '</div>\n' +
      '<div class="course-meta">\n' +
      '<div>' + icon('calendar', 16) + '<span>' + escapeHtml(c.schedule) + '</span></div>\n' +
      '<div>' + icon('clock', 16) + '<span>Duration: ' + escapeHtml(c.duration) + '</span></div>\n' +
      '<div>' + icon('monitor', 16) + '<span>' + modeBadges + '</span></div>\n' +
      '</div>\n' +
      '<div class="course-foot">\n' +
      '<div class="course-fee">' + icon('gift', 16) + ' Free<small>No fee - ever</small></div>\n' +
      '<button type="button" class="btn btn-primary btn-sm" data-apply="' + escapeHtml(c.id) + '">Apply Now</button>\n' +
      '</div>\n</article>';
  }).join('\n');
  return '<section class="section" id="courses" aria-labelledby="courses-title">\n<div class="wrap">\n' +
    '<div class="section-head reveal">\n<span class="eyebrow">' + icon('book', 14) + ' Courses & classes</span>\n' +
    '<h2 id="courses-title">Every class from <span class="grad-text">5 to 12</span> - all free.</h2>\n' +
    '<p class="lead">Pick your class and learning mode. Applying takes less than two minutes, and every course is completely free.</p>\n' +
    '</div>\n' +
    '<div class="course-grid">\n' + cards + '\n</div>\n' +
    '</div>\n</section>';
}

/* ---- Online classes ------------------------------------------------------------------- */
function onlineHtml() {
  const items = [
    ['cap', 'Class 5th to 12th guidance', 'Academic subjects explained in a simple and easy way, playlist by playlist.'],
    ['target', 'Class 10th special focus', 'In-depth concepts and exam-oriented preparation for board exams.'],
    ['zap', 'Math shortcut tricks', 'Calculator se bhi tez calculations - square roots, cube roots and multiplication "magical tricks".'],
    ['sparkles', 'Simplification & logic', 'Unique methods that solve complex problems in 10-20 seconds.'],
    ['clock', 'Regular updates', 'Daily shorts and videos to keep your brain sharp.']
  ];
  return '<section class="section" id="online" aria-labelledby="online-title">\n<div class="wrap">\n' +
    '<div class="section-head reveal">\n<span class="eyebrow">' + icon('monitor', 14) + ' Online classes</span>\n' +
    '<h2 id="online-title">Learn free on <span class="grad-text">YouTube</span> - anywhere, anytime.</h2>\n' +
    '<p class="lead">Our online classroom runs on the ' + escapeHtml(SITE.name) + ' YouTube channel. No fees, no forms - subscribe and start learning today.</p>\n' +
    '</div>\n' +
    '<div class="mode-grid">\n' +
    '<div class="reveal"><div class="img-frame">' + imgTag('online') + '</div></div>\n' +
    '<div class="reveal">\n' +
    '<h3><span lang="hi">इस चैनल पर आपको क्या मिलेगा?</span> <span class="grad-text">(What you will find)</span></h3>\n' +
    '<ul class="check-list">\n' +
    items.map(i => '<li>' + icon(i[0], 18) + '<span><strong>' + escapeHtml(i[1]) + '.</strong> ' + escapeHtml(i[2]) + '</span></li>').join('\n') +
    '\n</ul>\n' +
    '<div class="mode-actions">\n' +
    '<a class="btn btn-primary" href="' + escapeHtml(SITE.social.youtube) + '" target="_blank" rel="noopener noreferrer">' + icon('youtube', 18) + ' Visit the YouTube channel</a>\n' +
    '<a class="btn btn-ghost" href="' + escapeHtml(SITE.social.youtube) + '" target="_blank" rel="noopener noreferrer">' + icon('external', 18) + ' Subscribe + Bell</a>\n' +
    '</div>\n' +
    '<p class="form-note" style="margin-top:18px">' + icon('info', 14) + ' How to join: open the channel, press Subscribe and the bell icon, then follow the playlists for your class. If scheduled live sessions are announced in future, timings will be published here.</p>\n' +
    '</div>\n' +
    '</div>\n</div>\n</section>';
}

/* ---- Offline classes ------------------------------------------------------------------- */
function offlineHtml() {
  const items = [
    ['users', 'Classroom batches at our Puranaganj campus for Classes 5-12'],
    ['cap', 'Direct guidance from ' + escapeHtml(SITE.owner) + ' - 12+ years of offline teaching'],
    ['phone', 'Easy admission - apply online, on WhatsApp, or walk in'],
    ['pin', 'Find us easily - verified Google Maps location with directions']
  ];
  return '<section class="section" id="offline" aria-labelledby="offline-title">\n<div class="wrap">\n' +
    '<div class="section-head reveal">\n<span class="eyebrow">' + icon('pin', 14) + ' Offline classes</span>\n' +
    '<h2 id="offline-title">Classroom learning at <span class="grad-text">Puranaganj, Bihar</span>.</h2>\n' +
    '<p class="lead">Learn face-to-face at our campus with structured batches for every class. ' + escapeHtml(SITE.hoursNote) + '</p>\n' +
    '</div>\n' +
    '<div class="mode-grid flip">\n' +
    '<div class="reveal">\n' +
    '<ul class="check-list">\n' +
    items.map(i => '<li>' + icon(i[0], 18) + '<span>' + escapeHtml(i[1]) + '</span></li>').join('\n') +
    '\n</ul>\n' +
    '<div class="mode-actions">\n' +
    '<a class="btn btn-primary" href="' + escapeHtml(SITE.mapDirections) + '" target="_blank" rel="noopener noreferrer">' + icon('send', 18) + ' Get Directions</a>\n' +
    '<a class="btn btn-ghost" href="#admission">Apply for Admission</a>\n' +
    '</div>\n' +
    '<div class="glass map-card reveal">\n' +
    '<iframe class="map-frame" src="' + escapeHtml(SITE.mapEmbed) + '" title="Map showing the location of ' + escapeHtml(SITE.name) + '" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>\n' +
    '</div>\n' +
    '</div>\n' +
    '<div class="reveal"><div class="img-frame">' + imgTag('offline') + '</div></div>\n' +
    '</div>\n</div>\n</section>';
}

/* ---- Faculty --------------------------------------------------------------------------- */
function facultyHtml() {
  const cards = FACULTY.map(function (f) {
    return '<article class="glass faculty-card reveal' + (f.placeholder ? ' is-placeholder' : '') + '">\n' +
      '<div class="avatar" aria-hidden="true">' + escapeHtml(f.initials) + '</div>\n' +
      '<h3>' + escapeHtml(f.name) + '</h3>\n' +
      '<div class="faculty-role">' + escapeHtml(f.role) + '</div>\n' +
      '<div class="chips">' + f.subjects.map(s => '<span class="chip-subject">' + escapeHtml(s) + '</span>').join('') + '</div>\n' +
      '<p class="faculty-bio">' + escapeHtml(f.bio) + '</p>\n' +
      '<div class="faculty-rows">\n' +
      '<div>' + icon('cap', 15) + '<span>' + escapeHtml(f.experience) + '</span></div>\n' +
      '<div>' + icon('shield', 15) + '<span>' + escapeHtml(f.qualifications) + '</span></div>\n' +
      '</div>\n' +
      (f.placeholder
        ? '<p style="margin:14px 0 0"><span class="pending-row">' + icon('info', 14) + ' Placeholder - verified details awaited from the institute</span></p>'
        : '<p style="margin:14px 0 0"><span class="verified-row">' + icon('check', 14) + ' Details verified with the institute</span></p>') +
      '\n</article>';
  }).join('\n');
  return '<section class="section" id="faculty" aria-labelledby="faculty-title">\n<div class="wrap">\n' +
    '<div class="section-head reveal">\n<span class="eyebrow">' + icon('users', 14) + ' Faculty</span>\n' +
    '<h2 id="faculty-title">Meet your <span class="grad-text">educators</span>.</h2>\n' +
    '<p class="lead">We publish only faculty information verified with the institute. Placeholder cards below are reserved for details that are still being confirmed.</p>\n' +
    '</div>\n' +
    '<div class="faculty-grid">\n' + cards + '\n</div>\n' +
    '</div>\n</section>';
}

/* ---- Results (rendered only when verified entries exist) -------------------------------- */
function resultsHtml() {
  if (!RESULTS.length) return ''; // Hidden while empty - no fabricated achievements.
  return '<section class="section" id="results" aria-labelledby="results-title">\n<div class="wrap">\n' +
    '<div class="section-head reveal">\n<span class="eyebrow">' + icon('star', 14) + ' Results & achievements</span>\n' +
    '<h2 id="results-title">Our students <span class="grad-text">shine</span>.</h2>\n' +
    '</div>\n' +
    '<div class="faculty-grid">\n' +
    RESULTS.map(r => '<article class="glass faculty-card reveal"><h3>' + escapeHtml(r.student) + '</h3><div class="faculty-role">' + escapeHtml(r.achievement) + '</div>' + (r.quote ? '<p class="faculty-bio">"' + escapeHtml(r.quote) + '"</p>' : '') + '</article>').join('\n') +
    '\n</div>\n</div>\n</section>';
}

/* ---- FAQ --------------------------------------------------------------------------------- */
function faqHtml() {
  const items = FAQS.map(f =>
    '<details class="glass faq-item reveal">\n' +
    '<summary>' + escapeHtml(f.q) + icon('chevron', 18) + '</summary>\n' +
    '<p class="faq-a">' + escapeHtml(f.a) + '</p>\n</details>'
  ).join('\n');
  return '<section class="section" id="faq" aria-labelledby="faq-title">\n<div class="wrap">\n' +
    '<div class="section-head reveal">\n<span class="eyebrow">' + icon('message', 14) + ' FAQ</span>\n' +
    '<h2 id="faq-title">Frequently asked <span class="grad-text">questions</span>.</h2>\n' +
    '<p class="lead">Everything students and parents usually ask before joining. For anything else, WhatsApp us anytime.</p>\n' +
    '</div>\n' +
    '<div class="faq-list">\n' + items + '\n</div>\n' +
    '</div>\n</section>';
}

/* ---- Admission form ---------------------------------------------------------------------- */
function admissionHtml() {
  const courseOptions = COURSES.map(c => '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + ' - ' + escapeHtml(c.tag) + '</option>').join('');
  const classOptions = CLASS_LEVELS.map(c => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join('');
  const batchOptions = BATCH_PREFS.map(b => '<option value="' + escapeHtml(b) + '">' + escapeHtml(BATCH_LABELS[b]) + '</option>').join('');
  return '<section class="section" id="admission" aria-labelledby="admission-title">\n<div class="wrap">\n' +
    '<div class="section-head reveal">\n<span class="eyebrow">' + icon('send', 14) + ' Admission 2026-27</span>\n' +
    '<h2 id="admission-title">Apply for <span class="grad-text">free admission</span>.</h2>\n' +
    '<p class="lead">Fill this short form and you will get an application reference ID instantly. Our team contacts you to confirm your batch and timings. Admissions are open for Class 5 to Class 12 - both online and offline.</p>\n' +
    '</div>\n' +
    '<div class="glass glass-strong form-card reveal">\n' +
    '<form id="admissionForm" novalidate>\n' +
    '<div class="form-grid">\n' +
    '<div class="field"><label for="f-studentName">Student full name <span aria-hidden="true">*</span></label>' +
    '<input id="f-studentName" name="studentName" type="text" autocomplete="name" maxlength="80" required placeholder="e.g. Ayesha Siddiqui">' +
    '<p class="ferr" id="e-studentName" aria-live="polite"></p></div>\n' +
    '<div class="field"><label for="f-guardianName">Parent / guardian name <span class="opt">(optional)</span></label>' +
    '<input id="f-guardianName" name="guardianName" type="text" autocomplete="name" maxlength="80" placeholder="e.g. Md. Yusuf Rabbani">' +
    '<p class="ferr" id="e-guardianName" aria-live="polite"></p></div>\n' +
    '<div class="field"><label for="f-mobile">Student mobile number <span aria-hidden="true">*</span></label>' +
    '<input id="f-mobile" name="mobile" type="tel" inputmode="numeric" autocomplete="tel-national" maxlength="16" required placeholder="10-digit mobile number">' +
    '<p class="ferr" id="e-mobile" aria-live="polite"></p></div>\n' +
    '<div class="field"><label for="f-guardianMobile">Parent / guardian mobile <span class="opt">(optional)</span></label>' +
    '<input id="f-guardianMobile" name="guardianMobile" type="tel" inputmode="numeric" maxlength="16" placeholder="10-digit mobile number">' +
    '<p class="ferr" id="e-guardianMobile" aria-live="polite"></p></div>\n' +
    '<div class="field"><label for="f-email">Email address <span class="opt">(optional)</span></label>' +
    '<input id="f-email" name="email" type="email" autocomplete="email" maxlength="254" placeholder="you@example.com">' +
    '<p class="ferr" id="e-email" aria-live="polite"></p></div>\n' +
    '<div class="field"><label for="f-className">Current class <span aria-hidden="true">*</span></label>' +
    '<select id="f-className" name="className" required><option value="">Select class...</option>' + classOptions + '</select>' +
    '<p class="ferr" id="e-className" aria-live="polite"></p></div>\n' +
    '<div class="field full"><label for="f-courseId">Course of interest <span aria-hidden="true">*</span></label>' +
    '<select id="f-courseId" name="courseId" required><option value="">Select a course...</option>' + courseOptions + '</select>' +
    '<p class="ferr" id="e-courseId" aria-live="polite"></p></div>\n' +
    '<div class="field full"><label id="lbl-subjects">Subject preferences <span class="opt">(optional - pick any)</span></label>' +
    '<div class="subject-chips" id="subjectChips" role="group" aria-labelledby="lbl-subjects"></div>' +
    '<p class="fhint" id="hint-subjects">Choose a course first - its subjects will appear here.</p></div>\n' +
    '<div class="field full"><label id="lbl-mode">Learning mode <span aria-hidden="true">*</span></label>' +
    '<div class="radio-pills" role="radiogroup" aria-labelledby="lbl-mode">' +
    '<input type="radio" id="mode-online" name="learningMode" value="online"><label for="mode-online">' + icon('monitor', 17) + ' Online (YouTube)</label>' +
    '<input type="radio" id="mode-offline" name="learningMode" value="offline"><label for="mode-offline">' + icon('pin', 17) + ' Offline (Campus)</label>' +
    '</div><p class="ferr" id="e-learningMode" aria-live="polite"></p></div>\n' +
    '<div class="field"><label for="f-preferredBatch">Preferred batch / timing <span aria-hidden="true">*</span></label>' +
    '<select id="f-preferredBatch" name="preferredBatch" required><option value="">Select preference...</option>' + batchOptions + '</select>' +
    '<p class="fhint">Final timings are confirmed when we contact you.</p>' +
    '<p class="ferr" id="e-preferredBatch" aria-live="polite"></p></div>\n' +
    '<div class="field"><label for="f-school">Current school / institution <span class="opt">(optional)</span></label>' +
    '<input id="f-school" name="school" type="text" maxlength="120" placeholder="School name">' +
    '<p class="ferr" id="e-school" aria-live="polite"></p></div>\n' +
    '<div class="field"><label for="f-city">City / locality <span aria-hidden="true">*</span></label>' +
    '<input id="f-city" name="city" type="text" maxlength="60" autocomplete="address-level2" required placeholder="e.g. Puranaganj">' +
    '<p class="ferr" id="e-city" aria-live="polite"></p></div>\n' +
    '<div class="field"><label for="f-message">Additional message <span class="opt">(optional)</span></label>' +
    '<textarea id="f-message" name="message" maxlength="1000" placeholder="Anything you would like us to know..."></textarea>' +
    '<div class="counter"><span id="msgCount">0</span>/1000</div>' +
    '<p class="ferr" id="e-message" aria-live="polite"></p></div>\n' +
    '<div class="field full"><div class="consent-row">' +
    '<input type="checkbox" id="f-consent" name="consent" required>' +
    '<label for="f-consent">I agree to the <button type="button" class="link-arrow" id="privacyBtn" style="font:inherit;padding:0">Privacy Notice</button> and allow ' + escapeHtml(SITE.name) + ' to contact me about my admission application.</label></div>' +
    '<p class="ferr" id="e-consent" aria-live="polite"></p></div>\n' +
    '</div>\n' +
    '<div class="form-foot">\n' +
    '<button type="submit" class="btn btn-primary" id="admissionSubmit" style="min-width:230px">' + icon('send', 18) + '<span class="spin" aria-hidden="true"></span> Submit Application</button>\n' +
    '<p class="form-note">' + icon('shield', 14) + ' Submitting stores your details securely in our admission system and they are used only to contact you about admission. We never share your data.</p>\n' +
    '</div>\n' +
    '</form>\n' +
    '<div id="admissionSuccess" class="success-panel" hidden aria-live="polite" role="status">\n' +
    '<div style="width:64px;height:64px;border-radius:50%;display:grid;place-items: center;margin:0 auto 12px;background:rgba(5,150,105,.14);color:var(--ok)">' + icon('check', 30) + '</div>\n' +
    '<h3>Application received!</h3>\n' +
    '<p>Your application reference ID is:</p>\n' +
    '<div class="ref-box" id="successRef">REC-XX-00000</div>\n' +
    '<p class="form-note">Save this reference ID. Our team will contact you soon on your mobile number.' +
    ' You can also reach us directly on WhatsApp.</p>\n' +
    '<div class="success-actions">\n' +
    '<button type="button" class="btn btn-ghost btn-sm" id="copyRefBtn">' + icon('copy', 16) + ' Copy reference ID</button>\n' +
    '<a class="btn btn-primary btn-sm" id="successWaBtn" href="' + escapeHtml(waLink) + '" target="_blank" rel="noopener noreferrer">' + icon('whatsapp', 16) + ' Chat on WhatsApp</a>\n' +
    '</div>\n' +
    '</div>\n' +
    '</div>\n' +
    '</div>\n</section>';
}

/* ---- Contact ------------------------------------------------------------------------------- */
function contactHtml() {
  const cards = [
    ['phone', 'Call us', '<a href="tel:' + escapeHtml(SITE.phoneTel) + '">' + escapeHtml(SITE.phoneDisplay) + '</a>'],
    ['whatsapp', 'WhatsApp', '<a href="' + escapeHtml(waLink) + '" target="_blank" rel="noopener noreferrer">Message us anytime</a>'],
    ['mail', 'Email', '<a href="mailto:' + escapeHtml(SITE.email) + '">' + escapeHtml(SITE.email) + '</a>'],
    ['pin', 'Visit us', escapeHtml(SITE.addressFull) + ' - <a href="' + escapeHtml(SITE.mapDirections) + '" target="_blank" rel="noopener noreferrer">Get directions</a>'],
    ['clock', 'Class timings', escapeHtml(SITE.hoursNote)]
  ].map(c =>
    '<div class="glass info-card reveal"><div class="info-icon">' + icon(c[0], 20) + '</div><div><h3>' + c[1] + '</h3><p>' + c[2] + '</p></div></div>'
  ).join('\n');
  return '<section class="section" id="contact" aria-labelledby="contact-title">\n<div class="wrap">\n' +
    '<div class="section-head reveal">\n<span class="eyebrow">' + icon('phone', 14) + ' Contact</span>\n' +
    '<h2 id="contact-title">We would love to <span class="grad-text">hear from you</span>.</h2>\n' +
    '<p class="lead">Call, WhatsApp, email or visit - whichever you prefer. You can also send a quick enquiry below.</p>\n' +
    '</div>\n' +
    '<div class="contact-grid">\n' +
    '<div>\n<div class="info-cards">\n' + cards + '\n</div>\n' +
    '<div class="social-row" style="margin-top:16px">\n' +
    '<a class="social-btn sv-youtube" href="' + escapeHtml(SITE.social.youtube) + '" target="_blank" rel="noopener noreferrer" aria-label="YouTube channel">' + icon('youtube', 20) + '</a>\n' +
    '<a class="social-btn sv-facebook" href="' + escapeHtml(SITE.social.facebook) + '" target="_blank" rel="noopener noreferrer" aria-label="Facebook page">' + icon('facebook', 20) + '</a>\n' +
    '<a class="social-btn sv-instagram" href="' + escapeHtml(SITE.social.instagram) + '" target="_blank" rel="noopener noreferrer" aria-label="Instagram profile">' + icon('instagram', 20) + '</a>\n' +
    '</div>\n</div>\n' +
    '<div class="glass form-card reveal">\n' +
    '<h3 style="font-size:1.15rem">Quick enquiry</h3>\n' +
    '<form id="contactForm" novalidate>\n' +
    '<div class="form-grid" style="grid-template-columns:1fr">\n' +
    '<div class="field"><label for="c-name">Your name <span aria-hidden="true">*</span></label><input id="c-name" name="name" type="text" maxlength="80" required placeholder="Your full name"><p class="ferr" id="ce-name" aria-live="polite"></p></div>\n' +
    '<div class="field"><label for="c-mobile">Mobile number <span aria-hidden="true">*</span></label><input id="c-mobile" name="mobile" type="tel" inputmode="numeric" maxlength="16" required placeholder="10-digit mobile number"><p class="ferr" id="ce-mobile" aria-live="polite"></p></div>\n' +
    '<div class="field"><label for="c-message">Your message <span aria-hidden="true">*</span></label><textarea id="c-message" name="message" maxlength="2000" required placeholder="How can we help you?"></textarea><p class="ferr" id="ce-message" aria-live="polite"></p></div>\n' +
    '</div>\n' +
    '<div class="form-foot">\n' +
    '<button type="submit" class="btn btn-primary" id="contactSubmit">' + icon('send', 18) + '<span class="spin" aria-hidden="true"></span> Send Enquiry</button>\n' +
    '<p class="form-note">For admission, please use the admission form above - it gives you a reference ID for follow-up.</p>\n' +
    '</div>\n' +
    '</form>\n' +
    '</div>\n' +
    '</div>\n</div>\n</section>';
}

/* ---- Footer + dialogs ------------------------------------------------------------------------ */
function footerHtml() {
  return '<footer class="footer" id="footer">\n<div class="wrap">\n' +
    '<div class="glass glass-strong footer-card">\n' +
    '<div class="footer-grid">\n' +
    '<div class="footer-brand">\n' +
    '<a class="logo" href="#home"><span class="logo-mark">' + icon('cap', 24) + '</span><span class="logo-text">' + escapeHtml(SITE.name) + '<small>' + escapeHtml(SITE.tagline) + '</small></span></a>\n' +
    '<p>Free coaching for Classes 5-12, online and offline. Board-focused guidance, magical math tricks and daily practice - led by ' + escapeHtml(SITE.owner) + '.</p>\n' +
    '<div class="social-row" style="margin-top:6px">\n' +
    '<a class="social-btn sv-youtube" href="' + escapeHtml(SITE.social.youtube) + '" target="_blank" rel="noopener noreferrer" aria-label="YouTube channel">' + icon('youtube', 18) + '</a>\n' +
    '<a class="social-btn sv-facebook" href="' + escapeHtml(SITE.social.facebook) + '" target="_blank" rel="noopener noreferrer" aria-label="Facebook page">' + icon('facebook', 18) + '</a>\n' +
    '<a class="social-btn sv-instagram" href="' + escapeHtml(SITE.social.instagram) + '" target="_blank" rel="noopener noreferrer" aria-label="Instagram profile">' + icon('instagram', 18) + '</a>\n' +
    '</div>\n</div>\n' +
    '<div><h4>Quick links</h4><ul class="footer-links">' +
    '<li><a href="#about">About</a></li><li><a href="#courses">Courses</a></li><li><a href="#online">Online classes</a></li><li><a href="#offline">Offline classes</a></li><li><a href="#faculty">Faculty</a></li><li><a href="#faq">FAQ</a></li>' +
    '</ul></div>\n' +
    '<div><h4>Popular courses</h4><ul class="footer-links">' +
    '<li><a href="#courses">Class 10 Board Excellence</a></li><li><a href="#courses">Magical Math Tricks</a></li><li><a href="#courses">Foundation (Classes 5-7)</a></li><li><a href="#courses">Class 12 Board Mastery</a></li>' +
    '</ul></div>\n' +
    '<div><h4>Contact</h4><ul class="footer-links">' +
    '<li><a href="tel:' + escapeHtml(SITE.phoneTel) + '">' + escapeHtml(SITE.phoneDisplay) + '</a></li>' +
    '<li><a href="' + escapeHtml(waLink) + '" target="_blank" rel="noopener noreferrer">WhatsApp chat</a></li>' +
    '<li><a href="mailto:' + escapeHtml(SITE.email) + '">' + escapeHtml(SITE.email) + '</a></li>' +
    '<li><a href="' + escapeHtml(SITE.mapDirections) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(SITE.addressFull) + '</a></li>' +
    '</ul></div>\n' +
    '</div>\n' +
    '<div class="footer-bottom">\n' +
    '<span>&copy; <span id="yearNow">2026</span> ' + escapeHtml(SITE.name) + ' - ' + escapeHtml(SITE.tagline) + '. All courses are free.</span>\n' +
    '<span><button type="button" id="privacyBtn2">Privacy Notice</button> &middot; <button type="button" id="termsBtn">Terms of Use</button> &middot; Photos: Pexels (free license)</span>\n' +
    '</div>\n' +
    '</div>\n</div>\n</footer>';
}

function dialogsHtml() {
  return '<dialog class="rec-dialog" id="privacyDialog" aria-labelledby="privacyTitle">\n' +
    '<div class="dialog-head"><h3 id="privacyTitle">Privacy Notice</h3><button type="button" class="icon-btn" data-close-dialog aria-label="Close">' + icon('x', 18) + '</button></div>\n' +
    '<div class="dialog-body">\n' +
    '<p>This notice explains what ' + escapeHtml(SITE.name) + ' collects through this website and how it is used.</p>\n' +
    '<h4>What we collect</h4>\n' +
    '<p>The admission form collects: student name, parent/guardian name and mobile numbers, email (optional), current class, course of interest, subject preferences, learning mode, preferred batch, school (optional), city/locality and any message you write. The quick enquiry form collects your name, mobile number and message.</p>\n' +
    '<h4>Why we collect it</h4>\n' +
    '<p>Only to process your admission application or enquiry and to contact you about batches and timings. We do not use your data for advertising, profiling or selling.</p>\n' +
    '<h4>Where it is stored</h4>\n' +
    '<p>Applications are stored in a secured database hosted on MongoDB Atlas. Access is restricted to the institute administrator. This website sets no tracking or advertising cookies; the only cookie used is a secure, HttpOnly session cookie for the administrator dashboard.</p>\n' +
    '<h4>Retention & your rights</h4>\n' +
    '<p>Enquiry messages are automatically deleted after 90 days. Admission applications are kept while your admission is being processed or you are studying with us. You may ask us to show, correct or delete your data at any time by calling ' + escapeHtml(SITE.phoneDisplay) + ', emailing ' + escapeHtml(SITE.email) + ', or messaging us on WhatsApp.</p>\n' +
    '</div>\n</dialog>\n' +
    '<dialog class="rec-dialog" id="termsDialog" aria-labelledby="termsTitle">\n' +
    '<div class="dialog-head"><h3 id="termsTitle">Terms of Use</h3><button type="button" class="icon-btn" data-close-dialog aria-label="Close">' + icon('x', 18) + '</button></div>\n' +
    '<div class="dialog-body">\n' +
    '<p>By using this website you accept the terms below.</p>\n' +
    '<h4>Educational service</h4>\n' +
    '<p>' + escapeHtml(SITE.name) + ' provides free coaching for Classes 5-12 in online and offline modes. All courses are free of charge; we never ask for payment. If anyone demands payment in our name, please report it to us immediately.</p>\n' +
    '<h4>Accuracy of information</h4>\n' +
    '<p>We work to keep course and admission information accurate, but batch timings, schedules and offerings may change. Final details are always confirmed by our team at admission. Please verify important information by contacting us directly.</p>\n' +
    '<h4>Conduct</h4>\n' +
    '<p>Students and guardians are expected to behave respectfully with teachers, staff and fellow students, both at the campus and in online spaces. Online lessons on our YouTube channel are additionally governed by YouTube Terms of Service.</p>\n' +
    '<h4>Limitation</h4>\n' +
    '<p>This website is provided on an as-is basis for information and admission requests. It does not create any legal partnership or agency relationship. These terms are governed by the laws of India.</p>\n' +
    '</div>\n</dialog>';
}

/* ---- Full page assembly ------------------------------------------------------------------------ */
function renderPage(nonce) {
  return '<!DOCTYPE html>\n<html lang="en">\n' +
    headHtml(nonce) + '\n<body>\n' +
    '<a class="skip-link" href="#main">Skip to main content</a>\n' +
    '<div class="aurora" aria-hidden="true"><span></span><span></span><span></span></div>\n' +
    navHtml() + '\n' +
    '<main id="main">\n' +
    heroHtml() + '\n' + aboutHtml() + '\n' + coursesHtml() + '\n' + onlineHtml() + '\n' +
    offlineHtml() + '\n' + facultyHtml() + '\n' + resultsHtml() + '\n' + faqHtml() + '\n' +
    admissionHtml() + '\n' + contactHtml() + '\n' +
    '</main>\n' +
    footerHtml() + '\n' +
    '<a class="fab" href="' + escapeHtml(waLink) + '" target="_blank" rel="noopener noreferrer" aria-label="Chat with us on WhatsApp">' + icon('whatsapp', 26) + '</a>\n' +
    dialogsHtml() + '\n' +
    '<div class="toasts" id="toasts" aria-live="polite" aria-label="Notifications"></div>\n' +
    '<script nonce="' + nonce + '">' + APP_JS + '<\/script>\n' +
    '</body>\n</html>';
}

function render404(nonce) {
  return '<!DOCTYPE html>\n<html lang="en">\n' +
    '<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>Page not found - ' + escapeHtml(SITE.name) + '</title>\n' +
    '<meta name="robots" content="noindex">\n' +
    '<link rel="icon" type="image/svg+xml" href="' + FAVICON_DATA + '">\n' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap">\n' +
    '<style nonce="' + nonce + '">' + CSS + '</style>\n' +
    '</head>\n<body>\n' +
    '<div class="aurora" aria-hidden="true"><span></span><span></span><span></span></div>\n' +
    '<div class="nf-wrap"><div>\n' +
    '<div class="nf-code grad-text">404</div>\n' +
    '<h1 style="font-size:1.6rem">This page went to class somewhere else.</h1>\n' +
    '<p style="max-width:420px;margin-inline:auto">The address you opened does not exist on our website. Lets get you back to learning.</p>\n' +
    '<div class="hero-ctas" style="justify-content:center">\n' +
    '<a class="btn btn-primary" href="/">Back to Home</a>\n' +
    '<a class="btn btn-ghost" href="/#courses">Explore Courses</a>\n' +
    '</div>\n</div>\n</div>\n' +
    '</body>\n</html>';
}

const ROBOTS_TXT = 'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n';
function sitemapXml() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    '<url><loc>' + SITE.domain + '/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n' +
    '</urlset>\n';
}
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f46e5"/><stop offset=".55" stop-color="#7c3aed"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><path d="M50 26 L32 17 L14 26 l18 9 18-9z" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round"/><path d="M22 31v7c0 2.5 4.5 4.5 10 4.5s10-2 10-4.5v-7" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>';

/* =====================================================================================
 * SECTION 5 - BROWSER JAVASCRIPT (public site behaviour)
 * Written WITHOUT template literals or backticks so it can live inside a single
 * Node template literal. All dynamic text is inserted via textContent (never
 * innerHTML) so untrusted data can never inject markup.
 * ===================================================================================== */

const APP_JS = `
(function () {
  'use strict';
  /* ---- Course data injected from the server-side single source of truth ------------ */
  var COURSE_DATA = __COURSES_JSON__;
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- Toasts ------------------------------------------------------------------ */
  var toastsBox = document.getElementById('toasts');
  var ICONS = {
    ok: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    err: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>',
    info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>'
  };
  function toast(msg, type) {
    if (!toastsBox) return;
    var t = document.createElement('div');
    t.className = 'toast ' + (type || 'info');
    t.innerHTML = ICONS[type || 'info'] || ICONS.info;
    var span = document.createElement('span');
    span.textContent = msg;
    t.appendChild(span);
    toastsBox.appendChild(t);
    var kill = function () { if (t.parentNode) t.parentNode.removeChild(t); };
    t.addEventListener('click', kill);
    setTimeout(kill, 6000);
  }

  /* ---- Theme ------------------------------------------------------------------- */
  var themeBtn = document.getElementById('themeToggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var root = document.documentElement;
      var dark = root.getAttribute('data-theme') === 'dark';
      root.setAttribute('data-theme', dark ? 'light' : 'dark');
      try { localStorage.setItem('rec-theme', dark ? 'light' : 'dark'); } catch (e) {}
    });
  }

  /* ---- Navigation --------------------------------------------------------------- */
  var nav = document.getElementById('nav');
  var burger = document.getElementById('burger');
  function onScroll() { if (nav) nav.classList.toggle('scrolled', window.scrollY > 10); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  function closeMenu() {
    if (!nav || !nav.classList.contains('menu-open')) return;
    nav.classList.remove('menu-open');
    if (burger) burger.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }
  if (burger && nav) {
    burger.addEventListener('click', function () {
      var open = nav.classList.toggle('menu-open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.body.style.overflow = open ? 'hidden' : '';
    });
    var menu = document.getElementById('mobileMenu');
    if (menu) {
      menu.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', closeMenu); });
    }
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
  }
  /* Active section highlight in the nav */
  var navIdMap = {};
  document.querySelectorAll('.nav-links a').forEach(function (a) {
    var h = a.getAttribute('href') || '';
    if (h.charAt(0) === '#') navIdMap[h.slice(1)] = a;
  });
  if ('IntersectionObserver' in window) {
    var activeObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting && navIdMap[en.target.id]) {
          Object.keys(navIdMap).forEach(function (k) { navIdMap[k].classList.remove('active'); });
          navIdMap[en.target.id].classList.add('active');
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(navIdMap).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) activeObs.observe(el);
    });
  }

  /* ---- Scroll reveal ------------------------------------------------------------ */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  if (REDUCED || !('IntersectionObserver' in window)) {
    revealEls.forEach(function (el) { el.classList.add('in'); });
  } else {
    var revealObs = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); obs.unobserve(en.target); }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { revealObs.observe(el); });
  }

  /* ---- Image graceful fallback --------------------------------------------------- */
  document.querySelectorAll('img[data-fallback]').forEach(function (img) {
    img.addEventListener('error', function () { img.classList.add('img-failed'); });
  });

  /* ---- Dialogs ------------------------------------------------------------------- */
  function wireDialog(btnId, dialogId) {
    var btn = document.getElementById(btnId);
    var dlg = document.getElementById(dialogId);
    if (!btn || !dlg) return;
    btn.addEventListener('click', function () { if (typeof dlg.showModal === 'function') dlg.showModal(); });
    dlg.querySelectorAll('[data-close-dialog]').forEach(function (c) {
      c.addEventListener('click', function () { dlg.close(); });
    });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  }
  wireDialog('privacyBtn', 'privacyDialog');
  wireDialog('privacyBtn2', 'privacyDialog');
  wireDialog('termsBtn', 'termsDialog');

  /* ---- Footer year ---------------------------------------------------------------- */
  var yr = document.getElementById('yearNow');
  if (yr) yr.textContent = String(new Date().getFullYear());

  /* ---- Admission form --------------------------------------------------------------- */
  var form = document.getElementById('admissionForm');
  var courseSel = document.getElementById('f-courseId');
  var chipsBox = document.getElementById('subjectChips');
  var chipsHint = document.getElementById('hint-subjects');

  function courseById(id) {
    for (var i = 0; i < COURSE_DATA.length; i++) if (COURSE_DATA[i].id === id) return COURSE_DATA[i];
    return null;
  }
  function renderSubjectChips(course) {
    if (!chipsBox) return;
    chipsBox.textContent = '';
    if (!course) {
      if (chipsHint) chipsHint.hidden = false;
      return;
    }
    if (chipsHint) chipsHint.hidden = true;
    course.subjects.forEach(function (s, idx) {
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.id = 'sub-' + course.id + '-' + idx;
      input.name = 'subjects';
      input.value = s;
      var label = document.createElement('label');
      label.setAttribute('for', input.id);
      label.textContent = s;
      chipsBox.appendChild(input);
      chipsBox.appendChild(label);
    });
  }
  function syncModeToCourse(course) {
    var checked = form.querySelector('input[name="learningMode"]:checked');
    if (!course || !checked) return;
    if (course.modes.indexOf(checked.value) === -1) {
      var first = form.querySelector('input[name="learningMode"][value="' + course.modes[0] + '"]');
      if (first) first.checked = true;
      toast('This course is available ' + (course.modes.join(' and ')) + ' - learning mode updated.', 'info');
    }
  }
  function onCourseChange() {
    var course = courseById(courseSel ? courseSel.value : '');
    renderSubjectChips(course);
    syncModeToCourse(course);
  }
  if (courseSel) courseSel.addEventListener('change', onCourseChange);

  function preselectCourse(id, scrollToForm) {
    var course = courseById(id);
    if (!course || !courseSel) return;
    courseSel.value = id;
    onCourseChange();
    if (scrollToForm) {
      var target = document.getElementById('admission');
      if (target) target.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' });
      var nameInput = document.getElementById('f-studentName');
      if (nameInput) setTimeout(function () { nameInput.focus({ preventScroll: true }); }, REDUCED ? 0 : 650);
    }
  }
  document.querySelectorAll('[data-apply]').forEach(function (btn) {
    btn.addEventListener('click', function () { preselectCourse(btn.getAttribute('data-apply'), true); });
  });
  try {
    var qp = new URLSearchParams(window.location.search).get('course');
    if (qp) preselectCourse(qp, false);
  } catch (e) {}

  /* Field validation (mirrors backend rules exactly) */
  var NAME_RE = /^[\\p{L}\\p{M}][\\p{L}\\p{M}\\s.'-]{1,78}$/u;
  var EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_\`{|}~.-]{1,64}@[a-z0-9-]{1,63}(\\.[a-z0-9-]{1,63})+$/i;
  var CITY_RE = /^[\\p{L}\\p{M}][\\p{L}\\p{M}\\s.,'()/&-]{0,58}$/u;
  function normMobile(raw) {
    var d = String(raw || '').replace(/\\D/g, '');
    if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
    else if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
    return d;
  }
  function vName(raw, label) {
    var s = String(raw || '').trim();
    if (!s) return 'Please enter ' + label + '.';
    if (s.length < 3 || s.length > 80) return label + ' must be 3-80 characters long.';
    if (!NAME_RE.test(s)) return label + ' may contain letters, spaces, dots, apostrophes and hyphens only.';
    return '';
  }
  function vMobileEl(raw) {
    var d = normMobile(raw);
    if (!d) return 'Please enter a mobile number.';
    if (!/^[6-9]\\d{9}$/.test(d)) return 'Enter a valid 10-digit Indian mobile number (you may include +91).';
    return '';
  }
  function vEmailEl(raw) {
    var s = String(raw || '').trim().toLowerCase();
    if (!s) return '';
    if (s.length > 254 || !EMAIL_RE.test(s)) return 'Enter a valid email address.';
    return '';
  }
  function vCityEl(raw) {
    var s = String(raw || '').trim();
    if (!s) return 'Please enter your city or locality.';
    if (s.length < 2 || s.length > 60) return 'City / locality must be 2-60 characters.';
    if (!CITY_RE.test(s)) return 'City / locality contains characters that are not allowed.';
    return '';
  }
  function setErr(name, msg) {
    var input = form.querySelector('[name="' + name + '"]');
    var errEl = document.getElementById('e-' + name);
    if (errEl) errEl.textContent = msg || '';
    if (input && input.closest) {
      var field = input.closest('.field');
      if (field) field.classList.toggle('invalid', !!msg);
    } else if (name === 'learningMode' || name === 'subjects') {
      var box = document.getElementById('lbl-' + name) || document.getElementById('e-' + name);
      if (box && box.closest) { var f = box.closest('.field'); if (f) f.classList.toggle('invalid', !!msg); }
    }
  }
  function clearAllErrors() {
    form.querySelectorAll('.ferr').forEach(function (e) { e.textContent = ''; });
    form.querySelectorAll('.field.invalid').forEach(function (f) { f.classList.remove('invalid'); });
  }
  function validateAll() {
    var errs = {};
    var val = function (id) { var el = form.querySelector('[name="' + id + '"]'); return el ? el.value : ''; };
    var e;
    e = vName(val('studentName'), 'the student full name'); if (e) errs.studentName = e;
    e = vName(val('guardianName'), 'the parent / guardian name'); if (e && val('guardianName').trim()) errs.guardianName = e;
    e = vMobileEl(val('mobile')); if (e) errs.mobile = e;
    e = vMobileEl(val('guardianMobile')); if (e && String(val('guardianMobile')).trim()) errs.guardianMobile = e;
    e = vEmailEl(val('email')); if (e) errs.email = e;
    if (!val('className')) errs.className = 'Please select the current class.';
    if (!val('courseId') || !courseById(val('courseId'))) errs.courseId = 'Please select a valid course.';
    var mode = form.querySelector('input[name="learningMode"]:checked');
    if (!mode) errs.learningMode = 'Please choose online or offline.';
    else {
      var c = courseById(val('courseId'));
      if (c && c.modes.indexOf(mode.value) === -1) errs.learningMode = 'This course is not available in the selected mode.';
    }
    if (!val('preferredBatch')) errs.preferredBatch = 'Please select a preferred batch.';
    e = vCityEl(val('city')); if (e) errs.city = e;
    var school = String(val('school') || '').trim();
    if (school.length > 120) errs.school = 'School name must be at most 120 characters.';
    var msg = String(val('message') || '').trim();
    if (msg.length > 1000) errs.message = 'Message must be at most 1000 characters.';
    var consent = form.querySelector('[name="consent"]');
    if (!consent || !consent.checked) errs.consent = 'Please agree to the Privacy Notice to continue.';
    return errs;
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'k-' + Date.now() + '-' + String(Math.random()).slice(2, 10) + String(Math.random()).slice(2, 10);
  }
  var idemKey = uuid();

  function postJson(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) { return { status: r.status, data: data }; });
    });
  }
  function busy(btn, on, labelBusy, labelIdle) {
    if (!btn) return;
    btn.disabled = on;
    btn.classList.toggle('loading', on);
    if (labelIdle) btn.textContent = on ? labelBusy : labelIdle;
  }

  var submitBtn = document.getElementById('admissionSubmit');
  var successBox = document.getElementById('admissionSuccess');
  var successRef = document.getElementById('successRef');

  if (form && submitBtn) {
    var msgEl = form.querySelector('[name="message"]');
    var counter = document.getElementById('msgCount');
    if (msgEl && counter) {
      msgEl.addEventListener('input', function () { counter.textContent = String(msgEl.value.length); });
    }
    form.querySelectorAll('input, select, textarea').forEach(function (el) {
      el.addEventListener('input', function () {
        var name = el.name;
        if (name) setErr(name, '');
      });
      el.addEventListener('change', function () {
        var name = el.name;
        if (name) setErr(name, '');
      });
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      clearAllErrors();
      var errs = validateAll();
      var keys = Object.keys(errs);
      if (keys.length) {
        keys.forEach(function (k) { setErr(k, errs[k]); });
        toast('Please correct the highlighted fields.', 'err');
        var firstBad = form.querySelector('.field.invalid input, .field.invalid select, .field.invalid textarea');
        if (firstBad) firstBad.focus();
        return;
      }
      var subjects = [];
      form.querySelectorAll('input[name="subjects"]:checked').forEach(function (c) { subjects.push(c.value); });
      var mode = form.querySelector('input[name="learningMode"]:checked');
      var payload = {
        studentName: form.querySelector('[name="studentName"]').value.trim(),
        guardianName: form.querySelector('[name="guardianName"]').value.trim() || null,
        mobile: normMobile(form.querySelector('[name="mobile"]').value),
        guardianMobile: form.querySelector('[name="guardianMobile"]').value.trim() ? normMobile(form.querySelector('[name="guardianMobile"]').value) : null,
        email: form.querySelector('[name="email"]').value.trim() || null,
        className: form.querySelector('[name="className"]').value,
        courseId: form.querySelector('[name="courseId"]').value,
        subjects: subjects,
        learningMode: mode ? mode.value : '',
        preferredBatch: form.querySelector('[name="preferredBatch"]').value,
        school: form.querySelector('[name="school"]').value.trim() || null,
        city: form.querySelector('[name="city"]').value.trim(),
        message: form.querySelector('[name="message"]').value.trim() || null,
        consent: form.querySelector('[name="consent"]').checked,
        idempotencyKey: idemKey
      };
      busy(submitBtn, true);
      postJson('/api/admissions', payload).then(function (r) {
        if ((r.status === 200 || r.status === 201) && r.data && r.data.ok) {
          form.reset();
          renderSubjectChips(null);
          if (counter) counter.textContent = '0';
          idemKey = uuid(); // fresh key for any next submission
          if (successRef) successRef.textContent = r.data.appId || '';
          if (successBox) successBox.hidden = false;
          if (successBox) successBox.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' });
          toast('Application submitted successfully. Reference ID: ' + (r.data.appId || ''), 'ok');
          if (r.data.duplicate) toast('This submission was already recorded - showing your original reference ID.', 'info');
        } else {
          var fields = (r.data && r.data.error && r.data.error.fields) || {};
          var fkeys = Object.keys(fields);
          if (fkeys.length) {
            fkeys.forEach(function (k) { setErr(k, fields[k]); });
            toast('Please correct the highlighted fields.', 'err');
          } else {
            toast((r.data && r.data.error && r.data.error.message) || 'Submission failed. Please try again.', 'err');
          }
        }
      }).catch(function () {
        toast('Network problem - please check your connection and try again.', 'err');
      }).finally(function () {
        busy(submitBtn, false);
      });
    });
  }

  var copyBtn = document.getElementById('copyRefBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      var text = successRef ? successRef.textContent : '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('Reference ID copied.', 'ok'); }, function () { toast('Could not copy - please note it down manually.', 'info'); });
      } else {
        toast('Could not copy - please note it down manually.', 'info');
      }
    });
  }

  /* ---- Contact form ------------------------------------------------------------------ */
  var cform = document.getElementById('contactForm');
  var cbtn = document.getElementById('contactSubmit');
  if (cform && cbtn) {
    cform.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var errs = {};
      var g = function (id) { return cform.querySelector('[name="' + id + '"]'); };
      var e;
      e = vName(g('name').value, 'your name'); if (e) errs.name = e;
      e = vMobileEl(g('mobile').value); if (e) errs.mobile = e;
      var cmsg = String(g('message').value || '').trim();
      if (cmsg.length < 10) errs.message = 'Message must be at least 10 characters.';
      if (cmsg.length > 2000) errs.message = 'Message must be at most 2000 characters.';
      ['name', 'mobile', 'message'].forEach(function (k) {
        var el = document.getElementById('ce-' + k);
        if (el) el.textContent = errs[k] || '';
        var input = g(k);
        if (input && input.closest) input.closest('.field').classList.toggle('invalid', !!errs[k]);
      });
      if (Object.keys(errs).length) { toast('Please correct the highlighted fields.', 'err'); return; }
      busy(cbtn, true);
      postJson('/api/contact', { name: g('name').value.trim(), mobile: normMobile(g('mobile').value), message: cmsg }).then(function (r) {
        if ((r.status === 200 || r.status === 201) && r.data && r.data.ok) {
          cform.reset();
          toast('Enquiry sent! We will get back to you soon.', 'ok');
        } else {
          var fields = (r.data && r.data.error && r.data.error.fields) || {};
          Object.keys(fields).forEach(function (k) {
            var el = document.getElementById('ce-' + k);
            if (el) el.textContent = fields[k];
            var input = g(k);
            if (input && input.closest) input.closest('.field').classList.add('invalid');
          });
          toast((r.data && r.data.error && r.data.error.message) || 'Could not send your enquiry. Please try WhatsApp instead.', 'err');
        }
      }).catch(function () {
        toast('Network problem - please try again or message us on WhatsApp.', 'err');
      }).finally(function () { busy(cbtn, false); });
    });
  }
})();
`.replace('__COURSES_JSON__', function () {
  return JSON.stringify(COURSES.map(c => ({ id: c.id, subjects: c.subjects, modes: c.modes })));
});

/* =====================================================================================
 * SECTION 6 - PUBLIC API HANDLERS
 * All responses are JSON with a consistent envelope: { ok, ... } or
 * { ok:false, error:{ code, message, fields? } }. No stack traces, credentials or
 * database internals ever leave the server; unexpected errors are logged (redacted)
 * and answered with a generic message.
 * ===================================================================================== */

async function handleHealth(req, res) {
  const uri = process.env.MONGODB_URI;
  const configured = !!uri && /^mongodb(\+srv)?:\/\//i.test(uri);
  const db = { configured, connected: false };
  if (configured) {
    try {
      const database = await getDb();
      await database.command({ ping: 1 }, { maxTimeMS: 1500 });
      db.connected = true;
    } catch (e) { /* reported as connected:false - no internals leaked */ }
  }
  sendJson(res, 200, { ok: true, service: 'rabbani-education-circle', time: new Date().toISOString(), db });
}

function handleCourses(req, res) {
  sendJson(res, 200, {
    ok: true,
    courses: COURSES.map(c => ({
      id: c.id, name: c.name, tag: c.tag, subjects: c.subjects, blurb: c.blurb,
      modes: c.modes, schedule: c.schedule, duration: c.duration,
      fee: 'Free', admissionOpen: true
    }))
  });
}

async function handleAdmissions(req, res) {
  const db = await getDb();          // 503 (CONFIG_MISSING / DB_UNAVAILABLE) if not usable
  await ensureSchema(db);
  const body = await readJsonBody(req, BODY_LIMIT);
  await enforceRateLimit(db, 'adm', hashClient(req), ADMISSION_RATE.limit, ADMISSION_RATE.windowMs);

  const errs = {};
  const add = (k, m) => { if (!errs[k]) errs[k] = m; };

  const studentName = vName(body.studentName, 'the student full name');
  if (!studentName.ok) add('studentName', studentName.error);
  let guardianName = null;
  if (body.guardianName != null && String(body.guardianName).trim() !== '') {
    const g = vName(body.guardianName, 'the parent / guardian name');
    if (!g.ok) add('guardianName', g.error); else guardianName = g.value;
  }
  const mobile = vMobile(body.mobile);
  if (!mobile.ok) add('mobile', mobile.error);
  let guardianMobile = null;
  if (body.guardianMobile != null && String(body.guardianMobile).trim() !== '') {
    const g = vMobile(body.guardianMobile);
    if (!g.ok) add('guardianMobile', g.error); else guardianMobile = g.value;
  }
  const email = vEmail(body.email, false);
  if (!email.ok) add('email', email.error);
  const className = vEnum(body.className, CLASS_LEVELS, 'class (Class 5 to Class 12)');
  if (!className.ok) add('className', className.error);
  const courseId = body.courseId == null ? '' : String(body.courseId);
  const course = COURSE_MAP.get(courseId);
  if (!course) add('courseId', 'Please select a valid course.');
  const learningMode = vEnum(body.learningMode, LEARNING_MODES, 'learning mode');
  if (!learningMode.ok) add('learningMode', learningMode.error);
  else if (course && !course.modes.includes(learningMode.value)) add('learningMode', 'The selected course is not available in this mode.');
  const preferredBatch = vEnum(body.preferredBatch, BATCH_PREFS, 'preferred batch');
  if (!preferredBatch.ok) add('preferredBatch', preferredBatch.error);
  const city = vCity(body.city);
  if (!city.ok) add('city', city.error);
  const school = vPlainText(body.school, 'school name', 2, 120, false);
  if (!school.ok) add('school', school.error);
  const message = vPlainText(body.message, 'message', 2, 1000, false);
  if (!message.ok) add('message', message.error);
  const consent = vBoolTrue(body.consent, 'Please agree to the Privacy Notice to continue.');
  if (!consent.ok) add('consent', consent.error);

  let subjects = [];
  if (body.subjects !== undefined && body.subjects !== null) {
    if (!Array.isArray(body.subjects)) add('subjects', 'Subject preferences must be a list.');
    else {
      const cleaned = [];
      for (const s of body.subjects.slice(0, 20)) {
        const sv = String(s == null ? '' : s).trim();
        if (!sv) continue;
        if (course && !course.subjects.includes(sv)) { add('subjects', 'One of the selected subjects is not part of this course.'); break; }
        if (!cleaned.includes(sv)) cleaned.push(sv);
      }
      subjects = cleaned;
    }
  }

  let idemKey = body.idempotencyKey == null ? '' : String(body.idempotencyKey).trim();
  if (idemKey && !IDEM_RE.test(idemKey)) idemKey = '';
  if (!idemKey) idemKey = 'srv-' + crypto.randomBytes(18).toString('hex');

  if (Object.keys(errs).length) {
    throw new HttpError(400, 'VALIDATION', 'Some fields need your attention. Please correct them and submit again.', { fields: errs });
  }

  const now = new Date();
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const appId = await nextAppId(db);
    const doc = {
      appId,
      idempotencyKey: idemKey,
      studentName: studentName.value,
      guardianName,
      mobile: mobile.value,
      guardianMobile,
      email: email.value,
      className: className.value,
      courseId: course.id,
      courseName: course.name,
      subjects,
      learningMode: learningMode.value,
      preferredBatch: preferredBatch.value,
      school: school.value,
      city: city.value,
      message: message.value,
      consent: true,
      status: 'pending',          // always server-assigned, never client-controlled
      adminNotes: '',
      createdAt: now,
      updatedAt: now
    };
    try {
      await db.collection('admissions').insertOne(doc);
      return sendJson(res, 201, {
        ok: true,
        appId: doc.appId,
        status: doc.status,
        duplicate: false,
        message: 'Application received successfully. Please save your reference ID.'
      });
    } catch (e) {
      if (e && e.code === 11000) {
        const keyPattern = e.keyPattern || {};
        if (keyPattern.idempotencyKey) {
          const existing = await db.collection('admissions').findOne({ idempotencyKey: idemKey }, { projection: { appId: 1, status: 1 } });
          if (existing) {
            return sendJson(res, 200, {
              ok: true,
              appId: existing.appId,
              status: existing.status,
              duplicate: true,
              message: 'This submission was already recorded. Showing your original reference ID.'
            });
          }
        }
        if (keyPattern.appId) { lastErr = e; continue; } // sequence collision - retry with next ID
      }
      throw e;
    }
  }
  throw lastErr || new Error('insert failed');
}

async function handleContact(req, res) {
  const db = await getDb();
  await ensureSchema(db);
  const body = await readJsonBody(req, BODY_LIMIT);
  await enforceRateLimit(db, 'ctc', hashClient(req), CONTACT_RATE.limit, CONTACT_RATE.windowMs);

  const errs = {};
  const name = vName(body.name, 'your name');
  if (!name.ok) errs.name = name.error;
  const mobile = vMobile(body.mobile);
  if (!mobile.ok) errs.mobile = mobile.error;
  const message = vPlainText(body.message, 'message', 10, 2000, true);
  if (!message.ok) errs.message = message.error;

  if (Object.keys(errs).length) {
    throw new HttpError(400, 'VALIDATION', 'Some fields need your attention.', { fields: errs });
  }
  await db.collection('contact_messages').insertOne({
    name: name.value, mobile: mobile.value, message: message.value,
    status: 'new', createdAt: new Date()
  });
  sendJson(res, 201, { ok: true, message: 'Enquiry received. We will get back to you soon.' });
}

/* =====================================================================================
 * SECTION 7 - ROUTER (the exported Vercel handler)
 * ===================================================================================== */
async function handler(req, res) {
  const started = Date.now();
  let status = 500;
  try {
    const path = requestPath(req);
    const method = (req.method || 'GET').toUpperCase();

    if (path === '/favicon.ico' || path === '/favicon.svg') {
      status = 200;
      return sendText(res, 200, FAVICON_SVG, 'image/svg+xml; charset=utf-8', { 'Cache-Control': 'public, max-age=86400' });
    }
    if (path === '/robots.txt') {
      status = 200;
      return sendText(res, 200, ROBOTS_TXT, 'text/plain; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' });
    }
    if (path === '/sitemap.xml') {
      status = 200;
      return sendText(res, 200, sitemapXml(), 'application/xml; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' });
    }

    if (path === '/api/health') {
      if (method !== 'GET' && method !== 'HEAD') { status = 405; return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } }, { Allow: 'GET, HEAD' }); }
      status = 200;
      return await handleHealth(req, res);
    }
    if (path === '/api/courses') {
      if (method !== 'GET' && method !== 'HEAD') { status = 405; return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } }, { Allow: 'GET, HEAD' }); }
      status = 200;
      return handleCourses(req, res);
    }
    if (path === '/api/admissions') {
      if (method !== 'POST') { status = 405; return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST to submit an application.' } }, { Allow: 'POST' }); }
      await handleAdmissions(req, res);
      status = res.statusCode;
      return;
    }
    if (path === '/api/contact') {
      if (method !== 'POST') { status = 405; return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST to send an enquiry.' } }, { Allow: 'POST' }); }
      await handleContact(req, res);
      status = res.statusCode;
      return;
    }
    if (path.startsWith('/api/') && !path.startsWith('/api/admin')) {
      status = 404;
      return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown API endpoint.' } });
    }

    // HTML routes (admin routes are handled by admin.js on Vercel via vercel.json)
    if (path === '/' || path === '/index.html') {
      if (method !== 'GET' && method !== 'HEAD') { status = 405; return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } }, { Allow: 'GET, HEAD' }); }
      status = 200;
      const nonce = crypto.randomBytes(16).toString('base64');
      return sendHtml(res, 200, renderPage(nonce), nonce);
    }
    if (method !== 'GET' && method !== 'HEAD') { status = 405; return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } }, { Allow: 'GET, HEAD' }); }
    status = 404;
    const nonce = crypto.randomBytes(16).toString('base64');
    return sendHtml(res, 404, render404(nonce), nonce);
  } catch (e) {
    if (e instanceof HttpError) {
      status = e.status;
      const extra = e.extra && e.extra.retryAfterSec ? { 'Retry-After': String(e.extra.retryAfterSec) } : undefined;
      const payload = { ok: false, error: { code: e.code, message: e.message } };
      if (e.extra && e.extra.fields) payload.error.fields = e.extra.fields;
      return sendJson(res, e.status, payload, extra);
    }
    status = 500;
    console.error('[error]', req && req.method, req && req.url, redact(e && e.message));
    return sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again in a moment.' } });
  } finally {
    console.log('[req]', (req && req.method) || '-', req && req.url, status, (Date.now() - started) + 'ms');
  }
}

module.exports = handler;

/* =====================================================================================
 * SECTION 8 - LOCAL DEVELOPMENT HARNESS (never runs on Vercel)
 * Vercel imports this module and calls the exported handler directly. The block
 * below only executes when you run "node index.js" on your own machine, for
 * previewing and testing. It also mounts admin.js so the full app works locally.
 * ===================================================================================== */
if (require.main === module) {
  const adminHandler = require('./admin.js');
  const port = parseInt(process.env.PORT || '3000', 10);
  const server = http.createServer(async (req, res) => {
    const p = requestPath(req);
    if (p === '/admin' || p.startsWith('/api/admin') || p.startsWith('/admin/')) {
      try { await adminHandler(req, res); }
      catch (e) { console.error('[dev:admin]', redact(e && e.message)); if (!res.headersSent) { res.statusCode = 500; res.end('admin error'); } }
      return;
    }
    handler(req, res);
  });
  server.listen(port, () => {
    const dbState = process.env.MONGODB_URI ? 'MONGODB_URI set' : 'MONGODB_URI MISSING (forms will answer 503)';
    console.log('');
    console.log('  Rabbani Education Circle - local preview');
    console.log('  Site:   http://localhost:' + port + '/');
    console.log('  Admin:  http://localhost:' + port + '/admin');
    console.log('  DB:     ' + dbState);
    console.log('');
  });
}
