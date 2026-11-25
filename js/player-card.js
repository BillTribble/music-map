// Persistent Collapsible Floating Track Player Card (SoundCloud Waveform, Transport, 'i' Analysis Drawer & Tier A/B/C CTAs)
(function () {
  "use strict";

  const STAR_KEY = "btmm.starred";
  const COLLAPSE_KEY = "btmm.playerCollapsed";
  const AUTOPLAY_KEY = "btmm.autoPlay";
  const LEGACY_STAR_KEY = "me.starred";
  // Public opaque Web3Forms UUID (zero email address in client bundle; paste key from web3forms.com)
  let web3FormsKey = "";
  const WEB3FORMS_URL = "https://api.web3forms.com/submit";
  const DEFAULT_PEAK_BARS = 160;

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
  let optimisticSeekTrackId = null;
  let optimisticSeekSec = null;
  let optimisticSeekUntilMs = 0;
  let waveRafId = null;
  let lastRenderedTrackId = null;
  let lastRenderedCollapsed = null;
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
      collapsed = localStorage.getItem(COLLAPSE_KEY) === "true";
      const savedAuto = localStorage.getItem(AUTOPLAY_KEY);
      if (savedAuto === "false") localAutoPlay = false;
      else if (savedAuto === "true") localAutoPlay = true;
    } catch (_) {}
  }

  function saveStars() {
    try { localStorage.setItem(STAR_KEY, JSON.stringify([...starred])); } catch (_) {}
  }

  function saveCollapsed() {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "true" : "false"); } catch (_) {}
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

  function isSketch(t) {
    if (!t || t.is_ai) return false;
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

  function buildPlayerMetaPillsHtml(t, { released, sketch, wip, er }) {
    const pills = [];
    const bpmRounded = Math.round(Number(t.bpm) || 0);
    if (bpmRounded > 0) {
      pills.push(`<span class="badge badge-blue mono-num">${bpmRounded} BPM</span>`);
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
    if (!t || t.is_ai) return 0;
    if (Number.isFinite(t.preview_start_sec)) return Math.max(0, Number(t.preview_start_sec));
    if (Number.isFinite(t.cue_in_sec)) return Math.max(0, Number(t.cue_in_sec));
    return Math.max(0, Number(t.cue_sec) || 0);
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

    const isPlaying = activeMatch
      ? Boolean(st.playing)
      : Boolean(
          (hooks && typeof hooks.playing === "function" && hooks.playing() === t.id) ||
          (ma && typeof ma.isPlaying === "function" && ma.isPlaying(t.id))
        );
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

    if (t.is_ai) {
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
    };
  }

  function resolveWavePalette() {
    if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
      return {
        primary: "rgb(14, 87, 208)",
        secondary: "rgb(1, 99, 156)",
        secondaryContainer: "rgb(193, 231, 255)",
        onSurface: "rgb(31, 31, 31)",
        onSurfaceVariant: "rgb(68, 71, 70)",
      };
    }
    const themeAttr = document.documentElement.getAttribute("data-theme") || "light";
    if (cachedPalette && cachedThemeKey === themeAttr) return cachedPalette;
    const cs = getComputedStyle(document.documentElement);
    const pick = (prop, fb) => (cs.getPropertyValue(prop) || "").trim() || fb;
    cachedThemeKey = themeAttr;
    cachedPalette = {
      primary: pick("--md-sys-color-primary", "rgb(14, 87, 208)"),
      secondary: pick("--md-sys-color-secondary", "rgb(1, 99, 156)"),
      secondaryContainer: pick("--md-sys-color-secondary-container", "rgb(193, 231, 255)"),
      onSurface: pick("--md-sys-color-on-surface", "rgb(31, 31, 31)"),
      onSurfaceVariant: pick("--md-sys-color-on-surface-variant", "rgb(68, 71, 70)"),
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

  function drawMiniWaveform(ctx, W, H, t, snap, pal) {
    const sidePad = 8;
    const barStep = 5;
    const barW = 3;
    const barCount = Math.max(18, Math.floor((W - sidePad * 2 + (barStep - barW)) / barStep));
    const totalBarsW = barCount * barStep - (barStep - barW);
    const startX = Math.floor((W - totalBarsW) * 0.5);
    const maxBarH = Math.max(12, H - 8);

    const rawBars = getResampledBars(t, barCount);
    let peakMax = 1;
    for (let i = 0; i < barCount; i++) {
      if ((rawBars[i] || 0) > peakMax) peakMax = rawBars[i];
    }
    const denom = Math.max(65, peakMax);
    const heights = new Array(barCount);
    for (let i = 0; i < barCount; i++) {
      const prev = rawBars[Math.max(0, i - 1)] || 12;
      const curr = rawBars[i] || 12;
      const next = rawBars[Math.min(barCount - 1, i + 1)] || 12;
      const smoothNorm = clamp((prev * 0.22 + curr * 0.56 + next * 0.22) / denom, 0.14, 1);
      heights[i] = Math.max(4, Math.round(smoothNorm * maxBarH));
    }

    const dispFrac = isWaveScrubbing && scrubFrac !== null ? scrubFrac : snap.progressFrac;
    const hasProgress = snap.isPlaying || dispFrac > 0.001;
    const progressX = hasProgress ? clamp(startX + dispFrac * totalBarsW, startX, startX + totalBarsW) : startX;

    // 1. Unplayed capsule bars (right of playhead) + hover seek preview
    ctx.save();
    ctx.beginPath();
    ctx.rect(progressX, 0, Math.max(0, W - progressX), H);
    ctx.clip();
    for (let i = 0; i < barCount; i++) {
      const x = startX + i * barStep;
      if (x + barW <= progressX) continue;
      const barFrac = (i + 0.5) / barCount;
      const inHover = waveHoverFrac !== null && !isWaveScrubbing && barFrac <= waveHoverFrac;
      const barH = heights[i];
      const y = (H - barH) * 0.5;
      ctx.fillStyle = inHover ? pal.primary : pal.onSurfaceVariant;
      ctx.globalAlpha = inHover ? 0.35 : 0.25;
      drawRoundedRect(ctx, x, y, barW, barH, barW * 0.5);
      ctx.fill();
    }
    ctx.restore();

    // 2. Played accent capsule bars (left of playhead, continuous sub-pixel clip)
    if (hasProgress && progressX > startX) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, progressX, H);
      ctx.clip();
      for (let i = 0; i < barCount; i++) {
        const x = startX + i * barStep;
        if (x >= progressX) break;
        const barFrac = (i + 0.5) / barCount;
        const inRewindHover = waveHoverFrac !== null && !isWaveScrubbing && waveHoverFrac < dispFrac && barFrac >= waveHoverFrac;
        const barH = heights[i];
        const y = (H - barH) * 0.5;
        ctx.fillStyle = pal.primary;
        ctx.globalAlpha = inRewindHover ? 0.32 : 0.45;
        drawRoundedRect(ctx, x, y, barW, barH, barW * 0.5);
        ctx.fill();
      }
      ctx.restore();
    }

    // 3. Subtle hover seek cursor
    if (waveHoverFrac !== null && !isWaveScrubbing) {
      const hx = Math.round(startX + waveHoverFrac * totalBarsW) + 0.5;
      ctx.save();
      ctx.strokeStyle = pal.onSurface;
      ctx.globalAlpha = 0.28;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, 4);
      ctx.lineTo(hx, H - 4);
      ctx.stroke();
      ctx.restore();
    }

    // 4. Live playhead needle
    if (hasProgress) {
      const px = clamp(progressX, startX + 1, startX + totalBarsW - 1);
      ctx.save();
      ctx.strokeStyle = pal.primary;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 4);
      ctx.lineTo(px, H - 4);
      ctx.stroke();
      ctx.restore();
    }
  }

  function syncWaveVisuals() {
    if (!cardEl || cardEl.hidden || !selectedId || !byId.has(selectedId)) return;
    const t = byId.get(selectedId);
    const canvas = cardEl.querySelector("#mp-waveform");
    const wrapEl = cardEl.querySelector("#mp-wave-wrap");
    const timeEl = cardEl.querySelector("#mp-wave-time");
    if (!canvas) return;

    const snap = readPlaybackSnapshot(t);
    if (timeEl) {
      const nextTxt = formatWaveTimeText(snap);
      if (timeEl.textContent !== nextTxt) timeEl.textContent = nextTxt;
    }
    if (wrapEl) {
      const vNow = String(Math.round(snap.currentTime));
      const vMax = String(Math.round(snap.timelineDur));
      if (wrapEl.getAttribute("aria-valuenow") !== vNow) wrapEl.setAttribute("aria-valuenow", vNow);
      if (wrapEl.getAttribute("aria-valuemax") !== vMax) wrapEl.setAttribute("aria-valuemax", vMax);
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width < 12 || rect.height < 12) return;
    const dpr = Math.min(3, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    const pxW = Math.round(rect.width * dpr);
    const pxH = Math.round(rect.height * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const pal = resolveWavePalette();
    const W = rect.width;
    const H = rect.height;
    if (collapsed) {
      drawMiniWaveform(ctx, W, H, t, snap, pal);
      return;
    }
    const barStep = 3;
    const barW = 2;
    const sidePad = 8;
    const barCount = Math.max(24, Math.floor((W - sidePad * 2 + 1) / barStep));
    const totalBarsW = barCount * barStep - (barStep - barW);
    const startX = Math.floor((W - totalBarsW) * 0.5);

    const splitY = Math.round(H * 0.67);
    const gapY = 1.5;
    const maxUpperH = Math.max(8, splitY - 6 - gapY * 0.5);
    const maxLowerH = Math.max(4, H - 6 - splitY - gapY * 0.5);

    const w0 = snap.hasPreviewWindow ? clamp(snap.winStart / snap.timelineDur, 0, 1) : 0;
    const w1 = snap.hasPreviewWindow ? clamp(snap.winEnd / snap.timelineDur, w0, 1) : 0;
    const winX0 = startX + w0 * totalBarsW;
    const winX1 = startX + w1 * totalBarsW;

    // 1. Highlighted snippet / loop window backdrop
    if (snap.hasPreviewWindow && winX1 > winX0 + 2) {
      const fullSpan = w1 - w0 >= 0.98;
      if (snap.showLoopMarkers || !fullSpan) {
        ctx.save();
        ctx.fillStyle = pal.secondaryContainer;
        ctx.globalAlpha = snap.showLoopMarkers ? 0.36 : 0.18;
        drawRoundedRect(ctx, winX0, 3, winX1 - winX0, H - 6, 5);
        ctx.fill();
        ctx.restore();
      }
    }

    // 2. SoundCloud split upper + mirrored lower amplitude bars
    const bars = getResampledBars(t, barCount);
    const dispFrac = isWaveScrubbing && scrubFrac !== null ? scrubFrac : snap.progressFrac;
    const hasProgress = snap.isPlaying || dispFrac > 0.001;

    for (let i = 0; i < barCount; i++) {
      const barFrac = (i + 0.5) / barCount;
      const amp = bars[i] || 12;
      const x = startX + i * barStep;
      const uH = Math.max(2, Math.round((amp / 100) * maxUpperH));
      const lH = Math.max(1.5, Math.round((amp / 100) * maxLowerH));

      const played = hasProgress && barFrac <= dispFrac;
      const inWin = snap.hasPreviewWindow && barFrac >= w0 && barFrac <= w1;
      const inHover =
        waveHoverFrac !== null &&
        !isWaveScrubbing &&
        ((waveHoverFrac > dispFrac && barFrac > dispFrac && barFrac <= waveHoverFrac) ||
          (waveHoverFrac < dispFrac && barFrac >= waveHoverFrac && barFrac <= dispFrac));

      let col = pal.onSurfaceVariant;
      let uAlpha = 0.28;
      let lAlpha = 0.13;

      if (played) {
        col = pal.primary;
        uAlpha = 0.96;
        lAlpha = 0.38;
      } else if (inHover) {
        col = pal.primary;
        uAlpha = 0.56;
        lAlpha = 0.22;
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
        const cap = 4.5;
        ctx.save();
        ctx.strokeStyle = pal.secondary;
        ctx.globalAlpha = 0.92;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        // Left loop bracket [
        ctx.moveTo(bx0 + cap, 3.5);
        ctx.lineTo(bx0, 3.5);
        ctx.lineTo(bx0, H - 3.5);
        ctx.lineTo(bx0 + cap, H - 3.5);
        // Right loop bracket ]
        ctx.moveTo(bx1 - cap, 3.5);
        ctx.lineTo(bx1, 3.5);
        ctx.lineTo(bx1, H - 3.5);
        ctx.lineTo(bx1 - cap, H - 3.5);
        ctx.stroke();
        ctx.restore();
      } else if (w0 > 0.01) {
        const cx = Math.round(winX0) + 0.5;
        ctx.save();
        ctx.strokeStyle = pal.secondary;
        ctx.fillStyle = pal.secondary;
        ctx.globalAlpha = 0.72;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(cx, 4);
        ctx.lineTo(cx, H - 4);
        ctx.stroke();
        // Subtle cue-in flag triangle at top of snippet start
        ctx.beginPath();
        ctx.moveTo(cx, 3.5);
        ctx.lineTo(cx + 4.5, 6);
        ctx.lineTo(cx, 8.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    // 4. Hover scrub preview cursor
    if (waveHoverFrac !== null && !isWaveScrubbing) {
      const hx = Math.round(startX + waveHoverFrac * totalBarsW) + 0.5;
      ctx.save();
      ctx.strokeStyle = pal.onSurface;
      ctx.globalAlpha = 0.34;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, 3);
      ctx.lineTo(hx, H - 3);
      ctx.stroke();
      ctx.restore();
    }

    // 5. Live playhead needle
    if (hasProgress) {
      const px = clamp(startX + dispFrac * totalBarsW, startX + 1, startX + totalBarsW - 1);
      ctx.save();
      ctx.strokeStyle = pal.primary;
      ctx.fillStyle = pal.primary;
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      ctx.moveTo(px, 4);
      ctx.lineTo(px, H - 4);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, 5, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
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
      if (snap.isPlaying || snap.isPend || isWaveScrubbing || nowMs < optimisticSeekUntilMs) {
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

    // Tier C: Unreleased >= 2015 -> Zero-email-exposure request flow (Web3Forms + private GoatCounter)
    const sent = requestedIds.has(t.id);
    const hasRelay = Boolean((web3FormsKey || "").trim());
    if (formOpenForId === t.id && !sent && hasRelay) {
      const busy = sendingId === t.id;
      return `
        <div class="player-actions">
          <form class="req-form" data-req-form="${esc(t.id)}">
            <input type="checkbox" name="botcheck" tabindex="-1" autocomplete="off" hidden />
            <input class="req-input" type="email" name="email" required placeholder="Your email so Bill can reply" value="${esc(draftEmail)}" ${busy ? "disabled" : ""} />
            <input class="req-input" type="text" name="note" maxlength="280" placeholder="Optional note (DJ set, licensing, mix…)" value="${esc(draftNote)}" ${busy ? "disabled" : ""} />
            ${reqError ? `<div class="req-err">${esc(reqError)}</div>` : ""}
            <div class="req-actions">
              <button type="submit" class="btn" ${busy ? "disabled" : ""}>
                <span class="ms">send</span>
                <span>${busy ? "Sending…" : "Send request"}</span>
              </button>
              <button type="button" class="req-cancel-btn" data-cancel-req="${esc(t.id)}" ${busy ? "disabled" : ""}>Cancel</button>
            </div>
          </form>
        </div>`;
    }
    return `
      <div class="player-actions">
        <div class="player-cta-row">
          <button type="button" class="btn ${sent ? "is-sent" : ""}" data-request-track="${esc(t.id)}">
            <span class="ms">${sent ? "check" : "mail"}</span>
            <span>${sent ? (hasRelay ? "Request sent" : "Requested") : "Request track"}</span>
          </button>
        </div>
      </div>`;
  }

  function syncInPlaceButtons(t, snap) {
    const playBtn = cardEl.querySelector("[data-player-play]");
    if (playBtn) {
      playBtn.classList.toggle("is-playing", snap.isPlaying);
      playBtn.setAttribute("aria-label", snap.isPlaying ? "Pause" : "Play");
      playBtn.title = snap.isPlaying ? "Pause (Space)" : "Play (Space)";
      const ic = playBtn.querySelector(".ms");
      if (ic) ic.textContent = snap.isPlaying ? "pause" : snap.isPend ? "hourglass_top" : "play_arrow";
    }
    const autoBtn = cardEl.querySelector("#mp-autoplay-toggle");
    if (autoBtn) {
      autoBtn.classList.toggle("is-active", snap.autoPlay);
      autoBtn.setAttribute("aria-pressed", String(snap.autoPlay));
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

  function render() {
    if (!cardEl || !hooks) return;
    if (!selectedId || !byId.has(selectedId)) {
      cardEl.hidden = true;
      lastRenderedTrackId = null;
      lastRenderedCollapsed = null;
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

    if (
      lastRenderedTrackId === t.id &&
      lastRenderedCollapsed === collapsed &&
      (collapsed ||
        isWaveScrubbing ||
        (formOpenForId === t.id &&
          typeof document !== "undefined" &&
          cardEl.contains(document.activeElement) &&
          (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA")))
    ) {
      syncInPlaceButtons(t, snap);
      syncWaveVisuals();
      if (isPlaying || isPend || isWaveScrubbing) ensureWaveRaf();
      else stopWaveRaf();
      return;
    }

    cardEl.hidden = false;
    cardEl.classList.toggle("is-collapsed", collapsed);

    if (collapsed) {
      cardEl.innerHTML = `
        <div class="mp-mini-row">
          <button type="button" class="btn-tonal mp-play ${isPlaying ? "is-playing" : ""}" data-player-play="${esc(t.id)}" aria-label="${isPlaying ? "Pause" : "Play"}" title="${isPlaying ? "Pause (Space)" : "Play (Space)"}">
            <span class="ms filled">${isPlaying ? "pause" : isPend ? "hourglass_top" : "play_arrow"}</span>
          </button>
          <div class="mp-wave-wrap mp-mini-wave-wrap" id="mp-wave-wrap" role="slider" tabindex="0" aria-label="Seek ${esc(t.title)}" aria-valuemin="0" aria-valuemax="${Math.round(snap.timelineDur)}" aria-valuenow="${Math.round(snap.currentTime)}" title="${esc(t.title)} — click or drag to seek">
            <canvas id="mp-waveform" class="mp-wave-canvas mp-mini-wave-canvas" aria-hidden="true"></canvas>
            <div class="mp-mini-title-overlay">
              <span class="mp-mini-title">${esc(t.title)}</span>
            </div>
          </div>
          <button type="button" class="icon-btn mp-expand-btn" id="mp-expand" aria-label="Expand player" title="Expand player">
            <span class="ms">expand_less</span>
          </button>
        </div>`;
      lastRenderedTrackId = t.id;
      lastRenderedCollapsed = true;
      observeWaveWrap();
      syncWaveVisuals();
      if (isPlaying || isPend) ensureWaveRaf();
      else stopWaveRaf();
      return;
    }

    const released = isReleased(t);
    const sketch = isSketch(t);
    const wip = isWorkInProgress(t);
    const clusterName = t.cluster_label || "Unclassified";
    const eraShort = t.is_ai ? String(t.year || "2025") : (er ? er.label : t.era);
    const eraLong = t.is_ai ? `Gen AI (${t.year || "2025"})` : eraLabel;
    const metaShort = `${eraShort} · ${clusterName}`;
    const metaFull = `${eraLong} · ${clusterName}${wip ? " · Work in progress" : ""}`;
    const timeReadout = formatWaveTimeText(snap);

    cardEl.innerHTML = `
      <div class="mp-head">
        <button type="button" class="btn-tonal mp-play ${isPlaying ? "is-playing" : ""}" data-player-play="${esc(t.id)}" aria-label="${isPlaying ? "Pause" : "Play"}" title="${isPlaying ? "Pause (Space)" : "Play (Space)"}">
          <span class="ms filled">${isPlaying ? "pause" : isPend ? "hourglass_top" : "play_arrow"}</span>
        </button>
        <div class="mp-titles">
          <div class="mp-name" title="${esc(t.title)}">${esc(t.title)}</div>
          <div class="mp-meta" title="${esc(metaFull)}"><span class="mp-meta-text">${esc(metaShort)}</span></div>
        </div>
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
      <div class="mp-wave-section">
        <div class="mp-wave-wrap" id="mp-wave-wrap" role="slider" tabindex="0" aria-label="Track waveform seek" aria-valuemin="0" aria-valuemax="${Math.round(snap.timelineDur)}" aria-valuenow="${Math.round(snap.currentTime)}">
          <canvas id="mp-waveform" class="mp-wave-canvas" aria-hidden="true"></canvas>
          <div id="mp-wave-time" class="mp-wave-time">${esc(timeReadout)}</div>
        </div>
        ${buildPlayerMetaPillsHtml(t, { released, sketch, wip, er })}
        <div class="mp-transport-row">
          <button type="button" class="mp-ctrl-btn" id="mp-restart" data-player-restart="${esc(t.id)}" aria-label="Play from start (0:00)" title="Restart track from 0:00">
            <span class="ms">skip_previous</span>
            <span>0:00</span>
          </button>
          <button type="button" class="mp-ctrl-btn ${copiedForId === t.id ? "is-copied" : ""}" id="mp-copy-link" data-player-copy-link="${esc(t.id)}" aria-label="${copiedForId === t.id ? "Link copied" : "Copy direct link to track"}" title="Copy direct link that opens &amp; plays this track">
            <span class="ms">${copiedForId === t.id ? "check" : "link"}</span>
            <span class="mp-copy-lbl">${copiedForId === t.id ? "Copied" : "Copy link"}</span>
          </button>
          <button type="button" class="mp-ctrl-btn ${snap.autoPlay ? "is-active" : ""}" id="mp-autoplay-toggle" data-player-autoplay="1" aria-pressed="${snap.autoPlay}" aria-label="Auto-play similar tracks" title="${snap.autoPlay ? "Auto-play on: plays full track & 1s crossfades to nearest similar track (click to loop snippet)" : "Auto-play off: looping snippet window (click to enable Auto-play)"}">
            <span class="ms">${snap.autoPlay ? "playlist_play" : "repeat"}</span>
            <span>Auto-play</span>
          </button>
        </div>
      </div>
      <div id="mp-info-panel" class="mp-info-panel" ${infoOpen ? "" : "hidden"}>
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
    lastRenderedCollapsed = false;
    observeWaveWrap();
    syncWaveVisuals();
    if (isPlaying || isPend) ensureWaveRaf();
    else stopWaveRaf();
  }

  function observeWaveWrap() {
    if (!waveResizeObserver || !cardEl) return;
    waveResizeObserver.disconnect();
    const wrapEl = cardEl.querySelector("#mp-wave-wrap");
    if (wrapEl) waveResizeObserver.observe(wrapEl);
  }

  function fracFromPointerEvent(wrapEl, ev) {
    const rect = wrapEl.getBoundingClientRect();
    const sidePad = 8;
    const usable = Math.max(12, rect.width - sidePad * 2);
    return clamp((ev.clientX - rect.left - sidePad) / usable, 0, 1);
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
    if (!t) return;
    logPrivateTrackEvent("track-request", t);
    const hasRelay = Boolean((web3FormsKey || "").trim());
    if (!hasRelay) {
      if (typeof window !== "undefined" && window.BTMM_EVENTS && typeof window.BTMM_EVENTS.recordRequest === "function") {
        window.BTMM_EVENTS.recordRequest(t, { source: "player-request" });
      }
      requestedIds.add(t.id);
      render();
      return;
    }
    reqError = "";
    formOpenForId = t.id;
    render();
    const emailInput = cardEl && cardEl.querySelector('input[name="email"]');
    if (emailInput) emailInput.focus();
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
    const visitorEmail = String(fd.get("email") || "").trim();
    const note = String(fd.get("note") || "").trim();
    draftEmail = visitorEmail;
    draftNote = note;
    if (!visitorEmail || visitorEmail.indexOf("@") < 1) {
      reqError = "Please enter a valid reply email.";
      render();
      return;
    }
    reqError = "";
    sendingId = t.id;
    render();
    const er = erasById.get(t.era);
    const eraLabel = er ? er.label : t.era;
    try {
      const resp = await fetch(WEB3FORMS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          access_key: web3FormsKey.trim(),
          subject: `Track Request: ${t.title}`,
          from_name: "Bill Tribble Music Map",
          email: visitorEmail,
          track_title: t.title,
          track_id: t.id,
          era: eraLabel,
          key_tempo: `${formatSimpleKey(t) || "—"} · ${Math.round(t.bpm || 0)} BPM`,
          message: note || `Requesting "${t.title}" (${eraLabel}).`,
          botcheck: "",
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || json.success === false) {
        throw new Error(json.message || "Could not send request right now.");
      }
      requestedIds.add(t.id);
      if (typeof window !== "undefined" && window.BTMM_EVENTS && typeof window.BTMM_EVENTS.recordRequest === "function") {
        window.BTMM_EVENTS.recordRequest(t, { email: visitorEmail, note, source: "player-request-form" });
      }
      formOpenForId = null;
      draftNote = "";
    } catch (err) {
      reqError = (err && err.message) || "Network error — please try again.";
    } finally {
      sendingId = null;
      render();
    }
  }

  function bindCardEvents() {
    if (!cardEl) return;
    cardEl.addEventListener("input", (ev) => {
      if (ev.target.name === "email") draftEmail = ev.target.value;
      if (ev.target.name === "note") draftNote = ev.target.value;
    });
    cardEl.addEventListener("submit", (ev) => {
      const f = ev.target.closest("[data-req-form]");
      if (f) {
        ev.preventDefault();
        submitRequestForm(f);
      }
    });

    // Pointer scrubbing & hover preview on SoundCloud waveform
    cardEl.addEventListener("pointerdown", (ev) => {
      const wrap = ev.target.closest("#mp-wave-wrap");
      if (!wrap || (ev.button !== undefined && ev.button !== 0)) return;
      ev.stopPropagation();
      isWaveScrubbing = true;
      hasWaveDragged = false;
      const frac = fracFromPointerEvent(wrap, ev);
      scrubFrac = frac;
      waveHoverFrac = frac;
      if (typeof wrap.setPointerCapture === "function") {
        try { wrap.setPointerCapture(ev.pointerId); } catch (_) {}
      }
      seekToFraction(frac, { dragging: false });
    });

    cardEl.addEventListener("pointermove", (ev) => {
      const wrap = ev.target.closest("#mp-wave-wrap");
      if (isWaveScrubbing) {
        const activeWrap = cardEl.querySelector("#mp-wave-wrap");
        if (!activeWrap) return;
        hasWaveDragged = true;
        const frac = fracFromPointerEvent(activeWrap, ev);
        scrubFrac = frac;
        waveHoverFrac = frac;
        seekToFraction(frac, { dragging: true });
        return;
      }
      if (wrap) {
        waveHoverFrac = fracFromPointerEvent(wrap, ev);
        syncWaveVisuals();
      } else if (waveHoverFrac !== null) {
        waveHoverFrac = null;
        syncWaveVisuals();
      }
    });

    const finishWaveScrub = (ev) => {
      if (!isWaveScrubbing) return;
      const activeWrap = cardEl.querySelector("#mp-wave-wrap");
      const finalFrac = activeWrap && ev ? fracFromPointerEvent(activeWrap, ev) : scrubFrac;
      const didDrag = hasWaveDragged;
      isWaveScrubbing = false;
      hasWaveDragged = false;
      scrubFrac = null;
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
      syncWaveVisuals();
    });
    cardEl.addEventListener("pointerleave", () => {
      if (!isWaveScrubbing && waveHoverFrac !== null) {
        waveHoverFrac = null;
        syncWaveVisuals();
      }
    });

    cardEl.addEventListener("keydown", (ev) => {
      const wrap = ev.target.closest("#mp-wave-wrap");
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
        collapsed = true;
        waveHoverFrac = null;
        saveCollapsed();
        render();
        return;
      }
      if (ev.target.closest("#mp-expand")) {
        collapsed = false;
        waveHoverFrac = null;
        saveCollapsed();
        render();
        return;
      }
      const restartBtn = ev.target.closest("[data-player-restart]");
      if (restartBtn) {
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
        formOpenForId = null;
        reqError = "";
        render();
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
      selectedId = null;
      formOpenForId = null;
      waveHoverFrac = null;
      isWaveScrubbing = false;
      scrubFrac = null;
      render();
      if (!opts.silent && hooks && hooks.onSelectionChange) hooks.onSelectionChange(null);
      return;
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
    render();
    if (!opts.silent && hooks && hooks.onSelectionChange) hooks.onSelectionChange(tid);
  }

  function init(cfg) {
    hooks = cfg || {};
    byId = hooks.byId || new Map();
    erasById = hooks.erasById || new Map();
    if (typeof window !== "undefined" && window.BTMM_WEB3FORMS_KEY) {
      web3FormsKey = String(window.BTMM_WEB3FORMS_KEY);
    }
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
    setCollapsed(v) { collapsed = Boolean(v); waveHoverFrac = null; saveCollapsed(); render(); },
    isInfoOpen: () => infoOpen,
    setInfoOpen(v) { infoOpen = Boolean(v); render(); },
    setWeb3FormsKey(k) { web3FormsKey = String(k || ""); render(); },
    refreshWaveform: syncWaveVisuals,
    getPreviewStart,
    getShareUrl: (tid) => buildTrackShareUrl(tid || selectedId),
    isWorkInProgress,
    formatSimpleKey,
    logPrivateTrackEvent,
  };
})();

