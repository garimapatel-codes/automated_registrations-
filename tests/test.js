// Run: node tests/test.js   (all data here is invented)
const assert = require('assert');
const Core = require('../js/core.js');
const S = require('../js/statement.js');
const Vault = require('../js/vault.js');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n', e); process.exitCode = 1; } };

// ---------- fake OCR page ----------
function fakePage(rows, opts) {
  opts = opts || {};
  const W = []; const w = (text, left, top, width) => W.push({ text, left, top, width: width || text.length * 12, height: 24 });
  w('Date', 115, 96, 49); w('Narration', 563, 96, 102); w('Debit', 1789, 96, 56); w('Credit', 1948, 96, 67); w('Available', 2048, 96, 101); w('Balance', 2158, 96, 88);
  let y = 158;
  for (const r of rows) {
    w(r.dd + '-', 110, y, 33); w(r.mon + '-', 110, y + 26, 43); w('2026)', 110, y + 52, 50);
    w('BY', 229, y + 60, 30); w(r.narr, 265, y + 60, 600);
    if (r.credit != null) { const s = S.money(String(r.credit)) !== null ? '' : ''; const str = Number(r.credit).toLocaleString('en-IN', { minimumFractionDigits: 2 }); w(str, 2014 - str.length * 12, y + 60, str.length * 12); }
    if (r.debit != null) { const str = Number(r.debit).toLocaleString('en-IN', { minimumFractionDigits: 2 }); w(str, 1845 - str.length * 12, y + 60, str.length * 12); }
    const b = Number(r.bal).toLocaleString('en-IN', { minimumFractionDigits: 2 }); w(b, 2246 - b.length * 12, y + 60, b.length * 12);
    y += 190;
  }
  w('https://example.invalid/stmt', 68, y + 10, 500);
  return { words: W, width: 2339, height: 1654 };
}

(async () => {
  await t('statement: reads credits, skips debits, chain-checks balance', () => {
    const pg = fakePage([
      { dd: '03', mon: 'Oct', narr: 'TRANSFERUPI/CR/111122223333/ABC/ICIC/abc@ok', credit: 5900, bal: 100000.5 },
      { dd: '04', mon: 'Oct', narr: 'TRANSFERNEFT*PUNB0114310*PUNBH26274816750*XYZ', credit: 11800, bal: 111800.5 },
      { dd: '05', mon: 'Oct', narr: 'TRANSFERIMPS/999988887777/OUT', debit: 800, bal: 111000.5 },
      { dd: '06', mon: 'Oct', narr: 'TRANSFERUPI/CR/444455556666/DEF/SBIN/d@x', credit: 5900, bal: 116900.5 },
    ]);
    pg.words.push({ text: 'period', left: 100, top: 10, width: 60, height: 20 }); // header text for period test lives elsewhere
    const r = S.parseStatement([pg]);
    assert.strictEqual(r.rows, 4);
    assert.strictEqual(r.credits.length, 3);
    assert.strictEqual(r.chainBad, 0);
    assert.deepStrictEqual(r.credits.map((c) => c.amount), [5900, 11800, 5900]);
    assert.ok(S.tokensOf(r.credits[0].text).includes('111122223333'));
    assert.ok(S.tokensOf(r.credits[1].text).includes('PUNBH26274816750'));
    assert.strictEqual(r.credits[0].date, '2026-10-03');
  });
  await t('statement: a misread amount is flagged by the balance chain', () => {
    const pg = fakePage([
      { dd: '03', mon: 'Oct', narr: 'A', credit: 5900, bal: 1000 },
      { dd: '04', mon: 'Oct', narr: 'B', credit: 5800, bal: 6900 },   // balance says +5900
    ]);
    const r = S.parseStatement([pg]);
    assert.strictEqual(r.chainBad, 1);
    assert.strictEqual(r.credits[1].check, 'mismatch');
  });
  await t('statement: a missed date cell does not hide or merge payments', () => {
    const rows = [
      { dd: '03', mon: 'Oct', narr: 'TRANSFERUPI/CR/111122223333/A', credit: 5900, bal: 1000 },
      { dd: '04', mon: 'Oct', narr: 'TRANSFERUPI/CR/222233334444/B', credit: 8000, bal: 9000 },
      { dd: '05', mon: 'Oct', narr: 'TRANSFERUPI/CR/333344445555/C', credit: 8000, bal: 17000 },
      { dd: '06', mon: 'Oct', narr: 'TRANSFERUPI/CR/444455556666/D', credit: 5900, bal: 22900 },
    ];
    for (const drop of [['04-'], ['05-'], ['04-', '05-'], ['03-'], ['06-']]) {
      const pg = fakePage(rows);
      pg.words = pg.words.filter((w) => !(drop.includes(w.text) && w.left < 200));   // OCR failed to read these date starts
      const r = S.parseStatement([pg]);
      assert.deepStrictEqual(r.credits.map((c) => c.amount), [5900, 8000, 8000, 5900], 'dropped ' + drop);
      assert.strictEqual(r.chainBad, 0);
      assert.ok(r.credits.every((c, i) => S.tokensOf(c.text).includes(['111122223333', '222233334444', '333344445555', '444455556666'][i])), 'tokens stay with their own row, dropped ' + drop);
    }
  });
  await t('statement: period header', () => {
    assert.deepStrictEqual(S.parsePeriod('Account Statement for the period 01/10/2026 to 31/10/2026'), { from: '2026-10-01', to: '2026-10-31' });
  });

  await t('csv: quotes, newlines, BOM', () => {
    const rows = Core.parseCSV('﻿a,b\n"x, y","l1\nl2"\n');
    assert.deepStrictEqual(rows, [['a', 'b'], ['x, y', 'l1\nl2']]);
  });
  await t('phone: formats', () => {
    assert.deepStrictEqual(Core.normPhone('+91 98765 43210'), { num: '919876543210'.replace('9876543210', '9876543210'), ok: true });
    assert.strictEqual(Core.normPhone('09876543210').num, '919876543210');
    assert.strictEqual(Core.normPhone('12345').ok, false);
    assert.strictEqual(Core.normPhone('‎+971 50 123 4567').num, '971501234567');
  });
  await t('invite link validation', () => {
    assert.ok(Core.validInvite('https://chat.whatsapp.com/AbCdEfGhIjKlMn'));
    assert.ok(!Core.validInvite('http://chat.whatsapp.com/AbCdEfGhIjKlMn'));
    assert.ok(!Core.validInvite('https://evil.example/chat.whatsapp.com/AbCdEfGhIjKlMn'));
  });
  await t('google sheet url -> csv url', () => {
    assert.strictEqual(Core.sheetCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv'), 'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv');
    assert.strictEqual(Core.sheetCsvUrl('https://docs.google.com/spreadsheets/d/1AbC_d-9/edit#gid=77'), 'https://docs.google.com/spreadsheets/d/1AbC_d-9/gviz/tq?tqx=out:csv&gid=77');
    assert.strictEqual(Core.sheetCsvUrl('https://evil.example/x'), '');
  });

  // ---------- full flow ----------
  const HEAD = ['Timestamp', 'Email address', 'Name of the Institution', 'City of the Institution', 'Team Name', 'Team Member 1: Name (Team Leader)',
    'Team Member 1: Contact Number (WhatsApp enabled)', 'Team Member 1: Email ID', 'Team Member 2: Name', 'Team Member 2: Contact Number (WhatsApp enabled)', 'Team Member 2: Email ID',
    'Faculty Mentor: Name', 'Faculty Mentor: Contact Number (WhatsApp enabled)', 'Faculty Mentor: Email ID', 'Enter Transaction ID'];
  const row = (ts, em, team, ln, lp, mn, mp, txn, m2) => [ts, em, 'Inst', 'City', team, ln, lp, 'l@x', m2 || '', '', '', mn, mp, 'm@x', txn];
  const csv = [HEAD,
    row('22/10/2026 10:00:00', 'a@x', 'Alpha', 'Asha', '9876500001', 'Dr M', '9876500009', '111122223333', 'Bo'),
    row('23/10/2026 10:00:00', 'b@x', 'Bravo', 'Bina', '9876500002', 'Dr M', '9876500009', '444455556666', ''),
    row('24/10/2026 10:00:00', 'c@x', 'Charlie', 'Chet', '9876500003', '', '', '111122223333', ''),      // duplicate id
    row('25/10/2026 10:00:00', 'd@x', 'Delta', 'Dev', '98765', '', '', '777788889999', ''),            // bad phone
    row('26/10/2026 10:00:00', 'e@x', 'Echo', 'Eli', '9876500005', '', '', '555566667777', ''),        // no payment, in coverage
    row('05/11/2026 10:00:00', 'f@x', 'Foxtrot', 'Fay', '9876500006', '', '', '888899990000', ''),     // after coverage
    row('26/10/2026 11:00:00', 'g@x', 'Golf', 'Gus', '9876500007', '', '', 'CICAgPiJjtziOA', ''),     // non-numeric id
    row('26/10/2026 12:00:00', 'h@x', 'Hotel', 'Hal', '9876500008', '', '', '999900001111', ''),       // short payment
  ].map((r) => r.map((c) => '"' + c + '"').join(',')).join('\n');

  const pay = (amount, id, bal) => ({ date: '2026-10-10', amount, balance: bal, text: 'BY TRANSFERUPI/CR/' + id + '/NAME', check: 'ok' });
  function setup() {
    const st = Core.newState();
    st.settings.fee = '5900'; st.settings.feeMode = 'team'; st.settings.inviteLink = 'https://chat.whatsapp.com/AbCdEfGhIjKlMn1234';
    Core.loadRegistrations(st, Core.toTable(Core.parseCSV(csv)), 'file', 'f.csv');
    Core.addStatement(st, { id: 'f1', name: 'Oct.pdf', size: 1 }, { period: { from: '2026-10-01', to: '2026-10-31' }, rows: 5, chainBad: 0,
      credits: [pay(5900, '111122223333', 1), pay(5900, '444455556666', 2), pay(11800, '555500000000', 3), pay(1000, '999900001111', 4)] });
    return st;
  }
  const by = (d, name) => d.teams.find((x) => x.team === name);

  await t('matching: statuses', () => {
    const d = Core.compute(setup());
    assert.strictEqual(by(d, 'Alpha').status, 'VERIFIED');
    assert.strictEqual(by(d, 'Bravo').status, 'VERIFIED');
    assert.strictEqual(by(d, 'Charlie').status, 'DUPLICATE');
    assert.strictEqual(by(d, 'Delta').status, 'FIX');
    assert.strictEqual(by(d, 'Echo').status, 'NOMATCH');
    assert.strictEqual(by(d, 'Foxtrot').status, 'AWAITING');
    assert.strictEqual(by(d, 'Golf').status, 'CHECK');
    assert.strictEqual(by(d, 'Hotel').status, 'SHORT');
  });
  await t('fee must be set before anything is verified', () => {
    const st = setup(); st.settings.fee = '';
    assert.strictEqual(by(Core.compute(st), 'Alpha').status, 'NOFEE');
    assert.strictEqual(Core.queue(Core.compute(st)).length, 0);
  });
  await t('per-member fee', () => {
    const st = setup(); st.settings.feeMode = 'member';
    assert.strictEqual(by(Core.compute(st), 'Alpha').status, 'SHORT');   // 2 members x 5900
    assert.strictEqual(by(Core.compute(st), 'Alpha').required, 11800);
  });
  await t('queue: only verified, mentor once even for two teams', () => {
    const q = Core.queue(Core.compute(setup()));
    assert.deepStrictEqual(q.map((x) => x.role + ':' + x.name), ['leader:Asha', 'leader:Bina', 'mentor:Dr M']);
  });
  await t('send once: two-step flow, never twice', () => {
    const st = setup();
    const q = Core.queue(Core.compute(st));
    const r1 = Core.beginSend(st, q[0]); assert.ok(r1.ok); assert.ok(r1.url.startsWith('https://wa.me/919876500001?text='));
    assert.ok(decodeURIComponent(r1.url).includes('https://chat.whatsapp.com/AbCdEfGhIjKlMn1234'));
    assert.ok(!Core.beginSend(st, q[1]).ok, 'second send blocked while one is pending');
    assert.strictEqual(st.ledger.length, 0, 'nothing recorded until confirmed');
    assert.ok(Core.confirmSent(st).ok);
    assert.ok(!Core.beginSend(st, q[0]).ok, 'same number blocked');
    assert.strictEqual(Core.queue(Core.compute(st)).length, 2);
    // re-importing the same data must not bring them back
    Core.loadRegistrations(st, Core.toTable(Core.parseCSV(csv)), 'file', 'f.csv');
    assert.strictEqual(Core.queue(Core.compute(st)).length, 2);
  });
  await t('"didn\'t send" records nothing', () => {
    const st = setup(); const q = Core.queue(Core.compute(st));
    Core.beginSend(st, q[0]); Core.cancelPending(st);
    assert.strictEqual(st.ledger.length, 0); assert.strictEqual(Core.queue(Core.compute(st)).length, 3);
  });
  await t('undo puts someone back in the queue', () => {
    const st = setup(); const q = Core.queue(Core.compute(st));
    Core.beginSend(st, q[0]); Core.confirmSent(st);
    assert.ok(Core.undoSent(st, st.ledger[0].id).ok);
    assert.strictEqual(Core.queue(Core.compute(st)).length, 3);
  });
  await t('guard rails: bad link, daily limit', () => {
    const st = setup(); const q = Core.queue(Core.compute(st));
    st.settings.inviteLink = 'https://evil.example/x'; assert.ok(!Core.beginSend(st, q[0]).ok);
    st.settings.inviteLink = 'https://chat.whatsapp.com/AbCdEfGhIjKlMn1234'; st.settings.dailyLimit = 1;
    Core.beginSend(st, q[0]); Core.confirmSent(st);
    assert.ok(/Daily limit/.test(Core.beginSend(st, q[1]).error));
  });
  await t('manual approval needs a reason and unlocks sending', () => {
    const st = setup(); const d = Core.compute(st); const g = by(d, 'Golf');
    assert.ok(!Core.approveTeam(st, g.tid, ' ').ok);
    assert.ok(Core.approveTeam(st, g.tid, 'saw proof in Drive').ok);
    assert.strictEqual(by(Core.compute(st), 'Golf').status, 'APPROVED');
    assert.ok(Core.queue(Core.compute(st)).some((x) => x.name === 'Gus'));
  });
  await t('new payments flip waiting teams; removing a PDF flips them back', () => {
    const st = setup();
    Core.addStatement(st, { id: 'f2', name: 'Nov.pdf', size: 1 }, { period: { from: '2026-11-01', to: '2026-11-30' }, rows: 1, chainBad: 0, credits: [pay(5900, '888899990000', 9)] });
    assert.strictEqual(by(Core.compute(st), 'Foxtrot').status, 'VERIFIED');
    Core.removeStatement(st, 'f2');
    assert.strictEqual(by(Core.compute(st), 'Foxtrot').status, 'AWAITING');
  });
  await t('overlapping statements do not double-count', () => {
    const st = setup(); const before = st.payments.length;
    Core.addStatement(st, { id: 'f3', name: 'Oct-again.pdf', size: 1 }, { period: { from: '2026-10-01', to: '2026-10-31' }, rows: 1, chainBad: 0, credits: [pay(5900, '111122223333', 1)] });
    assert.strictEqual(st.payments.length, before);
  });
  await t('"new since last load" badge', () => {
    const st = setup();
    const more = csv + '\n' + row('24/10/2026 09:00:00', 'z@x', 'Zulu', 'Zed', '9876500010', '', '', '123456789012', '').map((c) => '"' + c + '"').join(',');
    const r = Core.loadRegistrations(st, Core.toTable(Core.parseCSV(more)), 'file', 'f2.csv');
    assert.strictEqual(r.added, 1);
    assert.ok(Core.compute(st).teams.find((x) => x.team === 'Zulu').isNew);
  });

  await t('add-myself mode: contacts files and sent-once', () => {
    const st = setup(); const q = Core.queue(Core.compute(st));
    const csv2 = Core.contactsCsv(st, q); assert.ok(csv2.includes('+919876500001') && csv2.includes('NACDeC-X - Asha'));
    assert.ok(Core.contactsVcf(st, q).includes('TEL;TYPE=CELL:+919876500009'));
    assert.strictEqual(Core.markAdded(st, q).n, 3);
    assert.strictEqual(Core.queue(Core.compute(st)).length, 0);
    assert.strictEqual(Core.markAdded(st, q).n, 0, 'second time adds nothing');
    assert.ok(!Core.beginSend(st, q[0]).ok, 'link send blocked after being added');
  });

  // ---------- vault ----------
  await t('vault: encrypts, unlocks, rejects wrong passphrase, backup/restore', async () => {
    const mem = {}; const store = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = v; }, removeItem: (k) => { delete mem[k]; } };
    const v = Vault.create(store); const st = setup();
    await v.setup('correct horse battery', st);
    const raw = store.getItem(Vault.KEY);
    assert.ok(!raw.includes('9876500001') && !raw.includes('Alpha'), 'no plaintext in storage');
    v.lock(); assert.ok(!v.isOpen());
    await assert.rejects(() => v.unlock('wrong pass'), /Wrong passphrase/);
    const back = await v.unlock('correct horse battery'); assert.strictEqual(back.reg.rows.length, 8);
    const bk = v.backupText();
    const v2 = Vault.create({ getItem: () => null, setItem() {}, removeItem() {} });
    await assert.rejects(() => v2.restore(bk, 'nope'), /Wrong passphrase/);
    const r = await v2.restore(bk, 'correct horse battery'); assert.strictEqual(r.ledger.length, 0);
    await v.changePass('correct horse battery', 'new pass phrase', back); v.lock();
    await assert.rejects(() => v.unlock('correct horse battery'));
    await v.unlock('new pass phrase');
  });

  console.log(`\n${n} checks passed`);
})();
