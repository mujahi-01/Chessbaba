import { Router } from 'express';
import crypto from 'node:crypto';

const RESULTS = ['', '1-0', '0-1', '1/2', '0-0', 'bye'];

/* Points: win 1, draw 0.5, bye 1. Tie-breaks: Buchholz, wins, rating. */
export function standings(players, rounds) {
  const P = new Map(players.map(p => [p.id, { ...p, pts: 0, w: 0, d: 0, l: 0, opp: [] }]));
  for (const rd of rounds) for (const m of rd.pairings) {
    const a = P.get(m.w), b = m.b && P.get(m.b);
    if (!a) continue;
    if (!m.b) { a.pts += 1; continue; }
    if (!b) continue;
    if (m.r === '1-0') { a.pts++; a.w++; b.l++; }
    else if (m.r === '0-1') { b.pts++; b.w++; a.l++; }
    else if (m.r === '1/2') { a.pts += 0.5; b.pts += 0.5; a.d++; b.d++; }
    else if (m.r === '0-0') { a.l++; b.l++; }
    else continue;
    a.opp.push(b.id); b.opp.push(a.id);
  }
  const list = [...P.values()];
  for (const p of list) p.bh = p.opp.reduce((s, id) => s + (P.get(id)?.pts || 0), 0);
  list.sort((x, y) => y.pts - x.pts || y.bh - x.bh || y.w - x.w || (y.elo || 0) - (x.elo || 0) || x.username.localeCompare(y.username));
  list.forEach((p, i) => { const q = list[i - 1]; p.rank = q && q.pts === p.pts && q.bh === p.bh && q.w === p.w ? q.rank : i + 1; });
  return list;
}

const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/* Quick Swiss: sort by score, avoid rematches, balance colours, one bye for the lowest player who had none.
   Round 1 pairs top half against bottom half. Always editable by hand afterwards. */
export function swiss(players, rounds, random = false) {
  const played = new Set(), bal = {}, hadBye = new Set();
  for (const rd of rounds) for (const m of rd.pairings) {
    if (!m.b) { hadBye.add(m.w); continue; }
    played.add(m.w + '|' + m.b); played.add(m.b + '|' + m.w);
    bal[m.w] = (bal[m.w] || 0) + 1; bal[m.b] = (bal[m.b] || 0) - 1;
  }
  let pool = random ? shuffle(players.map(p => p.id)) : standings(players, rounds).map(p => p.id);
  let bye = null;
  if (pool.length % 2) {
    const i = [...pool].reverse().findIndex(id => !hadBye.has(id));
    bye = pool.splice(pool.length - 1 - (i < 0 ? 0 : i), 1)[0];
  }
  const out = [];
  const pair = (a, b) => {
    const x = bal[a] || 0, y = bal[b] || 0;
    return x < y || (x === y && out.length % 2 === 0) ? { w: a, b, r: '' } : { w: b, b: a, r: '' };
  };
  if (!rounds.length && !random) {
    const half = pool.length / 2;
    for (let i = 0; i < half; i++) out.push(pair(pool[i], pool[i + half]));
  } else while (pool.length) {
    const a = pool.shift();
    let k = pool.findIndex(b => !played.has(a + '|' + b));
    if (k < 0) k = 0;
    out.push(pair(a, pool.splice(k, 1)[0]));
  }
  if (bye) out.push({ w: bye, b: null, r: 'bye' });
  return out;
}

/* Circle method: everyone plays everyone once. */
export function roundRobin(ids) {
  const a = [...ids]; if (a.length % 2) a.push(null);
  const n = a.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const boards = [];
    for (let i = 0; i < n / 2; i++) {
      let x = a[i], y = a[n - 1 - i];
      if (r % 2 && i === 0) [x, y] = [y, x];
      boards.push(x && y ? { w: x, b: y, r: '' } : { w: x || y, b: null, r: 'bye' });
    }
    rounds.push(boards);
    a.splice(1, 0, a.pop());
  }
  return rounds;
}

export default function result(c) {
  const { getDb, oid, h, bad, page, topbar, isAdmin, requireAdmin } = c;
  const r = Router();
  const T = db => db.collection('tournaments'), R = db => db.collection('registrations');
  const getT = async (db, id) => { const t = oid(id) && (await T(db).findOne({ _id: oid(id) })); if (!t) throw bad(404, 'Tournament not found'); return t; };
  const approved = async (db, t) => (await R(db).find({ tournamentId: t._id, status: 'approved' }).toArray()).map(p => ({ id: String(p._id), username: p.username, elo: p.elo }));

  /* ── public ── */
  r.get('/result/:slug', h(async (req, res) => {
    const t = await T(await getDb()).findOne({ slug: req.params.slug }, { projection: { title: 1, status: 1 } });
    const found = t && t.status !== 'draft';
    res.status(found ? 200 : 404).send(page(found ? `${t.title}: results` : 'Not found', `${topbar('<a href="/">All tournaments</a>')}<main class="wrap" id="app"></main>`, { script: resultClient }));
  }));

  r.get('/api/result/:slug', h(async (req, res) => {
    const db = await getDb(), t = await T(db).findOne({ slug: req.params.slug });
    if (!t || t.status === 'draft') throw bad(404, 'Tournament not found');
    if (t.resultsPublic === false && !isAdmin(req)) throw bad(403, 'Results are not public yet');
    const players = await approved(db, t), rounds = t.rounds || [];
    res.json({ title: t.title, slug: t.slug, status: t.status, format: t.format, prize: t.prize, players, rounds, standings: standings(players, rounds).map(({ opp, ...p }) => p) });
  }));

  /* ── admin: rounds, pairings, results ── */
  const cleanPairs = (arr, ids) => (Array.isArray(arr) ? arr : []).slice(0, 300).map(m => {
    const w = String(m?.w || ''), b = m?.b ? String(m.b) : null;
    if (!ids.has(w) || (b && !ids.has(b)) || w === b) throw bad(400, 'Invalid pairing: pick two different registered players');
    return { w, b, r: b ? (RESULTS.includes(m.r) && m.r !== 'bye' ? m.r : '') : 'bye' };
  });

  r.get('/api/admin/tournaments/:id/rounds', requireAdmin, h(async (req, res) => {
    const db = await getDb(), t = await getT(db, req.params.id), players = await approved(db, t);
    res.json({ players: players.sort((a, b) => (b.elo || 0) - (a.elo || 0)), rounds: t.rounds || [] });
  }));

  r.post('/api/admin/tournaments/:id/rounds', requireAdmin, h(async (req, res) => {
    const db = await getDb(), t = await getT(db, req.params.id), rounds = t.rounds || [], mode = req.body?.mode;
    const players = await approved(db, t);
    if (mode !== 'empty' && players.length < 2) throw bad(400, 'Approve at least 2 players first');
    let add;
    if (mode === 'roundrobin') {
      if (rounds.length) throw bad(409, 'Delete the existing rounds before generating a round robin');
      add = roundRobin(players.sort((a, b) => (b.elo || 0) - (a.elo || 0)).map(p => p.id));
    } else if (mode === 'swiss' || mode === 'random') {
      const last = rounds.at(-1);
      if (last?.pairings.some(m => m.b && !m.r)) throw bad(409, `Enter all results of round ${last.n} first`);
      add = [swiss(players, rounds, mode === 'random')];
    } else if (mode === 'empty') add = [[]];
    else throw bad(400, 'Unknown pairing mode');
    const next = [...rounds, ...add.map((pairings, i) => ({ n: rounds.length + i + 1, pairings }))];
    await T(db).updateOne({ _id: t._id }, { $set: { rounds: next } });
    res.json({ ok: true });
  }));

  r.put('/api/admin/tournaments/:id/rounds/:n', requireAdmin, h(async (req, res) => {
    const db = await getDb(), t = await getT(db, req.params.id), rounds = t.rounds || [], i = rounds.findIndex(x => x.n === Number(req.params.n));
    if (i < 0) throw bad(404, 'Round not found');
    const ids = new Set((await R(db).find({ tournamentId: t._id }, { projection: { _id: 1 } }).toArray()).map(x => String(x._id)));
    rounds[i].pairings = cleanPairs(req.body?.pairings, ids);
    await T(db).updateOne({ _id: t._id }, { $set: { rounds } });
    res.json({ ok: true });
  }));

  r.delete('/api/admin/tournaments/:id/rounds/:n', requireAdmin, h(async (req, res) => {
    const db = await getDb(), t = await getT(db, req.params.id);
    const rounds = (t.rounds || []).filter(x => x.n !== Number(req.params.n)).map((x, i) => ({ ...x, n: i + 1 }));
    await T(db).updateOne({ _id: t._id }, { $set: { rounds } });
    res.json({ ok: true });
  }));

  return r;
}

/* ───────── browser code for /result/:slug ───────── */
function resultClient() {
  const slug = decodeURIComponent(location.pathname.split('/').pop()), app = $('#app');
  let D, tab = 'standings', q = '', timer;
  const sym = { '1-0': '1 – 0', '0-1': '0 – 1', '1/2': '½ – ½', '0-0': '0 – 0', bye: 'bye', '': 'in play' };

  const body = () => {
    const P = Object.fromEntries(D.players.map(p => [p.id, p])), s = q.toLowerCase();
    const nm = id => (id ? `${esc(P[id]?.username || '?')}${P[id]?.elo ? ` <span class="mut">${P[id].elo}</span>` : ''}` : '<span class="mut">bye</span>');
    const hit = (...ids) => !s || ids.some(id => id && (P[id]?.username || '').toLowerCase().includes(s));
    if (tab === 'standings') {
      const rows = D.standings.filter(p => hit(p.id));
      return `<div class="card tw"><table><thead><tr><th>Rank</th><th>Player</th><th>Elo</th><th>Points</th><th>W</th><th>D</th><th>L</th><th>Buchholz</th></tr></thead><tbody>${rows.map(p => `<tr><td><b>${p.rank}</b></td><td>${esc(p.username)}</td><td>${p.elo ?? ''}</td><td><b>${p.pts}</b></td><td>${p.w}</td><td>${p.d}</td><td>${p.l}</td><td>${p.bh}</td></tr>`).join('') || '<tr><td colspan="8" class="mut">No players to show yet.</td></tr>'}</tbody></table></div>`;
    }
    return [...D.rounds].reverse().map(rd => `<div class="card tw"><h2>Round ${rd.n}</h2><table><thead><tr><th>Board</th><th>White</th><th>Result</th><th>Black</th></tr></thead><tbody>${rd.pairings.map((m, i) => hit(m.w, m.b) ? `<tr><td>${i + 1}</td><td>${nm(m.w)}</td><td><b>${sym[m.r] ?? ''}</b></td><td>${nm(m.b)}</td></tr>` : '').join('') || '<tr><td colspan="4" class="mut">No boards.</td></tr>'}</tbody></table></div>`).join('') || '<div class="card">Pairings have not been published yet.</div>';
  };

  function draw() {
    const top = D.status === 'finished' ? D.standings.slice(0, 3) : [];
    app.innerHTML = `<div class="row"><span class="badge b-${D.status}">${D.status}</span><span class="badge">${esc(D.format)}</span>${D.prize ? `<span class="badge">Prize: ${esc(D.prize)}</span>` : ''}</div>
      <h1 style="margin-top:12px">${esc(D.title)}</h1>
      ${top.length ? `<div class="podium">${top.map((p, i) => `<div class="pod p${i + 1}"><span class="medal">${p.rank}</span><b>${esc(p.username)}</b><span>${p.pts} points</span></div>`).join('')}</div>` : ''}
      <div class="row" style="margin:14px 0"><div class="tabs"><button class="btn sm ${tab === 'standings' ? 'on' : 'sec'}" data-t="standings">Standings</button><button class="btn sm ${tab === 'rounds' ? 'on' : 'sec'}" data-t="rounds">Rounds (${D.rounds.length})</button></div><input id="q" placeholder="Find a player" value="${esc(q)}" style="max-width:220px"></div>
      <div id="b">${body()}</div><p class="mut">${D.status === 'live' ? 'This page refreshes by itself every 30 seconds.' : ''}</p>`;
    $$('[data-t]').forEach(b => (b.onclick = () => { tab = b.dataset.t; draw(); }));
    $('#q').oninput = e => { q = e.target.value; $('#b').innerHTML = body(); };
  }

  const load = () => api('/api/result/' + encodeURIComponent(slug));
  load().then(d => {
    D = d; document.title = D.title + ' results'; draw();
    if (D.status === 'live') timer = setInterval(() => load().then(n => { D = n; $('#b').innerHTML = body(); }).catch(() => {}), 30000);
  }).catch(e => (app.innerHTML = `<div class="card"><h1>Results not available</h1><p>${esc(e.message)}</p><a class="btn" href="/">All tournaments</a></div>`));
}
