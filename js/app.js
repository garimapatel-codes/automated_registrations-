/*
 * app.js — UI. No network calls anywhere (and the page's CSP forbids them).
 * Everything is stored in this browser's localStorage, only if "Remember" is ticked.
 */
(function () {
  'use strict';
  const C = window.Core;
  const LS_KEY = 'regverifier.v1';
  const DEFAULT_MENTOR_TEMPLATE = 'Hello {mentor}, your team "{team}" (leader: {leader}) is registered for NACDeC-X ✅ Please join the group: {invite}';
  const DEFAULT_TEMPLATE = 'Hi {leader}, your team "{team}" is registered for NACDeC-X ✅ Please join the participants group: {invite}';

  const $ = (s, r) => (r || document).querySelector(s);
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (['checked', 'disabled', 'value', 'selected'].includes(k)) e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) { if (k == null || k === false) continue; e.append(k.nodeType ? k : document.createTextNode(String(k))); }
    return e;
  }

  // ---------------- state ----------------
  const defaults = () => ({
    settings: { fee: 8000, maxTeam: 5, cc: '91', mode: 'invite', invite: '', template: DEFAULT_TEMPLATE, mentors: true, mentorTemplate: DEFAULT_MENTOR_TEMPLATE, remember: true, watchMin: 15 },
    regText: '', regName: '', bankText: '', bankName: '',
    regMap: {}, bankMap: {}, bankHeaderRow: 0,
    flags: {}, // key -> { sent: ts|null, added: bool, override: 'verified'|'rejected'|null, note: '' }
  });
  let S = defaults();
  const view = { filter: 'ALL', q: '', open: new Set(), fresh: new Set() };
  const watchers = { reg: null, bank: null }; // live file handles; never persisted
  let model = { regT: null, bankT: null, bankAuto: 1, results: [], error: '', credits: 0 };

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      const d = defaults();
      S = Object.assign(d, o, { settings: Object.assign(d.settings, o.settings || {}) });
    } catch (e) { /* ignore corrupt storage */ }
  }
  function save() {
    try {
      const o = { settings: S.settings };
      if (S.settings.remember) Object.assign(o, { regText: S.regText, regName: S.regName, bankText: S.bankText, bankName: S.bankName, regMap: S.regMap, bankMap: S.bankMap, bankHeaderRow: S.bankHeaderRow, flags: S.flags });
      localStorage.setItem(LS_KEY, JSON.stringify(o));
    } catch (e) { toast('Browser storage is full or blocked — progress is kept only until you close this tab.'); }
  }
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3800);
  }

  // ---------------- model ----------------
  function ensureMaps() {
    if (model.regT) {
      const hs = model.regT.headers, g = C.guessReg(hs), m = S.regMap || {};
      for (const k of Object.keys(g)) {
        if (k === 'members') {
          if (typeof m.members === 'string') m.members = m.members ? [m.members] : undefined;
          if (!Array.isArray(m.members) || m.members.some((n) => !hs.includes(n))) m.members = g.members;
        } else if (m[k] === undefined || (m[k] && !hs.includes(m[k]))) m[k] = g[k];
      }
      S.regMap = m;
    }
    if (model.bankT) {
      const g = C.guessBank(model.bankT.headers), m = S.bankMap || {}, hs = model.bankT.headers;
      if (!Array.isArray(m.ref) || m.ref.some((n) => !hs.includes(n)) || !m.ref.length) m.ref = g.ref;
      for (const k of ['credit', 'debit', 'date']) if (m[k] === undefined || (m[k] && !hs.includes(m[k]))) m[k] = g[k];
      S.bankMap = m;
    }
  }
  function recompute() {
    model.regT = S.regText ? C.toTable(C.parseCSV(S.regText), 0) : null;
    if (S.bankText) {
      const rows = C.parseCSV(S.bankText);
      model.bankAuto = C.findBankHeader(rows) + 1;
      model.bankT = C.toTable(rows, (S.bankHeaderRow || model.bankAuto) - 1);
    } else model.bankT = null;
    ensureMaps();
    model.error = ''; model.results = []; model.credits = 0;
    if (model.regT) {
      const v = C.verify(model.regT, S.regMap, model.bankT, S.bankMap, S.settings);
      model.results = v.results; model.error = v.error || ''; model.credits = v.creditCount || 0;
    }
  }

  const LABEL = {
    VERIFIED: ['✅ Verified', 'ok'], UNDERPAID: ['⚠️ Underpaid', 'warn'], PENDING: ['⏳ Pending', 'warn'],
    DUPLICATE: ['🚫 Duplicate', 'bad'], REVIEW: ['🔍 Needs review', 'bad'], REJECTED: ['⛔ Rejected', 'bad'],
  };
  const flag = (r) => S.flags[r.key] || {};
  function eff(r) {
    const f = flag(r);
    if (f.override === 'verified') return { code: 'VERIFIED', manual: true };
    if (f.override === 'rejected') return { code: 'REJECTED', manual: true };
    return { code: r.status, manual: false };
  }
  const isOk = (r) => eff(r).code === 'VERIFIED';
  function setFlag(r, patch) { S.flags[r.key] = Object.assign({}, S.flags[r.key], patch); save(); render(); }
  // Mentors are tracked per phone number, so a mentor guiding several teams is invited only once.
  const mKey = (r) => 'M|' + r.mentorPhone;
  const mflag = (r) => S.flags[mKey(r)] || {};
  function setMFlag(r, patch) { S.flags[mKey(r)] = Object.assign({}, S.flags[mKey(r)], patch); save(); render(); }
  const mentorOk = (r) => !!S.settings.mentors && isOk(r) && !!r.mentorPhone;
  const fmtShort = (t) => new Date(t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

  // ---------------- links ----------------
  function messageFor(r, who) {
    const tpl = who === 'mentor' ? (S.settings.mentorTemplate || DEFAULT_MENTOR_TEMPLATE) : (S.settings.template || DEFAULT_TEMPLATE);
    return tpl.replace(/\{leader\}/g, r.leader || 'the team leader').replace(/\{team\}/g, r.team || 'your team')
      .replace(/\{mentor\}/g, r.mentorName || 'Sir/Madam').replace(/\{invite\}/g, S.settings.invite || '');
  }
  function linkFor(r, who) {
    const ph = who === 'mentor' ? r.mentorPhone : r.phone;
    if (!ph) return '';
    return S.settings.mode === 'invite' ? 'https://wa.me/' + ph + '?text=' + encodeURIComponent(messageFor(r, who)) : 'https://wa.me/' + ph;
  }
  const inviteMissing = () => S.settings.mode === 'invite' && !/^https:\/\/chat\.whatsapp\.com\/\S+/.test(S.settings.invite.trim());

  function openChat(r, who) {
    who = who || 'leader';
    const mentor = who === 'mentor';
    if (mentor ? !mentorOk(r) : !(isOk(r) && r.phone)) return;
    if (inviteMissing()) { toast('Paste the WhatsApp group invite link in step 3 first.'); return; }
    const f = mentor ? mflag(r) : flag(r);
    const who2 = mentor ? 'mentor ' + (r.mentorName || r.mentorPhone) : (r.leader || r.team);
    if (f.sent && !confirm('An invite was already marked as sent to ' + who2 + '. Send again?')) return;
    window.open(linkFor(r, who), '_blank', 'noopener,noreferrer');
    (mentor ? setMFlag : setFlag)(r, { sent: Date.now() });
  }
  /** Everyone still to be invited, in table order: leader first, then that team's mentor (each mentor once). */
  function pendingContacts() {
    const out = [], seen = new Set();
    for (const r of model.results) {
      if (isOk(r) && r.phone && !flag(r).sent) out.push({ r, who: 'leader' });
      if (mentorOk(r) && !mflag(r).sent && !seen.has(r.mentorPhone)) { seen.add(r.mentorPhone); out.push({ r, who: 'mentor' }); }
    }
    return out;
  }
  const uniqueMentors = (pred) => { const m = new Map(); model.results.forEach((r) => { if (mentorOk(r) && pred(r) && !m.has(r.mentorPhone)) m.set(r.mentorPhone, r); }); return [...m.values()]; };

  // ---------------- rendering ----------------
  function render() { renderUploads(); renderStats(); renderTable(); }
  function renderAll() { renderSettings(); renderMaps(); render(); }

  function renderUploads() {
    const R = model.regT, B = model.bankT;
    $('#dropReg').classList.toggle('loaded', !!R);
    $('#dropBank').classList.toggle('loaded', !!B);
    $('#infoReg').textContent = R ? '✔ ' + (S.regName || 'registrations.csv') + ' — ' + R.rows.length + ' registrations' : 'No file loaded — click or drop here';
    $('#infoBank').textContent = B ? '✔ ' + (S.bankName || 'bank.csv') + ' — ' + model.credits + ' credit rows (header on row ' + (S.bankHeaderRow || model.bankAuto) + ')' : 'No file loaded — click or drop here';
    const m = $('#loadMsg');
    m.className = 'msg';
    if (model.error) { m.classList.add('err'); m.textContent = model.error; }
    else if (R && !B) { m.classList.add('warn'); m.textContent = 'Registrations loaded. Upload the bank statement to start verifying — every team is “Pending” until then.'; }
    else if (!R && B) { m.classList.add('warn'); m.textContent = 'Bank statement loaded. Upload the registrations CSV too.'; }
    else m.textContent = '';
  }

  function renderSettings() {
    const s = S.settings;
    $('#setFee').value = s.fee; $('#setMax').value = s.maxTeam; $('#setCC').value = s.cc;
    $('#chkMentors').checked = !!s.mentors; $('#setMentorTemplate').value = s.mentorTemplate;
    $('#setInvite').value = s.invite; $('#setTemplate').value = s.template; $('#chkRemember').checked = !!s.remember;
    document.querySelectorAll('input[name=mode]').forEach((i) => { i.checked = i.value === s.mode; });
  }

  function select(headers, value, onchange, allowNone) {
    const sel = h('select', { onchange: (e) => onchange(e.target.value) });
    if (allowNone) sel.append(h('option', { value: '' }, '— none —'));
    headers.forEach((x) => sel.append(h('option', { value: x, selected: x === value }, x || '(blank)')));
    sel.value = value || '';
    return sel;
  }
  function renderMaps() {
    const mr = $('#mapReg'), mb = $('#mapBank');
    mr.replaceChildren(); mb.replaceChildren();
    if (!model.regT) mr.append(h('span', { class: 'muted' }, 'Upload the registrations file first.'));
    else {
      const f = [['team', 'Team name', 1], ['leader', 'Leader name', 1], ['phone', 'Leader WhatsApp no. *', 0], ['email', 'Leader email', 1], ['utr', 'UTR / transaction ID *', 0],
        ['institution', 'Institution', 1], ['city', 'City', 1], ['proof', 'Payment proof link', 1],
        ['mentorName', 'Mentor name', 1], ['mentorPhone', 'Mentor WhatsApp no.', 1], ['mentorEmail', 'Mentor email', 1]];
      f.forEach(([k, label, opt]) => {
        mr.append(h('label', {}, label), select(model.regT.headers, S.regMap[k], (v) => { S.regMap[k] = v; save(); recompute(); render(); }, !!opt));
      });
      const mm = h('div', { class: 'multi' });
      const nameish = model.regT.headers.filter((x) => x && (/name/i.test(x) || (S.regMap.members || []).includes(x)));
      nameish.forEach((x) => mm.append(h('label', {}, h('input', {
        type: 'checkbox', checked: (S.regMap.members || []).includes(x),
        onchange: (e) => { const set = new Set(S.regMap.members || []); e.target.checked ? set.add(x) : set.delete(x); S.regMap.members = model.regT.headers.filter((y) => set.has(y)); save(); recompute(); render(); },
      }), x)));
      mr.append(h('label', {}, 'Member name columns (counts team size)'), mm);
    }
    if (!model.bankT) mb.append(h('span', { class: 'muted' }, 'Upload the bank statement first.'));
    else {
      const hs = model.bankT.headers;
      mb.append(h('label', {}, 'Header row no.'),
        h('input', { type: 'number', min: 1, value: S.bankHeaderRow || model.bankAuto, onchange: (e) => { S.bankHeaderRow = Math.max(1, parseInt(e.target.value, 10) || 0); save(); recompute(); renderMaps(); render(); } }));
      mb.append(h('label', {}, 'Credit (money in) *'), select(hs, S.bankMap.credit, (v) => { S.bankMap.credit = v; save(); recompute(); render(); }, false));
      mb.append(h('label', {}, 'Debit (optional)'), select(hs, S.bankMap.debit, (v) => { S.bankMap.debit = v; save(); recompute(); render(); }, true));
      mb.append(h('label', {}, 'Date (optional)'), select(hs, S.bankMap.date, (v) => { S.bankMap.date = v; save(); recompute(); render(); }, true));
      const multi = h('div', { class: 'multi' });
      hs.filter(Boolean).forEach((x) => multi.append(h('label', {}, h('input', {
        type: 'checkbox', checked: (S.bankMap.ref || []).includes(x),
        onchange: (e) => { const set = new Set(S.bankMap.ref || []); e.target.checked ? set.add(x) : set.delete(x); S.bankMap.ref = [...set]; save(); recompute(); render(); },
      }), x)));
      mb.append(h('label', {}, 'Columns holding the UTR / narration *'), multi);
    }
  }

  function renderStats() {
    const rs = model.results;
    const n = (f) => rs.filter(f).length;
    const code = (r) => eff(r).code;
    const items = [
      ['ALL', 'All teams', rs.length, ''],
      ['VERIFIED', '✅ Verified', n((r) => code(r) === 'VERIFIED'), 'ok'],
      ['PENDING', '⏳ Pending', n((r) => code(r) === 'PENDING'), 'warn'],
      ['UNDERPAID', '⚠️ Underpaid', n((r) => code(r) === 'UNDERPAID'), 'warn'],
      ['ATTN', '🚫 Needs attention', n((r) => ['DUPLICATE', 'REVIEW', 'REJECTED'].includes(code(r))), 'bad'],
      ['TODO', '📨 Verified, not yet invited', n((r) => isOk(r) && !flag(r).sent), 'info'],
      ['SENT', '✉️ Invite sent', n((r) => flag(r).sent), 'info'],
      ['ADDED', '👥 Added to group', n((r) => flag(r).added), 'info'],
    ];
    if (S.settings.mentors) items.push(['MTODO', '🎓 Mentors to invite', uniqueMentors((r) => !mflag(r).sent).length, 'info']);
    const bar = $('#statsBar'); bar.replaceChildren();
    items.forEach(([k, label, count, cls]) => bar.append(h('button', {
      class: 'chip ' + cls, type: 'button', 'aria-pressed': String(view.filter === k),
      onclick: () => { view.filter = k; render(); },
    }, label, h('b', {}, count))));
    const q = $('#btnQueue'), pend = pendingContacts(), left = pend.length;
    q.disabled = left === 0;
    q.textContent = left ? 'Send to next verified contact ▶ (' + left + ' left)' : 'No verified contacts waiting';
    q.title = left ? 'Next: ' + (pend[0].who === 'mentor' ? 'mentor of ' : 'leader of ') + (pend[0].r.team || 'team') : '';
    const qi = $('#queueInfo');
    qi.className = 'msg';
    if (inviteMissing()) { qi.classList.add('warn'); qi.textContent = 'Invite-message mode is on but no valid group invite link is set (step 3). Buttons stay disabled until you add it.'; }
    else qi.textContent = '';
  }

  function matches(r) {
    const c = eff(r).code, f = flag(r), F = view.filter;
    const okFilter = F === 'ALL' || (F === 'ATTN' ? ['DUPLICATE', 'REVIEW', 'REJECTED'].includes(c)
      : F === 'TODO' ? c === 'VERIFIED' && !f.sent : F === 'SENT' ? !!f.sent : F === 'ADDED' ? !!f.added
        : F === 'MTODO' ? mentorOk(r) && !mflag(r).sent : c === F);
    if (!okFilter) return false;
    const q = view.q.trim().toLowerCase();
    if (!q) return true;
    return [r.team, r.leader, r.phoneRaw, r.phone, r.utrRaw, r.utr, r.email, r.institution, r.city, r.mentorName].join(' ').toLowerCase().includes(q);
  }

  function badge(r) {
    const e = eff(r), [text, cls] = LABEL[e.code];
    return h('span', { class: 'badge ' + cls }, text + (e.manual ? ' (manual)' : ''));
  }

  function highlight(text, needle) {
    const i = needle ? text.toUpperCase().indexOf(needle) : -1;
    if (i < 0) return [text];
    return [text.slice(0, i), h('mark', {}, text.slice(i, i + needle.length)), text.slice(i + needle.length)];
  }

  function detailRow(r) {
    const f = flag(r), e = eff(r);
    const reg = h('div', { class: 'box' },
      h('div', {}, 'CSV row ', r.rowNo, ' · UTR typed: ', h('span', { class: 'mono' }, r.utrRaw || '—')),
      h('div', {}, 'Phone typed: ', r.phoneRaw || '—', ' → ', h('span', { class: 'mono' }, r.phone ? '+' + r.phone : 'invalid')),
      r.email ? h('div', {}, 'Email: ', r.email) : null,
      r.institution || r.city ? h('div', {}, 'Institution: ', [r.institution, r.city].filter(Boolean).join(', ')) : null,
      r.members ? h('div', {}, 'Members (' + r.teamSize + '): ', r.members) : null,
      r.mentorName || r.mentorPhoneRaw ? h('div', {}, 'Faculty mentor: ', [r.mentorName, r.mentorPhone ? '+' + r.mentorPhone : (r.mentorPhoneRaw ? '(invalid number: ' + r.mentorPhoneRaw + ')' : '')].filter(Boolean).join(' · ')) : null,
      r.proof ? h('div', {}, 'Payment proof: ', h('a', { href: r.proof, target: '_blank', rel: 'noopener noreferrer' }, 'open in Drive ↗')) : null);
    const bankBox = h('div', { class: 'box' });
    if (!r.bankMatches.length) bankBox.append('No matching credit in the bank file.');
    r.bankMatches.forEach((m) => bankBox.append(h('div', {},
      'Bank row ' + m.rowNo + (m.date ? ' · ' + m.date : '') + ' · ',
      h('strong', {}, '₹' + m.amount.toLocaleString('en-IN')), ' · ', ...highlight(m.text, r.utr),
      r.matchType === 'loose' ? h('em', {}, ' (partial match)') : null)));
    const link = e.code === 'VERIFIED' && r.phone ? linkFor(r) : '';
    return h('tr', { class: 'detail' }, h('td', { colspan: 9 },
      h('div', { class: 'evidence' },
        h('div', {}, h('h4', {}, 'Why this status'), h('div', { class: 'box' }, r.reason || '—')),
        h('div', {}, h('h4', {}, 'Registration data'), reg),
        h('div', {}, h('h4', {}, 'Bank evidence'), bankBox)),
      link ? h('div', { class: 'linkline' }, 'Leader wa.me link: ', h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', class: 'mono' }, link)) : null,
      mentorOk(r) ? h('div', { class: 'linkline' }, 'Mentor wa.me link: ', h('a', { href: linkFor(r, 'mentor'), target: '_blank', rel: 'noopener noreferrer', class: 'mono' }, linkFor(r, 'mentor'))) : null,
      h('div', { class: 'override' },
        h('button', { class: 'btn small', type: 'button', onclick: () => { if (confirm('Mark this team as verified manually, without a matching bank payment?')) setFlag(r, { override: 'verified' }); } }, 'Mark verified manually'),
        h('button', { class: 'btn small', type: 'button', onclick: () => setFlag(r, { override: 'rejected' }) }, 'Reject'),
        f.override ? h('button', { class: 'btn small', type: 'button', onclick: () => setFlag(r, { override: null }) }, 'Reset to automatic') : null,
        h('input', { type: 'text', placeholder: 'Private note…', value: f.note || '', 'aria-label': 'Note', onchange: (ev) => setFlag(r, { note: ev.target.value }) }))));
  }

  function renderTable() {
    const body = $('#tbody'); body.replaceChildren();
    const rows = model.results.filter(matches);
    $('#emptyMsg').hidden = rows.length > 0;
    $('#emptyMsg').textContent = model.results.length ? 'No teams match this filter.' : 'Upload the registrations CSV to see teams here.';
    rows.forEach((r, i) => {
      const f = flag(r), ok = isOk(r), open = view.open.has(r.key);
      const mf = mflag(r), showMentor = mentorOk(r);
      const mentorBox = showMentor ? h('div', { class: 'mentorbox' },
        h('div', { class: 'small muted' }, '🎓 Mentor: ' + (r.mentorName || '—') + ' · +' + r.mentorPhone),
        h('button', { class: 'btn small', type: 'button', disabled: inviteMissing(), onclick: () => openChat(r, 'mentor') }, mf.sent ? 'Resend to mentor' : (S.settings.mode === 'invite' ? 'Invite mentor' : 'Open mentor chat')),
        h('div', { class: 'small' }, h('label', {}, h('input', { type: 'checkbox', checked: !!mf.sent, onchange: (e) => setMFlag(r, { sent: e.target.checked ? Date.now() : null }) }), ' sent', mf.sent ? ' ' + fmtShort(mf.sent) : ''))) : null;
      const sentCell = h('td', {},
        ok && r.phone ? h('button', { class: 'btn small primary', type: 'button', disabled: inviteMissing(), onclick: () => openChat(r) }, f.sent ? 'Resend' : (S.settings.mode === 'invite' ? 'Send invite' : 'Open chat')) : null,
        h('div', { class: 'small' }, h('label', {}, h('input', { type: 'checkbox', checked: !!f.sent, disabled: !ok && !f.sent, onchange: (e) => setFlag(r, { sent: e.target.checked ? Date.now() : null }) }), ' sent', f.sent ? ' ' + fmtShort(f.sent) : '')),
        mentorBox);
      body.append(h('tr', { class: 'main' },
        h('td', {}, r.rowNo),
        h('td', {}, h('div', { class: 'team' }, r.team || '(no team name)', view.fresh.has(r.key) ? h('span', { class: 'newtag' }, 'NEW') : null), h('div', {}, r.leader || '—')),
        h('td', { class: 'mono' }, r.phone ? '+' + r.phone : '—'),
        h('td', { class: 'mono' }, r.utr || '—'),
        h('td', { class: 'num' }, r.paid ? '₹' + r.paid.toLocaleString('en-IN') : '—'),
        h('td', {}, badge(r), h('div', { class: 'reason' }, r.reason),
          h('button', { class: 'toggle', type: 'button', 'aria-expanded': String(open), onclick: () => { open ? view.open.delete(r.key) : view.open.add(r.key); renderTable(); } }, open ? 'Hide evidence ▲' : 'Show evidence ▼')),
        sentCell,
        h('td', {}, h('label', {}, h('input', { type: 'checkbox', checked: !!f.added, disabled: !ok && !f.added, onchange: (e) => setFlag(r, { added: e.target.checked }) }), ' leader added'),
          showMentor ? h('div', { class: 'mentorbox' }, h('label', {}, h('input', { type: 'checkbox', checked: !!mf.added, onchange: (e) => setMFlag(r, { added: e.target.checked }) }), ' mentor added')) : null),
        h('td', {}, f.note ? h('span', { class: 'small muted' }, '📝 ' + f.note) : null)));
      if (open) body.append(detailRow(r));
    });
  }

  // ---------------- actions ----------------
  function readFile(file) {
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsText(file); });
  }
  function applyText(kind, text, name, resetMaps) {
    const before = new Set(model.results.map((r) => r.key));
    if (kind === 'reg') { S.regText = text; S.regName = name; if (resetMaps) S.regMap = {}; }
    else { S.bankText = text; S.bankName = name; if (resetMaps) { S.bankMap = {}; S.bankHeaderRow = 0; } }
    save(); recompute();
    // tag registrations that were not in the previously loaded data (only meaningful if there was data before)
    if (kind === 'reg') view.fresh = before.size ? new Set(model.results.filter((r) => !before.has(r.key)).map((r) => r.key)) : new Set();
    return view.fresh.size;
  }
  async function handleFile(kind, file) {
    if (!file) return;
    try {
      const added = applyText(kind, await readFile(file), file.name, true);
      renderAll();
      toast((kind === 'reg' ? 'Registrations' : 'Bank statement') + ' loaded: ' + file.name + (added ? ' — ' + added + ' new registration(s) since last time.' : ''));
    } catch (e) { toast('Could not read that file.'); }
  }

  // ---------- watch a file and re-check on a timer (File System Access API; Chrome/Edge) ----------
  const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function renderWatch(kind) {
    const box = $('.watch[data-kind=' + kind + ']'); if (!box) return;
    box.replaceChildren();
    if (!window.showOpenFilePicker) { box.append(h('span', { class: 'hint' }, 'Auto re-check needs Chrome or Edge — use manual upload here.')); return; }
    const w = watchers[kind];
    if (!w) { box.append(h('button', { class: 'btn small', type: 'button', onclick: () => startWatch(kind) }, '👁 Watch a file on this computer…')); return; }
    box.append(h('span', { class: 'on' }, '👁 Watching ' + w.name),
      h('span', { class: 'muted' }, 'last checked ' + hhmm(w.lastChecked) + ' · next ≈ ' + hhmm(w.lastChecked + S.settings.watchMin * 60000)),
      h('button', { class: 'btn small', type: 'button', onclick: () => checkWatch(kind, true) }, 'Check now'),
      h('button', { class: 'btn small', type: 'button', onclick: () => stopWatch(kind) }, 'Stop'));
  }
  async function startWatch(kind) {
    try {
      const [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'], 'text/plain': ['.txt'] } }] });
      stopWatch(kind, true);
      watchers[kind] = { handle, name: handle.name, lastMod: -1, size: -1, lastChecked: Date.now(), timer: null, first: true };
      await checkWatch(kind, true);
      scheduleWatch(kind);
    } catch (e) { if (e && e.name !== 'AbortError') toast('Could not open that file for watching.'); }
  }
  function scheduleWatch(kind) {
    const w = watchers[kind]; if (!w) return;
    clearInterval(w.timer);
    w.timer = setInterval(() => checkWatch(kind, false), Math.max(1, Number(S.settings.watchMin) || 15) * 60000);
  }
  function stopWatch(kind, silent) {
    const w = watchers[kind]; if (!w) return;
    clearInterval(w.timer); watchers[kind] = null; renderWatch(kind);
    if (!silent) toast('Stopped watching.');
  }
  const countCode = (c) => model.results.filter((r) => eff(r).code === c).length;
  async function checkWatch(kind, force) {
    const w = watchers[kind]; if (!w) return;
    try {
      const file = await w.handle.getFile();
      w.lastChecked = Date.now();
      if (force || file.lastModified !== w.lastMod || file.size !== w.size) {
        const changed = file.lastModified !== w.lastMod || file.size !== w.size;
        w.lastMod = file.lastModified; w.size = file.size;
        const verifiedBefore = countCode('VERIFIED');
        const add = applyText(kind, await readFile(file), file.name, w.first);
        const first = w.first; w.first = false;
        if (first) { renderAll(); toast('Watching ' + file.name + ' — re-checked every ' + S.settings.watchMin + ' min.' + (add ? ' ' + add + ' new registration(s) since last time.' : '')); }
        else if (changed) {
          render();
          const ver = countCode('VERIFIED') - verifiedBefore;
          toast(kind === 'reg' ? (add ? add + ' new registration(s) found.' : 'Registrations file updated.') : 'Bank file updated' + (ver > 0 ? ' — ' + ver + ' more team(s) now verified.' : '.'));
        }
      }
    } catch (e) { toast('Lost access to the watched file — pick it again.'); stopWatch(kind, true); }
    renderWatch(kind);
  }
  function wireDrop(id, inputId, kind) {
    const el = $(id), inp = $(inputId);
    inp.addEventListener('change', () => { handleFile(kind, inp.files[0]); inp.value = ''; });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } });
    ['dragenter', 'dragover'].forEach((t) => el.addEventListener(t, (e) => { e.preventDefault(); el.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => el.addEventListener(t, (e) => { e.preventDefault(); el.classList.remove('over'); }));
    el.addEventListener('drop', (e) => handleFile(kind, e.dataTransfer.files[0]));
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext !== false) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    fallbackCopy(text); return Promise.resolve();
  }
  function fallbackCopy(text) {
    const t = h('textarea', { style: 'position:fixed;opacity:0' }); t.value = text; document.body.append(t); t.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ } t.remove();
  }

  const csvCell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function exportCsv() {
    const head = ['Team', 'Leader', 'Phone', 'UTR', 'Paid', 'Status', 'Reason', 'Invite sent', 'Added to group', 'Bank evidence', 'Note'];
    const lines = [head.map(csvCell).join(',')];
    model.results.forEach((r) => {
      const f = flag(r), e = eff(r);
      lines.push([r.team, r.leader, r.phone ? '+' + r.phone : '', r.utr, r.paid || '', LABEL[e.code][0].replace(/^\S+\s/, '') + (e.manual ? ' (manual)' : ''), r.reason,
        f.sent ? new Date(f.sent).toISOString() : '', f.added ? 'yes' : '', r.bankMatches.map((m) => 'row ' + m.rowNo + ': ' + m.text).join(' | '), f.note || ''].map(csvCell).join(','));
    });
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' })), download: 'registration_status.csv' });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  const fmtTime = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  function exportXlsx() {
    const rs = model.results;
    if (!rs.length) { toast('Nothing to export yet.'); return; }
    const st = (r) => { const e = eff(r); return LABEL[e.code][0].replace(/^\S+\s/, '') + (e.manual ? ' (manual)' : ''); };
    const ev = (r) => r.bankMatches.map((m) => 'row ' + m.rowNo + (m.date ? ' (' + m.date + ')' : '') + ': ' + m.text).join(' | ');
    const n = (f) => rs.filter(f).length, code = (r) => eff(r).code;
    const summary = [
      ['Registration report', ''],
      ['Generated', fmtTime(Date.now())],
      ['Registrations file', S.regName], ['Bank statement file', S.bankName],
      ['Fee per team', Number(S.settings.fee) || 0],
      ['', ''],
      ['Total registrations', rs.length],
      ['Verified', n((r) => code(r) === 'VERIFIED')],
      ['Pending (payment not found)', n((r) => code(r) === 'PENDING')],
      ['Underpaid', n((r) => code(r) === 'UNDERPAID')],
      ['Duplicate / needs review / rejected', n((r) => ['DUPLICATE', 'REVIEW', 'REJECTED'].includes(code(r)))],
      ['Invites sent', n((r) => flag(r).sent)],
      ['Added to group', n((r) => flag(r).added)],
      ['Verified but not yet invited', n((r) => isOk(r) && !flag(r).sent)],
      ['Faculty mentors invited', uniqueMentors((r) => mflag(r).sent).length],
      ['Faculty mentors still to invite', uniqueMentors((r) => !mflag(r).sent).length],
    ];
    summary[0].bold = true;
    const all = [['#', 'Team', 'Institution', 'City', 'Leader', 'Phone', 'Team size', 'UTR', 'Paid (₹)', 'Status', 'Reason', 'Invite sent at', 'Added to group', 'Bank evidence', 'Payment proof', 'Mentor', 'Mentor phone', 'Mentor invite sent at', 'Note']];
    rs.forEach((r) => all.push([r.rowNo, r.team, r.institution, r.city, r.leader, r.phone ? '+' + r.phone : '', r.teamSize || '', r.utr, r.paid || '', st(r), r.reason, fmtTime(flag(r).sent), flag(r).added ? 'Yes' : '', ev(r), r.proof, r.mentorName, r.mentorPhone ? '+' + r.mentorPhone : '', r.mentorPhone ? fmtTime(mflag(r).sent) : '', flag(r).note || '']));
    const mentorsMap = new Map();
    rs.forEach((r) => {
      if (!r.mentorPhone) return;
      const m = mentorsMap.get(r.mentorPhone) || { r, teams: [], eligible: false };
      m.teams.push(r.team + (isOk(r) ? '' : ' (not verified)')); m.eligible = m.eligible || isOk(r);
      mentorsMap.set(r.mentorPhone, m);
    });
    const mentors = [['Mentor', 'Phone', 'Email', 'Institution', 'Teams', 'Eligible (a team is verified)', 'Invite sent at', 'Added to group']];
    mentorsMap.forEach((m, ph) => mentors.push([m.r.mentorName, '+' + ph, m.r.mentorEmail, m.r.institution, m.teams.join('; '), m.eligible ? 'Yes' : 'No', fmtTime(S.flags['M|' + ph] && S.flags['M|' + ph].sent), S.flags['M|' + ph] && S.flags['M|' + ph].added ? 'Yes' : '']));
    const invited = [['Team', 'Institution', 'Leader', 'Phone', 'Invite sent at', 'Added to group', 'Paid (₹)']];
    rs.filter((r) => flag(r).sent).sort((a, b) => flag(a).sent - flag(b).sent)
      .forEach((r) => invited.push([r.team, r.institution, r.leader, r.phone ? '+' + r.phone : '', fmtTime(flag(r).sent), flag(r).added ? 'Yes' : 'No', r.paid || '']));
    const todo = [['Team', 'Institution', 'Leader', 'Phone', 'Status', 'What to do', 'Payment proof']];
    rs.filter((r) => !isOk(r)).forEach((r) => todo.push([r.team, r.institution, r.leader, r.phone ? '+' + r.phone : '', st(r), r.reason, r.proof]));
    const bytes = Xlsx.build([
      { name: 'Summary', rows: summary, widths: [38, 34] },
      { name: 'All teams', rows: all, header: true },
      { name: 'Invited', rows: invited, header: true },
      { name: 'Mentors', rows: mentors, header: true },
      { name: 'Needs action', rows: todo, header: true },
    ]);
    const a = h('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })), download: 'registration_report_' + new Date().toISOString().slice(0, 10) + '.xlsx' });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Excel report downloaded.');
  }

  function init() {
    load(); recompute(); renderAll();
    wireDrop('#dropReg', '#fileReg', 'reg'); wireDrop('#dropBank', '#fileBank', 'bank');

    const bindNum = (id, key) => $(id).addEventListener('input', (e) => { S.settings[key] = e.target.value; save(); recompute(); render(); });
    bindNum('#setFee', 'fee'); bindNum('#setMax', 'maxTeam'); bindNum('#setCC', 'cc');
    $('#setInvite').addEventListener('input', (e) => { S.settings.invite = e.target.value; save(); render(); });
    $('#setTemplate').addEventListener('input', (e) => { S.settings.template = e.target.value; save(); });
    $('#setMentorTemplate').addEventListener('input', (e) => { S.settings.mentorTemplate = e.target.value; save(); });
    $('#chkMentors').addEventListener('change', (e) => { S.settings.mentors = e.target.checked; if (!e.target.checked && view.filter === 'MTODO') view.filter = 'ALL'; save(); render(); });
    document.querySelectorAll('input[name=mode]').forEach((i) => i.addEventListener('change', () => { if (i.checked) { S.settings.mode = i.value; save(); render(); } }));
    $('#chkRemember').addEventListener('change', (e) => {
      S.settings.remember = e.target.checked;
      if (!e.target.checked) { try { localStorage.removeItem(LS_KEY); } catch (x) { /* ignore */ } }
      save(); toast(e.target.checked ? 'Files & progress will be remembered in this browser.' : 'Saved data removed. Nothing is kept after you close this tab.');
    });
    $('#search').addEventListener('input', (e) => { view.q = e.target.value; renderTable(); });

    $('#btnSample').addEventListener('click', () => {
      S.regText = window.SAMPLES.reg; S.regName = 'nacdec_form_responses_sample.csv'; S.regMap = {};
      S.bankText = window.SAMPLES.bank; S.bankName = 'nacdec_bank_statement_sample.csv'; S.bankMap = {}; S.bankHeaderRow = 0;
      S.flags = {}; save(); recompute(); renderAll(); toast('Sample (fake) data loaded.');
    });
    $('#btnQueue').addEventListener('click', () => {
      const next = pendingContacts()[0];
      if (!next) return;
      if (inviteMissing()) { toast('Paste the WhatsApp group invite link in step 3 first.'); return; }
      const mentor = next.who === 'mentor';
      window.open(linkFor(next.r, next.who), '_blank', 'noopener,noreferrer');
      (mentor ? setMFlag : setFlag)(next.r, { sent: Date.now() });
      toast('Opened chat for ' + (mentor ? 'mentor ' + (next.r.mentorName || '') + ' (' + next.r.team + ')' : (next.r.leader || next.r.team)) + '. Press Send in WhatsApp, then click again for the next one.');
    });
    $('#btnCopyList').addEventListener('click', () => {
      const lines = model.results.filter((r) => isOk(r) && !flag(r).added)
        .map((r) => '+' + r.phone + '\t' + (r.leader || '') + '\t' + (r.team || '') + '\tLeader');
      uniqueMentors((r) => !mflag(r).added).forEach((r) => lines.push('+' + r.mentorPhone + '\t' + (r.mentorName || '') + '\t' + (r.team || '') + '\tMentor'));
      const list = lines.join('\n');
      if (!list) { toast('Nobody verified is waiting to be added.'); return; }
      copyText(list); toast('Copied. Use it to approve join requests / add people.');
    });
    $('#btnExport').addEventListener('click', exportCsv);
    $('#btnXlsx').addEventListener('click', exportXlsx);
    $('#setWatch').value = String(S.settings.watchMin);
    $('#setWatch').addEventListener('change', (e) => { S.settings.watchMin = Number(e.target.value); save(); ['reg', 'bank'].forEach((k) => { scheduleWatch(k); renderWatch(k); }); });
    ['reg', 'bank'].forEach(renderWatch);
    $('#btnClear').addEventListener('click', () => {
      if (!confirm('Delete all uploaded data, statuses and settings from this browser?')) return;
      try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
      S = defaults(); view.filter = 'ALL'; view.q = ''; view.open.clear(); $('#search').value = '';
      view.fresh.clear(); ['reg', 'bank'].forEach((k) => stopWatch(k, true)); $('#setWatch').value = String(S.settings.watchMin);
      recompute(); renderAll(); toast('Everything cleared.');
    });
  }
  init();
})();
