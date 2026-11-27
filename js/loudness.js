// ITU-R BS.1770-4 / EBU R128 Loudness Balancing Helper (`window.BTMM_LOUDNESS`)
// - Reference target: -10.0 LUFS (punchy club / Spotify "Loud" style reference)
// - WebAudio path (`dj-mixer.js` via `/api/audio/:tag/:asset` CORS Range stream):
//   exact attenuation on loud masters (-18..0 dB) + upward makeup gain on quiet tracks (0..+14 dB)
//   with +6.5 dB transient peak-catching headroom into a -0.8 dBFS brickwall DynamicsCompressorNode
//   limiter + C^1 tanh WaveShaperNode soft ceiling (-0.10 dBFS max sample, zero clipping).
// - Direct HTMLAudioElement fallback (`audio-deck.js`, `dj-mixer.js` `directEl`, `review-sketches.html`):
//   100% zero-CORS-tainting linear multiplier attenuating > -10.0 LUFS masters accurately to -10.0 LUFS
//   while <= -10.0 LUFS tracks play at full 1.0 element volume.
(function () {
  "use strict";

  const TARGET_LUFS = -10.0;
  const MIN_GAIN_DB = -18.0;
  const MAX_BOOST_DB = 14.0;
  const LIMITER_CEILING_DBTP = -0.5;
  const LIMITER_THRESHOLD_DB = -0.8;
  const LIMITER_KNEE_DB = 1.5;
  const LIMITER_RATIO = 20.0;
  const LIMITER_ATTACK_SEC = 0.001;
  const LIMITER_RELEASE_SEC = 0.065;
  const MAX_LIMITER_GR_DB = 6.5;
  const SOFT_CLIP_DOMAIN = 4.0;   // [-4.0, +4.0] (+12 dBFS) transient capture range
  const SOFT_CLIP_KNEE = 0.90;    // -0.915 dBFS (100% bit-linear below this threshold)
  const SOFT_CLIP_CEILING = 0.9885; // -0.100 dBFS absolute sample ceiling
  const MIN_LINEAR_GAIN = Math.pow(10, MIN_GAIN_DB / 20); // ~0.1259
  const MAX_LINEAR_GAIN = Math.pow(10, MAX_BOOST_DB / 20); // ~5.0119

  let cachedSoftClipCurve = null;

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function dbToLinear(db) {
    return Math.pow(10, db / 20);
  }

  function softClipSample(x) {
    const ax = Math.abs(x);
    if (ax <= SOFT_CLIP_KNEE) return x;
    const span = SOFT_CLIP_CEILING - SOFT_CLIP_KNEE;
    const y = SOFT_CLIP_KNEE + span * Math.tanh((ax - SOFT_CLIP_KNEE) / span);
    return x < 0 ? -y : y;
  }

  function getSoftClipCurve() {
    if (cachedSoftClipCurve) return cachedSoftClipCurve;
    const n = 65537; // odd length so midpoint (32768) maps u=0 -> 0.0 with zero DC offset
    const curve = new Float32Array(n);
    const half = (n - 1) / 2;
    for (let i = 0; i < n; i++) {
      if (i === half) {
        curve[i] = 0.0;
      } else {
        const u = (i - half) / half; // [-1.0, +1.0]
        curve[i] = softClipSample(u * SOFT_CLIP_DOMAIN);
      }
    }
    cachedSoftClipCurve = curve;
    return curve;
  }

  function computeTrackGainDb(track, opts) {
    if (!track || typeof track !== "object") return 0.0;
    const mode = (opts && opts.mode) || "webaudio";
    const isDirect = mode === "direct" || mode === "element";
    const maxBoostDb = isDirect ? 0.0 : MAX_BOOST_DB;
    const targetLufs = opts && Number.isFinite(Number(opts.targetLufs))
      ? Number(opts.targetLufs)
      : TARGET_LUFS;

    const rawLufs = Number(track.lufs);
    if (track.lufs !== null && track.lufs !== undefined && Number.isFinite(rawLufs)) {
      let db = clamp(targetLufs - rawLufs, MIN_GAIN_DB, maxBoostDb);
      const rawTp = Number(track.true_peak_db);
      if (!isDirect && db > 0 && track.true_peak_db !== null && track.true_peak_db !== undefined && Number.isFinite(rawTp)) {
        // Cap lossy-codec inter-sample Gibbs overshoots at +0.5 dBTP so -11..-18 LUFS tracks
        // with 0 dBFS drum transients receive their full makeup boost while ultra-high-crest
        // sparse percussion/piano tracks (crest > 16-22 dB) cap at <= ~6 dB limiter drive.
        const effTp = Math.min(rawTp, 0.5);
        const maxPeakSafeDb = (LIMITER_CEILING_DBTP - effTp) + MAX_LIMITER_GR_DB;
        db = Math.min(db, Math.max(0.0, maxPeakSafeDb));
      }
      return db;
    }

    const rawGainDb = Number(track.gain_db);
    if (track.gain_db !== null && track.gain_db !== undefined && Number.isFinite(rawGainDb)) {
      return clamp(rawGainDb, MIN_GAIN_DB, maxBoostDb);
    }

    const rawTrim = Number(track.gain_trim);
    if (track.gain_trim !== null && track.gain_trim !== undefined && Number.isFinite(rawTrim)) {
      // Defensive guard if any legacy record stored decibels (<= 0) instead of linear gain (> 0)
      if (rawTrim <= 0) {
        return clamp(rawTrim, MIN_GAIN_DB, 0);
      }
      return clamp(20 * Math.log10(Math.max(1e-4, rawTrim)), MIN_GAIN_DB, maxBoostDb);
    }

    const rawRms = Number(track.rms_db);
    if (track.rms_db !== null && track.rms_db !== undefined && Number.isFinite(rawRms)) {
      const estLufs = rawRms - 0.7;
      return clamp(targetLufs - estLufs, MIN_GAIN_DB, maxBoostDb);
    }

    return 0.0;
  }

  function getTrackLoudnessGain(track, opts) {
    const isDirect = Boolean(opts && (opts.mode === "direct" || opts.mode === "element"));
    const db = computeTrackGainDb(track, opts);
    return clamp(dbToLinear(db), MIN_LINEAR_GAIN, isDirect ? 1.0 : MAX_LINEAR_GAIN);
  }

  function computeEffectiveDirectVolume(track, userVolume, envelopeFactor) {
    const vol = Number.isFinite(Number(userVolume)) ? clamp(Number(userVolume), 0, 1) : 1.0;
    const env = Number.isFinite(Number(envelopeFactor)) ? clamp(Number(envelopeFactor), 0, 1) : 1.0;
    const gain = getTrackLoudnessGain(track, { mode: "direct" });
    return clamp(vol * gain * env, 0, 1);
  }

  function createSafetyLimiter(ctx) {
    if (!ctx || typeof ctx.createDynamicsCompressor !== "function") return null;
    try {
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = LIMITER_THRESHOLD_DB;
      lim.knee.value = LIMITER_KNEE_DB;
      lim.ratio.value = LIMITER_RATIO;
      lim.attack.value = LIMITER_ATTACK_SEC;
      lim.release.value = LIMITER_RELEASE_SEC;
      return lim;
    } catch (_) {
      return null;
    }
  }

  function createSoftClipStage(ctx) {
    if (!ctx || typeof ctx.createWaveShaper !== "function" || typeof ctx.createGain !== "function") return null;
    try {
      const preGain = ctx.createGain();
      preGain.gain.value = 1.0 / SOFT_CLIP_DOMAIN;
      const shaper = ctx.createWaveShaper();
      shaper.curve = getSoftClipCurve();
      shaper.oversample = "2x";
      preGain.connect(shaper);
      return { input: preGain, output: shaper, preGain, shaper };
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
    LIMITER_THRESHOLD_DB,
    LIMITER_KNEE_DB,
    LIMITER_RATIO,
    MAX_LIMITER_GR_DB,
    SOFT_CLIP_KNEE,
    SOFT_CLIP_CEILING,
    softClipSample,
    computeTrackGainDb,
    getTrackLoudnessGain,
    computeEffectiveDirectVolume,
    createSafetyLimiter,
    createSoftClipStage,
  };

  if (typeof window !== "undefined") {
    window.BTMM_LOUDNESS = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
