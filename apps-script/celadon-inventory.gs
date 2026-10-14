/*
 * Ateneo Celadon — Inventory (CelaCart) Apps Script backend
 *
 * One script for the whole app: login, catalog, projects, requests, history,
 * project/department accountability, overdue and expiry reminders. Adapted
 * from MEA's app (github.com/David-GY/mea-id), minus the ID Tracker and SUS
 * Dashboard, which are MEA-specific.
 *
 * Built around the "'26-'27 Inventory Tracker" sheet. The app reads (and
 * updates Qty/Status on) these existing tabs — it never adds or removes rows:
 *   Inventory     Item | Type | Qty | Unit | Department | Category | Status |
 *                 Storage Area | Specific Spot | Event | Owned/Borrowed | Notes
 *   Celamerch     School Year | Merch Design | Merch Type | Size | Count | Damaged Qty | Notes
 *   Consumables   Item | Type | Qty | Unit | Department | Storage Area | Specific Spot | Expiry Date | Notes
 * Header rows are found by name, so title/guideline rows above them are fine.
 *
 * Tabs this script adds (setupSheets; never touches the three above):
 *   MEMBERS        ID Number | Name | Department | Position | Email
 *                  (or point MEMBERS_SPREADSHEET_ID at the existing members sheet)
 *   ACCESS         ID Number | Name | Level | Email   (officers: get the daily email)
 *   PROJECTS       Project/Dept | Active | Event End Date
 *   REQUESTS       written by the app — one row per item per request
 *   BORROWED_NOW   live view of everything still out (formula, read-only)
 *
 * Every borrow or use-up is made *for* a project or department, never
 * personally. Any member picks one from the active PROJECTS list (the app
 * pre-selects their own department). Any member can mark a borrow returned;
 * REQUESTS records who did.
 *
 * Routes:
 GET  ?action=login&id=123456   member lookup (name, department)
 *   GET  ?action=inventory         items from Inventory + Celamerch + Consumables
 *   GET  ?action=projects          active project/department list
 *   GET  ?action=history           borrow/use-up records
 *   POST ?action=submitOrder       borrow / use up / return request
 *   POST ?action=resolve           mark one borrowed line as returned
 *   GET  ?action=options           dropdown lists from the Inventory tab (for the Add form)
 *   POST ?action=addItem           add a new item row (Inventory, or Consumables if it expires)
 *
 * Optional Script Properties (Project Settings > Script properties):
 *   ACCESS_TOKEN             shared token; when set, the app must send it
 *   SPREADSHEET_ID           only if the script is standalone instead of bound
 *   MEMBERS_SPREADSHEET_ID   read members from another spreadsheet
 *   MEMBERS_SHEET_NAME       tab in that spreadsheet (default: first tab)
 *   DEDUCT_ON_CONSUME        'false' to stop "Use up" requests lowering Qty
 *   BORROW_DAYS              days a borrow may stay out when the project has
 *                            no Event End Date (default 7)
 *   REMIND_EVERY_DAYS        days between repeat overdue reminders (default 3)
 *   EXPIRY_WARN_DAYS         flag Consumables expiring within this many days (default 14)
 *   NOTIFY_EMAILS            comma-separated inbox(es) for the daily digest
 *                            (default: emails in ACCESS)
 *   EMAIL_BORROWERS          'true' to also email each borrower
 */

var CELA = {
  // Item tabs, in the order the app lists them.
  SOURCES: [
    { tab: 'Inventory', kind: 'inventory', anchor: ['Item'] },
    { tab: 'Consumables', kind: 'consumable', anchor: ['Item'] },
    { tab: 'Celamerch', kind: 'merch', anchor: ['Merch Design'] }
  ],
  MEMBERS: 'MEMBERS',
  ACCESS: 'ACCESS',
  PROJECTS: 'PROJECTS',
  REQUESTS: 'REQUESTS',
  BORROWED: 'BORROWED_NOW',
  HEADERS: {
    MEMBERS: ['ID Number', 'Name', 'Department', 'Position', 'Email'],
    ACCESS: ['ID Number', 'Name', 'Level', 'Email'],
    PROJECTS: ['Project/Dept', 'Active', 'Event End Date'],
    REQUESTS: [
      'Timestamp', 'Request ID', 'Line ID', 'Client ID', 'ID Number', 'Name',
      'Case', 'Project', 'Department/Reason', 'Item', 'Item Ref', 'Qty',
      'Storage Area', 'Status', 'Due', 'Resolved At', 'Resolved By', 'Last Reminded'
    ]
  },
  DEPARTMENTS: ['OP', 'COMMPUB', 'CUL', 'EXREL', 'FIN', 'HR', 'OSR'],
  // Departments, then the Inventory tab's own Event names so they match.
  DEFAULT_PROJECTS: [
    'OP', 'COMMPUB', 'CUL', 'EXREL', 'FIN', 'HR', 'OSR', 'General',
    'Recruitment Week and Welcome Week', 'Celadon Merchandise', 'General Assembly',
    'Mid-Autumn Festival', 'Lunar Lotus Market', 'TALAB x Faculty Appreciation Week',
    'Jade Business Summit', 'Leadership Development Program', 'Celadon Rose Sale',
    'Chinese New Year', 'Spring Film Festival', 'Binondo Amazing Race',
    'Mandopop Music Festival', 'Celadon Ball'
  ],
  CASES: ['BORROWING', 'CONSUMING', 'RETURNING', 'RESTOCKING'],
  STATUS: { PENDING: 'Pending', RETURNED: 'Returned', CONSUMED: 'Consumed', RETURN: 'Return logged', ADDED: 'Added' },
  // Inventory tab Status values.
  ITEM_STATUS: { IN: 'In Storage', OUT: 'Out', USED_UP: 'Used Up' },
  HIDDEN_STATUSES: ['returnedtoowner', 'usedup']
};

// Full department names (as they may appear in the member list) → codes.
var DEPT_ALIASES = {
  officeofthepresident: 'OP', president: 'OP',
  communicationsandpublications: 'COMMPUB', communicationsandpublicationsdepartment: 'COMMPUB',
  culturalaffairs: 'CUL', culturalaffairsdepartment: 'CUL',
  externalrelations: 'EXREL', externalrelationsdepartment: 'EXREL',
  financialaffairs: 'FIN', financialaffairsdepartment: 'FIN', finance: 'FIN',
  humanresources: 'HR', humanresourcesdepartment: 'HR',
  organizationstrategiesandresearch: 'OSR', organizationstrategiesandresearchdepartment: 'OSR'
};

// Header aliases so a renamed column (or the existing members list) still works.
var COLS = {
  item: ['Item', 'Item Name', 'Title'],
  type: ['Type'],
  category: ['Category'],
  qty: ['Qty', 'Quantity', 'Count', 'Stock'],
  unit: ['Unit'],
  dept: ['Department', 'Dept'],
  status: ['Status'],
  storage: ['Storage Area', 'Location', 'Storage'],
  spot: ['Specific Spot', 'Specific Location', 'Specifc Location'],
  event: ['Event'],
  owned: ['Owned/Borrowed'],
  notes: ['Notes', 'Remarks'],
  expiry: ['Expiry Date', 'Expiry', 'Expiration Date'],
  sy: ['School Year', 'SY'],
  design: ['Merch Design', 'Design'],
  merchType: ['Merch Type'],
  size: ['Size'],
  damaged: ['Damaged Qty', 'Damaged'],
  id: ['ID Number', 'ID No', 'ID No.', 'ID #', 'ID', 'Student ID', 'Student Number', 'Student No', 'Ateneo ID'],
  name: ['Name', 'Full Name', 'Complete Name', 'Member Name'],
  first: ['First Name', 'Given Name'],
  last: ['Last Name', 'Surname', 'Family Name'],
  department: ['Department', 'Dept', 'Committee'],
  email: ['Email', 'Email Address', 'Ateneo Email', 'OBF Email', 'Ateneo Email Address'],
  level: ['Level', 'Access Level', 'Role'],
  project: ['Project/Dept', 'Project', 'Projects'],
  active: ['Active', 'Enabled'],
  endDate: ['Event End Date', 'End Date', 'Event Date']
};

// ═══════════════════════════════════════════════════════════════════════
// Entry points
// ═══════════════════════════════════════════════════════════════════════

function doGet(e) {
  return route_(e, null);
}

function doPost(e) {
  return route_(e, parseBody_(e));
}

function route_(e, body) {
  var p = mergeParams_(e, body);
  var action = String(p.action || '').trim();
  try {
    switch (action) {
      case 'login':
        requireToken_(p);
        return respond_(login_(p));
      case 'inventory':
        return respond_(inventory_());
      case 'projects':
        return respond_(projects_());
      case 'history':
        requireToken_(p);
        return respond_(history_());
      case 'submitOrder':
        requireToken_(p);
        return respond_(submitOrder_(p));
      case 'resolve':
        requireToken_(p);
        return respond_(resolve_(p));
      case 'options':
        return respond_(options_());
      case 'addItem':
        requireToken_(p);
        return respond_(addItem_(p));
      default:
        return respond_({ ok: false, error: 'Unknown action. Use login, inventory, projects, history, submitOrder, resolve, options, or addItem.' });
    }
  } catch (err) {
    return respond_({ ok: false, error: String(err && err.message || err) });
  }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Celadon Inventory')
    .addItem('Set up / repair app tabs', 'setupSheets')
    .addItem('Show pending borrows', 'showPendingBorrows')
    .addSeparator()
    .addItem('Run daily check now (overdue + expiry)', 'flagOverdue')
    .addItem('Turn on daily reminders (8 AM)', 'installDailyReminder')
    .addToUi();
}

// ═══════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════

function login_(p) {
  var id = normalize_(p.id);
  if (!/^\d{6}$/.test(id)) return { ok: true, found: false, error: 'ID must be a 6-digit number' };
  var member = findMember_(id);
  if (!member) return { ok: true, found: false, idNumber: id, name: '', level: 'NONE' };
  var level = accessLevel_(id);
  return {
    ok: true,
    found: true,
    idNumber: id,
    name: member.name,
    department: member.department,
    level: level,
    actFor: ['*'] // any member may borrow/use for any active project or department
  };
}

function inventory_() {
  var out = outByRef_();
  var items = catalogEntries_().map(function (e) {
    return {
      ref: e.ref,
      source: e.kind,
      title: e.title,
      category: e.category,
      type: e.type,
      qty: e.qty,
      unit: e.unit,
      status: e.status,
      event: e.event,
      expiry: iso_(e.expiry),
      out: out[e.ref] || 0,
      location: e.storage || e.spot,
      notes: [e.storage ? e.spot : '', e.event, e.notes].filter(String).join(' · ')
    };
  });
  return { ok: true, items: items };
}

function projects_() {
  var list = projectTable_().filter(function (pr) { return pr.active; }).map(function (pr) { return pr.name; });
  return { ok: true, projects: list.length ? list : CELA.DEFAULT_PROJECTS.slice() };
}

function history_() {
  var t = requestsTable_();
  var now = new Date();
  var records = [];
  t.rows.forEach(function (r) {
    var caseType = cell_(t, r, ['Case']).toUpperCase();
    if (!caseType || caseType === 'RETURNING') return; // returns show up as the borrow flipping to Returned
    var status = cell_(t, r, ['Status']);
    var due = r[t.index[key_('Due')]];
    var pending = status === CELA.STATUS.PENDING;
    records.push({
      lineId: cell_(t, r, ['Line ID']),
      time: iso_(r[t.index[key_('Timestamp')]]),
      idNum: cell_(t, r, COLS.id),
      name: cell_(t, r, ['Name']),
      item: cell_(t, r, ['Item']),
      qty: cell_(t, r, ['Qty']),
      location: cell_(t, r, ['Storage Area']),
      project: cell_(t, r, ['Project']),
      committee: cell_(t, r, ['Department/Reason']),
      caseType: caseType,
      status: status,
      due: iso_(due),
      overdue: pending && due instanceof Date && due < now,
      resolvedBy: cell_(t, r, ['Resolved By']),
      resolved: !pending
    });
  });
  records.reverse(); // newest first
  return { ok: true, records: records };
}

function submitOrder_(p) {
  var id = normalize_(p.idNumber);
  var member = findMember_(id);
  if (!member) throw new Error('ID ' + id + ' is not in the member list');

  var caseType = String(p.caseType || '').toUpperCase();
  if (CELA.CASES.indexOf(caseType) === -1) throw new Error('Unknown case: ' + caseType);
  var items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) throw new Error('No items in request');

  // Every request is made for a project or department from the PROJECTS list.
  var project = String(p.actingAs || p.project || '').trim();
  if (!project || /^personal$/i.test(project)) throw new Error('Choose the project or department this is for');
  if (!isKnownProject_(project)) throw new Error('"' + project + '" is not in the PROJECTS list');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var requests = ensureSheet_(CELA.REQUESTS);
    var clientId = String(p.clientId || '').trim();
    if (clientId && clientIdSeen_(clientId)) return { ok: true, logged: 0, duplicate: true };

    var now = new Date();
    var tz = Session.getScriptTimeZone();
    var requestId = 'REQ-' + Utilities.formatDate(now, tz, 'yyMMdd-HHmmss') + '-' + Math.floor(Math.random() * 1000);
    var due = caseType === 'BORROWING' ? dueDate_(project, now) : '';
    var entries = catalogEntries_();
    var out = outByRef_();
    var deduct = prop_('DEDUCT_ON_CONSUME') !== 'false';
    var rows = [];
    var warnings = [];

    items.forEach(function (it) {
      var title = String(it.title || '').trim();
      var qty = Math.max(0, parseInt(it.qty, 10) || 0);
      if (!title || !qty) return;
      var status = caseType === 'BORROWING' ? CELA.STATUS.PENDING
        : caseType === 'CONSUMING' ? CELA.STATUS.CONSUMED
        : caseType === 'RESTOCKING' ? CELA.STATUS.ADDED : CELA.STATUS.RETURN;

      var entry = findEntry_(entries, it.ref, title, it.location);
      if (!entry) warnings.push('Not found in the inventory tabs: ' + title);
      var ref = entry ? entry.ref : String(it.ref || '');

      if (caseType === 'RETURNING') {
        var cleared = resolveBorrows_(requests, project, ref, title, qty, member.name, now);
        if (cleared < qty) warnings.push(title + ': only ' + cleared + ' of ' + qty + ' matched a pending ' + project + ' borrow');
        out[ref] = Math.max(0, (out[ref] || 0) - cleared);
      }
      if (entry) {
        annotateQty_(entry, '[' + caseType + '] - ' + qty + ' ' + project + ', ' + member.name + ' (' + Utilities.formatDate(now, tz, 'MMM d') + ')');
        if (caseType === 'BORROWING') {
          out[ref] = (out[ref] || 0) + qty;
          syncOutStatus_(entry, out[ref]);
        } else if (caseType === 'CONSUMING' && deduct) {
          deductQty_(entry, qty, warnings);
        } else if (caseType === 'RETURNING') {
          syncOutStatus_(entry, out[ref] || 0);
        } else if (caseType === 'RESTOCKING') {
          addQty_(entry, qty);
        }
      }

      rows.push([
        now, requestId, requestId + '-' + (rows.length + 1), clientId, "'" + id, member.name,
        caseType, project, String(p.committee || ''), title, ref, qty,
        entry ? (entry.storage || entry.spot) : String(it.location || ''), status, due, '', '', ''
      ]);
    });

    if (rows.length) {
      requests.getRange(requests.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    }
    return { ok: true, logged: rows.length, requestId: requestId, due: iso_(due), warnings: warnings };
  } finally {
    lock.releaseLock();
  }
}

// Marks one pending borrow line as returned. Any member may do this (whoever
// brings the item back); REQUESTS keeps who resolved it.
function resolve_(p) {
  var id = normalize_(p.idNumber);
  var member = findMember_(id);
  if (!member) throw new Error('ID ' + id + ' is not in the member list');
  // One line (lineId) or many at once (lineIds) — the app's "Confirm return"
  // sends every ticked line in a single call.
  var wanted = (Array.isArray(p.lineIds) ? p.lineIds : [p.lineId])
    .map(function (x) { return String(x || '').trim(); }).filter(String);
  if (!wanted.length) throw new Error('Missing line ID');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var t = requestsTable_();
    var c = function (h) { return t.index[key_(h)]; };
    var now = new Date();
    var resolved = [], already = [], touched = [];
    t.rows.forEach(function (r, i) {
      var lineId = String(r[c('Line ID')]);
      if (wanted.indexOf(lineId) === -1) return;
      if (String(r[c('Status')]) !== CELA.STATUS.PENDING) { already.push(lineId); return; }
      markReturned_(t.sheet, t.headerRow + 2 + i, c, member.name, now);
      resolved.push(lineId);
      touched.push({ ref: String(r[c('Item Ref')] || ''), title: String(r[c('Item')]), where: String(r[c('Storage Area')]) });
    });
    var missing = wanted.filter(function (x) { return resolved.indexOf(x) === -1 && already.indexOf(x) === -1; });
    if (wanted.length === 1 && missing.length) throw new Error('Request line not found: ' + wanted[0]);

    // Put each affected item's Status back once everything is recorded.
    if (touched.length) {
      var entries = catalogEntries_();
      var out = outByRef_();
      var done = {};
      touched.forEach(function (x) {
        var entry = findEntry_(entries, x.ref, x.title, x.where);
        if (!entry || done[entry.ref]) return;
        done[entry.ref] = true;
        syncOutStatus_(entry, out[entry.ref] || 0);
      });
    }
    return { ok: true, lineId: wanted[0], resolved: resolved, alreadyResolved: already, missing: missing };
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Catalog (Inventory, Consumables, Celamerch)
// ═══════════════════════════════════════════════════════════════════════

// Every listable item row across the item tabs. `ref` identifies a row by
// its content (not its row number) so sorting/filtering the sheet is safe.
function catalogEntries_(includeHidden) {
  var entries = [];
  var seen = {};
  CELA.SOURCES.forEach(function (src) {
    var sheet = sheet_(src.tab, false);
    if (!sheet) return;
    var t = tableFromSheet_(sheet, src.anchor);
    var expiryCol = colFor_(t, COLS.expiry);
    t.rows.forEach(function (r, i) {
      var e = src.kind === 'merch' ? merchEntry_(t, r) : itemEntry_(t, r);
      if (!e) return;
      if (!includeHidden && CELA.HIDDEN_STATUSES.indexOf(key_(e.status)) !== -1) return;
      e.kind = src.kind;
      e.t = t;
      e.i = i;
      e.expiry = expiryCol != null && r[expiryCol] instanceof Date ? r[expiryCol] : null;
      var base = src.kind + ':' + [e.title, e.category, e.storage, e.spot].map(key_).join('|');
      seen[base] = (seen[base] || 0) + 1;
      e.ref = seen[base] > 1 ? base + '#' + seen[base] : base;
      entries.push(e);
    });
  });
  return entries;
}

function itemEntry_(t, r) {
  var title = cell_(t, r, COLS.item);
  if (!title) return null;
  return {
    title: title,
    category: cell_(t, r, COLS.dept) || 'General',
    type: cell_(t, r, COLS.type),
    qty: cell_(t, r, COLS.qty),
    unit: cell_(t, r, COLS.unit),
    status: cell_(t, r, COLS.status),
    storage: cell_(t, r, COLS.storage),
    spot: cell_(t, r, COLS.spot),
    event: cell_(t, r, COLS.event),
    notes: cell_(t, r, COLS.notes)
  };
}

function merchEntry_(t, r) {
  var design = cell_(t, r, COLS.design);
  var count = cell_(t, r, COLS.qty);
  if (!design || count === '') return null;
  var type = cell_(t, r, COLS.merchType);
  var size = cell_(t, r, COLS.size);
  var title = design + (type && design.toLowerCase().indexOf(type.toLowerCase()) === -1 ? ' ' + type : '') +
    (size && !/^n\/?a$/i.test(size) ? ' (' + size + ')' : '');
  var sy = cell_(t, r, COLS.sy);
  var damaged = cell_(t, r, COLS.damaged);
  return {
    title: title,
    category: 'Merch',
    type: type,
    qty: count,
    unit: 'pcs',
    status: '',
    storage: '',
    spot: sy ? 'SY ' + sy : '',
    event: '',
    notes: [damaged ? damaged + ' damaged' : '', cell_(t, r, COLS.notes)].filter(String).join(' · ')
  };
}

function findEntry_(entries, ref, title, location) {
  if (ref) {
    var byRef = entries.filter(function (e) { return e.ref === ref; })[0];
    if (byRef) return byRef;
  }
  var want = key_(title);
  var loc = key_(location);
  var matches = entries.filter(function (e) { return key_(e.title) === want; });
  return matches.filter(function (e) { return loc && (key_(e.storage) === loc || key_(e.spot) === loc); })[0] ||
    matches[0] || null;
}

function entryRange_(e, candidates) {
  var col = colFor_(e.t, candidates);
  return col == null ? null : e.t.sheet.getRange(e.t.headerRow + 2 + e.i, col + 1);
}

function annotateQty_(e, line) {
  var range = entryRange_(e, COLS.qty);
  if (!range) return;
  var existing = range.getNote();
  range.setNote(existing ? existing + '\n' + line : line);
}

function deductQty_(e, qty, warnings) {
  var range = entryRange_(e, COLS.qty);
  if (!range) return;
  var current = range.getValue();
  if (typeof current !== 'number' && !/^\d+$/.test(String(current).trim())) return; // "*", "many" etc.
  var next = Number(current) - qty;
  if (next < 0) {
    warnings.push(e.title + ': requested ' + qty + ' but sheet had ' + current);
    next = 0;
  }
  range.setValue(next);
  if (next === 0) setStatus_(e, CELA.ITEM_STATUS.USED_UP);
}

// Restock: raise a numeric (or blank) Qty; "*"/"many" stay as they are.
// A Used Up row comes back into storage.
function addQty_(e, qty) {
  var range = entryRange_(e, COLS.qty);
  if (!range) return;
  var current = range.getValue();
  var text = String(current).trim();
  if (text === '' || typeof current === 'number' || /^\d+$/.test(text)) {
    range.setValue((Number(current) || 0) + qty);
  }
  if (key_(e.status) === key_(CELA.ITEM_STATUS.USED_UP)) setStatus_(e, CELA.ITEM_STATUS.IN);
}

function setStatus_(e, value) {
  var range = entryRange_(e, COLS.status);
  if (range) range.setValue(value);
}

// Status follows the app's borrows: "Out" once every unit is out (or the
// count isn't a number), back to "In Storage" when nothing is out. Statuses
// set by hand (Missing, Returned to Owner…) are left alone.
function syncOutStatus_(e, outQty) {
  var status = key_(e.status);
  var total = parseInt(e.qty, 10);
  if (outQty > 0) {
    var allOut = isNaN(total) || outQty >= total;
    if (allOut && (status === '' || status === key_(CELA.ITEM_STATUS.IN))) setStatus_(e, CELA.ITEM_STATUS.OUT);
  } else if (status === key_(CELA.ITEM_STATUS.OUT)) {
    setStatus_(e, CELA.ITEM_STATUS.IN);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Adding items
// ═══════════════════════════════════════════════════════════════════════

// The Add form's dropdowns, read from the Inventory tab's own data
// validation so they always match the sheet.
function options_() {
  var sheet = sheet_('Inventory');
  var t = tableFromSheet_(sheet, ['Item']);
  var row = t.headerRow + 2;
  var lists = { types: COLS.type, departments: COLS.dept, categories: COLS.category, storageAreas: COLS.storage, events: COLS.event };
  var out = {};
  Object.keys(lists).forEach(function (name) {
    var col = colFor_(t, lists[name]);
    out[name] = [];
    if (col == null) return;
    try {
      var dv = sheet.getRange(row, col + 1).getDataValidation();
      var values = dv ? dv.getCriteriaValues() : null;
      if (values && Array.isArray(values[0])) out[name] = values[0].map(String).filter(String);
    } catch (err) { /* no dropdown on that column */ }
  });
  return { ok: true, options: out };
}

// Adds one new item row. Items with an expiry date go to Consumables.
// An exact match (same name, department, storage area and spot) is refused
// unless it was Used Up / Returned to Owner, in which case it's brought back.
function addItem_(p) {
  var id = normalize_(p.idNumber);
  var member = findMember_(id);
  if (!member) throw new Error('ID ' + id + ' is not in the member list');

  var title = String(p.title || '').trim();
  var dept = String(p.department || '').trim();
  if (!title) throw new Error('Enter the item name');
  if (!dept) throw new Error('Choose the department that owns it');
  var qtyText = String(p.qty == null ? '' : p.qty).trim();
  if (qtyText && qtyText !== '*' && !/^\d+$/.test(qtyText)) throw new Error('Quantity must be a whole number, or * for "a lot"');
  var qty = /^\d+$/.test(qtyText) ? Number(qtyText) : qtyText;
  var expiry = p.expiry ? new Date(p.expiry) : null;
  if (expiry && isNaN(expiry.getTime())) throw new Error('Expiry date is not a valid date');
  var storage = String(p.storage || '').trim();
  var spot = String(p.spot || '').trim();

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var tabName = expiry && sheet_('Consumables', false) ? 'Consumables' : 'Inventory';
    var kind = tabName === 'Consumables' ? 'consumable' : 'inventory';
    var base = kind + ':' + [title, dept, storage, spot].map(key_).join('|');
    var now = new Date();
    var stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'MMM d, yyyy');

    var existing = catalogEntries_(true).filter(function (e) { return e.ref === base; })[0];
    if (existing) {
      if (CELA.HIDDEN_STATUSES.indexOf(key_(existing.status)) === -1) {
        throw new Error(title + ' (' + dept + (storage || spot ? ', ' + (storage || spot) : '') + ') is already in the inventory. Use "Add stock" at checkout to add more.');
      }
      // Bring a used-up / returned row back instead of duplicating it.
      var qtyRange = entryRange_(existing, COLS.qty);
      if (qtyRange) qtyRange.setValue(qty);
      setStatus_(existing, CELA.ITEM_STATUS.IN);
      annotateQty_(existing, '[ADDED] ' + (qtyText || '') + ' by ' + member.name + ' (' + stamp + ')');
      logAdd_(member, id, p, title, base, qty, storage || spot, now);
      return { ok: true, ref: base, tab: tabName, revived: true };
    }

    var sheet = sheet_(tabName);
    var t = tableFromSheet_(sheet, ['Item']);
    var itemCol = colFor_(t, COLS.item);
    var last = -1;
    t.rows.forEach(function (r, i) { if (normalize_(r[itemCol]) !== '') last = i; });
    var rowNum = t.headerRow + 2 + last + 1;
    if (rowNum > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);

    var values = [
      [COLS.item, title], [COLS.type, p.type], [COLS.qty, qty], [COLS.unit, p.unit],
      [COLS.dept, dept], [COLS.category, p.category], [COLS.status, CELA.ITEM_STATUS.IN],
      [COLS.storage, storage], [COLS.spot, spot], [COLS.event, p.event], [COLS.notes, p.notes],
      [COLS.expiry, expiry]
    ];
    values.forEach(function (pair) {
      var col = colFor_(t, pair[0]);
      var v = pair[1];
      if (col == null || v == null || v === '') return;
      sheet.getRange(rowNum, col + 1).setValue(typeof v === 'string' ? v.trim() : v);
    });
    var qtyCol = colFor_(t, COLS.qty);
    if (qtyCol != null) sheet.getRange(rowNum, qtyCol + 1).setNote('[ADDED] by ' + member.name + ' (' + stamp + ')');

    logAdd_(member, id, p, title, base, qty, storage || spot, now);
    return { ok: true, ref: base, tab: tabName, row: rowNum };
  } finally {
    lock.releaseLock();
  }
}

function logAdd_(member, id, p, title, ref, qty, where, now) {
  var requests = ensureSheet_(CELA.REQUESTS);
  var requestId = 'ADD-' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyMMdd-HHmmss') + '-' + Math.floor(Math.random() * 1000);
  requests.getRange(requests.getLastRow() + 1, 1, 1, CELA.HEADERS.REQUESTS.length).setValues([[
    now, requestId, requestId + '-1', String(p.clientId || ''), "'" + id, member.name,
    'ADDING', String(p.department || ''), String(p.notes || ''), title, ref, qty === '' ? '' : qty,
    where, CELA.STATUS.ADDED, '', '', '', ''
  ]]);
}

// ═══════════════════════════════════════════════════════════════════════
// Request helpers
// ═══════════════════════════════════════════════════════════════════════

function requestsTable_() {
  ensureSheet_(CELA.REQUESTS);
  return table_(CELA.REQUESTS, ['Request ID', 'Timestamp']);
}

function clientIdSeen_(clientId) {
  var t = requestsTable_();
  var col = t.index[key_('Client ID')];
  if (col == null) return false;
  for (var i = t.rows.length - 1; i >= 0; i--) {
    if (String(t.rows[i][col]) === clientId) return true;
  }
  return false;
}

// Pending borrowed qty per catalog ref.
function outByRef_() {
  var out = {};
  if (!sheet_(CELA.REQUESTS, false)) return out;
  var t = requestsTable_();
  t.rows.forEach(function (r) {
    if (cell_(t, r, ['Case']).toUpperCase() !== 'BORROWING') return;
    if (cell_(t, r, ['Status']) !== CELA.STATUS.PENDING) return;
    var ref = cell_(t, r, ['Item Ref']);
    out[ref] = (out[ref] || 0) + (parseInt(cell_(t, r, ['Qty']), 10) || 0);
  });
  return out;
}

// Due the day after the project's Event End Date when one is set and still
// ahead; otherwise BORROW_DAYS (default 7) after borrowing.
function dueDate_(project, now) {
  var days = parseInt(prop_('BORROW_DAYS'), 10) || 7;
  var match = projectTable_().filter(function (pr) { return key_(pr.name) === key_(project); })[0];
  if (match && match.endDate instanceof Date && match.endDate >= startOfDay_(now)) {
    var due = startOfDay_(match.endDate);
    due.setDate(due.getDate() + 1);
    return due;
  }
  return new Date(now.getTime() + days * 86400000);
}

// Marks the oldest pending borrows of `project` + item as Returned.
// A row is cleared only when the returned qty covers it.
function resolveBorrows_(sheet, project, ref, title, qty, byName, now) {
  var t = requestsTable_();
  var c = function (h) { return t.index[key_(h)]; };
  var remaining = qty;
  var cleared = 0;
  for (var i = 0; i < t.rows.length && remaining > 0; i++) {
    var r = t.rows[i];
    if (String(r[c('Case')]).toUpperCase() !== 'BORROWING') continue;
    if (String(r[c('Status')]) !== CELA.STATUS.PENDING) continue;
    var sameItem = ref ? String(r[c('Item Ref')]) === ref : key_(r[c('Item')]) === key_(title);
    if (!sameItem) continue;
    if (key_(r[c('Project')]) !== key_(project)) continue;
    var borrowed = parseInt(r[c('Qty')], 10) || 0;
    if (borrowed > remaining) continue;
    markReturned_(sheet, t.headerRow + 2 + i, c, byName, now);
    remaining -= borrowed;
    cleared += borrowed;
  }
  return cleared;
}

function markReturned_(sheet, rowNum, c, byName, now) {
  sheet.getRange(rowNum, c('Status') + 1).setValue(CELA.STATUS.RETURNED);
  sheet.getRange(rowNum, c('Resolved At') + 1).setValue(now);
  sheet.getRange(rowNum, c('Resolved By') + 1).setValue(byName);
  sheet.getRange(rowNum, 1, 1, sheet.getLastColumn()).setBackground(null);
}

// ═══════════════════════════════════════════════════════════════════════
// Members, access, projects
// ═══════════════════════════════════════════════════════════════════════

// MEMBERS can live in this spreadsheet or in the org's existing member list
// (Script Properties MEMBERS_SPREADSHEET_ID + optional MEMBERS_SHEET_NAME).
function membersTable_() {
  var externalId = prop_('MEMBERS_SPREADSHEET_ID');
  if (!externalId) return table_(CELA.MEMBERS, COLS.id);
  var ss = SpreadsheetApp.openById(externalId);
  var name = prop_('MEMBERS_SHEET_NAME');
  var sheet = name ? ss.getSheetByName(name) : ss.getSheets()[0];
  if (!sheet) throw new Error('Members tab not found: ' + name);
  return tableFromSheet_(sheet, COLS.id);
}

function findMember_(id) {
  if (!id) return null;
  var t = membersTable_();
  for (var i = 0; i < t.rows.length; i++) {
    var r = t.rows[i];
    if (normalize_(cell_(t, r, COLS.id)).replace(/\s/g, '') !== id) continue;
    var name = cell_(t, r, COLS.name) ||
      [cell_(t, r, COLS.first), cell_(t, r, COLS.last)].filter(String).join(' ');
    return { id: id, name: name, department: deptCode_(cell_(t, r, COLS.department)), email: cell_(t, r, COLS.email) };
  }
  return null;
}

function deptCode_(value) {
  var k = key_(value);
  if (!k) return '';
  if (DEPT_ALIASES[k]) return DEPT_ALIASES[k];
  var code = CELA.DEPARTMENTS.filter(function (d) { return key_(d) === k; })[0];
  return code || String(value).trim();
}

function accessLevel_(id) {
  if (!sheet_(CELA.ACCESS, false)) return 'NONE';
  var t = table_(CELA.ACCESS, COLS.id);
  for (var i = 0; i < t.rows.length; i++) {
    if (normalize_(cell_(t, t.rows[i], COLS.id)) === id) {
      return (cell_(t, t.rows[i], COLS.level) || 'NONE').toUpperCase();
    }
  }
  return 'NONE';
}

function isKnownProject_(project) {
  var want = key_(project);
  return projectTable_().some(function (pr) { return pr.active && key_(pr.name) === want; });
}

function projectTable_() {
  if (!sheet_(CELA.PROJECTS, false)) {
    return CELA.DEFAULT_PROJECTS.map(function (name) { return { name: name, active: true, endDate: null }; });
  }
  var t = table_(CELA.PROJECTS, COLS.project);
  var endCol = colFor_(t, COLS.endDate);
  var list = [];
  t.rows.forEach(function (r) {
    var name = cell_(t, r, COLS.project);
    if (!name) return;
    list.push({
      name: name,
      active: !/^(false|no|0)$/i.test(cell_(t, r, COLS.active)),
      endDate: endCol != null && r[endCol] instanceof Date ? r[endCol] : null
    });
  });
  return list;
}

// ═══════════════════════════════════════════════════════════════════════
// Daily check: overdue borrows + expiring consumables
// ═══════════════════════════════════════════════════════════════════════

function installDailyReminder() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'flagOverdue') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('flagOverdue').timeBased().everyDays(1).atHour(8).create();
  notify_('Daily check is on (around 8 AM). Set NOTIFY_EMAILS in Script Properties to choose who gets the digest.');
}

// Highlights overdue borrows in REQUESTS and emails a digest that also lists
// expired/expiring Consumables. Each overdue line is re-reminded at most
// every REMIND_EVERY_DAYS days; expiring items are listed every day.
function flagOverdue() {
  var t = requestsTable_();
  var c = function (h) { return t.index[key_(h)]; };
  var now = new Date();
  var every = parseInt(prop_('REMIND_EVERY_DAYS'), 10) || 3;
  var overdue = [];
  var toRemind = [];
  t.rows.forEach(function (r, i) {
    if (String(r[c('Case')]).toUpperCase() !== 'BORROWING' || String(r[c('Status')]) !== CELA.STATUS.PENDING) return;
    var due = r[c('Due')];
    if (!(due instanceof Date) || due >= now) return;
    var rowNum = t.headerRow + 2 + i;
    var line = {
      rowNum: rowNum,
      id: normalize_(r[c('ID Number')]),
      name: String(r[c('Name')]),
      item: String(r[c('Item')]),
      qty: r[c('Qty')],
      project: String(r[c('Project')]),
      days: Math.floor((now - due) / 86400000) + 1
    };
    overdue.push(line);
    t.sheet.getRange(rowNum, 1, 1, t.sheet.getLastColumn()).setBackground('#fde2e1');
    var last = r[c('Last Reminded')];
    if (!(last instanceof Date) || (now - last) >= every * 86400000 - 3600000) toRemind.push(line);
  });

  var expiring = expiringItems_(now);
  if (toRemind.length || expiring.length) sendDigest_(toRemind, expiring);
  if (toRemind.length) {
    if (prop_('EMAIL_BORROWERS') === 'true') emailBorrowers_(toRemind);
    toRemind.forEach(function (l) { t.sheet.getRange(l.rowNum, c('Last Reminded') + 1).setValue(now); });
  }
  return { overdue: overdue.length, reminded: toRemind.length, expiring: expiring.length };
}

function expiringItems_(now) {
  var warnDays = parseInt(prop_('EXPIRY_WARN_DAYS'), 10) || 14;
  var limit = new Date(startOfDay_(now).getTime() + (warnDays + 1) * 86400000);
  return catalogEntries_().filter(function (e) { return e.expiry && e.expiry < limit; })
    .sort(function (a, b) { return a.expiry - b.expiry; })
    .map(function (e) {
      var days = Math.round((startOfDay_(e.expiry) - startOfDay_(now)) / 86400000);
      return '• ' + e.title + (e.qty ? ' (' + e.qty + (e.unit ? ' ' + e.unit : '') + ')' : '') + ' — ' + e.category + ' — ' +
        (days < 0 ? 'expired ' + (-days) + ' day' + (days === -1 ? '' : 's') + ' ago'
          : days === 0 ? 'expires today' : 'expires in ' + days + ' day' + (days === 1 ? '' : 's'));
    });
}

function overdueLine_(l) {
  return '• ' + l.qty + '× ' + l.item + ' — ' + l.project + ' (borrowed by ' + l.name + ') — ' +
    l.days + ' day' + (l.days === 1 ? '' : 's') + ' overdue';
}

function sendDigest_(overdueLines, expiringLines) {
  var to = prop_('NOTIFY_EMAILS') || accessEmails_().join(',');
  if (!to) return;
  var parts = [];
  if (overdueLines.length) {
    parts.push('Still out of the org room past their return date:\n\n' + overdueLines.map(overdueLine_).join('\n') +
      '\n\nOpen the BORROWED_NOW tab for the full list. Mark items returned in the app once they are back.');
  }
  if (expiringLines.length) {
    parts.push('Consumables expired or expiring soon:\n\n' + expiringLines.join('\n'));
  }
  var subject = [
    overdueLines.length ? overdueLines.length + ' overdue borrow' + (overdueLines.length === 1 ? '' : 's') : '',
    expiringLines.length ? expiringLines.length + ' expiring item' + (expiringLines.length === 1 ? '' : 's') : ''
  ].filter(String).join(', ');
  MailApp.sendEmail({ to: to, subject: '[Celadon Inventory] ' + subject, body: parts.join('\n\n———\n\n') });
}

// One email per borrower.
function emailBorrowers_(lines) {
  var byEmail = {};
  var add = function (id, line) {
    var m = findMember_(id);
    if (!m || !m.email) return;
    var entry = byEmail[m.email] = byEmail[m.email] || { name: m.name, lines: [] };
    if (entry.lines.indexOf(line) === -1) entry.lines.push(line);
  };
  lines.forEach(function (l) { add(l.id, l); });
  Object.keys(byEmail).forEach(function (email) {
    var entry = byEmail[email];
    MailApp.sendEmail({
      to: email,
      subject: '[Celadon Inventory] Please return borrowed items',
      body: 'Hi ' + (entry.name || '') + ',\n\nThese org room items are past their return date:\n\n' +
        entry.lines.map(overdueLine_).join('\n') +
        '\n\nPlease bring them back and tap "Mark returned" in the Celadon Inventory app. Thank you!'
    });
  });
}

function accessEmails_() {
  if (!sheet_(CELA.ACCESS, false)) return [];
  var t = table_(CELA.ACCESS, COLS.id);
  return t.rows.map(function (r) { return cell_(t, r, COLS.email); }).filter(String);
}

// ═══════════════════════════════════════════════════════════════════════
// Sheet setup (run once from the editor or the Celadon Inventory menu)
// ═══════════════════════════════════════════════════════════════════════

function setupSheets() {
  var missing = CELA.SOURCES.filter(function (src) { return !sheet_(src.tab, false); })
    .map(function (src) { return src.tab; });
  if (missing.indexOf('Inventory') !== -1) throw new Error('This spreadsheet has no Inventory tab. Open the script from the Celadon Inventory Tracker sheet.');

  var tabs = [CELA.ACCESS, CELA.PROJECTS, CELA.REQUESTS];
  if (!prop_('MEMBERS_SPREADSHEET_ID')) tabs.unshift(CELA.MEMBERS);
  tabs.forEach(ensureSheet_);

  var projects = sheet_(CELA.PROJECTS);
  if (projects.getLastRow() < 2) {
    var rows = CELA.DEFAULT_PROJECTS.map(function (name) { return [name, true, '']; });
    projects.getRange(2, 1, rows.length, 3).setValues(rows);
    projects.getRange(2, 2, rows.length, 1).insertCheckboxes();
  }
  projects.getRange('C2:C').setNumberFormat('mmm d, yyyy');

  validateColumn_(CELA.ACCESS, COLS.level, SpreadsheetApp.newDataValidation()
    .requireValueInList(['ADMIN', 'OFFICER'], true).build());

  var requests = sheet_(CELA.REQUESTS);
  var rt = requestsTable_();
  [['Timestamp', 'mmm d, yyyy h:mm am/pm'], ['Due', 'mmm d, yyyy'], ['Resolved At', 'mmm d, yyyy h:mm am/pm'], ['Last Reminded', 'mmm d, yyyy']]
    .forEach(function (pair) {
      var col = rt.index[key_(pair[0])];
      if (col != null) requests.getRange(2, col + 1, Math.max(requests.getMaxRows() - 1, 1), 1).setNumberFormat(pair[1]);
    });

  setupBorrowedNow_();
  notify_('App tabs are ready (' + tabs.concat(CELA.BORROWED).join(', ') + '). ' +
    'Inventory, Celamerch and Consumables were not changed. Next: add members and officers (ACCESS).');
}

function ensureSheet_(name) {
  var ss = spreadsheet_();
  var sheet = sheet_(name, false);
  if (!sheet) sheet = ss.insertSheet(name);
  var headers = CELA.HEADERS[name];
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeader_(sheet, headers.length);
    return sheet;
  }
  // Existing tab: append any missing columns.
  var current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(key_);
  var missing = headers.filter(function (h) { return current.indexOf(key_(h)) === -1; });
  if (missing.length && current.some(String)) {
    var start = sheet.getLastColumn() + 1;
    sheet.getRange(1, start, 1, missing.length).setValues([missing]);
    styleHeader_(sheet, start + missing.length - 1);
  }
  return sheet;
}

function styleHeader_(sheet, width) {
  sheet.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#003078').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
}

function validateColumn_(tab, candidates, rule) {
  var t = table_(tab, candidates);
  var col = colFor_(t, candidates);
  if (col == null) return;
  t.sheet.getRange(t.headerRow + 2, col + 1, Math.max(t.sheet.getMaxRows() - t.headerRow - 1, 1), 1).setDataValidation(rule);
}

// BORROWED_NOW: a read-only QUERY over REQUESTS, overdue rows in red.
function setupBorrowedNow_() {
  var ss = spreadsheet_();
  var sheet = sheet_(CELA.BORROWED, false) || ss.insertSheet(CELA.BORROWED);
  var t = requestsTable_();
  var L = function (h) { return columnLetter_(t.index[key_(h)] + 1); };
  var cols = ['Due', 'Item', 'Qty', 'Project', 'Name', 'Storage Area', 'Timestamp'].map(L);
  var query = 'select ' + cols.join(', ') +
    " where " + L('Case') + " = 'BORROWING' and " + L('Status') + " = 'Pending' order by " + L('Due');
  sheet.clear();
  sheet.getRange('A1').setFormula('=QUERY(' + CELA.REQUESTS + '!A:' + columnLetter_(t.sheet.getLastColumn()) + ', "' + query + '", 1)');
  styleHeader_(sheet, cols.length);
  sheet.getRange('A2:A').setNumberFormat('mmm d, yyyy');
  sheet.getRange('G2:G').setNumberFormat('mmm d, yyyy');
  var rule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND($A2<>"", $A2<TODAY())')
    .setBackground('#fde2e1').setFontColor('#970708')
    .setRanges([sheet.getRange('A2:G')]).build();
  sheet.setConditionalFormatRules([rule]);
}

function showPendingBorrows() {
  var lines = history_().records.filter(function (r) { return r.caseType === 'BORROWING' && !r.resolved; })
    .map(function (r) { return (r.overdue ? '⚠ ' : '') + r.qty + '× ' + r.item + ' — ' + r.project + ' (' + r.name + ')'; });
  SpreadsheetApp.getUi().alert('Pending borrows (' + lines.length + ')', lines.join('\n') || 'Nothing is out right now.', SpreadsheetApp.getUi().ButtonSet.OK);
}

// ═══════════════════════════════════════════════════════════════════════
// Generic helpers
// ═══════════════════════════════════════════════════════════════════════

function spreadsheet_() {
  var id = prop_('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function prop_(name) {
  return PropertiesService.getScriptProperties().getProperty(name);
}

function sheet_(name, required) {
  var ss = spreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    var want = key_(name);
    sheet = ss.getSheets().filter(function (s) { return key_(s.getName()) === want; })[0] || null;
  }
  if (!sheet && required !== false) throw new Error('Missing tab: ' + name + ' (run setupSheets)');
  return sheet;
}

function table_(name, anchor) {
  return tableFromSheet_(sheet_(name), anchor);
}

// Reads a tab into { sheet, headerRow (0-based), index: {normalizedHeader: col}, rows }.
// The header row is the first of the top 10 rows containing one of `anchor`.
function tableFromSheet_(sheet, anchor) {
  var values = sheet.getDataRange().getValues();
  var anchors = anchor.map(key_);
  var headerRow = 0;
  for (var r = 0; r < Math.min(values.length, 10); r++) {
    if (values[r].some(function (v) { return anchors.indexOf(key_(v)) !== -1; })) { headerRow = r; break; }
  }
  var index = {};
  (values[headerRow] || []).forEach(function (h, c) {
    var k = key_(h);
    if (k && index[k] == null) index[k] = c;
  });
  return { sheet: sheet, headerRow: headerRow, index: index, rows: values.slice(headerRow + 1) };
}

function colFor_(t, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var c = t.index[key_(candidates[i])];
    if (c != null) return c;
  }
  return null;
}

function cell_(t, row, candidates) {
  var c = colFor_(t, candidates);
  return c == null ? '' : normalize_(row[c]);
}

function key_(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalize_(v) {
  return String(v == null ? '' : v).replace(/^'/, '').trim();
}

function iso_(v) {
  return v instanceof Date ? v.toISOString() : String(v || '');
}

function startOfDay_(d) {
  var x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

function columnLetter_(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function requireToken_(p) {
  var configured = prop_('ACCESS_TOKEN');
  if (configured && String(p.token || '') !== String(configured)) throw new Error('Unauthorized');
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  try {
    var parsed = JSON.parse(e.postData.contents);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function mergeParams_(e, body) {
  var params = {};
  var query = e && e.parameter ? e.parameter : {};
  Object.keys(query).forEach(function (k) { params[k] = query[k]; });
  Object.keys(body || {}).forEach(function (k) { if (body[k] != null) params[k] = body[k]; });
  return params;
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function notify_(message) {
  try { SpreadsheetApp.getUi().alert(message); } catch (e) { Logger.log(message); }
}
