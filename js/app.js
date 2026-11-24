// Main Application Coordinator, Side Nav, Theme Sync, Global Spacebar, Timeline Loop & Settings
(function () {
  "use strict";

  const DATA = window.CORPUS_DATA;
  if (!DATA) return;

  const MODE_LABELS = (window.BTMM_MODE_LABELS = window.BTMM_MODE_LABELS || {
    vibe: "Vibe",
    era: "Era",
  });

  const VIEWS = [
    { id: "vibe", section: "Maps", icon: "hub", label: `${MODE_LABELS.vibe} map`, isMap: true },
    { id: "era", section: "Maps", icon: "waves", label: `${MODE_LABELS.era} timeline`, isMap: true },
    { id: "macro-harmony", section: "Overview", icon: "insights", label: "Macro harmony & energy" },
    { id: "timeline-player", section: "Overview", icon: "slideshow", label: "Timeline animator" },
    { id: "era-compare", section: "Overview", icon: "compare_arrows", label: "Era comparator" },
    { id: "chord-quality", section: "Harmony & tuning", icon: "piano", label: "Chord & dyad spectrum" },
    { id: "root-motion", section: "Harmony & tuning", icon: "donut_small", label: "Root motion & wheel" },
    { id: "modal-heatmap", section: "Harmony & tuning", icon: "grid_on", label: "12-degree modal heatmap" },
    { id: "voicing-spread", section: "Harmony & tuning", icon: "height", label: "Voicing spread & register" },
    { id: "ji-gamelan", section: "Harmony & tuning", icon: "tune", label: "JI & gamelan tunings" },
    { id: "workflow", section: "Evolution & groove", icon: "layers", label: "Workflow (MIDI vs audio)" },
    { id: "groove", section: "Evolution & groove", icon: "speed", label: "Groove & tempo" },
    { id: "melody", section: "Evolution & groove", icon: "timeline", label: "Melody & space" },
    { id: "audio", section: "Evolution & groove", icon: "graphic_eq", label: "Audio expressiveness" },
    { id: "palette", section: "Evolution & groove", icon: "equalizer", label: "Synths & FX palette" },
  ];

  const THEME_KEY = "btmm.theme";
  const LEGACY_THEME_KEY = "me.theme";

  const tracks = DATA.tracks || [];
  const eras = DATA.eras || [];
  const phases = DATA.phases || [];
  const meta = DATA.meta || {};
  const mapBlob = DATA.map || {};

  const byId = new Map(tracks.map((t) => [t.id, t]));
  const erasById = new Map(eras.map((e) => [e.id, e]));

  const state = {
    themeMode: "auto", // auto | light | dark
    resolvedTheme: "dark",
    tab: "vibe",
    granularity: "eras", // eras (16) | phases (5)
    pinnedEraIdx: Math.max(0, eras.length - 2),
    pinnedPhaseIdx: Math.max(0, phases.length - 1),
    hoverIdx: null,
    navExpanded: false,
    mobileNavOpen: false,
    searchQuery: "",
    chordMode: "pct",
    heatmapSource: "combined_12",
    heatmapSpotlight: true,
    voicingMode: "keyboard",
    tuningScaleId: "semeradana",
    compareAIdx: Math.min(1, Math.max(0, eras.length - 1)),
    compareBIdx: Math.max(0, eras.length - 2),
    animPlaying: false,
    animPos: 0,
    animLoop: true,
    animSort: "chrono",
    animGhost: "prev",
    barsPerEra: 4,
    audioEnabled: true,
    audioVolume: 0.85,
  };

  let animRafId = null;
  let animLastTs = 0;
  let isScrubbing = false;
  let scrubHoldTimer = null;
  let lastScrubStopIdx = -1;

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function syncSliderPct(input) {
    if (!input || !input.style) return;
    const min = parseFloat(input.min || "0");
    const max = parseFloat(input.max || "100");
    const val = parseFloat(input.value || "0");
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    input.style.setProperty("--pct", `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`);
  }

  // ---- Theme System (Auto / Light / Dark + Top-Right Toggle + Helix Live Sync) ----
  function resolveHostTheme() {
    if (typeof window === "undefined" || typeof document === "undefined") return "dark";
    try {
      const hostDark = document.documentElement.classList.contains("dark") ||
        document.body.classList.contains("dark") ||
        (document.body.getAttribute("data-vscode-theme-kind") || "").includes("dark");
      const hostLight = document.documentElement.classList.contains("light") ||
        document.body.classList.contains("light") ||
        (document.body.getAttribute("data-vscode-theme-kind") || "").includes("light");
      if (hostDark) return "dark";
      if (hostLight) return "light";
      if (window.matchMedia) {
        return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      }
    } catch (_) {}
    return "dark";
  }

  function syncThemeToggleIcon() {
    if (typeof document === "undefined") return;
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    const isDark = state.resolvedTheme === "dark";
    const iconEl = btn.querySelector(".ms");
    if (iconEl) iconEl.textContent = isDark ? "light_mode" : "dark_mode";
    btn.title = isDark ? "Switch to light theme" : "Switch to dark theme";
    btn.setAttribute("aria-label", btn.title);
  }

  function applyTheme(mode) {
    state.themeMode = mode;
    try { localStorage.setItem(THEME_KEY, mode); } catch (_) {}
    const eff = mode === "auto" ? resolveHostTheme() : mode;
    state.resolvedTheme = eff;
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", eff);
      document.documentElement.style.colorScheme = eff;
    }
    syncThemeToggleIcon();
    syncSettingsUi();
    if (window.ME_NODEMAP && window.ME_NODEMAP.refreshTheme) {
      window.ME_NODEMAP.refreshTheme();
    }
  }

  function initTheme() {
    if (typeof window !== "undefined" && window.BTMM_THEME && typeof window.BTMM_THEME.refresh === "function") {
      window.BTMM_THEME.refresh();
      return;
    }
    let saved = "auto";
    try { saved = localStorage.getItem(THEME_KEY) || localStorage.getItem(LEGACY_THEME_KEY) || "auto"; } catch (_) {}
    applyTheme(saved);
    if (typeof window !== "undefined" && window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      if (mq.addEventListener) mq.addEventListener("change", () => {
        if (window.BTMM_THEME && typeof window.BTMM_THEME.refresh === "function") { window.BTMM_THEME.refresh(); return; }
        if (state.themeMode === "auto") applyTheme("auto");
      });
    }
    if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
      const obs = new MutationObserver(() => {
        if (window.BTMM_THEME && typeof window.BTMM_THEME.refresh === "function") { window.BTMM_THEME.refresh(); return; }
        if (state.themeMode === "auto") applyTheme("auto");
      });
      obs.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-vscode-theme-kind"] });
    }
    if (typeof setInterval !== "undefined") {
      const hostThemeTimer = setInterval(() => {
        if (window.BTMM_THEME && typeof window.BTMM_THEME.refresh === "function") {
          clearInterval(hostThemeTimer);
          return;
        }
        if (state.themeMode === "auto") {
          const next = resolveHostTheme();
          if (next !== state.resolvedTheme) applyTheme("auto");
        }
      }, 600);
    }
  }

  // ---- Navigation & URL Hash ----
  function currentItems() {
    return state.granularity === "phases" ? phases : eras;
  }

  function getPinnedIdx() {
    const items = currentItems();
    const raw = state.granularity === "phases" ? state.pinnedPhaseIdx : state.pinnedEraIdx;
    return Math.max(0, Math.min(items.length - 1, raw));
  }

  function setPinnedIdx(idx) {
    const clamped = Math.max(0, Math.min(currentItems().length - 1, idx));
    if (state.granularity === "phases") state.pinnedPhaseIdx = clamped;
    else state.pinnedEraIdx = clamped;
    state.hoverIdx = null;
  }

  function isMapTab(tabId = state.tab) {
    return tabId === "vibe" || tabId === "similarity" || tabId === "era";
  }

  function buildSideNav() {
    const nav = document.getElementById("side-nav");
    if (!nav) return;
    let html = "";
    let lastSec = "";
    VIEWS.forEach((v) => {
      if (v.section !== lastSec) {
        if (lastSec) html += `<div class="nav-divider"></div>`;
        html += `<div class="nav-sec">${esc(v.section)}</div>`;
        lastSec = v.section;
      }
      const act = state.tab === v.id ? "is-active" : "";
      html += `
        <button type="button" class="nav-item ${act}" data-nav-view="${v.id}" title="${esc(v.label)}" aria-current="${state.tab === v.id ? "page" : "false"}">
          <span class="ms">${v.icon}</span>
          <span class="nav-lbl">${esc(v.label)}</span>
        </button>`;
    });
    nav.innerHTML = html;
    nav.classList.toggle("is-expanded", state.navExpanded);
    nav.classList.toggle("is-mobile-open", state.mobileNavOpen);
    const scrim = document.getElementById("nav-scrim");
    if (scrim) scrim.classList.toggle("open", state.mobileNavOpen);
    const tog = document.getElementById("menu-toggle");
    if (tog) {
      const mobile = typeof window !== "undefined" && window.innerWidth <= 840;
      tog.setAttribute("aria-expanded", String(mobile ? state.mobileNavOpen : state.navExpanded));
    }
  }

  function renderModeSwitchers() {
    const mapTabsEl = document.getElementById("map-mode-tabs");
    if (mapTabsEl) {
      const vibeAct = state.tab === "vibe" || state.tab === "similarity";
      mapTabsEl.innerHTML = `
        <button type="button" class="m3-pill-tab ${vibeAct ? "is-active" : ""}" data-map-layout="vibe" aria-pressed="${vibeAct}">${esc(MODE_LABELS.vibe)}</button>
        <button type="button" class="m3-pill-tab ${!vibeAct ? "is-active" : ""}" data-map-layout="era" aria-pressed="${!vibeAct}">${esc(MODE_LABELS.era)}</button>`;
    }
    const granEl = document.getElementById("analysis-granularity");
    if (granEl) {
      const eraAct = state.granularity === "eras";
      granEl.innerHTML = `
        <button type="button" class="m3-pill-tab ${eraAct ? "is-active" : ""}" data-granularity="eras" aria-pressed="${eraAct}">${eras.length} eras</button>
        <button type="button" class="m3-pill-tab ${!eraAct ? "is-active" : ""}" data-granularity="phases" aria-pressed="${!eraAct}">${phases.length} phases</button>`;
    }
  }

  // ---- Timeline Animator Controller ----
  function getSortedTimelineItems() {
    const base = [...currentItems()];
    const score = (it, k, fb = 0) => (it.macro_harmony && it.macro_harmony[k]) ?? fb;
    if (state.animSort === "energy") base.sort((a, b) => score(a, "mik_energy_med") - score(b, "mik_energy_med"));
    else if (state.animSort === "harmonic") base.sort((a, b) => score(a, "complexity") - score(b, "complexity"));
    else if (state.animSort === "drums") base.sort((a, b) => score(a, "drum_complexity_med") - score(b, "drum_complexity_med"));
    else if (state.animSort === "tempo") base.sort((a, b) => (a.bpm_p50 || 0) - (b.bpm_p50 || 0));
    return base;
  }

  function lerpObj(a, b, t) {
    const out = {};
    Object.keys(a).forEach((k) => { out[k] = a[k] + ((b[k] ?? a[k]) - a[k]) * t; });
    return out;
  }

  function interpAt(sorted, rawPos) {
    const maxPos = Math.max(0, sorted.length - 1);
    const pos = Math.max(0, Math.min(maxPos, Number.isFinite(rawPos) ? rawPos : 0));
    const i0 = Math.floor(pos);
    const i1 = Math.min(maxPos, i0 + 1);
    const tRaw = pos - i0;
    const t = tRaw * tRaw * (3 - 2 * tRaw);
    const C = window.ME_CHARTS;
    const p0 = C.extractCompareProfile(sorted[i0]);
    const p1 = C.extractCompareProfile(sorted[i1]);
    return {
      pos, i0, i1, tRaw, a: sorted[i0], b: sorted[i1], nearest: sorted[Math.round(pos)],
      radarNorm: p0.radarNorm.map((v, k) => v + (p1.radarNorm[k] - v) * t),
      macro: lerpObj(p0.macro, p1.macro, t),
      cofNorm: p0.cofNorm.map((v, k) => v + (p1.cofNorm[k] - v) * t),
    };
  }

  function updateAudioDeckUi() {
    const infoEl = document.getElementById("audio-now-info");
    const ledsEl = document.getElementById("audio-beat-leds");
    if (!infoEl || !ledsEl) return;
    const active = window.ME_AUDIO.activeVoice();
    const pend = window.ME_AUDIO.pendingVoice();
    const cur = currentItems()[getPinnedIdx()];
    const tr = (active && active.track) || (pend && pend.track) || (cur && cur.tracks && cur.tracks[0]);
    if (tr) {
      const er = erasById.get(tr.era);
      infoEl.innerHTML = `
        <div class="audio-now-title">${esc(tr.title)}</div>
        <div class="audio-now-meta">${esc(er ? er.label : tr.era)} · E${tr.energy}/10 · ${esc(tr.key_label)} · ${Math.round(tr.bpm)} BPM${pend ? " · Queued on bar" : ""}</div>`;
    }
    if (!ledsEl.children.length) {
      ledsEl.innerHTML = [0, 1, 2, 3].map((b) => `<span class="beat-led${b === 0 ? " down" : ""}"></span>`).join("");
    }
  }

  function updateTimelineFrame() {
    if (typeof document === "undefined" || state.tab !== "timeline-player") return;
    const sorted = getSortedTimelineItems();
    const maxPos = Math.max(0, sorted.length - 1);
    state.animPos = Math.max(0, Math.min(maxPos, state.animPos));
    const snap = interpAt(sorted, state.animPos);
    const hasGhost = state.animGhost !== "off";
    const ghostPos = state.animGhost === "anchor" ? 0 : Math.max(0, state.animPos - 1);
    const gSnap = hasGhost ? interpAt(sorted, ghostPos) : snap;
    const C = window.ME_CHARTS;

    const comboEl = document.getElementById("anim-svg-combo");
    const cofEl = document.getElementById("anim-svg-cof");
    if (comboEl) comboEl.innerHTML = C.buildRadarAndMacroSvg(gSnap.radarNorm, snap.radarNorm, gSnap.macro, snap.macro, gSnap.nearest.shortLabel, snap.nearest.shortLabel, hasGhost);
    if (cofEl) cofEl.innerHTML = C.buildCofSvg(gSnap.cofNorm, snap.cofNorm, hasGhost);

    const bannerEl = document.getElementById("anim-status-banner");
    if (bannerEl) {
      bannerEl.innerHTML = `
        <div><strong>${esc(snap.a.label)}</strong>${snap.tRaw > 0.04 && snap.a.id !== snap.b.id ? ` → <strong>${esc(snap.b.label)}</strong> <span class="badge">${Math.round(snap.tRaw * 100)}%</span>` : ` <span class="muted">(${esc(snap.a.sublabel)})</span>`}</div>
        <div class="muted">MIK Energy E${snap.macro.mik_energy_pct ? (snap.macro.mik_energy_pct / 10).toFixed(1) : "—"} · Harmonic ${Math.round(snap.macro.complexity)} · Drums ${Math.round(snap.macro.drum_complexity)}</div>`;
    }

    const sliderEl = document.getElementById("anim-slider");
    if (sliderEl) { sliderEl.value = state.animPos.toFixed(2); syncSliderPct(sliderEl); }
    const playBtn = document.getElementById("anim-play");
    if (playBtn) {
      playBtn.className = `btn-tonal ${state.animPlaying ? "is-playing" : ""}`;
      playBtn.innerHTML = `<span class="ms filled">${state.animPlaying ? "pause" : "play_arrow"}</span><span>${state.animPlaying ? "Pause" : "Play"}</span>`;
    }
    const activeStop = Math.round(state.animPos);
    document.querySelectorAll("#anim-stops [data-anim-stop]").forEach((btn) => {
      btn.classList.toggle("is-active", Number(btn.getAttribute("data-anim-stop")) === activeStop);
    });
    updateAudioDeckUi();
  }

  function queueStopOnBar(idx, immediate = false) {
    const sorted = getSortedTimelineItems();
    const stop = sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
    const tr = stop && stop.tracks && stop.tracks[0];
    if (!tr) return;
    window.ME_AUDIO.prefetchTracks(sorted.slice(idx, idx + 3).map((x) => x.tracks && x.tracks[0]).filter(Boolean));
    if (state.audioEnabled) {
      window.ME_AUDIO.playTrack(tr, { quantize: !immediate, stopIdx: idx, eraId: stop.id, isManual: true });
    }
  }

  function stopAnimPlayback() {
    state.animPlaying = false;
    if (animRafId !== null && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(animRafId);
    animRafId = null;
    window.ME_AUDIO.stop();
    updateTimelineFrame();
  }

  function stepAnimLoop(ts) {
    if (!state.animPlaying || state.tab !== "timeline-player") { stopAnimPlayback(); return; }
    const sorted = getSortedTimelineItems();
    const maxPos = Math.max(0, sorted.length - 1);
    const active = window.ME_AUDIO.activeVoice();
    const nowCtx = window.ME_AUDIO.ctxTime();

    if (!isScrubbing) {
      if (state.audioEnabled && active && active.scheduled && !active.isHtmlFallback && state.barsPerEra > 0) {
        const barDur = Math.max(0.25, active.barDurSec);
        const slotDur = state.barsPerEra * barDur;
        const elapsed = Math.max(0, nowCtx - active.slotStartCtxTime);
        const curIdx = active.stopIdx >= 0 ? active.stopIdx : Math.round(state.animPos);
        state.animPos = curIdx < maxPos ? curIdx + Math.min(1, elapsed / slotDur) : maxPos;
        const timeLeft = (active.slotStartCtxTime + slotDur) - nowCtx;
        const nextIdx = curIdx < maxPos ? curIdx + 1 : (state.animLoop ? 0 : -1);
        if (nextIdx >= 0 && maxPos > 0) {
          if (timeLeft <= 2.4) window.ME_AUDIO.prefetchTracks([sorted[nextIdx].tracks && sorted[nextIdx].tracks[0]]);
          if (timeLeft <= 0.35 && !window.ME_AUDIO.pending()) {
            const tr = sorted[nextIdx].tracks && sorted[nextIdx].tracks[0];
            if (tr) window.ME_AUDIO.playTrack(tr, { quantize: true, stopIdx: nextIdx, eraId: sorted[nextIdx].id });
          }
        } else if (nowCtx >= active.slotStartCtxTime + slotDur) {
          stopAnimPlayback();
          return;
        }
      } else {
        if (!animLastTs) animLastTs = ts;
        const dt = Math.min(0.1, Math.max(0, (ts - animLastTs) / 1000));
        animLastTs = ts;
        if (state.barsPerEra > 0) {
          const curTr = (sorted[Math.round(state.animPos)].tracks || [])[0];
          const barDur = (curTr && curTr.bar_sec) || 2.0;
          let nextPos = state.animPos + dt / (state.barsPerEra * barDur);
          if (nextPos >= maxPos) nextPos = state.animLoop ? 0 : maxPos;
          state.animPos = nextPos;
          if (!state.animLoop && nextPos >= maxPos) { stopAnimPlayback(); return; }
        }
      }
    } else {
      animLastTs = ts;
    }
    updateTimelineFrame();
    if (state.animPlaying && typeof requestAnimationFrame !== "undefined") animRafId = requestAnimationFrame(stepAnimLoop);
  }

  function startAnimPlayback() {
    const sorted = getSortedTimelineItems();
    const maxPos = Math.max(0, sorted.length - 1);
    if (state.animPos >= maxPos - 0.02) state.animPos = 0;
    const idx = Math.round(state.animPos);
    state.animPos = idx;
    state.animPlaying = true;
    animLastTs = 0;
    queueStopOnBar(idx, true);
    updateTimelineFrame();
    if (typeof requestAnimationFrame !== "undefined") animRafId = requestAnimationFrame(stepAnimLoop);
  }

  function glideToStop(targetIdx) {
    const sorted = getSortedTimelineItems();
    const goal = Math.max(0, Math.min(sorted.length - 1, targetIdx));
    if (state.animPlaying || window.ME_AUDIO.playing()) queueStopOnBar(goal, false);
    state.animPos = goal;
    updateTimelineFrame();
  }

  // ---- Main Render Coordinator ----
  function renderView() {
    buildSideNav();
    renderModeSwitchers();

    const mapEl = document.getElementById("map");
    const anaEl = document.getElementById("analysis-shell");
    if (isMapTab()) {
      if (state.animPlaying) stopAnimPlayback();
      if (mapEl) mapEl.hidden = false;
      if (anaEl) anaEl.hidden = true;
      window.ME_NODEMAP.setLayout(state.tab, true);
      return;
    }

    if (mapEl) mapEl.hidden = true;
    if (anaEl) anaEl.hidden = false;

    const items = currentItems();
    const selIdx = state.hoverIdx !== null ? Math.max(0, Math.min(items.length - 1, state.hoverIdx)) : getPinnedIdx();
    const d = items[selIdx];
    const playId = window.ME_AUDIO.playing();
    const VH = window.ME_VIEWS_HARMONY;
    const VE = window.ME_VIEWS_EVOLUTION;

    const stripEl = document.getElementById("era-strip");
    if (stripEl) {
      stripEl.hidden = state.tab === "timeline-player" || state.tab === "era-compare";
      const q = state.searchQuery.trim().toLowerCase();
      stripEl.innerHTML = items.map((it, i) => {
        const hit = !q || it.label.toLowerCase().includes(q) || (it.tracks || []).some((t) => t.title.toLowerCase().includes(q));
        return `
          <button type="button" data-era-idx="${i}" class="era-pill ${i === selIdx ? "is-active" : ""}" style="${hit ? "" : "opacity:0.32"}">
            <span class="era-pill-name">${esc(it.label)}</span>
            <span class="era-pill-sub">${esc(it.sublabel)} · E${Math.round((it.macro_harmony && it.macro_harmony.mik_energy_med) || 0)}</span>
          </button>`;
      }).join("");
    }

    const stageEl = document.getElementById("view-stage");
    if (stageEl && d) {
      if (state.tab === "macro-harmony") stageEl.innerHTML = VH.renderMacroHarmony(items, d, selIdx, state, playId);
      else if (state.tab === "timeline-player") stageEl.innerHTML = VH.renderTimelinePlayer(getSortedTimelineItems(), state);
      else if (state.tab === "chord-quality") stageEl.innerHTML = VH.renderChordQuality(items, d, selIdx, state);
      else if (state.tab === "root-motion") stageEl.innerHTML = VH.renderRootMotion(items, d, selIdx, state);
      else if (state.tab === "modal-heatmap") stageEl.innerHTML = VH.renderModalHeatmap(items, d, selIdx, state);
      else if (state.tab === "voicing-spread") stageEl.innerHTML = VH.renderVoicingSpread(items, d, selIdx, state);
      else if (state.tab === "ji-gamelan") stageEl.innerHTML = VH.renderJiGamelan(items, d, selIdx, state);
      else if (state.tab === "era-compare") stageEl.innerHTML = VE.renderEraCompare(items, state);
      else if (state.tab === "workflow") stageEl.innerHTML = VE.renderWorkflow(items, d, selIdx, state);
      else if (state.tab === "groove") stageEl.innerHTML = VE.renderGroove(items, d, selIdx, state);
      else if (state.tab === "melody") stageEl.innerHTML = VE.renderMelody(items, d, selIdx, state);
      else if (state.tab === "audio") stageEl.innerHTML = VE.renderAudioExp(items, d, selIdx, state);
      else if (state.tab === "palette") stageEl.innerHTML = VE.renderPalette(items, d, selIdx, state);
    }

    const inspEl = document.getElementById("era-inspector");
    if (inspEl && d) {
      inspEl.hidden = state.tab === "macro-harmony" || state.tab === "timeline-player";
      if (!inspEl.hidden) inspEl.innerHTML = VE.renderEraInspector(d, playId);
    }

    if (state.tab === "timeline-player") {
      updateTimelineFrame();
      document.querySelectorAll('input[type="range"].gm3-slider').forEach(syncSliderPct);
    }
    if (window.BTMM_PLAYER) window.BTMM_PLAYER.render();
  }

  function setTab(nextTab) {
    const normalized = nextTab === "similarity" ? "vibe" : nextTab;
    state.tab = VIEWS.some((v) => v.id === normalized) ? normalized : "vibe";
    state.hoverIdx = null;
    if (typeof window !== "undefined" && window.history && window.history.replaceState) {
      try { window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${state.tab}`); } catch (_) {}
    }
    renderView();
  }

  function syncSettingsUi() {
    if (typeof document === "undefined") return;
    const volEl = document.getElementById("set-vol");
    if (volEl) { volEl.value = String(state.audioVolume); syncSliderPct(volEl); }
    const muteEl = document.getElementById("set-mute");
    if (muteEl) muteEl.checked = state.audioEnabled;
    document.querySelectorAll("[data-set-color]").forEach((b) => {
      b.classList.toggle("is-active", b.getAttribute("data-set-color") === window.ME_NODEMAP.getColorMode());
    });
    const activeThemeMode = (typeof window !== "undefined" && window.BTMM_THEME && typeof window.BTMM_THEME.getMode === "function")
      ? window.BTMM_THEME.getMode()
      : state.themeMode;
    document.querySelectorAll("[data-set-theme]").forEach((b) => {
      const active = b.getAttribute("data-set-theme") === activeThemeMode;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function applySearchFilter(q) {
    state.searchQuery = q;
    const ql = q.trim().toLowerCase();
    if (!ql) {
      window.ME_NODEMAP.setFilter(null);
    } else {
      const hits = new Set();
      tracks.forEach((t) => {
        const er = erasById.get(t.era);
        if (
          (t.title || "").toLowerCase().includes(ql) ||
          (er && (er.label || "").toLowerCase().includes(ql)) ||
          (t.cluster_label || "").toLowerCase().includes(ql) ||
          (t.key_label || "").toLowerCase().includes(ql) ||
          (Array.isArray(t.discogs_styles) && t.discogs_styles.some((s) => s.toLowerCase().includes(ql))) ||
          (Array.isArray(t.mood_tags) && t.mood_tags.some((s) => s.toLowerCase().includes(ql))) ||
          (Array.isArray(t.instrument_tags) && t.instrument_tags.some((s) => s.toLowerCase().includes(ql)))
        ) {
          hits.add(t.id);
        }
      });
      window.ME_NODEMAP.setFilter(hits);
    }
    if (!isMapTab()) renderView();
  }

  function selectAndPlayTrack(tid) {
    if (!tid || !byId.has(tid)) return;
    if (window.ME_NODEMAP) window.ME_NODEMAP.setSelectedSilent(tid);
    if (window.BTMM_PLAYER) window.BTMM_PLAYER.select(tid, { silent: true });
    window.ME_AUDIO.toggleTrack(tid);
  }

  function resolveSpacebarTargetTrack() {
    const playingId = window.ME_AUDIO.playing() || window.ME_AUDIO.pending();
    if (playingId) return playingId;
    if (window.BTMM_PLAYER && window.BTMM_PLAYER.selected()) return window.BTMM_PLAYER.selected();
    if (window.ME_NODEMAP && window.ME_NODEMAP.selected()) return window.ME_NODEMAP.selected();
    if (!isMapTab()) {
      const cur = currentItems()[getPinnedIdx()];
      if (cur && cur.tracks && cur.tracks[0]) return cur.tracks[0].id;
    }
    if (window.ME_NODEMAP && window.ME_NODEMAP.firstVisibleTrackId) {
      return window.ME_NODEMAP.firstVisibleTrackId();
    }
    return tracks[0] ? tracks[0].id : null;
  }

  function isTextEditingTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName || "").toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function bindGlobalUi() {
    const searchWrap = document.getElementById("search-wrap");
    const searchOpen = document.getElementById("search-open");
    const searchInput = document.getElementById("search-input");
    const searchClose = document.getElementById("search-close");
    const themeToggleBtn = document.getElementById("theme-toggle");
    const settingsBtn = document.getElementById("settings-open");
    const settingsPop = document.getElementById("settings-popover");

    function closeSearch() {
      if (searchInput) searchInput.value = "";
      applySearchFilter("");
      if (searchWrap) searchWrap.classList.remove("is-open");
    }

    if (searchOpen) searchOpen.addEventListener("click", () => {
      if (searchWrap) searchWrap.classList.add("is-open");
      if (searchInput) searchInput.focus();
    });
    if (searchClose) searchClose.addEventListener("click", closeSearch);
    if (searchInput) searchInput.addEventListener("input", () => applySearchFilter(searchInput.value));

    if (themeToggleBtn) {
      themeToggleBtn.addEventListener("click", () => {
        applyTheme(state.resolvedTheme === "dark" ? "light" : "dark");
      });
    }

    document.getElementById("menu-toggle").addEventListener("click", () => {
      const mobile = window.innerWidth <= 840;
      if (mobile) state.mobileNavOpen = !state.mobileNavOpen;
      else state.navExpanded = !state.navExpanded;
      buildSideNav();
      if (!mobile) setTimeout(() => window.ME_NODEMAP.relayout(false), 220);
    });

    document.getElementById("nav-scrim").addEventListener("click", () => {
      state.mobileNavOpen = false;
      buildSideNav();
    });

    document.getElementById("side-nav").addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-nav-view]");
      if (!btn) return;
      state.mobileNavOpen = false;
      setTab(btn.getAttribute("data-nav-view"));
    });

    document.addEventListener("click", (ev) => {
      const layBtn = ev.target.closest("[data-map-layout]");
      if (layBtn) { setTab(layBtn.getAttribute("data-map-layout")); return; }

      const granBtn = ev.target.closest("[data-granularity]");
      if (granBtn) {
        state.granularity = granBtn.getAttribute("data-granularity");
        state.compareAIdx = 0;
        state.compareBIdx = Math.max(0, currentItems().length - 1);
        renderView();
        return;
      }

      const eraBtn = ev.target.closest("[data-era-idx]");
      if (eraBtn) {
        setPinnedIdx(Number(eraBtn.getAttribute("data-era-idx")));
        renderView();
        return;
      }

      const playBtn = ev.target.closest("[data-track-play]");
      if (playBtn) {
        selectAndPlayTrack(playBtn.getAttribute("data-track-play"));
        return;
      }

      const focusBtn = ev.target.closest("[data-focus-map]");
      if (focusBtn) {
        const tid = focusBtn.getAttribute("data-focus-map");
        setTab("vibe");
        window.ME_NODEMAP.focus(tid);
        return;
      }

      const subBtn = ev.target.closest("[data-sub]");
      if (subBtn) {
        const [k, rawV] = subBtn.getAttribute("data-sub").split(":");
        state[k] = rawV === "true" ? true : rawV === "false" ? false : (!Number.isNaN(Number(rawV)) && rawV !== "" ? Number(rawV) : rawV);
        if (k === "animLoop" && state.tab === "timeline-player") updateTimelineFrame();
        else renderView();
        return;
      }

      const presetBtn = ev.target.closest("[data-compare-preset]");
      if (presetBtn) {
        const p = window.ME_VIEWS_EVOLUTION.COMPARE_PRESETS.find((x) => x.id === presetBtn.getAttribute("data-compare-preset"));
        if (p) {
          const items = currentItems();
          const ia = items.findIndex((x) => x.id === (state.granularity === "phases" ? p.phA : p.eraA));
          const ib = items.findIndex((x) => x.id === (state.granularity === "phases" ? p.phB : p.eraB));
          if (ia >= 0) state.compareAIdx = ia;
          if (ib >= 0) state.compareBIdx = ib;
          renderView();
        }
        return;
      }

      if (ev.target.closest("#anim-play")) { state.animPlaying ? stopAnimPlayback() : startAnimPlayback(); return; }
      if (ev.target.closest("#anim-prev")) { glideToStop(Math.round(state.animPos) - 1); return; }
      if (ev.target.closest("#anim-next")) { glideToStop(Math.round(state.animPos) + 1); return; }
      const stopBtn = ev.target.closest("[data-anim-stop]");
      if (stopBtn) { glideToStop(Number(stopBtn.getAttribute("data-anim-stop"))); return; }
      if (ev.target.closest("#btn-audio-mute")) { state.audioEnabled = !state.audioEnabled; window.ME_AUDIO.setEnabled(state.audioEnabled); syncSettingsUi(); renderView(); return; }
      if (ev.target.closest("#btn-play-scale")) { window.ME_AUDIO.auditionScale(meta.tuning_scales[state.tuningScaleId]); return; }
      if (ev.target.closest("#btn-play-tet")) { window.ME_AUDIO.audition12Tet(); return; }
      const centBtn = ev.target.closest("[data-play-cent]");
      if (centBtn) { window.ME_AUDIO.triggerBellNote(Number(centBtn.getAttribute("data-play-cent")), 0); return; }

      if (settingsPop && !settingsPop.hidden && !ev.target.closest("#settings-popover") && !ev.target.closest("#settings-open")) {
        settingsPop.hidden = true;
        settingsBtn.setAttribute("aria-expanded", "false");
      }
    });

    document.addEventListener("change", (ev) => {
      if (ev.target.id === "anim-sort") { state.animSort = ev.target.value; state.animPos = 0; renderView(); }
      else if (ev.target.id === "anim-ghost") { state.animGhost = ev.target.value; updateTimelineFrame(); }
      else if (ev.target.id === "sel-comp-a") { state.compareAIdx = Number(ev.target.value); renderView(); }
      else if (ev.target.id === "sel-comp-b") { state.compareBIdx = Number(ev.target.value); renderView(); }
    });

    document.addEventListener("input", (ev) => {
      if (ev.target.id === "vol-slider" || ev.target.id === "set-vol") {
        state.audioVolume = Number(ev.target.value);
        window.ME_AUDIO.setVolume(state.audioVolume);
        syncSliderPct(ev.target);
        syncSettingsUi();
      } else if (ev.target.id === "anim-slider") {
        isScrubbing = true;
        state.animPos = Number(ev.target.value);
        updateTimelineFrame();
        const tIdx = Math.round(state.animPos);
        if (scrubHoldTimer) clearTimeout(scrubHoldTimer);
        if ((state.animPlaying || window.ME_AUDIO.playing()) && tIdx !== lastScrubStopIdx) {
          scrubHoldTimer = setTimeout(() => { lastScrubStopIdx = tIdx; queueStopOnBar(tIdx, false); }, 200);
        }
      }
    });

    document.addEventListener("pointerup", () => {
      if (!isScrubbing) return;
      isScrubbing = false;
      if (scrubHoldTimer) { clearTimeout(scrubHoldTimer); scrubHoldTimer = null; }
      const tIdx = Math.round(state.animPos);
      if (state.animPlaying || window.ME_AUDIO.playing()) queueStopOnBar(tIdx, false);
    });

    settingsBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const open = settingsPop.hidden;
      settingsPop.hidden = !open;
      settingsBtn.setAttribute("aria-expanded", String(open));
      if (open) syncSettingsUi();
    });
    settingsPop.addEventListener("click", (ev) => {
      const cBtn = ev.target.closest("[data-set-color]");
      if (cBtn) { window.ME_NODEMAP.setColorMode(cBtn.getAttribute("data-set-color")); syncSettingsUi(); }
      const tBtn = ev.target.closest("[data-set-theme]");
      if (tBtn) {
        if (window.BTMM_THEME && typeof window.BTMM_THEME.setMode === "function") {
          window.BTMM_THEME.setMode(tBtn.getAttribute("data-set-theme"));
        } else {
          applyTheme(tBtn.getAttribute("data-set-theme"));
        }
      }
    });
    document.getElementById("set-mute").addEventListener("change", (ev) => {
      state.audioEnabled = ev.target.checked;
      window.ME_AUDIO.setEnabled(state.audioEnabled);
    });

    // Global Spacebar Play/Pause + Escape handler
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        if (searchWrap && searchWrap.classList.contains("is-open")) { closeSearch(); return; }
        if (settingsPop && !settingsPop.hidden) { settingsPop.hidden = true; settingsBtn.setAttribute("aria-expanded", "false"); return; }
        if (state.mobileNavOpen) { state.mobileNavOpen = false; buildSideNav(); return; }
        if (isMapTab() && window.ME_NODEMAP.selected()) { window.ME_NODEMAP.setClusterFilter(null); }
        return;
      }
      if (ev.code === "Space" || ev.key === " ") {
        if (isTextEditingTarget(document.activeElement) || isTextEditingTarget(ev.target)) return;
        ev.preventDefault();
        if (state.tab === "timeline-player" && state.animPlaying) {
          stopAnimPlayback();
          return;
        }
        const targetTid = resolveSpacebarTargetTrack();
        if (targetTid) selectAndPlayTrack(targetTid);
      }
    });

    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      if (window.innerWidth > 840 && state.mobileNavOpen) state.mobileNavOpen = false;
      buildSideNav();
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { window.ME_NODEMAP.relayout(false); }, 120);
    });
  }

  function boot() {
    initTheme();
    const trackMapData = meta.track_map || DATA.track_map || mapBlob.track_map || {};
    const trackNearData = meta.track_near || DATA.track_near || mapBlob.track_near || {};
    window.ME_AUDIO.setTrackIndex(tracks, { trackMap: trackMapData, trackNear: trackNearData });
    window.ME_AUDIO.setOnStateChange(() => {
      window.ME_NODEMAP.paint();
      if (window.BTMM_PLAYER) window.BTMM_PLAYER.render();
      if (!isMapTab()) renderView();
    });
    if (window.ME_AUDIO.setOnAutoAdvance) {
      window.ME_AUDIO.setOnAutoAdvance((nextId) => {
        if (window.ME_NODEMAP) window.ME_NODEMAP.setSelectedSilent(nextId);
        if (window.BTMM_PLAYER) window.BTMM_PLAYER.select(nextId, { fromAutoPlay: true });
      });
    }
    window.ME_AUDIO.setOnBeat((tid, step) => {
      const leds = document.querySelectorAll("#audio-beat-leds .beat-led");
      if (leds.length === 4) {
        const b = Math.floor(step / 4) % 4;
        leds.forEach((l, i) => l.classList.toggle("on", i === b));
      }
    });

    if (typeof document !== "undefined") {
      window.BTMM_PLAYER.init({
        byId,
        erasById,
        playing: () => window.ME_AUDIO.playing(),
        pending: () => window.ME_AUDIO.pending(),
        getPlaybackState: () => (window.ME_AUDIO.getPlaybackState ? window.ME_AUDIO.getPlaybackState() : null),
        onPlayToggle: (tid) => window.ME_AUDIO.toggleTrack(tid),
        onSeek: (sec) => (window.ME_AUDIO.seek ? window.ME_AUDIO.seek(sec) : 0),
        onRestart: () => (window.ME_AUDIO.restart ? window.ME_AUDIO.restart() : false),
        getAutoPlay: () => (window.ME_AUDIO.getAutoPlay ? window.ME_AUDIO.getAutoPlay() : true),
        onAutoPlayToggle: (val) => (window.ME_AUDIO.setAutoPlay ? window.ME_AUDIO.setAutoPlay(val) : true),
        onSelectionChange: (tid) => {
          if (window.ME_NODEMAP) window.ME_NODEMAP.setSelectedSilent(tid);
        },
        onStarChange: () => {
          if (window.ME_NODEMAP) window.ME_NODEMAP.paint();
        },
      });

      window.ME_NODEMAP.init({
        tracks,
        eras,
        byId,
        erasById,
        styleGroups: meta.style_groups || DATA.style_groups || mapBlob.style_groups || [],
        eraAnchors: meta.era_anchors || DATA.era_anchors || mapBlob.era_anchors || [],
        trackMap: trackMapData,
        trackNear: trackNearData,
        playing: () => window.ME_AUDIO.playing(),
        pending: () => window.ME_AUDIO.pending(),
        onTap: (tid) => window.ME_AUDIO.toggleTrack(tid),
        onLayoutChange: () => renderModeSwitchers(),
      });
      bindGlobalUi();
      if (meta.classifier === "essentia-discogs400") {
        const si = document.getElementById("search-input");
        if (si) si.placeholder = "Filter tracks, genre, mood, key…";
      }
    }

    const rawHash = (typeof window !== "undefined" && window.location && window.location.hash || "").replace(/^#/, "");
    const mappedHash = rawHash === "similarity" ? "vibe" : rawHash;
    if (VIEWS.some((v) => v.id === mappedHash)) state.tab = mappedHash;
    renderView();
    if (typeof window !== "undefined") {
      window.__APP_LOADED__ = true;
      window.__APP_TEST__ = { state, DATA, VIEWS, MODE_LABELS, setTab, renderView, applyTheme };
    }
  }

  boot();
})();
