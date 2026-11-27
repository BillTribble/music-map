// Persistent Collapsible Floating Track Player Card (SoundCloud Waveform, Transport, 'i' Analysis Drawer & Tier A/B/C CTAs)
(function () {
  "use strict";

  const STAR_KEY = "btmm.starred";
  const COLLAPSE_KEY = "btmm.playerCollapsed";
  const AUTOPLAY_KEY = "btmm.autoPlay";
  const REQ_EMAIL_KEY = "btmm_req_email";
  const LEGACY_STAR_KEY = "me.starred";
  const REQ_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const DEFAULT_PEAK_BARS = 160;
  const EARLY_WAVE_HOVER_MAX_FRAC = 0.26;
  const COLLAPSE_ANIM_MS = 310;

  // Official inline brand SVG paths (zero external icon CDNs)
  const BRAND_SVGS = {
    bandcamp: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><polygon points="0,18.75 7.44,5.25 24,5.25 16.56,18.75" fill="currentColor"/></svg>',
    spotify: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1.5C6.2 1.5 1.5 6.2 1.5 12S6.2 22.5 12 22.5 22.5 17.8 22.5 12 17.8 1.5 12 1.5zm4.82 15.14a.75.75 0 0 1-1.03.25c-2.82-1.72-6.37-2.11-10.55-1.16a.75.75 0 0 1-.33-1.46c4.57-1.05 8.49-.6 11.66 1.34.36.22.47.69.25 1.03zm1.47-3.27a.94.94 0 0 1-1.29.31c-3.23-1.98-8.15-2.56-11.97-1.4a.94.94 0 1 1-.55-1.8c4.36-1.32 9.78-.68 13.5 1.6.44.27.58.85.31 1.29zm.13-3.41c-3.87-2.3-10.26-2.51-13.96-1.39a1.12 1.12 0 1 1-.65-2.15c4.25-1.29 11.31-1.04 15.76 1.6a1.12 1.12 0 0 1-1.15 1.94z"/></svg>',
    youtube_music: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 16.25a6.25 6.25 0 1 1 0-12.5 6.25 6.25 0 0 1 0 12.5zm0-11a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 0 0 0-9.5zM10.2 14.8V9.2l4.85 2.8-4.85 2.8z"/></svg>',
    apple_music: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.6 3.2c.4 0 .7.3.7.7v11.6a3.4 3.4 0 1 1-1.6-2.9V8.5l-7.8 1.6v7a3.4 3.4 0 1 1-1.6-2.9V6.8c0-.5.3-.9.8-1l9.1-2.5c.1 0 .3-.1.4-.1z"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.58 7.19a2.75 2.75 0 0 0-1.94-1.95C17.93 4.78 12 4.78 12 4.78s-5.93 0-7.64.46A2.75 2.75 0 0 0 2.42 7.2 28.7 28.7 0 0 0 1.96 12c0 1.63.16 3.25.46 4.81a2.75 2.75 0 0 0 1.94 1.95c1.71.46 7.64.46 7.64.46s5.93 0 7.64-.46a2.75 2.75 0 0 0 1.94-1.95c.3-1.56.46-3.18.46-4.81 0-1.63-.16-3.25-.46-4.81zM10 15V9l5.2 3L10 15z"/></svg>',
    download: '<svg class="dl-svg-icon" viewBox="0 -960 960 960" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z"/></svg>',
  };

  let byId = new Map();
  let erasById = new Map();
  let hooks = null;
  let cardEl = null;

  let selectedId = null;
  let collapsed = false;
  let infoOpen = false;
  let localAutoPlay = true;
  let starred = new Set();
  const requestedIds = new Set();
  let formOpenForId = null;
  let sendingId = null;
  let reqError = "";
  let draftEmail = "";
  let draftNote = "";

  // Waveform & playback animation state
  const fallbackPeaksCache = new Map();
  const resampledBarsCache = new Map();
  let waveHoverFrac = null;
  let isWaveScrubbing = false;
  let hasWaveDragged = false;
  let scrubFrac = null;
  let activeScrubWrapEl = null;
  let collapseSyncRafId = null;
  let collapseSyncUntilMs = 0;
  let optimisticSeekTrackId = null;
  let optimisticSeekSec = null;
  let optimisticSeekUntilMs = 0;
  let waveRafId = null;
  let lastRenderedTrackId = null;
  let lastRenderedCollapsed = null;
  let lastRenderedFormState = "";
  let copiedForId = null;
  let copiedTimer = null;
  let cachedThemeKey = "";
  let cachedPalette = null;
  let themeObserver = null;
  let waveResizeObserver = null;

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function loadPrefs() {
    try {
      const rawStars = localStorage.getItem(STAR_KEY) || localStorage.getItem(LEGACY_STAR_KEY);
      if (rawStars) {
        const arr = JSON.parse(rawStars);
        if (Array.isArray(arr)) starred = new Set(arr.filter((x) => typeof x === "string"));
      }
      // Always start the player maximized across all views on both mobile and desktop
      collapsed = false;
      localStorage.removeItem(COLLAPSE_KEY);
      const savedAuto = localStorage.getItem(AUTOPLAY_KEY);
      if (savedAuto === "false") localAutoPlay = false;
      else if (savedAuto === "true") localAutoPlay = true;
      const savedEmail = localStorage.getItem(REQ_EMAIL_KEY);
      if (typeof savedEmail === "string" && savedEmail.trim()) {
        draftEmail = savedEmail.trim();
      }
    } catch (_) {}
  }

  function loadSavedRequestEmail() {
    try {
      const saved = localStorage.getItem(REQ_EMAIL_KEY);
      return typeof saved === "string" ? saved.trim() : "";
    } catch (_) {
      return "";
    }
  }

  function saveRequestEmail(email) {
    const clean = String(email || "").trim();
    if (!clean) return;
    try { localStorage.setItem(REQ_EMAIL_KEY, clean); } catch (_) {}
  }

  function saveStars() {
    try { localStorage.setItem(STAR_KEY, JSON.stringify([...starred])); } catch (_) {}
  }

  function saveCollapsed() {
    // Intentionally session-local only so opening the app or player always starts maximized
  }

  function saveLocalAutoPlay() {
    try { localStorage.setItem(AUTOPLAY_KEY, localAutoPlay ? "true" : "false"); } catch (_) {}
  }

  function energyBadgeCls(en) {
    if (en <= 2) return "badge-blue";
    if (en <= 4) return "badge-teal";
    if (en === 5) return "badge-green";
    if (en <= 6) return "badge-amber";
    return "badge-pink";
  }

  function isReleased(t) {
    return Boolean(t && (t.released === true || (t.links && t.links.bandcamp)));
  }

  const PSYCHEDAILIES_NOTE = "Made in one day, with help from friends on Endlesss.";
  const TRACK_NOTES = {
    archive_2013_18_137: "Early sketch that became Kita Narashino.",
  };

  const FORCE_SKETCH_IDS = new Set([
    "archive_2013_18_12",
    "archive_2013_18_15",
    "archive_2013_18_33",
    "archive_2013_18_35",
    "archive_2013_18_70",
    "archive_2013_18_71",
    "archive_2013_18_87",
    "archive_2013_18_97",
    "archive_2013_18_114",
    "archive_2013_18_122",
    "archive_2013_18_123",
    "archive_2013_18_127",
    "archive_2013_18_132",
    "archive_2013_18_137",
    "archive_2013_18_139",
    "archive_2013_18_142",
    "archive_2013_18_148",
    "archive_2013_18_149",
    "archive_2013_18_152",
    "archive_2013_18_154",
    "archive_2018_23_48",
    "bands_archive_5",
    "bands_archive_8",
    "bands_archive_15",
    "ep_concepts_37",
    "hd_2005_16",
    "hd_2005_31",
    "hd_2005_49",
    "present_electro_25",
    "sketches_2024_25_24",
    "sketches_2026_3",
    "sketches_2026_19",
  ]);
  const FORCE_SKETCH_TITLES = new Set([
    "afrique",
    "anjuna",
    "chord-ideas",
    "clean 29 test track",
    "dancehorl ruff",
    "deep ruff",
    "gnarly peak beat",
    "hip-hawp b",
    "hip-hawp b 1",
    "huge-riff demo",
    "lazer-sketch",
    "lazer sketch",
    "lets watch tv ruff",
    "massive dune patch",
    "newx sketch",
    "paradise kit test",
    "piano quant sketch in f",
    "granular perc fun",
    "granular perc fun gamelanish",
    "granular perc (gamelanish)",
    "mya moody banger",
    "random acid hard",
    "reese rumble",
    "rez tweak",
    "rock sketch",
    "scrapeyard sketch",
    "spiral structure",
    "spudboy — drone 2 static",
    "spudboy - drone 2 static",
    "step 411 regal sketch",
    "synth test imposcar- devastor",
    "tryell modsynth",
    "tyrell modsynth",
    "tryell modsynth2",
    "tyrell modsynth2",
    "ultra fx",
    "weather-reportish",
    "who-knows 01 blues7th",
    "will u wont u ruff",
  ]);

  function isPsychedailiesTrack(t) {
    if (!t) return false;
    const era = String(t.era || t.era_id || "").trim().toLowerCase();
    const tid = String(t.id || "").trim().toLowerCase();
    return era === "psychedailies" || tid.startsWith("psychedailies_");
  }

  function getTrackNote(t) {
    if (!t) return "";
    if (typeof t.note === "string" && t.note.trim()) return t.note.trim();
    if (t.id && TRACK_NOTES[t.id]) return TRACK_NOTES[t.id];
    if (isPsychedailiesTrack(t)) return PSYCHEDAILIES_NOTE;
    return "";
  }

  function isSketch(t) {
    if (!t || t.is_ai || isPsychedailiesTrack(t)) return false;
    const tid = String(t.id || "");
    const lowTitle = String(t.title || "").trim().toLowerCase();
    if (FORCE_SKETCH_IDS.has(tid) || FORCE_SKETCH_TITLES.has(lowTitle)) return true;
    if (typeof t.is_sketch === "boolean") return t.is_sketch;
    const dur = Number(t.full_duration_sec || 0);
    return !isReleased(t) && dur > 0 && dur < 75;
  }

  const ROLLING_WIP_WINDOW_MS = 2 * 365.25 * 86400 * 1000; // rolling 2-year (730.5-day) window

  function isWorkInProgress(t, nowMs) {
    if (!t || t.is_ai || isReleased(t) || isSketch(t)) return false;
    if (!t.wip_eligible) return false;
    const refMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (typeof t.rendered_at === "string" && t.rendered_at) {
      const ts = Date.parse(t.rendered_at);
      if (Number.isFinite(ts)) {
        const ageMs = refMs - ts;
        return ageMs >= -30 * 86400 * 1000 && ageMs <= ROLLING_WIP_WINDOW_MS;
      }
    }
    if (typeof t.year === "number") {
      const curYear = new Date(refMs).getUTCFullYear();
      return curYear - t.year <= 2 && curYear - t.year >= 0;
    }
    return false;
  }
  window.isTrackWorkInProgress = isWorkInProgress;

  const CAMELOT_TO_SIMPLE_KEY = {
    "1A": "Abm", "2A": "Ebm", "3A": "Bbm", "4A": "Fm",
    "5A": "Cm",  "6A": "Gm",  "7A": "Dm",  "8A": "Am",
    "9A": "Em",  "10A": "Bm", "11A": "F#m", "12A": "C#m",
    "1B": "B",   "2B": "F#",  "3B": "Db",  "4B": "Ab",
    "5B": "Eb",  "6B": "Bb",  "7B": "F",   "8B": "C",
    "9B": "G",   "10B": "D",  "11B": "A",  "12B": "E",
  };

  function formatSimpleKey(t) {
    if (!t) return "";
    if (typeof t === "string") t = { key_label: t };
    const rawKey = String(t.key || t.musical_key || t.key_label || "").trim();
    const rawScale = String(t.scale || t.mode || "").trim().toLowerCase();
    const cleaned = rawKey.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    const cleanedUpper = cleaned.toUpperCase();

    if (/^(?:1[0-2]|[1-9])[AB]$/.test(cleanedUpper)) {
      return CAMELOT_TO_SIMPLE_KEY[cleanedUpper] || "";
    }

    if (cleaned) {
      const m = cleaned.match(
        /^([A-Ga-g])([#♯b♭]?)(?:(?:\s*[-/]?\s*)([Mm]inor|[Mm]in|MINOR|MIN|[Mm]ajor|[Mm]aj|MAJOR|MAJ|[Aa]eolian|[Dd]orian|[Pp]hrygian|[Ii]onian|[Mm]ixolydian|[Ll]ydian)|(\s*m))?$/
      );
      if (m) {
        const root = m[1].toUpperCase() + m[2].replace("♯", "#").replace("♭", "b");
        const wordQual = m[3] ? m[3].toLowerCase() : "";
        const hasLowerM = Boolean(m[4]);
        const effScale = wordQual || (hasLowerM ? "minor" : rawScale);
        const isMinor =
          effScale === "m" ||
          effScale === "min" ||
          effScale === "minor" ||
          effScale === "aeolian" ||
          effScale === "dorian" ||
          effScale === "phrygian";
        return isMinor ? `${root}m` : root;
      }
    }

    const camFallback = String(t.key_camelot || "").trim().toUpperCase();
    if (CAMELOT_TO_SIMPLE_KEY[camFallback]) {
      return CAMELOT_TO_SIMPLE_KEY[camFallback];
    }
    return "";
  }
  window.formatSimpleKey = formatSimpleKey;

  function resolveDisplayBpm(t) {
    if (!t) return 0;
    const bg = typeof window !== "undefined" && (window.BEAT_GRIDS || window.MUSIC_MAP_BEATGRIDS);
    const g = bg && t.id ? bg[t.id] : null;
    if (g && (g.groove === "4x4" || g.groove === "broken") && Number(g.bpm) > 0) {
      return Number(g.bpm);
    }
    return Number(t.bpm) || (g && Number(g.bpm)) || 0;
  }
  window.resolveDisplayBpm = resolveDisplayBpm;

  function buildPlayerMetaPillsHtml(t, { released, sketch, wip, er }) {
    const pills = [];
    const bpmRounded = Math.round(resolveDisplayBpm(t));
    if (bpmRounded > 0) {
      pills.push(`<span class="badge badge-blue">${bpmRounded} BPM</span>`);
    }
    const simpleKey = formatSimpleKey(t);
    if (simpleKey) {
      pills.push(`<span class="badge badge-indigo" title="Musical key: ${esc(simpleKey)}">${esc(simpleKey)}</span>`);
    }
    if (t.is_ai) {
      pills.push('<span class="badge badge-cyan">Generative AI</span>');
    } else if (sketch) {
      pills.push('<span class="badge badge-amber">Sketch</span>');
    } else if (wip) {
      pills.push('<span class="badge badge-teal mp-wip-pill mp-wip-badge" title="Unreleased work in progress from the last 2 years">Work in progress</span>');
    }
    if (!released) {
      pills.push('<span class="badge badge-purple">Unreleased</span>');
    } else {
      const relLabel = t.album || t.release_title || "Released";
      const relTitle = er && er.label ? `Released — ${er.label}` : "Released";
      pills.push(`<span class="badge badge-green" title="${esc(relTitle)}">${esc(relLabel)}</span>`);
    }
    return `<div class="mp-meta-pills" id="mp-meta-pills" aria-label="Track tempo, key, and release status">${pills.join("")}</div>`;
  }

  function resolveTier(t) {
    if (isReleased(t)) return "A";
    const mp3Url = t && (t.mp3_320_url || t.mp3_url);
    const flacUrl = t && t.flac_url;
    if (
      t &&
      Boolean(mp3Url || flacUrl) &&
      (
        t.tier === "free_download" ||
        t.is_ai === true ||
        (t.tier === "archive_dl" && !(typeof t.year === "number" && t.year >= 2015))
      )
    ) {
      return "B";
    }
    return "C";
  }

  function getPreviewStart(t) {
    if (!t) return 0;
    if (isPsychedailiesTrack(t)) return 0;
    const fullDur = Number(t.full_duration_sec) || Number(t.duration_sec) || 0;
    const audEnd = fullDur > 0 ? (getAudibleEndSec(t, fullDur) || fullDur) : 0;
    const effEnd = audEnd > 0 && fullDur > 0 ? Math.min(fullDur, audEnd) : (audEnd || fullDur);
    const maxFirstHalf = effEnd > 4.0
      ? Math.max(
          0,
          Math.min(
            0.50 * effEnd,
            fullDur > 0 ? 0.50 * fullDur : 0.50 * effEnd,
            effEnd >= 60.0 ? effEnd - 20.0 : (effEnd >= 32.0 ? effEnd - 12.0 : 0.45 * effEnd)
          )
        )
      : Infinity;
    const hasDropCue =
      Boolean(t.has_drop) &&
      Number.isFinite(t.preview_start_sec) &&
      Number(t.preview_start_sec) > 0 &&
      Number(t.preview_start_sec) <= maxFirstHalf + 1e-6;
    if (t.is_ai && !hasDropCue) return 0;
    let raw = 0;
    if (Number.isFinite(t.preview_start_sec)) raw = Math.max(0, Number(t.preview_start_sec));
    else if (Number.isFinite(t.cue_in_sec)) raw = Math.max(0, Number(t.cue_in_sec));
    else raw = Math.max(0, Number(t.cue_sec) || 0);
    return Number.isFinite(maxFirstHalf) ? Math.min(raw, maxFirstHalf) : raw;
  }

  function getAudibleEndSec(trackOrId, knownDur) {
    const t = typeof trackOrId === "object" && trackOrId ? trackOrId : byId.get(String(trackOrId || ""));
    if (typeof window !== "undefined" && window.ME_AUDIO && typeof window.ME_AUDIO.getAudibleEndSec === "function") {
      return window.ME_AUDIO.getAudibleEndSec(t || trackOrId, null, knownDur);
    }
    const dur = Number.isFinite(Number(knownDur)) && Number(knownDur) > 0
      ? Number(knownDur)
      : (Number(t && t.full_duration_sec) || Number(t && t.duration_sec) || 0);
    if (!t || !(dur > 0)) return 0;
    let effEnd = dur;
    if (t.has_mush === true && Number.isFinite(Number(t.mush_onset_sec)) && Number(t.mush_onset_sec) > 0) {
      const mushLim = Number(t.mush_onset_sec) + 3.0;
      if (mushLim > 12.0 && mushLim < effEnd) effEnd = mushLim;
    }
    const peaks = Array.isArray(t.peaks) ? t.peaks : null;
    if (!peaks || peaks.length < 16 || dur <= 6.0) return effEnd;
    const n = peaks.length;
    const maxBin = Math.min(n - 1, Math.max(0, Math.floor((effEnd / dur) * n) - 1));
    if (maxBin < 8) return effEnd;
    const activeSlice = [];
    const nonzero = [];
    for (let i = 0; i <= maxBin; i++) {
      const v = Number(peaks[i]) || 0;
      activeSlice.push(v);
      if (v > 2.0) nonzero.push(v);
    }
    const sample = (nonzero.length >= 6 ? nonzero : activeSlice).slice().sort((a, b) => a - b);
    const pct = (q) => {
      if (!sample.length) return 0;
      const pos = clamp(q, 0, 1) * (sample.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(sample.length - 1, lo + 1);
      return sample[lo] + (sample[hi] - sample[lo]) * (pos - lo);
    };
    const p80 = pct(0.80);
    const p50 = pct(0.50);
    if (p80 <= 5.0) return effEnd;
    const thr = clamp(Math.min(0.18 * p80, 0.45 * p50), 4.0, 22.0);
    const minBin = Math.max(3, Math.floor(0.22 * (maxBin + 1)));
    let last = maxBin;
    while (last > minBin) {
      const cur = activeSlice[last];
      const prev = activeSlice[last - 1];
      const nxt = last + 1 <= maxBin ? activeSlice[last + 1] : 0;
      if ((cur >= thr && (prev >= thr * 0.72 || nxt >= thr * 0.72)) || (0.5 * (cur + prev) >= thr)) break;
      last -= 1;
    }
    const audEnd = Math.min(effEnd, ((last + 1) / n) * dur);
    return effEnd - audEnd < 0.5 ? effEnd : Number(audEnd.toFixed(3));
  }

  function formatClock(sec, roundNearest = false) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const whole = roundNearest ? Math.max(0, Math.round(sec)) : Math.max(0, Math.floor(sec));
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function logPrivateTrackEvent(kind, track) {
    if (!track) return;
    const er = erasById.get(track.era);
    const eraLabel = (er && er.label) || track.era || "";
    const path = `${kind}/${track.id}`;
    const title = `${kind}: ${track.title} (${eraLabel})`;
    try {
      if (typeof window !== "undefined" && window.goatcounter && typeof window.goatcounter.count === "function") {
        window.goatcounter.count({ path, title, event: true });
        return;
      }
      const url = `https://billtribble-com.goatcounter.com/count?p=${encodeURIComponent(path)}&t=${encodeURIComponent(title)}&e=1`;
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(url);
      } else if (typeof Image !== "undefined") {
        const img = new Image();
        img.src = url;
      }
    } catch (_) {}
  }

  function meterHtml(label, val, col) {
    const v = Math.round(Number(val) || 0);
    return `
      <div>
        <div class="mp-meter-lbl"><span>${esc(label)}</span><strong>${v}</strong></div>
        <div class="mp-meter-track"><div class="mp-meter-fill" style="width:${Math.min(100, v)}%;background:${col}"></div></div>
      </div>`;
  }

  // Deterministic hash-seeded fallback waveform (0..100) from t.id + track dynamics when t.peaks isn't populated yet
  function getTrackPeaks(t) {
    if (!t) return [];
    if (Array.isArray(t.peaks) && t.peaks.length >= 16) {
      let maxVal = 0;
      for (let i = 0; i < t.peaks.length; i++) {
        const v = Number(t.peaks[i]) || 0;
        if (v > maxVal) maxVal = v;
      }
      const scale = maxVal > 0 && maxVal <= 1.05 ? 100 : 1;
      return t.peaks.map((v) => clamp(Math.round((Number(v) || 0) * scale), 4, 100));
    }
    if (fallbackPeaksCache.has(t.id)) return fallbackPeaksCache.get(t.id);

    const seedStr = String(t.id || t.title || "track");
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seedStr.length; i++) {
      h ^= seedStr.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    let state = h || 123456789;
    function nextRand() {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    }

    const energyNorm = clamp((Number(t.energy) || 5) / 10, 0.2, 1);
    const punch = clamp((Number(t.drum_complexity) || 35) / 100, 0.1, 0.95);
    const phaseA = nextRand() * Math.PI * 2;
    const phaseB = nextRand() * Math.PI * 2;
    const freqA = 2.2 + nextRand() * 2.6;
    const freqB = 5.5 + nextRand() * 4.5;

    const bars = new Array(DEFAULT_PEAK_BARS);
    for (let i = 0; i < DEFAULT_PEAK_BARS; i++) {
      const u = i / (DEFAULT_PEAK_BARS - 1);
      const intro = u < 0.08 ? 0.35 + 0.65 * (u / 0.08) : 1;
      const outro = u > 0.9 ? 0.3 + 0.7 * ((1 - u) / 0.1) : 1;
      const macro =
        0.58 +
        0.22 * Math.sin(u * freqA * Math.PI + phaseA) +
        0.14 * Math.sin(u * freqB * Math.PI + phaseB);
      const transient = (1 - punch * 0.55) + nextRand() * (0.42 + punch * 0.68);
      const raw = 100 * intro * outro * macro * transient * (0.62 + 0.38 * energyNorm);
      bars[i] = clamp(Math.round(raw), 10, 98);
    }
    fallbackPeaksCache.set(t.id, bars);
    return bars;
  }

  function getResampledBars(t, count) {
    const src = getTrackPeaks(t);
    if (!src.length || count <= 0) return [];
    const hasLivePeaks = Array.isArray(t.peaks) && t.peaks.length >= 16;
    const cacheKey = `${t.id}:${hasLivePeaks ? "p" : "f"}:${src.length}:${count}`;
    if (resampledBarsCache.has(cacheKey)) return resampledBarsCache.get(cacheKey);

    const out = new Array(count);
    const n = src.length;
    for (let i = 0; i < count; i++) {
      const a = (i * n) / count;
      const b = ((i + 1) * n) / count;
      const i0 = clamp(Math.floor(a), 0, n - 1);
      const i1 = clamp(Math.ceil(b) - 1, i0, n - 1);
      let mx = 0;
      let sum = 0;
      let cnt = 0;
      for (let j = i0; j <= i1; j++) {
        const v = src[j];
        if (v > mx) mx = v;
        sum += v;
        cnt++;
      }
      const mean = cnt > 0 ? sum / cnt : mx;
      out[i] = Math.round(mx * 0.65 + mean * 0.35);
    }
    if (resampledBarsCache.size > 64) resampledBarsCache.clear();
    resampledBarsCache.set(cacheKey, out);
    return out;
  }

  function getAutoPlayEnabled() {
    if (typeof window !== "undefined" && window.ME_AUDIO) {
      if (typeof window.ME_AUDIO.getAutoPlay === "function") {
        return Boolean(window.ME_AUDIO.getAutoPlay());
      }
      if (typeof window.ME_AUDIO.getPlaybackState === "function") {
        const st = window.ME_AUDIO.getPlaybackState();
        if (st && typeof st.autoPlay === "boolean") return st.autoPlay;
      }
    }
    return localAutoPlay;
  }

  function readPlaybackSnapshot(t) {
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    const st = ma && typeof ma.getPlaybackState === "function" ? ma.getPlaybackState() : null;
    const activeMatch = Boolean(st && st.trackId === t.id);
    const outgoingMatch = Boolean(!activeMatch && st && st.outgoingTrackId === t.id);

    const isPlaying = activeMatch
      ? Boolean(st.playing)
      : (outgoingMatch
        ? true
        : Boolean(
            (hooks && typeof hooks.playing === "function" && hooks.playing() === t.id) ||
            (ma && typeof ma.isPlaying === "function" && ma.isPlaying(t.id))
          ));
    const isPend = activeMatch && typeof st.pending === "boolean"
      ? st.pending
      : Boolean(hooks && typeof hooks.pending === "function" && hooks.pending() === t.id);

    const autoPlay = activeMatch && typeof st.autoPlay === "boolean"
      ? st.autoPlay
      : getAutoPlayEnabled();

    const hasFullAsset = Boolean(t.stream_url || t.mp3_320_url || t.mp3_url);
    const catalogFullDur = Number(t.full_duration_sec) || 0;
    const catalogClipDur = Number(t.duration_sec) || 22;

    let isFullTrack = hasFullAsset;
    let seekableDur = hasFullAsset
      ? (catalogFullDur || catalogClipDur)
      : catalogClipDur;
    let displayTotalDur = isFullTrack ? (catalogFullDur || catalogClipDur) : seekableDur;
    let currentTime = 0;

    if (activeMatch) {
      if (typeof st.isFullTrack === "boolean") {
        isFullTrack = st.isFullTrack;
      } else if (Number.isFinite(st.duration) && st.duration > catalogClipDur + 5) {
        isFullTrack = true;
      }
      if (Number.isFinite(st.duration) && st.duration > 0) {
        seekableDur = st.duration;
        displayTotalDur = st.duration;
      } else {
        seekableDur = isFullTrack ? (catalogFullDur || catalogClipDur) : catalogClipDur;
        displayTotalDur = seekableDur;
      }
      if (Number.isFinite(st.currentTime) && st.currentTime >= 0) {
        currentTime = st.currentTime;
      }
    } else if (outgoingMatch) {
      const outDur = Number(st.outgoingDuration) || catalogFullDur || catalogClipDur;
      isFullTrack = outDur > catalogClipDur + 5 || hasFullAsset;
      seekableDur = Math.max(1, outDur);
      displayTotalDur = seekableDur;
      if (Number.isFinite(st.outgoingCurrentTime) && st.outgoingCurrentTime >= 0) {
        currentTime = st.outgoingCurrentTime;
      }
    } else if (isPlaying && ma && typeof ma.activeVoice === "function") {
      const av = ma.activeVoice();
      if (av && av.trackId === t.id) {
        if (av.isHtmlFallback && av.htmlAudio) {
          const elDur = Number(av.htmlAudio.duration);
          if (Number.isFinite(elDur) && elDur > 0) {
            seekableDur = elDur;
            isFullTrack = elDur > catalogClipDur + 5;
            displayTotalDur = elDur;
          } else {
            isFullTrack = false;
            seekableDur = catalogClipDur;
            displayTotalDur = seekableDur;
          }
          if (Number.isFinite(av.htmlAudio.currentTime)) {
            currentTime = av.htmlAudio.currentTime;
          }
        } else {
          const ctxNow = typeof ma.ctxTime === "function" ? ma.ctxTime() : 0;
          const elapsed = Math.max(0, ctxNow - (av.barOriginCtxTime || 0));
          isFullTrack = false;
          seekableDur = catalogClipDur;
          displayTotalDur = seekableDur;
          currentTime = seekableDur > 0 ? (elapsed % seekableDur) : 0;
        }
      }
    } else if (!isFullTrack) {
      seekableDur = catalogClipDur;
      displayTotalDur = seekableDur;
    }

    const timelineDur = isFullTrack ? Math.max(1, displayTotalDur) : Math.max(1, seekableDur);

    const nowMs = typeof performance !== "undefined" ? performance.now() : 0;
    if (optimisticSeekTrackId === t.id && optimisticSeekSec !== null && nowMs < optimisticSeekUntilMs) {
      currentTime = clamp(optimisticSeekSec, 0, timelineDur);
    }

    const looping = activeMatch && typeof st.looping === "boolean"
      ? st.looping
      : (!autoPlay || !isFullTrack);

    let winStart = 0;
    let winEnd = Math.min(timelineDur, catalogClipDur);
    let hasPreviewWindow = false;

    const aiHasDropCue = Boolean(
      t.is_ai &&
      t.has_drop &&
      getPreviewStart(t) > 0.05
    );
    if (t.is_ai && !aiHasDropCue) {
      winStart = 0;
      winEnd = timelineDur;
      hasPreviewWindow = false;
    } else if (activeMatch && Number.isFinite(st.previewStart) && Number.isFinite(st.previewEnd) && st.previewEnd > st.previewStart) {
      winStart = clamp(st.previewStart, 0, timelineDur);
      winEnd = clamp(st.previewEnd, winStart, timelineDur);
      hasPreviewWindow = winEnd > winStart + 0.2 && (winStart > 0.05 || Boolean(looping));
    } else if (isFullTrack) {
      const cue = getPreviewStart(t);
      const pDur = Number(t.preview_dur_sec) || catalogClipDur;
      winStart = clamp(cue, 0, timelineDur);
      winEnd = clamp(winStart + pDur, winStart, timelineDur);
      hasPreviewWindow = timelineDur > pDur * 1.15 && winEnd > winStart + 0.5 && (winStart > 0.05 || Boolean(looping));
    } else {
      winStart = 0;
      winEnd = timelineDur;
      hasPreviewWindow = true;
    }

    const progressFrac = timelineDur > 0 ? clamp(currentTime / timelineDur, 0, 1) : 0;
    const rawMushOnset = Number(t && t.mush_onset_sec);
    const hasMush = Boolean(
      t &&
      t.has_mush === true &&
      Number.isFinite(rawMushOnset) &&
      rawMushOnset > 0 &&
      isFullTrack &&
      timelineDur > rawMushOnset + 4.2
    );
    const mushOnsetSec = hasMush ? rawMushOnset : null;
    const mushFadeStartSec = hasMush ? Math.min(timelineDur, rawMushOnset + 3.0) : null;
    const mushFrac = hasMush ? clamp(rawMushOnset / timelineDur, 0, 1) : null;
    const mushFadeFrac = hasMush ? clamp(mushFadeStartSec / timelineDur, 0, 1) : null;

    const autoMixWindow = ma && typeof ma.getAutoMixWindow === "function"
      ? ma.getAutoMixWindow(t.id)
      : (activeMatch && st && st.autoMixWindow ? st.autoMixWindow : null);
    const mixInWindow = activeMatch && st && st.mixInWindow && st.mixInWindow.enabled
      ? st.mixInWindow
      : null;

    return {
      isPlaying,
      isPend,
      autoPlay,
      isFullTrack,
      looping,
      showLoopMarkers: Boolean(looping),
      hasPreviewWindow,
      winStart,
      winEnd,
      currentTime,
      timelineDur,
      seekableDur: Math.max(1, seekableDur),
      displayTotalDur: Math.max(1, displayTotalDur),
      progressFrac,
      hasMush,
      mushOnsetSec,
      mushFadeStartSec,
      mushFrac,
      mushFadeFrac,
      autoMixWindow,
      mixInWindow,
    };
  }

  function resolveWavePalette() {
    if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
      return {
        primary: "rgb(94, 61, 198)",
        secondary: "rgb(106, 76, 156)",
        secondaryContainer: "rgb(232, 222, 248)",
        onCyanTonal: "rgb(21, 94, 117)",
        onSurface: "rgb(31, 31, 31)",
        onSurfaceVariant: "rgb(68, 71, 70)",
        outline: "rgb(116, 119, 117)",
        outlineVariant: "rgb(196, 199, 197)",
        surfaceVariant: "rgb(224, 227, 225)",
      };
    }
    const themeAttr = document.documentElement.getAttribute("data-theme") || "light";
    if (cachedPalette && cachedThemeKey === themeAttr) return cachedPalette;
    const cs = getComputedStyle(document.documentElement);
    const pick = (prop, fb) => (cs.getPropertyValue(prop) || "").trim() || fb;
    cachedThemeKey = themeAttr;
    cachedPalette = {
      primary: pick("--md-sys-color-primary", "rgb(94, 61, 198)"),
      secondary: pick("--md-sys-color-secondary", "rgb(106, 76, 156)"),
      secondaryContainer: pick("--md-sys-color-secondary-container", "rgb(232, 222, 248)"),
      onCyanTonal: pick("--md-sys-color-on-cyan-tonal", "rgb(21, 94, 117)"),
      onSurface: pick("--md-sys-color-on-surface", "rgb(31, 31, 31)"),
      onSurfaceVariant: pick("--md-sys-color-on-surface-variant", "rgb(68, 71, 70)"),
      outline: pick("--md-sys-color-outline", "rgb(116, 119, 117)"),
      outlineVariant: pick("--md-sys-color-outline-variant", "rgb(196, 199, 197)"),
      surfaceVariant: pick("--md-sys-color-surface-variant", "rgb(224, 227, 225)"),
    };
    return cachedPalette;
  }

  function formatWaveTimeText(snap) {
    if (isWaveScrubbing && scrubFrac !== null) {
      const target = scrubFrac * snap.timelineDur;
      return `${formatClock(target)} / ${formatClock(snap.timelineDur, true)}`;
    }
    if (waveHoverFrac !== null) {
      const hoverSec = waveHoverFrac * snap.timelineDur;
      return `${formatClock(hoverSec)} / ${formatClock(snap.timelineDur, true)}`;
    }
    if (snap.isPlaying || snap.currentTime > 0.05) {
      return `${formatClock(snap.currentTime)} / ${formatClock(snap.timelineDur, true)}`;
    }
    return formatClock(snap.displayTotalDur, true);
  }

  function drawRoundedRect(ctx, x, y, w, h, r) {
    const rad = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
    ctx.lineTo(x + rad, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
    ctx.lineTo(x, y + rad);
    ctx.quadraticCurveTo(x, y, x + rad, y);
    ctx.closePath();
  }

  function computeWaveTrackSpan(W) {
    const barStep = 3;
    const barW = 2;
    const sidePad = 8;
    const barCount = Math.max(24, Math.floor((W - sidePad * 2 + 1) / barStep));
    const totalBarsW = barCount * barStep - (barStep - barW);
    const startX = Math.floor((W - totalBarsW) * 0.5);
    return { barStep, barW, barCount, totalBarsW, startX };
  }

  function drawWaveformSurface(ctx, W, H, t, snap, pal, compact) {
    const { barStep, barW, barCount, totalBarsW, startX } = computeWaveTrackSpan(W);

    const splitY = Math.round(H * (compact ? 0.69 : 0.67));
    const gapY = compact ? 1.2 : 1.5;
    const vPad = compact ? 3.5 : 6;
    const maxUpperH = Math.max(compact ? 6 : 8, splitY - vPad - gapY * 0.5);
    const maxLowerH = Math.max(compact ? 3 : 4, H - vPad - splitY - gapY * 0.5);

    const w0 = snap.hasPreviewWindow ? clamp(snap.winStart / snap.timelineDur, 0, 1) : 0;
    const w1 = snap.hasPreviewWindow ? clamp(snap.winEnd / snap.timelineDur, w0, 1) : 0;
    const winX0 = startX + w0 * totalBarsW;
    const winX1 = startX + w1 * totalBarsW;

    // 1. Highlighted snippet / loop window backdrop
    if (snap.hasPreviewWindow && winX1 > winX0 + 2) {
      const fullSpan = w1 - w0 >= 0.98;
      if (snap.showLoopMarkers || !fullSpan) {
        const winPad = compact ? 2 : 3;
        ctx.save();
        ctx.fillStyle = pal.secondaryContainer;
        ctx.globalAlpha = snap.showLoopMarkers ? 0.36 : 0.18;
        drawRoundedRect(ctx, winX0, winPad, winX1 - winX0, H - winPad * 2, compact ? 4 : 5);
        ctx.fill();
        ctx.restore();
      }
    }

    const mixWin = snap.autoPlay && snap.autoMixWindow && snap.autoMixWindow.enabled ? snap.autoMixWindow : null;
    const mixStartFrac = mixWin ? clamp(mixWin.startSec / snap.timelineDur, 0, 1) : null;
    const mixEndFrac = mixWin ? clamp(mixWin.endSec / snap.timelineDur, mixStartFrac, 1) : null;
    const showMushCue = Boolean(snap.autoPlay && snap.hasMush && snap.mushFrac !== null);

    // 2. SoundCloud split upper + mirrored lower amplitude bars
    const bars = getResampledBars(t, barCount);
    const dispFrac = isWaveScrubbing && scrubFrac !== null ? scrubFrac : snap.progressFrac;
    const hasProgress = snap.isPlaying || dispFrac > 0.001;

    for (let i = 0; i < barCount; i++) {
      const barFrac = (i + 0.5) / barCount;
      const amp = bars[i] || 12;
      const x = startX + i * barStep;
      const uH = Math.max(compact ? 1.75 : 2, Math.round((amp / 100) * maxUpperH));
      const lH = Math.max(compact ? 1.25 : 1.5, Math.round((amp / 100) * maxLowerH));

      const played = hasProgress && barFrac <= dispFrac;
      const inWin = snap.hasPreviewWindow && barFrac >= w0 && barFrac <= w1;
      const inHover =
        waveHoverFrac !== null &&
        !isWaveScrubbing &&
        ((waveHoverFrac > dispFrac && barFrac > dispFrac && barFrac <= waveHoverFrac) ||
          (waveHoverFrac < dispFrac && barFrac >= waveHoverFrac && barFrac <= dispFrac));
      const inAutoMixZone = mixStartFrac !== null && mixEndFrac !== null && barFrac >= mixStartFrac && barFrac <= mixEndFrac;
      const pastAutoMixTail = mixEndFrac !== null && barFrac > mixEndFrac + 0.002;
      const inMushTaste = showMushCue && mixStartFrac !== null && barFrac >= snap.mushFrac && barFrac < mixStartFrac;

      let col = pal.onSurfaceVariant;
      let uAlpha = compact ? 0.32 : 0.30;
      let lAlpha = compact ? 0.15 : 0.14;

      if (played) {
        col = pal.primary;
        uAlpha = pastAutoMixTail ? 0.62 : 0.96;
        lAlpha = pastAutoMixTail ? 0.24 : 0.38;
      } else if (inHover) {
        col = pal.primary;
        uAlpha = 0.56;
        lAlpha = 0.22;
      } else if (inAutoMixZone) {
        col = pal.onCyanTonal;
        uAlpha = 0.44;
        lAlpha = 0.20;
      } else if (pastAutoMixTail) {
        col = pal.outline;
        uAlpha = 0.13;
        lAlpha = 0.06;
      } else if (inMushTaste) {
        col = pal.onSurfaceVariant;
        uAlpha = 0.21;
        lAlpha = 0.09;
      } else if (inWin) {
        col = pal.secondary;
        uAlpha = snap.showLoopMarkers ? 0.68 : 0.46;
        lAlpha = snap.showLoopMarkers ? 0.26 : 0.18;
      }

      ctx.fillStyle = col;
      ctx.globalAlpha = uAlpha;
      ctx.fillRect(x, splitY - gapY * 0.5 - uH, barW, uH);
      ctx.globalAlpha = lAlpha;
      ctx.fillRect(x, splitY + gapY * 0.5, barW, lH);
    }
    ctx.globalAlpha = 1;

    // 3. Loop brackets (when looping / preview-only) or subtle snippet cue tick (when Auto-Play ON)
    if (snap.hasPreviewWindow && winX1 > winX0 + 2) {
      if (snap.showLoopMarkers) {
        const bx0 = Math.round(winX0) + 0.5;
        const bx1 = Math.round(winX1) - 0.5;
        const cap = compact ? 3.5 : 4.5;
        const bPad = compact ? 2.5 : 3.5;
        ctx.save();
        ctx.strokeStyle = pal.secondary;
        ctx.globalAlpha = 0.92;
        ctx.lineWidth = compact ? 1.4 : 1.6;
        ctx.beginPath();
        // Left loop bracket [
        ctx.moveTo(bx0 + cap, bPad);
        ctx.lineTo(bx0, bPad);
        ctx.lineTo(bx0, H - bPad);
        ctx.lineTo(bx0 + cap, H - bPad);
        // Right loop bracket ]
        ctx.moveTo(bx1 - cap, bPad);
        ctx.lineTo(bx1, bPad);
        ctx.lineTo(bx1, H - bPad);
        ctx.lineTo(bx1 - cap, H - bPad);
        ctx.stroke();
        ctx.restore();
      } else if (w0 > 0.01) {
        const cx = Math.round(winX0) + 0.5;
        const cPad = compact ? 3 : 4;
        ctx.save();
        ctx.strokeStyle = pal.secondary;
        ctx.fillStyle = pal.secondary;
        ctx.globalAlpha = 0.72;
        ctx.lineWidth = compact ? 1.15 : 1.25;
        ctx.beginPath();
        ctx.moveTo(cx, cPad);
        ctx.lineTo(cx, H - cPad);
        ctx.stroke();
        // Subtle cue-in flag triangle at top of snippet start
        ctx.beginPath();
        ctx.moveTo(cx, compact ? 2.5 : 3.5);
        ctx.lineTo(cx + (compact ? 3.8 : 4.5), compact ? 4.6 : 6);
        ctx.lineTo(cx, compact ? 6.7 : 8.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    // 4. Hover scrub preview cursor
    if (waveHoverFrac !== null && !isWaveScrubbing) {
      const hx = Math.round(startX + waveHoverFrac * totalBarsW) + 0.5;
      const hPad = compact ? 2.5 : 3;
      ctx.save();
      ctx.strokeStyle = pal.onSurface;
      ctx.globalAlpha = 0.34;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, hPad);
      ctx.lineTo(hx, H - hPad);
      ctx.stroke();
      ctx.restore();
    }

    // 5. Live playhead needle
    if (hasProgress) {
      const px = clamp(startX + dispFrac * totalBarsW, startX + 1, startX + totalBarsW - 1);
      const nPad = compact ? 3 : 4;
      ctx.save();
      ctx.strokeStyle = pal.primary;
      ctx.fillStyle = pal.primary;
      ctx.lineWidth = compact ? 1.6 : 1.75;
      ctx.beginPath();
      ctx.moveTo(px, nPad);
      ctx.lineTo(px, H - nPad);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, compact ? 3.8 : 5, compact ? 2.0 : 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function prepareCanvas2d(canvasEl, minH = 10) {
    if (!canvasEl) return null;
    const rect = canvasEl.getBoundingClientRect();
    if (rect.width < 12 || rect.height < minH) return null;
    const dpr = Math.min(3, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    const pxW = Math.round(rect.width * dpr);
    const pxH = Math.round(rect.height * dpr);
    if (canvasEl.width !== pxW || canvasEl.height !== pxH) {
      canvasEl.width = pxW;
      canvasEl.height = pxH;
    }
    const ctx = canvasEl.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    return { ctx, W: rect.width, H: rect.height };
  }

  function formatAutoMixKindLabel(kind) {
    if (kind === "4x4") return "DJ blend";
    if (kind === "broken") return "Phrase fade";
    if (kind === "mush") return "Auto-fade";
    return "Crossfade";
  }

  function formatAutoMixMetaLabel(win) {
    if (!win) return "";
    const clock = formatClock(win.startSec);
    if (win.kind === "4x4" || win.kind === "broken") {
      const nBars = Math.max(1, Math.round(Number(win.bars) || (win.kind === "4x4" ? 5 : 1)));
      const barLbl = nBars === 1 ? "1 bar" : `${nBars} bars`;
      return `${barLbl} · ${clock}`;
    }
    if (win.kind === "ambient") {
      return `${Number(win.durationSec || 1.5).toFixed(1)}s · ${clock}`;
    }
    return clock;
  }

  function buildAutoMixZoneSvg(W, H, kind, compact, isMixIn) {
    const w = Math.max(6, W);
    const h = Math.max(10, H);
    const yTop = compact ? 2.2 : 3.2;
    const yBot = h - (compact ? 2.2 : 3.2);
    const capW = compact ? 5.0 : 6.5;
    const capH = compact ? 5.2 : 7.0;
    const xStart = 0.8;
    const xEnd = Math.max(xStart + 2, w - 0.8);
    const inStartX = (!isMixIn && kind === "mush") ? Math.max(xStart, xEnd - Math.max(4, (xEnd - xStart) * 0.38)) : xStart;

    if (isMixIn) {
      return `<svg class="mp-automix-svg" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" aria-hidden="true">
        <line class="mp-automix-cue-line" x1="${xStart}" y1="0" x2="${xStart}" y2="${h.toFixed(1)}" />
        <polygon class="mp-automix-cue-cap" points="0,0 ${capW.toFixed(1)},${(capH * 0.5).toFixed(1)} 0,${capH.toFixed(1)}" />
        <path class="mp-automix-slope-out" d="M ${xStart} ${yTop.toFixed(1)} L ${xEnd.toFixed(1)} ${yBot.toFixed(1)}" />
        <path class="mp-automix-slope-in" d="M ${xStart} ${yBot.toFixed(1)} L ${xEnd.toFixed(1)} ${yTop.toFixed(1)}" />
      </svg>`;
    }

    return `<svg class="mp-automix-svg" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" aria-hidden="true">
      <polygon class="mp-automix-wedge-out" points="${xStart},${yTop.toFixed(1)} ${xEnd.toFixed(1)},${yBot.toFixed(1)} ${xStart},${yBot.toFixed(1)}" />
      <line class="mp-automix-cue-line" x1="${xStart}" y1="0" x2="${xStart}" y2="${h.toFixed(1)}" />
      <polygon class="mp-automix-cue-cap" points="0,0 ${capW.toFixed(1)},${(capH * 0.5).toFixed(1)} 0,${capH.toFixed(1)}" />
      <path class="mp-automix-slope-out" d="M ${xStart} ${yTop.toFixed(1)} L ${xEnd.toFixed(1)} ${yBot.toFixed(1)}" />
      <path class="mp-automix-slope-in" d="M ${inStartX.toFixed(1)} ${yBot.toFixed(1)} L ${xEnd.toFixed(1)} ${yTop.toFixed(1)}" />
      <line class="mp-automix-end-line" x1="${xEnd.toFixed(1)}" y1="1.5" x2="${xEnd.toFixed(1)}" y2="${(h - 1.5).toFixed(1)}" />
    </svg>`;
  }

  function syncAutoMixOverlay(wrapEl, zoneEl, inZoneEl, tipEl, snap, compact) {
    if (!wrapEl) return;
    const rect = wrapEl.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 10) {
      if (zoneEl) zoneEl.hidden = true;
      if (inZoneEl) inZoneEl.hidden = true;
      if (tipEl) tipEl.hidden = true;
      return;
    }

    const span = computeWaveTrackSpan(rect.width);
    const vInset = compact ? 2.5 : 3.5;
    const zoneH = Math.max(10, rect.height - vInset * 2);
    const minRampPx = compact ? 9 : 13;

    // 1. Outgoing Rekordbox Mix-Out section (`[startSec .. endSec]`)
    const win = snap.autoPlay && snap.autoMixWindow && snap.autoMixWindow.enabled ? snap.autoMixWindow : null;
    let outStartFrac = null;
    let outZoneLeft = 0;
    let outZoneW = 0;

    if (zoneEl) {
      if (!win) {
        zoneEl.hidden = true;
        zoneEl.classList.remove("is-blending");
      } else {
        outStartFrac = clamp(win.startSec / snap.timelineDur, 0, 0.992);
        const outEndFrac = clamp(win.endSec / snap.timelineDur, outStartFrac, 1);
        const x0 = span.startX + outStartFrac * span.totalBarsW;
        const x1True = span.startX + outEndFrac * span.totalBarsW;
        const x1Vis = Math.min(span.startX + span.totalBarsW, Math.max(x1True, x0 + minRampPx));
        outZoneLeft = x0;
        outZoneW = Math.max(compact ? 6 : 8, x1Vis - x0);

        zoneEl.hidden = false;
        zoneEl.classList.toggle("is-blending", Boolean(win.blending));
        zoneEl.setAttribute("data-automix-kind", win.kind || "");
        zoneEl.setAttribute("data-automix-start", String(win.startSec));
        zoneEl.setAttribute("data-automix-end", String(win.endSec));
        zoneEl.style.left = `${outZoneLeft.toFixed(2)}px`;
        zoneEl.style.width = `${outZoneW.toFixed(2)}px`;
        zoneEl.style.top = `${vInset}px`;
        zoneEl.style.height = `${zoneH.toFixed(2)}px`;

        const sig = `${Math.round(outZoneW * 2)}|${Math.round(zoneH * 2)}|${win.kind || ""}|${compact ? 1 : 0}`;
        if (zoneEl._renderSig !== sig) {
          zoneEl._renderSig = sig;
          zoneEl.innerHTML = buildAutoMixZoneSvg(outZoneW, zoneH, win.kind, compact, false);
        }
      }
    }

    // 2. Live Incoming Mix-In section (`[inStartSec .. inEndSec]`) while actively blending into this track
    const inWin = !compact && snap.autoPlay && snap.mixInWindow && snap.mixInWindow.enabled ? snap.mixInWindow : null;
    let inStartFrac = null;
    let inEndFrac = null;

    if (inZoneEl) {
      if (!inWin) {
        inZoneEl.hidden = true;
        inZoneEl.classList.remove("is-blending");
      } else {
        inStartFrac = clamp(inWin.startSec / snap.timelineDur, 0, 0.98);
        inEndFrac = clamp(inWin.endSec / snap.timelineDur, inStartFrac, 1);
        const ix0 = span.startX + inStartFrac * span.totalBarsW;
        const ix1True = span.startX + inEndFrac * span.totalBarsW;
        const ix1Vis = Math.min(span.startX + span.totalBarsW, Math.max(ix1True, ix0 + minRampPx));
        const inW = Math.max(8, ix1Vis - ix0);

        inZoneEl.hidden = false;
        inZoneEl.classList.add("is-blending");
        inZoneEl.setAttribute("data-mixin-kind", inWin.kind || "");
        inZoneEl.style.left = `${ix0.toFixed(2)}px`;
        inZoneEl.style.width = `${inW.toFixed(2)}px`;
        inZoneEl.style.top = `${vInset}px`;
        inZoneEl.style.height = `${zoneH.toFixed(2)}px`;

        const inSig = `${Math.round(inW * 2)}|${Math.round(zoneH * 2)}|in:${inWin.kind || ""}`;
        if (inZoneEl._renderSig !== inSig) {
          inZoneEl._renderSig = inSig;
          inZoneEl.innerHTML = buildAutoMixZoneSvg(inW, zoneH, inWin.kind, false, true);
        }
      }
    }

    // 3. Hover Tooltip above the Rekordbox transition zone (never blocks click-to-seek)
    if (tipEl && !compact) {
      const leadFrac = Math.max(0.06, 22 / Math.max(80, span.totalBarsW));
      const hoveringOutZone = Boolean(
        win &&
        outStartFrac !== null &&
        waveHoverFrac !== null &&
        !isWaveScrubbing &&
        waveHoverFrac > 0.01 &&
        waveHoverFrac >= Math.max(EARLY_WAVE_HOVER_MAX_FRAC + 0.01, outStartFrac - leadFrac)
      );
      const hoveringInZone = Boolean(
        !hoveringOutZone &&
        inWin &&
        inStartFrac !== null &&
        inEndFrac !== null &&
        waveHoverFrac !== null &&
        !isWaveScrubbing &&
        waveHoverFrac > EARLY_WAVE_HOVER_MAX_FRAC &&
        waveHoverFrac >= inStartFrac - 0.02 &&
        waveHoverFrac <= inEndFrac + 0.04
      );

      if (!hoveringOutZone && !hoveringInZone) {
        tipEl.hidden = true;
      } else if (hoveringOutZone && win) {
        const kindLbl = formatAutoMixKindLabel(win.kind);
        const nextTitle = win.nextTrackTitle || "Next track";
        const metaLbl = formatAutoMixMetaLabel(win);
        const tipSig = `out|${kindLbl}|${nextTitle}|${metaLbl}`;
        if (tipEl._tipSig !== tipSig) {
          tipEl._tipSig = tipSig;
          tipEl.innerHTML = `<span class="mp-automix-tip-dot" aria-hidden="true"></span> <span class="mp-automix-tip-kind">${esc(kindLbl)} →</span> <strong class="mp-automix-tip-track">${esc(nextTitle)}</strong> <span class="mp-automix-tip-meta">· ${esc(metaLbl)}</span>`;
        }
        const rightOffset = clamp(rect.width - (outZoneLeft + outZoneW), 0, Math.max(0, rect.width - 180));
        tipEl.style.right = `${Math.round(rightOffset)}px`;
        tipEl.style.left = "auto";
        tipEl.style.maxWidth = `${Math.max(140, Math.round(rect.width - rightOffset))}px`;
        tipEl.hidden = false;
      } else if (hoveringInZone && inWin) {
        const fromTitle = inWin.fromTrackTitle || "Previous track";
        const tipSig = `in|${fromTitle}`;
        if (tipEl._tipSig !== tipSig) {
          tipEl._tipSig = tipSig;
          tipEl.innerHTML = `<span class="mp-automix-tip-dot" aria-hidden="true"></span> <span class="mp-automix-tip-kind">Blending in ←</span> <strong class="mp-automix-tip-track">${esc(fromTitle)}</strong>`;
        }
        tipEl.style.left = "0px";
        tipEl.style.right = "auto";
        tipEl.style.maxWidth = "";
        tipEl.hidden = false;
      }
    }
  }

  function syncWaveVisuals() {
    if (!cardEl || cardEl.hidden || !selectedId || !byId.has(selectedId)) return;
    const t = byId.get(selectedId);
    const canvas = cardEl.querySelector("#mp-waveform");
    const miniCanvas = cardEl.querySelector("#mp-mini-waveform");
    const wrapEl = cardEl.querySelector("#mp-wave-wrap");
    const miniWrapEl = cardEl.querySelector("#mp-mini-wave-wrap");
    const zoneEl = cardEl.querySelector("#mp-automix-zone");
    const inZoneEl = cardEl.querySelector("#mp-automix-in-zone");
    const tipEl = cardEl.querySelector("#mp-automix-tooltip");
    const miniZoneEl = cardEl.querySelector("#mp-mini-automix-zone");
    const timeEl = cardEl.querySelector("#mp-wave-time");
    const miniTimeEl = cardEl.querySelector("#mp-mini-wave-time");

    const snap = readPlaybackSnapshot(t);
    const autoBtn = cardEl.querySelector("#mp-autoplay-toggle");
    if (autoBtn) {
      const nextAutoTitle = buildAutoPlayTooltip(t, snap);
      if (autoBtn.title !== nextAutoTitle) autoBtn.title = nextAutoTitle;
    }

    const nextTxt = formatWaveTimeText(snap);
    [timeEl, miniTimeEl].forEach((el) => {
      if (el && el.textContent !== nextTxt) el.textContent = nextTxt;
    });
    const vNow = String(Math.round(snap.currentTime));
    const vMax = String(Math.round(snap.timelineDur));
    [wrapEl, miniWrapEl].forEach((el) => {
      if (!el) return;
      if (el.getAttribute("aria-valuenow") !== vNow) el.setAttribute("aria-valuenow", vNow);
      if (el.getAttribute("aria-valuemax") !== vMax) el.setAttribute("aria-valuemax", vMax);
    });

    const pal = resolveWavePalette();
    const nowPerf = typeof performance !== "undefined" ? performance.now() : 0;
    const isMorphing = nowPerf < collapseSyncUntilMs;

    if (collapsed || isMorphing) {
      const miniSurface = prepareCanvas2d(miniCanvas, 8);
      if (miniSurface) {
        drawWaveformSurface(miniSurface.ctx, miniSurface.W, miniSurface.H, t, snap, pal, true);
      }
      syncAutoMixOverlay(miniWrapEl, miniZoneEl, null, null, snap, true);
      if (collapsed && !isMorphing) return;
    }

    const expSurface = prepareCanvas2d(canvas, 8);
    if (!expSurface) return;
    drawWaveformSurface(expSurface.ctx, expSurface.W, expSurface.H, t, snap, pal, false);
    syncAutoMixOverlay(wrapEl, zoneEl, inZoneEl, tipEl, snap, false);
  }

  function stopWaveRaf() {
    if (waveRafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(waveRafId);
      waveRafId = null;
    }
  }

  function ensureWaveRaf() {
    if (typeof requestAnimationFrame !== "function") return;
    if (waveRafId !== null) return;
    function tick() {
      waveRafId = null;
      if (!cardEl || cardEl.hidden || !selectedId || !byId.has(selectedId)) return;
      if (typeof document !== "undefined" && document.hidden) return;
      const t = byId.get(selectedId);
      const snap = readPlaybackSnapshot(t);
      syncWaveVisuals();
      const nowMs = typeof performance !== "undefined" ? performance.now() : 0;
      if (snap.isPlaying || snap.isPend || isWaveScrubbing || nowMs < optimisticSeekUntilMs || nowMs < collapseSyncUntilMs) {
        waveRafId = requestAnimationFrame(tick);
      }
    }
    waveRafId = requestAnimationFrame(tick);
  }

  function buildTierActionsHtml(t) {
    const tier = resolveTier(t);
    if (tier === "A") {
      const links = t.links || {};
      const bcUrl = links.bandcamp || t.bandcamp_url || "https://billtribble.bandcamp.com/music";
      const platforms = [
        { key: "spotify", cls: "brand-spotify", label: "Listen on Spotify" },
        { key: "youtube_music", cls: "brand-ytmusic", label: "Listen on YouTube Music" },
        { key: "apple_music", cls: "brand-apple", label: "Listen on Apple Music" },
        { key: "youtube", cls: "brand-youtube", label: "Watch on YouTube" },
      ];
      const streamBtns = platforms
        .filter((p) => Boolean(links[p.key]))
        .map((p) => `<a class="stream-icon-btn ${p.cls}" href="${esc(links[p.key])}" target="_blank" rel="noopener noreferrer" aria-label="${esc(p.label)}" title="${esc(p.label)}">${BRAND_SVGS[p.key]}</a>`)
        .join("");
      return `
        <div class="player-actions">
          <div class="player-cta-row">
            <a class="btn" href="${esc(bcUrl)}" target="_blank" rel="noopener noreferrer">
              ${BRAND_SVGS.bandcamp}
              <span>Buy on Bandcamp</span>
            </a>
          </div>
          ${streamBtns ? `<div class="stream-strip">${streamBtns}</div>` : ""}
        </div>`;
    }

    if (tier === "B") {
      const mp3Url = t.mp3_320_url || t.mp3_url || "";
      const flacUrl = t.flac_url || "";
      const hasMp3 = Boolean(mp3Url);
      const hasFlac = Boolean(flacUrl);
      const safeBase = (t.title || t.id).replace(/[\\/:*?"<>|]/g, "");
      const safeMp3Filename = `Bill Tribble - ${safeBase}.mp3`;
      const safeFlacFilename = `Bill Tribble - ${safeBase}.flac`;
      const mp3Label = hasFlac ? "MP3" : "Download MP3";
      const flacLabel = hasMp3 ? "FLAC" : "Download FLAC";
      return `
        <div class="player-actions">
          <div class="player-cta-row">
            ${hasMp3 ? `<a class="btn" href="${esc(mp3Url)}" download="${esc(safeMp3Filename)}" target="_blank" rel="noopener noreferrer" data-dl-kind="track-download-mp3" title="Download MP3">${BRAND_SVGS.download}<span>${mp3Label}</span></a>` : ""}
            ${hasFlac ? `<a class="${hasMp3 ? "btn-secondary-pill" : "btn"}" href="${esc(flacUrl)}" download="${esc(safeFlacFilename)}" target="_blank" rel="noopener noreferrer" data-dl-kind="track-download-flac" title="Download lossless FLAC">${BRAND_SVGS.download}<span>${flacLabel}</span></a>` : ""}
          </div>
        </div>`;
    }

    // Tier C: Unreleased >= 2015 -> First-class in-app GM3 request sheet backed by Cloudflare D1 & Worker
    const sent = requestedIds.has(t.id);
    if (sent) {
      return `
        <div class="player-actions">
          <div class="req-confirm" id="mp-request-confirm" role="status" aria-live="polite">
            <span class="ms filled" aria-hidden="true">check_circle</span>
            <span>Request sent — Bill will be in touch!</span>
          </div>
        </div>`;
    }
    if (formOpenForId === t.id) {
      const busy = sendingId === t.id;
      return `
        <div class="player-actions">
          <form class="req-sheet req-form" id="mp-req-form" data-req-form="${esc(t.id)}" novalidate aria-labelledby="mp-req-heading">
            <div class="req-sheet-head">
              <span class="ms" aria-hidden="true">mail</span>
              <span id="mp-req-heading" class="req-sheet-title">Request track</span>
            </div>
            <input type="checkbox" name="botcheck" tabindex="-1" autocomplete="off" hidden />
            <div class="req-field">
              <label class="req-label" for="mp-req-email">Your email <span class="req-required" aria-hidden="true">*</span></label>
              <input
                id="mp-req-email"
                class="req-input ${reqError ? "is-invalid" : ""}"
                type="email"
                name="email"
                autocomplete="email"
                inputmode="email"
                required
                aria-required="true"
                aria-invalid="${reqError ? "true" : "false"}"
                ${reqError ? 'aria-describedby="mp-req-error"' : ""}
                placeholder="you@example.com"
                value="${esc(draftEmail)}"
                ${busy ? "disabled" : ""}
              />
            </div>
            <div class="req-field">
              <label class="req-label" for="mp-req-note">What is it for? <span class="req-opt">(DJ set, licensing, listening — optional)</span></label>
              <input
                id="mp-req-note"
                class="req-input"
                type="text"
                name="note"
                maxlength="500"
                placeholder="Optional note (DJ set, licensing, lossless…)"
                value="${esc(draftNote)}"
                ${busy ? "disabled" : ""}
              />
            </div>
            ${reqError ? `<div class="req-err" id="mp-req-error" role="alert">${esc(reqError)}</div>` : ""}
            <div class="req-actions">
              <button type="button" id="mp-req-cancel" class="req-cancel-btn" data-cancel-req="${esc(t.id)}" ${busy ? "disabled" : ""}>Cancel</button>
              <button type="submit" id="mp-req-submit" class="btn req-submit-btn" ${busy ? "disabled" : ""}>
                <span class="ms" aria-hidden="true">${busy ? "hourglass_top" : "send"}</span>
                <span>${busy ? "Sending…" : "Send request"}</span>
              </button>
            </div>
          </form>
        </div>`;
    }
    return `
      <div class="player-actions">
        <div class="player-cta-row">
          <button type="button" id="mp-request-btn" class="btn" data-request-track="${esc(t.id)}" aria-expanded="false">
            <span class="ms" aria-hidden="true">mail</span>
            <span>Request track</span>
          </button>
        </div>
      </div>`;
  }

  function buildAutoPlayTooltip(t, snap) {
    if (snap.hasMush && snap.mushOnsetSec !== null) {
      return snap.autoPlay
        ? `Auto-play on: plays 3s past ${formatClock(snap.mushOnsetSec)} tail mush, then fades to nearest similar track (turn off to hear full mush)`
        : "Auto-play off: playing 100% of track through all tail mush (click to enable Auto-play)";
    }
    const win = snap.autoMixWindow;
    if (snap.autoPlay && win && win.enabled && win.nextTrackTitle) {
      const kindLbl = formatAutoMixKindLabel(win.kind);
      const metaLbl = formatAutoMixMetaLabel(win);
      return `Auto-play on: ${kindLbl} → ${win.nextTrackTitle} (${metaLbl})`;
    }
    if (t && t.is_ai) {
      return snap.autoPlay
        ? "Auto-play on: plays full track & crossfades to nearest similar AI track (click to loop full track)"
        : "Auto-play off: playing & looping full track (click to enable Auto-play)";
    }
    return snap.autoPlay
      ? "Auto-play on: plays full track & beat-blends to nearest similar track (click to loop snippet)"
      : "Auto-play off: looping snippet window (click to enable Auto-play)";
  }

  function syncInPlaceButtons(t, snap) {
    cardEl.querySelectorAll("[data-player-play]").forEach((playBtn) => {
      playBtn.classList.toggle("is-playing", snap.isPlaying);
      playBtn.setAttribute("aria-label", snap.isPlaying ? "Pause" : "Play");
      playBtn.title = snap.isPlaying ? "Pause (Space)" : "Play (Space)";
      const ic = playBtn.querySelector(".ms");
      if (ic) ic.textContent = snap.isPlaying ? "pause" : snap.isPend ? "hourglass_top" : "play_arrow";
    });
    const isStar = starred.has(t.id);
    cardEl.querySelectorAll("[data-player-star]").forEach((starBtn) => {
      starBtn.classList.toggle("is-starred", isStar);
      starBtn.setAttribute("aria-pressed", String(isStar));
      starBtn.setAttribute("aria-label", isStar ? "Unstar track" : "Star track");
      starBtn.title = isStar ? "Remove star" : "Star track";
    });
    const autoBtn = cardEl.querySelector("#mp-autoplay-toggle");
    if (autoBtn) {
      autoBtn.classList.toggle("is-active", snap.autoPlay);
      autoBtn.setAttribute("aria-pressed", String(snap.autoPlay));
      autoBtn.title = buildAutoPlayTooltip(t, snap);
      const ic = autoBtn.querySelector(".ms");
      if (ic) ic.textContent = snap.autoPlay ? "playlist_play" : "repeat";
    }
    const copyBtn = cardEl.querySelector("#mp-copy-link");
    if (copyBtn) {
      const isCopied = copiedForId === t.id;
      copyBtn.classList.toggle("is-copied", isCopied);
      copyBtn.setAttribute("aria-label", isCopied ? "Link copied" : "Copy direct link to track");
      const ic = copyBtn.querySelector(".ms");
      const lbl = copyBtn.querySelector(".mp-copy-lbl");
      if (ic) ic.textContent = isCopied ? "check" : "link";
      if (lbl) lbl.textContent = isCopied ? "Copied" : "Copy link";
    }
  }

  function syncCollapseStateDom(isReqSheetOpen) {
    if (!cardEl) return;
    cardEl.classList.toggle("is-collapsed", collapsed);
    cardEl.classList.toggle("mp-collapsed", collapsed);
    cardEl.classList.toggle("is-requesting", Boolean(isReqSheetOpen));
    const miniShell = cardEl.querySelector("#mp-mini-shell");
    const expandShell = cardEl.querySelector("#mp-expand-shell");
    if (miniShell) {
      miniShell.setAttribute("aria-hidden", collapsed ? "false" : "true");
      if ("inert" in miniShell) miniShell.inert = !collapsed;
      if (!collapsed) {
        const miniWave = miniShell.querySelector("#mp-mini-wave-wrap");
        if (miniWave) miniWave.classList.remove("is-early-hover");
      }
    }
    if (expandShell) {
      expandShell.setAttribute("aria-hidden", collapsed ? "true" : "false");
      if ("inert" in expandShell) expandShell.inert = collapsed;
      if (collapsed) {
        const expWave = expandShell.querySelector("#mp-wave-wrap");
        if (expWave) expWave.classList.remove("is-early-hover");
      }
    }
  }

  function setCollapsedState(nextCollapsed, opts = {}) {
    const nextVal = Boolean(nextCollapsed);
    const changed = collapsed !== nextVal;
    const prevActive = typeof document !== "undefined" ? document.activeElement : null;
    const hadKeyboardFocus = Boolean(
      opts.preserveKeyboardFocus &&
      prevActive &&
      cardEl &&
      cardEl.contains(prevActive)
    );
    collapsed = nextVal;
    waveHoverFrac = null;
    saveCollapsed();
    if (changed && typeof performance !== "undefined") {
      collapseSyncUntilMs = performance.now() + COLLAPSE_ANIM_MS;
    }
    render();
    if (changed) {
      ensureWaveRaf();
      if (hadKeyboardFocus && cardEl) {
        const targetBtn = cardEl.querySelector(collapsed ? "#mp-expand" : "#mp-collapse");
        if (targetBtn && typeof targetBtn.focus === "function") {
          try { targetBtn.focus({ preventScroll: true }); } catch (_) { targetBtn.focus(); }
        }
      }
      if (hooks && typeof hooks.onCollapseChange === "function") {
        setTimeout(() => {
          if (hooks && typeof hooks.onCollapseChange === "function") hooks.onCollapseChange(collapsed);
        }, COLLAPSE_ANIM_MS + 16);
      }
    }
  }

  function render() {
    if (!cardEl || !hooks) return;
    if (!selectedId || !byId.has(selectedId)) {
      cardEl.hidden = true;
      cardEl.classList.remove("is-requesting", "is-collapsed", "mp-collapsed");
      lastRenderedTrackId = null;
      lastRenderedCollapsed = null;
      lastRenderedFormState = "";
      stopWaveRaf();
      return;
    }
    const t = byId.get(selectedId);
    const er = erasById.get(t.era);
    const eraLabel = er ? `${er.label} (${er.sublabel})` : t.era;
    const snap = readPlaybackSnapshot(t);
    const isPlaying = snap.isPlaying;
    const isPend = snap.isPend;
    const isStar = starred.has(t.id);
    const isReqSheetOpen = !collapsed && formOpenForId === t.id && !requestedIds.has(t.id);
    const formStateKey = `${formOpenForId || ""}|${sendingId || ""}|${reqError}|${requestedIds.has(t.id) ? 1 : 0}|${infoOpen ? 1 : 0}`;

    if (lastRenderedTrackId === t.id && lastRenderedFormState === formStateKey) {
      const collapsedFlipped = lastRenderedCollapsed !== collapsed;
      lastRenderedCollapsed = collapsed;
      syncCollapseStateDom(isReqSheetOpen);
      syncInPlaceButtons(t, snap);
      syncWaveVisuals();
      const nowPerf = typeof performance !== "undefined" ? performance.now() : 0;
      if (isPlaying || isPend || isWaveScrubbing || collapsedFlipped || nowPerf < collapseSyncUntilMs) {
        ensureWaveRaf();
      } else {
        stopWaveRaf();
      }
      return;
    }

    cardEl.hidden = false;

    const released = isReleased(t);
    const sketch = isSketch(t);
    const wip = isWorkInProgress(t);
    const clusterName = t.cluster_label || "Unclassified";
    const eraShort = t.is_ai ? String(t.year || "2025") : (er ? er.label : t.era);
    const eraLong = t.is_ai ? `Gen AI (${t.year || "2025"})` : eraLabel;
    const metaShort = `${eraShort} · ${clusterName}`;
    const metaFull = `${eraLong} · ${clusterName}${wip ? " · Work in progress" : ""}`;
    const trackNote = getTrackNote(t);
    const timeReadout = formatWaveTimeText(snap);

    const prevFocusedId =
      typeof document !== "undefined" &&
      document.activeElement &&
      cardEl.contains(document.activeElement) &&
      document.activeElement.id
        ? document.activeElement.id
        : "";

    let miniShell = cardEl.querySelector("#mp-mini-shell");
    let expandInner = cardEl.querySelector("#mp-expand-inner");

    if (!miniShell || !expandInner) {
      cardEl.innerHTML = `
        <div id="mp-mini-shell" class="mp-mini-shell" aria-hidden="${collapsed ? "false" : "true"}">
          <div class="mp-shell-inner">
            <div class="mp-mini-rows">
              <div class="mp-mini-top">
                <div class="mp-mini-transport">
                  <button type="button" class="btn-tonal mp-play ${isPlaying ? "is-playing" : ""}" id="mp-mini-play" data-player-play="${esc(t.id)}" aria-label="${isPlaying ? "Pause" : "Play"}" title="${isPlaying ? "Pause (Space)" : "Play (Space)"}">
                    <span class="ms filled">${isPlaying ? "pause" : isPend ? "hourglass_top" : "play_arrow"}</span>
                  </button>
                  <div class="mp-mini-skip-group" role="group" aria-label="Skip between similar tracks">
                    <button type="button" class="icon-btn mp-mini-skip-btn" id="mp-mini-prev" data-player-prev="1" aria-label="Previous similar track" title="Previous similar track">
                      <span class="ms" aria-hidden="true">skip_previous</span>
                    </button>
                    <button type="button" class="icon-btn mp-mini-skip-btn" id="mp-mini-next" data-player-next="1" aria-label="Next similar track" title="Next similar track">
                      <span class="ms" aria-hidden="true">skip_next</span>
                    </button>
                  </div>
                </div>
                <div class="mp-mini-title-wrap">
                  <span class="mp-mini-title" id="mp-mini-title-text" title="${esc(t.title)}">${esc(t.title)}</span>
                </div>
                <div class="mp-mini-actions">
                  <button type="button" class="star-btn mp-mini-star-btn ${isStar ? "is-starred" : ""}" id="mp-mini-star" data-player-star="${esc(t.id)}" aria-pressed="${isStar}" aria-label="${isStar ? "Unstar track" : "Star track"}" title="${isStar ? "Remove star" : "Star track"}">
                    <span class="ms">star</span>
                  </button>
                  <button type="button" class="icon-btn mp-expand-btn" id="mp-expand" aria-label="Expand player" title="Expand player">
                    <span class="ms">expand_less</span>
                  </button>
                </div>
              </div>
              <div class="mp-mini-wave-row">
                <div class="mp-wave-wrap mp-mini-wave-wrap" id="mp-mini-wave-wrap" data-wave-wrap="mini" role="slider" tabindex="0" aria-label="Seek ${esc(t.title)}" aria-valuemin="0" aria-valuemax="${Math.round(snap.timelineDur)}" aria-valuenow="${Math.round(snap.currentTime)}" title="${esc(t.title)} — click or drag to seek">
                  <canvas id="mp-mini-waveform" class="mp-wave-canvas mp-mini-wave-canvas" aria-hidden="true"></canvas>
                  <div id="mp-mini-automix-zone" class="mp-automix-zone mp-mini-automix-zone" hidden aria-hidden="true"></div>
                  <button type="button" class="mp-wave-restart-btn mp-mini-wave-restart-btn" id="mp-mini-wave-restart" data-player-restart="${esc(t.id)}" aria-label="Restart track from 0:00" title="Restart track from 0:00">
                    <span class="ms filled" aria-hidden="true">skip_previous</span>
                    <span>0:00</span>
                  </button>
                  <div id="mp-mini-wave-time" class="mp-wave-time mp-mini-wave-time">${esc(timeReadout)}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div id="mp-expand-shell" class="mp-expand-shell" aria-hidden="${collapsed ? "true" : "false"}">
          <div id="mp-expand-inner" class="mp-shell-inner"></div>
        </div>`;
      miniShell = cardEl.querySelector("#mp-mini-shell");
      expandInner = cardEl.querySelector("#mp-expand-inner");
    } else {
      const miniPlayBtn = miniShell.querySelector("#mp-mini-play");
      if (miniPlayBtn) miniPlayBtn.setAttribute("data-player-play", t.id);
      const miniStarBtn = miniShell.querySelector("#mp-mini-star");
      if (miniStarBtn) miniStarBtn.setAttribute("data-player-star", t.id);
      const miniRestartBtn = miniShell.querySelector("#mp-mini-wave-restart");
      if (miniRestartBtn) miniRestartBtn.setAttribute("data-player-restart", t.id);
      const miniTitleEl = miniShell.querySelector("#mp-mini-title-text");
      if (miniTitleEl) {
        if (miniTitleEl.textContent !== t.title) miniTitleEl.textContent = t.title;
        if (miniTitleEl.title !== t.title) miniTitleEl.title = t.title;
      }
      const miniWaveWrap = miniShell.querySelector("#mp-mini-wave-wrap");
      if (miniWaveWrap) {
        miniWaveWrap.setAttribute("aria-label", `Seek ${t.title}`);
        miniWaveWrap.title = `${t.title} — click or drag to seek`;
      }
    }

    expandInner.innerHTML = `
      <div class="mp-head">
        <div class="mp-head-bar">
          <button type="button" class="btn-tonal mp-play ${isPlaying ? "is-playing" : ""}" data-player-play="${esc(t.id)}" aria-label="${isPlaying ? "Pause" : "Play"}" title="${isPlaying ? "Pause (Space)" : "Play (Space)"}">
            <span class="ms filled">${isPlaying ? "pause" : isPend ? "hourglass_top" : "play_arrow"}</span>
          </button>
          <div class="mp-head-actions">
            <button type="button" class="icon-btn mp-info-btn ${infoOpen ? "is-active" : ""}" id="mp-info-toggle" aria-expanded="${infoOpen}" aria-controls="mp-info-panel" aria-label="Musical analysis details" title="${infoOpen ? "Hide musical analysis" : "Show sonic profile & harmonic analysis"}">
              <span class="ms">info</span>
            </button>
            <button type="button" class="star-btn ${isStar ? "is-starred" : ""}" data-player-star="${esc(t.id)}" aria-pressed="${isStar}" aria-label="${isStar ? "Unstar track" : "Star track"}" title="${isStar ? "Remove star" : "Star track"}">
              <span class="ms">star</span>
            </button>
            <button type="button" class="icon-btn" id="mp-collapse" aria-label="Collapse player" title="Collapse to mini bar">
              <span class="ms">expand_more</span>
            </button>
          </div>
        </div>
        <div class="mp-titles">
          <div id="mp-title" class="mp-name mp-title" title="${esc(t.title)}">${esc(t.title)}</div>
          <div class="mp-meta" title="${esc(metaFull)}"><span class="mp-meta-text">${esc(metaShort)}</span></div>
          ${trackNote ? `<p class="mp-track-note">${esc(trackNote)}</p>` : ""}
        </div>
      </div>
      <div class="mp-wave-section">
        <div class="mp-wave-wrap" id="mp-wave-wrap" data-wave-wrap="expanded" role="slider" tabindex="0" aria-label="Track waveform seek" aria-valuemin="0" aria-valuemax="${Math.round(snap.timelineDur)}" aria-valuenow="${Math.round(snap.currentTime)}">
          <canvas id="mp-waveform" class="mp-wave-canvas" aria-hidden="true"></canvas>
          <div id="mp-automix-in-zone" class="mp-automix-zone mp-automix-in-zone" hidden aria-hidden="true"></div>
          <div id="mp-automix-zone" class="mp-automix-zone" hidden aria-hidden="true"></div>
          <div id="mp-automix-tooltip" class="mp-automix-tooltip" role="tooltip" hidden aria-hidden="true"></div>
          <button type="button" class="mp-wave-restart-btn" id="mp-wave-restart" data-player-restart="${esc(t.id)}" aria-label="Restart track from 0:00" title="Restart track from 0:00">
            <span class="ms filled" aria-hidden="true">skip_previous</span>
            <span>0:00</span>
          </button>
          <div id="mp-wave-time" class="mp-wave-time">${esc(timeReadout)}</div>
        </div>
        ${buildPlayerMetaPillsHtml(t, { released, sketch, wip, er })}
        <div class="mp-transport-row">
          <div class="mp-skip-group" role="group" aria-label="Skip between similar tracks">
            <button type="button" class="mp-ctrl-btn mp-skip-btn" id="mp-prev-track" data-player-prev="1" aria-label="Previous similar track" title="Previous similar track">
              <span class="ms" aria-hidden="true">skip_previous</span>
            </button>
            <button type="button" class="mp-ctrl-btn mp-skip-btn" id="mp-next-track" data-player-next="1" aria-label="Next similar track" title="Next similar track">
              <span class="ms" aria-hidden="true">skip_next</span>
            </button>
          </div>
          <button type="button" class="mp-ctrl-btn ${copiedForId === t.id ? "is-copied" : ""}" id="mp-copy-link" data-player-copy-link="${esc(t.id)}" aria-label="${copiedForId === t.id ? "Link copied" : "Copy direct link to track"}" title="Copy direct link that opens &amp; plays this track">
            <span class="ms">${copiedForId === t.id ? "check" : "link"}</span>
            <span class="mp-copy-lbl">${copiedForId === t.id ? "Copied" : "Copy link"}</span>
          </button>
          <button type="button" class="mp-ctrl-btn ${snap.autoPlay ? "is-active" : ""}" id="mp-autoplay-toggle" data-player-autoplay="1" aria-pressed="${snap.autoPlay}" aria-label="Auto-play similar tracks" title="${esc(buildAutoPlayTooltip(t, snap))}">
            <span class="ms">${snap.autoPlay ? "playlist_play" : "repeat"}</span>
            <span>Auto-play</span>
          </button>
        </div>
      </div>
      <div id="mp-info-panel" class="mp-info-panel" ${infoOpen ? "" : "hidden"}>
        ${trackNote ? `<div class="mp-info-note">${esc(trackNote)}</div>` : ""}
        <div class="mp-info-header">
          <span class="badge ${energyBadgeCls(t.energy)}" title="Energy level (1–10)">E${t.energy}/10</span>
          ${Array.isArray(t.discogs_styles) && t.discogs_styles.length ? `
          <div class="mp-discogs-line">
            <span class="mp-discogs-styles">${esc(t.discogs_styles.join(" · "))}</span>
            ${Array.isArray(t.mood_tags) && t.mood_tags.length ? `<span class="mp-discogs-moods">${esc(t.mood_tags.join(" · "))}</span>` : ""}
          </div>` : (t.harmony_tag || t.rhythm_tag ? `
          <div class="mp-discogs-line">
            <span class="mp-discogs-styles">${esc([t.harmony_tag, t.rhythm_tag].filter(Boolean).join(" · "))}</span>
          </div>` : "")}
        </div>
        <div class="mp-meters">
          ${meterHtml("Harmonic complexity", t.harmonic_complexity, "var(--c5)")}
          ${meterHtml("Chord richness", t.chord_richness, "var(--c1)")}
          ${meterHtml("Harmonic motion", t.harmonic_motion, "var(--c2)")}
          ${meterHtml("Drum complexity", t.drum_complexity, "var(--c3)")}
        </div>
      </div>
      ${buildTierActionsHtml(t)}`;

    lastRenderedTrackId = t.id;
    lastRenderedCollapsed = collapsed;
    lastRenderedFormState = formStateKey;
    syncCollapseStateDom(isReqSheetOpen);
    syncInPlaceButtons(t, snap);
    observeWaveWrap();
    syncWaveVisuals();
    if (!collapsed && (prevFocusedId === "mp-prev-track" || prevFocusedId === "mp-next-track")) {
      const restoreEl = cardEl.querySelector(`#${prevFocusedId}`);
      if (restoreEl && typeof restoreEl.focus === "function") {
        try { restoreEl.focus({ preventScroll: true }); } catch (_) {}
      }
    }
    const nowPerf = typeof performance !== "undefined" ? performance.now() : 0;
    if (isPlaying || isPend || nowPerf < collapseSyncUntilMs) ensureWaveRaf();
    else stopWaveRaf();
  }

  function observeWaveWrap() {
    if (!waveResizeObserver || !cardEl) return;
    waveResizeObserver.disconnect();
    cardEl.querySelectorAll("[data-wave-wrap]").forEach((wrapEl) => {
      waveResizeObserver.observe(wrapEl);
    });
  }

  function fracFromPointerEvent(wrapEl, ev) {
    const rect = wrapEl.getBoundingClientRect();
    const span = computeWaveTrackSpan(rect.width);
    const usable = Math.max(12, span.totalBarsW);
    return clamp((ev.clientX - rect.left - span.startX) / usable, 0, 1);
  }

  function seekToFraction(frac, opts = {}) {
    if (!selectedId || !byId.has(selectedId)) return;
    const t = byId.get(selectedId);
    const clamped = clamp(Number(frac) || 0, 0, 1);
    const snap = readPlaybackSnapshot(t);
    const targetSec = clamped * snap.seekableDur;

    optimisticSeekTrackId = t.id;
    optimisticSeekSec = targetSec;
    optimisticSeekUntilMs = (typeof performance !== "undefined" ? performance.now() : 0) + 320;

    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (!snap.isPlaying && !snap.isPend && !opts.dragging) {
      if (ma && typeof ma.playTrack === "function") {
        ma.playTrack(t.id, { startSec: targetSec, isManual: true });
        if (typeof ma.seek !== "function" && typeof ma.activeVoice === "function") {
          const av = ma.activeVoice();
          if (av && av.trackId === t.id && av.htmlAudio) {
            try { av.htmlAudio.currentTime = targetSec; } catch (_) {}
          }
        }
      } else if (ma && typeof ma.seek === "function") {
        if (hooks && typeof hooks.onPlayToggle === "function") hooks.onPlayToggle(t.id);
        ma.seek(targetSec);
      } else if (hooks && typeof hooks.onPlayToggle === "function") {
        hooks.onPlayToggle(t.id);
      }
    } else if (ma && typeof ma.seek === "function") {
      ma.seek(targetSec);
    } else if (ma && typeof ma.activeVoice === "function") {
      const av = ma.activeVoice();
      if (av && av.trackId === t.id && av.htmlAudio) {
        try { av.htmlAudio.currentTime = targetSec; } catch (_) {}
      }
    }
    syncWaveVisuals();
    ensureWaveRaf();
  }

  function handleRestartTrack(tid) {
    if (!tid || !byId.has(tid)) return;
    optimisticSeekTrackId = tid;
    optimisticSeekSec = 0;
    optimisticSeekUntilMs = (typeof performance !== "undefined" ? performance.now() : 0) + 320;

    const t = byId.get(tid);
    const snap = readPlaybackSnapshot(t);
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;

    if (!snap.isPlaying && !snap.isPend) {
      if (ma && typeof ma.playTrack === "function") {
        ma.playTrack(tid, { startSec: 0, fromStart: true, isManual: true });
        if (typeof ma.restart !== "function" && typeof ma.activeVoice === "function") {
          const av = ma.activeVoice();
          if (av && av.trackId === tid && av.htmlAudio) {
            try { av.htmlAudio.currentTime = 0; } catch (_) {}
          }
        }
      } else if (ma && typeof ma.restart === "function") {
        ma.restart();
      } else if (hooks && typeof hooks.onPlayToggle === "function") {
        hooks.onPlayToggle(tid);
      }
    } else if (ma && typeof ma.restart === "function") {
      ma.restart();
    } else if (ma && typeof ma.seek === "function") {
      ma.seek(0);
    } else if (ma && typeof ma.activeVoice === "function") {
      const av = ma.activeVoice();
      if (av && av.trackId === tid && av.htmlAudio) {
        try { av.htmlAudio.currentTime = 0; } catch (_) {}
      }
    }
    syncWaveVisuals();
    ensureWaveRaf();
  }

  function handleSkipSimilar(dir) {
    if (typeof window !== "undefined") {
      if (window.ME_EVENTS && typeof window.ME_EVENTS.markPlayIntent === "function") {
        try { window.ME_EVENTS.markPlayIntent("manual"); } catch (_) {}
      }
      const ma = window.ME_AUDIO;
      if (ma) {
        if (dir < 0 && typeof ma.prevSimilarTrack === "function") {
          return ma.prevSimilarTrack();
        }
        if (dir > 0 && typeof ma.nextSimilarTrack === "function") {
          return ma.nextSimilarTrack();
        }
      }
    }
    return null;
  }

  function handleToggleAutoPlay() {
    const next = !getAutoPlayEnabled();
    localAutoPlay = next;
    saveLocalAutoPlay();
    if (typeof window !== "undefined" && window.ME_AUDIO && typeof window.ME_AUDIO.setAutoPlay === "function") {
      window.ME_AUDIO.setAutoPlay(next);
    }
    render();
  }

  function buildTrackShareUrl(tid) {
    const targetId = String(tid || selectedId || "");
    if (!targetId) return "";
    if (typeof window === "undefined" || !window.location) {
      return `?track=${encodeURIComponent(targetId)}`;
    }
    const u = new URL(window.location.href);
    u.search = "";
    u.hash = "";
    u.searchParams.set("track", targetId);
    return u.toString();
  }

  async function copyTextToClipboard(text) {
    if (!text) return false;
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {}
    }
    if (typeof document !== "undefined" && document.body) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.pointerEvents = "none";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (_) {}
      document.body.removeChild(ta);
      return ok;
    }
    return false;
  }

  async function handleCopyTrackLink(tid) {
    if (!tid || !byId.has(tid)) return;
    const shareUrl = buildTrackShareUrl(tid);
    if (!shareUrl) return;
    if (typeof window !== "undefined" && window.history && typeof window.history.replaceState === "function") {
      try { window.history.replaceState(null, "", shareUrl); } catch (_) {}
    }
    await copyTextToClipboard(shareUrl);
    logPrivateTrackEvent("track-copy-link", byId.get(tid));
    copiedForId = tid;
    if (copiedTimer) clearTimeout(copiedTimer);
    render();
    copiedTimer = setTimeout(() => {
      copiedTimer = null;
      if (copiedForId === tid) {
        copiedForId = null;
        render();
      }
    }, 1800);
  }

  function handleRequestTrack(t) {
    if (!t || requestedIds.has(t.id)) return;
    if (!draftEmail) {
      draftEmail = loadSavedRequestEmail();
    }
    reqError = "";
    formOpenForId = t.id;
    if (collapsed) {
      collapsed = false;
      saveCollapsed();
    }
    render();
    if (cardEl) {
      const formEl = cardEl.querySelector("#mp-req-form");
      if (formEl && typeof formEl.scrollIntoView === "function") {
        try { formEl.scrollIntoView({ block: "nearest" }); } catch (_) {}
      }
      const emailInput = cardEl.querySelector("#mp-req-email");
      if (emailInput) {
        try { emailInput.focus({ preventScroll: true }); } catch (_) { emailInput.focus(); }
      }
    }
  }

  function cancelRequestForm() {
    formOpenForId = null;
    reqError = "";
    render();
    const reqBtn = cardEl && cardEl.querySelector("#mp-request-btn");
    if (reqBtn) {
      try { reqBtn.focus({ preventScroll: true }); } catch (_) {}
    }
  }

  async function submitRequestForm(formEl) {
    const tid = formEl.getAttribute("data-req-form");
    const t = byId.get(tid);
    if (!t || sendingId) return;
    const fd = new FormData(formEl);
    if (fd.get("botcheck")) {
      requestedIds.add(t.id);
      formOpenForId = null;
      render();
      return;
    }
    const emailInputEl = formEl.querySelector('input[name="email"]');
    const visitorEmail = String(fd.get("email") || "").trim();
    const note = String(fd.get("note") || "").trim().slice(0, 500);
    draftEmail = visitorEmail;
    draftNote = note;

    if (!visitorEmail) {
      reqError = "Please enter your email address.";
      render();
      const el = cardEl && cardEl.querySelector("#mp-req-email");
      if (el) el.focus();
      return;
    }
    const html5Valid = emailInputEl && typeof emailInputEl.checkValidity === "function"
      ? emailInputEl.checkValidity()
      : true;
    if (!html5Valid || !REQ_EMAIL_RE.test(visitorEmail) || /[<>]/.test(visitorEmail) || visitorEmail.length > 254) {
      reqError = "Please enter a valid email address (e.g. you@example.com).";
      render();
      const el = cardEl && cardEl.querySelector("#mp-req-email");
      if (el) el.focus();
      return;
    }

    reqError = "";
    sendingId = t.id;
    render();

    try {
      let result = null;
      if (typeof window !== "undefined" && window.BTMM_EVENTS && typeof window.BTMM_EVENTS.recordRequest === "function") {
        result = await window.BTMM_EVENTS.recordRequest(t, {
          email: visitorEmail,
          note,
          source: "player-request-form",
        });
      } else {
        throw new Error("Request service is currently unavailable.");
      }

      if (!result || !result.ok) {
        throw new Error((result && result.error) || "Could not send request right now. Please try again.");
      }

      saveRequestEmail(visitorEmail);
      draftEmail = visitorEmail;
      draftNote = "";
      requestedIds.add(t.id);
      formOpenForId = null;
      logPrivateTrackEvent("track-request", t);
    } catch (err) {
      reqError = (err && err.message) || "Network error — please try again.";
    } finally {
      sendingId = null;
      render();
      if (reqError && cardEl) {
        const el = cardEl.querySelector("#mp-req-email");
        if (el) el.focus();
      }
    }
  }

  function bindCardEvents() {
    if (!cardEl) return;
    cardEl.addEventListener("input", (ev) => {
      if (ev.target.name === "email") {
        draftEmail = ev.target.value;
        if (reqError) {
          reqError = "";
          ev.target.classList.remove("is-invalid");
          ev.target.setAttribute("aria-invalid", "false");
          ev.target.removeAttribute("aria-describedby");
          const errEl = cardEl.querySelector("#mp-req-error");
          if (errEl) errEl.remove();
          if (selectedId && byId.has(selectedId)) {
            lastRenderedFormState = `${formOpenForId || ""}|${sendingId || ""}|${reqError}|${requestedIds.has(selectedId) ? 1 : 0}|${infoOpen ? 1 : 0}`;
          }
        }
      }
      if (ev.target.name === "note") draftNote = ev.target.value;
    });
    cardEl.addEventListener("submit", (ev) => {
      const f = ev.target.closest("[data-req-form]");
      if (f) {
        ev.preventDefault();
        submitRequestForm(f);
      }
    });

    // Pointer scrubbing, early-waveform restart hover & hover preview on SoundCloud waveform
    cardEl.addEventListener("pointerdown", (ev) => {
      if (ev.target && typeof ev.target.closest === "function" && ev.target.closest("[data-player-restart]")) {
        ev.stopPropagation();
        return;
      }
      const wrap = ev.target && typeof ev.target.closest === "function"
        ? ev.target.closest("[data-wave-wrap]")
        : null;
      if (!wrap || (ev.button !== undefined && ev.button !== 0)) return;
      ev.stopPropagation();
      isWaveScrubbing = true;
      hasWaveDragged = false;
      activeScrubWrapEl = wrap;
      const frac = fracFromPointerEvent(wrap, ev);
      scrubFrac = frac;
      waveHoverFrac = frac;
      wrap.classList.remove("is-early-hover");
      if (typeof wrap.setPointerCapture === "function") {
        try { wrap.setPointerCapture(ev.pointerId); } catch (_) {}
      }
      seekToFraction(frac, { dragging: false });
    });

    cardEl.addEventListener("pointermove", (ev) => {
      const wrap = ev.target && typeof ev.target.closest === "function"
        ? ev.target.closest("[data-wave-wrap]")
        : null;
      if (isWaveScrubbing) {
        const activeWrap = activeScrubWrapEl || cardEl.querySelector(collapsed ? "#mp-mini-wave-wrap" : "#mp-wave-wrap");
        if (!activeWrap) return;
        hasWaveDragged = true;
        const frac = fracFromPointerEvent(activeWrap, ev);
        scrubFrac = frac;
        waveHoverFrac = frac;
        seekToFraction(frac, { dragging: true });
        return;
      }
      const expWave = cardEl.querySelector("#mp-wave-wrap");
      const miniWave = cardEl.querySelector("#mp-mini-wave-wrap");
      if (wrap) {
        const onRestartBtn = Boolean(
          ev.target &&
          typeof ev.target.closest === "function" &&
          ev.target.closest("[data-player-restart]")
        );
        const rawFrac = fracFromPointerEvent(wrap, ev);
        waveHoverFrac = onRestartBtn ? 0 : rawFrac;
        [expWave, miniWave].forEach((wEl) => {
          if (!wEl) return;
          const isEarly =
            wrap === wEl &&
            ev.pointerType !== "touch" &&
            (onRestartBtn || rawFrac <= EARLY_WAVE_HOVER_MAX_FRAC);
          wEl.classList.toggle("is-early-hover", isEarly);
        });
        syncWaveVisuals();
      } else {
        if (expWave) expWave.classList.remove("is-early-hover");
        if (miniWave) miniWave.classList.remove("is-early-hover");
        if (waveHoverFrac !== null) {
          waveHoverFrac = null;
          syncWaveVisuals();
        }
      }
    });

    const finishWaveScrub = (ev) => {
      if (!isWaveScrubbing) return;
      const activeWrap = activeScrubWrapEl || cardEl.querySelector(collapsed ? "#mp-mini-wave-wrap" : "#mp-wave-wrap");
      const finalFrac = activeWrap && ev ? fracFromPointerEvent(activeWrap, ev) : scrubFrac;
      const didDrag = hasWaveDragged;
      isWaveScrubbing = false;
      hasWaveDragged = false;
      scrubFrac = null;
      activeScrubWrapEl = null;
      if (activeWrap && ev && typeof activeWrap.releasePointerCapture === "function") {
        try { activeWrap.releasePointerCapture(ev.pointerId); } catch (_) {}
      }
      if (didDrag && finalFrac !== null) seekToFraction(finalFrac, { dragging: true });
      else syncWaveVisuals();
    };
    cardEl.addEventListener("pointerup", finishWaveScrub);
    cardEl.addEventListener("pointercancel", () => {
      if (!isWaveScrubbing) return;
      isWaveScrubbing = false;
      hasWaveDragged = false;
      scrubFrac = null;
      activeScrubWrapEl = null;
      syncWaveVisuals();
    });
    cardEl.addEventListener("pointerleave", () => {
      const expWave = cardEl.querySelector("#mp-wave-wrap");
      const miniWave = cardEl.querySelector("#mp-mini-wave-wrap");
      if (expWave) expWave.classList.remove("is-early-hover");
      if (miniWave) miniWave.classList.remove("is-early-hover");
      if (!isWaveScrubbing && waveHoverFrac !== null) {
        waveHoverFrac = null;
        syncWaveVisuals();
      }
    });

    cardEl.addEventListener("keydown", (ev) => {
      if (ev.target && typeof ev.target.matches === "function" && ev.target.matches("input, textarea")) {
        if (ev.key === "Escape") {
          ev.preventDefault();
          ev.stopPropagation();
          cancelRequestForm();
          return;
        }
        ev.stopPropagation();
        return;
      }
      const wrap = ev.target && typeof ev.target.closest === "function"
        ? ev.target.closest("[data-wave-wrap]")
        : null;
      if (!wrap || !selectedId || !byId.has(selectedId)) return;
      const t = byId.get(selectedId);
      const snap = readPlaybackSnapshot(t);
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        ev.preventDefault();
        const delta = ev.key === "ArrowRight" ? 5 : -5;
        const nextFrac = clamp((snap.currentTime + delta) / snap.seekableDur, 0, 1);
        seekToFraction(nextFrac, { dragging: false });
      } else if (ev.key === "Home") {
        ev.preventDefault();
        handleRestartTrack(t.id);
      }
    });

    cardEl.addEventListener("click", (ev) => {
      if (ev.target.closest("#mp-info-toggle")) {
        infoOpen = !infoOpen;
        render();
        return;
      }
      if (ev.target.closest("#mp-collapse")) {
        setCollapsedState(true, { preserveKeyboardFocus: ev.detail === 0 });
        return;
      }
      if (ev.target.closest("#mp-expand")) {
        setCollapsedState(false, { preserveKeyboardFocus: ev.detail === 0 });
        return;
      }
      if (ev.target.closest("[data-player-prev]")) {
        ev.stopPropagation();
        handleSkipSimilar(-1);
        return;
      }
      if (ev.target.closest("[data-player-next]")) {
        ev.stopPropagation();
        handleSkipSimilar(1);
        return;
      }
      const restartBtn = ev.target.closest("[data-player-restart]");
      if (restartBtn) {
        ev.stopPropagation();
        handleRestartTrack(restartBtn.getAttribute("data-player-restart"));
        return;
      }
      const copyLinkBtn = ev.target.closest("[data-player-copy-link]");
      if (copyLinkBtn) {
        handleCopyTrackLink(copyLinkBtn.getAttribute("data-player-copy-link"));
        return;
      }
      if (ev.target.closest("[data-player-autoplay]")) {
        handleToggleAutoPlay();
        return;
      }
      const pBtn = ev.target.closest("[data-player-play]");
      if (pBtn && hooks && hooks.onPlayToggle) {
        hooks.onPlayToggle(pBtn.getAttribute("data-player-play"));
        return;
      }
      const sBtn = ev.target.closest("[data-player-star]");
      if (sBtn) {
        toggleStar(sBtn.getAttribute("data-player-star"));
        return;
      }
      const reqBtn = ev.target.closest("[data-request-track]");
      if (reqBtn) {
        handleRequestTrack(byId.get(reqBtn.getAttribute("data-request-track")));
        return;
      }
      const cancelBtn = ev.target.closest("[data-cancel-req]");
      if (cancelBtn) {
        cancelRequestForm();
        return;
      }
      const dlLink = ev.target.closest("[data-dl-kind]");
      if (dlLink && selectedId && byId.has(selectedId)) {
        const dlKind = dlLink.getAttribute("data-dl-kind");
        const dlTrack = byId.get(selectedId);
        logPrivateTrackEvent(dlKind, dlTrack);
        if (typeof window !== "undefined" && window.BTMM_EVENTS && typeof window.BTMM_EVENTS.recordDownload === "function") {
          window.BTMM_EVENTS.recordDownload(dlTrack, dlKind, "player-cta", dlLink.getAttribute("href") || "");
        }
      }
    });
  }

  function toggleStar(tid) {
    if (!tid) return;
    const nextStarred = !starred.has(tid);
    if (nextStarred) starred.add(tid);
    else starred.delete(tid);
    saveStars();
    render();
    const t = byId.get(tid);
    if (t) {
      logPrivateTrackEvent(nextStarred ? "track-star" : "track-unstar", t);
      if (typeof window !== "undefined" && window.BTMM_EVENTS && typeof window.BTMM_EVENTS.recordStarToggle === "function") {
        window.BTMM_EVENTS.recordStarToggle(t, nextStarred, { source: "player-star" });
      }
    }
    if (hooks && hooks.onStarChange) hooks.onStarChange(starred);
  }

  function select(tid, opts = {}) {
    if (!tid || !byId.has(tid)) {
      if (typeof window !== "undefined" && window.BTMM_EVENTS && typeof window.BTMM_EVENTS.notifyTrackIntent === "function") {
        window.BTMM_EVENTS.notifyTrackIntent(null, { source: "manual" });
      }
      selectedId = null;
      collapsed = false;
      formOpenForId = null;
      waveHoverFrac = null;
      isWaveScrubbing = false;
      scrubFrac = null;
      render();
      if (!opts.silent && hooks && hooks.onSelectionChange) hooks.onSelectionChange(null);
      return;
    }
    const wasClosed = !selectedId || !byId.has(selectedId);
    if (wasClosed) {
      collapsed = false;
    }
    if (selectedId !== tid) {
      formOpenForId = null;
      reqError = "";
      waveHoverFrac = null;
      isWaveScrubbing = false;
      scrubFrac = null;
      optimisticSeekTrackId = null;
      optimisticSeekSec = null;
    }
    selectedId = tid;
    if (
      !(opts && opts.fromHistoryNav) &&
      typeof window !== "undefined" &&
      window.ME_AUDIO &&
      typeof window.ME_AUDIO.syncHistorySelection === "function"
    ) {
      window.ME_AUDIO.syncHistorySelection(tid);
    }
    if (typeof window !== "undefined" && window.BTMM_EVENTS && typeof window.BTMM_EVENTS.notifyTrackIntent === "function") {
      window.BTMM_EVENTS.notifyTrackIntent(tid, { source: opts && opts.fromAutoPlay ? "autoplay" : "manual" });
    }
    render();
    if (!opts.silent && hooks && hooks.onSelectionChange) hooks.onSelectionChange(tid);
  }

  function init(cfg) {
    hooks = cfg || {};
    byId = hooks.byId || new Map();
    erasById = hooks.erasById || new Map();
    cardEl = typeof document !== "undefined" ? document.getElementById("track-player-card") : null;
    loadPrefs();
    if (typeof window !== "undefined" && window.ME_AUDIO && typeof window.ME_AUDIO.setAutoPlay === "function") {
      window.ME_AUDIO.setAutoPlay(localAutoPlay);
    }
    if (typeof MutationObserver !== "undefined" && typeof document !== "undefined" && !themeObserver) {
      themeObserver = new MutationObserver(() => {
        cachedPalette = null;
        syncWaveVisuals();
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    }
    if (typeof ResizeObserver !== "undefined" && !waveResizeObserver) {
      waveResizeObserver = new ResizeObserver(() => {
        syncWaveVisuals();
      });
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && selectedId) {
          syncWaveVisuals();
          ensureWaveRaf();
        }
      });
      let filterSyncQueued = false;
      const scheduleFilterWaveRefresh = (ev) => {
        if (!selectedId || !cardEl || cardEl.hidden || filterSyncQueued) return;
        if (ev && ev.target && cardEl.contains(ev.target)) return;
        filterSyncQueued = true;
        const run = () => {
          filterSyncQueued = false;
          syncWaveVisuals();
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
        else setTimeout(run, 16);
      };
      document.addEventListener("click", scheduleFilterWaveRefresh, true);
      document.addEventListener("input", scheduleFilterWaveRefresh, true);
    }
    bindCardEvents();
    render();
  }

  window.BTMM_PLAYER = {
    init,
    render,
    select,
    close: () => select(null),
    selected: () => selectedId,
    isStarred: (id) => starred.has(id),
    toggleStar,
    starredSet: () => starred,
    starredCount: () => starred.size,
    isCollapsed: () => collapsed,
    setCollapsed(v) { setCollapsedState(v); },
    nextSimilarTrack: () => handleSkipSimilar(1),
    prevSimilarTrack: () => handleSkipSimilar(-1),
    isInfoOpen: () => infoOpen,
    setInfoOpen(v) { infoOpen = Boolean(v); render(); },
    setWeb3FormsKey() {},
    refreshWaveform: syncWaveVisuals,
    getPreviewStart,
    getAudibleEndSec,
    isPsychedailiesTrack,
    getShareUrl: (tid) => buildTrackShareUrl(tid || selectedId),
    isWorkInProgress,
    formatSimpleKey,
    logPrivateTrackEvent,
  };
})();

