/* ==================================================================
     Celadon Inventory (CelaCart) — client logic
     Adapted from MEA's app (github.com/David-GY/mea-id)
     ================================================================== */

  // GitHub Pages does not provide Apps Script's google.script.run object. This
  // small local adapter keeps the app usable there while preserving the same
  // call shape for Apps Script deployments. getInventory specifically now
  // fetches LIVE data from the Apps Script backend (action=inventory) when a
  // Script URL is configured (the same script also handles login) — falling back to demo data only when
  // no URL is set yet or the request fails, so the app never breaks.
  if (!window.google || !window.google.script || !window.google.script.run) {
    // Sample items, shown only before the app is connected. Marked demo so they can't be ordered.
    const demoInventory = [
      { id: 'ITM-100', title: 'CLDN Letters', category: 'General', location: 'Outside Org Room', qtyAvailable: 1, qtyDisplay: '1 pcs' },
      { id: 'ITM-101', title: 'Scissors', category: 'COMMPUB', location: 'Metal Drawer (Top)', qtyAvailable: 1, qtyDisplay: '1 pcs' },
      { id: 'ITM-102', title: 'Tripods', category: 'COMMPUB', location: 'Metal Drawer (2nd from Top)', qtyAvailable: 5, qtyDisplay: '5 pcs' },
      { id: 'ITM-103', title: 'Binder Clips', category: 'COMMPUB', location: 'Metal Drawer (Top)', qtyAvailable: null, qtyDisplay: 'Lots' },
      { id: 'ITM-104', title: 'Metal Bowls', category: 'CUL', location: 'CUL MAF Box', qtyAvailable: 15, qtyDisplay: '15 pcs' },
      { id: 'ITM-105', title: 'Mahjong', category: 'HR', location: 'Rack (Bottom Shelf)', qtyAvailable: 3, qtyDisplay: '3 sets' },
      { id: 'ITM-106', title: 'Koi Lanyard', category: 'Merch', location: 'SY 25-26', qtyAvailable: 52, qtyDisplay: '52 pcs' }
    ];

    function getCelaInventoryScriptUrl() {
      try {
        return (localStorage.getItem('cela_inventory_url') || '').trim();
      } catch(e) { return ''; }
    }

    const INVENTORY_CACHE_KEY = 'cela_inventory_cache';

    function getCachedInventory() {
      try {
        const raw = localStorage.getItem(INVENTORY_CACHE_KEY);
        if (!raw) return null;
        return JSON.parse(raw); // { items, syncedAt }
      } catch(e) { return null; }
    }

    function setCachedInventory(items) {
      try {
        localStorage.setItem(INVENTORY_CACHE_KEY, JSON.stringify({ items, syncedAt: Date.now() }));
      } catch(e) {}
    }

    function offlineOrCachedFallback(reason) {
      const cache = getCachedInventory();
      if (cache && cache.items && cache.items.length) {
        const ago = Math.round((Date.now() - cache.syncedAt) / 60000);
        showInventoryDebug(reason + '\n\nShowing your last synced copy from ' + ago + ' minute(s) ago.');
        return cache.items;
      }
      showInventoryDebug(reason + '\n\nNo previously synced copy on this device yet — showing demo items.');
      return demoInventory.map(d => Object.assign({ demo: true }, d));
    }

    async function fetchLiveInventory() {
      window.__celaInventoryDebugError = null;
      const url = getCelaInventoryScriptUrl();
      if (!url) {
        showInventoryDebug('No Inventory Script URL configured yet.\n\nGo to Home > Settings > paste your Inventory Apps Script URL into the "Inventory Script URL" field > Save.');
        return demoInventory.map(d => Object.assign({ demo: true }, d)); // not configured yet
      }

      if (!navigator.onLine) {
        return offlineOrCachedFallback("You're offline.");
      }

      let res, text;
      try {
        res = await fetch(url + '?action=inventory');
        text = await res.text();
      } catch(networkErr) {
        console.error('[Cela Inventory] Network error reaching script:', networkErr);
        return offlineOrCachedFallback('Network error — could not reach the Inventory script.');
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch(parseErr) {
        console.error('[Cela Inventory] Response was not valid JSON:', text);
        return offlineOrCachedFallback('The inventory script sent back an error page.');
      }

      if (json && json.ok && Array.isArray(json.items)) {
        console.log('[Cela Inventory] Loaded', json.items.length, 'items from the sheet.');
        window.__celaInventoryDebugError = null;
        const mapped = json.items.map((item, i) => {
          const rawQty = String(item.qty == null ? '' : item.qty).trim();
          const numericQty = parseInt(rawQty, 10);
          const unit = String(item.unit || '').trim();
          return {
            // ref identifies the sheet row (tab + item + department + spot) so
            // same-name items in different departments stay separate.
            id: item.ref || ('INV-' + i),
            title: item.title || 'Untitled',
            category: item.category || 'General',   // department that owns it
            type: item.type || '',
            kind: item.kind || '',                  // sheet Category: Equipment / Supplies / …
            source: item.source || 'inventory',     // inventory | consumable | merch
            spot: item.spot || '',
            sheetNotes: item.sheetNotes || '',
            unit,
            qtyRaw: rawQty,
            event: item.event || '',
            status: item.status || '',
            expiry: item.expiry || '',
            location: item.location || '',
            notes: item.notes || '',
            // "*" in the sheet means plenty, no exact count
            qtyDisplay: rawQty === '*' ? 'Lots' : (rawQty ? rawQty + (unit && !isNaN(numericQty) ? ' ' + unit : '') : '—'),
            out: Number(item.out) || 0, // currently borrowed (pending in REQUESTS)
            qtyAvailable: !isNaN(numericQty) ? numericQty : null // null = uncapped (e.g. "*", "2 packs")
          };
        });
        setCachedInventory(mapped); // remember this for the next time we're offline
        return mapped;
      }

      // Script responded with valid JSON but ok:false or unexpected shape
      const errMsg = (json && json.error) ? json.error : 'Unexpected response shape (missing ok/items).';
      console.error('[Cela Inventory] Script returned an error:', errMsg, json);
      return offlineOrCachedFallback(errMsg);
    }

    function showInventoryDebug(message) {
      window.__celaInventoryDebugError = message;
    }

    const PENDING_ORDERS_KEY = 'cela_pending_orders';
    const FAILED_ORDERS_KEY = 'cela_failed_orders';
    const MAX_ORDER_ATTEMPTS = 5;

    function getPendingOrders() {
      try { return JSON.parse(localStorage.getItem(PENDING_ORDERS_KEY) || '[]'); }
      catch(e) { return []; }
    }

    // Returns false if the phone's storage is full, so callers never claim
    // "saved offline" for an order that wasn't actually saved.
    function savePendingOrders(list) {
      let ok = true;
      try { localStorage.setItem(PENDING_ORDERS_KEY, JSON.stringify(list)); } catch(e) { ok = false; }
      updateOrderSyncPill();
      return ok;
    }

    function getFailedOrders() {
      try { return JSON.parse(localStorage.getItem(FAILED_ORDERS_KEY) || '[]'); }
      catch(e) { return []; }
    }

    function saveFailedOrders(list) {
      try { localStorage.setItem(FAILED_ORDERS_KEY, JSON.stringify(list)); } catch(e) {}
    }

    function enqueuePendingOrder(payload, clientId) {
      const list = getPendingOrders();
      // Reuse the caller's clientId when given (e.g. a failed immediate
      // attempt that may have actually landed server-side) so a later
      // retry carries the same idempotency key instead of a fresh one.
      clientId = clientId || (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2)));
      list.push({ payload, queuedAt: Date.now(), attempts: 0, clientId });
      if (!savePendingOrders(list)) {
        throw new Error("Couldn't save this request on your phone (storage is full). Connect to the internet and try again.");
      }
    }

    function updateOrderSyncPill() {
      const pill = document.getElementById('orderSyncPill');
      if (!pill) return;
      const count = getPendingOrders().length;
      const failedCount = getFailedOrders().length;
      if (count === 0 && failedCount === 0) {
        pill.classList.remove('show');
        return;
      }
      pill.classList.add('show');
      pill.className = 'order-sync-pill show ' + (navigator.onLine ? 'syncing' : 'offline');
      const parts = [];
      if (count) parts.push(count + (count === 1 ? ' order' : ' orders') + ' pending');
      if (failedCount) parts.push(failedCount + ' failed — tap to retry');
      pill.querySelector('.order-sync-text').textContent =
        parts.join(', ') + (count && navigator.onLine ? ' — tap to sync' : (count ? ' — waiting for connection' : ''));
    }

    // The actual network call — throws on any failure, used by both the
    // immediate submit path and the retry queue. clientId is an idempotency
    // key: if a retry follows a request that actually succeeded server-side
    // but the response never reached us, a hardened backend can recognize
    // it and skip inserting the order twice.
    async function trySubmitOrderToSheet(payload, clientId) {
      const url = getCelaInventoryScriptUrl();
      if (!url) throw new Error('No Inventory Script URL configured yet — go to Home > Settings.');

      const token = getInventoryToken();
      const body = Object.assign({ clientId: clientId || null }, payload, token ? { token } : {});

      let res, text;
      try {
        // text/plain avoids a CORS preflight against Apps Script, which
        // doesn't support OPTIONS requests.
        res = await fetch(url + '?action=submitOrder', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body)
        });
        text = await res.text();
      } catch (networkErr) {
        throw new Error('Network error — could not reach the Inventory script.');
      }

      let json;
      try { json = JSON.parse(text); }
      catch (parseErr) { throw new Error('Script returned an unexpected response.'); }

      if (!json || !json.ok) {
        const serverErr = new Error((json && json.error) ? json.error : 'Script reported an error.');
        serverErr.fromServer = true; // a real rejection (e.g. not allowed for that project), not a network blip
        throw serverErr;
      }
      return json;
    }

    let isFlushingOrders = false;
    async function flushPendingOrders() {
      if (isFlushingOrders || !navigator.onLine) return;
      const pending = getPendingOrders();
      if (!pending.length) return;

      isFlushingOrders = true;
      updateOrderSyncPill();

      while (true) {
        const current = getPendingOrders();
        if (!current.length) break;
        const item = current[0];
        try {
          await trySubmitOrderToSheet(item.payload, item.clientId);
          // Remove by clientId (another tab may have changed the queue meanwhile).
          savePendingOrders(getPendingOrders().filter(x => x.clientId !== item.clientId));
        } catch(err) {
          // Network trouble just waits for the next try. A real rejection from
          // the script (removed member, closed project…) counts as an attempt;
          // after MAX_ORDER_ATTEMPTS it moves to "failed" with the reason, so it
          // doesn't block everything queued behind it.
          if (!err.fromServer) break;
          const remaining = getPendingOrders();
          const idx = remaining.findIndex(x => x.clientId === item.clientId);
          if (idx === -1) continue;
          remaining[idx].attempts = (remaining[idx].attempts || 0) + 1;
          remaining[idx].lastError = err.message;
          if (remaining[idx].attempts >= MAX_ORDER_ATTEMPTS) {
            const failedItem = remaining.splice(idx, 1)[0];
            const failedQ = getFailedOrders();
            failedQ.push(failedItem);
            saveFailedOrders(failedQ);
            savePendingOrders(remaining);
            showToast('A saved request could not be sent: ' + err.message, true);
            continue;
          }
          savePendingOrders(remaining);
          break;
        }
      }

      isFlushingOrders = false;
      updateOrderSyncPill();
    }

    function retryFailedOrders() {
      const failed = getFailedOrders();
      if (!failed.length) return;
      const q = getPendingOrders();
      failed.forEach(item => { item.attempts = 0; q.push(item); });
      savePendingOrders(q);
      saveFailedOrders([]);
      flushPendingOrders();
    }

    function orderSyncPillClick() {
      if (getFailedOrders().length) { retryFailedOrders(); return; }
      flushPendingOrders();
    }

    window.flushPendingOrders = orderSyncPillClick; // exposed for the sync pill's tap handler
    window.updateOrderSyncPill = updateOrderSyncPill; // exposed so boot can show any queue left over from last session
    window.addEventListener('online', () => { flushPendingOrders(); });
    setInterval(() => { if (navigator.onLine) flushPendingOrders(); }, 20000);

    // Fallback only — the live list comes from the sheet's PROJECTS tab
    // (action=projects) so officers can add a project without a code change.
    const PROJECT_OPTIONS = [
      // Departments
      'OP', 'COMMPUB', 'CUL', 'EXREL', 'FIN', 'HR', 'OSR',
      // Projects (same names as the Inventory tab's Event column)
      'Recruitment Week and Welcome Week', 'Celadon Merchandise', 'General Assembly',
      'Mid-Autumn Festival', 'Lunar Lotus Market', 'TALAB x Faculty Appreciation Week',
      'Jade Business Summit', 'Leadership Development Program', 'Celadon Rose Sale',
      'Chinese New Year', 'Spring Film Festival', 'Binondo Amazing Race',
      'Mandopop Music Festival', 'Celadon Ball'
    ];

    // The PROJECTS tab's list, remembered so offline requests use the same
    // names the script will accept later.
    function savedProjects() {
      try { const p = JSON.parse(localStorage.getItem('cela_projects') || 'null'); return Array.isArray(p) && p.length ? p : null; } catch(e) { return null; }
    }
    async function fetchLiveProjects() {
      const url = getCelaInventoryScriptUrl();
      if (!url || !navigator.onLine) return savedProjects() || PROJECT_OPTIONS.slice();
      try {
        const res = await fetch(url + '?action=projects');
        const json = await res.json();
        if (json && json.ok && Array.isArray(json.projects) && json.projects.length) {
          try { localStorage.setItem('cela_projects', JSON.stringify(json.projects)); } catch(e) {}
          return json.projects;
        }
      } catch(e) {}
      return savedProjects() || PROJECT_OPTIONS.slice();
    }

    const localMethods = {
      getInventory: () => fetchLiveInventory(),
      getProjectOptions: () => fetchLiveProjects(),
      lookupIdNumber: (idNumber) => ({
        found: /^\d{6}$/.test(String(idNumber).trim()),
        idNumber: String(idNumber).trim(), name: '', level: 'NONE',
        status: /^\d{6}$/.test(String(idNumber).trim()) ? 'ACTIVE' : 'UNKNOWN'
      }),
      submitOrder: async (payload) => {
        if (payload.items.some(i => /^ITM-/.test(i.ref || ''))) {
          throw new Error("Those are sample items. The app isn't connected to the inventory sheet yet.");
        }
        // Small local log of recent requests (last 50) for troubleshooting.
        try {
          const orders = JSON.parse(localStorage.getItem('cela_inventory_orders') || '[]');
          orders.unshift({ ...payload, createdAt: new Date().toISOString() });
          localStorage.setItem('cela_inventory_orders', JSON.stringify(orders.slice(0, 50)));
        } catch(e) {}

        const clientId = crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2));

        // No URL configured yet — nothing to sync to, but don't lose the order.
        if (!getCelaInventoryScriptUrl()) {
          enqueuePendingOrder(payload);
          return { success: true, queued: true, reason: 'not-configured' };
        }

        // Offline — skip straight to the queue, no point trying the network.
        if (!navigator.onLine) {
          enqueuePendingOrder(payload);
          return { success: true, queued: true, reason: 'offline' };
        }

        // Online — try immediately. If it fails for any reason (network
        // blip, server error), queue it instead of losing it; the queue
        // will retry automatically.
        try {
          const json = await trySubmitOrderToSheet(payload, clientId);
          return { success: true, queued: false, logged: json.logged, due: json.due, warnings: json.warnings || [] };
        } catch(err) {
          if (err.fromServer) throw err; // show the reason instead of retrying something that will keep failing
          enqueuePendingOrder(payload, clientId);
          return { success: true, queued: true, reason: 'error', message: err.message };
        }
      }
    };
    const runner = (success, failure) => new Proxy({}, { get: (_, name) => {
      if (name === 'withSuccessHandler') return fn => runner(fn, failure);
      if (name === 'withFailureHandler') return fn => runner(success, fn);
      return (...args) => Promise.resolve().then(() => localMethods[name](...args)).then(success).catch(failure);
    }});
    window.google = { script: { run: runner() } };
  }

  const state = {
    view: 'login',           // login | home | settings | help | history | catalog | cart | checkout
    catalogFormat: 'grid',   // grid | list
    catalogSearch: '',
    catalogSort: 'default',  // default | name | category | location
    catalogCategory: 'all',  // 'all' or a category key (see CATEGORY_DEFS)
    catalogDept: 'all',      // 'all' or a department code
    inventory: [],
    cart: {},                // { itemId: { item, qty, action } }
    scanLog: [],             // { idNumber, status, time }
    lastId: null,            // logged-in ID lookup result: { idNumber, name, role, committee, status }
    projectOptions: [],
    historyTab: 'personal',  // personal | project
    actingAs: '',            // project/department every request is logged under
    outFilter: 'mine'        // Borrowed-now view: mine (my projects/depts) | all
  };

  /* =========================================================
     LOGIN PERSISTENCE
     The logged-in ID stays on the device across reloads/relaunches
     until the person taps "Log out" in Settings.
     ========================================================= */
  const LOGIN_KEY = 'cela_login_v1';

  function getSavedLogin() {
    try {
      const raw = localStorage.getItem(LOGIN_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch(e) { return null; }
  }
  function saveLogin(result) {
    try { localStorage.setItem(LOGIN_KEY, JSON.stringify(result)); } catch(e) {}
  }
  function clearLogin() {
    try { localStorage.removeItem(LOGIN_KEY); } catch(e) {}
  }

  /**
   * Logs an ID number in against the Celadon Inventory Apps Script.
   *   GET <inventoryUrl>?action=login&id=<6-digit id>
   * Response: { ok:true, found:true/false, idNumber, name, department, level }
   * found:false means the ID isn't in the MEMBERS tab.
   * level is "NONE" when the ID isn't in ACCESS.
   */
  async function fetchIdLookup(idNumber) {
    const url = getInventoryScriptUrl();
    if (!url) {
      return { found: false, idNumber: String(idNumber).trim(), name: '', level: 'NONE', status: 'NOT_CONFIGURED' };
    }
    let res, text;
    try {
      const loginParams = new URLSearchParams({ action: 'login', id: idNumber });
      const token = getInventoryToken();
      if (token) loginParams.set('token', token);
      res = await fetch(url + '?' + loginParams.toString());
      text = await res.text();
    } catch (networkErr) {
      console.error('[Cela Login] Network error during lookup:', networkErr);
      return { found: false, idNumber: String(idNumber).trim(), name: '', level: 'NONE', status: 'NETWORK_ERROR' };
    }

    let json;
    try { json = JSON.parse(text); }
    catch (parseErr) {
      console.error('[Cela Login] Lookup response was not valid JSON:', text);
      return { found: false, idNumber: String(idNumber).trim(), name: '', level: 'NONE', status: 'ERROR' };
    }

    if (!json || json.ok === false) {
      console.error('[Cela Login] Script reported an error:', json && json.error, json);
      return { found: false, idNumber: String(idNumber).trim(), name: '', level: 'NONE', status: 'ERROR', message: json && json.error };
    }

    if (json.found) {
      return {
        found: true,
        idNumber: json.idNumber || String(idNumber).trim(),
        name: json.name || '',
        committee: json.department || '',
        level: (json.level || 'NONE').toUpperCase(),
        actFor: Array.isArray(json.actFor) ? json.actFor : [],
        status: 'ACTIVE'
      };
    }
    return { found: false, idNumber: String(idNumber).trim(), name: '', level: 'NONE', status: 'NOT_FOUND' };
  }

  function renderIdentity() {
    const r = state.lastId;
    const idText = r ? r.idNumber : '—';
    const nameText = (r && r.name) ? r.name : (r ? 'Unknown Member' : '—');
    ['home', 'settings', 'help', 'history'].forEach(v => {
      const idEl = document.getElementById(v + '-identity-id');
      const nameEl = document.getElementById(v + '-identity-name');
      if (idEl) idEl.textContent = idText;
      if (nameEl) nameEl.textContent = nameText;
    });
  }

  /* ---------------- Accessibility: keyboard support for role="button" divs ----------------
     A handful of controls (home cards, bottom nav) are non-<button> elements
     for layout reasons; this makes them behave like real buttons for anyone
     navigating by keyboard or screen reader, without touching their click
     handlers, which stay bound the normal way. */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('[role="button"]');
    if (!el) return;
    e.preventDefault();
    el.click();
  });

  /* ---------------- Init ---------------- */

  document.addEventListener('DOMContentLoaded', () => {
    seedDefaultScriptUrls();

    bindNav();
    bindSidebarLogout();
    bindLogin();
    bindHome();
    bindSettings();
    bindHeaderActions();
    bindCatalogToggle();
    bindCheckoutForm();
    bindForSheet();
    bindAppearance();
    bindModal();
    bindInstallBanner();
    renderContacts();

    restoreCart();
    loadProjectOptions();
    updateCartBadge();

    const saved = getSavedLogin();
    if (saved && saved.idNumber) {
      state.lastId = saved;
      state.actingAs = getSavedActingAs();
      renderIdentity();
      renderActForSelects();
      showView('home');
      refreshLoginInBackground();
      loadInventory(); // warm the item list in the background
    } else {
      showView('login');
    }

    if (window.updateOrderSyncPill) window.updateOrderSyncPill();
    if (navigator.onLine && window.flushPendingOrders) window.flushPendingOrders();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    }
    // Hide the splash after the first screen is drawn (with a timer as a
    // fallback for browsers that delay animation frames).
    const hideSplash = () => {
      const splash = document.getElementById('splash');
      if (!splash || splash.classList.contains('hide')) return;
      splash.classList.add('hide');
      setTimeout(() => splash.remove(), 450);
    };
    requestAnimationFrame(hideSplash);
    setTimeout(hideSplash, 250);
  });

  /* ---------------- Navigation ---------------- */

  function bindNav() {
    document.querySelectorAll('#bottom-nav .nav-btn').forEach(btn => {
      btn.addEventListener('click', () => showView(btn.dataset.view));
    });
    document.querySelectorAll('#history-tabs [data-tab]').forEach(btn => {
      btn.addEventListener('click', () => setHistoryTab(btn.dataset.tab));
    });
  }

  // The pinned "Log out" at the bottom of the desktop sidebar.
  function bindSidebarLogout() {
    document.querySelectorAll('.sidebar-logout-link').forEach(link => {
      link.addEventListener('click', performLogout);
    });
  }

  // Views with their own brand block (no shared app header). Items, Cart and
  // Checkout use the shared header with the cart/contact buttons.
  const MAIN_VIEWS = ['home', 'settings', 'help', 'history', 'out', 'add', 'done'];
  // Which bottom-nav tab lights up for views that aren't tabs themselves.
  const NAV_FOR_VIEW = { checkout: 'cart', done: 'home', history: 'settings', help: 'settings', add: 'catalog' };

  function showView(view) {
    if (view !== 'login' && !state.lastId) view = 'login';
    state.view = view;
    closeItemSheet();
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + view).classList.add('active');

    const navKey = NAV_FOR_VIEW[view] || view;
    document.querySelectorAll('#bottom-nav .nav-btn').forEach(b => {
      const on = b.dataset.view === navKey;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });

    const isMain = MAIN_VIEWS.includes(view);
    const isLogin = view === 'login';
    document.body.classList.toggle('has-desktop-sidebar', !isLogin);
    document.getElementById('app-header').style.display = (isMain || isLogin) ? 'none' : 'flex';
    document.getElementById('bottom-nav').style.display = isLogin ? 'none' : 'flex';
    document.getElementById('cart-icon-btn').style.display = view === 'catalog' ? 'flex' : 'none';
    document.getElementById('contact-icon-btn').style.display = view === 'catalog' ? 'flex' : 'none';
    window.scrollTo(0, 0);

    if (view === 'settings') {
      document.getElementById('settings-inventory-url').value = getInventoryScriptUrl();
      const tokenInput = document.getElementById('settings-inventory-token');
      if (tokenInput) tokenInput.value = getInventoryToken();
    }
    if (view === 'history') setHistoryTab(state.historyTab || 'personal');
    if (view === 'out') renderOut();
    if (view === 'add') renderAddForm();
    if (view === 'home') refreshHomeData();
    if (view === 'cart') renderCart();
    if (view === 'checkout') renderCheckout();
    if (view === 'catalog') loadInventory();
    if (view === 'login') warmUpBackend();
  }

  function setHistoryTab(tab) {
    state.historyTab = tab;
    document.querySelectorAll('#history-tabs [data-tab]').forEach(b => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const projectSelect = document.getElementById('history-project-select');
    if (projectSelect) {
      projectSelect.style.display = tab === 'project' ? '' : 'none';
      if (tab === 'project' && !projectSelect.value && state.actingAs) projectSelect.value = state.actingAs;
    }
    renderHistory();
  }

  // Apps Script "cold starts" can take a few seconds. Poke it while the
  // person is still typing their ID so login and the first load feel instant.
  let warmedUp = false;
  function warmUpBackend() {
    const url = getInventoryScriptUrl();
    if (warmedUp || !url || !navigator.onLine) return;
    warmedUp = true;
    fetch(url + '?action=projects').catch(() => {});
  }

  // ── History data: fetched from the Inventory Apps Script (action=history),
  // cached locally so History still shows the last-known data offline,
  // exactly like the Catalog's inventory cache.
  const HISTORY_CACHE_KEY = 'cela_history_cache';

  function getCachedHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_CACHE_KEY);
      return raw ? JSON.parse(raw) : null; // { records, syncedAt }
    } catch(e) { return null; }
  }

  function setCachedHistory(records) {
    try {
      localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify({ records, syncedAt: Date.now() }));
    } catch(e) {}
  }

  async function fetchHistoryRecords() {
    const url = getInventoryScriptUrl();
    if (!url) return { records: [], offline: false, error: 'No Inventory Script URL configured yet.' };

    if (!navigator.onLine) {
      const cache = getCachedHistory();
      return { records: cache ? cache.records : [], offline: true, syncedAt: cache ? cache.syncedAt : null };
    }

    try {
      const params = new URLSearchParams({ action: 'history' });
      const token = getInventoryToken();
      if (token) params.set('token', token);
      const res = await fetch(url + '?' + params.toString());
      const json = await res.json();
      if (json && json.ok && Array.isArray(json.records)) {
        setCachedHistory(json.records);
        return { records: json.records, offline: false };
      }
      throw new Error((json && json.error) || 'Unexpected response');
    } catch(err) {
      const cache = getCachedHistory();
      return {
        records: cache ? cache.records : [],
        offline: true,
        syncedAt: cache ? cache.syncedAt : null,
        error: err.message
      };
    }
  }

  function shortDate(iso) {
    return iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  }

  // showName: include who borrowed it (project/Borrowed-now lists).
  function historyRowHtml(rec, showName) {
    const when = shortDate(rec.time);
    const pendingBorrow = rec.caseType === 'BORROWING' && !rec.resolved;
    const caseLabel = rec.caseType === 'CONSUMING' ? 'Used up'
      : rec.caseType === 'ADDING' ? 'Added'
      : rec.caseType === 'RESTOCKING' ? 'Stock added'
      : (rec.resolved ? 'Returned' : (rec.overdue ? 'Overdue' : 'Borrowed'));
    const caseClass = rec.resolved ? 'resolved' : (rec.overdue ? 'overdue' : 'pending');
    const dueNote = pendingBorrow && rec.due ? `<div class="history-item-date${rec.overdue ? ' overdue' : ''}">Due ${shortDate(rec.due)}</div>` : `<div class="history-item-date">${when}</div>`;
    const resolveBtn = pendingBorrow && canResolve(rec)
      ? `<button type="button" class="resolve-btn" data-resolve="${escapeHtml(rec.lineId)}">Mark returned</button>`
      : '';
    return `
      <div class="history-item${rec.overdue ? ' is-overdue' : ''}">
        <div class="history-item-main">
          <div class="history-item-title">${escapeHtml(rec.item)}${rec.qty ? ' × ' + escapeHtml(rec.qty) : ''}</div>
          <div class="history-item-meta">${escapeHtml(rec.project || '—')}${(showName || state.historyTab === 'project') && rec.name ? ' · ' + escapeHtml(rec.name) : ''}${rec.committee ? ' · ' + escapeHtml(rec.committee) : ''}</div>
          ${resolveBtn}
        </div>
        <div class="history-item-side">
          <div class="history-item-case ${caseClass}">${caseLabel}</div>
          ${dueNote}
        </div>
      </div>`;
  }

  /* ---------------- Borrowing for a project / department ----------------
     Every borrow or use-up is logged under a project or department, never
     personally. Any member can pick any active one (login returns '*'); the
     picker starts on their own department. */
  const ACTING_AS_KEY = 'cela_acting_as';

  function getSavedActingAs() {
    try { return localStorage.getItem(ACTING_AS_KEY) || ''; } catch(e) { return ''; }
  }

  function setActingAs(value) {
    const changed = value !== state.actingAs;
    state.actingAs = value || '';
    try { localStorage.setItem(ACTING_AS_KEY, state.actingAs); } catch(e) {}
    renderActForSelects();
    if (changed) { dashState.selected.clear(); dashState.confirming = false; dashState.openGroups = null; renderProjectDash(); }
  }

  function sameName(a, b) {
    return String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '') === String(b || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function allowedTargets() {
    const actFor = (state.lastId && Array.isArray(state.lastId.actFor)) ? state.lastId.actFor : [];
    if (actFor.includes('*')) return state.projectOptions.slice();
    return actFor.slice();
  }

  // Anyone can mark a borrow returned (whoever brings it back); the sheet
  // records who did.
  function canResolve(rec) {
    return !!(rec.lineId && state.lastId);
  }

  /* ---------------- Appearance: system / light / dark ---------------- */
  const APPEARANCE_KEY = 'cela_appearance';
  const darkQuery = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;

  function getAppearance() {
    try { return localStorage.getItem(APPEARANCE_KEY) || 'system'; } catch(e) { return 'system'; }
  }

  function applyAppearance(pref) {
    const root = document.documentElement;
    const dark = pref === 'dark' || (pref === 'system' && darkQuery && darkQuery.matches);
    if (pref === 'system') root.removeAttribute('data-appearance'); else root.setAttribute('data-appearance', pref);
    root.toggleAttribute('data-theme-dark', !!dark);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0b1220' : '#ffffff');
    document.querySelectorAll('#appearance-tabs [data-appearance]').forEach(b => {
      const on = b.dataset.appearance === pref;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function bindAppearance() {
    applyAppearance(getAppearance());
    document.querySelectorAll('#appearance-tabs [data-appearance]').forEach(b => b.addEventListener('click', () => {
      try { localStorage.setItem(APPEARANCE_KEY, b.dataset.appearance); } catch(e) {}
      applyAppearance(b.dataset.appearance);
    }));
    // Follow the phone switching between light and dark while the app is open.
    if (darkQuery) {
      const onChange = () => { if (getAppearance() === 'system') applyAppearance('system'); };
      if (darkQuery.addEventListener) darkQuery.addEventListener('change', onChange); else darkQuery.addListener(onChange);
    }
  }

  /* ---------------- "What is this for?" picker ----------------
     Departments shown with their A-yi, projects with their cover photo from
     ateneoceladon.com. The two hidden <select>s stay as the form values. */
  const DEPT_INFO = {
    OP: 'Office of the President',
    COMMPUB: 'Communications and Publications',
    CUL: 'Cultural Affairs',
    EXREL: 'External Relations',
    FIN: 'Financial Affairs',
    HR: 'Human Resources',
    OSR: 'Organization Strategies and Research',
    General: 'Whole org'
  };
  const PROJECT_BRAND = {
    'Recruitment Week and Welcome Week': { short: 'RecWeek', cover: 'recruitment-week-and-welcome-week' },
    'Celadon Merchandise': { short: 'Celamerch', emoji: '👕' },
    'General Assembly': { short: 'GA', cover: 'general-assembly' },
    'Mid-Autumn Festival': { short: 'MAF', cover: 'mid-autumn-festival' },
    'Lunar Lotus Market': { cover: 'lunar-lotus-market' },
    'TALAB x Faculty Appreciation Week': { short: 'TALAB x FAW', emoji: '🍎' },
    'Jade Business Summit': { emoji: '💼' },
    'Leadership Development Program': { short: 'LDP', cover: 'leadership-development-program' },
    'Celadon Rose Sale': { emoji: '🌹' },
    'Chinese New Year': { short: 'CNY', cover: 'chinese-new-year' },
    'Spring Film Festival': { cover: 'spring-film-festival' },
    'Binondo Amazing Race': { cover: 'binondo-amazing-race' },
    'Mandopop Music Festival': { cover: 'mandopop-music-festival' },
    'Celadon Ball': { cover: 'celadon-ball' }
  };

  // Theme colour per department/project: [accent, deep, tint]. Picked from the
  // website's palette (navy, blues, crimson, jade, gold, brown) and each
  // event's character; every accent keeps white text readable (≥4.5:1).
  const THEMES = {
    "OP": ["#003078", "#001c45", "#e0e6ef"],
    "COMMPUB": ["#3F5F99", "#304975", "#e8ecf3"],
    "CUL": ["#970708", "#660505", "#f3e1e1"],
    "EXREL": ["#477d6a", "#355c4e", "#ebf3f0"],
    "FIN": ["#906a07", "#5f4605", "#f6f0e2"],
    "HR": ["#2a7d9d", "#1f5d75", "#e5eff3"],
    "OSR": ["#783F1A", "#4e2911", "#efe8e4"],
    "Recruitment Week and Welcome Week": ["#aa5d19", "#7e4512", "#fbefe4"],
    "Celadon Merchandise": ["#0f766e", "#094944", "#e2efee"],
    "General Assembly": ["#1b3a6b", "#112442", "#e4e7ed"],
    "Mid-Autumn Festival": ["#917020", "#675017", "#f9f3e6"],
    "Lunar Lotus Market": ["#d0353e", "#aa282f", "#f9e7e8"],
    "TALAB x Faculty Appreciation Week": ["#5f7e1f", "#405515", "#edf1e5"],
    "Jade Business Summit": ["#398163", "#295e48", "#e8f2ed"],
    "Leadership Development Program": ["#3F5F99", "#304975", "#e8ecf3"],
    "Celadon Rose Sale": ["#c2185b", "#951246", "#f8e3eb"],
    "Chinese New Year": ["#b71c1c", "#8b1515", "#f6e4e4"],
    "Spring Film Festival": ["#c84067", "#a53051", "#f9ecf0"],
    "Binondo Amazing Race": ["#a0522d", "#783e22", "#f4eae6"],
    "Mandopop Music Festival": ["#5b2a86", "#411e5f", "#ebe5f0"],
    "Celadon Ball": ["#1a1f3f", "#0b0d1b", "#e4e4e8"]
  };
  const DEFAULT_THEME = ['#003078', '#001c45', '#eef2f8'];

  function themeFor(name) {
    const key = Object.keys(THEMES).find(k => sameName(k, name));
    return key ? THEMES[key] : DEFAULT_THEME;
  }

  // Recolours the app for the department/project you're working for.
  function applyTheme(name) {
    const [accent, deep, tint] = themeFor(name);
    const root = document.documentElement.style;
    root.setProperty('--theme', accent);
    root.setProperty('--theme-deep', deep);
    root.setProperty('--theme-tint-light', tint); // dark mode derives its own tint
  }

  function brandFor(name) {
    const dept = Object.keys(DEPT_INFO).find(d => sameName(d, name));
    if (dept) return { kind: 'dept', name, title: dept, sub: DEPT_INFO[dept], img: ayiFor(dept), theme: themeFor(dept) };
    const key = Object.keys(PROJECT_BRAND).find(p => sameName(p, name));
    const b = key ? PROJECT_BRAND[key] : {};
    return { kind: 'project', name, title: name, sub: b.short || 'Project', cover: b.cover ? 'brand/covers/' + b.cover + '.jpg' : '', emoji: b.emoji || '✨', theme: themeFor(name) };
  }

  function pickerButtonHtml(name) {
    if (!name) {
      return `<span class="fp-visual fp-empty" aria-hidden="true">?</span>
        <span class="fp-text"><span class="fp-eyebrow">Not chosen yet</span><span class="fp-name">Choose a department or project</span></span>
        <span class="fp-change">Choose</span>`;
    }
    const b = brandFor(name);
    const visual = b.kind === 'dept'
      ? `<span class="fp-visual fp-ayi"><img src="${b.img}" alt="" decoding="async"></span>`
      : (b.cover ? `<span class="fp-visual fp-cover"><img src="${b.cover}" alt="" decoding="async"></span>` : `<span class="fp-visual fp-emoji" style="background:linear-gradient(135deg, ${b.theme[0]}, ${b.theme[1]})">${b.emoji}</span>`);
    return `${visual}
      <span class="fp-text"><span class="fp-eyebrow">${b.kind === 'dept' ? 'Department' : 'Project'}</span><span class="fp-name">${escapeHtml(b.title)}</span><span class="fp-sub">${escapeHtml(b.kind === 'dept' ? b.sub : (b.sub !== 'Project' ? b.sub : ''))}</span></span>
      <span class="fp-change">Change</span>`;
  }

  // Swap each <select> for a branded button (once), keeping the select as the value holder.
  function ensurePickerButtons() {
    ['home-actfor-select', 'project-select'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel || sel.dataset.enhanced) return;
      sel.dataset.enhanced = '1';
      sel.classList.add('sr-only-select');
      sel.setAttribute('tabindex', '-1');
      sel.setAttribute('aria-hidden', 'true');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'for-picker' + (id === 'home-actfor-select' ? ' on-navy' : '');
      btn.id = id + '-btn';
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.addEventListener('click', openForSheet);
      sel.insertAdjacentElement('afterend', btn);
    });
  }

  function renderActForSelects() {
    ensurePickerButtons();
    const targets = allowedTargets();
    const before = state.actingAs;
    // Only check the saved choice once the list has loaded. With no saved
    // choice, use the member's own department if the member list has one —
    // otherwise leave it unchosen rather than silently picking the first.
    if (targets.length && state.actingAs && !targets.some(t => t === state.actingAs)) state.actingAs = '';
    if (targets.length && !state.actingAs) {
      const ownDept = state.lastId && state.lastId.committee;
      state.actingAs = targets.find(t => sameName(t, ownDept)) || '';
    }
    if (state.actingAs !== before && typeof renderProjectDash === 'function') renderProjectDash();
    applyTheme(state.actingAs);
    const html = '<option value="">Choose…</option>' +
      targets.map(t => `<option value="${escapeHtml(t)}"${t === state.actingAs ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('');
    ['home-actfor-select', 'project-select'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = html;
      el.value = state.actingAs;
      const btn = document.getElementById(id + '-btn');
      if (btn) {
        btn.innerHTML = pickerButtonHtml(state.actingAs);
        btn.disabled = !targets.length;
        btn.setAttribute('aria-label', state.actingAs ? 'For: ' + state.actingAs + '. Change' : 'Choose a department or project');
      }
    });
    const note = document.getElementById('actfor-empty-note');
    if (note) note.style.display = targets.length ? 'none' : '';
  }

  function openForSheet() {
    const sheet = document.getElementById('for-sheet');
    document.getElementById('for-search').value = '';
    renderForSheet('');
    sheet.classList.add('show');
    sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('sheet-open');
  }

  function closeForSheet() {
    const sheet = document.getElementById('for-sheet');
    if (!sheet.classList.contains('show')) return;
    sheet.classList.remove('show');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('sheet-open');
  }

  function renderForSheet(query) {
    const q = String(query || '').toLowerCase().trim();
    const all = allowedTargets().map(brandFor);
    const match = b => !q || [b.title, b.sub, b.name].join(' ').toLowerCase().includes(q);
    const depts = all.filter(b => b.kind === 'dept' && match(b));
    const projects = all.filter(b => b.kind === 'project' && match(b));
    const selected = name => sameName(name, state.actingAs) ? ' selected' : '';
    const deptCard = b => `
      <button type="button" class="for-card dept${selected(b.name)}" data-pick="${escapeHtml(b.name)}" style="--c:${b.theme[0]};--c-tint:${b.theme[2]}">
        <img src="${b.img}" alt="" loading="lazy" decoding="async">
        <span class="for-card-code">${escapeHtml(b.title)}</span>
        <span class="for-card-sub">${escapeHtml(b.sub)}</span>
      </button>`;
    const projectCard = b => `
      <button type="button" class="for-card project${b.cover ? '' : ' no-cover'}${selected(b.name)}" data-pick="${escapeHtml(b.name)}" style="--c:${b.theme[0]};--c-deep:${b.theme[1]}">
        ${b.cover ? `<img class="for-card-cover" src="${b.cover}" alt="" loading="lazy" decoding="async"><span class="for-card-shade" aria-hidden="true"></span>` : `<span class="for-card-emoji" aria-hidden="true">${b.emoji}</span>`}
        <span class="for-card-name">${escapeHtml(b.title)}</span>
        ${b.sub !== 'Project' ? `<span class="for-card-short">${escapeHtml(b.sub)}</span>` : ''}
      </button>`;
    document.getElementById('for-sheet-body').innerHTML =
      (depts.length ? `<div class="for-section-label">Departments</div><div class="for-grid depts">${depts.map(deptCard).join('')}</div>` : '') +
      (projects.length ? `<div class="for-section-label">Projects</div><div class="for-grid projects">${projects.map(projectCard).join('')}</div>` : '') +
      (!depts.length && !projects.length ? '<div class="history-empty">No match. Officers can add projects in the PROJECTS tab.</div>' : '');
  }

  function bindForSheet() {
    document.getElementById('for-sheet-close').addEventListener('click', closeForSheet);
    document.getElementById('for-sheet').addEventListener('click', e => {
      if (e.target.id === 'for-sheet') return closeForSheet();
      const card = e.target.closest('[data-pick]');
      if (!card) return;
      setActingAs(card.dataset.pick);
      closeForSheet();
      if (state.view === 'checkout') renderCheckout();
    });
    document.getElementById('for-search').addEventListener('input', e => renderForSheet(e.target.value));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeForSheet(); });
  }

  async function refreshLoginInBackground() {
    if (!navigator.onLine || !state.lastId || !getInventoryScriptUrl()) return;
    const fresh = await fetchIdLookup(state.lastId.idNumber);
    if (fresh.status === 'NOT_FOUND' && state.lastId) {
      performLogout();
      showToast('Your ID is no longer in the member list. Ask an officer if this is a mistake.', true);
      return;
    }
    if (!fresh.found || !state.lastId || fresh.idNumber !== state.lastId.idNumber) return;
    state.lastId = fresh;
    saveLogin(fresh);
    renderIdentity();
    renderActForSelects();
  }

  // One resolve call to the backend. Throws with the server's message.
  async function postResolve(lineId) {
    const url = getInventoryScriptUrl();
    const token = getInventoryToken();
    const res = await fetch(url + '?action=resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ idNumber: state.lastId.idNumber, lineId }, token ? { token } : {}))
    });
    const json = await res.json();
    if (!json || !json.ok) throw new Error((json && json.error) || 'Could not mark returned');
    return json;
  }

  function canReachBackend() {
    if (getInventoryScriptUrl() && navigator.onLine) return true;
    showToast('You need to be online to mark items returned', true);
    return false;
  }

  function refreshAfterReturn() {
    if (state.view === 'out') renderOut();
    else if (state.view === 'history') renderHistory();
    else if (state.view === 'home') refreshHomeData();
    loadInventory();
  }

  async function resolveLine(lineId, btn) {
    if (!canReachBackend()) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await postResolve(lineId);
      showToast('Marked returned');
      refreshAfterReturn();
    } catch(err) {
      showToast(err.message, true);
      if (btn) { btn.disabled = false; btn.textContent = 'Mark returned'; }
    }
  }
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-resolve]');
    if (btn) resolveLine(btn.dataset.resolve, btn);
  });

  /* ---------------- Add to inventory ----------------
     Creates a new row in the Inventory tab (or Consumables when it has an
     expiry date). Dropdowns mirror the sheet's own dropdown lists
     (action=options), with these as a fallback until they load. */
  const ADD_OPTIONS_KEY = 'cela_add_options';
  const ADD_OPTIONS_FALLBACK = {
    types: ['Art & Craft Supplies', 'Bags & Storage', 'Cloth & Textiles', 'Decor & Props', 'Electronics & Lighting', 'Food', 'Games',
      'Kitchen & Food Prep', 'Office Supplies', 'Signage & Displays', 'Tableware & Disposables', 'Toiletries & Hygiene'],
    departments: ['General', 'OP', 'COMMPUB', 'CUL', 'EXREL', 'FIN', 'HR', 'OSR'],
    categories: ['Supplies', 'Equipment', 'Event Prop', 'Sponsor Goods'],
    storageAreas: ['Outside Org Room', 'Brown Table (Top)', 'Metal Drawer (Top)', 'Metal Drawer (2nd from Top)', 'Brown Cabinet',
      'Brown Cabinet (Bottom)', 'Cabinet (Bottom Shelf)', 'Rack (Top Shelf)', 'Rack (Bottom Shelf)', 'Shelf', 'Org Room Corner'],
    events: ['Recruitment Week and Welcome Week', 'Celadon Merchandise', 'General Assembly', 'Mid-Autumn Festival', 'Lunar Lotus Market',
      'TALAB x Faculty Appreciation Week', 'Jade Business Summit', 'Leadership Development Program', 'Celadon Rose Sale',
      'Chinese New Year', 'Spring Film Festival', 'Binondo Amazing Race', 'Mandopop Music Festival', 'Celadon Ball']
  };

  function getAddOptions() {
    try {
      const cached = JSON.parse(localStorage.getItem(ADD_OPTIONS_KEY) || 'null');
      if (cached) return Object.assign({}, ADD_OPTIONS_FALLBACK, cached);
    } catch(e) {}
    return ADD_OPTIONS_FALLBACK;
  }

  async function refreshAddOptions() {
    const url = getInventoryScriptUrl();
    if (!url || !navigator.onLine) return;
    try {
      const json = await fetch(url + '?action=options').then(r => r.json());
      if (!json || !json.ok || !json.options) return;
      const live = {};
      Object.keys(json.options).forEach(k => { if (Array.isArray(json.options[k]) && json.options[k].length) live[k] = json.options[k]; });
      localStorage.setItem(ADD_OPTIONS_KEY, JSON.stringify(live));
      if (state.view === 'add') fillAddSelects(true);
    } catch(e) {}
  }

  function fillSelect(id, values, placeholder, keep) {
    const el = document.getElementById(id);
    if (!el) return;
    const current = keep ? el.value : '';
    el.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` +
      values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    if (current && values.includes(current)) el.value = current;
  }

  const NEW_LOCATION = '__new__';

  function fillAddSelects(keep) {
    const o = getAddOptions();
    fillSelect('add-dept', o.departments, 'Choose a department', keep);
    fillSelect('add-type', o.types, 'Choose a type', keep);
    fillSelect('add-category', o.categories, 'Equipment, Supplies…', keep);
    const storage = document.getElementById('add-storage');
    const keepStorage = keep ? storage.value : '';
    fillSelect('add-storage', o.storageAreas, 'Not sure yet', false);
    storage.insertAdjacentHTML('beforeend', `<option value="${NEW_LOCATION}">+ New location…</option>`);
    if (keepStorage) storage.value = keepStorage;
    fillSelect('add-event', o.events, 'None', keep);
  }

  function renderAddForm() {
    const deptSelect = document.getElementById('add-dept');
    const keep = deptSelect && deptSelect.options.length > 1;
    fillAddSelects(keep);
    if (!keep || !deptSelect.value) {
      // Default the department to what you're borrowing for (if it's a
      // department), else your own.
      const o = getAddOptions();
      const pick = [state.actingAs, state.lastId && state.lastId.committee].find(v => v && o.departments.some(d => sameName(d, v)));
      if (pick) deptSelect.value = o.departments.find(d => sameName(d, pick));
    }
    document.getElementById('add-error').textContent = '';
    refreshAddOptions();
  }

  // ---- Add form checks (the script checks the same rules again) ----
  const ADD_RULES = {
    'add-title': v => {
      if (!v) return 'Enter the item name.';
      if (v.length < 2) return 'Use at least 2 characters.';
      if (/^[=+\-@]/.test(v)) return "Names can't start with = + - or @.";
      return '';
    },
    'add-qty': v => {
      if (!v) return 'Enter how many (or * if there are a lot).';
      if (v === '*') return '';
      if (!/^\d+$/.test(v)) return 'Use a whole number like 5, or *.';
      const n = Number(v);
      if (n < 1) return 'Must be at least 1.';
      if (n > 9999) return 'That looks too high. Max 9999.';
      return '';
    },
    'add-unit': v => (v && !/^[\p{L} .\/-]+$/u.test(v) ? 'Use a word like pcs, packs or sets.' : ''),
    'add-dept': v => (v ? '' : 'Choose the department that owns it.'),
    'add-type': v => (v ? '' : 'Choose a type so people can find it.'),
    'add-category': v => (v ? '' : 'Equipment comes back; Supplies get used up.'),
    'add-storage': () => {
      const sel = document.getElementById('add-storage').value;
      const spot = document.getElementById('add-spot').value.trim();
      if (sel === NEW_LOCATION) {
        const name = document.getElementById('add-storage-new').value.trim();
        if (name.length < 3) return 'Name the new location (at least 3 characters).';
        if (/^[=+\-@]/.test(name)) return "Location names can't start with = + - or @.";
        const known = getAddOptions().storageAreas.find(a => sameName(a, name));
        if (known) return `"${known}" already exists. Pick it from the list instead.`;
        return '';
      }
      return (!sel && !spot) ? 'Pick a storage area or fill in the specific spot.' : '';
    },
    'add-expiry': v => {
      if (!document.getElementById('add-expires').checked) return '';
      if (!v) return 'Pick the expiry date, or untick the box.';
      const d = new Date(v + 'T00:00:00');
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (d < new Date(today.getTime() - 365 * 86400000) || d > new Date(today.getTime() + 15 * 365 * 86400000)) return 'Check the year.';
      return '';
    }
  };

  function checkAddField(id, show) {
    const el = document.getElementById(id);
    const msg = ADD_RULES[id](el.value.trim());
    const errEl = document.getElementById('err-' + id);
    if (show && errEl) errEl.textContent = msg;
    if (show) el.setAttribute('aria-invalid', msg ? 'true' : 'false');
    return msg;
  }

  // Warn while typing if this exact item already exists, and offer Add stock.
  function checkDuplicate() {
    const hint = document.getElementById('dup-add-title');
    const title = document.getElementById('add-title').value.trim();
    const dept = document.getElementById('add-dept').value;
    hint.innerHTML = '';
    if (title.length < 2) return;
    const same = state.inventory.filter(i => sameName(i.title, title));
    if (!same.length) return;
    const exact = same.find(i => !dept || sameName(i.category, dept));
    const item = exact || same[0];
    hint.innerHTML = `Already listed: <b>${escapeHtml(item.title)}</b> (${escapeHtml(item.category)}${item.location ? ', ' + escapeHtml(item.location) : ''}). ` +
      `<button type="button" class="text-link" data-open-item="${escapeHtml(item.id)}">Add stock to it instead</button>`;
  }

  function bindAddForm() {
    const form = document.getElementById('add-form');
    if (!form) return;
    document.getElementById('add-expires').addEventListener('change', e => {
      document.getElementById('add-expiry-wrap').style.display = e.target.checked ? '' : 'none';
      if (!e.target.checked) document.getElementById('err-add-expiry').textContent = '';
    });
    document.getElementById('add-storage').addEventListener('change', e => {
      const isNew = e.target.value === NEW_LOCATION;
      document.getElementById('add-storage-new-wrap').style.display = isNew ? '' : 'none';
      if (isNew) document.getElementById('add-storage-new').focus();
    });
    // Check a field once the person leaves it, then live while they fix it.
    Object.keys(ADD_RULES).forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('blur', () => checkAddField(id, true));
      el.addEventListener('input', () => { if (el.getAttribute('aria-invalid') === 'true') checkAddField(id, true); });
      el.addEventListener('change', () => { if (el.tagName === 'SELECT') checkAddField(id, true); });
    });
    ['add-storage-new', 'add-spot'].forEach(id => document.getElementById(id).addEventListener('input', () => {
      if (document.getElementById('add-storage').getAttribute('aria-invalid') === 'true') checkAddField('add-storage', true);
    }));
    document.getElementById('add-title').addEventListener('input', checkDuplicate);
    document.getElementById('add-dept').addEventListener('change', checkDuplicate);
    document.getElementById('dup-add-title').addEventListener('click', e => {
      const b = e.target.closest('[data-open-item]');
      if (!b) return;
      showView('catalog');
      openItemSheet(b.dataset.openItem);
      sheetState.action = 'RESTOCKING';
      renderItemSheet();
    });
    const notes = document.getElementById('add-notes');
    notes.addEventListener('input', () => { document.getElementById('add-notes-count').textContent = notes.value.length + ' / 300'; });
    form.addEventListener('submit', e => { e.preventDefault(); submitAddItem(); });
  }

  let addingItem = false;
  async function submitAddItem() {
    if (addingItem) return;
    const val = id => document.getElementById(id).value.replace(/\s+/g, ' ').trim();
    const err = document.getElementById('add-error');
    const btn = document.getElementById('add-submit');
    err.textContent = '';

    // Run every check and jump to the first problem.
    const problems = Object.keys(ADD_RULES).filter(id => checkAddField(id, true));
    if (problems.length) {
      err.textContent = problems.length === 1 ? 'Fix the highlighted field.' : 'Fix the ' + problems.length + ' highlighted fields.';
      document.getElementById(problems[0]).focus();
      return;
    }
    const expires = document.getElementById('add-expires').checked;
    const storageSel = document.getElementById('add-storage').value;
    const payload = {
      idNumber: state.lastId && state.lastId.idNumber,
      title: val('add-title'), qty: val('add-qty'), unit: val('add-unit'),
      department: val('add-dept'), type: val('add-type'), category: val('add-category'),
      storage: storageSel === NEW_LOCATION ? val('add-storage-new') : storageSel,
      spot: val('add-spot'), event: val('add-event'),
      notes: val('add-notes'), expiry: expires ? val('add-expiry') : ''
    };
    const url = getInventoryScriptUrl();
    if (!url || !navigator.onLine) { err.textContent = 'You need to be online to add items.'; return; }

    addingItem = true;
    btn.disabled = true; btn.innerHTML = BUSY_DOTS + ' ADDING';
    try {
      const token = getInventoryToken();
      const res = await fetch(url + '?action=addItem', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign(payload, token ? { token } : {}))
      });
      const json = await res.json();
      if (!json || !json.ok) throw new Error((json && json.error) || 'Could not add the item');
      showToast(json.revived ? payload.title + ' is back in the inventory' : payload.title + ' added' + (json.tab === 'Consumables' ? ' to Consumables' : ''));
      if (storageSel === NEW_LOCATION) {
        // The new location is now in the sheet's dropdown; refresh our copy.
        try { localStorage.removeItem(ADD_OPTIONS_KEY); } catch(e) {}
        refreshAddOptions();
      }
      document.getElementById('add-form').reset();
      document.getElementById('add-expiry-wrap').style.display = 'none';
      document.getElementById('add-storage-new-wrap').style.display = 'none';
      document.getElementById('dup-add-title').innerHTML = '';
      document.querySelectorAll('#add-form [aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
      // Show the new item in the catalog.
      state.catalogSearch = payload.title;
      state.catalogCategory = 'all';
      state.catalogDept = 'all';
      const search = document.getElementById('catalog-search');
      if (search) search.value = payload.title;
      showView('catalog');
      loadInventory(true);
    } catch(e2) {
      err.textContent = e2.message;
    } finally {
      addingItem = false;
      btn.disabled = false; btn.textContent = 'ADD TO INVENTORY';
    }
  }

  /* ---------------- Borrowed now ----------------
     Everything still out of the org room, grouped by project/department,
     overdue first. Same data as History (action=history), so it also works
     from the offline cache. */
  function pendingBorrows(records) {
    return records.filter(r => r.caseType === 'BORROWING' && !r.resolved);
  }

  async function updateOutCount(records) {
    const sub = document.getElementById('out-sub');
    if (!sub) return;
    if (!records) records = (await fetchHistoryRecords()).records;
    const pending = pendingBorrows(records);
    const overdue = pending.filter(r => r.overdue).length;
    sub.textContent = pending.length
      ? pending.length + (pending.length === 1 ? ' item' : ' items') + ' out' + (overdue ? ' · ' + overdue + ' overdue' : '')
      : 'Nothing is out right now';
    sub.classList.toggle('overdue', overdue > 0);
  }

  /* ---------------- Home dashboard: what the picked project still has out ----------------
     Every pending borrow for the project/department picked on Home, however
     old. Tick what came back, then confirm to mark them returned. Recently
     returned items sit in a collapsed list underneath for reassurance. */
  const RECENT_RETURN_DAYS = 30;

  // A-yi drawings from ateneoceladon.com, one per department; projects, OP and
  // General get the classic A-yi.
  const AYI_BY_DEPT = { COMMPUB: 'commpub', CUL: 'cul', EXREL: 'exrel', FIN: 'fin', HR: 'hr', OSR: 'osr' };
  function ayiFor(name) {
    const code = Object.keys(AYI_BY_DEPT).find(d => sameName(d, name));
    return 'brand/ayi/' + (code ? AYI_BY_DEPT[code] : 'ayi') + '.png';
  }
  const dashState = { selected: new Set(), confirming: false, busy: false, records: [], offline: false, loading: false, openGroups: null };
  const DASH_OPEN_ALL_UP_TO = 5; // with this many items or fewer, every group starts expanded

  let homeLoadToken = 0;
  async function refreshHomeData() {
    const myToken = ++homeLoadToken;
    const cached = getCachedHistory();
    if (cached && Array.isArray(cached.records)) {
      updateOutCount(cached.records);
      dashState.records = cached.records;
      dashState.loading = false;
      renderProjectDash();
    } else {
      dashState.loading = true;
      renderProjectDash();
    }
    const { records, offline } = await fetchHistoryRecords();
    if (myToken !== homeLoadToken) return;
    updateOutCount(records);
    dashState.records = records;
    dashState.offline = offline;
    dashState.loading = false;
    renderProjectDash();
  }

  function renderProjectDash() {
    const box = document.getElementById('proj-dash');
    if (!box) return;
    const project = state.actingAs;
    const heroAyi = document.getElementById('hero-ayi');
    if (heroAyi) heroAyi.src = ayiFor(project);
    if (!project || !state.lastId) { box.style.display = 'none'; return; }
    box.style.display = '';
    if (dashState.loading) {
      document.getElementById('proj-dash-title').textContent = project;
      document.getElementById('proj-dash-sub').textContent = 'Checking what\'s out…';
      document.getElementById('proj-dash-stats').innerHTML = '<div class="dash-stat skeleton"></div>'.repeat(3);
      document.getElementById('proj-dash-list').innerHTML = loaderHtml('Checking what\'s out…', true);
      document.getElementById('proj-dash-actions').innerHTML = '';
      return;
    }

    const borrows = dashState.records.filter(r => sameName(r.project, project) && r.caseType === 'BORROWING');
    const out = borrows.filter(r => !r.resolved)
      .sort((a, b) => (b.overdue - a.overdue) || String(a.due).localeCompare(String(b.due)));
    const recentCutoff = Date.now() - RECENT_RETURN_DAYS * 86400000;
    const returned = borrows.filter(r => r.resolved && new Date(r.resolvedAt || r.time) >= recentCutoff)
      .sort((a, b) => String(b.resolvedAt || b.time).localeCompare(String(a.resolvedAt || a.time)));
    const overdue = out.filter(r => r.overdue).length;
    const dueSoon = out.filter(r => !r.overdue && r.due && new Date(r.due) - Date.now() < 3 * 86400000).length;

    // Drop selections that are no longer pending (e.g. resolved elsewhere).
    const outIds = new Set(out.map(r => r.lineId));
    [...dashState.selected].forEach(id => { if (!outIds.has(id)) dashState.selected.delete(id); });

    document.getElementById('proj-dash-title').textContent = project;
    document.getElementById('proj-dash-sub').textContent = 'Still borrowed by this ' + (/^(OP|COMMPUB|CUL|EXREL|FIN|HR|OSR|General)$/.test(project) ? 'department' : 'project') + ' and not yet returned';
    document.getElementById('proj-dash-stats').innerHTML = [
      ['Not returned', out.length, out.length ? 'warn' : ''],
      ['Overdue', overdue, overdue ? 'danger' : ''],
      ['Due in 3 days', dueSoon, dueSoon ? 'warn' : '']
    ].map(([label, n, tone]) => `<div class="dash-stat ${tone}"><div class="dash-stat-n">${n}</div><div class="dash-stat-l">${label}</div></div>`).join('');

    const offlineNote = dashState.offline ? '<div class="history-offline-note">Offline: showing the last synced data. Returns need a connection.</div>' : '';
    // Group what's out by borrower so long lists collapse into one line per
    // person; each group (and the whole list) has a select-all checkbox.
    const disabled = dashState.offline || dashState.busy ? 'disabled' : '';
    const groupsByKey = {};
    out.forEach(r => {
      const key = String(r.idNum || r.name || '?');
      (groupsByKey[key] = groupsByKey[key] || { key, name: r.name || r.idNum || 'Unknown', rows: [] }).rows.push(r);
    });
    const groups = Object.values(groupsByKey).sort((a, b) =>
      (b.rows.filter(r => r.overdue).length - a.rows.filter(r => r.overdue).length) || a.name.localeCompare(b.name));
    if (!dashState.openGroups) {
      // First render for this project: open everything when the list is short,
      // otherwise only groups with something overdue.
      dashState.openGroups = new Set(groups.filter(g => out.length <= DASH_OPEN_ALL_UP_TO || g.rows.some(r => r.overdue)).map(g => g.key));
    }
    const rowHtml = r => `
          <label class="dash-row${r.overdue ? ' is-overdue' : ''}">
            <input type="checkbox" class="dash-check" data-line="${escapeHtml(r.lineId)}" ${dashState.selected.has(r.lineId) ? 'checked' : ''} ${disabled}>
            <span class="dash-row-main">
              <span class="dash-row-title">${escapeHtml(r.item)}${r.qty ? ' × ' + escapeHtml(r.qty) : ''}</span>
              <span class="dash-row-meta">${shortDate(r.time)}${r.committee ? ' · ' + escapeHtml(r.committee) : ''}${r.location ? ' · ' + escapeHtml(r.location) : ''}</span>
            </span>
            <span class="dash-row-due${r.overdue ? ' overdue' : ''}">${r.overdue ? 'Overdue' : (r.due ? 'Due ' + shortDate(r.due) : '')}</span>
          </label>`;
    const groupHtml = g => {
      const overdueN = g.rows.filter(r => r.overdue).length;
      const units = g.rows.reduce((sum, r) => sum + (parseInt(r.qty, 10) || 0), 0);
      return `
        <details class="dash-group${overdueN ? ' has-overdue' : ''}" data-group="${escapeHtml(g.key)}" ${dashState.openGroups.has(g.key) ? 'open' : ''}>
          <summary class="dash-group-head">
            <input type="checkbox" class="dash-group-check" data-group="${escapeHtml(g.key)}" aria-label="Select everything ${escapeHtml(g.name)} borrowed" ${disabled}>
            <span class="dash-group-name">${escapeHtml(g.name)}</span>
            <span class="dash-group-meta">${g.rows.length} item${g.rows.length === 1 ? '' : 's'}${units > g.rows.length ? ' (' + units + ' pcs)' : ''}${overdueN ? ` · <b>${overdueN} overdue</b>` : ''}</span>
            <span class="dash-group-chev" aria-hidden="true">›</span>
          </summary>
          <div class="dash-group-body">${g.rows.map(rowHtml).join('')}</div>
        </details>`;
    };
    const outRows = (out.length > 1 ? `
      <div class="dash-toolbar">
        <label class="dash-all"><input type="checkbox" id="dash-check-all" ${disabled}> Select all (${out.length})</label>
        <button type="button" class="text-link" id="dash-toggle-groups">${dashState.openGroups.size === groups.length ? 'Collapse all' : 'Expand all'}</button>
      </div>` : '') + groups.map(groupHtml).join('');
    const doneRows = returned.map(r => `
      <div class="dash-row done">
        <span class="dash-done-mark" aria-hidden="true">✓</span>
        <span class="dash-row-main">
          <span class="dash-row-title">${escapeHtml(r.item)}${r.qty ? ' × ' + escapeHtml(r.qty) : ''}</span>
          <span class="dash-row-meta">Borrowed by ${escapeHtml(r.name || '—')} · ${shortDate(r.time)}${r.resolvedBy ? ' · returned by ' + escapeHtml(r.resolvedBy) : ''}</span>
        </span>
      </div>`).join('');

    document.getElementById('proj-dash-list').innerHTML = offlineNote +
      (out.length ? outRows : `<div class="dash-empty"><img src="${ayiFor(project)}" alt="" loading="lazy" decoding="async"><div>All clear! ${escapeHtml(project)} has nothing out right now.</div></div>`) +
      (returned.length ? `<details class="dash-done"><summary>Recently returned (${returned.length})</summary>${doneRows}</details>` : '');

    // Keeps the group / select-all boxes in step with the item boxes.
    const syncChecks = () => {
      groups.forEach(g => {
        const box = document.querySelector(`#proj-dash-list .dash-group-check[data-group="${CSS.escape(g.key)}"]`);
        if (!box) return;
        const n = g.rows.filter(r => dashState.selected.has(r.lineId)).length;
        box.checked = n === g.rows.length;
        box.indeterminate = n > 0 && n < g.rows.length;
      });
      const all = document.getElementById('dash-check-all');
      if (all) {
        all.checked = dashState.selected.size === out.length;
        all.indeterminate = dashState.selected.size > 0 && dashState.selected.size < out.length;
      }
      dashState.confirming = false;
      renderDashActions(out);
    };
    const setLines = (rows, on) => {
      rows.forEach(r => on ? dashState.selected.add(r.lineId) : dashState.selected.delete(r.lineId));
      document.querySelectorAll('#proj-dash-list .dash-check').forEach(cb => { cb.checked = dashState.selected.has(cb.dataset.line); });
      syncChecks();
    };
    document.querySelectorAll('#proj-dash-list .dash-check').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) dashState.selected.add(cb.dataset.line); else dashState.selected.delete(cb.dataset.line);
        syncChecks();
      });
    });
    document.querySelectorAll('#proj-dash-list .dash-group-check').forEach(cb => {
      // Ticking the box in a group's header shouldn't also open/close it.
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('change', () => setLines(groupsByKey[cb.dataset.group].rows, cb.checked));
    });
    document.querySelectorAll('#proj-dash-list .dash-group').forEach(d => {
      d.addEventListener('toggle', () => {
        if (d.open) dashState.openGroups.add(d.dataset.group); else dashState.openGroups.delete(d.dataset.group);
        const t = document.getElementById('dash-toggle-groups');
        if (t) t.textContent = dashState.openGroups.size === groups.length ? 'Collapse all' : 'Expand all';
      });
    });
    const allBox = document.getElementById('dash-check-all');
    if (allBox) allBox.addEventListener('change', () => setLines(out, allBox.checked));
    const toggle = document.getElementById('dash-toggle-groups');
    if (toggle) toggle.addEventListener('click', () => {
      const openAll = dashState.openGroups.size !== groups.length;
      document.querySelectorAll('#proj-dash-list .dash-group').forEach(d => { d.open = openAll; });
    });
    syncChecks();
  }

  function renderDashActions(out) {
    const actions = document.getElementById('proj-dash-actions');
    if (!actions) return;
    const n = dashState.selected.size;
    if (!out.length) { actions.innerHTML = ''; return; }
    if (dashState.confirming && n) {
      const picked = out.filter(r => dashState.selected.has(r.lineId));
      const names = picked.slice(0, 6).map(r => escapeHtml(r.item) + (r.qty ? ' × ' + escapeHtml(r.qty) : '') + ` <span class="dash-confirm-who">(${escapeHtml(r.name || '—')})</span>`);
      if (picked.length > 6) names.push(`…and ${picked.length - 6} more`);
      actions.innerHTML = `
        <div class="dash-confirm" role="alertdialog" aria-label="Confirm return">
          <div class="dash-confirm-q">Are these back in the org room?</div>
          <div class="dash-confirm-list">${names.join('<br>')}</div>
          <div class="dash-confirm-btns">
            <button type="button" class="btn-secondary" id="dash-cancel">Not yet</button>
            <button type="button" class="btn-primary" id="dash-yes">Yes, mark ${n} returned</button>
          </div>
        </div>`;
      document.getElementById('dash-cancel').addEventListener('click', () => { dashState.confirming = false; renderDashActions(out); });
      document.getElementById('dash-yes').addEventListener('click', () => confirmDashReturn(out));
      return;
    }
    actions.innerHTML = `<button type="button" class="btn-primary dash-return-btn" id="dash-return" ${n && !dashState.busy ? '' : 'disabled'}>${n ? 'Confirm return (' + n + ')' : 'Tick items that came back'}</button>`;
    document.getElementById('dash-return').addEventListener('click', () => { dashState.confirming = true; renderDashActions(out); });
  }

  async function confirmDashReturn(out) {
    if (!canReachBackend()) return;
    const ids = out.map(r => r.lineId).filter(id => dashState.selected.has(id));
    dashState.busy = true;
    dashState.confirming = false;
    const actions = document.getElementById('proj-dash-actions');
    if (actions) actions.innerHTML = `<div class="dash-progress">Marking ${ids.length} item${ids.length === 1 ? '' : 's'} returned…</div>`;
    let done = 0;
    const failed = [];
    try {
      // One call for the whole batch.
      const token = getInventoryToken();
      const res = await fetch(getInventoryScriptUrl() + '?action=resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ idNumber: state.lastId.idNumber, lineIds: ids }, token ? { token } : {}))
      });
      const json = await res.json();
      if (!json || !json.ok) throw new Error((json && json.error) || 'Could not mark returned');
      if (Array.isArray(json.resolved)) {
        done = json.resolved.length + (json.alreadyResolved || []).length;
        (json.missing || []).forEach(() => failed.push('not found'));
      } else {
        // Older script (one line per call): it only handled the first; do the rest one by one.
        done = 1;
        for (const id of ids.slice(1)) {
          if (actions) actions.innerHTML = `<div class="dash-progress">Marking returned… ${done + 1} of ${ids.length}</div>`;
          try { await postResolve(id); done++; } catch(err) { failed.push(err.message); }
        }
      }
      ids.forEach(id => dashState.selected.delete(id));
    } catch(err) {
      failed.push(err.message);
    }
    dashState.busy = false;
    if (failed.length) showToast(`${done} marked returned, ${failed.length} failed: ${failed[0]}`, true);
    else showToast(done === 1 ? 'Marked returned' : done + ' items marked returned');
    refreshAfterReturn();
  }


  let outLoadToken = 0;
  async function renderOut() {
    const list = document.getElementById('out-list');
    if (!list) return;
    document.querySelectorAll('#out-filter .category-chip').forEach(b => b.classList.toggle('active', b.dataset.filter === state.outFilter));
    const myToken = ++outLoadToken;
    list.innerHTML = loaderHtml('Finding what\'s out…');

    const { records, offline, syncedAt } = await fetchHistoryRecords();
    if (myToken !== outLoadToken) return;

    let pending = pendingBorrows(records);
    if (state.outFilter === 'mine') {
      // Mine = what I borrowed, plus anything out for my department or the
      // project/department I've picked on Home.
      const myId = String(state.lastId && state.lastId.idNumber || '').trim();
      const ownDept = state.lastId && state.lastId.committee;
      pending = pending.filter(r => String(r.idNum).trim() === myId || sameName(r.project, ownDept) || sameName(r.project, state.actingAs));
    }
    pending.sort((a, b) => (b.overdue - a.overdue) || String(a.due).localeCompare(String(b.due)));

    const groups = {};
    pending.forEach(r => { (groups[r.project || '—'] = groups[r.project || '—'] || []).push(r); });

    const offlineNote = offline
      ? `<div class="history-offline-note"><svg class="svg-icon icon-inline" aria-hidden="true" focusable="false"><use href="#i-wifi"/></svg>Showing ${syncedAt ? 'data from ' + new Date(syncedAt).toLocaleString() : 'no saved data'}.</div>`
      : '';
    list.innerHTML = offlineNote + (pending.length
      ? Object.keys(groups).map(project => `
          <div class="history-section-label">${escapeHtml(project)} <span class="out-group-count">${groups[project].length}</span></div>
          <div class="history-list">${groups[project].map(r => historyRowHtml(r, true)).join('')}</div>`).join('')
      : `<div class="history-empty">${state.outFilter === 'mine' ? 'Nothing borrowed by you or your projects' : 'Nothing is out of the org room'}</div>`);
  }

  let historyLoadToken = 0;
  async function renderHistory() {
    const pendingList = document.getElementById('history-pending-list');
    const totalList = document.getElementById('history-total-list');
    if (!pendingList || !totalList) return;

    const myToken = ++historyLoadToken; // avoids a slow older fetch overwriting a newer render
    const skeletonRow = '<div class="history-item skeleton-row skeleton" style="height:52px;"></div>';
    pendingList.innerHTML = loaderHtml('Loading your history…');
    totalList.innerHTML = skeletonRow.repeat(2);

    const { records, offline, error, syncedAt } = await fetchHistoryRecords();
    if (myToken !== historyLoadToken) return; // a newer call already took over

    let scoped = records;
    if (state.historyTab === 'personal') {
      const myId = state.lastId && state.lastId.idNumber ? String(state.lastId.idNumber).trim() : '';
      scoped = records.filter(r => String(r.idNum).trim() === myId);
    } else {
      const projectSelect = document.getElementById('history-project-select');
      const chosen = projectSelect ? projectSelect.value : '';
      if (!chosen) {
        pendingList.innerHTML = '<div class="history-empty">Choose a project or department above</div>';
        totalList.innerHTML = '';
        return;
      }
      scoped = records.filter(r => sameName(r.project, chosen));
    }

    const pending = scoped.filter(r => !r.resolved);
    const total = scoped.filter(r => r.resolved);

    const offlineNote = offline
      ? `<div class="history-offline-note"><svg class="svg-icon icon-inline" aria-hidden="true" focusable="false"><use href="#i-wifi"/></svg>${error ? 'Could not refresh' : "You're offline"} — showing ${syncedAt ? 'last synced (' + new Date(syncedAt).toLocaleString() + ')' : 'no saved'} data.</div>`
      : '';

    pendingList.innerHTML = offlineNote + (pending.length
      ? pending.map(r => historyRowHtml(r, false)).join('')
      : '<div class="history-empty">No pending requests yet</div>');

    totalList.innerHTML = total.length
      ? total.map(r => historyRowHtml(r, false)).join('')
      : '<div class="history-empty">Nothing logged yet</div>';
  }

  function bindHeaderActions() {
    document.getElementById('cart-icon-btn').addEventListener('click', () => showView('cart'));
    document.getElementById('contact-icon-btn').addEventListener('click', () => toggleModal(true));
  }

  /* ---------------- Home (page 1 layout) ---------------- */

  const INVENTORY_URL_KEY = 'cela_inventory_url';

  // Default Apps Script URL — pre-fills Settings and unlocks the app on first
  // load. Paste the /exec URL of the Celadon Inventory deployment here
  // (see SETUP.md). Still editable at any time from Settings.
  const DEFAULT_INVENTORY_URL = 'https://script.google.com/macros/s/AKfycbzNeUVhEX0hgdte8ix6ztLUkJHGbbzvTcWFV9s9X2bniEK1V_i8Ox5a7zXgiaGhS0kHWg/exec';

  function getInventoryScriptUrl() {
    try {
      return (localStorage.getItem(INVENTORY_URL_KEY) || '').trim();
    } catch(e) { return ''; }
  }

  function saveInventoryScriptUrl(url) {
    localStorage.setItem(INVENTORY_URL_KEY, url);
  }

  const INVENTORY_TOKEN_KEY = 'cela_inventory_token';

  function getInventoryToken() {
    try { return (localStorage.getItem(INVENTORY_TOKEN_KEY) || '').trim(); } catch(e) { return ''; }
  }

  function saveInventoryToken(token) {
    try { localStorage.setItem(INVENTORY_TOKEN_KEY, token || ''); } catch(e) {}
  }

  // Seeds the URL with its default the very first time the app runs on a
  // device, without ever overwriting a URL the person has already saved
  // (their own edits — including clearing it back to blank — always win).
  function seedDefaultScriptUrls() {
    if (DEFAULT_INVENTORY_URL && localStorage.getItem(INVENTORY_URL_KEY) === null) {
      saveInventoryScriptUrl(DEFAULT_INVENTORY_URL);
    }
  }

  /* ---------------- Login ---------------- */

  function bindLogin() {
    const input = document.getElementById('login-id-input');
    const btn = document.getElementById('login-enter-btn');
    const err = document.getElementById('login-error');

    async function attemptLogin() {
      const idValue = input.value.trim();
      err.textContent = '';

      if (!idValue) {
        err.textContent = 'Enter your ID number.';
        return;
      }
      if (!/^\d{6}$/.test(idValue)) {
        err.textContent = 'Enter a valid 6-digit ID number.';
        return;
      }

      btn.disabled = true;
      btn.classList.add('loading');
      btn.innerHTML = BUSY_DOTS + ' CHECKING';
      // Apps Script can take a few seconds to wake up; say so instead of looking stuck.
      const slowTimer = setTimeout(() => { err.className = 'login-error info'; err.innerHTML = loaderHtml('Waking up the inventory sheet… this can take a few seconds.', true); }, 2500);

      const result = await fetchIdLookup(idValue);

      clearTimeout(slowTimer);
      err.className = 'login-error';
      err.textContent = '';
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.textContent = 'ENTER';

      if (result.status === 'NOT_CONFIGURED') {
        err.textContent = 'The app isn\'t connected to the inventory sheet yet — contact an officer.';
        return;
      }
      if (result.status === 'NETWORK_ERROR') {
        err.textContent = 'Could not reach the server. Check your connection.';
        return;
      }
      if (result.status === 'ERROR') {
        err.textContent = result.message || 'Something went wrong. Please try again.';
        if (/access code/i.test(result.message || '')) document.getElementById('login-connection').open = true;
        return;
      }
      if (!result.found) {
        err.textContent = 'ID number not found in the Celadon member list. Check the number, or ask an officer to add you.';
        return;
      }

      state.lastId = result;
      saveLogin(result);
      state.actingAs = getSavedActingAs();
      renderIdentity();
      renderActForSelects();
      input.value = '';
      showView('home');
      loadInventory(); // get the item list ready while they look at Home
    }

    // Connection settings on the login screen (an access code, if the
    // officers turned one on — otherwise nobody new could log in).
    const codeSave = document.getElementById('login-code-save');
    if (codeSave) codeSave.addEventListener('click', () => {
      saveInventoryToken(document.getElementById('login-code-input').value.trim());
      showToast('Access code saved');
      attemptLogin();
    });

    btn.addEventListener('click', attemptLogin);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attemptLogin();
    });
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); });
  }

  /* ---------------- Home (page 1 layout) ---------------- */

  function bindHome() {
    document.getElementById('home-nav-inventory').addEventListener('click', () => {
      showView('catalog');
    });

    document.getElementById('home-nav-history').addEventListener('click', () => {
      showView('history');
    });

    const historyProjectSelect = document.getElementById('history-project-select');
    if (historyProjectSelect) {
      historyProjectSelect.addEventListener('change', () => renderHistory());
    }

    document.getElementById('home-nav-out').addEventListener('click', () => showView('out'));
    document.getElementById('home-nav-add').addEventListener('click', () => showView('add'));
    document.getElementById('catalog-add-btn').addEventListener('click', () => showView('add'));
    bindAddForm();
    document.querySelectorAll('#out-filter .category-chip').forEach(btn => {
      btn.addEventListener('click', () => { state.outFilter = btn.dataset.filter; renderOut(); });
    });
    ['home-actfor-select', 'project-select'].forEach(id => {
      document.getElementById(id).addEventListener('change', e => setActingAs(e.target.value));
    });

    const logoBtn = document.getElementById('logo-home-btn');
    if (logoBtn) logoBtn.addEventListener('click', () => showView('home'));
  }

  /* ---------------- Settings ---------------- */

  function bindSettings() {
    document.getElementById('settings-install-btn').addEventListener('click', () => triggerInstall());

    document.getElementById('settings-save-btn').addEventListener('click', () => {
      const inventoryUrl = document.getElementById('settings-inventory-url').value.trim();
      const inventoryToken = document.getElementById('settings-inventory-token').value.trim();
      const status = document.getElementById('settingsStatus');

      if (!inventoryUrl) {
        status.textContent = 'Enter the Inventory Apps Script URL.';
        status.className = 'setup-status error';
        return;
      }
      saveInventoryScriptUrl(inventoryUrl);
      saveInventoryToken(inventoryToken);

      status.textContent = 'Saved!';
      status.className = 'setup-status ok';
      loadInventory(); // refresh right away so Catalog isn't stuck on stale/demo data
    });

    document.getElementById('logout-link').addEventListener('click', performLogout);
  }

  /**
   * Logs the current person out from anywhere in the app — the Settings
   * page link (mobile) or either sidebar's pinned "Log out" (desktop).
   */
  function performLogout() {
    clearLogin();
    state.lastId = null;
    state.cart = {};
    state.actingAs = '';
    try {
      ['cela_cart_v2', 'cela_acting_as', 'cela_history_cache'].forEach(k => localStorage.removeItem(k));
    } catch(e) {}
    updateCartBadge();
    applyTheme('');
    dashState.records = [];
    const loginInput = document.getElementById('login-id-input');
    const loginErr = document.getElementById('login-error');
    if (loginInput) loginInput.value = '';
    if (loginErr) loginErr.textContent = '';
    showView('login');
  }

  /* ---------------- Inventory / catalog ---------------- */

  /* ---------------- Loading visuals ----------------
     A swinging lantern (drawn for this app) for anything that takes a
     moment, and three bouncing "dumplings" inside busy buttons. */
  const LANTERN_SVG = '<svg class="lantern" viewBox="0 0 64 96" aria-hidden="true" focusable="false"><path d="M32 2v10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><rect x="22" y="11" width="20" height="7" rx="2.5" fill="currentColor"/><ellipse class="lantern-glow" cx="32" cy="44" rx="29" ry="29" fill="#f09b43" opacity=".2"/><path d="M12 44c0-14 9-25 20-25s20 11 20 25-9 25-20 25-20-11-20-25z" fill="currentColor"/><path d="M32 19c-6 6-8 15-8 25s2 19 8 25M32 19c6 6 8 15 8 25s-2 19-8 25" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="1.6"/><path d="M13.5 37h37M13.5 51h37" stroke="#fff" stroke-opacity=".25" stroke-width="1.4"/><ellipse class="lantern-light" cx="27" cy="38" rx="5" ry="9" fill="#ffd9a8" opacity=".55"/><rect x="22" y="68" width="20" height="7" rx="2.5" fill="currentColor"/><path d="M32 75v8" stroke="#f09b43" stroke-width="2.5" stroke-linecap="round"/><path class="lantern-tassel" d="M28 83h8l-1.2 11h-5.6z" fill="#f09b43"/></svg>';
  function loaderHtml(text, small) {
    return `<div class="cela-loader${small ? ' small' : ''}" role="status">${LANTERN_SVG}<div class="cela-loader-text">${escapeHtml(text || 'Loading…')}</div></div>`;
  }
  const BUSY_DOTS = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>';

  /* ---------------- Categories ----------------
     The sheet's Type column, shown under friendlier names. Merch (from the
     Celamerch tab) gets its own. Anything new in the sheet still shows up,
     under its own Type name. */
  const CATEGORY_DEFS = [
    { key: 'stationery', label: 'Stationery', icon: '✏️', type: 'Office Supplies' },
    { key: 'art', label: 'Art & Craft', icon: '🎨', type: 'Art & Craft Supplies' },
    { key: 'electronics', label: 'Lights & Electronics', icon: '💡', type: 'Electronics & Lighting' },
    { key: 'decor', label: 'Decor & Props', icon: '🏮', type: 'Decor & Props' },
    { key: 'signage', label: 'Signs & Displays', icon: '🪧', type: 'Signage & Displays' },
    { key: 'kitchen', label: 'Kitchen', icon: '🍳', type: 'Kitchen & Food Prep' },
    { key: 'tableware', label: 'Tableware', icon: '🍽️', type: 'Tableware & Disposables' },
    { key: 'bags', label: 'Bags & Boxes', icon: '👜', type: 'Bags & Storage' },
    { key: 'cloth', label: 'Cloth & Textiles', icon: '🧵', type: 'Cloth & Textiles' },
    { key: 'games', label: 'Games', icon: '🎲', type: 'Games' },
    { key: 'toiletries', label: 'Toiletries', icon: '🧴', type: 'Toiletries & Hygiene' },
    { key: 'food', label: 'Food', icon: '🍪', type: 'Food' },
    { key: 'merch', label: 'Merch', icon: '👕', type: '' }
  ];

  function categoryOf(item) {
    if (item.source === 'merch' || item.category === 'Merch') return CATEGORY_DEFS.find(c => c.key === 'merch');
    const def = CATEGORY_DEFS.find(c => c.type && sameName(c.type, item.type));
    if (def) return def;
    const label = String(item.type || '').trim() || 'Other';
    return { key: 'type:' + label.toLowerCase(), label, icon: '📦' };
  }

  // Equipment & event props come back (Borrow); supplies, sponsor goods and
  // merch don't (Use up).
  function defaultAction(item) {
    const kind = String(item.kind || '').toLowerCase();
    if (item.source === 'merch' || /suppl|sponsor/.test(kind) || item.source === 'consumable') return 'CONSUMING';
    return 'BORROWING';
  }

  const ACTIONS = {
    BORROWING: { label: 'Borrow', verb: 'Borrowed', hint: 'Bring it back after' },
    CONSUMING: { label: 'Use up', verb: 'Used up', hint: "Won't come back" },
    RESTOCKING: { label: 'Add stock', verb: 'Stock added', hint: 'Putting more in' }
  };

  // How many are actually in the org room right now (sheet count minus
  // what's borrowed). null = no number in the sheet ("*", blank).
  function availableQty(item) {
    if (item.qtyAvailable == null) return null;
    return Math.max(0, item.qtyAvailable - (item.out || 0));
  }

  function availabilityText(item) {
    const avail = availableQty(item);
    const unit = item.unit ? ' ' + item.unit : '';
    if (/^\*$/.test(String(item.qtyRaw || '').trim())) return 'Plenty in the org room';
    if (avail == null) return 'Count not recorded';
    if (item.out) return `${avail} of ${item.qtyAvailable}${unit} in the org room · ${item.out} out`;
    return `${avail}${unit} in the org room`;
  }

  // Problems worth flagging before someone takes an item.
  function itemWarnings(item, qty, action) {
    const w = [];
    if (action === 'RESTOCKING') return w;
    const avail = availableQty(item);
    if (/^missing$/i.test(item.status)) w.push('Marked Missing in the sheet');
    else if (/^out$/i.test(item.status) && !item.out) w.push('Marked Out in the sheet, so it may not be in the org room');
    if (avail != null && qty > avail) w.push(avail === 0 ? 'None left right now' : `Only ${avail} left`);
    if (item.expiry && new Date(item.expiry) < new Date()) w.push('Past its expiry date');
    return w;
  }

  /* ---------------- Inventory loading ----------------
     Shows the last saved copy straight away, then refreshes in the
     background (Apps Script can take a few seconds to answer). */
  let inventoryLoading = false;
  let inventorySyncedAt = 0;

  function readInventoryCache() {
    try { return JSON.parse(localStorage.getItem('cela_inventory_cache') || 'null'); } catch(e) { return null; }
  }

  function setSyncNote(text, busy) {
    const el = document.getElementById('catalog-sync');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('busy', !!busy);
  }

  function relativeTime(ts) {
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? hrs + ' hr ago' : new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function loadInventory(force) {
    if (!state.inventory.length) {
      const cache = readInventoryCache();
      if (cache && Array.isArray(cache.items) && cache.items.length) {
        state.inventory = cache.items;
        inventorySyncedAt = cache.syncedAt || 0;
      }
    }
    renderCategoryChips();
    renderDeptFilter();
    renderCatalog();
    // Don't refetch on every tab switch; 30s is fresh enough.
    if (inventoryLoading || (!force && Date.now() - inventorySyncedAt < 30000 && state.inventory.length)) return;
    inventoryLoading = true;
    setSyncNote(state.inventory.length ? 'Updating…' : '', true);
    google.script.run
      .withSuccessHandler(items => {
        inventoryLoading = false;
        if (Array.isArray(items) && items.length) {
          state.inventory = items;
          inventorySyncedAt = window.__celaInventoryDebugError ? inventorySyncedAt : Date.now();
          pruneCart();
        }
        setSyncNote(window.__celaInventoryDebugError ? 'Showing saved copy' : 'Updated ' + relativeTime(Date.now()));
        renderCategoryChips();
        renderDeptFilter();
        renderCatalog();
        if (state.view === 'cart') renderCart();
      })
      .withFailureHandler(err => {
        inventoryLoading = false;
        setSyncNote('Could not refresh');
        showToast(err.message || 'Could not load items', true);
      })
      .getInventory();
  }

  // Cart lines whose item vanished from the sheet are dropped; the rest get
  // the fresh item data (counts, status).
  function pruneCart() {
    let dropped = 0;
    Object.keys(state.cart).forEach(id => {
      const fresh = state.inventory.find(i => i.id === id);
      if (fresh) state.cart[id].item = fresh;
      else { delete state.cart[id]; dropped++; }
    });
    if (dropped) showToast(dropped + (dropped === 1 ? ' item was' : ' items were') + ' removed from your cart (no longer in the sheet)', true);
    saveCart();
    updateCartBadge();
  }

  function renderCategoryChips() {
    const row = document.getElementById('category-chip-row');
    if (!row) return;
    const counts = {};
    const defs = {};
    state.inventory.forEach(i => {
      const c = categoryOf(i);
      counts[c.key] = (counts[c.key] || 0) + 1;
      defs[c.key] = c;
    });
    const order = CATEGORY_DEFS.map(c => c.key);
    const keys = Object.keys(counts).sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || defs[a].label.localeCompare(defs[b].label);
    });
    if (!keys.length) { row.innerHTML = ''; return; }
    if (state.catalogCategory !== 'all' && !counts[state.catalogCategory]) state.catalogCategory = 'all';
    const chip = (key, label, icon, n) => `<button type="button" class="category-chip${state.catalogCategory === key ? ' active' : ''}" data-category="${escapeHtml(key)}" aria-pressed="${state.catalogCategory === key}">${icon ? `<span class="chip-icon" aria-hidden="true">${icon}</span>` : ''}${escapeHtml(label)}<span class="chip-n">${n}</span></button>`;
    row.innerHTML = chip('all', 'All', '', state.inventory.length) + keys.map(k => chip(k, defs[k].label, defs[k].icon, counts[k])).join('');
    row.querySelectorAll('.category-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        state.catalogCategory = btn.dataset.category;
        renderCategoryChips();
        renderCatalog();
      });
    });
  }

  function renderDeptFilter() {
    const sel = document.getElementById('catalog-dept');
    if (!sel) return;
    const depts = Array.from(new Set(state.inventory.map(i => i.category).filter(Boolean))).sort();
    if (state.catalogDept !== 'all' && !depts.includes(state.catalogDept)) state.catalogDept = 'all';
    sel.innerHTML = '<option value="all">All departments</option>' + depts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    sel.value = state.catalogDept;
  }

  function loadProjectOptions() {
    google.script.run
      .withSuccessHandler(options => {
        state.projectOptions = Array.isArray(options) ? options.filter(o => !/^personal$/i.test(o)) : [];
        renderActForSelects();
        const historySelect = document.getElementById('history-project-select');
        if (historySelect) {
          const keep = historySelect.value;
          historySelect.innerHTML = '<option value="">Choose a project or department</option>' +
            state.projectOptions.map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join('');
          if (keep) historySelect.value = keep;
        }
      })
      .withFailureHandler(() => {})
      .getProjectOptions();
  }

  function bindCatalogToggle() {
    document.getElementById('format-grid-btn').addEventListener('click', () => setCatalogFormat('grid'));
    document.getElementById('format-list-btn').addEventListener('click', () => setCatalogFormat('list'));

    const searchInput = document.getElementById('catalog-search');
    const clearBtn = document.getElementById('catalog-search-clear');
    let searchTimer = null;
    searchInput.addEventListener('input', (e) => {
      state.catalogSearch = e.target.value;
      clearBtn.style.display = e.target.value ? 'flex' : 'none';
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderCatalog, 120);
    });
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      state.catalogSearch = '';
      clearBtn.style.display = 'none';
      renderCatalog();
      searchInput.focus();
    });
    document.getElementById('catalog-sort').addEventListener('change', (e) => {
      state.catalogSort = e.target.value;
      renderCatalog();
    });
    document.getElementById('catalog-dept').addEventListener('change', (e) => {
      state.catalogDept = e.target.value;
      renderCatalog();
    });
    document.getElementById('catalog-container').addEventListener('click', (e) => {
      const cmd = e.target.closest('[data-cmd]');
      if (cmd) {
        if (cmd.dataset.cmd === 'reload-items') loadInventory(true);
        if (cmd.dataset.cmd === 'clear-filters') clearCatalogFilters();
        if (cmd.dataset.cmd === 'go-add') showView('add');
        return;
      }
      const card = e.target.closest('[data-item]');
      if (card) openItemSheet(card.dataset.item);
    });
  }

  function setCatalogFormat(format) {
    state.catalogFormat = format;
    document.getElementById('format-grid-btn').classList.toggle('active', format === 'grid');
    document.getElementById('format-list-btn').classList.toggle('active', format === 'list');
    document.getElementById('format-grid-btn').setAttribute('aria-pressed', format === 'grid');
    document.getElementById('format-list-btn').setAttribute('aria-pressed', format === 'list');
    renderCatalog();
  }

  function getVisibleInventory() {
    const q = state.catalogSearch.trim().toLowerCase();
    let items = state.inventory;
    if (state.catalogCategory && state.catalogCategory !== 'all') {
      items = items.filter(item => categoryOf(item).key === state.catalogCategory);
    }
    if (state.catalogDept && state.catalogDept !== 'all') {
      items = items.filter(item => item.category === state.catalogDept);
    }
    if (q) {
      const words = q.split(/\s+/).filter(Boolean);
      items = items.filter(item => {
        const haystack = [item.title, item.category, item.type, categoryOf(item).label, item.event, item.location, item.notes]
          .filter(Boolean).join(' ').toLowerCase();
        return words.every(w => haystack.includes(w));
      });
    }
    const sorted = items.slice();
    const order = CATEGORY_DEFS.map(c => c.key);
    const catIndex = i => { const k = order.indexOf(categoryOf(i).key); return k < 0 ? 99 : k; };
    if (state.catalogSort === 'name') {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    } else if (state.catalogSort === 'available') {
      const n = i => { const a = availableQty(i); return a == null ? 1e6 : a; };
      sorted.sort((a, b) => n(b) - n(a) || a.title.localeCompare(b.title));
    } else if (state.catalogSort === 'location') {
      sorted.sort((a, b) => (a.location || '~').localeCompare(b.location || '~') || a.title.localeCompare(b.title));
    } else {
      sorted.sort((a, b) => catIndex(a) - catIndex(b) || a.title.localeCompare(b.title));
    }
    return sorted;
  }

  function renderCatalogSkeleton(container) {
    const grid = state.catalogFormat === 'grid';
    container.className = grid ? 'item-grid' : 'item-list';
    const card = grid
      ? '<div class="item-card skeleton-card skeleton"><div class="skeleton-line w40"></div><div class="skeleton-line"></div><div class="skeleton-line w60"></div></div>'
      : '<div class="item-row skeleton-row skeleton"><div class="skeleton-lines"><div class="skeleton-line"></div><div class="skeleton-line w40"></div></div></div>';
    container.innerHTML = `<div style="grid-column:1/-1;">${loaderHtml('Getting the org room list… the first load can take a few seconds.')}</div>` + card.repeat(grid ? 6 : 4);
  }

  function renderCatalog() {
    const container = document.getElementById('catalog-container');
    if (!container) return;
    const countEl = document.getElementById('catalog-result-count');

    if (!state.inventory.length) {
      if (inventoryLoading || !inventorySyncedAt) { renderCatalogSkeleton(container); return; }
      container.className = 'item-list';
      container.innerHTML = '<div class="empty-state"><svg class="svg-icon" aria-hidden="true" focusable="false"><use href="#i-archive-box"/></svg>No items in the sheet yet.</div>';
      return;
    }

    const notice = window.__celaInventoryDebugError
      ? `<div class="notice warn" style="grid-column:1/-1;">Couldn't reach the inventory sheet. ${readInventoryCache() ? 'Showing the last saved copy.' : 'Showing sample items.'} <button type="button" class="text-link" data-cmd="reload-items">Try again</button></div>`
      : '';

    const visible = getVisibleInventory();
    const filtered = !!state.catalogSearch.trim() || state.catalogCategory !== 'all' || state.catalogDept !== 'all';
    if (countEl) countEl.textContent = filtered ? visible.length + (visible.length === 1 ? ' item' : ' items') : state.inventory.length + ' items · tap one for details';

    if (!visible.length) {
      container.className = 'item-list';
      container.innerHTML = notice + `
        <div class="empty-state">
          <img src="brand/ayi/ayi.png" alt="" class="empty-ayi" loading="lazy" decoding="async">
          Nothing matches${state.catalogSearch.trim() ? ' "' + escapeHtml(state.catalogSearch.trim()) + '"' : ''}.
          <button type="button" class="btn-secondary" style="margin-top:14px;max-width:220px;" data-cmd="clear-filters">Clear filters</button>
          <button type="button" class="text-link" style="margin-top:6px;" data-cmd="go-add">Not listed? Add it to the inventory</button>
        </div>`;
      return;
    }

    const grid = state.catalogFormat === 'grid';
    container.className = grid ? 'item-grid' : 'item-list';
    // Draw the first batch now and the rest as the person scrolls. A redraw
    // (e.g. the background refresh) keeps however many were already shown.
    const shown = container.querySelectorAll('[data-item]').length;
    const firstCount = Math.max(CATALOG_BATCH, shown);
    const firstBatch = visible.slice(0, firstCount);
    container.innerHTML = notice + firstBatch.map(item => catalogCardHtml(item, grid)).join('');
    lazyRenderRest(container, visible.slice(firstCount), grid);
  }

  function catalogCardHtml(item, grid) {
      const cat = categoryOf(item);
      const inCart = cartQty(item.id);
      const avail = availableQty(item);
      const none = avail === 0 && item.qtyAvailable != null;
      return grid ? `
        <button type="button" class="item-card${none ? ' is-none' : ''}" data-item="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)}, ${escapeHtml(availabilityText(item))}">
          <span class="item-card-top"><span class="item-cat"><span aria-hidden="true">${cat.icon}</span> ${escapeHtml(cat.label)}</span>${inCart ? `<span class="in-cart-dot" title="In your cart">${inCart}</span>` : ''}</span>
          <span class="item-title">${escapeHtml(item.title)}</span>
          <span class="item-qty">${escapeHtml(item.qtyDisplay)}${itemBadges(item)}</span>
          <span class="item-foot"><span class="dept-tag">${escapeHtml(item.category)}</span>${locationLine(item.location)}</span>
        </button>` : `
        <button type="button" class="item-row${none ? ' is-none' : ''}" data-item="${escapeHtml(item.id)}">
          <span class="row-icon" aria-hidden="true">${cat.icon}</span>
          <span class="item-info">
            <span class="item-title">${escapeHtml(item.title)}${itemBadges(item)}</span>
            <span class="item-qty"><span class="dept-tag">${escapeHtml(item.category)}</span> ${escapeHtml(item.qtyDisplay)}</span>
            ${locationLine(item.location)}
          </span>
          ${inCart ? `<span class="in-cart-badge">${inCart} in cart</span>` : '<span class="row-chev" aria-hidden="true">›</span>'}
        </button>`;
  }

  const CATALOG_BATCH = 30;
  let catalogObserver = null;
  function lazyRenderRest(container, rest, grid) {
    if (catalogObserver) { catalogObserver.disconnect(); catalogObserver = null; }
    if (!rest.length) return;
    const sentinel = document.createElement('div');
    sentinel.className = 'catalog-sentinel';
    sentinel.style.gridColumn = '1 / -1';
    container.appendChild(sentinel);
    const drawNext = () => {
      const batch = rest.splice(0, CATALOG_BATCH);
      const tmp = document.createElement('div');
      tmp.innerHTML = batch.map(item => catalogCardHtml(item, grid)).join('');
      while (tmp.firstChild) container.insertBefore(tmp.firstChild, sentinel);
      if (!rest.length) { sentinel.remove(); if (catalogObserver) catalogObserver.disconnect(); }
    };
    if (!('IntersectionObserver' in window)) { while (rest.length) drawNext(); return; }
    catalogObserver = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) drawNext(); }, { rootMargin: '600px 0px' });
    catalogObserver.observe(sentinel);
  }

  function clearCatalogFilters() {
    state.catalogSearch = '';
    state.catalogCategory = 'all';
    state.catalogDept = 'all';
    const searchInput = document.getElementById('catalog-search');
    const clearBtn = document.getElementById('catalog-search-clear');
    if (searchInput) searchInput.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    renderCategoryChips();
    renderDeptFilter();
    renderCatalog();
  }

  function itemBadges(item) {
    const badges = [];
    const avail = availableQty(item);
    if (item.out) badges.push(`<span class="out-badge">${item.out} out</span>`);
    if (avail === 0 && item.qtyAvailable != null) badges.push('<span class="out-badge none">None left</span>');
    if (/^(out|missing)$/i.test(item.status) && !item.out) badges.push(`<span class="out-badge status">${escapeHtml(item.status)}</span>`);
    if (item.expiry) {
      const days = Math.round((new Date(item.expiry) - new Date()) / 86400000);
      const label = days < 0 ? 'Expired' : (days <= 14 ? 'Exp. ' + shortDate(item.expiry) : '');
      if (label) badges.push(`<span class="out-badge expiry">${label}</span>`);
    }
    return badges.length ? ' ' + badges.join(' ') : '';
  }

  /* ---------------- Item detail sheet ---------------- */
  const sheetState = { id: null, qty: 1, action: 'BORROWING' };

  function openItemSheet(itemId) {
    const item = state.inventory.find(i => i.id === itemId);
    if (!item) return;
    const line = state.cart[itemId];
    sheetState.id = itemId;
    sheetState.qty = line ? line.qty : 1;
    sheetState.action = line ? line.action : defaultAction(item);
    renderItemSheet();
    const sheet = document.getElementById('item-sheet');
    sheet.classList.add('show');
    sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('sheet-open');
    setTimeout(() => { const b = document.getElementById('sheet-add'); if (b) b.focus(); }, 50);
  }

  function closeItemSheet() {
    const sheet = document.getElementById('item-sheet');
    if (!sheet || !sheet.classList.contains('show')) return;
    sheet.classList.remove('show');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('sheet-open');
  }

  function renderItemSheet() {
    const item = state.inventory.find(i => i.id === sheetState.id);
    if (!item) return closeItemSheet();
    const cat = categoryOf(item);
    const inCart = !!state.cart[item.id];
    const warnings = itemWarnings(item, sheetState.qty, sheetState.action);
    const where = [item.location, item.spot && item.spot !== item.location ? item.spot : ''].filter(Boolean).join(' · ');
    document.getElementById('sheet-body').innerHTML = `
      <div class="sheet-eyebrow"><span aria-hidden="true">${cat.icon}</span> ${escapeHtml(cat.label)} · ${escapeHtml(item.category)}${item.kind ? ' · ' + escapeHtml(item.kind) : ''}</div>
      <h3 class="sheet-title" id="sheet-title">${escapeHtml(item.title)}</h3>
      <div class="sheet-avail${availableQty(item) === 0 && item.qtyAvailable != null ? ' none' : ''}">${escapeHtml(availabilityText(item))}</div>
      <dl class="sheet-facts">
        <div><dt>Where</dt><dd>${locationLine(item.location)}${item.spot && item.spot !== item.location ? `<div class="sheet-spot">${escapeHtml(item.spot)}</div>` : ''}</dd></div>
        ${item.event ? `<div><dt>Event</dt><dd>${escapeHtml(item.event)}</dd></div>` : ''}
        ${item.expiry ? `<div><dt>Expires</dt><dd>${new Date(item.expiry).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</dd></div>` : ''}
      </dl>
      ${item.sheetNotes ? `<div class="sheet-notes"><b>Notes</b><br>${escapeHtml(item.sheetNotes)}</div>` : ''}
      <div class="field-label" style="margin-top:14px;">What are you doing?</div>
      <div class="seg-control" role="radiogroup" aria-label="Action">
        ${Object.keys(ACTIONS).map(a => `<button type="button" role="radio" aria-checked="${sheetState.action === a}" class="${sheetState.action === a ? 'active' : ''}" data-action="${a}">${ACTIONS[a].label}<small>${ACTIONS[a].hint}</small></button>`).join('')}
      </div>
      <div class="sheet-qty-row">
        <span class="field-label" style="margin:0;">How many?</span>
        <div class="qty-stepper">
          <button type="button" class="qty-btn" data-step="-1" aria-label="Fewer" ${sheetState.qty <= 1 ? 'disabled' : ''}><svg class="svg-icon" aria-hidden="true" focusable="false"><use href="#i-minus"/></svg></button>
          <input type="number" min="1" max="9999" inputmode="numeric" id="sheet-qty" value="${sheetState.qty}" aria-label="Quantity">
          <button type="button" class="qty-btn" data-step="1" aria-label="More"><svg class="svg-icon" aria-hidden="true" focusable="false"><use href="#i-plus"/></svg></button>
        </div>
      </div>
      ${warnings.length ? `<div class="notice warn">${warnings.map(escapeHtml).join('<br>')}${sheetState.action !== 'RESTOCKING' ? '<br><span class="notice-sub">You can still request it. Check with the department first.</span>' : ''}</div>` : ''}
      <button type="button" class="btn-primary" id="sheet-add">${inCart ? 'UPDATE CART' : 'ADD TO CART'}</button>
      ${inCart ? '<button type="button" class="btn-secondary" id="sheet-remove">Remove from cart</button>' : ''}`;

    const body = document.getElementById('sheet-body');
    body.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => { sheetState.action = b.dataset.action; renderItemSheet(); }));
    body.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
      sheetState.qty = clampQty(sheetState.qty + Number(b.dataset.step));
      renderItemSheet();
    }));
    const qtyInput = document.getElementById('sheet-qty');
    qtyInput.addEventListener('change', () => { sheetState.qty = clampQty(qtyInput.value); renderItemSheet(); });
    document.getElementById('sheet-add').addEventListener('click', () => {
      sheetState.qty = clampQty(document.getElementById('sheet-qty').value);
      state.cart[item.id] = { item, qty: sheetState.qty, action: sheetState.action };
      saveCart();
      updateCartBadge();
      closeItemSheet();
      renderCatalog();
      showToast(`${item.title} × ${sheetState.qty} · ${ACTIONS[sheetState.action].label}`, false, { label: 'View cart', onClick: () => showView('cart') });
    });
    const rm = document.getElementById('sheet-remove');
    if (rm) rm.addEventListener('click', () => { removeFromCart(item.id); closeItemSheet(); renderCatalog(); });
  }

  function clampQty(v) {
    const n = parseInt(v, 10);
    return Math.min(9999, Math.max(1, isNaN(n) ? 1 : n));
  }

  /* ---------------- Cart ----------------
     { itemId: { item, qty, action } } — kept in localStorage so a reload or
     an accidental close doesn't lose it. */
  const CART_KEY = 'cela_cart_v2';

  function saveCart() {
    try {
      const slim = {};
      Object.keys(state.cart).forEach(id => { slim[id] = { qty: state.cart[id].qty, action: state.cart[id].action, item: state.cart[id].item }; });
      localStorage.setItem(CART_KEY, JSON.stringify(slim));
    } catch(e) {}
  }

  function restoreCart() {
    try {
      const saved = JSON.parse(localStorage.getItem(CART_KEY) || '{}');
      Object.keys(saved).forEach(id => {
        const line = saved[id];
        if (line && line.item && ACTIONS[line.action]) state.cart[id] = { item: line.item, qty: clampQty(line.qty), action: line.action };
      });
    } catch(e) {}
  }

  function cartQty(itemId) {
    return state.cart[itemId] ? state.cart[itemId].qty : 0;
  }

  function removeFromCart(itemId) {
    const line = state.cart[itemId];
    if (!line) return;
    delete state.cart[itemId];
    saveCart();
    updateCartBadge();
    if (state.view === 'cart') renderCart();
    showToast(line.item.title + ' removed', false, { label: 'Undo', onClick: () => {
      state.cart[itemId] = line; saveCart(); updateCartBadge(); if (state.view === 'cart') renderCart(); renderCatalog();
    } });
  }

  function updateCartBadge() {
    const count = Object.keys(state.cart).length;
    [document.getElementById('cart-badge'), document.getElementById('nav-cart-badge')].forEach(badge => {
      if (!badge) return;
      badge.textContent = count;
      badge.style.display = count > 0 ? 'flex' : 'none';
    });
  }

  function renderCart() {
    const container = document.getElementById('cart-list');
    const summary = document.getElementById('cart-summary');
    const entries = Object.values(state.cart);
    const checkoutBtn = document.getElementById('cart-checkout-btn');

    if (!entries.length) {
      container.innerHTML = `<div class="empty-state"><img src="brand/ayi/ayi.png" alt="" class="empty-ayi" loading="lazy" decoding="async">Your cart is empty.<br><span class="muted">Tap an item in Items to add it.</span></div>`;
      summary.innerHTML = '';
      checkoutBtn.disabled = true;
      return;
    }
    checkoutBtn.disabled = false;

    container.innerHTML = entries.map(({ item, qty, action }) => {
      const warnings = itemWarnings(item, qty, action);
      return `
      <div class="cart-line" data-line="${escapeHtml(item.id)}">
        <div class="cart-line-top">
          <div class="item-info">
            <div class="item-title">${escapeHtml(item.title)}</div>
            <div class="item-qty"><span class="dept-tag">${escapeHtml(item.category)}</span> ${escapeHtml(availabilityText(item))}</div>
          </div>
          <button type="button" class="cart-remove" data-remove aria-label="Remove ${escapeHtml(item.title)}">×</button>
        </div>
        <div class="cart-line-controls">
          <div class="seg-control small" role="radiogroup" aria-label="Action for ${escapeHtml(item.title)}">
            ${Object.keys(ACTIONS).map(a => `<button type="button" role="radio" aria-checked="${action === a}" class="${action === a ? 'active' : ''}" data-action="${a}">${ACTIONS[a].label}</button>`).join('')}
          </div>
          <div class="qty-stepper">
            <button type="button" class="qty-btn" data-step="-1" aria-label="Fewer" ${qty <= 1 ? 'disabled' : ''}><svg class="svg-icon" aria-hidden="true" focusable="false"><use href="#i-minus"/></svg></button>
            <input type="number" min="1" max="9999" inputmode="numeric" value="${qty}" aria-label="Quantity" data-qty>
            <button type="button" class="qty-btn" data-step="1" aria-label="More"><svg class="svg-icon" aria-hidden="true" focusable="false"><use href="#i-plus"/></svg></button>
          </div>
        </div>
        ${warnings.length ? `<div class="cart-warn">⚠ ${warnings.map(escapeHtml).join(' · ')}</div>` : ''}
      </div>`;
    }).join('');

    const counts = {};
    entries.forEach(e => { counts[e.action] = (counts[e.action] || 0) + 1; });
    summary.innerHTML = `<div class="cart-summary">${Object.keys(ACTIONS).filter(a => counts[a]).map(a => `<span><b>${counts[a]}</b> to ${ACTIONS[a].label.toLowerCase()}</span>`).join('')}</div>`;

    container.querySelectorAll('.cart-line').forEach(el => {
      const id = el.dataset.line;
      const line = state.cart[id];
      el.querySelector('[data-remove]').addEventListener('click', () => removeFromCart(id));
      el.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => { line.action = b.dataset.action; saveCart(); renderCart(); }));
      el.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => { line.qty = clampQty(line.qty + Number(b.dataset.step)); saveCart(); renderCart(); }));
      el.querySelector('[data-qty]').addEventListener('change', e => { line.qty = clampQty(e.target.value); saveCart(); renderCart(); });
    });
  }

  /* ---------------- Checkout ---------------- */
  function renderCheckout() {
    const entries = Object.values(state.cart);
    if (!entries.length) { showView('cart'); return; }
    const who = state.lastId || {};
    document.getElementById('checkout-who').innerHTML =
      `<img src="${ayiFor(who.committee)}" alt="" loading="lazy" decoding="async"><div><div class="muted">Logged in as</div><b>${escapeHtml(who.name || 'Member')}</b> <span class="muted">${escapeHtml(who.idNumber || '')}${who.committee ? ' · ' + escapeHtml(who.committee) : ''}</span></div>`;
    renderActForSelects();

    const groups = groupCart(entries);
    document.getElementById('checkout-summary').innerHTML = groups.map(g => `
      <div class="checkout-group">
        <div class="checkout-group-head">${ACTIONS[g.action].label} <span class="muted">· ${g.action === 'BORROWING' ? 'due date is set when you submit' : ACTIONS[g.action].hint.toLowerCase()}</span></div>
        ${g.lines.map(l => `<div class="checkout-row"><span>${escapeHtml(l.item.title)}</span><b>× ${l.qty}</b></div>`).join('')}
      </div>`).join('');

    const warnLines = entries.map(l => ({ l, w: itemWarnings(l.item, l.qty, l.action) })).filter(x => x.w.length);
    document.getElementById('checkout-warnings').innerHTML = warnLines.length
      ? `<div class="notice warn"><b>Heads up</b><br>${warnLines.map(x => escapeHtml(x.l.item.title) + ': ' + x.w.map(escapeHtml).join(', ')).join('<br>')}<br><span class="notice-sub">You can still submit. Please check with the department.</span></div>`
      : '';
    const btn = document.getElementById('submit-order-btn');
    btn.textContent = groups.length > 1 ? `SUBMIT (${groups.length} REQUESTS)` : 'SUBMIT';
  }

  function groupCart(entries) {
    return Object.keys(ACTIONS).map(action => ({ action, lines: entries.filter(e => e.action === action) })).filter(g => g.lines.length);
  }

  function bindCheckoutForm() {
    document.getElementById('submit-order-btn').addEventListener('click', submitOrder);
    document.getElementById('checkout-back-btn').addEventListener('click', () => showView('cart'));
    document.getElementById('cart-checkout-btn').addEventListener('click', () => showView('checkout'));
    document.getElementById('cart-more-btn').addEventListener('click', () => showView('catalog'));
    document.getElementById('done-home-btn').addEventListener('click', () => showView('home'));
    document.getElementById('done-more-btn').addEventListener('click', () => showView('catalog'));
    document.getElementById('sheet-close').addEventListener('click', closeItemSheet);
    document.getElementById('item-sheet').addEventListener('click', e => { if (e.target.id === 'item-sheet') closeItemSheet(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeItemSheet(); });
  }

  let submitting = false;
  async function submitOrder() {
    if (submitting) return; // no double submits
    const entries = Object.values(state.cart);
    if (!state.lastId || !state.lastId.idNumber) { showToast('Log in with your ID number first', true); showView('login'); return; }
    if (!entries.length) { showToast('Your cart is empty', true); return; }
    const project = document.getElementById('project-select').value;
    if (!project) { showToast('Choose the project or department this is for', true); return; }
    const committee = document.getElementById('committee-input').value.trim().slice(0, 120);

    submitting = true;
    const btn = document.getElementById('submit-order-btn');
    btn.disabled = true;
    btn.innerHTML = BUSY_DOTS + ' SUBMITTING';

    const results = [];
    for (const g of groupCart(entries)) {
      const payload = {
        idNumber: state.lastId.idNumber,
        caseType: g.action,
        actingAs: project,
        project: project,
        committee: committee,
        items: g.lines.map(({ item, qty }) => ({ id: item.id, ref: item.id, title: item.title, qty, location: item.location || '' }))
      };
      try {
        const result = await new Promise((resolve, reject) => {
          google.script.run.withSuccessHandler(resolve).withFailureHandler(reject).submitOrder(payload);
        });
        results.push({ group: g, ok: true, queued: !!(result && result.queued), due: result && result.due, warnings: (result && result.warnings) || [] });
        g.lines.forEach(l => delete state.cart[l.item.id]); // only clear what went through
      } catch(err) {
        results.push({ group: g, ok: false, error: err.message || 'Could not submit' });
      }
    }
    saveCart();
    updateCartBadge();
    submitting = false;
    btn.disabled = false;
    btn.textContent = 'SUBMIT';
    inventorySyncedAt = 0; // counts changed — refresh next time Items opens
    renderDone(results, project);
  }

  function renderDone(results, project) {
    const failed = results.filter(r => !r.ok);
    const queued = results.filter(r => r.ok && r.queued);
    document.getElementById('done-ayi').src = ayiFor(project);
    document.getElementById('done-title').textContent = failed.length === results.length ? 'Not sent' : (failed.length ? 'Partly sent' : (queued.length ? 'Saved on this phone' : 'All set!'));
    document.getElementById('done-sub').textContent = queued.length
      ? "You're offline. It will send by itself when you're back online."
      : 'Logged for ' + project + '.';
    document.getElementById('done-body').innerHTML = results.map(r => {
      const g = r.group;
      const due = r.due ? new Date(r.due) : null;
      const head = r.ok
        ? `${ACTIONS[g.action].verb}${g.action === 'BORROWING' && due && !isNaN(due) ? ` · <span class="due">return by ${due.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>` : ''}`
        : `Couldn't ${ACTIONS[g.action].label.toLowerCase()}: ${escapeHtml(r.error)}`;
      return `<div class="done-group${r.ok ? '' : ' failed'}">
        <div class="done-group-head">${head}</div>
        ${g.lines.map(l => `<div class="checkout-row"><span>${escapeHtml(l.item.title)}</span><b>× ${l.qty}</b></div>`).join('')}
        ${r.warnings && r.warnings.length ? `<div class="cart-warn">⚠ ${r.warnings.map(escapeHtml).join('<br>')}</div>` : ''}
      </div>`;
    }).join('') + (failed.length ? '<div class="notice warn">The items that didn\'t go through are still in your cart.</div>' : '');
    showView('done');
  }

  /* ---------------- Contacts (shared by the Help view and the Contact modal) ----------------
     Single source of truth so editing the team roster only ever means
     touching one array instead of two identical hand-written HTML blocks. */
  // TODO: replace with Celadon's inventory point people before launch.
  // Leave telegram blank ('') to hide that button for a person.
  const CONTACTS = [
    { name: 'Ateneo Celadon', role: 'Official page', messenger: 'https://m.me/celadonateneo', telegram: '' }
  ];

  function contactRowHtml(c) {
    return `
      <div class="contact-row">
        <div class="contact-info">
          <div class="contact-name">${escapeHtml(c.name)}</div>
          <div class="contact-role">${escapeHtml(c.role)}</div>
        </div>
        <div class="contact-btn-group">
          <a class="contact-icon-btn" href="${escapeHtml(c.messenger)}" target="_blank" rel="noopener" title="Message ${escapeHtml(c.name)} on Messenger" aria-label="Message ${escapeHtml(c.name)} on Messenger"><svg class="svg-icon" aria-hidden="true" focusable="false"><use href="#i-messenger"/></svg></a>
          ${c.telegram ? `<a class="contact-icon-btn" href="${escapeHtml(c.telegram)}" target="_blank" rel="noopener" title="Message ${escapeHtml(c.name)} on Telegram" aria-label="Message ${escapeHtml(c.name)} on Telegram"><svg class="svg-icon" aria-hidden="true" focusable="false"><use href="#i-telegram"/></svg></a>` : ''}
        </div>
      </div>`;
  }

  function renderContacts() {
    const html = CONTACTS.map(contactRowHtml).join('');
    const help = document.getElementById('help-contact-list');
    const modal = document.getElementById('modal-contact-list');
    if (help) help.innerHTML = html;
    if (modal) modal.innerHTML = html;
  }

  /* ---------------- Contact modal ---------------- */

  function bindModal() {
    document.getElementById('modal-close-btn').addEventListener('click', () => toggleModal(false));
    document.getElementById('modal-backdrop').addEventListener('click', e => {
      if (e.target.id === 'modal-backdrop') toggleModal(false);
    });
  }

  function toggleModal(show) {
    document.getElementById('modal-backdrop').classList.toggle('show', show);
  }

  /* ---------------- Install App (PWA) ---------------- */

  let deferredInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    maybeShowInstallBanner();
  });

  window.addEventListener('appinstalled', () => {
    showToast('Celadon app installed!');
    hideInstallBanner();
  });

  async function triggerInstall() {
    if (!deferredInstallPrompt) {
      showToast('App may already be installed, or your browser doesn\'t support installing yet');
      return;
    }
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      showToast('Installing Celadon app…');
      hideInstallBanner();
    }
    deferredInstallPrompt = null;
  }

  /* ---------------- Install banner ----------------
     Mobile-only prompt encouraging people to add the app to their home
     screen. Android/Chrome gets a real "Install" button wired to the
     captured beforeinstallprompt event; iOS Safari never fires that event
     at all, so it gets instructions instead (Add to Home Screen is a
     manual step there with no programmatic trigger). Dismissing snoozes
     the banner for 14 days rather than hiding it forever, since people
     often dismiss the first time they see anything new. */
  const INSTALL_DISMISS_KEY = 'cela_install_banner_dismissed_at';
  const INSTALL_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

  function isStandalonePwa() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }
  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  }
  function isMobileViewport() {
    return window.matchMedia('(max-width: 767px)').matches;
  }
  function wasInstallBannerRecentlyDismissed() {
    try {
      const at = parseInt(localStorage.getItem(INSTALL_DISMISS_KEY) || '0', 10);
      return at && (Date.now() - at) < INSTALL_SNOOZE_MS;
    } catch(e) { return false; }
  }

  function maybeShowInstallBanner() {
    if (!isMobileViewport() || isStandalonePwa() || wasInstallBannerRecentlyDismissed()) return;
    const ios = isIOS();
    if (!ios && !deferredInstallPrompt) return; // Android/Chrome with nothing to prompt yet
    const banner = document.getElementById('install-banner');
    if (!banner) return;

    document.getElementById('install-banner-btn').style.display = ios ? 'none' : '';
    document.getElementById('install-banner-steps').style.display = ios ? 'flex' : 'none';
    document.getElementById('install-banner-sub').textContent = ios
      ? 'Add it to your home screen for quick, full-screen access.'
      : 'Add it to your home screen for a faster, full-screen experience.';
    banner.classList.add('show');
  }

  function hideInstallBanner() {
    const banner = document.getElementById('install-banner');
    if (banner) banner.classList.remove('show');
  }

  function dismissInstallBanner() {
    try { localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now())); } catch(e) {}
    hideInstallBanner();
  }

  function bindInstallBanner() {
    const btn = document.getElementById('install-banner-btn');
    const dismiss = document.getElementById('install-banner-dismiss');
    if (btn) btn.addEventListener('click', () => triggerInstall());
    if (dismiss) dismiss.addEventListener('click', dismissInstallBanner);

    // iOS never fires beforeinstallprompt, so it's the only case checked
    // eagerly on load; Android waits for that event (handled above).
    if (isIOS()) setTimeout(maybeShowInstallBanner, 1200);
  }

  /* ---------------- Toast ---------------- */

  let toastTimer = null;
  function showToast(message, isError, action) {
    const toast = document.getElementById('toast');
    toast.innerHTML = '';
    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);
    if (action && action.label) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.textContent = action.label;
      b.addEventListener('click', () => { toast.classList.remove('show'); action.onClick(); });
      toast.appendChild(b);
    }
    toast.classList.toggle('error', !!isError);
    toast.classList.toggle('has-action', !!(action && action.label));
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), action ? 4500 : (isError ? 4000 : 2400));
  }


  /* ---------------- Utils ---------------- */

  // A curated set of colors that all sit comfortably on the app's dark navy
  // background and stay readable with white text — used to give every
  // distinct storage location its own consistent, recognizable color.
  // Leans on Celadon's site accents (jade, crimson, gold).
  const LOCATION_PALETTE = [
    '#3d5a96', '#579782', '#970708', '#b2620e', '#6b4fa0',
    '#2a7d9d', '#9d3f6b', '#5c7a2a', '#8a6a0b', '#4a4a9d',
    '#1b6b5a', '#a04a2a'
  ];

  function locationColor(location) {
    if (!location) return '#3a4560'; // neutral slate for unassigned items
    let hash = 0;
    for (let i = 0; i < location.length; i++) {
      hash = (hash * 31 + location.charCodeAt(i)) >>> 0;
    }
    return LOCATION_PALETTE[hash % LOCATION_PALETTE.length];
  }

  // Where an item lives: a quiet line with a colour dot, so the item name
  // stays the focus of each card.
  function locationLine(location) {
    const text = location && location.trim() ? location.trim() : 'Location not recorded';
    return `<span class="item-loc" title="${escapeHtml(text)}"><span class="loc-dot" style="background:${locationColor(location)}"></span>${escapeHtml(text)}</span>`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }
  // Attribute values are always double-quoted, so full HTML escaping is what's needed.
  function escapeAttr(str) {
    return escapeHtml(str);
  }

