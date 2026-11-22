(function () {
  "use strict";

  const DATA = window.CORPUS_DATA;
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  const TABS = [
    { id: "chord-quality", group: "harmony", label: "Chord & Dyad Spectrum" },
    { id: "root-motion", group: "harmony", label: "Root Motion & Wheel" },
    { id: "modal-heatmap", group: "harmony", label: "12-Degree Modal Heatmap" },
    { id: "voicing-spread", group: "harmony", label: "Voicing Spread & Keyboard" },
    { id: "ji-gamelan", group: "harmony", label: "JI & Gamelan Tunings", tag: "Garage" },
    { id: "era-compare", group: "harmony", label: "Era-vs-Era Comparator" },
    { id: "workflow", group: "evolution", label: "Workflow (MIDI vs Audio)" },
    { id: "groove", group: "evolution", label: "Groove & Tempo" },
    { id: "melody", group: "evolution", label: "Melody & Space" },
    { id: "audio", group: "evolution", label: "Audio Expressiveness" },
    { id: "palette", group: "evolution", label: "Synths & FX" },
  ];

  const FINE_CHORD_META = [
    { key: "extended_9_11", label: "Extended 9/11", group: "ext", color: "var(--c1)" },
    { key: "min7", label: "Minor 7th", group: "seventh", color: "var(--c2)" },
    { key: "maj7", label: "Major 7th", group: "seventh", color: "var(--c2)" },
    { key: "dom7", label: "Dominant 7th", group: "seventh", color: "var(--c2)" },
    { key: "maj_triad", label: "Major Triad", group: "triad", color: "var(--c4)" },
    { key: "min_triad", label: "Minor Triad", group: "triad", color: "var(--c4)" },
    { key: "sus2_4", label: "Sus2 / Sus4", group: "triad", color: "var(--c4)" },
    { key: "dim_aug", label: "Dim / Aug", group: "triad", color: "var(--c4)" },
    { key: "quartal_cluster", label: "Quartal / Cluster", group: "quartal", color: "var(--c6)" },
    { key: "dyad_3rd_6th", label: "Dyad: 3rd / 6th", group: "dyad36", color: "var(--c5)" },
    { key: "dyad_5th", label: "Dyad: Open 5th", group: "dyad45", color: "var(--c3)" },
    { key: "dyad_4th", label: "Dyad: Open 4th", group: "dyad45", color: "var(--c3)" },
    { key: "dyad_2nd_m7", label: "Dyad: 2nd / b7", group: "dyad27", color: "var(--c8)" },
    { key: "dyad_semitone_M7", label: "Dyad: b2 / M7", group: "dyadfric", color: "var(--c7)" },
    { key: "dyad_tritone", label: "Dyad: Tritone", group: "dyadfric", color: "var(--c7)" },
  ];

  const CHORD_STACK_GROUPS = [
    { id: "ext", label: "Extended 9/11", keys: ["extended_9_11"], color: "var(--c1)" },
    { id: "seventh", label: "7ths (min7/maj7/dom7)", keys: ["min7", "maj7", "dom7"], color: "var(--c2)" },
    { id: "triad", label: "Triads & Sus", keys: ["maj_triad", "min_triad", "sus2_4", "dim_aug"], color: "var(--c4)" },
    { id: "quartal", label: "Quartal / Add2 Stack", keys: ["quartal_cluster"], color: "var(--c6)" },
    { id: "dyad36", label: "Dyad: 3rd / 6th", keys: ["dyad_3rd_6th"], color: "var(--c5)" },
    { id: "dyad45", label: "Dyad: Open 4th / 5th", keys: ["dyad_5th", "dyad_4th"], color: "var(--c3)" },
    { id: "dyad27", label: "Dyad: 2nd / b7", keys: ["dyad_2nd_m7"], color: "var(--c8)" },
    { id: "dyadfric", label: "Dyad: b2 / M7 / TT", keys: ["dyad_semitone_M7", "dyad_tritone"], color: "var(--c7)" },
  ];

  const ROOT_MOTION_GROUPS = [
    { key: "fourth_fifth_5_7", label: "±5 st (4th / 5th)", color: "var(--c1)" },
    { key: "wholestep_2_10", label: "±2 st (Step / bVII)", color: "var(--c2)" },
    { key: "min3_3_9", label: "±3 st (Min 3rd)", color: "var(--c3)" },
    { key: "maj3_4_8", label: "±4 st (Maj 3rd / bVI)", color: "var(--c4)" },
    { key: "semitone_1_11", label: "±1 st (Phrygian Slide)", color: "var(--c5)" },
    { key: "tritone_6", label: "6 st (Tritone)", color: "var(--c7)" },
  ];

  const DEGREE_INFO = [
    { deg: "1", name: "1 (Tonic)", role: "anchor" },
    { deg: "b2", name: "b2 (Phrygian)", role: "dark" },
    { deg: "2", name: "2 (Major 2nd)", role: "dorian" },
    { deg: "b3", name: "b3 (Minor 3rd)", role: "dark" },
    { deg: "3", name: "3 (Major 3rd)", role: "bright" },
    { deg: "4", name: "4 (Fourth)", role: "neutral" },
    { deg: "b5", name: "b5 (Tritone)", role: "tension" },
    { deg: "5", name: "5 (Fifth)", role: "anchor" },
    { deg: "b6", name: "b6 (Minor 6th)", role: "dark" },
    { deg: "6", name: "6 (Dorian 6th)", role: "dorian" },
    { deg: "b7", name: "b7 (Mixolydian)", role: "dark" },
    { deg: "7", name: "7 (Leading Tone)", role: "bright" },
  ];

  const COMPARE_PRESETS = [
    { id: "nihon_sk26", label: "Nihon Forever → Sketches 2026", eraA: "nihon_forever", eraB: "sketches_2026", phA: "phase1_early", phB: "phase4_recent" },
    { id: "garage_ecstatic", label: "Le Garage → Ecstatic Wave", eraA: "le_garage", eraB: "ecstatic_wave", phA: "phase2_mid", phB: "phase4_recent" },
    { id: "ep_garage", label: "EP Concepts → Le Garage", eraA: "ep_concepts", eraB: "le_garage", phA: "phase1_early", phB: "phase2_mid" },
    { id: "spirit_lucid", label: "Spirit Guides → Lucid Crystal", eraA: "spirit_guides", eraB: "lucid_crystal", phA: "phase2_mid", phB: "phase3_ambient" },
  ];

  const state = {
    theme: "dark",
    granularity: "eras", // default to 12 Eras per user request
    tab: "chord-quality",
    pinnedEraIdx: 11, // Sketches 2026
    pinnedPhaseIdx: 3, // Phase 4 Recent
    hoverIdx: null,
    userPinned: false,
    jiAutoDone: false,
    chordMode: "pct", // pct | count
    heatmapSource: "combined_12", // combined_12 | midi_12 | audio_12
    heatmapSpotlight: true,
    voicingMode: "keyboard", // keyboard | span
    tuningScaleId: "semeradana",
    playingDeg: null,
    compareAIdx: 1, // nihon_forever / phase2
    compareBIdx: 11, // sketches_2026 / phase4
  };

  function parseInitialHash() {
    if (typeof window === "undefined" || !window.location) return;
    const h = (window.location.hash || "").replace(/^#/, "");
    if (TABS.some((t) => t.id === h)) {
      state.tab = h;
      if (h === "ji-gamelan") {
        state.jiAutoDone = true;
        state.pinnedEraIdx = 3;
        state.pinnedPhaseIdx = 1;
      }
    }
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function num(v, suffix = "") {
    return v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `${v}${suffix}`;
  }

  function midiName(m) {
    if (m === null || m === undefined || !Number.isFinite(m)) return "n/a";
    const r = Math.round(m);
    const oct = Math.floor(r / 12) - 1;
    const name = NOTE_NAMES[((r % 12) + 12) % 12];
    return `${Number.isInteger(m) ? m : m.toFixed(1)} (${name}${oct})`;
  }

  function currentItems() {
    return state.granularity === "phases" ? DATA.phases : DATA.eras;
  }

  function getPinnedIdx() {
    const items = currentItems();
    const raw = state.granularity === "phases" ? state.pinnedPhaseIdx : state.pinnedEraIdx;
    return Math.max(0, Math.min(items.length - 1, raw));
  }

  function setPinnedIdx(idx, explicit = true) {
    const items = currentItems();
    const clamped = Math.max(0, Math.min(items.length - 1, idx));
    if (state.granularity === "phases") state.pinnedPhaseIdx = clamped;
    else state.pinnedEraIdx = clamped;
    state.hoverIdx = null;
    if (explicit) state.userPinned = true;
  }

  function activeIdx() {
    const items = currentItems();
    if (state.hoverIdx !== null) return Math.max(0, Math.min(items.length - 1, state.hoverIdx));
    return getPinnedIdx();
  }

  function audioSharePct(d) {
    const a = d.audio_tracks_med ?? 0;
    const m = d.midi_tracks_med ?? 0;
    return a + m > 0 ? Math.round((a / (a + m)) * 1000) / 10 : null;
  }

  function svgLinePath(points) {
    let d = "";
    let open = false;
    for (const pt of points) {
      if (!pt || pt.y === null || !Number.isFinite(pt.y)) {
        open = false;
        continue;
      }
      d += `${open ? "L" : "M"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
      open = true;
    }
    return d;
  }

  function measureStageWidth(id, fallback = 860) {
    const el = document.getElementById(id);
    if (!el || !el.clientWidth || el.clientWidth < 120) return fallback;
    return Math.floor(el.clientWidth);
  }

  function phaseDividerLayer(W, padL, plotW, padT, plotH) {
    if (state.granularity !== "eras") return "";
    const colW = plotW / 12;
    const xC = (i) => padL + colW * (i + 0.5);
    const groups = [
      { tag: "P1 Early (2013–18)", start: 0, end: 2 },
      { tag: "P2 Mid (2018–22)", start: 3, end: 5 },
      { tag: "P3 Ambient (2020–24)", start: 6, end: 8 },
      { tag: "P4 Recent (2024–26)", start: 9, end: 11 },
    ];
    let out = "";
    groups.forEach((g, gi) => {
      const cx = (xC(g.start) + xC(g.end)) / 2;
      out += `<text x="${cx.toFixed(1)}" y="14" text-anchor="middle" font-size="12" fill="var(--fg-dim)" font-weight="600">${esc(g.tag)}</text>`;
      if (gi > 0) {
        const dx = padL + colW * g.start;
        out += `<line x1="${dx.toFixed(1)}" y1="${padT}" x2="${dx.toFixed(1)}" y2="${padT + plotH}" stroke="var(--border)" stroke-dasharray="3,3" stroke-width="1" />`;
      }
    });
    return out;
  }

  function gridAxesLayer(padL, plotW, padT, plotH, ticks, fmtLeft, fmtRight) {
    let out = "";
    const yFromNorm = (n) => padT + plotH * (1 - Math.max(0, Math.min(1, n)));
    for (const norm of ticks) {
      const y = yFromNorm(norm);
      out += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--border-subtle)" stroke-width="1" />`;
      if (fmtLeft) {
        out += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="var(--fg-muted)">${esc(fmtLeft(norm))}</text>`;
      }
      if (fmtRight) {
        out += `<text x="${padL + plotW + 8}" y="${(y + 4).toFixed(1)}" text-anchor="start" font-size="12" fill="var(--fg-muted)">${esc(fmtRight(norm))}</text>`;
      }
    }
    return out;
  }

  function xAxisAndHitLayer(items, padL, plotW, padT, plotH, H, selIdx) {
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);
    let out = "";
    const selX = padL + colW * selIdx;
    out += `<rect x="${(selX + 2).toFixed(1)}" y="${padT}" width="${Math.max(4, colW - 4).toFixed(1)}" height="${plotH}" rx="4" fill="var(--primary)" fill-opacity="0.09" stroke="var(--primary)" stroke-opacity="${state.hoverIdx !== null ? 0.45 : 0.75}" stroke-width="1.2" />`;
    items.forEach((d, i) => {
      const cx = xC(i);
      const isSel = i === selIdx;
      const lbl = state.granularity === "phases" ? d.label : d.shortLabel;
      out += `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="12" font-weight="${isSel ? "700" : "500"}" fill="${isSel ? "var(--fg)" : "var(--fg-muted)"}">${esc(lbl)}</text>`;
      out += `<rect data-era-idx="${i}" x="${(padL + colW * i).toFixed(1)}" y="${padT}" width="${colW.toFixed(1)}" height="${plotH + 26}" fill="transparent" style="cursor:pointer"><title>${esc(d.label)} (${esc(d.sublabel)})</title></rect>`;
    });
    return out;
  }

  function legendHtml(items) {
    return `<div class="legend-row">${items
      .map((it) => {
        const sw = it.dashed
          ? `<span class="swatch-line" style="border-color:${it.color}"></span>`
          : `<span class="swatch" style="background:${it.color}"></span>`;
        return `<span class="legend-item">${sw}<span>${esc(it.label)}</span></span>`;
      })
      .join("")}</div>`;
  }

  // ---------------- WebAudio Bell Synthesis for JI & Gamelan ----------------
  let audioCtx = null;
  function getAudioCtx() {
    if (typeof window === "undefined") return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function triggerBellNote(cents, delaySec = 0) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime + delaySec;
    const baseHz = 261.6256; // C4
    const freq = baseHz * Math.pow(2, cents / 1200);

    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.18, now + 0.015);
    master.gain.exponentialRampToValueAtTime(0.0008, now + 0.85);
    master.connect(ctx.destination);

    const osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(freq, now);
    osc1.connect(master);

    const overGain = ctx.createGain();
    overGain.gain.setValueAtTime(0.24, now);
    overGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    overGain.connect(master);

    const osc2 = ctx.createOscillator();
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(freq * 2.756, now); // subtle bronze-bar partial
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

  function audition12TetRef() {
    const steps = [0, 200, 300, 500, 700, 800, 1000, 1200];
    steps.forEach((c, idx) => triggerBellNote(c, idx * 0.28));
  }

  // ---------------- TAB RENDERERS ----------------

  function renderChordQuality(items, d, selIdx) {
    const insight = "4+ note 7th/extended chords jumped nearly 7× (2.3% → 15.6%) while dyads shifted from Nihon's tritones/b2s to Lucid Crystal's open 4ths/5ths and Ecstatic Wave's rich min7 stacks.";
    const subBtns = `
      <div class="segmented">
        <button type="button" data-sub="chordMode:pct" class="btn ${state.chordMode === "pct" ? "active" : ""}">Normalized %</button>
        <button type="button" data-sub="chordMode:count" class="btn ${state.chordMode === "count" ? "active" : ""}">Chord Count</button>
      </div>`;

    const W = Math.max(420, measureStageWidth("cq-stage-wrap", 620));
    const H = 300;
    const padL = 46, padR = 16, padT = state.granularity === "eras" ? 26 : 16, padB = 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);
    const bw = Math.max(10, Math.min(48, colW * 0.62));

    const maxCnt = Math.max(100, ...items.map((it) => it.fine_harmony.n_chords || 0));
    const yScaleCnt = Math.ceil(maxCnt / 200) * 200;

    let svg = phaseDividerLayer(W, padL, plotW, padT, plotH);
    svg += gridAxesLayer(
      padL, plotW, padT, plotH, [0, 0.25, 0.5, 0.75, 1],
      (r) => state.chordMode === "pct" ? `${Math.round(r * 100)}%` : `${Math.round(r * yScaleCnt)}`,
      null
    );

    items.forEach((it, i) => {
      const cx = xC(i);
      const fh = it.fine_harmony;
      const tot = fh.n_chords || 0;
      if (tot === 0) {
        svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${plotH}" rx="2" fill="var(--bg-hover)" fill-opacity="0.45" stroke="var(--border)" stroke-dasharray="3,2" />`;
        svg += `<text x="${cx.toFixed(1)}" y="${(padT + plotH / 2).toFixed(1)}" text-anchor="middle" font-size="12" fill="var(--fg-dim)">n=0</text>`;
        return;
      }
      const denom = state.chordMode === "pct" ? tot : yScaleCnt;
      let yCursor = padT + plotH;
      // Draw from bottom up: dyadfric -> dyad27 -> dyad45 -> dyad36 -> quartal -> triad -> seventh -> ext
      const order = [...CHORD_STACK_GROUPS].reverse();
      order.forEach((grp) => {
        const cnt = grp.keys.reduce((acc, k) => acc + (fh.counts[k] || 0), 0);
        if (cnt <= 0) return;
        const h = (cnt / denom) * plotH;
        yCursor -= h;
        svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${yCursor.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="${grp.color}" fill-opacity="${fh.low_sample ? 0.45 : i === selIdx ? 0.98 : 0.84}" />`;
      });
      if (fh.low_sample) {
        svg += `<text x="${cx.toFixed(1)}" y="${Math.max(padT + 12, yCursor - 4).toFixed(1)}" text-anchor="middle" font-size="12" fill="var(--c3)">n=${tot}</text>`;
      }
    });

    svg += xAxisAndHitLayer(items, padL, plotW, padT, plotH, H, selIdx);

    // Right breakdown for ALL 15 fine categories
    const fhActive = d.fine_harmony;
    const rowsHtml = FINE_CHORD_META.map((meta) => {
      const cnt = fhActive.counts[meta.key] || 0;
      const pctVal = fhActive.pcts[meta.key];
      const w = pctVal !== null && Number.isFinite(pctVal) ? Math.min(100, pctVal * 1.8) : 0;
      return `
        <div class="flavor-row">
          <span class="flavor-name" title="${esc(meta.label)}">${esc(meta.label)}</span>
          <div class="flavor-track"><div class="flavor-fill" style="width:${w.toFixed(1)}%;background:${meta.color}"></div></div>
          <span class="flavor-val">${pctVal !== null ? `${pctVal}% (${cnt})` : "—"}</span>
        </div>`;
    }).join("");

    return `
      <div class="view-head">
        <p class="view-insight">${esc(insight)}</p>
        <div class="sub-controls">${subBtns}</div>
      </div>
      ${legendHtml(CHORD_STACK_GROUPS)}
      <div class="grid-2">
        <div class="subpanel">
          <div class="subpanel-title">
            <span>Stacked Chord & Dyad Taxonomy</span>
            <span class="muted">${state.chordMode === "pct" ? "100% Share" : "Chord Events"} (dashed/muted = n&lt;25 audio-first)</span>
          </div>
          <div id="cq-stage-wrap" class="svg-stage">
            <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg>
          </div>
        </div>
        <div class="subpanel">
          <div class="subpanel-title">
            <span>All 15 Flavors — ${esc(d.label)}</span>
            <span class="badge ${fhActive.low_sample ? "badge-warn" : ""}">${fhActive.n_chords} events</span>
          </div>
          <div class="flavor-list">${rowsHtml}</div>
        </div>
      </div>`;
  }

  function renderRootMotion(items, d, selIdx) {
    const insight = "Progression DNA evolved from Nihon's ±1 semitone Phrygian slides (37% of moves) and Le Garage/EP's M3 mediants to Spirit Guides' whole-step planing and recent 4th/5th gravity.";

    const W = Math.max(380, measureStageWidth("rm-stage-wrap", 540));
    const H = 300;
    const padL = 44, padR = 44, padT = state.granularity === "eras" ? 26 : 16, padB = 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);
    const bw = Math.max(10, Math.min(44, colW * 0.58));

    let svg = phaseDividerLayer(W, padL, plotW, padT, plotH);
    svg += gridAxesLayer(
      padL, plotW, padT, plotH, [0, 0.25, 0.5, 0.75, 1],
      (r) => `${Math.round(r * 100)}%`,
      (r) => `${Math.round(r * 100)}%`
    );

    const pedalPts = [];
    items.forEach((it, i) => {
      const cx = xC(i);
      const rm = it.root_motion;
      if (!rm || rm.n_moves === 0) {
        svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${plotH}" rx="2" fill="var(--bg-hover)" fill-opacity="0.35" stroke="var(--border)" stroke-dasharray="3,2" />`;
        pedalPts.push(null);
        return;
      }
      let yCursor = padT + plotH;
      const order = [...ROOT_MOTION_GROUPS].reverse();
      order.forEach((grp) => {
        const val = rm[grp.key] || 0;
        const h = (val / 100) * plotH;
        yCursor -= h;
        svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${yCursor.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" fill="${grp.color}" fill-opacity="${rm.n_moves < 20 ? 0.4 : i === selIdx ? 0.96 : 0.82}" />`;
      });
      if (rm.n_moves < 20) {
        svg += `<text x="${cx.toFixed(1)}" y="${(padT + 14).toFixed(1)}" text-anchor="middle" font-size="12" fill="var(--c3)">n=${rm.n_moves}</text>`;
      }
      pedalPts.push(rm.pedal_pct !== null ? { x: cx, y: padT + plotH * (1 - rm.pedal_pct / 100) } : null);
    });

    svg += `<path d="${svgLinePath(pedalPts)}" fill="none" stroke="var(--fg)" stroke-width="2" stroke-dasharray="4,3" />`;
    pedalPts.forEach((pt, i) => {
      if (!pt) return;
      svg += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${i === selIdx ? 4.5 : 3}" fill="var(--fg)" />`;
    });
    svg += xAxisAndHitLayer(items, padL, plotW, padT, plotH, H, selIdx);

    // Interactive 12-semitone Circular Wheel for active era
    const whSize = 290;
    const cx = whSize / 2, cy = whSize / 2, rOuter = 104, rInner = 28;
    const rmActive = d.root_motion;
    const cnts = rmActive.counts_12 || Array(12).fill(0);
    const maxNonZero = Math.max(1, ...cnts.slice(1));
    const wheelLabels = ["0 Ped", "+1 bII", "+2 II", "+3 bIII", "+4 III", "+5 IV", "+6 TT", "+7 V", "-4 bVI", "-3 VI", "-2 bVII", "-1 VII"];
    let wheelSvg = `<circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="var(--border)" stroke-width="1" />`;
    wheelSvg += `<circle cx="${cx}" cy="${cy}" r="${rOuter * 0.55}" fill="none" stroke="var(--border-subtle)" stroke-dasharray="2,3" stroke-width="1" />`;

    for (let s = 0; s < 12; s++) {
      const ang = (s / 12) * Math.PI * 2 - Math.PI / 2;
      const lx = cx + (rOuter + 24) * Math.cos(ang);
      const ly = cy + (rOuter + 24) * Math.sin(ang);
      const val = cnts[s] || 0;
      const col = s === 0 ? "var(--c8)" : (s === 5 || s === 7) ? "var(--c1)" : (s === 2 || s === 10) ? "var(--c2)" : (s === 1 || s === 11) ? "var(--c5)" : (s === 4 || s === 8) ? "var(--c4)" : (s === 3 || s === 9) ? "var(--c3)" : "var(--c7)";
      if (s > 0 && val > 0) {
        const ratio = val / maxNonZero;
        const rTip = rInner + ratio * (rOuter - rInner);
        const x1 = cx + rInner * Math.cos(ang);
        const y1 = cy + rInner * Math.sin(ang);
        const x2 = cx + rTip * Math.cos(ang);
        const y2 = cy + rTip * Math.sin(ang);
        const sw = 2 + ratio * 7;
        wheelSvg += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${col}" stroke-width="${sw.toFixed(1)}" stroke-linecap="round" stroke-opacity="0.88"><title>${wheelLabels[s]}: ${val} transitions</title></line>`;
        wheelSvg += `<circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="3.5" fill="${col}" />`;
      }
      wheelSvg += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" font-size="12" fill="${val > 0 ? "var(--fg)" : "var(--fg-dim)"}" font-weight="${s > 0 && val === maxNonZero ? "700" : "500"}">${esc(wheelLabels[s])}</text>`;
    }
    const pedLabel = rmActive.pedal_pct !== null ? `${rmActive.pedal_pct}%` : "n/a";
    wheelSvg += `<circle cx="${cx}" cy="${cy}" r="${rInner}" fill="var(--bg-card)" stroke="var(--border)" stroke-width="1.2" />`;
    wheelSvg += `<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--fg)">${esc(pedLabel)}</text>`;
    wheelSvg += `<text x="${cx}" y="${cy + 13}" text-anchor="middle" font-size="12" fill="var(--fg-muted)">pedal</text>`;

    return `
      <div class="view-head">
        <p class="view-insight">${esc(insight)}</p>
      </div>
      ${legendHtml([...ROOT_MOTION_GROUPS, { label: "0 st Pedal Repeat % (line)", color: "var(--fg)", dashed: true }])}
      <div class="grid-2">
        <div class="subpanel">
          <div class="subpanel-title"><span>Non-Pedal Root Progression Mix (% of Changes)</span></div>
          <div id="rm-stage-wrap" class="svg-stage">
            <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg>
          </div>
        </div>
        <div class="subpanel">
          <div class="subpanel-title">
            <span>Transition Wheel — ${esc(d.label)}</span>
            <span class="badge">${rmActive.n_moves} moves</span>
          </div>
          <div class="svg-stage" style="max-width:300px;margin:0 auto">
            <svg viewBox="0 0 ${whSize} ${whSize}" width="${whSize}" height="${whSize}">${wheelSvg}</svg>
          </div>
        </div>
      </div>`;
  }

  function renderModalHeatmap(items, d, selIdx) {
    const insight = "Even on audio-first eras, 12-degree density tracks your shift from major 3 (Spirit Guides 15.7%) & Harmonic Minor 7 (Le Garage 8.0%) to Minor/Phrygian/Dorian color (b3 9.9%, 3 0.7%, b2 6.4% in Sketches 2026).";
    const controls = `
      <div class="segmented">
        <button type="button" data-sub="heatmapSource:combined_12" class="btn ${state.heatmapSource === "combined_12" ? "active" : ""}">Combined (MIDI+Audio)</button>
        <button type="button" data-sub="heatmapSource:midi_12" class="btn ${state.heatmapSource === "midi_12" ? "active" : ""}">MIDI Only</button>
        <button type="button" data-sub="heatmapSource:audio_12" class="btn ${state.heatmapSource === "audio_12" ? "active" : ""}">Audio Only</button>
      </div>
      <div class="segmented">
        <button type="button" data-sub="heatmapSpotlight:true" class="btn ${state.heatmapSpotlight ? "active" : ""}">Spotlight Color Degrees</button>
        <button type="button" data-sub="heatmapSpotlight:false" class="btn ${!state.heatmapSpotlight ? "active" : ""}">All 12 Degrees</button>
      </div>`;

    const indices = state.heatmapSpotlight ? [1, 2, 3, 4, 5, 6, 8, 9, 10, 11] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    let maxVal = 0.05;
    items.forEach((it) => {
      const vec = it.scale_degrees[state.heatmapSource];
      if (!vec) return;
      indices.forEach((idx) => {
        if (vec[idx] > maxVal) maxVal = vec[idx];
      });
    });

    function cellStyle(val, role) {
      if (val === null || val === undefined || !Number.isFinite(val)) {
        return `background:var(--bg-elev);color:var(--fg-dim)`;
      }
      const norm = Math.min(1, val / maxVal);
      const alpha = (0.06 + norm * 0.68).toFixed(2);
      const rgb =
        role === "dark" ? "244,114,182" :
        role === "dorian" ? "34,211,238" :
        role === "bright" ? "52,211,153" :
        role === "tension" ? "251,113,133" : "94,161,255";
      const txtCol = norm > 0.56 ? (state.theme === "dark" ? "#081221" : "#081221") : "var(--fg)";
      const fw = norm > 0.45 ? "700" : "500";
      return `background:rgba(${rgb},${alpha});color:${txtCol};font-weight:${fw}`;
    }

    const headCols = items.map((it, i) => {
      const lbl = state.granularity === "phases" ? it.shortLabel : it.shortLabel;
      return `<th data-era-idx="${i}" class="${i === selIdx ? "col-active" : ""}" title="${esc(it.label)} (${esc(it.sublabel)})">${esc(lbl)}</th>`;
    }).join("");

    const bodyRows = indices.map((degIdx) => {
      const info = DEGREE_INFO[degIdx];
      const cells = items.map((it, i) => {
        const vec = it.scale_degrees[state.heatmapSource];
        const v = vec ? vec[degIdx] : null;
        const pctStr = v !== null && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—";
        const activeBorder = i === selIdx ? ";outline:1px solid var(--primary)" : "";
        return `<td data-era-idx="${i}" class="hm-cell" style="${cellStyle(v, info.role)}${activeBorder}" title="${esc(it.label)} · ${esc(info.name)}: ${pctStr}">${pctStr}</td>`;
      }).join("");
      return `<tr><td class="hm-deg">${esc(info.name)}</td>${cells}</tr>`;
    }).join("");

    return `
      <div class="view-head">
        <p class="view-insight">${esc(insight)}</p>
        <div class="sub-controls">${controls}</div>
      </div>
      ${legendHtml([
        { label: "Dark Modal (b2, b3, b6, b7)", color: "rgb(244,114,182)" },
        { label: "Dorian Color (2, 6)", color: "rgb(34,211,238)" },
        { label: "Major / Leading (3, 7)", color: "rgb(52,211,153)" },
        { label: "Tritone (b5)", color: "rgb(251,113,133)" },
        { label: "Structural (1, 4, 5)", color: "rgb(94,161,255)" }
      ])}
      <div class="heatmap-wrap">
        <table class="heatmap-table">
          <thead><tr><th>Scale Degree</th>${headCols}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>`;
  }

  function renderVoicingSpread(items, d, selIdx) {
    const insight = state.voicingMode === "keyboard"
      ? "Chords expand from Nihon/EP's compact mid grips into 2–3 octave cinematic voicings in Le Garage & Remixes, then tighten into rich MIDI 50–68 modal voicings over deep bass."
      : "Vertical span peaks in Le Garage (28 st median) & Remixes (38 st) for towering synth pads, whereas Nihon (6 st), Lucid (5 st), & Sketches 2026 (7 st) voice closer within an octave.";
    const subBtns = `
      <div class="segmented">
        <button type="button" data-sub="voicingMode:keyboard" class="btn ${state.voicingMode === "keyboard" ? "active" : ""}">Keyboard Register (C1–C6)</button>
        <button type="button" data-sub="voicingMode:span" class="btn ${state.voicingMode === "span" ? "active" : ""}">Semitone Span (p10–p90)</button>
      </div>`;

    const W = Math.max(460, measureStageWidth("vs-stage-wrap", 960));
    const H = 310;
    const padL = 62, padR = 24, padT = state.granularity === "eras" ? 26 : 16, padB = 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);

    let svg = phaseDividerLayer(W, padL, plotW, padT, plotH);

    if (state.voicingMode === "keyboard") {
      const mMin = 24, mMax = 88; // C1 to E6
      const yM = (m) => m === null || !Number.isFinite(m) ? null : padT + plotH * (1 - Math.max(0, Math.min(1, (m - mMin) / (mMax - mMin))));
      // Piano C-octave reference lines + left keyboard glyph
      [24, 36, 48, 60, 72, 84].forEach((cm) => {
        const y = yM(cm);
        const oct = Math.floor(cm / 12) - 1;
        svg += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="${cm === 60 ? "var(--border)" : "var(--border-subtle)"}" stroke-width="${cm === 60 ? 1.4 : 1}" />`;
        svg += `<text x="${padL - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="${cm === 60 ? "var(--fg)" : "var(--fg-muted)"}" font-weight="${cm === 60 ? "700" : "500"}">C${oct} (${cm})</text>`;
      });

      const leadPts = [], audioPts = [], bassPts = [];
      const bw = Math.max(10, Math.min(28, colW * 0.38));

      items.forEach((it, i) => {
        const cx = xC(i);
        const vr = it.voicing_register;
        if (vr && vr.low_p50 !== null && vr.high_p50 !== null) {
          const yLow25 = yM(vr.low_p25);
          const yHigh75 = yM(vr.high_p75);
          const yLow50 = yM(vr.low_p50);
          const yHigh50 = yM(vr.high_p50);
          if (yLow25 !== null && yHigh75 !== null) {
            svg += `<line x1="${cx.toFixed(1)}" y1="${yHigh75.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yLow25.toFixed(1)}" stroke="var(--c1)" stroke-opacity="0.55" stroke-width="2" />`;
          }
          const topY = Math.min(yLow50, yHigh50);
          const barH = Math.max(4, Math.abs(yLow50 - yHigh50));
          svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${topY.toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" rx="3" fill="var(--c1)" fill-opacity="${i === selIdx ? 0.85 : 0.45}" stroke="var(--c1)" stroke-width="1.2" />`;
        } else {
          svg += `<text x="${cx.toFixed(1)}" y="${(padT + 18).toFixed(1)}" text-anchor="middle" font-size="12" fill="var(--fg-dim)">Audio</text>`;
        }
        leadPts.push({ x: cx, y: yM(it.lead_midi_p50) });
        audioPts.push({ x: cx, y: yM(it.audio_midi_p50) });
        bassPts.push({ x: cx, y: yM(it.bass_midi_p50) });
      });

      [
        { pts: leadPts, col: "var(--c3)", dashed: false },
        { pts: audioPts, col: "var(--c2)", dashed: true },
        { pts: bassPts, col: "var(--c4)", dashed: false },
      ].forEach((s) => {
        svg += `<path d="${svgLinePath(s.pts)}" fill="none" stroke="${s.col}" stroke-width="2" ${s.dashed ? 'stroke-dasharray="4,3"' : ""} />`;
        s.pts.forEach((pt, i) => {
          if (pt.y === null) return;
          svg += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${i === selIdx ? 4.8 : 3.4}" fill="${s.col}" stroke="var(--bg-card)" stroke-width="1.4" />`;
        });
      });
    } else {
      const sMax = 48;
      const yS = (v) => v === null || !Number.isFinite(v) ? null : padT + plotH * (1 - Math.max(0, Math.min(1, v / sMax)));
      svg += gridAxesLayer(padL, plotW, padT, plotH, [0, 0.25, 0.5, 0.75, 1], (r) => `${Math.round(r * sMax)} st`, null);
      const medPts = [];
      const bw = Math.max(10, Math.min(28, colW * 0.4));
      items.forEach((it, i) => {
        const cx = xC(i);
        const vr = it.voicing_register;
        if (!vr || vr.span_p50 === null) {
          medPts.push(null);
          svg += `<text x="${cx.toFixed(1)}" y="${(padT + 20).toFixed(1)}" text-anchor="middle" font-size="12" fill="var(--fg-dim)">n=0</text>`;
          return;
        }
        const y10 = yS(vr.span_p10), y90 = yS(vr.span_p90);
        const y25 = yS(vr.span_p25), y75 = yS(vr.span_p75);
        const y50 = yS(vr.span_p50);
        svg += `<line x1="${cx.toFixed(1)}" y1="${y90.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y10.toFixed(1)}" stroke="var(--c5)" stroke-opacity="0.55" stroke-width="2" />`;
        svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y75.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(4, y25 - y75).toFixed(1)}" rx="3" fill="var(--c5)" fill-opacity="${i === selIdx ? 0.85 : 0.45}" stroke="var(--c5)" stroke-width="1.2" />`;
        medPts.push({ x: cx, y: y50 });
      });
      svg += `<path d="${svgLinePath(medPts)}" fill="none" stroke="var(--c3)" stroke-width="2.4" />`;
      medPts.forEach((pt, i) => {
        if (!pt) return;
        svg += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${i === selIdx ? 5 : 3.5}" fill="var(--c3)" stroke="var(--bg-card)" stroke-width="1.5" />`;
      });
    }

    svg += xAxisAndHitLayer(items, padL, plotW, padT, plotH, H, selIdx);

    const legend = state.voicingMode === "keyboard"
      ? [
          { label: "Chord Core (low–high median; whisker p25–p75)", color: "var(--c1)" },
          { label: "Lead MIDI Med", color: "var(--c3)" },
          { label: "Audio Melodic Med", color: "var(--c2)", dashed: true },
          { label: "Bass MIDI Med", color: "var(--c4)" },
        ]
      : [
          { label: "IQR Span (p25–p75; whisker p10–p90)", color: "var(--c5)" },
          { label: "Median Chord Span (semitones)", color: "var(--c3)" },
        ];

    return `
      <div class="view-head">
        <p class="view-insight">${esc(insight)}</p>
        <div class="sub-controls">${subBtns}</div>
      </div>
      ${legendHtml(legend)}
      <div class="subpanel">
        <div id="vs-stage-wrap" class="svg-stage">
          <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg>
        </div>
      </div>`;
  }

  function renderJiGamelan(items, d, selIdx) {
    const insight = "Just Intonation (Retune for Live .amxd / Tuned 808 JI) & Balinese Semaradana / Gamelan tunings spike in EP Concepts ('Le Garage ≤2018', 7 projects) and Le Garage Hermétique (5/9 album tracks; 17.5¢ median / 31.9¢ p75 audio cent deviation).";

    const W = Math.max(360, measureStageWidth("ji-stage-wrap", 540));
    const H = 265;
    const padL = 36, padR = 44, padT = state.granularity === "eras" ? 24 : 16, padB = 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);
    const bw = Math.max(10, Math.min(34, colW * 0.54));
    const maxProj = Math.max(8, ...items.map((it) => (it.microtonal.ji_retune_projects || 0) + (it.microtonal.gamelan_projects || 0)));
    const maxCents = 45;

    let svg = phaseDividerLayer(W, padL, plotW, padT, plotH);
    svg += gridAxesLayer(
      padL, plotW, padT, plotH, [0, 0.5, 1],
      (r) => `${Math.round(r * maxProj)}`,
      (r) => `${Math.round(r * maxCents)}¢`
    );

    const p50Pts = [], p75Pts = [];
    items.forEach((it, i) => {
      const cx = xC(i);
      const mt = it.microtonal;
      const hJi = ((mt.ji_retune_projects || 0) / maxProj) * plotH;
      const hGam = ((mt.gamelan_projects || 0) / maxProj) * plotH;
      if (hJi > 0) {
        svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${(padT + plotH - hJi).toFixed(1)}" width="${bw.toFixed(1)}" height="${hJi.toFixed(1)}" fill="var(--c3)" fill-opacity="0.88" />`;
      }
      if (hGam > 0) {
        svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${(padT + plotH - hJi - hGam).toFixed(1)}" width="${bw.toFixed(1)}" height="${hGam.toFixed(1)}" rx="2" fill="var(--c2)" fill-opacity="0.88" />`;
      }
      p50Pts.push(mt.tuning_offset_p50 !== null ? { x: cx, y: padT + plotH * (1 - Math.min(1, mt.tuning_offset_p50 / maxCents)) } : null);
      p75Pts.push(mt.tuning_offset_p75 !== null ? { x: cx, y: padT + plotH * (1 - Math.min(1, mt.tuning_offset_p75 / maxCents)) } : null);
    });

    svg += `<path d="${svgLinePath(p75Pts)}" fill="none" stroke="var(--c4)" stroke-width="1.8" stroke-dasharray="4,3" />`;
    svg += `<path d="${svgLinePath(p50Pts)}" fill="none" stroke="var(--c1)" stroke-width="2.4" />`;
    p50Pts.forEach((pt, i) => {
      if (!pt) return;
      svg += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${i === selIdx ? 4.8 : 3.2}" fill="var(--c1)" stroke="var(--bg-card)" stroke-width="1.3" />`;
    });
    svg += xAxisAndHitLayer(items, padL, plotW, padT, plotH, H, selIdx);

    // Right Octave Cent-Ruler
    const scales = DATA.meta.tuning_scales;
    const sc = scales[state.tuningScaleId] || scales.semeradana;
    const scaleBtns = Object.values(scales).map((s) =>
      `<button type="button" data-sub="tuningScaleId:${s.id}" class="btn ${s.id === sc.id ? "active" : ""}">${esc(s.id === "semeradana" ? "Semaradana (7-tone)" : s.id === "ji_5_7" ? "5/7-Limit JI" : s.id === "alves_pelog" ? "Alves JI Pelog" : "Alves JI Slendro")}</button>`
    ).join("");

    const rw = 520, rh = 132, rPadL = 22, rPadR = 22, rPlotW = rw - rPadL - rPadR;
    const xCent = (c) => rPadL + (c / 1200) * rPlotW;
    let rulerSvg = `<line x1="${rPadL}" y1="74" x2="${rPadL + rPlotW}" y2="74" stroke="var(--border)" stroke-width="2" />`;
    // 12-TET reference ticks
    for (let st = 0; st <= 12; st++) {
      const x = xCent(st * 100);
      rulerSvg += `<line x1="${x.toFixed(1)}" y1="62" x2="${x.toFixed(1)}" y2="86" stroke="var(--fg-dim)" stroke-opacity="0.55" stroke-width="1" />`;
      if (st % 2 === 0 || st === 7 || st === 11) {
        rulerSvg += `<text x="${x.toFixed(1)}" y="102" text-anchor="middle" font-size="12" fill="var(--fg-dim)">${st * 100}</text>`;
      }
    }
    rulerSvg += `<text x="${rPadL}" y="120" text-anchor="start" font-size="12" fill="var(--fg-muted)">12-TET cents baseline (grey ticks)</text>`;

    // Active tuning degree pins
    sc.degrees.forEach((degObj, di) => {
      const x = xCent(degObj.cents);
      const nearestTet = Math.round(degObj.cents / 100) * 100;
      const diff = Math.round(degObj.cents - nearestTet);
      const diffStr = diff === 0 ? "0¢" : `${diff > 0 ? "+" : ""}${diff}¢`;
      const yPin = di % 2 === 0 ? 34 : 50;
      rulerSvg += `<line x1="${x.toFixed(1)}" y1="${yPin}" x2="${x.toFixed(1)}" y2="74" stroke="var(--c3)" stroke-width="2" />`;
      rulerSvg += `<circle data-play-cent="${degObj.cents}" cx="${x.toFixed(1)}" cy="74" r="5" fill="var(--c3)" stroke="var(--bg-card)" stroke-width="1.5" style="cursor:pointer"><title>${esc(degObj.deg)} · ${degObj.cents}¢ (${diffStr} vs 12-TET)</title></circle>`;
      rulerSvg += `<text x="${x.toFixed(1)}" y="${yPin - 5}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--fg)">${esc(degObj.deg)}</text>`;
    });

    const degPills = sc.degrees.map((degObj) => {
      const nearestTet = Math.round(degObj.cents / 100) * 100;
      const diff = Math.round((degObj.cents - nearestTet) * 10) / 10;
      const diffStr = diff === 0 ? "0¢" : `${diff > 0 ? "+" : ""}${diff}¢`;
      return `
        <button type="button" data-play-cent="${degObj.cents}" class="deg-pill" title="${esc(degObj.note)}">
          <strong>${esc(degObj.deg)} · ${degObj.cents}¢</strong>
          <span class="muted">${diffStr} vs 12-TET</span>
        </button>`;
    }).join("");

    // Curated evidence cards
    const evEras = [
      { id: "le_garage", title: "Le Garage Hermétique (5/9 tracks)", badge: "17.5¢ p50 · 31.9¢ p75" },
      { id: "ep_concepts", title: "EP Concepts · 'Le Garage ≤2018'", badge: "7 JI / Gamelan projects" },
      { id: "nihon_forever", title: "Earlier & Crossover Works", badge: "Nihon · 2019 · Ladrang" },
    ];
    const evidenceCards = evEras.map((card) => {
      const targetEra = DATA.eras.find((e) => e.id === card.id);
      const targetIdx = DATA.eras.findIndex((e) => e.id === card.id);
      let bullets = (targetEra && targetEra.microtonal.evidence) || [];
      if (card.id === "nihon_forever") {
        bullets = [
          "Nihon Forever: 07 Funabashi Massive (Retune microtonal.amxd)",
          "Archive 2018–23: 2019 gamelan test & fugue test gamelan",
          "Remixes/Comm: Gamelan Ladrang Remix (Javanese cycle)"
        ];
      }
      const isActive = state.granularity === "eras" && targetIdx === selIdx;
      return `
        <div class="evidence-card ${isActive ? "active" : ""}" data-jump-era="${esc(card.id)}">
          <h4><span>${esc(card.title)}</span><span class="badge badge-warn">${esc(card.badge)}</span></h4>
          <ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
        </div>`;
    }).join("");

    return `
      <div class="view-head">
        <p class="view-insight">${esc(insight)}</p>
      </div>
      ${legendHtml([
        { label: "JI / Retune (.amxd/.adg) Projects", color: "var(--c3)" },
        { label: "Gamelan / Semaradana Projects", color: "var(--c2)" },
        { label: "Audio 12-TET Offset p50 (¢)", color: "var(--c1)" },
        { label: "Audio 12-TET Offset p75 (¢)", color: "var(--c4)", dashed: true }
      ])}
      <div class="grid-equal-2">
        <div class="subpanel">
          <div class="subpanel-title">
            <span>Microtonal Projects & Measured Audio Cent Offset</span>
            <span class="muted">Vocal vibrato also lifts Spirit Guides / Nihon offsets</span>
          </div>
          <div id="ji-stage-wrap" class="svg-stage">
            <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg>
          </div>
        </div>
        <div class="subpanel">
          <div class="subpanel-title">
            <span>Octave Cent-Ruler (0–1200¢ vs 12-TET)</span>
            <div class="sub-controls">
              <button id="btn-play-scale" type="button" class="btn btn-outline">▶ Hear Scale</button>
              <button id="btn-play-tet" type="button" class="btn btn-outline">▶ Hear 12-TET</button>
            </div>
          </div>
          <div class="segmented" style="margin-bottom:8px;flex-wrap:wrap">${scaleBtns}</div>
          <div class="svg-stage">
            <svg viewBox="0 0 ${rw} ${rh}" width="${rw}" height="${rh}">${rulerSvg}</svg>
          </div>
          <div class="muted" style="font-size:12px;margin-top:4px">${esc(sc.source_note)}</div>
          <div class="degree-pills">${degPills}</div>
        </div>
      </div>
      <div class="evidence-grid">${evidenceCards}</div>`;
  }

  function renderEraCompare(items) {
    const insight = "Overlay any two eras side by side across harmonic radar dimensions, 12-degree modal color balance, and Circle-of-Fifths key root gravity.";
    const idxA = Math.max(0, Math.min(items.length - 1, state.compareAIdx));
    const idxB = Math.max(0, Math.min(items.length - 1, state.compareBIdx));
    const a = items[idxA];
    const b = items[idxB];

    const optsA = items.map((it, i) => `<option value="${i}" ${i === idxA ? "selected" : ""}>${esc(it.label)} (${esc(it.sublabel)})</option>`).join("");
    const optsB = items.map((it, i) => `<option value="${i}" ${i === idxB ? "selected" : ""}>${esc(it.label)} (${esc(it.sublabel)})</option>`).join("");
    const presets = COMPARE_PRESETS.map((p) => `<button type="button" data-compare-preset="${p.id}" class="btn btn-outline">${esc(p.label)}</button>`).join("");

    // 1. 8-Axis Polar Harmonic Radar
    const sumGrp = (it, keys) => {
      const fh = it.fine_harmony;
      if (!fh || !fh.n_chords) return 0;
      return keys.reduce((acc, k) => acc + (fh.pcts[k] || 0), 0);
    };
    const axes = [
      { label: "4+ Chords", val: (it) => Math.min(100, (sumGrp(it, ["extended_9_11", "min7", "maj7", "dom7"]) / 30) * 100), raw: (it) => `${sumGrp(it, ["extended_9_11", "min7", "maj7", "dom7"]).toFixed(1)}%` },
      { label: "Triads/Sus", val: (it) => Math.min(100, (sumGrp(it, ["maj_triad", "min_triad", "sus2_4"]) / 45) * 100), raw: (it) => `${sumGrp(it, ["maj_triad", "min_triad", "sus2_4"]).toFixed(1)}%` },
      { label: "Open 4th/5th", val: (it) => Math.min(100, (sumGrp(it, ["dyad_4th", "dyad_5th"]) / 65) * 100), raw: (it) => `${sumGrp(it, ["dyad_4th", "dyad_5th"]).toFixed(1)}%` },
      { label: "Dark Modes", val: (it) => Math.min(100, ((it.dark_modal_pct || 0) / 70) * 100), raw: (it) => `${num(it.dark_modal_pct, "%")}` },
      { label: "Harm Minor", val: (it) => Math.min(100, ((it.harm_min_pct || 0) / 35) * 100), raw: (it) => `${num(it.harm_min_pct, "%")}` },
      { label: "Stepwise", val: (it) => Math.min(100, (((it.lead_step_pct ?? it.audio_step_pct) || 0) / 40) * 100), raw: (it) => `${num(it.lead_step_pct ?? it.audio_step_pct, "%")}` },
      { label: "Root 4th/5th", val: (it) => Math.min(100, ((it.root_motion.fourth_fifth_5_7 || 0) / 45) * 100), raw: (it) => `${num(it.root_motion.fourth_fifth_5_7, "%")}` },
      { label: "Micro Offset", val: (it) => Math.min(100, ((it.microtonal.tuning_offset_p50 || 0) / 25) * 100), raw: (it) => `${num(it.microtonal.tuning_offset_p50, "¢")}` },
    ];
    const rW = 340, rH = 290, rCx = 170, rCy = 148, rMax = 88;
    let radarSvg = "";
    [0.33, 0.66, 1].forEach((r) => {
      const pts = axes.map((_, i) => {
        const ang = (i / axes.length) * Math.PI * 2 - Math.PI / 2;
        return `${(rCx + r * rMax * Math.cos(ang)).toFixed(1)},${(rCy + r * rMax * Math.sin(ang)).toFixed(1)}`;
      }).join(" ");
      radarSvg += `<polygon points="${pts}" fill="none" stroke="var(--border-subtle)" stroke-width="1" />`;
    });
    axes.forEach((ax, i) => {
      const ang = (i / axes.length) * Math.PI * 2 - Math.PI / 2;
      const x2 = rCx + rMax * Math.cos(ang), y2 = rCy + rMax * Math.sin(ang);
      const lx = rCx + (rMax + 24) * Math.cos(ang), ly = rCy + (rMax + 18) * Math.sin(ang);
      radarSvg += `<line x1="${rCx}" y1="${rCy}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--border-subtle)" stroke-width="1" />`;
      const anchor = Math.abs(Math.cos(ang)) < 0.25 ? "middle" : Math.cos(ang) > 0 ? "start" : "end";
      radarSvg += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${anchor}" font-size="12" fill="var(--fg-muted)">${esc(ax.label)}</text>`;
    });
    [{ it: a, col: "var(--c1)" }, { it: b, col: "var(--c4)" }].forEach((s) => {
      const pts = axes.map((ax, i) => {
        const ang = (i / axes.length) * Math.PI * 2 - Math.PI / 2;
        const rad = (Math.max(4, ax.val(s.it)) / 100) * rMax;
        return `${(rCx + rad * Math.cos(ang)).toFixed(1)},${(rCy + rad * Math.sin(ang)).toFixed(1)}`;
      }).join(" ");
      radarSvg += `<polygon points="${pts}" fill="${s.col}" fill-opacity="0.20" stroke="${s.col}" stroke-width="2.2" />`;
    });

    // 2. 12-Degree Butterfly Chart
    const bW = 360, bH = 290, midX = 180, halfBarW = 128;
    const sdA = a.scale_degrees.combined_12 || Array(12).fill(0);
    const sdB = b.scale_degrees.combined_12 || Array(12).fill(0);
    const colorIdxs = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11]; // focus on non-1/5 harmonic degrees
    const maxDeg = Math.max(0.08, ...colorIdxs.map((i) => Math.max(sdA[i] || 0, sdB[i] || 0)));
    let buttSvg = `<line x1="${midX}" y1="18" x2="${midX}" y2="${bH - 12}" stroke="var(--border)" stroke-width="1" />`;
    buttSvg += `<text x="${midX - 10}" y="14" text-anchor="end" font-size="12" fill="var(--c1)" font-weight="600">${esc(a.shortLabel)}</text>`;
    buttSvg += `<text x="${midX + 10}" y="14" text-anchor="start" font-size="12" fill="var(--c4)" font-weight="600">${esc(b.shortLabel)}</text>`;
    colorIdxs.forEach((degIdx, row) => {
      const y = 28 + row * 25;
      const va = sdA[degIdx] || 0, vb = sdB[degIdx] || 0;
      const wa = (va / maxDeg) * (halfBarW - 28);
      const wb = (vb / maxDeg) * (halfBarW - 28);
      buttSvg += `<rect x="${(midX - 24 - wa).toFixed(1)}" y="${y}" width="${Math.max(1, wa).toFixed(1)}" height="14" rx="2" fill="var(--c1)" fill-opacity="0.85" />`;
      buttSvg += `<text x="${(midX - 28 - wa).toFixed(1)}" y="${y + 11}" text-anchor="end" font-size="12" fill="var(--fg-muted)">${(va * 100).toFixed(1)}%</text>`;
      buttSvg += `<text x="${midX}" y="${y + 11}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--fg)">${esc(DEGREE_INFO[degIdx].deg)}</text>`;
      buttSvg += `<rect x="${midX + 24}" y="${y}" width="${Math.max(1, wb).toFixed(1)}" height="14" rx="2" fill="var(--c4)" fill-opacity="0.85" />`;
      buttSvg += `<text x="${(midX + 28 + wb).toFixed(1)}" y="${y + 11}" text-anchor="start" font-size="12" fill="var(--fg-muted)">${(vb * 100).toFixed(1)}%</text>`;
    });

    // 3. Circle-of-Fifths Key Root Gravity Map
    const cW = 320, cH = 290, cCx = 160, cCy = 152, cRad = 96;
    const cofOrder = DATA.meta.cof_order;
    const cntA = a.key_roots.counts, cntB = b.key_roots.counts;
    const sumA = Math.max(1, cntA.reduce((x, y) => x + y, 0));
    const sumB = Math.max(1, cntB.reduce((x, y) => x + y, 0));
    let cofSvg = `<circle cx="${cCx}" cy="${cCy}" r="${cRad}" fill="none" stroke="var(--border)" stroke-width="1" />`;
    cofOrder.forEach((rootName, i) => {
      const ang = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const x = cCx + cRad * Math.cos(ang), y = cCy + cRad * Math.sin(ang);
      const lx = cCx + (cRad + 24) * Math.cos(ang), ly = cCy + (cRad + 24) * Math.sin(ang);
      const ra = 4 + (cntA[i] / sumA) * 52;
      const rb = 4 + (cntB[i] / sumB) * 52;
      if (cntA[i] > 0) cofSvg += `<circle cx="${(x - 3).toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.min(22, ra).toFixed(1)}" fill="var(--c1)" fill-opacity="0.48" stroke="var(--c1)" stroke-width="1.2"><title>${esc(a.label)} ${rootName}: ${cntA[i]}</title></circle>`;
      if (cntB[i] > 0) cofSvg += `<circle cx="${(x + 3).toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.min(22, rb).toFixed(1)}" fill="var(--c4)" fill-opacity="0.48" stroke="var(--c4)" stroke-width="1.2"><title>${esc(b.label)} ${rootName}: ${cntB[i]}</title></circle>`;
      cofSvg += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="600" fill="var(--fg)">${esc(rootName)}</text>`;
    });
    cofSvg += `<text x="${cCx}" y="${cCy + 4}" text-anchor="middle" font-size="12" fill="var(--fg-muted)">Key Roots</text>`;

    return `
      <div class="view-head">
        <p class="view-insight">${esc(insight)}</p>
      </div>
      <div class="compare-bar">
        <div class="select-pair">
          <span class="swatch" style="background:var(--c1)"></span>
          <strong>A:</strong>
          <select id="sel-comp-a" class="era-select">${optsA}</select>
          <span class="muted">vs</span>
          <span class="swatch" style="background:var(--c4)"></span>
          <strong>B:</strong>
          <select id="sel-comp-b" class="era-select">${optsB}</select>
        </div>
        <div class="sub-controls">${presets}</div>
      </div>
      <div class="grid-3">
        <div class="subpanel">
          <div class="subpanel-title"><span>8-Axis Harmonic Radar</span></div>
          <div class="svg-stage"><svg viewBox="0 0 ${rW} ${rH}" width="${rW}" height="${rH}">${radarSvg}</svg></div>
        </div>
        <div class="subpanel">
          <div class="subpanel-title"><span>10 Color Scale Degrees (% of Pitched Notes)</span></div>
          <div class="svg-stage"><svg viewBox="0 0 ${bW} ${bH}" width="${bW}" height="${bH}">${buttSvg}</svg></div>
        </div>
        <div class="subpanel">
          <div class="subpanel-title"><span>Circle of Fifths Key Center Gravity</span></div>
          <div class="svg-stage"><svg viewBox="0 0 ${cW} ${cH}" width="${cW}" height="${cH}">${cofSvg}</svg></div>
        </div>
      </div>`;
  }

  // ---- CORE 5 EVOLUTION TABS ----

  function renderWorkflow(items, d, selIdx) {
    const insight = "MIDI-heavy 2013–18 production pivoted sharply to multi-track audio assemblies in 2018–22 (Psychedailies 14 audio / 1 MIDI track), balancing into a hybrid studio workflow in 2024–26.";
    const W = Math.max(460, measureStageWidth("wf-stage-wrap", 960));
    const H = 300;
    const padL = 48, padR = 46, padT = state.granularity === "eras" ? 26 : 16, padB = 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);
    const bw = Math.max(5, Math.min(24, (colW - 10) / 2));
    const maxRaw = Math.max(...items.map((it) => Math.max(it.midi_pitched_notes || 0, it.audio_notes || 0)));
    const scaleMax = Math.max(5000, Math.ceil(maxRaw / 5000) * 5000);

    let svg = phaseDividerLayer(W, padL, plotW, padT, plotH);
    svg += gridAxesLayer(padL, plotW, padT, plotH, [0, 0.5, 1], (r) => r === 0 ? "0" : `${Math.round((r * scaleMax) / 1000)}k`, (r) => `${Math.round(r * 100)}%`);

    const sharePts = [];
    items.forEach((it, i) => {
      const cx = xC(i);
      const hM = ((it.midi_pitched_notes || 0) / scaleMax) * plotH;
      const hA = ((it.audio_notes || 0) / scaleMax) * plotH;
      svg += `<rect x="${(cx - bw - 1).toFixed(1)}" y="${(padT + plotH - hM).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, hM).toFixed(1)}" rx="2" fill="var(--c1)" fill-opacity="${i === selIdx ? 1 : 0.82}" />`;
      svg += `<rect x="${(cx + 1).toFixed(1)}" y="${(padT + plotH - hA).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, hA).toFixed(1)}" rx="2" fill="var(--c2)" fill-opacity="${i === selIdx ? 1 : 0.82}" />`;
      const sh = audioSharePct(it);
      sharePts.push(sh === null ? null : { x: cx, y: padT + plotH * (1 - sh / 100) });
    });

    svg += `<path d="${svgLinePath(sharePts)}" fill="none" stroke="var(--c3)" stroke-width="2.4" />`;
    sharePts.forEach((pt, i) => {
      if (!pt) return;
      svg += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${i === selIdx ? 5 : 3.5}" fill="var(--c3)" stroke="var(--bg-card)" stroke-width="1.5" />`;
    });
    svg += xAxisAndHitLayer(items, padL, plotW, padT, plotH, H, selIdx);

    return `
      <div class="view-head"><p class="view-insight">${esc(insight)}</p></div>
      ${legendHtml([
        { label: "MIDI Pitched Notes", color: "var(--c1)" },
        { label: "Audio Pitched Notes", color: "var(--c2)" },
        { label: "Audio Track Share %", color: "var(--c3)" }
      ])}
      <div class="subpanel"><div id="wf-stage-wrap" class="svg-stage"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg></div></div>`;
  }

  function renderGroove(items, d, selIdx) {
    const insight = "From loose live playing (6–13% quantized across early/mid/ambient tracks) to locked drum (70–100%) and 808 bass (Ecstatic Wave 76.5%) pockets around 120 BPM.";
    const W = Math.max(460, measureStageWidth("gr-stage-wrap", 960));
    const H = 300;
    const padL = 46, padR = 46, padT = state.granularity === "eras" ? 26 : 16, padB = 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);
    const bpmMin = 60, bpmMax = 160;
    const yPct = (p) => p === null || !Number.isFinite(p) ? null : padT + plotH * (1 - p / 100);
    const yBpm = (b) => b === null || !Number.isFinite(b) ? null : padT + plotH * (1 - Math.max(0, Math.min(1, (b - bpmMin) / (bpmMax - bpmMin))));

    let svg = phaseDividerLayer(W, padL, plotW, padT, plotH);
    svg += gridAxesLayer(padL, plotW, padT, plotH, [0, 0.5, 1], (r) => `${Math.round(r * 100)}%`, (r) => `${Math.round(bpmMin + r * (bpmMax - bpmMin))}`);

    const topPts = items.map((it, i) => `${xC(i).toFixed(1)},${yBpm(it.bpm_p75).toFixed(1)}`);
    const botPts = items.map((it, i) => `${xC(i).toFixed(1)},${yBpm(it.bpm_p25).toFixed(1)}`).reverse();
    svg += `<polygon points="${topPts.concat(botPts).join(" ")}" fill="var(--c3)" fill-opacity="0.16" />`;
    svg += `<path d="${svgLinePath(items.map((it, i) => ({ x: xC(i), y: yBpm(it.bpm_p50) })))}" fill="none" stroke="var(--c3)" stroke-width="2" stroke-dasharray="4,3" />`;

    [
      { key: "quant_drum_pct", col: "var(--c1)" },
      { key: "quant_bass_pct", col: "var(--c2)" },
      { key: "quant_pitched_pct", col: "var(--c4)" },
    ].forEach((s) => {
      const pts = items.map((it, i) => ({ x: xC(i), y: yPct(it[s.key]) }));
      svg += `<path d="${svgLinePath(pts)}" fill="none" stroke="${s.col}" stroke-width="2.3" />`;
      pts.forEach((pt, i) => {
        if (pt.y === null) return;
        svg += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${i === selIdx ? 4.8 : 3.2}" fill="${s.col}" stroke="var(--bg-card)" stroke-width="1.3" />`;
      });
    });

    svg += xAxisAndHitLayer(items, padL, plotW, padT, plotH, H, selIdx);
    return `
      <div class="view-head"><p class="view-insight">${esc(insight)}</p></div>
      ${legendHtml([
        { label: "Drum Quantized %", color: "var(--c1)" },
        { label: "Bass Quantized %", color: "var(--c2)" },
        { label: "Pitched Quantized %", color: "var(--c4)" },
        { label: "BPM Median (IQR band)", color: "var(--c3)", dashed: true }
      ])}
      <div class="subpanel"><div id="gr-stage-wrap" class="svg-stage"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg></div></div>`;
  }

  function renderMelody(items, d, selIdx) {
    const insight = "Stepwise lyricism and post-leap gap-fill rose dramatically in Ecstatic Wave (38.0% stepwise, 29.5% gap-fill) & Sketches 2026 while keeping >43% melodic breathing space.";
    const W = Math.max(460, measureStageWidth("mel-stage-wrap", 960));
    const H = 300;
    const padL = 46, padR = 52, padT = state.granularity === "eras" ? 26 : 16, padB = 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);
    const yPct = (p) => p === null || !Number.isFinite(p) ? null : padT + plotH * (1 - Math.min(1, p / 50));
    const mMin = 42, mMax = 76;
    const yMidi = (m) => m === null || !Number.isFinite(m) ? null : padT + plotH * (1 - Math.max(0, Math.min(1, (m - mMin) / (mMax - mMin))));

    let svg = phaseDividerLayer(W, padL, plotW, padT, plotH);
    svg += gridAxesLayer(padL, plotW, padT, plotH, [0, 0.5, 1], (r) => `${Math.round(r * 50)}%`, (r) => `M${Math.round(mMin + r * (mMax - mMin))}`);

    [
      { fn: (it) => yPct(it.lead_step_pct), col: "var(--c1)", dashed: false },
      { fn: (it) => yPct(it.lead_gapfill_pct), col: "var(--c6)", dashed: false },
      { fn: (it) => yMidi(it.lead_midi_p50), col: "var(--c3)", dashed: true },
      { fn: (it) => yMidi(it.audio_midi_p50), col: "var(--c2)", dashed: true },
    ].forEach((s) => {
      const pts = items.map((it, i) => ({ x: xC(i), y: s.fn(it) }));
      svg += `<path d="${svgLinePath(pts)}" fill="none" stroke="${s.col}" stroke-width="2.3" ${s.dashed ? 'stroke-dasharray="4,3"' : ""} />`;
      pts.forEach((pt, i) => {
        if (pt.y === null) return;
        svg += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${i === selIdx ? 4.8 : 3.2}" fill="${s.col}" stroke="var(--bg-card)" stroke-width="1.3" />`;
      });
    });

    svg += xAxisAndHitLayer(items, padL, plotW, padT, plotH, H, selIdx);
    return `
      <div class="view-head"><p class="view-insight">${esc(insight)}</p></div>
      ${legendHtml([
        { label: "MIDI Lead Stepwise %", color: "var(--c1)" },
        { label: "Leap→Step Gap-Fill %", color: "var(--c6)" },
        { label: "MIDI Lead Register", color: "var(--c3)", dashed: true },
        { label: "Audio Melodic Register", color: "var(--c2)", dashed: true }
      ])}
      <div class="subpanel"><div id="mel-stage-wrap" class="svg-stage"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg></div></div>`;
  }

  function renderAudioExp(items, d, selIdx) {
    const insight = "Expressive phrasing lives in your audio stems: audio legato climbed from 31% to 48–52% (80.5% in Spirit Guides) with 48–74¢ vibrato & pitch bends.";
    const W = Math.max(460, measureStageWidth("au-stage-wrap", 960));
    const H = 300;
    const padL = 46, padR = 48, padT = state.granularity === "eras" ? 26 : 16, padB = 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);
    const bw = Math.max(10, Math.min(40, colW * 0.5));
    const yPct = (p) => p === null || !Number.isFinite(p) ? null : padT + plotH * (1 - p / 100);
    const yCents = (c) => c === null || !Number.isFinite(c) ? null : padT + plotH * (1 - Math.min(1, c / 90));

    let svg = phaseDividerLayer(W, padL, plotW, padT, plotH);
    svg += gridAxesLayer(padL, plotW, padT, plotH, [0, 0.5, 1], (r) => `${Math.round(r * 100)}%`, (r) => `${Math.round(r * 90)}¢`);

    items.forEach((it, i) => {
      const cx = xC(i);
      const s = it.audio_sources || {};
      const tot = ["vocal", "guitar_live_inst", "bass_audio", "synth_stem", "other_musical"].reduce((a, k) => a + (s[k] || 0), 0);
      if (tot > 0) {
        const vh = (((s.vocal || 0) + (s.guitar_live_inst || 0)) / tot) * plotH;
        const bh = (((s.bass_audio || 0) + (s.synth_stem || 0)) / tot) * plotH;
        const oh = Math.max(0, plotH - vh - bh);
        svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${oh.toFixed(1)}" fill="var(--c8)" fill-opacity="0.22" />`;
        svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${(padT + oh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="var(--c5)" fill-opacity="0.28" />`;
        svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${(padT + oh + bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${vh.toFixed(1)}" fill="var(--c2)" fill-opacity="0.34" />`;
      }
    });

    [
      { fn: (it) => yPct(it.audio_legato_pct), col: "var(--c1)", dashed: false },
      { fn: (it) => yPct(it.midi_legato_pct), col: "var(--c6)", dashed: true },
      { fn: (it) => yCents(it.audio_vib_cents), col: "var(--c4)", dashed: false },
    ].forEach((s) => {
      const pts = items.map((it, i) => ({ x: xC(i), y: s.fn(it) }));
      svg += `<path d="${svgLinePath(pts)}" fill="none" stroke="${s.col}" stroke-width="2.4" ${s.dashed ? 'stroke-dasharray="4,3"' : ""} />`;
      pts.forEach((pt, i) => {
        if (pt.y === null) return;
        svg += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${i === selIdx ? 4.8 : 3.2}" fill="${s.col}" stroke="var(--bg-card)" stroke-width="1.3" />`;
      });
    });

    svg += xAxisAndHitLayer(items, padL, plotW, padT, plotH, H, selIdx);
    return `
      <div class="view-head"><p class="view-insight">${esc(insight)}</p></div>
      ${legendHtml([
        { label: "Audio Legato %", color: "var(--c1)" },
        { label: "MIDI Lead Legato %", color: "var(--c6)", dashed: true },
        { label: "Audio Vibrato/Bend ¢", color: "var(--c4)" },
        { label: "Vocal + Live Inst Share (bg)", color: "var(--c2)" }
      ])}
      <div class="subpanel"><div id="au-stage-wrap" class="svg-stage"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg></div></div>`;
  }

  function renderPalette(items, d, selIdx) {
    const insight = "Synth & processing evolution: Maschine, Battery 4 & Diva racks → Omnisphere & UltraAnalog → Chromaphone & Satin → Live 12 P&L/Move presets, Sub 808 & Ducker BT.";
    const cards = items.map((it, i) => {
      const badge = it.daw ? it.daw : `${it.phaseTag} · ${it.sublabel}`;
      const insts = (it.top_inst || []).map((x) => `<span class="gear-pill" title="${esc(x)}">${esc(x)}</span>`).join("");
      const fxs = (it.top_fx || []).map((x) => `<span class="gear-pill fx" title="${esc(x)}">${esc(x)}</span>`).join("");
      const modes = (it.top_modes_midi || []).slice(0, 2).join(" / ") || "n/a";
      return `
        <button type="button" data-era-idx="${i}" class="palette-card ${i === selIdx ? "active" : ""}">
          <div>
            <div style="display:flex;justify-content:space-between;gap:6px;margin-bottom:6px">
              <strong style="font-size:13px">${esc(it.label)}</strong>
              <span class="muted" style="font-size:12px">${esc(badge)}</span>
            </div>
            <div class="pill-stack" style="margin-bottom:6px">${insts}</div>
            <div class="pill-stack">${fxs}</div>
          </div>
          <div class="muted" style="font-size:12px;border-top:1px solid var(--border-subtle);padding-top:6px">Modes: ${esc(modes)}</div>
        </button>`;
    }).join("");

    return `
      <div class="view-head"><p class="view-insight">${esc(insight)}</p></div>
      ${legendHtml([{ label: "Top Instruments", color: "var(--c1)" }, { label: "Top Effects", color: "var(--c2)" }])}
      <div class="palette-cards">${cards}</div>`;
  }

  // ---------------- INSPECTOR BAR ----------------

  function renderInspector(items, selIdx) {
    const d = items[selIdx];
    const isHover = state.hoverIdx !== null && state.hoverIdx !== getPinnedIdx();
    const badge = isHover ? "Preview (click to pin)" : "Pinned";
    const subTag = d.daw ? `${d.sublabel} · ${d.daw}` : `${d.sublabel}${d.phaseTag ? ` · ${d.phaseTag}` : ""}`;

    let cards = [];
    let foot = d.note || "";

    if (state.tab === "chord-quality") {
      const fh = d.fine_harmony;
      const sortedF = FINE_CHORD_META.map((m) => ({ label: m.label, pct: fh.pcts[m.key] })).filter((x) => x.pct !== null).sort((x, y) => y.pct - x.pct);
      const top2 = sortedF.slice(0, 2).map((x) => `${x.label} ${x.pct}%`).join(", ") || "n/a";
      const sum7 = ["min7", "maj7", "dom7", "extended_9_11"].reduce((a, k) => a + (fh.pcts[k] || 0), 0).toFixed(1);
      cards = [
        { k: "Top Harmonic Flavors", v: top2 },
        { k: "7th + Extended Share", v: fh.n_chords > 0 ? `${sum7}% (${fh.n_chords} total)` : "Audio-first" },
        { k: "Open 4th + 5th Dyads", v: fh.n_chords > 0 ? `${((fh.pcts.dyad_4th || 0) + (fh.pcts.dyad_5th || 0)).toFixed(1)}%` : "n/a" },
        { k: "Voicing Span Med (IQR)", v: `${num(d.voicing_register.span_p50, " st")} (${num(d.voicing_register.span_p25)}–${num(d.voicing_register.span_p75)})` },
      ];
      foot = foot || `Top MIDI modes: ${(d.top_modes_midi || []).join(", ") || "n/a"} · Audio modes: ${(d.top_modes_audio || []).join(", ") || "n/a"}.`;
    } else if (state.tab === "root-motion") {
      const rm = d.root_motion;
      cards = [
        { k: "0 st Pedal Repeat", v: num(rm.pedal_pct, "%") },
        { k: "±1 st Phrygian Slides", v: num(rm.semitone_1_11, "%") },
        { k: "±2 st Whole-Step Planing", v: num(rm.wholestep_2_10, "%") },
        { k: "±5 st (4th / 5th Gravity)", v: num(rm.fourth_fifth_5_7, "%") },
      ];
      foot = foot || `${rm.n_moves} non-pedal chord root moves analyzed (${rm.n_total} total transitions).`;
    } else if (state.tab === "modal-heatmap") {
      const sd = d.scale_degrees[state.heatmapSource];
      cards = [
        { k: "Dark Modal Share", v: num(d.dark_modal_pct, "%") },
        { k: "Harmonic Minor Share", v: num(d.harm_min_pct, "%") },
        { k: "Phrygian b2 / Maj 3", v: sd ? `${(sd[1] * 100).toFixed(1)}% b2 · ${(sd[4] * 100).toFixed(1)}% 3` : "n/a" },
        { k: "Min b3 / Dorian 6", v: sd ? `${(sd[3] * 100).toFixed(1)}% b3 · ${(sd[9] * 100).toFixed(1)}% 6` : "n/a" },
      ];
      foot = foot || `MIDI modes: ${(d.top_modes_midi || []).join(", ")} · Audio modes: ${(d.top_modes_audio || []).join(", ")}.`;
    } else if (state.tab === "voicing-spread") {
      const vr = d.voicing_register;
      cards = [
        { k: "Chord Floor (low p50)", v: midiName(vr.low_p50) },
        { k: "Chord Ceiling (high p50)", v: midiName(vr.high_p50) },
        { k: "Span p10 / p50 / p90", v: `${num(vr.span_p10)} / ${num(vr.span_p50)} / ${num(vr.span_p90, " st")}` },
        { k: "Lead / Audio / Bass Med", v: `${midiName(d.lead_midi_p50)} · Ba ${num(d.bass_midi_p50)}` },
      ];
      foot = foot || `Audio melodic register median: ${midiName(d.audio_midi_p50)}.`;
    } else if (state.tab === "ji-gamelan") {
      const mt = d.microtonal;
      cards = [
        { k: "JI / Retune Projects", v: `${mt.ji_retune_projects} projects` },
        { k: "Gamelan / Semaradana", v: `${mt.gamelan_projects} projects` },
        { k: "Audio 12-TET Offset Med", v: num(mt.tuning_offset_p50, "¢") },
        { k: "Audio Offset p75 (Tail)", v: num(mt.tuning_offset_p75, "¢") },
      ];
      foot = mt.evidence && mt.evidence.length ? `Discovered tracks/racks: ${mt.evidence.slice(0, 2).join(" | ")}` : "Standard 12-TET tuning across MIDI clips; audio cent offset reflects vibrato/human intonation.";
    } else if (state.tab === "era-compare") {
      const a = items[Math.max(0, Math.min(items.length - 1, state.compareAIdx))];
      const b = items[Math.max(0, Math.min(items.length - 1, state.compareBIdx))];
      const extA = ["min7", "maj7", "dom7", "extended_9_11"].reduce((acc, k) => acc + (a.fine_harmony.pcts[k] || 0), 0).toFixed(1);
      const extB = ["min7", "maj7", "dom7", "extended_9_11"].reduce((acc, k) => acc + (b.fine_harmony.pcts[k] || 0), 0).toFixed(1);
      cards = [
        { k: "4+ Chord Share (A vs B)", v: `${extA}% → ${extB}%` },
        { k: "Dark Modal (A vs B)", v: `${num(a.dark_modal_pct, "%")} → ${num(b.dark_modal_pct, "%")}` },
        { k: "4th/5th Root Move", v: `${num(a.root_motion.fourth_fifth_5_7, "%")} → ${num(b.root_motion.fourth_fifth_5_7, "%")}` },
        { k: "Tempo Med (A vs B)", v: `${num(a.bpm_p50)} → ${num(b.bpm_p50)} BPM` },
      ];
      foot = `Comparing ${a.label} (${a.projects} projects) vs ${b.label} (${b.projects} projects).`;
    } else if (state.tab === "workflow") {
      cards = [
        { k: "Median Tracks (MIDI / Aud)", v: `${num(d.midi_tracks_med)} / ${num(d.audio_tracks_med)} (${num(audioSharePct(d), "% aud")})` },
        { k: "MIDI Pitched Notes", v: `${(d.midi_pitched_notes || 0).toLocaleString()} (${d.midi_pitched_clips} clips)` },
        { k: "Audio Pitched Notes", v: `${(d.audio_notes || 0).toLocaleString()} (${d.audio_files} files)` },
        { k: "Median Song Length", v: `${num(d.minutes_med, " min")} · ${d.midi_drum_clips} drums` },
      ];
    } else if (state.tab === "groove") {
      cards = [
        { k: "Tempo BPM Med (IQR)", v: `${num(d.bpm_p50)} (${num(d.bpm_p25)}–${num(d.bpm_p75)})` },
        { k: "Quantized (Dr / Ba / Pitch)", v: `${num(d.quant_drum_pct, "%")} / ${num(d.quant_bass_pct, "%")} / ${num(d.quant_pitched_pct, "%")}` },
        { k: "Timing Jitter Med", v: num(d.jitter_ms, " ms") },
        { k: "Vel Std / Syncopation", v: `${num(d.vel_std)} · ${num(d.syncopation_pct, "%")}` },
      ];
    } else if (state.tab === "melody") {
      cards = [
        { k: "Stepwise / Gap-Fill", v: `${num(d.lead_step_pct, "%")} · ${num(d.lead_gapfill_pct, "%")}` },
        { k: "MIDI Lead Register", v: midiName(d.lead_midi_p50) },
        { k: "Audio / Bass Register", v: `${midiName(d.audio_midi_p50)} · Ba ${num(d.bass_midi_p50)}` },
        { k: "Rest Space (MIDI / Aud)", v: `${num(d.lead_rest_pct, "%")} / ${num(d.audio_rest_pct, "%")}` },
      ];
    } else if (state.tab === "audio") {
      const s = d.audio_sources || {};
      cards = [
        { k: "Audio vs MIDI Legato", v: `${num(d.audio_legato_pct, "%")} aud · ${num(d.midi_legato_pct, "%")} midi` },
        { k: "Vibrato / Bend Depth", v: num(d.audio_vib_cents, "¢") },
        { k: "Audio Glide / Stepwise", v: `${num(d.audio_glide_cents, "¢")} · ${num(d.audio_step_pct, "%")}` },
        { k: "Source Stems", v: `${s.vocal || 0} voc · ${s.guitar_live_inst || 0} gtr · ${s.bass_audio || 0} ba` },
      ];
    } else {
      cards = [
        { k: "Top Instruments", v: (d.top_inst || []).slice(0, 3).join(", ") || "n/a" },
        { k: "Top FX", v: (d.top_fx || []).slice(0, 3).join(", ") || "n/a" },
        { k: "Top MIDI Modes", v: (d.top_modes_midi || []).join(", ") || "n/a" },
        { k: "Top Audio Modes", v: (d.top_modes_audio || []).join(", ") || "n/a" },
      ];
    }

    document.getElementById("inspector").innerHTML = `
      <div class="inspector-top">
        <div class="inspector-title">
          <strong>${esc(d.label)}</strong>
          <span class="muted">${esc(subTag)}</span>
          <span class="badge ${isHover ? "badge-muted" : ""}">${esc(badge)}</span>
        </div>
        <span class="mono muted">${d.projects} projects · ${d.midi_pitched_clips + d.midi_drum_clips} MIDI clips · ${d.audio_files} audio stems</span>
      </div>
      <div class="inspector-metrics">
        ${cards.map((c) => `
          <div class="metric-box">
            <div class="metric-label">${esc(c.k)}</div>
            <div class="metric-val" title="${esc(c.v)}">${esc(c.v)}</div>
          </div>`).join("")}
      </div>
      ${foot ? `<div class="inspector-foot">${esc(foot)}</div>` : ""}`;
  }

  function renderTabs() {
    const harmEl = document.getElementById("tab-row-harmony");
    const evoEl = document.getElementById("tab-row-evolution");
    const btnHtml = (t) => `
      <button type="button" data-tab="${t.id}" class="tab-btn ${state.tab === t.id ? "active" : ""}">
        <span>${esc(t.label)}</span>${t.tag ? `<span class="tab-tag">${esc(t.tag)}</span>` : ""}
      </button>`;
    harmEl.innerHTML = `<span class="tab-row-label">Harmony & Tuning</span>` + TABS.filter((t) => t.group === "harmony").map(btnHtml).join("");
    evoEl.innerHTML = `<span class="tab-row-label">Track & Sound</span>` + TABS.filter((t) => t.group === "evolution").map(btnHtml).join("");
  }

  function render() {
    const btnEras = document.getElementById("btn-eras");
    const btnPhases = document.getElementById("btn-phases");
    const btnTheme = document.getElementById("btn-theme");
    btnEras.className = `btn ${state.granularity === "eras" ? "active" : ""}`;
    btnPhases.className = `btn ${state.granularity === "phases" ? "active" : ""}`;
    btnTheme.textContent = state.theme === "dark" ? "Light theme" : "Dark theme";
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.setAttribute("data-theme", state.theme);
    }

    renderTabs();
    const items = currentItems();
    const selIdx = activeIdx();
    const d = items[selIdx];

    let html = "";
    switch (state.tab) {
      case "chord-quality": html = renderChordQuality(items, d, selIdx); break;
      case "root-motion": html = renderRootMotion(items, d, selIdx); break;
      case "modal-heatmap": html = renderModalHeatmap(items, d, selIdx); break;
      case "voicing-spread": html = renderVoicingSpread(items, d, selIdx); break;
      case "ji-gamelan": html = renderJiGamelan(items, d, selIdx); break;
      case "era-compare": html = renderEraCompare(items); break;
      case "workflow": html = renderWorkflow(items, d, selIdx); break;
      case "groove": html = renderGroove(items, d, selIdx); break;
      case "melody": html = renderMelody(items, d, selIdx); break;
      case "audio": html = renderAudioExp(items, d, selIdx); break;
      case "palette": html = renderPalette(items, d, selIdx); break;
      default: html = renderChordQuality(items, d, selIdx);
    }
    document.getElementById("stage-card").innerHTML = html;
    renderInspector(items, selIdx);
  }

  function setTab(tabId) {
    if (!TABS.some((t) => t.id === tabId)) return;
    state.tab = tabId;
    if (tabId === "ji-gamelan" && !state.jiAutoDone && !state.userPinned) {
      state.jiAutoDone = true;
      state.pinnedEraIdx = 3; // Le Garage Hermétique
      state.pinnedPhaseIdx = 1; // Phase 2 Mid
      state.hoverIdx = null;
    }
    try {
      if (typeof history !== "undefined" && history.replaceState) {
        history.replaceState(null, "", `#${tabId}`);
      }
    } catch (_) {}
    render();
  }

  // Event delegation
  function wireEvents() {
    document.getElementById("btn-eras").addEventListener("click", () => {
      if (state.granularity === "eras") return;
      state.granularity = "eras";
      state.compareAIdx = 1;
      state.compareBIdx = 11;
      state.hoverIdx = null;
      render();
    });
    document.getElementById("btn-phases").addEventListener("click", () => {
      if (state.granularity === "phases") return;
      state.granularity = "phases";
      state.compareAIdx = 0;
      state.compareBIdx = 3;
      state.hoverIdx = null;
      render();
    });
    document.getElementById("btn-theme").addEventListener("click", () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      render();
    });

    const tabNav = document.querySelector(".tab-groups");
    tabNav.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-tab]");
      if (btn) setTab(btn.getAttribute("data-tab"));
    });

    const stage = document.getElementById("stage-card");
    stage.addEventListener("click", (ev) => {
      const sub = ev.target.closest("[data-sub]");
      if (sub) {
        const [k, v] = sub.getAttribute("data-sub").split(":");
        state[k] = v === "true" ? true : v === "false" ? false : v;
        render();
        return;
      }
      const centEl = ev.target.closest("[data-play-cent]");
      if (centEl) {
        triggerBellNote(parseFloat(centEl.getAttribute("data-play-cent")));
        return;
      }
      if (ev.target.closest("#btn-play-scale")) {
        const sc = DATA.meta.tuning_scales[state.tuningScaleId] || DATA.meta.tuning_scales.semeradana;
        auditionScale(sc);
        return;
      }
      if (ev.target.closest("#btn-play-tet")) {
        audition12TetRef();
        return;
      }
      const presetBtn = ev.target.closest("[data-compare-preset]");
      if (presetBtn) {
        const p = COMPARE_PRESETS.find((x) => x.id === presetBtn.getAttribute("data-compare-preset"));
        if (p) {
          const items = currentItems();
          const idA = state.granularity === "eras" ? p.eraA : p.phA;
          const idB = state.granularity === "eras" ? p.eraB : p.phB;
          state.compareAIdx = Math.max(0, items.findIndex((x) => x.id === idA));
          state.compareBIdx = Math.max(0, items.findIndex((x) => x.id === idB));
          render();
        }
        return;
      }
      const jumpCard = ev.target.closest("[data-jump-era]");
      if (jumpCard) {
        const eraId = jumpCard.getAttribute("data-jump-era");
        if (state.granularity === "eras") {
          const idx = DATA.eras.findIndex((e) => e.id === eraId);
          if (idx >= 0) { setPinnedIdx(idx, true); render(); }
        }
        return;
      }
      const eraHit = ev.target.closest("[data-era-idx]");
      if (eraHit) {
        const idx = Number(eraHit.getAttribute("data-era-idx"));
        if (Number.isFinite(idx)) {
          setPinnedIdx(idx, true);
          render();
        }
      }
    });

    stage.addEventListener("change", (ev) => {
      if (ev.target && ev.target.id === "sel-comp-a") {
        state.compareAIdx = Number(ev.target.value) || 0;
        render();
      } else if (ev.target && ev.target.id === "sel-comp-b") {
        state.compareBIdx = Number(ev.target.value) || 0;
        render();
      }
    });

    stage.addEventListener("mousemove", (ev) => {
      const hit = ev.target.closest("[data-era-idx]");
      if (!hit) return;
      const idx = Number(hit.getAttribute("data-era-idx"));
      if (Number.isFinite(idx) && state.hoverIdx !== idx) {
        state.hoverIdx = idx;
        renderInspector(currentItems(), activeIdx());
      }
    });

    stage.addEventListener("mouseleave", () => {
      if (state.hoverIdx !== null) {
        state.hoverIdx = null;
        renderInspector(currentItems(), activeIdx());
      }
    });

    if (typeof window !== "undefined") {
      window.addEventListener("hashchange", () => {
        const h = (window.location.hash || "").replace(/^#/, "");
        if (TABS.some((t) => t.id === h) && h !== state.tab) setTab(h);
      });
      if (typeof ResizeObserver !== "undefined") {
        let lastW = stage.clientWidth;
        new ResizeObserver(() => {
          if (Math.abs(stage.clientWidth - lastW) > 12) {
            lastW = stage.clientWidth;
            render();
          }
        }).observe(stage);
      }
    }
  }

  parseInitialHash();
  wireEvents();
  render();

  if (typeof globalThis !== "undefined") {
    globalThis.__APP_TEST__ = { state, setTab, render, TABS, COMPARE_PRESETS, currentItems };
  }
})();
