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
      return demoInventory;
    }

    async function fetchLiveInventory() {
      window.__celaInventoryDebugError = null;
      const url = getCelaInventoryScriptUrl();
      if (!url) {
        showInventoryDebug('No Inventory Script URL configured yet.\n\nGo to Home > Settings > paste your Inventory Apps Script URL into the "Inventory Script URL" field > Save.');
        return demoInventory; // not configured yet — safe fallback
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
        showInventoryDebug('Got a response, but it wasn\'t valid JSON (likely an HTML error page from Apps Script).\n\nFirst 400 characters of the response:\n\n' + text.substring(0, 400));
        return demoInventory;
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
            category: item.category || 'General',
            type: item.type || '',
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
      showInventoryDebug('Script responded but reported an error:\n\n' + errMsg + '\n\nFull response:\n' + JSON.stringify(json, null, 2));
      return demoInventory;
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

    function savePendingOrders(list) {
      try { localStorage.setItem(PENDING_ORDERS_KEY, JSON.stringify(list)); } catch(e) {}
      updateOrderSyncPill();
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
      savePendingOrders(list);
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
          const remaining = getPendingOrders();
          remaining.shift();
          savePendingOrders(remaining);
        } catch(err) {
          // One permanently-failing order (bad data, a removed sheet) would
          // otherwise block every order behind it forever — after
          // MAX_ORDER_ATTEMPTS it moves to a "failed" bucket instead, and
          // the queue keeps moving.
          const remaining = getPendingOrders();
          if (remaining.length && remaining[0].clientId === item.clientId) {
            remaining[0].attempts = (remaining[0].attempts || 0) + 1;
            if (remaining[0].attempts >= MAX_ORDER_ATTEMPTS) {
              const failedItem = remaining.shift();
              const failedQ = getFailedOrders();
              failedQ.push(failedItem);
              saveFailedOrders(failedQ);
              savePendingOrders(remaining);
              continue;
            }
            savePendingOrders(remaining);
          }
          break; // still within retry budget — stop, keep it queued, try again later
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
      'OP', 'COMMPUB', 'CUL', 'EXREL', 'FIN', 'HR', 'OSR', 'General',
      // Projects (same names as the Inventory tab's Event column)
      'Recruitment Week and Welcome Week', 'Celadon Merchandise', 'General Assembly',
      'Mid-Autumn Festival', 'Lunar Lotus Market', 'TALAB x Faculty Appreciation Week',
      'Jade Business Summit', 'Leadership Development Program', 'Celadon Rose Sale',
      'Chinese New Year', 'Spring Film Festival', 'Binondo Amazing Race',
      'Mandopop Music Festival', 'Celadon Ball'
    ];

    async function fetchLiveProjects() {
      const url = getCelaInventoryScriptUrl();
      if (!url || !navigator.onLine) return PROJECT_OPTIONS.slice();
      try {
        const res = await fetch(url + '?action=projects');
        const json = await res.json();
        if (json && json.ok && Array.isArray(json.projects) && json.projects.length) {
          return json.projects;
        }
      } catch(e) {}
      return PROJECT_OPTIONS.slice();
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
        // Always keep a full local history — this never fails, regardless
        // of network state, so an order is never silently lost.
        const orders = JSON.parse(localStorage.getItem('cela_inventory_orders') || '[]');
        orders.unshift({ ...payload, createdAt: new Date().toISOString() });
        localStorage.setItem('cela_inventory_orders', JSON.stringify(orders));

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
          return { success: true, queued: false, orderId: 'ORD-' + Date.now(), logged: json.logged };
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
    catalogCategory: 'all',  // 'all' or one of the sheet's own Category values
    inventory: [],
    cart: {},                // { itemId: { item, qty } }
    scanLog: [],             // { idNumber, status, time }
    lastId: null,            // logged-in ID lookup result: { idNumber, name, role, committee, status }
    projectOptions: [],
    historyTab: 'personal',  // personal | project
    checkoutCase: 'BORROWING', // BORROWING | CONSUMING | RETURNING
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
      return { found: false, idNumber: String(idNumber).trim(), name: '', level: 'NONE', status: 'ERROR' };
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
    bindMainNav();
    bindSidebarLogout();
    bindLogin();
    bindHome();
    bindSettings();
    bindHeaderActions();
    bindCatalogToggle();
    bindCheckoutForm();
    bindModal();
    bindInstallBanner();
    renderContacts();

    loadInventory();
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
    } else {
      showView('login');
    }

    if (window.updateOrderSyncPill) window.updateOrderSyncPill();
    if (navigator.onLine && window.flushPendingOrders) window.flushPendingOrders();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    }
  });

  /* ---------------- Navigation ---------------- */

  function bindNav() {
    document.querySelectorAll('#bottom-nav .nav-btn').forEach(btn => {
      btn.addEventListener('click', () => showView(btn.dataset.view));
    });
  }

  function bindMainNav() {
    document.querySelectorAll('#bottom-nav-main .nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (state.view === 'history' && (btn.id === 'nav-slot-2' || btn.id === 'nav-slot-3')) {
          setHistoryTab(btn.id === 'nav-slot-2' ? 'personal' : 'project');
          return;
        }
        showView(btn.dataset.mainview);
      });
    });
  }

  // The pinned "Log out" at the bottom of the desktop sidebar — present in
  // both nav bars since either one can be the active sidebar at a time.
  function bindSidebarLogout() {
    document.querySelectorAll('.sidebar-logout-link').forEach(link => {
      link.addEventListener('click', performLogout);
    });
  }

  // Views that use the Celadon identity header + the Home/Settings/Help
  // bottom nav instead of the standard app header + Catalog/Cart/Checkout nav.
  const MAIN_VIEWS = ['home', 'settings', 'help', 'history', 'out'];

  function showView(view) {
    state.view = view;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('view-' + view).classList.add('active');

    const navBtn = document.querySelector('.nav-btn[data-view="' + view + '"]') ||
                   document.querySelector('.nav-btn[data-mainview="' + view + '"]');
    if (navBtn) navBtn.classList.add('active');

    const isMain = MAIN_VIEWS.includes(view);
    const isLogin = view === 'login';

    // The desktop sidebar is hidden on the login screen. Keep the wide-screen
    // content centered in the viewport until the sidebar is actually visible.
    document.body.classList.toggle('has-desktop-sidebar', !isLogin);

    // Login/Home/Settings/Help/History all use their own top brand block —
    // hide the shared app chrome so it isn't duplicated. Catalog/Cart/
    // Checkout share the standard header + bottom nav.
    document.getElementById('app-header').style.display = (isMain || isLogin) ? 'none' : 'flex';
    document.getElementById('bottom-nav').style.display = (isMain || isLogin) ? 'none' : 'flex';
    document.getElementById('bottom-nav-main').style.display = isMain ? 'flex' : 'none';
    document.getElementById('cart-icon-btn').style.display = view === 'catalog' ? 'flex' : 'none';
    document.getElementById('contact-icon-btn').style.display = view === 'catalog' ? 'flex' : 'none';

    // History repurposes the Settings/Help nav slots as Personal/Project —
    // relabel them here, and restore the defaults for every other view.
    applyMainNavForView(view);

    if (view === 'settings') {
      document.getElementById('settings-inventory-url').value = getInventoryScriptUrl();
      const tokenInput = document.getElementById('settings-inventory-token');
      if (tokenInput) tokenInput.value = getInventoryToken();
    }
    if (view === 'history') setHistoryTab('personal');
    if (view === 'out') renderOut();
    if (view === 'home') refreshHomeData();
    if (view === 'cart') renderCart();
    if (view === 'checkout') renderCheckout();
    if (view === 'catalog') loadInventory();
  }

  // ── History view's Personal/Project tabs ──
  // The History view reuses the Home/Settings/Help bottom nav's slots 2 & 3
  // (normally Settings/Help) as Personal/Project instead, per the design —
  // rather than a fourth, separate nav bar.
  const NAV_SLOT_DEFAULT = {
    2: '<span class="nav-emoji"><img class="svg-icon nav-svg-icon" src="icons/ui/cog.svg" alt=""></span>Settings',
    3: '<span class="nav-emoji"><img class="svg-icon nav-svg-icon" src="icons/ui/contact.svg" alt=""></span>Help'
  };
  const NAV_SLOT_HISTORY = {
    2: '<span class="nav-emoji"><img class="svg-icon nav-svg-icon" src="icons/ui/user.svg" alt=""></span>Personal',
    3: '<span class="nav-emoji"><img class="svg-icon nav-svg-icon" src="icons/ui/folder.svg" alt=""></span>Project'
  };

  function applyMainNavForView(view) {
    const slot2 = document.getElementById('nav-slot-2');
    const slot3 = document.getElementById('nav-slot-3');
    if (!slot2 || !slot3) return;
    const map = view === 'history' ? NAV_SLOT_HISTORY : NAV_SLOT_DEFAULT;
    slot2.innerHTML = map[2];
    slot3.innerHTML = map[3];
  }

  function setHistoryTab(tab) {
    state.historyTab = tab;

    const slot2 = document.getElementById('nav-slot-2');
    const slot3 = document.getElementById('nav-slot-3');
    const homeSlot = document.querySelector('#bottom-nav-main .nav-btn[data-mainview="home"]');
    [homeSlot, slot2, slot3].forEach(b => b && b.classList.remove('active'));
    if (tab === 'project') {
      slot3.classList.add('active');
    } else {
      slot2.classList.add('active');
    }

    const projectSelect = document.getElementById('history-project-select');
    if (projectSelect) {
      projectSelect.style.display = tab === 'project' ? '' : 'none';
      if (tab === 'project' && !projectSelect.value && state.actingAs) projectSelect.value = state.actingAs;
    }

    renderHistory();
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
    const caseLabel = rec.caseType === 'CONSUMING' ? 'Used up' : (rec.resolved ? 'Returned' : (rec.overdue ? 'Overdue' : 'Borrowed'));
    const caseClass = rec.resolved ? 'resolved' : (rec.overdue ? 'overdue' : 'pending');
    const dueNote = pendingBorrow && rec.due ? `<div class="history-item-date${rec.overdue ? ' overdue' : ''}">Due ${shortDate(rec.due)}</div>` : `<div class="history-item-date">${when}</div>`;
    const resolveBtn = pendingBorrow && canResolve(rec)
      ? `<button type="button" class="resolve-btn" onclick="resolveLine('${escapeAttr(rec.lineId)}', this)">Mark returned</button>`
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
    if (changed) { dashState.selected.clear(); dashState.confirming = false; renderProjectDash(); }
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

  function renderActForSelects() {
    const targets = allowedTargets();
    const before = state.actingAs;
    if (!targets.some(t => t === state.actingAs)) {
      const ownDept = state.lastId && state.lastId.committee;
      state.actingAs = targets.find(t => sameName(t, ownDept)) || targets[0] || '';
    }
    if (state.actingAs !== before && typeof renderProjectDash === 'function') renderProjectDash();
    const html = targets.length
      ? targets.map(t => `<option value="${escapeHtml(t)}"${t === state.actingAs ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('')
      : '<option value="">Not linked to a department or project</option>';
    ['home-actfor-select', 'project-select'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = html;
      el.disabled = !targets.length;
    });
    const note = document.getElementById('actfor-empty-note');
    if (note) note.style.display = targets.length ? 'none' : '';
  }

  async function refreshLoginInBackground() {
    if (!navigator.onLine || !state.lastId || !getInventoryScriptUrl()) return;
    const fresh = await fetchIdLookup(state.lastId.idNumber);
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
  window.resolveLine = resolveLine;

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
  const dashState = { selected: new Set(), confirming: false, busy: false, records: [], offline: false };

  let homeLoadToken = 0;
  async function refreshHomeData() {
    const myToken = ++homeLoadToken;
    const { records, offline } = await fetchHistoryRecords();
    if (myToken !== homeLoadToken) return;
    updateOutCount(records);
    dashState.records = records;
    dashState.offline = offline;
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

    const borrows = dashState.records.filter(r => sameName(r.project, project) && r.caseType === 'BORROWING');
    const out = borrows.filter(r => !r.resolved)
      .sort((a, b) => (b.overdue - a.overdue) || String(a.due).localeCompare(String(b.due)));
    // History has no "returned on" date, so "recent" is judged by when the item was borrowed.
    const recentCutoff = Date.now() - RECENT_RETURN_DAYS * 86400000;
    const returned = borrows.filter(r => r.resolved && r.time && new Date(r.time) >= recentCutoff);
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
    const outRows = out.map(r => `
      <label class="dash-row${r.overdue ? ' is-overdue' : ''}">
        <input type="checkbox" class="dash-check" data-line="${escapeHtml(r.lineId)}" ${dashState.selected.has(r.lineId) ? 'checked' : ''} ${dashState.offline || dashState.busy ? 'disabled' : ''}>
        <span class="dash-row-main">
          <span class="dash-row-title">${escapeHtml(r.item)}${r.qty ? ' × ' + escapeHtml(r.qty) : ''}</span>
          <span class="dash-row-meta">${escapeHtml(r.name || '—')} · ${shortDate(r.time)}${r.committee ? ' · ' + escapeHtml(r.committee) : ''}</span>
        </span>
        <span class="dash-row-due${r.overdue ? ' overdue' : ''}">${r.overdue ? 'Overdue' : (r.due ? 'Due ' + shortDate(r.due) : '')}</span>
      </label>`).join('');
    const doneRows = returned.map(r => `
      <div class="dash-row done">
        <span class="dash-done-mark" aria-hidden="true">✓</span>
        <span class="dash-row-main">
          <span class="dash-row-title">${escapeHtml(r.item)}${r.qty ? ' × ' + escapeHtml(r.qty) : ''}</span>
          <span class="dash-row-meta">Borrowed by ${escapeHtml(r.name || '—')} · ${shortDate(r.time)}${r.resolvedBy ? ' · returned by ' + escapeHtml(r.resolvedBy) : ''}</span>
        </span>
      </div>`).join('');

    document.getElementById('proj-dash-list').innerHTML = offlineNote +
      (out.length ? outRows : `<div class="dash-empty"><img src="${ayiFor(project)}" alt=""><div>All clear! ${escapeHtml(project)} has nothing out right now.</div></div>`) +
      (returned.length ? `<details class="dash-done"><summary>Recently returned (${returned.length})</summary>${doneRows}</details>` : '');

    document.querySelectorAll('#proj-dash-list .dash-check').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) dashState.selected.add(cb.dataset.line); else dashState.selected.delete(cb.dataset.line);
        dashState.confirming = false;
        renderDashActions(out);
      });
    });
    renderDashActions(out);
  }

  function renderDashActions(out) {
    const actions = document.getElementById('proj-dash-actions');
    if (!actions) return;
    const n = dashState.selected.size;
    if (!out.length) { actions.innerHTML = ''; return; }
    if (dashState.confirming && n) {
      const names = out.filter(r => dashState.selected.has(r.lineId)).map(r => escapeHtml(r.item) + (r.qty ? ' × ' + escapeHtml(r.qty) : ''));
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
    let done = 0;
    const failed = [];
    for (const id of ids) {
      if (actions) actions.innerHTML = `<div class="dash-progress">Marking returned… ${done + 1} of ${ids.length}</div>`;
      try { await postResolve(id); done++; dashState.selected.delete(id); }
      catch(err) { failed.push(err.message); }
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
    list.innerHTML = '<div class="history-item skeleton-row skeleton" style="height:52px;"></div>'.repeat(3);

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
      ? `<div class="history-offline-note"><img class="svg-icon icon-inline" src="icons/ui/wifi.svg" alt="">Showing ${syncedAt ? 'data from ' + new Date(syncedAt).toLocaleString() : 'no saved data'}.</div>`
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
    pendingList.innerHTML = skeletonRow.repeat(2);
    totalList.innerHTML = skeletonRow.repeat(3);

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
        pendingList.innerHTML = '<div class="history-empty">Select a Project/Dept above</div>';
        totalList.innerHTML = '<div class="history-empty">Select a Project/Dept above</div>';
        return;
      }
      scoped = records.filter(r => sameName(r.project, chosen));
    }

    const pending = scoped.filter(r => !r.resolved);
    const total = scoped.filter(r => r.resolved);

    const offlineNote = offline
      ? `<div class="history-offline-note"><img class="svg-icon icon-inline" src="icons/ui/wifi.svg" alt="">${error ? 'Could not refresh' : "You're offline"} — showing ${syncedAt ? 'last synced (' + new Date(syncedAt).toLocaleString() + ')' : 'no saved'} data.</div>`
      : '';

    pendingList.innerHTML = offlineNote + (pending.length
      ? pending.map(historyRowHtml).join('')
      : '<div class="history-empty">No pending requests yet</div>');

    totalList.innerHTML = total.length
      ? total.map(historyRowHtml).join('')
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
      btn.textContent = 'CHECKING…';

      const result = await fetchIdLookup(idValue);

      btn.disabled = false;
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
        err.textContent = 'Something went wrong. Please try again.';
        return;
      }
      if (!result.found) {
        err.textContent = 'ID number not found in the Celadon member list.';
        return;
      }

      state.lastId = result;
      saveLogin(result);
      state.actingAs = getSavedActingAs();
      renderIdentity();
      renderActForSelects();
      input.value = '';
      showView('home');
    }

    btn.addEventListener('click', attemptLogin);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attemptLogin();
    });
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
    const loginInput = document.getElementById('login-id-input');
    const loginErr = document.getElementById('login-error');
    if (loginInput) loginInput.value = '';
    if (loginErr) loginErr.textContent = '';
    showView('login');
  }

  /* ---------------- Inventory / catalog ---------------- */

  function renderCatalogSkeleton() {
    const container = document.getElementById('catalog-container');
    if (!container || state.inventory.length) return; // only show on a genuinely empty first load
    const grid = state.catalogFormat === 'grid';
    container.className = grid ? 'item-grid' : 'item-list';
    const card = grid
      ? '<div class="item-card skeleton-card skeleton"><div class="skeleton-thumb"></div><div class="skeleton-line"></div><div class="skeleton-line w60"></div></div>'
      : '<div class="item-row skeleton-row skeleton"><div class="skeleton-thumb"></div><div class="skeleton-lines"><div class="skeleton-line"></div><div class="skeleton-line w40"></div></div></div>';
    container.innerHTML = card.repeat(grid ? 9 : 5);
  }

  function loadInventory() {
    renderCatalogSkeleton();
    google.script.run
      .withSuccessHandler(items => {
        state.inventory = items || [];
        renderCategoryChips();
        renderCatalog();
      })
      .withFailureHandler(err => showToast(err.message || 'Could not load inventory', true))
      .getInventory();
  }

  // Category chips let people jump straight to a section of the catalog
  // instead of scrolling or guessing a search term — built from whatever
  // categories actually exist in the sheet right now, so it never goes
  // stale relative to the data.
  function renderCategoryChips() {
    const row = document.getElementById('category-chip-row');
    if (!row) return;
    const categories = Array.from(new Set(
      state.inventory.map(i => (i.category || '').trim()).filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));

    if (!categories.length) { row.innerHTML = ''; return; }
    if (!categories.includes(state.catalogCategory)) state.catalogCategory = 'all';

    const chip = (value, label) => `<button type="button" class="category-chip${state.catalogCategory === value ? ' active' : ''}" data-category="${escapeAttr(value)}">${escapeHtml(label)}</button>`;
    row.innerHTML = chip('all', 'All') + categories.map(c => chip(c, c)).join('');

    row.querySelectorAll('.category-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        state.catalogCategory = btn.dataset.category;
        row.querySelectorAll('.category-chip').forEach(b => b.classList.toggle('active', b === btn));
        renderCatalog();
      });
    });
  }

  function loadProjectOptions() {
    google.script.run
      .withSuccessHandler(options => {
        state.projectOptions = Array.isArray(options) ? options.filter(o => !/^personal$/i.test(o)) : [];
        renderActForSelects();

        const historySelect = document.getElementById('history-project-select');
        if (historySelect) {
          const placeholder = historySelect.querySelector('option[value=""]');
          historySelect.innerHTML = (placeholder ? placeholder.outerHTML : '<option value="">Project/Dept</option>') +
            state.projectOptions
              .map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`)
              .join('');
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
    searchInput.addEventListener('input', (e) => {
      state.catalogSearch = e.target.value;
      clearBtn.style.display = e.target.value ? 'flex' : 'none';
      renderCatalog();
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
  }

  function setCatalogFormat(format) {
    state.catalogFormat = format;
    document.getElementById('format-grid-btn').classList.toggle('active', format === 'grid');
    document.getElementById('format-list-btn').classList.toggle('active', format === 'list');
    renderCatalog();
  }

  // Returns state.inventory filtered by the search box (matches title,
  // category, location, or notes) and sorted per the sort dropdown —
  // Category uses the sheet's own Category column, per request.
  function getVisibleInventory() {
    const q = state.catalogSearch.trim().toLowerCase();
    let items = state.inventory;

    if (state.catalogCategory && state.catalogCategory !== 'all') {
      items = items.filter(item => (item.category || '').trim() === state.catalogCategory);
    }

    if (q) {
      items = items.filter(item => {
        const haystack = [item.title, item.category, item.type, item.event, item.location, item.notes]
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    const sorted = items.slice();
    if (state.catalogSort === 'name') {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    } else if (state.catalogSort === 'category') {
      sorted.sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.title.localeCompare(b.title));
    } else if (state.catalogSort === 'location') {
      sorted.sort((a, b) => (a.location || '').localeCompare(b.location || '') || a.title.localeCompare(b.title));
    }
    return sorted;
  }

  function renderCatalog() {
    const container = document.getElementById('catalog-container');
    const debugMsg = window.__celaInventoryDebugError;
    const debugHtml = debugMsg
      ? `<div style="grid-column:1/-1;background:rgba(255,107,107,0.08);border:1px solid rgba(255,107,107,0.3);border-radius:12px;padding:14px;font-size:11px;font-family:monospace;color:#ffb3b3;white-space:pre-wrap;word-break:break-word;margin-bottom:10px;"><img class="svg-icon icon-inline" src="icons/ui/warning.svg" alt="">Inventory fetch failed — showing demo items below.\n\n${escapeHtml(debugMsg)}</div>`
      : '';

    const countEl = document.getElementById('catalog-result-count');

    if (!state.inventory.length) {
      container.innerHTML = debugHtml + '<div class="empty-state"><img class="svg-icon" src="icons/ui/archive-box.svg" alt="">Inventory is empty</div>';
      if (countEl) countEl.textContent = 'Tap an item to add it to your cart';
      return;
    }

    const visible = getVisibleInventory();
    const filtered = !!state.catalogSearch.trim() || state.catalogCategory !== 'all';

    if (countEl) {
      countEl.textContent = filtered
        ? visible.length + (visible.length === 1 ? ' item found' : ' items found')
        : 'Tap an item to add it to your cart';
    }

    if (!visible.length) {
      container.className = state.catalogFormat === 'grid' ? 'item-grid' : 'item-list';
      container.innerHTML = debugHtml + `
        <div class="empty-state" style="grid-column:1/-1;">
          <img class="svg-icon" src="icons/ui/search.svg" alt="">
          No items match${state.catalogCategory !== 'all' ? ' "' + escapeHtml(state.catalogCategory) + '"' : ''}${state.catalogSearch.trim() ? ' "' + escapeHtml(state.catalogSearch.trim()) + '"' : ''}
          <button type="button" class="btn-secondary" style="margin-top:14px;max-width:200px;" onclick="clearCatalogFilters()">Clear filters</button>
        </div>`;
      return;
    }

    if (state.catalogFormat === 'grid') {
      container.className = 'item-grid';
      container.innerHTML = debugHtml + visible.map(item => `
        <div class="item-card" onclick="addToCart('${escapeAttr(item.id)}')">
          <div class="item-card-top"><span class="item-cat">${escapeHtml(item.category)}</span>${cartQty(item.id) > 0 ? `<span class="in-cart-dot">${cartQty(item.id)}</span>` : ''}</div>
          <div class="item-title">${escapeHtml(item.title)}</div>
          <div class="item-qty">${escapeHtml(item.qtyDisplay != null ? item.qtyDisplay : item.qtyAvailable)}${itemBadges(item)}</div>
          ${locationLine(item.location)}
        </div>
      `).join('');
    } else {
      container.className = 'item-list';
      container.innerHTML = debugHtml + visible.map(item => `
        <div class="item-row" onclick="addToCart('${escapeAttr(item.id)}')">
          <div class="item-info">
            <div class="item-title">${escapeHtml(item.title)}${itemBadges(item)}</div>
            <div class="item-qty"><span class="item-cat">${escapeHtml(item.category)}</span> · ${escapeHtml(item.qtyDisplay || '—')}${item.notes ? ' · ' + escapeHtml(item.notes) : ''}</div>
            ${locationLine(item.location)}
          </div>
          ${cartQty(item.id) > 0 ? `<div class="in-cart-badge">${cartQty(item.id)} in cart</div>` : ''}
        </div>
      `).join('');
    }
  }

  function clearCatalogFilters() {
    state.catalogSearch = '';
    state.catalogCategory = 'all';
    const searchInput = document.getElementById('catalog-search');
    const clearBtn = document.getElementById('catalog-search-clear');
    if (searchInput) searchInput.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    renderCategoryChips();
    renderCatalog();
  }

  // Small status chips on catalog cards: borrowed count, hand-set Status
  // (Out/Missing), and Consumables expiry.
  function itemBadges(item) {
    const badges = [];
    if (item.out) badges.push(`<span class="out-badge">${item.out} out</span>`);
    if (/^(out|missing)$/i.test(item.status) && !item.out) badges.push(`<span class="out-badge status">${escapeHtml(item.status)}</span>`);
    if (item.expiry) {
      const days = Math.round((new Date(item.expiry) - new Date()) / 86400000);
      const label = days < 0 ? 'Expired' : (days <= 14 ? 'Exp. ' + shortDate(item.expiry) : '');
      if (label) badges.push(`<span class="out-badge expiry">${label}</span>`);
    }
    return badges.length ? ' ' + badges.join(' ') : '';
  }

  function cartQty(itemId) {
    return state.cart[itemId] ? state.cart[itemId].qty : 0;
  }

  function addToCart(itemId) {
    const item = state.inventory.find(i => i.id === itemId);
    if (!item) return;
    const current = state.cart[itemId] || { item: item, qty: 0 };
    current.qty += 1;
    state.cart[itemId] = current;
    updateCartBadge();
    showToast(item.title + ' added to cart');
  }

  function stepQty(itemId, delta) {
    const item = state.inventory.find(i => i.id === itemId);
    if (!item) return;
    const current = state.cart[itemId] || { item: item, qty: 0 };
    current.qty = Math.max(0, current.qty + delta);
    if (current.qty === 0) {
      delete state.cart[itemId];
    } else {
      state.cart[itemId] = current;
    }
    updateCartBadge();
    renderCatalog();
    if (state.view === 'cart') renderCart();
  }

  function setQty(itemId, value) {
    const item = state.inventory.find(i => i.id === itemId);
    if (!item) return;
    const qty = Math.max(0, parseInt(value, 10) || 0);
    if (qty === 0) {
      delete state.cart[itemId];
    } else {
      state.cart[itemId] = { item: item, qty: qty };
    }
    updateCartBadge();
    if (state.view === 'cart') renderCart();
  }

  function updateCartBadge() {
    const count = Object.values(state.cart).reduce((sum, c) => sum + c.qty, 0);
    const badge = document.getElementById('cart-badge');
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  /* ---------------- Cart view ---------------- */

  function renderCart() {
    const container = document.getElementById('cart-list');
    const entries = Object.values(state.cart);
    const checkoutBtn = document.getElementById('cart-checkout-btn');

    if (!entries.length) {
      container.innerHTML = '<div class="empty-state"><img class="svg-icon" src="icons/ui/shopping-basket.svg" alt="">Your cart is empty</div>';
      checkoutBtn.disabled = true;
      return;
    }
    checkoutBtn.disabled = false;

    container.innerHTML = entries.map(({ item, qty }) => `
      <div class="item-row">
        <div class="item-info">
          <div class="item-title">${escapeHtml(item.title)}</div>
          <div class="item-qty"><span class="item-cat">${escapeHtml(item.category)}</span> · ${escapeHtml(item.qtyDisplay || '—')}</div>
          ${locationLine(item.location)}
        </div>
        <div class="qty-stepper">
          <button class="qty-btn" onclick="stepQty('${escapeAttr(item.id)}', -1)" aria-label="Decrease quantity"><img class="svg-icon" src="icons/ui/minus.svg" alt=""></button>
          <input type="number" min="0" value="${qty}" aria-label="Quantity"
                 onchange="setQty('${escapeAttr(item.id)}', this.value)" />
          <button class="qty-btn" onclick="stepQty('${escapeAttr(item.id)}', 1)" aria-label="Increase quantity"><img class="svg-icon" src="icons/ui/plus.svg" alt=""></button>
        </div>
      </div>
    `).join('');
  }

  /* ---------------- Checkout view ---------------- */

  const CASE_HINTS = {
    BORROWING: 'Borrowing: taking items out of the org room for the project/department above. They stay under it until they\'re marked returned.',
    CONSUMING: 'Using up: supplies that won\'t come back (e.g. tape, paper). The quantity is deducted from the sheet and charged to the project/department above.',
    RETURNING: 'Returning: bringing back items borrowed for the project/department above. Clears its pending borrows. You can also tap "Mark returned" in Borrowed now.'
  };

  function renderCheckout() {
    document.getElementById('checkout-id-display').textContent =
      state.lastId && state.lastId.idNumber ? state.lastId.idNumber : 'Not scanned yet';

    renderActForSelects();

    const entries = Object.values(state.cart);
    const tbody = document.getElementById('checkout-summary-body');
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="2">No items selected</td></tr>';
    } else {
      tbody.innerHTML = entries.map(({ item, qty }) => `
        <tr><td>${escapeHtml(item.title)}</td><td>${qty}x</td></tr>
      `).join('');
    }
  }

  function bindCheckoutForm() {
    document.getElementById('submit-order-btn').addEventListener('click', submitOrder);

    document.querySelectorAll('.case-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.case-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.checkoutCase = btn.dataset.case;
        document.getElementById('case-hint').textContent = CASE_HINTS[state.checkoutCase];
      });
    });
  }

  function submitOrder() {
    const entries = Object.values(state.cart);
    if (!state.lastId || !state.lastId.idNumber) {
      showToast('Log in with your ID number first', true);
      showView('home');
      return;
    }
    if (!entries.length) {
      showToast('Your cart is empty', true);
      return;
    }

    const committee = document.getElementById('committee-input').value;
    const project = document.getElementById('project-select').value;
    if (!project) {
      showToast('Choose the project or department this is for', true);
      return;
    }
    const pointPerson = (state.lastId && state.lastId.name) ? state.lastId.name : state.lastId.idNumber;

    const payload = {
      idNumber: state.lastId.idNumber,
      caseType: state.checkoutCase, // BORROWING | CONSUMING | RETURNING
      actingAs: project, // required: the project/department accountable for these items
      project: project,
      committee: committee,
      items: entries.map(({ item, qty }) => ({
        id: item.id,
        ref: item.id, // the backend matches the exact sheet row by this
        title: item.title,
        qty: qty,
        location: item.location || '',
        // Note left on the item's quantity cell, e.g. "[BORROWING] - 2 MAF, Juan Dela Cruz"
        comment: `[${state.checkoutCase}] - ${qty} ${project}, ${pointPerson}`
      }))
    };

    const btn = document.getElementById('submit-order-btn');
    btn.disabled = true;
    btn.textContent = 'SUBMITTING…';

    google.script.run
      .withSuccessHandler((result) => {
        if (result && result.queued) {
          showToast('Saved offline — will sync automatically');
        } else {
          showToast('Request submitted');
        }
        state.cart = {};
        updateCartBadge();
        btn.disabled = false;
        btn.textContent = 'SUBMIT REQUEST';
        showView('home');
      })
      .withFailureHandler(err => {
        showToast(err.message || 'Could not submit request', true);
        btn.disabled = false;
        btn.textContent = 'SUBMIT REQUEST';
      })
      .submitOrder(payload);
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
          <button class="contact-icon-btn" title="Message ${escapeAttr(c.name)} on Messenger" aria-label="Message ${escapeAttr(c.name)} on Messenger" onclick="window.open('${c.messenger}', '_blank', 'noopener')"><img class="svg-icon" src="icons/ui/messenger.svg" alt=""></button>
          ${c.telegram ? `<button class="contact-icon-btn" title="Message ${escapeAttr(c.name)} on Telegram" aria-label="Message ${escapeAttr(c.name)} on Telegram" onclick="window.open('${c.telegram}', '_blank', 'noopener')"><img class="svg-icon" src="icons/ui/telegram.svg" alt=""></button>` : ''}
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
  function showToast(message, isError) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.toggle('error', !!isError);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
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
    return `<div class="item-loc" title="${escapeAttr(text)}"><span class="loc-dot" style="background:${locationColor(location)}"></span>${escapeHtml(text)}</div>`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }
  function escapeAttr(str) {
    return String(str).replace(/'/g, "\\'");
  }
