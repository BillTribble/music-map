// Cross-Platform Hardware Media Keys & OS Now Playing Controller (macOS, Windows, Linux, iOS, Android)
// - W3C `navigator.mediaSession` live metadata (`title`, `artist`, `era · constellation` album, 96–512px PNG artwork)
// - Full transport & scrub handlers (`play`, `pause`, `stop`, `previoustrack`, `nexttrack`, `seekto`, `seekbackward`, `seekforward`)
// - Uncaptured 12s sub-audible WAV companion `<audio>` carrier so WebAudio (`createMediaElementSource`) & dual-deck
//   DJ crossfades keep OS AudioFocus / macOS Now Playing / Windows SMTC continuously active with zero state flicker
// - Deduplicated (`150ms`) in-window `keydown` fallback for `MediaPlayPause`, `MediaTrackNext`, `MediaTrackPrevious`, `MediaStop`
(function () {
  "use strict";

  const ARTIST_NAME = "Bill Tribble";
  const DEFAULT_ALBUM = "Bill Tribble Music Map";
  const POSITION_THROTTLE_MS = 950;
  const PLAYING_SYNC_INTERVAL_MS = 1000;
  const DEFAULT_SEEK_OFFSET_SEC = 10;
  const ACTION_DEDUPE_MS = 150;
  const GESTURE_UNLOCK_GUARD_MS = 80;

  // Chromium's MediaSessionImpl requires HTMLMediaElement duration >= 5.0s (`kMinimumDurationForContent`)
  // and `!muted && volume > 0` to classify as `MediaContentType::kPersistent` and route OS hardware media keys.
  const CARRIER_SAMPLE_RATE = 8000;
  const CARRIER_DURATION_SEC = 12;
  const CARRIER_VOLUME = 0.01;

  const ARTWORK_REL_SPECS = [
    { rel: "assets/media-artwork-96.png?v=20261127r", sizes: "96x96", type: "image/png" },
    { rel: "assets/media-artwork-192.png?v=20261125p2", sizes: "192x192", type: "image/png" },
    { rel: "assets/media-artwork-256.png?v=20261125p2", sizes: "256x256", type: "image/png" },
    { rel: "assets/media-artwork-512.png?v=20261125p2", sizes: "512x512", type: "image/png" },
  ];

  const byId = new Map();
  const erasById = new Map();
  const boundDecks = new WeakSet();
  const registeredHandlers = new Map();

  const lastActionByKind = {
    transport: { source: "", atMs: -Infinity, targetState: "" },
    next: { source: "", atMs: -Infinity },
    prev: { source: "", atMs: -Infinity },
    stop: { source: "", atMs: -Infinity },
  };

  let cachedArtwork = null;
  let cachedBaseHref = "";
  let lastMetadataKey = "";
  let lastPlaybackState = "";
  let lastPositionSyncMs = 0;
  let lastPositionState = null;
  let lastTrackCount = 0;
  let wasOverallPlaying = false;
  let lastPlayTransitionMs = -Infinity;
  let playingSyncTimer = null;

  let carrierEl = null;
  let carrierBlobUrl = "";
  let carrierEnabled = true;

  function nowMs() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function getMediaSession() {
    if (typeof navigator === "undefined" || !navigator.mediaSession) return null;
    return navigator.mediaSession;
  }

  // Build a 12s 8kHz 16-bit mono RIFF WAV with alternating +1/-1 LSB samples (zero DC offset,
  // -90.3 dBFS sample level -> -130.3 dBFS at volume 0.01: non-zero PCM for WebKit silence checks,
  // >= 5s for Chromium persistent media focus, zero network I/O, zero audible output).
  function getCarrierWavUrl() {
    if (carrierBlobUrl) return carrierBlobUrl;
    if (typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      return "";
    }
    const numSamples = CARRIER_SAMPLE_RATE * CARRIER_DURATION_SEC;
    const dataBytes = numSamples * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buf);
    const writeAscii = (off, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    };

    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true);  // AudioFormat = 1 (PCM)
    view.setUint16(22, 1, true);  // NumChannels = 1
    view.setUint32(24, CARRIER_SAMPLE_RATE, true);
    view.setUint32(28, CARRIER_SAMPLE_RATE * 2, true); // ByteRate
    view.setUint16(32, 2, true);  // BlockAlign
    view.setUint16(34, 16, true); // BitsPerSample
    writeAscii(36, "data");
    view.setUint32(40, dataBytes, true);

    const samples = new Int16Array(buf, 44, numSamples);
    for (let i = 0; i < numSamples; i++) {
      samples[i] = (i & 1) === 0 ? 1 : -1;
    }

    try {
      carrierBlobUrl = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    } catch (_) {
      carrierBlobUrl = "";
    }
    return carrierBlobUrl;
  }

  function ensureCarrierElement() {
    if (!carrierEnabled) return null;
    if (carrierEl) {
      if (
        typeof document !== "undefined" &&
        document.body &&
        !carrierEl.parentNode
      ) {
        try { document.body.appendChild(carrierEl); } catch (_) {}
      }
      return carrierEl;
    }
    if (typeof document === "undefined" && typeof Audio === "undefined") return null;
    const url = getCarrierWavUrl();
    if (!url) return null;

    try {
      const el = typeof document !== "undefined" && typeof document.createElement === "function"
        ? document.createElement("audio")
        : new Audio();
      el.setAttribute("aria-hidden", "true");
      el.setAttribute("data-btmm-media-carrier", "1");
      el.preload = "auto";
      el.loop = true;
      el.playsInline = true;
      el.muted = false;
      el.volume = CARRIER_VOLUME;
      if (el.style) {
        el.style.display = "none";
      }
      el.src = url;

      const reassertPosition = () => {
        const ms = getMediaSession();
        if (!ms) return;
        syncPositionState(ms, resolveCurrentTrackState(), true);
      };
      el.addEventListener("loadedmetadata", reassertPosition);
      el.addEventListener("play", reassertPosition);
      el.addEventListener("seeked", reassertPosition);

      if (typeof document !== "undefined" && document.body) {
        try { document.body.appendChild(el); } catch (_) {}
      }
      carrierEl = el;
      return carrierEl;
    } catch (_) {
      return null;
    }
  }

  function syncCarrierPlayback(shouldPlay) {
    if (!carrierEnabled) return;
    if (shouldPlay) {
      const el = ensureCarrierElement();
      if (!el) return;
      el.loop = true;
      el.muted = false;
      el.volume = CARRIER_VOLUME;
      if (el.paused) {
        try {
          const p = el.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch (_) {}
      }
    } else if (carrierEl && !carrierEl.paused) {
      try { carrierEl.pause(); } catch (_) {}
    }
  }

  function hydrateCatalog() {
    const data = typeof window !== "undefined" ? window.CORPUS_DATA : null;
    if (!data) return;
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    if (byId.size > 0 && tracks.length === lastTrackCount) return;
    byId.clear();
    erasById.clear();
    const eras = Array.isArray(data.eras) ? data.eras : [];
    for (let i = 0; i < eras.length; i++) {
      const er = eras[i];
      if (er && er.id) erasById.set(er.id, er);
    }
    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i];
      if (tr && tr.id) byId.set(tr.id, tr);
    }
    lastTrackCount = tracks.length;
  }

  function lookupTrack(trackId, activeVoice) {
    if (!trackId) return null;
    if (activeVoice && activeVoice.track && activeVoice.track.id === trackId) {
      return activeVoice.track;
    }
    hydrateCatalog();
    if (byId.has(trackId)) return byId.get(trackId);
    // Re-scan once if catalog was mutated dynamically after boot
    lastTrackCount = -1;
    hydrateCatalog();
    return byId.get(trackId) || null;
  }

  function resolveArtworkList() {
    const baseHref =
      typeof window !== "undefined" && window.location && window.location.href
        ? window.location.href
        : "";
    if (cachedArtwork && cachedBaseHref === baseHref) {
      return cachedArtwork;
    }
    cachedBaseHref = baseHref;
    cachedArtwork = ARTWORK_REL_SPECS.map((spec) => {
      let resolvedSrc = spec.rel;
      if (baseHref) {
        try {
          resolvedSrc = new URL(spec.rel, baseHref).href;
        } catch (_) {
          resolvedSrc = spec.rel;
        }
      }
      return {
        src: resolvedSrc,
        sizes: spec.sizes,
        type: spec.type,
      };
    });
    return cachedArtwork;
  }

  function buildAlbumSubtitle(track) {
    if (!track) return DEFAULT_ALBUM;
    hydrateCatalog();
    if (track.is_ai) {
      const eraPart = `Gen AI (${track.year || "2025"})`;
      const rawCluster = String(track.cluster_label || "")
        .replace(/^Generative\s+AI\s*[·•-]\s*/i, "")
        .trim();
      const parts = [eraPart, rawCluster].filter(Boolean);
      return parts.length ? parts.join(" · ") : DEFAULT_ALBUM;
    }
    const er = track.era ? erasById.get(track.era) : null;
    const eraPart = er
      ? (er.sublabel ? `${er.label} (${er.sublabel})` : String(er.label || ""))
      : String(track.era || "").trim();
    const clusterPart = String(track.cluster_label || "").trim();
    const parts = [eraPart, clusterPart].filter(Boolean);
    return parts.length ? parts.join(" · ") : DEFAULT_ALBUM;
  }

  function isAudioElPlaying(el) {
    return Boolean(el && !el.paused && !el.ended);
  }

  function resolveCurrentTrackState() {
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    const player = typeof window !== "undefined" ? window.BTMM_PLAYER : null;
    const nodemap = typeof window !== "undefined" ? window.ME_NODEMAP : null;

    const av = ma && typeof ma.activeVoice === "function" ? ma.activeVoice() : null;
    const activeValid = Boolean(av && !av.disposed);
    const fv = ma && typeof ma.fadingVoice === "function" ? ma.fadingVoice() : null;
    const fadingValid = Boolean(fv && !fv.disposed);
    const pv = ma && typeof ma.pendingVoice === "function" ? ma.pendingVoice() : null;
    const pendingValid = Boolean(pv && !pv.disposed);
    const snap = ma && typeof ma.getPlaybackState === "function" ? ma.getPlaybackState() : null;

    let trackId = null;
    if (activeValid && av.trackId) {
      trackId = av.trackId;
    } else if (pendingValid && pv.trackId) {
      trackId = pv.trackId;
    } else if (snap && snap.trackId) {
      trackId = snap.trackId;
    } else if (player && typeof player.selected === "function" && player.selected()) {
      trackId = player.selected();
    } else if (nodemap && typeof nodemap.selected === "function" && nodemap.selected()) {
      trackId = nodemap.selected();
    } else if (fadingValid && fv.trackId) {
      trackId = fv.trackId;
    }

    const track = lookupTrack(trackId, activeValid ? av : (fadingValid ? fv : null));

    // Overall player playback state: stays true across dual-deck crossfades (`fadingVoice` playing
    // while `activeVoice` buffers/promotes, or when outgoing `deckA.pause()` fires at blend end).
    const activePlaying = activeValid && isAudioElPlaying(av.htmlAudio);
    const fadingPlaying = fadingValid && isAudioElPlaying(fv.htmlAudio);
    const pendingActive = pendingValid || Boolean(snap && snap.pending);
    const enginePlaying = Boolean(
      (snap && snap.playing) || (ma && typeof ma.isPlaying === "function" && ma.isPlaying())
    );
    const isPlaying = Boolean(activePlaying || fadingPlaying || pendingActive || enginePlaying);

    return {
      trackId,
      track,
      activeVoice: activeValid ? av : null,
      fadingVoice: fadingValid ? fv : null,
      snap,
      isPlaying,
    };
  }

  function computePositionNumbers(ctxState) {
    const { track, activeVoice, snap } = ctxState;
    let dur = 0;
    let pos = 0;
    let rate = 1.0;

    if (activeVoice && activeVoice.htmlAudio) {
      const el = activeVoice.htmlAudio;
      const elDur = Number(el.duration);
      if (Number.isFinite(elDur) && elDur > 0) {
        dur = elDur;
      }
      if (activeVoice.seekPending !== null && Number.isFinite(activeVoice.seekPending) && activeVoice.seekPending >= 0) {
        pos = Number(activeVoice.seekPending);
      } else {
        const elPos = Number(el.currentTime);
        if (Number.isFinite(elPos) && elPos >= 0) {
          pos = elPos;
        }
      }
      const elRate = Number(el.playbackRate);
      if (Number.isFinite(elRate) && elRate > 0) {
        rate = elRate;
      } else if (Number.isFinite(activeVoice.playbackRate) && activeVoice.playbackRate > 0) {
        rate = Number(activeVoice.playbackRate);
      }
    }

    if (!(dur > 0) && snap && Number.isFinite(snap.duration) && snap.duration > 0) {
      dur = Number(snap.duration);
    }
    if (!(dur > 0) && track) {
      const est = Number(track.full_duration_sec) || Number(track.duration_sec) || 0;
      if (Number.isFinite(est) && est > 0) {
        dur = est;
      }
    }

    if (!activeVoice && snap && Number.isFinite(snap.currentTime) && snap.currentTime >= 0) {
      pos = Number(snap.currentTime);
    }
    if (!activeVoice && snap && Number.isFinite(snap.playbackRate) && snap.playbackRate > 0) {
      rate = Number(snap.playbackRate);
    }

    return { dur, pos, rate };
  }

  function syncPositionState(ms, ctxState, force) {
    if (!ms || typeof ms.setPositionState !== "function") return;
    const now = nowMs();
    if (!force && now - lastPositionSyncMs < POSITION_THROTTLE_MS) return;

    if (!ctxState || !ctxState.track) return;
    const { dur, pos, rate } = computePositionNumbers(ctxState);

    if (Number.isFinite(dur) && dur > 0) {
      const safePos = clamp(Number.isFinite(pos) ? pos : 0, 0, dur);
      const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1.0;
      const statePayload = {
        duration: dur,
        playbackRate: safeRate,
        position: safePos,
      };
      try {
        ms.setPositionState(statePayload);
        lastPositionSyncMs = now;
        lastPositionState = statePayload;
      } catch (_) {}
    }
  }

  function ensurePlayingSyncLoop(isPlaying) {
    if (isPlaying) {
      if (playingSyncTimer === null && typeof setInterval === "function") {
        playingSyncTimer = setInterval(() => {
          syncMediaSession({ forcePosition: false });
        }, PLAYING_SYNC_INTERVAL_MS);
      }
    } else if (playingSyncTimer !== null) {
      clearInterval(playingSyncTimer);
      playingSyncTimer = null;
    }
  }

  function syncMediaSession(opts = {}) {
    const ctxState = resolveCurrentTrackState();
    const { track, isPlaying } = ctxState;

    if (isPlaying && !wasOverallPlaying) {
      lastPlayTransitionMs = nowMs();
    }
    wasOverallPlaying = isPlaying;

    syncCarrierPlayback(isPlaying);
    ensurePlayingSyncLoop(isPlaying);
    bindDeckAudioListeners();

    const ms = getMediaSession();
    if (!ms) return null;

    if (!track) {
      if (lastPlaybackState !== "none") {
        try {
          ms.playbackState = "none";
          lastPlaybackState = "none";
        } catch (_) {}
      }
      return null;
    }

    const title = String(track.title || track.id || DEFAULT_ALBUM).trim() || DEFAULT_ALBUM;
    const artist = ARTIST_NAME;
    const album = buildAlbumSubtitle(track);
    const artwork = resolveArtworkList();
    const metaKey = `${track.id}|${title}|${artist}|${album}|${artwork[0] ? artwork[0].src : ""}`;
    const trackChanged = metaKey !== lastMetadataKey;

    if (
      (opts.forceMetadata || trackChanged || !ms.metadata) &&
      typeof MediaMetadata !== "undefined"
    ) {
      try {
        ms.metadata = new MediaMetadata({
          title,
          artist,
          album,
          artwork,
        });
        lastMetadataKey = metaKey;
      } catch (_) {}
    }

    const desiredState = isPlaying ? "playing" : "paused";
    const stateChanged = lastPlaybackState !== desiredState || ms.playbackState !== desiredState;
    if (stateChanged) {
      try {
        ms.playbackState = desiredState;
        lastPlaybackState = desiredState;
      } catch (_) {}
    }

    syncPositionState(ms, ctxState, Boolean(opts.forcePosition || trackChanged || stateChanged));

    return {
      trackId: track.id,
      title,
      artist,
      album,
      playbackState: desiredState,
      artwork,
    };
  }

  function isCrossSourceDuplicate(kind, source) {
    if (!source) return false;
    const entry = lastActionByKind[kind];
    if (!entry) return false;
    const now = nowMs();
    if (entry.source && entry.source !== source && now - entry.atMs < ACTION_DEDUPE_MS) {
      return true;
    }
    return false;
  }

  function recordActionSource(kind, source, targetState) {
    const entry = lastActionByKind[kind];
    if (!entry || !source) return;
    entry.source = source;
    entry.atMs = nowMs();
    if (targetState !== undefined) entry.targetState = targetState;
  }

  function markManualIntent(targetTrackId) {
    if (typeof window === "undefined") return;
    if (window.ME_EVENTS && typeof window.ME_EVENTS.markPlayIntent === "function") {
      try { window.ME_EVENTS.markPlayIntent("manual"); } catch (_) {}
    }
    if (targetTrackId && window.BTMM_EVENTS && typeof window.BTMM_EVENTS.notifyTrackIntent === "function") {
      try { window.BTMM_EVENTS.notifyTrackIntent(targetTrackId, { source: "manual" }); } catch (_) {}
    }
  }

  function syncMuteCheckboxUi(enabledVal) {
    if (typeof document === "undefined") return;
    const muteEl = document.getElementById("set-mute");
    if (muteEl && muteEl.checked !== Boolean(enabledVal)) {
      muteEl.checked = Boolean(enabledVal);
    }
  }

  function syncPlayerSelectionUi(targetId) {
    if (!targetId || typeof window === "undefined") return;
    if (window.ME_NODEMAP && typeof window.ME_NODEMAP.setSelectedSilent === "function") {
      if (typeof window.ME_NODEMAP.selected !== "function" || window.ME_NODEMAP.selected() !== targetId) {
        window.ME_NODEMAP.setSelectedSilent(targetId);
      }
    }
    if (window.BTMM_PLAYER && typeof window.BTMM_PLAYER.select === "function") {
      if (typeof window.BTMM_PLAYER.selected !== "function" || window.BTMM_PLAYER.selected() !== targetId) {
        window.BTMM_PLAYER.select(targetId, { silent: true });
      }
    }
  }

  function refreshPlayerUi() {
    if (typeof window === "undefined" || !window.BTMM_PLAYER) return;
    if (typeof window.BTMM_PLAYER.render === "function") {
      window.BTMM_PLAYER.render();
    } else if (typeof window.BTMM_PLAYER.refreshWaveform === "function") {
      window.BTMM_PLAYER.refreshWaveform();
    }
  }

  function resolveFallbackPlayTrackId() {
    const ctxState = resolveCurrentTrackState();
    if (ctxState.trackId) return ctxState.trackId;
    if (
      typeof window !== "undefined" &&
      window.ME_NODEMAP &&
      typeof window.ME_NODEMAP.firstVisibleTrackId === "function"
    ) {
      const visId = window.ME_NODEMAP.firstVisibleTrackId();
      if (visId) return visId;
    }
    hydrateCatalog();
    const first = byId.keys().next();
    return first && !first.done ? first.value : null;
  }

  function handleActionPlay(source) {
    if (isCrossSourceDuplicate("transport", source)) return;
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (!ma) return;

    recordActionSource("transport", source || "mediasession", "playing");

    if (typeof ma.isEnabled === "function" && !ma.isEnabled() && typeof ma.setEnabled === "function") {
      ma.setEnabled(true);
      syncMuteCheckboxUi(true);
    }
    if (typeof ma.ensureCtx === "function") {
      try { ma.ensureCtx(); } catch (_) {}
    }

    const ctxState = resolveCurrentTrackState();
    if (ctxState.isPlaying) {
      if (ctxState.trackId) syncPlayerSelectionUi(ctxState.trackId);
      syncMediaSession({ forcePosition: true });
      return;
    }

    const player = typeof window !== "undefined" ? window.BTMM_PLAYER : null;
    const selectedId = player && typeof player.selected === "function" ? player.selected() : null;
    const av = ctxState.activeVoice;
    const targetId =
      selectedId ||
      (av && av.trackId) ||
      (ctxState.snap && ctxState.snap.trackId) ||
      resolveFallbackPlayTrackId();
    if (!targetId) return;

    markManualIntent(targetId);
    syncPlayerSelectionUi(targetId);

    if (
      av &&
      av.trackId === targetId &&
      av.htmlAudio &&
      av.htmlAudio.paused &&
      av.htmlAudio.getAttribute("src")
    ) {
      if (typeof ma.resume === "function") {
        ma.resume();
      } else {
        av.htmlAudio.play().catch(() => {});
      }
    } else if (typeof ma.toggleTrack === "function") {
      ma.toggleTrack(targetId, { isManual: true });
    } else if (typeof ma.playTrack === "function") {
      ma.playTrack(targetId, { isManual: true });
    }

    refreshPlayerUi();
    syncMediaSession({ forcePosition: true });
  }

  function handleActionPause(source) {
    if (isCrossSourceDuplicate("transport", source)) return;
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (!ma) return;

    recordActionSource("transport", source || "mediasession", "paused");

    if (typeof ma.pause === "function") {
      ma.pause();
    } else {
      const playingId = typeof ma.playing === "function" ? ma.playing() : null;
      if (playingId && typeof ma.toggleTrack === "function") {
        ma.toggleTrack(playingId);
      } else {
        const av = typeof ma.activeVoice === "function" ? ma.activeVoice() : null;
        if (av && !av.disposed && av.htmlAudio && !av.htmlAudio.paused) {
          try { av.htmlAudio.pause(); } catch (_) {}
        }
      }
    }

    refreshPlayerUi();
    syncMediaSession({ forcePosition: true });
  }

  function handleActionStop(source) {
    if (isCrossSourceDuplicate("stop", source)) return;
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (!ma) return;

    recordActionSource("stop", source || "mediasession");
    recordActionSource("transport", source || "mediasession", "paused");

    if (typeof ma.pause === "function") {
      ma.pause();
    }
    if (typeof ma.seek === "function") {
      ma.seek(0);
    } else {
      const av = typeof ma.activeVoice === "function" ? ma.activeVoice() : null;
      if (av && !av.disposed && av.htmlAudio) {
        try {
          av.htmlAudio.pause();
          av.htmlAudio.currentTime = 0;
        } catch (_) {}
      }
    }

    refreshPlayerUi();
    syncMediaSession({ forcePosition: true });
  }

  function handleActionPrevTrack(source) {
    if (isCrossSourceDuplicate("prev", source)) return;
    recordActionSource("prev", source || "mediasession");

    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (ma && typeof ma.isEnabled === "function" && !ma.isEnabled() && typeof ma.setEnabled === "function") {
      ma.setEnabled(true);
      syncMuteCheckboxUi(true);
    }

    markManualIntent();
    const player = typeof window !== "undefined" ? window.BTMM_PLAYER : null;
    if (player && typeof player.prevSimilarTrack === "function") {
      player.prevSimilarTrack();
    } else if (ma && typeof ma.prevSimilarTrack === "function") {
      ma.prevSimilarTrack();
    }
    refreshPlayerUi();
    syncMediaSession({ forcePosition: true });
  }

  function handleActionNextTrack(source) {
    if (isCrossSourceDuplicate("next", source)) return;
    recordActionSource("next", source || "mediasession");

    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (ma && typeof ma.isEnabled === "function" && !ma.isEnabled() && typeof ma.setEnabled === "function") {
      ma.setEnabled(true);
      syncMuteCheckboxUi(true);
    }

    markManualIntent();
    const player = typeof window !== "undefined" ? window.BTMM_PLAYER : null;
    if (player && typeof player.nextSimilarTrack === "function") {
      player.nextSimilarTrack();
    } else if (ma && typeof ma.nextSimilarTrack === "function") {
      ma.nextSimilarTrack();
    }
    refreshPlayerUi();
    syncMediaSession({ forcePosition: true });
  }

  function applyClampedSeek(targetSec, useFastSeek) {
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (!ma) return;

    const ctxState = resolveCurrentTrackState();
    const { dur } = computePositionNumbers(ctxState);
    const clampedTarget = dur > 0 ? clamp(targetSec, 0, Math.max(0, dur - 0.05)) : Math.max(0, targetSec);
    const av = ctxState.activeVoice;
    const blendActive = Boolean(ctxState.snap && ctxState.snap.djBlendActive);

    if (
      useFastSeek &&
      !blendActive &&
      av &&
      av.htmlAudio &&
      typeof av.htmlAudio.fastSeek === "function"
    ) {
      try {
        av.htmlAudio.fastSeek(clampedTarget);
        av.seekPending = null;
        av.autoTransitionFired = false;
        av.lastManualSeekSec = clampedTarget;
        if (typeof window !== "undefined" && window.BTMM_PLAYER && typeof window.BTMM_PLAYER.refreshWaveform === "function") {
          window.BTMM_PLAYER.refreshWaveform();
        }
        syncMediaSession({ forcePosition: true });
        return;
      } catch (_) {}
    }

    if (typeof ma.seek === "function") {
      ma.seek(clampedTarget);
    } else if (av && av.htmlAudio) {
      try { av.htmlAudio.currentTime = clampedTarget; } catch (_) {}
    }
    if (typeof window !== "undefined" && window.BTMM_PLAYER && typeof window.BTMM_PLAYER.refreshWaveform === "function") {
      window.BTMM_PLAYER.refreshWaveform();
    }
    syncMediaSession({ forcePosition: true });
  }

  function handleActionSeekTo(details) {
    if (!details || !Number.isFinite(details.seekTime)) return;
    applyClampedSeek(Math.max(0, Number(details.seekTime)), Boolean(details.fastSeek));
  }

  function handleActionSeekBackward(details) {
    const rawOffset = details && Number.isFinite(details.seekOffset) && details.seekOffset > 0
      ? Number(details.seekOffset)
      : DEFAULT_SEEK_OFFSET_SEC;
    const ctxState = resolveCurrentTrackState();
    const { pos } = computePositionNumbers(ctxState);
    applyClampedSeek(Math.max(0, pos - rawOffset), false);
  }

  function handleActionSeekForward(details) {
    const rawOffset = details && Number.isFinite(details.seekOffset) && details.seekOffset > 0
      ? Number(details.seekOffset)
      : DEFAULT_SEEK_OFFSET_SEC;
    const ctxState = resolveCurrentTrackState();
    const { dur, pos } = computePositionNumbers(ctxState);
    const nextPos = dur > 0 ? Math.min(dur, pos + rawOffset) : pos + rawOffset;
    applyClampedSeek(nextPos, false);
  }

  function safeSetActionHandler(ms, action, handler) {
    registeredHandlers.set(action, handler);
    if (!ms || typeof ms.setActionHandler !== "function") return false;
    try {
      ms.setActionHandler(action, handler);
      return true;
    } catch (_) {
      return false;
    }
  }

  function registerActionHandlers() {
    const ms = getMediaSession();
    safeSetActionHandler(ms, "play", () => handleActionPlay("mediasession"));
    safeSetActionHandler(ms, "pause", () => handleActionPause("mediasession"));
    safeSetActionHandler(ms, "stop", () => handleActionStop("mediasession"));
    safeSetActionHandler(ms, "previoustrack", () => handleActionPrevTrack("mediasession"));
    safeSetActionHandler(ms, "nexttrack", () => handleActionNextTrack("mediasession"));
    safeSetActionHandler(ms, "seekto", handleActionSeekTo);
    safeSetActionHandler(ms, "seekbackward", handleActionSeekBackward);
    safeSetActionHandler(ms, "seekforward", handleActionSeekForward);
  }

  function resolveMediaKeyAction(ev) {
    if (!ev) return "";
    const k = ev.key || "";
    const c = ev.code || "";
    if (k === "MediaPlayPause" || c === "MediaPlayPause") return "MediaPlayPause";
    if (k === "MediaTrackNext" || c === "MediaTrackNext") return "MediaTrackNext";
    if (k === "MediaTrackPrevious" || c === "MediaTrackPrevious") return "MediaTrackPrevious";
    if (k === "MediaStop" || c === "MediaStop") return "MediaStop";
    if (k === "MediaFastForward" || c === "MediaFastForward") return "MediaFastForward";
    if (k === "MediaRewind" || c === "MediaRewind") return "MediaRewind";
    if (!k || k === "Unidentified") {
      const kc = Number(ev.keyCode || ev.which || 0);
      if (kc === 179) return "MediaPlayPause";
      if (kc === 176) return "MediaTrackNext";
      if (kc === 177) return "MediaTrackPrevious";
      if (kc === 178) return "MediaStop";
    }
    return "";
  }

  function onWindowKeyDown(ev) {
    const mediaKey = resolveMediaKeyAction(ev);
    if (!mediaKey) return;
    if (ev.defaultPrevented) return;

    if (mediaKey === "MediaPlayPause") {
      ev.preventDefault();
      if (ev.repeat) return;
      if (isCrossSourceDuplicate("transport", "keydown")) return;

      const ctxState = resolveCurrentTrackState();
      // Guard against toggling right back to paused if a cold deep-link unlock gesture
      // started playback synchronously earlier in this exact same keydown dispatch.
      if (
        ctxState.isPlaying &&
        nowMs() - lastPlayTransitionMs < GESTURE_UNLOCK_GUARD_MS &&
        lastActionByKind.transport.atMs < lastPlayTransitionMs
      ) {
        recordActionSource("transport", "keydown", "playing");
        syncMediaSession({ forcePosition: true });
        return;
      }

      if (ctxState.isPlaying) {
        handleActionPause("keydown");
      } else {
        handleActionPlay("keydown");
      }
      return;
    }

    if (mediaKey === "MediaTrackNext") {
      ev.preventDefault();
      if (ev.repeat) return;
      handleActionNextTrack("keydown");
      return;
    }

    if (mediaKey === "MediaTrackPrevious") {
      ev.preventDefault();
      if (ev.repeat) return;
      handleActionPrevTrack("keydown");
      return;
    }

    if (mediaKey === "MediaStop") {
      ev.preventDefault();
      if (ev.repeat) return;
      handleActionStop("keydown");
      return;
    }

    if (mediaKey === "MediaFastForward") {
      ev.preventDefault();
      handleActionSeekForward({ seekOffset: DEFAULT_SEEK_OFFSET_SEC });
      return;
    }

    if (mediaKey === "MediaRewind") {
      ev.preventDefault();
      handleActionSeekBackward({ seekOffset: DEFAULT_SEEK_OFFSET_SEC });
    }
  }

  function isActiveOrBlendingDeckElement(el) {
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (!ma) return false;
    const av = typeof ma.activeVoice === "function" ? ma.activeVoice() : null;
    if (av && !av.disposed && av.htmlAudio === el) return true;
    const fv = typeof ma.fadingVoice === "function" ? ma.fadingVoice() : null;
    if (fv && !fv.disposed && fv.htmlAudio === el) return true;
    return false;
  }

  function collectAllDeckElements() {
    const elements = [];
    const pushUnique = (el) => {
      if (el && typeof el.addEventListener === "function" && elements.indexOf(el) === -1) {
        elements.push(el);
      }
    };

    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (ma) {
      if (typeof ma.getDecks === "function") {
        const dList = ma.getDecks();
        if (Array.isArray(dList)) dList.forEach(pushUnique);
      }
      const av = typeof ma.activeVoice === "function" ? ma.activeVoice() : null;
      if (av && !av.disposed && av.htmlAudio) pushUnique(av.htmlAudio);
      const fv = typeof ma.fadingVoice === "function" ? ma.fadingVoice() : null;
      if (fv && !fv.disposed && fv.htmlAudio) pushUnique(fv.htmlAudio);
    }

    const dj = typeof window !== "undefined" ? window.DJ_MIXER : null;
    if (dj && typeof dj.getDecks === "function") {
      const djDecks = dj.getDecks();
      if (Array.isArray(djDecks)) {
        for (let i = 0; i < djDecks.length; i++) {
          const d = djDecks[i];
          if (!d) continue;
          pushUnique(d.webEl);
          pushUnique(d.directEl);
        }
      }
    }
    return elements;
  }

  function bindDeckAudioListeners() {
    const decks = collectAllDeckElements();
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;

    for (let i = 0; i < decks.length; i++) {
      const el = decks[i];
      if (!el || boundDecks.has(el)) continue;
      boundDecks.add(el);

      const onImmediateEvent = () => {
        if (!isActiveOrBlendingDeckElement(el)) return;
        syncMediaSession({ forcePosition: true });
      };

      const onPauseEvent = () => {
        // Ignore standby or outgoing crossfade deck `.pause()` events while another deck is active/playing
        const curActive = ma && typeof ma.activeVoice === "function" ? ma.activeVoice() : null;
        if (curActive && !curActive.disposed && curActive.htmlAudio && curActive.htmlAudio !== el) {
          if (isAudioElPlaying(curActive.htmlAudio)) return;
        }
        const curFading = ma && typeof ma.fadingVoice === "function" ? ma.fadingVoice() : null;
        if (curFading && !curFading.disposed && curFading.htmlAudio && curFading.htmlAudio !== el) {
          if (isAudioElPlaying(curFading.htmlAudio)) return;
        }
        syncMediaSession({ forcePosition: true });
      };

      const onThrottledTimeUpdate = () => {
        const curActive = ma && typeof ma.activeVoice === "function" ? ma.activeVoice() : null;
        if (!curActive || curActive.disposed || curActive.htmlAudio !== el) return;
        syncMediaSession({ forcePosition: false });
      };

      el.addEventListener("play", onImmediateEvent);
      el.addEventListener("playing", onImmediateEvent);
      el.addEventListener("loadedmetadata", onImmediateEvent);
      el.addEventListener("durationchange", onImmediateEvent);
      el.addEventListener("seeked", onImmediateEvent);
      el.addEventListener("ratechange", onImmediateEvent);
      el.addEventListener("pause", onPauseEvent);
      el.addEventListener("timeupdate", onThrottledTimeUpdate);
    }
  }

  let windowHooksBound = false;

  function hookPlayerAndAudio() {
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (ma && typeof ma.onStateChange === "function" && !ma.__btmmMediaSessionSubscribed) {
      ma.__btmmMediaSessionSubscribed = true;
      ma.onStateChange(() => {
        syncMediaSession({ forcePosition: false });
      });
    }

    const player = typeof window !== "undefined" ? window.BTMM_PLAYER : null;
    if (player && typeof player.select === "function" && !player.select.__btmmMediaSessionWrapped) {
      const origSelect = player.select;
      const wrappedSelect = function () {
        const res = origSelect.apply(this, arguments);
        syncMediaSession({ forcePosition: true });
        return res;
      };
      wrappedSelect.__btmmMediaSessionWrapped = true;
      player.select = wrappedSelect;
    }

    if (typeof window !== "undefined" && !windowHooksBound) {
      windowHooksBound = true;
      window.addEventListener("keydown", onWindowKeyDown);

      // Ensure the companion OS MediaSession carrier unlocks cleanly on any user gesture while playing
      const onUserGesture = () => {
        if (!carrierEnabled) return;
        const ctxState = resolveCurrentTrackState();
        if (ctxState.isPlaying) {
          syncCarrierPlayback(true);
        }
      };
      window.addEventListener("pointerdown", onUserGesture, { capture: true, passive: true });
      window.addEventListener("keydown", onUserGesture, { capture: true, passive: true });
    }

    bindDeckAudioListeners();
  }

  function init() {
    hydrateCatalog();
    registerActionHandlers();
    hookPlayerAndAudio();
    syncMediaSession({ forcePosition: true });
  }

  init();

  if (typeof window !== "undefined") {
    window.BTMM_MEDIA_SESSION = {
      init,
      sync: (opts) => syncMediaSession(opts || { forcePosition: true }),
      registerActionHandlers,
      getArtworkSpecs: resolveArtworkList,
      buildAlbumSubtitle,
      getRegisteredActions: () => Array.from(registeredHandlers.keys()),
      invokeAction: (action, details) => {
        const fn = registeredHandlers.get(action);
        if (typeof fn === "function") {
          fn(details);
          return true;
        }
        return false;
      },
      setCarrierEnabled: (val) => {
        carrierEnabled = Boolean(val);
        if (!carrierEnabled && carrierEl && !carrierEl.paused) {
          try { carrierEl.pause(); } catch (_) {}
        }
      },
      getSnapshot: () => {
        const ms = getMediaSession();
        const md = ms && ms.metadata ? ms.metadata : null;
        return {
          supported: Boolean(ms),
          playbackState: ms ? ms.playbackState : "none",
          title: md ? md.title : "",
          artist: md ? md.artist : "",
          album: md ? md.album : "",
          artwork: md && md.artwork ? Array.from(md.artwork) : [],
          positionState: lastPositionState ? Object.assign({}, lastPositionState) : null,
          registeredActions: Array.from(registeredHandlers.keys()),
          carrierActive: Boolean(carrierEl && !carrierEl.paused),
        };
      },
    };
  }
})();

