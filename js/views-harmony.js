// Harmony, Macro Harmony & Energy, Timeline Animator & Tuning Renderers
(function () {
  "use strict";

  const FINE_CHORD_META = [
    { key: "extended_9_11", label: "Extended 9th / 11th", color: "var(--c1)" },
    { key: "min7", label: "Minor 7th", color: "var(--c2)" },
    { key: "maj7", label: "Major 7th", color: "var(--c2)" },
    { key: "dom7", label: "Dominant 7th", color: "var(--c2)" },
    { key: "maj_triad", label: "Major Triad", color: "var(--c4)" },
    { key: "min_triad", label: "Minor Triad", color: "var(--c4)" },
    { key: "sus2_4", label: "Sus2 / Sus4", color: "var(--c4)" },
    { key: "dim_aug", label: "Dim / Aug", color: "var(--c4)" },
    { key: "quartal_cluster", label: "Quartal / Cluster", color: "var(--c6)" },
    { key: "dyad_3rd_6th", label: "Dyad: 3rd / 6th", color: "var(--c5)" },
    { key: "dyad_5th", label: "Dyad: Open 5th", color: "var(--c3)" },
    { key: "dyad_4th", label: "Dyad: Open 4th", color: "var(--c3)" },
    { key: "dyad_2nd_m7", label: "Dyad: 2nd / b7", color: "var(--c8)" },
    { key: "dyad_semitone_M7", label: "Dyad: b2 / M7", color: "var(--c7)" },
    { key: "dyad_tritone", label: "Dyad: Tritone", color: "var(--c7)" },
  ];

  const CHORD_STACK_GROUPS = [
    { id: "ext", label: "Extended 9/11", keys: ["extended_9_11"], color: "var(--c1)" },
    { id: "seventh", label: "7ths (min7/maj7/dom7)", keys: ["min7", "maj7", "dom7"], color: "var(--c2)" },
    { id: "triad", label: "Triads & Sus", keys: ["maj_triad", "min_triad", "sus2_4", "dim_aug"], color: "var(--c4)" },
    { id: "quartal", label: "Quartal / Cluster", keys: ["quartal_cluster"], color: "var(--c6)" },
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

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function num(v, suffix = "", digits = 1) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
    const f = Number(v).toFixed(digits).replace(/\.0$/, "");
    return suffix ? `${f}${suffix}` : f;
  }

  function midiName(m) {
    if (m === null || m === undefined || !Number.isFinite(m)) return "n/a";
    const names = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
    const r = Math.round(m);
    return `${names[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1} (${Math.round(m)})`;
  }

  function measureStageWidth(id, fallback = 860) {
    const el = typeof document !== "undefined" ? document.getElementById(id) : null;
    if (!el || !el.clientWidth || el.clientWidth < 120) return fallback;
    return Math.floor(el.clientWidth);
  }

  function svgLinePath(points) {
    let d = "";
    let open = false;
    for (const pt of points) {
      if (!pt || pt.y === null || !Number.isFinite(pt.y)) { open = false; continue; }
      d += `${open ? "L" : "M"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
      open = true;
    }
    return d;
  }

  function legendHtml(items) {
    return `<div class="legend-row">${items.map((it) => {
      const sw = it.dashed
        ? `<span class="swatch-line" style="border-color:${it.color}"></span>`
        : `<span class="swatch" style="background:${it.color}"></span>`;
      return `<span class="legend-item">${sw}<span>${esc(it.label)}</span></span>`;
    }).join("")}</div>`;
  }

  function phaseDividerLayer(items, state, padL, plotW, padT, plotH) {
    if (state.granularity !== "eras" || !items.length) return "";
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);
    const groups = [];
    items.forEach((it, idx) => {
      const pTag = it.phaseTag || "";
      const last = groups[groups.length - 1];
      if (!last || last.tag !== pTag) groups.push({ tag: pTag, start: idx, end: idx });
      else last.end = idx;
    });
    let out = "";
    groups.forEach((g, gi) => {
      const cx = (xC(g.start) + xC(g.end)) / 2;
      out += `<text x="${cx.toFixed(1)}" y="14" text-anchor="middle" font-size="11" fill="var(--fg-dim)" font-weight="600">${esc(g.tag)}</text>`;
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
      if (fmtLeft) out += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--fg-muted)">${esc(fmtLeft(norm))}</text>`;
      if (fmtRight) out += `<text x="${padL + plotW + 8}" y="${(y + 4).toFixed(1)}" text-anchor="start" font-size="11" fill="var(--fg-muted)">${esc(fmtRight(norm))}</text>`;
    }
    return out;
  }

  function xAxisAndHitLayer(items, state, padL, plotW, padT, plotH, H, selIdx) {
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);
    const selX = padL + colW * selIdx;
    let out = `<rect x="${(selX + 2).toFixed(1)}" y="${padT}" width="${Math.max(4, colW - 4).toFixed(1)}" height="${plotH}" rx="4" fill="var(--primary)" fill-opacity="0.11" stroke="var(--primary)" stroke-opacity="${state.hoverIdx !== null ? 0.45 : 0.78}" stroke-width="1.2" />`;
    const narrow = colW < 42;
    items.forEach((d, i) => {
      const cx = xC(i);
      const isSel = i === selIdx;
      const lbl = state.granularity === "phases" ? d.shortLabel : d.shortLabel;
      if (narrow) {
        const yAng = padT + plotH + 14;
        out += `<text x="${(cx + 2).toFixed(1)}" y="${yAng.toFixed(1)}" text-anchor="end" transform="rotate(-28 ${(cx + 2).toFixed(1)} ${yAng.toFixed(1)})" font-size="10" font-weight="${isSel ? "700" : "500"}" fill="${isSel ? "var(--fg)" : "var(--fg-muted)"}">${esc(lbl)}</text>`;
      } else {
        out += `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" font-weight="${isSel ? "700" : "500"}" fill="${isSel ? "var(--fg)" : "var(--fg-muted)"}">${esc(lbl)}</text>`;
      }
      out += `<rect data-era-idx="${i}" x="${(padL + colW * i).toFixed(1)}" y="${padT}" width="${colW.toFixed(1)}" height="${plotH + 34}" fill="transparent" style="cursor:pointer"><title>${esc(d.label)} (${esc(d.sublabel)})</title></rect>`;
    });
    return out;
  }

  function sumHarmonyPct(it, keys) {
    const fh = it.fine_harmony;
    if (!fh || !fh.n_chords || !fh.pcts) return 0;
    return keys.reduce((acc, k) => acc + (fh.pcts[k] || 0), 0);
  }

  function chordRichnessShare(it) {
    return sumHarmonyPct(it, ["min7", "maj7", "dom7", "extended_9_11"]);
  }

  const RADAR_AXES = [
    { label: "Harmonic depth", norm: (it) => (it.macro_harmony && it.macro_harmony.complexity) || Math.min(100, (chordRichnessShare(it) / 30) * 100) },
    { label: "Chord richness", norm: (it) => (it.macro_harmony && it.macro_harmony.chord_richness) || Math.min(100, (sumHarmonyPct(it, ["maj_triad", "min_triad", "sus2_4"]) / 45) * 100) },
    { label: "Harmonic motion", norm: (it) => (it.macro_harmony && it.macro_harmony.harmonic_motion) || 35 },
    { label: "Dark modes", norm: (it) => (it.macro_harmony && it.macro_harmony.modal_darkness) || Math.min(100, ((it.dark_modal_pct || 0) / 70) * 100) },
    { label: "Drum complexity", norm: (it) => (it.macro_harmony && it.macro_harmony.drum_complexity_med) || 40 },
    { label: "Groove pulse", norm: (it) => (it.macro_harmony && it.macro_harmony.drum_pulse_med) || 40 },
    { label: "MIK energy", norm: (it) => ((it.macro_harmony && it.macro_harmony.mik_energy_med) || 4) * 10 },
    { label: "Micro shimmer", norm: (it) => (it.macro_harmony && it.macro_harmony.microtonal) || Math.min(100, ((it.microtonal && it.microtonal.tuning_offset_p50) || 0) * 3) },
  ];

  const MACRO_BARS = [
    { key: "complexity", label: "Harmonic complexity", fmt: (v) => `${Math.round(v)}`, color: "var(--c5)" },
    { key: "chord_richness", label: "Chord richness", fmt: (v) => `${Math.round(v)}`, color: "var(--c1)" },
    { key: "harmonic_motion", label: "Harmonic motion", fmt: (v) => `${Math.round(v)}`, color: "var(--c2)" },
    { key: "modal_darkness", label: "Modal darkness", fmt: (v) => `${Math.round(v)}%`, color: "var(--c4)" },
    { key: "drum_complexity", label: "Drum complexity", fmt: (v) => `${Math.round(v)}`, color: "var(--c3)" },
    { key: "mik_energy_pct", label: "MIK energy (1–10)", fmt: (v) => `E${(v / 10).toFixed(1)}`, color: "var(--c7)" },
  ];

  function extractCompareProfile(it) {
    const cnts = (it.key_roots && it.key_roots.counts) || Array(12).fill(0);
    const sumCnt = Math.max(1, cnts.reduce((x, y) => x + y, 0));
    const mh = it.macro_harmony || {};
    return {
      radarNorm: RADAR_AXES.map((ax) => ax.norm(it)),
      macro: {
        complexity: mh.complexity ?? 0,
        chord_richness: mh.chord_richness ?? 0,
        harmonic_motion: mh.harmonic_motion ?? 0,
        modal_darkness: mh.modal_darkness ?? (it.dark_modal_pct || 0),
        drum_complexity: mh.drum_complexity_med ?? 0,
        mik_energy_pct: (mh.mik_energy_med ?? 4) * 10,
      },
      cofNorm: cnts.map((c) => c / sumCnt),
      mikEnergy: mh.mik_energy_med ?? 4,
      harmonicComplexity: mh.complexity ?? 0,
      drumComplexity: mh.drum_complexity_med ?? 0,
      darkPct: mh.modal_darkness ?? (it.dark_modal_pct || 0),
      bpmMed: it.bpm_p50 ?? 120,
      offsetCents: (it.microtonal && it.microtonal.tuning_offset_p50) ?? 0,
    };
  }

  function buildRadarAndMacroSvg(radarA, radarB, macroA, macroB, shortA, shortB, showGhost) {
    const rCx = 178, rCy = 152, rMax = 76;
    let svg = `<text x="${rCx}" y="16" text-anchor="middle" font-size="12" font-weight="600" fill="var(--fg-muted)">8-Axis Sonic &amp; Harmonic Radar</text>`;
    [0.33, 0.66, 1].forEach((r) => {
      const pts = RADAR_AXES.map((_, i) => {
        const ang = (i / RADAR_AXES.length) * Math.PI * 2 - Math.PI / 2;
        return `${(rCx + r * rMax * Math.cos(ang)).toFixed(1)},${(rCy + r * rMax * Math.sin(ang)).toFixed(1)}`;
      }).join(" ");
      svg += `<polygon points="${pts}" fill="none" stroke="var(--border-subtle)" stroke-width="1" />`;
    });
    RADAR_AXES.forEach((ax, i) => {
      const ang = (i / RADAR_AXES.length) * Math.PI * 2 - Math.PI / 2;
      const x2 = rCx + rMax * Math.cos(ang), y2 = rCy + rMax * Math.sin(ang);
      const lx = rCx + (rMax + 20) * Math.cos(ang), ly = rCy + (rMax + 18) * Math.sin(ang);
      svg += `<line x1="${rCx}" y1="${rCy}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--border-subtle)" stroke-width="1" />`;
      const anchor = Math.abs(Math.cos(ang)) < 0.25 ? "middle" : Math.cos(ang) > 0 ? "start" : "end";
      svg += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${anchor}" font-size="11" fill="var(--fg-muted)">${esc(ax.label)}</text>`;
    });
    const layers = showGhost ? [{ vec: radarA, col: "var(--c1)" }, { vec: radarB, col: "var(--c4)" }] : [{ vec: radarB, col: "var(--c4)" }];
    layers.forEach((s) => {
      const pts = s.vec.map((v, i) => {
        const ang = (i / RADAR_AXES.length) * Math.PI * 2 - Math.PI / 2;
        const rad = (Math.max(5, Math.min(100, v || 0)) / 100) * rMax;
        return `${(rCx + rad * Math.cos(ang)).toFixed(1)},${(rCy + rad * Math.sin(ang)).toFixed(1)}`;
      }).join(" ");
      svg += `<polygon points="${pts}" fill="${s.col}" fill-opacity="0.22" stroke="${s.col}" stroke-width="2.2" />`;
    });

    svg += `<line x1="364" y1="12" x2="364" y2="274" stroke="var(--border-subtle)" stroke-width="1" />`;
    svg += `<text x="380" y="15" font-size="12" font-weight="600" fill="var(--fg-muted)">Macro Harmony, Rhythm &amp; Energy</text>`;
    if (showGhost) {
      svg += `<text x="380" y="30" font-size="11" fill="var(--fg-muted)"><tspan fill="var(--c1)" font-weight="600">${esc(shortA)}</tspan> vs <tspan fill="var(--c4)" font-weight="600">${esc(shortB)}</tspan></text>`;
    } else {
      svg += `<text x="380" y="30" font-size="11" fill="var(--c4)" font-weight="600">${esc(shortB)} (active solo)</text>`;
    }

    const barX = 496, barMaxW = 132;
    MACRO_BARS.forEach((mb, row) => {
      const y = 44 + row * 38;
      const va = Math.max(0, Math.min(100, macroA[mb.key] || 0));
      const vb = Math.max(0, Math.min(100, macroB[mb.key] || 0));
      svg += `<text x="${barX - 10}" y="${y + 12}" text-anchor="end" font-size="12" font-weight="500" fill="var(--fg)">${esc(mb.label)}</text>`;
      svg += `<rect x="${barX}" y="${y}" width="${barMaxW}" height="14" rx="7" fill="var(--bg-hover)" />`;
      if (showGhost) {
        svg += `<rect x="${barX}" y="${y}" width="${Math.max(4, (va / 100) * barMaxW).toFixed(1)}" height="6" rx="3" fill="var(--c1)" fill-opacity="0.88" />`;
        svg += `<rect x="${barX}" y="${y + 8}" width="${Math.max(4, (vb / 100) * barMaxW).toFixed(1)}" height="6" rx="3" fill="var(--c4)" fill-opacity="0.92" />`;
        svg += `<text x="${barX + barMaxW + 8}" y="${y + 11}" font-size="11" fill="var(--fg-muted)">${esc(mb.fmt(va))} → ${esc(mb.fmt(vb))}</text>`;
      } else {
        svg += `<rect x="${barX}" y="${y + 2}" width="${Math.max(6, (vb / 100) * barMaxW).toFixed(1)}" height="10" rx="5" fill="${mb.color}" fill-opacity="0.9" />`;
        svg += `<text x="${barX + barMaxW + 8}" y="${y + 11}" font-size="12" font-weight="600" fill="var(--fg)">${esc(mb.fmt(vb))}</text>`;
      }
    });
    return svg;
  }

  function buildCofSvg(cofNormA, cofNormB, showGhost) {
    const cCx = 165, cCy = 148, cRad = 90;
    const cofOrder = window.CORPUS_DATA.meta.cof_order;
    let svg = `<circle cx="${cCx}" cy="${cCy}" r="${cRad}" fill="none" stroke="var(--border)" stroke-width="1" />`;
    cofOrder.forEach((rootName, i) => {
      const ang = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const x = cCx + cRad * Math.cos(ang), y = cCy + cRad * Math.sin(ang);
      const lx = cCx + (cRad + 28) * Math.cos(ang), ly = cCy + (cRad + 28) * Math.sin(ang);
      const ra = 4 + (cofNormA[i] || 0) * 52;
      const rb = 4 + (cofNormB[i] || 0) * 52;
      if (showGhost && (cofNormA[i] || 0) > 0.004) {
        svg += `<circle cx="${(x - 3).toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.min(22, ra).toFixed(1)}" fill="var(--c1)" fill-opacity="0.46" stroke="var(--c1)" stroke-width="1.2" />`;
      }
      if ((cofNormB[i] || 0) > 0.004) {
        const cxPt = showGhost ? x + 3 : x;
        svg += `<circle cx="${cxPt.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.min(22, rb).toFixed(1)}" fill="var(--c4)" fill-opacity="0.52" stroke="var(--c4)" stroke-width="1.3" />`;
      }
      svg += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="600" fill="var(--fg)">${esc(rootName)}</text>`;
    });
    svg += `<text x="${cCx}" y="${cCy + 4}" text-anchor="middle" font-size="12" fill="var(--fg-muted)">Key roots</text>`;
    return svg;
  }

  function renderMacroHarmony(items, d, selIdx, state, playId) {
    const insight = "Macro harmonic complexity (chord richness + chord motion + modal darkness) alongside Mixed In Key energy (1–10) and drum complexity across all 16 eras.";
    const W = Math.max(460, measureStageWidth("mh-stage-wrap", 960));
    const H = items.length > 8 ? 316 : 300;
    const padL = 44, padR = 44, padT = state.granularity === "eras" ? 26 : 16, padB = items.length > 8 ? 44 : 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);
    const y01 = (v) => padT + plotH * (1 - Math.max(0, Math.min(100, v || 0)) / 100);
    const yEn = (e) => padT + plotH * (1 - Math.max(0, Math.min(10, e || 0)) / 10);

    let svg = phaseDividerLayer(items, state, padL, plotW, padT, plotH);
    svg += gridAxesLayer(padL, plotW, padT, plotH, [0, 0.25, 0.5, 0.75, 1], (r) => `${Math.round(r * 100)}`, (r) => `E${Math.round(r * 10)}`);

    [
      { fn: (it) => y01(it.macro_harmony && it.macro_harmony.complexity), col: "var(--c5)", dashed: false },
      { fn: (it) => y01(it.macro_harmony && it.macro_harmony.drum_complexity_med), col: "var(--c3)", dashed: false },
      { fn: (it) => y01(it.macro_harmony && it.macro_harmony.modal_darkness), col: "var(--c4)", dashed: false },
      { fn: (it) => yEn(it.macro_harmony && it.macro_harmony.mik_energy_med), col: "var(--c7)", dashed: true },
    ].forEach((s) => {
      const pts = items.map((it, i) => ({ x: xC(i), y: s.fn(it) }));
      svg += `<path d="${svgLinePath(pts)}" fill="none" stroke="${s.col}" stroke-width="2.4" ${s.dashed ? 'stroke-dasharray="5,3"' : ""} />`;
      pts.forEach((pt, i) => {
        svg += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${i === selIdx ? 5 : 3.2}" fill="${s.col}" stroke="var(--bg-card)" stroke-width="1.3" />`;
      });
    });
    svg += xAxisAndHitLayer(items, state, padL, plotW, padT, plotH, H, selIdx);

    const trackCards = (d.tracks || []).map((t) => {
      const playing = playId === t.id;
      return `
        <div class="track-mini-card">
          <div class="track-mini-head">
            <button type="button" class="btn-tonal mp-play ${playing ? "is-playing" : ""}" data-track-play="${esc(t.id)}" title="${playing ? "Stop" : "Play track loop"}">
              <span class="ms filled">${playing ? "stop" : "play_arrow"}</span>
            </button>
            <div style="flex:1;min-width:0">
              <div class="track-mini-title">${esc(t.title)}</div>
              <div class="track-mini-sub">${esc(t.key_label)} · ${Math.round(t.bpm)} BPM</div>
            </div>
            <button type="button" class="badge badge-amber" data-focus-map="${esc(t.id)}" title="Inspect on ${(window.BTMM_MODE_LABELS && window.BTMM_MODE_LABELS.vibe) || "Vibe"} Map">E${t.energy}/10</button>
          </div>
          <div class="track-mini-bars">
            <div class="tbar-row"><span>Harmonic</span><div class="tbar-track"><div class="tbar-fill" style="width:${t.harmonic_complexity}%;background:var(--c5)"></div></div><strong>${Math.round(t.harmonic_complexity)}</strong></div>
            <div class="tbar-row"><span>Chord richness</span><div class="tbar-track"><div class="tbar-fill" style="width:${t.chord_richness}%;background:var(--c1)"></div></div><strong>${Math.round(t.chord_richness)}</strong></div>
            <div class="tbar-row"><span>Motion</span><div class="tbar-track"><div class="tbar-fill" style="width:${t.harmonic_motion}%;background:var(--c2)"></div></div><strong>${Math.round(t.harmonic_motion)}</strong></div>
            <div class="tbar-row"><span>Drum detail</span><div class="tbar-track"><div class="tbar-fill" style="width:${t.drum_complexity}%;background:var(--c3)"></div></div><strong>${Math.round(t.drum_complexity)}</strong></div>
          </div>
        </div>`;
    }).join("");

    return `
      <div class="view-head">
        <div class="view-title-group">
          <h2 class="view-title">Macro harmony &amp; energy</h2>
          <p class="view-insight">${esc(insight)}</p>
        </div>
      </div>
      ${legendHtml([
        { label: "Macro harmonic complexity (0–100)", color: "var(--c5)" },
        { label: "Drum complexity (0–100)", color: "var(--c3)" },
        { label: "Modal darkness %", color: "var(--c4)" },
        { label: "MIK energy (1–10)", color: "var(--c7)", dashed: true },
      ])}
      <div class="subpanel">
        <div id="mh-stage-wrap" class="svg-stage"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg></div>
      </div>
      <div class="subpanel">
        <div class="subpanel-title"><span>Tracks in ${esc(d.label)}</span><span class="muted">Click any E-badge to jump to the ${(window.BTMM_MODE_LABELS && window.BTMM_MODE_LABELS.vibe) || "Vibe"} Map</span></div>
        <div class="track-card-grid">${trackCards}</div>
      </div>`;
  }

  function renderTimelinePlayer(sorted, state) {
    const insight = "Press Play for bar-quantized tracks synced across all 16 eras — or scrub and hold on any era to switch on the downbeat.";
    const barBtns = [2, 4, 8, 0].map((v) =>
      `<button type="button" data-sub="barsPerEra:${v}" class="btn-chip ${Number(state.barsPerEra) === v ? "is-active" : ""}">${v ? `${v} bars` : "Hold"}</button>`
    ).join("");
    const sortOpts = [
      { id: "chrono", label: "Chronological (2001–2026)" },
      { id: "energy", label: "MIK energy (1–10)" },
      { id: "harmonic", label: "Harmonic complexity" },
      { id: "drums", label: "Drum complexity" },
      { id: "tempo", label: "Tempo (BPM)" },
    ].map((o) => `<option value="${o.id}" ${state.animSort === o.id ? "selected" : ""}>${esc(o.label)}</option>`).join("");
    const ghostOpts = [
      { id: "prev", label: "Trailing era (t - 1)" },
      { id: "anchor", label: "First era baseline" },
      { id: "off", label: "Solo (no ghost)" },
    ].map((o) => `<option value="${o.id}" ${state.animGhost === o.id ? "selected" : ""}>${esc(o.label)}</option>`).join("");

    const stopsHtml = sorted.map((it, i) =>
      `<button type="button" data-anim-stop="${i}" class="anim-stop${i === Math.round(state.animPos) ? " is-active" : ""}" title="${esc(it.label)} (${esc(it.sublabel)})">${esc(it.shortLabel)}</button>`
    ).join("");

    return `
      <div class="view-head">
        <div class="view-title-group">
          <h2 class="view-title">Timeline animator</h2>
          <p class="view-insight">${esc(insight)}</p>
        </div>
      </div>
      <div class="anim-transport">
        <div class="anim-controls-left">
          <button id="anim-prev" type="button" class="icon-btn" title="Previous stop" aria-label="Previous stop"><span class="ms">skip_previous</span></button>
          <button id="anim-play" type="button" class="btn-tonal ${state.animPlaying ? "is-playing" : ""}">
            <span class="ms filled">${state.animPlaying ? "pause" : "play_arrow"}</span>
            <span>${state.animPlaying ? "Pause" : "Play"}</span>
          </button>
          <button id="anim-next" type="button" class="icon-btn" title="Next stop" aria-label="Next stop"><span class="ms">skip_next</span></button>
          <div style="display:flex;gap:4px">${barBtns}</div>
          <button id="anim-loop" type="button" data-sub="animLoop:${!state.animLoop}" class="btn-chip ${state.animLoop ? "is-active" : ""}">
            <span class="ms" style="font-size:16px">repeat</span><span>Loop</span>
          </button>
        </div>
        <div class="anim-controls-right">
          <select id="anim-sort" class="era-select" aria-label="Sort order">${sortOpts}</select>
          <select id="anim-ghost" class="era-select" aria-label="Comparison ghost">${ghostOpts}</select>
        </div>
      </div>
      <div id="anim-audio-deck" class="anim-audio-deck">
        <div id="audio-now-info"></div>
        <div id="audio-beat-leds" class="audio-beats"></div>
        <div style="display:flex;align-items:center;gap:10px">
          <button id="btn-audio-mute" type="button" class="btn-chip ${state.audioEnabled ? "is-active" : ""}">
            <span class="ms" style="font-size:16px">${state.audioEnabled ? "volume_up" : "volume_off"}</span>
            <span>${state.audioEnabled ? "Audio on" : "Muted"}</span>
          </button>
          <input id="vol-slider" class="gm3-slider" type="range" min="0" max="1" step="0.02" value="${state.audioVolume}" aria-label="Master volume" style="width:110px" />
        </div>
      </div>
      <div id="anim-status-banner" class="anim-status-banner"></div>
      <div class="anim-scrubber">
        <input id="anim-slider" class="gm3-slider anim-slider" type="range" min="0" max="${Math.max(0, sorted.length - 1)}" step="0.01" value="${state.animPos.toFixed(2)}" aria-label="Scrub timeline" />
        <div id="anim-stops" class="anim-stops">${stopsHtml}</div>
      </div>
      <div class="grid-harmony-compare">
        <div class="subpanel">
          <div class="subpanel-title"><span>8-Axis Harmonic Radar &amp; Macro Harmony Profile</span></div>
          <div class="svg-stage"><svg id="anim-svg-combo" viewBox="0 0 720 286" width="720" height="286"></svg></div>
        </div>
        <div class="subpanel">
          <div class="subpanel-title"><span>Circle of Fifths Key Gravity</span></div>
          <div class="svg-stage"><svg id="anim-svg-cof" viewBox="0 0 330 286" width="330" height="286"></svg></div>
        </div>
      </div>`;
  }

  function renderChordQuality(items, d, selIdx, state) {
    const insight = "From Ableton 2013+ MIDI clips: 4+ note 7th/extended chords jumped nearly 7x while open dyads shifted from Nihon tritones to Lucid Crystal 4ths/5ths.";
    const subBtns = `
      <button type="button" data-sub="chordMode:pct" class="btn-chip ${state.chordMode === "pct" ? "is-active" : ""}">Normalized %</button>
      <button type="button" data-sub="chordMode:count" class="btn-chip ${state.chordMode === "count" ? "is-active" : ""}">Chord count</button>`;
    const W = Math.max(420, measureStageWidth("cq-stage-wrap", 620));
    const H = items.length > 8 ? 316 : 300;
    const padL = 46, padR = 16, padT = state.granularity === "eras" ? 26 : 16, padB = items.length > 8 ? 44 : 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);
    const bw = Math.max(8, Math.min(44, colW * 0.62));
    const maxCnt = Math.max(100, ...items.map((it) => (it.fine_harmony && it.fine_harmony.n_chords) || 0));
    const yScaleCnt = Math.ceil(maxCnt / 200) * 200;

    let svg = phaseDividerLayer(items, state, padL, plotW, padT, plotH);
    svg += gridAxesLayer(padL, plotW, padT, plotH, [0, 0.25, 0.5, 0.75, 1], (r) => (state.chordMode === "pct" ? `${Math.round(r * 100)}%` : `${Math.round(r * yScaleCnt)}`), null);
    items.forEach((it, i) => {
      const cx = xC(i);
      const fh = it.fine_harmony || {};
      const tot = fh.n_chords || 0;
      if (!tot) {
        svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${plotH}" rx="2" fill="var(--bg-hover)" fill-opacity="0.45" stroke="var(--border)" stroke-dasharray="3,2" />`;
        return;
      }
      const denom = state.chordMode === "pct" ? tot : yScaleCnt;
      let yCursor = padT + plotH;
      [...CHORD_STACK_GROUPS].reverse().forEach((grp) => {
        const cnt = grp.keys.reduce((acc, k) => acc + ((fh.counts && fh.counts[k]) || 0), 0);
        if (cnt <= 0) return;
        const h = (cnt / denom) * plotH;
        yCursor -= h;
        svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${yCursor.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="${grp.color}" fill-opacity="${fh.low_sample ? 0.45 : i === selIdx ? 0.98 : 0.84}" />`;
      });
    });
    svg += xAxisAndHitLayer(items, state, padL, plotW, padT, plotH, H, selIdx);

    const fhActive = d.fine_harmony || {};
    const rowsHtml = fhActive.n_chords
      ? FINE_CHORD_META.map((meta) => {
          const cnt = (fhActive.counts && fhActive.counts[meta.key]) || 0;
          const pctVal = fhActive.pcts ? fhActive.pcts[meta.key] : null;
          const w = pctVal !== null && Number.isFinite(pctVal) ? Math.min(100, pctVal * 1.8) : 0;
          return `<div class="flavor-row"><span class="flavor-name">${esc(meta.label)}</span><div class="flavor-track"><div class="flavor-fill" style="width:${w.toFixed(1)}%;background:${meta.color}"></div></div><span class="flavor-val">${pctVal !== null ? `${pctVal}% (${cnt})` : "—"}</span></div>`;
        }).join("")
      : `<p class="muted">Audio-only archive era (MIDI chord extraction begins in 2013 Ableton projects). Use Macro harmony &amp; energy for audio chord richness (${Math.round((d.macro_harmony && d.macro_harmony.chord_richness) || 0)}/100).</p>`;

    return `
      <div class="view-head"><div class="view-title-group"><h2 class="view-title">Chord &amp; dyad spectrum</h2><p class="view-insight">${esc(insight)}</p></div><div class="sub-controls">${subBtns}</div></div>
      ${legendHtml(CHORD_STACK_GROUPS)}
      <div class="grid-2">
        <div class="subpanel"><div class="subpanel-title"><span>Stacked chord &amp; dyad taxonomy</span><span class="muted">Dashed bars: audio-only / pre-MIDI</span></div><div id="cq-stage-wrap" class="svg-stage"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg></div></div>
        <div class="subpanel"><div class="subpanel-title"><span>15 harmonic flavors — ${esc(d.label)}</span><span class="badge">${fhActive.n_chords || 0} events</span></div><div class="flavor-list">${rowsHtml}</div></div>
      </div>`;
  }

  function renderRootMotion(items, d, selIdx, state) {
    const insight = "Root progression DNA evolved from Nihon's ±1 semitone Phrygian slides and Le Garage mediants to Spirit Guides whole-step planing and 4th/5th gravity.";
    const W = Math.max(380, measureStageWidth("rm-stage-wrap", 540));
    const H = items.length > 8 ? 316 : 300;
    const padL = 44, padR = 44, padT = state.granularity === "eras" ? 26 : 16, padB = items.length > 8 ? 44 : 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);
    const bw = Math.max(8, Math.min(40, colW * 0.58));

    let svg = phaseDividerLayer(items, state, padL, plotW, padT, plotH);
    svg += gridAxesLayer(padL, plotW, padT, plotH, [0, 0.25, 0.5, 0.75, 1], (r) => `${Math.round(r * 100)}%`, (r) => `${Math.round(r * 100)}%`);
    const pedalPts = [];
    items.forEach((it, i) => {
      const cx = xC(i);
      const rm = it.root_motion || {};
      if (!rm.n_moves) {
        svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${plotH}" rx="2" fill="var(--bg-hover)" fill-opacity="0.35" stroke="var(--border)" stroke-dasharray="3,2" />`;
        pedalPts.push(null);
        return;
      }
      let yCursor = padT + plotH;
      [...ROOT_MOTION_GROUPS].reverse().forEach((grp) => {
        const val = rm[grp.key] || 0;
        const h = (val / 100) * plotH;
        yCursor -= h;
        svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${yCursor.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" fill="${grp.color}" fill-opacity="${i === selIdx ? 0.96 : 0.82}" />`;
      });
      pedalPts.push(rm.pedal_pct !== null ? { x: cx, y: padT + plotH * (1 - rm.pedal_pct / 100) } : null);
    });
    svg += `<path d="${svgLinePath(pedalPts)}" fill="none" stroke="var(--fg)" stroke-width="2" stroke-dasharray="4,3" />`;
    svg += xAxisAndHitLayer(items, state, padL, plotW, padT, plotH, H, selIdx);

    const whSize = 290, cx = whSize / 2, cy = whSize / 2, rOuter = 104, rInner = 28;
    const rmActive = d.root_motion || {};
    const cnts = rmActive.counts_12 || Array(12).fill(0);
    const maxNZ = Math.max(1, ...cnts.slice(1));
    const wheelLabels = ["0 Ped", "+1 bII", "+2 II", "+3 bIII", "+4 III", "+5 IV", "+6 TT", "+7 V", "-4 bVI", "-3 VI", "-2 bVII", "-1 VII"];
    let wheelSvg = `<circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="var(--border)" stroke-width="1" />`;
    for (let s = 0; s < 12; s++) {
      const ang = (s / 12) * Math.PI * 2 - Math.PI / 2;
      const lx = cx + (rOuter + 24) * Math.cos(ang), ly = cy + (rOuter + 24) * Math.sin(ang);
      const val = cnts[s] || 0;
      const col = s === 0 ? "var(--c8)" : (s === 5 || s === 7) ? "var(--c1)" : (s === 2 || s === 10) ? "var(--c2)" : (s === 1 || s === 11) ? "var(--c5)" : "var(--c4)";
      if (s > 0 && val > 0) {
        const ratio = val / maxNZ;
        const rTip = rInner + ratio * (rOuter - rInner);
        wheelSvg += `<line x1="${(cx + rInner * Math.cos(ang)).toFixed(1)}" y1="${(cy + rInner * Math.sin(ang)).toFixed(1)}" x2="${(cx + rTip * Math.cos(ang)).toFixed(1)}" y2="${(cy + rTip * Math.sin(ang)).toFixed(1)}" stroke="${col}" stroke-width="${(2 + ratio * 7).toFixed(1)}" stroke-linecap="round" />`;
      }
      wheelSvg += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="${val > 0 ? "var(--fg)" : "var(--fg-dim)"}">${esc(wheelLabels[s])}</text>`;
    }
    const pedLabel = rmActive.pedal_pct !== undefined && rmActive.pedal_pct !== null ? `${rmActive.pedal_pct}%` : "n/a";
    wheelSvg += `<circle cx="${cx}" cy="${cy}" r="${rInner}" fill="var(--bg-card)" stroke="var(--border)" /><text x="${cx}" y="${cy + 3}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--fg)">${esc(pedLabel)}</text>`;

    return `
      <div class="view-head"><div class="view-title-group"><h2 class="view-title">Root motion &amp; wheel</h2><p class="view-insight">${esc(insight)}</p></div></div>
      ${legendHtml([...ROOT_MOTION_GROUPS, { label: "0 st Pedal Repeat %", color: "var(--fg)", dashed: true }])}
      <div class="grid-2">
        <div class="subpanel"><div class="subpanel-title"><span>Non-pedal root progression mix</span></div><div id="rm-stage-wrap" class="svg-stage"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg></div></div>
        <div class="subpanel"><div class="subpanel-title"><span>Transition wheel — ${esc(d.label)}</span><span class="badge">${rmActive.n_moves || 0} moves</span></div><div class="svg-stage" style="max-width:300px;margin:0 auto"><svg viewBox="0 0 ${whSize} ${whSize}" width="${whSize}" height="${whSize}">${wheelSvg}</svg></div></div>
      </div>`;
  }

  function renderModalHeatmap(items, d, selIdx, state) {
    const insight = "12-degree pitch density across combined MIDI + audio stems (including HPSS chromagrams for all pre-2013 archive eras).";
    const controls = `
      <button type="button" data-sub="heatmapSource:combined_12" class="btn-chip ${state.heatmapSource === "combined_12" ? "is-active" : ""}">Combined</button>
      <button type="button" data-sub="heatmapSource:midi_12" class="btn-chip ${state.heatmapSource === "midi_12" ? "is-active" : ""}">MIDI only</button>
      <button type="button" data-sub="heatmapSource:audio_12" class="btn-chip ${state.heatmapSource === "audio_12" ? "is-active" : ""}">Audio only</button>
      <button type="button" data-sub="heatmapSpotlight:${!state.heatmapSpotlight}" class="btn-chip ${state.heatmapSpotlight ? "is-active" : ""}">${state.heatmapSpotlight ? "10 Color degrees" : "All 12 degrees"}</button>`;

    const indices = state.heatmapSpotlight ? [1, 2, 3, 4, 5, 6, 8, 9, 10, 11] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    let maxVal = 0.05;
    items.forEach((it) => {
      const vec = it.scale_degrees && it.scale_degrees[state.heatmapSource];
      if (!vec) return;
      const tot = vec.reduce((a, b) => a + b, 0);
      const scale = tot > 2 ? 100 : 1;
      indices.forEach((idx) => { const v = vec[idx] / scale; if (v > maxVal) maxVal = v; });
    });

    function cellStyle(raw, role) {
      if (raw === null || raw === undefined || !Number.isFinite(raw)) return `background:var(--bg-elev);color:var(--fg-dim)`;
      const norm = Math.min(1, raw / maxVal);
      const pct = Math.round(10 + norm * 75);
      const cVar = role === "dark" ? "var(--c4)" : role === "dorian" ? "var(--c8)" : role === "bright" ? "var(--c6)" : role === "tension" ? "var(--c7)" : "var(--c1)";
      return `background:color-mix(in srgb, ${cVar} ${pct}%, var(--bg-elev));color:var(--fg);font-weight:${norm > 0.45 ? 700 : 500}`;
    }

    const headCols = items.map((it, i) => `<th data-era-idx="${i}" class="${i === selIdx ? "col-active" : ""}">${esc(it.shortLabel)}</th>`).join("");
    const bodyRows = indices.map((degIdx) => {
      const info = DEGREE_INFO[degIdx];
      const cells = items.map((it, i) => {
        const vec = it.scale_degrees && it.scale_degrees[state.heatmapSource];
        if (!vec) return `<td data-era-idx="${i}" class="hm-cell" style="${cellStyle(null, info.role)}">—</td>`;
        const tot = vec.reduce((a, b) => a + b, 0);
        const v = tot > 2 ? vec[degIdx] / 100 : vec[degIdx];
        const act = i === selIdx ? ";outline:2px solid var(--primary)" : "";
        return `<td data-era-idx="${i}" class="hm-cell" style="${cellStyle(v, info.role)}${act}">${(v * 100).toFixed(1)}%</td>`;
      }).join("");
      return `<tr><td class="hm-deg">${esc(info.name)}</td>${cells}</tr>`;
    }).join("");

    return `
      <div class="view-head"><div class="view-title-group"><h2 class="view-title">12-degree modal heatmap</h2><p class="view-insight">${esc(insight)}</p></div><div class="sub-controls">${controls}</div></div>
      <div class="heatmap-wrap"><table class="heatmap-table"><thead><tr><th>Scale degree</th>${headCols}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
  }

  function renderVoicingSpread(items, d, selIdx, state) {
    const insight = "MIDI voicing register (2013+) expanded into multi-octave pads in Le Garage & Remixes before tightening around warm midrange chords in recent releases.";
    const subBtns = `
      <button type="button" data-sub="voicingMode:keyboard" class="btn-chip ${state.voicingMode === "keyboard" ? "is-active" : ""}">Keyboard register</button>
      <button type="button" data-sub="voicingMode:span" class="btn-chip ${state.voicingMode === "span" ? "is-active" : ""}">Semitone span</button>`;
    const W = Math.max(460, measureStageWidth("vs-stage-wrap", 960));
    const H = items.length > 8 ? 316 : 300;
    const padL = 62, padR = 24, padT = state.granularity === "eras" ? 26 : 16, padB = items.length > 8 ? 44 : 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length;
    const xC = (i) => padL + colW * (i + 0.5);
    let svg = phaseDividerLayer(items, state, padL, plotW, padT, plotH);

    if (state.voicingMode === "keyboard") {
      const mMin = 24, mMax = 88;
      const yM = (m) => (m === null || !Number.isFinite(m) ? null : padT + plotH * (1 - Math.max(0, Math.min(1, (m - mMin) / (mMax - mMin)))));
      [24, 36, 48, 60, 72, 84].forEach((cm) => {
        const y = yM(cm);
        svg += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="${cm === 60 ? "var(--border)" : "var(--border-subtle)"}" /><text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--fg-muted)">C${Math.floor(cm / 12) - 1}</text>`;
      });
      const bw = Math.max(8, Math.min(26, colW * 0.4));
      const leadPts = [];
      items.forEach((it, i) => {
        const cx = xC(i), vr = it.voicing_register || {};
        if (vr.low_p50 !== null && vr.low_p50 !== undefined && vr.high_p50 !== null) {
          const yL = yM(vr.low_p50), yH = yM(vr.high_p50);
          svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${Math.min(yL, yH).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(4, Math.abs(yL - yH)).toFixed(1)}" rx="3" fill="var(--c1)" fill-opacity="${i === selIdx ? 0.85 : 0.45}" stroke="var(--c1)" />`;
        }
        leadPts.push({ x: cx, y: yM(it.lead_midi_p50) });
      });
      svg += `<path d="${svgLinePath(leadPts)}" fill="none" stroke="var(--c3)" stroke-width="2" />`;
    } else {
      const sMax = 48;
      const yS = (v) => (v === null || !Number.isFinite(v) ? null : padT + plotH * (1 - Math.max(0, Math.min(1, v / sMax))));
      svg += gridAxesLayer(padL, plotW, padT, plotH, [0, 0.25, 0.5, 0.75, 1], (r) => `${Math.round(r * sMax)} st`, null);
      const medPts = items.map((it, i) => ({ x: xC(i), y: yS(it.voicing_register && it.voicing_register.span_p50) }));
      svg += `<path d="${svgLinePath(medPts)}" fill="none" stroke="var(--c3)" stroke-width="2.4" />`;
      medPts.forEach((pt, i) => { if (pt.y !== null) svg += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${i === selIdx ? 5 : 3.4}" fill="var(--c3)" />`; });
    }
    svg += xAxisAndHitLayer(items, state, padL, plotW, padT, plotH, H, selIdx);
    return `
      <div class="view-head"><div class="view-title-group"><h2 class="view-title">Voicing spread &amp; keyboard</h2><p class="view-insight">${esc(insight)}</p></div><div class="sub-controls">${subBtns}</div></div>
      <div class="subpanel"><div id="vs-stage-wrap" class="svg-stage"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg></div></div>`;
  }

  function renderJiGamelan(items, d, selIdx, state) {
    const insight = "Just Intonation racks (.amxd / Tuned 808 JI) and Balinese Semaradana / Gamelan tunings spike in EP Concepts and Le Garage Hermétique.";
    const scales = window.CORPUS_DATA.meta.tuning_scales;
    const sc = scales[state.tuningScaleId] || scales.semeradana;
    const scaleNames = { semeradana: "Semaradana (7-tone)", ji_5_7: "5/7-Limit JI", alves_pelog: "Alves JI Pelog", alves_slendro: "Alves JI Slendro" };
    const scaleBtns = Object.values(scales).map((s) =>
      `<button type="button" data-sub="tuningScaleId:${s.id}" class="btn-chip ${s.id === sc.id ? "is-active" : ""}">${esc(s.label || s.name || scaleNames[s.id] || s.id)}</button>`
    ).join("");
    const W = Math.max(360, measureStageWidth("ji-stage-wrap", 540));
    const H = items.length > 8 ? 290 : 265, padL = 36, padR = 44, padT = state.granularity === "eras" ? 24 : 16, padB = items.length > 8 ? 44 : 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length, xC = (i) => padL + colW * (i + 0.5), bw = Math.max(8, Math.min(30, colW * 0.54));
    const maxProj = Math.max(8, ...items.map((it) => (it.microtonal.ji_retune_projects || 0) + (it.microtonal.gamelan_projects || 0)));

    let svg = phaseDividerLayer(items, state, padL, plotW, padT, plotH);
    svg += gridAxesLayer(padL, plotW, padT, plotH, [0, 0.5, 1], (r) => `${Math.round(r * maxProj)}`, (r) => `${Math.round(r * 45)}¢`);
    const p50Pts = [];
    items.forEach((it, i) => {
      const cx = xC(i), mt = it.microtonal || {};
      const hJi = ((mt.ji_retune_projects || 0) / maxProj) * plotH;
      const hGam = ((mt.gamelan_projects || 0) / maxProj) * plotH;
      if (hJi > 0) svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${(padT + plotH - hJi).toFixed(1)}" width="${bw.toFixed(1)}" height="${hJi.toFixed(1)}" fill="var(--c3)" />`;
      if (hGam > 0) svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${(padT + plotH - hJi - hGam).toFixed(1)}" width="${bw.toFixed(1)}" height="${hGam.toFixed(1)}" fill="var(--c2)" />`;
      p50Pts.push(mt.tuning_offset_p50 !== null && mt.tuning_offset_p50 !== undefined ? { x: cx, y: padT + plotH * (1 - Math.min(1, mt.tuning_offset_p50 / 45)) } : null);
    });
    svg += `<path d="${svgLinePath(p50Pts)}" fill="none" stroke="var(--c1)" stroke-width="2.4" />`;
    svg += xAxisAndHitLayer(items, state, padL, plotW, padT, plotH, H, selIdx);

    const rw = 520, rh = 128, rPadL = 22, rPlotW = rw - 44;
    const xCent = (c) => rPadL + (c / 1200) * rPlotW;
    let rulerSvg = `<line x1="${rPadL}" y1="70" x2="${rPadL + rPlotW}" y2="70" stroke="var(--border)" stroke-width="2" />`;
    for (let st = 0; st <= 12; st++) {
      const x = xCent(st * 100);
      rulerSvg += `<line x1="${x.toFixed(1)}" y1="60" x2="${x.toFixed(1)}" y2="80" stroke="var(--fg-dim)" stroke-opacity="0.5" />`;
    }
    sc.degrees.forEach((degObj, di) => {
      const x = xCent(degObj.cents), yPin = di % 2 === 0 ? 32 : 48;
      rulerSvg += `<line x1="${x.toFixed(1)}" y1="${yPin}" x2="${x.toFixed(1)}" y2="70" stroke="var(--c3)" stroke-width="2" /><circle data-play-cent="${degObj.cents}" cx="${x.toFixed(1)}" cy="70" r="5" fill="var(--c3)" style="cursor:pointer" /><text x="${x.toFixed(1)}" y="${yPin - 5}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--fg)">${esc(degObj.deg)}</text>`;
    });

    const degPills = sc.degrees.map((degObj) => {
      const diff = Math.round((degObj.cents - Math.round(degObj.cents / 100) * 100) * 10) / 10;
      return `<button type="button" data-play-cent="${degObj.cents}" class="deg-pill"><strong>${esc(degObj.deg)} · ${degObj.cents}¢</strong><span class="muted">${diff >= 0 ? "+" : ""}${diff}¢ vs 12-TET</span></button>`;
    }).join("");

    return `
      <div class="view-head"><div class="view-title-group"><h2 class="view-title">JI &amp; gamelan tunings</h2><p class="view-insight">${esc(insight)}</p></div></div>
      <div class="grid-equal-2">
        <div class="subpanel"><div class="subpanel-title"><span>Microtonal projects &amp; audio cent offset</span></div><div id="ji-stage-wrap" class="svg-stage"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg></div></div>
        <div class="subpanel">
          <div class="subpanel-title"><span>Octave cent-ruler (0–1200¢)</span><div class="sub-controls"><button id="btn-play-scale" type="button" class="btn-tonal"><span class="ms filled">play_arrow</span><span>Scale</span></button><button id="btn-play-tet" type="button" class="btn-chip"><span class="ms filled" style="font-size:16px">play_arrow</span><span>12-TET</span></button></div></div>
          <div class="sub-controls">${scaleBtns}</div>
          <div class="svg-stage"><svg viewBox="0 0 ${rw} ${rh}" width="${rw}" height="${rh}">${rulerSvg}</svg></div>
          <div class="degree-pills">${degPills}</div>
        </div>
      </div>`;
  }

  window.ME_CHARTS = {
    esc, num, midiName, measureStageWidth, svgLinePath, legendHtml,
    phaseDividerLayer, gridAxesLayer, xAxisAndHitLayer,
    extractCompareProfile, buildRadarAndMacroSvg, buildCofSvg, FINE_CHORD_META,
  };
  window.ME_VIEWS_HARMONY = {
    renderMacroHarmony,
    renderTimelinePlayer,
    renderChordQuality,
    renderRootMotion,
    renderModalHeatmap,
    renderVoicingSpread,
    renderJiGamelan,
  };
})();
