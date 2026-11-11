// ==UserScript==
// @name           daily-widget
// @include        main
// ==/UserScript==
//
// Daily checklist widget for the Zen sidebar.
// NOTE: keep this file pure ASCII. The loader reads it as Latin-1, so any
// raw UTF-8 symbol shows up as garbage. Use \uXXXX escapes in strings.
//
// v1.0.0
//  - Checklist of your own daily tasks. Tick one and it is "done for today";
//    ticked tasks disappear (setting) and come back the next day.
//  - Per task (pencil button = edit mode, click a task to open its options):
//      * times per day: 1 = a normal checkbox, 3 = needs three ticks
//        ("Drink water 1/3"); click = +1, right-click = -1
//      * optional timer in minutes: play / pause, right-click = reset.
//        When it reaches zero it plays a chime and ticks the task for you.
//        Timers keep running while the window is minimised and survive a
//        browser restart (they are stored as an end time).
//      * optional weekdays (e.g. gym only Mon / Wed / Fri)
//  - Edit mode shows every task, also the hidden ones, with a note about
//    when each one comes back ("done, back tomorrow", "back Mon").
//  - Settings (gear in edit mode): hide ticked tasks or just keep them
//    ticked (default: hide), sound on/off, test sound, untick everything.
//  - Mounts ABOVE the Anki and SoundCloud widgets, whatever loads first.
//  - Everything is stored in about:config under "daily-widget.*" and shared
//    between windows. Extra prefs (about:config, optional):
//      daily-widget.day-start-hour  (int, default 4)  a "day" rolls over at
//                                   this hour, so 01:30 still counts as
//                                   yesterday. Set 0 for plain midnight.
//      daily-widget.volume          (int 0-100, default 60)

(() => {
  "use strict";

  const DAILY_WIDGET_VERSION = "1.0.0";
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first

  // =====================================================================
  // CHROME SIDE (the widget itself)
  // =====================================================================
  function dailyWidgetInit() {
    if (document.getElementById("daily-widget")) return;
    console.log("[DAILY-WIDGET] init v" + DAILY_WIDGET_VERSION);

    // ---- Palette (same neutral glass palette as the other widgets) ----
    const COL_BG = "#18181b";
    const COL_TEXT = "#f4f4f5";
    const COL_SELECTION = "rgba(255, 255, 255, 0.14)";
    const COL_SURFACE = "rgba(255, 255, 255, 0.08)";
    const COL_SURFACE_SOFT = "rgba(255, 255, 255, 0.05)";
    const COL_TEXT_DIM = "rgba(255, 255, 255, 0.74)";
    const COL_TEXT_FAINT = "rgba(255, 255, 255, 0.50)";
    const SVG_NS = "http://www.w3.org/2000/svg";

    // =================== PREFS (about:config "daily-widget.*") ===================
    const PREFIX = "daily-widget.";
    function getInt(n, d) {
      try { return Services.prefs.getIntPref(PREFIX + n, d); } catch (e) { return d; }
    }
    function getStr(n, d) {
      try { return Services.prefs.getStringPref(PREFIX + n, d); } catch (e) { return d; }
    }
    function getBool(n, d) {
      try { return Services.prefs.getBoolPref(PREFIX + n, d); } catch (e) { return d; }
    }
    // Our own writes must not trigger our own pref observer (it would rebuild
    // the UI while you are typing), so writes raise a flag.
    let writing = false;
    function setPref(kind, n, v) {
      writing = true;
      try { Services.prefs[kind](PREFIX + n, v); } catch (e) {} finally { writing = false; }
    }

    const DAY_START_H = Math.min(12, Math.max(0, getInt("day-start-hour", 4)));

    function pad2(n) { return (n < 10 ? "0" : "") + n; }
    function clampInt(v, lo, hi, d) {
      v = Math.round(Number(v));
      if (!isFinite(v)) return d;
      return Math.min(hi, Math.max(lo, v));
    }
    function shiftedNow() { return new Date(Date.now() - DAY_START_H * 3600000); }
    function dayKey() {
      const d = shiftedNow();
      return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    }
    function weekday() { return shiftedNow().getDay(); } // 0 = Sunday
    function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

    // =================== DATA ===================
    // items:  [{ id, text, times, minutes, days }]   days = [] means every day
    // state:  { date: "YYYY-MM-DD", counts: { id: n } }   resets every day
    // timers: { id: { end: epochMs } (running) | { left: ms } (paused) }
    let items = [];
    let state = { date: "", counts: {} };
    let timers = {};
    let hideDone = true;
    let soundOn = true;
    let volume = 60;

    function loadSettings() {
      hideDone = getBool("hide-done", true);
      soundOn = getBool("sound", true);
      volume = clampInt(getInt("volume", 60), 0, 100, 60);
    }
    function loadItems() {
      const out = [];
      try {
        const a = JSON.parse(getStr("items", "[]"));
        if (Array.isArray(a)) {
          for (const x of a) {
            if (!x || typeof x.id !== "string" || typeof x.text !== "string") continue;
            let days = Array.isArray(x.days)
              ? Array.from(new Set(x.days.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)))
              : [];
            days.sort((p, q) => p - q);
            if (days.length === 7) days = [];
            out.push({
              id: x.id,
              text: x.text.slice(0, 120),
              times: clampInt(x.times, 1, 99, 1),
              minutes: clampInt(x.minutes, 0, 600, 0),
              days,
            });
          }
        }
      } catch (e) {}
      items = out;
    }
    function loadState() {
      let s = null;
      try { s = JSON.parse(getStr("state", "{}")); } catch (e) {}
      const counts = {};
      const today = dayKey();
      if (s && s.date === today && s.counts && typeof s.counts === "object") {
        for (const k of Object.keys(s.counts)) {
          const n = s.counts[k];
          if (Number.isInteger(n) && n > 0) counts[k] = n;
        }
      }
      state = { date: today, counts };
    }
    function loadTimers() {
      const out = {};
      try {
        const o = JSON.parse(getStr("timers", "{}"));
        if (o && typeof o === "object") {
          for (const k of Object.keys(o)) {
            const t = o[k];
            if (!t || typeof t !== "object") continue;
            if (typeof t.end === "number" && isFinite(t.end)) out[k] = { end: t.end };
            else if (typeof t.left === "number" && isFinite(t.left)) out[k] = { left: Math.max(1000, t.left) };
          }
        }
      } catch (e) {}
      timers = out;
    }
    function loadAll() {
      loadSettings();
      loadItems();
      loadState();
      loadTimers();
    }
    function saveItems() {
      for (const it of items) {
        if (it.days.length === 7) it.days = [];
        it.days.sort((p, q) => p - q);
      }
      setPref("setStringPref", "items", JSON.stringify(items));
    }
    function saveState() { setPref("setStringPref", "state", JSON.stringify(state)); }
    function saveTimers() { setPref("setStringPref", "timers", JSON.stringify(timers)); }

    function ensureToday() {
      if (state.date !== dayKey()) {
        state = { date: dayKey(), counts: {} };
        saveState();
      }
    }
    function isScheduled(it, wd) { return !it.days.length || it.days.indexOf(wd) !== -1; }
    function countOf(it) { return state.counts[it.id] || 0; }
    function isDone(it) { return countOf(it) >= it.times; }

    // =================== DOM ===================
    const widgetDiv = document.createElement("div");
    widgetDiv.id = "daily-widget";

    const styleTag = document.createElement("style");
    styleTag.textContent = `
      #daily-widget {
        position: relative; display: flex; flex-direction: column; gap: 4px;
        flex-shrink: 0; min-width: 0; max-width: calc(100% - 16px);
        contain: inline-size; overflow: hidden;
        margin: 6px 8px 3px; padding: 8px 8px 8px 10px; box-sizing: border-box;
        -moz-window-dragging: no-drag;
        background: transparent;
        backdrop-filter: blur(14px) saturate(160%);
        border: none; border-radius: 16px;
        box-shadow: 0 12px 32px -10px rgba(0, 0, 0, 0.28);
        font-family: system-ui, -apple-system, sans-serif; color: ${COL_TEXT}; font-size: 11px;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.42);
        animation: dw-in 0.25s ease backwards;
      }
      @keyframes dw-in { from { opacity: 0; transform: translateY(4px); } }
      #daily-widget * { -moz-window-dragging: no-drag; }
      /* Glass rim: one flat, faint 1px ring, identical all the way round. */
      #daily-widget::before {
        content: ""; position: absolute; inset: 0; padding: 1px; box-sizing: border-box;
        border-radius: inherit; pointer-events: none;
        background: rgba(255, 255, 255, 0.10);
        mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        mask-composite: exclude;
        transition: background-color 0.15s ease;
      }
      #daily-widget::after {
        content: ""; position: absolute; inset: 0; border-radius: inherit;
        z-index: -1; pointer-events: none;
        background: rgba(255, 255, 255, 0.06);
        opacity: 0; transition: opacity 0.15s ease;
      }
      #daily-widget:hover::after { opacity: 1; }
      #daily-widget:hover::before { background: rgba(255, 255, 255, 0.20); }
      #daily-widget.dw-ring::before { animation: dw-ring 1s ease-in-out 6; }
      @keyframes dw-ring {
        0%, 100% { background: rgba(255, 255, 255, 0.10); }
        50% { background: rgba(255, 255, 255, 0.60); }
      }
      #daily-widget *::selection { background-color: ${COL_SELECTION}; color: ${COL_TEXT}; }
      #daily-widget.dw-narrow { display: none !important; }

      /* two views: main list / edit panel */
      #daily-widget .dw-main, #daily-widget .dw-edit { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      #daily-widget.dw-editing .dw-main { display: none !important; }
      #daily-widget:not(.dw-editing) .dw-edit { display: none !important; }

      #daily-widget .dw-head {
        display: flex; align-items: center; gap: 6px; min-height: 20px; padding-left: 2px;
      }
      #daily-widget .dw-title { font-size: 12px; font-weight: 700; }
      #daily-widget .dw-progress { color: ${COL_TEXT_FAINT}; font-size: 10.5px; font-variant-numeric: tabular-nums; }
      #daily-widget .dw-spacer { flex: 1; }
      #daily-widget[data-complete="1"] .dw-progress { color: ${COL_TEXT_DIM}; }

      /* round flat buttons */
      #daily-widget .dw-btn {
        appearance: none; border: none; margin: 0; padding: 0;
        font: inherit; color: inherit; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
        background-color: ${COL_SURFACE};
        transition: background-color 0.12s ease, transform 0.08s ease, opacity 0.15s ease;
      }
      #daily-widget .dw-btn:hover { background-color: ${COL_SELECTION}; }
      #daily-widget .dw-btn:active { transform: scale(0.92); }
      #daily-widget .dw-main .dw-head .dw-btn { opacity: 0.5; }
      #daily-widget:hover .dw-main .dw-head .dw-btn { opacity: 1; }

      /* ---- main list ---- */
      #daily-widget .dw-list {
        display: flex; flex-direction: column; gap: 1px;
        max-height: 200px; overflow-y: auto; overflow-x: hidden;
        margin: 0 -4px; padding: 0 4px;
        scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
      }
      #daily-widget .dw-row {
        display: flex; align-items: center; gap: 8px; min-width: 0;
        padding: 4px 5px; border-radius: 8px; cursor: pointer;
        transition: background-color 0.12s ease;
      }
      #daily-widget .dw-row:hover { background: ${COL_SURFACE}; }
      #daily-widget .dw-row-text {
        flex: 1; min-width: 0; font-size: 11.5px; color: rgba(255, 255, 255, 0.92);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      #daily-widget .dw-row.dw-done .dw-row-text { color: ${COL_TEXT_FAINT}; text-decoration: line-through; }
      #daily-widget .dw-badge {
        flex-shrink: 0; font-size: 10px; color: ${COL_TEXT_FAINT}; font-variant-numeric: tabular-nums;
      }
      #daily-widget .dw-check {
        display: flex; align-items: center; justify-content: center;
        width: 14px; height: 14px; border-radius: 5px; flex-shrink: 0; box-sizing: border-box;
        border: 1.5px solid ${COL_TEXT_FAINT};
        transition: background-color 0.12s ease, border-color 0.12s ease;
      }
      #daily-widget .dw-check svg { opacity: 0; }
      #daily-widget .dw-check.dw-on { background: ${COL_TEXT}; border-color: ${COL_TEXT}; }
      #daily-widget .dw-check.dw-on svg { opacity: 1; }

      #daily-widget .dw-timer {
        appearance: none; border: none; margin: 0; padding: 0 8px 0 6px; height: 18px;
        display: flex; align-items: center; gap: 4px; flex-shrink: 0;
        border-radius: 9px; box-sizing: border-box; cursor: pointer;
        font: inherit; font-size: 10px; font-variant-numeric: tabular-nums; color: ${COL_TEXT_DIM};
        background: ${COL_SURFACE};
        transition: background-color 0.12s ease, color 0.12s ease;
      }
      #daily-widget .dw-timer:hover { background: ${COL_SELECTION}; color: ${COL_TEXT}; }
      #daily-widget .dw-timer.dw-running { background: rgba(255, 255, 255, 0.16); color: ${COL_TEXT}; }
      #daily-widget .dw-timer.dw-paused { opacity: 0.7; }

      #daily-widget .dw-empty {
        padding: 10px 6px 8px; text-align: center; color: ${COL_TEXT_FAINT};
        font-size: 10.5px; line-height: 1.45; white-space: pre-line;
      }

      /* ---- edit panel ---- */
      #daily-widget .dw-head-edit { display: grid; grid-template-columns: 18px 1fr 18px; gap: 6px; }
      #daily-widget .dw-head-edit .dw-title { text-align: center; }
      #daily-widget .dw-settings {
        display: none; flex-direction: column; gap: 3px;
        padding: 6px 6px 7px; border-radius: 10px; background: ${COL_SURFACE_SOFT};
      }
      #daily-widget.dw-settings-open .dw-settings { display: flex; }
      #daily-widget .dw-toggle {
        display: flex; align-items: center; gap: 8px; padding: 3px 2px; border-radius: 6px; cursor: pointer;
        font-size: 10.5px; color: rgba(255, 255, 255, 0.88);
      }
      #daily-widget .dw-toggle:hover { background: ${COL_SURFACE}; }
      #daily-widget .dw-pills { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 3px; }
      #daily-widget .dw-pill {
        appearance: none; border: none; margin: 0; padding: 0 9px; height: 20px;
        border-radius: 10px; box-sizing: border-box; cursor: pointer;
        font: inherit; font-size: 10px; font-weight: 600; white-space: nowrap;
        background: ${COL_SURFACE}; color: ${COL_TEXT_DIM};
        transition: background-color 0.12s ease, color 0.12s ease;
      }
      #daily-widget .dw-pill:hover { background: ${COL_SELECTION}; color: ${COL_TEXT}; }

      #daily-widget .dw-elist {
        display: flex; flex-direction: column; gap: 1px;
        max-height: 250px; overflow-y: auto; overflow-x: hidden;
        margin: 0 -4px; padding: 0 4px;
        scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
      }
      #daily-widget .dw-erow { padding: 4px 6px; border-radius: 8px; cursor: pointer; min-width: 0; transition: background-color 0.12s ease; }
      #daily-widget .dw-erow:hover { background: ${COL_SURFACE}; }
      #daily-widget .dw-eitem.dw-open .dw-erow { background: ${COL_SURFACE}; }
      #daily-widget .dw-erow-name {
        font-size: 11.5px; color: rgba(255, 255, 255, 0.92);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      #daily-widget .dw-erow-meta {
        font-size: 9.5px; color: ${COL_TEXT_FAINT}; margin-top: 1px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      #daily-widget .dw-editor {
        display: flex; flex-direction: column; gap: 7px;
        padding: 8px 7px 8px; margin: 2px 0 4px; border-radius: 10px; background: ${COL_SURFACE_SOFT};
      }
      #daily-widget .dw-field {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        font-size: 10.5px; color: ${COL_TEXT_DIM};
      }
      #daily-widget .dw-field-col { flex-direction: column; align-items: stretch; gap: 4px; }
      #daily-widget .dw-input {
        appearance: none; border: none; margin: 0; outline: none;
        background: rgba(255, 255, 255, 0.10); color: ${COL_TEXT};
        border-radius: 8px; padding: 5px 9px; box-sizing: border-box;
        font: inherit; font-size: 11px; min-width: 0; width: 100%;
        text-shadow: none;
        transition: background-color 0.12s ease;
      }
      #daily-widget .dw-input:focus { background: rgba(255, 255, 255, 0.17); }
      #daily-widget .dw-input::placeholder { color: ${COL_TEXT_FAINT}; }
      #daily-widget .dw-input.dw-num { width: 48px; text-align: center; padding: 4px 4px; -moz-appearance: textfield; }
      #daily-widget .dw-days { display: flex; gap: 3px; }
      #daily-widget .dw-day {
        appearance: none; border: none; margin: 0; padding: 0; flex: 1; height: 20px; min-width: 0;
        border-radius: 6px; cursor: pointer; font: inherit; font-size: 9.5px; font-weight: 600;
        background: ${COL_SURFACE}; color: ${COL_TEXT_DIM};
        transition: background-color 0.12s ease, color 0.12s ease;
      }
      #daily-widget .dw-day:hover { background: ${COL_SELECTION}; }
      #daily-widget .dw-day.dw-on { background: ${COL_TEXT}; color: ${COL_BG}; text-shadow: none; }
      #daily-widget .dw-erow-actions { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
      #daily-widget .dw-pill.dw-danger:hover { background: rgba(255, 120, 120, 0.35); }
      #daily-widget .dw-add { margin-top: 3px; }
    `;
    widgetDiv.appendChild(styleTag);

    function el(tag, cls, text) {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    function svgIcon(paths, size, stroke, sw) {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", String(size));
      svg.setAttribute("height", String(size));
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", stroke);
      svg.setAttribute("stroke-width", String(sw));
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      for (const d of paths) {
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", d);
        svg.appendChild(p);
      }
      svg.style.pointerEvents = "none";
      return svg;
    }

    // Lucide icons
    const PATH_CHECK = ["M5 12l5 5L20 7"];
    const PATH_BACK = ["M15 6l-6 6 6 6"];
    const PATH_PENCIL = ["M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z", "M15 5l4 4"];
    const PATH_PLAY = ["M7 4l13 8-13 8z"];
    const PATH_PAUSE = ["M8 5v14", "M16 5v14"];
    const PATH_UP = ["M6 15l6-6 6 6"];
    const PATH_DOWN = ["M6 9l6 6 6-6"];
    const PATH_GEAR = [
      "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0"
    ];

    function checkBox(on) {
      const chk = el("span", "dw-check" + (on ? " dw-on" : ""));
      chk.appendChild(svgIcon(PATH_CHECK, 9, COL_BG, 3.5));
      return chk;
    }
    function roundBtn(path, title, size, sw) {
      const b = el("button", "dw-btn");
      b.title = title;
      b.appendChild(svgIcon(path, size || 10, "currentColor", sw || 2));
      return b;
    }

    // ---- main view ----
    const mainView = el("div", "dw-main");
    const head = el("div", "dw-head");
    const progEl = el("span", "dw-progress");
    const editBtn = roundBtn(PATH_PENCIL, "Edit tasks", 10, 2);
    head.appendChild(el("span", "dw-title", "Today"));
    head.appendChild(progEl);
    head.appendChild(el("span", "dw-spacer"));
    head.appendChild(editBtn);
    const listEl = el("div", "dw-list");
    mainView.appendChild(head);
    mainView.appendChild(listEl);

    // ---- edit view ----
    const editView = el("div", "dw-edit");
    const ehead = el("div", "dw-head dw-head-edit");
    const backBtn = roundBtn(PATH_BACK, "Back", 10, 3);
    const gearBtn = roundBtn(PATH_GEAR, "Settings", 10, 2);
    ehead.appendChild(backBtn);
    ehead.appendChild(el("span", "dw-title", "Edit daily"));
    ehead.appendChild(gearBtn);

    const settingsBox = el("div", "dw-settings");
    const syncers = [];
    function addToggle(label, get, set) {
      const row = el("div", "dw-toggle");
      const chk = checkBox(false);
      row.appendChild(chk);
      row.appendChild(el("span", null, label));
      const sync = () => chk.classList.toggle("dw-on", !!get());
      syncers.push(sync);
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        set(!get());
        sync();
        render();
      });
      settingsBox.appendChild(row);
    }
    addToggle("Hide ticked tasks for the day", () => hideDone, (v) => {
      hideDone = v;
      setPref("setBoolPref", "hide-done", v);
    });
    addToggle("Sound when a timer ends", () => soundOn, (v) => {
      soundOn = v;
      setPref("setBoolPref", "sound", v);
    });
    const pillRow = el("div", "dw-pills");
    const testBtn = el("button", "dw-pill", "Test sound");
    const resetBtn = el("button", "dw-pill", "Untick all today");
    pillRow.appendChild(testBtn);
    pillRow.appendChild(resetBtn);
    settingsBox.appendChild(pillRow);

    const editList = el("div", "dw-elist");
    const addInput = el("input", "dw-input dw-add");
    addInput.type = "text";
    addInput.maxLength = 120;
    addInput.placeholder = "Add a task, press Enter";

    editView.appendChild(ehead);
    editView.appendChild(settingsBox);
    editView.appendChild(editList);
    editView.appendChild(addInput);

    widgetDiv.appendChild(mainView);
    widgetDiv.appendChild(editView);

    // =================== SOUND + RING ===================
    let audioCtx = null;
    function chime() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw new Error("no audio");
        if (!audioCtx) audioCtx = new AC();
        if (audioCtx.state === "suspended") audioCtx.resume();
        const peak = 0.32 * (volume / 100);
        const notes = [659.25, 783.99, 1046.5]; // E5 G5 C6
        const t0 = audioCtx.currentTime + 0.03;
        for (let rep = 0; rep < 2; rep++) {
          notes.forEach((f, i) => {
            const t = t0 + rep * 1.1 + i * 0.18;
            const osc = audioCtx.createOscillator();
            const g = audioCtx.createGain();
            osc.type = "sine";
            osc.frequency.value = f;
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
            osc.connect(g);
            g.connect(audioCtx.destination);
            osc.start(t);
            osc.stop(t + 0.75);
          });
        }
      } catch (e) {
        try { Services.sound.beep(); } catch (e2) {}
      }
    }
    let ringTimeout = null;
    function ring() {
      if (soundOn) chime();
      widgetDiv.classList.add("dw-ring");
      clearTimeout(ringTimeout);
      ringTimeout = setTimeout(() => widgetDiv.classList.remove("dw-ring"), 6500);
    }

    // =================== FORMATTING ===================
    function fmtClock(ms) {
      const s = Math.max(0, Math.ceil(ms / 1000));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      return h ? h + ":" + pad2(m) + ":" + pad2(ss) : pad2(m) + ":" + pad2(ss);
    }
    function fmtMinutes(m) {
      if (m < 60) return m + " min";
      const h = Math.floor(m / 60);
      const r = m % 60;
      return r ? h + " h " + r + " min" : h + " h";
    }
    function timerLeft(it) {
      const t = timers[it.id];
      if (!t) return it.minutes * 60000;
      return t.end ? Math.max(0, t.end - Date.now()) : t.left;
    }

    // =================== TIMERS ===================
    let tickIv = null;
    let fireTo = null;

    function timerAction(it) {
      const t = timers[it.id];
      const now = Date.now();
      if (!t) timers[it.id] = { end: now + it.minutes * 60000 };
      else if (t.end) timers[it.id] = { left: Math.max(1000, t.end - now) };
      else timers[it.id] = { end: now + t.left };
      saveTimers();
      render();
    }
    function resetTimer(it) {
      if (!timers[it.id]) return;
      delete timers[it.id];
      saveTimers();
      render();
    }
    function updateTimerLabels() {
      for (const b of listEl.querySelectorAll(".dw-timer")) {
        const it = items.find((x) => x.id === b.dataset.id);
        const txt = b.querySelector(".dw-timer-text");
        if (it && txt) txt.textContent = fmtClock(timerLeft(it));
      }
    }
    function checkTimers() {
      const now = Date.now();
      let dirty = false;
      const fired = [];
      for (const id of Object.keys(timers)) {
        const it = items.find((x) => x.id === id);
        if (!it) { delete timers[id]; dirty = true; continue; }
        const t = timers[id];
        if (t.end && t.end <= now) fired.push({ it, overdue: now - t.end });
      }
      if (fired.length) {
        ensureToday();
        const wd = weekday();
        for (const f of fired) {
          const it = f.it;
          delete timers[it.id];
          if (isScheduled(it, wd) && !isDone(it)) {
            state.counts[it.id] = countOf(it) + 1;
            if (isDone(it)) markRecent(it.id);
          }
        }
        saveState();
        dirty = true;
        // Finished while the browser was closed: tick silently, no surprise sound.
        if (fired.some((f) => f.overdue < 30000)) ring();
      }
      if (dirty) {
        saveTimers();
        render();
      }
    }
    function tick() {
      updateTimerLabels();
      checkTimers();
    }
    function scheduleTimers() {
      if (fireTo) { clearTimeout(fireTo); fireTo = null; }
      const running = Object.keys(timers).map((k) => timers[k]).filter((t) => t.end);
      if (!running.length) {
        if (tickIv) { clearInterval(tickIv); tickIv = null; }
        return;
      }
      if (!tickIv) tickIv = setInterval(tick, 1000);
      // Exact wake-up for the nearest end, in case interval ticks get throttled
      // while the window is minimised.
      const next = Math.min.apply(null, running.map((t) => t.end)) - Date.now();
      fireTo = setTimeout(() => {
        fireTo = null;
        checkTimers();
        scheduleTimers();
      }, Math.max(0, next) + 30);
    }

    // =================== ITEM ACTIONS ===================
    // A just-completed task stays visible for a moment so a mis-click can be undone.
    const recent = new Set();
    const recentTimeouts = new Map();
    function markRecent(id) {
      recent.add(id);
      clearTimeout(recentTimeouts.get(id));
      recentTimeouts.set(id, setTimeout(() => {
        recent.delete(id);
        recentTimeouts.delete(id);
        render();
      }, 1100));
    }
    function clickItem(it) {
      ensureToday();
      const c = countOf(it);
      if (c >= it.times) {
        delete state.counts[it.id];
        recent.delete(it.id);
      } else {
        state.counts[it.id] = c + 1;
        if (c + 1 >= it.times) {
          if (timers[it.id]) { delete timers[it.id]; saveTimers(); }
          markRecent(it.id);
        }
      }
      saveState();
      render();
    }
    function undoItem(it) {
      ensureToday();
      const c = countOf(it);
      if (c <= 0) return;
      if (c <= 1) delete state.counts[it.id];
      else state.counts[it.id] = c - 1;
      recent.delete(it.id);
      saveState();
      render();
    }

    // =================== MAIN RENDER ===================
    function buildTimerBtn(it) {
      const t = timers[it.id];
      const running = !!(t && t.end);
      const btn = el("button", "dw-timer" + (running ? " dw-running" : t ? " dw-paused" : ""));
      btn.dataset.id = it.id;
      btn.appendChild(svgIcon(running ? PATH_PAUSE : PATH_PLAY, 8, "currentColor", running ? 3.4 : 2.6));
      btn.appendChild(el("span", "dw-timer-text", fmtClock(timerLeft(it))));
      btn.title = (running ? "Pause" : t ? "Resume" : "Start " + fmtMinutes(it.minutes)) + " (right-click: reset)";
      btn.addEventListener("click", (e) => { e.stopPropagation(); timerAction(it); });
      btn.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); resetTimer(it); });
      return btn;
    }

    function buildRow(it) {
      const done = isDone(it);
      const row = el("div", "dw-row" + (done ? " dw-done" : ""));
      row.appendChild(checkBox(done));
      row.appendChild(el("span", "dw-row-text", it.text));
      if (it.times > 1) row.appendChild(el("span", "dw-badge", countOf(it) + "/" + it.times));
      if (it.minutes > 0 && !done) row.appendChild(buildTimerBtn(it));
      row.title = it.text + (it.times > 1 ? "\nClick: +1, right-click: -1" : "\nClick to tick, right-click to untick");
      row.addEventListener("click", (e) => { e.stopPropagation(); clickItem(it); });
      row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); undoItem(it); });
      return row;
    }

    function renderMain() {
      ensureToday();
      const wd = weekday();
      const today = items.filter((it) => isScheduled(it, wd));
      const doneN = today.filter(isDone).length;
      progEl.textContent = today.length ? doneN + "/" + today.length : "";
      widgetDiv.dataset.complete = today.length && doneN === today.length ? "1" : "";
      const vis = today.filter((it) => !hideDone || !isDone(it) || recent.has(it.id));
      const sc = listEl.scrollTop;
      listEl.textContent = "";
      if (!vis.length) {
        let msg;
        if (!items.length) msg = "No tasks yet.\nPress the pencil to add some.";
        else if (!today.length) msg = "Nothing planned for today.";
        else msg = "All done for today.";
        listEl.appendChild(el("div", "dw-empty", msg));
      } else {
        for (const it of vis) listEl.appendChild(buildRow(it));
      }
      listEl.scrollTop = sc;
      scheduleTimers();
    }

    // =================== EDIT MODE ===================
    let expandedId = null;

    function nextDayLabel(it, wd) {
      for (let i = 1; i <= 7; i++) {
        const d = (wd + i) % 7;
        if (!it.days.length || it.days.indexOf(d) !== -1) return i === 1 ? "tomorrow" : DAY_NAMES[d];
      }
      return "tomorrow";
    }
    function metaText(it) {
      const wd = weekday();
      const parts = [];
      if (it.times > 1) parts.push(it.times + "x per day");
      if (it.minutes > 0) parts.push(fmtMinutes(it.minutes) + " timer");
      if (it.days.length) parts.push(DAY_ORDER.filter((d) => it.days.indexOf(d) !== -1).map((d) => DAY_NAMES[d]).join(" "));
      if (!parts.length) parts.push("daily");
      const c = countOf(it);
      if (!isScheduled(it, wd)) parts.push("not today, back " + nextDayLabel(it, wd));
      else if (c >= it.times) parts.push("done, back " + nextDayLabel(it, wd));
      else if (c > 0) parts.push(c + "/" + it.times + " today");
      return parts.join(" \u00b7 ");
    }

    function numField(label, value, lo, hi, cb) {
      const f = el("div", "dw-field");
      f.appendChild(el("span", null, label));
      const inp = el("input", "dw-input dw-num");
      inp.type = "number";
      inp.min = String(lo);
      inp.max = String(hi);
      inp.value = String(value);
      inp.addEventListener("change", () => {
        const v = clampInt(inp.value, lo, hi, value);
        inp.value = String(v);
        value = v;
        cb(v);
      });
      inp.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" || e.key === "Escape") inp.blur();
      });
      f.appendChild(inp);
      return f;
    }

    function moveItem(it, dir) {
      const i = items.indexOf(it);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= items.length) return;
      items[i] = items[j];
      items[j] = it;
      saveItems();
      renderEdit();
      renderMain();
    }
    function deleteItem(it) {
      items = items.filter((x) => x !== it);
      delete state.counts[it.id];
      delete timers[it.id];
      expandedId = null;
      saveItems();
      saveState();
      saveTimers();
      renderEdit();
      renderMain();
    }

    function buildEditor(it, onChange) {
      const box = el("div", "dw-editor");
      box.addEventListener("click", (e) => e.stopPropagation());

      const nameIn = el("input", "dw-input");
      nameIn.type = "text";
      nameIn.maxLength = 120;
      nameIn.value = it.text;
      nameIn.placeholder = "Task";
      nameIn.addEventListener("change", () => {
        const v = nameIn.value.trim();
        if (!v) { nameIn.value = it.text; return; }
        it.text = v.slice(0, 120);
        nameIn.value = it.text;
        onChange();
      });
      nameIn.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" || e.key === "Escape") nameIn.blur();
      });
      box.appendChild(nameIn);

      box.appendChild(numField("Times per day", it.times, 1, 99, (v) => {
        it.times = v;
        onChange();
      }));
      box.appendChild(numField("Timer in minutes (0 = none)", it.minutes, 0, 600, (v) => {
        it.minutes = v;
        if (timers[it.id]) { delete timers[it.id]; saveTimers(); }
        onChange();
      }));

      const daysField = el("div", "dw-field dw-field-col");
      daysField.appendChild(el("span", null, "Days (none selected = every day)"));
      const daysRow = el("div", "dw-days");
      for (const d of DAY_ORDER) {
        const b = el("button", "dw-day" + (it.days.indexOf(d) !== -1 ? " dw-on" : ""), DAY_SHORT[d]);
        b.title = DAY_NAMES[d];
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          const i = it.days.indexOf(d);
          if (i === -1) it.days.push(d);
          else it.days.splice(i, 1);
          b.classList.toggle("dw-on", it.days.indexOf(d) !== -1);
          onChange();
        });
        daysRow.appendChild(b);
      }
      daysField.appendChild(daysRow);
      box.appendChild(daysField);

      const acts = el("div", "dw-erow-actions");
      const upBtn = roundBtn(PATH_UP, "Move up", 10, 3);
      const downBtn = roundBtn(PATH_DOWN, "Move down", 10, 3);
      upBtn.addEventListener("click", (e) => { e.stopPropagation(); moveItem(it, -1); });
      downBtn.addEventListener("click", (e) => { e.stopPropagation(); moveItem(it, 1); });
      const untickBtn = el("button", "dw-pill", "Untick today");
      untickBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        delete state.counts[it.id];
        if (timers[it.id]) { delete timers[it.id]; saveTimers(); }
        recent.delete(it.id);
        saveState();
        onChange();
      });
      const delBtn = el("button", "dw-pill dw-danger", "Delete");
      let armed = null;
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!armed) {
          delBtn.textContent = "Sure?";
          armed = setTimeout(() => { armed = null; delBtn.textContent = "Delete"; }, 2500);
          return;
        }
        clearTimeout(armed);
        deleteItem(it);
      });
      acts.appendChild(upBtn);
      acts.appendChild(downBtn);
      acts.appendChild(untickBtn);
      acts.appendChild(delBtn);
      box.appendChild(acts);
      return box;
    }

    function buildEditRow(it) {
      const wrap = el("div", "dw-eitem" + (expandedId === it.id ? " dw-open" : ""));
      const row = el("div", "dw-erow");
      const nameEl = el("div", "dw-erow-name", it.text);
      const metaEl = el("div", "dw-erow-meta", metaText(it));
      row.appendChild(nameEl);
      row.appendChild(metaEl);
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        expandedId = expandedId === it.id ? null : it.id;
        renderEdit();
      });
      wrap.appendChild(row);
      if (expandedId === it.id) {
        const onChange = () => {
          saveItems();
          renderMain();
          nameEl.textContent = it.text;
          metaEl.textContent = metaText(it);
        };
        wrap.appendChild(buildEditor(it, onChange));
      }
      return wrap;
    }

    function renderEdit() {
      ensureToday();
      const sc = editList.scrollTop;
      editList.textContent = "";
      if (!items.length) {
        editList.appendChild(el("div", "dw-empty", "No tasks yet.\nType one below and press Enter."));
      } else {
        for (const it of items) editList.appendChild(buildEditRow(it));
      }
      editList.scrollTop = sc;
      for (const s of syncers) s();
    }

    function addItem(text) {
      text = text.trim();
      if (!text) return;
      items.push({ id: newId(), text: text.slice(0, 120), times: 1, minutes: 0, days: [] });
      saveItems();
      renderEdit();
      renderMain();
      editList.scrollTop = editList.scrollHeight;
    }

    function setEditing(on) {
      widgetDiv.classList.toggle("dw-editing", on);
      expandedId = null;
      if (!on) widgetDiv.classList.remove("dw-settings-open");
      if (on) renderEdit();
      else renderMain();
    }

    // Everything on screen that depends on data.
    function render() {
      renderMain();
      if (widgetDiv.classList.contains("dw-editing")) {
        const a = document.activeElement;
        if (!(a && editList.contains(a))) renderEdit();
      }
    }

    // =================== EVENTS ===================
    widgetDiv.addEventListener("click", (e) => e.stopPropagation());
    editBtn.addEventListener("click", (e) => { e.stopPropagation(); setEditing(true); });
    backBtn.addEventListener("click", (e) => { e.stopPropagation(); setEditing(false); });
    gearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      widgetDiv.classList.toggle("dw-settings-open");
    });
    testBtn.addEventListener("click", (e) => { e.stopPropagation(); chime(); });
    resetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.counts = {};
      recent.clear();
      saveState();
      render();
      renderEdit();
    });
    addInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        addItem(addInput.value);
        addInput.value = "";
      } else if (e.key === "Escape") {
        addInput.blur();
      }
    });

    // =================== MOUNTING (above Anki and SoundCloud) ===================
    let resizeObs = null;
    let keeper = null;
    function findMount() {
      for (const id of ["zen-sidebar-foot-buttons", "zen-sidebar-bottom-buttons"]) {
        const node = document.getElementById(id);
        if (node && node.parentNode) {
          let parent = node.parentNode;
          let before = node;
          try {
            const cs = getComputedStyle(parent);
            if (cs.display.includes("flex") && cs.flexDirection.startsWith("row") && parent.parentNode) {
              before = parent;
              parent = parent.parentNode;
            }
          } catch (e) {}
          return { parent, before };
        }
      }
      const tabs = document.getElementById("tabbrowser-tabs");
      if (tabs && tabs.parentNode) return { parent: tabs.parentNode, before: tabs.nextSibling };
      return null;
    }

    // The first of the sibling widgets that already sits in the container.
    function topAnchor(parent) {
      for (const child of parent.children) {
        if (child !== widgetDiv && (child.id === "anki-widget" || child.id === "sc-widget-test")) return child;
      }
      return null;
    }

    function mountWidget() {
      const m = findMount();
      if (!m) return false;
      const anchor = topAnchor(m.parent);
      const before = anchor || m.before;
      if (widgetDiv.parentNode !== m.parent || widgetDiv.nextSibling !== before) {
        m.parent.insertBefore(widgetDiv, before);
        console.log("[DAILY-WIDGET] mounted into", m.parent.id || m.parent.tagName);
      }
      try {
        if (resizeObs) resizeObs.disconnect();
        resizeObs = new ResizeObserver(() => {
          widgetDiv.classList.toggle("dw-narrow", m.parent.clientWidth < 150);
        });
        resizeObs.observe(m.parent);
      } catch (e) {}
      // If another widget loads later and lands above us, move back to the top.
      try {
        if (keeper) keeper.disconnect();
        keeper = new MutationObserver(() => {
          const a = topAnchor(m.parent);
          if (a && widgetDiv.parentNode === m.parent && (widgetDiv.compareDocumentPosition(a) & 4) === 0) {
            m.parent.insertBefore(widgetDiv, a);
          }
        });
        keeper.observe(m.parent, { childList: true });
      } catch (e) {}
      return true;
    }

    // =================== WIRE UP ===================
    loadAll();
    render();

    if (!mountWidget()) {
      let tries = 0;
      const iv = setInterval(() => {
        if (mountWidget() || ++tries > 30) clearInterval(iv);
      }, 500);
    }

    // Timers that ended while the browser was closed are settled right away.
    checkTimers();
    scheduleTimers();

    // Day rollover + keep-alive for the mount point.
    function housekeeping() {
      if (!widgetDiv.isConnected) mountWidget();
      if (state.date !== dayKey()) {
        render();
      }
      checkTimers();
    }
    setInterval(housekeeping, 30000);
    window.addEventListener("focus", housekeeping);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) housekeeping(); });
    window.addEventListener("sizemodechange", housekeeping);

    // Keep several windows in sync.
    const prefObserver = {
      observe() {
        if (writing) return;
        loadAll();
        render();
      }
    };
    try {
      Services.prefs.addObserver(PREFIX, prefObserver);
      window.addEventListener("unload", () => {
        try { Services.prefs.removeObserver(PREFIX, prefObserver); } catch (e) {}
      }, { once: true });
    } catch (e) {}

    // Don't draw over the urlbar results panel
    try {
      const urlbarPanel = window.gURLBar && window.gURLBar.view && window.gURLBar.view.panel;
      if (urlbarPanel) {
        urlbarPanel.addEventListener("popupshowing", () => {
          widgetDiv.style.opacity = "0";
          widgetDiv.style.pointerEvents = "none";
        });
        urlbarPanel.addEventListener("popuphidden", () => {
          widgetDiv.style.opacity = "1";
          widgetDiv.style.pointerEvents = "";
        });
      }
    } catch (e) {}
  }

  // ---- Boot ----
  try {
    if (typeof UC_API !== "undefined" && UC_API && UC_API.Runtime && UC_API.Runtime.startupFinished) {
      UC_API.Runtime.startupFinished().then(dailyWidgetInit);
    } else if (document.readyState === "complete") {
      dailyWidgetInit();
    } else {
      window.addEventListener("load", dailyWidgetInit, { once: true });
    }
  } catch (e) {
    console.log("[DAILY-WIDGET] top-level error while triggering init: " + (e && e.message));
  }
})();
