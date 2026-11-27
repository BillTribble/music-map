// Dual-Deck Web Audio DJ Transition Engine for Bill Tribble Music Map
// - Offline DJ-Vibes beat-grids (`window.BEAT_GRIDS` / `window.MUSIC_MAP_BEATGRIDS`)
// - Pitch-steady tempo matching (`preservesPitch = true` across all tempo adjustments & glides)
// - 4/4 Auto-Play 4-bar phrase-aligned 5-bar DJ blend with 180 Hz (-24 dB) lowshelf bass swap
// - Immediate 1-bar beat-phase-locked manual transition on `Next` (>|), `Prev` (|<), or track click
// - Smooth 1-bar beat-synced short fades on broken-beat (DnB, breakbeat, UK bass) & equal-power ambient fades
// - CORS-safe Web Audio streaming via `/api/audio/:tag/:asset` with zero-silence untainted `<audio>` failover
(function () {
  "use strict";

  const baseAudio = typeof window !== "undefined" ? window.ME_AUDIO : null;
  if (!baseAudio) return;

  const DEFAULT_EVENTS_API = "https://music-map-events.billtribble.workers.dev";
  const GH_RELEASE_RE = /^https?:\/\/github\.com\/BillTribble\/music-map\/releases\/download\/([^/?#]+)\/([^?#]+)$/i;

  const LOWSHELF_FREQ_HZ = 180;
  const BASS_CUT_DB = -24.0;
  const TEMPO_TOL_4X4 = 0.12;      // ±12% pitch-steady BPM match window for 4/4 blends
  const TEMPO_TOL_BROKEN = 0.10;   // ±10% pitch-steady BPM match window for broken-beat fades
  const AUTO_4X4_BLEND_BARS = 5.0; // 1 bar highs-in + 2 bars bass-swap + 2 bars outgoing fade (~9.5-10.5s)
  const MANUAL_BLEND_BARS = 1.0;   // Immediate 1-bar (4-beat) smooth transition on Next / click
  const BROKEN_FADE_BARS = 1.0;    // Short 1-bar (4-beat) beat-synced fade on broken-beat tracks
  const TEMPO_GLIDE_BARS = 2.0;    // Smooth post-blend tempo glide back to 1.0x
  const AMBIENT_FADE_MS = 1500;
  const MUSH_TASTE_SEC = 3.0;
  const MUSH_FADE_MS = 2500;
  const MUSH_MIN_FACTOR = 0.02;
  const TICK_MS = 25;
  const CORS_RETRY_COOLDOWN_MS = 30000;

  let ctx = null;
  let mixerMasterGain = null;
  let masterAnalyser = null;
  let analyserBuf = null;

  let enabled = typeof baseAudio.isEnabled === "function" ? Boolean(baseAudio.isEnabled()) : true;
  let volume = typeof baseAudio.getVolume === "function" ? Number(baseAudio.getVolume()) : 0.85;
  let autoPlay = typeof baseAudio.getAutoPlay === "function" ? Boolean(baseAudio.getAutoPlay()) : true;

  let tracksList = [];
  let byId = new Map();
  const visitedIds = new Set();
  const playHistory = [];
  let historyCursor = -1;

  let decks = [null, null];
  let active = null;
  let outgoing = null;
  let prewarm = null;
  let pending = null;
  let lastPaused = null;
  let activeBlend = null;
  let activeGlide = null;

  let generation = 0;
  let tickTimer = null;
  let rafId = 0;
  let corsProxyCooldownUntilMs = 0;

  let onStateChangeCb = () => {};
  const stateListeners = new Set();
  let onBeatCb = () => {};
  let onAutoAdvanceCb = null;
  const transitionHistory = [];

  function nowMs() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function smoothstep01(x) {
    const t = clamp(x, 0, 1);
    return 0.5 - 0.5 * Math.cos(t * Math.PI);
  }

  function applyPreservesPitch(el) {
    if (!el) return;
    try {
      if ("preservesPitch" in el) el.preservesPitch = true;
      if ("mozPreservesPitch" in el) el.mozPreservesPitch = true;
      if ("webkitPreservesPitch" in el) el.webkitPreservesPitch = true;
    } catch (_) {}
  }

  function readPreservesPitch(el) {
    if (!el) return true;
    if ("preservesPitch" in el) return Boolean(el.preservesPitch);
    if ("mozPreservesPitch" in el) return Boolean(el.mozPreservesPitch);
    if ("webkitPreservesPitch" in el) return Boolean(el.webkitPreservesPitch);
    return true;
  }

  function getCorsApiBase() {
    if (typeof window !== "undefined") {
      if (typeof window.BTMM_AUDIO_CORS_BASE === "string") {
        return window.BTMM_AUDIO_CORS_BASE.trim().replace(/\/+$/, "");
      }
      if (typeof window.BTMM_EVENTS_API_URL === "string" && window.BTMM_EVENTS_API_URL.trim()) {
        return window.BTMM_EVENTS_API_URL.trim().replace(/\/+$/, "");
      }
      try {
        const u = new URL(window.location.href);
        const qp = u.searchParams.get("audio_cors_api") || u.searchParams.get("events_api");
        if (qp && /^https?:\/\//i.test(qp)) {
          return qp.trim().replace(/\/+$/, "");
        }
      } catch (_) {}
    }
    return DEFAULT_EVENTS_API;
  }

  function isSameOriginOrLocalUrl(url) {
    if (!url) return false;
    if (/^(?:blob:|data:|\/|audio\/|\.\.?\/)/i.test(url)) return true;
    if (typeof window === "undefined" || !window.location) return false;
    try {
      const parsed = new URL(url, window.location.href);
      return parsed.origin === window.location.origin;
    } catch (_) {
      return false;
    }
  }

  function resolveRawTrackUrls(t) {
    if (!t) return [];
    if (typeof window !== "undefined" && typeof window.BTMM_LOCAL_AUDIO_MAP === "object" && window.BTMM_LOCAL_AUDIO_MAP) {
      const mapped = window.BTMM_LOCAL_AUDIO_MAP[t.id];
      if (typeof mapped === "string" && mapped.length > 0) {
        return [mapped];
      }
    }
    const raw = [t.stream_url, t.mp3_320_url, t.mp3_url, t.preview_url, t.file];
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const u = raw[i];
      if (typeof u === "string" && u.length > 0 && out.indexOf(u) === -1) {
        out.push(u);
      }
    }
    return out;
  }

  function isUrlFullTrack(t, rawUrl) {
    if (!t || !rawUrl) return false;
    if (typeof window !== "undefined" && window.BTMM_LOCAL_AUDIO_MAP && window.BTMM_LOCAL_AUDIO_MAP[t.id] === rawUrl) {
      return true;
    }
    return Boolean(
      (t.stream_url && rawUrl === t.stream_url) ||
      (t.mp3_320_url && rawUrl === t.mp3_320_url) ||
      (t.mp3_url && rawUrl === t.mp3_url)
    );
  }

  function buildUrlCandidates(t) {
    const rawUrls = resolveRawTrackUrls(t);
    const out = [];
    const corsBase = getCorsApiBase();
    const proxyCoolingDown = nowMs() < corsProxyCooldownUntilMs;

    for (let i = 0; i < rawUrls.length; i++) {
      const rawUrl = rawUrls[i];
      const full = isUrlFullTrack(t, rawUrl);
      if (isSameOriginOrLocalUrl(rawUrl)) {
        out.push({ url: rawUrl, rawUrl, mode: "webaudio", isFullTrack: full, viaProxy: false });
        continue;
      }
      const m = GH_RELEASE_RE.exec(rawUrl);
      if (m && corsBase && !proxyCoolingDown) {
        const tag = m[1];
        const asset = m[2];
        out.push({
          url: `${corsBase}/api/audio/${tag}/${asset}`,
          rawUrl,
          mode: "webaudio",
          isFullTrack: full,
          viaProxy: true,
        });
      }
      // Untainted direct HTMLAudioElement fallback guarantees playback NEVER fails or goes silent
      out.push({ url: rawUrl, rawUrl, mode: "direct", isFullTrack: full, viaProxy: false });
    }
    return out;
  }

  function getBeatGridsStore() {
    if (typeof window === "undefined") return {};
    return window.BEAT_GRIDS || window.MUSIC_MAP_BEATGRIDS || {};
  }

  function getTrackGrid(trackOrId) {
    const tr = typeof trackOrId === "object" ? trackOrId : byId.get(String(trackOrId || ""));
    const tid = tr ? tr.id : String(trackOrId || "");
    const store = getBeatGridsStore();
    const g = (tid && store[tid]) || null;

    const rawBpm = Number((g && g.bpm) || (tr && (tr.bpm || tr.effective_bpm)) || 120);
    const bpm = clamp(Number.isFinite(rawBpm) && rawBpm > 0 ? rawBpm : 120, 45, 220);
    const beatSec = 60.0 / bpm;
    const barSec = 4.0 * beatSec;
    const phraseSec = 4.0 * barSec;

    const firstBeatSec = g && Number.isFinite(Number(g.first_beat_sec))
      ? Math.max(0, Number(g.first_beat_sec))
      : Math.max(0, Number((tr && tr.beat_phase_sec) || 0) % beatSec);
    const barOffset = g && Number.isFinite(Number(g.bar_offset)) ? ((Number(g.bar_offset) % 4) + 4) % 4 : 0;
    const phraseBar = g && Number.isFinite(Number(g.phrase_bar)) ? ((Number(g.phrase_bar) % 4) + 4) % 4 : 0;
    const firstBarSec = firstBeatSec + barOffset * beatSec;
    const firstPhraseSec = firstBarSec + phraseBar * barSec;

    let groove = g && typeof g.groove === "string" ? g.groove : "";
    if (groove !== "4x4" && groove !== "broken" && groove !== "ambient") {
      if (tr && tr.is_spoken_word) groove = "ambient";
      else if (tr && (tr.cluster_id === "d0_ambient" || tr.groove_style === "ambient" || tr.groove_style === "dark_ambient")) groove = "ambient";
      else if (tr && tr.groove_style === "four_on_floor" && tr.cluster_id !== "d7_dnb_breaks" && tr.cluster_id !== "d9_uk_bass") groove = "4x4";
      else groove = "broken";
    }

    const cueInSec = g && Number.isFinite(Number(g.cue_in_sec))
      ? Math.max(0, Number(g.cue_in_sec))
      : (groove === "ambient" ? 0 : firstBarSec);
    const mixOutSec = g && Number.isFinite(Number(g.mix_out_sec)) ? Math.max(0, Number(g.mix_out_sec)) : null;
    const beatClarity = g && Number.isFinite(Number(g.beat_clarity))
      ? clamp(Number(g.beat_clarity), 0, 1)
      : clamp(Number((tr && tr.pulse_clarity) || 0.5), 0, 1);

    return {
      trackId: tid,
      bpm,
      beatSec,
      barSec,
      phraseSec,
      firstBeatSec,
      barOffset,
      phraseBar,
      firstBarSec,
      firstPhraseSec,
      beatClarity,
      groove,
      cueInSec,
      mixOutSec,
    };
  }

  function computeTempoMatch(gridA, gridB, currentRateA, tolPct) {
    const effBpmA = gridA.bpm * (Number.isFinite(currentRateA) && currentRateA > 0 ? currentRateA : 1.0);
    const baseB = gridB.bpm;
    if (!(effBpmA > 0) || !(baseB > 0)) {
      return { matched: false, rateB: 1.0, mult: 1.0, effBpmA: 120 };
    }
    const mults = [1.0, 0.5, 2.0];
    let bestMult = 1.0;
    let bestRate = 1.0;
    let bestDiff = Infinity;

    for (let i = 0; i < mults.length; i++) {
      const m = mults[i];
      const candBpm = baseB * m;
      const rate = effBpmA / candBpm;
      const diff = Math.abs(rate - 1.0);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestRate = rate;
        bestMult = m;
      }
    }

    if (bestDiff <= tolPct) {
      return {
        matched: true,
        rateB: clamp(bestRate, 1.0 - tolPct, 1.0 + tolPct),
        mult: bestMult,
        effBpmA,
      };
    }
    return { matched: false, rateB: 1.0, mult: 1.0, effBpmA };
  }

  function ensureCtx() {
    if (!ctx) {
      ctx = typeof baseAudio.ensureCtx === "function" ? baseAudio.ensureCtx() : null;
      if (!ctx && typeof window !== "undefined") {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ctx = new AC();
      }
    }
    if (ctx && !mixerMasterGain) {
      mixerMasterGain = ctx.createGain();
      mixerMasterGain.gain.value = enabled ? clamp(volume, 0, 1) : 0;
      masterAnalyser = ctx.createAnalyser();
      masterAnalyser.fftSize = 2048;
      masterAnalyser.smoothingTimeConstant = 0.5;
      analyserBuf = new Float32Array(masterAnalyser.fftSize);
      mixerMasterGain.connect(masterAnalyser);
      masterAnalyser.connect(ctx.destination);
    }
    if (ctx && ctx.state === "suspended" && typeof ctx.resume === "function") {
      ctx.resume().catch(() => {});
    }
    // Bind any existing decks into the Web Audio graph once ctx is live
    for (let i = 0; i < 2; i++) {
      if (decks[i]) bindDeckWebAudio(decks[i]);
    }
    return ctx;
  }

  function createDeck(idx) {
    if (typeof Audio === "undefined") return null;
    const webEl = new Audio();
    webEl.crossOrigin = "anonymous";
    webEl.preload = "auto";
    webEl.loop = false;
    applyPreservesPitch(webEl);

    const directEl = new Audio();
    directEl.preload = "auto";
    directEl.loop = false;
    applyPreservesPitch(directEl);

    const deck = {
      idx,
      webEl,
      directEl,
      mediaSource: null,
      bassFilter: null,
      deckGain: null,
      deckAnalyser: null,
      deckAnalyserBuf: null,
      bassDb: 0,
      gainVal: 1.0,
      playbackRate: 1.0,
    };
    if (ctx && mixerMasterGain) {
      bindDeckWebAudio(deck);
    }
    return deck;
  }

  function bindDeckWebAudio(deck) {
    if (!deck || deck.mediaSource || !ctx || !mixerMasterGain) return;
    try {
      const src = ctx.createMediaElementSource(deck.webEl);
      const filter = ctx.createBiquadFilter();
      filter.type = "lowshelf";
      filter.frequency.value = LOWSHELF_FREQ_HZ;
      filter.gain.value = deck.bassDb;

      const gain = ctx.createGain();
      gain.gain.value = deck.gainVal;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.4;

      src.connect(filter);
      filter.connect(gain);
      gain.connect(analyser);
      analyser.connect(mixerMasterGain);

      deck.mediaSource = src;
      deck.bassFilter = filter;
      deck.deckGain = gain;
      deck.deckAnalyser = analyser;
      deck.deckAnalyserBuf = new Float32Array(analyser.fftSize);
    } catch (_) {}
  }

  function ensureDecks() {
    if (!decks[0]) decks[0] = createDeck(0);
    if (!decks[1]) decks[1] = createDeck(1);
    return Boolean(decks[0] && decks[1]);
  }

  function readAnalyserRms(analyser, buf) {
    if (!analyser || !buf || !ctx || ctx.state !== "running") return 0;
    try {
      analyser.getFloatTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const s = buf[i];
        sumSq += s * s;
      }
      return Math.sqrt(sumSq / buf.length);
    } catch (_) {
      return 0;
    }
  }

  function getOutputRms() {
    return readAnalyserRms(masterAnalyser, analyserBuf);
  }

  function setVoicePlaybackRate(voice, rate) {
    if (!voice || voice.disposed) return;
    const r = clamp(Number.isFinite(rate) && rate > 0 ? rate : 1.0, 0.5, 2.0);
    voice.playbackRate = r;
    const deck = decks[voice.deckIdx];
    if (deck) deck.playbackRate = r;
    const el = voice.htmlAudio;
    if (el) {
      applyPreservesPitch(el);
      try {
        if (r === 1.0 || Math.abs(el.playbackRate - r) > 1e-6) {
          el.playbackRate = r;
        }
      } catch (_) {}
      applyPreservesPitch(el);
    }
  }

  function setVoiceBassDb(voice, db) {
    if (!voice || voice.disposed) return;
    const clampedDb = clamp(Number.isFinite(db) ? db : 0, -30, 6);
    voice.bassDb = clampedDb;
    const deck = decks[voice.deckIdx];
    if (deck) {
      deck.bassDb = clampedDb;
      if (deck.bassFilter && ctx) {
        try {
          deck.bassFilter.gain.setValueAtTime(clampedDb, ctx.currentTime);
        } catch (_) {
          deck.bassFilter.gain.value = clampedDb;
        }
      }
    }
  }

  function getTrackTrim(track) {
    return track && Number.isFinite(Number(track.gain_trim))
      ? clamp(Number(track.gain_trim), 0.25, 1.5)
      : 1.0;
  }

  function getVoiceBaseVolume(voice) {
    if (!voice || !enabled) return 0;
    return clamp(volume * getTrackTrim(voice.track), 0, 1);
  }

  function syncVoiceGainAndVolume(voice) {
    if (!voice || voice.disposed || !voice.htmlAudio) return;
    const el = voice.htmlAudio;
    const deck = decks[voice.deckIdx];
    const trim = getTrackTrim(voice.track);
    const fade = Number.isFinite(voice.fadeFactor) ? clamp(voice.fadeFactor, 0, 1) : 1.0;
    const mush = Number.isFinite(voice.mushFadeFactor) ? clamp(voice.mushFadeFactor, MUSH_MIN_FACTOR, 1) : 1.0;
    const holdSilentForSeek = voice.seekPending !== null && voice.seekPending > 0.02;

    if (voice.audioMode === "webaudio" && deck && deck.deckGain) {
      const targetGain = (!enabled || holdSilentForSeek) ? 0 : clamp(trim * fade * mush, 0, 1.5);
      deck.gainVal = targetGain;
      if (ctx) {
        try {
          deck.deckGain.gain.setValueAtTime(targetGain, ctx.currentTime);
        } catch (_) {
          deck.deckGain.gain.value = targetGain;
        }
      } else {
        deck.deckGain.gain.value = targetGain;
      }
      el.volume = 1.0;
      el.muted = !enabled;
    } else {
      // Direct HTMLAudioElement fallback mode
      const bassAtten = voice.bassDb < -6 ? (1.0 - 0.18 * clamp(-voice.bassDb / 24, 0, 1)) : 1.0;
      const targetVol = (!enabled || holdSilentForSeek)
        ? 0
        : clamp(volume * trim * fade * mush * bassAtten, 0, 1);
      el.volume = targetVol;
      el.muted = !enabled;
    }
  }

  function syncMasterGain() {
    const v = enabled ? clamp(volume, 0, 1) : 0;
    if (mixerMasterGain && ctx) {
      try {
        mixerMasterGain.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
      } catch (_) {
        mixerMasterGain.gain.value = v;
      }
    }
    if (active) syncVoiceGainAndVolume(active);
    if (outgoing) syncVoiceGainAndVolume(outgoing);
  }

  function computeTrackBounds(track, isFullTrack, knownDur) {
    if (!track) return { duration: 0, previewStart: 0, previewEnd: 0, previewDur: 20 };
    const isAi = Boolean(track.is_ai);
    const hasDropCue = Boolean(track.has_drop) && Number.isFinite(track.preview_start_sec) && Number(track.preview_start_sec) > 0;
    const finiteKnown = Number.isFinite(knownDur) && knownDur > 0 ? knownDur : 0;
    if (isFullTrack) {
      const estDur = finiteKnown || Number(track.full_duration_sec) || Number(track.duration_sec) || 0;
      if (isAi && !hasDropCue) {
        const fullSpanDur = Math.max(4, estDur || Number(track.duration_sec) || 22);
        return { duration: estDur, previewStart: 0, previewEnd: estDur, previewDur: fullSpanDur };
      }
      const rawCueVal = Number.isFinite(track.preview_start_sec)
        ? Number(track.preview_start_sec)
        : (Number.isFinite(track.cue_in_sec) ? Number(track.cue_in_sec) : (Number(track.cue_sec) || 0));
      const rawStart = Math.max(0, rawCueVal);
      const previewStart = estDur > 1.5 ? Math.min(rawStart, Math.max(0, estDur - 1.5)) : rawStart;
      const previewDur = Math.max(4, Number(track.preview_dur_sec) || Number(track.duration_sec) || 22);
      const previewEnd = estDur > 0 ? Math.min(estDur, previewStart + previewDur) : (previewStart + previewDur);
      return { duration: estDur, previewStart, previewEnd, previewDur };
    }
    const clipDur = finiteKnown || Number(track.duration_sec) || Number(track.preview_dur_sec) || 0;
    const rawCue = isAi ? 0 : Math.max(0, Number(track.cue_sec) || 0);
    const previewStart = clipDur > 1.0 ? Math.min(rawCue, Math.max(0, clipDur - 1.0)) : rawCue;
    const previewEnd = clipDur > 0 ? clipDur : Math.max(previewStart + 16, 20);
    return { duration: clipDur, previewStart, previewEnd, previewDur: Math.max(4, previewEnd - previewStart) };
  }

  function getVoiceBounds(voice) {
    if (!voice) return { duration: 0, previewStart: 0, previewEnd: 0, previewDur: 20 };
    const elDur = voice.htmlAudio && Number.isFinite(voice.htmlAudio.duration) && voice.htmlAudio.duration > 0
      ? voice.htmlAudio.duration
      : 0;
    return computeTrackBounds(voice.track, voice.isFullTrack, elDur);
  }

  function getVoiceDuration(voice) {
    return getVoiceBounds(voice).duration;
  }

  function getVoiceCurrentTime(voice) {
    if (!voice) return 0;
    if (voice.seekPending !== null && Number.isFinite(voice.seekPending)) {
      return Math.max(0, voice.seekPending);
    }
    if (voice.htmlAudio && Number.isFinite(voice.htmlAudio.currentTime)) {
      return Math.max(0, voice.htmlAudio.currentTime);
    }
    return 0;
  }

  function isVoiceActivelyPlaying(voice) {
    if (!voice || voice.disposed) return false;
    if (voice.htmlAudio) {
      return !voice.htmlAudio.paused && !voice.htmlAudio.ended;
    }
    return false;
  }

  function getRawMushTriggerSec(track, realDur) {
    if (!track || track.has_mush !== true) return null;
    const onset = Number(track.mush_onset_sec);
    if (!Number.isFinite(onset) || onset <= 0) return null;
    const trig = onset + MUSH_TASTE_SEC;
    if (Number.isFinite(realDur) && realDur > 0 && trig >= realDur - 1.2) return null;
    return trig;
  }

  function getEffectiveMushTriggerSec(voice, realDur) {
    if (!voice || !voice.isFullTrack || !voice.track) return null;
    const rawTrig = getRawMushTriggerSec(voice.track, realDur);
    if (rawTrig === null) return null;
    const eff = Number.isFinite(voice.mushCustomTriggerSec)
      ? Math.max(rawTrig, voice.mushCustomTriggerSec)
      : rawTrig;
    if (Number.isFinite(realDur) && realDur > 0 && eff >= realDur - 1.2) return null;
    return eff;
  }

  function cancelMushFade(voice) {
    if (!voice || voice.disposed) return;
    if (voice.mushFadeActive || voice.mushFadeFactor !== 1.0) {
      voice.mushFadeActive = false;
      voice.mushFadeStartMs = 0;
      voice.mushFadeFactor = 1.0;
      syncVoiceGainAndVolume(voice);
    }
  }

  function stopElementCleanly(el) {
    if (!el) return;
    try {
      el.pause();
      el.loop = false;
      el.removeAttribute("src");
      el.load();
    } catch (_) {}
  }

  function clearPrewarm(keepDeckElement = false) {
    if (!prewarm) return;
    const pw = prewarm;
    prewarm = null;
    pw.disposed = true;
    if (pw.cleanup) {
      try { pw.cleanup(); } catch (_) {}
      pw.cleanup = null;
    }
    if (!keepDeckElement && pw.el) {
      stopElementCleanly(pw.el);
    }
  }

  function stopVoice(voice) {
    if (!voice || voice.disposed) return;
    voice.disposed = true;
    if (voice.cleanup) {
      try { voice.cleanup(); } catch (_) {}
      voice.cleanup = null;
    }
    const deck = decks[voice.deckIdx];
    if (deck) {
      deck.bassDb = 0;
      deck.gainVal = 0;
      deck.playbackRate = 1.0;
      if (deck.bassFilter && ctx) {
        try { deck.bassFilter.gain.setValueAtTime(0, ctx.currentTime); } catch (_) { deck.bassFilter.gain.value = 0; }
      }
      if (deck.deckGain && ctx) {
        try { deck.deckGain.gain.setValueAtTime(0, ctx.currentTime); } catch (_) { deck.deckGain.gain.value = 0; }
      }
    }
    if (voice.htmlAudio) {
      stopElementCleanly(voice.htmlAudio);
    }
  }

  // ---- History & Deterministic Upcoming Next Track Resolution ----
  function recordHistoryVisit(trackId) {
    if (!trackId || !byId.has(trackId)) return;
    if (typeof baseAudio.syncHistorySelection === "function") {
      try { baseAudio.syncHistorySelection(trackId); } catch (_) {}
    }
    if (historyCursor >= 0 && playHistory[historyCursor] === trackId) return;
    if (historyCursor >= 0 && historyCursor + 1 < playHistory.length) {
      if (playHistory[historyCursor + 1] === trackId) {
        historyCursor += 1;
        return;
      }
      playHistory.splice(historyCursor + 1);
    }
    if (playHistory[playHistory.length - 1] !== trackId) {
      playHistory.push(trackId);
    }
    if (playHistory.length > 500) playHistory.shift();
    historyCursor = playHistory.length - 1;
  }

  function resolveHistoryAnchorId() {
    if (active && !active.disposed && active.trackId && byId.has(active.trackId)) {
      return active.trackId;
    }
    if (typeof window !== "undefined") {
      if (window.BTMM_PLAYER && typeof window.BTMM_PLAYER.selected === "function") {
        const sel = window.BTMM_PLAYER.selected();
        if (sel && byId.has(sel)) return sel;
      }
      if (window.ME_NODEMAP && typeof window.ME_NODEMAP.selected === "function") {
        const sel = window.ME_NODEMAP.selected();
        if (sel && byId.has(sel)) return sel;
      }
    }
    if (historyCursor >= 0 && historyCursor < playHistory.length && byId.has(playHistory[historyCursor])) {
      return playHistory[historyCursor];
    }
    if (typeof window !== "undefined" && window.ME_NODEMAP && typeof window.ME_NODEMAP.firstVisibleTrackId === "function") {
      const vis = window.ME_NODEMAP.firstVisibleTrackId();
      if (vis && byId.has(vis)) return vis;
    }
    return tracksList[0] ? tracksList[0].id : null;
  }

  function isActiveViewFilterMatch(cand) {
    if (!cand) return false;
    if (typeof window !== "undefined" && window.ME_NODEMAP) {
      const nm = window.ME_NODEMAP;
      if (
        typeof nm.isMapVisible === "function" &&
        nm.isMapVisible() &&
        typeof nm.isTrackMatched === "function"
      ) {
        return Boolean(nm.isTrackMatched(cand.id));
      }
    }
    if (typeof document !== "undefined") {
      const starBtn = document.getElementById("star-filter-btn");
      if (
        starBtn &&
        starBtn.getAttribute("aria-pressed") === "true" &&
        typeof window !== "undefined" &&
        window.BTMM_PLAYER &&
        typeof window.BTMM_PLAYER.isStarred === "function" &&
        !window.BTMM_PLAYER.isStarred(cand.id)
      ) {
        return false;
      }
      const searchEl = document.getElementById("search-input") || document.getElementById("map-search");
      const ql = searchEl && typeof searchEl.value === "string" ? searchEl.value.trim().toLowerCase() : "";
      if (ql) {
        if (ql === "has:mush" || ql === "is:mush" || ql === "tag:mush") {
          return Boolean(cand.has_mush === true && Number.isFinite(Number(cand.mush_onset_sec)));
        }
        const cd = typeof window !== "undefined" ? window.CORPUS_DATA : null;
        const erasArr = (cd && cd.eras) || [];
        let eraLbl = "";
        for (let i = 0; i < erasArr.length; i++) {
          if (erasArr[i] && erasArr[i].id === cand.era) {
            eraLbl = String(erasArr[i].label || "").toLowerCase();
            break;
          }
        }
        const hit =
          String(cand.title || "").toLowerCase().includes(ql) ||
          eraLbl.includes(ql) ||
          String(cand.cluster_label || "").toLowerCase().includes(ql) ||
          String(cand.key_label || "").toLowerCase().includes(ql) ||
          (typeof window !== "undefined" &&
            typeof window.formatSimpleKey === "function" &&
            window.formatSimpleKey(cand).toLowerCase() === ql) ||
          (Array.isArray(cand.discogs_styles) && cand.discogs_styles.some((s) => String(s).toLowerCase().includes(ql))) ||
          (Array.isArray(cand.mood_tags) && cand.mood_tags.some((s) => String(s).toLowerCase().includes(ql))) ||
          (Array.isArray(cand.instrument_tags) && cand.instrument_tags.some((s) => String(s).toLowerCase().includes(ql))) ||
          (ql.length >= 3 &&
            typeof window !== "undefined" &&
            window.BTMM_PLAYER &&
            typeof window.BTMM_PLAYER.isWorkInProgress === "function" &&
            window.BTMM_PLAYER.isWorkInProgress(cand) &&
            ("work in progress".includes(ql) || "wip".startsWith(ql))) ||
          (Boolean(cand.has_mush) && (ql === "mush" || ql === "ai mush" || (ql.length >= 3 && "mush".startsWith(ql))));
        if (!hit) return false;
      }
    }
    return true;
  }

  function isForwardWalkEligible(cand) {
    if (!cand) return false;
    const nm = typeof window !== "undefined" ? window.ME_NODEMAP : null;
    const sketchesShown =
      nm && typeof nm.getShowSketches === "function"
        ? Boolean(nm.getShowSketches())
        : false;
    if (!sketchesShown && cand.is_sketch) return false;
    if (nm && cand.is_ai) {
      const lay = typeof nm.getLayout === "function" ? nm.getLayout() : "vibe";
      if (lay === "era" && typeof nm.getShowEraGenAi === "function" && !nm.getShowEraGenAi()) {
        return false;
      }
      if (lay !== "era" && typeof nm.getShowVibeGenAi === "function" && !nm.getShowVibeGenAi()) {
        return false;
      }
    }
    return isActiveViewFilterMatch(cand);
  }

  function resolveNextDecision(opts = {}) {
    if (!tracksList.length) return null;
    const consume = Boolean(opts.consume);
    const curId = opts.anchorId && byId.has(opts.anchorId) ? opts.anchorId : resolveHistoryAnchorId();

    let effHistory = playHistory;
    let effCursor = historyCursor;
    if (curId && (effCursor < 0 || effHistory[effCursor] !== curId)) {
      if (consume) {
        recordHistoryVisit(curId);
        effHistory = playHistory;
        effCursor = historyCursor;
      } else {
        effHistory = playHistory.slice();
        if (effCursor >= 0 && effCursor + 1 < effHistory.length && effHistory[effCursor + 1] === curId) {
          effCursor += 1;
        } else {
          if (effCursor >= 0 && effCursor + 1 < effHistory.length) effHistory.splice(effCursor + 1);
          if (effHistory[effHistory.length - 1] !== curId) effHistory.push(curId);
          if (effHistory.length > 500) effHistory.shift();
          effCursor = effHistory.length - 1;
        }
      }
    }

    if (effCursor >= 0 && effCursor + 1 < effHistory.length) {
      for (let idx = effCursor + 1; idx < effHistory.length; idx++) {
        const fwdId = effHistory[idx];
        if (!fwdId || !byId.has(fwdId) || fwdId === curId) continue;
        const fwdTrack = byId.get(fwdId);
        if (!isForwardWalkEligible(fwdTrack)) continue;
        if (consume) historyCursor = idx;
        return { track: fwdTrack, fromForwardHistory: true };
      }
      if (consume && historyCursor >= 0 && historyCursor + 1 < playHistory.length) {
        playHistory.splice(historyCursor + 1);
      }
      effHistory = effHistory.slice(0, effCursor + 1);
    }

    const combinedExclude = new Set(visitedIds);
    for (let i = 0; i < effHistory.length; i++) combinedExclude.add(effHistory[i]);

    let nextTrack = baseAudio.pickNextSimilarTrack(curId, {
      peekOnly: true,
      allowSpoken: Boolean(opts.allowSpoken),
      excludeIds: combinedExclude,
    });
    if ((!nextTrack || nextTrack.id === curId) && tracksList.length > 1) {
      const curTrack = curId ? byId.get(curId) : null;
      const curIsAi = Boolean(curTrack && curTrack.is_ai);
      if (consume) {
        Array.from(visitedIds).forEach((vid) => {
          const vt = byId.get(vid);
          if (vt && Boolean(vt.is_ai) === curIsAi && vid !== curId) visitedIds.delete(vid);
        });
      }
      nextTrack = baseAudio.pickNextSimilarTrack(curId, {
        peekOnly: true,
        allowSpoken: Boolean(opts.allowSpoken),
        excludeIds: new Set(curId ? [curId] : []),
      });
    }
    if (!nextTrack) return null;
    if (consume) {
      if (playHistory[playHistory.length - 1] !== nextTrack.id) playHistory.push(nextTrack.id);
      if (playHistory.length > 500) playHistory.shift();
      historyCursor = playHistory.length - 1;
      visitedIds.add(nextTrack.id);
      if (typeof baseAudio.syncHistorySelection === "function") {
        try { baseAudio.syncHistorySelection(nextTrack.id); } catch (_) {}
      }
    }
    return { track: nextTrack, fromForwardHistory: false };
  }

  function peekNextTrack(anchorId) {
    const dec = resolveNextDecision({
      consume: false,
      anchorId: anchorId || null,
      allowSpoken: true,
    });
    return dec ? dec.track : null;
  }

  function setTrackIndex(tracks, graphMeta) {
    tracksList = Array.isArray(tracks) ? tracks.slice() : [];
    byId = new Map(tracksList.map((t) => [t.id, t]));
    baseAudio.setTrackIndex(tracks, graphMeta);
  }

  // ---- Auto-Play Mix-Out Trigger Calculation ----
  function computeAutoMixTriggerSec(voice, nextTrack, realDur) {
    if (!voice || !voice.track || !(realDur > 4.0)) return null;
    const gridA = voice.grid || getTrackGrid(voice.track);
    const gridB = nextTrack ? getTrackGrid(nextTrack) : null;
    const mushTrig = getEffectiveMushTriggerSec(voice, realDur);
    const effEnd = mushTrig !== null ? Math.min(realDur, mushTrig + 2.2) : realDur;

    const both4x4 = gridA.groove === "4x4" && gridB && gridB.groove === "4x4";
    const tempoMatch = both4x4 ? computeTempoMatch(gridA, gridB, voice.playbackRate, TEMPO_TOL_4X4) : { matched: false };
    const usePrecomputedMixOut = mushTrig === null && gridA.mixOutSec !== null;

    if (both4x4 && tempoMatch.matched && effEnd > gridA.barSec * 6.2) {
      // Count 4-bar phrases from firstPhraseSec and pick the latest 4-bar boundary leaving >= 5.0 bars of audio
      const minReserve = Math.max(8.0, AUTO_4X4_BLEND_BARS * gridA.barSec + 0.35);
      const maxStart = effEnd - minReserve;
      let mixSec = usePrecomputedMixOut ? Math.min(gridA.mixOutSec, maxStart) : maxStart;
      if (mixSec > gridA.firstPhraseSec + gridA.phraseSec) {
        const pIdx = Math.floor((mixSec - gridA.firstPhraseSec + 0.05) / gridA.phraseSec);
        mixSec = gridA.firstPhraseSec + Math.max(1, pIdx) * gridA.phraseSec;
      } else {
        const bIdx = Math.floor(Math.max(0, maxStart - gridA.firstBarSec) / gridA.barSec);
        mixSec = gridA.firstBarSec + Math.max(1, bIdx) * gridA.barSec;
      }
      return {
        triggerSec: clamp(mixSec, gridA.barSec, Math.max(gridA.barSec, effEnd - gridA.barSec * 2.2)),
        prewarmLeadSec: Math.max(5.5, 3.2 * gridA.barSec),
        blendType: "4x4-phrase-blend",
        tempoMatch,
        effEnd,
      };
    }

    if (gridA.groove !== "ambient" && (!gridB || gridB.groove !== "ambient") && effEnd > gridA.barSec * 2.5) {
      // Broken-beat / DnB / breakbeat / UK bass -> smooth 1-bar beat-synced fade near end
      const tmBroken = gridB ? computeTempoMatch(gridA, gridB, voice.playbackRate, TEMPO_TOL_BROKEN) : { matched: false, rateB: 1.0, mult: 1.0 };
      const reserve = Math.max(1.8, 1.35 * gridA.barSec);
      const maxStart = effEnd - reserve;
      let mixSec = usePrecomputedMixOut ? Math.min(gridA.mixOutSec, maxStart) : maxStart;
      const bIdx = Math.floor(Math.max(0, mixSec - gridA.firstBarSec + 0.04) / gridA.barSec);
      mixSec = gridA.firstBarSec + Math.max(1, bIdx) * gridA.barSec;
      return {
        triggerSec: clamp(mixSec, gridA.beatSec * 2, Math.max(gridA.beatSec * 2, effEnd - gridA.barSec * 1.05)),
        prewarmLeadSec: Math.max(4.5, 2.5 * gridA.barSec),
        blendType: "beat-short-1bar",
        tempoMatch: tmBroken,
        effEnd,
      };
    }

    // Beatless ambient track -> smooth equal-power crossfade
    const fadeSec = AMBIENT_FADE_MS / 1000;
    return {
      triggerSec: Math.max(0.5, effEnd - fadeSec - 0.15),
      prewarmLeadSec: 5.5,
      blendType: "ambient-crossfade",
      tempoMatch: { matched: false, rateB: 1.0, mult: 1.0 },
      effEnd,
    };
  }

  // ---- Standby Deck Prewarming ----
  function maybePrewarmNext(currentVoice, plan) {
    if (!autoPlay || outgoing || !currentVoice || !ensureDecks()) return;
    const standbyIdx = 1 - currentVoice.deckIdx;
    const nextTrack = peekNextTrack(currentVoice.trackId);
    if (!nextTrack) return;
    if (prewarm && !prewarm.disposed && prewarm.deckIdx === standbyIdx && prewarm.trackId === nextTrack.id) {
      return;
    }
    clearPrewarm(false);

    const cands = buildUrlCandidates(nextTrack);
    if (!cands.length) return;
    const gridB = getTrackGrid(nextTrack);
    const deck = decks[standbyIdx];
    if (!deck) return;

    const hasDropCue = Boolean(nextTrack.has_drop) && Number(nextTrack.preview_start_sec) > 0.02;
    const targetCue = plan && plan.blendType === "4x4-phrase-blend"
      ? gridB.cueInSec
      : (plan && plan.blendType === "beat-short-1bar"
        ? gridB.cueInSec
        : (hasDropCue ? Number(nextTrack.preview_start_sec) : 0));

    const pw = {
      deckIdx: standbyIdx,
      trackId: nextTrack.id,
      track: nextTrack,
      grid: gridB,
      cands,
      candIdx: 0,
      el: null,
      audioMode: "webaudio",
      isFullTrack: false,
      targetStart: targetCue,
      sought: targetCue <= 0.02,
      disposed: false,
      cleanup: null,
    };

    const bindCandidate = (idx) => {
      if (pw.disposed || idx >= pw.cands.length) return;
      if (pw.cleanup) {
        try { pw.cleanup(); } catch (_) {}
        pw.cleanup = null;
      }
      const cand = pw.cands[idx];
      pw.candIdx = idx;
      pw.audioMode = cand.mode === "webaudio" && ensureCtx() && deck.bassFilter ? "webaudio" : "direct";
      pw.isFullTrack = cand.isFullTrack;
      const el = pw.audioMode === "webaudio" ? deck.webEl : deck.directEl;
      pw.el = el;
      applyPreservesPitch(el);

      const onMeta = () => {
        if (pw.disposed || el.readyState < 1) return;
        applyPreservesPitch(el);
        if (!pw.sought) {
          const b = computeTrackBounds(nextTrack, pw.isFullTrack, el.duration);
          const dest = clamp(pw.targetStart, 0, Math.max(0, b.duration - 0.4));
          try {
            el.currentTime = dest;
            pw.sought = true;
          } catch (_) {}
        }
      };

      const onErr = () => {
        if (pw.disposed) return;
        if (cand.viaProxy) {
          corsProxyCooldownUntilMs = nowMs() + CORS_RETRY_COOLDOWN_MS;
        }
        if (pw.candIdx + 1 < pw.cands.length) {
          stopElementCleanly(el);
          bindCandidate(pw.candIdx + 1);
        }
      };

      el.addEventListener("loadedmetadata", onMeta);
      el.addEventListener("canplay", onMeta);
      el.addEventListener("error", onErr);
      pw.cleanup = () => {
        el.removeEventListener("loadedmetadata", onMeta);
        el.removeEventListener("canplay", onMeta);
        el.removeEventListener("error", onErr);
      };

      try {
        el.pause();
        el.loop = false;
        if (pw.audioMode === "webaudio" && deck.deckGain) {
          deck.deckGain.gain.value = 0;
          el.volume = 1.0;
          el.muted = !enabled;
        } else {
          el.volume = 0;
          el.muted = true;
        }
        if (plan && plan.tempoMatch && plan.tempoMatch.matched) {
          el.playbackRate = plan.tempoMatch.rateB;
          applyPreservesPitch(el);
        } else {
          el.playbackRate = 1.0;
          applyPreservesPitch(el);
        }
        el.src = cand.url;
        el.load();
      } catch (_) {
        pw.cleanup();
      }
    };

    bindCandidate(0);
    prewarm = pw;
  }

  // ---- Bar-Counted Blend & Post-Blend Tempo Glide Engine ----
  function cancelActiveBlendAndFinishOutgoing() {
    activeBlend = null;
    if (outgoing && !outgoing.disposed) {
      stopVoice(outgoing);
    }
    outgoing = null;
    if (active && !active.disposed) {
      active.fadeFactor = 1.0;
      setVoiceBassDb(active, 0);
      syncVoiceGainAndVolume(active);
    }
  }

  function cancelTempoGlide(snapToNatural = true) {
    activeGlide = null;
    if (snapToNatural && active && !active.disposed) {
      setVoicePlaybackRate(active, 1.0);
    }
  }

  function startPostBlendTempoGlide(voice, fromRate, barsCount) {
    if (!voice || voice.disposed || Math.abs((fromRate || 1.0) - 1.0) < 0.002) {
      if (voice && !voice.disposed) setVoicePlaybackRate(voice, 1.0);
      activeGlide = null;
      return;
    }
    const grid = voice.grid || getTrackGrid(voice.track);
    activeGlide = {
      voice,
      fromRate,
      toRate: 1.0,
      startMediaSec: getVoiceCurrentTime(voice),
      startWallMs: nowMs(),
      durBars: Math.max(0.5, barsCount || TEMPO_GLIDE_BARS),
      barSec: grid.barSec,
    };
  }

  function stepBlendAndGlide() {
    rafId = 0;
    const now = nowMs();
    let keepAnimating = false;

    if (activeBlend) {
      const bState = activeBlend;
      const outV = bState.outgoing;
      const inV = bState.incoming;

      if (!inV || inV.disposed) {
        cancelActiveBlendAndFinishOutgoing();
      } else if (!outV || outV.disposed) {
        inV.fadeFactor = 1.0;
        setVoiceBassDb(inV, 0);
        syncVoiceGainAndVolume(inV);
        startPostBlendTempoGlide(inV, inV.playbackRate, bState.glideBars);
        activeBlend = null;
        keepAnimating = Boolean(activeGlide);
      } else {
        let progress01 = 0;
        let elapsedBars = 0;

        if (bState.blendType === "ambient-crossfade") {
          progress01 = clamp((now - bState.startWallMs) / Math.max(80, bState.durMs), 0, 1);
          elapsedBars = progress01 * bState.totalBars;
        } else {
          // Count progress strictly in musical BARS of the outgoing track's beat-grid!
          const curMediaOut = getVoiceCurrentTime(outV);
          const mediaDelta = curMediaOut - bState.startMediaSecA;
          const wallBars = ((now - bState.startWallMs) / 1000.0) * (outV.playbackRate || 1.0) / Math.max(0.25, bState.barSecA);
          if (!outV.htmlAudio || outV.htmlAudio.ended) {
            elapsedBars = bState.totalBars;
          } else if (mediaDelta >= -0.02 && isVoiceActivelyPlaying(outV)) {
            // Use sample-accurate media bar position, bounded softly by wall clock if network stalls
            elapsedBars = Math.max(Math.max(0, mediaDelta / Math.max(0.25, bState.barSecA)), wallBars * 0.85);
          } else {
            elapsedBars = Math.max(0, wallBars);
          }
          progress01 = clamp(elapsedBars / Math.max(0.25, bState.totalBars), 0, 1);
        }

        bState.elapsedBars = elapsedBars;

        if (progress01 >= 1.0) {
          stopVoice(outV);
          if (outgoing === outV) outgoing = null;
          inV.fadeFactor = 1.0;
          setVoiceBassDb(inV, 0);
          syncVoiceGainAndVolume(inV);
          activeBlend = null;
          startPostBlendTempoGlide(inV, inV.playbackRate, bState.glideBars);
          keepAnimating = Boolean(activeGlide);
        } else if (bState.blendType === "4x4-phrase-blend") {
          // 5-bar choreography (normalized across totalBars so shortened tail blends keep exact proportions):
          //   0.00..0.20 (Bar 0..1): Incoming highs/mids fade in with -24 dB bass cut; Outgoing full
          //   0.20..0.60 (Bar 1..3): Smooth 180 Hz bass swap (Incoming -24 -> 0 dB, Outgoing 0 -> -24 dB)
          //   0.60..1.00 (Bar 3..5): Outgoing fades cleanly to 0
          let gainIn = 1.0;
          let bassIn = 0.0;
          let gainOut = bState.outStartGain;
          let bassOut = bState.outStartBassDb;

          if (progress01 < 0.20) {
            const p = progress01 / 0.20;
            gainIn = Math.sin(p * Math.PI * 0.5);
            bassIn = BASS_CUT_DB;
            gainOut = bState.outStartGain;
            bassOut = bState.outStartBassDb;
          } else if (progress01 < 0.60) {
            const s = smoothstep01((progress01 - 0.20) / 0.40);
            gainIn = 1.0;
            bassIn = BASS_CUT_DB * (1.0 - s);
            gainOut = bState.outStartGain * (1.0 - 0.12 * s);
            bassOut = bState.outStartBassDb + (BASS_CUT_DB - bState.outStartBassDb) * s;
          } else {
            const v = clamp((progress01 - 0.60) / 0.40, 0, 1);
            gainIn = 1.0;
            bassIn = 0.0;
            gainOut = bState.outStartGain * 0.88 * Math.cos(v * Math.PI * 0.5);
            bassOut = BASS_CUT_DB;
          }

          inV.fadeFactor = gainIn;
          setVoiceBassDb(inV, bassIn);
          syncVoiceGainAndVolume(inV);

          outV.fadeFactor = gainOut;
          setVoiceBassDb(outV, bassOut);
          syncVoiceGainAndVolume(outV);
          keepAnimating = true;
        } else if (bState.blendType === "4x4-manual-1bar") {
          // Immediate 1-bar (4-beat) 4/4 bass-swap + crossfade:
          //   0.00..0.35: Incoming enters with -24 dB bass cut
          //   0.20..0.80: Smooth 180 Hz bass swap (-24 -> 0 dB / 0 -> -24 dB)
          //   0.35..1.00: Outgoing fades smoothly to 0
          const gainIn = progress01 < 0.35 ? Math.sin((progress01 / 0.35) * Math.PI * 0.5) : 1.0;
          const swapS = smoothstep01((progress01 - 0.20) / 0.60);
          const bassIn = BASS_CUT_DB * (1.0 - swapS);
          const bassOut = bState.outStartBassDb + (BASS_CUT_DB - bState.outStartBassDb) * swapS;
          const fadeOutP = clamp((progress01 - 0.30) / 0.70, 0, 1);
          const gainOut = bState.outStartGain * Math.cos(fadeOutP * Math.PI * 0.5);

          inV.fadeFactor = gainIn;
          setVoiceBassDb(inV, bassIn);
          syncVoiceGainAndVolume(inV);

          outV.fadeFactor = gainOut;
          setVoiceBassDb(outV, bassOut);
          syncVoiceGainAndVolume(outV);
          keepAnimating = true;
        } else {
          // Broken-beat 1-bar beat-synced short fade OR ambient equal-power crossfade
          const gainIn = Math.sin(progress01 * Math.PI * 0.5);
          const gainOut = bState.outStartGain * Math.cos(progress01 * Math.PI * 0.5);
          const bassOut = bState.blendType === "beat-short-1bar"
            ? bState.outStartBassDb + (-8.0 - bState.outStartBassDb) * smoothstep01(progress01)
            : 0.0;

          inV.fadeFactor = gainIn;
          setVoiceBassDb(inV, 0.0);
          syncVoiceGainAndVolume(inV);

          outV.fadeFactor = gainOut;
          setVoiceBassDb(outV, bassOut);
          syncVoiceGainAndVolume(outV);
          keepAnimating = true;
        }
      }
    }

    if (activeGlide) {
      const g = activeGlide;
      if (!g.voice || g.voice.disposed || g.voice !== active) {
        activeGlide = null;
      } else {
        const mediaBars = (getVoiceCurrentTime(g.voice) - g.startMediaSec) / Math.max(0.25, g.barSec);
        const wallBars = ((now - g.startWallMs) / 1000.0) / Math.max(0.25, g.barSec);
        const barsDone = Math.max(0, mediaBars >= 0 ? mediaBars : wallBars, wallBars * 0.85);
        const p = clamp(barsDone / Math.max(0.25, g.durBars), 0, 1);
        if (p >= 1.0) {
          setVoicePlaybackRate(g.voice, 1.0);
          activeGlide = null;
        } else {
          const s = smoothstep01(p);
          const curRate = g.fromRate + (g.toRate - g.fromRate) * s;
          setVoicePlaybackRate(g.voice, curRate);
          keepAnimating = true;
        }
      }
    }

    if (active && !active.disposed && active.mushFadeActive) {
      if (!autoPlay) {
        cancelMushFade(active);
      } else {
        const pMush = clamp((now - active.mushFadeStartMs) / MUSH_FADE_MS, 0, 1);
        if (pMush >= 1) {
          active.mushFadeActive = false;
          active.mushFadeFactor = MUSH_MIN_FACTOR;
          active.autoTransitionFired = true;
          advanceToNextAuto({ fromMushFade: true });
          return;
        }
        active.mushFadeFactor = MUSH_MIN_FACTOR + (1.0 - MUSH_MIN_FACTOR) * Math.cos(pMush * Math.PI * 0.5);
        syncVoiceGainAndVolume(active);
        keepAnimating = true;
      }
    }

    if (keepAnimating && typeof requestAnimationFrame === "function" && typeof document !== "undefined" && !document.hidden) {
      rafId = requestAnimationFrame(stepBlendAndGlide);
    }
    if (!active && !outgoing) {
      stopTickLoop();
    }
  }

  function ensureAnimRaf() {
    if (!rafId && typeof requestAnimationFrame === "function" && typeof document !== "undefined" && !document.hidden) {
      rafId = requestAnimationFrame(stepBlendAndGlide);
    }
  }

  // ---- Playback State & Notifications ----
  function buildPlaybackState() {
    if (active && !active.disposed) {
      const b = getVoiceBounds(active);
      return {
        trackId: active.trackId,
        playing: isVoiceActivelyPlaying(active),
        pending: false,
        currentTime: getVoiceCurrentTime(active),
        duration: b.duration,
        previewStart: b.previewStart,
        previewEnd: b.previewEnd,
        isFullTrack: Boolean(active.isFullTrack),
        looping: !autoPlay,
        autoPlay: Boolean(autoPlay),
        mushFadeActive: Boolean(active.mushFadeActive),
        mushFadeFactor: Number.isFinite(active.mushFadeFactor) ? active.mushFadeFactor : 1.0,
        baseVolume: getVoiceBaseVolume(active),
        playbackRate: active.playbackRate || 1.0,
        preservesPitch: readPreservesPitch(active.htmlAudio),
        djBlendActive: Boolean(activeBlend),
        djBlendType: activeBlend ? activeBlend.blendType : null,
      };
    }
    if (pending) {
      const b = computeTrackBounds(pending.track, Boolean(pending.isFullTrack), 0);
      return {
        trackId: pending.trackId,
        playing: false,
        pending: true,
        currentTime: 0,
        duration: b.duration,
        previewStart: b.previewStart,
        previewEnd: b.previewEnd,
        isFullTrack: Boolean(pending.isFullTrack),
        looping: !autoPlay,
        autoPlay: Boolean(autoPlay),
      };
    }
    if (lastPaused && byId.has(lastPaused.trackId)) {
      return {
        trackId: lastPaused.trackId,
        playing: false,
        pending: false,
        currentTime: lastPaused.currentTime,
        duration: lastPaused.duration,
        previewStart: lastPaused.previewStart,
        previewEnd: lastPaused.previewEnd,
        isFullTrack: Boolean(lastPaused.isFullTrack),
        looping: !autoPlay,
        autoPlay: Boolean(autoPlay),
      };
    }
    return {
      trackId: null,
      playing: false,
      pending: false,
      currentTime: 0,
      duration: 0,
      previewStart: 0,
      previewEnd: 0,
      isFullTrack: false,
      looping: !autoPlay,
      autoPlay: Boolean(autoPlay),
    };
  }

  function notifyStateChange(opts = {}) {
    const snap = buildPlaybackState();
    if (!opts.skipAppCallback) {
      try { onStateChangeCb(active, pending, snap); } catch (_) {}
    }
    stateListeners.forEach((fn) => {
      try { fn(snap, active, pending); } catch (_) {}
    });
  }

  // ---- Auto-Play Advance ----
  function advanceToNextAuto(opts = {}) {
    if (!active || active.disposed) return null;
    const prevId = active.trackId;
    const dec = resolveNextDecision({ consume: true, anchorId: prevId, allowSpoken: false });
    const nextTrack = dec ? dec.track : baseAudio.pickNextSimilarTrack(prevId, { peekOnly: false });
    if (!nextTrack) return null;

    if (typeof window !== "undefined" && window.BTMM_EVENTS && typeof window.BTMM_EVENTS.notifyTrackIntent === "function") {
      try { window.BTMM_EVENTS.notifyTrackIntent(nextTrack.id, { source: "autoplay" }); } catch (_) {}
    }

    const ma = typeof window !== "undefined" && window.ME_AUDIO ? window.ME_AUDIO : null;
    const playFn = ma && typeof ma.playTrack === "function" ? ma.playTrack : playTrack;
    playFn.call(ma, nextTrack, {
      fromAutoPlay: true,
      fromMushFade: Boolean(opts.fromMushFade),
      djPlan: opts.djPlan || null,
    });

    if (typeof onAutoAdvanceCb === "function") {
      try { onAutoAdvanceCb(nextTrack.id, prevId); } catch (_) {}
    } else if (typeof window !== "undefined") {
      if (window.ME_NODEMAP && typeof window.ME_NODEMAP.setSelectedSilent === "function") {
        window.ME_NODEMAP.setSelectedSilent(nextTrack.id);
      }
      if (window.BTMM_PLAYER && typeof window.BTMM_PLAYER.select === "function") {
        window.BTMM_PLAYER.select(nextTrack.id, { fromAutoPlay: true });
      }
    }
    notifyStateChange();
    return nextTrack.id;
  }

  // ---- Main Playback & Beat-Grid Tick Loop ----
  function tickPlayback() {
    stepBlendAndGlide();

    if (!active || active.disposed) return;
    const el = active.htmlAudio;
    if (!el) return;

    const curSec = getVoiceCurrentTime(active);
    const grid = active.grid || getTrackGrid(active.track);
    const beatDur = Math.max(0.05, grid.beatSec / (active.playbackRate || 1.0));
    const barDur = beatDur * 4;
    const relSec = Math.max(0, curSec - grid.firstBeatSec);
    const step = Math.floor((relSec / grid.beatSec) * 4) % 16;
    const barIdx = Math.floor(Math.max(0, curSec - grid.firstBarSec) / grid.barSec);
    active.beatDurSec = beatDur;
    active.barDurSec = barDur;
    try { onBeatCb(active.trackId, step, barIdx, active); } catch (_) {}

    if (active.seekPending !== null) return;
    if (active.stopIdx >= 0) return;

    if (!autoPlay) {
      cancelMushFade(active);
      if (active.isFullTrack) {
        el.loop = false;
        const b = getVoiceBounds(active);
        if (active.loopWindowActive && b.previewEnd > b.previewStart + 0.5) {
          if (curSec >= b.previewEnd - 0.05) {
            try { el.currentTime = b.previewStart; } catch (_) {}
          }
        } else if (!active.loopWindowActive && b.duration > 1.0 && curSec >= b.duration - 0.1) {
          active.loopWindowActive = true;
          try { el.currentTime = b.previewStart; } catch (_) {}
        }
      } else {
        el.loop = true;
      }
      return;
    }

    // Auto-Play ON: AI Mush +3.0s Taste & Cosine Fade-Out Gate (d34d1af / post-023316)
    el.loop = false;
    if (active.track && active.track.is_spoken_word) return;
    const realDur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    if (realDur <= 0 || active.autoTransitionFired) return;

    const mushTrig = getEffectiveMushTriggerSec(active, realDur);
    if (mushTrig !== null) {
      active.autoPlan = {
        triggerSec: mushTrig,
        prewarmLeadSec: MUSH_TASTE_SEC,
        blendType: "mush-fade",
        tempoMatch: { matched: false, rateB: 1.0, mult: 1.0 },
        effEnd: Math.min(realDur, mushTrig + MUSH_FADE_MS / 1000),
      };
      if (!outgoing && curSec >= mushTrig - MUSH_TASTE_SEC) {
        maybePrewarmNext(active, active.autoPlan);
      }
      if (!active.mushFadeActive && curSec >= mushTrig) {
        active.mushFadeActive = true;
        active.mushFadeStartMs = nowMs();
        active.mushFadeFactor = 1.0;
        ensureAnimRaf();
        notifyStateChange({ skipAppCallback: true });
      }
      if (realDur - curSec > 0.35) {
        return;
      }
    }

    // Auto-Play ON: Beat-grid & 4-bar phrase DJ scheduling
    const nextCandidate = peekNextTrack(active.trackId);
    const plan = computeAutoMixTriggerSec(active, nextCandidate, realDur);
    active.autoPlan = plan;
    if (!plan) return;

    if (!outgoing && curSec >= plan.triggerSec - plan.prewarmLeadSec && curSec < plan.effEnd - 0.2) {
      maybePrewarmNext(active, plan);
    }

    // If user manually scrubbed past the planned 4-bar boundary while >= 1.5 bars remain,
    // wait for the very next 1-bar downbeat so the transition still enters cleanly on the bar!
    let effectiveTriggerSec = plan.triggerSec;
    if (active.lastManualSeekSec !== null && active.lastManualSeekSec > plan.triggerSec + 0.25) {
      const nextBarIdx = Math.ceil((active.lastManualSeekSec - grid.firstBarSec) / grid.barSec);
      const nextBarSec = grid.firstBarSec + Math.max(0, nextBarIdx) * grid.barSec;
      if (plan.effEnd - nextBarSec >= grid.barSec * 1.2) {
        effectiveTriggerSec = nextBarSec;
      } else {
        effectiveTriggerSec = Math.max(active.lastManualSeekSec, plan.effEnd - grid.barSec);
      }
    }

    if (curSec >= effectiveTriggerSec) {
      active.autoTransitionFired = true;
      advanceToNextAuto({ djPlan: { ...plan, triggerSec: effectiveTriggerSec } });
    }
  }

  function startTickLoop() {
    if (tickTimer !== null) return;
    tickTimer = setInterval(tickPlayback, TICK_MS);
  }

  function stopTickLoop() {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (rafId && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  // ---- Plan Transition Type & Beat/Phrase Alignment ----
  function resolveTransitionConfig(outVoice, inTrack, opts) {
    const gridB = getTrackGrid(inTrack);
    if (
      !outVoice ||
      outVoice.disposed ||
      !isVoiceActivelyPlaying(outVoice) ||
      (opts && (opts.stopIdx >= 0 || opts.fromMushFade))
    ) {
      return {
        shouldBlend: false,
        blendType: null,
        rateB: 1.0,
        mult: 1.0,
        totalBars: 0,
        durMs: 0,
        initialBassDbB: 0,
        initialGainB: 1.0,
        startSecOffsetB: 0,
        useCueInB: false,
      };
    }

    const gridA = outVoice.grid || getTrackGrid(outVoice.track);
    const curSecA = getVoiceCurrentTime(outVoice);
    const realDurA = outVoice.htmlAudio && Number.isFinite(outVoice.htmlAudio.duration) && outVoice.htmlAudio.duration > 0
      ? outVoice.htmlAudio.duration
      : (Number(outVoice.track && outVoice.track.full_duration_sec) || 60);
    const availBarsA = Math.max(0.5, (realDurA - curSecA) / gridA.barSec);
    const isAuto = Boolean(opts && opts.fromAutoPlay);

    // 1. Auto-Play 4/4 Phrase Blend (5 bars: 1 bar highs-in + 2 bars bass-swap + 2 bars fade-out)
    if (isAuto && gridA.groove === "4x4" && gridB.groove === "4x4") {
      const tm = (opts.djPlan && opts.djPlan.tempoMatch) || computeTempoMatch(gridA, gridB, outVoice.playbackRate, TEMPO_TOL_4X4);
      if (tm.matched) {
        const triggerRef = opts.djPlan && Number.isFinite(opts.djPlan.triggerSec) ? opts.djPlan.triggerSec : curSecA;
        const lateSecA = clamp(curSecA - triggerRef, 0, gridA.barSec * 0.5);
        const phaseCompB = lateSecA * (gridB.bpm * tm.mult / Math.max(45, gridA.bpm));
        const totalBars = clamp(Math.min(AUTO_4X4_BLEND_BARS, availBarsA - 0.15), 1.5, AUTO_4X4_BLEND_BARS);
        return {
          shouldBlend: true,
          blendType: "4x4-phrase-blend",
          rateB: tm.rateB,
          mult: tm.mult,
          totalBars,
          durMs: Math.round((totalBars * gridA.barSec / (outVoice.playbackRate || 1.0)) * 1000),
          initialBassDbB: BASS_CUT_DB,
          initialGainB: 0.0,
          startSecOffsetB: phaseCompB,
          useCueInB: true,
          glideBars: TEMPO_GLIDE_BARS,
        };
      }
    }

    // 2. Manual Next (>|) / Prev (|<) / Track Click while playing -> Immediate 1-bar transition!
    if (!isAuto) {
      if (gridA.groove === "4x4" && gridB.groove === "4x4") {
        const tm = computeTempoMatch(gridA, gridB, outVoice.playbackRate, TEMPO_TOL_4X4);
        if (tm.matched) {
          const inBarBeatsA = (((curSecA - gridA.firstBarSec) / gridA.beatSec) % 4 + 4) % 4;
          const phaseOffsetB = (inBarBeatsA * gridB.beatSec) / tm.mult;
          const totalBars = Math.min(MANUAL_BLEND_BARS, Math.max(0.5, availBarsA));
          return {
            shouldBlend: true,
            blendType: "4x4-manual-1bar",
            rateB: tm.rateB,
            mult: tm.mult,
            totalBars,
            durMs: Math.round((totalBars * gridA.barSec / (outVoice.playbackRate || 1.0)) * 1000),
            initialBassDbB: BASS_CUT_DB,
            initialGainB: 0.0,
            startSecOffsetB: phaseOffsetB,
            useCueInB: false,
            snapStartToBarB: true,
            glideBars: 1.5,
          };
        }
      }

      if (gridA.groove !== "ambient" && gridB.groove !== "ambient") {
        const tm = computeTempoMatch(gridA, gridB, outVoice.playbackRate, TEMPO_TOL_BROKEN);
        const inBeatPhaseA = (((curSecA - gridA.firstBeatSec) / gridA.beatSec) % 1 + 1) % 1;
        const phaseOffsetB = tm.matched ? (inBeatPhaseA * gridB.beatSec) / tm.mult : 0;
        const totalBars = Math.min(MANUAL_BLEND_BARS, Math.max(0.5, availBarsA));
        return {
          shouldBlend: true,
          blendType: "beat-short-1bar",
          rateB: tm.matched ? tm.rateB : 1.0,
          mult: tm.mult,
          totalBars,
          durMs: Math.round((totalBars * gridA.barSec / (outVoice.playbackRate || 1.0)) * 1000),
          initialBassDbB: 0.0,
          initialGainB: 0.0,
          startSecOffsetB: phaseOffsetB,
          useCueInB: false,
          snapStartToBeatB: true,
          glideBars: 1.0,
        };
      }

      return {
        shouldBlend: true,
        blendType: "ambient-crossfade",
        rateB: 1.0,
        mult: 1.0,
        totalBars: 1.0,
        durMs: 1200,
        initialBassDbB: 0.0,
        initialGainB: 0.0,
        startSecOffsetB: 0,
        useCueInB: false,
        glideBars: 0,
      };
    }

    // 3. Auto-Play Broken-Beat / DnB / UK Bass / Far-BPM -> Smooth 1-bar beat-synced short fade
    if (gridA.groove !== "ambient" && gridB.groove !== "ambient") {
      const tm = (opts.djPlan && opts.djPlan.tempoMatch) || computeTempoMatch(gridA, gridB, outVoice.playbackRate, TEMPO_TOL_BROKEN);
      const totalBars = Math.min(BROKEN_FADE_BARS, Math.max(0.5, availBarsA - 0.1));
      return {
        shouldBlend: true,
        blendType: "beat-short-1bar",
        rateB: tm.matched ? tm.rateB : 1.0,
        mult: tm.mult || 1.0,
        totalBars,
        durMs: Math.round((totalBars * gridA.barSec / (outVoice.playbackRate || 1.0)) * 1000),
        initialBassDbB: 0.0,
        initialGainB: 0.0,
        startSecOffsetB: 0,
        useCueInB: true,
        glideBars: 1.0,
      };
    }

    // 4. Auto-Play Ambient -> Smooth equal-power crossfade
    return {
      shouldBlend: true,
      blendType: "ambient-crossfade",
      rateB: 1.0,
      mult: 1.0,
      totalBars: 1.0,
      durMs: AMBIENT_FADE_MS,
      initialBassDbB: 0.0,
      initialGainB: 0.0,
      startSecOffsetB: 0,
      useCueInB: false,
      glideBars: 0,
    };
  }

  // ---- Core Dual-Deck `playTrack` ----
  function playTrack(trackOrId, opts = {}) {
    const tr = typeof trackOrId === "object" ? trackOrId : byId.get(trackOrId);
    const cands = buildUrlCandidates(tr);
    if (!tr || !cands.length || !ensureDecks()) return false;

    ensureCtx();
    const gen = ++generation;
    const now = nowMs();

    if (tr.id) {
      visitedIds.add(tr.id);
      if (!opts.fromHistoryNav) {
        recordHistoryVisit(tr.id);
      }
    }

    // Warm resume if the exact track is already paused on active deck
    if (
      active &&
      !active.disposed &&
      active.trackId === tr.id &&
      active.htmlAudio &&
      active.htmlAudio.paused &&
      active.htmlAudio.getAttribute("src") &&
      (opts.stopIdx === undefined || opts.stopIdx === active.stopIdx)
    ) {
      const elWarm = active.htmlAudio;
      lastPaused = null;
      pending = null;
      if (typeof opts.startSec === "number" && Number.isFinite(opts.startSec)) {
        const dest = Math.max(0, opts.startSec);
        const mushOnsetWarm = tr.has_mush === true ? Number(tr.mush_onset_sec) : NaN;
        active.mushCustomTriggerSec =
          Number.isFinite(mushOnsetWarm) && mushOnsetWarm > 0 && dest >= mushOnsetWarm
            ? dest + MUSH_TASTE_SEC
            : null;
        active.autoTransitionFired = false;
        if (elWarm.readyState >= 1) {
          try { elWarm.currentTime = dest; active.seekPending = null; } catch (_) { active.seekPending = dest; }
        } else {
          active.seekPending = dest;
        }
      } else if (opts.fromStart) {
        active.mushCustomTriggerSec = null;
        active.autoTransitionFired = false;
        if (elWarm.readyState >= 1) {
          try { elWarm.currentTime = 0; active.seekPending = null; } catch (_) { active.seekPending = 0; }
        } else {
          active.seekPending = 0;
        }
      }
      active.fadeFactor = 1.0;
      setVoiceBassDb(active, 0);
      setVoicePlaybackRate(active, 1.0);
      cancelMushFade(active);
      syncVoiceGainAndVolume(active);
      startTickLoop();
      elWarm.play().catch(() => {
        if (active && !active.disposed) {
          try { elWarm.pause(); } catch (_) {}
          stopTickLoop();
          notifyStateChange();
        }
      });
      notifyStateChange({ skipAppCallback: Boolean(opts.fromAutoPlay) });
      return true;
    }

    lastPaused = null;
    pending = null;
    cancelTempoGlide(false);

    const transCfg = resolveTransitionConfig(active, tr, opts);

    // Choose next deck & move previous active to outgoing if blending
    let nextDeckIdx = 0;
    let prevOutForBlend = null;
    if (active && !active.disposed) {
      nextDeckIdx = 1 - active.deckIdx;
      if (outgoing && !outgoing.disposed) {
        stopVoice(outgoing);
        outgoing = null;
      }
      activeBlend = null;

      if (transCfg.shouldBlend && !opts.fromMushFade) {
        prevOutForBlend = active;
        active = null;
        cancelMushFade(prevOutForBlend);
        outgoing = prevOutForBlend;
      } else {
        cancelMushFade(active);
        stopVoice(active);
        active = null;
      }
    } else if (outgoing && !outgoing.disposed) {
      nextDeckIdx = 1 - outgoing.deckIdx;
    }

    const deck = decks[nextDeckIdx];
    const gridB = getTrackGrid(tr);

    const reusePrewarm = Boolean(
      prewarm &&
      !prewarm.disposed &&
      prewarm.deckIdx === nextDeckIdx &&
      prewarm.trackId === tr.id &&
      prewarm.el
    );

    const candIdxInit = reusePrewarm ? prewarm.candIdx : 0;
    const activeCands = reusePrewarm ? prewarm.cands : cands;
    if (reusePrewarm) {
      clearPrewarm(true);
    } else {
      clearPrewarm(false);
    }

    // Stop the inactive sibling element on the target deck so webEl & directEl never play simultaneously
    const firstCand = activeCands[candIdxInit];
    const initAudioMode = firstCand.mode === "webaudio" && ctx && deck.bassFilter ? "webaudio" : "direct";
    const initEl = initAudioMode === "webaudio" ? deck.webEl : deck.directEl;
    const siblingEl = initAudioMode === "webaudio" ? deck.directEl : deck.webEl;
    if (!reusePrewarm) stopElementCleanly(siblingEl);

    const initBounds = computeTrackBounds(
      tr,
      firstCand.isFullTrack,
      reusePrewarm && Number.isFinite(initEl.duration) ? initEl.duration : 0
    );
    const hasDropCue = Boolean(tr.has_drop) && initBounds.previewStart > 0.02;

    let baseStartSec = 0;
    if (typeof opts.startSec === "number" && Number.isFinite(opts.startSec)) {
      baseStartSec = Math.max(0, opts.startSec);
    } else if (opts.fromStart) {
      baseStartSec = 0;
    } else if (transCfg.useCueInB) {
      baseStartSec = gridB.cueInSec;
    } else if (opts.fromAutoPlay && !hasDropCue) {
      baseStartSec = gridB.groove === "ambient" ? 0 : gridB.cueInSec;
    } else if (tr.is_ai && !hasDropCue) {
      baseStartSec = 0;
    } else {
      baseStartSec = initBounds.previewStart;
    }

    // Snap manual blend cue to nearest bar/beat on incoming track + add beat-phase offset from outgoing track
    let initialStartSec = baseStartSec;
    if (transCfg.shouldBlend && opts.startSec === undefined && !opts.fromStart) {
      if (transCfg.snapStartToBarB) {
        const bIdx = Math.max(0, Math.round((baseStartSec - gridB.firstBarSec) / gridB.barSec));
        initialStartSec = gridB.firstBarSec + bIdx * gridB.barSec + transCfg.startSecOffsetB;
      } else if (transCfg.snapStartToBeatB) {
        const beatIdx = Math.max(0, Math.round((baseStartSec - gridB.firstBeatSec) / gridB.beatSec));
        initialStartSec = gridB.firstBeatSec + beatIdx * gridB.beatSec + transCfg.startSecOffsetB;
      } else {
        initialStartSec = baseStartSec + transCfg.startSecOffsetB;
      }
    }
    if (initBounds.duration > 2.0) {
      initialStartSec = clamp(initialStartSec, 0, Math.max(0, initBounds.duration - 1.5));
    }

    const alreadySought = Boolean(
      reusePrewarm &&
      initEl.readyState >= 1 &&
      Math.abs((initEl.currentTime || 0) - initialStartSec) < 0.25
    );

    const ctxNow = ctx ? ctx.currentTime : 0;
    const willBlend = Boolean(transCfg.shouldBlend && prevOutForBlend && !prevOutForBlend.disposed);
    const effRateB = willBlend ? transCfg.rateB : 1.0;
    const voice = {
      gen,
      deckIdx: nextDeckIdx,
      trackId: tr.id,
      track: tr,
      grid: gridB,
      cands: activeCands,
      candIdx: candIdxInit,
      url: firstCand.url,
      isFullTrack: firstCand.isFullTrack,
      audioMode: initAudioMode,
      htmlAudio: initEl,
      barOriginCtxTime: ctxNow,
      slotStartCtxTime: ctxNow,
      startWallMs: now,
      beatDurSec: gridB.beatSec / effRateB,
      barDurSec: gridB.barSec / effRateB,
      playbackRate: effRateB,
      bassDb: willBlend ? transCfg.initialBassDbB : 0,
      fadeFactor: willBlend ? transCfg.initialGainB : 1.0,
      stopIdx: opts.stopIdx ?? -1,
      eraId: opts.eraId ?? tr.era,
      seekPending: (!alreadySought && initialStartSec > 0.02) ? initialStartSec : null,
      lastManualSeekSec: null,
      loopWindowActive: initialStartSec <= initBounds.previewEnd + 0.05,
      autoTransitionFired: false,
      autoPlan: null,
      mushFadeActive: false,
      mushFadeStartMs: 0,
      mushFadeFactor: 1.0,
      mushCustomTriggerSec:
        opts.isManual &&
        typeof opts.startSec === "number" &&
        tr.has_mush === true &&
        Number.isFinite(Number(tr.mush_onset_sec)) &&
        Number(tr.mush_onset_sec) > 0 &&
        initialStartSec >= Number(tr.mush_onset_sec)
          ? initialStartSec + MUSH_TASTE_SEC
          : null,
      disposed: false,
      cleanup: null,
    };

    active = voice;

    if (transCfg.shouldBlend && prevOutForBlend && !prevOutForBlend.disposed) {
      const gridA = prevOutForBlend.grid || getTrackGrid(prevOutForBlend.track);
      const startMediaA = getVoiceCurrentTime(prevOutForBlend);
      activeBlend = {
        outgoing: prevOutForBlend,
        incoming: voice,
        blendType: transCfg.blendType,
        startMediaSecA: startMediaA,
        startWallMs: now,
        barSecA: gridA.barSec,
        totalBars: transCfg.totalBars,
        durMs: transCfg.durMs,
        elapsedBars: 0,
        outStartGain: Number.isFinite(prevOutForBlend.fadeFactor) ? prevOutForBlend.fadeFactor : 1.0,
        outStartBassDb: Number.isFinite(prevOutForBlend.bassDb) ? prevOutForBlend.bassDb : 0.0,
        glideBars: transCfg.glideBars,
      };
      transitionHistory.push({
        atMs: now,
        fromId: prevOutForBlend.trackId,
        toId: tr.id,
        blendType: transCfg.blendType,
        isManual: !opts.fromAutoPlay,
        rateB: Number(transCfg.rateB.toFixed(4)),
        preservesPitch: true,
        startMediaSecA: Number(startMediaA.toFixed(3)),
        cueInSecB: Number(initialStartSec.toFixed(3)),
        totalBars: Number(transCfg.totalBars.toFixed(2)),
      });
      if (transitionHistory.length > 40) transitionHistory.shift();
    }

    const bindVoiceToCandidate = (cIdx, reuseExistingSrc) => {
      if (voice.disposed || cIdx >= voice.cands.length) return;
      if (voice.cleanup) {
        try { voice.cleanup(); } catch (_) {}
        voice.cleanup = null;
      }

      const cand = voice.cands[cIdx];
      voice.candIdx = cIdx;
      voice.url = cand.url;
      voice.isFullTrack = cand.isFullTrack;
      voice.audioMode = cand.mode === "webaudio" && ctx && deck.bassFilter ? "webaudio" : "direct";

      const el = voice.audioMode === "webaudio" ? deck.webEl : deck.directEl;
      const unusedEl = voice.audioMode === "webaudio" ? deck.directEl : deck.webEl;
      if (voice.htmlAudio !== el) {
        stopElementCleanly(unusedEl);
      }
      voice.htmlAudio = el;
      applyPreservesPitch(el);

      let playbackInitiated = false;

      const applyPendingSeek = () => {
        if (voice.disposed || voice.seekPending === null || el.readyState < 1) return;
        const b = getVoiceBounds(voice);
        const maxSeek = b.duration > 0.4 ? Math.max(0, b.duration - 0.2) : voice.seekPending;
        const dest = clamp(voice.seekPending, 0, maxSeek);
        try {
          el.currentTime = dest;
          voice.seekPending = null;
          voice.loopWindowActive = dest <= b.previewEnd + 0.05;
          // Re-anchor outgoing blend start when incoming seek completes so bars count from audible entry!
          if (activeBlend && activeBlend.incoming === voice && activeBlend.outgoing && !activeBlend.outgoing.disposed) {
            activeBlend.startMediaSecA = getVoiceCurrentTime(activeBlend.outgoing);
            activeBlend.startWallMs = nowMs();
          }
          syncVoiceGainAndVolume(voice);
        } catch (_) {}
      };

      const onLoadedMeta = () => {
        if (voice.disposed) return;
        applyPreservesPitch(el);
        setVoicePlaybackRate(voice, voice.playbackRate);
        applyPendingSeek();
        notifyStateChange();
      };

      const onCanPlay = () => {
        if (voice.disposed) return;
        applyPreservesPitch(el);
        applyPendingSeek();
      };

      const onTimeUpdate = () => {
        if (voice.disposed || active !== voice) return;
        tickPlayback();
      };

      const onEnded = () => {
        if (voice.disposed || active !== voice) return;
        if (voice.stopIdx >= 0) return;
        if (!autoPlay) {
          const b = getVoiceBounds(voice);
          voice.loopWindowActive = true;
          try {
            el.currentTime = b.previewStart;
            el.play().catch(() => {});
          } catch (_) {}
          return;
        }
        if (!voice.autoTransitionFired) {
          voice.autoTransitionFired = true;
          const nextId = advanceToNextAuto({});
          if (!nextId) {
            lastPaused = {
              trackId: voice.trackId,
              track: voice.track,
              currentTime: 0,
              duration: getVoiceDuration(voice),
              isFullTrack: voice.isFullTrack,
            };
            stopVoice(voice);
            active = null;
            stopTickLoop();
            notifyStateChange();
          }
        }
      };

      const handlePlayRejection = (err, attemptIdx) => {
        if (generation !== gen || active !== voice || voice.disposed) return;
        if (attemptIdx !== voice.candIdx) return;
        const errName = (err && err.name) || "";
        if (errName === "AbortError") return;
        if (errName !== "NotAllowedError" && voice.candIdx + 1 < voice.cands.length) return;
        cancelActiveBlendAndFinishOutgoing();
        const b = getVoiceBounds(voice);
        lastPaused = {
          trackId: tr.id,
          currentTime: getVoiceCurrentTime(voice),
          duration: b.duration,
          previewStart: b.previewStart,
          previewEnd: b.previewEnd,
          isFullTrack: voice.isFullTrack,
        };
        stopVoice(voice);
        active = null;
        notifyStateChange();
      };

      const onError = () => {
        if (voice.disposed) return;
        if (cand.viaProxy) {
          corsProxyCooldownUntilMs = nowMs() + CORS_RETRY_COOLDOWN_MS;
        }
        if (voice.candIdx + 1 < voice.cands.length) {
          voice.seekPending = initialStartSec > 0.02 ? initialStartSec : null;
          bindVoiceToCandidate(voice.candIdx + 1, false);
          return;
        }
        if (active === voice) {
          cancelActiveBlendAndFinishOutgoing();
          stopVoice(voice);
          active = null;
          notifyStateChange();
        }
      };

      const onNativePlay = () => {
        if (voice.disposed || active !== voice) return;
        lastPaused = null;
        applyPreservesPitch(el);
        setVoicePlaybackRate(voice, voice.playbackRate);
        syncVoiceGainAndVolume(voice);
        startTickLoop();
        ensureAnimRaf();
        notifyStateChange();
      };

      const onNativePause = () => {
        if (!playbackInitiated || voice.disposed || active !== voice) return;
        if (el.ended) return;
        cancelActiveBlendAndFinishOutgoing();
        cancelTempoGlide(true);
        cancelMushFade(voice);
        const b = getVoiceBounds(voice);
        lastPaused = {
          trackId: voice.trackId,
          currentTime: getVoiceCurrentTime(voice),
          duration: b.duration,
          previewStart: b.previewStart,
          previewEnd: b.previewEnd,
          isFullTrack: voice.isFullTrack,
        };
        stopTickLoop();
        notifyStateChange();
      };

      el.addEventListener("loadedmetadata", onLoadedMeta);
      el.addEventListener("canplay", onCanPlay);
      el.addEventListener("timeupdate", onTimeUpdate);
      el.addEventListener("ended", onEnded);
      el.addEventListener("error", onError);
      el.addEventListener("play", onNativePlay);
      el.addEventListener("pause", onNativePause);

      voice.cleanup = () => {
        el.removeEventListener("loadedmetadata", onLoadedMeta);
        el.removeEventListener("canplay", onCanPlay);
        el.removeEventListener("timeupdate", onTimeUpdate);
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("error", onError);
        el.removeEventListener("play", onNativePlay);
        el.removeEventListener("pause", onNativePause);
      };

      try {
        el.loop = !autoPlay && !voice.isFullTrack && voice.stopIdx < 0;
        if (!reuseExistingSrc || el.getAttribute("src") !== cand.url) {
          el.src = cand.url;
        } else if (voice.seekPending !== null && el.readyState >= 1) {
          applyPendingSeek();
        }
        setVoiceBassDb(voice, voice.bassDb);
        setVoicePlaybackRate(voice, voice.playbackRate);
        syncVoiceGainAndVolume(voice);
        startTickLoop();
        if (activeBlend) ensureAnimRaf();
        playbackInitiated = true;
        const attemptIdx = voice.candIdx;
        el.play().catch((err) => handlePlayRejection(err, attemptIdx));
      } catch (err) {
        handlePlayRejection(err, voice.candIdx);
      }
    };

    bindVoiceToCandidate(candIdxInit, reusePrewarm);
    notifyStateChange({ skipAppCallback: Boolean(opts.fromAutoPlay) });
    return true;
  }

  // ---- Transport Controls ----
  function pauseActive() {
    if (!active || active.disposed) return false;
    cancelActiveBlendAndFinishOutgoing();
    cancelTempoGlide(true);
    cancelMushFade(active);
    const el = active.htmlAudio;
    const b = getVoiceBounds(active);
    lastPaused = {
      trackId: active.trackId,
      currentTime: getVoiceCurrentTime(active),
      duration: b.duration,
      previewStart: b.previewStart,
      previewEnd: b.previewEnd,
      isFullTrack: active.isFullTrack,
    };
    if (el) {
      try { el.pause(); } catch (_) {}
    }
    stopTickLoop();
    notifyStateChange();
    return true;
  }

  function resumeActive() {
    ensureCtx();
    if (active && !active.disposed && active.htmlAudio) {
      const el = active.htmlAudio;
      lastPaused = null;
      active.fadeFactor = 1.0;
      setVoiceBassDb(active, 0);
      syncVoiceGainAndVolume(active);
      startTickLoop();
      el.play().catch(() => {
        if (active && !active.disposed) {
          try { el.pause(); } catch (_) {}
          stopTickLoop();
          notifyStateChange();
        }
      });
      notifyStateChange();
      return true;
    }
    if (lastPaused && byId.has(lastPaused.trackId)) {
      return playTrack(lastPaused.trackId, { startSec: lastPaused.currentTime, isManual: true });
    }
    return false;
  }

  function seek(sec) {
    const dest = Math.max(0, Number(sec) || 0);
    if (active && !active.disposed && active.htmlAudio) {
      cancelActiveBlendAndFinishOutgoing();
      cancelTempoGlide(true);
      const el = active.htmlAudio;
      const b = getVoiceBounds(active);
      const clamped = b.duration > 0 ? clamp(dest, 0, Math.max(0, b.duration - 0.08)) : dest;
      active.loopWindowActive = false;
      active.autoTransitionFired = false;
      active.lastManualSeekSec = clamped;
      cancelMushFade(active);
      const rawMush = getRawMushTriggerSec(active.track, b.duration);
      const mushOnset = active.track && active.track.has_mush === true ? Number(active.track.mush_onset_sec) : NaN;
      if (rawMush !== null || (Number.isFinite(mushOnset) && mushOnset > 0)) {
        const onsetThr = Number.isFinite(mushOnset) && mushOnset > 0 ? mushOnset : rawMush;
        active.mushCustomTriggerSec = clamped >= onsetThr ? clamped + MUSH_TASTE_SEC : null;
      }
      if (el.readyState >= 1) {
        try { el.currentTime = clamped; active.seekPending = null; } catch (_) { active.seekPending = clamped; }
      } else {
        active.seekPending = clamped;
      }
      syncVoiceGainAndVolume(active);
      notifyStateChange();
      return clamped;
    }
    if (lastPaused) {
      lastPaused.currentTime = lastPaused.duration > 0
        ? clamp(dest, 0, Math.max(0, lastPaused.duration - 0.08))
        : dest;
      notifyStateChange();
      return lastPaused.currentTime;
    }
    return 0;
  }

  function restart() {
    if (active && !active.disposed && active.htmlAudio) {
      cancelActiveBlendAndFinishOutgoing();
      cancelTempoGlide(true);
      active.loopWindowActive = false;
      active.autoTransitionFired = false;
      active.lastManualSeekSec = 0;
      active.mushCustomTriggerSec = null;
      cancelMushFade(active);
      try { active.htmlAudio.currentTime = 0; active.seekPending = null; } catch (_) { active.seekPending = 0; }
      if (active.htmlAudio.paused) {
        active.htmlAudio.play().catch(() => {});
      }
      syncVoiceGainAndVolume(active);
      startTickLoop();
      notifyStateChange();
      return true;
    }
    if (lastPaused && byId.has(lastPaused.trackId)) {
      return playTrack(lastPaused.trackId, { startSec: 0, fromStart: true, isManual: true });
    }
    return false;
  }

  function toggleTrack(trackId, opts = {}) {
    if (active && !active.disposed && active.trackId === trackId) {
      if (isVoiceActivelyPlaying(active)) {
        pauseActive();
        return false;
      }
      if (typeof opts.startSec === "number" && Number.isFinite(opts.startSec)) {
        seek(opts.startSec);
      } else if (opts.fromStart) {
        seek(0);
      }
      return resumeActive();
    }
    if (lastPaused && lastPaused.trackId === trackId && opts.startSec === undefined && !opts.fromStart) {
      return playTrack(trackId, { ...opts, startSec: lastPaused.currentTime, isManual: true });
    }
    const ma = typeof window !== "undefined" && window.ME_AUDIO ? window.ME_AUDIO : null;
    const playFn = ma && typeof ma.playTrack === "function" ? ma.playTrack : playTrack;
    return playFn.call(ma, trackId, { ...opts, isManual: true });
  }

  function stop() {
    generation++;
    lastPaused = null;
    activeBlend = null;
    activeGlide = null;
    stopVoice(active);
    stopVoice(outgoing);
    active = null;
    outgoing = null;
    pending = null;
    clearPrewarm(false);
    stopTickLoop();
    notifyStateChange();
  }

  function setAutoPlay(val) {
    const next = Boolean(val);
    if (autoPlay === next) return autoPlay;
    autoPlay = next;
    if (typeof baseAudio.setAutoPlay === "function") {
      try { baseAudio.setAutoPlay(next); } catch (_) {}
    }
    if (active && !active.disposed && active.htmlAudio) {
      if (!autoPlay) {
        cancelMushFade(active);
        clearPrewarm(false);
      }
      const b = getVoiceBounds(active);
      const cur = getVoiceCurrentTime(active);
      active.loopWindowActive = cur <= b.previewEnd + 0.05;
      active.htmlAudio.loop = !autoPlay && !active.isFullTrack && active.stopIdx < 0;
    }
    notifyStateChange();
    return autoPlay;
  }

  function applyManualSkipToTrack(targetTrack, opts = {}) {
    if (!targetTrack || !targetTrack.id) return null;
    if (typeof window !== "undefined") {
      if (window.ME_EVENTS && typeof window.ME_EVENTS.markPlayIntent === "function") {
        try { window.ME_EVENTS.markPlayIntent("manual"); } catch (_) {}
      }
      if (window.BTMM_EVENTS && typeof window.BTMM_EVENTS.notifyTrackIntent === "function") {
        try { window.BTMM_EVENTS.notifyTrackIntent(targetTrack.id, { source: "manual" }); } catch (_) {}
      }
      if (window.ME_NODEMAP && typeof window.ME_NODEMAP.setSelectedSilent === "function") {
        window.ME_NODEMAP.setSelectedSilent(targetTrack.id);
      }
      if (window.BTMM_PLAYER && typeof window.BTMM_PLAYER.select === "function") {
        window.BTMM_PLAYER.select(targetTrack.id, { silent: true, fromHistoryNav: true });
      }
    }
    const ma = typeof window !== "undefined" && window.ME_AUDIO ? window.ME_AUDIO : null;
    const playFn = ma && typeof ma.playTrack === "function" ? ma.playTrack : playTrack;
    playFn.call(ma, targetTrack, {
      ...opts,
      isManual: true,
      fromHistoryNav: true,
    });
    return targetTrack.id;
  }

  function nextSimilarTrack(opts = {}) {
    const dec = resolveNextDecision({ consume: true, allowSpoken: true });
    if (!dec || !dec.track) return null;
    return applyManualSkipToTrack(dec.track, opts);
  }

  function prevSimilarTrack(opts = {}) {
    if (!tracksList.length) return null;
    const curId = resolveHistoryAnchorId();
    if (curId && (historyCursor < 0 || playHistory[historyCursor] !== curId)) {
      recordHistoryVisit(curId);
    }
    while (historyCursor > 0) {
      historyCursor -= 1;
      const prevId = playHistory[historyCursor];
      if (prevId && byId.has(prevId) && prevId !== curId) {
        return applyManualSkipToTrack(byId.get(prevId), opts);
      }
    }
    const prevNeighbor = baseAudio.pickPrevSimilarTrack(curId, { allowSpoken: true });
    if (!prevNeighbor) return null;
    if (playHistory[0] !== prevNeighbor.id) playHistory.unshift(prevNeighbor.id);
    if (playHistory.length > 500) playHistory.pop();
    historyCursor = 0;
    visitedIds.add(prevNeighbor.id);
    return applyManualSkipToTrack(prevNeighbor, opts);
  }

  function getNextBarBoundary(ctxNow) {
    if (!active) return (ctxNow || 0) + 0.02;
    const barDur = Math.max(0.25, active.barDurSec || 2.0);
    const elapsedBars = Math.floor(Math.max(0, (ctxNow || 0) - active.barOriginCtxTime) / barDur);
    let nextBar = active.barOriginCtxTime + (elapsedBars + 1) * barDur;
    if (nextBar - (ctxNow || 0) < 0.035) nextBar += barDur;
    return nextBar;
  }

  function onStateChange(fn) {
    if (typeof fn !== "function") return () => {};
    stateListeners.add(fn);
    return () => stateListeners.delete(fn);
  }

  function serializeVoiceDiag(voice) {
    if (!voice || voice.disposed) return null;
    const deck = decks[voice.deckIdx];
    const grid = voice.grid || getTrackGrid(voice.track);
    return {
      deckIdx: voice.deckIdx,
      trackId: voice.trackId,
      groove: grid.groove,
      bpm: grid.bpm,
      playbackRate: voice.htmlAudio ? voice.htmlAudio.playbackRate : voice.playbackRate,
      preservesPitch: readPreservesPitch(voice.htmlAudio),
      gain: Number((voice.fadeFactor ?? 1.0).toFixed(4)),
      deckGainNodeValue: deck && deck.deckGain ? Number(deck.deckGain.gain.value.toFixed(4)) : null,
      bassGainDb: Number((voice.bassDb ?? 0.0).toFixed(2)),
      biquadGainDb: deck && deck.bassFilter ? Number(deck.bassFilter.gain.value.toFixed(2)) : null,
      currentTime: Number(getVoiceCurrentTime(voice).toFixed(3)),
      duration: Number(getVoiceDuration(voice).toFixed(3)),
      audioMode: voice.audioMode,
      rms: deck ? Number(readAnalyserRms(deck.deckAnalyser, deck.deckAnalyserBuf).toFixed(5)) : 0,
    };
  }

  const djMixerApi = {
    getBeatGrid: getTrackGrid,
    computeTempoMatch,
    getOutputRms,
    getDecks: () => { ensureDecks(); return decks.slice(); },
    getTransitionHistory: () => transitionHistory.slice(),
    clearTransitionHistory: () => { transitionHistory.length = 0; },
    resetCorsCooldown: () => { corsProxyCooldownUntilMs = 0; },
    getState() {
      const nextCand = active && !active.disposed ? peekNextTrack(active.trackId) : null;
      return {
        mode: activeBlend
          ? "blending"
          : (prewarm && !prewarm.disposed ? "prewarmed" : (isVoiceActivelyPlaying(active) ? "playing" : "idle")),
        blendType: activeBlend ? activeBlend.blendType : null,
        elapsedBars: activeBlend ? Number(activeBlend.elapsedBars.toFixed(3)) : 0,
        totalBars: activeBlend ? Number(activeBlend.totalBars.toFixed(3)) : 0,
        tempoGlideActive: Boolean(activeGlide),
        queuedNextTrackId: nextCand ? nextCand.id : null,
        queuedTriggerSec: active && active.autoPlan ? Number(active.autoPlan.triggerSec.toFixed(3)) : null,
        activeDeck: serializeVoiceDiag(active),
        outgoingDeck: serializeVoiceDiag(outgoing),
        outputRms: Number(getOutputRms().toFixed(5)),
      };
    },
  };

  if (typeof window !== "undefined") {
    window.DJ_MIXER = djMixerApi;
    window.ME_AUDIO = Object.assign({}, baseAudio, {
      setTrackIndex,
      playTrack,
      toggleTrack,
      pause: pauseActive,
      resume: resumeActive,
      stop,
      seek,
      restart,
      getPlaybackState: buildPlaybackState,
      getProgress: buildPlaybackState,
      getAutoPlay: () => autoPlay,
      setAutoPlay,
      onStateChange,
      nextSimilarTrack: (opts) => nextSimilarTrack(opts),
      prevSimilarTrack: (opts) => prevSimilarTrack(opts),
      skipNextSimilar: (opts) => nextSimilarTrack(opts),
      skipPrevSimilar: (opts) => prevSimilarTrack(opts),
      peekNextTrack: (id) => peekNextTrack(id),
      getPlayHistory: () => ({ ids: playHistory.slice(), cursor: historyCursor }),
      syncHistorySelection: (id) => recordHistoryVisit(id),
      resetPlayHistory: () => {
        playHistory.length = 0;
        historyCursor = -1;
        if (typeof baseAudio.resetPlayHistory === "function") baseAudio.resetPlayHistory();
      },
      isPlaying: (id) => Boolean(isVoiceActivelyPlaying(active) && (id ? active.trackId === id : true)),
      visitedCount: () => visitedIds.size,
      getVisitedIds: () => Array.from(visitedIds),
      resetVisited: () => {
        visitedIds.clear();
        if (typeof baseAudio.resetVisited === "function") baseAudio.resetVisited();
      },
      getDecks: () => {
        ensureDecks();
        return decks.map((d) => d.webEl);
      },
      getNextBarBoundary,
      ensureCtx,
      playing: () => (isVoiceActivelyPlaying(active) ? active.trackId : null),
      pending: () => (pending ? pending.trackId : null),
      activeVoice: () => active,
      fadingVoice: () => outgoing,
      pendingVoice: () => pending,
      ctxTime: () => (ctx ? ctx.currentTime : 0),
      isEnabled: () => enabled,
      setEnabled(val) {
        enabled = Boolean(val);
        if (typeof baseAudio.setEnabled === "function") baseAudio.setEnabled(enabled);
        syncMasterGain();
        notifyStateChange();
      },
      setVolume(val) {
        volume = clamp(Number(val) || 0, 0, 1);
        if (typeof baseAudio.setVolume === "function") baseAudio.setVolume(volume);
        syncMasterGain();
      },
      getVolume: () => volume,
      setOnStateChange(fn) { onStateChangeCb = typeof fn === "function" ? fn : () => {}; },
      setOnAutoAdvance(fn) { onAutoAdvanceCb = typeof fn === "function" ? fn : null; },
      setOnBeat(fn) { onBeatCb = typeof fn === "function" ? fn : () => {}; },
      djMixer: djMixerApi,
    });
  }
})();
