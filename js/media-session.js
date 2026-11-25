// Mobile Lock-Screen, Control Center, Android Media Notification & Headphone Media Session Controller
// Supplies live cleaned track titles, Era · Vibe subtitle, crisp 512px purple waveform app-icon artwork,
// scrubbable position state, and true Previous / Next track buttons (omitting ±10s podcast seek handlers).
(function () {
  "use strict";

  const ARTIST_NAME = "Bill Tribble";
  const DEFAULT_ALBUM = "Bill Tribble Music Map";
  const POSITION_THROTTLE_MS = 950;

  const ARTWORK_REL_SPECS = [
    { rel: "assets/media-artwork-192.png?v=20261125p2", sizes: "192x192", type: "image/png" },
    { rel: "assets/media-artwork-256.png?v=20261125p2", sizes: "256x256", type: "image/png" },
    { rel: "assets/media-artwork-512.png?v=20261125p2", sizes: "512x512", type: "image/png" },
  ];

  const byId = new Map();
  const erasById = new Map();
  const boundDecks = new WeakSet();

  let cachedArtwork = null;
  let cachedBaseHref = "";
  let lastMetadataKey = "";
  let lastPlaybackState = "";
  let lastPositionSyncMs = 0;
  let lastTrackCount = 0;

  function nowMs() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  function getMediaSession() {
    if (typeof navigator === "undefined" || !navigator.mediaSession) return null;
    return navigator.mediaSession;
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

  function resolveCurrentTrackState() {
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    const player = typeof window !== "undefined" ? window.BTMM_PLAYER : null;
    const nodemap = typeof window !== "undefined" ? window.ME_NODEMAP : null;

    const av = ma && typeof ma.activeVoice === "function" ? ma.activeVoice() : null;
    const activeValid = Boolean(av && !av.disposed);
    const snap = ma && typeof ma.getPlaybackState === "function" ? ma.getPlaybackState() : null;

    let trackId = null;
    if (activeValid && av.trackId) {
      trackId = av.trackId;
    } else if (snap && snap.trackId) {
      trackId = snap.trackId;
    } else if (player && typeof player.selected === "function" && player.selected()) {
      trackId = player.selected();
    } else if (nodemap && typeof nodemap.selected === "function" && nodemap.selected()) {
      trackId = nodemap.selected();
    }

    const track = lookupTrack(trackId, activeValid ? av : null);
    let isPlaying = false;
    if (activeValid && av.htmlAudio) {
      isPlaying = !av.htmlAudio.paused && !av.htmlAudio.ended;
    } else {
      isPlaying = Boolean(
        (snap && snap.playing) || (ma && typeof ma.isPlaying === "function" && ma.isPlaying())
      );
    }

    return {
      trackId,
      track,
      activeVoice: activeValid ? av : null,
      snap,
      isPlaying,
    };
  }

  function syncPositionState(ms, ctxState, force) {
    if (!ms || typeof ms.setPositionState !== "function") return;
    const now = nowMs();
    if (!force && now - lastPositionSyncMs < POSITION_THROTTLE_MS) return;

    const { track, activeVoice, snap } = ctxState;
    if (!track) return;

    let dur = 0;
    let pos = 0;
    let rate = 1.0;

    if (activeVoice && activeVoice.htmlAudio) {
      const el = activeVoice.htmlAudio;
      const elDur = Number(el.duration);
      if (Number.isFinite(elDur) && elDur > 0) {
        dur = elDur;
      }
      const elPos = Number(el.currentTime);
      if (Number.isFinite(elPos) && elPos >= 0) {
        pos = elPos;
      }
      const elRate = Number(el.playbackRate);
      if (Number.isFinite(elRate) && elRate > 0) {
        rate = elRate;
      }
    }

    if (!(dur > 0) && snap && Number.isFinite(snap.duration) && snap.duration > 0) {
      dur = Number(snap.duration);
    }
    if (!(dur > 0)) {
      const est = Number(track.full_duration_sec) || Number(track.duration_sec) || 0;
      if (Number.isFinite(est) && est > 0) {
        dur = est;
      }
    }

    if (!activeVoice && snap && Number.isFinite(snap.currentTime) && snap.currentTime >= 0) {
      pos = Number(snap.currentTime);
    }

    if (Number.isFinite(dur) && dur > 0) {
      const safePos = Math.max(0, Math.min(dur, Number.isFinite(pos) ? pos : 0));
      const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1.0;
      try {
        ms.setPositionState({
          duration: dur,
          playbackRate: safeRate,
          position: safePos,
        });
        lastPositionSyncMs = now;
      } catch (_) {}
    }
  }

  function syncMediaSession(opts = {}) {
    const ms = getMediaSession();
    if (!ms) return null;

    const ctxState = resolveCurrentTrackState();
    const { track, isPlaying } = ctxState;

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
    bindDeckAudioListeners();

    return {
      trackId: track.id,
      title,
      artist,
      album,
      playbackState: desiredState,
      artwork,
    };
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

  function handleActionPlay() {
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (!ma) return;
    if (typeof ma.isEnabled === "function" && !ma.isEnabled() && typeof ma.setEnabled === "function") {
      ma.setEnabled(true);
    }
    const av = typeof ma.activeVoice === "function" ? ma.activeVoice() : null;
    if (av && !av.disposed && av.htmlAudio) {
      markManualIntent(av.trackId);
      if (av.htmlAudio.paused) {
        if (typeof ma.resume === "function") {
          ma.resume();
        } else {
          av.htmlAudio.play().catch(() => {});
        }
      }
      syncMediaSession({ forcePosition: true });
      return;
    }
    const targetId = resolveFallbackPlayTrackId();
    if (!targetId) return;
    markManualIntent(targetId);
    if (typeof ma.toggleTrack === "function") {
      ma.toggleTrack(targetId, { isManual: true });
    } else if (typeof ma.playTrack === "function") {
      ma.playTrack(targetId, { isManual: true });
    }
    syncMediaSession({ forcePosition: true });
  }

  function handleActionPause() {
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (!ma) return;
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
    syncMediaSession({ forcePosition: true });
  }

  function handleActionPrevTrack() {
    markManualIntent();
    const player = typeof window !== "undefined" ? window.BTMM_PLAYER : null;
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (player && typeof player.prevSimilarTrack === "function") {
      player.prevSimilarTrack();
    } else if (ma && typeof ma.prevSimilarTrack === "function") {
      ma.prevSimilarTrack();
    }
    syncMediaSession({ forcePosition: true });
  }

  function handleActionNextTrack() {
    markManualIntent();
    const player = typeof window !== "undefined" ? window.BTMM_PLAYER : null;
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (player && typeof player.nextSimilarTrack === "function") {
      player.nextSimilarTrack();
    } else if (ma && typeof ma.nextSimilarTrack === "function") {
      ma.nextSimilarTrack();
    }
    syncMediaSession({ forcePosition: true });
  }

  function handleActionSeekTo(details) {
    if (!details || !Number.isFinite(details.seekTime)) return;
    const targetSec = Math.max(0, Number(details.seekTime));
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (!ma) return;
    const av = typeof ma.activeVoice === "function" ? ma.activeVoice() : null;

    if (details.fastSeek && av && !av.disposed && av.htmlAudio && typeof av.htmlAudio.fastSeek === "function") {
      try {
        av.htmlAudio.fastSeek(targetSec);
        if (window.BTMM_PLAYER && typeof window.BTMM_PLAYER.refreshWaveform === "function") {
          window.BTMM_PLAYER.refreshWaveform();
        }
        syncMediaSession({ forcePosition: true });
        return;
      } catch (_) {}
    }

    if (typeof ma.seek === "function") {
      ma.seek(targetSec);
    } else if (av && !av.disposed && av.htmlAudio) {
      try { av.htmlAudio.currentTime = targetSec; } catch (_) {}
    }
    if (typeof window !== "undefined" && window.BTMM_PLAYER && typeof window.BTMM_PLAYER.refreshWaveform === "function") {
      window.BTMM_PLAYER.refreshWaveform();
    }
    syncMediaSession({ forcePosition: true });
  }

  function safeSetActionHandler(ms, action, handler) {
    try {
      ms.setActionHandler(action, handler);
      return true;
    } catch (_) {
      return false;
    }
  }

  function registerActionHandlers() {
    const ms = getMediaSession();
    if (!ms || typeof ms.setActionHandler !== "function") return;

    safeSetActionHandler(ms, "play", handleActionPlay);
    safeSetActionHandler(ms, "pause", handleActionPause);
    safeSetActionHandler(ms, "previoustrack", handleActionPrevTrack);
    safeSetActionHandler(ms, "nexttrack", handleActionNextTrack);
    safeSetActionHandler(ms, "seekto", handleActionSeekTo);

    // Explicitly keep 'seekbackward' and 'seekforward' unset (null) so iOS Safari
    // Lock Screen, Control Center, CarPlay, and headphones render true ⏮ Previous &
    // ⏭ Next track buttons instead of replacing them with ±10s podcast skip buttons.
    safeSetActionHandler(ms, "seekbackward", null);
    safeSetActionHandler(ms, "seekforward", null);
  }

  function isActiveDeckElement(el) {
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (!ma || typeof ma.activeVoice !== "function") return false;
    const av = ma.activeVoice();
    return Boolean(av && !av.disposed && av.htmlAudio === el);
  }

  function bindDeckAudioListeners() {
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (!ma || typeof ma.getDecks !== "function") return;
    const decks = ma.getDecks();
    if (!Array.isArray(decks)) return;

    for (let i = 0; i < decks.length; i++) {
      const el = decks[i];
      if (!el || boundDecks.has(el)) continue;
      boundDecks.add(el);

      const onImmediateEvent = () => {
        if (!isActiveDeckElement(el)) return;
        syncMediaSession({ forcePosition: true });
      };

      const onPauseEvent = () => {
        // Ignore standby/outgoing crossfade deck pause events while another deck is active
        const curActive = ma.activeVoice ? ma.activeVoice() : null;
        if (curActive && !curActive.disposed && curActive.htmlAudio !== el) return;
        syncMediaSession({ forcePosition: true });
      };

      const onThrottledTimeUpdate = () => {
        if (!isActiveDeckElement(el)) return;
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

  function hookPlayerAndAudio() {
    const ma = typeof window !== "undefined" ? window.ME_AUDIO : null;
    if (ma && typeof ma.onStateChange === "function") {
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
        };
      },
    };
  }
})();
