// Persistent Collapsible Floating Track Player Card (Starred, Badges, Tier A/B/C CTAs & Private Analytics)
(function () {
  "use strict";

  const STAR_KEY = "btmm.starred";
  const COLLAPSE_KEY = "btmm.playerCollapsed";
  const LEGACY_STAR_KEY = "me.starred";
  const PRE_2015_ERAS = new Set(["present_ambient", "present_electro", "hd_2005", "bands_archive"]);
  // Public opaque Web3Forms UUID (zero email address in client bundle; paste key from web3forms.com)
  let web3FormsKey = "";
  const WEB3FORMS_URL = "https://api.web3forms.com/submit";
  const INSTAGRAM_URL = "https://www.instagram.com/bill_tribble/";

  // Official inline brand SVG paths (zero external icon CDNs)
  const BRAND_SVGS = {
    bandcamp: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><polygon points="0,18.75 7.44,5.25 24,5.25 16.56,18.75" fill="currentColor"/></svg>',
    spotify: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1.5C6.2 1.5 1.5 6.2 1.5 12S6.2 22.5 12 22.5 22.5 17.8 22.5 12 17.8 1.5 12 1.5zm4.82 15.14a.75.75 0 0 1-1.03.25c-2.82-1.72-6.37-2.11-10.55-1.16a.75.75 0 0 1-.33-1.46c4.57-1.05 8.49-.6 11.66 1.34.36.22.47.69.25 1.03zm1.47-3.27a.94.94 0 0 1-1.29.31c-3.23-1.98-8.15-2.56-11.97-1.4a.94.94 0 1 1-.55-1.8c4.36-1.32 9.78-.68 13.5 1.6.44.27.58.85.31 1.29zm.13-3.41c-3.87-2.3-10.26-2.51-13.96-1.39a1.12 1.12 0 1 1-.65-2.15c4.25-1.29 11.31-1.04 15.76 1.6a1.12 1.12 0 0 1-1.15 1.94z"/></svg>',
    youtube_music: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 16.25a6.25 6.25 0 1 1 0-12.5 6.25 6.25 0 0 1 0 12.5zm0-11a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 0 0 0-9.5zM10.2 14.8V9.2l4.85 2.8-4.85 2.8z"/></svg>',
    apple_music: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.6 3.2c.4 0 .7.3.7.7v11.6a3.4 3.4 0 1 1-1.6-2.9V8.5l-7.8 1.6v7a3.4 3.4 0 1 1-1.6-2.9V6.8c0-.5.3-.9.8-1l9.1-2.5c.1 0 .3-.1.4-.1z"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.58 7.19a2.75 2.75 0 0 0-1.94-1.95C17.93 4.78 12 4.78 12 4.78s-5.93 0-7.64.46A2.75 2.75 0 0 0 2.42 7.2 28.7 28.7 0 0 0 1.96 12c0 1.63.16 3.25.46 4.81a2.75 2.75 0 0 0 1.94 1.95c1.71.46 7.64.46 7.64.46s5.93 0 7.64-.46a2.75 2.75 0 0 0 1.94-1.95c.3-1.56.46-3.18.46-4.81 0-1.63-.16-3.25-.46-4.81zM10 15V9l5.2 3L10 15z"/></svg>',
  };

  let byId = new Map();
  let erasById = new Map();
  let hooks = null;
  let cardEl = null;

  let selectedId = null;
  let collapsed = false;
  let starred = new Set();
  const requestedIds = new Set();
  let formOpenForId = null;
  let sendingId = null;
  let reqError = "";
  let draftEmail = "";
  let draftNote = "";

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function loadPrefs() {
    try {
      const rawStars = localStorage.getItem(STAR_KEY) || localStorage.getItem(LEGACY_STAR_KEY);
      if (rawStars) {
        const arr = JSON.parse(rawStars);
        if (Array.isArray(arr)) starred = new Set(arr.filter((x) => typeof x === "string"));
      }
      collapsed = localStorage.getItem(COLLAPSE_KEY) === "true";
    } catch (_) {}
  }

  function saveStars() {
    try { localStorage.setItem(STAR_KEY, JSON.stringify([...starred])); } catch (_) {}
  }

  function saveCollapsed() {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "true" : "false"); } catch (_) {}
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
    if (!t) return false;
    if (typeof t.is_sketch === "boolean") return t.is_sketch;
    const dur = Number(t.full_duration_sec || 0);
    if (dur > 0 && dur < 120) return true;
    if (/sketch/i.test(t.era || "")) return true;
    return /\b(sketch|ruff|idea|test|demo|loop)\b/i.test(t.title || "");
  }

  function resolveTier(t) {
    if (isReleased(t)) return "A";
    if (t.tier === "archive_dl" || (typeof t.year === "number" && t.year < 2015) || PRE_2015_ERAS.has(t.era)) {
      return "B";
    }
    return "C";
  }

  function formatDur(sec) {
    if (!sec || !Number.isFinite(sec)) return "";
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
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

  function buildTierActionsHtml(t, eraLabel) {
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
      const mp3Url = t.mp3_320_url || t.download_url || "";
      const flacUrl = t.flac_url || "";
      const safeFilename = `Bill Tribble - ${(t.title || t.id).replace(/[\\/:*?"<>|]/g, "")}.mp3`;
      const durTxt = formatDur(t.full_duration_sec);
      const sizeTxt = t.mp3_size_mb ? `${Number(t.mp3_size_mb).toFixed(1)} MB` : "";
      const subParts = ["Free 320 kbps MP3", durTxt, sizeTxt].filter(Boolean);

      if (!mp3Url && !flacUrl) {
        return `
          <div class="player-actions">
            <div class="action-sub">Full 320 kbps MP3 &amp; FLAC queued for archive upload (${esc(eraLabel)}).</div>
          </div>`;
      }
      return `
        <div class="player-actions">
          <div class="player-cta-row">
            ${mp3Url ? `<a class="btn" href="${esc(mp3Url)}" download="${esc(safeFilename)}" target="_blank" rel="noopener noreferrer" data-dl-kind="track-download-mp3"><span class="ms">download</span><span>Download MP3 (320 kbps)</span></a>` : ""}
            ${flacUrl ? `<a class="btn-secondary-pill" href="${esc(flacUrl)}" target="_blank" rel="noopener noreferrer" data-dl-kind="track-download-flac" title="Download lossless FLAC"><span class="ms">album</span><span>FLAC</span></a>` : ""}
          </div>
          <div class="action-sub">${esc(subParts.join(" · "))}</div>
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
        <div class="request-helper">
          <span>${sent ? (hasRelay ? "Bill has your track request." : "Request logged for Bill.") : "Spam-protected track request"}</span>
          ${!hasRelay ? `<a class="ig-dm-link" href="${INSTAGRAM_URL}" target="_blank" rel="noopener noreferrer"><span class="ms" style="font-size:13px">open_in_new</span><span>Instagram</span></a>` : ""}
        </div>
      </div>`;
  }

  function render() {
    if (!cardEl || !hooks) return;
    if (!selectedId || !byId.has(selectedId)) {
      cardEl.hidden = true;
      return;
    }
    const t = byId.get(selectedId);
    const er = erasById.get(t.era);
    const eraLabel = er ? `${er.label} (${er.sublabel})` : t.era;
    const isPlaying = hooks.playing() === t.id;
    const isPend = hooks.pending() === t.id;
    const isStar = starred.has(t.id);

    if (
      !collapsed &&
      formOpenForId === t.id &&
      typeof document !== "undefined" &&
      cardEl.contains(document.activeElement) &&
      (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA")
    ) {
      const playBtn = cardEl.querySelector("[data-player-play]");
      if (playBtn) {
        playBtn.classList.toggle("is-playing", isPlaying);
        const ic = playBtn.querySelector(".ms");
        if (ic) ic.textContent = isPlaying ? "stop" : isPend ? "hourglass_top" : "play_arrow";
      }
      return;
    }

    cardEl.hidden = false;
    cardEl.classList.toggle("is-collapsed", collapsed);

    if (collapsed) {
      cardEl.innerHTML = `
        <div class="mp-mini-row">
          <button type="button" class="btn-tonal mp-play ${isPlaying ? "is-playing" : ""}" data-player-play="${esc(t.id)}" aria-label="${isPlaying ? "Stop" : "Play"}" title="${isPlaying ? "Stop (Space)" : "Play preview (Space)"}">
            <span class="ms filled">${isPlaying ? "stop" : isPend ? "hourglass_top" : "play_arrow"}</span>
          </button>
          <div class="mp-mini-title" title="${esc(t.title)}">${esc(t.title)}</div>
          <button type="button" class="star-btn ${isStar ? "is-starred" : ""}" data-player-star="${esc(t.id)}" aria-pressed="${isStar}" aria-label="${isStar ? "Unstar track" : "Star track"}" title="${isStar ? "Remove star" : "Star track"}">
            <span class="ms">star</span>
          </button>
          <button type="button" class="icon-btn" id="mp-expand" aria-label="Expand player" title="Expand player">
            <span class="ms">expand_less</span>
          </button>
        </div>`;
      return;
    }

    const released = isReleased(t);
    const sketch = isSketch(t);
    const clusterName = t.cluster_label || "Unclassified";

    cardEl.innerHTML = `
      <div class="mp-head">
        <button type="button" class="btn-tonal mp-play ${isPlaying ? "is-playing" : ""}" data-player-play="${esc(t.id)}" aria-label="${isPlaying ? "Stop" : "Play"}" title="${isPlaying ? "Stop (Space)" : "Play preview (Space)"}">
          <span class="ms filled">${isPlaying ? "stop" : isPend ? "hourglass_top" : "play_arrow"}</span>
        </button>
        <div class="mp-titles">
          <div class="mp-name" title="${esc(t.title)}">${esc(t.title)}</div>
          <div class="mp-meta">${esc(eraLabel)} · ${esc(clusterName)}</div>
        </div>
        <div class="mp-head-actions">
          <button type="button" class="star-btn ${isStar ? "is-starred" : ""}" data-player-star="${esc(t.id)}" aria-pressed="${isStar}" aria-label="${isStar ? "Unstar track" : "Star track"}" title="${isStar ? "Remove star" : "Star track"}">
            <span class="ms">star</span>
          </button>
          <button type="button" class="icon-btn" id="mp-collapse" aria-label="Collapse player" title="Collapse to mini bar">
            <span class="ms">expand_more</span>
          </button>
          <button type="button" class="icon-btn" id="mp-close" aria-label="Close player" title="Close">
            <span class="ms">close</span>
          </button>
        </div>
      </div>
      <div class="mp-badges">
        <span class="badge ${energyBadgeCls(t.energy)}" title="Mixed In Key energy level (1–10)">E${t.energy}/10</span>
        <span class="badge badge-indigo">${esc(t.key_label)}</span>
        <span class="badge badge-blue mono-num">${Math.round(t.bpm)} BPM</span>
        ${sketch ? '<span class="badge badge-amber">Sketch</span>' : ""}
        ${!released ? '<span class="badge badge-purple">Unreleased</span>' : ""}
      </div>
      <div class="mp-meters">
        ${meterHtml("Harmonic complexity", t.harmonic_complexity, "var(--c5)")}
        ${meterHtml("Chord richness", t.chord_richness, "var(--c1)")}
        ${meterHtml("Harmonic motion", t.harmonic_motion, "var(--c2)")}
        ${meterHtml("Drum complexity", t.drum_complexity, "var(--c3)")}
      </div>
      ${buildTierActionsHtml(t, er ? er.label : t.era)}`;
  }

  function handleRequestTrack(t) {
    if (!t) return;
    logPrivateTrackEvent("track-request", t);
    const hasRelay = Boolean((web3FormsKey || "").trim());
    if (!hasRelay) {
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
          key_tempo: `${t.key_label || "—"} · ${Math.round(t.bpm || 0)} BPM`,
          message: note || `Requesting "${t.title}" (${eraLabel}).`,
          botcheck: "",
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || json.success === false) {
        throw new Error(json.message || "Could not send request right now.");
      }
      requestedIds.add(t.id);
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
    cardEl.addEventListener("click", (ev) => {
      if (ev.target.closest("#mp-close")) {
        selectedId = null;
        formOpenForId = null;
        render();
        if (hooks && hooks.onSelectionChange) hooks.onSelectionChange(null);
        return;
      }
      if (ev.target.closest("#mp-collapse")) {
        collapsed = true;
        saveCollapsed();
        render();
        return;
      }
      if (ev.target.closest("#mp-expand")) {
        collapsed = false;
        saveCollapsed();
        render();
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
        logPrivateTrackEvent(dlLink.getAttribute("data-dl-kind"), byId.get(selectedId));
      }
    });
  }

  function toggleStar(tid) {
    if (!tid) return;
    if (starred.has(tid)) starred.delete(tid);
    else starred.add(tid);
    saveStars();
    render();
    if (hooks && hooks.onStarChange) hooks.onStarChange(starred);
  }

  function select(tid, opts = {}) {
    if (!tid || !byId.has(tid)) {
      selectedId = null;
      formOpenForId = null;
      render();
      if (!opts.silent && hooks && hooks.onSelectionChange) hooks.onSelectionChange(null);
      return;
    }
    if (selectedId !== tid) {
      formOpenForId = null;
      reqError = "";
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
    setCollapsed(v) { collapsed = Boolean(v); saveCollapsed(); render(); },
    setWeb3FormsKey(k) { web3FormsKey = String(k || ""); render(); },
    logPrivateTrackEvent,
  };
})();
