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
 *   BORROW_DAYS              days a borrow may stay out when there's no project
 *                            end date to go by (default 7). Project borrows are
 *                            due one month after the project's Event End Date.
 *   REMIND_EVERY_DAYS        days between repeat overdue reminders (default 3)
 *   EXPIRY_WARN_DAYS         flag Consumables expiring within this many days (default 14)
 *   NOTIFY_EMAILS            comma-separated inbox(es) for the daily digest
 *                            (default: emails in ACCESS)
 *   EMAIL_BORROWERS          'true' to also email each borrower
 *   HISTORY_DAYS             finished lines older than this aren't sent to the app (default 180)
 *   UNDO_HOURS               how long a "Mark returned" can be undone from the app (default 48)
 */

var CELA = {
  // Item tabs, in the order the app lists them.
  SOURCES: [
    { tab: 'Inventory', kind: 'inventory', anchor: ['Item'], prefix: 'INV' },
    { tab: 'Consumables', kind: 'consumable', anchor: ['Item'], prefix: 'CON' },
    { tab: 'Celamerch', kind: 'merch', anchor: ['Merch Design'], prefix: 'MER' }
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
    'OP', 'COMMPUB', 'CUL', 'EXREL', 'FIN', 'HR', 'OSR',
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
  itemId: ['Item ID'],
  borrowed: ['Currently Borrowed'],
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

// Actions that change the sheet must come as POST (not a shareable GET link).
var WRITE_ACTIONS = ['submitOrder', 'resolve', 'unresolve', 'addItem'];

function route_(e, body) {
  var p = mergeParams_(e, body);
  var action = String(p.action || '').trim();
  try {
    if (WRITE_ACTIONS.indexOf(action) !== -1 && body === null) {
      throw new Error('Use POST for ' + action);
    }
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
      case 'unresolve':
        requireToken_(p);
        return respond_(unresolve_(p));
      case 'options':
        return respond_(options_());
      case 'addItem':
        requireToken_(p);
        return respond_(addItem_(p));
      default:
        return respond_({ ok: false, error: 'Unknown action. Use login, inventory, projects, history, submitOrder, resolve, options, or addItem.' });
    }
  } catch (err) {
    var msg = String(err && err.message || err);
    // Google being busy (lock wait, rate limit, service hiccup): the app
    // should simply try again later instead of counting it as a failure.
    var retry = /lock|timed out|too many|try again later|service (error|unavailable)|internal error/i.test(msg);
    return respond_({ ok: false, error: msg, retry: retry });
  }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Celadon Inventory')
    .addItem('Set up / repair app tabs', 'setupSheets')
    .addItem('Show pending borrows', 'showPendingBorrows')
    .addItem('Refresh member list now', 'refreshMemberCache')
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
      kind: e.itemCategory || '',
      out: out[e.ref] || 0,
      location: e.storage || e.spot,
      spot: e.spot,
      sheetNotes: e.notes,
      notes: [e.storage ? e.spot : '', e.event, e.notes].filter(String).join(' · ')
    };
  });
  return { ok: true, items: items };
}

function projects_() {
  var list = projectTable_().filter(function (pr) { return pr.active; }).map(function (pr) { return pr.name; });
  return { ok: true, projects: list.length ? list : CELA.DEFAULT_PROJECTS.slice() };
}

// Everything still pending, plus finished lines from the last HISTORY_DAYS
// (default 180) so the response stays small as REQUESTS grows.
function history_() {
  var t = requestsTable_();
  var now = new Date();
  var keepSince = new Date(now.getTime() - (parseInt(prop_('HISTORY_DAYS'), 10) || 180) * 86400000);
  var records = [];
  t.rows.forEach(function (r) {
    var caseType = cell_(t, r, ['Case']).toUpperCase();
    if (!caseType || caseType === 'RETURNING') return; // returns show up as the borrow flipping to Returned
    var status = cell_(t, r, ['Status']);
    var due = r[t.index[key_('Due')]];
    var pending = status === CELA.STATUS.PENDING;
    var ts = r[t.index[key_('Timestamp')]];
    var resolvedAt = r[t.index[key_('Resolved At')]];
    var lastTouched = resolvedAt instanceof Date ? resolvedAt : ts;
    if (!pending && lastTouched instanceof Date && lastTouched < keepSince) return;
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
      resolvedAt: iso_(resolvedAt),
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
    var requestId = 'REQ-' + Utilities.formatDate(now, tz, 'yyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 6);
    var due = caseType === 'BORROWING' ? dueDate_(project, now) : '';
    var entries = catalogEntries_();
    var out = outByRef_();
    var deduct = prop_('DEDUCT_ON_CONSUME') !== 'false';
    var committee = safe_(p.committee, 120);
    var rows = [];
    var plan = [];
    var warnings = [];

    // 1. Work out every line first (nothing written yet).
    items.forEach(function (it) {
      var title = String(it.title || '').trim().slice(0, 120);
      var qty = Math.min(MAX_QTY, Math.max(0, parseInt(it.qty, 10) || 0));
      if (!title || !qty) return;
      var status = caseType === 'BORROWING' ? CELA.STATUS.PENDING
        : caseType === 'CONSUMING' ? CELA.STATUS.CONSUMED
        : caseType === 'RESTOCKING' ? CELA.STATUS.ADDED : CELA.STATUS.RETURN;

      var entry = findEntry_(entries, it.ref, title, it.location);
      if (!entry) warnings.push('Not found in the inventory tabs: ' + title);
      var ref = entry ? entry.ref : String(it.ref || '');

      if (entry && (caseType === 'BORROWING' || caseType === 'CONSUMING')) {
        var total = /^\d+$/.test(String(entry.qty).trim()) ? Number(entry.qty) : null;
        var avail = total == null ? null : Math.max(0, total - (out[ref] || 0));
        if (avail != null && qty > avail) warnings.push(title + ': asked for ' + qty + ' but only ' + avail + ' left in the sheet');
        if (/^missing$/i.test(entry.status)) warnings.push(title + ' is marked Missing in the sheet');
      }
      plan.push({ entry: entry, ref: ref, title: title, qty: qty });
      rows.push([
        now, requestId, requestId + '-' + (rows.length + 1), clientId, "'" + id, member.name,
        caseType, project, committee, safe_(title, 120), ref, qty,
        entry ? safe_(entry.storage || entry.spot, 120) : safe_(it.location, 120), status, due, '', '', ''
      ]);
    });
    if (!rows.length) throw new Error('No valid items in request');

    // 2. Log the request (so a failure below can never leave unlogged changes).
    requests.getRange(requests.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

    // 3. Apply the changes to the item tabs.
    plan.forEach(function (x) {
      if (caseType === 'RETURNING') {
        var cleared = resolveBorrows_(requests, project, x.ref, x.title, x.qty, member.name, now);
        if (cleared < x.qty) warnings.push(x.title + ': only ' + cleared + ' of ' + x.qty + ' matched a pending ' + project + ' borrow');
        out[x.ref] = Math.max(0, (out[x.ref] || 0) - cleared);
      }
      if (!x.entry) return;
      annotateQty_(x.entry, '[' + caseType + '] - ' + x.qty + ' ' + project + ', ' + member.name + ' (' + Utilities.formatDate(now, tz, 'MMM d') + ')');
      if (caseType === 'BORROWING') {
        out[x.ref] = (out[x.ref] || 0) + x.qty;
        syncOutStatus_(x.entry, out[x.ref]);
      } else if (caseType === 'CONSUMING' && deduct) {
        deductQty_(x.entry, x.qty, warnings);
      } else if (caseType === 'RETURNING') {
        syncOutStatus_(x.entry, out[x.ref] || 0);
      } else if (caseType === 'RESTOCKING') {
        addQty_(x.entry, x.qty, warnings);
      }
    });
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
  // Optional partial returns: { lineId: how many came back }.
  var partial = p.qtys && typeof p.qtys === 'object' ? p.qtys : {};

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
      var lent = parseInt(r[c('Qty')], 10) || 0;
      var back = parseInt(partial[lineId], 10);
      if (back > 0 && back < lent) {
        // Some came back: the borrow keeps the rest, and a Returned line
        // records what came back.
        t.sheet.getRange(t.headerRow + 2 + i, c('Qty') + 1).setValue(lent - back);
        var copy = r.slice();
        copy[c('Line ID')] = lineId + '-R' + Utilities.getUuid().slice(0, 4);
        copy[c('Qty')] = back;
        copy[c('Status')] = CELA.STATUS.RETURNED;
        copy[c('Resolved At')] = now;
        copy[c('Resolved By')] = member.name;
        copy[c('Last Reminded')] = '';
        copy[c('ID Number')] = "'" + normalize_(copy[c('ID Number')]);
        t.sheet.getRange(t.sheet.getLastRow() + 1, 1, 1, copy.length).setValues([copy]);
      } else {
        markReturned_(t.sheet, t.headerRow + 2 + i, c, member.name, now);
      }
      resolved.push(lineId);
      touched.push({ ref: String(r[c('Item Ref')] || ''), title: String(r[c('Item')]), where: String(r[c('Storage Area')]) });
    });
    var missing = wanted.filter(function (x) { return resolved.indexOf(x) === -1 && already.indexOf(x) === -1; });
    if (wanted.length === 1 && missing.length) throw new Error('Request line not found: ' + wanted[0]);

    // Put each affected item's Status back once everything is recorded.
    if (touched.length) {
      var entries = catalogEntries_(true);
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

// Undo a "Mark returned" done by mistake (within UNDO_HOURS, default 48).
// Partial-return lines can't be undone this way; fix those in the sheet.
function unresolve_(p) {
  var id = normalize_(p.idNumber);
  var member = findMember_(id);
  if (!member) throw new Error('ID ' + id + ' is not in the member list');
  var lineId = String(p.lineId || '').trim();
  var hours = parseInt(prop_('UNDO_HOURS'), 10) || 48;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var t = requestsTable_();
    var c = function (h) { return t.index[key_(h)]; };
    for (var i = 0; i < t.rows.length; i++) {
      var r = t.rows[i];
      if (String(r[c('Line ID')]) !== lineId) continue;
      if (String(r[c('Status')]) !== CELA.STATUS.RETURNED || String(r[c('Case')]).toUpperCase() !== 'BORROWING') {
        throw new Error('Only a returned borrow can be undone');
      }
      if (/-R[0-9a-f]{4}$/.test(lineId)) throw new Error('This was a partial return; fix it in the REQUESTS tab');
      var at = r[c('Resolved At')];
      if (!(at instanceof Date) || (new Date() - at) > hours * 3600000) throw new Error('Too late to undo here; ask an officer to fix it in the sheet');
      var rowNum = t.headerRow + 2 + i;
      t.sheet.getRange(rowNum, c('Status') + 1).setValue(CELA.STATUS.PENDING);
      t.sheet.getRange(rowNum, c('Resolved At') + 1).setValue('');
      t.sheet.getRange(rowNum, c('Resolved By') + 1).setValue('');
      var entry = findEntry_(catalogEntries_(true), String(r[c('Item Ref')] || ''), String(r[c('Item')]), String(r[c('Storage Area')]));
      if (entry) syncOutStatus_(entry, outByRef_()[entry.ref] || 0);
      return { ok: true, lineId: lineId };
    }
    throw new Error('Request line not found: ' + lineId);
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Catalog (Inventory, Consumables, Celamerch)
// ═══════════════════════════════════════════════════════════════════════

// Every listable item row across the item tabs. `ref` is the row's
// permanent Item ID (e.g. INV-0042) once setupSheets has added that column;
// before that it falls back to a content key (tab + item + dept + spot).
var healingIds_ = false;
function catalogEntries_(includeHidden) {
  var entries = [];
  var needsIds = false;
  CELA.SOURCES.forEach(function (src) {
    var sheet = sheet_(src.tab, false);
    if (!sheet) return;
    var t = tableFromSheet_(sheet, src.anchor);
    var expiryCol = colFor_(t, COLS.expiry);
    var idCol = colFor_(t, COLS.itemId);
    var seen = {};
    var ids = {};
    t.rows.forEach(function (r, i) {
      var e = src.kind === 'merch' ? merchEntry_(t, r) : itemEntry_(t, r);
      if (!e) return;
      e.kind = src.kind;
      e.prefix = src.prefix;
      e.t = t;
      e.i = i;
      e.expiry = expiryCol != null && r[expiryCol] instanceof Date ? r[expiryCol] : null;
      // Content key, numbered before hiding Used Up rows (the pre-ID scheme;
      // still used to match old REQUESTS rows and to spot duplicate adds).
      e.contentKey = src.kind + ':' + [e.title, e.category, e.storage, e.spot].map(key_).join('|');
      seen[e.contentKey] = (seen[e.contentKey] || 0) + 1;
      e.legacyRef = seen[e.contentKey] > 1 ? e.contentKey + '#' + seen[e.contentKey] : e.contentKey;
      e.id = idCol != null ? normalize_(r[idCol]) : '';
      if (idCol != null && (!e.id || ids[e.id])) needsIds = true; // missing, or copy-pasted duplicate
      if (e.id) ids[e.id] = true;
      e.ref = e.id || e.legacyRef;
      if (!includeHidden && CELA.HIDDEN_STATUSES.indexOf(key_(e.status)) !== -1) return;
      entries.push(e);
    });
  });
  // Rows added by hand (or copy-pasted) get an ID on the next read.
  if (needsIds && !healingIds_) {
    healingIds_ = true;
    try { if (assignItemIds_()) return catalogEntries_(includeHidden); }
    finally { healingIds_ = false; }
  }
  return entries;
}

// ═══════════════════════════════════════════════════════════════════════
// Permanent item IDs + "Currently Borrowed"
// ═══════════════════════════════════════════════════════════════════════

// Gives every item row without an ID (or with a duplicated one) a new
// INV-/CON-/MER- number, moves old REQUESTS rows onto the IDs, and makes
// sure Inventory's Currently Borrowed formulas are in place.
// Returns true if anything was written.
function assignItemIds_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return false;
  var wrote = false;
  try {
    var legacyToId = {};
    CELA.SOURCES.forEach(function (src) {
      var sheet = sheet_(src.tab, false);
      if (!sheet) return;
      var t = tableFromSheet_(sheet, src.anchor);
      var idCol = colFor_(t, COLS.itemId);
      if (idCol == null || !t.rows.length) return;
      var pattern = new RegExp('^' + src.prefix + '-(\\d+)$');
      var max = 0;
      t.rows.forEach(function (r) {
        var m = normalize_(r[idCol]).match(pattern);
        if (m) max = Math.max(max, Number(m[1]));
      });
      var used = {};
      var seen = {};
      var tabChanged = false;
      var column = t.rows.map(function (r) {
        var e = src.kind === 'merch' ? merchEntry_(t, r) : itemEntry_(t, r);
        var id = normalize_(r[idCol]);
        if (!e) return [id];
        var key = src.kind + ':' + [e.title, e.category, e.storage, e.spot].map(key_).join('|');
        seen[key] = (seen[key] || 0) + 1;
        var legacy = seen[key] > 1 ? key + '#' + seen[key] : key;
        if (!id || used[id]) { id = src.prefix + '-' + ('000' + (++max)).slice(-4); tabChanged = true; }
        used[id] = true;
        legacyToId[legacy] = id;
        return [id];
      });
      if (tabChanged) { sheet.getRange(t.headerRow + 2, idCol + 1, column.length, 1).setValues(column); wrote = true; }
      if (src.kind === 'inventory') wrote = ensureBorrowedFormulas_(sheet) || wrote;
    });

    // Old REQUESTS rows pointed at content keys; repoint them at the IDs.
    var req = sheet_(CELA.REQUESTS, false);
    if (req) {
      var rt = requestsTable_();
      var refCol = rt.index[key_('Item Ref')];
      if (refCol != null && rt.rows.length) {
        var changed = false;
        var refs = rt.rows.map(function (r) {
          var ref = String(r[refCol] || '');
          if (ref.indexOf(':') !== -1 && legacyToId[ref]) { changed = true; return [legacyToId[ref]]; }
          return [ref];
        });
        if (changed) { req.getRange(rt.headerRow + 2, refCol + 1, refs.length, 1).setValues(refs); wrote = true; }
      }
    }
  } finally {
    lock.releaseLock();
  }
  return wrote;
}

// Currently Borrowed = sum of this item's pending borrows in REQUESTS, as a
// formula on each item row (so it's always live and survives sorting).
function borrowedFormulaR1C1_(t) {
  var idCol = colFor_(t, COLS.itemId);
  var rt = requestsTable_();
  var C = function (h) { return rt.index[key_(h)] + 1; };
  if (idCol == null || [C('Qty'), C('Item Ref'), C('Case'), C('Status')].some(isNaN)) return null;
  return '=IF(RC' + (idCol + 1) + '="","",SUMIFS(' + CELA.REQUESTS + '!C' + C('Qty') + ',' +
    CELA.REQUESTS + '!C' + C('Item Ref') + ',RC' + (idCol + 1) + ',' +
    CELA.REQUESTS + '!C' + C('Case') + ',"BORROWING",' +
    CELA.REQUESTS + '!C' + C('Status') + ',"' + CELA.STATUS.PENDING + '"))';
}

function ensureBorrowedFormulas_(sheet) {
  var t = tableFromSheet_(sheet, ['Item']);
  var col = colFor_(t, COLS.borrowed);
  var itemCol = colFor_(t, COLS.item);
  var formula = borrowedFormulaR1C1_(t);
  if (col == null || !formula || !t.rows.length) return false;
  var range = sheet.getRange(t.headerRow + 2, col + 1, t.rows.length, 1);
  var current = range.getFormulasR1C1();
  var changed = false;
  var out = t.rows.map(function (r, i) {
    var want = normalize_(r[itemCol]) ? formula : '';
    if ((current[i] && current[i][0]) !== want) changed = true;
    return [want];
  });
  if (changed) range.setFormulasR1C1(out);
  return changed;
}

// Adds the Item ID column (end of each item tab) and Inventory's Currently
// Borrowed column (right after Qty), if they're missing. Run via setupSheets.
function ensureItemColumns_() {
  CELA.SOURCES.forEach(function (src) {
    var sheet = sheet_(src.tab, false);
    if (!sheet) return;
    var t = tableFromSheet_(sheet, src.anchor);
    var hr = t.headerRow + 1;
    if (src.kind === 'inventory' && colFor_(t, COLS.borrowed) == null) {
      var qtyCol = colFor_(t, COLS.qty);
      if (qtyCol != null) {
        sheet.insertColumnAfter(qtyCol + 1);
        sheet.getRange(hr, qtyCol + 1).copyTo(sheet.getRange(hr, qtyCol + 2), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
        sheet.getRange(hr, qtyCol + 2).setValue('Currently Borrowed')
          .setNote('Filled in by the Celadon Inventory app: units borrowed and not yet returned. Don\'t type here.');
        t = tableFromSheet_(sheet, src.anchor);
      }
    }
    if (colFor_(t, COLS.itemId) == null) {
      var headerCells = sheet.getRange(hr, 1, 1, sheet.getLastColumn()).getValues()[0];
      var last = 0;
      headerCells.forEach(function (v, i) { if (normalize_(v)) last = i + 1; });
      sheet.insertColumnAfter(last);
      sheet.getRange(hr, last).copyTo(sheet.getRange(hr, last + 1), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      sheet.getRange(hr, last + 1).setValue('Item ID')
        .setNote('Permanent ID used by the Celadon Inventory app to track borrows. Don\'t edit or copy.');
      try {
        var protection = sheet.getRange(hr + 1, last + 1, Math.max(sheet.getMaxRows() - hr, 1), 1).protect();
        protection.setDescription('Item IDs (Celadon Inventory app)').setWarningOnly(true);
      } catch (e) { /* protection is a nicety */ }
    }
  });
  protectAppAreas_();
  assignItemIds_();
}

// Warning-only protection: people can still edit, but get a "this is managed
// by the inventory app" prompt first. Covers item-tab header rows, the
// Currently Borrowed column and the REQUESTS log.
function protectAppAreas_() {
  var warn = function (range, what) {
    try {
      var existing = range.getSheet().getProtections(SpreadsheetApp.ProtectionType.RANGE)
        .some(function (pr) { return pr.getDescription() === what; });
      if (!existing) range.protect().setDescription(what).setWarningOnly(true);
    } catch (e) { /* protection is a nicety */ }
  };
  CELA.SOURCES.forEach(function (src) {
    var sheet = sheet_(src.tab, false);
    if (!sheet) return;
    var t = tableFromSheet_(sheet, src.anchor);
    warn(sheet.getRange(t.headerRow + 1, 1, 1, sheet.getLastColumn()), 'Column headers (' + src.tab + ', Celadon Inventory app)');
    var b = colFor_(t, COLS.borrowed);
    if (b != null) warn(sheet.getRange(t.headerRow + 2, b + 1, Math.max(sheet.getMaxRows() - t.headerRow - 1, 1), 1), 'Currently Borrowed formulas (Celadon Inventory app)');
  });
  var req = sheet_(CELA.REQUESTS, false);
  if (req) {
    try {
      var has = req.getProtections(SpreadsheetApp.ProtectionType.SHEET).length > 0;
      if (!has) req.protect().setDescription('Request log (Celadon Inventory app)').setWarningOnly(true);
    } catch (e) {}
  }
}

function itemEntry_(t, r) {
  var title = cell_(t, r, COLS.item);
  if (!title) return null;
  return {
    title: title,
    category: cell_(t, r, COLS.dept) || 'General',
    type: cell_(t, r, COLS.type),
    itemCategory: cell_(t, r, COLS.category),
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
    var byRef = entries.filter(function (e) { return e.ref === ref || e.id === ref || e.legacyRef === ref; })[0];
    // A known ref that's gone must not fall back to some other department's
    // same-name row.
    if (byRef || /^(inventory|consumable|merch):|^(INV|CON|MER)-\d+$/.test(ref)) return byRef || null;
  }
  var want = key_(title);
  var loc = key_(location);
  var matches = entries.filter(function (e) { return key_(e.title) === want; });
  return matches.filter(function (e) { return loc && (key_(e.storage) === loc || key_(e.spot) === loc); })[0] ||
    matches[0] || null;
}

function entryRange_(e, candidates) {
  var col = colFor_(e.t, candidates);
  return col == null ? null : e.t.sheet.getRange(entryRow_(e), col + 1);
}

// The sheet row of an entry, double-checked against its Item ID right before
// writing: if someone sorted or inserted rows since it was read, find the ID
// again instead of writing into whatever row now sits there.
function entryRow_(e) {
  var row = e.t.headerRow + 2 + e.i;
  var idCol = colFor_(e.t, COLS.itemId);
  if (!e.id || idCol == null || e.verified) return row;
  var sheet = e.t.sheet;
  if (normalize_(sheet.getRange(row, idCol + 1).getValue()) !== e.id) {
    var height = Math.max(sheet.getLastRow() - e.t.headerRow - 1, 1);
    var ids = sheet.getRange(e.t.headerRow + 2, idCol + 1, height, 1).getValues();
    var k = -1;
    for (var n = 0; n < ids.length; n++) { if (normalize_(ids[n][0]) === e.id) { k = n; break; } }
    if (k === -1) throw new Error(e.title + ' (' + e.id + ') was moved or deleted in the sheet while saving. Please try again.');
    e.i = k;
    row = e.t.headerRow + 2 + k;
  }
  e.verified = true;
  return row;
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
  if (typeof current !== 'number' && !/^\d+$/.test(String(current).trim())) {
    if (String(current).trim() !== '*' && warnings) warnings.push(e.title + ': Qty in the sheet is "' + current + '" (not a plain number), so it wasn\'t lowered. Please fix it in the sheet.');
    return;
  }
  // Over-asking was already reported by submitOrder_; just never go below 0.
  var next = Math.max(0, Number(current) - qty);
  range.setValue(next);
  if (next === 0) setStatus_(e, CELA.ITEM_STATUS.USED_UP);
}

// Restock: raise a numeric (or blank) Qty; "*"/"many" stay as they are.
// A Used Up row comes back into storage.
function addQty_(e, qty, warnings) {
  var range = entryRange_(e, COLS.qty);
  if (!range) return;
  var current = range.getValue();
  var text = String(current).trim();
  if (text === '' || typeof current === 'number' || /^\d+$/.test(text)) {
    range.setValue((Number(current) || 0) + qty);
  } else if (text !== '*' && warnings) {
    warnings.push(e.title + ': Qty in the sheet is "' + current + '" (not a plain number), so it wasn\'t raised. Please fix it in the sheet.');
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
    var allOut = !isNaN(total) && outQty >= total; // "*" or blank: never all out
    if (allOut && (status === '' || status === key_(CELA.ITEM_STATUS.IN))) setStatus_(e, CELA.ITEM_STATUS.OUT);
    else if (!allOut && status === key_(CELA.ITEM_STATUS.OUT)) setStatus_(e, CELA.ITEM_STATUS.IN); // stock was added
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
  var v = validateNewItem_(p, true);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // Same item, same department (and same batch for expiring items)?
    // Add to that row instead of creating a duplicate.
    var target = findMergeTarget_(v);
    if (target) return mergeIntoExisting_(target, v, member, id);
    v = validateNewItem_(p, false); // a brand-new row needs every field
    var tabName = v.expiry && sheet_('Consumables', false) ? 'Consumables' : 'Inventory';
    var kind = tabName === 'Consumables' ? 'consumable' : 'inventory';
    var base = kind + ':' + [v.title, v.dept, v.storage, v.spot].map(key_).join('|');
    var now = new Date();
    var stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'MMM d, yyyy');
    if (v.newStorage) addStorageOption_(v.storage);

    var sheet = sheet_(tabName);
    var t = tableFromSheet_(sheet, ['Item']);
    var itemCol = colFor_(t, COLS.item);
    var last = -1;
    t.rows.forEach(function (r, i) { if (normalize_(r[itemCol]) !== '') last = i; });
    var rowNum = t.headerRow + 2 + last + 1;
    if (rowNum > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);

    // Whole row in one write: blanks included, so leftovers in that row are cleared.
    var width = sheet.getLastColumn();
    var row = sheet.getRange(rowNum, 1, 1, width).getValues()[0].map(function () { return ''; });
    [[COLS.item, v.title], [COLS.type, v.type], [COLS.qty, v.qty], [COLS.unit, v.unit],
      [COLS.dept, v.dept], [COLS.category, v.category], [COLS.status, CELA.ITEM_STATUS.IN],
      [COLS.storage, v.storage], [COLS.spot, v.spot], [COLS.event, v.event], [COLS.notes, v.notes],
      [COLS.expiry, v.expiry]].forEach(function (pair) {
      var col = colFor_(t, pair[0]);
      if (col != null && col < width && pair[1] != null) row[col] = pair[1];
    });
    // Permanent ID for the new row.
    var newRef = base;
    var idCol = colFor_(t, COLS.itemId);
    if (idCol != null && idCol < width) {
      var prefix = kind === 'consumable' ? 'CON' : 'INV';
      var max = 0;
      t.rows.forEach(function (r) { var m = normalize_(r[idCol]).match(new RegExp('^' + prefix + '-(\\d+)$')); if (m) max = Math.max(max, Number(m[1])); });
      newRef = prefix + '-' + ('000' + (max + 1)).slice(-4);
      row[idCol] = newRef;
    }
    sheet.getRange(rowNum, 1, 1, width).setValues([row]);
    var qtyCol = colFor_(t, COLS.qty);
    if (qtyCol != null) sheet.getRange(rowNum, qtyCol + 1).setNote('[ADDED] by ' + member.name + ' (' + stamp + ')');
    var borrowedCol = colFor_(t, COLS.borrowed);
    var formula = borrowedCol != null ? borrowedFormulaR1C1_(t) : null;
    if (formula) sheet.getRange(rowNum, borrowedCol + 1).setFormulaR1C1(formula);

    logAdd_(member, id, v, newRef, now);
    return { ok: true, ref: newRef, tab: tabName, row: rowNum };
  } finally {
    lock.releaseLock();
  }
}

// Server-side checks for the Add form (the app checks the same things, but
// the sheet must never rely on that).
// strictNew === false/undefined → everything required for a brand-new row;
// lenient (true) → only what a merge needs.
function validateNewItem_(p, lenient) {
  var lists = options_().options;
  var text = function (v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); };
  var inList = function (value, list, label, required) {
    if (!value) { if (required) throw new Error('Choose a ' + label); return ''; }
    if (list && list.length) {
      var hit = list.filter(function (x) { return key_(x) === key_(value); })[0];
      if (!hit) throw new Error('"' + value + '" is not one of the ' + label + ' options');
      return hit;
    }
    return value;
  };
  var v = {};
  v.title = text(p.title, 80);
  if (v.title.length < 2) throw new Error('Enter the item name (at least 2 characters)');
  if (/^[=+\-@]/.test(v.title)) throw new Error('Item names can\'t start with = + - or @');
  v.qtyText = text(p.qty, 6);
  if (!v.qtyText) throw new Error('Enter how many there are (or * for a lot)');
  if (v.qtyText !== '*' && !/^\d+$/.test(v.qtyText)) throw new Error('Quantity must be a whole number, or * for a lot');
  v.qty = v.qtyText === '*' ? '*' : Number(v.qtyText);
  if (v.qty !== '*' && (v.qty < 1 || v.qty > MAX_QTY)) throw new Error('Quantity must be between 1 and ' + MAX_QTY);
  v.unit = safe_(text(p.unit, 15), 15);
  if (v.unit && !/^[\p{L} .\/-]+$/u.test(v.unit)) throw new Error('Unit should be a word like pcs, packs or sets');
  v.dept = inList(text(p.department, 40), lists.departments, 'department', true);
  v.type = inList(text(p.type, 40), lists.types, 'type', !lenient);
  v.category = inList(text(p.category, 40), lists.categories, 'category', !lenient);
  v.event = inList(text(p.event, 60), lists.events, 'event', false);
  v.spot = safe_(text(p.spot, 80), 80);
  v.notes = safe_(text(p.notes, 300), 300);
  var storage = text(p.storage, 40);
  v.newStorage = false;
  if (storage) {
    var known = (lists.storageAreas || []).filter(function (x) { return key_(x) === key_(storage); })[0];
    if (known) storage = known;
    else {
      if (storage.length < 3) throw new Error('New location name is too short');
      if (/^[=+\-@]/.test(storage)) throw new Error('Location names can\'t start with = + - or @');
      v.newStorage = true;
    }
  }
  v.storage = storage;
  if (!lenient && !v.storage && !v.spot) throw new Error('Add a storage area or a specific spot so people can find it');
  v.expiry = null;
  if (p.expiry) {
    var d = new Date(p.expiry);
    if (isNaN(d.getTime())) throw new Error('Expiry date is not a valid date');
    var today = startOfDay_(new Date());
    if (d < new Date(today.getTime() - 366 * 86400000) || d > new Date(today.getTime() + 15 * 366 * 86400000)) {
      throw new Error('Expiry date looks wrong. Check the year');
    }
    v.expiry = d;
  }
  v.title = safe_(v.title, 80);
  return v;
}

// "Scissor" / "scissors" / "Scissors " are the same item; so are box / boxes.
function sameItemName_(a, b) {
  var x = key_(a), y = key_(b);
  return !!x && (x === y || x + 's' === y || y + 's' === x || x + 'es' === y || y + 'es' === x);
}

function unitKey_(u) {
  var k = key_(u);
  if (/^(pc|pcs|piece|pieces)$/.test(k)) return 'pc';
  return k.replace(/(es|s)$/, '');
}

function sameDay_(a, b) {
  return a instanceof Date && b instanceof Date && startOfDay_(a).getTime() === startOfDay_(b).getTime();
}

// The row a new entry should merge into, if any: same item name + same
// department in the same tab (Consumables: same expiry date too). Prefers a
// row in the same spot, then one that's still listed.
function findMergeTarget_(v) {
  var kind = v.expiry && sheet_('Consumables', false) ? 'consumable' : 'inventory';
  var matches = catalogEntries_(true).filter(function (e) {
    return e.kind === kind && sameItemName_(e.title, v.title) && key_(e.category) === key_(v.dept) &&
      (kind !== 'consumable' || sameDay_(e.expiry, v.expiry));
  });
  if (!matches.length) return null;
  var hidden = function (e) { return CELA.HIDDEN_STATUSES.indexOf(key_(e.status)) !== -1; };
  return matches.filter(function (e) {
    return (v.storage && key_(e.storage) === key_(v.storage)) || (v.spot && key_(e.spot) === key_(v.spot));
  })[0] || matches.filter(function (e) { return !hidden(e); })[0] || matches[0];
}

function mergeIntoExisting_(target, v, member, id) {
  if (target.unit && v.unit && unitKey_(target.unit) !== unitKey_(v.unit)) {
    throw new Error(target.title + ' (' + target.category + ') is already listed in ' + target.unit +
      '. Enter the amount in ' + target.unit + ', or give it a different name if it\'s a different item.');
  }
  var now = new Date();
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'MMM d, yyyy');
  var revived = CELA.HIDDEN_STATUSES.indexOf(key_(target.status)) !== -1;
  var qtyRange = entryRange_(target, COLS.qty);
  var current = qtyRange ? qtyRange.getValue() : '';
  var curText = String(current).trim();
  var total;
  if (revived || curText === '') total = v.qty;                         // used-up row starts over
  else if (curText === '*' || v.qty === '*') total = '*';              // "a lot" stays "a lot"
  else if (/^\d+$/.test(curText)) total = Number(curText) + v.qty;
  else total = current;                                                 // free text like "2 boxes": leave it
  if (qtyRange) qtyRange.setValue(total);

  var set = function (cols, value) { var r = entryRange_(target, cols); if (r && value) r.setValue(value); };
  if (!target.unit && v.unit) set(COLS.unit, v.unit);
  if (!target.type && v.type) set(COLS.type, v.type);
  if (!target.itemCategory && v.category) set(COLS.category, v.category);
  if (!target.event && v.event) set(COLS.event, v.event);
  if (v.newStorage) addStorageOption_(v.storage);
  var notes = target.notes || '';
  if (!target.storage && v.storage) set(COLS.storage, v.storage);
  else if ((v.storage && key_(v.storage) !== key_(target.storage)) || (v.spot && key_(v.spot) !== key_(target.spot))) {
    var where = [v.storage, v.spot].filter(String).join(', ');
    if (notes.toLowerCase().indexOf(where.toLowerCase()) === -1) notes = (notes ? notes + ' · ' : '') + 'Also some at ' + where;
  }
  if (!target.spot && v.spot && !target.storage) set(COLS.spot, v.spot);
  if (v.notes && notes.toLowerCase().indexOf(v.notes.toLowerCase()) === -1) notes = (notes ? notes + ' · ' : '') + v.notes;
  if (notes !== (target.notes || '')) { var nr = entryRange_(target, COLS.notes); if (nr) nr.setValue(safe_(notes, 500)); }

  if (revived) setStatus_(target, CELA.ITEM_STATUS.IN);
  target.qty = String(total);
  target.status = revived ? CELA.ITEM_STATUS.IN : target.status;
  syncOutStatus_(target, outByRef_()[target.ref] || 0);
  annotateQty_(target, '[ADDED] +' + v.qtyText + ' (merged) by ' + member.name + ' (' + stamp + ')');
  logAdd_(member, id, v, target.ref, now);
  return { ok: true, merged: true, revived: revived, ref: target.ref, title: target.title, total: total,
    location: target.storage || target.spot, tab: target.kind === 'consumable' ? 'Consumables' : 'Inventory' };
}

// A new storage area typed in the Add form joins the Storage Area dropdown
// on both item tabs, so the next person can pick it.
function addStorageOption_(name) {
  ['Inventory', 'Consumables'].forEach(function (tab) {
    var sheet = sheet_(tab, false);
    if (!sheet) return;
    var t = tableFromSheet_(sheet, ['Item']);
    var col = colFor_(t, COLS.storage);
    if (col == null) return;
    var first = sheet.getRange(t.headerRow + 2, col + 1);
    var dv = first.getDataValidation();
    var values = dv ? dv.getCriteriaValues() : null;
    var list = values && Array.isArray(values[0]) ? values[0].map(String) : [];
    if (list.some(function (x) { return key_(x) === key_(name); })) return;
    list.push(name);
    var rule = SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(true).build();
    sheet.getRange(t.headerRow + 2, col + 1, Math.max(sheet.getMaxRows() - t.headerRow - 1, 1), 1).setDataValidation(rule);
  });
}

function logAdd_(member, id, v, ref, now) {
  var requests = ensureSheet_(CELA.REQUESTS);
  var requestId = 'ADD-' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 6);
  requests.getRange(requests.getLastRow() + 1, 1, 1, CELA.HEADERS.REQUESTS.length).setValues([[
    now, requestId, requestId + '-1', '', "'" + id, member.name,
    'ADDING', v.dept, v.notes, v.title, ref, v.qty,
    v.storage || v.spot, CELA.STATUS.ADDED, '', '', '', ''
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

// Project borrows are due one month after the project's Event End Date
// (end of that day), as long as that's still ahead. Departments, projects
// with no end date, or borrows made after that window: BORROW_DAYS
// (default 7) after borrowing.
function dueDate_(project, now) {
  var days = parseInt(prop_('BORROW_DAYS'), 10) || 7;
  var match = projectTable_().filter(function (pr) { return key_(pr.name) === key_(project); })[0];
  if (match && match.endDate instanceof Date) {
    var due = startOfDay_(match.endDate);
    var day = due.getDate();
    due.setMonth(due.getMonth() + 1);
    if (due.getDate() !== day) due.setDate(0);  // Jan 31 + 1 month -> Feb 28/29, not Mar 3
    due.setHours(23, 59, 59, 0);
    if (due >= now) return due;
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

// Member lookups go through a 10-minute cache of {id: [name, dept, email]}:
// the members tab (RecWeek form responses) is large and read on every request.
var memberIndexMemo_ = null;
function memberIndex_() {
  if (memberIndexMemo_) return memberIndexMemo_;
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) {}
  var hit = cache && cache.get('members_v1');
  if (hit) return (memberIndexMemo_ = JSON.parse(hit));
  var t = membersTable_();
  var index = {};
  t.rows.forEach(function (r) {
    var id = normalize_(cell_(t, r, COLS.id)).replace(/\s/g, '');
    if (!/^\d{6}$/.test(id)) return;
    var name = cell_(t, r, COLS.name) ||
      [cell_(t, r, COLS.first), cell_(t, r, COLS.last)].filter(String).join(' ');
    // Later rows (newer form submissions) win.
    index[id] = [name.replace(/\s+/g, ' ').trim(), deptCode_(cell_(t, r, COLS.department)), cell_(t, r, COLS.email)];
  });
  try { if (cache) cache.put('members_v1', JSON.stringify(index), 600); } catch (e) { /* >100KB: skip caching */ }
  return (memberIndexMemo_ = index);
}

function findMember_(id) {
  if (!id) return null;
  var m = memberIndex_()[id];
  return m ? { id: id, name: m[0], department: m[1], email: m[2] } : null;
}

// Run from the menu after editing the members tab so changes apply at once.
function refreshMemberCache() {
  try { CacheService.getScriptCache().remove('members_v1'); } catch (e) {}
  memberIndexMemo_ = null;
  notify_('Member list refreshed: ' + Object.keys(memberIndex_()).length + ' IDs.');
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
  try { assignItemIds_(); ensureBorrowedFormulas_(sheet_('Inventory')); } catch (e) { /* repairs are best-effort */ }
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
  ensureItemColumns_();
  if (Session.getScriptTimeZone() !== 'Asia/Manila') {
    notify_('Heads up: this script\'s time zone is ' + Session.getScriptTimeZone() + '. Set it to (GMT+08:00) Manila in Project Settings so due dates land on the right day.');
  }
  notify_('App tabs are ready (' + tabs.concat(CELA.BORROWED).join(', ') + '). ' +
    'Item tabs now have an Item ID column, and Inventory has Currently Borrowed after Qty. Next: add officers (ACCESS).');
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

// Comparison key: case/spacing/punctuation-insensitive, but keeps letters in
// any script (e.g. Chinese item names).
function key_(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

var MAX_QTY = 9999;

// Text typed by members, made safe to write into a cell: trimmed, length-capped
// and never read by Sheets as a formula (=, +, -, @).
function safe_(v, max) {
  var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 200);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
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
  if (configured && String(p.token || '') !== String(configured)) {
    throw new Error('This app needs the access code. Ask an officer, then enter it under "Connection settings".');
  }
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
