/*
 * Ateneo Celadon — Inventory (CelaCart) Apps Script backend
 *
 * One script for the whole app: login, catalog, projects, requests, history,
 * project/department accountability and overdue reminders. Adapted from MEA's
 * app (github.com/David-GY/mea-id), minus the ID Tracker and SUS Dashboard,
 * which are MEA-specific.
 *
 * Every borrow or use-up is made *for* a project or department ("acting
 * for"), never personally. A member can act for:
 *   - their own department (Department column of the member list),
 *   - any project/department they're listed under in CORES,
 *   - anything, if they're ADMIN or OFFICER in ACCESS.
 * Anyone who can act for that project/department can mark its borrows returned.
 *
 * Bind this script to the Celadon inventory spreadsheet (Extensions > Apps
 * Script), run `setupSheets` once, then Deploy > New deployment > Web app,
 * execute as Me, access: Anyone. See SETUP.md.
 *
 * Tabs (created/repaired by setupSheets; headers are matched by name, so
 * columns can be reordered and extra columns are ignored):
 *   CATALOG        Item | Category | Quantity | Storage Area | Specific Location | Notes | Last Updated
 *   STORAGE_AREAS  Storage Area | Description       (drives the CATALOG dropdown)
 *   MEMBERS        ID Number | Name | Department | Position | Email
 *                  (or point MEMBERS_SPREADSHEET_ID at the existing members sheet)
 *   ACCESS         ID Number | Name | Level | Email   (ADMIN or OFFICER)
 *   PROJECTS       Project/Dept | Active | Event End Date
 *   CORES          ID Number | Name | Project | Role  (who can act for a project)
 *   REQUESTS       written by the app — one row per item per request
 *   BORROWED_NOW   live view of everything still out (formula, read-only)
 *
 * Routes:
 *   GET  ?action=login&id=123456   member lookup (+ projects/depts they can act for)
 *   GET  ?action=inventory         catalog rows with how many are out
 *   GET  ?action=projects          active project/department list
 *   GET  ?action=history           borrow/consume records
 *   POST ?action=submitOrder       borrow / use up / return request
 *   POST ?action=resolve           mark one borrowed line as returned
 *
 * Optional Script Properties (Project Settings > Script properties):
 *   ACCESS_TOKEN             shared token; when set, the app must send it
 *   SPREADSHEET_ID           only if the script is standalone instead of bound
 *   MEMBERS_SPREADSHEET_ID   read members from another spreadsheet
 *   MEMBERS_SHEET_NAME       tab in that spreadsheet (default: first tab)
 *   DEDUCT_ON_CONSUME        'false' to stop "Use up" requests lowering Quantity
 *   BORROW_DAYS              days a borrow may stay out when the project has
 *                            no Event End Date (default 7)
 *   REMIND_EVERY_DAYS        days between repeat reminders (default 3)
 *   NOTIFY_EMAILS            comma-separated inbox(es) for the daily overdue digest
 *                            (default: emails in ACCESS)
 *   EMAIL_BORROWERS          'true' to also email the borrower and the project's cores
 */

var CELA = {
  CATALOG: 'CATALOG',
  STORAGE: 'STORAGE_AREAS',
  MEMBERS: 'MEMBERS',
  ACCESS: 'ACCESS',
  PROJECTS: 'PROJECTS',
  CORES: 'CORES',
  REQUESTS: 'REQUESTS',
  BORROWED: 'BORROWED_NOW',
  HEADERS: {
    CATALOG: ['Item', 'Category', 'Quantity', 'Storage Area', 'Specific Location', 'Notes', 'Last Updated'],
    STORAGE_AREAS: ['Storage Area', 'Description'],
    MEMBERS: ['ID Number', 'Name', 'Department', 'Position', 'Email'],
    ACCESS: ['ID Number', 'Name', 'Level', 'Email'],
    PROJECTS: ['Project/Dept', 'Active', 'Event End Date'],
    CORES: ['ID Number', 'Name', 'Project', 'Role'],
    REQUESTS: [
      'Timestamp', 'Request ID', 'Line ID', 'Client ID', 'ID Number', 'Name',
      'Case', 'Project', 'Department/Reason', 'Item', 'Qty',
      'Storage Area', 'Status', 'Due', 'Resolved At', 'Resolved By', 'Last Reminded'
    ]
  },
  DEPARTMENTS: ['COMMPUB', 'CUL', 'EXREL', 'FIN', 'HR', 'OSR'],
  DEFAULT_PROJECTS: [
    'COMMPUB', 'CUL', 'EXREL', 'FIN', 'HR', 'OSR',
    'Recruitment Week & Welcome Week', 'Celadon Merchandise', 'GA', 'MAF',
    'Lunar Lotus Market', 'TALAB x FAW', 'Jade Business Summit', 'LDP',
    'Celadon Rose Sale', 'CNY', 'Spring Film Festival', 'Binondo Amazing Race',
    'Mandopop Music Festival', 'Celadon Ball'
  ],
  CASES: ['BORROWING', 'CONSUMING', 'RETURNING'],
  STATUS: { PENDING: 'Pending', RETURNED: 'Returned', CONSUMED: 'Consumed', RETURN: 'Return logged' }
};

// Full department names (as they may appear in the member list) → codes.
var DEPT_ALIASES = {
  communicationsandpublications: 'COMMPUB', communicationsandpublicationsdepartment: 'COMMPUB',
  culturalaffairs: 'CUL', culturalaffairsdepartment: 'CUL',
  externalrelations: 'EXREL', externalrelationsdepartment: 'EXREL',
  financialaffairs: 'FIN', financialaffairsdepartment: 'FIN', finance: 'FIN',
  humanresources: 'HR', humanresourcesdepartment: 'HR',
  organizationstrategiesandresearch: 'OSR', organizationstrategiesandresearchdepartment: 'OSR'
};

// Header aliases so a copied/renamed sheet (or the existing members list) still works.
var COLS = {
  item: ['Item', 'Item Name', 'Title', 'Item Type'],
  category: ['Category', 'Department', 'Dept', 'Section'],
  qty: ['Quantity', 'Qty', 'Count', 'Stock'],
  storage: ['Storage Area', 'Location', 'Storage'],
  specific: ['Specific Location', 'Specifc Location', 'Exact Location'],
  notes: ['Notes', 'Remarks', 'Item Description', 'Description'],
  updated: ['Last Updated', 'Updated'],
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
      default:
        return respond_({ ok: false, error: 'Unknown action. Use login, inventory, projects, history, submitOrder, or resolve.' });
    }
  } catch (err) {
    return respond_({ ok: false, error: String(err && err.message || err) });
  }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Celadon Inventory')
    .addItem('Set up / repair tabs', 'setupSheets')
    .addItem('Show pending borrows', 'showPendingBorrows')
    .addSeparator()
    .addItem('Check overdue borrows now', 'flagOverdue')
    .addItem('Turn on daily overdue reminders (8 AM)', 'installDailyReminder')
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
    // Officers may act for anything; the app shows them the full project list.
    actFor: level === 'ADMIN' || level === 'OFFICER' ? ['*'] : actForList_(id, member)
  };
}

function inventory_() {
  var t = table_(CELA.CATALOG, COLS.item);
  var out = outByItem_();
  var items = [];
  t.rows.forEach(function (r) {
    var title = cell_(t, r, COLS.item);
    if (!title) return;
    var specific = cell_(t, r, COLS.specific);
    var notes = cell_(t, r, COLS.notes);
    items.push({
      title: title,
      category: cell_(t, r, COLS.category) || 'Misc',
      qty: cell_(t, r, COLS.qty),
      out: out[outKey_(title, cell_(t, r, COLS.storage))] || 0,
      location: cell_(t, r, COLS.storage),
      notes: [specific, notes].filter(String).join(' · ')
    });
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

  // Every request is made for a project or department the member can act for.
  var project = String(p.actingAs || p.project || '').trim();
  if (!project || /^personal$/i.test(project)) throw new Error('Choose the project or department this is for');
  if (!canActFor_(id, project, member)) {
    throw new Error('You can only log requests for your department or projects you are a core of (not ' + project + ')');
  }

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
    var catalog = table_(CELA.CATALOG, COLS.item);
    var deduct = prop_('DEDUCT_ON_CONSUME') !== 'false';
    var rows = [];
    var warnings = [];

    items.forEach(function (it) {
      var title = String(it.title || '').trim();
      var qty = Math.max(0, parseInt(it.qty, 10) || 0);
      if (!title || !qty) return;
      var status = caseType === 'BORROWING' ? CELA.STATUS.PENDING
        : caseType === 'CONSUMING' ? CELA.STATUS.CONSUMED : CELA.STATUS.RETURN;

      var match = findCatalogRow_(catalog, title, it.location);
      if (match === null) warnings.push('Not in CATALOG: ' + title);

      if (caseType === 'RETURNING') {
        var cleared = resolveBorrows_(requests, project, title, qty, member.name, now);
        if (cleared < qty) warnings.push(title + ': only ' + cleared + ' of ' + qty + ' matched a pending ' + project + ' borrow');
      }
      if (match !== null) {
        annotateQty_(catalog, match, '[' + caseType + '] - ' + qty + ' ' + project + ', ' + member.name + ' (' + Utilities.formatDate(now, tz, 'MMM d') + ')');
        if (caseType === 'CONSUMING' && deduct) deductQty_(catalog, match, qty, warnings, title);
        touch_(catalog, match, now);
      }

      rows.push([
        now, requestId, requestId + '-' + (rows.length + 1), clientId, "'" + id, member.name,
        caseType, project, String(p.committee || ''), title, qty,
        String(it.location || ''), status, due, '', '', ''
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

// Marks one pending borrow line as returned. Allowed for the borrower, anyone
// who can act for the line's project/department, or an ADMIN/OFFICER.
function resolve_(p) {
  var id = normalize_(p.idNumber);
  var member = findMember_(id);
  if (!member) throw new Error('ID ' + id + ' is not in the member list');
  var lineId = String(p.lineId || '').trim();
  if (!lineId) throw new Error('Missing line ID');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var t = requestsTable_();
    var c = function (h) { return t.index[key_(h)]; };
    for (var i = 0; i < t.rows.length; i++) {
      var r = t.rows[i];
      if (String(r[c('Line ID')]) !== lineId) continue;
      if (String(r[c('Status')]) !== CELA.STATUS.PENDING) return { ok: true, alreadyResolved: true };
      var isBorrower = normalize_(r[c('ID Number')]) === id;
      if (!isBorrower && !canActFor_(id, String(r[c('Project')]), member)) {
        throw new Error('Only the borrower or someone from ' + (r[c('Project')] || 'that project') + ' can mark this returned');
      }
      markReturned_(t.sheet, t.headerRow + 2 + i, c, member.name, new Date());
      return { ok: true, lineId: lineId };
    }
    throw new Error('Request line not found: ' + lineId);
  } finally {
    lock.releaseLock();
  }
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

// Same item name can exist in two storage areas, so count per name + area.
function outKey_(title, area) {
  return key_(title) + '|' + key_(area);
}

function outByItem_() {
  var out = {};
  if (!sheet_(CELA.REQUESTS, false)) return out;
  var t = requestsTable_();
  t.rows.forEach(function (r) {
    if (cell_(t, r, ['Case']).toUpperCase() !== 'BORROWING') return;
    if (cell_(t, r, ['Status']) !== CELA.STATUS.PENDING) return;
    var k = outKey_(cell_(t, r, ['Item']), cell_(t, r, ['Storage Area']));
    out[k] = (out[k] || 0) + (parseInt(cell_(t, r, ['Qty']), 10) || 0);
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
function resolveBorrows_(sheet, project, title, qty, byName, now) {
  var t = requestsTable_();
  var c = function (h) { return t.index[key_(h)]; };
  var remaining = qty;
  var cleared = 0;
  for (var i = 0; i < t.rows.length && remaining > 0; i++) {
    var r = t.rows[i];
    if (String(r[c('Case')]).toUpperCase() !== 'BORROWING') continue;
    if (String(r[c('Status')]) !== CELA.STATUS.PENDING) continue;
    if (key_(r[c('Item')]) !== key_(title)) continue;
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

function findCatalogRow_(t, title, location) {
  var want = key_(title);
  var loc = key_(location);
  var fallback = null;
  for (var i = 0; i < t.rows.length; i++) {
    if (key_(cell_(t, t.rows[i], COLS.item)) !== want) continue;
    if (!loc || key_(cell_(t, t.rows[i], COLS.storage)) === loc) return i;
    if (fallback === null) fallback = i;
  }
  return fallback;
}

function annotateQty_(t, i, line) {
  var col = colFor_(t, COLS.qty);
  if (col == null) return;
  var range = t.sheet.getRange(t.headerRow + 2 + i, col + 1);
  var existing = range.getNote();
  range.setNote(existing ? existing + '\n' + line : line);
}

function deductQty_(t, i, qty, warnings, title) {
  var col = colFor_(t, COLS.qty);
  if (col == null) return;
  var range = t.sheet.getRange(t.headerRow + 2 + i, col + 1);
  var current = range.getValue();
  if (typeof current !== 'number' && !/^\d+$/.test(String(current).trim())) return; // "many", "a lot" etc.
  var next = Number(current) - qty;
  if (next < 0) {
    warnings.push(title + ': requested ' + qty + ' but sheet had ' + current);
    next = 0;
  }
  range.setValue(next);
}

function touch_(t, i, now) {
  var col = colFor_(t, COLS.updated);
  if (col != null) t.sheet.getRange(t.headerRow + 2 + i, col + 1).setValue(now);
}

// ═══════════════════════════════════════════════════════════════════════
// Members, access, projects, cores
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

function isOfficer_(id) {
  var level = accessLevel_(id);
  return level === 'ADMIN' || level === 'OFFICER';
}

function coreProjects_(id) {
  if (!sheet_(CELA.CORES, false)) return [];
  var t = table_(CELA.CORES, COLS.id);
  var list = [];
  t.rows.forEach(function (r) {
    var project = cell_(t, r, COLS.project);
    if (project && normalize_(cell_(t, r, COLS.id)) === id && list.indexOf(project) === -1) list.push(project);
  });
  return list;
}

// Own department first, then CORES entries.
function actForList_(id, member) {
  var list = member.department ? [member.department] : [];
  coreProjects_(id).forEach(function (pr) {
    if (!list.some(function (x) { return key_(x) === key_(pr); })) list.push(pr);
  });
  return list;
}

function canActFor_(id, project, member) {
  if (!project) return false;
  if (isOfficer_(id)) return true;
  var want = key_(project);
  return actForList_(id, member || findMember_(id) || {}).some(function (pr) { return key_(pr) === want; });
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
// Overdue reminders (daily trigger)
// ═══════════════════════════════════════════════════════════════════════

function installDailyReminder() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'flagOverdue') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('flagOverdue').timeBased().everyDays(1).atHour(8).create();
  notify_('Daily overdue check is on (around 8 AM). Set NOTIFY_EMAILS in Script Properties to choose who gets the digest.');
}

// Highlights overdue borrows in REQUESTS and emails a digest. Each line is
// re-reminded at most every REMIND_EVERY_DAYS days.
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

  if (toRemind.length) {
    sendDigest_(toRemind);
    if (prop_('EMAIL_BORROWERS') === 'true') emailBorrowers_(toRemind);
    toRemind.forEach(function (l) { t.sheet.getRange(l.rowNum, c('Last Reminded') + 1).setValue(now); });
  }
  return { overdue: overdue.length, reminded: toRemind.length };
}

function overdueLine_(l) {
  return '• ' + l.qty + '× ' + l.item + ' — ' + l.project + ' (borrowed by ' + l.name + ') — ' +
    l.days + ' day' + (l.days === 1 ? '' : 's') + ' overdue';
}

function sendDigest_(lines) {
  var to = prop_('NOTIFY_EMAILS') || accessEmails_().join(',');
  if (!to) return;
  MailApp.sendEmail({
    to: to,
    subject: '[Celadon Inventory] ' + lines.length + ' overdue borrow' + (lines.length === 1 ? '' : 's'),
    body: 'Still out of the org room past their return date:\n\n' + lines.map(overdueLine_).join('\n') +
      '\n\nOpen the BORROWED_NOW tab for the full list. Mark items returned in the app once they are back.'
  });
}

// One email per person: the borrower plus every core of the project.
function emailBorrowers_(lines) {
  var byEmail = {};
  var add = function (id, line) {
    var m = findMember_(id);
    if (!m || !m.email) return;
    var entry = byEmail[m.email] = byEmail[m.email] || { name: m.name, lines: [] };
    if (entry.lines.indexOf(line) === -1) entry.lines.push(line);
  };
  lines.forEach(function (l) {
    add(l.id, l);
    coreIds_(l.project).forEach(function (id) { add(id, l); });
  });
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

function coreIds_(project) {
  if (!sheet_(CELA.CORES, false)) return [];
  var t = table_(CELA.CORES, COLS.id);
  var want = key_(project);
  return t.rows.filter(function (r) { return key_(cell_(t, r, COLS.project)) === want; })
    .map(function (r) { return normalize_(cell_(t, r, COLS.id)); }).filter(String);
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
  var tabs = [CELA.CATALOG, CELA.STORAGE, CELA.ACCESS, CELA.PROJECTS, CELA.CORES, CELA.REQUESTS];
  if (!prop_('MEMBERS_SPREADSHEET_ID')) tabs.push(CELA.MEMBERS);
  tabs.forEach(ensureSheet_);

  var projects = sheet_(CELA.PROJECTS);
  if (projects.getLastRow() < 2) {
    var rows = CELA.DEFAULT_PROJECTS.map(function (name) { return [name, true, '']; });
    projects.getRange(2, 1, rows.length, 3).setValues(rows);
    projects.getRange(2, 2, rows.length, 1).insertCheckboxes();
  }
  projects.getRange('C2:C').setNumberFormat('mmm d, yyyy');

  seedStorageAreas_();
  validateColumn_(CELA.CATALOG, COLS.storage, SpreadsheetApp.newDataValidation()
    .requireValueInRange(sheet_(CELA.STORAGE).getRange('A2:A'), true).setAllowInvalid(false)
    .setHelpText('Pick a storage area. Add new ones in the STORAGE_AREAS tab.').build());
  validateColumn_(CELA.CORES, COLS.project, SpreadsheetApp.newDataValidation()
    .requireValueInRange(projects.getRange('A2:A'), true).build());
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
  notify_('Celadon Inventory tabs are ready. Fill in CATALOG, STORAGE_AREAS, CORES and the member list next.');
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
  // Existing tab (e.g. copied from MEA's sheet): append any missing columns.
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

// First run only: fill STORAGE_AREAS from whatever CATALOG already uses.
function seedStorageAreas_() {
  var storage = sheet_(CELA.STORAGE);
  if (storage.getLastRow() > 1) return;
  var t = table_(CELA.CATALOG, COLS.item);
  var seen = {};
  t.rows.forEach(function (r) {
    var area = cell_(t, r, COLS.storage);
    if (area && !seen[key_(area)]) seen[key_(area)] = area;
  });
  var areas = Object.keys(seen).map(function (k) { return [seen[k], '']; })
    .sort(function (a, b) { return a[0].localeCompare(b[0]); });
  if (areas.length) storage.getRange(2, 1, areas.length, 2).setValues(areas);
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
