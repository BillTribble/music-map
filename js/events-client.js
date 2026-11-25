// Asynchronous Cloudflare Worker + D1 Event Client (Stars, Unstars, Track Downloads & Requests)
// Zero cookies, zero PII, optimistic non-blocking transport (keepalive fetch + sendBeacon fallback).
(function () {
  "use strict";

  const VISITOR_SEED_KEY = "btmm.visitor_seed";
  const STAR_STORAGE_KEY = "btmm.starred";
  const LEGACY_STAR_KEY = "me.starred";
  const STAR_DEBOUNCE_MS = 650;
  const DL_DEDUP_MS = 1500;

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

  function recordRequest(trackOrId, opts = {}) {
    const track = resolveTrack(trackOrId);
    if (!track || !track.id) return null;
    const parts = [];
    if (opts.email) parts.push(`Reply: ${opts.email}`);
    if (opts.note) parts.push(opts.note);
    return postEventPayload({
      track_id: track.id,
      track_title: track.title || track.id,
      era: resolveEraLabel(track),
      event_type: "request",
      source: opts.source || "player-request",
      note: parts.join(" — ").slice(0, 340),
    });
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

  function init() {
    hydrateCatalogIndex();
    ensureSessionHash();

    if (typeof document !== "undefined") {
      document.addEventListener("click", handleDelegatedAnchorDownload, true);
      document.addEventListener("auxclick", handleDelegatedAnchorDownload, true);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          flushAllPendingStars(true);
        }
      });
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => {
        flushAllPendingStars(true);
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
      flushAllPendingStars,
      getSessionHash: () => ensureSessionHash(),
    };
  }
})();
