/*
 * app.js — UI. No network calls anywhere (and the page's CSP forbids them).
 * Everything is stored in this browser's localStorage, only if "Remember" is ticked.
 */
(function () {
  'use strict';
  const C = window.Core;
  const LS_KEY = 'regverifier.v1';
  const DEFAULT_TEMPLATE = 'Hi {leader}, your team "{team}" is registered ✅ Please join the participants group: {invite}';

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
    settings: { fee: 8000, maxTeam: 5, cc: '91', mode: 'invite', invite: '', template: DEFAULT_TEMPLATE, remember: true, watchMin: 15 },
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
      const g = C.guessReg(model.regT.headers), m = S.regMap || {};
      for (const k of Object.keys(g)) if (m[k] === undefined || (m[k] && !model.regT.headers.includes(m[k]))) m[k] = g[k];
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

  // ---------------- links ----------------
  function messageFor(r) {
    return (S.settings.template || DEFAULT_TEMPLATE)
      .replace(/\{leader\}/g, r.leader || 'there').replace(/\{team\}/g, r.team || 'your team').replace(/\{invite\}/g, S.settings.invite || '');
  }
  function linkFor(r) {
    if (!r.phone) return '';
    return S.settings.mode === 'invite' ? 'https://wa.me/' + r.phone + '?text=' + encodeURIComponent(messageFor(r)) : 'https://wa.me/' + r.phone;
  }
  const inviteMissing = () => S.settings.mode === 'invite' && !/^https:\/\/chat\.whatsapp\.com\/\S+/.test(S.settings.invite.trim());

  function openChat(r) {
    if (!isOk(r) || !r.phone) return;
    if (inviteMissing()) { toast('Paste the WhatsApp group invite link in step 3 first.'); return; }
    if (flag(r).sent && !confirm('An invite was already marked as sent to ' + (r.leader || r.team) + '. Send again?')) return;
    window.open(linkFor(r), '_blank', 'noopener,noreferrer');
    setFlag(r, { sent: Date.now() });
  }

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
      const f = [['team', 'Team name', 1], ['leader', 'Leader name', 1], ['phone', 'Leader WhatsApp no. *', 0], ['email', 'Email', 1], ['utr', 'UTR / transaction ID *', 0], ['members', 'Team members', 1]];
      f.forEach(([k, label, opt]) => {
        mr.append(h('label', {}, label), select(model.regT.headers, S.regMap[k], (v) => { S.regMap[k] = v; save(); recompute(); render(); }, !!opt));
      });
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
    const bar = $('#statsBar'); bar.replaceChildren();
    items.forEach(([k, label, count, cls]) => bar.append(h('button', {
      class: 'chip ' + cls, type: 'button', 'aria-pressed': String(view.filter === k),
      onclick: () => { view.filter = k; render(); },
    }, label, h('b', {}, count))));
    const q = $('#btnQueue'), left = n((r) => isOk(r) && r.phone && !flag(r).sent);
    q.disabled = left === 0;
    q.textContent = left ? 'Send to next verified leader ▶ (' + left + ' left)' : 'No verified leaders waiting';
    const qi = $('#queueInfo');
    qi.className = 'msg';
    if (inviteMissing()) { qi.classList.add('warn'); qi.textContent = 'Invite-message mode is on but no valid group invite link is set (step 3). Buttons stay disabled until you add it.'; }
    else qi.textContent = '';
  }

  function matches(r) {
    const c = eff(r).code, f = flag(r), F = view.filter;
    const okFilter = F === 'ALL' || (F === 'ATTN' ? ['DUPLICATE', 'REVIEW', 'REJECTED'].includes(c)
      : F === 'TODO' ? c === 'VERIFIED' && !f.sent : F === 'SENT' ? !!f.sent : F === 'ADDED' ? !!f.added : c === F);
    if (!okFilter) return false;
    const q = view.q.trim().toLowerCase();
    if (!q) return true;
    return [r.team, r.leader, r.phoneRaw, r.phone, r.utrRaw, r.utr, r.email].join(' ').toLowerCase().includes(q);
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
      r.members ? h('div', {}, 'Members (' + r.teamSize + '): ', r.members) : null);
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
      link ? h('div', { class: 'linkline' }, 'wa.me link: ', h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', class: 'mono' }, link)) : null,
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
      const sentCell = h('td', {},
        ok && r.phone ? h('button', { class: 'btn small primary', type: 'button', disabled: inviteMissing(), onclick: () => openChat(r) }, f.sent ? 'Resend' : (S.settings.mode === 'invite' ? 'Send invite' : 'Open chat')) : null,
        h('div', { class: 'small' }, h('label', {}, h('input', { type: 'checkbox', checked: !!f.sent, disabled: !ok && !f.sent, onchange: (e) => setFlag(r, { sent: e.target.checked ? Date.now() : null }) }), ' sent', f.sent ? ' ' + new Date(f.sent).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '')));
      body.append(h('tr', { class: 'main' },
        h('td', {}, r.rowNo),
        h('td', {}, h('div', { class: 'team' }, r.team || '(no team name)', view.fresh.has(r.key) ? h('span', { class: 'newtag' }, 'NEW') : null), h('div', {}, r.leader || '—')),
        h('td', { class: 'mono' }, r.phone ? '+' + r.phone : '—'),
        h('td', { class: 'mono' }, r.utr || '—'),
        h('td', { class: 'num' }, r.paid ? '₹' + r.paid.toLocaleString('en-IN') : '—'),
        h('td', {}, badge(r), h('div', { class: 'reason' }, r.reason),
          h('button', { class: 'toggle', type: 'button', 'aria-expanded': String(open), onclick: () => { open ? view.open.delete(r.key) : view.open.add(r.key); renderTable(); } }, open ? 'Hide evidence ▲' : 'Show evidence ▼')),
        sentCell,
        h('td', {}, h('label', {}, h('input', { type: 'checkbox', checked: !!f.added, disabled: !ok && !f.added, onchange: (e) => setFlag(r, { added: e.target.checked }) }), ' added')),
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
    ];
    summary[0].bold = true;
    const all = [['#', 'Team', 'Leader', 'Phone', 'UTR', 'Paid (₹)', 'Status', 'Reason', 'Invite sent at', 'Added to group', 'Bank evidence', 'Note']];
    rs.forEach((r) => all.push([r.rowNo, r.team, r.leader, r.phone ? '+' + r.phone : '', r.utr, r.paid || '', st(r), r.reason, fmtTime(flag(r).sent), flag(r).added ? 'Yes' : '', ev(r), flag(r).note || '']));
    const invited = [['Team', 'Leader', 'Phone', 'Invite sent at', 'Added to group', 'Paid (₹)']];
    rs.filter((r) => flag(r).sent).sort((a, b) => flag(a).sent - flag(b).sent)
      .forEach((r) => invited.push([r.team, r.leader, r.phone ? '+' + r.phone : '', fmtTime(flag(r).sent), flag(r).added ? 'Yes' : 'No', r.paid || '']));
    const todo = [['Team', 'Leader', 'Phone', 'Status', 'What to do']];
    rs.filter((r) => !isOk(r)).forEach((r) => todo.push([r.team, r.leader, r.phone ? '+' + r.phone : '', st(r), r.reason]));
    const bytes = Xlsx.build([
      { name: 'Summary', rows: summary, widths: [38, 34] },
      { name: 'All teams', rows: all, header: true },
      { name: 'Invited', rows: invited, header: true },
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
    document.querySelectorAll('input[name=mode]').forEach((i) => i.addEventListener('change', () => { if (i.checked) { S.settings.mode = i.value; save(); render(); } }));
    $('#chkRemember').addEventListener('change', (e) => {
      S.settings.remember = e.target.checked;
      if (!e.target.checked) { try { localStorage.removeItem(LS_KEY); } catch (x) { /* ignore */ } }
      save(); toast(e.target.checked ? 'Files & progress will be remembered in this browser.' : 'Saved data removed. Nothing is kept after you close this tab.');
    });
    $('#search').addEventListener('input', (e) => { view.q = e.target.value; renderTable(); });

    $('#btnSample').addEventListener('click', () => {
      S.regText = window.SAMPLES.reg; S.regName = 'sample_registrations.csv'; S.regMap = {};
      S.bankText = window.SAMPLES.bank; S.bankName = 'sample_bank_statement.csv'; S.bankMap = {}; S.bankHeaderRow = 0;
      S.flags = {}; save(); recompute(); renderAll(); toast('Sample (fake) data loaded.');
    });
    $('#btnQueue').addEventListener('click', () => {
      const next = model.results.find((r) => isOk(r) && r.phone && !flag(r).sent);
      if (!next) return;
      if (inviteMissing()) { toast('Paste the WhatsApp group invite link in step 3 first.'); return; }
      window.open(linkFor(next), '_blank', 'noopener,noreferrer');
      setFlag(next, { sent: Date.now() });
      toast('Opened chat for ' + (next.leader || next.team) + '. Press Send in WhatsApp, then click again for the next one.');
    });
    $('#btnCopyList').addEventListener('click', () => {
      const list = model.results.filter((r) => isOk(r) && !flag(r).added)
        .map((r) => '+' + r.phone + '\t' + (r.leader || '') + '\t' + (r.team || '')).join('\n');
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
