// Interactive Hybrid Canvas + SVG Vibe Map & Energy-Wave Era Stage
// Features 8-cluster palette, 60fps canvas nodes/edges, and container-level Euclidean nearest-node hit-testing.
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const PAD = 56;
  const LINKS = 2;
  const MORPH_MS = 620;
  const HIT_MOUSE_PX = 30;
  const HIT_TOUCH_PX = 42;
  const DRAG_MOUSE_PX = 8;
  const DRAG_TOUCH_PX = 14;

  const CLUSTER_VARS = [
    "--md-sys-color-cluster-0",
    "--md-sys-color-cluster-1",
    "--md-sys-color-cluster-2",
    "--md-sys-color-cluster-3",
    "--md-sys-color-cluster-4",
    "--md-sys-color-cluster-5",
    "--md-sys-color-cluster-6",
    "--md-sys-color-cluster-7",
    "--md-sys-color-cluster-8",
    "--md-sys-color-cluster-9",
    "--md-sys-color-cluster-10",
  ];
  const PHASE_VARS = {
    phase0_archive: "--md-sys-color-cluster-4",
    phase1_early: "--md-sys-color-cluster-0",
    phase2_mid: "--md-sys-color-cluster-5",
    phase3_ambient: "--md-sys-color-cluster-2",
    phase4_recent: "--md-sys-color-cluster-7",
  };

  let hooks = null;
  let tracks = [];
  let eras = [];
  let byId = new Map();
  let erasById = new Map();
  let styleGroups = [];
  let eraAnchors = [];
  let trackMap = {};
  let trackNear = {};

  let mapWrap = null;
  let canvas = null;
  let ctx = null;
  let svg = null;
  let groupG = null;
  let ringG = null;
  let hoverPill = null;
  let starBtn = null;
  let sketchBtn = null;
  let eraGenAiBtn = null;
  let hudHintEl = null;
  let hudHoverTarget = null; // "star" | "sketch" | "genai" | null
  let starEmptyEl = null;

  let nodes = [];
  let nodeById = new Map();
  let edges = [];
  let eraLayout = null;
  let vibeLayout = null;
  let groupEls = [];

  let layout = "vibe"; // "vibe" | "era"
  let colorMode = "cluster"; // "cluster" | "energy" | "era"
  let filterSet = null;
  let starFilter = false;
  let showSketches = false;
  let showVibeGenAi = false;
  let showEraGenAi = false;
  let activeClusterId = null;
  let activeEraId = null;
  let selectedId = null;
  let hoverId = null;

  let vw = 1000;
  let vh = 700;
  let dpr = 1;
  let zoom = { k: 1, x: 0, y: 0 };
  let tweenRaf = 0;
  let resizeRaf = 0;
  let pulseRaf = 0;
  let pulseLastNow = 0;
  let pulseTimeSec = 0;
  let pulseFlowSec = 0;
  let pulseTargetSec = 0;
  let pulseSizeModPhase = 0;
  let pulseRevWavePhase = 0;
  let pulseDirOscPhase = 0;
  let pulseWaveOriginFlowSec = 0;
  let pulseAlpha = 0;
  let lastRingSig = "";
  const REV_WAVE_FREQ_RATIO = 1.35;
  const pulseState = {
    fromId: null,
    toId: null,
    live: false,
    preview: false,
  };
  let lastPulseRenderTelemetry = {
    mode: "line_dots",
    kFwd: 0,
    kRev: 0,
    dirOsc: {
      osc: 0.5,
      pinch: 0.55,
      pinchGamma: Math.pow(12, 0.55),
      pinchedOsc: Math.pow(0.5, Math.pow(12, 0.55)),
      shapedOsc: Math.pow(0.5, Math.pow(12, 0.55)),
      effFwdAmt: 0.5,
      effRevMix: 0.65,
      effSheenFwd: 1,
      effSheenRev: 0.65,
    },
    forwardDots: [],
    reverseDots: [],
  };
  let previewFromCacheId = null;
  let pulsePanelOpen = false;
  let pulseTuneUi = null;
  let palette = {};

  const PULSE_PRESET_KEY_PRIMARY = "btmm.pulsePreset.v1";
  const PULSE_PRESET_KEY_ALT = "btmm.pulseTuning.v1";
  const PULSE_PRESET_SCHEMA_VERSION = 6;
  const PULSE_PRESET_PROMOTED_AT_MS = Date.parse("2026-11-27T15:13:10Z");
  const DEFAULT_PULSE_PRESET_API = "https://music-map-events.billtribble.workers.dev/api/pulse-preset";
  const VALID_PULSE_MODES = new Set(["line_dots", "line_sheen"]);
  const DEFAULT_PULSE_TUNING = Object.freeze({
    mode: "line_dots",
    lineStrength: 1.25,
    dotSpeed: 0.2,
    reverseMix: 0.65,
    dirOscAmount: 0.75,
    dirOscFreq: 0.1,
    dirOscPinch: 0.55,
    colorCount: 3,
    targetPulseSpeed: 0.25,
    pulseGlow: 0.35,
    dotSize: 1.05,
    dotSizePulseAmt: 0.5,
    dotSizePulseFreq: 0.65,
    dotSpacing: 0.9,
  });
  let pulseTuning = { ...DEFAULT_PULSE_TUNING };
  let pulseUserModifiedInSession = false;
  let pulseLocalSavedAtMs = 0;

  const GEMINI_STOPS_DARK = [
    [139, 92, 246],  // electric Gemini violet
    [66, 133, 244],  // Gemini blue
    [38, 198, 218],  // aqua cyan
    [232, 113, 168], // warm Gemini rose-magenta
    [251, 188, 5],   // luminous Gemini gold
  ];
  const GEMINI_STOPS_LIGHT = [
    [109, 40, 217],  // royal Gemini violet
    [37, 99, 235],   // vivid cobalt blue
    [8, 145, 178],   // crisp teal cyan
    [219, 39, 119],  // vivid rose-magenta
    [217, 119, 6],   // warm amber gold
  ];

  function sanitizePulseTuning(raw, base = DEFAULT_PULSE_TUNING) {
    const src = raw && typeof raw === "object" ? (raw.preset && typeof raw.preset === "object" ? raw.preset : raw) : {};
    const clampRound = (val, min, max, fb) => {
      if (val === undefined || val === null || val === "" || typeof val === "boolean") return fb;
      const n = Number(val);
      if (!Number.isFinite(n)) return fb;
      return Math.round(Math.max(min, Math.min(max, n)) * 1000) / 1000;
    };
    const baseNum = (k) => (base && Number.isFinite(base[k]) ? base[k] : DEFAULT_PULSE_TUNING[k]);
    const rawMode = typeof src.mode === "string" ? src.mode.trim() : "";
    const fbMode = base && VALID_PULSE_MODES.has(base.mode) ? base.mode : DEFAULT_PULSE_TUNING.mode;
    return {
      mode: VALID_PULSE_MODES.has(rawMode) ? rawMode : fbMode,
      lineStrength: clampRound(src.lineStrength, 0.2, 2.0, baseNum("lineStrength")),
      dotSpeed: clampRound(src.dotSpeed, 0, 3, baseNum("dotSpeed")),
      reverseMix: clampRound(src.reverseMix, 0, 1, baseNum("reverseMix")),
      dirOscAmount: clampRound(src.dirOscAmount, 0, 1, baseNum("dirOscAmount")),
      dirOscFreq: clampRound(src.dirOscFreq, 0.02, 0.6, baseNum("dirOscFreq")),
      dirOscPinch: clampRound(src.dirOscPinch, 0, 1, baseNum("dirOscPinch")),
      colorCount: clampRound(src.colorCount, 1, 5, baseNum("colorCount")),
      targetPulseSpeed: clampRound(src.targetPulseSpeed, 0, 3, baseNum("targetPulseSpeed")),
      pulseGlow: clampRound(src.pulseGlow, 0, 2.5, baseNum("pulseGlow")),
      dotSize: clampRound(src.dotSize, 0.5, 2, baseNum("dotSize")),
      dotSizePulseAmt: clampRound(src.dotSizePulseAmt, 0, 1, baseNum("dotSizePulseAmt")),
      dotSizePulseFreq: clampRound(src.dotSizePulseFreq, 0.1, 4, baseNum("dotSizePulseFreq")),
      dotSpacing: clampRound(src.dotSpacing, 0.6, 1.8, baseNum("dotSpacing")),
    };
  }

  function loadStoredPulseTuning() {
    pulseLocalSavedAtMs = 0;
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(PULSE_PRESET_KEY_PRIMARY) || localStorage.getItem(PULSE_PRESET_KEY_ALT);
      if (!raw) {
        pulseTuning = { ...DEFAULT_PULSE_TUNING };
        return;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        pulseTuning = { ...DEFAULT_PULSE_TUNING };
        return;
      }
      const src = parsed.preset && typeof parsed.preset === "object" && !Array.isArray(parsed.preset) ? parsed.preset : parsed;
      const rawVersion = Number(src.version ?? parsed.version) || 0;
      const savedAtRaw = typeof (src.savedAt ?? parsed.savedAt) === "string" ? (src.savedAt ?? parsed.savedAt).trim() : "";
      const savedAtMs = savedAtRaw ? Date.parse(savedAtRaw) : NaN;
      if (rawVersion < PULSE_PRESET_SCHEMA_VERSION) {
        if (Number.isFinite(savedAtMs) && savedAtMs > PULSE_PRESET_PROMOTED_AT_MS) {
          pulseTuning = sanitizePulseTuning(src, DEFAULT_PULSE_TUNING);
          pulseLocalSavedAtMs = savedAtMs;
          const migrated = JSON.stringify({
            version: PULSE_PRESET_SCHEMA_VERSION,
            ...pulseTuning,
            savedAt: savedAtRaw,
          });
          localStorage.setItem(PULSE_PRESET_KEY_PRIMARY, migrated);
          localStorage.setItem(PULSE_PRESET_KEY_ALT, migrated);
        } else {
          localStorage.removeItem(PULSE_PRESET_KEY_PRIMARY);
          localStorage.removeItem(PULSE_PRESET_KEY_ALT);
          pulseTuning = { ...DEFAULT_PULSE_TUNING };
        }
        return;
      }
      pulseTuning = sanitizePulseTuning(src, DEFAULT_PULSE_TUNING);
      if (Number.isFinite(savedAtMs)) pulseLocalSavedAtMs = savedAtMs;
    } catch (_) {
      pulseTuning = { ...DEFAULT_PULSE_TUNING };
    }
  }

  function applyRemotePulsePreset(remoteData, opts = {}) {
    if (!remoteData || typeof remoteData !== "object" || Array.isArray(remoteData)) {
      return { applied: false, reason: "invalid_payload" };
    }
    const presetSrc = remoteData.preset && typeof remoteData.preset === "object" && !Array.isArray(remoteData.preset)
      ? remoteData.preset
      : remoteData;
    const hasField =
      presetSrc.mode !== undefined ||
      presetSrc.lineStrength !== undefined ||
      presetSrc.dotSpeed !== undefined ||
      presetSrc.reverseMix !== undefined ||
      presetSrc.dirOscAmount !== undefined ||
      presetSrc.dirOscFreq !== undefined ||
      presetSrc.dirOscPinch !== undefined ||
      presetSrc.colorCount !== undefined ||
      presetSrc.targetPulseSpeed !== undefined ||
      presetSrc.pulseGlow !== undefined ||
      presetSrc.dotSize !== undefined ||
      presetSrc.dotSizePulseAmt !== undefined ||
      presetSrc.dotSizePulseFreq !== undefined ||
      presetSrc.dotSpacing !== undefined;
    if (!hasField) {
      return { applied: false, reason: "empty_preset" };
    }
    if (!opts.force && pulseUserModifiedInSession) {
      return { applied: false, reason: "user_modified" };
    }
    const updatedRaw = typeof (remoteData.updated_at ?? presetSrc.savedAt) === "string"
      ? (remoteData.updated_at ?? presetSrc.savedAt).trim()
      : "";
    const remoteMs = updatedRaw ? Date.parse(updatedRaw) : NaN;
    if (!opts.force) {
      if (!Number.isFinite(remoteMs) || remoteMs <= PULSE_PRESET_PROMOTED_AT_MS) {
        return { applied: false, reason: "already_promoted" };
      }
      if (pulseLocalSavedAtMs > 0 && remoteMs <= pulseLocalSavedAtMs) {
        return { applied: false, reason: "local_newer" };
      }
    }
    // Always merge onto DEFAULT_PULSE_TUNING so missing <v6 keys (dirOscAmount, dirOscFreq, dirOscPinch)
    // in a legacy D1 row inherit v6 defaults (0.75 / 0.10 / 0.55) instead of clobbering to 0.
    pulseTuning = sanitizePulseTuning(presetSrc, DEFAULT_PULSE_TUNING);
    if (Number.isFinite(remoteMs)) pulseLocalSavedAtMs = remoteMs;
    try {
      if (typeof localStorage !== "undefined") {
        const serialized = JSON.stringify({
          version: PULSE_PRESET_SCHEMA_VERSION,
          ...pulseTuning,
          savedAt: updatedRaw || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        });
        localStorage.setItem(PULSE_PRESET_KEY_PRIMARY, serialized);
        localStorage.setItem(PULSE_PRESET_KEY_ALT, serialized);
      }
    } catch (_) {}
    syncPulseTuningUi();
    paintCanvas();
    return { applied: true, tuning: { ...pulseTuning } };
  }

  async function hydrateRemotePulseTuning() {
    if (typeof fetch !== "function") return { applied: false, reason: "no_fetch" };
    if (typeof window !== "undefined" && window.BTMM_DISABLE_REMOTE_PRESET_FETCH === true) {
      return { applied: false, reason: "disabled" };
    }
    try {
      const endpoint = resolvePulsePresetEndpoint();
      const resp = await fetch(endpoint, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
      });
      if (!resp.ok) return { applied: false, reason: "http_error" };
      const data = await resp.json().catch(() => null);
      if (!data || data.ok === false || !data.preset) return { applied: false, reason: "no_preset" };
      return applyRemotePulsePreset(data);
    } catch (_) {
      return { applied: false, reason: "network_error" };
    }
  }

  function resolvePulsePresetEndpoint() {
    if (typeof window !== "undefined") {
      if (typeof window.BTMM_PULSE_PRESET_URL === "string" && window.BTMM_PULSE_PRESET_URL.trim()) {
        return window.BTMM_PULSE_PRESET_URL.trim();
      }
      if (typeof window.BTMM_EVENTS_API_URL === "string" && window.BTMM_EVENTS_API_URL.trim()) {
        return `${window.BTMM_EVENTS_API_URL.trim().replace(/\/+$/, "")}/api/pulse-preset`;
      }
    }
    return DEFAULT_PULSE_PRESET_API;
  }

  function samplePalette() {
    if (typeof document === "undefined" || typeof getComputedStyle !== "function") return;
    const cs = getComputedStyle(document.documentElement);
    const val = (v, fb) => (cs.getPropertyValue(v) || "").trim() || fb;
    palette = {
      clusters: CLUSTER_VARS.map((v, i) => val(v, i % 2 ? "#80CFFF" : "#A7C7FA")),
      phases: Object.fromEntries(Object.entries(PHASE_VARS).map(([k, v]) => [k, val(v, "#A7C7FA")])),
      energy: [
        val("--md-sys-color-cluster-0", "#60A5FA"),
        val("--md-sys-color-cluster-2", "#2DD4BF"),
        val("--md-sys-color-cluster-3", "#4ADE80"),
        val("--md-sys-color-cluster-4", "#FBBF24"),
        val("--md-sys-color-cluster-7", "#FB7185"),
      ],
      primary: val("--md-sys-color-primary", "#D0BCFF"),
      outline: val("--md-sys-color-outline-variant", "#444746"),
      edgeLine: val("--md-sys-color-outline", "#8E9099"),
      edgeLineDark: val("--md-sys-color-on-surface-variant", "#C2C5D0"),
      surfaceLowest: val("--md-sys-color-surface-container-lowest", "#16161B"),
      onSurface: val("--md-sys-color-on-surface", "#E8E9EF"),
      playing: val("--md-sys-color-cluster-2", "#2DD4BF"),
      queued: val("--md-sys-color-cluster-4", "#FBBF24"),
      bandAlt: val("--md-sys-color-surface-container", "#1C1C22"),
      bandActive: val("--md-sys-color-surface-container-high", "#262730"),
      gridLine: val("--md-sys-color-outline-variant", "#3D404A"),
      spineGlow: val("--md-sys-color-primary-container", "#4F378B"),
    };
  }

  function normLayoutName(lay) {
    if (lay === "similarity") return "vibe";
    return lay === "era" ? "era" : "vibe";
  }

  function elSvg(tag, cls) {
    const e = document.createElementNS(NS, tag);
    if (cls) e.setAttribute("class", cls);
    return e;
  }

  function energyColor(en) {
    const e = palette.energy || [];
    if (en <= 2) return e[0] || palette.primary;
    if (en <= 4) return e[1] || palette.primary;
    if (en === 5) return e[2] || palette.primary;
    if (en <= 6) return e[3] || palette.primary;
    return e[4] || palette.primary;
  }

  function trackColor(t) {
    if (colorMode === "energy") return energyColor(t.energy);
    if (colorMode === "era") {
      const er = erasById.get(t.era);
      return (palette.phases && palette.phases[er && er.phase]) || palette.primary;
    }
    const cols = palette.clusters || [];
    const idx = Number.isFinite(t.cluster_idx) ? t.cluster_idx : 0;
    return cols[((idx % cols.length) + cols.length) % cols.length] || palette.primary;
  }

  function nodeScreenRadius(t) {
    const e = Math.max(1, Math.min(10, Number(t.energy || 4)));
    const isMobileEra = layout === "era" && vw <= 800;
    const base = vw <= 600 && !isMobileEra
      ? 2.5 + ((e - 1) / 9) * 1.1
      : 3.4 + ((e - 1) / 9) * 1.5;
    // Shrink circle size in screen pixels as you zoom in so dense clusters open up for all track labels
    const zoomShrink = zoom.k <= 1 ? 1 : Math.max(0.56, 1 / Math.pow(zoom.k, 0.28));
    return Math.max(2.0, base * zoomShrink);
  }

  function isGenAiShown() {
    return layout === "era" ? showEraGenAi : showVibeGenAi;
  }

  function isSketchHidden(t) {
    if (!t) return false;
    if (Boolean(t.is_ai) && !isGenAiShown()) return true;
    const hideSketch = !showSketches && Boolean(t.is_sketch);
    if (!hideSketch) return false;
    const playId = hooks && hooks.playing ? hooks.playing() : null;
    const pendId = hooks && hooks.pending ? hooks.pending() : null;
    if (t.id === selectedId || t.id === playId || t.id === pendId) return false;
    return true;
  }

  // Fan out co-located or near-touching screen dots into a small ring (Groove Explorer style)
  function computeScreenPositions() {
    const T = 7.5;
    const raw = nodes.map((n) => [n.x * zoom.k + zoom.x, n.y * zoom.k + zoom.y]);
    const taken = new Set();
    for (let i = 0; i < nodes.length; i++) {
      if (taken.has(i)) continue;
      if (isSketchHidden(nodes[i].t) || !isMatch(nodes[i].t)) {
        nodes[i].px = raw[i][0];
        nodes[i].py = raw[i][1];
        nodes[i].fanAngle = null;
        taken.add(i);
        continue;
      }
      const grp = [i];
      taken.add(i);
      for (let j = i + 1; j < nodes.length; j++) {
        if (taken.has(j) || isSketchHidden(nodes[j].t) || !isMatch(nodes[j].t)) continue;
        if (Math.abs(raw[i][0] - raw[j][0]) < T && Math.hypot(raw[i][0] - raw[j][0], raw[i][1] - raw[j][1]) < T) {
          grp.push(j);
          taken.add(j);
        }
      }
      if (grp.length === 1) {
        nodes[i].px = raw[i][0];
        nodes[i].py = raw[i][1];
        nodes[i].fanAngle = null;
        continue;
      }
      const cx = grp.reduce((acc, idx) => acc + raw[idx][0], 0) / grp.length;
      const cy = grp.reduce((acc, idx) => acc + raw[idx][1], 0) / grp.length;
      const gap = Math.min(40, Math.max(10, 12 * Math.sqrt(Math.max(1, zoom.k))));
      const ringR = Math.max(7, grp.length === 2 ? gap * 0.5 : gap / (2 * Math.sin(Math.PI / grp.length)));
      for (let k = 0; k < grp.length; k++) {
        const ang = -Math.PI / 2 + (2 * Math.PI * k) / grp.length;
        const ni = grp[k];
        nodes[ni].px = cx + ringR * Math.cos(ang);
        nodes[ni].py = cy + ringR * Math.sin(ang);
        nodes[ni].fanAngle = ang;
      }
    }
  }

  function territoryOf(t) {
    if (t && t.is_spoken_word) return "spoken";
    if (t && t.is_ai) return "ai";
    return "music";
  }

  function constellationKeyOf(t) {
    if (!t) return "";
    if (t.is_spoken_word) return "spoken";
    if (t.is_ai) return t.ai_sub_id || "ai_generative";
    return t.cluster_id || String(t.cluster_idx || 0);
  }

  function isClusterMatch(t) {
    if (!activeClusterId) return true;
    if (activeClusterId === "spoken_word") return Boolean(t.is_spoken_word);
    if (activeClusterId === "ai_generative") return Boolean(t.is_ai);
    if (activeClusterId.startsWith("ai_sub_")) return Boolean(t.is_ai) && t.ai_sub_id === activeClusterId;
    return !t.is_ai && !t.is_spoken_word && t.cluster_id === activeClusterId;
  }

  function eraKeyOf(t) {
    return t && t.is_ai ? "genai_2025" : (t ? t.era : "");
  }

  function isMatch(t) {
    if (isSketchHidden(t)) return false;
    if (filterSet && !filterSet.has(t.id)) return false;
    if (starFilter && window.BTMM_PLAYER && !window.BTMM_PLAYER.isStarred(t.id)) return false;
    if (layout === "vibe" && !isClusterMatch(t)) return false;
    if (layout === "era" && activeEraId && eraKeyOf(t) !== activeEraId) return false;
    return true;
  }

  function computeVibeLayout() {
    const isMobile = vw <= 768;
    const topPad = vw <= 800 ? 64 : PAD;
    const sidePad = vw <= 800 ? 16 : PAD;
    const botPad = vw <= 800 ? 24 : PAD;
    const rawW = Math.max(220, vw - sidePad * 2);
    const rawH = Math.max(200, vh - topPad - botPad);

    let hMinX = Infinity, hMaxX = -Infinity;
    let aMinX = Infinity, aMaxX = -Infinity;
    let hasHuman = false, hasAi = false;

    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t || t.is_spoken_word) continue;
      const coords = trackMap[t.id];
      const norm = coords && (coords.vibe || coords.similarity);
      if (!norm) continue;
      const nx = norm[0];
      if (t.is_ai) {
        if (showVibeGenAi) {
          if (nx < aMinX) aMinX = nx;
          if (nx > aMaxX) aMaxX = nx;
          hasAi = true;
        }
      } else {
        if (nx < hMinX) hMinX = nx;
        if (nx > hMaxX) hMaxX = nx;
        hasHuman = true;
      }
    }

    let offsetX = sidePad;
    let spanW = rawW;
    let virtualW = vw;

    if (hasHuman && hasAi && showVibeGenAi && aMaxX > hMinX + 0.05) {
      // Show Gen AI is ON: fit both the handcrafted constellation and the cohesive AI constellation cleanly on screen
      const aiPadX = vw > 840 ? 32 : 12;
      const leftPad = isMobile ? 16 : 64;
      const rightPad = isMobile ? 12 : 28;
      const denom = Math.max(0.20, aMaxX - hMinX);
      spanW = Math.max(180, (vw - leftPad - rightPad - aiPadX) / denom);
      offsetX = leftPad - hMinX * spanW;
      virtualW = vw;
    } else if (hasHuman && !showVibeGenAi && hMaxX > hMinX + 0.05) {
      // Show Gen AI is OFF (default): center 100% of the human-made catalog cleanly across the full viewport
      const sideMargin = isMobile ? 22 : Math.max(88, Math.round(vw * 0.085));
      spanW = (vw - sideMargin * 2) / (hMaxX - hMinX);
      offsetX = sideMargin - hMinX * spanW;
      virtualW = vw;
    }

    const h = vh > vw * 1.15
      ? Math.min(rawH, Math.max(rawH * 0.92, rawW * 1.45))
      : rawH;
    const startY = topPad + (rawH - h) * 0.45;
    const spreadScale = Math.max(1, Math.min(1.55, Math.hypot(spanW / rawW, 1) / Math.SQRT2));

    return {
      offsetX,
      spanW,
      startY,
      spanH: h,
      virtualW,
      virtualH: vh,
      spreadScale,
      defaultZoom: { k: 1, x: 0, y: 0 },
    };
  }

  function vibeTarget(tid) {
    const coords = trackMap[tid];
    const norm = (coords && (coords.vibe || coords.similarity)) || [0.5, 0.5];
    const vl = vibeLayout || computeVibeLayout();
    let tx = vl.offsetX + norm[0] * vl.spanW;
    const tr = byId.get(tid);
    if (tr && tr.is_spoken_word && !showVibeGenAi) {
      tx = Math.min(vw - 74, tx);
    }
    return [tx, vl.startY + norm[1] * vl.spanH];
  }

  function computeTargetPositions() {
    if (layout === "era" && window.BTMM_TIMELINE_ERA) {
      vibeLayout = null;
      const visTracks = tracks.filter((t) => !isSketchHidden(t));
      eraLayout = window.BTMM_TIMELINE_ERA.computeLayout(visTracks, eras, erasById, vw, vh);
      nodes.forEach((n) => {
        const c = eraLayout.coords.get(n.id);
        n.tx = c ? c.x : vw * 0.5;
        n.ty = c ? c.y : vh * 0.5;
      });
    } else {
      eraLayout = null;
      vibeLayout = computeVibeLayout();
      nodes.forEach((n) => {
        const [tx, ty] = vibeTarget(n.id);
        n.tx = tx;
        n.ty = ty;
      });
    }
  }

  function buildEdges() {
    const pairs = new Map();
    const keyFor = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const addEdge = (a, b, w, weak) => {
      const k = keyFor(a, b);
      if (pairs.has(k)) return;
      const aCanon = a < b ? a : b;
      const bCanon = a < b ? b : a;
      pairs.set(k, { a: aCanon, b: bCanon, w, weak });
    };
    const visNodes = nodes.filter((n) => !isSketchHidden(n.t));
    const visSet = new Set(visNodes.map((n) => n.id));

    if (layout === "vibe") {
      const minDim = Math.min(vw, vh);
      const spreadScale = (vibeLayout && vibeLayout.spreadScale) || 1;
      const maxChordPx = minDim * 0.145 * spreadScale;
      const maxIntraBridgePx = minDim * 0.22 * spreadScale;
      const maxWebPx = minDim * 0.275 * spreadScale;
      const maxSpanBridgePx = minDim * 0.36 * spreadScale;
      const MIN_CHORD_SIM = 0.56;
      const MIN_INTRA_SPAN_SIM = 0.28;

      const nearSim = new Map();
      visNodes.forEach((n) => {
        const tid = n.id;
        (trackNear[tid] || []).forEach(([nid, sim]) => {
          if (!visSet.has(nid)) return;
          const k = keyFor(tid, nid);
          const prev = nearSim.get(k) || 0;
          if (sim > prev) nearSim.set(k, sim);
        });
      });

      // Pass 1a: Intra-constellation local chords (strong internal skeleton)
      visNodes.forEach((n) => {
        const t = n.t;
        if (t.is_spoken_word) return;
        const tTerr = territoryOf(t);
        const tConst = constellationKeyOf(t);
        const minChordSim = tTerr === "ai" ? 0.50 : MIN_CHORD_SIM;
        const candidates = (trackNear[t.id] || []).filter(([nid, sim]) => {
          if (sim < minChordSim) return false;
          if (!visSet.has(nid)) return false;
          const nb = nodeById.get(nid);
          if (!nb || territoryOf(nb.t) !== tTerr || constellationKeyOf(nb.t) !== tConst) return false;
          return Math.hypot(nb.tx - n.tx, nb.ty - n.ty) <= maxChordPx;
        }).slice(0, LINKS);
        candidates.forEach(([nid, sim]) => {
          addEdge(t.id, nid, sim, false);
        });
      });

      if (visNodes.length <= 800) {
        const parent = new Map(visNodes.map((n) => [n.id, n.id]));
        const find = (x) => {
          while (parent.get(x) !== x) {
            parent.set(x, parent.get(parent.get(x)));
            x = parent.get(x);
          }
          return x;
        };
        const unite = (a, b) => {
          const ra = find(a), rb = find(b);
          if (ra !== rb) { parent.set(ra, rb); return true; }
          return false;
        };
        pairs.forEach((e) => unite(e.a, e.b));

        // Pass 1b: Intra-constellation Kruskal connectivity so each genre forms one coherent constellation
        const intraCands = [];
        nearSim.forEach((sim, k) => {
          if (sim < MIN_INTRA_SPAN_SIM || pairs.has(k)) return;
          const sep = k.indexOf("|");
          const aId = k.slice(0, sep), bId = k.slice(sep + 1);
          const a = nodeById.get(aId), b = nodeById.get(bId);
          if (!a || !b || a.t.is_spoken_word || b.t.is_spoken_word) return;
          if (territoryOf(a.t) !== territoryOf(b.t)) return;
          if (constellationKeyOf(a.t) !== constellationKeyOf(b.t)) return;
          if (find(aId) === find(bId)) return;
          const d = Math.hypot(a.tx - b.tx, a.ty - b.ty);
          if (d > maxIntraBridgePx) return;
          intraCands.push({ a: aId, b: bId, d, sim, cost: d / Math.max(0.45, sim) });
        });
        intraCands.sort((p, q) => p.cost - q.cost);
        for (const c of intraCands) {
          if (unite(c.a, c.b)) addEdge(c.a, c.b, c.sim, false);
        }

        // Pass 2: Genuine cross-genre / cross-subfamily sonic web (strictly X_hybrid acoustic cousins in trackNear — zero blind pixel bridges!)
        const crossDeg = new Map();
        const pairConstCnt = new Map();
        const bumpCross = (aId, bId, cKey) => {
          crossDeg.set(aId, (crossDeg.get(aId) || 0) + 1);
          crossDeg.set(bId, (crossDeg.get(bId) || 0) + 1);
          pairConstCnt.set(cKey, (pairConstCnt.get(cKey) || 0) + 1);
        };

        // Pass 2a: Acoustic spanning spine so all constellations weave into one connected web
        const spanCands = [];
        nearSim.forEach((sim, k) => {
          if (pairs.has(k)) return;
          const sep = k.indexOf("|");
          const aId = k.slice(0, sep), bId = k.slice(sep + 1);
          const a = nodeById.get(aId), b = nodeById.get(bId);
          if (!a || !b || a.t.is_spoken_word || b.t.is_spoken_word) return;
          const terr = territoryOf(a.t);
          if (terr !== territoryOf(b.t)) return;
          const ca = constellationKeyOf(a.t), cb = constellationKeyOf(b.t);
          if (ca === cb) return;
          const minSim = terr === "ai" ? 0.58 : 0.645;
          if (sim < minSim) return;
          const d = Math.hypot(a.tx - b.tx, a.ty - b.ty);
          const maxSpanPx = terr === "ai" ? minDim * 0.26 * spreadScale : maxSpanBridgePx;
          if (d > maxSpanPx) return;
          spanCands.push({ a: aId, b: bId, ca, cb, d, sim, cost: d / (sim * sim) });
        });
        spanCands.sort((p, q) => p.cost - q.cost);
        for (const c of spanCands) {
          if (unite(c.a, c.b)) {
            const cKey = keyFor(c.ca, c.cb);
            addEdge(c.a, c.b, c.sim, true);
            bumpCross(c.a, c.b, cKey);
          }
        }

        // Pass 2b: Multi-filament coastal cousin weave across acoustically related neighboring genres
        const weaveCands = [];
        nearSim.forEach((sim, k) => {
          if (pairs.has(k)) return;
          const sep = k.indexOf("|");
          const aId = k.slice(0, sep), bId = k.slice(sep + 1);
          const a = nodeById.get(aId), b = nodeById.get(bId);
          if (!a || !b || a.t.is_spoken_word || b.t.is_spoken_word) return;
          const terr = territoryOf(a.t);
          if (terr !== territoryOf(b.t)) return;
          const ca = constellationKeyOf(a.t), cb = constellationKeyOf(b.t);
          if (ca === cb) return;
          const minSim = terr === "ai" ? 0.62 : 0.65;
          if (sim < minSim) return;
          const d = Math.hypot(a.tx - b.tx, a.ty - b.ty);
          const maxTerrWebPx = terr === "ai" ? minDim * 0.195 * spreadScale : minDim * 0.265 * spreadScale;
          if (d > maxTerrWebPx) return;
          const score = sim - 0.22 * (d / maxTerrWebPx);
          weaveCands.push({ a: aId, b: bId, ca, cb, terr, sim, score });
        });
        weaveCands.sort((p, q) => q.score - p.score);
        for (const c of weaveCands) {
          const maxNodeCross = 2;
          if ((crossDeg.get(c.a) || 0) >= maxNodeCross || (crossDeg.get(c.b) || 0) >= maxNodeCross) continue;
          const cKey = keyFor(c.ca, c.cb);
          const maxPair = c.terr === "ai" ? 5 : 4;
          if ((pairConstCnt.get(cKey) || 0) >= maxPair) continue;
          addEdge(c.a, c.b, c.sim, true);
          bumpCross(c.a, c.b, cKey);
        }
      }
    } else {
      // Intra-era subtle harmonic arcs (nearest visible within same era & musical territory)
      const byEra = new Map();
      visNodes.forEach((n) => {
        const t = n.t;
        if (t.is_spoken_word) return;
        const ek = eraKeyOf(t);
        if (!byEra.has(ek)) byEra.set(ek, []);
        byEra.get(ek).push(t);
      });
      byEra.forEach((list) => {
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          const tTerr = territoryOf(t);
          const ek = eraKeyOf(t);
          let near = (trackNear[t.id] || []).find(([nid]) => {
            if (!visSet.has(nid)) return false;
            const nt = byId.get(nid);
            return nt && eraKeyOf(nt) === ek && territoryOf(nt) === tTerr;
          });
          if (!near && Array.isArray(t.feat_vec) && t.feat_vec.length) {
            let bestId = null;
            let bestSim = 0.45;
            const va = t.feat_vec;
            let na = 0;
            for (let k = 0; k < va.length; k++) na += va[k] * va[k];
            na = Math.sqrt(na) || 1;
            for (let j = 0; j < list.length; j++) {
              if (i === j) continue;
              const cand = list[j];
              if (territoryOf(cand) !== tTerr || !Array.isArray(cand.feat_vec)) continue;
              const vb = cand.feat_vec;
              let dot = 0, nb = 0;
              const len = Math.min(va.length, vb.length);
              for (let k = 0; k < len; k++) { dot += va[k] * vb[k]; nb += vb[k] * vb[k]; }
              const sim = dot / (na * (Math.sqrt(nb) || 1));
              if (sim > bestSim) { bestSim = sim; bestId = cand.id; }
            }
            if (bestId) near = [bestId, bestSim];
          }
          if (near) {
            const k = keyFor(t.id, near[0]);
            if (!pairs.has(k)) pairs.set(k, { a: t.id, b: near[0], w: near[1], weak: true });
          }
        }
      });
    }
    edges = [...pairs.values()];
  }

  function repaintLabelsFrame() {
    paintCanvas();
    drawFloatingLabels();
  }

  function drawFloatingLabels() {
    if (!groupG) return;
    groupEls = [];

    if (layout === "era" && window.BTMM_TIMELINE_ERA && eraLayout) {
      if (window.BTMM_MAP_LABELS && window.BTMM_MAP_LABELS.clearClusterDom) {
        window.BTMM_MAP_LABELS.clearClusterDom(groupG);
      } else {
        groupG.innerHTML = "";
      }
      window.BTMM_TIMELINE_ERA.renderOverlay(groupG, eraLayout, zoom, vw, vh, activeEraId, (eraId) => {
        activeEraId = activeEraId === eraId ? null : eraId;
        activeClusterId = null;
        paint();
      });
      return;
    }

    if (window.BTMM_MAP_LABELS) {
      window.BTMM_MAP_LABELS.renderClusterLandmarks(groupG, {
        styleGroups,
        nodeById,
        nodes,
        zoom,
        vw,
        vh,
        activeClusterId,
        isMatch,
        isHidden: isSketchHidden,
        mapWrap,
        onRequestFrame: repaintLabelsFrame,
        onToggleCluster: (cid) => setClusterFilter(activeClusterId === cid ? null : cid),
      });
    }
  }

  function updateHudHint() {
    const starLbl = document.getElementById("star-btn-label");
    const sketchLbl = document.getElementById("sketch-btn-label");
    const genaiLbl = document.getElementById("era-genai-btn-label");
    const genAiActive = isGenAiShown();
    if (starLbl) starLbl.textContent = starFilter ? "Starred only · On" : "Starred only";
    if (sketchLbl) sketchLbl.textContent = showSketches ? "Hide sketches" : "Show sketches";
    if (genaiLbl) genaiLbl.textContent = genAiActive ? "Hide Gen AI" : "Show Gen AI";
    if (starBtn) starBtn.classList.toggle("is-hint-open", hudHoverTarget === "star");
    if (sketchBtn) sketchBtn.classList.toggle("is-hint-open", hudHoverTarget === "sketch");
    if (eraGenAiBtn) eraGenAiBtn.classList.toggle("is-hint-open", hudHoverTarget === "genai");
  }

  function syncStarHud() {
    if (starBtn) {
      starBtn.classList.toggle("is-active", starFilter);
      starBtn.setAttribute("aria-pressed", String(starFilter));
      starBtn.setAttribute("aria-label", starFilter ? "Starred only (active)" : "Starred only");
    }
    if (sketchBtn) {
      sketchBtn.classList.toggle("is-active", showSketches);
      sketchBtn.setAttribute("aria-pressed", String(showSketches));
      sketchBtn.setAttribute("aria-label", showSketches ? "Hide sketches" : "Show sketches");
    }
    if (eraGenAiBtn) {
      const genAiActive = isGenAiShown();
      eraGenAiBtn.hidden = false;
      eraGenAiBtn.classList.toggle("is-active", genAiActive);
      eraGenAiBtn.setAttribute("aria-pressed", String(genAiActive));
      eraGenAiBtn.setAttribute("aria-label", genAiActive ? "Hide Gen AI" : "Show Gen AI");
    }
    updateHudHint();
    if (starEmptyEl) {
      const cnt = window.BTMM_PLAYER ? window.BTMM_PLAYER.starredCount() : 0;
      starEmptyEl.hidden = !(starFilter && cnt === 0);
    }
  }

  function updateHoverPill() {
    if (!hoverPill) return;
    const hn = hoverId ? nodeById.get(hoverId) : null;
    const alreadyLabeled = hn && window.BTMM_MAP_LABELS && window.BTMM_MAP_LABELS.isLabelShown && window.BTMM_MAP_LABELS.isLabelShown(hn.id);
    if (!hn || !isMatch(hn.t) || alreadyLabeled) {
      hoverPill.hidden = true;
      return;
    }
    const sx = Number.isFinite(hn.px) ? hn.px : hn.x * zoom.k + zoom.x;
    const sy = Number.isFinite(hn.py) ? hn.py : hn.y * zoom.k + zoom.y;
    const r = nodeScreenRadius(hn.t);
    const wip = Boolean(window.isTrackWorkInProgress && window.isTrackWorkInProgress(hn.t));
    const baseText = hn.t.discogs_top ? `${hn.t.title} · ${hn.t.discogs_top}` : hn.t.title;
    hoverPill.innerHTML = "";
    const txtSpan = document.createElement("span");
    txtSpan.textContent = baseText;
    hoverPill.appendChild(txtSpan);
    if (wip) {
      const wipSpan = document.createElement("span");
      wipSpan.className = "mp-wip-pill";
      wipSpan.textContent = "Work in progress";
      hoverPill.appendChild(wipSpan);
    }
    hoverPill.style.left = `${sx.toFixed(1)}px`;
    hoverPill.style.top = `${Math.max(44, sy - r - 12).toFixed(1)}px`;
    hoverPill.hidden = false;
  }

  function paintRings(playId, pendId) {
    if (!ringG) return;

    const targets = [];
    if (hoverId && hoverId !== selectedId && hoverId !== playId) targets.push({ id: hoverId, kind: "hover" });
    if (pendId && pendId !== playId) targets.push({ id: pendId, kind: "queued" });
    if (selectedId) targets.push({ id: selectedId, kind: "selected" });
    if (playId) targets.push({ id: playId, kind: "playing" });

    const nextRingSig = targets.map((item) => {
      const n = nodeById.get(item.id);
      if (!n) return "";
      const sx = Number.isFinite(n.px) ? n.px : n.x * zoom.k + zoom.x;
      const sy = Number.isFinite(n.py) ? n.py : n.y * zoom.k + zoom.y;
      return `${item.kind}:${item.id}:${sx.toFixed(1)},${sy.toFixed(1)}:${zoom.k.toFixed(3)}:${trackColor(n.t)}`;
    }).join("|") + `|${palette.playing}|${palette.queued}|${palette.primary}`;

    if (nextRingSig === lastRingSig) return;
    lastRingSig = nextRingSig;
    ringG.innerHTML = "";

    targets.forEach((item) => {
      const n = nodeById.get(item.id);
      if (!n) return;
      const sx = Number.isFinite(n.px) ? n.px : n.x * zoom.k + zoom.x;
      const sy = Number.isFinite(n.py) ? n.py : n.y * zoom.k + zoom.y;
      const baseR = nodeScreenRadius(n.t);

      if (item.kind === "hover") {
        const aura = elSvg("circle");
        aura.setAttribute("cx", sx.toFixed(1));
        aura.setAttribute("cy", sy.toFixed(1));
        aura.setAttribute("r", "16");
        aura.setAttribute("fill", trackColor(n.t));
        aura.setAttribute("fill-opacity", "0.2");
        ringG.appendChild(aura);
      } else {
        const ring = elSvg("circle");
        ring.setAttribute("cx", sx.toFixed(1));
        ring.setAttribute("cy", sy.toFixed(1));
        ring.setAttribute("r", String((baseR + 4.4).toFixed(1)));
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", item.kind === "playing" ? palette.playing : item.kind === "queued" ? palette.queued : palette.primary);
        ring.setAttribute("stroke-width", item.kind === "playing" ? "2.2" : "1.9");
        if (item.kind === "playing") ring.setAttribute("stroke-dasharray", "4 2.5");
        else if (item.kind === "queued") ring.setAttribute("stroke-dasharray", "3 3");
        ringG.appendChild(ring);
      }
    });
  }

  function isReducedMotionPreferred() {
    return Boolean(
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function isNodeRenderedOnMap(n) {
    if (!n || !n.t) return false;
    if (isSketchHidden(n.t)) return false;
    if (starFilter && !isMatch(n.t)) return false;
    return true;
  }

  function resolveUpcomingTargetId(playId, pendId) {
    if (!playId) return null;
    if (pendId && pendId !== playId && byId.has(pendId)) return pendId;
    if (hooks && typeof hooks.upcoming === "function") {
      const upId = hooks.upcoming(playId);
      if (upId && upId !== playId && byId.has(upId)) return upId;
    }
    if (typeof window !== "undefined" && window.ME_AUDIO && typeof window.ME_AUDIO.peekNextTrack === "function") {
      const nextTr = window.ME_AUDIO.peekNextTrack(playId);
      if (nextTr && nextTr.id && nextTr.id !== playId && byId.has(nextTr.id)) {
        return nextTr.id;
      }
    }
    return null;
  }

  function fract(x) {
    return x - Math.floor(x);
  }

  function smoothstep(edge0, edge1, x) {
    if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  function sampleStopsSubset(stops, count, t) {
    const n = Math.max(1, Math.min(stops.length, count));
    if (n <= 1) return [stops[0][0], stops[0][1], stops[0][2]];
    const pos = fract(t) * n;
    const idx = Math.floor(pos) % n;
    const f = pos - Math.floor(pos);
    const s = f * f * (3 - 2 * f);
    const a = stops[idx];
    const b = stops[(idx + 1) % n];
    return [
      Math.round(a[0] + (b[0] - a[0]) * s),
      Math.round(a[1] + (b[1] - a[1]) * s),
      Math.round(a[2] + (b[2] - a[2]) * s),
    ];
  }

  function sampleGeminiCyclic(t, isLight) {
    const stops = isLight ? GEMINI_STOPS_LIGHT : GEMINI_STOPS_DARK;
    const maxStops = stops.length;
    const c = Math.max(1, Math.min(maxStops, Number(pulseTuning.colorCount) || 4));
    const lowN = Math.floor(c);
    const rem = c - lowN;
    if (rem <= 0.001 || lowN >= maxStops) {
      return sampleStopsSubset(stops, lowN, t);
    }
    const cA = sampleStopsSubset(stops, lowN, t);
    const cB = sampleStopsSubset(stops, lowN + 1, t);
    return [
      Math.round(cA[0] + (cB[0] - cA[0]) * rem),
      Math.round(cA[1] + (cB[1] - cA[1]) * rem),
      Math.round(cA[2] + (cB[2] - cA[2]) * rem),
    ];
  }

  function rgbaStr(rgb, alpha) {
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
  }

  function parseCssRgb(str, fallback) {
    const s = String(str || "").trim();
    if (s.charCodeAt(0) === 35) {
      const body = s.slice(1);
      if (body.length === 3) {
        const r = parseInt(body[0] + body[0], 16);
        const g = parseInt(body[1] + body[1], 16);
        const b = parseInt(body[2] + body[2], 16);
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b];
      } else if (body.length >= 6) {
        const r = parseInt(body.slice(0, 2), 16);
        const g = parseInt(body.slice(2, 4), 16);
        const b = parseInt(body.slice(4, 6), 16);
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b];
      }
    }
    const m = s.match(/rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i);
    if (m) {
      return [
        Math.max(0, Math.min(255, Math.round(Number(m[1])))),
        Math.max(0, Math.min(255, Math.round(Number(m[2])))),
        Math.max(0, Math.min(255, Math.round(Number(m[3])))),
      ];
    }
    return fallback;
  }

  function mixRgb(a, b, t) {
    const k = Math.max(0, Math.min(1, t));
    return [
      Math.round(a[0] + (b[0] - a[0]) * k),
      Math.round(a[1] + (b[1] - a[1]) * k),
      Math.round(a[2] + (b[2] - a[2]) * k),
    ];
  }

  function resolvePreviewPulsePair() {
    const tryFrom = (fid) => {
      if (!fid) return null;
      const fn = nodeById.get(fid);
      if (!fn || !isNodeRenderedOnMap(fn) || !isMatch(fn.t)) return null;
      const tid = resolveUpcomingTargetId(fid, null);
      if (!tid || tid === fid) return null;
      const tn = nodeById.get(tid);
      if (!tn || !isNodeRenderedOnMap(tn)) return null;
      const ax = Number.isFinite(fn.px) ? fn.px : fn.x * zoom.k + zoom.x;
      const ay = Number.isFinite(fn.py) ? fn.py : fn.y * zoom.k + zoom.y;
      const bx = Number.isFinite(tn.px) ? tn.px : tn.x * zoom.k + zoom.x;
      const by = Number.isFinite(tn.py) ? tn.py : tn.y * zoom.k + zoom.y;
      if (ax < 36 || ax > vw - 36 || ay < 52 || ay > vh - 36) return null;
      if (bx < 36 || bx > vw - 36 || by < 52 || by > vh - 36) return null;
      if (Math.hypot(bx - ax, by - ay) < 22) return null;
      return [fid, tid];
    };

    if (selectedId) {
      const selPair = tryFrom(selectedId);
      if (selPair) return selPair;
    }
    if (previewFromCacheId) {
      const cachedPair = tryFrom(previewFromCacheId);
      if (cachedPair) return cachedPair;
    }

    const targetX = vw * 0.56;
    const targetY = vh * 0.42;
    let bestPair = null;
    let bestScore = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!isNodeRenderedOnMap(n) || !isMatch(n.t)) continue;
      const ax = Number.isFinite(n.px) ? n.px : n.x * zoom.k + zoom.x;
      const ay = Number.isFinite(n.py) ? n.py : n.y * zoom.k + zoom.y;
      // Keep preview cleanly outside the bottom-left tuning panel & right-hand player card
      if (ax < Math.min(348, vw * 0.35) && ay > vh * 0.25) continue;
      if (ax < 48 || ax > vw - 60 || ay < 64 || ay > vh - 64) continue;
      const pair = tryFrom(n.id);
      if (!pair) continue;
      const tn = nodeById.get(pair[1]);
      const bx = Number.isFinite(tn.px) ? tn.px : tn.x * zoom.k + zoom.x;
      const by = Number.isFinite(tn.py) ? tn.py : tn.y * zoom.k + zoom.y;
      if (bx < Math.min(340, vw * 0.34) && by > vh * 0.28) continue;
      const chord = Math.hypot(bx - ax, by - ay);
      if (chord < 82 || chord > 260) continue;
      const distCenter = Math.hypot((ax + bx) * 0.5 - targetX, (ay + by) * 0.5 - targetY);
      const chordPenalty = Math.abs(chord - 148) * 0.55;
      const horizLabelPenalty = Math.abs(by - ay) < 34 ? 95 : 0;
      const score = distCenter + chordPenalty + horizLabelPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestPair = pair;
      }
    }
    if (bestPair) {
      previewFromCacheId = bestPair[0];
      return bestPair;
    }
    for (let i = 0; i < nodes.length; i++) {
      const pair = tryFrom(nodes[i].id);
      if (pair) {
        previewFromCacheId = pair[0];
        return pair;
      }
    }
    return null;
  }

  function stepPulseState(playId, pendId) {
    const reduced = isReducedMotionPreferred() && !pulsePanelOpen;
    let activeFromId = playId || null;
    let nextId = activeFromId ? resolveUpcomingTargetId(activeFromId, pendId) : null;
    let isPreview = false;

    if (!activeFromId && pulsePanelOpen) {
      const prevPair = resolvePreviewPulsePair();
      if (prevPair) {
        activeFromId = prevPair[0];
        nextId = prevPair[1];
        isPreview = true;
      }
    }

    const fromNode = activeFromId ? nodeById.get(activeFromId) : null;
    const toNode = nextId ? nodeById.get(nextId) : null;
    const liveValid = Boolean(
      fromNode &&
      toNode &&
      fromNode.id !== toNode.id &&
      isNodeRenderedOnMap(fromNode) &&
      isNodeRenderedOnMap(toNode)
    );

    const now = typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
    const rawDt = pulseLastNow > 0 ? (now - pulseLastNow) / 1000 : 0.016;
    pulseLastNow = now;
    const dt = Math.max(0, Math.min(0.064, rawDt));

    if (liveValid) {
      if (pulseState.fromId !== fromNode.id) {
        pulseWaveOriginFlowSec = pulseFlowSec;
      }
      pulseState.fromId = fromNode.id;
      pulseState.toId = toNode.id;
      pulseState.live = true;
      pulseState.preview = isPreview;
      if (reduced) {
        pulseAlpha = 1;
      } else {
        pulseAlpha = Math.min(1, Math.max(pulseAlpha + dt / 0.24, 0.06));
        pulseTimeSec += dt;
        pulseFlowSec += dt * pulseTuning.dotSpeed;
        pulseTargetSec += dt * pulseTuning.targetPulseSpeed;
        pulseSizeModPhase = (pulseSizeModPhase + dt * pulseTuning.dotSizePulseFreq * Math.PI * 2) % (Math.PI * 2000);
        pulseRevWavePhase = (pulseRevWavePhase + dt * pulseTuning.dotSizePulseFreq * REV_WAVE_FREQ_RATIO * Math.PI * 2) % (Math.PI * 2000);
        pulseDirOscPhase = (pulseDirOscPhase + dt * pulseTuning.dirOscFreq * Math.PI * 2) % (Math.PI * 2000);
      }
      return;
    }

    pulseState.live = false;
    pulseState.preview = false;
    const fadeFrom = pulseState.fromId ? nodeById.get(pulseState.fromId) : null;
    const fadeTo = pulseState.toId ? nodeById.get(pulseState.toId) : null;
    if (!fadeFrom || !fadeTo || !isNodeRenderedOnMap(fadeFrom) || !isNodeRenderedOnMap(fadeTo) || reduced) {
      pulseAlpha = 0;
    } else if (pulseAlpha > 0) {
      pulseAlpha = Math.max(0, pulseAlpha - dt / 0.28);
      pulseTimeSec += dt * 0.65;
      pulseFlowSec += dt * 0.65 * pulseTuning.dotSpeed;
      pulseTargetSec += dt * 0.65 * pulseTuning.targetPulseSpeed;
      pulseSizeModPhase = (pulseSizeModPhase + dt * 0.65 * pulseTuning.dotSizePulseFreq * Math.PI * 2) % (Math.PI * 2000);
      pulseRevWavePhase = (pulseRevWavePhase + dt * 0.65 * pulseTuning.dotSizePulseFreq * REV_WAVE_FREQ_RATIO * Math.PI * 2) % (Math.PI * 2000);
      pulseDirOscPhase = (pulseDirOscPhase + dt * 0.65 * pulseTuning.dirOscFreq * Math.PI * 2) % (Math.PI * 2000);
    }
    if (pulseAlpha <= 0.004) {
      pulseAlpha = 0;
      pulseLastNow = 0;
      lastPulseRenderTelemetry = {
        mode: pulseTuning.mode,
        kFwd: 0,
        kRev: 0,
        dirOsc: computeDirectionCrossfade(reduced),
        forwardDots: [],
        reverseDots: [],
      };
    }
  }

  function schedulePulseFrameIfNeeded() {
    const mapHidden = Boolean(
      !mapWrap ||
      mapWrap.hidden ||
      (typeof document !== "undefined" && document.hidden)
    );
    const reduced = isReducedMotionPreferred() && !pulsePanelOpen;
    const wantAnim = !mapHidden && !reduced && (pulseState.live || pulseAlpha > 0.004);
    if (!wantAnim) {
      if (pulseRaf && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(pulseRaf);
        pulseRaf = 0;
      }
      if (!pulseState.live && pulseAlpha <= 0.004) pulseLastNow = 0;
      return;
    }
    if (tweenRaf || pulseRaf || typeof requestAnimationFrame !== "function") return;
    pulseRaf = requestAnimationFrame(() => {
      pulseRaf = 0;
      paintCanvas();
    });
  }

  function computeDirectionCrossfade(reduced) {
    const oscAmt = pulseTuning.dirOscAmount;
    const pinch = Number.isFinite(pulseTuning.dirOscPinch)
      ? Math.max(0, Math.min(1, pulseTuning.dirOscPinch))
      : DEFAULT_PULSE_TUNING.dirOscPinch;
    const revMix = pulseTuning.reverseMix;
    const sizePulseAmt = pulseTuning.dotSizePulseAmt;
    const rawWave = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(pulseDirOscPhase);
    // Smooth C^1-continuous sine-to-notch wave-shaping:
    // pinch = 0 -> gamma = 1.0 (exact pure sine); pinch = 0.55 -> gamma ≈ 3.92 (musical reverse notch);
    // pinch = 1.0 -> gamma = 12.0 (tight brief reverse notch, still reaching full 1.0 peak cleanly at crest).
    const pinchGamma = Math.pow(12, pinch);
    const pinchedOsc = rawWave <= 0 ? 0 : rawWave >= 1 ? 1 : Math.pow(rawWave, pinchGamma);
    if (oscAmt <= 0.001) {
      return {
        osc: rawWave,
        pinch,
        pinchGamma,
        pinchedOsc,
        shapedOsc: pinchedOsc,
        effFwdAmt: sizePulseAmt,
        effRevMix: revMix,
        effSheenFwd: 1,
        effSheenRev: revMix,
      };
    }
    // Center bias around reverseMix while preserving full 0 -> 1 crossfade endpoints
    const biasGamma = Math.pow(2, (0.5 - revMix) * 0.75);
    const shapedOsc = pinchedOsc <= 0 ? 0 : pinchedOsc >= 1 ? 1 : Math.pow(pinchedOsc, biasGamma);
    // Equal-power quarter-circle envelope (cos^2 + sin^2 === 1 so total visual energy never drops dead mid-crossfade)
    const theta = shapedOsc * (Math.PI * 0.5);
    const tideFwd = Math.cos(theta);
    const tideRev = Math.sin(theta);

    const baseEnergy = Math.max(sizePulseAmt, revMix * 0.65, 0.35);
    const fwdPeak = Math.max(sizePulseAmt, baseEnergy * 0.78) * (1 + 0.16 * revMix);
    const revPeak = Math.min(1.22, Math.max(revMix * 1.24, baseEnergy * 1.48));

    const effFwdAmt = sizePulseAmt + oscAmt * (fwdPeak * tideFwd - sizePulseAmt);
    const effRevMix = revMix + oscAmt * (revPeak * tideRev - revMix);

    const sheenRevPeak = Math.max(revMix, 0.88);
    const effSheenFwd = 1 + oscAmt * (tideFwd - 1);
    const effSheenRev = revMix + oscAmt * (sheenRevPeak * tideRev - revMix);

    return {
      osc: rawWave,
      pinch,
      pinchGamma,
      pinchedOsc,
      shapedOsc,
      effFwdAmt,
      effRevMix,
      effSheenFwd,
      effSheenRev,
    };
  }

  function evalQuad(ax, ay, cx, cy, bx, by, u) {
    const inv = 1 - u;
    return [
      inv * inv * ax + 2 * inv * u * cx + u * u * bx,
      inv * inv * ay + 2 * inv * u * cy + u * u * by,
    ];
  }

  function buildPulseGeometry() {
    if (pulseAlpha <= 0.004 || !pulseState.fromId || !pulseState.toId) return null;
    const fromNode = nodeById.get(pulseState.fromId);
    const toNode = nodeById.get(pulseState.toId);
    if (!fromNode || !toNode || !isNodeRenderedOnMap(fromNode) || !isNodeRenderedOnMap(toNode)) return null;

    const ax = Number.isFinite(fromNode.px) ? fromNode.px : fromNode.x * zoom.k + zoom.x;
    const ay = Number.isFinite(fromNode.py) ? fromNode.py : fromNode.y * zoom.k + zoom.y;
    const bx = Number.isFinite(toNode.px) ? toNode.px : toNode.x * zoom.k + zoom.x;
    const by = Number.isFinite(toNode.py) ? toNode.py : toNode.y * zoom.k + zoom.y;

    const minX = Math.min(ax, bx) - 48;
    const maxX = Math.max(ax, bx) + 48;
    const minY = Math.min(ay, by) - 64;
    const maxY = Math.max(ay, by) + 64;
    if (maxX < 0 || minX > vw || maxY < 0 || minY > vh) return null;

    const dx = bx - ax;
    const dy = by - ay;
    const chord = Math.hypot(dx, dy);
    if (chord < 1.5) return null;

    const mx = (ax + bx) * 0.5;
    const my = (ay + by) * 0.5;
    let cx = mx;
    let cy = my;
    let isCurved = false;
    if (layout === "era") {
      isCurved = true;
      if (Math.abs(dx) < 14 && chord > 24) {
        cx = mx + Math.min(18, chord * 0.14);
      } else {
        const arcMag = Math.min(34, Math.abs(dx) * 0.25 + 14);
        cy = my + (Math.min(ay, by) < 68 ? arcMag * 0.75 : -arcMag);
      }
    }

    const SEG = 16;
    const cumLen = new Float64Array(SEG + 1);
    let px0 = ax;
    let py0 = ay;
    let totalLen = 0;
    for (let i = 1; i <= SEG; i++) {
      const [qx, qy] = evalQuad(ax, ay, cx, cy, bx, by, i / SEG);
      totalLen += Math.hypot(qx - px0, qy - py0);
      cumLen[i] = totalLen;
      px0 = qx;
      py0 = qy;
    }
    if (totalLen < 1.5) return null;

    function uAtArcLen(s) {
      if (s <= 0) return 0;
      if (s >= totalLen) return 1;
      let lo = 0;
      let hi = SEG;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (cumLen[mid] <= s) lo = mid;
        else hi = mid;
      }
      const segSpan = cumLen[hi] - cumLen[lo];
      const fracSeg = segSpan > 1e-4 ? (s - cumLen[lo]) / segSpan : 0;
      return (lo + fracSeg) / SEG;
    }

    const curR = nodeScreenRadius(fromNode.t) + 1.3;
    const nextR = nodeScreenRadius(toNode.t);
    const sStart = curR + 3.2;
    const sEnd = totalLen - (nextR + 3.6);
    const usableLen = Math.max(0, sEnd - sStart);
    const baseDotStep = Math.max(8.8, Math.min(12.4, 9.6 * Math.pow(Math.max(1, zoom.k), 0.14)));
    const dotStep = Math.max(5.2, Math.min(24.0, baseDotStep * pulseTuning.dotSpacing));
    const approxDots = Math.max(4, usableLen / dotStep);
    const effSpan = Math.max(usableLen, totalLen * 0.85);
    // Primary forward size pulses (0 -> 1): broad swells propagating with dot flow
    const kFwd = Math.max(1.25, Math.min(2.6, effSpan / 88));
    // Smaller opposite-direction size waves (1 -> 0): higher spatial wavenumber (kRev > kFwd),
    // Nyquist-guarded (>= 4.4 dots/wave) so discrete beads hand off crests smoothly at any spacing.
    const nyquistMaxK = Math.max(2.15, approxDots / 4.4);
    const targetKRev = Math.max(kFwd * 2.05, Math.min(4.3, effSpan / 43));
    const kRev = Math.max(kFwd * 1.55, Math.min(targetKRev, nyquistMaxK));

    const sheenWaves = totalLen >= 260 ? 2 : 1;
    const sheenPeriodSec = Math.max(0.54, Math.min(1.05, totalLen / 165));
    const kRevSheen = sheenWaves >= 2 ? 4.2 : 3.2;
    const elapsedFlow = Math.max(0, pulseFlowSec - pulseWaveOriginFlowSec);
    const reduced = isReducedMotionPreferred() && !pulsePanelOpen;
    const stationaryDots = pulseTuning.dotSpeed <= 0.001;

    function fwdSizeWaveAt(u) {
      if (reduced) return 0.35;
      const s = 0.5 + 0.5 * Math.sin(Math.PI * 2 * kFwd * u - pulseSizeModPhase);
      return s * s;
    }

    function revSizeWaveAt(u) {
      if (reduced) return 0.35;
      const s = 0.5 + 0.5 * Math.sin(Math.PI * 2 * kRev * u + pulseRevWavePhase);
      return Math.pow(s, 2.75);
    }

    function sheenWaveAt(u) {
      if (reduced || stationaryDots) {
        const dStatic = u - 0.62;
        return 0.36 + 0.56 * Math.exp(-(dStatic * dStatic) / (2 * 0.24 * 0.24));
      }
      let sum = 0;
      for (let w = 0; w < sheenWaves; w++) {
        const front = fract(elapsedFlow / sheenPeriodSec + w / sheenWaves);
        for (let k = -1; k <= 1; k++) {
          const du = u - front + k;
          const sigma = du > 0 ? 0.072 : 0.225;
          sum += Math.exp(-(du * du) / (2 * sigma * sigma));
        }
      }
      return Math.min(1, sum);
    }

    const revSheenPhase = stationaryDots
      ? pulseRevWavePhase
      : (elapsedFlow / (sheenPeriodSec * 0.72)) * Math.PI * 2 + pulseRevWavePhase * 0.35;
    function revSheenWaveAt(u) {
      if (reduced) return 0.32;
      const s = 0.5 + 0.5 * Math.sin(Math.PI * 2 * kRevSheen * u + revSheenPhase);
      return Math.pow(s, 2.85);
    }

    const xfade = computeDirectionCrossfade(reduced);
    const activeWaveArrival = pulseTuning.mode === "line_sheen"
      ? (stationaryDots ? 0.25 : sheenWaveAt(0.96) * xfade.effSheenFwd)
      : xfade.effFwdAmt * fwdSizeWaveAt(0.96);
    const arrivalBoost = reduced ? 0.25 : activeWaveArrival;
    const activeRevArrival = pulseTuning.mode === "line_sheen"
      ? revSheenWaveAt(0.04)
      : revSizeWaveAt(0.04);
    const revArrivalBoost =
      (reduced ? 0.25 : activeRevArrival) *
      (pulseTuning.mode === "line_sheen" ? xfade.effSheenRev : xfade.effRevMix);
    const tRate = pulseTuning.targetPulseSpeed;
    const targetBreath = reduced || tRate <= 0.001
      ? 0.35
      : 0.5 - 0.5 * Math.cos(pulseTargetSec * Math.PI * 2 * 0.85);
    const targetCombinedPulse = tRate <= 0.001
      ? 0.35
      : Math.min(1.25, 0.76 * targetBreath + 0.34 * arrivalBoost);

    return {
      fromNode,
      toNode,
      ax,
      ay,
      bx,
      by,
      cx,
      cy,
      isCurved,
      totalLen,
      curR,
      nextR,
      sStart,
      sEnd,
      usableLen,
      dotStep,
      kFwd,
      kRev,
      xfade,
      arrivalBoost,
      revArrivalBoost,
      targetBreath,
      targetCombinedPulse,
      uAtArcLen,
      fwdSizeWaveAt,
      revSizeWaveAt,
      sheenWaveAt,
      revSheenWaveAt,
    };
  }

  function tracePulseSpanPath(geom, u0, u1) {
    const { ax, ay, bx, by, cx, cy, isCurved } = geom;
    ctx.beginPath();
    if (!isCurved) {
      if (u0 <= 0.001 && u1 >= 0.999) {
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      } else {
        const [p0x, p0y] = evalQuad(ax, ay, cx, cy, bx, by, u0);
        const [p1x, p1y] = evalQuad(ax, ay, cx, cy, bx, by, u1);
        ctx.moveTo(p0x, p0y);
        ctx.lineTo(p1x, p1y);
      }
      return;
    }
    if (u0 <= 0.001 && u1 >= 0.999) {
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cx, cy, bx, by);
      return;
    }
    const STEPS = 20;
    for (let i = 0; i <= STEPS; i++) {
      const u = u0 + (u1 - u0) * (i / STEPS);
      const [px, py] = evalQuad(ax, ay, cx, cy, bx, by, u);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }

  function drawNextPulseUnderlay(geom, isLight) {
    if (!geom || !ctx) return;
    const glow = pulseTuning.pulseGlow;
    const lineStrength = pulseTuning.lineStrength;
    const isSheenMode = pulseTuning.mode === "line_sheen";
    if (glow <= 0.005 && lineStrength <= 0.005) return;

    const {
      fromNode,
      toNode,
      ax,
      ay,
      bx,
      by,
      totalLen,
      curR,
      nextR,
      xfade,
      revArrivalBoost,
      targetCombinedPulse,
      uAtArcLen,
      sheenWaveAt,
      revSheenWaveAt,
    } = geom;
    const master = pulseAlpha;
    const phaseShift = -pulseFlowSec * (isSheenMode ? 0.34 : 0.18);
    const glowRadiusScale = 0.68 + 0.32 * glow;
    const glowAlphaScale = Math.min(2.35, glow);
    const fwdSheenWeight = xfade ? xfade.effSheenFwd : 1;
    const revSheenWeight = xfade ? xfade.effSheenRev : pulseTuning.reverseMix;

    ctx.save();
    ctx.setLineDash([]);

    if (glow > 0.005) {
      // 1. Subtle Gemini emitter aura underneath the currently playing (or preview source) node
      if (ax >= -48 && ax <= vw + 48 && ay >= -48 && ay <= vh + 48) {
        const emitR = curR + (10.5 + 3.0 * revArrivalBoost) * glowRadiusScale;
        const emitInner = sampleGeminiCyclic(0.05 + phaseShift, isLight);
        const emitOuter = sampleGeminiCyclic(0.28 + phaseShift, isLight);
        const emitGrad = ctx.createRadialGradient(ax, ay, curR * 0.4, ax, ay, emitR);
        emitGrad.addColorStop(
          0,
          rgbaStr(emitInner, Math.min(0.88, ((isLight ? 0.20 : 0.28) + 0.11 * revArrivalBoost) * glowAlphaScale) * master)
        );
        emitGrad.addColorStop(
          0.58,
          rgbaStr(emitOuter, Math.min(0.58, ((isLight ? 0.10 : 0.14) + 0.07 * revArrivalBoost) * glowAlphaScale) * master)
        );
        emitGrad.addColorStop(1, rgbaStr(emitOuter, 0));
        ctx.beginPath();
        ctx.arc(ax, ay, emitR, 0, Math.PI * 2);
        ctx.fillStyle = emitGrad;
        ctx.globalAlpha = 1;
        ctx.fill();
      }

      // 2. Soft breathing Gemini destination aura underneath the upcoming Next node
      if (bx >= -56 && bx <= vw + 56 && by >= -56 && by <= vh + 56) {
        const destAuraR = nextR + (10.8 + 5.4 * targetCombinedPulse) * glowRadiusScale;
        const destInner = sampleGeminiCyclic(0.62 + phaseShift, isLight);
        const destOuter = sampleGeminiCyclic(0.86 + phaseShift, isLight);
        const destGrad = ctx.createRadialGradient(bx, by, nextR * 0.4, bx, by, destAuraR);
        destGrad.addColorStop(
          0,
          rgbaStr(destInner, Math.min(0.9, ((isLight ? 0.20 : 0.26) + 0.16 * targetCombinedPulse) * glowAlphaScale) * master)
        );
        destGrad.addColorStop(
          0.55,
          rgbaStr(destOuter, Math.min(0.62, ((isLight ? 0.10 : 0.14) + 0.11 * targetCombinedPulse) * glowAlphaScale) * master)
        );
        destGrad.addColorStop(1, rgbaStr(destOuter, 0));
        ctx.beginPath();
        ctx.arc(bx, by, destAuraR, 0, Math.PI * 2);
        ctx.fillStyle = destGrad;
        ctx.globalAlpha = 1;
        ctx.fill();
      }

      // 3. Soft Gemini aurora path mist (travels with directional/bidirectional sheen in Flowing line mode)
      const sMistStart = Math.min(totalLen * 0.45, curR + 3.2);
      const sMistEnd = Math.max(totalLen * 0.55, totalLen - (nextR + 3.4));
      if (sMistEnd > sMistStart + 2) {
        const u0 = uAtArcLen(sMistStart);
        const u1 = uAtArcLen(sMistEnd);
        const [gx0, gy0] = evalQuad(ax, ay, geom.cx, geom.cy, bx, by, u0);
        const [gx1, gy1] = evalQuad(ax, ay, geom.cx, geom.cy, bx, by, u1);
        const mistGrad = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
        if (isSheenMode) {
          const STOPS = 28;
          const peakMistAlpha = Math.min(0.50, (isLight ? 0.14 : 0.22) * glowAlphaScale) * master;
          for (let i = 0; i <= STOPS; i++) {
            const tStop = i / STOPS;
            const u = u0 + (u1 - u0) * tStop;
            const wFwd = sheenWaveAt(u) * fwdSheenWeight;
            const wRev = revSheenWeight > 0.004 ? revSheenWaveAt(u) * revSheenWeight : 0;
            const w = wRev > 0
              ? Math.min(1, wFwd * (1 - 0.14 * revSheenWeight) + 0.68 * wRev)
              : wFwd;
            const rgbFwd = sampleGeminiCyclic(u * 0.82 + phaseShift, isLight);
            const rgb = wRev > 0
              ? mixRgb(
                  rgbFwd,
                  sampleGeminiCyclic((1 - u) * 0.82 + 0.5 - phaseShift * 0.88, isLight),
                  (wRev * 0.72) / (wFwd + wRev * 0.72 + 1e-4)
                )
              : rgbFwd;
            mistGrad.addColorStop(tStop, rgbaStr(rgb, peakMistAlpha * (0.14 + 0.86 * w * w)));
          }
          tracePulseSpanPath(geom, u0, u1);
          ctx.lineCap = "round";
          ctx.strokeStyle = mistGrad;
          ctx.lineWidth = 3.4 + 2.5 * glow;
          ctx.globalAlpha = 1;
          ctx.stroke();
        } else {
          mistGrad.addColorStop(0, rgbaStr(sampleGeminiCyclic(0.0 + phaseShift, isLight), 1));
          mistGrad.addColorStop(0.34, rgbaStr(sampleGeminiCyclic(0.28 + phaseShift, isLight), 1));
          mistGrad.addColorStop(0.68, rgbaStr(sampleGeminiCyclic(0.56 + phaseShift, isLight), 1));
          mistGrad.addColorStop(1, rgbaStr(sampleGeminiCyclic(0.84 + phaseShift, isLight), 1));
          tracePulseSpanPath(geom, u0, u1);
          ctx.lineCap = "round";
          ctx.strokeStyle = mistGrad;
          ctx.lineWidth = 4.0 + 2.0 * glow;
          ctx.globalAlpha = Math.min(0.34, (isLight ? 0.055 : 0.085) * glowAlphaScale) * master;
          ctx.stroke();
        }
      }
    }

    // 4. Crisp continuous normal-weight constellation carrier wire (matches neighbor graph lines)
    if (lineStrength > 0.005) {
      const bothMatched = isMatch(fromNode.t) && isMatch(toNode.t);
      const uWire0 = bothMatched ? 0 : uAtArcLen(Math.min(totalLen * 0.46, curR + 0.8));
      const uWire1 = bothMatched ? 1 : uAtArcLen(Math.max(totalLen * 0.54, totalLen - (nextR + 0.8)));
      if (uWire1 > uWire0 + 0.01) {
        const edgeCss = isLight ? (palette.edgeLine || palette.outline) : (palette.edgeLineDark || palette.edgeLine);
        const baseEdgeRgb = parseCssRgb(edgeCss, isLight ? [116, 119, 117] : [194, 197, 208]);
        const tintMix = isSheenMode
          ? Math.min(0.58, 0.22 + 0.14 * lineStrength)
          : Math.min(0.74, 0.36 + 0.18 * lineStrength);
        const wireGrad = ctx.createLinearGradient(ax, ay, bx, by);
        const WIRE_STOPS = 4;
        for (let i = 0; i <= WIRE_STOPS; i++) {
          const tStop = i / WIRE_STOPS;
          const gemRgb = sampleGeminiCyclic(tStop * 0.85 + phaseShift, isLight);
          const blended = mixRgb(baseEdgeRgb, gemRgb, tintMix);
          wireGrad.addColorStop(tStop, rgbaStr(blended, 1));
        }
        tracePulseSpanPath(geom, uWire0, uWire1);
        ctx.lineCap = "round";
        ctx.strokeStyle = wireGrad;
        ctx.lineWidth = (isSheenMode ? 0.98 : 1.02) + 0.20 * Math.min(2.0, lineStrength);
        const baseWireAlpha = isSheenMode
          ? (isLight ? 0.40 : 0.46)
          : (isLight ? 0.52 : 0.58);
        ctx.globalAlpha = Math.min(0.95, baseWireAlpha * lineStrength) * master;
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  function drawNextPulseOverlay(geom, isLight) {
    if (!geom || !ctx) return;
    const {
      ax,
      ay,
      bx,
      by,
      cx,
      cy,
      totalLen,
      curR,
      nextR,
      sStart,
      sEnd,
      usableLen,
      dotStep,
      kFwd,
      kRev,
      xfade,
      targetCombinedPulse,
      uAtArcLen,
      fwdSizeWaveAt,
      revSizeWaveAt,
      sheenWaveAt,
      revSheenWaveAt,
    } = geom;
    const master = pulseAlpha;
    const isSheenMode = pulseTuning.mode === "line_sheen";
    const phaseShift = -pulseFlowSec * (isSheenMode ? 0.34 : 0.18);
    const glow = pulseTuning.pulseGlow;
    const lineStrength = pulseTuning.lineStrength;
    const tRate = pulseTuning.targetPulseSpeed;
    const dirOsc = xfade || computeDirectionCrossfade(isReducedMotionPreferred() && !pulsePanelOpen);
    const effFwdAmt = dirOsc.effFwdAmt;
    const effRevMix = dirOsc.effRevMix;
    const stationaryDots = pulseTuning.dotSpeed <= 0.001;
    const reduced = isReducedMotionPreferred() && !pulsePanelOpen;

    ctx.save();
    ctx.setLineDash([]);

    // 1. Shimmering Gemini gradient halo ring + breathing pulse ripple around the upcoming Next node
    if (bx >= -42 && bx <= vw + 42 && by >= -42 && by <= vh + 42) {
      const haloR = nextR + 3.9 + 2.15 * targetCombinedPulse;
      const rot = reduced || tRate <= 0.001 ? 0.45 : pulseTargetSec * 1.45;
      const gx = Math.cos(rot) * haloR;
      const gy = Math.sin(rot) * haloR;
      const ringGrad = ctx.createLinearGradient(bx - gx, by - gy, bx + gx, by + gy);
      ringGrad.addColorStop(0, rgbaStr(sampleGeminiCyclic(0.0, isLight), 1));
      ringGrad.addColorStop(0.35, rgbaStr(sampleGeminiCyclic(0.30, isLight), 1));
      ringGrad.addColorStop(0.70, rgbaStr(sampleGeminiCyclic(0.60, isLight), 1));
      ringGrad.addColorStop(1, rgbaStr(sampleGeminiCyclic(0.90, isLight), 1));

      if (!reduced && tRate > 0.001) {
        const ripplePhase = fract(pulseTargetSec * 0.85);
        const rippleR = nextR + 4.2 + ripplePhase * (7.2 + 2.4 * Math.min(1.8, glow));
        const rippleAlpha =
          Math.pow(1 - ripplePhase, 1.65) *
          (isLight ? 0.42 : 0.52) *
          (0.52 + 0.48 * Math.min(1.6, glow)) *
          master;
        if (rippleAlpha > 0.015) {
          ctx.beginPath();
          ctx.arc(bx, by, rippleR, 0, Math.PI * 2);
          ctx.strokeStyle = ringGrad;
          ctx.lineWidth = Math.max(0.75, 1.35 * (1 - 0.42 * ripplePhase));
          ctx.globalAlpha = rippleAlpha;
          ctx.stroke();
        }
      }

      ctx.beginPath();
      ctx.arc(bx, by, haloR, 0, Math.PI * 2);
      ctx.strokeStyle = ringGrad;
      ctx.lineWidth = 1.75 + 0.62 * targetCombinedPulse;
      ctx.globalAlpha = Math.min(1, (isLight ? 0.80 : 0.86) + 0.14 * targetCombinedPulse) * master;
      ctx.stroke();
    }

    if (isSheenMode) {
      // 2a. Flowing line mode ("line_sheen"): zero discrete dots — pure continuous normal-weight
      // constellation line with broad forward sheen + smaller opposite-direction sheen/thickness ripples.
      const sSheenStart = Math.min(totalLen * 0.46, curR + 1.0);
      const sSheenEnd = Math.max(totalLen * 0.54, totalLen - (nextR + 1.0));
      const fwdWeight = dirOsc.effSheenFwd;
      const revWeight = dirOsc.effSheenRev;
      if (sSheenEnd > sSheenStart + 1.5) {
        const u0 = uAtArcLen(sSheenStart);
        const u1 = uAtArcLen(sSheenEnd);
        const [p0x, p0y] = evalQuad(ax, ay, cx, cy, bx, by, u0);
        const [p1x, p1y] = evalQuad(ax, ay, cx, cy, bx, by, u1);
        const sheenGrad = ctx.createLinearGradient(p0x, p0y, p1x, p1y);
        const crestGrad = ctx.createLinearGradient(p0x, p0y, p1x, p1y);
        const STOPS = 28;
        const strengthGain = Math.min(1.35, 0.45 + 0.55 * lineStrength);
        const floorAlpha = 0.16 * Math.min(1.5, lineStrength);
        for (let i = 0; i <= STOPS; i++) {
          const tStop = i / STOPS;
          const u = u0 + (u1 - u0) * tStop;
          const wFwdRaw = sheenWaveAt(u);
          const wFwd = wFwdRaw * fwdWeight;
          const wRevRaw = revSheenWaveAt(u);
          const wRev = revWeight > 0.004 ? wRevRaw * revWeight : 0;
          const w = wRev > 0
            ? Math.min(1.12, wFwd * (1 - 0.14 * Math.min(1, revWeight)) + 0.68 * wRev)
            : wFwd;
          let rgb = sampleGeminiCyclic(u * 0.82 + phaseShift, isLight);
          if (wRev > 0) {
            let rgbRev = sampleGeminiCyclic((1 - u) * 0.82 + 0.5 - phaseShift * 0.88, isLight);
            if (pulseTuning.colorCount <= 1.05) {
              rgbRev = mixRgb(rgbRev, isLight ? [59, 130, 246] : [196, 181, 253], 0.28);
            }
            rgb = mixRgb(rgb, rgbRev, (wRev * 0.72) / (wFwd + wRev * 0.72 + 1e-4));
          }
          if (!isLight && glow > 0.05 && w > 0.68) {
            const crestHighlight = ((w - 0.68) / 0.32) * Math.min(0.42, 0.24 * glow);
            rgb = mixRgb(rgb, [246, 248, 255], crestHighlight);
          }
          const stopAlpha = Math.min(1, floorAlpha + (isLight ? 0.84 : 0.88) * strengthGain * Math.pow(Math.min(1, w), 0.9)) * master;
          sheenGrad.addColorStop(tStop, rgbaStr(rgb, stopAlpha));
          const swellEnv = Math.min(1, 0.52 * fwdWeight * Math.pow(wFwdRaw, 2.2) + 0.48 * revWeight * Math.pow(wRevRaw, 2.4));
          crestGrad.addColorStop(tStop, rgbaStr(rgb, Math.min(0.78, (isLight ? 0.38 : 0.48) * strengthGain * swellEnv) * master));
        }
        tracePulseSpanPath(geom, u0, u1);
        ctx.lineCap = "round";
        ctx.strokeStyle = crestGrad;
        ctx.lineWidth = 2.05 + 0.85 * Math.min(2.0, lineStrength);
        ctx.globalAlpha = 1;
        ctx.stroke();

        tracePulseSpanPath(geom, u0, u1);
        ctx.lineCap = "round";
        ctx.strokeStyle = sheenGrad;
        ctx.lineWidth = 1.08 + 0.24 * Math.min(2.0, lineStrength);
        ctx.globalAlpha = 1;
        ctx.stroke();
      }
      lastPulseRenderTelemetry = { mode: "line_sheen", kFwd, kRev, dirOsc, forwardDots: [], reverseDots: [] };
      ctx.restore();
      return;
    }

    // 2b. Line + dots mode ("line_dots"): SINGLE continuous stream of forward-moving dots
    // (playingNode -> nextNode, 100% du/dt >= 0) carrying superposed forward size pulses (0 -> 1)
    // plus smaller higher-wavenumber size waves rippling in the opposite direction (1 -> 0),
    // smoothly crossfaded by the Direction Crossfade Oscillator (dirOscAmount, dirOscFreq).
    const marchBaseSpeed = 44;
    const baseUnitR = 1.64 * pulseTuning.dotSize;
    const forwardDots = [];

    function evaluateDotWaveSuperposition(u, endEnv) {
      const endScale = 0.56 + 0.44 * endEnv;
      const baseR = baseUnitR * endScale;
      if (reduced) {
        return { dotR: baseR, baseR, wFwd: 0.35, wRev: 0.35, effWave: 0.35, revGlow: 0 };
      }
      const wFwd = fwdSizeWaveAt(u);
      const wRev = revSizeWaveAt(u);
      const fwdDelta = effFwdAmt * (1.36 * wFwd - 0.20);
      const revDelta = effRevMix * (0.74 * wRev - 0.08);
      const sizeMult = Math.max(0.42, 1 + fwdDelta + revDelta);
      const dotR = Math.max(0.45, baseR * sizeMult);

      const fwdGlow = effFwdAmt * wFwd;
      const revGlow = effRevMix * wRev;
      const steadyBase = 0.34 * Math.max(0, 1 - 0.62 * Math.max(effFwdAmt, effRevMix));
      const effWave = Math.min(1.18, steadyBase + 0.92 * fwdGlow + 0.66 * revGlow);
      return { dotR, baseR, wFwd, wRev, effWave, revGlow };
    }

    function paintBead(px, py, dotR, rgb, effWave, endEnv) {
      if (glow > 0.005 && (effWave > 0.10 || glow > 0.55)) {
        const glowR = dotR * (isLight ? 2.6 : 3.2) * (0.56 + 0.46 * glow);
        const glowDrive = 0.24 * Math.max(0, glow - 0.35) + 0.82 * effWave * glow;
        const peakGlow = Math.min(0.94, (isLight ? 0.28 : 0.42) * glowDrive) * endEnv * master;
        if (peakGlow > 0.01) {
          const bloom = ctx.createRadialGradient(px, py, dotR * 0.24, px, py, glowR);
          bloom.addColorStop(0, rgbaStr(rgb, peakGlow));
          bloom.addColorStop(0.48, rgbaStr(rgb, peakGlow * 0.36));
          bloom.addColorStop(1, rgbaStr(rgb, 0));
          ctx.beginPath();
          ctx.arc(px, py, glowR, 0, Math.PI * 2);
          ctx.fillStyle = bloom;
          ctx.globalAlpha = 1;
          ctx.fill();
        }
      }

      ctx.beginPath();
      ctx.arc(px, py, dotR, 0, Math.PI * 2);
      ctx.fillStyle = rgbaStr(rgb, 1);
      ctx.globalAlpha = Math.min(1, ((isLight ? 0.56 : 0.52) + (isLight ? 0.42 : 0.46) * effWave)) * endEnv * master;
      ctx.fill();

      if (!isLight && glow > 0.05 && effWave > 0.62) {
        const coreStrength = Math.min(1, ((effWave - 0.62) / 0.38) * Math.min(1, glow));
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.65, dotR * 0.44), 0, Math.PI * 2);
        ctx.fillStyle = "rgb(255, 255, 255)";
        ctx.globalAlpha = 0.88 * coreStrength * endEnv * master;
        ctx.fill();
      }
    }

    if (usableLen >= 6.5) {
      const fwdDist = pulseFlowSec * marchBaseSpeed;
      const phaseOffset =
        reduced || stationaryDots
          ? dotStep * 0.5
          : fract(fwdDist / dotStep) * dotStep;
      const fadeSpan = Math.min(10, usableLen * 0.22);

      // Single continuous forward stream (playingNode -> nextNode, u: 0 -> 1)
      for (let s = sStart + phaseOffset; s <= sEnd; s += dotStep) {
        const u = uAtArcLen(s);
        const [px, py] = evalQuad(ax, ay, cx, cy, bx, by, u);
        if (px < -28 || px > vw + 28 || py < -28 || py > vh + 28) continue;

        const inFade = fadeSpan > 0.5 ? smoothstep(0, fadeSpan, s - sStart) : 1;
        const outFade = fadeSpan > 0.5 ? smoothstep(0, fadeSpan, sEnd - s) : 1;
        const endEnv = inFade * outFade;
        if (endEnv <= 0.02) continue;

        const beadId = reduced || stationaryDots
          ? Math.round((s - sStart) / dotStep)
          : Math.round(((s - sStart) - fwdDist) / dotStep);
        const { dotR, baseR, wFwd, wRev, effWave, revGlow } = evaluateDotWaveSuperposition(u, endEnv);
        let rgb = sampleGeminiCyclic(u * 0.88 + phaseShift, isLight);
        if (revGlow > 0.02) {
          let revAccent = sampleGeminiCyclic((1 - u) * 0.82 + 0.46 - phaseShift * 0.65, isLight);
          if (pulseTuning.colorCount <= 1.05) {
            revAccent = mixRgb(revAccent, isLight ? [59, 130, 246] : [196, 181, 253], 0.26);
          }
          rgb = mixRgb(rgb, revAccent, Math.min(0.36, 0.30 * revGlow));
        }
        paintBead(px, py, dotR, rgb, effWave, endEnv);
        forwardDots.push({
          id: beadId,
          u: Math.round(u * 10000) / 10000,
          s: Math.round(s * 1000) / 1000,
          x: px,
          y: py,
          r: dotR,
          baseR,
          endEnv: Math.round(endEnv * 10000) / 10000,
          fwdWave: Math.round(wFwd * 10000) / 10000,
          revWave: Math.round(wRev * 10000) / 10000,
        });
      }
    } else if (totalLen > curR + nextR + 1.5) {
      // Ultra-close neighbor bridge: single-stream micro-dots with superposed forward & reverse size waves
      const uMidA = Math.min(0.46, (curR + 1.6) / totalLen);
      const uMidB = Math.max(0.54, 1 - (nextR + 1.8) / totalLen);
      const microUs = [uMidA, uMidB];
      for (let m = 0; m < microUs.length; m++) {
        const u = microUs[m];
        const [px, py] = evalQuad(ax, ay, cx, cy, bx, by, u);
        const { dotR, baseR, wFwd, wRev, effWave } = evaluateDotWaveSuperposition(u, 1);
        const rgb = sampleGeminiCyclic(u * 0.8 + phaseShift, isLight);
        const microR = dotR * 0.72;
        ctx.beginPath();
        ctx.arc(px, py, microR, 0, Math.PI * 2);
        ctx.fillStyle = rgbaStr(rgb, 1);
        ctx.globalAlpha = Math.min(1, 0.48 + 0.45 * effWave) * master;
        ctx.fill();
        forwardDots.push({
          id: m,
          u: Math.round(u * 10000) / 10000,
          s: Math.round(u * totalLen * 1000) / 1000,
          x: px,
          y: py,
          r: microR,
          baseR: baseR * 0.72,
          endEnv: 1,
          fwdWave: Math.round(wFwd * 10000) / 10000,
          revWave: Math.round(wRev * 10000) / 10000,
        });
      }
    }

    lastPulseRenderTelemetry = {
      mode: "line_dots",
      kFwd,
      kRev,
      dirOsc,
      forwardDots,
      reverseDots: [],
    };
    ctx.restore();
  }

  function paintCanvas() {
    if (!ctx || !canvas) return;
    const playId = hooks ? hooks.playing() : null;
    const pendId = hooks ? hooks.pending() : null;
    const selTrack = selectedId ? byId.get(selectedId) : null;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);

    if (layout === "era" && window.BTMM_TIMELINE_ERA && eraLayout) {
      let visiblePlayerTopY = vh;
      let visiblePlayerLeftX = vw;
      if (typeof document !== "undefined" && mapWrap) {
        const card = document.getElementById("track-player-card");
        if (card && !card.hidden) {
          const mRect = mapWrap.getBoundingClientRect();
          const cRect = card.getBoundingClientRect();
          if (cRect.height > 20) {
            visiblePlayerTopY = Math.max(80, cRect.top - mRect.top);
            visiblePlayerLeftX = Math.max(120, cRect.left - mRect.left);
          }
        }
      }
      const [panSlackX, panSlackY] = getPanSlack();
      window.BTMM_TIMELINE_ERA.drawCanvasBackground(ctx, eraLayout, zoom, {
        bandAlt: palette.bandAlt,
        bandActive: palette.bandActive,
        gridLine: palette.gridLine,
        primary: palette.primary,
        spineGlow: palette.spineGlow,
        viewportW: vw,
        viewportH: vh,
        panSlackX,
        panSlackY,
        visiblePlayerTopY,
        visiblePlayerLeftX,
      }, activeEraId, selTrack);
    }

    computeScreenPositions();
    stepPulseState(playId, pendId);
    const pulseGeom = buildPulseGeometry();

    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    const zoomScale = Math.max(1, zoom.k);
    const spreadScale = layout === "vibe" && vibeLayout ? vibeLayout.spreadScale : 1;
    const maxLocalDist = Math.min(vw, vh) * 0.22 * spreadScale * zoomScale + 18;
    const maxBridgeDist = Math.min(vw, vh) * 0.36 * spreadScale * zoomScale + 24;

    // Draw edges & shrunk jewel circles directly in 1:1 screen space so zooming never inflates circle size
    edges.forEach((e) => {
      const a = nodeById.get(e.a);
      const b = nodeById.get(e.b);
      if (!a || !b) return;
      if (isSketchHidden(a.t) || isSketchHidden(b.t)) return;
      const isPulseEdge = Boolean(
        pulseGeom &&
        pulseAlpha > 0.01 &&
        ((e.a === pulseState.fromId && e.b === pulseState.toId) ||
         (e.a === pulseState.toId && e.b === pulseState.fromId))
      );
      if (isPulseEdge && pulseAlpha >= 0.96) return;
      const edgeFade = isPulseEdge ? (1 - pulseAlpha) : 1;
      const selLit = Boolean(selectedId && (e.a === selectedId || e.b === selectedId));
      const hovLit = Boolean(!selLit && hoverId && (e.a === hoverId || e.b === hoverId));
      const lit = selLit || hovLit;
      const aMatch = isMatch(a.t);
      const bMatch = isMatch(b.t);
      if (starFilter && (!aMatch || !bMatch) && !lit) return;

      let edgeAlpha = isLight ? 0.30 : 0.34;
      let edgeWidth = 1.05;
      if (!lit && layout === "vibe") {
        const d = Math.hypot(b.px - a.px, b.py - a.py);
        if (!aMatch && !bMatch) {
          if (d >= (e.weak ? maxBridgeDist : maxLocalDist)) return;
          edgeAlpha = isLight ? 0.065 : 0.075;
          edgeWidth = e.weak ? 0.85 : 0.95;
        } else if (aMatch !== bMatch) {
          if (d >= maxBridgeDist) return;
          edgeAlpha = isLight ? 0.21 : 0.26;
          edgeWidth = 0.95;
        } else if (e.weak) {
          if (d >= maxBridgeDist) return;
          const tBridge = Math.max(0.48, 1 - (d / maxBridgeDist) * 0.56);
          const simBoost = 0.86 + 0.24 * Math.min(1, Math.max(0, ((e.w || 0.68) - 0.64) / 0.22));
          edgeAlpha = (isLight ? 0.32 : 0.36) * tBridge * simBoost;
          edgeWidth = 0.95;
        } else {
          if (d >= maxLocalDist) return;
          const tLocal = Math.max(0.48, 1 - (d / maxLocalDist) * 0.60);
          edgeAlpha = (isLight ? 0.48 : 0.54) * tLocal;
          edgeWidth = 1.15;
        }
        if (edgeAlpha < 0.02) return;
      } else if (!lit && !aMatch && !bMatch) {
        edgeAlpha = 0.07;
      }

      ctx.beginPath();
      if (layout === "era") {
        const mx = (a.px + b.px) * 0.5;
        const arcOff = -Math.min(34, Math.abs(b.px - a.px) * 0.25 + 14);
        ctx.moveTo(a.px, a.py);
        ctx.quadraticCurveTo(mx, (a.py + b.py) * 0.5 + arcOff, b.px, b.py);
      } else {
        ctx.moveTo(a.px, a.py);
        ctx.lineTo(b.px, b.py);
      }

      if (lit) {
        ctx.strokeStyle = palette.primary;
        ctx.globalAlpha = (selLit ? 0.90 : 0.78) * edgeFade;
        ctx.lineWidth = e.weak ? 1.55 : 1.9;
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = isLight ? (palette.edgeLine || palette.outline) : (palette.edgeLineDark || palette.edgeLine);
        ctx.globalAlpha = edgeAlpha * edgeFade;
        ctx.lineWidth = edgeWidth;
        ctx.setLineDash([]);
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);

    const drawPass = (wantMatch) => {
      nodes.forEach((n) => {
        if (isSketchHidden(n.t)) return;
        const match = isMatch(n.t);
        if (match !== wantMatch) return;
        if (starFilter && !match) return;
        if (n.px < -20 || n.px > vw + 20 || n.py < -20 || n.py > vh + 20) return;
        const isPlay = n.id === playId;
        const isSel = n.id === selectedId;
        const isHov = n.id === hoverId;
        let drawR = nodeScreenRadius(n.t);
        if (isPlay) drawR += 1.3;
        else if (isSel || isHov) drawR += 0.9;

        ctx.beginPath();
        ctx.arc(n.px, n.py, drawR, 0, Math.PI * 2);
        ctx.fillStyle = trackColor(n.t);
        ctx.globalAlpha = match ? 0.95 : 0.12;
        ctx.fill();

        if (isSel || isPlay || isHov) {
          ctx.lineWidth = 1.7;
          ctx.strokeStyle = palette.surfaceLowest;
          ctx.globalAlpha = 1;
          ctx.stroke();
        } else if (match) {
          ctx.lineWidth = 1.25;
          ctx.strokeStyle = palette.surfaceLowest;
          ctx.globalAlpha = 0.88;
          ctx.stroke();
        }
      });
    };
    drawPass(false);
    if (pulseGeom) drawNextPulseUnderlay(pulseGeom, isLight);
    drawPass(true);
    if (pulseGeom) drawNextPulseOverlay(pulseGeom, isLight);

    if (window.BTMM_MAP_LABELS) {
      window.BTMM_MAP_LABELS.drawScreenTrackLabels(ctx, {
        nodes,
        nodeById,
        styleGroups,
        zoom,
        vw,
        vh,
        palette,
        isMatch,
        isHidden: isSketchHidden,
        activeClusterId,
        nodeScreenRadius,
        trackColor,
        playId,
        selectedId,
        hoverId,
        isStarred: (id) => Boolean(window.BTMM_PLAYER && window.BTMM_PLAYER.isStarred(id)),
        mapWrap,
        layout,
        eraLeftGutter: eraLayout && eraLayout.leftGutter ? eraLayout.leftGutter : 94,
        onRequestFrame: repaintLabelsFrame,
      });
    }

    ctx.restore();
    paintRings(playId, pendId);
    updateHoverPill();
    schedulePulseFrameIfNeeded();
  }

  function paint() {
    syncStarHud();
    paintCanvas();
    drawFloatingLabels();
    if (window.BTMM_PLAYER) window.BTMM_PLAYER.render();
  }

  function tweenToTargets(animate, durMs = MORPH_MS) {
    stopMomentum();
    if (tweenRaf && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(tweenRaf);
    nodes.forEach((n) => { n.sx = n.x; n.sy = n.y; });
    const reducedMotion = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const allowMorph = animate && !reducedMotion && nodes.length <= 800 && typeof requestAnimationFrame !== "undefined";
    if (!allowMorph) {
      nodes.forEach((n) => { n.x = n.tx; n.y = n.ty; });
      paint();
      return;
    }
    const t0 = performance.now();
    function step(now) {
      const u = Math.min(1, (now - t0) / durMs);
      const ease = 1 - Math.pow(1 - u, 3);
      nodes.forEach((n) => {
        n.x = n.sx + (n.tx - n.sx) * ease;
        n.y = n.sy + (n.ty - n.sy) * ease;
      });
      paintCanvas();
      if (u < 1) tweenRaf = requestAnimationFrame(step);
      else { tweenRaf = 0; drawFloatingLabels(); schedulePulseFrameIfNeeded(); }
    }
    tweenRaf = requestAnimationFrame(step);
  }

  function hitRadiusForEvent(ev) {
    const base = isTouchEvent(ev) ? HIT_TOUCH_PX : HIT_MOUSE_PX;
    return zoom.k >= 1.55 ? base + 8 : base;
  }

  function findNearestVisibleNode(px, py, maxDist) {
    let best = null;
    let bestDist = maxDist;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!isMatch(n.t)) continue;
      const sx = Number.isFinite(n.px) ? n.px : n.x * zoom.k + zoom.x;
      const sy = Number.isFinite(n.py) ? n.py : n.y * zoom.k + zoom.y;
      const d = Math.hypot(px - sx, py - sy);
      if (d <= bestDist) {
        bestDist = d;
        best = n;
      }
    }
    if (bestDist > 9 && window.BTMM_MAP_LABELS && window.BTMM_MAP_LABELS.hitLabelAt) {
      const lid = window.BTMM_MAP_LABELS.hitLabelAt(px, py);
      if (lid) {
        const ln = nodeById.get(lid);
        if (ln && isMatch(ln.t)) return ln;
      }
    }
    return best;
  }

  function pointerLocalXY(ev) {
    const rect = mapWrap.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  }

  function isTouchEvent(ev) {
    if (ev && ev.pointerType === "touch") return true;
    return typeof window !== "undefined" && window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  }

  let physics = null;
  let cachedExpandedBottomSpanY = 0;

  // Always reserve blank scrollable space behind the maximized player (even when minimized or closed)
  // so bottom-most tracks in both Vibe and Era views sit right above the maximized player's top edge.
  function getPanSlack() {
    const isMob = vw <= 840;
    const isDesktopEra = layout === "era" && vw > 800;
    let spanY = cachedExpandedBottomSpanY > 0 ? cachedExpandedBottomSpanY : 336;
    let liveDesktopSpanX = 0;
    if (typeof document !== "undefined" && mapWrap) {
      const card = document.getElementById("track-player-card");
      if (card && !card.hidden) {
        const mRect = mapWrap.getBoundingClientRect();
        const cRect = card.getBoundingClientRect();
        if (cRect.width > 40 && vw > 800) {
          liveDesktopSpanX = Math.max(0, Math.round(mRect.right - cRect.left + 42));
        }
        const isCol = card.classList.contains("is-collapsed") || card.classList.contains("mp-collapsed");
        if (!isCol) {
          if (cRect.height > 40) {
            const liveSpan = Math.max(0, mRect.bottom - cRect.top);
            const infoOpen = Boolean(window.BTMM_PLAYER && window.BTMM_PLAYER.isInfoOpen && window.BTMM_PLAYER.isInfoOpen());
            if (!card.classList.contains("is-requesting") && !infoOpen) {
              cachedExpandedBottomSpanY = Math.max(300, liveSpan);
              spanY = cachedExpandedBottomSpanY;
            } else {
              spanY = Math.max(spanY, liveSpan);
            }
          }
        } else {
          const expandInner = card.querySelector("#mp-expand-inner");
          if (expandInner && expandInner.scrollHeight > 80) {
            const estCardH = Math.min(isMob ? vh * 0.58 : vh - 36, expandInner.scrollHeight + 30);
            const estSpan = estCardH + (isMob ? 10 : 18);
            cachedExpandedBottomSpanY = Math.max(300, estSpan);
            spanY = Math.max(spanY, estSpan);
          }
        }
      }
    }

    const [, worldH] = worldSize();
    let maxNodeY = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (isSketchHidden(n.t) || !isMatch(n.t)) continue;
      const ny = Number.isFinite(n.ty) ? n.ty : n.y;
      if (ny > maxNodeY) maxNodeY = ny;
    }
    const bottomMarginWorld = maxNodeY > 0 ? Math.max(0, worldH - maxNodeY) : 0;
    const curK = Math.max(1, Number.isFinite(zoom.k) ? zoom.k : 1);
    // On Desktop Era at 1x zoom, lock vertical slack to 0 so horizontal timeline scrolling stays on a rock-steady rail
    if (isDesktopEra && curK <= 1.02) {
      const eraSlackX = Math.max(448, liveDesktopSpanX);
      return [eraSlackX, 0];
    }
    // Place the lowest visible track ~42px above the maximized player's top edge when scrolled all the way up
    const neededSlackY = (spanY + 42) - bottomMarginWorld * curK;
    const minDesktopSlackY = !isMob && curK <= 1.02 ? Math.round(spanY + 48) : 0;
    const slackY = Math.max(minDesktopSlackY, Math.min(Math.round(vh * 0.75), Math.round(Math.max(0, neededSlackY))));
    const slackX = isDesktopEra ? Math.max(448, liveDesktopSpanX) : (isMob ? 0 : Math.max(416, liveDesktopSpanX));
    return [slackX, slackY];
  }

  function worldSize() {
    if (layout === "era" && eraLayout && eraLayout.virtualW && eraLayout.virtualH) {
      return [eraLayout.virtualW, eraLayout.virtualH];
    }
    if (layout === "vibe" && vibeLayout && vibeLayout.virtualW && vibeLayout.virtualH) {
      return [vibeLayout.virtualW, vibeLayout.virtualH];
    }
    return [vw, vh];
  }

  function defaultMapZoom() {
    if (layout === "era" && eraLayout && eraLayout.defaultZoom) {
      return { ...eraLayout.defaultZoom };
    }
    if (layout === "vibe" && vibeLayout && vibeLayout.defaultZoom) {
      return { ...vibeLayout.defaultZoom };
    }
    return { k: 1, x: 0, y: 0 };
  }

  function resetCamera() {
    stopMomentum();
    zoom = defaultMapZoom();
    clampZoom();
    paint();
  }

  function clampZoom() {
    if (physics) physics.clampZoom();
  }

  function stopMomentum() {
    if (physics) physics.stopMomentum();
  }

  function bindEvents() {
    physics = window.BTMM_MAP_PHYSICS.createController({
      mapWrap,
      getZoom: () => zoom,
      getDefaultZoom: defaultMapZoom,
      getViewport: () => [vw, vh],
      getWorldSize: worldSize,
      getPanSlack,
      preferWheelScroll: () => vw <= 800,
      onTransform: () => {
        paintCanvas();
        drawFloatingLabels();
      },
      onFullPaint: () => paint(),
      onHoverMove: (ev, [px, py]) => {
        if (
          mapWrap.hidden ||
          !ev.target ||
          !mapWrap.contains(ev.target) ||
          ev.target.closest("#map-floating-hud") ||
          ev.target.closest("#pulse-tune-dock")
        ) {
          if (hoverId !== null) {
            hoverId = null;
            mapWrap.classList.remove("has-hover");
            paintCanvas();
          }
          return;
        }
        const hit = findNearestVisibleNode(px, py, hitRadiusForEvent(ev));
        const nextHov = hit ? hit.id : null;
        if (nextHov !== hoverId) {
          hoverId = nextHov;
          mapWrap.classList.toggle("has-hover", Boolean(hoverId));
          paintCanvas();
        }
      },
      onHoverLeave: () => {
        if (hoverId !== null) {
          hoverId = null;
          mapWrap.classList.remove("has-hover");
          paintCanvas();
        }
      },
      onTapPoint: (ev, px, py) => {
        const hit = findNearestVisibleNode(px, py, hitRadiusForEvent(ev));
        if (!hit) return false;
        selectedId = hit.id;
        if (window.BTMM_PLAYER) window.BTMM_PLAYER.select(hit.id, { silent: true });
        if (hooks && hooks.onTap) hooks.onTap(hit.id);
        paint();
        return true;
      },
      onBackgroundTap: () => {
        selectedId = null;
        if (window.BTMM_PLAYER) window.BTMM_PLAYER.select(null, { silent: true });
        if (activeClusterId || activeEraId) {
          activeClusterId = null;
          activeEraId = null;
        }
        paint();
      },
    });
    physics.bind();

    if (starBtn) {
      starBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        starFilter = !starFilter;
        if (isTouchEvent(ev)) hudHoverTarget = null;
        paint();
      });
      starBtn.addEventListener("pointerenter", (ev) => {
        if (ev.pointerType === "touch") return;
        hudHoverTarget = "star";
        updateHudHint();
      });
      starBtn.addEventListener("pointerleave", () => { if (hudHoverTarget === "star") { hudHoverTarget = null; updateHudHint(); } });
      starBtn.addEventListener("focus", () => {
        if (!starBtn.matches || !starBtn.matches(":focus-visible")) return;
        hudHoverTarget = "star";
        updateHudHint();
      });
      starBtn.addEventListener("blur", () => { if (hudHoverTarget === "star") { hudHoverTarget = null; updateHudHint(); } });
    }

    if (sketchBtn) {
      sketchBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (isTouchEvent(ev)) hudHoverTarget = null;
        setShowSketches(!showSketches);
      });
      sketchBtn.addEventListener("pointerenter", (ev) => {
        if (ev.pointerType === "touch") return;
        hudHoverTarget = "sketch";
        updateHudHint();
      });
      sketchBtn.addEventListener("pointerleave", () => { if (hudHoverTarget === "sketch") { hudHoverTarget = null; updateHudHint(); } });
      sketchBtn.addEventListener("focus", () => {
        if (!sketchBtn.matches || !sketchBtn.matches(":focus-visible")) return;
        hudHoverTarget = "sketch";
        updateHudHint();
      });
      sketchBtn.addEventListener("blur", () => { if (hudHoverTarget === "sketch") { hudHoverTarget = null; updateHudHint(); } });
    }

    if (eraGenAiBtn) {
      eraGenAiBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (isTouchEvent(ev)) hudHoverTarget = null;
        setShowGenAi(!isGenAiShown());
      });
      eraGenAiBtn.addEventListener("pointerenter", (ev) => {
        if (ev.pointerType === "touch") return;
        hudHoverTarget = "genai";
        updateHudHint();
      });
      eraGenAiBtn.addEventListener("pointerleave", () => { if (hudHoverTarget === "genai") { hudHoverTarget = null; updateHudHint(); } });
      eraGenAiBtn.addEventListener("focus", () => {
        if (!eraGenAiBtn.matches || !eraGenAiBtn.matches(":focus-visible")) return;
        hudHoverTarget = "genai";
        updateHudHint();
      });
      eraGenAiBtn.addEventListener("blur", () => { if (hudHoverTarget === "genai") { hudHoverTarget = null; updateHudHint(); } });
    }

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          schedulePulseFrameIfNeeded();
        } else if (hooks && hooks.playing && hooks.playing()) {
          pulseLastNow = 0;
          paintCanvas();
        }
      });
    }

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        const cr = entries[0] && entries[0].contentRect;
        if (!cr || cr.width < 40 || cr.height < 40) return;
        if (Math.abs(cr.width - vw) < 0.5 && Math.abs(cr.height - vh) < 0.5) return;
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          relayout(false);
        });
      });
      ro.observe(mapWrap);
    }
  }

  function resizeCanvas() {
    if (!mapWrap || !canvas || !svg) return;
    vw = Math.max(320, mapWrap.clientWidth || 1000);
    vh = Math.max(300, mapWrap.clientHeight || 680);
    dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    canvas.width = Math.floor(vw * dpr);
    canvas.height = Math.floor(vh * dpr);
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
  }

  function relayout(animate = false) {
    stopMomentum();
    const prevVw = vw;
    const prevVh = vh;
    resizeCanvas();
    computeTargetPositions();
    if (layout === "era" && eraLayout) {
      if ((prevVw <= 800) !== (vw <= 800)) {
        zoom = { ...eraLayout.defaultZoom };
      } else if (vw <= 800 && prevVh > 0 && Math.abs(vh - prevVh) > 0.5) {
        zoom.y = zoom.y * (vh / prevVh);
      } else if (vw > 800 && prevVw > 0 && Math.abs(vw - prevVw) > 0.5) {
        zoom.x = zoom.x * (vw / prevVw);
      }
    } else if ((prevVw <= 768) !== (vw <= 768)) {
      zoom = defaultMapZoom();
    }
    clampZoom();
    if (prevVw !== vw || prevVh !== vh) buildEdges();
    tweenToTargets(animate);
    drawFloatingLabels();
  }

  function focus(tid, opts = {}) {
    if (!byId.has(tid)) return;
    stopMomentum();
    const tr = byId.get(tid);
    if (tr && isSketchHidden(tr)) {
      if (tr.is_ai) {
        if (layout === "era") showEraGenAi = true;
        else showVibeGenAi = true;
      }
      if (tr.is_sketch) showSketches = true;
      computeTargetPositions();
      nodes.forEach((n) => { n.x = n.tx; n.y = n.ty; });
      buildEdges();
    }
    if (opts && opts.centerNode) {
      const n = nodeById.get(tid);
      if (n) {
        const defFocusK = layout === "era" && vw <= 800 ? 1 : 1.85;
        const targetK = Math.max(1, Math.min(4, Number(opts.zoomK) || defFocusK));
        const anchorX = vw <= 840 ? vw * 0.5 : vw * 0.42;
        const anchorY = vw <= 840 ? vh * 0.34 : vh * 0.45;
        zoom = {
          k: targetK,
          x: anchorX - n.x * targetK,
          y: anchorY - n.y * targetK,
        };
        clampZoom();
      }
    }
    selectedId = tid;
    if (window.BTMM_PLAYER) window.BTMM_PLAYER.select(tid, { silent: true });
    paint();
    drawFloatingLabels();
  }

  function setLayout(nextLay, animate = true) {
    stopMomentum();
    const norm = normLayoutName(nextLay);
    layout = norm;
    activeClusterId = null;
    activeEraId = null;
    resizeCanvas();
    computeTargetPositions();
    zoom = defaultMapZoom();
    clampZoom();
    buildEdges();
    tweenToTargets(animate);
    drawFloatingLabels();
    paint();
    if (hooks && hooks.onLayoutChange) hooks.onLayoutChange(layout);
  }

  function setShowSketches(val) {
    const next = Boolean(val);
    if (next === showSketches) return showSketches;
    stopMomentum();
    showSketches = next;
    if (layout === "era") {
      computeTargetPositions();
      nodes.forEach((n) => { n.x = n.tx; n.y = n.ty; });
      clampZoom();
    }
    buildEdges();
    paint();
    return showSketches;
  }

  function setShowVibeGenAi(val, opts = {}) {
    const next = Boolean(val);
    if (next === showVibeGenAi) return showVibeGenAi;
    stopMomentum();
    showVibeGenAi = next;
    if (!showVibeGenAi) {
      if (activeClusterId === "ai_generative" || (activeClusterId && activeClusterId.startsWith("ai_sub_"))) {
        activeClusterId = null;
      }
      const selTr = selectedId ? byId.get(selectedId) : null;
      if (selTr && selTr.is_ai) {
        selectedId = null;
        if (window.BTMM_PLAYER) window.BTMM_PLAYER.select(null, { silent: true });
      }
      const hovTr = hoverId ? byId.get(hoverId) : null;
      if (hovTr && hovTr.is_ai) {
        hoverId = null;
        if (mapWrap) mapWrap.classList.remove("has-hover");
      }
    }
    if (layout === "vibe") {
      computeTargetPositions();
      zoom = defaultMapZoom();
      clampZoom();
      buildEdges();
      const shouldAnimate = opts && typeof opts.animate === "boolean" ? opts.animate : true;
      syncStarHud();
      tweenToTargets(shouldAnimate, 320);
      drawFloatingLabels();
      if (window.BTMM_PLAYER) window.BTMM_PLAYER.render();
      return showVibeGenAi;
    }
    buildEdges();
    paint();
    return showVibeGenAi;
  }

  function setShowEraGenAi(val) {
    const next = Boolean(val);
    if (next === showEraGenAi) return showEraGenAi;
    stopMomentum();
    showEraGenAi = next;
    if (!showEraGenAi && activeEraId === "genai_2025") activeEraId = null;
    if (layout === "era") {
      computeTargetPositions();
      nodes.forEach((n) => { n.x = n.tx; n.y = n.ty; });
      clampZoom();
    }
    buildEdges();
    paint();
    return showEraGenAi;
  }

  function setShowGenAi(val) {
    return layout === "era" ? setShowEraGenAi(val) : setShowVibeGenAi(val);
  }

  function setClusterFilter(cid) {
    stopMomentum();
    activeClusterId = cid;
    paint();
  }

  function firstVisibleTrackId() {
    for (let i = 0; i < nodes.length; i++) {
      if (!isSketchHidden(nodes[i].t) && isMatch(nodes[i].t)) return nodes[i].id;
    }
    return tracks[0] ? tracks[0].id : null;
  }

  let pulseCornerMoveHandler = null;
  let pulseDocLeaveHandler = null;
  let pulseDocKeyHandler = null;
  let pulseSaveInFlight = false;

  function syncRangeTrackPct(input) {
    if (!input || !input.style) return;
    const min = parseFloat(input.min || "0");
    const max = parseFloat(input.max || "100");
    const val = parseFloat(input.value || "0");
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    input.style.setProperty("--pct", `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`);
  }

  function formatPulseSliderValue(key, val) {
    if (key === "colorCount") {
      const n = Math.round(val);
      return n === 1 ? "1 color" : `${n} colors`;
    }
    if (key === "dotSpeed") {
      return val <= 0.005 ? "Still" : `${val.toFixed(2)}×`;
    }
    if (key === "reverseMix") {
      return val <= 0.005 ? "Off" : `${Math.round(val * 100)}%`;
    }
    if (key === "dirOscAmount") {
      return val <= 0.005 ? "0%" : `${Math.round(val * 100)}%`;
    }
    if (key === "dirOscFreq") {
      const sec = val > 0 ? 1 / val : 0;
      const cyc = sec >= 10 ? `${Math.round(sec)}s` : `${sec.toFixed(1).replace(/\.0$/, "")}s`;
      return `${val.toFixed(2)} Hz · ${cyc}`;
    }
    if (key === "dirOscPinch") {
      const pct = Math.round(val * 100);
      if (pct <= 0) return "0% · Sine";
      if (pct >= 80) return `${pct}% · Tight`;
      return `${pct}% · Notch`;
    }
    if (key === "dotSizePulseAmt") {
      return val <= 0.005 ? "0%" : `${Math.round(val * 100)}%`;
    }
    if (key === "dotSizePulseFreq") {
      return `${val.toFixed(2)} Hz`;
    }
    if (key === "targetPulseSpeed" || key === "pulseGlow") {
      return val <= 0.005 ? "Off" : `${val.toFixed(2)}×`;
    }
    return `${val.toFixed(2)}×`;
  }

  function clearSavedButtonFeedback() {
    if (!pulseTuneUi) return;
    if (pulseTuneUi.saveTimer) {
      clearTimeout(pulseTuneUi.saveTimer);
      pulseTuneUi.saveTimer = 0;
    }
    pulseTuneUi.saveBtn.classList.remove("is-saved");
    pulseTuneUi.saveIcon.textContent = "cloud_upload";
    pulseTuneUi.saveLbl.textContent = "Save settings";
    pulseTuneUi.statusEl.hidden = true;
    pulseTuneUi.statusEl.textContent = "";
  }

  function syncPulseTuningUi() {
    if (!pulseTuneUi) return;
    const isLight = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "light";
    const stops = isLight ? GEMINI_STOPS_LIGHT : GEMINI_STOPS_DARK;
    const isSheen = pulseTuning.mode === "line_sheen";
    if (pulseTuneUi.modeBtns) {
      pulseTuneUi.modeBtns.forEach(({ mode, btn }) => {
        const active = pulseTuning.mode === mode;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
    }
    if (pulseTuneUi.bonusGroup) {
      pulseTuneUi.bonusGroup.hidden = isSheen;
    }
    pulseTuneUi.controls.forEach(({ key, input, valEl, lblEl, defaultLabel, sheenLabel }) => {
      const cur = pulseTuning[key];
      input.value = String(cur);
      syncRangeTrackPct(input);
      valEl.textContent = formatPulseSliderValue(key, cur);
      if (lblEl && sheenLabel) {
        const nextLbl = isSheen ? sheenLabel : defaultLabel;
        lblEl.textContent = nextLbl;
        input.setAttribute("aria-label", nextLbl);
      }
    });
    if (pulseTuneUi.swatchWrap) {
      const activeCount = Math.max(1, Math.min(stops.length, Math.round(pulseTuning.colorCount)));
      pulseTuneUi.swatchWrap.innerHTML = "";
      for (let i = 0; i < activeCount; i++) {
        const dot = document.createElement("span");
        dot.className = "pulse-tune-swatch";
        const rgb = stops[i];
        dot.style.background = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
        pulseTuneUi.swatchWrap.appendChild(dot);
      }
    }
  }

  function setPulsePanelOpen(nextOpen) {
    pulsePanelOpen = Boolean(nextOpen);
    if (pulseTuneUi) {
      pulseTuneUi.dock.classList.toggle("is-open", pulsePanelOpen);
      pulseTuneUi.panel.hidden = !pulsePanelOpen;
      pulseTuneUi.trigger.setAttribute("aria-expanded", String(pulsePanelOpen));
      if (pulsePanelOpen) {
        syncPulseTuningUi();
      }
    }
    pulseLastNow = 0;
    paintCanvas();
  }

  function setPulseTuning(patch, opts = {}) {
    if (!opts.fromRemote) pulseUserModifiedInSession = true;
    pulseTuning = sanitizePulseTuning({ ...pulseTuning, ...(patch || {}) }, pulseTuning);
    if (!opts.keepSaveBadge) clearSavedButtonFeedback();
    syncPulseTuningUi();
    paintCanvas();
    return { ...pulseTuning };
  }

  function resetPulseTuning() {
    pulseUserModifiedInSession = true;
    pulseTuning = { ...DEFAULT_PULSE_TUNING };
    clearSavedButtonFeedback();
    syncPulseTuningUi();
    paintCanvas();
    return { ...pulseTuning };
  }

  async function savePulseTuning() {
    if (pulseSaveInFlight) return { ok: false, inFlight: true };
    pulseSaveInFlight = true;
    pulseUserModifiedInSession = true;
    const savedAtIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const payload = {
      version: PULSE_PRESET_SCHEMA_VERSION,
      mode: pulseTuning.mode,
      lineStrength: pulseTuning.lineStrength,
      dotSpeed: pulseTuning.dotSpeed,
      reverseMix: pulseTuning.reverseMix,
      dirOscAmount: pulseTuning.dirOscAmount,
      dirOscFreq: pulseTuning.dirOscFreq,
      dirOscPinch: pulseTuning.dirOscPinch,
      colorCount: pulseTuning.colorCount,
      targetPulseSpeed: pulseTuning.targetPulseSpeed,
      pulseGlow: pulseTuning.pulseGlow,
      dotSize: pulseTuning.dotSize,
      dotSizePulseAmt: pulseTuning.dotSizePulseAmt,
      dotSizePulseFreq: pulseTuning.dotSizePulseFreq,
      dotSpacing: pulseTuning.dotSpacing,
      savedAt: savedAtIso,
    };
    const savedMs = Date.parse(savedAtIso);
    if (Number.isFinite(savedMs)) pulseLocalSavedAtMs = savedMs;
    const serialized = JSON.stringify(payload);

    try {
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(PULSE_PRESET_KEY_PRIMARY, serialized);
          localStorage.setItem(PULSE_PRESET_KEY_ALT, serialized);
        }
      } catch (_) {}

      let copied = false;
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(serialized);
          copied = true;
        }
      } catch (_) {}

      if (pulseTuneUi) {
        pulseTuneUi.saveBtn.setAttribute("aria-busy", "true");
        pulseTuneUi.saveLbl.textContent = "Saving…";
      }

      let remoteOk = false;
      let remoteData = null;
      try {
        const endpoint = resolvePulsePresetEndpoint();
        const resp = await fetch(endpoint, {
          method: "POST",
          mode: "cors",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: serialized,
        });
        if (resp.ok) {
          remoteData = await resp.json().catch(() => null);
          remoteOk = Boolean(remoteData && remoteData.ok);
        }
      } catch (_) {
        remoteOk = false;
      }

      if (pulseTuneUi) {
        pulseTuneUi.saveBtn.removeAttribute("aria-busy");
        pulseTuneUi.saveBtn.classList.add("is-saved");
        pulseTuneUi.saveIcon.textContent = "check_circle";
        pulseTuneUi.saveLbl.textContent = "Saved — ready to pick up";
        pulseTuneUi.statusEl.hidden = false;
        pulseTuneUi.statusEl.textContent = remoteOk
          ? "Saved! Preset synced"
          : copied
            ? "Saved locally & copied JSON"
            : "Saved locally on this browser";
        if (pulseTuneUi.saveTimer) clearTimeout(pulseTuneUi.saveTimer);
        pulseTuneUi.saveTimer = setTimeout(() => {
          if (!pulseTuneUi) return;
          pulseTuneUi.saveTimer = 0;
        }, 4500);
      }

      return {
        ok: true,
        remoteSynced: remoteOk,
        copied,
        preset: payload,
        remote: remoteData,
      };
    } finally {
      pulseSaveInFlight = false;
      if (pulseTuneUi) pulseTuneUi.saveBtn.removeAttribute("aria-busy");
    }
  }

  function mountPulseTuningUi() {
    if (!mapWrap || typeof document === "undefined") return;
    if (pulseCornerMoveHandler && typeof window !== "undefined") {
      window.removeEventListener("pointermove", pulseCornerMoveHandler);
      pulseCornerMoveHandler = null;
    }
    if (pulseDocLeaveHandler) {
      document.removeEventListener("mouseleave", pulseDocLeaveHandler);
      pulseDocLeaveHandler = null;
    }
    if (pulseDocKeyHandler && typeof window !== "undefined") {
      window.removeEventListener("keydown", pulseDocKeyHandler);
      pulseDocKeyHandler = null;
    }
    const prev = document.getElementById("pulse-tune-dock");
    if (prev) prev.remove();

    const dock = document.createElement("div");
    dock.id = "pulse-tune-dock";
    dock.className = "pulse-tune-dock";

    const panel = document.createElement("div");
    panel.id = "pulse-tune-panel";
    panel.className = "pulse-tune-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Pulse animation tuning");
    panel.hidden = true;

    const head = document.createElement("div");
    head.className = "pulse-tune-head";

    const titleWrap = document.createElement("div");
    titleWrap.className = "pulse-tune-title-wrap";
    const titleIcon = document.createElement("span");
    titleIcon.className = "ms";
    titleIcon.setAttribute("aria-hidden", "true");
    titleIcon.textContent = "auto_awesome";
    const titleEl = document.createElement("h3");
    titleEl.className = "pulse-tune-title";
    titleEl.textContent = "Pulse tuning";
    titleWrap.append(titleIcon, titleEl);

    const headActions = document.createElement("div");
    headActions.className = "pulse-tune-head-actions";
    const resetBtn = document.createElement("button");
    resetBtn.id = "pulse-tune-reset";
    resetBtn.type = "button";
    resetBtn.className = "pulse-tune-reset-btn";
    resetBtn.textContent = "Reset";
    const closeBtn = document.createElement("button");
    closeBtn.id = "pulse-tune-close";
    closeBtn.type = "button";
    closeBtn.className = "pulse-tune-close-btn";
    closeBtn.setAttribute("aria-label", "Close pulse tuning");
    const closeIcon = document.createElement("span");
    closeIcon.className = "ms";
    closeIcon.setAttribute("aria-hidden", "true");
    closeIcon.textContent = "close";
    closeBtn.appendChild(closeIcon);
    headActions.append(resetBtn, closeBtn);
    head.append(titleWrap, headActions);

    const modeRow = document.createElement("div");
    modeRow.className = "pulse-tune-mode-row";
    const modeLbl = document.createElement("div");
    modeLbl.className = "pulse-tune-lbl";
    modeLbl.textContent = "Style";

    const modeSwitch = document.createElement("div");
    modeSwitch.id = "pt-mode-switch";
    modeSwitch.className = "m3-pill-tabs gm3-connected-dsp pulse-tune-mode-tabs";
    modeSwitch.setAttribute("role", "group");
    modeSwitch.setAttribute("aria-label", "Style");

    const modeDefs = [
      { id: "pt-mode-line-dots", mode: "line_dots", label: "Line + dots" },
      { id: "pt-mode-line-sheen", mode: "line_sheen", label: "Flowing line" },
    ];
    const modeBtns = modeDefs.map((mDef) => {
      const btn = document.createElement("button");
      btn.id = mDef.id;
      btn.type = "button";
      btn.className = "m3-pill-tab";
      btn.dataset.pulseMode = mDef.mode;
      btn.textContent = mDef.label;
      btn.setAttribute("aria-pressed", String(pulseTuning.mode === mDef.mode));
      btn.addEventListener("click", () => {
        setPulseTuning({ mode: mDef.mode });
      });
      modeSwitch.appendChild(btn);
      return { mode: mDef.mode, btn };
    });
    modeRow.append(modeLbl, modeSwitch);

    const primaryGroup = document.createElement("div");
    primaryGroup.className = "pulse-tune-group";

    const bonusGroup = document.createElement("div");
    bonusGroup.className = "pulse-tune-group pulse-tune-group-sub";

    const sliderDefs = [
      { id: "pt-line-strength", key: "lineStrength", label: "Line strength", min: 0.2, max: 2.0, step: 0.05, primary: true },
      { id: "pt-dot-speed", key: "dotSpeed", label: "Dot speed", sheenLabel: "Flow speed", min: 0, max: 3, step: 0.05, primary: true },
      { id: "pt-reverse-mix", key: "reverseMix", label: "Reverse wave", min: 0, max: 1, step: 0.05, primary: true },
      { id: "pt-dir-osc-amt", key: "dirOscAmount", label: "Direction crossfade", min: 0, max: 1, step: 0.05, primary: true },
      { id: "pt-dir-osc-freq", key: "dirOscFreq", label: "Crossfade speed", min: 0.02, max: 0.6, step: 0.01, primary: true },
      { id: "pt-dir-osc-pinch", key: "dirOscPinch", label: "Reverse pinch", min: 0, max: 1, step: 0.05, primary: true },
      { id: "pt-color-count", key: "colorCount", label: "Amount of colors", min: 1, max: 5, step: 1, primary: true, swatches: true },
      { id: "pt-target-speed", key: "targetPulseSpeed", label: "Receiving track pulse", min: 0, max: 3, step: 0.05, primary: true },
      { id: "pt-pulse-glow", key: "pulseGlow", label: "Pulse glow", min: 0, max: 2.5, step: 0.05, primary: true },
      { id: "pt-dot-size", key: "dotSize", label: "Dot size", min: 0.5, max: 2, step: 0.05, primary: false },
      { id: "pt-dot-size-pulse-amt", key: "dotSizePulseAmt", label: "Size pulse amount", min: 0, max: 1, step: 0.05, primary: false },
      { id: "pt-dot-size-pulse-freq", key: "dotSizePulseFreq", label: "Size pulse freq", min: 0.1, max: 4.0, step: 0.05, primary: false },
      { id: "pt-dot-spacing", key: "dotSpacing", label: "Dot spacing", min: 0.6, max: 1.8, step: 0.05, primary: false },
    ];

    const controls = [];
    let swatchWrap = null;

    sliderDefs.forEach((def) => {
      const row = document.createElement("div");
      row.className = "pulse-tune-row";

      const lblRow = document.createElement("div");
      lblRow.className = "pulse-tune-lbl-row";

      const lbl = document.createElement("label");
      lbl.className = "pulse-tune-lbl";
      lbl.setAttribute("for", def.id);
      lbl.textContent = def.label;

      const meta = document.createElement("div");
      meta.className = "pulse-tune-meta";
      if (def.swatches) {
        swatchWrap = document.createElement("span");
        swatchWrap.className = "pulse-tune-swatches";
        swatchWrap.setAttribute("aria-hidden", "true");
        meta.appendChild(swatchWrap);
      }
      const valEl = document.createElement("span");
      valEl.id = `${def.id}-val`;
      valEl.className = "pulse-tune-val";
      meta.appendChild(valEl);

      lblRow.append(lbl, meta);

      const input = document.createElement("input");
      input.id = def.id;
      input.className = "gm3-slider";
      input.type = "range";
      input.min = String(def.min);
      input.max = String(def.max);
      input.step = String(def.step);
      input.value = String(pulseTuning[def.key]);
      input.setAttribute("aria-label", def.label);
      input.addEventListener("input", () => {
        setPulseTuning({ [def.key]: parseFloat(input.value) });
      });

      row.append(lblRow, input);
      (def.primary ? primaryGroup : bonusGroup).appendChild(row);
      controls.push({
        key: def.key,
        input,
        valEl,
        lblEl: lbl,
        defaultLabel: def.label,
        sheenLabel: def.sheenLabel || "",
      });
    });

    const foot = document.createElement("div");
    foot.className = "pulse-tune-foot";
    const saveBtn = document.createElement("button");
    saveBtn.id = "pulse-tune-save";
    saveBtn.type = "button";
    saveBtn.className = "pulse-tune-save-btn";
    const saveIcon = document.createElement("span");
    saveIcon.className = "ms";
    saveIcon.setAttribute("aria-hidden", "true");
    saveIcon.textContent = "cloud_upload";
    const saveLbl = document.createElement("span");
    saveLbl.id = "pulse-tune-save-lbl";
    saveLbl.textContent = "Save settings";
    saveBtn.append(saveIcon, saveLbl);

    const statusEl = document.createElement("div");
    statusEl.id = "pulse-tune-status";
    statusEl.className = "pulse-tune-status";
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");
    statusEl.hidden = true;

    const scrollBody = document.createElement("div");
    scrollBody.className = "pulse-tune-scroll";
    scrollBody.append(modeRow, primaryGroup, bonusGroup);

    foot.append(saveBtn, statusEl);
    panel.append(head, scrollBody, foot);

    const zone = document.createElement("div");
    zone.id = "pulse-tune-zone";
    zone.className = "pulse-tune-zone";

    const trigger = document.createElement("button");
    trigger.id = "pulse-tune-trigger";
    trigger.type = "button";
    trigger.className = "pulse-tune-trigger";
    trigger.setAttribute("aria-label", "Pulse animation controls");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", "pulse-tune-panel");
    const trigIcon = document.createElement("span");
    trigIcon.className = "ms";
    trigIcon.setAttribute("aria-hidden", "true");
    trigIcon.textContent = "auto_awesome";
    const trigLbl = document.createElement("span");
    trigLbl.textContent = "Pulse tuning";
    trigger.append(trigIcon, trigLbl);
    zone.appendChild(trigger);

    dock.append(panel, zone);
    mapWrap.appendChild(dock);

    ["pointerdown", "pointerup", "click", "dblclick", "wheel"].forEach((evtName) => {
      dock.addEventListener(evtName, (ev) => {
        ev.stopPropagation();
      });
    });
    dock.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && pulsePanelOpen) {
        ev.stopPropagation();
        setPulsePanelOpen(false);
        trigger.focus();
        return;
      }
      ev.stopPropagation();
    });

    trigger.addEventListener("click", () => {
      setPulsePanelOpen(!pulsePanelOpen);
    });
    closeBtn.addEventListener("click", () => {
      setPulsePanelOpen(false);
    });
    resetBtn.addEventListener("click", () => {
      resetPulseTuning();
    });
    saveBtn.addEventListener("click", () => {
      savePulseTuning();
    });

    if (typeof window !== "undefined") {
      pulseCornerMoveHandler = (ev) => {
        if (ev.pointerType === "touch" || !mapWrap || mapWrap.hidden) {
          dock.classList.remove("is-corner-near");
          return;
        }
        const mRect = mapWrap.getBoundingClientRect();
        const inScreenBottomLeft = ev.clientX <= Math.max(148, mRect.left + 88) && ev.clientY >= window.innerHeight - 86;
        const inMapBottomLeft =
          ev.clientX >= mRect.left - 8 &&
          ev.clientX <= mRect.left + 148 &&
          ev.clientY >= mRect.bottom - 76 &&
          ev.clientY <= mRect.bottom + 8;
        dock.classList.toggle("is-corner-near", Boolean(inScreenBottomLeft || inMapBottomLeft));
      };
      pulseDocLeaveHandler = () => {
        dock.classList.remove("is-corner-near");
      };
      pulseDocKeyHandler = (ev) => {
        if (ev.key === "Escape" && pulsePanelOpen) {
          ev.preventDefault();
          ev.stopPropagation();
          setPulsePanelOpen(false);
          if (trigger && typeof trigger.focus === "function") {
            trigger.focus();
          }
        }
      };
      window.addEventListener("pointermove", pulseCornerMoveHandler, { passive: true });
      document.addEventListener("mouseleave", pulseDocLeaveHandler);
      window.addEventListener("keydown", pulseDocKeyHandler);
    }

    pulseTuneUi = {
      dock,
      panel,
      zone,
      trigger,
      modeBtns,
      bonusGroup,
      saveBtn,
      saveIcon,
      saveLbl,
      statusEl,
      controls,
      swatchWrap,
      saveTimer: 0,
    };
    syncPulseTuningUi();
  }

  function init(cfg) {
    hooks = cfg;
    tracks = cfg.tracks || [];
    eras = cfg.eras || [];
    byId = cfg.byId;
    erasById = cfg.erasById;
    styleGroups = cfg.styleGroups || [];
    eraAnchors = cfg.eraAnchors || [];
    trackMap = cfg.trackMap || {};
    trackNear = cfg.trackNear || {};

    mapWrap = document.getElementById("map");
    canvas = document.getElementById("map-canvas");
    svg = document.getElementById("map-svg");
    hoverPill = document.getElementById("map-hover-pill");
    starBtn = document.getElementById("star-filter-btn");
    sketchBtn = document.getElementById("sketch-filter-btn");
    eraGenAiBtn = document.getElementById("era-genai-filter-btn");
    hudHintEl = document.getElementById("map-hud-hint");
    starEmptyEl = document.getElementById("star-empty-msg");
    if (!mapWrap || !canvas || !svg) return;

    loadStoredPulseTuning();
    ctx = canvas.getContext("2d");
    samplePalette();
    resizeCanvas();

    svg.innerHTML = "";
    lastRingSig = "";
    groupG = elSvg("g", "map-groups");
    ringG = elSvg("g", "map-rings");
    svg.append(ringG, groupG);

    vibeLayout = computeVibeLayout();
    nodes = tracks.map((t) => {
      const [x, y] = vibeTarget(t.id);
      return { id: t.id, t, x, y, sx: x, sy: y, tx: x, ty: y };
    });
    nodeById = new Map(nodes.map((n) => [n.id, n]));

    computeTargetPositions();
    nodes.forEach((n) => { n.x = n.tx; n.y = n.ty; });
    mountPulseTuningUi();
    bindEvents();
    zoom = defaultMapZoom();
    clampZoom();
    buildEdges();
    paint();
    hydrateRemotePulseTuning();
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => paint());
    }
  }

  window.ME_NODEMAP = {
    init,
    paint,
    focus,
    resetCamera,
    setLayout,
    getLayout: () => layout,
    getZoom: () => ({ ...zoom }),
    getWorldSize: worldSize,
    getPanSlack,
    refreshLabels() { clampZoom(); paintCanvas(); drawFloatingLabels(); },
    isCoasting: () => Boolean(physics && physics.isCoasting && physics.isCoasting()),
    getVelocity: () => (physics && physics.getVelocity ? physics.getVelocity() : { vx: 0, vy: 0, speed: 0, vLogK: 0, zoomSpeed: 0 }),
    selected: () => selectedId,
    setSelectedSilent(tid) { selectedId = tid; paint(); },
    firstVisibleTrackId,
    setFilter(setOrNull) { stopMomentum(); filterSet = setOrNull; paint(); },
    setClusterFilter,
    setShowSketches,
    getShowSketches: () => showSketches,
    setShowGenAi,
    getShowGenAi: isGenAiShown,
    setShowVibeGenAi,
    getShowVibeGenAi: () => showVibeGenAi,
    setShowEraGenAi,
    getShowEraGenAi: () => showEraGenAi,
    getEdges: () => edges.slice(),
    getEdgesCountFor: (tid) => edges.filter((e) => e.a === tid || e.b === tid).length,
    getNodeScreenPos: (tid) => { const n = nodeById.get(tid); return n && Number.isFinite(n.px) ? [n.px, n.py] : null; },
    isMapVisible: () => Boolean(mapWrap && !mapWrap.hidden),
    isTrackMatched: (tid) => { const t = byId.get(tid); return Boolean(t && isMatch(t)); },
    isTrackVisible: (tid) => { const n = nodeById.get(tid); return Boolean(n && isNodeRenderedOnMap(n)); },
    getNextPulseState: () => ({
      fromId: pulseState.fromId,
      toId: pulseState.toId,
      live: pulseState.live,
      preview: pulseState.preview,
      alpha: pulseAlpha,
      timeSec: pulseTimeSec,
      flowSec: pulseFlowSec,
      targetSec: pulseTargetSec,
      sizeModPhase: pulseSizeModPhase,
      revWavePhase: pulseRevWavePhase,
      dirOscPhase: pulseDirOscPhase,
      rafActive: Boolean(pulseRaf),
      panelOpen: pulsePanelOpen,
      tuning: { ...pulseTuning },
      renderStats: {
        mode: lastPulseRenderTelemetry.mode,
        kFwd: lastPulseRenderTelemetry.kFwd || 0,
        kRev: lastPulseRenderTelemetry.kRev || 0,
        dirOsc: lastPulseRenderTelemetry.dirOsc ? { ...lastPulseRenderTelemetry.dirOsc } : null,
        forwardCount: lastPulseRenderTelemetry.forwardDots.length,
        reverseCount: lastPulseRenderTelemetry.reverseDots.length,
        forwardDots: lastPulseRenderTelemetry.forwardDots.map((d) => ({ ...d })),
        reverseDots: lastPulseRenderTelemetry.reverseDots.map((d) => ({ ...d })),
      },
    }),
    getPulseTuning: () => ({ ...pulseTuning }),
    setPulseTuning,
    resetPulseTuning,
    savePulseTuning,
    applyRemotePulsePreset,
    setPulsePanelOpen,
    setColorMode(mode) { colorMode = mode; paint(); },
    getColorMode: () => colorMode,
    refreshTheme() { samplePalette(); syncPulseTuningUi(); paint(); },
    relayout,
  };
})();
