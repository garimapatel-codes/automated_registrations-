// Run: node tests/test.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const C = require('../js/core.js');
const rd = (f) => fs.readFileSync(path.join(__dirname, '../sample', f), 'utf8');

const regRows = C.parseCSV(rd('nacdec_form_responses_sample.csv'));
const reg = C.toTable(regRows, 0);
const bankRows = C.parseCSV(rd('sample_bank_statement.csv'));
const bank = C.toTable(bankRows, C.findBankHeader(bankRows));
assert.deepStrictEqual(bank.headers.slice(0, 3), ['Txn Date', 'Value Date', 'Description'], 'bank header row detected below preamble');

const regMap = C.guessReg(reg.headers), bankMap = C.guessBank(bank.headers);
assert.strictEqual(regMap.utr, 'Enter Transaction ID');
assert.strictEqual(regMap.phone, 'Team Member 1: Contact Number (WhatsApp enabled)');
assert.strictEqual(regMap.team, 'Team Name');
assert.strictEqual(regMap.leader, 'Team Member 1: Name (Team Leader)');
assert.strictEqual(regMap.email, 'Team Member 1: Email ID');
assert.strictEqual(regMap.institution, 'Name of the Institution');
assert.strictEqual(regMap.city, 'City of the Institution');
assert.strictEqual(regMap.proof, 'Upload Payment proof');
assert.strictEqual(regMap.members.length, 5, 'five member-name columns');
assert.strictEqual(bankMap.credit, 'Credit');

const { results, error } = C.verify(reg, regMap, bank, bankMap, { fee: 8000, maxTeam: 5, cc: '91' });
assert.ok(!error, error);
const by = Object.fromEntries(results.map((r) => [r.team, r]));
const expect = {
  'Team Astra': 'VERIFIED',   // 5 members, quoted amount "8,000.00"
  'Team Vyom': 'VERIFIED',    // phone typed as "+91 98450 22222"
  'Team Agni': 'UNDERPAID',   // 7500
  'Team Pushpak': 'PENDING',  // UTR not in bank
  'Team Gagan': 'DUPLICATE',  // same UTR as Team Nabh
  'Team Nabh': 'DUPLICATE',
  'Team Rohini': 'VERIFIED',  // typed "UTR No: 4123 4567 8906", bank says IMPS/...
  'Team Maitri': 'REVIEW',    // phone "12345" is invalid
};
for (const [t, s] of Object.entries(expect)) assert.strictEqual(by[t].status, s, t + ' -> ' + by[t].status + ' (' + by[t].reason + ')');
assert.strictEqual(by['Team Astra'].teamSize, 5);
assert.strictEqual(by['Team Vyom'].teamSize, 3);
assert.strictEqual(by['Team Astra'].phone, '919845011111');
assert.strictEqual(by['Team Vyom'].phone, '919845022222');
assert.strictEqual(by['Team Astra'].institution, 'Sample Institute of Technology');
assert.strictEqual(by['Team Astra'].proof, 'https://drive.google.com/open?id=PROOF_001');
assert.strictEqual(by['Team Astra'].bankMatches[0].rowNo, 7);
// a quoted header containing newlines and doubled quotes must survive parsing
assert.ok(reg.headers.some((h) => h.includes('Self Motivation') && h.includes('"None"')), 'quoted header parsed');
assert.ok(reg.headers.some((h) => h.startsWith('Duly signed') && h.includes('\n')), 'multi-line header parsed');
const X = require('../js/xlsx.js');
const bytes = X.build([{ name: 'T', header: true, rows: [['a', 'b'], ['x & <y>', 5]] }]);
assert.strictEqual(String.fromCharCode(bytes[0], bytes[1]), 'PK', 'xlsx is a zip');
console.log('All tests passed:', results.map((r) => r.team + '=' + r.status).join(', '));
