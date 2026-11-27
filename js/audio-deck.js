// Full-Track Dual-HTMLAudioElement Deck, Snippet-Cue Dive-In, 1s CORS-Safe Crossfader,
// ~550-Track No-Repeat Sonic Similarity Walk & WebAudio JI/Gamelan Bell Synth
(function () {
  "use strict";

  const CROSSFADE_SEC = 1.0;
  const CROSSFADE_MS = 1000;
  const PREWARM_LEAD_SEC = 5.5;
  const MUSH_TASTE_SEC = 3.0;
  const MUSH_FADE_SEC = 2.5;
  const MUSH_FADE_MS = 2500;
  const MUSH_MIN_FACTOR = 0.02;
  const TICK_MS = 40;

  let ctx = null;
  let masterGain = null;
  let enabled = true;
  let volume = 0.85;
  let autoPlay = true;

  let tracksList = [];
  let byId = new Map();
  let explicitTrackNear = null;
  let explicitTrackMap = null;
  const fallbackVecCache = new Map();
  const visitedIds = new Set();
  const playHistory = [];
  let historyCursor = -1;

  // Retained for legacy API compatibility on same-origin decoded buffers
  const bufferCache = new Map();
  const decodedCache = new Map();
  const corsBlockedUrls = new Set();

  // Dual pooled HTMLAudioElement decks (NO crossOrigin, NO MediaElementAudioSourceNode
  // so GitHub Release HTTP 206 byte-range streams play & crossfade with zero CORS tainting)
  let decks = [null, null];
  let active = null;
  let fadingOut = null;
  let prewarm = null;
  let pending = null;
  let lastPaused = null;

  let generation = 0;
  let tickTimer = null;
  let fadeRafId = 0;

  let onStateChangeCb = () => {};
  const stateListeners = new Set();
  let onBeatCb = () => {};
  let onAutoAdvanceCb = null;

  function nowMs() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function resolveTrackUrls(t) {
    if (!t) return [];
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

  function isUrlFullTrack(t, url) {
    if (!t || !url) return false;
    return Boolean(
      (t.stream_url && url === t.stream_url) ||
      (t.mp3_320_url && url === t.mp3_320_url) ||
      (t.mp3_url && url === t.mp3_url)
    );
  }

  function trackAudioUrl(t) {
    const urls = resolveTrackUrls(t);
    return urls.length ? urls[0] : "";
  }

  function getCorpusMetaObj() {
    if (typeof window === "undefined" || !window.CORPUS_DATA) return null;
    return window.CORPUS_DATA;
  }

  function getTrackNearLookup() {
    if (explicitTrackNear) return explicitTrackNear;
    const cd = getCorpusMetaObj();
    if (!cd) return {};
    return (cd.meta && cd.meta.track_near) || cd.track_near || (cd.map && cd.map.track_near) || {};
  }

  function getTrackMapLookup() {
    if (explicitTrackMap) return explicitTrackMap;
    const cd = getCorpusMetaObj();
    if (!cd) return {};
    return (cd.meta && cd.meta.track_map) || cd.track_map || (cd.map && cd.map.track_map) || {};
  }

  function buildFallbackVec(t, coordsLookup) {
    const coordsEntry = coordsLookup && coordsLookup[t.id];
    const vibe = (coordsEntry && (coordsEntry.vibe || coordsEntry.similarity)) || [0.5, 0.5];
    const vx = Number.isFinite(Number(vibe[0])) ? Number(vibe[0]) : 0.5;
    const vy = Number.isFinite(Number(vibe[1])) ? Number(vibe[1]) : 0.5;
    return [
      (Number(t.energy) || 5) / 10,
      (Number(t.effective_bpm || t.bpm) || 120) / 180,
      (Number(t.harmonic_complexity) || 0) / 100,
      (Number(t.chord_richness) || 0) / 100,
      (Number(t.harmonic_motion) || 0) / 100,
      (Number(t.drum_complexity) || 0) / 100,
      vx,
      vy,
    ];
  }

  function setTrackIndex(tracks, graphMeta) {
    tracksList = Array.isArray(tracks) ? tracks.slice() : [];
    byId = new Map(tracksList.map((t) => [t.id, t]));
    if (graphMeta && typeof graphMeta === "object") {
      if (graphMeta.trackNear) explicitTrackNear = graphMeta.trackNear;
      if (graphMeta.trackMap) explicitTrackMap = graphMeta.trackMap;
    }
    fallbackVecCache.clear();
    const coordsLookup = getTrackMapLookup();
    for (let i = 0; i < tracksList.length; i++) {
      const tr = tracksList[i];
      if (tr && tr.id) {
        fallbackVecCache.set(tr.id, buildFallbackVec(tr, coordsLookup));
      }
    }
    // Prune any visited IDs or playHistory entries no longer in the catalog
    if (visitedIds.size > 0) {
      Array.from(visitedIds).forEach((id) => {
        if (!byId.has(id)) visitedIds.delete(id);
      });
    }
    if (playHistory.length > 0) {
      let nextCursorId = historyCursor >= 0 && historyCursor < playHistory.length
        ? playHistory[historyCursor]
        : null;
      for (let i = playHistory.length - 1; i >= 0; i--) {
        if (!byId.has(playHistory[i])) playHistory.splice(i, 1);
      }
      historyCursor = nextCursorId ? playHistory.lastIndexOf(nextCursorId) : (playHistory.length - 1);
    }
  }

  function getFallbackVec(t) {
    if (!t || !t.id) return [0.5, 0.67, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    let v = fallbackVecCache.get(t.id);
    if (!v) {
      v = buildFallbackVec(t, getTrackMapLookup());
      fallbackVecCache.set(t.id, v);
    }
    return v;
  }

  function sonicDistance(a, b) {
    if (!a || !b) return Infinity;
    const fa = a.feat_vec;
    const fb = b.feat_vec;
    const va = getFallbackVec(a);
    const vb = getFallbackVec(b);
    if (Array.isArray(fa) && fa.length > 0 && Array.isArray(fb) && fb.length === fa.length) {
      let sumSq = 0;
      for (let i = 0; i < fa.length; i++) {
        const d = (Number(fa[i]) || 0) - (Number(fb[i]) || 0);
        sumSq += d * d;
      }
      const dx = va[6] - vb[6];
      const dy = va[7] - vb[7];
      return Math.sqrt(sumSq) + Math.sqrt(dx * dx + dy * dy) * 0.05;
    }
    let sumSq = 0;
    for (let i = 0; i < va.length; i++) {
      const d = va[i] - vb[i];
      sumSq += d * d;
    }
    return Math.sqrt(sumSq);
  }

  function extractNeighborId(entry) {
    if (!entry) return null;
    if (typeof entry === "string") return entry;
    if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
    if (typeof entry === "object" && typeof entry.id === "string") return entry.id;
    return null;
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
      const searchEl = document.getElementById("search-input");
      const ql = searchEl && typeof searchEl.value === "string" ? searchEl.value.trim().toLowerCase() : "";
      if (ql) {
        if (ql === "has:mush" || ql === "is:mush" || ql === "tag:mush") {
          return Boolean(cand.has_mush === true && Number.isFinite(Number(cand.mush_onset_sec)));
        }
        const cd = getCorpusMetaObj();
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

  function isWalkEligible(cand, curIsAi, opts = {}) {
    if (!cand) return false;
    if (cand.is_spoken_word && !opts.allowSpoken) return false;
    if (!opts.anyTerritory && Boolean(cand.is_ai) !== curIsAi) return false;
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
    if (!opts.ignoreViewFilter && !isActiveViewFilterMatch(cand)) return false;
    return true;
  }

  function collectSimilarCandidatePool(currentId, curTrack, effectiveVisited, extraExclude, allowIgnoreFilter = true) {
    const curIsAi = Boolean(curTrack && curTrack.is_ai);
    const curSpoken = Boolean(curTrack && curTrack.is_spoken_word);
    const passes = [
      { allowSpoken: curSpoken, anyTerritory: false, ignoreViewFilter: false },
      { allowSpoken: curSpoken, anyTerritory: true, ignoreViewFilter: false },
    ];
    if (allowIgnoreFilter) {
      passes.push(
        { allowSpoken: curSpoken, anyTerritory: false, ignoreViewFilter: true },
        { allowSpoken: true, anyTerritory: true, ignoreViewFilter: true }
      );
    }
    for (let p = 0; p < passes.length; p++) {
      const pOpts = passes[p];
      const out = [];
      for (let i = 0; i < tracksList.length; i++) {
        const tr = tracksList[i];
        if (!tr || tr.id === currentId) continue;
        if (effectiveVisited && effectiveVisited.has(tr.id)) continue;
        if (extraExclude && extraExclude.has(tr.id)) continue;
        if (isWalkEligible(tr, curIsAi, pOpts)) out.push(tr);
      }
      if (out.length > 0) return { pool: out, eligOpts: pOpts };
    }
    return { pool: [], eligOpts: passes[0] };
  }

  function pickNextSimilarTrack(currentId, opts = {}) {
    if (!tracksList.length) return null;
    if (tracksList.length === 1) return tracksList[0];

    const curTrack = currentId ? byId.get(currentId) : null;
    if (curTrack && curTrack.is_spoken_word && !opts.allowSpoken) return null;
    const curIsAi = Boolean(curTrack && curTrack.is_ai);

    const peekOnly = Boolean(opts.peekOnly);
    const extraExclude = opts.excludeIds instanceof Set ? opts.excludeIds : null;
    let effectiveVisited = visitedIds;

    // 1. Prefer unvisited candidates matching the active view/map filters first
    let { pool: unvisited, eligOpts } = collectSimilarCandidatePool(
      currentId,
      curTrack,
      effectiveVisited,
      extraExclude,
      false
    );
    if (unvisited.length === 0 && extraExclude && extraExclude.size > 0) {
      const noHistTry = collectSimilarCandidatePool(currentId, curTrack, effectiveVisited, null, false);
      unvisited = noHistTry.pool;
      eligOpts = noHistTry.eligOpts;
    }

    // 2. If all view-filtered tracks were visited, loop cleanly inside the active filter/territory before widening
    if (unvisited.length === 0) {
      if (peekOnly) {
        const nextVisited = new Set();
        visitedIds.forEach((vid) => {
          const vt = byId.get(vid);
          if (!(vt && Boolean(vt.is_ai) === curIsAi && vid !== currentId)) {
            nextVisited.add(vid);
          }
        });
        if (currentId && byId.has(currentId)) nextVisited.add(currentId);
        effectiveVisited = nextVisited;
      } else {
        // Clear visited history within this territory so the walk loops cleanly inside its territory
        Array.from(visitedIds).forEach((vid) => {
          const vt = byId.get(vid);
          if (vt && Boolean(vt.is_ai) === curIsAi && vid !== currentId) {
            visitedIds.delete(vid);
          }
        });
        if (currentId && byId.has(currentId)) visitedIds.add(currentId);
        effectiveVisited = visitedIds;
      }
      const retryFiltered = collectSimilarCandidatePool(currentId, curTrack, effectiveVisited, null, false);
      unvisited = retryFiltered.pool;
      eligOpts = retryFiltered.eligOpts;
      if (unvisited.length === 0) {
        const retryUnfiltered = collectSimilarCandidatePool(currentId, curTrack, effectiveVisited, null, true);
        unvisited = retryUnfiltered.pool;
        eligOpts = retryUnfiltered.eligOpts;
      }
      if (!unvisited.length) return curTrack || tracksList[0];
    }

    if (!curTrack) return unvisited[0];

    const poolSet = new Set(unvisited.map((t) => t.id));
    // 1. Check currentTrack.track_near (or CORPUS_DATA.meta.track_near[currentId]) first
    const nearLookup = getTrackNearLookup();
    const nearList = Array.isArray(curTrack.track_near)
      ? curTrack.track_near
      : (nearLookup[currentId] || []);

    for (let i = 0; i < nearList.length; i++) {
      const nid = extractNeighborId(nearList[i]);
      if (nid && nid !== currentId && poolSet.has(nid)) {
        const cand = byId.get(nid);
        if (cand && isWalkEligible(cand, curIsAi, eligOpts)) return cand;
      }
    }

    // 2. All direct track_near neighbors visited -> find closest unvisited track in candidate pool
    let bestTrack = unvisited[0];
    let bestDist = Infinity;
    for (let i = 0; i < unvisited.length; i++) {
      const cand = unvisited[i];
      const dist = sonicDistance(curTrack, cand);
      if (dist < bestDist) {
        bestDist = dist;
        bestTrack = cand;
      }
    }
    return bestTrack;
  }

  function pickPrevSimilarTrack(currentId, opts = {}) {
    if (!tracksList.length) return null;
    if (tracksList.length === 1) return tracksList[0];

    const curTrack = currentId ? byId.get(currentId) : null;
    if (!curTrack) return tracksList[0];

    // Reserve the primary forward neighbor when >= 2 candidates exist so Prev and Next step to distinct neighbors from index 0
    const forwardPrimary = pickNextSimilarTrack(currentId, { peekOnly: true, allowSpoken: true });
    const excludeSet = new Set(playHistory);
    if (forwardPrimary && forwardPrimary.id && forwardPrimary.id !== currentId) {
      excludeSet.add(forwardPrimary.id);
    }

    let { pool, eligOpts } = collectSimilarCandidatePool(currentId, curTrack, null, excludeSet);
    if (pool.length === 0) {
      const fallbackExclude = new Set(currentId ? [currentId] : []);
      if (forwardPrimary && forwardPrimary.id && tracksList.length > 2) {
        fallbackExclude.add(forwardPrimary.id);
      }
      const fb = collectSimilarCandidatePool(currentId, curTrack, null, fallbackExclude);
      pool = fb.pool;
      eligOpts = fb.eligOpts;
    }
    if (pool.length === 0) {
      return forwardPrimary || curTrack;
    }

    const curIsAi = Boolean(curTrack.is_ai);
    const poolSet = new Set(pool.map((t) => t.id));
    const nearLookup = getTrackNearLookup();
    const nearList = Array.isArray(curTrack.track_near)
      ? curTrack.track_near
      : (nearLookup[currentId] || []);

    for (let i = 0; i < nearList.length; i++) {
      const nid = extractNeighborId(nearList[i]);
      if (nid && nid !== currentId && poolSet.has(nid)) {
        const cand = byId.get(nid);
        if (cand && isWalkEligible(cand, curIsAi, eligOpts)) return cand;
      }
    }

    let bestTrack = pool[0];
    let bestDist = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      const dist = sonicDistance(curTrack, cand);
      if (dist < bestDist) {
        bestDist = dist;
        bestTrack = cand;
      }
    }
    return bestTrack;
  }

  function recordHistoryVisit(trackId) {
    if (!trackId || !byId.has(trackId)) return;
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
    if (playHistory.length > 500) {
      playHistory.shift();
    }
    historyCursor = playHistory.length - 1;
  }

  function ensureCtx() {
    if (!ctx && typeof window !== "undefined") {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        ctx = new AC();
        masterGain = ctx.createGain();
        masterGain.gain.value = enabled ? volume : 0;
        masterGain.connect(ctx.destination);
      }
    }
    if (ctx && ctx.state === "suspended" && typeof ctx.resume === "function") {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  function createDeckAudioEl() {
    if (typeof Audio === "undefined") return null;
    const el = new Audio();
    el.preload = "auto";
    el.loop = false;
    return el;
  }

  function ensureDecks() {
    if (!decks[0]) decks[0] = createDeckAudioEl();
    if (!decks[1]) decks[1] = createDeckAudioEl();
    return decks[0] && decks[1];
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

  function getVoiceDuration(voice) {
    if (!voice) return 0;
    const elDur = voice.htmlAudio && Number.isFinite(voice.htmlAudio.duration) && voice.htmlAudio.duration > 0
      ? voice.htmlAudio.duration
      : 0;
    return computeTrackBounds(voice.track, voice.isFullTrack, elDur).duration;
  }

  function getVoiceBounds(voice) {
    if (!voice) return { duration: 0, previewStart: 0, previewEnd: 0, previewDur: 20 };
    const elDur = voice.htmlAudio && Number.isFinite(voice.htmlAudio.duration) && voice.htmlAudio.duration > 0
      ? voice.htmlAudio.duration
      : 0;
    return computeTrackBounds(voice.track, voice.isFullTrack, elDur);
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

  function getVoiceBaseVolume(voice) {
    if (!voice || !enabled) return 0;
    const trim = voice.track && Number.isFinite(Number(voice.track.gain_trim))
      ? clamp(Number(voice.track.gain_trim), 0.25, 1.5)
      : 1.0;
    return clamp(volume * trim, 0, 1);
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
      syncVoiceVolume(voice);
    }
  }

  function syncVoiceVolume(voice) {
    if (!voice || voice.disposed || !voice.htmlAudio) return;
    const el = voice.htmlAudio;
    // Hold silent during the brief pre-metadata window if seeking into a snippet offset
    if (voice.seekPending !== null && voice.seekPending > 0.02) {
      el.volume = 0;
      el.muted = !enabled;
      return;
    }
    const baseVol = getVoiceBaseVolume(voice);
    const fade = Number.isFinite(voice.fadeFactor) ? clamp(voice.fadeFactor, 0, 1) : 1.0;
    const mushFade = Number.isFinite(voice.mushFadeFactor)
      ? clamp(voice.mushFadeFactor, MUSH_MIN_FACTOR, 1)
      : 1.0;
    const target = enabled ? clamp(baseVol * fade * mushFade, 0, 1) : 0;
    el.volume = target;
    el.muted = !enabled;
  }

  function syncMasterGain() {
    const v = enabled ? clamp(volume, 0, 1) : 0;
    if (masterGain && ctx) {
      if (typeof masterGain.gain.setTargetAtTime === "function") {
        masterGain.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
      } else {
        masterGain.gain.value = v;
      }
    }
    if (active) syncVoiceVolume(active);
    if (fadingOut) syncVoiceVolume(fadingOut);
  }

  function isVoiceActivelyPlaying(voice) {
    if (!voice || voice.disposed) return false;
    if (voice.htmlAudio) {
      return !voice.htmlAudio.paused && !voice.htmlAudio.ended;
    }
    return true;
  }

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

  function clearPrewarm(keepAudioSrc = false) {
    if (!prewarm) return;
    const pw = prewarm;
    prewarm = null;
    pw.disposed = true;
    if (pw.cleanup) pw.cleanup();
    if (!keepAudioSrc && pw.el) {
      try {
        pw.el.pause();
        pw.el.removeAttribute("src");
        pw.el.load();
      } catch (_) {}
    }
  }

  function stopVoice(voice) {
    if (!voice || voice.disposed) return;
    voice.disposed = true;
    if (voice.cleanup) {
      try { voice.cleanup(); } catch (_) {}
      voice.cleanup = null;
    }
    if (voice.src) {
      try { voice.src.stop(0); } catch (_) {}
    }
    if (voice.htmlAudio) {
      try {
        voice.htmlAudio.pause();
        voice.htmlAudio.loop = false;
        voice.htmlAudio.volume = 0;
        voice.htmlAudio.removeAttribute("src");
        voice.htmlAudio.load();
      } catch (_) {}
    }
  }

  function isNoCorsReleaseUrl(url) {
    return /^https?:\/\/(?:github\.com\/[^/]+\/[^/]+\/releases\/download\/|release-assets\.githubusercontent\.com\/)/i.test(url || "");
  }

  function loadBuffer(track) {
    const url = track && (track.preview_url || track.file || "");
    if (!url || isNoCorsReleaseUrl(url) || corsBlockedUrls.has(url)) return Promise.resolve(null);
    if (decodedCache.has(url)) return Promise.resolve(decodedCache.get(url));
    if (bufferCache.has(url)) return bufferCache.get(url);
    const ac = ensureCtx();
    if (!ac || typeof fetch !== "function") return Promise.resolve(null);
    const p = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.arrayBuffer();
      })
      .then((ab) => ac.decodeAudioData(ab))
      .then((buf) => {
        if (buf) decodedCache.set(url, buf);
        return buf || null;
      })
      .catch(() => {
        bufferCache.delete(url);
        if (/^https?:\/\//i.test(url)) corsBlockedUrls.add(url);
        return null;
      });
    bufferCache.set(url, p);
    return p;
  }

  function prefetchTracks() {
    // HTMLAudioElement HTTP 206 streaming handles full-track byte ranges on demand;
    // next-track standby prewarming runs automatically 5.5s before track end.
  }

  function getNextBarBoundary(ctxNow) {
    if (!active) return (ctxNow || 0) + 0.02;
    const barDur = Math.max(0.25, active.barDurSec || 2.0);
    const elapsedBars = Math.floor(Math.max(0, (ctxNow || 0) - active.barOriginCtxTime) / barDur);
    let nextBar = active.barOriginCtxTime + (elapsedBars + 1) * barDur;
    if (nextBar - (ctxNow || 0) < 0.035) nextBar += barDur;
    return nextBar;
  }

  function promotePending() {
    return false;
  }

  function maybePrewarmNext(currentTrackId) {
    if (!autoPlay || fadingOut || !ensureDecks()) return;
    const standbyIdx = active ? (1 - active.deckIdx) : 1;
    const nextTrack = peekNextTrack(currentTrackId);
    if (!nextTrack) return;
    if (prewarm && prewarm.trackId === nextTrack.id && prewarm.deckIdx === standbyIdx && !prewarm.disposed) {
      return;
    }
    clearPrewarm(false);

    const urls = resolveTrackUrls(nextTrack);
    if (!urls.length) return;
    const url = urls[0];
    const isFull = isUrlFullTrack(nextTrack, url);
    const prewarmBounds = computeTrackBounds(nextTrack, isFull, 0);
    const targetStart = Boolean(nextTrack.has_drop) && prewarmBounds.previewStart > 0.02
      ? prewarmBounds.previewStart
      : 0;
    const el = decks[standbyIdx];
    if (!el) return;

    const pw = {
      deckIdx: standbyIdx,
      el,
      trackId: nextTrack.id,
      track: nextTrack,
      url,
      urlIdx: 0,
      urls,
      isFullTrack: isFull,
      targetStart,
      sought: targetStart <= 0.02,
      disposed: false,
      cleanup: null,
    };

    const onMeta = () => {
      if (pw.disposed || pw.sought || el.readyState < 1) return;
      const realBounds = computeTrackBounds(nextTrack, pw.isFullTrack, el.duration);
      const dest = clamp(pw.targetStart, 0, Math.max(0, realBounds.duration - 0.25));
      try {
        el.currentTime = dest;
        pw.sought = true;
      } catch (_) {}
    };

    const onErr = () => {
      if (pw.disposed) return;
      if (pw.urlIdx + 1 < pw.urls.length) {
        pw.urlIdx++;
        pw.url = pw.urls[pw.urlIdx];
        pw.isFullTrack = isUrlFullTrack(nextTrack, pw.url);
        const fbBounds = computeTrackBounds(nextTrack, pw.isFullTrack, 0);
        pw.targetStart = Boolean(nextTrack.has_drop) && fbBounds.previewStart > 0.02
          ? fbBounds.previewStart
          : 0;
        pw.sought = pw.targetStart <= 0.02;
        try {
          el.src = pw.url;
          el.load();
        } catch (_) {}
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
      el.volume = 0;
      el.muted = true;
      el.src = url;
      el.load();
    } catch (_) {
      pw.cleanup();
      return;
    }
    prewarm = pw;
  }

  function stepFadeFrame() {
    fadeRafId = 0;
    const now = nowMs();
    let stillFading = false;

    if (fadingOut && !fadingOut.disposed) {
      const pOut = clamp((now - fadingOut.fadeStartMs) / Math.max(1, fadingOut.fadeDurMs), 0, 1);
      if (pOut >= 1) {
        stopVoice(fadingOut);
        fadingOut = null;
      } else {
        fadingOut.fadeFactor = fadingOut.fadeStartFactor * Math.cos(pOut * Math.PI * 0.5);
        syncVoiceVolume(fadingOut);
        stillFading = true;
      }
    }

    if (active && !active.disposed && active.fadeIn) {
      const pIn = clamp((now - active.fadeStartMs) / Math.max(1, active.fadeDurMs), 0, 1);
      if (pIn >= 1) {
        active.fadeIn = false;
        active.fadeFactor = 1.0;
        syncVoiceVolume(active);
      } else {
        active.fadeFactor = Math.sin(pIn * Math.PI * 0.5);
        syncVoiceVolume(active);
        stillFading = true;
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
          active.crossfadeTriggered = true;
          advanceToNextSimilar({ crossfadeMs: 0, fromMushFade: true });
          return;
        }
        active.mushFadeFactor =
          MUSH_MIN_FACTOR + (1.0 - MUSH_MIN_FACTOR) * Math.cos(pMush * Math.PI * 0.5);
        syncVoiceVolume(active);
        stillFading = true;
      }
    }

    if (stillFading && typeof requestAnimationFrame === "function" && typeof document !== "undefined" && !document.hidden) {
      fadeRafId = requestAnimationFrame(stepFadeFrame);
    }
    if (!active && !fadingOut) {
      stopTickLoop();
    }
  }

  function ensureFadeRaf() {
    if (!fadeRafId && typeof requestAnimationFrame === "function" && typeof document !== "undefined" && !document.hidden) {
      fadeRafId = requestAnimationFrame(stepFadeFrame);
    }
  }

  function resolveHistoryAnchorId() {
    if (active && !active.disposed && active.trackId && byId.has(active.trackId)) {
      return active.trackId;
    }
    const idleId = resolveIdleTargetTrackId();
    if (idleId && byId.has(idleId)) return idleId;
    if (historyCursor >= 0 && historyCursor < playHistory.length && byId.has(playHistory[historyCursor])) {
      return playHistory[historyCursor];
    }
    if (typeof window !== "undefined" && window.ME_NODEMAP && typeof window.ME_NODEMAP.firstVisibleTrackId === "function") {
      const visId = window.ME_NODEMAP.firstVisibleTrackId();
      if (visId && byId.has(visId)) return visId;
    }
    return tracksList[0] ? tracksList[0].id : null;
  }

  function markManualPlayIntent(targetId) {
    if (typeof window === "undefined") return;
    if (window.ME_EVENTS && typeof window.ME_EVENTS.markPlayIntent === "function") {
      try { window.ME_EVENTS.markPlayIntent("manual"); } catch (_) {}
    }
    if (targetId && window.BTMM_EVENTS && typeof window.BTMM_EVENTS.notifyTrackIntent === "function") {
      try { window.BTMM_EVENTS.notifyTrackIntent(targetId, { source: "manual" }); } catch (_) {}
    }
  }

  function applyManualHistorySkip(targetTrack, opts = {}) {
    if (!targetTrack || !targetTrack.id) return null;
    const wasMushFading = Boolean(active && !active.disposed && active.mushFadeActive);
    if (active && !active.disposed) {
      cancelMushFade(active);
    }
    markManualPlayIntent(targetTrack.id);

    const fadeMs = Number.isFinite(opts.crossfadeMs)
      ? Math.max(0, opts.crossfadeMs)
      : (active && !active.disposed && !wasMushFading ? 160 : 0);

    if (typeof window !== "undefined") {
      if (window.ME_NODEMAP && typeof window.ME_NODEMAP.setSelectedSilent === "function") {
        window.ME_NODEMAP.setSelectedSilent(targetTrack.id);
      }
      if (window.BTMM_PLAYER && typeof window.BTMM_PLAYER.select === "function") {
        window.BTMM_PLAYER.select(targetTrack.id, { silent: true, fromHistoryNav: true });
      }
    }

    playTrack(targetTrack, {
      isManual: true,
      fromHistoryNav: true,
      crossfadeMs: fadeMs,
    });
    return targetTrack.id;
  }

  function resolveNextSimilarDecision(opts = {}) {
    if (!tracksList.length) return null;
    const consume = Boolean(opts.consume);
    const curId = opts.anchorId && byId.has(opts.anchorId)
      ? opts.anchorId
      : resolveHistoryAnchorId();
    const curTrack = curId ? byId.get(curId) : null;
    const curIsAi = Boolean(curTrack && curTrack.is_ai);

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
          if (effCursor >= 0 && effCursor + 1 < effHistory.length) {
            effHistory.splice(effCursor + 1);
          }
          if (effHistory[effHistory.length - 1] !== curId) {
            effHistory.push(curId);
          }
          if (effHistory.length > 500) effHistory.shift();
          effCursor = effHistory.length - 1;
        }
      }
    }

    if (effCursor >= 0 && effCursor + 1 < effHistory.length) {
      for (let idx = effCursor + 1; idx < effHistory.length; idx++) {
        const forwardId = effHistory[idx];
        if (!forwardId || !byId.has(forwardId) || forwardId === curId) continue;
        const forwardTrack = byId.get(forwardId);
        if (!isWalkEligible(forwardTrack, curIsAi, { allowSpoken: true, anyTerritory: true, ignoreViewFilter: false })) {
          continue;
        }
        if (consume) {
          historyCursor = idx;
        }
        return { track: forwardTrack, fromForwardHistory: true };
      }
      if (consume && historyCursor >= 0 && historyCursor + 1 < playHistory.length) {
        playHistory.splice(historyCursor + 1);
      }
      effHistory = effHistory.slice(0, effCursor + 1);
    }

    const nextTrack = pickNextSimilarTrack(curId, {
      peekOnly: !consume,
      allowSpoken: true,
      excludeIds: new Set(effHistory),
    });
    if (!nextTrack) return null;
    if (consume) {
      if (playHistory[playHistory.length - 1] !== nextTrack.id) {
        playHistory.push(nextTrack.id);
      }
      if (playHistory.length > 500) playHistory.shift();
      historyCursor = playHistory.length - 1;
      visitedIds.add(nextTrack.id);
    }
    return { track: nextTrack, fromForwardHistory: false };
  }

  function peekNextTrack(anchorId) {
    if (pending && pending.trackId && byId.has(pending.trackId)) {
      const activeId = active && !active.disposed ? active.trackId : null;
      if (pending.trackId !== activeId) return byId.get(pending.trackId);
    }
    const dec = resolveNextSimilarDecision({
      consume: false,
      anchorId: anchorId || null,
    });
    return dec ? dec.track : null;
  }

  function nextSimilarTrack(opts = {}) {
    const dec = resolveNextSimilarDecision({ consume: true });
    if (!dec || !dec.track) return null;
    return applyManualHistorySkip(dec.track, opts);
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
        return applyManualHistorySkip(byId.get(prevId), opts);
      }
    }

    const prevNeighbor = pickPrevSimilarTrack(curId, { allowSpoken: true });
    if (!prevNeighbor) return null;
    if (playHistory[0] !== prevNeighbor.id) {
      playHistory.unshift(prevNeighbor.id);
    }
    if (playHistory.length > 500) playHistory.pop();
    historyCursor = 0;
    visitedIds.add(prevNeighbor.id);
    return applyManualHistorySkip(prevNeighbor, opts);
  }

  function advanceToNextSimilar(opts = {}) {
    if (!active || active.disposed) return null;
    const prevId = active.trackId;
    const dec = resolveNextSimilarDecision({ consume: true, anchorId: prevId });
    if (!dec || !dec.track) return null;
    const nextTrack = dec.track;

    const fadeMs = opts.crossfadeMs === 0
      ? 0
      : (Number.isFinite(opts.crossfadeMs) ? Math.max(80, opts.crossfadeMs) : CROSSFADE_MS);
    const nextHasDrop = Boolean(nextTrack.has_drop) && Number(nextTrack.preview_start_sec) > 0.02;
    playTrack(nextTrack, {
      fromAutoPlay: true,
      fromHistoryNav: Boolean(dec.fromForwardHistory),
      fromStart: !nextHasDrop,
      crossfadeMs: fadeMs,
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

  function tickPlayback() {
    stepFadeFrame();

    if (!active || active.disposed) return;
    const el = active.htmlAudio;
    if (!el) return;

    // Beat callback for LEDs / visualizations
    const curSec = getVoiceCurrentTime(active);
    const beatDur = Math.max(0.05, active.beatDurSec || 0.5);
    const barDur = Math.max(0.25, active.barDurSec || 2.0);
    const step = Math.floor((curSec / beatDur) * 4) % 16;
    const barIdx = Math.floor(curSec / barDur);
    try { onBeatCb(active.trackId, step, barIdx, active); } catch (_) {}

    // Wait until initial metadata seek completes before checking loop/end boundaries
    if (active.seekPending !== null) return;
    // Do not auto-advance/loop-override while Timeline Animator owns era stop stepping
    if (active.stopIdx >= 0) return;

    if (!autoPlay) {
      // HARD REQUIREMENT (post-023316): when Auto-Play is OFF, never fade or shorten mush tracks!
      cancelMushFade(active);
      // Loop Mode (Auto-Play OFF): loop the snippet window [previewStart, previewEnd]
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

    // Auto-Play ON: play through to track end (or mush_onset_sec + 3.0s on flagged AI mush tracks)
    el.loop = false;
    if (active.track && active.track.is_spoken_word) return;
    const realDur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    if (realDur <= 0) return;

    const mushTrig = getEffectiveMushTriggerSec(active, realDur);
    if (mushTrig !== null && !active.crossfadeTriggered) {
      if (!fadingOut && curSec >= mushTrig - MUSH_TASTE_SEC) {
        maybePrewarmNext(active.trackId);
      }
      if (!active.mushFadeActive && curSec >= mushTrig) {
        active.mushFadeActive = true;
        active.mushFadeStartMs = nowMs();
        active.mushFadeFactor = 1.0;
        ensureFadeRaf();
        notifyStateChange({ skipAppCallback: true });
      }
      if (active.mushFadeActive && realDur - curSec > 0.35) {
        return;
      }
    }

    const remaining = realDur - curSec;
    if (!fadingOut && remaining <= PREWARM_LEAD_SEC && remaining > CROSSFADE_SEC + 0.1) {
      maybePrewarmNext(active.trackId);
    }
    if (!active.crossfadeTriggered && realDur > 1.2 && remaining <= CROSSFADE_SEC) {
      active.crossfadeTriggered = true;
      const effFadeMs = Math.round(clamp(remaining, 0.25, CROSSFADE_SEC) * 1000);
      advanceToNextSimilar({ crossfadeMs: effFadeMs });
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
    if (fadeRafId && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(fadeRafId);
      fadeRafId = 0;
    }
  }

  function playTrack(trackId, opts = {}) {
    const tr = typeof trackId === "object" ? trackId : byId.get(trackId);
    const urls = resolveTrackUrls(tr);
    if (!tr || !urls.length || !ensureDecks()) return false;

    const gen = ++generation;
    const crossfadeMs = Number.isFinite(opts.crossfadeMs) && opts.crossfadeMs > 0 ? opts.crossfadeMs : 0;
    const now = nowMs();

    // Seed visited set & session history for no-repeat ~550-track walk
    if (tr.id) {
      visitedIds.add(tr.id);
      if (!opts.fromHistoryNav) {
        recordHistoryVisit(tr.id);
      }
    }

    // Fast warm-deck resume if the requested track is already buffered & paused on active
    if (
      active &&
      !active.disposed &&
      active.trackId === tr.id &&
      active.htmlAudio &&
      active.htmlAudio.paused &&
      active.htmlAudio.getAttribute("src") &&
      !(crossfadeMs > 0) &&
      (opts.stopIdx === undefined || opts.stopIdx === active.stopIdx)
    ) {
      const elWarm = active.htmlAudio;
      lastPaused = null;
      pending = null;
      if (typeof opts.startSec === "number" && Number.isFinite(opts.startSec)) {
        const dest = Math.max(0, opts.startSec);
        if (elWarm.readyState >= 1) {
          try { elWarm.currentTime = dest; active.seekPending = null; } catch (_) { active.seekPending = dest; }
        } else {
          active.seekPending = dest;
        }
      } else if (opts.fromStart) {
        if (elWarm.readyState >= 1) {
          try { elWarm.currentTime = 0; active.seekPending = null; } catch (_) { active.seekPending = 0; }
        } else {
          active.seekPending = 0;
        }
      }
      active.fadeIn = false;
      active.fadeFactor = 1.0;
      cancelMushFade(active);
      syncVoiceVolume(active);
      startTickLoop();
      const warmUrlIdx = active.urlIdx;
      elWarm.play().catch(() => {
        if (active && !active.disposed && active.urlIdx === warmUrlIdx) {
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

    // Choose target deck & transition existing voice(s)
    let nextDeckIdx = 0;
    if (active && !active.disposed) {
      nextDeckIdx = 1 - active.deckIdx;
      if (fadingOut && !fadingOut.disposed) {
        stopVoice(fadingOut);
        fadingOut = null;
      }
      if (crossfadeMs > 0 && isVoiceActivelyPlaying(active)) {
        const outgoing = active;
        active = null;
        const effMush = outgoing.mushFadeActive && Number.isFinite(outgoing.mushFadeFactor)
          ? clamp(outgoing.mushFadeFactor, MUSH_MIN_FACTOR, 1)
          : 1.0;
        outgoing.mushFadeActive = false;
        outgoing.mushFadeStartMs = 0;
        outgoing.mushFadeFactor = 1.0;
        outgoing.fadeIn = false;
        outgoing.fadeStartMs = now;
        outgoing.fadeDurMs = crossfadeMs;
        outgoing.fadeStartFactor = (Number.isFinite(outgoing.fadeFactor) ? outgoing.fadeFactor : 1.0) * effMush;
        syncVoiceVolume(outgoing);
        fadingOut = outgoing;
      } else {
        cancelMushFade(active);
        stopVoice(active);
        active = null;
      }
    } else if (fadingOut && !fadingOut.disposed) {
      nextDeckIdx = 1 - fadingOut.deckIdx;
    }

    const el = decks[nextDeckIdx];
    const reusePrewarm = Boolean(
      prewarm &&
      !prewarm.disposed &&
      prewarm.deckIdx === nextDeckIdx &&
      prewarm.trackId === tr.id &&
      prewarm.el === el
    );

    let urlIdx = reusePrewarm ? prewarm.urlIdx : 0;
    let url = reusePrewarm ? prewarm.url : urls[0];
    let isFull = isUrlFullTrack(tr, url);

    if (reusePrewarm) {
      clearPrewarm(true);
    } else {
      clearPrewarm(false);
    }

    const initBounds = computeTrackBounds(tr, isFull, reusePrewarm && Number.isFinite(el.duration) ? el.duration : 0);
    const hasDropCue = Boolean(tr.has_drop) && initBounds.previewStart > 0.02;
    let initialStartSec = 0;
    if (typeof opts.startSec === "number" && Number.isFinite(opts.startSec)) {
      initialStartSec = Math.max(0, opts.startSec);
    } else if (opts.fromStart || (opts.fromAutoPlay && !hasDropCue) || (tr.is_ai && !hasDropCue)) {
      initialStartSec = 0;
    } else {
      initialStartSec = initBounds.previewStart;
    }

    const beatDurSec = tr.beat_sec || (60 / (tr.bpm || 120));
    const barDurSec = tr.bar_sec || beatDurSec * 4;
    const ctxNow = ctx ? ctx.currentTime : 0;

    const alreadySought = Boolean(
      reusePrewarm &&
      el.readyState >= 1 &&
      Math.abs((el.currentTime || 0) - initialStartSec) < 0.35
    );

    const voice = {
      gen,
      deckIdx: nextDeckIdx,
      trackId: tr.id,
      track: tr,
      urls,
      urlIdx,
      url,
      isFullTrack: isFull,
      src: null,
      htmlAudio: el,
      gain: null,
      barOriginCtxTime: ctxNow,
      slotStartCtxTime: ctxNow,
      startWallMs: now,
      beatDurSec,
      barDurSec,
      stopIdx: opts.stopIdx ?? -1,
      eraId: opts.eraId ?? tr.era,
      scheduled: true,
      isHtmlFallback: true,
      seekPending: (!alreadySought && initialStartSec > 0.02) ? initialStartSec : null,
      loopWindowActive: initialStartSec <= initBounds.previewEnd + 0.05,
      crossfadeTriggered: false,
      fadeIn: crossfadeMs > 0,
      fadeStartMs: now,
      fadeDurMs: crossfadeMs,
      fadeStartFactor: 0,
      fadeFactor: crossfadeMs > 0 ? 0 : 1.0,
      mushFadeActive: false,
      mushFadeStartMs: 0,
      mushFadeFactor: 1.0,
      mushCustomTriggerSec:
        opts.isManual &&
        typeof opts.startSec === "number" &&
        getRawMushTriggerSec(tr, initBounds.duration) !== null &&
        initialStartSec >= getRawMushTriggerSec(tr, initBounds.duration)
          ? initialStartSec + MUSH_TASTE_SEC
          : null,
      disposed: false,
      cleanup: null,
    };

    const applyPendingSeek = () => {
      if (voice.disposed || voice.seekPending === null) return;
      if (el.readyState < 1) return;
      const b = getVoiceBounds(voice);
      const maxSeek = b.duration > 0.4 ? Math.max(0, b.duration - 0.2) : voice.seekPending;
      const dest = clamp(voice.seekPending, 0, maxSeek);
      try {
        el.currentTime = dest;
        voice.seekPending = null;
        voice.loopWindowActive = dest <= b.previewEnd + 0.05;
        syncVoiceVolume(voice);
      } catch (_) {}
    };

    const onLoadedMeta = () => {
      if (voice.disposed) return;
      applyPendingSeek();
      notifyStateChange();
    };

    const onCanPlay = () => {
      if (voice.disposed) return;
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
      if (!voice.crossfadeTriggered) {
        voice.crossfadeTriggered = true;
        const nextId = advanceToNextSimilar({ crossfadeMs: 350 });
        if (!nextId) {
          lastPaused = {
            trackId: voice.trackId,
            track: voice.track,
            currentTime: 0,
            duration: getVoiceDuration(voice),
            isFullTrack: voice.isFullTrack,
            stopIdx: voice.stopIdx,
            eraId: voice.eraId,
          };
          stopVoice(voice);
          active = null;
          stopTickLoop();
          notifyStateChange();
        }
      }
    };

    const handlePlayRejection = (err, attemptUrlIdx) => {
      if (generation !== gen || active !== voice || voice.disposed) return;
      if (attemptUrlIdx !== voice.urlIdx) return;
      const errName = (err && err.name) || "";
      if (errName === "AbortError") return;
      // If a fallback URL exists and media load failed, let onError advance to the next URL
      if (errName !== "NotAllowedError" && voice.urlIdx + 1 < voice.urls.length) return;
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
      // Fallback gracefully down the priority chain (stream_url -> mp3_320_url -> preview_url)
      if (voice.urlIdx + 1 < voice.urls.length) {
        voice.urlIdx++;
        const fbAttemptIdx = voice.urlIdx;
        voice.url = voice.urls[fbAttemptIdx];
        voice.isFullTrack = isUrlFullTrack(tr, voice.url);
        const fbBounds = computeTrackBounds(tr, voice.isFullTrack, 0);
        const fbHasDropCue = Boolean(tr.has_drop) && fbBounds.previewStart > 0.02;
        const fbStart = (opts.fromStart || (opts.fromAutoPlay && !fbHasDropCue) || (tr.is_ai && !fbHasDropCue))
          ? 0
          : fbBounds.previewStart;
        voice.seekPending = fbStart > 0.02 ? fbStart : null;
        voice.loopWindowActive = true;
        try {
          el.loop = !autoPlay && !voice.isFullTrack && voice.stopIdx < 0;
          el.src = voice.url;
          syncVoiceVolume(voice);
          el.play().catch((e) => handlePlayRejection(e, fbAttemptIdx));
          notifyStateChange();
        } catch (_) {}
        return;
      }
      if (active === voice) {
        stopVoice(voice);
        active = null;
        notifyStateChange();
      }
    };

    let playbackInitiated = false;

    const onNativePlay = () => {
      if (voice.disposed || active !== voice) return;
      lastPaused = null;
      syncVoiceVolume(voice);
      startTickLoop();
      notifyStateChange();
    };

    const onNativePause = () => {
      if (!playbackInitiated || voice.disposed || active !== voice) return;
      if (el.ended) return;
      if (fadingOut && !fadingOut.disposed) {
        stopVoice(fadingOut);
        fadingOut = null;
      }
      voice.fadeIn = false;
      voice.fadeFactor = 1.0;
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

    active = voice;

    if (!reusePrewarm) {
      try {
        el.pause();
        el.src = url;
      } catch (_) {}
    }
    el.loop = !autoPlay && !voice.isFullTrack && voice.stopIdx < 0;

    if (el.readyState >= 1) {
      if (voice.seekPending !== null) {
        applyPendingSeek();
      } else if (initialStartSec === 0 && (el.currentTime || 0) > 0.05) {
        try { el.currentTime = 0; } catch (_) {}
      }
    }
    syncVoiceVolume(voice);

    startTickLoop();
    if (crossfadeMs > 0) ensureFadeRaf();

    const initialAttemptIdx = voice.urlIdx;
    playbackInitiated = true;
    el.play().catch((err) => handlePlayRejection(err, initialAttemptIdx));
    notifyStateChange({ skipAppCallback: Boolean(opts.fromAutoPlay) });
    return true;
  }

  function resolveIdleTargetTrackId() {
    if (typeof window !== "undefined") {
      const selPlayer = window.BTMM_PLAYER && typeof window.BTMM_PLAYER.selected === "function"
        ? window.BTMM_PLAYER.selected()
        : null;
      if (selPlayer && byId.has(selPlayer)) return selPlayer;
      const selMap = window.ME_NODEMAP && typeof window.ME_NODEMAP.selected === "function"
        ? window.ME_NODEMAP.selected()
        : null;
      if (selMap && byId.has(selMap)) return selMap;
    }
    if (lastPaused && byId.has(lastPaused.trackId)) return lastPaused.trackId;
    return null;
  }

  function seek(seconds) {
    const rawSec = Math.max(0, Number(seconds) || 0);
    if (active && !active.disposed && active.htmlAudio) {
      const el = active.htmlAudio;
      const b = getVoiceBounds(active);
      const maxSeek = b.duration > 0.1 ? Math.max(0, b.duration - 0.05) : rawSec;
      const target = clamp(rawSec, 0, maxSeek);
      // Immediately cancel any active mush fade and restore full volume on manual seek
      cancelMushFade(active);
      const rawMushTrig = getRawMushTriggerSec(active.track, b.duration);
      if (rawMushTrig !== null && target >= rawMushTrig) {
        active.mushCustomTriggerSec = target + MUSH_TASTE_SEC;
      } else {
        active.mushCustomTriggerSec = null;
      }
      if (b.duration > 0 && (b.duration - target) > CROSSFADE_SEC + 0.15) {
        active.crossfadeTriggered = false;
      }
      active.loopWindowActive = target <= b.previewEnd - 0.05;
      if (el.readyState >= 1) {
        try {
          el.currentTime = target;
          active.seekPending = null;
          syncVoiceVolume(active);
        } catch (_) {
          active.seekPending = target;
        }
      } else {
        active.seekPending = target;
      }
      if (el.paused && enabled) {
        el.play().catch(() => {});
      }
      // Notify lightweight listeners without rebuilding cardEl DOM during pointer drag scrubbing
      notifyStateChange({ skipAppCallback: true });
      return target;
    }

    const idleId = resolveIdleTargetTrackId();
    if (idleId) {
      playTrack(idleId, { startSec: rawSec, isManual: true });
      return rawSec;
    }
    return 0;
  }

  function restart() {
    if (active && !active.disposed && active.htmlAudio) {
      const el = active.htmlAudio;
      cancelMushFade(active);
      active.mushCustomTriggerSec = null;
      active.crossfadeTriggered = false;
      active.loopWindowActive = true;
      active.seekPending = null;
      if (el.readyState >= 1) {
        try { el.currentTime = 0; } catch (_) { active.seekPending = 0; }
      } else {
        active.seekPending = 0;
      }
      syncVoiceVolume(active);
      if (el.paused && enabled) {
        el.play().catch(() => {});
      }
      notifyStateChange({ skipAppCallback: true });
      return true;
    }

    const idleId = resolveIdleTargetTrackId();
    if (idleId) {
      playTrack(idleId, { startSec: 0, fromStart: true, isManual: true });
      return true;
    }
    return false;
  }

  function pauseActive() {
    if (!active || active.disposed) return false;
    const b = getVoiceBounds(active);
    lastPaused = {
      trackId: active.trackId,
      currentTime: getVoiceCurrentTime(active),
      duration: b.duration,
      previewStart: b.previewStart,
      previewEnd: b.previewEnd,
      isFullTrack: active.isFullTrack,
    };
    if (fadingOut && !fadingOut.disposed) {
      stopVoice(fadingOut);
      fadingOut = null;
    }
    active.fadeIn = false;
    active.fadeFactor = 1.0;
    cancelMushFade(active);
    clearPrewarm(false);
    if (active.htmlAudio) {
      // Keep el.src intact & buffered so iOS Safari / Android Chrome Lock-Screen
      // MediaSession stays mounted while paused and resumes with zero network reload.
      try { active.htmlAudio.pause(); } catch (_) {}
    } else {
      generation++;
      stopVoice(active);
      active = null;
    }
    stopTickLoop();
    notifyStateChange();
    return true;
  }

  function resumeActive() {
    if (!active || active.disposed || !active.htmlAudio) return false;
    if (!active.htmlAudio.paused && !active.htmlAudio.ended) return true;
    lastPaused = null;
    active.fadeIn = false;
    active.fadeFactor = 1.0;
    syncVoiceVolume(active);
    startTickLoop();
    active.htmlAudio.play().catch(() => {
      if (active && !active.disposed) {
        try { active.htmlAudio.pause(); } catch (_) {}
        stopTickLoop();
        notifyStateChange();
      }
    });
    notifyStateChange();
    return true;
  }

  function toggleTrack(trackId, opts = {}) {
    if (active && !active.disposed && active.trackId === trackId && !pending) {
      if (isVoiceActivelyPlaying(active)) {
        pauseActive();
        return false;
      }
      if (typeof opts.startSec === "number" && Number.isFinite(opts.startSec) && active.htmlAudio) {
        try { active.htmlAudio.currentTime = Math.max(0, opts.startSec); } catch (_) {}
      } else if (opts.fromStart && active.htmlAudio) {
        try { active.htmlAudio.currentTime = 0; } catch (_) {}
      }
      return resumeActive();
    }
    if (pending && pending.trackId === trackId) {
      stop();
      return false;
    }
    if (
      lastPaused &&
      lastPaused.trackId === trackId &&
      opts.startSec === undefined &&
      !opts.fromStart
    ) {
      playTrack(trackId, { ...opts, startSec: lastPaused.currentTime });
      return true;
    }
    playTrack(trackId, opts);
    return true;
  }

  function stop() {
    generation++;
    lastPaused = null;
    stopVoice(active);
    stopVoice(fadingOut);
    active = null;
    fadingOut = null;
    pending = null;
    clearPrewarm(false);
    stopTickLoop();
    notifyStateChange();
  }

  function setAutoPlay(val) {
    const next = Boolean(val);
    if (autoPlay === next) return autoPlay;
    autoPlay = next;
    if (active && !active.disposed && active.htmlAudio) {
      if (!autoPlay) {
        // Immediately cancel any active mush fade and restore full volume when Auto-play is turned OFF
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

  function onStateChange(fn) {
    if (typeof fn !== "function") return () => {};
    stateListeners.add(fn);
    return () => {
      stateListeners.delete(fn);
    };
  }

  function triggerBellNote(cents, delaySec = 0) {
    const ac = ensureCtx();
    if (!ac) return;
    const now = ac.currentTime + delaySec;
    const freq = 261.6256 * Math.pow(2, cents / 1200);
    const outGain = ac.createGain();
    outGain.gain.setValueAtTime(0.0001, now);
    outGain.gain.exponentialRampToValueAtTime(0.22, now + 0.015);
    outGain.gain.exponentialRampToValueAtTime(0.0008, now + 0.85);
    outGain.connect(masterGain || ac.destination);

    const osc1 = ac.createOscillator();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(freq, now);
    osc1.connect(outGain);

    const overGain = ac.createGain();
    overGain.gain.setValueAtTime(0.24, now);
    overGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    overGain.connect(outGain);

    const osc2 = ac.createOscillator();
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(freq * 2.756, now);
    osc2.connect(overGain);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.9);
    osc2.stop(now + 0.4);
  }

  function auditionScale(scaleObj) {
    if (!scaleObj || !scaleObj.degrees) return;
    scaleObj.degrees.forEach((d, idx) => triggerBellNote(d.cents, idx * 0.28));
  }

  function audition12Tet() {
    [0, 200, 300, 500, 700, 800, 1000, 1200].forEach((c, idx) => triggerBellNote(c, idx * 0.28));
  }

  window.ME_AUDIO = {
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
    pickNextSimilarTrack: (id, opts) => pickNextSimilarTrack(id, opts),
    pickPrevSimilarTrack: (id, opts) => pickPrevSimilarTrack(id, opts),
    getPlayHistory: () => ({ ids: playHistory.slice(), cursor: historyCursor }),
    syncHistorySelection: (id) => recordHistoryVisit(id),
    resetPlayHistory: () => { playHistory.length = 0; historyCursor = -1; },
    isPlaying: (id) => Boolean(isVoiceActivelyPlaying(active) && (id ? active.trackId === id : true)),
    visitedCount: () => visitedIds.size,
    getVisitedIds: () => Array.from(visitedIds),
    resetVisited: () => { visitedIds.clear(); },
    getDecks: () => { ensureDecks(); return decks.slice(); },
    loadBuffer,
    prefetchTracks,
    promotePending,
    getNextBarBoundary,
    ensureCtx,
    triggerBellNote,
    auditionScale,
    audition12Tet,
    playing: () => (isVoiceActivelyPlaying(active) ? active.trackId : null),
    pending: () => (pending ? pending.trackId : null),
    activeVoice: () => active,
    fadingVoice: () => fadingOut,
    pendingVoice: () => pending,
    ctxTime: () => (ctx ? ctx.currentTime : 0),
    isEnabled: () => enabled,
    setEnabled(val) {
      enabled = Boolean(val);
      syncMasterGain();
      notifyStateChange();
    },
    setVolume(val) {
      volume = clamp(Number(val) || 0, 0, 1);
      syncMasterGain();
    },
    getVolume: () => volume,
    setOnStateChange(fn) { onStateChangeCb = typeof fn === "function" ? fn : () => {}; },
    setOnAutoAdvance(fn) { onAutoAdvanceCb = typeof fn === "function" ? fn : null; },
    setOnBeat(fn) { onBeatCb = typeof fn === "function" ? fn : () => {}; },
  };
})();

