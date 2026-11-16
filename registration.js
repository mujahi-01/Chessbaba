import { Router } from 'express';
import crypto from 'node:crypto';

const bad = (status, message) => Object.assign(new Error(message), { status, expose: true });

/* Is registration open, full, closed or not yet open? */
export function regState(t, count, now = Date.now()) {
  if (t.status !== 'open') return 'closed';
  if (t.regOpen && now < Date.parse(t.regOpen)) return 'soon';
  if (t.regDeadline && now > Date.parse(t.regDeadline)) return 'closed';
  if (t.maxPlayers && count >= t.maxPlayers) return t.waitlist ? 'waitlist' : 'full';
  return 'open';
}

/* Validate one entry against the tournament's form. `lax` (admin) skips required/rating checks. */
export function validateEntry(t, input = {}, lax = false) {
  const data = {};
  for (const f of t.fields) {
    let v = input[f.key];
    if (f.type === 'checkbox') v = v === true || v === 'true' || v === 'on';
    else v = String(v ?? '').trim().slice(0, f.type === 'textarea' ? 2000 : 300);
    if (!lax && f.required && !v) throw bad(400, `${f.label} is required`);
    if (v && f.type === 'number') { if (!isFinite(Number(v))) throw bad(400, `${f.label} must be a number`); v = Number(v); }
    if (v && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw bad(400, `${f.label} must be a valid email`);
    if (v && f.type === 'url' && !/^https?:\/\/\S+$/i.test(v)) throw bad(400, `${f.label} must be a link starting with https://`);
    if (v && f.type === 'select' && !f.options.includes(v)) throw bad(400, `Invalid choice for ${f.label}`);
    data[f.key] = v;
  }
  const username = String(data.username || '');
  if (!username) throw bad(400, 'Username is required');
  const elo = data.elo === '' || data.elo == null ? null : Number(data.elo);
  if (!lax) {
    if (elo != null && (!Number.isInteger(elo) || elo < 0 || elo > 4000)) throw bad(400, 'Enter a valid Elo rating');
    if (elo == null && (t.minElo != null || t.maxElo != null)) throw bad(400, 'Your Elo rating is required for this tournament');
    if (elo != null && t.minElo != null && elo < t.minElo) throw bad(400, `Minimum rating for this tournament is ${t.minElo}`);
    if (elo != null && t.maxElo != null && elo > t.maxElo) throw bad(400, `Maximum rating for this tournament is ${t.maxElo}`);
  }
  return { data, username, usernameKey: username.toLowerCase(), elo };
}

export default function registration(c) {
  const { getDb, oid, esc, h, limit, page, topbar, safeEq } = c;
  const r = Router();
  const open = (db, slug) => db.collection('tournaments').findOne({ slug });
  const seats = (db, t) => db.collection('registrations').countDocuments({ tournamentId: t._id, status: { $in: ['approved', 'pending'] } });

  r.get('/r/:slug', h(async (req, res) => {
    const t = await open(await getDb(), req.params.slug);
    const found = t && t.status !== 'draft';
    res.status(found ? 200 : 404).send(page(found ? `${t.title}: registration` : 'Not found',
      `${topbar('<a href="/">All tournaments</a>')}<main class="wrap" id="app"></main>`,
      { script: regClient, desc: found ? t.description?.slice(0, 150) : '' }));
  }));

  r.get('/api/t/:slug', h(async (req, res) => {
    const db = await getDb(), t = await open(db, req.params.slug);
    if (!t || t.status === 'draft') throw bad(404, 'Tournament not found');
    const count = await seats(db, t);
    res.json({
      title: t.title, slug: t.slug, description: t.description, rules: t.rules, status: t.status, format: t.format,
      timeControl: t.timeControl, platform: t.platform, link: t.link, startDate: t.startDate, regOpen: t.regOpen,
      regDeadline: t.regDeadline, maxPlayers: t.maxPlayers, minElo: t.minElo, maxElo: t.maxElo, fee: t.fee, prize: t.prize,
      needsCode: !!t.accessCode, showPlayers: t.showPlayers, resultsPublic: t.resultsPublic !== false, fields: t.fields,
      successMessage: t.successMessage, closedMessage: t.closedMessage, count, state: regState(t, count),
      wheel: t.wheel?.enabled ? { title: t.wheel.title, items: t.wheel.items.map(i => i.label) } : null,
    });
  }));

  r.get('/api/t/:slug/players', h(async (req, res) => {
    const db = await getDb(), t = await open(db, req.params.slug);
    if (!t || t.status === 'draft' || !t.showPlayers) throw bad(403, 'Player list is not public');
    const cols = t.fields.filter(f => f.public);
    const list = await db.collection('registrations').find({ tournamentId: t._id, status: 'approved' }).sort({ elo: -1, createdAt: 1 }).toArray();
    res.json({ cols: cols.map(f => f.label), rows: list.map(x => cols.map(f => (x.data?.[f.key] === true ? 'yes' : x.data?.[f.key] === false ? '' : x.data?.[f.key] ?? ''))) });
  }));

  r.post('/api/t/:slug/register', h(async (req, res) => {
    if (!limit('reg:' + req.ip, 6, 60000)) throw bad(429, 'Too many attempts. Wait a minute and try again.');
    const db = await getDb(), t = await open(db, req.params.slug), b = req.body || {};
    if (!t || t.status === 'draft') throw bad(404, 'Tournament not found');
    if (b.hp_site) return res.json({ ok: true }); // honeypot: bots fill hidden fields
    if (t.accessCode && !safeEq(String(b.code || '').trim(), t.accessCode)) throw bad(403, 'That access code is not valid');
    const R = db.collection('registrations');
    const state = regState(t, await seats(db, t));
    if (state !== 'open' && state !== 'waitlist') throw bad(403, state === 'soon' ? 'Registration has not opened yet' : t.closedMessage || 'Registration is closed');
    const e = validateEntry(t, b.data);
    if (await R.findOne({ tournamentId: t._id, usernameKey: e.usernameKey })) throw bad(409, 'This username is already registered');
    const doc = {
      tournamentId: t._id, ...e,
      status: state === 'waitlist' ? 'waitlist' : t.autoApprove ? 'approved' : 'pending',
      note: '', paid: false, checkedIn: false, spin: null,
      token: crypto.randomBytes(12).toString('hex'), createdAt: new Date(),
    };
    const { insertedId } = await R.insertOne(doc);
    res.json({ ok: true, id: String(insertedId), token: doc.token, status: doc.status });
  }));

  /* One free spin per registration. The server picks the prize, the browser only animates it. */
  r.post('/api/t/:slug/spin', h(async (req, res) => {
    const db = await getDb(), t = await open(db, req.params.slug), { id, token } = req.body || {};
    if (!t?.wheel?.enabled) throw bad(400, 'This tournament has no wheel');
    const R = db.collection('registrations');
    const reg = oid(id) && (await R.findOne({ _id: oid(id), tournamentId: t._id }));
    if (!reg || !safeEq(token || '', reg.token)) throw bad(403, 'Invalid registration');
    if (reg.spin) return res.json({ index: reg.spin.i, label: reg.spin.label, again: true });
    if (reg.status === 'rejected') throw bad(403, 'This registration was rejected');
    const used = Object.fromEntries((await R.aggregate([
      { $match: { tournamentId: t._id, spin: { $ne: null } } },
      { $group: { _id: '$spin.i', n: { $sum: 1 } } },
    ]).toArray()).map(x => [x._id, x.n]));
    const pool = t.wheel.items.map((it, i) => ({ ...it, i })).filter(it => it.weight > 0 && (!it.limit || (used[it.i] || 0) < it.limit));
    if (!pool.length) throw bad(409, 'The wheel is out of prizes');
    let x = (crypto.randomInt(0, 1e9) / 1e9) * pool.reduce((s, it) => s + it.weight, 0);
    const win = pool.find(it => (x -= it.weight) < 0) || pool.at(-1);
    const up = await R.updateOne({ _id: reg._id, spin: null }, { $set: { spin: { i: win.i, label: win.label, at: new Date() } } });
    if (!up.modifiedCount) { const r2 = await R.findOne({ _id: reg._id }); return res.json({ index: r2.spin.i, label: r2.spin.label, again: true }); }
    res.json({ index: win.i, label: win.label });
  }));

  return r;
}

/* ───────── browser code for /r/:slug (serialised into the page) ───────── */
function regClient() {
  const slug = decodeURIComponent(location.pathname.split('/').pop()), app = $('#app'), KEY = 'reg:' + slug;
  let T, mine = null;
  try { mine = JSON.parse(localStorage.getItem(KEY)); } catch {}
  const say = { open: 'Registration is open.', waitlist: 'The event is full, but you can join the waitlist.', full: 'This event is full.', closed: 'Registration is closed.', soon: 'Registration has not opened yet.' };
  const fact = (k, v) => (v ? `<div><b>${esc(v)}</b><br><span class="mut">${k}</span></div>` : '');

  const form = () => `<form class="card" id="rf"><h2>${T.state === 'waitlist' ? 'Join the waitlist' : 'Register'}</h2>
    ${T.needsCode ? '<div class="fld"><label>Access code *</label><input name="_code" required autocomplete="off"></div>' : ''}
    ${T.fields.map(f => {
      const rq = f.required ? ' required' : '', ph = ` placeholder="${esc(f.placeholder)}"`, star = f.required ? ' *' : '';
      if (f.type === 'checkbox') return `<label class="chk"><input type="checkbox" name="${f.key}"${rq}> ${esc(f.label)}${star}</label>`;
      const el = f.type === 'textarea' ? `<textarea name="${f.key}" rows="3"${rq}${ph}></textarea>`
        : f.type === 'select' ? `<select name="${f.key}"${rq}><option value="">Choose</option>${f.options.map(o => `<option>${esc(o)}</option>`).join('')}</select>`
        : `<input name="${f.key}" type="${f.type}"${rq}${ph}${f.type === 'number' ? ' step="1" min="0"' : ''}>`;
      return `<div class="fld"><label>${esc(f.label)}${star}</label>${el}</div>`;
    }).join('')}
    <input name="hp_site" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">
    <p id="err" class="err" role="alert"></p><button class="btn" id="sub">${T.state === 'waitlist' ? 'Join waitlist' : 'Register'}</button></form>`;

  const done = () => `<section class="card"><h2>${mine.status === 'approved' ? 'You are registered' : mine.status === 'waitlist' ? 'You are on the waitlist' : 'Registration received'}</h2>
    <p>${esc(T.successMessage)}</p>${mine.status === 'pending' ? '<p class="mut">Your entry is waiting for approval by the organiser.</p>' : ''}
    ${T.wheel ? `<h3>${esc(T.wheel.title)}</h3><p class="mut">You get one free spin.</p><div class="wheelbox"><canvas id="wc" width="520" height="520"></canvas></div><div class="row" style="justify-content:center"><button class="btn" id="spin">Spin the wheel</button></div><p id="wres" style="text-align:center;font-weight:700;min-height:1.5em"></p>` : ''}
    <button class="btn sec sm" id="again">Register another player</button></section>`;

  function draw() {
    const can = T.state === 'open' || T.state === 'waitlist';
    app.innerHTML = `<section class="card"><div class="row"><span class="badge b-${T.status}">${T.status}</span><span class="badge">${esc(T.format)}</span>${T.timeControl ? `<span class="badge">${esc(T.timeControl)}</span>` : ''}${T.platform ? `<span class="badge">${esc(T.platform)}</span>` : ''}</div>
      <h1 style="margin-top:12px">${esc(T.title)}</h1><p style="white-space:pre-wrap">${esc(T.description)}</p>
      <div class="grid facts">${fact('starts', T.startDate && fmtDate(T.startDate))}${fact('registration closes', T.regDeadline && fmtDate(T.regDeadline))}${fact('players', T.count + (T.maxPlayers ? ' of ' + T.maxPlayers : ''))}${fact('rating range', T.minElo != null || T.maxElo != null ? (T.minElo ?? 0) + ' to ' + (T.maxElo ?? 'any') : '')}${fact('entry fee', T.fee)}${fact('prize', T.prize)}</div>
      ${T.link ? `<p><a href="${esc(T.link)}" target="_blank" rel="noopener noreferrer">Event link</a></p>` : ''}
      ${T.rules ? `<details><summary><b>Rules</b></summary><p style="white-space:pre-wrap">${esc(T.rules)}</p></details>` : ''}</section>
      <div class="card"><span class="badge b-${can ? 'open' : 'closed'}">${can ? 'Open' : 'Closed'}</span> <b>${say[T.state]}</b>${!can && T.closedMessage ? `<br>${esc(T.closedMessage)}` : ''}</div>
      ${mine ? done() : can ? form() : ''}<section id="pl"></section>
      ${T.resultsPublic ? `<p><a class="btn sec" href="/result/${esc(T.slug)}">Standings and results</a></p>` : ''}`;

    if ($('#rf')) $('#rf').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target), data = {};
      T.fields.forEach(x => (data[x.key] = x.type === 'checkbox' ? fd.has(x.key) : fd.get(x.key)));
      $('#sub').disabled = true; $('#err').textContent = '';
      try {
        const r = await api(`/api/t/${encodeURIComponent(slug)}/register`, 'POST', { data, code: fd.get('_code'), hp_site: fd.get('hp_site') });
        mine = { id: r.id, token: r.token, status: r.status };
        try { localStorage.setItem(KEY, JSON.stringify(mine)); } catch {}
        T.count++; draw(); scrollTo(0, 0);
      } catch (er) { $('#err').textContent = er.message; $('#sub').disabled = false; }
    };
    if ($('#again')) $('#again').onclick = () => { mine = null; try { localStorage.removeItem(KEY); } catch {} draw(); };
    if ($('#wc')) {
      drawWheel($('#wc'), T.wheel.items);
      $('#spin').onclick = async b => {
        const btn = b.currentTarget; btn.disabled = true;
        try {
          const r = await api(`/api/t/${encodeURIComponent(slug)}/spin`, 'POST', { id: mine.id, token: mine.token });
          await spinWheel($('#wc'), T.wheel.items, r.index, r.again ? 1200 : 5200);
          $('#wres').textContent = (r.again ? 'Your prize: ' : 'You won: ') + r.label;
        } catch (er) { toast(er.message, 1); btn.disabled = false; }
      };
    }
    if (T.showPlayers) api(`/api/t/${encodeURIComponent(slug)}/players`).then(p => {
      $('#pl').innerHTML = `<div class="card tw"><h2>Registered players</h2><table><thead><tr><th>#</th>${p.cols.map(x => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${p.rows.map((row, i) => `<tr><td>${i + 1}</td>${row.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('') || '<tr><td class="mut">Nobody yet. Be the first.</td></tr>'}</tbody></table></div>`;
    }).catch(() => {});
  }

  api('/api/t/' + encodeURIComponent(slug)).then(d => { T = d; document.title = T.title; draw(); })
    .catch(e => (app.innerHTML = `<div class="card"><h1>Tournament not found</h1><p>${esc(e.message)}</p><a class="btn" href="/">All tournaments</a></div>`));
}
