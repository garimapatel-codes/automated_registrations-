/* app.js — Invite Desk UI. Everything runs in this browser tab; the only data store is the encrypted vault (see vault.js). */
(function () {
  'use strict';
  const { Core, Vault, Ocr, Xlsx, Statement } = window;
  const S = Core.STATUS, ST = Core.STATUS_TEXT;
  const root = document.getElementById('root');

  // ---------- tiny DOM helper (text only — never innerHTML with data) ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'for') el.htmlFor = v;
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'multiple' || k === 'hidden') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (c) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.appendChild(c.nodeType ? c : document.createTextNode(String(c))); };
    kids.forEach(add);
    return el;
  }
  const ICONS = {
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.4c2.3.6 3.5 2.6 3.5 5.6"/>',
    send: '<path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
    log: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    bank: '<path d="M3 10l9-6 9 6"/><path d="M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    download: '<path d="M12 3v12M7 11l5 5 5-5M4 20h16"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  };
  const icon = (n) => { const s = document.createElement('span'); s.style.display = 'contents'; s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[n] + '</svg>'; return s.firstChild; };

  // ---------- state ----------
  let state = null, derived = null, vault = null, saveTimer = null, lastActive = Date.now(), unlockFails = 0, lockedUntil = 0;
  const ui = { view: 'dash', q: '', scope: 'teams', filter: 'all', payFilter: 'all', expanded: new Set(), ocr: null, tab: 'file', cooldownUntil: 0, openedAtMs: 0, busy: false };
  const storageOk = (() => { try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return true; } catch (e) { return false; } })();

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (state) vault.save(state).catch((e) => toast('Could not save: ' + e.message, true)); }, 200);
  }
  function commit() { save(); derived = Core.compute(state); renderNav(); renderContent(); }
  function flushSave() { clearTimeout(saveTimer); return state ? vault.save(state) : Promise.resolve(); }

  // ---------- toasts & dialogs ----------
  let toastBox = null;
  function toast(msg, bad) {
    if (!toastBox) { toastBox = h('div', { class: 'toasts' }); document.body.appendChild(toastBox); }
    const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
    toastBox.appendChild(t); setTimeout(() => t.remove(), bad ? 7000 : 4200);
  }
  /** opts: {title, body, confirm, danger, inputs:[{label,type,value,hint}] , cancel:false} -> Promise(null | values[]) */
  function ask(opts) {
    return new Promise((resolve) => {
      const inputs = (opts.inputs || []).map((i) => h('input', { type: i.type || 'text', value: i.value || '', placeholder: i.placeholder || '', autocomplete: 'off' }));
      const done = (v) => { veil.remove(); resolve(v); };
      const ok = h('button', { class: 'btn' + (opts.danger ? ' danger' : ''), onclick: () => done(inputs.map((i) => i.value)) }, opts.confirm || 'OK');
      const veil = h('div', { class: 'veil', onkeydown: (e) => { if (e.key === 'Escape') done(null); if (e.key === 'Enter' && inputs.length) ok.click(); } },
        h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
          h('h2', null, opts.title), opts.body ? h('p', { class: 'muted' }, opts.body) : null,
          (opts.inputs || []).map((i, n) => h('div', { class: 'field', style: null }, h('label', { class: 'f' }, i.label), inputs[n], i.hint ? h('div', { class: 'hint' }, i.hint) : null)),
          h('div', { class: 'acts' }, opts.cancel === false ? null : h('button', { class: 'btn ghost', onclick: () => done(null) }, 'Cancel'), ok)));
      document.body.appendChild(veil);
      (inputs[0] || ok).focus();
    });
  }
  const confirmBox = (title, body, confirm, danger) => ask({ title, body, confirm, danger }).then((v) => v !== null);

  function download(data, name, type) {
    const url = URL.createObjectURL(new Blob([data], { type: type || 'application/octet-stream' }));
    const a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const csvCell = (v) => { v = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
  const day = () => Core.todayKey();

  // ---------- lock / unlock ----------
  function lockScreen() {
    const first = !vault.exists();
    const pass = h('input', { type: 'password', autocomplete: first ? 'new-password' : 'current-password', placeholder: first ? 'Create a passphrase (10+ characters)' : 'Passphrase' });
    const pass2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Type it again' });
    const understand = h('input', { type: 'checkbox' });
    const msg = h('p', { class: 'small', role: 'alert' });
    const btn = h('button', { class: 'btn pink', type: 'button' }, first ? 'Create my private desk' : 'Unlock');
    const setMsg = (t) => { msg.textContent = t; };
    async function go() {
      if (!storageOk) return setMsg('This browser is blocking local storage (private window?). Open the site in a normal window.');
      if (first) {
        if (pass.value.length < 10) return setMsg('Use at least 10 characters.');
        if (pass.value !== pass2.value) return setMsg('The two passphrases do not match.');
        if (!understand.checked) return setMsg('Please tick the box to confirm you understand.');
        btn.disabled = true; setMsg('Creating…');
        state = Core.newState();
        try { await vault.setup(pass.value, state); } catch (e) { state = null; btn.disabled = false; return setMsg('Failed: ' + e.message); }
        enter();
      } else {
        const wait = Math.ceil((lockedUntil - Date.now()) / 1000);
        if (wait > 0) return setMsg('Too many wrong tries. Wait ' + wait + 's.');
        btn.disabled = true; setMsg('Unlocking…');
        try { state = await vault.unlock(pass.value); unlockFails = 0; enter(); }
        catch (e) {
          btn.disabled = false; unlockFails++;
          if (unlockFails >= 3) lockedUntil = Date.now() + Math.min(60, 2 ** (unlockFails - 2)) * 1000;
          setMsg(e.code === 'BAD_PASS' ? 'Wrong passphrase.' : 'Could not open: ' + e.message);
        }
      }
    }
    btn.addEventListener('click', go);
    [pass, pass2].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }));
    const restoreIn = h('input', { type: 'file', class: 'sr', accept: '.idbackup,.json,.txt', onchange: async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      const vals = await ask({ title: 'Restore a backup', body: 'Enter the passphrase that was used when the backup was made. This replaces any data in this browser.', confirm: 'Restore', inputs: [{ label: 'Backup passphrase', type: 'password' }] });
      if (!vals) return;
      try { state = await vault.restore(await f.text(), vals[0]); toast('Backup restored.'); enter(); } catch (err) { toast(err.message, true); }
    } });
    return h('div', { class: 'lock' }, h('div', { class: 'lockcard' },
      h('div', { class: 'brand' }, 'invite desk', h('i')),
      h('h1', null, first ? 'Welcome 👋' : 'Welcome back'),
      h('p', { class: 'muted', style: null }, first
        ? 'Everything you load here is encrypted with a passphrase and kept only in this browser. Nothing is uploaded anywhere.'
        : 'Enter your passphrase to open your desk.'),
      h('div', { class: 'field' }),
      pass, first ? h('div', { class: 'field' }) : null, first ? pass2 : null,
      first ? h('div', { class: 'field' }) : null,
      first ? h('label', { class: 'chk' }, understand, h('span', { class: 'small' }, 'I understand that nobody can recover this passphrase. If I forget it, I will need a backup or to start over.')) : null,
      h('div', { class: 'field' }), h('div', { class: 'row' }, btn, h('div', { class: 'grow' })), msg,
      h('div', { class: 'field' }),
      h('div', { class: 'row wrap xs muted' },
        h('button', { class: 'pill', type: 'button', onclick: () => restoreIn.click() }, 'Restore from backup'), restoreIn,
        !first ? h('button', { class: 'pill', type: 'button', onclick: async () => {
          const v = await ask({ title: 'Erase everything?', body: 'This permanently deletes all data in this browser, including the list of who was invited. Type ERASE to confirm.', confirm: 'Erase', danger: true, inputs: [{ label: 'Type ERASE' }] });
          if (v && v[0] === 'ERASE') { vault.wipe(); location.reload(); }
        } }, 'Erase all data') : null)));
  }

  function enter() { Core.migrate(state); ui.view = 'dash'; ui.q = ''; derived = Core.compute(state); lastActive = Date.now(); render(); }
  async function lock(why) {
    await flushSave().catch(() => {});
    await Ocr.stop(); vault.lock(); state = null; derived = null; ui.ocr = null; ui.expanded.clear();
    render(); if (why) toast(why);
  }

  // ---------- shell ----------
  const NAV = [['dash', 'Dashboard', 'home'], ['teams', 'Teams', 'users'], ['send', 'Send invites', 'send'], ['sent', 'Sent log', 'log'], ['pay', 'Payments', 'bank'], ['settings', 'Settings', 'gear']];
  let navEl = null, contentEl = null;
  function render() {
    if (!state) { root.replaceChildren(lockScreen()); return; }
    navEl = h('nav', { class: 'side', 'aria-label': 'Main' });
    contentEl = h('div', { class: 'content', id: 'content' });
    const search = h('input', { type: 'text', placeholder: 'Search teams, people, payments…', value: ui.q, 'aria-label': 'Search', oninput: (e) => { ui.q = e.target.value; renderContent(); } });
    const scopes = [['teams', 'Teams'], ['sent', 'Sent'], ['pay', 'Payments']];
    const pills = h('div', { class: 'pills' }, 'In:', scopes.map(([k, l]) => h('button', { class: 'pill' + (ui.scope === k ? ' on' : ''), type: 'button', onclick: (e) => {
      ui.scope = k; ui.view = k; ui.filter = 'all'; ui.payFilter = 'all'; pills.querySelectorAll('.pill').forEach((p) => p.classList.remove('on')); e.target.classList.add('on'); renderNav(); renderContent();
    } }, l)));
    const top = h('div', { class: 'top' },
      h('div', { class: 'search' }, h('button', { class: 'go', type: 'button', 'aria-label': 'Search', onclick: () => search.focus() }, icon('search')), search, pills),
      h('button', { class: 'round', title: 'Lock now', 'aria-label': 'Lock now', onclick: () => lock('Locked.') }, icon('lock')),
      h('button', { class: 'round', title: 'Settings', 'aria-label': 'Settings', onclick: () => go('settings') }, icon('gear')));
    root.replaceChildren(h('div', { class: 'shell' }, navEl, h('main', { class: 'main' }, top, contentEl)));
    renderNav(); renderContent();
  }
  function go(view) { ui.view = view; if (view !== 'teams' && view !== 'sent' && view !== 'pay') ui.q = ''; ui.filter = 'all'; renderNav(); renderContent(); window.scrollTo(0, 0); }
  function renderNav() {
    if (!navEl || !derived) return;
    const q = Core.queue(derived).length;
    const items = NAV.map(([k, l, ic]) => h('button', { class: 'nav' + (ui.view === k ? ' on' : ''), onclick: () => go(k) }, icon(ic), l,
      k === 'send' && q ? h('span', { class: 'count' }, q) : null, k === 'sent' && state.ledger.length ? h('span', { class: 'count' }, state.ledger.length) : null));
    navEl.replaceChildren(h('div', { class: 'brand' }, 'invite desk', h('i')), h('div', { class: 'label' }, 'Workspace'), ...items,
      h('div', { class: 'spacer' }),
      h('div', { class: 'note' }, '🔒 Encrypted in this browser. Auto-locks after ' + (state.settings.autoLockMin || 'never') + ' min idle.'));
  }
  function renderContent() {
    if (!contentEl || !state) return;
    const views = { dash: dashView, teams: teamsView, send: sendView, sent: sentView, pay: payView, settings: settingsView };
    contentEl.replaceChildren(views[ui.view]());
  }

  // ---------- shared pieces ----------
  const chipClass = (s) => ({ VERIFIED: 'ok', APPROVED: 'info', AWAITING: 'info', NOSTMT: 'info', SHORT: 'warn', CHECK: 'warn', NOFEE: 'warn', NOMATCH: 'warn', DUPLICATE: 'bad', FIX: 'bad' }[s] || 'mute');
  const statusChip = (t) => h('span', { class: 'chip ' + chipClass(t.status), title: t.reason }, ST[t.status]);
  const empty = (title, text, btn) => h('div', { class: 'card white empty' }, h('h3', null, title), h('p', null, text), btn ? h('div', { class: 'field' }) : null, btn || null);
  const matches = (q, ...parts) => !q || parts.join(' ').toLowerCase().includes(q.toLowerCase());
  const head = (title, sub, ...actions) => h('div', { class: 'sec-h wrap' }, h('div', { class: 'grow' }, h('h1', null, title), sub ? h('p', { class: 'muted' }, sub) : null), actions);

  // ---------- data loading ----------
  async function loadCsvFile(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return toast('That file is over 8 MB — is it the right one?', true);
    const text = await file.text();
    if (/^%PDF/.test(text)) return toast('That is a PDF. Registrations need a CSV (File ▸ Download ▸ .csv in Google Sheets). Bank statements go on the Payments page.', true);
    const table = Core.toTable(Core.parseCSV(text));
    if (table.headers.length < 3 || !table.rows.length) return toast('This CSV looks empty or is not a registrations export.', true);
    const r = Core.loadRegistrations(state, table, 'file', file.name);
    commit();
    if (derived.needsMapping.length) toast('Loaded, but I could not find: ' + derived.needsMapping.join(', ') + '. Pick the columns below.', true);
    else toast(`Loaded ${r.total} registrations` + (r.added ? ` — ${r.added} new` : '') + '.');
  }
  async function refreshSheet() {
    const url = Core.sheetCsvUrl(state.settings.sheetUrl);
    if (!url) return toast('Paste a Google Sheets link first (a “Publish to web ▸ CSV” link works best).', true);
    ui.busy = true; renderContent();
    try {
      const res = await fetch(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error('Google answered ' + res.status + '. Is the sheet shared/published?');
      const text = await res.text();
      if (/^\s*</.test(text)) throw new Error('Google sent a web page instead of data. Publish the sheet to the web as CSV, or set sharing to “anyone with the link”.');
      const table = Core.toTable(Core.parseCSV(text));
      if (table.headers.length < 3 || !table.rows.length) throw new Error('The sheet came back empty.');
      const r = Core.loadRegistrations(state, table, 'sheet', 'Google Sheet');
      ui.busy = false; commit();
      toast(`Refreshed: ${r.total} registrations` + (r.added ? ` — ${r.added} new` : ' — nothing new') + '.');
    } catch (e) { ui.busy = false; renderContent(); toast(e.message.includes('Failed to fetch') ? 'Could not reach Google (blocked, offline, or the sheet is private).' : e.message, true); }
  }
  function paintOcr() {
    const el = document.getElementById('ocr-status'); if (!el) return;
    el.querySelector('p').textContent = ui.ocr ? ui.ocr.msg : '';
    const pr = el.querySelector('progress'); if (pr) pr.value = ui.ocr ? ui.ocr.frac : 0;
  }
  async function addPdfs(files) {
    files = Array.from(files || []); if (!files.length) return;
    if (ui.ocr) return toast('Still reading the previous file.', true);
    const sup = Ocr.supported(); if (!sup.ok) return toast(sup.why, true);
    for (const f of files) {
      if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { toast(f.name + ' is not a PDF.', true); continue; }
      if (f.size > 60 * 1024 * 1024) { toast(f.name + ' is too large.', true); continue; }
      if (state.pdfs.some((p) => p.name === f.name && p.size === f.size)) { toast(f.name + ' is already loaded.', true); continue; }
      ui.ocr = { msg: 'Opening ' + f.name + '…', frac: 0, name: f.name }; renderContent(); paintOcr();
      try {
        const pages = await Ocr.readPdf(f, (m, fr) => { ui.ocr.msg = f.name + ' — ' + m; if (fr != null) ui.ocr.frac = fr; paintOcr(); },
          async (m) => { const v = await ask({ title: 'PDF password', body: m, confirm: 'Open', inputs: [{ label: 'Password', type: 'password' }] }); return v ? v[0] : null; });
        const parsed = Statement.parseStatement(pages);
        if (!parsed.credits.length) throw new Error('No credit (money received) rows were found in ' + f.name + '. This reader expects a bank statement with Date, Narration, Debit, Credit and Balance columns.');
        const r = Core.addStatement(state, { id: 'S' + Date.now().toString(36), name: f.name, size: f.size }, parsed);
        ui.ocr = null; commit();
        toast(`${f.name}: ${parsed.credits.length} credits read (${r.added} new).` + (parsed.chainBad ? ` ${parsed.chainBad} row(s) failed the balance check — review them on this page.` : ''), !!parsed.chainBad);
      } catch (e) { ui.ocr = null; renderContent(); toast(e.message, true); }
    }
  }

  function sourcePanel() {
    const reg = state.reg, s = state.settings;
    const fileIn = h('input', { type: 'file', class: 'sr', accept: '.csv,text/csv', onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; loadCsvFile(f); } });
    const drop = h('div', { class: 'drop', tabindex: '0', role: 'button', onclick: () => fileIn.click(), onkeydown: (e) => { if (e.key === 'Enter') fileIn.click(); },
      ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); loadCsvFile(e.dataTransfer.files[0]); } },
      h('b', null, reg ? 'Drop the updated CSV here' : 'Drop your registrations CSV here'), h('div', { class: 'small muted' }, 'or click to choose — new teams are added, nobody already invited is ever re-invited'), fileIn);
    const urlIn = h('input', { type: 'url', placeholder: 'https://docs.google.com/spreadsheets/d/…', value: s.sheetUrl || '', 'aria-label': 'Google Sheet link' });
    const sheet = h('div', null,
      h('div', { class: 'row' }, urlIn,
        h('button', { class: 'btn', disabled: ui.busy, onclick: () => { s.sheetUrl = urlIn.value.trim(); if (!Core.sheetCsvUrl(s.sheetUrl)) return toast('That is not a Google Sheets link.', true); save(); refreshSheet(); } }, icon('refresh'), ui.busy ? 'Loading…' : 'Load / refresh')),
      h('div', { class: 'hint' }, 'In Google Sheets: File ▸ Share ▸ Publish to web ▸ choose the responses sheet and “CSV” ▸ Publish, then paste that link. ',
        h('b', null, 'Privacy: '), 'anyone who has that link can read the sheet — don’t share it, and un-publish when the event is over. It only updates when you press the button; nothing runs in the background.'));
    return h('div', { class: 'card white' },
      h('div', { class: 'sec-h' }, h('h2', { class: 'grow' }, 'Registrations'),
        h('button', { class: 'fbtn' + (ui.tab === 'file' ? ' on' : ''), onclick: () => { ui.tab = 'file'; renderContent(); } }, 'CSV file'),
        h('button', { class: 'fbtn' + (ui.tab === 'sheet' ? ' on' : ''), onclick: () => { ui.tab = 'sheet'; renderContent(); } }, 'Google Sheet link')),
      ui.tab === 'file' ? drop : sheet,
      reg ? h('p', { class: 'small muted', style: null }, h('b', null, 'Loaded: '), `${reg.rows.length} rows from ${reg.source === 'sheet' ? 'Google Sheet' : reg.name} · ${when(reg.loadedAt)}`) : null);
  }

  // ---------- views ----------
  function dashView() {
    const d = derived, T = d.teams, s = state.settings;
    const ok = T.filter((t) => Core.OK_STATUSES.has(t.status)).length;
    const att = T.filter((t) => [S.SHORT, S.CHECK, S.DUPLICATE, S.FIX, S.NOFEE, S.NOMATCH].includes(t.status)).length;
    const wait = T.filter((t) => t.status === S.AWAITING || t.status === S.NOSTMT).length;
    const q = Core.queue(d);
    const leaders = state.ledger.filter((l) => l.role === 'leader').length, mentors = state.ledger.length - leaders;
    const newN = T.filter((t) => t.isNew).length;
    const hr = new Date().getHours();
    const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    const sub = !state.reg ? 'Let’s get set up — it takes about a minute. Nothing here is pre-filled.'
      : `${q.length} invite${q.length === 1 ? '' : 's'} ready to send. ${att ? att + ' team' + (att === 1 ? '' : 's') + ' need a look.' : 'Nothing needs your attention.'}`;
    const steps = [
      ['Load registrations', 'CSV or Google Sheet link', !!state.reg],
      ['Add bank statement', 'PDF — add a new one any time', state.payments.length > 0],
      ['Set fee & invite link', 'In Settings', !!parseFloat(s.fee) && Core.validInvite(s.inviteLink)],
      ['Send invites', 'One tap per person', state.ledger.length > 0]];
    const seg = (n) => (T.length ? (n / T.length * 100).toFixed(1) + '%' : '0%');
    const barSeg = (n, cls) => { const b = h('b', { class: cls || '' }); b.style.width = seg(n); return b; };
    const exportBtn = h('button', { class: 'btn ghost sm', onclick: exportXlsx }, icon('download'), 'Excel report');
    return h('div', { class: 'stack' },
      h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, h('h1', null, greet + ', ' + (s.name || 'there')), h('p', { class: 'muted' }, sub)), exportBtn),
      steps.some((x) => !x[2]) ? h('ul', { class: 'steps', style: null }, steps.map(([a, b, done]) => h('li', { class: done ? 'done' : '' }, h('b', null, a), b))) : null,
      h('div', { class: 'field' }),
      h('div', { class: 'stats' },
        h('div', { class: 'stat y' }, h('h3', null, 'Registered teams'), h('div', { class: 'big' }, T.length), h('div', { class: 'sub' }, newN ? newN + ' new since the last load' : state.reg ? 'Last loaded ' + when(state.reg.loadedAt) : 'No registrations loaded')),
        h('div', { class: 'stat p' }, h('h3', null, 'Payment verified'), h('div', { class: 'big' }, ok), h('div', { class: 'bar' }, barSeg(ok), barSeg(wait, 'l')), h('div', { class: 'sub' }, wait ? wait + ' awaiting a statement' : 'of ' + T.length + ' teams')),
        h('div', { class: 'stat g' }, h('h3', null, 'Invites sent'), h('div', { class: 'big' }, state.ledger.length), h('div', { class: 'sub' }, `${leaders} leader${leaders === 1 ? '' : 's'} · ${mentors} mentor${mentors === 1 ? '' : 's'} · ${Core.sentToday(state)} today`)),
        h('div', { class: 'stat b' }, h('h3', null, 'Ready to send'), h('div', { class: 'big' }, q.length), h('div', { class: 'sub' }, att ? att + ' team' + (att === 1 ? '' : 's') + ' need a look' : 'Verified & not yet invited'))),
      h('div', { class: 'field' }),
      h('div', { class: 'split' },
        h('div', null,
          h('div', { class: 'sec-h' }, h('h2', { class: 'grow' }, 'Next up'), h('button', { class: 'btn sm', onclick: () => go('send') }, 'Open send desk')),
          q.length ? h('div', { class: 'list' }, q.slice(0, 5).map((p, i) => personItem(p, i === 0, false))) : h('div', { class: 'card white empty' }, h('p', null, T.length ? 'No one is waiting. New verified teams will show up here.' : 'Load registrations and a bank statement to begin.'))),
        h('div', null,
          h('div', { class: 'sec-h' }, h('h2', null, 'Activity')),
          h('div', { class: 'card timeline' }, state.log.length ? state.log.slice(-7).reverse().map((e) => h('div', { class: 'tl' }, h('span', { class: 'dot ' + e.type }), h('div', null, h('p', null, e.msg), h('div', { class: 'when' }, when(e.ts))))) : h('p', { class: 'muted small' }, 'Nothing yet.')))),
      h('div', { class: 'field' }),
      h('div', { class: 'split' }, sourcePanel(), statementsMini()));
  }
  function statementsMini() {
    const last = derived.coverage;
    return h('div', { class: 'card white' }, h('div', { class: 'sec-h' }, h('h2', { class: 'grow' }, 'Bank statements'), h('button', { class: 'btn sm', onclick: () => go('pay') }, 'Manage')),
      state.pdfs.length ? h('p', { class: 'small' }, `${state.pdfs.length} statement${state.pdfs.length === 1 ? '' : 's'} · ${state.payments.length} payments · covers up to ${last || 'unknown'}`) : h('p', { class: 'small muted' }, 'No statement yet. Add the PDF you receive; add each new one when it arrives.'));
  }
  const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
  function personItem(p, hot, withBtn) {
    const cooling = Date.now() < ui.cooldownUntil;
    return h('div', { class: 'item' + (hot ? ' hot' : '') }, h('div', { class: 'ico' + (p.role === 'mentor' ? ' m' : '') }, initials(p.name)),
      h('div', { class: 't' }, h('b', null, p.name), h('span', null, `${p.role === 'mentor' ? 'Faculty mentor' : 'Team leader'} · ${p.team} · ${Core.prettyPhone(p.phone)}`)),
      withBtn ? h('button', { class: 'btn' + (hot ? '' : ' ghost') + ' sm', disabled: !!state.pending || cooling, onclick: () => openInvite(p) }, icon('send'), 'Open WhatsApp') : h('span', { class: 'chip dark' }, p.role === 'mentor' ? 'Mentor' : 'Leader'));
  }

  // --- Teams
  const FILTERS = [['all', 'All'], ['new', 'New'], ['ready', 'Ready to invite'], ['verified', 'Verified'], ['attention', 'Needs a look'], ['awaiting', 'Awaiting statement'], ['sent', 'Fully invited']];
  const filterFn = {
    all: () => true, new: (t) => t.isNew, ready: (t) => t.invitesDue > 0, verified: (t) => Core.OK_STATUSES.has(t.status),
    attention: (t) => [S.SHORT, S.CHECK, S.DUPLICATE, S.FIX, S.NOFEE, S.NOMATCH].includes(t.status), awaiting: (t) => t.status === S.AWAITING || t.status === S.NOSTMT, sent: (t) => t.fullySent,
  };
  function inviteChip(p, label, wanted) {
    if (!wanted && !p.sent) return h('span', { class: 'chip mute' }, label + ': —');
    if (p.sent) return h('span', { class: 'chip ok', title: 'Marked as invited ' + when(p.sent.ts) }, label + ' ✓ ' + when(p.sent.ts));
    if (p.pending) return h('span', { class: 'chip warn' }, label + ': confirming…');
    return h('span', { class: 'chip ' + (p.eligible ? 'info' : 'mute') }, label + (p.eligible ? ': ready' : ': waiting'));
  }
  function teamsView() {
    const d = derived;
    const kids = [head('Teams', 'Every registration, its payment check, and who has been invited.'), sourcePanel(), h('div', { class: 'field' })];
    if (d.needsMapping.length) kids.push(mappingPanel(), h('div', { class: 'field' }));
    if (!state.reg) return h('div', null, kids, empty('No registrations yet', 'Load your CSV or Google Sheet link above. Nothing is pre-filled.'));
    if (d.needsMapping.length) return h('div', null, kids);
    const rows = d.teams.filter((t) => filterFn[ui.filter](t) && matches(ui.q, t.team, t.leader.name, t.leader.phone, t.leader.raw, t.institution, t.city, t.mentor.name, t.txnRaw, ST[t.status]));
    kids.push(h('div', { class: 'filters' }, FILTERS.map(([k, l]) => h('button', { class: 'fbtn' + (ui.filter === k ? ' on' : ''), onclick: () => { ui.filter = k; renderContent(); } }, l + ' ' + d.teams.filter(filterFn[k]).length))));
    if (!parseFloat(state.settings.fee)) kids.push(h('div', { class: 'banner' }, h('div', { class: 'grow' }, h('b', null, 'Set the registration fee. '), 'Until then nothing can be marked verified.'), h('button', { class: 'btn sm', onclick: () => go('settings') }, 'Open Settings')), h('div', { class: 'field' }));
    kids.push(rows.length ? h('div', { class: 'tbl-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Team', 'Leader', 'Payment', 'Invites', ''].map((x) => h('th', null, x)))),
      h('tbody', null, rows.map((t) => teamRow(t))))) : empty('No teams match', 'Try another filter or search.'));
    return h('div', null, kids);
  }
  function teamRow(t) {
    const open = ui.expanded.has(t.tid);
    const main = h('tr', { class: t.isNew ? 'isnew' : '' },
      h('td', null, h('div', { class: 'nm' }, t.team, t.isNew ? h('span', { class: 'chip warn', style: null }, ' NEW') : null), h('div', { class: 'sb' }, [t.institution, t.city].filter(Boolean).join(', '))),
      h('td', null, h('div', { class: 'nm' }, t.leader.name), h('div', { class: 'sb' }, t.leader.phoneOk ? Core.prettyPhone(t.leader.phone) : t.leader.raw || 'no number')),
      h('td', null, statusChip(t), t.payment ? h('div', { class: 'sb' }, '₹' + Core.fmt(t.payment.amount) + (t.payment.date ? ' · ' + t.payment.date : '')) : null),
      h('td', null, h('div', { class: 'row wrap' }, inviteChip(t.leader, 'Leader', true), t.mentor.name ? inviteChip(t.mentor, 'Mentor', t.mentor.wanted) : null)),
      h('td', null, h('button', { class: 'btn ghost sm', onclick: () => { open ? ui.expanded.delete(t.tid) : ui.expanded.add(t.tid); renderContent(); } }, open ? 'Hide' : 'Details')));
    if (!open) return main;
    const canApprove = !Core.OK_STATUSES.has(t.status) && t.status !== S.DUPLICATE && t.status !== S.FIX && t.status !== S.NOSTMT;
    const note = h('input', { type: 'text', placeholder: 'What did you check? e.g. “saw matching payment proof in Drive”' });
    const proofOk = /^https:\/\//i.test(t.proof);
    return [main, h('tr', { class: 'detail' }, h('td', { colspan: 5 },
      h('dl', { class: 'kv' },
        h('dt', null, 'Why this status'), h('dd', null, t.reason),
        h('dt', null, 'Transaction ID typed'), h('dd', null, t.txnRaw || '—'),
        h('dt', null, 'Matched payment'), h('dd', null, t.payment ? `₹${Core.fmt(t.payment.amount)} on ${t.payment.date || '?'} — ${t.payment.text.slice(0, 110)}` : 'None'),
        h('dt', null, 'Expected amount'), h('dd', null, t.required ? '₹' + Core.fmt(t.required) + ` (${t.members} member${t.members === 1 ? '' : 's'})` : 'Set the fee in Settings'),
        h('dt', null, 'Registered'), h('dd', null, t.ts + ' · sheet row ' + t.rowNo),
        h('dt', null, 'Faculty mentor'), h('dd', null, t.mentor.name ? `${t.mentor.name} · ${t.mentor.phoneOk ? Core.prettyPhone(t.mentor.phone) : t.mentor.raw || 'no number'}` : '—'),
        h('dt', null, 'Payment proof'), h('dd', null, proofOk ? h('a', { href: t.proof, target: '_blank', rel: 'noopener noreferrer' }, 'Open link') : t.proof || '—'),
        t.leader.dupPhone ? h('dt', null, 'Heads-up') : null, t.leader.dupPhone ? h('dd', null, 'This leader’s number appears on more than one registration.') : null),
      t.approved ? h('div', { class: 'row', style: null }, h('span', { class: 'chip info' }, 'Approved manually'), h('span', { class: 'small' }, t.approved.note),
        h('button', { class: 'btn ghost sm', onclick: () => { Core.revokeApproval(state, t.tid); commit(); } }, 'Remove approval')) : null,
      canApprove && !t.approved ? h('div', { class: 'row', style: null }, note, h('button', { class: 'btn sm', onclick: async () => {
        const r = Core.approveTeam(state, t.tid, note.value); if (!r.ok) return toast(r.error, true);
        commit(); toast('Approved. They can now be invited.');
      } }, 'Approve manually')) : null)),
    ];
  }
  function mappingPanel() {
    const hs = state.reg.headers, cur = derived.map;
    const fields = [['leader', 'Team leader name'], ['phone', 'Team leader WhatsApp number'], ['txn', 'Transaction ID'], ['team', 'Team name'], ['ts', 'Timestamp'], ['email', 'Submitter email'], ['institution', 'Institution'], ['mentorName', 'Faculty mentor name'], ['mentorPhone', 'Faculty mentor number'], ['proof', 'Payment proof link']];
    return h('div', { class: 'card white' }, h('h3', null, 'Match the columns'),
      h('p', { class: 'small muted' }, 'I could not recognise: ' + derived.needsMapping.join(', ') + '. Pick the right columns from your file.'), h('div', { class: 'field' }),
      h('div', { class: 'split' }, fields.map(([k, l]) => h('div', { class: 'field' }, h('label', { class: 'f' }, l),
        h('select', { onchange: (e) => { state.settings.cols = Object.assign({}, state.settings.cols, { [k]: parseInt(e.target.value, 10) }); commit(); } },
          h('option', { value: -1 }, '— none —'), hs.map((x, i) => h('option', { value: i, selected: cur[k] === i }, (x || '(blank)').slice(0, 70))))))));
  }

  // --- Send
  async function openInvite(p) {
    if (Date.now() < ui.cooldownUntil) return;
    const r = Core.beginSend(state, p);
    if (!r.ok) return toast(r.error, true);
    ui.openedAtMs = Date.now(); commit();
    window.open(r.url, '_blank', 'noopener,noreferrer');
    setTimeout(() => { if (ui.view === 'send') renderContent(); }, 2100);
  }
  function sendView() {
    if (state.settings.deliveryMode === 'add') return addView();
    const q = Core.queue(derived), s = state.settings, p = state.pending;
    const kids = [head('Send invites', 'One person at a time. Nobody is ever sent the same invite twice.'), modeSwitch()];
    if (!Core.validInvite(s.inviteLink)) kids.push(h('div', { class: 'banner red' }, h('div', { class: 'grow' }, h('b', null, 'Add your WhatsApp group invite link first. '), 'Settings ▸ Invite link (it looks like https://chat.whatsapp.com/…).'), h('button', { class: 'btn sm', onclick: () => go('settings') }, 'Open Settings')), h('div', { class: 'field' }));
    if (p) {
      const ready = Date.now() - ui.openedAtMs > 2000 || !ui.openedAtMs;
      const reopen = () => { const r = Core.waLink(p.phone, Core.fillTemplate(p.role === 'mentor' ? s.mentorMsg : s.leaderMsg, { name: p.name, team: p.team, link: s.inviteLink.trim() })); window.open(r, '_blank', 'noopener,noreferrer'); };
      kids.push(h('div', { class: 'sendcard' }, h('h2', null, 'Did you send it to ' + p.name + '?'), h('p', { class: 'small' }, 'WhatsApp opened in another tab with the message ready. Press Send there, then confirm here. Only “Yes” records them as invited.'),
        h('div', { class: 'field' }), h('div', { class: 'row wrap' },
          h('button', { class: 'btn', disabled: !ready, onclick: () => { const r = Core.confirmSent(state); if (!r.ok) toast(r.error, true); ui.cooldownUntil = Date.now() + 2500; commit(); setTimeout(() => { if (ui.view === 'send') renderContent(); }, 2600); } }, icon('check'), 'Yes, I sent it'),
          h('button', { class: 'btn ghost', onclick: () => { Core.cancelPending(state); commit(); } }, 'No, I didn’t send it'),
          h('button', { class: 'btn ghost', onclick: reopen }, 'Open WhatsApp again'))), h('div', { class: 'field' }));
    }
    const lim = Number(s.dailyLimit) || 0, today = Core.sentToday(state);
    kids.push(h('div', { class: 'row wrap', style: null }, h('span', { class: 'chip dark' }, q.length + ' waiting'), h('span', { class: 'chip ' + (lim && today >= lim ? 'bad' : 'mute') }, `${today}${lim ? ' / ' + lim : ''} sent today`),
      h('span', { class: 'small muted' }, 'Messages are sent by you from your own WhatsApp — this app can’t send anything by itself.')), h('div', { class: 'field' }));
    const list = q.filter((x) => matches(ui.q, x.name, x.team, x.phone));
    kids.push(list.length ? h('div', { class: 'list' }, list.map((x, i) => personItem(x, i === 0 && !p, true)))
      : empty('Nobody is waiting', derived.teams.length ? 'Teams appear here once their payment is verified (or approved by you). Add a newer statement or load the latest registrations to see more.' : 'Load registrations and a bank statement first.'));
    return h('div', null, kids);
  }


  // --- "Add them myself" mode
  function modeSwitch() {
    const s = state.settings;
    return h('div', { class: 'filters' }, [['link', 'Send invite link'], ['add', 'Add them myself']].map(([k, l]) => h('button', { class: 'fbtn' + (s.deliveryMode === k ? ' on' : ''), onclick: () => { s.deliveryMode = k; commit(); } }, l)));
  }
  async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('Copied ' + t); } catch (e) { toast('Could not copy — select the number manually.', true); } }
  function addView() {
    const q = Core.queue(derived), s = state.settings;
    const list = q.filter((x) => matches(ui.q, x.name, x.team, x.phone));
    const kids = [head('Add people to the group', 'You add them yourself, so no invite link is ever sent or shared.'), modeSwitch()];
    kids.push(h('div', { class: 'card white' }, h('h2', null, 'Fast way: import them as contacts'),
      h('ol', { class: 'small' }, h('li', null, 'Download the contacts file below.'), h('li', null, 'Import it at contacts.google.com ▸ Import (or open the .vcf on your phone). Your phone syncs it.'),
        h('li', null, 'In your WhatsApp group: Group info ▸ Add participants ▸ search “' + (s.namePrefix || '').trim() + '” and tick everyone.'), h('li', null, 'Come back and press “Mark all as added”.')),
      h('div', { class: 'field' }), h('div', { class: 'row wrap' },
        h('button', { class: 'btn', disabled: !q.length, onclick: () => { download(Core.contactsCsv(state, q), 'nacdec-contacts-' + day() + '.csv', 'text/csv'); toast('Contacts CSV downloaded. It contains phone numbers — keep it private.'); } }, icon('download'), 'Google Contacts CSV'),
        h('button', { class: 'btn ghost', disabled: !q.length, onclick: () => { download(Core.contactsVcf(state, q), 'nacdec-contacts-' + day() + '.vcf', 'text/vcard'); toast('Contacts file downloaded.'); } }, icon('download'), 'Phone contacts (.vcf)'),
        h('button', { class: 'btn pink', disabled: !q.length, onclick: async () => {
          if (!(await confirmBox('Mark everyone listed as added?', `${q.length} people will be recorded as added to the group and won’t appear here again. Only do this after you have actually added them.`, 'Yes, they are added'))) return;
          const r = Core.markAdded(state, q); commit(); toast(`${r.n} marked as added.`);
        } }, icon('check'), 'Mark all as added')),
      h('p', { class: 'hint' }, 'Only verified (or manually approved) people who haven’t been handled yet are included. Names get the prefix “' + (s.namePrefix || '') + '” so they’re easy to find; change it in Settings. Delete the contacts afterwards if you like.')));
    kids.push(h('div', { class: 'field' }));
    kids.push(list.length ? h('div', { class: 'list' }, list.map((x) => h('div', { class: 'item' }, h('div', { class: 'ico' + (x.role === 'mentor' ? ' m' : '') }, initials(x.name)),
      h('div', { class: 't' }, h('b', null, x.name), h('span', null, `${x.role === 'mentor' ? 'Faculty mentor' : 'Team leader'} · ${x.team} · ${Core.prettyPhone(x.phone)}`)),
      h('button', { class: 'btn ghost sm', onclick: () => copyText('+' + x.phone) }, 'Copy number'),
      h('button', { class: 'btn sm', onclick: () => { Core.markAdded(state, [x]); commit(); } }, icon('check'), 'Mark as added'))))
      : empty('Nobody is waiting', 'Verified teams appear here. If you type a number straight into Add participants (no contact needed), use Copy number, then Mark as added.'));
    return h('div', null, kids);
  }

  // --- Sent log
  function sentView() {
    const rows = state.ledger.slice().reverse().filter((l) => matches(ui.q, l.name, l.team, l.phone, l.role));
    return h('div', null, head('Sent log', `${state.ledger.length} people marked as invited. This list is what prevents double-sending.`,
      h('button', { class: 'btn ghost sm', onclick: exportSentCsv }, icon('download'), 'CSV'), h('button', { class: 'btn sm', onclick: exportXlsx }, icon('download'), 'Excel report')),
      rows.length ? h('div', { class: 'tbl-wrap' }, h('table', null, h('thead', null, h('tr', null, ['When', 'Who', 'Team', 'Number', ''].map((x) => h('th', null, x)))),
        h('tbody', null, rows.map((l) => h('tr', null, h('td', null, when(l.ts)), h('td', null, h('div', { class: 'nm' }, l.name), h('div', { class: 'sb' }, (l.role === 'mentor' ? 'Faculty mentor' : 'Team leader') + (l.via === 'added' ? ' · added by you' : ' · invite link'))), h('td', null, l.team), h('td', null, Core.prettyPhone(l.phone)),
          h('td', null, h('button', { class: 'btn ghost sm', onclick: async () => {
            if (!(await confirmBox('Remove this “invited” mark?', `${l.name} will appear in the send queue again and could be sent a second invite. Only do this if the message was never actually delivered.`, 'Remove mark', true))) return;
            Core.undoSent(state, l.id); commit();
          } }, 'Undo'))))))) : empty('Nobody invited yet', 'People you confirm on the Send page appear here.'));
  }

  // --- Payments
  function payView() {
    const sup = Ocr.supported();
    const fileIn = h('input', { type: 'file', class: 'sr', accept: '.pdf,application/pdf', multiple: true, onchange: (e) => { const f = e.target.files; addPdfs(f); e.target.value = ''; } });
    const drop = h('div', { class: 'drop', tabindex: '0', role: 'button', onclick: () => fileIn.click(), onkeydown: (e) => { if (e.key === 'Enter') fileIn.click(); },
      ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); addPdfs(e.dataTransfer.files); } },
      h('b', null, state.pdfs.length ? 'Add the new statement PDF' : 'Drop the bank statement PDF here'), h('div', { class: 'small muted' }, 'Printed-to-PDF statements are read on this device. Add each new one — payments accumulate and duplicates are ignored.'), fileIn);
    const matchedBy = new Map(); derived.teams.forEach((t) => { if (t.payment && (t.status === S.VERIFIED || t.status === S.APPROVED || t.status === S.SHORT || t.status === S.NOFEE)) matchedBy.set(t.payment, t.team); });
    const F = [['all', 'All'], ['unmatched', 'Not matched to a team'], ['review', 'Needs checking']];
    const rows = state.payments.filter((p) => (ui.payFilter === 'all' || (ui.payFilter === 'unmatched' ? !matchedBy.has(p) : p.check === 'mismatch' || p.check === 'unchecked')) && matches(ui.q, p.text, p.amount, p.date)).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return h('div', null, head('Payments', 'Credits read from your bank statements. Matching to teams is by the transaction ID.'),
      !sup.ok ? h('div', { class: 'banner red' }, h('div', { class: 'grow' }, h('b', null, 'PDF reading is unavailable here. '), sup.why)) : null, !sup.ok ? h('div', { class: 'field' }) : null,
      drop, h('div', { class: 'field' }),
      ui.ocr ? h('div', { class: 'card white', id: 'ocr-status' }, h('p', { class: 'small' }, ui.ocr.msg), h('progress', { max: 1, value: ui.ocr.frac }), h('p', { class: 'hint' }, 'Reading happens on this device and can take a few seconds per page.')) : null, ui.ocr ? h('div', { class: 'field' }) : null,
      state.pdfs.length ? h('div', { class: 'list' }, state.pdfs.map((f) => h('div', { class: 'item' }, h('div', { class: 'ico' }, 'PDF'),
        h('div', { class: 't' }, h('b', null, f.name), h('span', null, `${f.periodFrom ? f.periodFrom + ' → ' + f.periodTo + ' · ' : ''}${f.credits} credits · ${f.added} new · added ${when(f.addedAt)}`)),
        f.chainBad ? h('span', { class: 'chip warn', title: 'The running balance did not add up on these rows — a digit may have been misread' }, f.chainBad + ' to check') : h('span', { class: 'chip ok' }, 'Balance check passed'),
        h('button', { class: 'btn ghost sm', onclick: async () => { if (await confirmBox('Remove this statement?', 'Its payments are removed (unless another statement also contains them). Teams may go back to “awaiting”.', 'Remove', true)) { Core.removeStatement(state, f.id); commit(); } } }, 'Remove')))) : null,
      state.payments.length ? h('div', { class: 'field' }) : null,
      state.payments.length ? h('div', { class: 'filters' }, F.map(([k, l]) => h('button', { class: 'fbtn' + (ui.payFilter === k ? ' on' : ''), onclick: () => { ui.payFilter = k; renderContent(); } }, l))) : null,
      state.payments.length ? (rows.length ? h('div', { class: 'tbl-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Date', 'Amount', 'Narration', 'Matched to', 'Read'].map((x) => h('th', null, x)))),
        h('tbody', null, rows.map((p) => h('tr', null, h('td', null, p.date || '—'), h('td', null, h('b', null, '₹' + Core.fmt(p.amount))), h('td', { class: 'small' }, p.text.slice(0, 120)),
          h('td', null, matchedBy.has(p) ? h('span', { class: 'chip ok' }, matchedBy.get(p)) : h('span', { class: 'chip mute' }, '—')),
          h('td', null, p.check === 'ok' ? h('span', { class: 'chip ok', title: 'The running balance adds up, so this amount was read correctly' }, 'sure') : p.check === 'mismatch' ? h('span', { class: 'chip warn' }, 'verify by eye') : h('span', { class: 'chip mute' }, p.check === 'inferred' ? 'inferred' : 'unchecked'))))))) : empty('No payments match', '')) : null);
  }

  // --- Settings
  function settingsView() {
    const s = state.settings;
    const f = (label, el, hint) => h('div', { class: 'field' }, h('label', { class: 'f' }, label), el, hint ? h('div', { class: 'hint' }, hint) : null);
    const upd = (key, conv) => (e) => { s[key] = conv ? conv(e.target.value, e.target) : e.target.value; commit(); };
    const feeIn = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'e.g. 5900', value: s.fee, onchange: upd('fee') });
    const mode = h('select', { onchange: upd('feeMode') }, h('option', { value: 'team', selected: s.feeMode === 'team' }, 'per team (one payment covers everyone)'), h('option', { value: 'member', selected: s.feeMode === 'member' }, 'per member (fee × number of members listed)'));
    const link = h('input', { type: 'url', placeholder: 'https://chat.whatsapp.com/…', value: s.inviteLink, onchange: (e) => { s.inviteLink = e.target.value.trim(); if (s.inviteLink && !Core.validInvite(s.inviteLink)) toast('That does not look like a WhatsApp group invite link.', true); commit(); } });
    const lm = h('textarea', { onchange: upd('leaderMsg') }, s.leaderMsg), mm = h('textarea', { onchange: upd('mentorMsg') }, s.mentorMsg);
    const prevEl = h('div', { class: 'card white small' });
    const paintPrev = () => { prevEl.textContent = Core.fillTemplate(lm.value, { name: 'Asha Rao', team: 'Team Alpha', link: s.inviteLink || 'https://chat.whatsapp.com/…' }); };
    lm.addEventListener('input', paintPrev); paintPrev();
    const restoreIn = h('input', { type: 'file', class: 'sr', accept: '.idbackup,.json,.txt', onchange: async (e) => {
      const file = e.target.files[0]; e.target.value = ''; if (!file) return;
      const v = await ask({ title: 'Restore this backup?', body: 'It replaces everything currently in this browser. Enter the backup’s passphrase.', confirm: 'Restore', danger: true, inputs: [{ label: 'Backup passphrase', type: 'password' }] });
      if (!v) return; try { state = await vault.restore(await file.text(), v[0]); toast('Backup restored.'); enter(); } catch (err) { toast(err.message, true); }
    } });
    const colsHs = state.reg ? state.reg.headers : [];
    return h('div', { style: null },
      head('Settings', 'Everything here is saved in the encrypted vault.'),
      h('div', { class: 'split' }, h('div', { class: 'card white' }, h('h2', null, 'Event'),
        h('div', { class: 'field' }), f('Your name (for the greeting)', h('input', { type: 'text', value: s.name, onchange: upd('name') })),
        f('Registration fee (₹)', feeIn, 'No default — enter the amount your event charges.'), f('How the fee is charged', mode),
        f('WhatsApp group invite link', link, 'Open the group ▸ Group info ▸ Invite via link ▸ Copy. Anyone with this link can join, so it only goes in messages you send.'),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: s.inviteMentors, onchange: (e) => { s.inviteMentors = e.target.checked; commit(); } }), 'Also invite faculty mentors (once per number)')),
      h('div', { class: 'card white' }, h('h2', null, 'Guard rails'), h('div', { class: 'field' }),
        f('Daily send limit', h('input', { type: 'number', min: 0, max: 500, value: s.dailyLimit, onchange: upd('dailyLimit', (v) => Math.max(0, parseInt(v, 10) || 0)) }), 'Sending many first-time messages in a day can get a WhatsApp number restricted. 0 = no limit.'),
        f('Auto-lock after (minutes idle)', h('input', { type: 'number', min: 1, max: 240, value: s.autoLockMin, onchange: upd('autoLockMin', (v) => Math.min(240, Math.max(1, parseInt(v, 10) || 10))) })),
        f('Contact name prefix (for “Add them myself”)', h('input', { type: 'text', value: s.namePrefix, onchange: upd('namePrefix') }), 'Added before each name in the contacts file so you can find them in WhatsApp.'),
        f('Default country code', h('input', { type: 'text', value: s.cc, onchange: upd('cc', (v) => v.replace(/\D/g, '') || '91') }), 'Used for numbers typed without one.'),
        h('ul', { class: 'small muted' }, h('li', null, 'Only verified (or manually approved) teams can be invited.'), h('li', null, 'A number that has been invited is blocked from being invited again.'), h('li', null, 'Only one invite can be “in progress” at a time.'), h('li', null, 'Nothing is recorded as sent until you confirm it.')))),
      h('div', { class: 'field' }),
      h('div', { class: 'card white' }, h('h2', null, 'Messages'), h('p', { class: 'small muted' }, 'You can use {name}, {team} and {link}.'), h('div', { class: 'field' }),
        h('div', { class: 'split' }, f('Message to team leaders', lm), f('Message to faculty mentors', mm)), h('label', { class: 'f' }, 'Preview (leader)'), prevEl,
        h('div', { class: 'field' }), h('button', { class: 'btn ghost sm', onclick: () => { s.leaderMsg = Core.DEFAULT_LEADER_MSG; s.mentorMsg = Core.DEFAULT_MENTOR_MSG; commit(); } }, 'Reset messages')),
      h('div', { class: 'field' }),
      colsHs.length ? h('details', { class: 'card white' }, h('summary', null, h('b', null, 'Advanced: which columns to use')), h('div', { class: 'field' }), h('p', { class: 'small muted' }, 'Normally detected automatically from your form’s headings.'), h('div', { class: 'field' }), (() => {
        const cur = Object.assign({}, derived.map || Core.guessColumns(colsHs));
        const fields = [['leader', 'Leader name'], ['phone', 'Leader WhatsApp'], ['txn', 'Transaction ID'], ['team', 'Team name'], ['ts', 'Timestamp'], ['email', 'Submitter email'], ['institution', 'Institution'], ['mentorName', 'Mentor name'], ['mentorPhone', 'Mentor number'], ['proof', 'Payment proof']];
        return h('div', { class: 'split' }, fields.map(([k, l]) => f(l, h('select', { onchange: (e) => { s.cols = Object.assign({}, s.cols, { [k]: parseInt(e.target.value, 10) }); commit(); } },
          h('option', { value: -1 }, '— none —'), colsHs.map((x, i) => h('option', { value: i, selected: cur[k] === i }, (x || '(blank)').slice(0, 70)))))));
      })(), s.cols ? h('button', { class: 'btn ghost sm', onclick: () => { s.cols = null; commit(); } }, 'Back to automatic') : null) : null,
      h('div', { class: 'field' }),
      h('div', { class: 'card white' }, h('h2', null, 'Security & backup'), h('div', { class: 'field' }),
        h('p', { class: 'small muted' }, 'Your data is encrypted (AES-256) with your passphrase and stored only in this browser. Back it up regularly — clearing browser data deletes it.'), h('div', { class: 'field' }),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn', onclick: async () => { await flushSave(); download(vault.backupText(), 'invite-desk-backup-' + day() + '.idbackup', 'text/plain'); toast('Encrypted backup downloaded.'); } }, icon('download'), 'Download encrypted backup'),
          h('button', { class: 'btn ghost', onclick: () => restoreIn.click() }, 'Restore backup'), restoreIn,
          h('button', { class: 'btn ghost', onclick: changePass }, 'Change passphrase'),
          h('button', { class: 'btn ghost', onclick: () => lock('Locked.') }, icon('lock'), 'Lock now'),
          h('button', { class: 'btn danger', onclick: async () => {
            const v = await ask({ title: 'Erase everything?', body: 'Deletes all registrations, payments and the sent list from this browser. Download a backup first. Type ERASE to confirm.', confirm: 'Erase everything', danger: true, inputs: [{ label: 'Type ERASE' }] });
            if (v && v[0] === 'ERASE') { vault.wipe(); location.reload(); }
          } }, 'Erase everything'))));
  }
  async function changePass() {
    const v = await ask({ title: 'Change passphrase', confirm: 'Change', inputs: [{ label: 'Current passphrase', type: 'password' }, { label: 'New passphrase (10+ characters)', type: 'password' }, { label: 'New passphrase again', type: 'password' }] });
    if (!v) return;
    if (v[1].length < 10) return toast('Use at least 10 characters.', true);
    if (v[1] !== v[2]) return toast('The new passphrases do not match.', true);
    try { await vault.changePass(v[0], v[1], state); toast('Passphrase changed. Make a fresh backup.'); } catch (e) { toast(e.code === 'BAD_PASS' ? 'Current passphrase is wrong.' : e.message, true); }
  }

  // ---------- exports ----------
  function exportSentCsv() {
    const rows = [['Sent at', 'Role', 'Name', 'Team', 'Phone']].concat(state.ledger.map((l) => [l.ts, l.role, l.name, l.team, '+' + l.phone]));
    download('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), 'invite-log-' + day() + '.csv', 'text/csv');
    toast('Downloaded. The file contains phone numbers — keep it private.');
  }
  function exportXlsx() {
    const T = derived.teams;
    const teams = [['Team', 'Institution', 'City', 'Leader', 'Leader phone', 'Payment status', 'Why', 'Paid (₹)', 'Payment date', 'Leader invited', 'Faculty mentor', 'Mentor phone', 'Mentor invited', 'Registered']]
      .concat(T.map((t) => [t.team, t.institution, t.city, t.leader.name, t.leader.phone ? '+' + t.leader.phone : t.leader.raw, ST[t.status], t.reason, t.payment ? t.payment.amount : '', t.payment ? t.payment.date : '',
        t.leader.sent ? when(t.leader.sent.ts) : 'No', t.mentor.name, t.mentor.phone ? '+' + t.mentor.phone : '', t.mentor.name ? (t.mentor.sent ? when(t.mentor.sent.ts) : 'No') : '', t.ts]));
    const sent = [['Sent at', 'Role', 'Name', 'Team', 'Phone']].concat(state.ledger.map((l) => [when(l.ts), l.role, l.name, l.team, '+' + l.phone]));
    const notSent = [['Role', 'Name', 'Team', 'Phone', 'Payment status']].concat(Core.queue(derived).map((p) => [p.role, p.name, p.team, '+' + p.phone, 'Ready']))
      .concat(T.filter((t) => !Core.OK_STATUSES.has(t.status)).map((t) => ['leader', t.leader.name, t.team, t.leader.phone ? '+' + t.leader.phone : t.leader.raw, ST[t.status] + ' — ' + t.reason]));
    const pays = [['Date', 'Amount (₹)', 'Narration', 'Read check']].concat(state.payments.map((p) => [p.date, p.amount, p.text, p.check]));
    const log = [['When', 'Event']].concat(state.log.slice().reverse().map((e) => [when(e.ts), e.msg]));
    const bytes = Xlsx.build([{ name: 'Teams', rows: teams, header: true, widths: [24, 26, 14, 22, 16, 18, 40, 10, 12, 18, 22, 16, 18, 20] }, { name: 'Sent log', rows: sent, header: true, widths: [20, 10, 24, 24, 16] },
      { name: 'Not yet invited', rows: notSent, header: true, widths: [10, 24, 24, 16, 50] }, { name: 'Payments', rows: pays, header: true, widths: [12, 12, 80, 12] }, { name: 'Activity', rows: log, header: true, widths: [20, 80] }]);
    download(bytes, 'invite-desk-report-' + day() + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    toast('Report downloaded. It contains personal data — keep it private.');
  }

  // ---------- boot ----------
  ['pointerdown', 'keydown', 'wheel'].forEach((ev) => window.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true }));
  setInterval(() => {
    if (!state) return;
    const m = Number(state.settings.autoLockMin) || 0;
    if (m && !ui.ocr && Date.now() - lastActive > m * 60000) lock('Locked after ' + m + ' minutes idle.');
  }, 10000);
  window.addEventListener('beforeunload', (e) => { if (ui.ocr) { e.preventDefault(); e.returnValue = ''; } });

  vault = Vault.create(storageOk ? localStorage : { getItem: () => null, setItem() {}, removeItem() {} });
  render();
})();
