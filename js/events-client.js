// Asynchronous Cloudflare Worker + D1 Event Client (Stars, Unstars, Qualified Plays, Track Downloads & Requests)
// Zero cookies, zero PII, optimistic non-blocking transport (keepalive fetch + sendBeacon fallback).
(function () {
  "use strict";

  const VISITOR_SEED_KEY = "btmm.visitor_seed";
  const STAR_STORAGE_KEY = "btmm.starred";
  const LEGACY_STAR_KEY = "me.starred";
  const STAR_DEBOUNCE_MS = 650;
  const DL_DEDUP_MS = 1500;
  const PLAY_SAMPLE_MS = 250;
  const MIN_PLAY_DELTA_FLUSH_SEC = 1.0;

  // Populated at deploy time once Cloudflare Worker URL is live; overridable via window.BTMM_EVENTS_API_URL
  const DEFAULT_API_BASE = "https://music-map-events.billtribble.workers.dev";

  const byId = new Map();
  const erasById = new Map();
  const byAudioUrl = new Map();
  const syncedStars = new Set();
  const pendingStarTimers = new Map();
  const pendingStarTargets = new Map();
  const recentDownloads = new Map();

  let sessionHashSync = "";
  let sessionHashPromise = null;
  let volatileSeed = "";

  // Qualified Play Session State (>= 10s real audible playback, or >= 50% for < 20s clips)
  let activePlaySession = null;
  let playTickTimer = null;
  let audioDeckBound = false;
  let lastTrackIntent = { trackId: null, source: "manual", atMs: 0 };

  function nowWallMs() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  function computeQualifyThresholdSec(trackDurationSec) {
    const dur = Number(trackDurationSec) || 0;
    if (dur > 0) {
      return Math.min(10.0, Math.max(3.0, 0.5 * dur));
    }
    return 10.0;
  }

  function getApiBase() {
    if (typeof window !== "undefined") {
      if (typeof window.BTMM_EVENTS_API_URL === "string") {
        return window.BTMM_EVENTS_API_URL.trim().replace(/\/+$/, "");
      }
      try {
        const u = new URL(window.location.href);
        const qp = u.searchParams.get("events_api");
        if (qp && /^https?:\/\//i.test(qp)) {
          return qp.trim().replace(/\/+$/, "");
        }
      } catch (_) {}
    }
    return DEFAULT_API_BASE.replace(/\/+$/, "");
  }

  function fnv1aHex(str, seedInit) {
    let h = seedInit >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  function fallbackHash24(input) {
    return (
      fnv1aHex(input, 0x811c9dc5) +
      fnv1aHex("a:" + input, 0x9e3779b9) +
      fnv1aHex("b:" + input, 0x85ebca6b)
    ).slice(0, 24);
  }

  function randomHex(byteLen) {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const buf = new Uint8Array(byteLen);
      crypto.getRandomValues(buf);
      let out = "";
      for (let i = 0; i < buf.length; i++) {
        out += buf[i].toString(16).padStart(2, "0");
      }
      return out;
    }
    let out = "";
    for (let i = 0; i < byteLen; i++) {
      out += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
    }
    return out;
  }

  function getOrCreateVisitorSeed() {
    if (volatileSeed) return volatileSeed;
    try {
      const existing = localStorage.getItem(VISITOR_SEED_KEY);
      if (existing && existing.length >= 16) {
        volatileSeed = existing;
        return existing;
      }
      const created = randomHex(16);
      localStorage.setItem(VISITOR_SEED_KEY, created);
      volatileSeed = created;
      return created;
    } catch (_) {
      volatileSeed = randomHex(16);
      return volatileSeed;
    }
  }

  function ensureSessionHash() {
    if (sessionHashPromise) return sessionHashPromise;
    const seed = getOrCreateVisitorSeed();
    const raw = `btmm-session-v1:${seed}`;
    sessionHashSync = fallbackHash24(raw);

    if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
      sessionHashPromise = crypto.subtle
        .digest("SHA-256", new TextEncoder().encode(raw))
        .then((buf) => {
          const bytes = new Uint8Array(buf);
          let hex = "";
          for (let i = 0; i < 12; i++) {
            hex += bytes[i].toString(16).padStart(2, "0");
          }
          sessionHashSync = hex;
          return hex;
        })
        .catch(() => sessionHashSync);
    } else {
      sessionHashPromise = Promise.resolve(sessionHashSync);
    }
    return sessionHashPromise;
  }

  function hydrateCatalogIndex() {
    const data = typeof window !== "undefined" ? window.CORPUS_DATA : null;
    if (!data) return;
    (data.eras || []).forEach((e) => {
      if (e && e.id) erasById.set(e.id, e);
    });
    (data.tracks || []).forEach((t) => {
      if (!t || !t.id) return;
      byId.set(t.id, t);
      [t.mp3_320_url, t.mp3_url, t.flac_url, t.stream_url, t.preview_url, t.file].forEach((u) => {
        if (typeof u === "string" && u) {
          byAudioUrl.set(u, t);
        }
      });
    });

    try {
      const rawStars = localStorage.getItem(STAR_STORAGE_KEY) || localStorage.getItem(LEGACY_STAR_KEY);
      if (rawStars) {
        const parsed = JSON.parse(rawStars);
        if (Array.isArray(parsed)) {
          parsed.forEach((id) => {
            if (typeof id === "string") syncedStars.add(id);
          });
        }
      }
    } catch (_) {}
  }

  function resolveTrack(trackOrId) {
    if (!trackOrId) return null;
    if (typeof trackOrId === "object" && trackOrId.id) return trackOrId;
    const id = String(trackOrId);
    return byId.get(id) || { id, title: id, era: "" };
  }

  function resolveEraLabel(track) {
    if (!track) return "";
    if (track.is_ai) return `Gen AI (${track.year || "2025"})`;
    const er = erasById.get(track.era);
    return (er && er.label) || track.era || "";
  }

  function inferDownloadFormat(track, explicitFormat, href) {
    if (explicitFormat) {
      const f = String(explicitFormat).toLowerCase();
      if (f.includes("flac")) return "flac";
      if (f.includes("320")) return "mp3_320";
      if (f.includes("mp3")) {
        const estKbps =
          Number(track && track.mp3_kbps) ||
          (track && track.mp3_320_bytes && track.full_duration_sec
            ? Math.round((track.mp3_320_bytes * 8) / 1000 / track.full_duration_sec)
            : 320);
        return estKbps < 280 ? "mp3" : "mp3_320";
      }
      return f;
    }
    const cleanHref = String(href || "").split("?")[0].toLowerCase();
    if (cleanHref.endsWith(".flac")) return "flac";
    if (cleanHref.endsWith(".wav")) return "wav";
    if (cleanHref.endsWith(".m4a")) return "m4a";
    if (cleanHref.endsWith(".mp3")) {
      const estKbps = Number(track && track.mp3_kbps) || 320;
      return estKbps < 280 ? "mp3" : "mp3_320";
    }
    return "audio";
  }

  async function postEventPayload(payload, useBeaconPrefer = false) {
    const base = getApiBase();
    if (!base) return null;
    const endpoint = `${base}/api/events`;
    const hash = sessionHashSync || (await ensureSessionHash());
    const bodyObj = {
      ...payload,
      session_hash: hash,
      referrer: (typeof document !== "undefined" && document.referrer) || "",
    };
    const jsonStr = JSON.stringify(bodyObj);

    if (useBeaconPrefer && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      try {
        const blob = new Blob([jsonStr], { type: "application/json" });
        if (navigator.sendBeacon(endpoint, blob)) {
          return { ok: true, beacon: true };
        }
      } catch (_) {}
    }

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: jsonStr,
      });
      if (!resp.ok) return null;
      return await resp.json().catch(() => null);
    } catch (_) {
      if (!useBeaconPrefer && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        try {
          const blob = new Blob([jsonStr], { type: "application/json" });
          navigator.sendBeacon(endpoint, blob);
        } catch (_bErr) {}
      }
      return null;
    }
  }

  function flushPendingStar(trackId, useBeacon = false) {
    const timer = pendingStarTimers.get(trackId);
    if (timer) {
      clearTimeout(timer);
      pendingStarTimers.delete(trackId);
    }
    if (!pendingStarTargets.has(trackId)) return null;
    const target = pendingStarTargets.get(trackId);
    pendingStarTargets.delete(trackId);

    const alreadyStarred = syncedStars.has(trackId);
    if (target.isStarred === alreadyStarred) {
      return null;
    }
    if (target.isStarred) syncedStars.add(trackId);
    else syncedStars.delete(trackId);

    return postEventPayload(
      {
        track_id: target.track.id,
        track_title: target.track.title || target.track.id,
        era: resolveEraLabel(target.track),
        event_type: target.isStarred ? "star" : "unstar",
        source: target.source || "player-star",
      },
      useBeacon
    );
  }

  function flushAllPendingStars(useBeacon = false) {
    Array.from(pendingStarTargets.keys()).forEach((tid) => {
      flushPendingStar(tid, useBeacon);
    });
  }

  function recordStarToggle(trackOrId, isStarred, opts = {}) {
    const track = resolveTrack(trackOrId);
    if (!track || !track.id) return;
    const tid = track.id;

    pendingStarTargets.set(tid, {
      track,
      isStarred: Boolean(isStarred),
      source: opts.source || "player-star",
    });

    const prevTimer = pendingStarTimers.get(tid);
    if (prevTimer) clearTimeout(prevTimer);

    if (opts.immediate) {
      return flushPendingStar(tid, false);
    }

    const nextTimer = setTimeout(() => {
      flushPendingStar(tid, false);
    }, STAR_DEBOUNCE_MS);
    pendingStarTimers.set(tid, nextTimer);
  }

  function recordDownload(trackOrId, explicitFormat = "", source = "player-cta", href = "") {
    const track = resolveTrack(trackOrId);
    if (!track || !track.id) return null;
    const fmt = inferDownloadFormat(track, explicitFormat, href);
    const dedupKey = `${track.id}:${fmt}`;
    const now = Date.now();
    const prevTs = recentDownloads.get(dedupKey) || 0;
    if (now - prevTs < DL_DEDUP_MS) {
      return null;
    }
    recentDownloads.set(dedupKey, now);

    return postEventPayload({
      track_id: track.id,
      track_title: track.title || track.id,
      era: resolveEraLabel(track),
      event_type: "download",
      format: fmt,
      source: source || "player-cta",
    });
  }

  async function recordRequest(trackOrId, opts = {}) {
    const track = resolveTrack(trackOrId);
    if (!track || !track.id) {
      return { ok: false, status: 400, error: "Unknown track." };
    }
    const base = getApiBase();
    if (!base) {
      return { ok: false, status: 0, error: "Request service is currently unavailable." };
    }
    const requesterEmail = String(opts.email || opts.requester_email || "").trim();
    const note = String(opts.note || "").trim().slice(0, 500);
    const hash = sessionHashSync || (await ensureSessionHash());
    const endpoint = `${base}/api/events`;
    const bodyObj = {
      track_id: track.id,
      track_title: track.title || track.id,
      era: resolveEraLabel(track),
      event_type: "request",
      source: opts.source || "player-request",
      requester_email: requesterEmail,
      note,
      session_hash: hash,
      referrer: (typeof document !== "undefined" && document.referrer) || "",
    };

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || (data && data.ok === false)) {
        return {
          ok: false,
          status: resp.status,
          error: (data && data.error) || "Could not send request right now. Please try again.",
        };
      }
      return { ok: true, status: resp.status, data };
    } catch (_) {
      return {
        ok: false,
        status: 0,
        error: "Network error — please check your connection and try again.",
      };
    }
  }

  function handleDelegatedAnchorDownload(ev) {
    if (ev.type === "auxclick" && ev.button !== 1) return;
    if (!ev.target || typeof ev.target.closest !== "function") return;
    const anchor = ev.target.closest("a[href]");
    if (!anchor) return;

    const dlKind = anchor.getAttribute("data-dl-kind") || "";
    const href = anchor.getAttribute("href") || "";
    const hasDownloadAttr = anchor.hasAttribute("download");
    const isAudioAssetHref = /\.(mp3|flac|wav|m4a|ogg)(\?|$)/i.test(href);

    if (!dlKind && !hasDownloadAttr && !isAudioAssetHref) return;

    // Resolve track from URL index or currently selected player track
    let track = byAudioUrl.get(href) || null;
    if (!track && typeof window !== "undefined" && window.BTMM_PLAYER && typeof window.BTMM_PLAYER.selected === "function") {
      const selId = window.BTMM_PLAYER.selected();
      if (selId) track = resolveTrack(selId);
    }
    if (!track) return;

    const source = dlKind ? "player-cta" : "direct-media-link";
    recordDownload(track, dlKind, source, href);
  }

  function stopPlayTickTimer() {
    if (playTickTimer !== null) {
      clearInterval(playTickTimer);
      playTickTimer = null;
    }
  }

  function ensurePlayTickTimer() {
    if (playTickTimer !== null) return;
    playTickTimer = setInterval(sampleActivePlayback, PLAY_SAMPLE_MS);
  }

  function createPlaySession(track, source) {
    return {
      playId: `pl_${randomHex(8)}`,
      trackId: track.id,
      track,
      source: source === "autoplay" ? "autoplay" : "manual",
      startedWallMs: nowWallMs(),
      audibleSec: 0,
      reportedSec: 0,
      qualified: false,
      lastSampleWallMs: 0,
      lastMediaTime: null,
      wasPlaying: false,
    };
  }

  function flushPlaySessionProgress(session, useBeacon = false) {
    if (!session || !session.qualified || !session.track || !session.track.id) return null;
    const totalSec = Math.round(session.audibleSec * 100) / 100;
    if (totalSec - session.reportedSec < MIN_PLAY_DELTA_FLUSH_SEC) return null;
    session.reportedSec = totalSec;
    return postEventPayload(
      {
        track_id: session.track.id,
        track_title: session.track.title || session.track.id,
        era: resolveEraLabel(session.track),
        event_type: "play_end",
        source: session.source,
        play_id: session.playId,
        listened_sec: totalSec,
      },
      useBeacon
    );
  }

  function finalizePlaySession(useBeacon = false) {
    if (!activePlaySession) {
      stopPlayTickTimer();
      return null;
    }
    const outgoing = activePlaySession;
    activePlaySession = null;
    stopPlayTickTimer();
    return flushPlaySessionProgress(outgoing, useBeacon);
  }

  function sampleActivePlayback() {
    if (typeof window === "undefined" || !window.ME_AUDIO) return;
    const ma = window.ME_AUDIO;
    const voice = typeof ma.activeVoice === "function" ? ma.activeVoice() : null;
    if (!voice || voice.disposed || !voice.htmlAudio || !voice.trackId) {
      if (activePlaySession) {
        activePlaySession.wasPlaying = false;
        activePlaySession.lastSampleWallMs = 0;
        activePlaySession.lastMediaTime = null;
      }
      stopPlayTickTimer();
      return;
    }

    const tid = voice.trackId;
    if (!activePlaySession || activePlaySession.trackId !== tid) {
      if (activePlaySession) {
        finalizePlaySession(false);
      }
      const tr = resolveTrack(voice.track || tid);
      if (!tr || !tr.id) return;
      const inferredSource =
        lastTrackIntent.trackId === tid && nowWallMs() - lastTrackIntent.atMs < 3000
          ? lastTrackIntent.source
          : "manual";
      activePlaySession = createPlaySession(tr, inferredSource);
    }
    ensurePlayTickTimer();

    const el = voice.htmlAudio;
    const audioEnabled = typeof ma.isEnabled === "function" ? Boolean(ma.isEnabled()) : true;
    const masterVol = typeof ma.getVolume === "function" ? Number(ma.getVolume()) : 1;
    const isAudible = Boolean(
      !el.paused &&
      !el.ended &&
      !el.muted &&
      el.readyState >= 2 &&
      audioEnabled &&
      masterVol > 0.001
    );

    const now = nowWallMs();
    const curMediaTime = Number(el.currentTime) || 0;

    if (isAudible) {
      if (
        activePlaySession.wasPlaying &&
        activePlaySession.lastSampleWallMs > 0 &&
        activePlaySession.lastMediaTime !== null
      ) {
        const wallDt = Math.max(0, (now - activePlaySession.lastSampleWallMs) / 1000);
        const mediaDt = curMediaTime - activePlaySession.lastMediaTime;
        if (wallDt > 0 && wallDt <= 4.0) {
          if (mediaDt > 0 && mediaDt <= wallDt * 1.45 + 0.25) {
            activePlaySession.audibleSec += Math.min(wallDt, mediaDt);
          } else if (mediaDt < 0 && wallDt <= 1.25) {
            // Seamless snippet loop wraparound while continuously playing
            activePlaySession.audibleSec += Math.min(wallDt, 0.35);
          }
        }
      }
      activePlaySession.wasPlaying = true;
      activePlaySession.lastSampleWallMs = now;
      activePlaySession.lastMediaTime = curMediaTime;

      const mediaDur =
        (Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0) ||
        Number(activePlaySession.track.full_duration_sec) ||
        Number(activePlaySession.track.duration_sec) ||
        0;
      const thresholdSec = computeQualifyThresholdSec(mediaDur);

      if (!activePlaySession.qualified && activePlaySession.audibleSec >= thresholdSec) {
        activePlaySession.qualified = true;
        const qualifiedListenSec = Math.round(activePlaySession.audibleSec * 100) / 100;
        activePlaySession.reportedSec = qualifiedListenSec;
        postEventPayload(
          {
            track_id: activePlaySession.track.id,
            track_title: activePlaySession.track.title || activePlaySession.track.id,
            era: resolveEraLabel(activePlaySession.track),
            event_type: "play",
            source: activePlaySession.source,
            play_id: activePlaySession.playId,
            listened_sec: qualifiedListenSec,
          },
          false
        );
      }
    } else {
      activePlaySession.wasPlaying = false;
      activePlaySession.lastSampleWallMs = now;
      activePlaySession.lastMediaTime = curMediaTime;
    }
  }

  function beginTrackPlaySession(trackOrId, source) {
    const track = resolveTrack(trackOrId);
    if (!track || !track.id) return;
    const normSource = source === "autoplay" ? "autoplay" : "manual";

    sampleActivePlayback();

    if (activePlaySession && activePlaySession.trackId === track.id) {
      // Same track resumed from pause: preserve accumulated audible time in the same play_id
      activePlaySession.wasPlaying = false;
      activePlaySession.lastSampleWallMs = 0;
      activePlaySession.lastMediaTime = null;
      if (!activePlaySession.qualified && nowWallMs() - activePlaySession.startedWallMs < 2500) {
        activePlaySession.source = normSource;
      }
      ensurePlayTickTimer();
      return;
    }

    if (activePlaySession) {
      finalizePlaySession(false);
    }

    activePlaySession = createPlaySession(track, normSource);
    ensurePlayTickTimer();
  }

  function ensureAudioDeckBound() {
    if (audioDeckBound || typeof window === "undefined" || !window.ME_AUDIO) return;
    const ma = window.ME_AUDIO;
    audioDeckBound = true;

    if (typeof ma.playTrack === "function" && !ma.playTrack.__btmmWrapped) {
      const origPlayTrack = ma.playTrack;
      const wrappedPlayTrack = function (trackOrId, opts = {}) {
        const isAuto = Boolean(
          opts && (opts.fromAutoPlay || (typeof opts.stopIdx === "number" && opts.stopIdx >= 0 && !opts.isManual))
        );
        const source = isAuto ? "autoplay" : "manual";
        lastTrackIntent = {
          trackId: typeof trackOrId === "object" && trackOrId ? trackOrId.id : String(trackOrId || ""),
          source,
          atMs: nowWallMs(),
        };
        beginTrackPlaySession(trackOrId, source);
        const res = origPlayTrack.call(ma, trackOrId, opts);
        ensurePlayTickTimer();
        return res;
      };
      wrappedPlayTrack.__btmmWrapped = true;
      ma.playTrack = wrappedPlayTrack;
    }

    if (typeof ma.stop === "function" && !ma.stop.__btmmWrapped) {
      const origStop = ma.stop;
      const wrappedStop = function () {
        sampleActivePlayback();
        finalizePlaySession(false);
        return origStop.apply(ma, arguments);
      };
      wrappedStop.__btmmWrapped = true;
      ma.stop = wrappedStop;
    }

    if (typeof ma.onStateChange === "function") {
      ma.onStateChange(() => {
        sampleActivePlayback();
        if (typeof ma.playing === "function" && ma.playing()) {
          ensurePlayTickTimer();
        }
      });
    }
  }

  function notifyTrackIntent(trackOrId, opts = {}) {
    ensureAudioDeckBound();
    if (!trackOrId) {
      sampleActivePlayback();
      finalizePlaySession(false);
      return;
    }
    const track = resolveTrack(trackOrId);
    if (!track || !track.id) return;
    const source = opts && opts.source === "autoplay" ? "autoplay" : "manual";
    lastTrackIntent = { trackId: track.id, source, atMs: nowWallMs() };
    if (
      activePlaySession &&
      activePlaySession.trackId === track.id &&
      !activePlaySession.qualified &&
      nowWallMs() - activePlaySession.startedWallMs < 5000
    ) {
      activePlaySession.source = source;
    }
    if (typeof window !== "undefined" && window.ME_AUDIO && typeof window.ME_AUDIO.playing === "function" && window.ME_AUDIO.playing()) {
      ensurePlayTickTimer();
    }
  }

  async function fetchPopular(opts = {}) {
    const base = getApiBase();
    if (!base) return null;
    const range = encodeURIComponent(String(opts.range || "all"));
    const limit = encodeURIComponent(String(opts.limit || 200));
    const fresh = opts.fresh ? "&fresh=1" : "";
    try {
      const resp = await fetch(`${base}/api/popular?range=${range}&limit=${limit}${fresh}`, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
      });
      if (!resp.ok) return null;
      return await resp.json().catch(() => null);
    } catch (_) {
      return null;
    }
  }

  function init() {
    hydrateCatalogIndex();
    ensureSessionHash();
    ensureAudioDeckBound();

    if (typeof document !== "undefined") {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
          hydrateCatalogIndex();
          ensureAudioDeckBound();
        });
      } else {
        setTimeout(() => {
          hydrateCatalogIndex();
          ensureAudioDeckBound();
        }, 0);
      }
      document.addEventListener("click", handleDelegatedAnchorDownload, true);
      document.addEventListener("auxclick", handleDelegatedAnchorDownload, true);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          flushAllPendingStars(true);
          sampleActivePlayback();
          if (activePlaySession) {
            flushPlaySessionProgress(activePlaySession, true);
          }
        }
      });
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => {
        flushAllPendingStars(true);
        sampleActivePlayback();
        finalizePlaySession(true);
      });
    }
  }

  init();

  if (typeof window !== "undefined") {
    window.BTMM_EVENTS = {
      getApiBase,
      recordStarToggle,
      recordDownload,
      recordRequest,
      notifyTrackIntent,
      fetchPopular,
      flushAllPendingStars,
      flushActivePlay: (useBeacon = false) => {
        sampleActivePlayback();
        return finalizePlaySession(Boolean(useBeacon));
      },
      getPlaySessionState: () => {
        sampleActivePlayback();
        if (!activePlaySession) return null;
        return {
          playId: activePlaySession.playId,
          trackId: activePlaySession.trackId,
          source: activePlaySession.source,
          audibleSec: Math.round(activePlaySession.audibleSec * 100) / 100,
          reportedSec: activePlaySession.reportedSec,
          qualified: activePlaySession.qualified,
        };
      },
      computeQualifyThresholdSec,
      getSessionHash: () => ensureSessionHash(),
    };
  }
})();
