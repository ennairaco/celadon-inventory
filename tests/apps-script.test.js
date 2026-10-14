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
        setBackground(bg) { sheet.bg = sheet.bg || {}; sheet.bg[r] = bg; },
        getDataValidation() { const v = (sheet.validation || {})[c]; return v ? { getCriteriaValues: () => [v] } : null; }
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
  ACCESS: mkSheet('ACCESS', [['ID Number', 'Name', 'Level', 'Email'], ['212348', 'Officer Tan', 'officer', 'tan@example.com']])
};
const MEMBER_ROWS = [
  ['ID Number', 'Name', 'Department', 'Position', 'Email'],
  [212345, 'Juan Dela Cruz', 'Communications and Publications', 'Associate', 'juan@example.com'],
  [212346, 'Maria Santos', 'CUL', 'Associate', 'maria@example.com'],
  [212347, 'Ana Lim', 'HR', 'Associate', ''],
  [212348, 'Officer Tan', 'FIN', 'VP', 'tan@example.com'],
  [212349, 'Pres Uy', 'Office of the President', 'President', '']
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
  Utilities: { formatDate: () => 'x', getUuid: () => Math.random().toString(16).slice(2) + Date.now().toString(16) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
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
['MEMBERS', 'ACCESS', 'PROJECTS', 'REQUESTS', 'BORROWED_NOW'].forEach(t => assert.ok(sheets[t], t + ' created'));
assert.ok(!sheets.CATALOG && !sheets.STORAGE_AREAS && !sheets.CORES, 'no CATALOG/STORAGE_AREAS/CORES tabs');
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

// Login: everyone may pick any project/department; department comes back for the default
const juan = get({ action: 'login', id: '212345' });
assert.deepStrictEqual(juan.actFor, ['*']);
assert.strictEqual(juan.department, 'COMMPUB');
assert.strictEqual(get({ action: 'login', id: '999999' }).found, false);
assert.strictEqual(get({ action: 'login', id: '212349' }).department, 'OP', 'Office of the President → OP');
assert.ok(get({ action: 'projects' }).projects.includes('OP'));
const cul = find('Scissors', 'CUL');
assert.match(post('submitOrder', { idNumber: '212345', caseType: 'BORROWING', items: [{ ref: cul.ref, title: 'Scissors', qty: 1 }] }).error, /Choose the project/);
assert.match(post('submitOrder', { idNumber: '212347', caseType: 'BORROWING', actingAs: 'Made-up Event', items: [{ ref: cul.ref, title: 'Scissors', qty: 1 }] }).error, /not in the PROJECTS list/);
assert.match(post('submitOrder', { idNumber: '000001', caseType: 'BORROWING', actingAs: 'HR', items: [{ ref: cul.ref, title: 'Scissors', qty: 1 }] }).error, /not in the member list/);

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

// Add stock: numeric Qty goes up, "*" left alone
const tripodsBefore = invRow('Tripods', 'COMMPUB')[QTY];
r = post('submitOrder', { clientId: 'r1', idNumber: '212345', caseType: 'RESTOCKING', actingAs: 'COMMPUB',
  items: [{ ref: tripods.ref, title: 'Tripods', qty: 3 }, { ref: pins.ref, title: pins.title, qty: 10 }] });
assert.ok(r.ok, JSON.stringify(r));
assert.strictEqual(invRow('Tripods', 'COMMPUB')[QTY], tripodsBefore + 3);
assert.strictEqual(invRow('Pushpins', 'COMMPUB')[QTY], '*');

// Add-item form options come from the Inventory tab's dropdowns
sheets.Inventory.validation = { 3: ['Office Supplies', 'Art & Craft Supplies', 'Toiletries & Hygiene'], 6: ['General', 'OP', 'COMMPUB', 'CUL', 'HR'],
  7: ['Supplies', 'Equipment'], 9: ['Metal Drawer (Top)', 'Shelf'] };
const opts = get({ action: 'options' }).options;
assert.deepStrictEqual(opts.departments, ['General', 'OP', 'COMMPUB', 'CUL', 'HR']);
assert.deepStrictEqual(opts.storageAreas, ['Metal Drawer (Top)', 'Shelf']);

// Add a new item → appended right after the last item row, In Storage, listed, logged
const lastBefore = sheets.Inventory.data.length;
r = post('addItem', { idNumber: '212346', title: 'Glitter Glue', qty: '12', unit: 'pcs', department: 'CUL', type: 'Art & Craft Supplies',
  category: 'Supplies', storage: 'Shelf', spot: 'CUL Bag 1', notes: 'For LDP' });
assert.ok(r.ok && r.tab === 'Inventory', JSON.stringify(r));
const added = sheets.Inventory.data[r.row - 1];
assert.strictEqual(r.row, lastBefore + 1, 'written to the next empty row');
assert.deepStrictEqual([added[1], added[3], added[5], added[STATUS], added[8], added[9]], ['Glitter Glue', 12, 'CUL', 'In Storage', 'Shelf', 'CUL Bag 1']);
assert.ok(get({ action: 'inventory' }).items.some(i => i.title === 'Glitter Glue' && i.ref === r.ref));
assert.ok(requests().some(x => x[col('Case')] === 'ADDING' && x[col('Item')] === 'Glitter Glue' && x[col('Name')] === 'Maria Santos'));

// Duplicates refused; bad qty refused; non-members refused
const base = { idNumber: '212346', title: 'Tape', qty: '2', department: 'CUL', type: 'Office Supplies', category: 'Supplies', storage: 'Shelf' };
const add = extra => post('addItem', Object.assign({}, base, extra));
assert.match(add({ title: 'glitter glue', qty: '1', type: 'Art & Craft Supplies', spot: 'CUL Bag 1' }).error, /already in the inventory/);
assert.match(add({ qty: 'two' }).error, /whole number/);
assert.match(add({ qty: '0' }).error, /between 1 and/);
assert.match(add({ qty: '99999' }).error, /whole number|between/);
assert.match(add({ idNumber: '000001' }).error, /not in the member list/);
assert.match(add({ department: '' }).error, /department/);
assert.match(add({ department: 'Made Up Dept' }).error, /not one of the department options/);
assert.match(add({ type: '' }).error, /type/);
assert.match(add({ category: 'Weird' }).error, /not one of the category options/);
assert.match(add({ title: 'x' }).error, /at least 2/);
assert.match(add({ title: '=IMPORTRANGE("x")' }).error, /can't start with/);
assert.match(add({ unit: '<b>' }).error, /Unit should be/);
assert.match(add({ storage: '', spot: '' }).error, /storage area or a specific spot/);
assert.match(add({ expiry: '1999-01-01' }).error, /Check the year/);
// Formula-looking notes/spots are stored as plain text
r = add({ title: 'Glue Sticks', notes: '=HYPERLINK("http://x")', spot: '+ box 2' });
assert.ok(r.ok, JSON.stringify(r));
const glueRow = sheets.Inventory.data[r.row - 1];
assert.strictEqual(glueRow[INV_HEAD.indexOf('Notes')], "'=HYPERLINK(\"http://x\")");
assert.strictEqual(glueRow[INV_HEAD.indexOf('Specific Spot')], "'+ box 2");
// A brand-new storage area is accepted and joins the dropdown
r = add({ title: 'Banner Stand', type: 'Office Supplies', category: 'Supplies', storage: 'Locker 3' });
assert.ok(r.ok, JSON.stringify(r));
assert.strictEqual(sheets.Inventory.data[r.row - 1][INV_HEAD.indexOf('Storage Area')], 'Locker 3');

// Expiry date → Consumables tab
r = post('addItem', { idNumber: '212347', title: 'Hand Sanitizer', qty: '6', unit: 'bottles', department: 'HR', type: 'Toiletries & Hygiene', category: 'Supplies', storage: 'Shelf', expiry: new Date(today.getTime() + 60 * DAY).toISOString() });
assert.strictEqual(r.tab, 'Consumables');
assert.ok(sheets.Consumables.data.some(x => x[1] === 'Hand Sanitizer' && x[8] instanceof Date));

// Re-adding a Used Up item brings the old row back instead of duplicating it
const tapeRows = () => sheets.Inventory.data.filter(x => x[1] === 'Masking Tape').length;
r = post('addItem', { idNumber: '212345', title: 'Masking Tape', qty: '4', department: 'COMMPUB', type: 'Office Supplies', category: 'Supplies', storage: 'Metal Drawer (Top)', spot: 'Office supplies box' });
assert.ok(r.ok && r.revived, JSON.stringify(r));
assert.strictEqual(tapeRows(), 1);
assert.strictEqual(invRow('Masking Tape', 'COMMPUB')[QTY], 4);
assert.strictEqual(invRow('Masking Tape', 'COMMPUB')[STATUS], 'In Storage');

// Resolve: any member can (HR's Ana returns MAF's scissors); Status back to In Storage
let hist = get({ action: 'history' }).records;
const mafLine = hist.find(x => x.project === 'Mid-Autumn Festival');
assert.match(post('resolve', { idNumber: '000001', lineId: mafLine.lineId }).error, /not in the member list/);
assert.ok(post('resolve', { idNumber: '212347', lineId: mafLine.lineId }).ok);
assert.strictEqual(invRow('Scissors', 'CUL')[STATUS], 'In Storage');
assert.strictEqual(requests()[1][col('Resolved By')], 'Ana Lim');

// Bulk resolve: several lines in one call; repeats and unknown IDs reported, not fatal
const pendingBefore = new Set(get({ action: 'history' }).records.filter(x => !x.resolved).map(x => x.lineId));
post('submitOrder', { clientId: 'b1', idNumber: '212345', caseType: 'BORROWING', actingAs: 'COMMPUB', items: [{ ref: find('Scissors', 'COMMPUB').ref, title: 'Scissors', qty: 1 }] });
post('submitOrder', { clientId: 'b2', idNumber: '212346', caseType: 'BORROWING', actingAs: 'COMMPUB', items: [{ ref: tripods.ref, title: 'Tripods', qty: 1 }] });
const bulkLines = get({ action: 'history' }).records.filter(x => !x.resolved && !pendingBefore.has(x.lineId)).map(x => x.lineId);
assert.strictEqual(bulkLines.length, 2);
const bulk = post('resolve', { idNumber: '212347', lineIds: bulkLines.concat([mafLine.lineId, 'NOPE-1']) });
assert.ok(bulk.ok, JSON.stringify(bulk));
assert.deepStrictEqual(bulk.resolved.slice().sort(), bulkLines.slice().sort());
assert.deepStrictEqual(bulk.alreadyResolved, [mafLine.lineId]);
assert.deepStrictEqual(bulk.missing, ['NOPE-1']);
assert.strictEqual(invRow('Scissors', 'COMMPUB')[STATUS], 'In Storage', 'status restored after bulk return');

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

// ---- Review fixes ----
// Writes must be POST
assert.match(get({ action: 'submitOrder', idNumber: '212345', caseType: 'BORROWING' }).error, /Use POST/);
// Asking for more than is left -> warning (still logged)
r = post('submitOrder', { clientId: 'w1', idNumber: '212345', caseType: 'BORROWING', actingAs: 'COMMPUB', items: [{ ref: find('Scissors', 'COMMPUB').ref, title: 'Scissors', qty: 50 }] });
assert.ok(r.ok && r.warnings.some(w => /only 1 left/.test(w)), JSON.stringify(r));
// Qty is capped
const capLine = get({ action: 'history' }).records.find(x => x.item === 'Scissors' && x.project === 'COMMPUB' && !x.resolved);
assert.ok(Number(capLine.qty) <= 9999);
// A stale ref never falls back to another department's same-name item
r = post('submitOrder', { clientId: 'w2', idNumber: '212345', caseType: 'CONSUMING', actingAs: 'CUL', items: [{ ref: 'inventory:scissors|cul|gone|', title: 'Scissors', qty: 1 }] });
assert.ok(r.warnings.some(w => /Not found/.test(w)));
assert.strictEqual(invRow('Scissors', 'COMMPUB')[QTY], 1, 'COMMPUB scissors untouched');
// Borrowing some of a "*" item doesn't mark the whole row Out
post('submitOrder', { clientId: 'w3', idNumber: '212345', caseType: 'BORROWING', actingAs: 'COMMPUB', items: [{ ref: pins.ref, title: pins.title, qty: 5 }] });
assert.strictEqual(invRow('Pushpins', 'COMMPUB')[STATUS], 'In Storage');
// Chinese item names get distinct refs
r = add({ title: '红包 Red Envelopes', type: 'Office Supplies', category: 'Supplies', storage: 'Shelf' });
assert.ok(r.ok && /红包/.test(r.ref), JSON.stringify(r));
// History reports when a line was resolved
assert.ok(get({ action: 'history' }).records.some(x => x.resolved && x.resolvedAt));
// Committee text can't become a formula in REQUESTS
post('submitOrder', { clientId: 'w4', idNumber: '212345', caseType: 'CONSUMING', actingAs: 'COMMPUB', committee: '=1+1', items: [{ ref: pins.ref, title: pins.title, qty: 1 }] });
assert.strictEqual(requests()[requests().length - 1][col('Department/Reason')], "'=1+1");

console.log('ALL APPS SCRIPT TESTS PASSED');
