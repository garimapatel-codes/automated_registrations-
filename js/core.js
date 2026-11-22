/*
 * core.js — pure logic: CSV parsing, column detection, phone/ID normalising, payment matching,
 * the "who may be invited" rules and the sent-once ledger rules. No DOM, no network.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./statement.js'));
  else root.Core = factory(root.Statement);
})(typeof self !== 'undefined' ? self : this, function (Statement) {
  'use strict';

  // ---------- CSV ----------
  function detectDelimiter(text) {
    const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 8);
    let best = ',', bestScore = -1;
    for (const d of [',', ';', '\t']) {
      let score = 0;
      for (const line of lines) { let q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === d && !q) score++; } }
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }
  /** CSV text -> array of rows. Quotes, embedded newlines, BOM and ; or tab delimiters are handled. */
  function parseCSV(text) {
    if (!text) return [];
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const delim = detectDelimiter(text);
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; }
      else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  const blank = (r) => !r || r.every((c) => String(c).trim() === '');

  /** rows -> {headers, rows:[{rowNo, cells}]} (blank rows dropped, rowNo matches the spreadsheet line). */
  function toTable(rows) {
    let h = 0; while (h < rows.length && blank(rows[h])) h++;
    if (h >= rows.length) return { headers: [], rows: [] };
    const headers = rows[h].map((x) => String(x).replace(/\s+/g, ' ').trim());
    const out = [];
    for (let i = h + 1; i < rows.length; i++) if (!blank(rows[i])) out.push({ rowNo: i + 1, cells: rows[i].map((c) => String(c).trim()) });
    return { headers, rows: out };
  }

  // ---------- columns ----------
  const pick = (hs, re, not) => { const i = hs.findIndex((h) => re.test(h) && !(not && not.test(h))); return i >= 0 ? i : -1; };
  function guessColumns(hs) {
    const members = [];
    hs.forEach((h, i) => { if (/member\s*\d+\s*:?\s*name/i.test(h)) members.push(i); });
    return {
      ts: pick(hs, /^timestamp|submitted|submission/i),
      email: pick(hs, /^e-?mail( address)?$/i),
      institution: pick(hs, /institution|college|university|organi[sz]ation/i, /city/i),
      city: pick(hs, /city|town/i),
      team: pick(hs, /^team name|team\s*name/i),
      leader: pick(hs, /member\s*1.*name|team leader.*name|leader.*name/i),
      phone: pick(hs, /(member\s*1|leader).*(whats?app|phone|mobile|contact)/i),
      leaderEmail: pick(hs, /(member\s*1|leader).*e-?mail/i),
      members,
      mentorName: pick(hs, /(mentor|faculty|guide).*name/i),
      mentorPhone: pick(hs, /(mentor|faculty|guide).*(whats?app|phone|mobile|contact)/i),
      txn: pick(hs, /transaction\s*id|\butr\b|txn|upi.*ref|payment.*ref/i),
      proof: pick(hs, /payment.*proof|screenshot|receipt/i),
    };
  }
  const REQUIRED = [['leader', 'team leader name'], ['phone', 'team leader WhatsApp number'], ['txn', 'transaction ID']];
  const missingColumns = (map) => REQUIRED.filter(([k]) => !(map[k] >= 0)).map(([, label]) => label);

  // ---------- normalisers ----------
  /** Returns {num, ok}. num is digits incl. country code, no '+'. */
  function normPhone(v, cc) {
    const raw = String(v || '').replace(/[‎‏‪-‮]/g, '').trim();
    const d = raw.replace(/\D/g, '');
    cc = String(cc || '91');
    if (!d) return { num: '', ok: false };
    if (raw.startsWith('+') && !d.startsWith(cc)) return { num: d, ok: d.length >= 8 && d.length <= 15 };
    let n = d;
    if (n.length === 12 && n.startsWith(cc)) n = n.slice(2);
    else if (n.length === 11 && n.startsWith('0')) n = n.slice(1);
    else if (n.length > 10) n = n.slice(-10);
    const ok = n.length === 10 && /^[6-9]/.test(n);
    return { num: ok ? cc + n : n, ok };
  }
  const maskPhone = (n) => (n && n.length > 6 ? n.slice(0, -6) + '••••' + n.slice(-2) : n || '');
  const prettyPhone = (n) => (/^91\d{10}$/.test(n || '') ? '+91 ' + n.slice(2, 7) + ' ' + n.slice(7) : n ? '+' + n : '');

  const normTxn = (v) => String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  /** OCR confuses O/0 and I/L/1 inside bank reference codes, so compare references on a folded key. */
  const fz = (v) => String(v || '').replace(/O/g, '0').replace(/[IL]/g, '1');

  /** "22/10/2026 18:15:00" (day first) -> "2026-10-22" */
  function parseTs(v) {
    const m = /(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/.exec(v || '');
    if (!m) return '';
    return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }

  const INVITE_RE = /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]{10,40}\/?$/;
  const validInvite = (l) => INVITE_RE.test(String(l || '').trim());

  const DEFAULT_LEADER_MSG = 'Hi {name}! Your NACDeC-X registration for team "{team}" is confirmed. Please join the official WhatsApp group using this link: {link}';
  const DEFAULT_MENTOR_MSG = 'Hello {name}, your team "{team}" is registered for NACDeC-X. Please join the official WhatsApp group for faculty mentors and team leaders: {link}';
  const fillTemplate = (t, o) => String(t || '').replace(/\{(name|team|link)\}/g, (_, k) => o[k] || '');
  const waLink = (phone, text) => 'https://wa.me/' + phone + '?text=' + encodeURIComponent(text);

  /** Accepts a normal Google-Sheet URL or a "Publish to web" URL and returns a CSV URL (or '' if unrecognised). */
  function sheetCsvUrl(u) {
    u = String(u || '').trim();
    let m;
    if (!/^https:\/\/docs\.google\.com\/spreadsheets\//.test(u)) return '';
    if (/[?&]output=csv/.test(u) || /\/export\?.*format=csv/.test(u) || /tqx=out:csv/.test(u)) return u;
    if ((m = /\/spreadsheets\/d\/e\/([^/]+)\/pub/.exec(u))) return `https://docs.google.com/spreadsheets/d/e/${m[1]}/pub?output=csv`;
    if ((m = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(u))) {
      const g = /[#&?]gid=(\d+)/.exec(u);
      return `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv${g ? '&gid=' + g[1] : ''}`;
    }
    return '';
  }

  // ---------- state ----------
  /** Older saved data may predate newer settings; fill any that are missing so nothing silently becomes blank. */
  function migrate(state) {
    const d = newState();
    state.settings = Object.assign({}, d.settings, state.settings);
    if (state.settings.namePrefix == null) state.settings.namePrefix = d.settings.namePrefix;
    ['seen', 'approvals'].forEach((k) => { if (!state[k]) state[k] = {}; });
    ['payments', 'pdfs', 'ledger', 'log'].forEach((k) => { if (!state[k]) state[k] = []; });
    return state;
  }
  function newState() {
    return {
      v: 1,
      settings: { name: '', fee: '', feeMode: 'team', inviteLink: '', leaderMsg: DEFAULT_LEADER_MSG, mentorMsg: DEFAULT_MENTOR_MSG,
        inviteMentors: true, deliveryMode: 'link', namePrefix: 'NACDeC-X - ', dailyLimit: 30, autoLockMin: 10, sheetUrl: '', cc: '91', cols: null },
      reg: null, seen: {}, payments: [], pdfs: [], approvals: {}, ledger: [], pending: null, log: [],
    };
  }

  const logEvent = (state, type, msg) => { state.log.push({ ts: new Date().toISOString(), type, msg }); if (state.log.length > 800) state.log.splice(0, state.log.length - 800); };

  // ---------- teams ----------
  const STATUS = { VERIFIED: 'VERIFIED', APPROVED: 'APPROVED', SHORT: 'SHORT', AWAITING: 'AWAITING', NOMATCH: 'NOMATCH', CHECK: 'CHECK',
    DUPLICATE: 'DUPLICATE', NOFEE: 'NOFEE', NOSTMT: 'NOSTMT', FIX: 'FIX' };
  const STATUS_TEXT = {
    VERIFIED: 'Verified', APPROVED: 'Approved by you', SHORT: 'Amount short', AWAITING: 'Awaiting statement', NOMATCH: 'No payment found',
    CHECK: 'Check manually', DUPLICATE: 'Duplicate ID', NOFEE: 'Set the fee', NOSTMT: 'Add a statement', FIX: 'Fix details',
  };
  const OK_STATUSES = new Set([STATUS.VERIFIED, STATUS.APPROVED]);

  function paymentIndex(payments) {
    const map = new Map();
    payments.forEach((p, i) => (p.tokens || []).forEach((t0) => { const t = fz(t0); if (!map.has(t)) map.set(t, []); map.get(t).push(i); }));
    return map;
  }
  const coverageEnd = (state) => state.pdfs.reduce((m, p) => (p.periodTo && p.periodTo > m ? p.periodTo : m), '');

  /** Builds the full derived picture. Never mutates state. */
  function compute(state) {
    const s = state.settings;
    const out = { teams: [], needsMapping: [], coverage: coverageEnd(state), sentPhones: new Set(state.ledger.map((l) => l.phone)) };
    if (!state.reg) return out;
    const { headers, rows } = state.reg;
    const map = Object.assign(guessColumns(headers), s.cols || {});
    out.needsMapping = missingColumns(map);
    out.map = map;
    if (out.needsMapping.length) return out;
    const g = (cells, i) => (i >= 0 ? cells[i] || '' : '');
    const pidx = paymentIndex(state.payments);
    const fee = parseFloat(String(s.fee).replace(/,/g, '')) || 0;
    const claimed = new Map();     // payment index -> tid
    const txnSeen = new Map();     // normalised typed id -> tid
    const phoneLeaders = {};

    const teams = rows.map((r) => {
      const c = r.cells;
      const leaderP = normPhone(g(c, map.phone), s.cc);
      const mentorP = normPhone(g(c, map.mentorPhone), s.cc);
      const ts = g(c, map.ts), email = g(c, map.email).toLowerCase();
      const tid = ((ts || 'row' + r.rowNo) + '|' + (email || leaderP.num)).toLowerCase();
      const members = map.members.filter((i) => g(c, i)).length || 1;
      const t = {
        tid, rowNo: r.rowNo, ts, tsDate: parseTs(ts), team: g(c, map.team) || '(no team name)', institution: g(c, map.institution), city: g(c, map.city),
        leader: { name: g(c, map.leader), phone: leaderP.num, phoneOk: leaderP.ok, raw: g(c, map.phone) },
        mentor: { name: g(c, map.mentorName), phone: mentorP.num, phoneOk: mentorP.ok, raw: g(c, map.mentorPhone) },
        members, txnRaw: g(c, map.txn), txn: normTxn(g(c, map.txn)), proof: g(c, map.proof),
        status: '', reason: '', payment: null, required: fee ? (s.feeMode === 'member' ? fee * members : fee) : 0, isNew: false,
      };
      if (t.leader.phoneOk) phoneLeaders[t.leader.phone] = (phoneLeaders[t.leader.phone] || 0) + 1;
      return t;
    });

    teams.forEach((t) => {
      t.isNew = !!state.reg.newTids && state.reg.newTids.indexOf(t.tid) >= 0;
      t.approved = state.approvals[t.tid] || null;
      if (!t.leader.name || !t.leader.phoneOk) { t.status = STATUS.FIX; t.reason = !t.leader.phoneOk ? 'Leader phone number looks invalid' : 'Leader name is missing'; return; }
      if (!t.txn) { t.status = t.approved ? STATUS.APPROVED : STATUS.CHECK; t.reason = 'No transaction ID entered'; return; }
      const prior = txnSeen.get(t.txn);
      if (prior && prior !== t.tid) { t.status = STATUS.DUPLICATE; t.reason = 'Same transaction ID as another team'; return; }
      txnSeen.set(t.txn, t.tid);

      const cand = Statement.tokensOf(t.txnRaw); if (t.txn && cand.indexOf(t.txn) < 0) cand.push(t.txn);
      let hit = -1;
      for (const tok0 of cand) { const list = pidx.get(fz(tok0)); if (list && list.length) { hit = list.find((i) => !claimed.has(i) || claimed.get(i) === t.tid); if (hit === undefined) hit = -2; if (hit !== -2) break; } }
      if (hit === -2) { t.status = STATUS.DUPLICATE; t.reason = 'That payment was already used by another team'; return; }
      if (hit >= 0) {
        claimed.set(hit, t.tid);
        t.payment = state.payments[hit];
        if (!fee) { t.status = STATUS.NOFEE; t.reason = 'Payment found — set the fee in Settings to confirm the amount'; }
        else if (t.payment.amount + 0.005 < t.required) { t.status = STATUS.SHORT; t.reason = `Paid ₹${fmt(t.payment.amount)}, expected ₹${fmt(t.required)}`; }
        else { t.status = STATUS.VERIFIED; t.reason = t.payment.amount > t.required + 0.005 ? `Paid ₹${fmt(t.payment.amount)} (more than ₹${fmt(t.required)})` : 'Payment found'; }
      } else {
        const loose = t.txn.length >= 10 ? state.payments.findIndex((p) => (p.norm || '').includes(fz(t.txn))) : -1;
        if (!state.payments.length) { t.status = STATUS.NOSTMT; t.reason = 'No bank statement loaded yet'; }
        else if (loose >= 0) { t.status = STATUS.CHECK; t.reason = 'Possible match in a narration — confirm by eye'; t.payment = state.payments[loose]; }
        else if (!/^\d{12}$/.test(t.txn)) { t.status = STATUS.CHECK; t.reason = 'ID is not a 12-digit UPI reference — check the payment proof'; }
        else if (t.tsDate && out.coverage && t.tsDate > out.coverage) { t.status = STATUS.AWAITING; t.reason = `Registered after the last statement ends (${out.coverage}) — add the next statement`; }
        else { t.status = STATUS.NOMATCH; t.reason = 'ID not found in the loaded statements'; }
      }
      if (t.approved && !OK_STATUSES.has(t.status) && t.status !== STATUS.DUPLICATE) { t.status = STATUS.APPROVED; t.reason = 'You approved this manually: ' + (t.approved.note || ''); }
    });

    teams.forEach((t) => {
      const lp = t.leader.phone;
      t.leader.sent = lp ? state.ledger.find((l) => l.phone === lp) || null : null;
      t.mentor.sent = t.mentor.phone ? state.ledger.find((l) => l.phone === t.mentor.phone) || null : null;
      t.leader.pending = !!(state.pending && state.pending.phone === lp);
      t.mentor.pending = !!(state.pending && state.pending.phone === t.mentor.phone);
      const teamOk = OK_STATUSES.has(t.status);
      t.leader.eligible = teamOk && t.leader.phoneOk && !t.leader.sent;
      t.leader.dupPhone = phoneLeaders[lp] > 1;
      t.mentor.wanted = !!(s.inviteMentors && t.mentor.name && t.mentor.phoneOk);
      t.mentor.eligible = teamOk && t.mentor.wanted && !t.mentor.sent && t.mentor.phone !== lp;
      t.invitesDue = (t.leader.eligible ? 1 : 0) + (t.mentor.eligible ? 1 : 0);
      t.fullySent = !!t.leader.sent && (!t.mentor.wanted || !!t.mentor.sent);
    });
    out.teams = teams;
    return out;
  }

  /** Everyone who may be messaged right now, de-duplicated by phone. */
  function queue(derived) {
    const seen = new Set(), q = [];
    for (const t of derived.teams) {
      if (t.leader.eligible && !seen.has(t.leader.phone)) { seen.add(t.leader.phone); q.push({ role: 'leader', name: t.leader.name, phone: t.leader.phone, team: t.team, tid: t.tid, institution: t.institution }); }
    }
    for (const t of derived.teams) {
      if (t.mentor.eligible && !seen.has(t.mentor.phone) && !derived.sentPhones.has(t.mentor.phone)) { seen.add(t.mentor.phone); q.push({ role: 'mentor', name: t.mentor.name, phone: t.mentor.phone, team: t.team, tid: t.tid, institution: t.institution }); }
    }
    return q;
  }

  const fmt = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const todayKey = (d) => { d = d || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const sentToday = (state, now) => state.ledger.filter((l) => todayKey(new Date(l.ts)) === todayKey(now)).length;

  // ---------- guard-railed actions (all mutate state; return {ok, error}) ----------
  /** Step 1: record that we are about to open WhatsApp for someone. */
  function beginSend(state, item, now) {
    const s = state.settings;
    if (state.pending) return { ok: false, error: 'Finish the previous invite first — did that message get sent?' };
    if (!validInvite(s.inviteLink)) return { ok: false, error: 'Add a valid WhatsApp group invite link in Settings first.' };
    if (state.ledger.some((l) => l.phone === item.phone)) return { ok: false, error: 'This number has already been invited. It will not be sent again.' };
    const lim = Number(s.dailyLimit) || 0;
    if (lim && sentToday(state, now) >= lim) return { ok: false, error: `Daily limit of ${lim} invites reached. Raise it in Settings if you really want to continue.` };
    state.pending = { phone: item.phone, name: item.name, role: item.role, team: item.team, tid: item.tid, openedAt: (now || new Date()).toISOString() };
    return { ok: true, url: waLink(item.phone, fillTemplate(item.role === 'mentor' ? s.mentorMsg : s.leaderMsg, { name: item.name, team: item.team, link: s.inviteLink.trim() })) };
  }
  /** Step 2: the volunteer confirms the message was actually sent. */
  function confirmSent(state, now) {
    const p = state.pending;
    if (!p) return { ok: false, error: 'Nothing to confirm.' };
    if (state.ledger.some((l) => l.phone === p.phone)) { state.pending = null; return { ok: false, error: 'Already recorded.' }; }
    state.ledger.push({ id: 'L' + (now || new Date()).getTime().toString(36) + state.ledger.length, ts: (now || new Date()).toISOString(), phone: p.phone, name: p.name, role: p.role, team: p.team, tid: p.tid });
    logEvent(state, 'sent', `${p.role === 'mentor' ? 'Mentor' : 'Leader'} ${p.name} (${p.team}) marked as invited`);
    state.pending = null;
    return { ok: true };
  }
  function cancelPending(state) {
    if (state.pending) logEvent(state, 'skip', `Not sent: ${state.pending.name} (${state.pending.team})`);
    state.pending = null; return { ok: true };
  }
  function undoSent(state, id) {
    const i = state.ledger.findIndex((l) => l.id === id);
    if (i < 0) return { ok: false, error: 'Entry not found' };
    const [e] = state.ledger.splice(i, 1);
    logEvent(state, 'undo', `Removed "invited" mark for ${e.name} (${e.team}) — they can be invited again`);
    return { ok: true };
  }
  function approveTeam(state, tid, note) {
    note = String(note || '').trim();
    if (note.length < 3) return { ok: false, error: 'Write a short reason (what did you check?).' };
    state.approvals[tid] = { note, ts: new Date().toISOString() };
    logEvent(state, 'approve', 'Manually approved a team: ' + note);
    return { ok: true };
  }
  function revokeApproval(state, tid) { delete state.approvals[tid]; logEvent(state, 'approve', 'Removed a manual approval'); return { ok: true }; }

  /** Loads a registration table. Returns {added: n, total: n}. New = a team we have never seen before. */
  function loadRegistrations(state, table, source, name) {
    const prevSeen = state.seen || {};
    const map = Object.assign(guessColumns(table.headers), state.settings.cols || {});
    const g = (c, i) => (i >= 0 ? c[i] || '' : '');
    const nowIso = new Date().toISOString(), newTids = [];
    state.reg = { source, name, loadedAt: nowIso, headers: table.headers, rows: table.rows, newTids };
    const seen = Object.assign({}, prevSeen);
    table.rows.forEach((r) => {
      const ph = normPhone(g(r.cells, map.phone), state.settings.cc);
      const ts = g(r.cells, map.ts), email = g(r.cells, map.email).toLowerCase();
      const tid = ((ts || 'row' + r.rowNo) + '|' + (email || ph.num)).toLowerCase();
      if (!seen[tid]) { seen[tid] = nowIso; if (Object.keys(prevSeen).length) newTids.push(tid); }
    });
    state.seen = seen;
    logEvent(state, 'load', `Loaded ${table.rows.length} registrations from ${source === 'sheet' ? 'Google Sheet' : name}` + (newTids.length ? ` (${newTids.length} new)` : ''));
    return { total: table.rows.length, added: newTids.length };
  }

  /** Merge OCR results into the payments list (de-duplicated, so overlapping statements are fine). */
  function addStatement(state, file, parsed) {
    const key = (p) => [p.date, p.amount, p.balance == null ? '' : p.balance].join('|') + (p.balance == null ? '|' + p.norm.slice(0, 30) : '');
    const have = new Map(state.payments.map((p) => [key(p), p]));
    let added = 0, dup = 0;
    const fid = file.id;
    for (const c of parsed.credits) {
      const p = { date: c.date, amount: c.amount, balance: c.balance, text: c.text, check: c.check, src: [fid], tokens: Statement.tokensOf(c.text), norm: fz(normTxn(c.text)) };
      const k = key(p);
      const twin = have.has(k) ? have.get(k) : state.payments.find((x) => x.amount === p.amount && p.tokens.some((t) => /^\d{12}$/.test(t) && x.tokens.indexOf(t) >= 0));
      if (twin) { const ex = twin; if (ex.src.indexOf(fid) < 0) ex.src.push(fid); dup++; }
      else { state.payments.push(p); have.set(k, p); added++; }
    }
    state.pdfs.push({ id: fid, name: file.name, size: file.size, addedAt: new Date().toISOString(), periodFrom: parsed.period ? parsed.period.from : '', periodTo: parsed.period ? parsed.period.to : '',
      credits: parsed.credits.length, added, dup, chainBad: parsed.chainBad, rows: parsed.rows });
    logEvent(state, 'pdf', `Read statement "${file.name}": ${parsed.credits.length} credits (${added} new)`);
    return { added, dup };
  }
  function removeStatement(state, fid) {
    const f = state.pdfs.find((p) => p.id === fid);
    state.pdfs = state.pdfs.filter((p) => p.id !== fid);
    state.payments = state.payments.filter((p) => { p.src = p.src.filter((x) => x !== fid); return p.src.length > 0; });
    if (f) logEvent(state, 'pdf', `Removed statement "${f.name}"`);
  }


  // ---------- "add them myself" mode ----------
  const contactName = (state, p) => (state.settings.namePrefix || '') + p.name;
  const q2 = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  /** Google Contacts import file (CSV). */
  function contactsCsv(state, people) {
    const lines = ['First Name,Last Name,Labels,Phone 1 - Label,Phone 1 - Value'];
    people.forEach((p) => lines.push([q2(contactName(state, p)), q2(p.role === 'mentor' ? '(Mentor)' : ''), q2('NACDeC-X'), 'Mobile', q2('+' + p.phone)].join(',')));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }
  /** vCard file — imports straight into iPhone/Android contacts. */
  function contactsVcf(state, people) {
    const esc = (v) => String(v).replace(/([\;,])/g, '\\$1').replace(/\n/g, ' ');
    return people.map((p) => ['BEGIN:VCARD', 'VERSION:3.0', 'FN:' + esc(contactName(state, p)), 'N:' + esc(contactName(state, p)) + ';;;;', 'TEL;TYPE=CELL:+' + p.phone, 'CATEGORIES:NACDeC-X', 'END:VCARD'].join('\r\n')).join('\r\n') + '\r\n';
  }
  /** Records that the volunteer added these people to the group themselves. */
  function markAdded(state, items, now) {
    if (state.pending) return { ok: false, error: 'Finish the pending invite first.' };
    let n = 0; const t = (now || new Date()).toISOString();
    items.forEach((item) => {
      if (state.ledger.some((l) => l.phone === item.phone)) return;
      state.ledger.push({ id: 'L' + Date.now().toString(36) + state.ledger.length, ts: t, phone: item.phone, name: item.name, role: item.role, team: item.team, tid: item.tid, via: 'added' });
      n++;
    });
    if (n) logEvent(state, 'sent', n === 1 ? `Marked ${items[0].name} (${items[0].team}) as added to the group` : `Marked ${n} people as added to the group`);
    return { ok: true, n };
  }

  return { migrate, contactsCsv, contactsVcf, markAdded, parseCSV, toTable, guessColumns, missingColumns, normPhone, maskPhone, prettyPhone, normTxn, parseTs, validInvite, fillTemplate, waLink, sheetCsvUrl,
    newState, logEvent, compute, queue, beginSend, confirmSent, cancelPending, undoSent, approveTeam, revokeApproval, loadRegistrations, addStatement,
    removeStatement, sentToday, todayKey, fmt, STATUS, STATUS_TEXT, OK_STATUSES, DEFAULT_LEADER_MSG, DEFAULT_MENTOR_MSG };
});
