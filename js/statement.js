/*
 * statement.js — turns OCR word boxes of a printed bank statement into credit transactions.
 * Pure logic (no DOM). Input: pages = [{ words: [{text,left,top,width,height}], width, height }]
 * Works from column positions (Debit / Credit / Balance header words), so it does not depend on line order.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Statement = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const MONEY = /^\d[\d,]*\.\d{2}$/;
  const validGroup = (x) => /^\d{1,3}(\.\d+)?$/.test(x) || /^\d{1,2}(,\d{2})*,\d{3}(\.\d+)?$/.test(x);
  /** A money token can carry a glued currency symbol that OCR reads as a digit ("₹5,900.00" -> "25,900.00"),
   *  so return every plausible reading; the running-balance check picks the right one later. */
  function moneyCands(t) {
    const s = String(t).replace(/^[^\d]+/, '').replace(/[^\d.,]+$/, '');
    if (!MONEY.test(s)) return [];
    const out = [];
    const add = (x) => { if (MONEY.test(x)) out.push({ v: parseFloat(x.replace(/,/g, '')), ok: validGroup(x) }); };
    add(s);
    if (s.indexOf('.') > 1) add(s.slice(1).replace(/^,/, ''));
    return out.sort((a, b) => (b.ok ? 1 : 0) - (a.ok ? 1 : 0));
  }
  const money = (t) => { const c = moneyCands(t); return c.length ? c[0].v : null; };
  const pad = (n) => String(n).padStart(2, '0');

  /** "for the period 01/10/2026 to 31/10/2026" -> {from:'2026-10-01', to:'2026-10-31'} */
  function parsePeriod(text) {
    const m = /period\s+(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\s+to\s+(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/i.exec(text || '');
    if (!m) return null;
    return { from: `${m[3]}-${pad(m[2])}-${pad(m[1])}`, to: `${m[6]}-${pad(m[5])}-${pad(m[4])}` };
  }

  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

  /** Finds the header row (Narration … Debit Credit … Balance) on a page and returns column right-edges. */
  function findColumns(words) {
    const find = (re) => words.filter((w) => re.test(w.text));
    for (const nar of find(/^narration$/i)) {
      const same = (w) => Math.abs(w.top - nar.top) < nar.height * 1.2;
      const d = words.find((w) => same(w) && /^debit$/i.test(w.text));
      const c = words.find((w) => same(w) && /^credit$/i.test(w.text));
      const b = words.filter((w) => same(w) && /^balance$/i.test(w.text)).pop();
      const dateW = words.find((w) => same(w) && /^date$/i.test(w.text));
      if (c && b) {
        const cR = c.left + c.width, bR = b.left + b.width;
        const dR = d ? d.left + d.width : cR - (bR - cR) * 0.9;
        const dateCut = dateW ? dateW.left + (nar.left - dateW.left) * 0.2 : nar.left * 0.35;
        return { headerBottom: nar.top + nar.height, narLeft: nar.left, dateCut, cR, dR, bR };
      }
    }
    return null;
  }

  function parseDateWords(ws, fallbackYear) {
    const toks = ws.map((w) => w.text);
    const day = (toks.map((t) => /^\(?(\d{1,2})-?$/.exec(t)).find(Boolean) || [])[1];
    const mon = toks.map((t) => /^([A-Za-z]{3})-?$/.exec(t)).find((m) => m && MONTHS[m[1].toLowerCase()]);
    const yr = toks.map((t) => /^(\d{4})\)?$/.exec(t)).find(Boolean);
    if (!day || !mon) return { date: '', day: day ? +day : 0, mon: mon ? MONTHS[mon[1].toLowerCase()] : 0 };
    const y = yr ? +yr[1] : fallbackYear || 0;
    return { date: y ? `${y}-${pad(MONTHS[mon[1].toLowerCase()])}-${pad(+day)}` : '', day: +day, mon: MONTHS[mon[1].toLowerCase()] };
  }

  /** Extract rows from one page. */
  function parsePage(page, ctx) {
    const words = page.words.filter((w) => w.text && w.text.trim());
    const cols = findColumns(words) || ctx.cols;
    if (!cols) return { rows: [], skipped: true };
    ctx.cols = cols;
    const tol = Math.max(25, (cols.cR - cols.dR) * 0.45);
    // date-column words below the header
    const dateWords = words.filter((w) => w.top > cols.headerBottom && w.left < cols.dateCut);
    const starts = dateWords.filter((w) => /^\d{2}-$/.test(w.text)).sort((a, b) => a.top - b.top);
    // footer: URL / page-number line cuts the last band
    const footer = words.filter((w) => /^https?:\/\//i.test(w.text) && w.top > cols.headerBottom).map((w) => w.top);
    const pageEnd = footer.length ? Math.min.apply(null, footer) - 4 : Infinity;
    const lineH = median(words.map((w) => w.height)) || 20;

    // Row bands start at each date. The first band also covers anything above the first date, and a page with no
    // readable date still gets one band — a missed date must never hide a payment.
    const tops = starts.map((st) => st.top - lineH * 0.4);
    const edges = starts.length ? [cols.headerBottom].concat(tops.slice(1), [pageEnd]) : [cols.headerBottom, pageEnd];
    const isAmt = (w) => moneyCands(w.text).length && w.left + w.width > cols.dR - tol * 1.6;
    const cy = (w) => w.top + w.height / 2;

    const rows = [];
    const emit = (band, lo, hi) => {
      const dws = band.filter((w) => w.left < cols.dateCut);
      const rest = band.filter((w) => w.left >= cols.dateCut);
      const dt = parseDateWords(dws.slice().sort((a, b) => a.top - b.top), ctx.fallbackYear);
      let credC = [], debC = [], balC = [];
      const textWords = [];
      for (const w of rest) {
        const v = moneyCands(w.text);
        const right = w.left + w.width;
        if (v.length && right > cols.dR - tol * 1.6) {
          if (Math.abs(right - cols.bR) <= tol) balC = v;
          else if (Math.abs(right - cols.cR) <= tol) credC = v;
          else if (Math.abs(right - cols.dR) <= tol) debC = v;
        } else if (right < cols.dR - tol * 1.6) textWords.push(w);
      }
      textWords.sort((a, b) => (Math.abs(a.top - b.top) > lineH * 0.5 ? a.top - b.top : a.left - b.left));
      const text = textWords.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
      rows.push({ date: dt.date, credC, debC, balC, text });
    };
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i], hi = edges[i + 1];
      const band = words.filter((w) => cy(w) >= lo && cy(w) < hi);
      // money lines inside this band; two or more means two transactions were glued together -> split between them
      const ys = band.filter(isAmt).map(cy).sort((a, b) => a - b);
      const lines = [];
      ys.forEach((y) => { if (!lines.length || y - lines[lines.length - 1].y2 > lineH * 1.3) lines.push({ y1: y, y2: y }); else lines[lines.length - 1].y2 = y; });
      if (lines.length < 2) { emit(band, lo, hi); continue; }
      const cuts = [lo];
      for (let k = 0; k + 1 < lines.length; k++) cuts.push((lines[k].y2 + lines[k + 1].y1) / 2);
      cuts.push(hi);
      for (let k = 0; k < cuts.length - 1; k++) emit(band.filter((w) => cy(w) >= cuts[k] && cy(w) < cuts[k + 1]), cuts[k], cuts[k + 1]);
    }
    return { rows };
  }

  /** Flatten OCR pages into rows, chain-check balances, return credits only. */
  function parseStatement(pages, opts) {
    opts = opts || {};
    const allText = pages.map((p) => p.words.map((w) => w.text).join(' ')).join(' ');
    const period = parsePeriod(allText) || opts.period || null;
    const ctx = { cols: null, fallbackYear: period ? +period.to.slice(0, 4) : 0 };
    let rows = [];
    let skippedPages = 0;
    pages.forEach((p) => { const r = parsePage(p, ctx); if (r.skipped) skippedPages++; rows = rows.concat(r.rows); });

    // Running-balance check: each row's balance must equal previous balance +credit / -debit. This also picks the right
    // reading when OCR glued a currency symbol onto a number.
    let prev = null, chainOk = 0, chainBad = 0;
    const r2 = (x) => Math.round(x * 100) / 100;
    for (const r of rows) {
      let hit = null;
      if (prev !== null) {
        outer: for (const b of r.balC) {
          for (const c of r.credC) if (Math.abs(prev + c.v - b.v) < 0.006) { hit = { balance: b.v, credit: c.v }; break outer; }
          for (const d of r.debC) if (Math.abs(prev - d.v - b.v) < 0.006) { hit = { balance: b.v, debit: d.v }; break outer; }
        }
      }
      if (hit) { r.balance = hit.balance; r.credit = hit.credit == null ? null : hit.credit; r.debit = hit.debit == null ? null : hit.debit; r.chain = 'ok'; chainOk++; }
      else {
        r.balance = r.balC.length ? r.balC[0].v : null;
        r.credit = r.credC.length ? r.credC[0].v : null; r.debit = r.debC.length ? r.debC[0].v : null;
        if (prev !== null && r.balance !== null) {
          const d = r2(r.balance - prev);
          if (r.credit === null && r.debit === null) { if (d > 0) { r.credit = d; r.inferred = true; } else if (d < 0) { r.debit = -d; r.inferred = true; } }
          else { r.chain = 'mismatch'; r.chainAmount = Math.abs(d); chainBad++; }
        }
      }
      if (r.balance !== null) prev = r.balance;
      else if (prev !== null && (r.credit !== null || r.debit !== null)) prev = r2(prev + (r.credit || 0) - (r.debit || 0));
    }
    const credits = rows.filter((r) => r.credit !== null && r.credit > 0 && r.debit === null).map((r) => ({
      date: r.date, amount: r.credit, balance: r.balance, text: r.text, check: r.chain || (r.inferred ? 'inferred' : 'unchecked'),
      chainAmount: r.chainAmount,
    }));
    return { period, rows: rows.length, credits, chainOk, chainBad, skippedPages };
  }

  /** Candidate reference tokens inside a narration or a typed transaction id. */
  function tokensOf(text) {
    const t = String(text || '').toUpperCase();
    const out = new Set();
    (t.match(/(?<![0-9])[0-9]{12}(?![0-9])/g) || []).forEach((x) => out.add(x));
    (t.match(/[A-Z0-9]{10,25}/g) || []).forEach((x) => { if (/[0-9]/.test(x) && /[A-Z]/.test(x)) out.add(x); });
    return Array.from(out);
  }

  return { parseStatement, parsePeriod, tokensOf, findColumns, money, moneyCands };
});
