// Local productivity app — client-only MVP
// Data store backed by localStorage. No external deps.

(function () {
  const STORAGE_KEY = 'app_state_v2';
  const PREF_KEY = 'app_pref_storage';
  // Optional Firebase-backed storage
  const prefersFirebase = () => localStorage.getItem(PREF_KEY) === 'firebase';
  let fb = { app: null, auth: null, db: null, user: null, unsub: null, lastWrite: null };

  function getFirebaseConfig() {
    try {
      const raw = (document.getElementById('firebaseConfig') && document.getElementById('firebaseConfig').value) || localStorage.getItem('app_firebase_config') || '';
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return window.FIREBASE_CONFIG || null;
  }

  async function ensureFirebaseSdk() {
    if (window.firebaseSdk) return true;
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.type = 'module';
        s.textContent = `
          import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
          import { getAuth, onAuthStateChanged, signInAnonymously, signOut, setPersistence, browserLocalPersistence, isSignInWithEmailLink, sendSignInLinkToEmail, signInWithEmailLink } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
          import { getFirestore, doc, getDoc, setDoc, onSnapshot, enableIndexedDbPersistence } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
          window.firebaseSdk = { initializeApp, getAuth, onAuthStateChanged, signInAnonymously, signOut, setPersistence, browserLocalPersistence, isSignInWithEmailLink, sendSignInLinkToEmail, signInWithEmailLink, getFirestore, doc, getDoc, setDoc, onSnapshot, enableIndexedDbPersistence };
          window.dispatchEvent(new Event('firebaseSdkReady'));
        `;
        const timeout = setTimeout(() => reject(new Error('Firebase SDK load timeout')), 5000);
        window.addEventListener('firebaseSdkReady', () => { clearTimeout(timeout); resolve(); }, { once: true });
        document.head.appendChild(s);
      });
      return !!window.firebaseSdk;
    } catch (_) { return false; }
  }

  async function initFirebase() {
    try {
      if (!window.firebaseSdk) {
        const ok = await ensureFirebaseSdk();
        if (!ok) return;
      }
      const cfg = getFirebaseConfig();
      if (!cfg) return;
      if (!fb.app) {
        fb.app = window.firebaseSdk.initializeApp(cfg);
        fb.auth = window.firebaseSdk.getAuth(fb.app);
        try { await window.firebaseSdk.setPersistence(fb.auth, window.firebaseSdk.browserLocalPersistence); } catch (_) {}
        fb.db = window.firebaseSdk.getFirestore(fb.app);
        try { await window.firebaseSdk.enableIndexedDbPersistence(fb.db); } catch (_) {}
        window.firebaseSdk.onAuthStateChanged(fb.auth, (user) => {
          fb.user = user || null;
          if (fb.user) { try { localStorage.setItem(PREF_KEY, 'firebase'); } catch (_) {} }
          renderStorageStatus();
          if (fb.unsub) { try { fb.unsub(); } catch (_) {} fb.unsub = null; }
          if (fb.user && prefersFirebase()) {
            const ref = window.firebaseSdk.doc(fb.db, 'users', fb.user.uid, 'state', 'state');
            fb.unsub = window.firebaseSdk.onSnapshot(ref, (snap) => {
              try {
                if (!snap.exists()) return;
                const data = snap.data();
                if (!data || !data.state) return;
                const incoming = JSON.stringify(data.state);
                if (fb.lastWrite && fb.lastWrite === incoming) return; // ignore our own writes
                state = data.state;
                render();
              } catch (_) {}
            });
          }
        });
        // Email link completion
        try {
          if (window.firebaseSdk.isSignInWithEmailLink && window.firebaseSdk.isSignInWithEmailLink(fb.auth, window.location.href)) {
            let email = localStorage.getItem('app_firebase_email_for_signin') || '';
            if (!email) {
              email = prompt('Confirm your email for sign-in:') || '';
            }
            if (email) {
              await window.firebaseSdk.signInWithEmailLink(fb.auth, email, window.location.href);
              localStorage.removeItem('app_firebase_email_for_signin');
              try { window.history.replaceState({}, document.title, window.location.pathname); } catch (_) {}
              localStorage.setItem(PREF_KEY, 'firebase');
              renderStorageStatus();
            }
          }
        } catch (_) {}
      }
    } catch (e) { console.warn('initFirebase failed', e); }
  }
  // (Local folder/file autosave removed in cloud-first mode)
  function parseUrlParams() {
    const out = {};
    const q = new URLSearchParams(window.location.search);
    for (const [k, v] of q.entries()) out[k] = v;
    if (window.location.hash && window.location.hash.length > 1) {
      const h = new URLSearchParams(window.location.hash.slice(1));
      for (const [k, v] of h.entries()) out[k] = v;
    }
    return out;
  }

  async function initSupabase() {
    const { url, anon } = getSupabaseConfig();
    if (!url || !anon || !window.supabaseCreateClient) { supabase = null; supabaseUser = null; return; }
    supabase = window.supabaseCreateClient(url, anon, { auth: { persistSession: true, autoRefreshToken: true } });
    // Handle redirect-based sign-ins (magic link / OAuth)
    try {
      const params = parseUrlParams();
      const href = window.location.href;
      if (params.code && typeof supabase.auth.exchangeCodeForSession === 'function') {
        // OAuth PKCE code exchange
        try { await supabase.auth.exchangeCodeForSession(href); } catch (_) { /* ignore */ }
      } else if (params.access_token && params.refresh_token && typeof supabase.auth.setSession === 'function') {
        // Email magic link sets tokens in hash fragment
        try { await supabase.auth.setSession({ access_token: params.access_token, refresh_token: params.refresh_token }); } catch (_) { /* ignore */ }
      }
      // Clean URL (remove query/hash)
      if (href.includes('code=') || href.includes('access_token=') || href.includes('token_hash=')) {
        try { window.history.replaceState({}, document.title, window.location.pathname); } catch (_) {}
      }
    } catch (_) {}
    const { data: { session } } = await supabase.auth.getSession();
    supabaseUser = session && session.user ? session.user : null;
    supabase.auth.onAuthStateChange((event, sess) => {
      supabaseUser = sess && sess.user ? sess.user : null;
      console.log('[AuthDebug] event:', event, 'user:', supabaseUser && (supabaseUser.email || supabaseUser.id));
      renderStorageStatus();
      // After sign-in, attempt to load server state and render
      if (supabaseUser) {
        loadState().then(() => render()).catch(() => render());
      }
    });
  }

  // ---------- Utilities ----------
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = (s) => new Date(`${s}T00:00:00`);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(d.getDate() + n); return x; };
  const weekday = (d) => d.getDay(); // 0 = Sun
  const fmtHuman = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  function computeLogicalDateFrom(now, rolloverHour) {
    const h = Number.isFinite(rolloverHour) ? rolloverHour : 3;
    const d = new Date(now);
    if (d.getHours() < h) d.setDate(d.getDate() - 1);
    return d;
  }

  function uid(prefix = 'id') { return `${prefix}_${Math.random().toString(36).slice(2, 9)}`; }

  // ---------- Data Model ----------
  // state = { tasks, backlog, instancesByDate, progression, settings, lastDate }

  function defaultState() {
    // Start with no predefined tasks or backlog. Users add their own.
    const tasks = [];
    const backlog = [];
    const settings = { rolloverHour: 3, progressionMiss: 'hold' };
    const progression = {};
    return { tasks, backlog, instancesByDate: {}, progression, settings, lastDate: toKey(computeLogicalDateFrom(new Date(), 3)) };
  }

  async function loadState() {
    // Cloud-first: Firebase
    if (prefersFirebase()) {
      await initFirebase();
      if (fb.db && fb.auth) {
        if (!fb.user) {
          try { /* no-op */ } catch (_) {}
        }
        try {
          if (!fb.user) return defaultState();
          const ref = window.firebaseSdk.doc(fb.db, 'users', fb.user.uid, 'state', 'state');
          const snap = await window.firebaseSdk.getDoc(ref);
          if (snap.exists()) {
            const data = snap.data();
            if (data && data.state) return data.state;
          }
          const seeded = defaultState();
          await window.firebaseSdk.setDoc(ref, { state: seeded }, { merge: false });
          return seeded;
        } catch (e) { console.warn('Firebase load failed', e); }
      }
    }
    // Fallback: browser storage
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return parsed;
    } catch (e) {
      console.warn('Failed to load state, resetting.', e);
      return defaultState();
    }
  }

  async function saveState() {
    // Cloud-first: Firebase
    if (prefersFirebase()) {
      try {
        await initFirebase();
        if (fb.db && fb.user) {
          const ref = window.firebaseSdk.doc(fb.db, 'users', fb.user.uid, 'state', 'state');
          const json = JSON.stringify(state);
          fb.lastWrite = json;
          await window.firebaseSdk.setDoc(ref, { state }, { merge: false });
        }
      } catch (e) { console.warn('Firebase save failed', e); }
    }
    // Only keep a local backup when not using Firebase
    if (!prefersFirebase()) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  }

  let state; // assigned during init()

  // ---------- Recurrence & Instances ----------
  function generateInstancesForDate(dateKey) {
    const d = fromKey(dateKey);
    const isWeekdayMatch = (task) => (task.weekdays || []).includes(weekday(d));
    const arr = [];
    state.tasks.forEach((t) => {
      if (!t.active) return;
      const include = (t.type === 'daily') || (t.type === 'weekly' && isWeekdayMatch(t));
      if (!include) return;
      const inst = makeInstanceForTask(t, dateKey);
      arr.push(inst);
    });
    return arr;
  }

  function makeInstanceForTask(task, dateKey) {
    const id = uid('inst');
    let title = task.title;
    if (task.progression) {
      const day = state.progression[task.id] || 1;
      title = `${task.title} — Day ${day}`;
    }
    return {
      id,
      date: dateKey,
      taskId: task.id,
      title,
      durationEst: task.durationMin || 0,
      percent: task.percentTracking ? 0 : null,
      completed: false,
      actualMin: 0,
      order: 0,
      source: 'schedule', // schedule | backlog | quick
    };
  }

  function ensureToday(dateKey) {
    if (!state.instancesByDate[dateKey]) {
      state.instancesByDate[dateKey] = generateInstancesForDate(dateKey);
    }
  }

  function rolloverIfNeeded() {
    const now = new Date();
    const logical = computeLogicalDateFrom(now, (state && state.settings && state.settings.rolloverHour) || 3);
    const todayKey = toKey(logical);
    if (state.lastDate !== todayKey) {
      // Apply progression miss rule for any progression tasks not completed yesterday
      const yesterdayKey = state.lastDate;
      if (yesterdayKey && state.instancesByDate[yesterdayKey]) {
        const yInstances = state.instancesByDate[yesterdayKey];
        const missed = yInstances.filter((i) => i.taskId && !i.completed);
        missed.forEach((i) => {
          const task = state.tasks.find((t) => t.id === i.taskId);
          if (task && task.progression) {
            const rule = task.progression.onMiss || state.settings.progressionMiss || 'hold';
            if (rule === 'reset') state.progression[task.id] = 1;
            // hold = do nothing
          }
        });
      }
      state.lastDate = todayKey;
      ensureToday(todayKey);
      saveState();
    }
  }

  // ---------- Rendering ----------
  const els = {
    currentDateLabel: document.getElementById('currentDateLabel'),
    prevDay: document.getElementById('prevDay'),
    nextDay: document.getElementById('nextDay'),
    // tabs removed
    panels: {
      today: document.getElementById('tab-today'),
      analytics: document.getElementById('tab-analytics'),
      settings: document.getElementById('tab-settings'),
    },
    todayList: document.getElementById('todayList'),
    backlogList: document.getElementById('backlogList'),
    // backlogListFull removed page
    todayProgress: document.getElementById('todayProgress'),
    openAnalyticsPanel: document.getElementById('openAnalyticsPanel'),
    openSettingsPanel: document.getElementById('openSettingsPanel'),
    navHome: document.getElementById('navHome'),
    openAddToday: document.getElementById('openAddToday'),
    openAddBacklog: document.getElementById('openAddBacklog'),
    addModal: document.getElementById('addModal'),
    addModalTitle: document.getElementById('addModalTitle'),
    addModalName: document.getElementById('addModalName'),
    addModalTime: document.getElementById('addModalTime'),
    addModalSave: document.getElementById('addModalSave'),
    addModalCancel: document.getElementById('addModalCancel'),
    heatmap: document.getElementById('heatmap'),
    timeStats: document.getElementById('timeStats'),
    rolloverHour: document.getElementById('rolloverHour'),
    progressionMiss: document.getElementById('progressionMiss'),
    saveSettings: document.getElementById('saveSettings'),
    briefing: document.getElementById('briefing'),
  };

  let currentDate = new Date();
  function refreshDateLabel() {
    els.currentDateLabel.textContent = fmtHuman(currentDate);
  }

  function setPanel(name) {
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    const el = document.getElementById(`tab-${name}`);
    if (el) el.classList.add('active');
  }

  function render() {
    const key = toKey(currentDate);
    ensureToday(key);
    refreshDateLabel();
    renderTodayList();
    renderBacklogLists();
    renderSummary();
    renderAnalytics();
    // Settings UI minimized to data storage; no need to render form fields
    renderStorageStatus();
  }

  function renderTodayList() {
    const key = toKey(currentDate);
    const list = state.instancesByDate[key] || [];
    const byOrder = [...list].sort((a, b) => (a.order || 0) - (b.order || 0));
    const done = byOrder.filter((i) => i.completed);
    const todo = byOrder.filter((i) => !i.completed);
    const final = done.concat(todo);
    // Mutate underlying array to match UI order to keep indices consistent
    list.splice(0, list.length, ...final);
    els.todayList.innerHTML = '';
    list.forEach((inst, idx) => {
      inst.order = idx;
      els.todayList.appendChild(renderItem(inst, { context: 'today' }));
    });
  }

  function renderBacklogLists() {
    if (els.backlogList) els.backlogList.innerHTML = '';
    // Keep current array order (supports manual positioning)
    state.backlog.forEach((b) => {
      const node = renderBacklogItem(b, true);
      if (els.backlogList) els.backlogList.appendChild(node);
    });
    // If a move-to-backlog just happened, scroll into view
    if (window.__pendingScrollBacklogId) {
      const id = window.__pendingScrollBacklogId;
      const target = els.backlogList ? els.backlogList.querySelector(`[data-id="${id}"]`) : null;
      if (target && target.scrollIntoView) {
        target.classList.add('just-moved');
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setTimeout(() => target && target.classList && target.classList.remove('just-moved'), 1200);
      }
      window.__pendingScrollBacklogId = null;
    }
  }

  function renderItem(inst, { context }) {
    const li = document.createElement('li');
    li.className = 'bubble-item';
    li.setAttribute('data-id', inst.id);
    li.setAttribute('data-context', context);
    const dlabel = minutesToString(inst.durationEst || 0);
    li.innerHTML = `
      <button class="trash-btn" title="Hold to delete">
        <div class="trash-progress" style="--pct:0%"></div>
        <div class="trash-inner"><img src="images/trash-icon.png" alt="Delete"/></div>
      </button>
      <div class="item-title">${escapeHtml(inst.title)}</div>
      <div class="item-meta">
        ${dlabel ? `<span class=\"pill\">${dlabel}</span>` : ''}
      </div>
      <div class="complete-toggle ${inst.completed ? 'completed' : ''}" title="Toggle complete">${inst.completed ? '✓' : ''}</div>
    `;

    li.querySelector('.complete-toggle').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      inst.completed = !inst.completed;
      // advance progression for next day if completed
      if (inst.completed && inst.taskId) {
        const task = state.tasks.find((t) => t.id === inst.taskId);
        if (task && task.progression) {
          const cur = state.progression[task.id] || 1;
          const next = cur >= (task.progression.days || cur) ? 1 : cur + 1;
          state.progression[task.id] = next;
        }
      }
      await saveState();
      render();
    });

    // Trash hold-to-delete
    const trashBtn = li.querySelector('.trash-btn');
    if (trashBtn) attachHoldToDelete(trashBtn, async () => {
      const key = toKey(currentDate);
      const list = state.instancesByDate[key] || [];
      const idx = list.findIndex((x) => x.id === inst.id);
      if (idx >= 0) {
        list.splice(idx, 1);
        list.forEach((it, n) => (it.order = n));
        await saveState();
        render();
      }
    });

    enableDrag(li);
    return li;
  }

  function renderBacklogItem(item, showActions = false) {
    const li = document.createElement('li');
    li.className = 'bubble-item';
    li.setAttribute('data-id', item.id);
    li.setAttribute('data-context', 'backlog');
    const blabel = minutesToString(item.estimateMin || 0);
    li.innerHTML = `
      <button class="trash-btn" title="Hold to delete">
        <div class="trash-progress" style="--pct:0%"></div>
        <div class="trash-inner"><img src="images/trash-icon.png" alt="Delete"/></div>
      </button>
      <div class="item-title">${escapeHtml(item.title)}</div>
      <div class="item-meta">
        ${blabel ? `<span class=\"pill\">${blabel}</span>` : ''}
      </div>
    `;
    const trashBtn = li.querySelector('.trash-btn');
    if (trashBtn) attachHoldToDelete(trashBtn, async () => {
      const idx = state.backlog.findIndex((b) => b.id === item.id);
      if (idx >= 0) {
        state.backlog.splice(idx, 1);
        await saveState();
        render();
      }
    });
    enableDrag(li);
    return li;
  }

  function addBacklogToToday(backlogId, { atIndex = null, silent = false } = {}) {
    const idxInBacklog = state.backlog.findIndex((b) => b.id === backlogId);
    const item = idxInBacklog >= 0 ? state.backlog[idxInBacklog] : null;
    if (!item) return null;
    const key = toKey(currentDate);
    ensureToday(key);
    const inst = {
      id: uid('inst'),
      date: key,
      taskId: null,
      title: item.title,
      durationEst: item.estimateMin || 0,
      percent: null,
      completed: false,
      actualMin: 0,
      order: 0,
      source: 'backlog',
      backlogId: item.id,
    };
    const list = state.instancesByDate[key];
    const completedCount = list.filter((x) => x.completed).length;
    let idx = atIndex == null ? completedCount : Math.max(0, Math.min(atIndex, list.length));
    if (idx < completedCount) idx = completedCount;
    list.splice(idx, 0, inst);
    list.forEach((i, n) => (i.order = n));
    // Remove from backlog to make it a true move
    if (idxInBacklog >= 0) {
      state.backlog.splice(idxInBacklog, 1);
    }
    saveState();
    if (!silent) render();
    return inst.id;
  }

  function renderSummary() {
    const key = toKey(currentDate);
    const list = state.instancesByDate[key] || [];
    const total = list.length;
    const done = list.filter((i) => i.completed).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    if (els.todayProgress) {
      els.todayProgress.textContent = total ? `(${pct}% Completed)` : '';
    }
  }

  // ---------- Drag and Drop ----------
  let drag = { el: null, placeholder: null, preview: null, offset: { x: 0, y: 0 } };
  let selected = { el: null };
  function setSelected(el) {
    if (selected.el && selected.el.classList) selected.el.classList.remove('selected');
    selected.el = el || null;
    if (selected.el) selected.el.classList.add('selected');
  }
  function enableDrag(el) {
    el.addEventListener('mousedown', onPressStart);
    // Click to select
    el.addEventListener('click', (e) => {
      if (e.target && (e.target.closest('.complete-toggle') || e.target.closest('.trash-btn'))) return;
      setSelected(el);
    });
  }
  const HOLD_MS = 0; // start drag immediately on press
  const HOLD_DELETE_MS = 600; // hold time for delete (ms)
  let holdTimer = null;
  let holdStart = null;
  function onPressStart(e) {
    if (e.button !== 0) return;
    const item = (e.target && e.target.closest) ? e.target.closest('.bubble-item') : e.currentTarget.closest('.bubble-item');
    if (!item) return;
    // Don’t start drag from toggle or interactive elements
    if (e.target && (e.target.closest('.complete-toggle') || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON')) return;
    setSelected(item);
    if (HOLD_MS <= 0) {
      // Immediate drag on press
      startDrag(e, item);
    } else {
      holdStart = { x: e.clientX, y: e.clientY, item };
      holdTimer = setTimeout(() => startDrag(e, item), HOLD_MS);
      document.addEventListener('mouseup', cancelHoldOnce, { once: true });
      document.addEventListener('mousemove', onHoldMove);
    }
  }
  function onHoldMove(e) {
    if (!holdStart) return;
    const dx = Math.abs(e.clientX - holdStart.x);
    const dy = Math.abs(e.clientY - holdStart.y);
    if (dx > 3 || dy > 3) cancelHold();
  }
  function cancelHold() {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    holdStart = null;
    document.removeEventListener('mousemove', onHoldMove);
  }
  function cancelHoldOnce() { cancelHold(); }
  function startDrag(e, item) {
    e.preventDefault();
    drag.el = item;
    // Measure before changing positioning to keep full width
    const rect = item.getBoundingClientRect();
    drag.offset = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // Insert placeholder to keep layout height
    drag.placeholder = document.createElement('li');
    drag.placeholder.className = 'bubble-item placeholder';
    drag.placeholder.style.height = rect.height + 'px';
    item.parentNode.insertBefore(drag.placeholder, item);

    // Now apply dragging styles and lock size/position
    item.classList.add('dragging');
    item.style.width = rect.width + 'px';
    item.style.height = rect.height + 'px';
    item.style.left = e.clientX - drag.offset.x + 'px';
    item.style.top = e.clientY - drag.offset.y + 'px';

    drag.preview = document.createElement('li');
    drag.preview.className = 'drop-preview';

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
  }

  // Hold-to-delete helper
  function attachHoldToDelete(btn, onConfirm) {
    let start = 0;
    let rafId = null;
    let animEl = btn.querySelector('.trash-progress');
    const update = () => {
      const elapsed = Date.now() - start;
      const pct = Math.max(0, Math.min(100, Math.floor((elapsed / HOLD_DELETE_MS) * 100)));
      if (animEl) animEl.style.setProperty('--pct', pct + '%');
      if (elapsed >= HOLD_DELETE_MS) {
        cleanup();
        onConfirm && onConfirm();
        return;
      }
      rafId = requestAnimationFrame(update);
    };
    const cleanup = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null; start = 0;
      if (animEl) animEl.style.setProperty('--pct', '0%');
      document.removeEventListener('mouseup', onUp);
      btn.removeEventListener('mouseleave', onUp);
    };
    const onDown = (e) => {
      e.stopPropagation();
      start = Date.now();
      document.addEventListener('mouseup', onUp);
      btn.addEventListener('mouseleave', onUp);
      rafId = requestAnimationFrame(update);
    };
    const onUp = (e) => {
      e && e.stopPropagation();
      cleanup();
    };
    btn.addEventListener('mousedown', onDown);
    // Touch support
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); onDown(e); }, { passive: false });
    btn.addEventListener('touchend', onUp);
    btn.addEventListener('touchcancel', onUp);
  }
  function detectDroppableAt(x, y) {
    const under = document.elementFromPoint(x, y);
    if (under) {
      let best = under.closest('.droppable');
      if (best) return best;
      const area = under.closest('.scroll-area');
      if (area) {
        const inner = area.querySelector('.droppable');
        if (inner) return inner;
      }
    }
    // Absolute fallback based on column boxes
    const tCol = document.getElementById('todayColumn');
    const bCol = document.getElementById('backlogColumn');
    if (tCol) {
      const r = tCol.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return document.getElementById('todayList');
    }
    if (bCol) {
      const r2 = bCol.getBoundingClientRect();
      if (x >= r2.left && x <= r2.right && y >= r2.top && y <= r2.bottom) return document.getElementById('backlogList');
    }
    return null;
  }

  function onMouseMove(e) {
    const el = drag.el; if (!el) return;
    el.style.left = e.clientX - drag.offset.x + 'px';
    el.style.top = e.clientY - drag.offset.y + 'px';
    const best = detectDroppableAt(e.clientX, e.clientY);
    // Clear previous highlights
    document.querySelectorAll('.droppable.highlight').forEach((d) => d.classList.remove('highlight'));
    if (!best) { if (drag.preview.parentNode) drag.preview.remove(); return; }
    best.classList.add('highlight');
    const after = getDragAfterElement(best, e.clientY);
    if (after == null) best.appendChild(drag.preview); else best.insertBefore(drag.preview, after);
  }
  function onMouseUp(e) {
    cancelHold();
    const el = drag.el; if (!el) return;
    el.classList.remove('dragging');
    el.style.left = el.style.top = '';
    el.style.width = '';
    el.style.height = '';
    // determine drop target using position (ignore stale highlights)
    document.querySelectorAll('.droppable.highlight').forEach((d) => d.classList.remove('highlight'));
    const target = detectDroppableAt(e.clientX, e.clientY);

    const fromContext = el.getAttribute('data-context');
    const id = el.getAttribute('data-id');
    const key = toKey(currentDate);

    // Determine intended index based on drop preview location
    let targetIndex = 0;
    if (target) {
      const after = getDragAfterElement(target, e.clientY);
      const siblings = Array.from(target.querySelectorAll('.bubble-item:not(.dragging):not(.placeholder)'));
      targetIndex = after == null ? siblings.length : siblings.indexOf(after);
    }

    if (target) {
      if (target.id === 'todayList') {
        ensureToday(key);
        const list = state.instancesByDate[key];
        if (fromContext === 'backlog') {
          // Only add if the preview is actually inside the today list
          if (drag.preview && drag.preview.parentNode === target) {
            addBacklogToToday(id, { atIndex: targetIndex, silent: true });
          } else {
            // No preview inside target; treat as no-drop
          }
        } else if (fromContext === 'today') {
          const i = list.findIndex((x) => x.id === id);
          if (i >= 0) {
            // Compute insertion index based on siblings list (excludes dragging el)
            let idx = Math.max(0, Math.min(targetIndex, list.length));
            const completedCount = list.filter((x) => x.completed).length;
            const [inst] = list.splice(i, 1);
            if (i < idx) idx--; // account for removal before insertion point
            const isCompleted = !!inst.completed;
            if (isCompleted) {
              // Completed tasks must stay within the completed block [0..completedCount]
              if (idx > completedCount) idx = completedCount;
            } else {
              // Unfinished tasks must stay below the completed block [completedCount..end]
              if (idx < completedCount) idx = completedCount;
            }
            list.splice(idx, 0, inst);
            list.forEach((it, n) => (it.order = n));
          }
        }
      } else if (target.id === 'backlogList' || target.id === 'backlogListFull') {
        // Reorder within backlog
        if (fromContext === 'backlog') {
          const i = state.backlog.findIndex((b) => b.id === id);
          if (i >= 0) {
            let idx = Math.max(0, Math.min(targetIndex, state.backlog.length));
            const [item] = state.backlog.splice(i, 1);
            if (i < idx) idx--; // account for removal before insert
            state.backlog.splice(idx, 0, item);
          }
        }
        // Move Today item back into Backlog at the drop slot
        else if (fromContext === 'today') {
          const list = state.instancesByDate[key] || [];
          const idx = list.findIndex((i) => i.id === id);
          if (idx >= 0) {
            const inst = list[idx];
            // Disallow moving daily repeating tasks out of Today
            if (inst.taskId) {
              const task = state.tasks.find((t) => t.id === inst.taskId);
              if (task && task.type === 'daily') {
                // cancel: don't move daily tasks to backlog
                cleanupDrag();
                saveState();
                render();
                return;
              }
            }
            let addedBacklogId = null;
            const clampIndex = (n) => Math.max(0, Math.min(n, state.backlog.length));
            if (inst.backlogId) {
              const existingIndex = state.backlog.findIndex((b) => b.id === inst.backlogId);
              if (existingIndex >= 0) {
                // If already exists, move it to the new slot
                const [existing] = state.backlog.splice(existingIndex, 1);
                state.backlog.splice(clampIndex(targetIndex), 0, existing);
                addedBacklogId = existing.id;
              } else {
                // Create the original backlog entry at the chosen slot
                const newItem = { id: inst.backlogId, title: inst.title, estimateMin: inst.durationEst || null, createdAt: Date.now() };
                state.backlog.splice(clampIndex(targetIndex), 0, newItem);
                addedBacklogId = newItem.id;
              }
            } else {
              // If it did not originate from backlog, create a new entry at the drop index
              const newId = uid('bl');
              const newItem = { id: newId, title: inst.title, estimateMin: inst.durationEst || null, createdAt: Date.now() };
              state.backlog.splice(clampIndex(targetIndex), 0, newItem);
              addedBacklogId = newId;
            }
            // Remove from Today
            list.splice(idx, 1);
            list.forEach((it, n) => (it.order = n));
            // Mark for scroll after render so users see it
            if (addedBacklogId) window.__pendingScrollBacklogId = addedBacklogId;
          }
        }
      }
    }

    cleanupDrag();
    saveState();
    render();

    function cleanupDrag() {
      if (drag.placeholder) drag.placeholder.remove();
      if (drag.preview && drag.preview.parentNode) drag.preview.remove();
      drag = { el: null, placeholder: null, preview: null, offset: { x: 0, y: 0 } };
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
  }

  // Allow cancelling drag from elsewhere (e.g., when opening edit modal)
  function cancelDrag() {
    if (!drag.el && !drag.placeholder && !drag.preview) return;
    if (drag.el) {
      drag.el.classList.remove('dragging');
      drag.el.style.left = drag.el.style.top = '';
      drag.el.style.width = '';
      drag.el.style.height = '';
    }
    if (drag.placeholder) drag.placeholder.remove();
    if (drag.preview && drag.preview.parentNode) drag.preview.remove();
    drag = { el: null, placeholder: null, preview: null, offset: { x: 0, y: 0 } };
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  // ---------- Maintenance actions ----------
  const clearExtrasBtn = document.getElementById('clearTodayExtras');
  if (clearExtrasBtn) clearExtrasBtn.addEventListener('click', () => {
    const key = toKey(currentDate);
    if (!state.instancesByDate[key]) return;
    state.instancesByDate[key] = state.instancesByDate[key].filter((i) => i.source === 'schedule');
    state.instancesByDate[key].forEach((i, n) => (i.order = n));
    saveState();
    render();
  });

  const resetAllBtn = document.getElementById('resetAll');
  if (resetAllBtn) resetAllBtn.addEventListener('click', () => {
    if (!confirm('Reset all local data and reload?')) return;
    localStorage.removeItem(STORAGE_KEY);
    state = defaultState();
    saveState();
    location.reload();
  });
  function getDragAfterElement(container, y) {
    const items = [...container.querySelectorAll('.bubble-item:not(.dragging):not(.placeholder)')];
    return items.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  // ---------- Analytics ----------
  function renderAnalytics() {
    // Coming soon: only show placeholder for now
    return;
  }
  function ratioToColor(r) {
    // from light gray to deep green/blue
    if (r === 0) return '#e5e7eb';
    const g = 200 - Math.floor(r * 120);
    const b = 255 - Math.floor(r * 180);
    return `rgb(120, ${g}, ${b})`;
  }

  // ---------- Settings & Briefing ----------
  function renderStorageStatus() {
    const el = document.getElementById('storageStatus');
    const fbEl = document.getElementById('firebaseStatus');
    if (el) {
      let via = 'Browser storage';
      if (prefersFirebase()) via = 'Firebase' + (fb.user ? ` (uid ${fb.user.uid.slice(0,6)}…)` : ' (not signed in)');
      el.textContent = `Storage: ${via}`;
    }
    if (fbEl) {
      if (!prefersFirebase()) fbEl.textContent = 'Firebase disconnected.';
      else if (!window.firebaseSdk) fbEl.textContent = 'Firebase SDK not loaded.';
      else if (!fb.app) fbEl.textContent = 'Enter config JSON and Connect.';
      else if (!fb.user) fbEl.textContent = 'Connected to Firebase. Not signed in.';
      else fbEl.textContent = `Signed in (uid ${fb.user.uid})`;
    }
  }
  function renderBriefing() {
    const key = toKey(currentDate);
    const list = state.instancesByDate[key] || [];
    const early = list.filter((i) => !i.completed).slice(0, 3).map((i) => `• ${i.title} (${i.durationEst || 0}m)`).join('\n');
    const totalMin = list.reduce((a, i) => a + (i.durationEst || 0), 0);
    const done = list.filter((i) => i.completed).length;
    const tone = 'Motivation-focused';
    const lines = [
      `Good morning — here\'s a gentle plan.`,
      `You\'ve got ${list.length} tasks today (${totalMin}m est). Start small:`,
      early || '• Add a quick win to get momentum',
      '',
      `Wins so far: ${done}. Keep the streak alive.`,
      `Tip: Protect a 25-minute focus block for the top task.`,
      `(Tone: ${tone})`,
    ];
    els.briefing.textContent = lines.join('\n');
  }

  // ---------- Actions ----------
  let modalTarget = null; // 'today' | 'backlog'
  let editMode = false;
  let editRef = null; // { context: 'today'|'backlog', id: string }
  function openAddModal(target) {
    editMode = false; editRef = null;
    modalTarget = target;
    if (els.addModalTitle) els.addModalTitle.textContent = target === 'today' ? 'Add to Today' : 'Add to Unscheduled';
    if (els.addModalName) els.addModalName.value = '';
    if (els.addModalTime) els.addModalTime.value = '';
    if (els.addModal) els.addModal.classList.remove('hidden');
    setTimeout(() => { if (els.addModalName) els.addModalName.focus(); }, 0);
  }
  function minutesToString(min) {
    const m = parseInt(min || 0, 10) || 0;
    if (m === 0) return '';
    if (m % 60 === 0) return (m/60) + 'h';
    return m + 'm';
  }
  function openEditModal(context, id) {
    // cancel drag if active
    cancelDrag();
    editMode = true; modalTarget = context; editRef = { context, id };
    if (els.addModalTitle) els.addModalTitle.textContent = 'Edit Task';
    if (context === 'today') {
      const key = toKey(currentDate);
      const list = state.instancesByDate[key] || [];
      const inst = list.find(i => i.id === id);
      if (inst) {
        if (els.addModalName) els.addModalName.value = inst.title || '';
        if (els.addModalTime) els.addModalTime.value = minutesToString(inst.durationEst || 0);
      }
    } else {
      const item = state.backlog.find(b => b.id === id);
      if (item) {
        if (els.addModalName) els.addModalName.value = item.title || '';
        if (els.addModalTime) els.addModalTime.value = minutesToString(item.estimateMin || 0);
      }
    }
    if (els.addModal) els.addModal.classList.remove('hidden');
    setTimeout(() => { if (els.addModalName) els.addModalName.focus(); }, 0);
  }
  function closeAddModal() {
    if (els.addModal) els.addModal.classList.add('hidden');
    modalTarget = null;
    // Reset edit state so future adds are not treated as edits
    editMode = false;
    editRef = null;
  }
  if (els.openAddToday) els.openAddToday.addEventListener('click', () => openAddModal('today'));
  if (els.openAddBacklog) els.openAddBacklog.addEventListener('click', () => openAddModal('backlog'));
  if (els.addModalCancel) els.addModalCancel.addEventListener('click', closeAddModal);
  if (els.addModal) els.addModal.addEventListener('click', (e) => { if (e.target && e.target.classList && e.target.classList.contains('modal-backdrop')) closeAddModal(); });
  async function saveFromModal() {
    const title = (els.addModalName && els.addModalName.value || '').trim();
    if (!title) { if (els.addModalName) els.addModalName.focus(); return; }
    const estMin = parseDurationToMinutes(els.addModalTime && els.addModalTime.value);
    if (editMode && editRef) {
      if (editRef.context === 'today') {
        const key = toKey(currentDate);
        const list = state.instancesByDate[key] || [];
        const inst = list.find(i => i.id === editRef.id);
        if (inst) { inst.title = title; inst.durationEst = estMin || 0; }
      } else if (editRef.context === 'backlog') {
        const item = state.backlog.find(b => b.id === editRef.id);
        if (item) { item.title = title; item.estimateMin = estMin || null; }
      }
    } else if (modalTarget === 'today') {
      const key = toKey(currentDate);
      ensureToday(key);
      const list = state.instancesByDate[key];
      const inst = { id: uid('inst'), date: key, taskId: null, title, durationEst: estMin || 0, percent: null, completed: false, actualMin: 0, order: 0, source: 'quick' };
      const completedCount = list.filter((x) => x.completed).length;
      list.splice(completedCount, 0, inst);
      list.forEach((i, n) => (i.order = n));
    } else if (modalTarget === 'backlog') {
      state.backlog.splice(0, 0, { id: uid('bl'), title, estimateMin: estMin || null, createdAt: Date.now() });
    }
    await saveState();
    render();
    closeAddModal();
  }
  if (els.addModalSave) els.addModalSave.addEventListener('click', saveFromModal);
  if (els.addModalName) els.addModalName.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveFromModal(); });
  if (els.addModalTime) els.addModalTime.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveFromModal(); });

  els.prevDay.addEventListener('click', () => { currentDate = addDays(currentDate, -1); render(); });
  els.nextDay.addEventListener('click', () => { currentDate = addDays(currentDate, 1); render(); });

  // Keyboard: 'e' to edit selected task (disabled while typing or when modal open)
  document.addEventListener('keydown', (e) => {
    if (!e.key || e.key.toLowerCase() !== 'e') return;
    // Ignore if user is typing in any input/textarea/contentEditable or modal is open
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (els.addModal && !els.addModal.classList.contains('hidden')) return;
    let el = selected.el || null;
    if (!el && drag.el) el = drag.el;
    if (!el) return;
    const context = el.getAttribute('data-context');
    const id = el.getAttribute('data-id');
    if (context && id) {
      e.preventDefault();
      openEditModal(context === 'backlog' ? 'backlog' : 'today', id);
    }
  });

  // Header icon navigation
  if (els.openAnalyticsPanel) els.openAnalyticsPanel.addEventListener('click', () => setPanel('analytics'));
  if (els.openSettingsPanel) els.openSettingsPanel.addEventListener('click', () => setPanel('settings'));
  if (els.navHome) els.navHome.addEventListener('click', () => setPanel('today'));
  // Clicking the date label brings you back to Today panel
  if (els.currentDateLabel) els.currentDateLabel.addEventListener('click', () => setPanel('today'));

  // Settings form removed; only data storage controls remain

  // Data storage controls
  const exportBtn = document.getElementById('exportJson');
  const importBtn = document.getElementById('importJson');
  const importInput = document.getElementById('importJsonInput');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'export.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
  if (importBtn && importInput) {
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
      const f = importInput.files && importInput.files[0];
      if (!f) return;
      try {
        const text = await f.text();
        const parsed = JSON.parse(text);
        if (!parsed || !parsed.tasks || !parsed.backlog) throw new Error('Invalid JSON data');
        state = parsed;
        await saveState();
        render();
        alert('Data imported.');
      } catch (e) {
        alert('Failed to import JSON: ' + e.message);
      } finally {
        importInput.value = '';
      }
    });
  }

  // ---------- Helpers ----------
  function getRedirectTo() {
    try {
      return window.location.origin + window.location.pathname;
    } catch (_) {
      return window.location.href;
    }
  }
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  // (Removed freeform parse; using explicit Name + Minutes fields)

  // ----- Time parsing + Timers & Progress helpers -----
  function parseDurationToMinutes(raw) {
    const s = (raw || '').trim();
    if (!s) return 0;
    // Support: h, hr, hrs, hour(s); m, min(s), minute(s)
    const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?$/i);
    if (!m) {
      const n = parseFloat(s);
      return Number.isFinite(n) ? Math.round(n) : 0;
    }
    const val = parseFloat(m[1]);
    const unit = (m[2] || 'm').toLowerCase();
    if (unit[0] === 'h') return Math.round(val * 60);
    return Math.round(val);
  }
  function getTotalSeconds(inst) {
    const baseSec = ((inst.actualMin || 0) * 60) + (inst.timerAccumulatedSec || 0);
    const runningSec = inst.timerStartAt ? Math.max(0, Math.floor((Date.now() - inst.timerStartAt) / 1000)) : 0;
    return baseSec + runningSec;
  }
  function getDisplayMinutes(inst) {
    return Math.floor(getTotalSeconds(inst) / 60);
  }
  function startTimer(inst) {
    if (inst.timerStartAt) return;
    inst.timerStartAt = Date.now();
  }
  function stopTimer(inst) {
    if (!inst.timerStartAt) return;
    const delta = Math.max(0, Math.floor((Date.now() - inst.timerStartAt) / 1000));
    const total = (inst.timerAccumulatedSec || 0) + delta;
    const extraMin = Math.floor(total / 60);
    inst.actualMin = (inst.actualMin || 0) + extraMin;
    inst.timerAccumulatedSec = total % 60;
    delete inst.timerStartAt;
  }

  // ---------- Init ----------
  async function init() {
    try {
      try { if (window.FIREBASE_CONFIG) localStorage.setItem(PREF_KEY, 'firebase'); } catch (_) {}
      // Always try to init Firebase on startup so email-link redirects work
      await initFirebase();
      // Migrate legacy localStorage keys to neutral ones
      try {
        if (!localStorage.getItem(STORAGE_KEY) && localStorage.getItem('focusflow_state_v2')) {
          localStorage.setItem(STORAGE_KEY, localStorage.getItem('focusflow_state_v2'));
          localStorage.removeItem('focusflow_state_v2');
        }
        if (!localStorage.getItem(PREF_KEY) && localStorage.getItem('focusflow_pref_storage')) {
          localStorage.setItem(PREF_KEY, localStorage.getItem('focusflow_pref_storage'));
          localStorage.removeItem('focusflow_pref_storage');
        }
        if (!localStorage.getItem('app_supabase_url') && localStorage.getItem('focusflow_supabase_url')) {
          localStorage.setItem('app_supabase_url', localStorage.getItem('focusflow_supabase_url'));
          localStorage.removeItem('focusflow_supabase_url');
        }
        if (!localStorage.getItem('app_supabase_anon') && localStorage.getItem('focusflow_supabase_anon')) {
          localStorage.setItem('app_supabase_anon', localStorage.getItem('focusflow_supabase_anon'));
          localStorage.removeItem('focusflow_supabase_anon');
        }
      } catch (_) {}
      // Cloud-first; no local folder/file restore
      state = await loadState();
    } catch (e) {
      console.warn('Init load failed, using defaults', e);
      state = defaultState();
    }
    rolloverIfNeeded();
    render();
    // update storage status label if present
    renderStorageStatus();

    // (Removed keyboard shortcuts to keep interactions minimal)

    // Periodic day rollover check (no timer UI)
    setInterval(() => {
      rolloverIfNeeded();
    }, 60000);

    // Supabase controls removed

    // No data folder controls in cloud-first mode

    // Firebase controls
    const fbCfgEl = document.getElementById('firebaseConfig');
    const fbConnectBtn = document.getElementById('firebaseConnect');
    const fbAnonBtn = document.getElementById('firebaseAnon');
    const fbSignOutBtn = document.getElementById('firebaseSignOut');
    const fbEmailEl = document.getElementById('firebaseEmail');
    const fbSendLinkBtn = document.getElementById('firebaseSendLink');
    if (fbConnectBtn) fbConnectBtn.addEventListener('click', async () => {
      try {
        const raw = (fbCfgEl && fbCfgEl.value || '').trim();
        if (!raw && !window.FIREBASE_CONFIG) { alert('Paste Firebase web config JSON first.'); return; }
        if (raw) localStorage.setItem('app_firebase_config', raw);
        await initFirebase();
        localStorage.setItem(PREF_KEY, 'firebase');
        renderStorageStatus();
        alert('Firebase connected. You can now sign in anonymously.');
      } catch (e) { alert('Failed to init Firebase: ' + (e.message || e)); }
    });
    if (fbAnonBtn) fbAnonBtn.addEventListener('click', async () => {
      try {
        await initFirebase();
        if (!fb.auth) { alert('Firebase not connected.'); return; }
        await window.firebaseSdk.signInAnonymously(fb.auth);
        localStorage.setItem(PREF_KEY, 'firebase');
        renderStorageStatus();
      } catch (e) { alert('Anonymous sign-in failed: ' + (e.message || e)); }
    });
    if (fbSendLinkBtn) fbSendLinkBtn.addEventListener('click', async () => {
      try {
        await initFirebase();
        if (!fb.auth) { alert('Firebase not connected.'); return; }
        const email = (fbEmailEl && fbEmailEl.value || '').trim();
        if (!email) { alert('Enter your email.'); return; }
        const url = getRedirectTo();
        await window.firebaseSdk.sendSignInLinkToEmail(fb.auth, email, { url, handleCodeInApp: true });
        localStorage.setItem('app_firebase_email_for_signin', email);
        localStorage.setItem(PREF_KEY, 'firebase');
        alert('Email link sent. Open it on this device/browser.');
      } catch (e) { alert('Failed to send email link: ' + (e.message || e)); }
    });
    if (fbSignOutBtn) fbSignOutBtn.addEventListener('click', async () => {
      try {
        if (fb.auth) await window.firebaseSdk.signOut(fb.auth);
        fb.user = null;
        renderStorageStatus();
      } catch (e) { /* ignore */ }
    });
  }
  init();
})();
