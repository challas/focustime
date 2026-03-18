(() => {
  // =========================
  // CONFIG
  // =========================
  const MAX_CHARS = 10000;

  // Server endpoint lives here (relative to /time/)
  const API_ENDPOINT = "./api/user-state.php";

  // If you set API key in PHP, set it here too. (You said: IamShiva)
  const API_KEY = "IamShiva";

  // Set false to disable all syncing and keep local-only.
  const ENABLE_SYNC = true;

  // localStorage keys
  const USERNAME_KEY = "unt_last_username_v2";
  const STATE_PREFIX = "unt_state_v2__"; // per-user: STATE_PREFIX + username

  // Debounce timings
  const SAVE_DEBOUNCE_MS = 350;
  const SYNC_DEBOUNCE_MS = 900;

  // =========================
  // DOM
  // =========================
  const el = {
    username: document.getElementById("username"),
    loadUserBtn: document.getElementById("loadUserBtn"),

    timerValue: document.getElementById("timerValue"),
    timerToggleBtn: document.getElementById("timerToggleBtn"),
    timerResetBtn: document.getElementById("timerResetBtn"),
    runningVal: document.getElementById("runningVal"),

    editor: document.getElementById("editor"),
    clearBtn: document.getElementById("clearBtn"),
    syncBtn: document.getElementById("syncBtn"),

    charCount: document.getElementById("charCount"),
    limitMsg: document.getElementById("limitMsg"),
    savedAtVal: document.getElementById("savedAtVal"),

    statusDot: document.getElementById("statusDot"),
    statusText: document.getElementById("statusText"),
  };

  // =========================
  // STATE
  // =========================
  let currentUser = "";
  let state = defaultState();
  let tickInterval = null;

  let saveTimer = null;
  let syncTimer = null;

  function defaultState() {
    return {
      editorText: "",

      // timer model:
      // elapsedMs = accumulated time when not running
      // running = true/false
      // startedAt = epoch ms when last started (only meaningful if running)
      elapsedMs: 0,
      running: false,
      startedAt: null,

      updatedAt: null,
      lastSyncedAt: null,
      syncError: null
    };
  }

  // =========================
  // HELPERS
  // =========================
  function setStatus(kind, text) {
    const colorMap = {
      ok:   { bg: "var(--good)", ring: "rgba(45,212,191,.12)" },
      warn: { bg: "var(--warn)", ring: "rgba(251,191,36,.12)" },
      bad:  { bg: "var(--bad)",  ring: "rgba(251,113,133,.12)" },
      info: { bg: "var(--accent)", ring: "rgba(110,168,255,.14)" },
    };
    const c = colorMap[kind] || colorMap.info;
    el.statusDot.style.background = c.bg;
    el.statusDot.style.boxShadow = `0 0 0 3px ${c.ring}`;
    el.statusText.textContent = text;
  }

  function normalizeUsername(raw) {
    return (raw || "").trim();
  }

  function userStorageKey(username) {
    return STATE_PREFIX + encodeURIComponent(username);
  }

  function nowMs() {
    return Date.now();
  }

  function safeJsonParse(s) {
    try { return JSON.parse(s); } catch { return null; }
  }

  function formatHMS(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const s = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const m = totalMinutes % 60;
    const h = Math.floor(totalMinutes / 60);

    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function effectiveElapsedMs(st) {
    if (!st.running || !st.startedAt) return st.elapsedMs || 0;
    const extra = Math.max(0, nowMs() - st.startedAt);
    return (st.elapsedMs || 0) + extra;
  }

  function clampToMaxChars() {
    const txt = el.editor.value || "";
    if (txt.length <= MAX_CHARS) {
      el.limitMsg.textContent = "";
      return;
    }
    el.editor.value = txt.slice(0, MAX_CHARS);
    el.limitMsg.textContent = `Limit reached (${MAX_CHARS}). Extra text was removed.`;
  }

  function updateCharCounter() {
    const len = (el.editor.value || "").length;
    el.charCount.textContent = `${len} / ${MAX_CHARS}`;
  }

  function updateTimerUI() {
    el.timerValue.textContent = formatHMS(effectiveElapsedMs(state));
    el.runningVal.textContent = state.running ? "Yes" : "No";
    el.timerToggleBtn.textContent = state.running ? "Stop" : "Start";
  }

  function updateSavedAtUI() {
    if (!state.updatedAt) {
      el.savedAtVal.textContent = "—";
      return;
    }
    el.savedAtVal.textContent = new Date(state.updatedAt).toLocaleString();
  }

  // =========================
  // LOCAL STORAGE
  // =========================
  function loadLocal(username) {
    const raw = localStorage.getItem(userStorageKey(username));
    const parsed = safeJsonParse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  }

  function persistLocal() {
    if (!currentUser) return;

    // Save textarea to state
    clampToMaxChars();
    state.editorText = el.editor.value || "";

    state.updatedAt = new Date().toISOString();

    localStorage.setItem(userStorageKey(currentUser), JSON.stringify(state));
    localStorage.setItem(USERNAME_KEY, currentUser);
    updateSavedAtUI();
  }

  function scheduleSave() {
    if (!currentUser) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persistLocal();
      setStatus("ok", "Saved locally");
      scheduleSync();
    }, SAVE_DEBOUNCE_MS);
  }

  // =========================
  // SERVER SYNC
  // =========================
  function authHeaders(extra = {}) {
    const h = { ...extra };
    if (API_KEY && API_KEY.trim() !== "") {
      h["X-Api-Key"] = API_KEY;
    }
    return h;
  }

  async function pullFromServerIfAvailable(username) {
    if (!ENABLE_SYNC) return null;

    try {
      setStatus("info", "Checking server…");

      const res = await fetch(`${API_ENDPOINT}?u=${encodeURIComponent(username)}`, {
        method: "GET",
        headers: authHeaders({ "Accept": "application/json" })
      });

      if (res.status === 404) {
        setStatus("ok", "No server copy");
        return null;
      }
      if (!res.ok) {
        throw new Error(`Server load failed (${res.status})`);
      }

      const data = await res.json();
      if (!data || typeof data !== "object" || !data.state) return null;

      setStatus("ok", "Loaded from server");
      return data.state;
    } catch (err) {
      setStatus("warn", "Server unavailable / not synced");
      return null;
    }
  }

  async function syncToServer() {
    if (!ENABLE_SYNC || !currentUser) return;

    // Make sure local is up to date before sync
    persistLocal();

    setStatus("info", "Syncing…");

    try {
      const res = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ username: currentUser, state })
      });

      if (!res.ok) throw new Error(`Sync failed (${res.status})`);

      state.lastSyncedAt = new Date().toISOString();
      state.syncError = null;
      persistLocal();

      setStatus("ok", "Synced");
    } catch (err) {
      state.syncError = String(err?.message || err);
      persistLocal();
      setStatus("warn", "Offline / not synced");
    }
  }

  function scheduleSync() {
    if (!ENABLE_SYNC || !currentUser) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { void syncToServer(); }, SYNC_DEBOUNCE_MS);
  }

  // =========================
  // USER LOAD / MERGE
  // =========================
  async function loadUser(username, preferServer = true) {
    const u = normalizeUsername(username);
    if (!u) {
      setStatus("warn", "Enter a username");
      return;
    }

    stopTick();

    currentUser = u;
    el.username.value = u;

    const local = loadLocal(u);

    let server = null;
    if (preferServer && ENABLE_SYNC) {
      server = await pullFromServerIfAvailable(u);
    }

    // Choose newest by updatedAt
    let chosen = local || defaultState();
    if (server && typeof server === "object") {
      const lts = local?.updatedAt ? Date.parse(local.updatedAt) : 0;
      const sts = server?.updatedAt ? Date.parse(server.updatedAt) : 0;
      chosen = (sts > lts) ? server : chosen;
    }

    state = { ...defaultState(), ...chosen };

    // Backward compatibility: if old state had editorHtml, convert to text once.
    if (!state.editorText && state.editorHtml) {
      const tmp = document.createElement("div");
      tmp.innerHTML = String(state.editorHtml);
      state.editorText = (tmp.innerText || "").slice(0, MAX_CHARS);
    }

    el.editor.value = (state.editorText || "").slice(0, MAX_CHARS);
    updateCharCounter();
    updateTimerUI();
    updateSavedAtUI();

    localStorage.setItem(USERNAME_KEY, currentUser);

    startTick();
    setStatus("ok", "User loaded");
  }

  // =========================
  // TIMER
  // =========================
  function startTick() {
    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(updateTimerUI, 250);
  }

  function stopTick() {
    if (tickInterval) clearInterval(tickInterval);
    tickInterval = null;
  }

  function onToggleTimer() {
    if (!currentUser) { setStatus("warn", "Set username first"); return; }

    if (!state.running) {
      state.running = true;
      state.startedAt = nowMs();
      setStatus("ok", "Timer started");
    } else {
      const extra = state.startedAt ? Math.max(0, nowMs() - state.startedAt) : 0;
      state.elapsedMs = (state.elapsedMs || 0) + extra;
      state.running = false;
      state.startedAt = null;
      setStatus("ok", "Timer stopped");
    }

    updateTimerUI();
    scheduleSave();
  }

  function onResetTimer() {
    if (!currentUser) { setStatus("warn", "Set username first"); return; }

    state.elapsedMs = 0;
    state.startedAt = state.running ? nowMs() : null;
    updateTimerUI();

    setStatus("ok", "Timer reset");
    scheduleSave();
  }

  // =========================
  // EVENTS
  // =========================
  function onUsernameKeydown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      void loadUser(el.username.value, true);
    }
  }

  function onEditorInput() {
    if (!currentUser) return;
    clampToMaxChars();
    updateCharCounter();
    scheduleSave();
  }

  function onClear() {
    if (!currentUser) { setStatus("warn", "Set username first"); return; }
    el.editor.value = "";
    updateCharCounter();
    setStatus("ok", "Cleared");
    scheduleSave();
  }

  function onSyncNow() {
    if (!currentUser) { setStatus("warn", "Set username first"); return; }
    void syncToServer();
  }

  function onVisibilityChange() {
    if (document.visibilityState === "hidden") {
      persistLocal();
      if (ENABLE_SYNC) void syncToServer();
    }
  }

  // =========================
  // INIT
  // =========================
  function init() {
    el.loadUserBtn.addEventListener("click", () => void loadUser(el.username.value, true));
    el.username.addEventListener("keydown", onUsernameKeydown);

    el.timerToggleBtn.addEventListener("click", onToggleTimer);
    el.timerResetBtn.addEventListener("click", onResetTimer);

    el.editor.addEventListener("input", onEditorInput);

    el.clearBtn.addEventListener("click", onClear);
    el.syncBtn.addEventListener("click", onSyncNow);

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("beforeunload", persistLocal);

    const last = normalizeUsername(localStorage.getItem(USERNAME_KEY));
    if (last) {
      el.username.value = last;
      void loadUser(last, true);
    } else {
      setStatus("info", "Enter username to begin");
      startTick();
    }
  }

  init();
})();