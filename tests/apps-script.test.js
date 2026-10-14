// Runs the Apps Script against an in-memory mock spreadsheet: node tests/apps-script.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'celadon-inventory.gs'), 'utf8');

// Anything not explicitly mocked is a chainable no-op, so formatting calls
// (setFontWeight, setNumberFormat, data validation builders…) just work.
function chain(base) {
  const p = new Proxy(base, {
    get: (t, k) => {
      if (!(k in t)) return () => p;
      if (typeof t[k] !== 'function' || !/^(set|clear)/.test(String(k))) return t[k];
      return (...args) => { const v = t[k](...args); return v === undefined ? p : v; };
    }
  });
  return p;
}

function mkSheet(name, data) {
  const notes = {};
  const sheet = {
    name, data, notes, formulas: {},
    getName: () => name,
    getLastRow: () => data.length,
    getLastColumn: () => Math.max(0, ...data.map(r => r.length)),
    getMaxRows: () => 1000,
    getDataRange: () => ({ getValues: () => data.map(r => r.slice()) }),
    clear: () => { data.length = 0; },
    getRange: (r, c, nr, nc) => {
      if (typeof r === 'string') {
        return chain({ setFormula: f => { sheet.formulas[r] = f; } });
      }
      return chain({
        setValues(v) { v.forEach((row, i) => { data[r - 1 + i] = data[r - 1 + i] || []; row.forEach((x, j) => { data[r - 1 + i][c - 1 + j] = x; }); }); },
        setValue(x) { data[r - 1] = data[r - 1] || []; data[r - 1][c - 1] = x; },
        getValue() { return (data[r - 1] || [])[c - 1]; },
        getValues() { return [((data[r - 1] || []).slice(c - 1, c - 1 + (nc || 1)))]; },
        getNote() { return notes[r + ',' + c] || ''; },
        setNote(n) { notes[r + ',' + c] = n; },
        setBackground(bg) { sheet.bg = sheet.bg || {}; sheet.bg[r] = bg; }
      });
    }
  };
  return chain(sheet);
}

const DAY = 86400000;
const today = new Date();
const sheets = {
  CATALOG: mkSheet('CATALOG', [
    ['Item', 'Category', 'Quantity', 'Storage Area', 'Specific Location', 'Notes', 'Last Updated'],
    ['Plastic Bowls', 'MAF', 17, 'Org Room', 'Shelf 2', '', ''],
    ['Tape', 'COMMPUB', 5, 'Metal Drawer (Top)', '', '', ''],
    ['Pushpins', 'COMMPUB', 'many', 'Metal Drawer (Top)', '', '', '']
  ]),
  MEMBERS: mkSheet('MEMBERS', [
    ['ID Number', 'Name', 'Department', 'Position', 'Email'],
    [212345, 'Juan Dela Cruz', 'Communications and Publications', 'Associate', 'juan@example.com'],
    [212346, 'Maria Santos', 'CUL', 'Associate', 'maria@example.com'],
    [212347, 'Ana Lim', 'HR', 'Associate', ''],
    [212348, 'Officer Tan', 'FIN', 'VP', 'tan@example.com']
  ]),
  ACCESS: mkSheet('ACCESS', [['ID Number', 'Name', 'Level', 'Email'], ['212348', 'Officer Tan', 'officer', 'tan@example.com']]),
  CORES: mkSheet('CORES', [['ID Number', 'Name', 'Project', 'Role'], ['212345', 'Juan', 'MAF', 'Core'], ['212346', 'Maria', 'MAF', 'Core']])
};
const ss = chain({
  getSheetByName: n => sheets[n] || null,
  getSheets: () => Object.values(sheets),
  insertSheet: n => (sheets[n] = mkSheet(n, []))
});
const mail = [];
const props = {};
const g = {
  SpreadsheetApp: chain({ getActiveSpreadsheet: () => ss, getUi: () => { throw new Error('no ui'); } }),
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Utilities: { formatDate: () => 'x' },
  Session: { getScriptTimeZone: () => 'Asia/Manila' },
  ContentService: { createTextOutput: t => ({ setMimeType: () => JSON.parse(t) }), MimeType: { JSON: 1 } },
  MailApp: { sendEmail: m => mail.push(m) },
  ScriptApp: chain({ getProjectTriggers: () => [] }),
  Logger: { log() {} }
};
const api = new Function(...Object.keys(g), src + '; return { doGet, doPost, setupSheets, flagOverdue };')(...Object.values(g));
const get = a => api.doGet({ parameter: a });
const post = (action, body) => api.doPost({ parameter: { action }, postData: { contents: JSON.stringify(body) } });
const requests = () => sheets.REQUESTS.data;
const col = h => requests()[0].indexOf(h);

api.setupSheets();
sheets.PROJECTS.data[10][2] = new Date(today.getTime() + 3 * DAY); // MAF ends in 3 days
assert.ok(sheets.BORROWED_NOW.formulas.A1.includes("'BORROWING'"), 'BORROWED_NOW query set up');
assert.ok(sheets.STORAGE_AREAS.data.some(r => r[0] === 'Metal Drawer (Top)'), 'storage areas seeded from CATALOG');

// Login: department (full name → code) + core projects; officers act for anything
let login = get({ action: 'login', id: '212345' });
assert.deepStrictEqual(login.actFor, ['COMMPUB', 'MAF']);
assert.deepStrictEqual(get({ action: 'login', id: '212348' }).actFor, ['*']);
assert.strictEqual(get({ action: 'login', id: '999999' }).found, false);

// Must act for a project/department the member belongs to
assert.match(post('submitOrder', { idNumber: '212345', caseType: 'BORROWING', items: [{ title: 'Tape', qty: 1 }] }).error, /Choose the project/);
assert.match(post('submitOrder', { idNumber: '212345', caseType: 'BORROWING', actingAs: 'Personal', items: [{ title: 'Tape', qty: 1 }] }).error, /Choose the project/);
assert.match(post('submitOrder', { idNumber: '212347', caseType: 'BORROWING', actingAs: 'MAF', items: [{ title: 'Tape', qty: 1 }] }).error, /only log requests/);

// Borrow for MAF (core) → due the day after the event end date
let r = post('submitOrder', { clientId: 'c1', idNumber: '212345', caseType: 'BORROWING', actingAs: 'MAF', items: [{ title: 'Plastic Bowls', qty: 5, location: 'Org Room' }] });
assert.ok(r.ok && r.logged === 1, JSON.stringify(r));
const due = new Date(r.due);
assert.strictEqual(Math.round((due - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / DAY), 4);
assert.strictEqual(post('submitOrder', { clientId: 'c1', idNumber: '212345', caseType: 'BORROWING', actingAs: 'MAF', items: [{ title: 'Plastic Bowls', qty: 5 }] }).duplicate, true);
assert.strictEqual(get({ action: 'inventory' }).items[0].out, 5);

// Borrow for own department → due in 7 days
r = post('submitOrder', { clientId: 'c2', idNumber: '212345', caseType: 'BORROWING', actingAs: 'COMMPUB', items: [{ title: 'Tape', qty: 1 }] });
assert.ok(Math.abs(new Date(r.due) - today - 7 * DAY) < 60000);

// Use up deducts numeric quantities only
r = post('submitOrder', { clientId: 'c3', idNumber: '212346', caseType: 'CONSUMING', actingAs: 'CUL', items: [{ title: 'Tape', qty: 2 }, { title: 'Pushpins', qty: 3 }] });
assert.ok(r.ok, JSON.stringify(r));
assert.strictEqual(sheets.CATALOG.data[2][2], 3);
assert.strictEqual(sheets.CATALOG.data[3][2], 'many');

// Resolving: unrelated member denied; another MAF core can resolve
let hist = get({ action: 'history' }).records;
const mafLine = hist.find(x => x.project === 'MAF');
assert.strictEqual(mafLine.resolved, false);
assert.match(post('resolve', { idNumber: '212347', lineId: mafLine.lineId }).error, /Only the borrower/);
assert.ok(post('resolve', { idNumber: '212346', lineId: mafLine.lineId }).ok);
assert.strictEqual(requests()[1][col('Resolved By')], 'Maria Santos');
assert.strictEqual(get({ action: 'inventory' }).items[0].out, 0);

// Checkout "Return" clears the project's borrow even when another core returns it
post('submitOrder', { clientId: 'c4', idNumber: '212345', caseType: 'BORROWING', actingAs: 'MAF', items: [{ title: 'Plastic Bowls', qty: 2 }] });
r = post('submitOrder', { clientId: 'c5', idNumber: '212346', caseType: 'RETURNING', actingAs: 'MAF', items: [{ title: 'Plastic Bowls', qty: 2 }] });
assert.deepStrictEqual(r.warnings, []);

// Overdue: the COMMPUB tape borrow, pushed into the past
const tapeRow = requests().findIndex(x => x[col('Item')] === 'Tape' && x[col('Case')] === 'BORROWING');
requests()[tapeRow][col('Due')] = new Date(today.getTime() - 2 * DAY);
hist = get({ action: 'history' }).records;
assert.strictEqual(hist.filter(x => x.overdue).length, 1);
props.EMAIL_BORROWERS = 'true';
let res = api.flagOverdue();
assert.deepStrictEqual(res, { overdue: 1, reminded: 1 });
assert.strictEqual(mail[0].to, 'tan@example.com', 'digest goes to ACCESS emails by default');
assert.ok(mail.some(m => m.to === 'juan@example.com'), 'borrower emailed');
assert.strictEqual(api.flagOverdue().reminded, 0, 'no repeat reminder the same day');

console.log('ALL APPS SCRIPT TESTS PASSED');
