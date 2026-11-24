// WebAudio loop deck (bar-quantized switching + CORS-safe HTML5 <audio> fallback + JI bell synth)
(function () {
  "use strict";

  let ctx = null;
  let masterGain = null;
  let enabled = true;
  let volume = 0.85;
  let byId = new Map();

  const bufferCache = new Map();
  const decodedCache = new Map();
  const corsBlockedUrls = new Set();

  let active = null; // { trackId, track, src, htmlAudio, gain, barOriginCtxTime, slotStartCtxTime, beatDurSec, barDurSec, stopIdx, eraId, scheduled, isHtmlFallback, startWallMs }
  let pending = null;
  let generation = 0;
  let beatTimer = null;
  let onStateChangeCb = () => {};
  let onBeatCb = () => {};

  function trackAudioUrl(t) {
    if (!t) return "";
    return t.preview_url || t.file || "";
  }

  function setTrackIndex(tracks) {
    byId = new Map((tracks || []).map((t) => [t.id, t]));
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

  function syncMasterGain() {
    const v = enabled ? Math.max(0, Math.min(1, volume)) : 0;
    if (masterGain && ctx) {
      if (typeof masterGain.gain.setTargetAtTime === "function") {
        masterGain.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
      } else {
        masterGain.gain.value = v;
      }
    }
    if (active && active.htmlAudio) {
      active.htmlAudio.volume = v;
      active.htmlAudio.muted = !enabled;
    }
  }

  function isNoCorsReleaseUrl(url) {
    return /^https?:\/\/(?:github\.com\/[^/]+\/[^/]+\/releases\/download\/|release-assets\.githubusercontent\.com\/)/i.test(url || "");
  }

  function loadBuffer(track) {
    const url = trackAudioUrl(track);
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

  function prefetchTracks(trackList) {
    (trackList || []).forEach((tr) => {
      const url = trackAudioUrl(tr);
      if (url && !corsBlockedUrls.has(url) && !decodedCache.has(url) && !bufferCache.has(url)) {
        loadBuffer(tr);
      }
    });
  }

  function safeStop(voice, when) {
    if (!voice) return;
    if (voice.src) {
      try { voice.src.stop(when || 0); } catch (_) {}
    }
    if (voice.htmlAudio) {
      try {
        voice.htmlAudio.pause();
        voice.htmlAudio.removeAttribute("src");
        voice.htmlAudio.load();
      } catch (_) {}
    }
  }

  function getNextBarBoundary(ctxNow) {
    if (!active) return ctxNow + 0.02;
    const barDur = Math.max(0.25, active.barDurSec || 2.0);
    const elapsedBars = Math.floor(Math.max(0, ctxNow - active.barOriginCtxTime) / barDur);
    let nextBar = active.barOriginCtxTime + (elapsedBars + 1) * barDur;
    if (nextBar - ctxNow < 0.035) nextBar += barDur;
    return nextBar;
  }

  function scheduleVoice(track, buf, switchCtxTime, meta = {}) {
    if (!ctx || !buf || !enabled) return false;
    if (active && active.htmlAudio) {
      safeStop(active, 0);
      active = null;
    }
    const beatDurSec = track.beat_sec || (60 / (track.bpm || 120));
    const barDurSec = track.bar_sec || beatDurSec * 4;
    const bufDur = buf.duration || track.duration_sec || 16;
    const cue = Math.min(Math.max(0, track.cue_sec || 0), Math.max(0, bufDur - 1.5));

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const wholeBars = Math.floor((bufDur - cue + 0.04) / barDurSec);
    if (wholeBars >= 2) {
      src.loopStart = cue;
      src.loopEnd = Math.min(bufDur, cue + wholeBars * barDurSec);
    } else if (bufDur > cue + 1.2) {
      src.loopStart = cue;
      src.loopEnd = Math.max(cue + 1.0, bufDur - 0.02);
    }

    const gain = ctx.createGain();
    const targetGain = track.gain_trim || 1.0;
    const tPre = Math.max(ctx.currentTime, switchCtxTime - 0.004);
    if (typeof gain.gain.setValueAtTime === "function" && typeof gain.gain.linearRampToValueAtTime === "function") {
      gain.gain.setValueAtTime(0.0001, tPre);
      gain.gain.setValueAtTime(0.0001, switchCtxTime);
      gain.gain.linearRampToValueAtTime(targetGain, switchCtxTime + 0.028);
    } else {
      gain.gain.value = targetGain;
    }
    src.connect(gain);
    gain.connect(masterGain || ctx.destination);
    src.start(switchCtxTime, cue);

    if (active && active.gain) {
      const aGain = active.gain.gain;
      const curA = active.track ? (active.track.gain_trim || 1.0) : 1.0;
      if (typeof aGain.setValueAtTime === "function" && typeof aGain.linearRampToValueAtTime === "function") {
        aGain.setValueAtTime(curA, Math.max(ctx.currentTime, switchCtxTime - 0.004));
        aGain.linearRampToValueAtTime(0.0001, switchCtxTime + 0.028);
      }
      safeStop(active, switchCtxTime + 0.04);
    }

    pending = {
      trackId: track.id,
      track,
      src,
      htmlAudio: null,
      gain,
      switchCtxTime,
      beatDurSec,
      barDurSec,
      stopIdx: meta.stopIdx ?? -1,
      eraId: meta.eraId ?? track.era,
      eraLabel: meta.eraLabel ?? "",
      scheduled: true,
      isManual: Boolean(meta.isManual),
    };
    return true;
  }

  function playHtmlFallback(track, opts = {}, gen) {
    const url = trackAudioUrl(track);
    if (!url || typeof Audio === "undefined") {
      if (pending && pending.trackId === track.id) {
        pending = null;
        onStateChangeCb(active, null);
      }
      return;
    }
    if (active) safeStop(active, 0);
    const el = new Audio(url);
    el.loop = true;
    el.preload = "auto";
    el.volume = enabled ? Math.max(0, Math.min(1, volume)) : 0;
    el.muted = !enabled;

    const beatDurSec = track.beat_sec || (60 / (track.bpm || 120));
    const barDurSec = track.bar_sec || beatDurSec * 4;
    const ctxNow = ctx ? ctx.currentTime : 0;

    pending = null;
    active = {
      trackId: track.id,
      track,
      src: null,
      htmlAudio: el,
      gain: null,
      barOriginCtxTime: ctxNow,
      slotStartCtxTime: ctxNow,
      startWallMs: performance.now(),
      beatDurSec,
      barDurSec,
      stopIdx: opts.stopIdx ?? -1,
      eraId: opts.eraId ?? track.era,
      scheduled: true,
      isHtmlFallback: true,
    };
    onStateChangeCb(active, null);
    startBeatLoop();

    el.play().catch(() => {
      if (generation === gen && active && active.htmlAudio === el) {
        safeStop(active, 0);
        active = null;
        stopBeatLoop();
        onStateChangeCb(null, null);
      }
    });
  }

  function startBeatLoop() {
    if (beatTimer !== null) return;
    beatTimer = setInterval(() => {
      if (ctx) promotePending(ctx.currentTime);
      if (active) {
        const elapsed = active.isHtmlFallback
          ? (active.htmlAudio && Number.isFinite(active.htmlAudio.currentTime)
            ? active.htmlAudio.currentTime
            : Math.max(0, (performance.now() - active.startWallMs) / 1000))
          : Math.max(0, (ctx ? ctx.currentTime : 0) - active.barOriginCtxTime);
        const step = Math.floor((elapsed / Math.max(0.05, active.beatDurSec)) * 4) % 16;
        const barIdx = Math.floor(elapsed / Math.max(0.25, active.barDurSec));
        onBeatCb(active.trackId, step, barIdx, active);
      }
    }, 45);
  }

  function stopBeatLoop() {
    if (beatTimer !== null) {
      clearInterval(beatTimer);
      beatTimer = null;
    }
  }

  function promotePending(ctxNow) {
    if (!pending || !pending.scheduled) return false;
    if (ctxNow < pending.switchCtxTime) return false;
    const p = pending;
    pending = null;
    active = {
      trackId: p.trackId,
      track: p.track,
      src: p.src,
      htmlAudio: null,
      gain: p.gain,
      barOriginCtxTime: p.switchCtxTime,
      slotStartCtxTime: p.switchCtxTime,
      beatDurSec: p.beatDurSec,
      barDurSec: p.barDurSec,
      stopIdx: p.stopIdx,
      eraId: p.eraId,
      scheduled: true,
    };
    onStateChangeCb(active, null);
    return true;
  }

  function playTrack(trackId, opts = {}) {
    const tr = typeof trackId === "object" ? trackId : byId.get(trackId);
    const url = trackAudioUrl(tr);
    if (!tr || !url) return;

    const ac = ensureCtx();
    const gen = ++generation;
    startBeatLoop();

    if (pending && (pending.src || pending.htmlAudio)) safeStop(pending, 0);

    if (!ac || isNoCorsReleaseUrl(url) || corsBlockedUrls.has(url)) {
      playHtmlFallback(tr, opts, gen);
      return;
    }

    const quantize = Boolean(opts.quantize && active && !active.isHtmlFallback);
    const switchTime = quantize ? getNextBarBoundary(ac.currentTime) : (ac.currentTime + 0.02);
    const cached = decodedCache.get(url);

    if (cached) {
      scheduleVoice(tr, cached, switchTime, opts);
      promotePending(ac.currentTime);
      onStateChangeCb(active, pending);
      return;
    }

    pending = {
      trackId: tr.id,
      track: tr,
      src: null,
      htmlAudio: null,
      gain: null,
      switchCtxTime: switchTime,
      beatDurSec: tr.beat_sec || (60 / (tr.bpm || 120)),
      barDurSec: tr.bar_sec || 2.0,
      stopIdx: opts.stopIdx ?? -1,
      eraId: opts.eraId ?? tr.era,
      eraLabel: opts.eraLabel ?? "",
      scheduled: false,
      isManual: Boolean(opts.isManual),
    };
    onStateChangeCb(active, pending);

    loadBuffer(tr).then((buf) => {
      if (generation !== gen) return;
      if (!pending || pending.trackId !== tr.id) return;
      if (!buf) {
        playHtmlFallback(tr, opts, gen);
        return;
      }
      const realSwitch = active && !active.isHtmlFallback
        ? (opts.quantize ? Math.max(switchTime, getNextBarBoundary(ac.currentTime)) : (ac.currentTime + 0.02))
        : (ac.currentTime + 0.02);
      scheduleVoice(tr, buf, realSwitch, opts);
      onStateChangeCb(active, pending);
    });
  }

  function toggleTrack(trackId, opts = {}) {
    if (active && active.trackId === trackId && !pending) {
      stop();
      return false;
    }
    if (pending && pending.trackId === trackId) {
      stop();
      return false;
    }
    playTrack(trackId, opts);
    return true;
  }

  function stop() {
    generation++;
    safeStop(active, 0);
    safeStop(pending, 0);
    active = null;
    pending = null;
    stopBeatLoop();
    onStateChangeCb(null, null);
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
    stop,
    loadBuffer,
    prefetchTracks,
    promotePending,
    getNextBarBoundary,
    ensureCtx,
    triggerBellNote,
    auditionScale,
    audition12Tet,
    playing: () => (active ? active.trackId : null),
    pending: () => (pending ? pending.trackId : null),
    activeVoice: () => active,
    pendingVoice: () => pending,
    ctxTime: () => (ctx ? ctx.currentTime : 0),
    isEnabled: () => enabled,
    setEnabled(val) {
      enabled = Boolean(val);
      syncMasterGain();
      onStateChangeCb(active, pending);
    },
    setVolume(val) {
      volume = Math.max(0, Math.min(1, Number(val) || 0));
      syncMasterGain();
    },
    getVolume: () => volume,
    setOnStateChange(fn) { onStateChangeCb = typeof fn === "function" ? fn : () => {}; },
    setOnBeat(fn) { onBeatCb = typeof fn === "function" ? fn : () => {}; },
  };
})();
