/*
 * core.js — pure logic (no DOM, no network). Works in the browser (window.Core)
 * and in Node (module.exports) so it can be unit-tested.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- CSV ----------
  function detectDelimiter(text) {
    const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 8);
    const cands = [',', ';', '\t', '|'];
    let best = ',', bestScore = -1;
    for (const d of cands) {
      let score = 0;
      for (const line of lines) {
        let q = false, n = 0;
        for (const ch of line) { if (ch === '"') q = !q; else if (ch === d && !q) n++; }
        score += n;
      }
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  /** Parses CSV text to an array of rows (arrays of strings). Blank rows are kept so row numbers match the file. */
  function parseCSV(text) {
    if (!text) return [];
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const delim = detectDelimiter(text);
    const rows = [];
    let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = ''; rows.push(row); row = [];
      } else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  const isBlankRow = (r) => !r || r.every((c) => String(c).trim() === '');

  /** Bank statements often have account details above the table; find the real header row. */
  function findBankHeader(rows) {
    const lim = Math.min(rows.length, 60);
    for (let i = 0; i < lim; i++) {
      const r = rows[i].map((c) => String(c));
      const hasText = r.some((c) => /narration|description|particulars|remarks|details/i.test(c));
      const hasCredit = r.some((c) => /credit|deposit|\bcr\b/i.test(c));
      if (hasText && hasCredit) return i;
    }
    for (let i = 0; i < lim; i++) if (!isBlankRow(rows[i])) return i;
    return 0;
  }

  function toTable(rows, headerIdx) {
    if (!rows.length || headerIdx >= rows.length) return { headers: [], rows: [], headerIdx: 0 };
    const headers = rows[headerIdx].map((h) => String(h).trim());
    const out = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      if (isBlankRow(rows[i])) continue;
      out.push({ rowNo: i + 1, cells: rows[i].map((c) => String(c).trim()) });
    }
    return { headers, rows: out, headerIdx };
  }

  // ---------- column guessing ----------
  const firstMatch = (headers, re, skip) => {
    const i = headers.findIndex((h, idx) => re.test(h) && !(skip && skip.test(h)));
    return i >= 0 ? headers[i] : '';
  };

  function guessReg(headers) {
    const memberNames = headers.filter((h) => /member\s*\d+\s*[:\-]?\s*name/i.test(h));
    const single = firstMatch(headers, /members?/i, /count|size|number of|\d/i);
    return {
      team: firstMatch(headers, /team/i, /member|size|count|leader|lead/i) || firstMatch(headers, /team/i),
      leader: firstMatch(headers, /member\s*1.*name|leader|lead name|full name|your name|^name$/i),
      phone: firstMatch(headers, /(member\s*1|leader).*(whats?app|phone|mobile|contact)/i) || firstMatch(headers, /whats?app|phone|mobile|contact/i),
      email: firstMatch(headers, /(member\s*1|leader).*e-?mail/i) || firstMatch(headers, /e-?mail/i),
      utr: firstMatch(headers, /utr|transaction|txn|upi ?ref|reference/i),
      members: memberNames.length ? memberNames : (single ? [single] : []),
      institution: firstMatch(headers, /institution|college|university|organi[sz]ation/i, /city/i),
      city: firstMatch(headers, /city|town|location/i),
      proof: firstMatch(headers, /payment.*(proof|screenshot|receipt)|proof|screenshot|receipt/i),
    };
  }

  function guessBank(headers) {
    return {
      ref: headers.filter((h) => /narration|description|particulars|remarks|reference|ref|chq|utr|details/i.test(h)),
      credit: firstMatch(headers, /credit|deposit|\bcr\b/i),
      debit: firstMatch(headers, /debit|withdraw|\bdr\b/i),
      date: firstMatch(headers, /date/i),
    };
  }

  // ---------- normalisers ----------
  const normUtr = (v) => String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
    .replace(/^(?:UTRNO|UTRNUMBER|UTR|TXNID|TXNNO|TXN|TRANSACTIONID|TRANSACTIONNO|TRANSACTION|REFNO|REFERENCENO|REF|NO|ID)+(?=\d)/, '');

  function normPhone(v, cc) {
    const d = String(v || '').replace(/\D/g, '');
    if (d.length < 10) return '';
    return String(cc || '91') + d.slice(-10);
  }

  function parseAmount(v) {
    if (typeof v === 'number') return v;
    const s = String(v || '').replace(/,/g, '').replace(/[^0-9.\-]/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  const countMembers = (v) => String(v || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).length;

  // ---------- bank index ----------
  function buildBankIndex(bank, map) {
    const idx = (n) => (n ? bank.headers.indexOf(n) : -1);
    const refI = (map.ref || []).map(idx).filter((i) => i >= 0);
    const credI = idx(map.credit), debI = idx(map.debit), dateI = idx(map.date);
    if (!refI.length) return { error: 'Choose at least one reference/description column for the bank file.' };
    if (credI < 0) return { error: 'Choose the credit (money received) column for the bank file.' };

    const tokens = new Map();
    const credits = [];
    for (const r of bank.rows) {
      const amt = parseAmount(r.cells[credI]);
      if (!(amt > 0)) continue;
      if (debI >= 0 && parseAmount(r.cells[debI]) > 0) continue;
      const text = refI.map((i) => r.cells[i] || '').join(' ').trim();
      const entry = { rowNo: r.rowNo, text, amount: amt, date: dateI >= 0 ? r.cells[dateI] || '' : '', norm: normUtr(text) };
      credits.push(entry);
      const toks = new Set();
      (text.match(/(?<!\d)\d{12}(?!\d)/g) || []).forEach((t) => toks.add(t));
      (text.toUpperCase().match(/[A-Z0-9]{10,25}/g) || []).forEach((t) => { if (/\d/.test(t)) toks.add(t); });
      toks.forEach((t) => { if (!tokens.has(t)) tokens.set(t, []); tokens.get(t).push(entry); });
    }
    return { tokens, credits };
  }

  function lookup(index, utr) {
    const exact = index.tokens.get(utr);
    if (exact && exact.length) return { type: 'exact', entries: exact };
    if (utr.length >= 10) {
      const loose = index.credits.filter((e) => e.norm.includes(utr));
      if (loose.length) return { type: 'loose', entries: loose };
    }
    return { type: 'none', entries: [] };
  }

  // ---------- verification ----------
  const STATUS = {
    VERIFIED: 'VERIFIED', UNDERPAID: 'UNDERPAID', PENDING: 'PENDING', DUPLICATE: 'DUPLICATE', REVIEW: 'REVIEW',
  };

  /**
   * regMap: header names for {team, leader, phone, email, utr, members}
   * bankMap: {ref:[names], credit, debit, date}
   * opts: {fee, maxTeam, cc}
   */
  function verify(reg, regMap, bank, bankMap, opts) {
    const fee = Number(opts.fee) || 0, maxTeam = Number(opts.maxTeam) || 0, cc = opts.cc || '91';
    const ci = (n) => (n ? reg.headers.indexOf(n) : -1);
    const c = {
      team: ci(regMap.team), leader: ci(regMap.leader), phone: ci(regMap.phone),
      email: ci(regMap.email), utr: ci(regMap.utr),
      institution: ci(regMap.institution), city: ci(regMap.city), proof: ci(regMap.proof),
    };
    const memCols = (Array.isArray(regMap.members) ? regMap.members : regMap.members ? [regMap.members] : []).map(ci).filter((i) => i >= 0);
    if (c.utr < 0) return { error: 'Choose the UTR / transaction-ID column for the registration file.', results: [] };
    if (c.phone < 0) return { error: 'Choose the leader WhatsApp-number column for the registration file.', results: [] };

    const index = bank && bank.headers.length ? buildBankIndex(bank, bankMap) : null;
    if (index && index.error) return { error: index.error, results: [] };

    const get = (cells, i) => (i >= 0 ? cells[i] || '' : '');
    const utrCount = {}, phoneCount = {};
    for (const r of reg.rows) {
      const u = normUtr(get(r.cells, c.utr)), p = normPhone(get(r.cells, c.phone), cc);
      if (u) utrCount[u] = (utrCount[u] || 0) + 1;
      if (p) phoneCount[p] = (phoneCount[p] || 0) + 1;
    }

    const results = reg.rows.map((r) => {
      const utr = normUtr(get(r.cells, c.utr));
      const phone = normPhone(get(r.cells, c.phone), cc);
      // several "Member N: Name" columns -> count non-empty ones; a single list cell -> split it
      const memCells = memCols.map((i) => get(r.cells, i)).filter((v) => String(v).trim() !== '');
      const teamSize = memCols.length > 1 ? memCells.length : memCols.length === 1 ? countMembers(memCells[0]) : 0;
      const membersRaw = memCells.join(', ');
      const out = {
        rowNo: r.rowNo,
        key: (phone || 'nophone') + '|' + (utr || 'noutr') + '|' + r.rowNo,
        team: get(r.cells, c.team), leader: get(r.cells, c.leader), phone,
        phoneRaw: get(r.cells, c.phone), email: get(r.cells, c.email),
        institution: get(r.cells, c.institution), city: get(r.cells, c.city),
        proof: (String(get(r.cells, c.proof)).match(/https?:\/\/[^\s,;]+/) || [''])[0],
        utr, utrRaw: get(r.cells, c.utr), members: membersRaw, teamSize,
        status: '', reason: '', paid: 0, matchType: 'none', bankMatches: [],
      };
      // key without rowNo so flags survive re-uploading a longer CSV
      out.key = (phone || 'nophone') + '|' + (utr || 'noutr');

      if (!utr) { out.status = STATUS.REVIEW; out.reason = 'No UTR / transaction ID entered.'; return out; }
      if (utrCount[utr] > 1) { out.status = STATUS.DUPLICATE; out.reason = 'The same UTR appears in ' + utrCount[utr] + ' registrations.'; return out; }
      if (!phone) { out.status = STATUS.REVIEW; out.reason = 'Leader phone number is missing or invalid.'; return out; }
      if (phoneCount[phone] > 1) { out.status = STATUS.DUPLICATE; out.reason = 'This leader phone appears in ' + phoneCount[phone] + ' registrations.'; return out; }
      if (maxTeam && teamSize > maxTeam) { out.status = STATUS.REVIEW; out.reason = 'Team lists ' + teamSize + ' members (max ' + maxTeam + ').'; return out; }
      if (!index) { out.status = STATUS.PENDING; out.reason = 'Bank statement not uploaded yet.'; return out; }

      const m = lookup(index, utr);
      out.matchType = m.type; out.bankMatches = m.entries;
      if (m.type === 'none') { out.status = STATUS.PENDING; out.reason = 'UTR not found in the bank statement (yet). Upload a fresher statement or check for a typo.'; return out; }
      if (m.entries.length > 1) {
        out.paid = m.entries.reduce((s, e) => s + e.amount, 0);
        out.status = STATUS.REVIEW; out.reason = 'UTR appears in ' + m.entries.length + ' bank credits — check manually.'; return out;
      }
      out.paid = m.entries[0].amount;
      if (m.type === 'loose') { out.status = STATUS.REVIEW; out.reason = 'Only a partial text match in the bank narration — confirm the highlighted bank row is really this payment.'; return out; }
      if (fee && out.paid < fee) { out.status = STATUS.UNDERPAID; out.reason = 'Paid ' + out.paid + ', fee is ' + fee + ' (short by ' + (fee - out.paid) + ').'; return out; }
      out.status = STATUS.VERIFIED;
      out.reason = fee && out.paid > fee ? 'Exact UTR match. Overpaid by ' + (out.paid - fee) + '.' : 'Exact UTR match with the required amount.';
      return out;
    });
    return { results, creditCount: index ? index.credits.length : 0 };
  }

  return { parseCSV, toTable, findBankHeader, guessReg, guessBank, normUtr, normPhone, parseAmount, countMembers, verify, STATUS };
});
