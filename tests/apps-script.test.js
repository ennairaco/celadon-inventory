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
const blank = n => Array(n).fill('');
// Mirrors the real '26-'27 Inventory Tracker: title rows, header on row 5, data in B:M.
const INV_HEAD = ['', 'Item', 'Type', 'Qty', 'Unit', 'Department', 'Category', 'Status', 'Storage Area', 'Specific Spot', 'Event', 'Owned/Borrowed', 'Notes'];
const inv = (item, qty, dept, status, storage, spot, event, owned) =>
  ['', item, 'Office Supplies', qty, qty === '*' ? '' : 'pcs', dept, 'Supplies', status, storage, spot, event, owned || 'Owned', ''];
const sheets = {
  Inventory: mkSheet('Inventory', [
    blank(13), ['', 'Celadon Inventory Tracker'], ['', 'GUIDELINES: Item names...'], blank(13), INV_HEAD,
    inv('Scissors', 1, 'COMMPUB', 'In Storage', 'Metal Drawer (Top)', 'Office supplies (2 boxes)', ''),
    inv('Scissors', 5, 'CUL', 'In Storage', '', 'CUL MAF Box', 'Mid-Autumn Festival'),
    inv('Tripods', 5, 'COMMPUB', 'In Storage', 'Metal Drawer (2nd from Top)', '', ''),
    inv('Masking Tape', 6, 'COMMPUB', 'In Storage', 'Metal Drawer (Top)', 'Office supplies box', ''),
    inv('Pushpins', '*', 'COMMPUB', 'In Storage', 'Metal Drawer (Top)', 'Office supplies box', ''),
    inv('Plastic Bowls', 17, 'CUL', 'Returned to Owner', '', '', 'Mid-Autumn Festival', 'Borrowed'),
    inv('Blue Cloth', 1, 'CUL', 'Out', '', '', 'Mid-Autumn Festival')
  ]),
  Celamerch: mkSheet('Celamerch', [
    blank(8), ['', 'Celamerch Inventory'], ['', 'As of June 22, 2026'], ['', 'Total', '', '', '', 564, 15],
    ['', 'School Year', 'Merch Design', 'Merch Type', 'Size', 'Count', 'Damaged Qty', 'Notes'],
    ['', '25-26', 'Koi', 'Lanyard', 'N/A', 52, '', ''],
    ['', '25-26', 'Zodiac Black', 'Shirt', 'M', 5, '', ''],
    ['', '24-25', 'White Prosper', 'Shirt', 'Mixed', '', 8, 'Damaged pieces']
  ]),
  Consumables: mkSheet('Consumables', [
    blank(10), ['', 'Consumables'], ['', 'Log items that expire here'], blank(10),
    ['', 'Item', 'Type', 'Qty', 'Unit', 'Department', 'Storage Area', 'Specific Spot', 'Expiry Date', 'Notes'],
    ['', 'Sunscreen', 'Toiletries & Hygiene', 13, 'pcs', 'HR', 'Rack (Top Shelf)', 'Black pouch organizer', new Date(today.getTime() + 5 * DAY), '']
  ]),
  ACCESS: mkSheet('ACCESS', [['ID Number', 'Name', 'Level', 'Email'], ['212348', 'Officer Tan', 'officer', 'tan@example.com']]),
  CORES: mkSheet('CORES', [['ID Number', 'Name', 'Project', 'Role'], ['212345', 'Juan', 'Mid-Autumn Festival', 'Core'], ['212346', 'Maria', 'Mid-Autumn Festival', 'Core']])
};
const MEMBER_ROWS = [
  ['ID Number', 'Name', 'Department', 'Position', 'Email'],
  [212345, 'Juan Dela Cruz', 'Communications and Publications', 'Associate', 'juan@example.com'],
  [212346, 'Maria Santos', 'CUL', 'Associate', 'maria@example.com'],
  [212347, 'Ana Lim', 'HR', 'Associate', ''],
  [212348, 'Officer Tan', 'FIN', 'VP', 'tan@example.com']
];
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
const invRow = (item, dept) => sheets.Inventory.data.find(r => r[1] === item && r[5] === dept);
const STATUS = 7, QTY = 3;
const snapshot = JSON.stringify(sheets.Inventory.data.map(r => r.slice()));

// Setup adds the app tabs only
api.setupSheets();
sheets.MEMBERS.data.length = 0; MEMBER_ROWS.forEach(r => sheets.MEMBERS.data.push(r));
['MEMBERS', 'ACCESS', 'PROJECTS', 'CORES', 'REQUESTS', 'BORROWED_NOW'].forEach(t => assert.ok(sheets[t], t + ' created'));
assert.ok(!sheets.CATALOG && !sheets.STORAGE_AREAS, 'no CATALOG/STORAGE_AREAS tabs');
assert.strictEqual(JSON.stringify(sheets.Inventory.data), snapshot, 'setup leaves Inventory untouched');
const mafRow = sheets.PROJECTS.data.findIndex(r => r[0] === 'Mid-Autumn Festival');
assert.ok(mafRow > 0, 'projects use the sheet\'s event names');
sheets.PROJECTS.data[mafRow][2] = new Date(today.getTime() + 3 * DAY);
assert.ok(sheets.BORROWED_NOW.formulas.A1.includes("'BORROWING'"));

// Catalog: all three tabs, hidden statuses dropped, same-name items kept apart
let items = get({ action: 'inventory' }).items;
const find = (title, cat) => items.find(i => i.title === title && i.category === cat);
assert.ok(!items.some(i => i.title === 'Plastic Bowls'), 'Returned to Owner rows hidden');
assert.ok(find('Scissors', 'COMMPUB') && find('Scissors', 'CUL'));
assert.notStrictEqual(find('Scissors', 'COMMPUB').ref, find('Scissors', 'CUL').ref);
assert.strictEqual(find('Scissors', 'CUL').location, 'CUL MAF Box', 'falls back to Specific Spot');
assert.ok(find('Koi Lanyard', 'Merch') && find('Zodiac Black Shirt (M)', 'Merch'));
assert.ok(!items.some(i => i.title.startsWith('White Prosper')), 'merch rows without a count skipped');
assert.ok(find('Sunscreen', 'HR').expiry, 'consumable expiry passed through');

// Login + acting-for rules
assert.deepStrictEqual(get({ action: 'login', id: '212345' }).actFor, ['COMMPUB', 'Mid-Autumn Festival']);
assert.deepStrictEqual(get({ action: 'login', id: '212348' }).actFor, ['*']);
assert.strictEqual(get({ action: 'login', id: '999999' }).found, false);
const cul = find('Scissors', 'CUL');
assert.match(post('submitOrder', { idNumber: '212345', caseType: 'BORROWING', items: [{ ref: cul.ref, title: 'Scissors', qty: 1 }] }).error, /Choose the project/);
assert.match(post('submitOrder', { idNumber: '212347', caseType: 'BORROWING', actingAs: 'Mid-Autumn Festival', items: [{ ref: cul.ref, title: 'Scissors', qty: 1 }] }).error, /only log requests/);

// Borrow all 5 CUL scissors for MAF → Status Out; COMMPUB scissors untouched
let r = post('submitOrder', { clientId: 'c1', idNumber: '212345', caseType: 'BORROWING', actingAs: 'Mid-Autumn Festival', items: [{ ref: cul.ref, title: 'Scissors', qty: 5 }] });
assert.ok(r.ok && r.logged === 1, JSON.stringify(r));
assert.strictEqual(Math.round((new Date(r.due) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / DAY), 4, 'due day after event');
assert.strictEqual(invRow('Scissors', 'CUL')[STATUS], 'Out');
assert.strictEqual(invRow('Scissors', 'COMMPUB')[STATUS], 'In Storage');
assert.strictEqual(post('submitOrder', { clientId: 'c1', idNumber: '212345', caseType: 'BORROWING', actingAs: 'Mid-Autumn Festival', items: [{ ref: cul.ref, title: 'Scissors', qty: 5 }] }).duplicate, true);
items = get({ action: 'inventory' }).items;
assert.strictEqual(find('Scissors', 'CUL').out, 5);
assert.strictEqual(find('Scissors', 'COMMPUB').out, 0);

// Partial borrow keeps In Storage
const tripods = find('Tripods', 'COMMPUB');
r = post('submitOrder', { clientId: 'c2', idNumber: '212345', caseType: 'BORROWING', actingAs: 'COMMPUB', items: [{ ref: tripods.ref, title: 'Tripods', qty: 2 }] });
assert.strictEqual(invRow('Tripods', 'COMMPUB')[STATUS], 'In Storage');
assert.ok(Math.abs(new Date(r.due) - today - 7 * DAY) < 60000, 'no event end date → 7 days');

// Use up: numeric qty deducted, hits 0 → Used Up (then hidden); "*" left alone; merch Count deducted
const tape = find('Masking Tape', 'COMMPUB'), pins = find('Pushpins', 'COMMPUB'), koi = find('Koi Lanyard', 'Merch');
r = post('submitOrder', { clientId: 'c3', idNumber: '212345', caseType: 'CONSUMING', actingAs: 'COMMPUB',
  items: [{ ref: tape.ref, title: tape.title, qty: 6 }, { ref: pins.ref, title: pins.title, qty: 3 }, { ref: koi.ref, title: koi.title, qty: 2 }] });
assert.ok(r.ok, JSON.stringify(r));
assert.strictEqual(invRow('Masking Tape', 'COMMPUB')[QTY], 0);
assert.strictEqual(invRow('Masking Tape', 'COMMPUB')[STATUS], 'Used Up');
assert.strictEqual(invRow('Pushpins', 'COMMPUB')[QTY], '*');
assert.strictEqual(sheets.Celamerch.data.find(x => x[2] === 'Koi')[5], 50);
assert.ok(!get({ action: 'inventory' }).items.some(i => i.title === 'Masking Tape'));

// Resolve: unrelated member denied; another MAF core can; Status back to In Storage
let hist = get({ action: 'history' }).records;
const mafLine = hist.find(x => x.project === 'Mid-Autumn Festival');
assert.match(post('resolve', { idNumber: '212347', lineId: mafLine.lineId }).error, /Only the borrower/);
assert.ok(post('resolve', { idNumber: '212346', lineId: mafLine.lineId }).ok);
assert.strictEqual(invRow('Scissors', 'CUL')[STATUS], 'In Storage');
assert.strictEqual(requests()[1][col('Resolved By')], 'Maria Santos');

// Checkout "Return" clears the project's borrow
post('submitOrder', { clientId: 'c4', idNumber: '212345', caseType: 'BORROWING', actingAs: 'Mid-Autumn Festival', items: [{ ref: cul.ref, title: 'Scissors', qty: 5 }] });
assert.strictEqual(invRow('Scissors', 'CUL')[STATUS], 'Out');
r = post('submitOrder', { clientId: 'c5', idNumber: '212346', caseType: 'RETURNING', actingAs: 'Mid-Autumn Festival', items: [{ ref: cul.ref, title: 'Scissors', qty: 5 }] });
assert.deepStrictEqual(r.warnings, []);
assert.strictEqual(invRow('Scissors', 'CUL')[STATUS], 'In Storage');
assert.strictEqual(invRow('Blue Cloth', 'CUL')[STATUS], 'Out', 'hand-set Out untouched');

// Daily check: overdue tripods + expiring sunscreen
const tripodRow = requests().findIndex(x => x[col('Item')] === 'Tripods');
requests()[tripodRow][col('Due')] = new Date(today.getTime() - 2 * DAY);
assert.strictEqual(get({ action: 'history' }).records.filter(x => x.overdue).length, 1);
props.EMAIL_BORROWERS = 'true';
const res = api.flagOverdue();
assert.deepStrictEqual(res, { overdue: 1, reminded: 1, expiring: 1 });
assert.strictEqual(mail[0].to, 'tan@example.com');
assert.match(mail[0].body, /Sunscreen.*expires in 5 days/);
assert.ok(mail.some(m => m.to === 'juan@example.com'), 'borrower emailed');
assert.strictEqual(api.flagOverdue().reminded, 0, 'no repeat overdue reminder the same day');

console.log('ALL APPS SCRIPT TESTS PASSED');
