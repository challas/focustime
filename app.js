(() => {
  const MAX_CHARS = 10000;
  const API_ENDPOINT = "./api/user-state.php";
  const ENABLE_SYNC = true;
  const START_LAP_LABEL = "Start Task";
  const TASK_STATUS_IDLE = "select a line/task and click 'start task'";

  const USERNAME_KEY = "unt_last_username_v5";
  const STATE_PREFIX = "unt_state_v5__";

  const SAVE_DEBOUNCE_MS = 300;
  const SYNC_DEBOUNCE_MS = 900;

  const el = {
    username: document.getElementById("username"),
    loadUserBtn: document.getElementById("loadUserBtn"),
    pin: document.getElementById("pin"),
    authMsg: document.getElementById("authMsg"),
    taskStatus: document.getElementById("taskStatus"),

    timerToggleBtn: document.getElementById("timerToggleBtn"),
    timerResetBtn: document.getElementById("timerResetBtn"),
    notesLabel: document.getElementById("notesLabel"),

    editor: document.getElementById("editor"),
    startLapBtn: document.getElementById("startLapBtn"),
    pauseLapBtn: document.getElementById("pauseLapBtn"),
    stopLapBtn: document.getElementById("stopLapBtn"),
    clearBtn: document.getElementById("clearBtn"),
    syncBtn: document.getElementById("syncBtn"),

    limitMsg: document.getElementById("limitMsg"),

    statusDot: document.getElementById("statusDot"),
    statusText: document.getElementById("statusText"),

    logContainer: document.getElementById("logContainer"),
  };

  let currentUser = "";
  let state = defaultState();
  let tickInterval = null;
  let saveTimer = null;
  let syncTimer = null;

  function defaultState() {
    return {
      editorText: "",
      elapsedMs: 0,
      running: false,
      startedAt: null,


      // Lap timer
      lap: {
        currentLine: null,
        startTime: null,
        pausedTime: 0,
        isRunning: false,
        isPaused: false,
        totalTime: 0
      },

      // Log of completed tasks
      log: [],

      updatedAt: null,
      lastSyncedAt: null,
      syncError: null
    };
  }

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

  function showAuthMsg(msg) {
    el.authMsg.textContent = msg || "";
  }

  function pinHintText(hint) {
    const t = String(hint || "").trim();
    return t ? ` PIN Hint: ${t}` : "";
  }

  function normalizeUsername(raw) { return (raw || "").trim(); }
  function userStorageKey(username) { return STATE_PREFIX + encodeURIComponent(username); }
  function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }
  function nowMs() { return Date.now(); }

  function formatHMS(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const s = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const m = totalMinutes % 60;
    const h = Math.floor(totalMinutes / 60);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function autoGrowTextarea() {
    const ta = el.editor;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
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

  function updateMetrics() {
    const txt = el.editor.value || "";
    const chars = txt.length;

    el.notesLabel.textContent = `Notes (${chars}/${MAX_CHARS} chars)`;
    // also update textarea aria-label for screen readers
    el.editor.setAttribute("aria-label", `Notes (${chars}/${MAX_CHARS} chars)`);

  }

  function updateTimerUI() {
    el.timerToggleBtn.textContent = state.running ? "Stop" : "Start";
  }



  // localStorage
  function loadLocal(username) {
    const raw = localStorage.getItem(userStorageKey(username));
    const parsed = safeJsonParse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  }

  function persistLocal() {
    if (!currentUser) return;

    clampToMaxChars();
    state.editorText = el.editor.value || "";
    state.updatedAt = new Date().toISOString();

    localStorage.setItem(userStorageKey(currentUser), JSON.stringify(state));
    localStorage.setItem(USERNAME_KEY, currentUser);
  }

  function scheduleSave() {
    if (!currentUser) return;
    clearTimeout(saveTimer);
    setStatus("info", "Saving...");
    saveTimer = setTimeout(() => {
      persistLocal();
      setStatus("ok", "Saved");
      scheduleSync();
    }, SAVE_DEBOUNCE_MS);
  }

  function authHeaders(extra = {}) {
    const h = { ...extra };

    const pin = (el.pin.value || "").trim();
    if (pin) h["X-User-Pin"] = pin;

    return h;
  }

  async function pullFromServer(username) {
    if (!ENABLE_SYNC) return null;

    try {
      setStatus("info", "Loading...");
      showAuthMsg("");

      const res = await fetch(`${API_ENDPOINT}?u=${encodeURIComponent(username)}`, {
        method: "GET",
        headers: authHeaders({ "Accept": "application/json" })
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 401 && (data?.error === "PIN_REQUIRED" || data?.error === "PIN_SETUP_REQUIRED")) {
        showAuthMsg(data?.error === "PIN_SETUP_REQUIRED"
          ? "PIN setup is required for this username. Enter a PIN and click Sync."
          : `PIN required or incorrect. Enter the correct PIN and click Load again.${pinHintText(data?.hint)}`
        );
        setStatus("warn", "PIN required");
        return null;
      }

      if (res.status === 404) {
        setStatus("ok", "No server copy");
        return null;
      }

      if (res.status === 429) {
        const wait = Number(data?.retryAfterSec) || 0;
        showAuthMsg(wait > 0 ? `Too many PIN attempts. Try again in ${wait}s.` : "Too many PIN attempts. Try again later.");
        setStatus("warn", "Too many attempts");
        return null;
      }

      if (!res.ok) throw new Error(`Server load failed (${res.status})`);

      setStatus("ok", "Loaded");
      return data.state || null;
    } catch {
      setStatus("warn", "Offline");
      return null;
    }
  }

  async function syncToServer(pinHintOverride = "") {
    if (!ENABLE_SYNC || !currentUser) return;

    persistLocal();

    setStatus("info", "Syncing...");
    showAuthMsg("");

    const pin = (el.pin.value || "").trim();
    const hint = String(pinHintOverride || "").trim();

    try {
      const res = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ username: currentUser, pin, pinHint: hint, state })
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 401 && (data?.error === "PIN_REQUIRED" || data?.error === "PIN_SETUP_REQUIRED")) {
        if (data?.error === "PIN_SETUP_REQUIRED") {
          if (!pin) {
            showAuthMsg("New user setup: enter a PIN, then click Sync.");
            setStatus("warn", "PIN required");
            return;
          }

          const askedHint = prompt("New user setup: add a PIN hint (required).");
          const normalizedHint = (askedHint || "").trim();
          if (!normalizedHint) {
            showAuthMsg("PIN hint is required for new user setup.");
            setStatus("warn", "PIN hint required");
            return;
          }
          void syncToServer(normalizedHint);
          return;
        }

        showAuthMsg(`PIN required or incorrect. Enter the correct PIN and click Sync.${pinHintText(data?.hint)}`);
        setStatus("warn", "PIN required");
        return;
      }

      if (data?.error === "PIN_HINT_REQUIRED") {
        const askedHint = prompt("New user setup: add a PIN hint (required).");
        const normalizedHint = (askedHint || "").trim();
        if (!normalizedHint) {
          showAuthMsg("PIN hint is required for new user setup.");
          setStatus("warn", "PIN hint required");
          return;
        }
        void syncToServer(normalizedHint);
        return;
      }

      if (res.status === 429) {
        const wait = Number(data?.retryAfterSec) || 0;
        showAuthMsg(wait > 0 ? `Too many PIN attempts. Try again in ${wait}s.` : "Too many PIN attempts. Try again later.");
        setStatus("warn", "Too many attempts");
        return;
      }

      if (!res.ok) throw new Error(`Sync failed (${res.status})`);

      state.lastSyncedAt = new Date().toISOString();
      state.syncError = null;
      persistLocal();

      setStatus("ok", "Synced");
    } catch (err) {
      state.syncError = String(err?.message || err);
      persistLocal();
      setStatus("warn", "Offline");
    }
  }

  function scheduleSync() {
    if (!ENABLE_SYNC || !currentUser) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { void syncToServer(); }, SYNC_DEBOUNCE_MS);
  }

  async function loadUser(username, preferServer = true) {
    const u = normalizeUsername(username);
    if (!u) { setStatus("warn", "Enter a username"); return; }

    currentUser = u;
    el.username.value = u;

    const local = loadLocal(u);
    let server = null;

    if (preferServer && ENABLE_SYNC) server = await pullFromServer(u);

    let chosen = local || defaultState();
    if (server && typeof server === "object") {
      const lts = local?.updatedAt ? Date.parse(local.updatedAt) : 0;
      const sts = server?.updatedAt ? Date.parse(server.updatedAt) : 0;
      chosen = (sts > lts) ? server : chosen;
    }

    state = { ...defaultState(), ...chosen };


    // Ensure lap state is initialized
    if (!state.lap) state.lap = defaultState().lap;
    if (!state.log) state.log = [];

    el.editor.value = (state.editorText || "").slice(0, MAX_CHARS);
    clampToMaxChars();
    autoGrowTextarea();

    updateMetrics();

    updateTimerUI();
    syncLapControls();
    renderLog();

    localStorage.setItem(USERNAME_KEY, currentUser);

    startTick();
    setStatus("ok", "User loaded");
  }

  // Timer tick
  function startTick() {
    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(updateTimerUI, 250);
  }

  function onToggleTimer() {
    if (!currentUser) { setStatus("warn", "Set username first"); return; }

    if (!state.running) {
      state.running = true;
      state.startedAt = nowMs();


      setStatus("ok", "Timer started");
    } else {
      // Stop main
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

    // Reset main
    state.elapsedMs = 0;
    state.startedAt = state.running ? nowMs() : null;

    updateTimerUI();
    setStatus("ok", "Timer reset");
    scheduleSave();
  }

  function onUsernameKeydown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      void loadUser(el.username.value, true);
    }
  }

  function onEditorInput() {
    if (!currentUser) return;

    clampToMaxChars();
    autoGrowTextarea();

    updateMetrics();
    scheduleSave();
  }

  function onClear() {
    if (!currentUser) { setStatus("warn", "Set username first"); return; }
    if (confirm("Are you sure you want to clear all notes? This action cannot be undone.")) {
      el.editor.value = "";
      autoGrowTextarea();
      updateMetrics();
      setStatus("ok", "Cleared");
      scheduleSave();
    }
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

  function getSelectedLineText() {
    const textarea = el.editor;
    const text = textarea.value;
    const selStart = textarea.selectionStart;
    const selEnd = textarea.selectionEnd;

    if (selStart === selEnd) {
      return null; // No selection
    }

    // Find the start of the line containing selStart
    let lineStart = selStart;
    while (lineStart > 0 && text[lineStart - 1] !== "\n") {
      lineStart--;
    }

    // Find the end of the line containing selStart
    let lineEnd = selStart;
    while (lineEnd < text.length && text[lineEnd] !== "\n") {
      lineEnd++;
    }

    const selectedLine = text.substring(lineStart, lineEnd);
    return { text: selectedLine, start: lineStart, end: lineEnd };
  }

  function onStartLap() {
    if (!currentUser) { setStatus("warn", "Set username first"); return; }

    const selected = getSelectedLineText();
    if (!selected) {
      setStatus("warn", "Please select a line/task to time");
      return;
    }

    state.lap.currentLine = selected.text;
    state.lap.startTime = nowMs();
    state.lap.pausedTime = 0;
    state.lap.isRunning = true;
    state.lap.isPaused = false;
    state.lap.totalTime = 0;

    el.startLapBtn.disabled = true;
    el.pauseLapBtn.disabled = false;
    el.stopLapBtn.disabled = false;

    setStatus("ok", `Task timer started for: "${selected.text}"`);
    updateLapTimerUI();
    updateTaskStatusLabel();
    scheduleSave();
  }

  function onPauseLap() {
    if (!state.lap.isRunning) return;

    if (!state.lap.isPaused) {
      // Pause
      const elapsed = nowMs() - state.lap.startTime;
      state.lap.pausedTime += elapsed;
      state.lap.isPaused = true;
      state.lap.startTime = nowMs();

      el.pauseLapBtn.textContent = "Resume";
      setStatus("ok", "Task timer paused - [PAUSED]");
    } else {
      // Resume
      state.lap.startTime = nowMs();
      state.lap.isPaused = false;

      el.pauseLapBtn.textContent = "Pause";
      setStatus("ok", "Task timer resumed");
    }

    updateLapTimerUI();
    updateTaskStatusLabel();
    scheduleSave();
  }

  function onStopLap() {
    if (!state.lap.isRunning) return;

    const elapsed = nowMs() - state.lap.startTime;
    state.lap.totalTime = state.lap.pausedTime + (state.lap.isPaused ? 0 : elapsed);

    // Create log entry
    const logEntry = {
      task: state.lap.currentLine,
      elapsed: state.lap.totalTime,
      timestamp: new Date().toISOString()
    };

    if (!state.log) state.log = [];
    state.log.push(logEntry);

    // Append the line to the bottom with time spent
    const textarea = el.editor;
    const text = textarea.value;
    const timeStr = formatHMS(state.lap.totalTime);
    const appendedLine = state.lap.currentLine + " [Time spent: " + timeStr + "]";

    // Append to the end
    const newText = text + "\n" + appendedLine;
    el.editor.value = newText;
    autoGrowTextarea();
    updateMetrics();

    // Reset lap state
    state.lap = {
      currentLine: null,
      startTime: null,
      pausedTime: 0,
      isRunning: false,
      isPaused: false,
      totalTime: 0
    };

    el.startLapBtn.disabled = false;
    el.startLapBtn.textContent = START_LAP_LABEL;
    el.pauseLapBtn.disabled = true;
    el.pauseLapBtn.textContent = "Pause";
    el.stopLapBtn.disabled = true;

    setStatus("ok", "Task timer stopped and logged");
    updateTaskStatusLabel();
    renderLog();
    scheduleSave();
  }

  function lapElapsedMs() {
    if (!state.lap || !state.lap.isRunning) return 0;
    return state.lap.pausedTime + (state.lap.isPaused ? 0 : (nowMs() - state.lap.startTime));
  }

  function updateLapTimerUI() {
    if (!state.lap.isRunning) return;

    const elapsed = lapElapsedMs();
    const display = formatHMS(elapsed);

    if (state.lap.isPaused) {
      el.startLapBtn.textContent = `Task: ${display} [PAUSED]`;
    } else {
      el.startLapBtn.textContent = `Task: ${display}`;
    }
  }

  function updateTaskStatusLabel() {
    if (!el.taskStatus) return;
    if (!currentUser || !state.lap || !state.lap.isRunning || !state.lap.currentLine) {
      el.taskStatus.textContent = TASK_STATUS_IDLE;
      return;
    }

    const display = formatHMS(lapElapsedMs());
    el.taskStatus.textContent = `${currentUser} is working on ${state.lap.currentLine} for ${display}`;
  }

  function syncLapControls() {
    const lap = state.lap || defaultState().lap;
    if (!lap.isRunning) {
      el.startLapBtn.disabled = false;
      el.startLapBtn.textContent = START_LAP_LABEL;
      el.pauseLapBtn.disabled = true;
      el.pauseLapBtn.textContent = "Pause";
      el.stopLapBtn.disabled = true;
      updateTaskStatusLabel();
      return;
    }

    el.startLapBtn.disabled = true;
    el.pauseLapBtn.disabled = false;
    el.pauseLapBtn.textContent = lap.isPaused ? "Resume" : "Pause";
    el.stopLapBtn.disabled = false;
    updateLapTimerUI();
    updateTaskStatusLabel();
  }

  function renderLog() {
    el.logContainer.textContent = "";

    if (!state.log || state.log.length === 0) {
      const empty = document.createElement("div");
      empty.style.color = "var(--muted)";
      empty.textContent = "No logged tasks yet";
      el.logContainer.appendChild(empty);
      return;
    }

    state.log.forEach((entry) => {
      const row = document.createElement("div");
      row.style.margin = "4px 0";

      const task = document.createElement("strong");
      task.textContent = String(entry.task || "");

      row.appendChild(task);
      row.appendChild(document.createTextNode(` - ${formatHMS(Number(entry.elapsed) || 0)}`));
      el.logContainer.appendChild(row);
    });
  }

  function init() {
    el.loadUserBtn.addEventListener("click", () => void loadUser(el.username.value, true));
    el.username.addEventListener("keydown", onUsernameKeydown);

    el.timerToggleBtn.addEventListener("click", onToggleTimer);
    el.timerResetBtn.addEventListener("click", onResetTimer);

    el.startLapBtn.addEventListener("click", onStartLap);
    el.pauseLapBtn.addEventListener("click", onPauseLap);
    el.stopLapBtn.addEventListener("click", onStopLap);

    el.editor.addEventListener("input", onEditorInput);
    window.addEventListener("resize", autoGrowTextarea);

    el.clearBtn.addEventListener("click", onClear);
    el.syncBtn.addEventListener("click", onSyncNow);

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("beforeunload", persistLocal);

    // Update lap timer display every 100ms if running
    setInterval(() => {
      if (state.lap && state.lap.isRunning) {
        updateLapTimerUI();
        updateTaskStatusLabel();
      }
    }, 100);

    const last = normalizeUsername(localStorage.getItem(USERNAME_KEY));
    if (last) {
      el.username.value = last;
      void loadUser(last, true);
    } else {
      setStatus("info", "Enter username to begin");
      updateTaskStatusLabel();
      startTick();
      autoGrowTextarea();
      updateMetrics();
    }
  }

  init();
})();
