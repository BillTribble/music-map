// ITU-R BS.1770-4 / EBU R128 Loudness Balancing Helper (`window.BTMM_LOUDNESS`)
// - Reference target: -16.5 LUFS (Apple Sound Check / streaming reference)
// - WebAudio path (`dj-mixer.js` via `/api/audio/:tag/:asset` CORS Range stream):
//   exact attenuation on loud masters (-18..0 dB) + upward lift on quiet tracks (0..+12 dB)
//   with true-peak headroom guard paired with a -1.0 dBFS brickwall DynamicsCompressorNode limiter.
// - Direct HTMLAudioElement fallback (`audio-deck.js`, `dj-mixer.js` `directEl`, `review-sketches.html`):
//   100% zero-CORS-tainting linear multiplier (`clamp(userVolume * gain * fade, 0, 1)`) matching
//   WebAudio output loudness 1:1 from -4 LUFS down to -18 LUFS at default 0.85 master volume.
(function () {
  "use strict";

  const TARGET_LUFS = -16.5;
  const MIN_GAIN_DB = -18.0;
  const MAX_BOOST_DB = 12.0;
  const LIMITER_CEILING_DBTP = -1.0;
  const MAX_LIMITER_GR_DB = 6.0;
  const MIN_LINEAR_GAIN = Math.pow(10, MIN_GAIN_DB / 20); // ~0.1259
  const MAX_LINEAR_GAIN = Math.pow(10, MAX_BOOST_DB / 20); // ~3.9811

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function dbToLinear(db) {
    return Math.pow(10, db / 20);
  }

  function computeTrackGainDb(track, opts) {
    if (!track || typeof track !== "object") return 0.0;
    const mode = (opts && opts.mode) || "webaudio";
    const targetLufs = opts && Number.isFinite(Number(opts.targetLufs))
      ? Number(opts.targetLufs)
      : TARGET_LUFS;

    const rawLufs = Number(track.lufs);
    if (track.lufs !== null && track.lufs !== undefined && Number.isFinite(rawLufs)) {
      let db = clamp(targetLufs - rawLufs, MIN_GAIN_DB, MAX_BOOST_DB);
      const rawTp = Number(track.true_peak_db);
      if (db > 0 && track.true_peak_db !== null && track.true_peak_db !== undefined && Number.isFinite(rawTp)) {
        if (mode === "webaudio") {
          const maxPeakSafeDb = (LIMITER_CEILING_DBTP - rawTp) + MAX_LIMITER_GR_DB;
          db = Math.min(db, Math.max(-6.0, maxPeakSafeDb));
        }
      }
      return db;
    }

    const rawGainDb = Number(track.gain_db);
    if (track.gain_db !== null && track.gain_db !== undefined && Number.isFinite(rawGainDb)) {
      return clamp(rawGainDb, MIN_GAIN_DB, MAX_BOOST_DB);
    }

    const rawTrim = Number(track.gain_trim);
    if (track.gain_trim !== null && track.gain_trim !== undefined && Number.isFinite(rawTrim)) {
      // Defensive guard if any legacy record stored decibels (<= 0) instead of linear gain (> 0)
      if (rawTrim <= 0) {
        return clamp(rawTrim, MIN_GAIN_DB, 0);
      }
      return clamp(20 * Math.log10(Math.max(1e-4, rawTrim)), MIN_GAIN_DB, MAX_BOOST_DB);
    }

    const rawRms = Number(track.rms_db);
    if (track.rms_db !== null && track.rms_db !== undefined && Number.isFinite(rawRms)) {
      const estLufs = rawRms - 0.7;
      return clamp(targetLufs - estLufs, MIN_GAIN_DB, MAX_BOOST_DB);
    }

    return 0.0;
  }

  function getTrackLoudnessGain(track, opts) {
    const db = computeTrackGainDb(track, opts);
    return clamp(dbToLinear(db), MIN_LINEAR_GAIN, MAX_LINEAR_GAIN);
  }

  function computeEffectiveDirectVolume(track, userVolume, envelopeFactor) {
    const vol = Number.isFinite(Number(userVolume)) ? clamp(Number(userVolume), 0, 1) : 0.85;
    const env = Number.isFinite(Number(envelopeFactor)) ? clamp(Number(envelopeFactor), 0, 1) : 1.0;
    const gain = getTrackLoudnessGain(track, { mode: "direct" });
    return clamp(vol * gain * env, 0, 1);
  }

  function createSafetyLimiter(ctx) {
    if (!ctx || typeof ctx.createDynamicsCompressor !== "function") return null;
    try {
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = LIMITER_CEILING_DBTP;
      lim.knee.value = 0.0;
      lim.ratio.value = 20.0;
      lim.attack.value = 0.001;
      lim.release.value = 0.080;
      return lim;
    } catch (_) {
      return null;
    }
  }

  const api = {
    TARGET_LUFS,
    MIN_GAIN_DB,
    MAX_BOOST_DB,
    MIN_LINEAR_GAIN,
    MAX_LINEAR_GAIN,
    LIMITER_CEILING_DBTP,
    computeTrackGainDb,
    getTrackLoudnessGain,
    computeEffectiveDirectVolume,
    createSafetyLimiter,
  };

  if (typeof window !== "undefined") {
    window.BTMM_LOUDNESS = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
