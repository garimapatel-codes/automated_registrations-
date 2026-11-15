// Run: node tests/test.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const C = require('../js/core.js');
const rd = (f) => fs.readFileSync(path.join(__dirname, '../sample', f), 'utf8');

const regRows = C.parseCSV(rd('sample_registrations.csv'));
const reg = C.toTable(regRows, 0);
const bankRows = C.parseCSV(rd('sample_bank_statement.csv'));
const bank = C.toTable(bankRows, C.findBankHeader(bankRows));
assert.deepStrictEqual(bank.headers.slice(0, 3), ['Txn Date', 'Value Date', 'Description'], 'bank header row detected below preamble');

const regMap = C.guessReg(reg.headers), bankMap = C.guessBank(bank.headers);
assert.strictEqual(regMap.utr, 'UTR / Transaction ID');
assert.strictEqual(regMap.phone, 'Leader WhatsApp Number');
assert.strictEqual(regMap.team, 'Team Name');
assert.strictEqual(regMap.leader, 'Leader Name');
assert.strictEqual(bankMap.credit, 'Credit');

const { results, error } = C.verify(reg, regMap, bank, bankMap, { fee: 8000, maxTeam: 5, cc: '91' });
assert.ok(!error, error);
const by = Object.fromEntries(results.map((r) => [r.team, r]));
const expect = {
  'Byte Brigade': 'VERIFIED',      // 8,000.00 with quotes+comma
  'Null Pointers': 'VERIFIED',
  'Stack Overflowers': 'UNDERPAID', // 7500
  'Git Gud': 'PENDING',            // UTR not in bank
  'Merge Conflict': 'DUPLICATE',   // same UTR as Copycats
  'Copycats': 'DUPLICATE',
  'Overflow': 'REVIEW',            // 6 members
  'Typo Team': 'VERIFIED',         // "UTR 4123 4567 8907" normalised, found inside free-text narration
};
for (const [t, s] of Object.entries(expect)) assert.strictEqual(by[t].status, s, t + ' -> ' + by[t].status + ' (' + by[t].reason + ')');
assert.strictEqual(by['Byte Brigade'].phone, '919845011111');
assert.strictEqual(by['Null Pointers'].phone, '919845022222');
assert.strictEqual(by['Byte Brigade'].bankMatches[0].rowNo, 7);
assert.ok(!C.verify(reg, regMap, bank, bankMap, { fee: 8000, maxTeam: 5 }).results.some((r) => r.team === 'Stationery'), 'debit rows never match');
const X = require('../js/xlsx.js');
const bytes = X.build([{ name: 'T', header: true, rows: [['a', 'b'], ['x & <y>', 5]] }]);
assert.strictEqual(String.fromCharCode(bytes[0], bytes[1]), 'PK', 'xlsx is a zip');
console.log('All tests passed:', results.map((r) => r.team + '=' + r.status).join(', '));
