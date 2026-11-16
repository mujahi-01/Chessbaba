import express from 'express';
import crypto from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import admin from './admin.js';
import registration from './registration.js';
import result from './result.js';

const { MONGODB_URI, ADMIN, PASSWORD } = process.env;
const g = globalThis;

/* ───────── database (connection cached across serverless calls) ───────── */
async function getDb() {
  if (!MONGODB_URI) throw Object.assign(new Error('MONGODB_URI is not set'), { status: 500, expose: true });
  g._mongo ??= new MongoClient(MONGODB_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 })
    .connect()
    .catch(e => { g._mongo = null; throw e; });
  const db = (await g._mongo).db();
  if (!g._idx) {
    g._idx = true;
    await Promise.all([
      db.collection('tournaments').createIndex({ slug: 1 }, { unique: true }),
      db.collection('registrations').createIndex({ tournamentId: 1, usernameKey: 1 }),
    ]).catch(() => { g._idx = false; });
  }
  return db;
}

/* ───────── small helpers ───────── */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = s => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'tournament';
const oid = v => { try { return ObjectId.isValid(v) && String(new ObjectId(String(v))) === String(v) ? new ObjectId(String(v)) : null; } catch { return null; } };
const bad = (status, message) => Object.assign(new Error(message), { status, expose: true });
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const hits = new Map();
const limit = (key, max, ms) => {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms);
  a.push(now); hits.set(key, a); if (hits.size > 5000) hits.clear();
  return a.length <= max;
};

/* ───────── admin session: signed HttpOnly cookie, no extra packages ───────── */
const secret = crypto.createHash('sha256').update(`${ADMIN}|${PASSWORD}|${MONGODB_URI}`).digest();
const sign = v => crypto.createHmac('sha256', secret).update(v).digest('base64url');
const safeEq = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const cookie = (req, name) => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1);
const isAdmin = req => {
  if (!ADMIN || !PASSWORD) return false;
  const [exp, sig] = (cookie(req, 'adm') || '').split('.');
  return !!(exp && sig && Number(exp) > Date.now() && safeEq(sign(exp), sig));
};
const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'Please log in' }));
const flags = `Path=/; HttpOnly; SameSite=Strict${process.env.VERCEL ? '; Secure' : ''}`;
const startSession = res => { const exp = String(Date.now() + 7 * 864e5); res.append('Set-Cookie', `adm=${exp}.${sign(exp)}; Max-Age=${7 * 86400}; ${flags}`); };
const endSession = res => res.append('Set-Cookie', `adm=; Max-Age=0; ${flags}`);

/* ───────── shared look ───────── */
const CSS = `
:root{--bg:#dde2d0;--card:#f7f8f0;--ink:#1d2719;--mut:#5f6b58;--line:#c4cbb4;--g:#5b7f3a;--g2:#46662b;--hi:#f2df5b;--red:#b23a2e;--r:10px}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 Figtree,system-ui,sans-serif}
h1,h2,h3{font-family:'Bricolage Grotesque',Figtree,sans-serif;line-height:1.15;margin:0 0 .5em;letter-spacing:-.01em}
h1{font-size:clamp(1.9rem,5vw,3rem);font-weight:800}h2{font-size:1.35rem;font-weight:700}h3{font-size:1.05rem;font-weight:700}
.strip{height:16px;background:repeating-conic-gradient(var(--g) 0 25%,#eeeed2 0 50%) 0 0/32px 32px}
.top{display:flex;align-items:center;gap:14px;padding:12px 18px;flex-wrap:wrap}
.brand{font:800 1.25rem 'Bricolage Grotesque',sans-serif;color:var(--ink);text-decoration:none}
.top nav{margin-left:auto;display:flex;gap:14px;align-items:center;flex-wrap:wrap}.top a{color:var(--ink)}
.wrap{max-width:860px;margin:0 auto;padding:10px 16px 60px}.wide{max-width:1180px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px;margin:0 0 16px}
.btn{font:inherit;font-weight:700;background:var(--g);color:#fff;border:1.5px solid var(--g);border-radius:8px;padding:9px 16px;cursor:pointer;text-decoration:none;display:inline-block}
.btn:hover{background:var(--g2)}.btn.sec{background:transparent;color:var(--ink);border-color:var(--line)}.btn.sec:hover{background:#e9ecdc}
.btn.red{background:var(--red);border-color:var(--red)}.btn.sm{padding:4px 10px;font-size:.86rem}.btn:disabled{opacity:.5;cursor:not-allowed}
:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
input,select,textarea{font:inherit;width:100%;padding:8px 10px;border:1.5px solid var(--line);border-radius:8px;background:#fff;color:var(--ink)}
input[type=checkbox]{width:auto}
label{font-weight:600;font-size:.92rem;display:block;margin-bottom:4px}
.fld{margin-bottom:14px}.chk{display:flex;gap:8px;align-items:center;font-weight:500;margin:6px 0}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}.facts{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:14px 0}
table{width:100%;border-collapse:collapse;font-size:.95rem}th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);vertical-align:middle}th{font-size:.86rem;color:var(--mut)}
.tw{overflow-x:auto}td select{min-width:130px}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;font-size:.82rem;font-weight:700;background:#e3e8d3;border:1px solid var(--line)}
.b-open,.b-approved{background:#d5ebbd;border-color:#9cc56f}.b-live{background:var(--hi);border-color:#cdbb2a}
.b-pending,.b-waitlist{background:#fbe9b7;border-color:#e3c46c}.b-rejected,.b-closed{background:#f0d0ca;border-color:#d99a90}.b-finished{background:#cfd8e8;border-color:#9fb0cf}
.mut{color:var(--mut)}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.sp{flex:1}.err{color:var(--red);font-weight:600;min-height:1.2em}
.hl{background:#fff3a8}
#toast{position:fixed;left:50%;bottom:20px;transform:translate(-50%,40px);background:var(--ink);color:#fff;padding:10px 16px;border-radius:8px;opacity:0;transition:.25s;pointer-events:none;z-index:99}
#toast.show{opacity:1;transform:translate(-50%,0)}#toast.bad{background:var(--red)}
.ov{position:fixed;inset:0;background:#0009;display:flex;align-items:flex-start;justify-content:center;padding:30px 12px;overflow:auto;z-index:50}
.modal{background:var(--card);border-radius:12px;padding:20px;width:100%;max-width:560px}
.wheelbox{position:relative;width:min(360px,100%);margin:14px auto}.wheelbox canvas{width:100%;height:auto;display:block}
.wheelbox:before{content:"";position:absolute;left:50%;top:-6px;transform:translateX(-50%);border:13px solid transparent;border-top:24px solid var(--red);border-bottom:0;z-index:2}
.frow{display:grid;grid-template-columns:2fr 1fr auto auto;gap:8px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px;background:#fff}
.frow .full{grid-column:1/-1}.frow .chk{margin:0}
@media(max-width:640px){.frow{grid-template-columns:1fr 1fr}}
.tabs{display:flex;gap:6px}.tabs .btn.on{background:var(--ink);border-color:var(--ink);color:#fff}
.podium{display:flex;gap:10px;align-items:flex-end;margin:16px 0}
.pod{flex:1;border-radius:var(--r);padding:12px;text-align:center;display:flex;flex-direction:column;border:1px solid var(--line);background:var(--card);word-break:break-word}
.p1{background:var(--hi);min-height:140px}.p2{min-height:115px}.p3{min-height:95px}.medal{font:800 1.9rem 'Bricolage Grotesque',sans-serif}
.tc{display:block;text-decoration:none;color:inherit}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;

/* browser helpers shared by every page (runs in the browser, not on the server) */
function shared() {
  window.$ = (s, e = document) => e.querySelector(s);
  window.$$ = (s, e = document) => [...e.querySelectorAll(s)];
  window.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.fmtDate = d => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  window.api = async (url, method = 'GET', body) => {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'Request failed'), { status: r.status });
    return j;
  };
  window.toast = (m, bad) => { const t = $('#toast'); t.textContent = m; t.className = 'show' + (bad ? ' bad' : ''); clearTimeout(t._t); t._t = setTimeout(() => (t.className = ''), 3300); };
  window.drawWheel = (c, items, rot = c._rot || 0) => {
    const x = c.getContext('2d'), W = c.width, R = W / 2 - 4, n = items.length, a = (2 * Math.PI) / n;
    const pal = [['#5b7f3a', '#fff'], ['#eeeed2', '#1d2719'], ['#c9a227', '#1d2719'], ['#2f4a22', '#fff'], ['#b23a2e', '#fff']];
    c._rot = rot; x.clearRect(0, 0, W, W);
    items.forEach((t, i) => {
      const [bg, fg] = pal[i % pal.length];
      x.beginPath(); x.moveTo(W / 2, W / 2); x.arc(W / 2, W / 2, R, rot + i * a, rot + (i + 1) * a); x.closePath();
      x.fillStyle = bg; x.fill(); x.strokeStyle = '#f7f8f0'; x.lineWidth = 3; x.stroke();
      x.save(); x.translate(W / 2, W / 2); x.rotate(rot + (i + 0.5) * a);
      x.textAlign = 'right'; x.textBaseline = 'middle'; x.fillStyle = fg;
      x.font = `700 ${Math.max(12, Math.min(24, 280 / n + 8))}px sans-serif`;
      const s = String(t); x.fillText(s.length > 16 ? s.slice(0, 15) + '…' : s, R - 16, 0); x.restore();
    });
    x.beginPath(); x.arc(W / 2, W / 2, 24, 0, 7); x.fillStyle = '#1d2719'; x.fill();
  };
  window.spinWheel = (c, items, idx, ms = 5200) => new Promise(done => {
    const a = (2 * Math.PI) / items.length, end0 = -Math.PI / 2 - (idx + 0.5) * a, cur = c._rot || 0;
    const end = end0 + 2 * Math.PI * (Math.ceil((cur - end0) / (2 * Math.PI)) + 6), s = performance.now();
    const f = now => {
      const p = Math.min(1, (now - s) / ms);
      drawWheel(c, items, cur + (end - cur) * (1 - Math.pow(1 - p, 4)));
      p < 1 ? requestAnimationFrame(f) : done();
    };
    requestAnimationFrame(f);
  });
  $$('time[data-d]').forEach(t => (t.textContent = fmtDate(t.dataset.d)));
}

const page = (title, body, { script, desc = '' } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700;800&family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet"><style>${CSS}</style></head><body><div class="strip"></div>${body}<div id="toast"></div><script>(${shared})()</script>${script ? `<script>(${script})()</script>` : ''}</body></html>`;
const topbar = (nav = '') => `<header class="top"><a class="brand" href="/">♞ Chess Tournaments</a><nav>${nav}</nav></header>`;

/* ───────── app ───────── */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '4mb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  next();
});

const ctx = { getDb, ObjectId, oid, esc, slugify, h, bad, limit, page, topbar, isAdmin, requireAdmin, safeEq, startSession, endSession };

app.get('/', h(async (req, res) => {
  const db = await getDb();
  const ts = await db.collection('tournaments').find({ status: { $ne: 'draft' } }).sort({ createdAt: -1 }).toArray();
  const counts = Object.fromEntries((await db.collection('registrations').aggregate([
    { $match: { tournamentId: { $in: ts.map(t => t._id) }, status: { $in: ['approved', 'pending'] } } },
    { $group: { _id: '$tournamentId', n: { $sum: 1 } } },
  ]).toArray()).map(x => [String(x._id), x.n]));
  const label = { open: 'Registration open', closed: 'Registration closed', live: 'Live now', finished: 'Finished' };
  const cards = ts.map(t => `<div class="card"><div class="row"><span class="badge b-${esc(t.status)}">${label[t.status] || esc(t.status)}</span><span class="badge">${esc(t.format)}</span>${t.timeControl ? `<span class="badge">${esc(t.timeControl)}</span>` : ''}</div>
    <h2 style="margin-top:10px">${esc(t.title)}</h2>
    <p class="mut">${t.startDate ? `Starts <time data-d="${esc(t.startDate)}"></time>. ` : ''}${counts[String(t._id)] || 0}${t.maxPlayers ? ' of ' + t.maxPlayers : ''} players registered.${t.prize ? ' Prize: ' + esc(t.prize) + '.' : ''}</p>
    <div class="row">${t.status === 'open' ? `<a class="btn" href="/r/${esc(t.slug)}">Register</a>` : `<a class="btn sec" href="/r/${esc(t.slug)}">Details</a>`}${t.resultsPublic !== false && ['live', 'finished'].includes(t.status) ? `<a class="btn" href="/result/${esc(t.slug)}">Results</a>` : ''}</div></div>`).join('');
  res.send(page('Chess Tournaments', `${topbar()}<main class="wrap"><h1>Pick a tournament, take a seat.</h1><p class="mut">Register in a minute, then follow pairings and standings as the rounds are played.</p>${cards || '<div class="card">No tournaments are open right now. Check back soon.</div>'}</main>`, { desc: 'Chess tournament registration and results' }));
}));

app.use(admin(ctx));
app.use(registration(ctx));
app.use(result(ctx));

app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.status(404).send(page('Not found', `${topbar()}<main class="wrap"><div class="card"><h1>Page not found</h1><a class="btn" href="/">All tournaments</a></div></main>`));
});

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500, msg = err.expose ? err.message : 'Something went wrong. Please try again.';
  if (req.path.startsWith('/api')) return res.status(status).json({ error: msg });
  res.status(status).send(page('Error', `${topbar()}<main class="wrap"><div class="card"><h1>Something went wrong</h1><p>${esc(msg)}</p><a class="btn" href="/">Back home</a></div></main>`));
});

if (!process.env.VERCEL) app.listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000)));

export default app;
