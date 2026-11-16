import { Router } from 'express';
import crypto from 'node:crypto';
import { validateEntry } from './registration.js';

const STATUS = ['draft', 'open', 'closed', 'live', 'finished'];
const FORMAT = ['swiss', 'roundrobin', 'knockout', 'arena', 'custom'];
const TYPES = ['text', 'number', 'email', 'url', 'textarea', 'select', 'checkbox'];
const REG_STATUS = ['pending', 'approved', 'waitlist', 'rejected'];

const s = (v, n) => String(v ?? '').trim().slice(0, n);
const iso = v => { const t = Date.parse(v); return v && !isNaN(t) ? new Date(t).toISOString() : ''; };
const num = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : null; };
const bad = (status, message) => Object.assign(new Error(message), { status, expose: true });

function cleanFields(arr) {
  const seen = new Set(), out = [];
  for (const f of Array.isArray(arr) ? arr : []) {
    const key = String(f.key || f.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const type = key === 'elo' ? 'number' : TYPES.includes(f.type) ? f.type : 'text';
    out.push({
      key, label: s(f.label || key, 80), type, required: key === 'username' || !!f.required, public: key === 'username' || !!f.public,
      placeholder: s(f.placeholder, 100),
      options: type === 'select' ? (Array.isArray(f.options) ? f.options : []).map(o => s(o, 60)).filter(Boolean).slice(0, 50) : [],
    });
  }
  if (!seen.has('username')) out.unshift({ key: 'username', label: 'Username', type: 'text', required: true, public: true, placeholder: '', options: [] });
  return out.slice(0, 40);
}

function clean(b = {}) {
  const title = s(b.title, 120);
  if (!title) throw bad(400, 'Title is required');
  const items = (Array.isArray(b.wheel?.items) ? b.wheel.items : []).slice(0, 24)
    .map(i => ({ label: s(i.label, 40), weight: Math.max(0, Number(i.weight) || 0), limit: num(i.limit) ?? 0 })).filter(i => i.label);
  return {
    title, slug: s(b.slug, 60), description: s(b.description, 5000), rules: s(b.rules, 8000),
    status: STATUS.includes(b.status) ? b.status : 'draft', format: FORMAT.includes(b.format) ? b.format : 'swiss',
    timeControl: s(b.timeControl, 60), platform: s(b.platform, 60), link: /^https?:\/\//i.test(b.link || '') ? s(b.link, 300) : '',
    startDate: iso(b.startDate), regOpen: iso(b.regOpen), regDeadline: iso(b.regDeadline),
    maxPlayers: num(b.maxPlayers) ?? 0, waitlist: !!b.waitlist, autoApprove: !!b.autoApprove, minElo: num(b.minElo), maxElo: num(b.maxElo),
    fee: s(b.fee, 60), prize: s(b.prize, 200), accessCode: s(b.accessCode, 40), showPlayers: !!b.showPlayers, resultsPublic: b.resultsPublic !== false,
    successMessage: s(b.successMessage, 500), closedMessage: s(b.closedMessage, 500),
    fields: cleanFields(b.fields),
    wheel: { enabled: !!b.wheel?.enabled && items.length >= 2, title: s(b.wheel?.title, 60) || 'Lucky wheel', items },
  };
}

export default function admin(c) {
  const { getDb, ObjectId, oid, slugify, h, limit, page, requireAdmin, safeEq, startSession, endSession } = c;
  const r = Router();
  const T = db => db.collection('tournaments'), R = db => db.collection('registrations');
  const getT = async (db, id) => { const t = oid(id) && (await T(db).findOne({ _id: oid(id) })); if (!t) throw bad(404, 'Tournament not found'); return t; };
  const uniq = async (db, base, self) => {
    let x = slugify(base);
    while (await T(db).findOne({ slug: x, ...(self ? { _id: { $ne: self } } : {}) }, { projection: { _id: 1 } })) x = `${slugify(base)}-${crypto.randomBytes(2).toString('hex')}`;
    return x;
  };

  r.get('/admin', (req, res) => res.send(page('Admin: Chess Tournaments', '<div id="app"></div>', { script: adminClient })));

  /* ── session ── */
  r.post('/api/admin/login', h(async (req, res) => {
    if (!process.env.ADMIN || !process.env.PASSWORD) throw bad(500, 'ADMIN and PASSWORD environment variables are not set');
    if (!limit('login:' + req.ip, 8, 10 * 60 * 1000)) throw bad(429, 'Too many attempts. Try again in a few minutes.');
    const { username = '', password = '' } = req.body || {};
    const okU = safeEq(username, process.env.ADMIN), okP = safeEq(password, process.env.PASSWORD);
    if (!(okU && okP)) throw bad(401, 'Wrong username or password');
    startSession(res); res.json({ ok: true });
  }));
  r.post('/api/admin/logout', (req, res) => { endSession(res); res.json({ ok: true }); });
  r.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

  /* ── tournaments ── */
  r.get('/api/admin/tournaments', requireAdmin, h(async (req, res) => {
    const db = await getDb();
    const [list, cnt] = await Promise.all([
      T(db).aggregate([{ $addFields: { roundCount: { $size: { $ifNull: ['$rounds', []] } } } }, { $project: { rounds: 0, fields: 0, rules: 0, description: 0 } }, { $sort: { createdAt: -1 } }]).toArray(),
      R(db).aggregate([{ $group: { _id: { t: '$tournamentId', s: '$status' }, n: { $sum: 1 } } }]).toArray(),
    ]);
    const by = {};
    for (const x of cnt) (by[x._id.t] ??= {})[x._id.s] = x.n;
    res.json({ tournaments: list.map(t => ({ ...t, counts: by[t._id] || {} })) });
  }));

  r.get('/api/admin/tournaments/:id', requireAdmin, h(async (req, res) => {
    const t = await getT(await getDb(), req.params.id); delete t.rounds; res.json(t);
  }));

  r.post('/api/admin/tournaments', requireAdmin, h(async (req, res) => {
    const db = await getDb(), d = clean(req.body);
    d.slug = await uniq(db, d.slug || d.title); d.createdAt = new Date(); d.rounds = [];
    const { insertedId } = await T(db).insertOne(d);
    res.json({ ok: true, id: String(insertedId) });
  }));

  r.put('/api/admin/tournaments/:id', requireAdmin, h(async (req, res) => {
    const db = await getDb(), t = await getT(db, req.params.id), d = clean(req.body);
    d.slug = await uniq(db, d.slug || d.title, t._id);
    await T(db).updateOne({ _id: t._id }, { $set: d });
    res.json({ ok: true });
  }));

  r.post('/api/admin/tournaments/:id/duplicate', requireAdmin, h(async (req, res) => {
    const db = await getDb(), { _id, rounds, createdAt, ...t } = await getT(db, req.params.id);
    t.title = `${t.title} (copy)`; t.slug = await uniq(db, t.title); t.status = 'draft';
    const out = await T(db).insertOne({ ...t, rounds: [], createdAt: new Date() });
    res.json({ ok: true, id: String(out.insertedId) });
  }));

  r.delete('/api/admin/tournaments/:id', requireAdmin, h(async (req, res) => {
    const db = await getDb(), t = await getT(db, req.params.id);
    await Promise.all([R(db).deleteMany({ tournamentId: t._id }), T(db).deleteOne({ _id: t._id })]);
    res.json({ ok: true });
  }));

  /* ── registrations ── */
  r.get('/api/admin/tournaments/:id/registrations', requireAdmin, h(async (req, res) => {
    const db = await getDb(), t = await getT(db, req.params.id);
    const registrations = await R(db).find({ tournamentId: t._id }, { projection: { token: 0 } }).sort({ createdAt: 1 }).toArray();
    res.json({ registrations });
  }));

  r.post('/api/admin/tournaments/:id/registrations', requireAdmin, h(async (req, res) => {
    const db = await getDb(), t = await getT(db, req.params.id), b = req.body || {};
    const e = validateEntry(t, b.data, true);
    if (await R(db).findOne({ tournamentId: t._id, usernameKey: e.usernameKey })) throw bad(409, 'This username is already registered');
    await R(db).insertOne({
      tournamentId: t._id, ...e, status: REG_STATUS.includes(b.status) ? b.status : 'approved', note: s(b.note, 500),
      paid: false, checkedIn: false, spin: null, token: crypto.randomBytes(12).toString('hex'), createdAt: new Date(),
    });
    res.json({ ok: true });
  }));

  r.patch('/api/admin/registrations/:id', requireAdmin, h(async (req, res) => {
    const db = await getDb(), reg = oid(req.params.id) && (await R(db).findOne({ _id: oid(req.params.id) }));
    if (!reg) throw bad(404, 'Registration not found');
    const b = req.body || {}, set = {};
    if (b.status) { if (!REG_STATUS.includes(b.status)) throw bad(400, 'Invalid status'); set.status = b.status; }
    if ('note' in b) set.note = s(b.note, 500);
    if ('paid' in b) set.paid = !!b.paid;
    if ('checkedIn' in b) set.checkedIn = !!b.checkedIn;
    if (b.resetSpin) set.spin = null;
    if (b.data) {
      const t = await getT(db, String(reg.tournamentId)), e = validateEntry(t, b.data, true);
      if (await R(db).findOne({ tournamentId: t._id, usernameKey: e.usernameKey, _id: { $ne: reg._id } })) throw bad(409, 'This username is already registered');
      Object.assign(set, e);
    }
    await R(db).updateOne({ _id: reg._id }, { $set: set });
    res.json({ ok: true });
  }));

  r.delete('/api/admin/registrations/:id', requireAdmin, h(async (req, res) => {
    await R(await getDb()).deleteOne({ _id: oid(req.params.id) || 0 });
    res.json({ ok: true });
  }));

  r.post('/api/admin/tournaments/:id/registrations/bulk', requireAdmin, h(async (req, res) => {
    const db = await getDb(), t = await getT(db, req.params.id), { ids = [], action } = req.body || {};
    const q = { tournamentId: t._id, _id: { $in: (Array.isArray(ids) ? ids : []).map(x => oid(x)).filter(Boolean) } };
    if (action === 'delete') await R(db).deleteMany(q);
    else if (REG_STATUS.includes(action)) await R(db).updateMany(q, { $set: { status: action } });
    else if (action === 'paid' || action === 'unpaid') await R(db).updateMany(q, { $set: { paid: action === 'paid' } });
    else throw bad(400, 'Unknown action');
    res.json({ ok: true });
  }));

  r.get('/api/admin/tournaments/:id/export.csv', requireAdmin, h(async (req, res) => {
    const db = await getDb(), t = await getT(db, req.params.id);
    const rows = await R(db).find({ tournamentId: t._id }).sort({ createdAt: 1 }).toArray();
    const cell = v => { v = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return `"${v.replace(/"/g, '""')}"`; };
    const lines = [
      ['#', 'status', 'paid', 'checked_in', 'wheel_prize', 'note', 'registered_at', ...t.fields.map(f => f.label)],
      ...rows.map((x, i) => [i + 1, x.status, x.paid ? 'yes' : 'no', x.checkedIn ? 'yes' : 'no', x.spin?.label, x.note, x.createdAt?.toISOString(), ...t.fields.map(f => x.data?.[f.key])]),
    ];
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${t.slug}-registrations.csv"` })
      .send('\ufeff' + lines.map(l => l.map(cell).join(',')).join('\r\n'));
  }));

  /* ── database tools ── */
  r.get('/api/admin/db', requireAdmin, h(async (req, res) => {
    const db = await getDb();
    const [tournaments, registrations] = await Promise.all([T(db).countDocuments(), R(db).countDocuments()]);
    const st = await db.command({ dbStats: 1 }).catch(() => ({}));
    res.json({ name: db.databaseName, tournaments, registrations, dataSize: st.dataSize, node: process.version });
  }));

  r.get('/api/admin/db/export', requireAdmin, h(async (req, res) => {
    const db = await getDb();
    const [tournaments, registrations] = await Promise.all([T(db).find().toArray(), R(db).find().toArray()]);
    res.set({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="chess-backup-${new Date().toISOString().slice(0, 10)}.json"` })
      .send(JSON.stringify({ version: 1, exportedAt: new Date(), tournaments, registrations }));
  }));

  r.post('/api/admin/db/import', requireAdmin, h(async (req, res) => {
    const { tournaments = [], registrations = [], replace = false } = req.body || {};
    if (!Array.isArray(tournaments) || !Array.isArray(registrations)) throw bad(400, 'This is not a valid backup file');
    const db = await getDb();
    const D = v => (v ? new Date(v) : new Date());
    const run = async (col, docs, fix) => {
      const ops = docs.map(d => { const _id = oid(d?._id); if (!_id) return null; const { _id: _, ...rest } = d; return { replaceOne: { filter: { _id }, replacement: fix(rest), upsert: true } }; }).filter(Boolean);
      if (ops.length) await col.bulkWrite(ops, { ordered: false });
      return ops.length;
    };
    try {
      if (replace) await Promise.all([T(db).deleteMany({}), R(db).deleteMany({})]);
      const nt = await run(T(db), tournaments, d => ({ ...d, createdAt: D(d.createdAt) }));
      const nr = await run(R(db), registrations.filter(d => oid(d?.tournamentId)), d => ({ ...d, tournamentId: oid(d.tournamentId), createdAt: D(d.createdAt) }));
      res.json({ ok: true, tournaments: nt, registrations: nr });
    } catch (e) { throw bad(409, 'Import failed: ' + e.message); }
  }));

  r.post('/api/admin/db/purge', requireAdmin, h(async (req, res) => {
    const { scope, confirm } = req.body || {};
    if (confirm !== 'DELETE') throw bad(400, 'Type DELETE to confirm');
    const db = await getDb();
    if (scope === 'results') await T(db).updateMany({}, { $set: { rounds: [] } });
    else if (scope === 'registrations') await R(db).deleteMany({});
    else if (scope === 'all') await Promise.all([T(db).deleteMany({}), R(db).deleteMany({})]);
    else throw bad(400, 'Unknown scope');
    res.json({ ok: true });
  }));

  return r;
}

/* ───────── admin panel (runs in the browser, serialised into /admin) ───────── */
function adminClient() {
  const app = $('#app');
  const FT = ['text', 'number', 'email', 'url', 'textarea', 'select', 'checkbox'];
  const ST = ['draft', 'open', 'closed', 'live', 'finished'];
  const FM = ['swiss', 'roundrobin', 'knockout', 'arena', 'custom'];
  const RS = ['pending', 'approved', 'waitlist', 'rejected'];
  const RES = [['', 'Pending'], ['1-0', '1 – 0'], ['1/2', '½ – ½'], ['0-1', '0 – 1'], ['0-0', '0 – 0 forfeit'], ['bye', 'Bye']];
  const PRE = [{ label: 'Chess.com username', type: 'text' }, { label: 'Lichess username', type: 'text' }, { label: 'FIDE ID', type: 'text' }, { label: 'Discord tag', type: 'text' }, { label: 'Real name', type: 'text' }, { label: 'I accept the rules', type: 'checkbox', required: true }];
  let ME = false, E, X, G, W = [];

  const dtl = iso => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
  const setp = (o, p, v) => { const k = p.split('.'), l = k.pop(); k.forEach(x => (o = o[x] ??= {})); o[l] = v; };
  const run = async (fn, ok) => {
    try { const v = await fn(); if (ok) toast(ok); return v; }
    catch (e) { if (e.status === 401) { ME = false; route(); } else toast(e.message, 1); }
  };
  const closeModal = () => $$('.ov').forEach(x => x.remove());
  const modal = html => {
    closeModal();
    const d = document.createElement('div'); d.className = 'ov'; d.innerHTML = `<div class="modal">${html}</div>`;
    d.addEventListener('mousedown', e => { if (e.target === d) closeModal(); });
    document.body.append(d);
  };
  const shell = inner => (app.innerHTML = `<header class="top"><a class="brand" href="#/">♞ Admin</a><nav><a href="#/">Tournaments</a><a href="#/db">Database</a><a href="/" target="_blank">Public site</a><button class="btn sec sm" data-act="logout">Log out</button></nav></header><main class="wrap wide">${inner}</main>`);

  /* login */
  const login = () => {
    app.innerHTML = `<main class="wrap" style="max-width:420px"><h1>Admin login</h1><form class="card" id="lf"><div class="fld"><label>Username</label><input name="u" autocomplete="username" required></div><div class="fld"><label>Password</label><input name="p" type="password" autocomplete="current-password" required></div><button class="btn">Log in</button></form></main>`;
    $('#lf').onsubmit = e => { e.preventDefault(); const f = e.target; run(async () => { await api('/api/admin/login', 'POST', { username: f.u.value, password: f.p.value }); ME = true; route(); }); };
  };

  /* tournaments list */
  async function list() {
    const { tournaments } = await api('/api/admin/tournaments');
    shell(`<div class="row"><h1 class="sp">Tournaments</h1><a class="btn" href="#/new">New tournament</a></div>` + (tournaments.map(t => {
      const k = t.counts, n = (k.approved || 0) + (k.pending || 0);
      return `<div class="card"><div class="row"><h2 class="sp" style="margin:0">${esc(t.title)}</h2><span class="badge b-${t.status}">${t.status}</span></div>
        <p class="mut">${esc(t.format)}${t.timeControl ? ', ' + esc(t.timeControl) : ''}${t.startDate ? ', starts ' + fmtDate(t.startDate) : ''}</p>
        <p><b>${n}</b>${t.maxPlayers ? ' of ' + t.maxPlayers : ''} registered, ${k.pending || 0} pending approval, ${k.waitlist || 0} on the waitlist, ${t.roundCount} rounds played or planned.</p>
        <div class="row"><a class="btn sm" href="#/regs/${t._id}">Registrations</a><a class="btn sm" href="#/results/${t._id}">Results</a><a class="btn sec sm" href="#/edit/${t._id}">Edit</a><button class="btn sec sm" data-act="copy" data-v="/r/${esc(t.slug)}">Copy sign-up link</button><a class="btn sec sm" target="_blank" href="/result/${esc(t.slug)}">Public results</a><button class="btn sec sm" data-act="dup" data-id="${t._id}">Duplicate</button><button class="btn red sm" data-act="del" data-id="${t._id}">Delete</button></div></div>`;
    }).join('') || '<div class="card">No tournaments yet. Create one to open registration.</div>'));
  }

  /* editor */
  const blank = () => ({
    title: '', slug: '', description: '', rules: '', status: 'draft', format: 'swiss', timeControl: '10+0', platform: 'Lichess', link: '',
    startDate: '', regOpen: '', regDeadline: '', maxPlayers: 0, waitlist: true, autoApprove: false, minElo: '', maxElo: '', fee: '', prize: '',
    accessCode: '', showPlayers: true, resultsPublic: true, successMessage: 'You are in. The organiser will share the event details with you.', closedMessage: '',
    fields: [
      { key: 'username', label: 'Username', type: 'text', required: true, public: true, placeholder: 'Your chess username', options: [] },
      { key: 'elo', label: 'Peak Elo', type: 'number', required: true, public: true, placeholder: 'Highest rating you have reached', options: [] },
      { key: 'country', label: 'Country', type: 'text', required: false, public: true, placeholder: '', options: [] },
      { key: 'email', label: 'Email', type: 'email', required: false, public: false, placeholder: '', options: [] },
    ],
    wheel: { enabled: false, title: 'Lucky wheel', items: [] },
  });

  async function edit(id) {
    E = id ? await api('/api/admin/tournaments/' + id) : blank();
    E.wheel ??= { enabled: false, title: 'Lucky wheel', items: [] };
    const t = (l, n, type = 'text', x = '') => `<div class="fld"><label>${l}</label><input type="${type}" name="${n}" value="${esc(type === 'datetime-local' ? dtl(get(E, n)) : get(E, n))}" ${x}></div>`;
    const s = (l, n, o) => `<div class="fld"><label>${l}</label><select name="${n}">${o.map(v => `<option ${get(E, n) === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`;
    const c = (l, n) => `<label class="chk"><input type="checkbox" name="${n}" ${get(E, n) ? 'checked' : ''}> ${l}</label>`;
    const a = (l, n, r = 4) => `<div class="fld"><label>${l}</label><textarea name="${n}" rows="${r}">${esc(get(E, n))}</textarea></div>`;
    shell(`<div class="row"><h1 class="sp">${id ? 'Edit' : 'New'} tournament</h1><a class="btn sec" href="#/">Cancel</a><button class="btn" data-act="save">Save tournament</button></div>
    <form id="ef" onsubmit="return false">
    <section class="card"><h2>Basics</h2><div class="grid">${t('Title', 'title')}${t('URL name (slug)', 'slug', 'text', 'placeholder="made from the title"')}${s('Status', 'status', ST)}${s('Format', 'format', FM)}${t('Time control', 'timeControl')}${t('Platform', 'platform')}${t('Event or lobby link', 'link', 'url', 'placeholder="https://"')}${t('Prize', 'prize')}${t('Entry fee', 'fee')}</div>${a('Description', 'description')}${a('Rules', 'rules', 6)}</section>
    <section class="card"><h2>Schedule and limits</h2><div class="grid">${t('Registration opens', 'regOpen', 'datetime-local')}${t('Registration closes', 'regDeadline', 'datetime-local')}${t('Tournament starts', 'startDate', 'datetime-local')}${t('Max players (0 = unlimited)', 'maxPlayers', 'number', 'min="0"')}${t('Minimum Elo', 'minElo', 'number', 'min="0"')}${t('Maximum Elo', 'maxElo', 'number', 'min="0"')}${t('Access code (optional)', 'accessCode')}</div>
    ${c('Approve players automatically (otherwise you approve each one)', 'autoApprove')}${c('Use a waitlist when the event is full', 'waitlist')}${c('Show approved players on the sign-up page', 'showPlayers')}${c('Show the results page publicly', 'resultsPublic')}</section>
    <section class="card"><h2>Sign-up form</h2><p class="mut">Choose what players fill in. Username is always required. Public fields appear in the player list.</p><div id="fields"></div><div class="row"><button type="button" class="btn sm" data-act="fadd">Add field</button><span class="mut">Quick add:</span>${PRE.map((p, i) => `<button type="button" class="btn sec sm" data-act="fpre" data-i="${i}">${p.label}</button>`).join('')}</div></section>
    <section class="card"><h2>Lucky wheel</h2><p class="mut">Each player gets one free spin after registering. Weight sets the odds. Limit caps how often a prize can be won (0 = no cap). Needs at least 2 prizes.</p>${c('Enable the lucky wheel', 'wheel.enabled')}${t('Wheel title', 'wheel.title')}<div id="wheelItems"></div><div class="row"><button type="button" class="btn sm" data-act="witem">Add prize</button><button type="button" class="btn sec sm" data-act="wsample">Load sample prizes</button><button type="button" class="btn sec sm" data-act="wprev">Preview wheel</button></div></section>
    <section class="card"><h2>Messages</h2>${a('Shown after registering', 'successMessage', 2)}${a('Shown when registration is closed', 'closedMessage', 2)}</section></form>
    <button class="btn" data-act="save">Save tournament</button>`);
    drawBuilder();
  }

  function drawBuilder() {
    $('#fields').innerHTML = E.fields.map((x, i) => `<div class="frow">
      <input data-fi="${i}" data-fk="label" value="${esc(x.label)}" placeholder="Label" aria-label="Label">
      <select data-fi="${i}" data-fk="type" aria-label="Type" ${x.key === 'elo' ? 'disabled' : ''}>${FT.map(v => `<option ${x.type === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label class="chk"><input type="checkbox" data-fi="${i}" data-fk="required" ${x.required ? 'checked' : ''} ${x.key === 'username' ? 'disabled' : ''}> required</label>
      <label class="chk"><input type="checkbox" data-fi="${i}" data-fk="public" ${x.public ? 'checked' : ''} ${x.key === 'username' ? 'disabled' : ''}> public</label>
      <input class="full" data-fi="${i}" data-fk="placeholder" value="${esc(x.placeholder)}" placeholder="Hint shown inside the field">
      ${x.type === 'select' ? `<input class="full" data-fi="${i}" data-fk="options" value="${esc(Array.isArray(x.options) ? x.options.join(', ') : x.options)}" placeholder="Options, separated by commas">` : ''}
      <div class="row full"><button type="button" class="btn sec sm" data-act="fup" data-i="${i}">Move up</button><button type="button" class="btn sec sm" data-act="fdn" data-i="${i}">Move down</button><button type="button" class="btn red sm" data-act="fdel" data-i="${i}" ${x.key === 'username' ? 'disabled' : ''}>Remove</button></div></div>`).join('');
    $('#wheelItems').innerHTML = E.wheel.items.map((x, i) => `<div class="frow" style="grid-template-columns:3fr 1fr 1fr auto"><input data-wi="${i}" data-wk="label" value="${esc(x.label)}" placeholder="Prize name" aria-label="Prize"><input data-wi="${i}" data-wk="weight" type="number" min="0" step="any" value="${esc(x.weight)}" placeholder="Weight" aria-label="Weight"><input data-wi="${i}" data-wk="limit" type="number" min="0" value="${esc(x.limit)}" placeholder="Limit" aria-label="Limit"><button type="button" class="btn red sm" data-act="wdel" data-i="${i}">Remove</button></div>`).join('') || '<p class="mut">No prizes yet.</p>';
  }

  /* registrations */
  async function regs(id) {
    const [t, l] = await Promise.all([api('/api/admin/tournaments/' + id), api(`/api/admin/tournaments/${id}/registrations`)]);
    G = { t, list: l.registrations, q: '', st: '', sel: new Set() };
    shell(`<div class="row"><h1 class="sp">${esc(t.title)}</h1><a class="btn sec" href="#/">Back</a></div>
    <div class="card"><div class="row"><input id="q" placeholder="Search players" style="max-width:240px" aria-label="Search"><select id="stf" style="max-width:170px" aria-label="Filter"><option value="">All statuses</option>${RS.map(x => `<option>${x}</option>`).join('')}</select><span class="sp"></span><button class="btn sm" data-act="radd">Add player</button><button class="btn sm" data-act="draw">Draw wheel</button><a class="btn sec sm" href="/api/admin/tournaments/${id}/export.csv">Export CSV</a></div>
    <div class="row" style="margin-top:10px"><select id="bulk" style="max-width:220px" aria-label="Bulk action"><option value="">Bulk action for selected</option><option value="approved">Approve</option><option value="waitlist">Move to waitlist</option><option value="rejected">Reject</option><option value="pending">Set to pending</option><option value="paid">Mark paid</option><option value="unpaid">Mark unpaid</option><option value="delete">Delete</option></select><button class="btn sec sm" data-act="bulk">Apply</button><span id="cnt" class="mut"></span></div></div>
    <div class="card tw"><table><thead><tr><th><input type="checkbox" data-act="selall" aria-label="Select all"></th><th>#</th><th>Username</th><th>Elo</th><th>Status</th><th>Paid</th><th>Checked in</th><th>Wheel prize</th><th>Registered</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>`);
    rows();
  }
  const view = () => { const q = G.q.toLowerCase(); return G.list.filter(x => (!G.st || x.status === G.st) && (!q || JSON.stringify(x.data).toLowerCase().includes(q))); };
  function rows() {
    const v = view();
    $('#rows').innerHTML = v.map((x, i) => `<tr><td><input type="checkbox" data-sel="${x._id}" ${G.sel.has(x._id) ? 'checked' : ''}></td><td>${i + 1}</td><td><b>${esc(x.username)}</b></td><td>${x.elo ?? ''}</td>
      <td><select data-rst="${x._id}">${RS.map(s => `<option ${x.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
      <td><input type="checkbox" data-rfl="paid" data-id="${x._id}" ${x.paid ? 'checked' : ''}></td><td><input type="checkbox" data-rfl="checkedIn" data-id="${x._id}" ${x.checkedIn ? 'checked' : ''}></td>
      <td>${esc(x.spin?.label)}</td><td>${fmtDate(x.createdAt)}</td><td><div class="row"><button class="btn sec sm" data-act="redit" data-id="${x._id}">Edit</button><button class="btn red sm" data-act="rdel" data-id="${x._id}">Delete</button></div></td></tr>`).join('') || '<tr><td colspan="10" class="mut">No players match.</td></tr>';
    $('#cnt').textContent = `${v.length} shown, ${G.sel.size} selected`;
  }
  function regForm(x) {
    const d = x?.data || {};
    modal(`<h2>${x ? 'Edit player' : 'Add player'}</h2><form id="rf" onsubmit="return false">${G.t.fields.map(f => f.type === 'checkbox'
      ? `<label class="chk"><input type="checkbox" name="${f.key}" ${d[f.key] ? 'checked' : ''}> ${esc(f.label)}</label>`
      : `<div class="fld"><label>${esc(f.label)}</label>${f.type === 'select' ? `<select name="${f.key}"><option value=""></option>${f.options.map(o => `<option ${d[f.key] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>` : f.type === 'textarea' ? `<textarea name="${f.key}">${esc(d[f.key])}</textarea>` : `<input name="${f.key}" type="${f.type}" value="${esc(d[f.key])}">`}</div>`).join('')}
      <div class="fld"><label>Status</label><select name="_status">${RS.map(s => `<option ${(x?.status || 'approved') === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="fld"><label>Admin note (private)</label><textarea name="_note" rows="2">${esc(x?.note)}</textarea></div>
      ${x?.spin ? '<label class="chk"><input type="checkbox" name="_reset"> Reset wheel spin so the player can spin again</label>' : ''}
      <div class="row"><button type="button" class="btn" data-act="rsave" data-id="${x?._id || ''}">Save player</button><button type="button" class="btn sec" data-act="close">Cancel</button></div></form>`);
  }
  function wheelModal(title, labels) {
    if (labels.length < 2) return toast('Add at least 2 entries first', 1);
    W = [...labels];
    modal(`<h2>${esc(title)}</h2><div class="wheelbox"><canvas id="dw" width="520" height="520"></canvas></div><p id="dwin" class="mut" style="text-align:center">${W.length} entries on the wheel</p><div class="row" style="justify-content:center"><button class="btn" data-act="dspin">Spin</button><button class="btn sec" data-act="close">Close</button></div>`);
    drawWheel($('#dw'), W);
  }

  /* results */
  async function results(id) {
    const [t, d] = await Promise.all([api('/api/admin/tournaments/' + id), api(`/api/admin/tournaments/${id}/rounds`)]);
    X = { t, ...d }; drawResults();
  }
  function drawResults() {
    const P = X.players, opt = (v, ph) => `<option value="">${ph}</option>` + P.map(p => `<option value="${p.id}" ${p.id === v ? 'selected' : ''}>${esc(p.username)}${p.elo ? ' (' + p.elo + ')' : ''}</option>`).join('');
    shell(`<div class="row"><h1 class="sp">Results: ${esc(X.t.title)}</h1><a class="btn sec" href="#/">Back</a><a class="btn sec" target="_blank" href="/result/${esc(X.t.slug)}">Public page</a></div>
    <div class="card"><p class="mut">${P.length} approved players. Generated pairings are a starting point: every board can be changed, and edits save as soon as you make them. Set the tournament status to Live or Finished on the edit page.</p><div class="row"><button class="btn sm" data-act="rnew" data-m="swiss">Pair next Swiss round</button><button class="btn sm" data-act="rnew" data-m="random">Random pairing round</button><button class="btn sm" data-act="rnew" data-m="roundrobin">Generate round robin</button><button class="btn sec sm" data-act="rnew" data-m="empty">Add empty round</button></div></div>`
      + (X.rounds.map((rd, ri) => {
        const cnt = {}; rd.pairings.forEach(m => [m.w, m.b].forEach(id => id && (cnt[id] = (cnt[id] || 0) + 1)));
        return `<div class="card tw"><div class="row"><h2 class="sp">Round ${rd.n}</h2><button class="btn sec sm" data-act="badd" data-ri="${ri}">Add board</button><button class="btn red sm" data-act="rdelr" data-ri="${ri}">Delete round</button></div>
          <table><thead><tr><th>Board</th><th>White</th><th>Result</th><th>Black</th><th></th></tr></thead><tbody>${rd.pairings.map((m, bi) => `<tr class="${[m.w, m.b].some(id => id && cnt[id] > 1) ? 'hl' : ''}"><td>${bi + 1}</td><td><select data-b="${ri}.${bi}.w" aria-label="White">${opt(m.w, 'Choose player')}</select></td><td><select data-b="${ri}.${bi}.r" aria-label="Result">${RES.map(([v, l]) => `<option value="${v}" ${m.r === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td><td><select data-b="${ri}.${bi}.b" aria-label="Black">${opt(m.b, 'Bye')}</select></td><td><button class="btn red sm" data-act="bdel" data-ri="${ri}" data-bi="${bi}">Remove</button></td></tr>`).join('')}</tbody></table></div>`;
      }).join('') || '<div class="card">No rounds yet. Pair the first round to begin. Highlighted rows mean a player is on two boards in the same round.</div>'));
  }
  const saveRound = ri => run(() => api(`/api/admin/tournaments/${X.t._id}/rounds/${X.rounds[ri].n}`, 'PUT', { pairings: X.rounds[ri].pairings.filter(m => m.w) }), 'Saved');

  /* database */
  async function dbv() {
    const d = await api('/api/admin/db');
    shell(`<h1>Database</h1><div class="card"><div class="grid"><div><b>${esc(d.name)}</b><br><span class="mut">database</span></div><div><b>${d.tournaments}</b><br><span class="mut">tournaments</span></div><div><b>${d.registrations}</b><br><span class="mut">registrations</span></div><div><b>${d.dataSize != null ? (d.dataSize / 1024).toFixed(1) + ' KB' : 'n/a'}</b><br><span class="mut">data size</span></div><div><b>${esc(d.node)}</b><br><span class="mut">runtime</span></div></div></div>
    <div class="card"><h2>Backup and restore</h2><p class="mut">Download every tournament and registration as JSON, or restore from an earlier backup.</p><div class="row"><a class="btn" href="/api/admin/db/export">Download backup</a><input type="file" id="imp" accept=".json,application/json" style="max-width:260px" aria-label="Backup file"><label class="chk"><input type="checkbox" id="rep"> Replace existing data</label><button class="btn sec" data-act="import">Restore backup</button></div></div>
    <div class="card"><h2>Danger zone</h2><p class="mut">These cannot be undone. Download a backup first.</p><div class="row"><button class="btn red sm" data-act="purge" data-s="results">Clear all results</button><button class="btn red sm" data-act="purge" data-s="registrations">Delete all registrations</button><button class="btn red sm" data-act="purge" data-s="all">Delete everything</button></div></div>`);
  }

  /* actions */
  const act = {
    logout: async () => { await api('/api/admin/logout', 'POST', {}); ME = false; route(); },
    copy: b => navigator.clipboard.writeText(location.origin + b.dataset.v).then(() => toast('Link copied')),
    dup: b => run(async () => { await api(`/api/admin/tournaments/${b.dataset.id}/duplicate`, 'POST', {}); list(); }, 'Duplicated as a draft'),
    del: b => confirm('Delete this tournament and all its registrations?') && run(async () => { await api('/api/admin/tournaments/' + b.dataset.id, 'DELETE'); list(); }, 'Deleted'),
    close: closeModal,
    save: () => run(async () => {
      const body = { ...E, fields: E.fields.map(f => ({ ...f, options: Array.isArray(f.options) ? f.options : String(f.options || '').split(',').map(x => x.trim()).filter(Boolean) })) };
      if (E._id) await api('/api/admin/tournaments/' + E._id, 'PUT', body); else await api('/api/admin/tournaments', 'POST', body);
      location.hash = '#/';
    }, 'Saved'),
    fadd: () => { E.fields.push({ key: '', label: 'New field', type: 'text', required: false, public: false, placeholder: '', options: [] }); drawBuilder(); },
    fpre: b => { const p = PRE[b.dataset.i]; E.fields.push({ key: '', label: p.label, type: p.type, required: !!p.required, public: false, placeholder: '', options: [] }); drawBuilder(); },
    fup: b => { const i = +b.dataset.i; if (i > 0) { [E.fields[i - 1], E.fields[i]] = [E.fields[i], E.fields[i - 1]]; drawBuilder(); } },
    fdn: b => { const i = +b.dataset.i; if (i < E.fields.length - 1) { [E.fields[i + 1], E.fields[i]] = [E.fields[i], E.fields[i + 1]]; drawBuilder(); } },
    fdel: b => { E.fields.splice(+b.dataset.i, 1); drawBuilder(); },
    witem: () => { E.wheel.items.push({ label: '', weight: 1, limit: 0 }); drawBuilder(); },
    wsample: () => { E.wheel.items = [{ label: 'Free entry', weight: 1, limit: 3 }, { label: '10% off', weight: 3, limit: 0 }, { label: 'Bonus prize', weight: 1, limit: 1 }, { label: 'Try again', weight: 5, limit: 0 }]; drawBuilder(); },
    wdel: b => { E.wheel.items.splice(+b.dataset.i, 1); drawBuilder(); },
    wprev: () => wheelModal(E.wheel.title || 'Wheel preview', E.wheel.items.map(i => i.label).filter(Boolean)),
    radd: () => regForm(null),
    redit: b => regForm(G.list.find(x => x._id === b.dataset.id)),
    rdel: b => confirm('Delete this registration?') && run(async () => { await api('/api/admin/registrations/' + b.dataset.id, 'DELETE'); G.list = G.list.filter(x => x._id !== b.dataset.id); rows(); }, 'Deleted'),
    rsave: b => {
      const fd = new FormData($('#rf')), data = {};
      G.t.fields.forEach(f => (data[f.key] = f.type === 'checkbox' ? fd.has(f.key) : fd.get(f.key)));
      const body = { data, status: fd.get('_status'), note: fd.get('_note'), resetSpin: fd.has('_reset') }, id = b.dataset.id;
      run(async () => { id ? await api('/api/admin/registrations/' + id, 'PATCH', body) : await api(`/api/admin/tournaments/${G.t._id}/registrations`, 'POST', body); closeModal(); regs(G.t._id); }, 'Saved');
    },
    selall: b => { view().forEach(x => (b.checked ? G.sel.add(x._id) : G.sel.delete(x._id))); rows(); },
    bulk: () => {
      const action = $('#bulk').value; if (!action || !G.sel.size) return toast('Select players and an action first', 1);
      if (action === 'delete' && !confirm(`Delete ${G.sel.size} registrations?`)) return;
      run(async () => { await api(`/api/admin/tournaments/${G.t._id}/registrations/bulk`, 'POST', { ids: [...G.sel], action }); regs(G.t._id); }, 'Done');
    },
    draw: () => wheelModal('Draw wheel', G.list.filter(x => x.status === 'approved').map(x => x.username)),
    dspin: async b => {
      b.disabled = true;
      const i = crypto.getRandomValues(new Uint32Array(1))[0] % W.length;
      await spinWheel($('#dw'), W, i);
      $('#dwin').innerHTML = `Winner: <b>${esc(W[i])}</b> <button class="btn sec sm" data-act="dremove" data-i="${i}">Remove and draw again</button>`;
      b.disabled = false;
    },
    dremove: b => { W.splice(+b.dataset.i, 1); if (W.length < 2) { closeModal(); return toast('Only one entry left', 1); } drawWheel($('#dw'), W); $('#dwin').textContent = `${W.length} entries on the wheel`; },
    rnew: b => run(async () => { await api(`/api/admin/tournaments/${X.t._id}/rounds`, 'POST', { mode: b.dataset.m }); results(X.t._id); }, 'Round added'),
    badd: b => { X.rounds[+b.dataset.ri].pairings.push({ w: '', b: '', r: '' }); drawResults(); },
    bdel: b => { X.rounds[+b.dataset.ri].pairings.splice(+b.dataset.bi, 1); saveRound(+b.dataset.ri); drawResults(); },
    rdelr: b => confirm('Delete this round?') && run(async () => { await api(`/api/admin/tournaments/${X.t._id}/rounds/${X.rounds[+b.dataset.ri].n}`, 'DELETE'); results(X.t._id); }, 'Round deleted'),
    import: () => {
      const f = $('#imp').files[0]; if (!f) return toast('Choose a backup file first', 1);
      if ($('#rep').checked && !confirm('Replace ALL existing data with this backup?')) return;
      run(async () => { const j = JSON.parse(await f.text()); const r = await api('/api/admin/db/import', 'POST', { ...j, replace: $('#rep').checked }); dbv(); toast(`Restored ${r.tournaments} tournaments and ${r.registrations} registrations`); });
    },
    purge: b => { if (prompt('This cannot be undone. Type DELETE to confirm.') !== 'DELETE') return; run(async () => { await api('/api/admin/db/purge', 'POST', { scope: b.dataset.s, confirm: 'DELETE' }); dbv(); }, 'Done'); },
  };
  document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b) act[b.dataset.act]?.(b); });

  const onEdit = e => {
    const el = e.target, val = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.fi) { E.fields[el.dataset.fi][el.dataset.fk] = val; if (e.type === 'change' && el.dataset.fk === 'type') drawBuilder(); }
    else if (el.dataset.wi) E.wheel.items[el.dataset.wi][el.dataset.wk] = el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : val;
    else if (el.name && $('#ef')?.contains(el)) setp(E, el.name, el.type === 'datetime-local' ? (el.value ? new Date(el.value).toISOString() : '') : val);
    else if (el.id === 'q') { G.q = el.value; rows(); }
    else if (el.id === 'stf') { G.st = el.value; rows(); }
    else if (e.type === 'change' && el.dataset.sel) { el.checked ? G.sel.add(el.dataset.sel) : G.sel.delete(el.dataset.sel); rows(); }
    else if (e.type === 'change' && el.dataset.rst) run(async () => { await api('/api/admin/registrations/' + el.dataset.rst, 'PATCH', { status: el.value }); G.list.find(x => x._id === el.dataset.rst).status = el.value; }, 'Status updated');
    else if (e.type === 'change' && el.dataset.rfl) run(async () => { await api('/api/admin/registrations/' + el.dataset.id, 'PATCH', { [el.dataset.rfl]: el.checked }); G.list.find(x => x._id === el.dataset.id)[el.dataset.rfl] = el.checked; });
    else if (e.type === 'change' && el.dataset.b) {
      const [ri, bi, k] = el.dataset.b.split('.'), m = X.rounds[ri].pairings[bi];
      m[k] = el.value;
      if (k === 'b') m.r = m.b ? (m.r === 'bye' ? '' : m.r) : 'bye';
      saveRound(+ri); drawResults();
    }
  };
  app.addEventListener('input', onEdit);
  app.addEventListener('change', onEdit);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  async function route() {
    closeModal();
    if (!ME) return login();
    const [v, id] = location.hash.slice(2).split('/');
    await run(async () => { await (v === 'new' ? edit() : v === 'edit' ? edit(id) : v === 'regs' ? regs(id) : v === 'results' ? results(id) : v === 'db' ? dbv() : list()); });
  }
  addEventListener('hashchange', route);
  api('/api/admin/me').then(() => (ME = true)).catch(() => {}).finally(route);
}
