// Evolution, Era Comparator, Groove/Tempo, Melody, Audio & Synths Views + Era Inspector
(function () {
  "use strict";

  const COMPARE_PRESETS = [
    { id: "arch_ecstatic", label: "Early Roots '97 → Ecstatic Wave", eraA: "present_early_97", eraB: "ecstatic_wave", phA: "phase0_archive", phB: "phase4_recent" },
    { id: "arcadian_ecstatic", label: "Arcadian '03 → Ecstatic Wave", eraA: "present_arcadian_03", eraB: "ecstatic_wave", phA: "phase0_archive", phB: "phase4_recent" },
    { id: "garage_ecstatic", label: "Le Garage → Ecstatic Wave", eraA: "le_garage", eraB: "ecstatic_wave", phA: "phase2_mid", phB: "phase4_recent" },
    { id: "spirit_lucid", label: "Spirit Guides → Lucid Crystal", eraA: "spirit_guides", eraB: "lucid_crystal", phA: "phase3_ambient", phB: "phase3_ambient" },
  ];

  function audioSharePct(d) {
    const a = d.audio_tracks_med ?? 0;
    const m = d.midi_tracks_med ?? 0;
    return a + m > 0 ? Math.round((a / (a + m)) * 1000) / 10 : null;
  }

  function renderEraCompare(items, state) {
    const C = window.ME_CHARTS;
    const insight = "Overlay any two eras or phases across the 8-axis radar, macro harmony & energy bars, and Circle of Fifths key root gravity.";
    const idxA = Math.max(0, Math.min(items.length - 1, state.compareAIdx));
    const idxB = Math.max(0, Math.min(items.length - 1, state.compareBIdx));
    const a = items[idxA];
    const b = items[idxB];
    const profA = C.extractCompareProfile(a);
    const profB = C.extractCompareProfile(b);

    const optsA = items.map((it, i) => `<option value="${i}" ${i === idxA ? "selected" : ""}>${C.esc(it.label)} (${C.esc(it.sublabel)})</option>`).join("");
    const optsB = items.map((it, i) => `<option value="${i}" ${i === idxB ? "selected" : ""}>${C.esc(it.label)} (${C.esc(it.sublabel)})</option>`).join("");
    const presets = COMPARE_PRESETS.map((p) => `<button type="button" data-compare-preset="${p.id}" class="btn-chip">${C.esc(p.label)}</button>`).join("");

    const comboSvg = C.buildRadarAndMacroSvg(profA.radarNorm, profB.radarNorm, profA.macro, profB.macro, a.shortLabel, b.shortLabel, true);
    const cofSvg = C.buildCofSvg(profA.cofNorm, profB.cofNorm, true);

    return `
      <div class="view-head">
        <div class="view-title-group">
          <h2 class="view-title">Era comparator</h2>
          <p class="view-insight">${C.esc(insight)}</p>
        </div>
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
      <div class="grid-harmony-compare">
        <div class="subpanel">
          <div class="subpanel-title"><span>8-Axis Radar &amp; Macro Harmony / MIK Energy</span></div>
          <div class="svg-stage"><svg viewBox="0 0 720 286" width="720" height="286">${comboSvg}</svg></div>
        </div>
        <div class="subpanel">
          <div class="subpanel-title"><span>Circle of Fifths Key Center Gravity</span></div>
          <div class="svg-stage"><svg viewBox="0 0 330 286" width="330" height="286">${cofSvg}</svg></div>
        </div>
      </div>`;
  }

  function renderWorkflow(items, d, selIdx, state) {
    const C = window.ME_CHARTS;
    const insight = "From pre-2013 audio archives through MIDI-heavy 2013–18 production, pivoting to multi-track audio assemblies in 2018–22 and hybrid studio balance in 2024–26.";
    const W = Math.max(460, C.measureStageWidth("wf-stage-wrap", 960));
    const H = items.length > 8 ? 316 : 300, padL = 48, padR = 46, padT = state.granularity === "eras" ? 26 : 16, padB = items.length > 8 ? 54 : 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length, xC = (i) => padL + colW * (i + 0.5);
    const bw = Math.max(4, Math.min(20, (colW - 8) / 2));
    const maxRaw = Math.max(...items.map((it) => Math.max(it.midi_pitched_notes || 0, it.audio_notes || 0)));
    const scaleMax = Math.max(5000, Math.ceil(maxRaw / 5000) * 5000);

    let svg = C.phaseDividerLayer(items, state, padL, plotW, padT, plotH);
    svg += C.gridAxesLayer(padL, plotW, padT, plotH, [0, 0.5, 1], (r) => (r === 0 ? "0" : `${Math.round((r * scaleMax) / 1000)}k`), (r) => `${Math.round(r * 100)}%`);
    const sharePts = [];
    items.forEach((it, i) => {
      const cx = xC(i);
      const hM = ((it.midi_pitched_notes || 0) / scaleMax) * plotH;
      const hA = ((it.audio_notes || 0) / scaleMax) * plotH;
      svg += `<rect x="${(cx - bw - 1).toFixed(1)}" y="${(padT + plotH - hM).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, hM).toFixed(1)}" rx="2" fill="var(--c1)" fill-opacity="${i === selIdx ? 1 : 0.8}" />`;
      svg += `<rect x="${(cx + 1).toFixed(1)}" y="${(padT + plotH - hA).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, hA).toFixed(1)}" rx="2" fill="var(--c2)" fill-opacity="${i === selIdx ? 1 : 0.8}" />`;
      const sh = audioSharePct(it);
      sharePts.push(sh === null ? null : { x: cx, y: padT + plotH * (1 - sh / 100) });
    });
    svg += `<path d="${C.svgLinePath(sharePts)}" fill="none" stroke="var(--c3)" stroke-width="2.4" />`;
    svg += C.xAxisAndHitLayer(items, state, padL, plotW, padT, plotH, H, selIdx);

    return `
      <div class="view-head"><div class="view-title-group"><h2 class="view-title">Workflow: MIDI vs audio</h2><p class="view-insight">${C.esc(insight)}</p></div></div>
      ${C.legendHtml([{ label: "MIDI pitched notes", color: "var(--c1)" }, { label: "Audio pitched notes", color: "var(--c2)" }, { label: "Audio track share %", color: "var(--c3)" }])}
      <div class="subpanel"><div id="wf-stage-wrap" class="svg-stage"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg></div></div>`;
  }

  function renderGroove(items, d, selIdx, state) {
    const C = window.ME_CHARTS;
    const insight = `Median BPM (with IQR range), MIDI quantization lock (2013+), and audio-measured Drum Complexity across all ${items.length} ${state.granularity}.`;
    const W = Math.max(460, C.measureStageWidth("gr-stage-wrap", 960));
    const H = items.length > 8 ? 316 : 300, padL = 46, padR = 46, padT = state.granularity === "eras" ? 26 : 16, padB = items.length > 8 ? 54 : 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const colW = plotW / items.length, xC = (i) => padL + colW * (i + 0.5);
    const bpmMin = 50, bpmMax = 180;
    const yPct = (p) => (p === null || !Number.isFinite(p) ? null : padT + plotH * (1 - Math.max(0, Math.min(100, p)) / 100));
    const yBpm = (b) => (b === null || !Number.isFinite(b) ? null : padT + plotH * (1 - Math.max(0, Math.min(1, (b - bpmMin) / (bpmMax - bpmMin)))));

    let svg = C.phaseDividerLayer(items, state, padL, plotW, padT, plotH);
    svg += C.gridAxesLayer(padL, plotW, padT, plotH, [0, 0.5, 1], (r) => `${Math.round(r * 100)}%`, (r) => `${Math.round(bpmMin + r * (bpmMax - bpmMin))}`);

    const topPts = items.map((it, i) => `${xC(i).toFixed(1)},${(yBpm(it.bpm_p75) ?? yBpm(120)).toFixed(1)}`);
    const botPts = items.map((it, i) => `${xC(i).toFixed(1)},${(yBpm(it.bpm_p25) ?? yBpm(120)).toFixed(1)}`).reverse();
    svg += `<polygon points="${topPts.concat(botPts).join(" ")}" fill="var(--c3)" fill-opacity="0.16" />`;
    svg += `<path d="${C.svgLinePath(items.map((it, i) => ({ x: xC(i), y: yBpm(it.bpm_p50) })))}" fill="none" stroke="var(--c3)" stroke-width="2" stroke-dasharray="4,3" />`;

    [
      { fn: (it) => yPct(it.macro_harmony && it.macro_harmony.drum_complexity_med), col: "var(--c5)" },
      { fn: (it) => yPct(it.quant_drum_pct), col: "var(--c1)" },
      { fn: (it) => yPct(it.quant_bass_pct), col: "var(--c2)" },
      { fn: (it) => yPct(it.quant_pitched_pct), col: "var(--c4)" },
    ].forEach((s) => {
      const pts = items.map((it, i) => ({ x: xC(i), y: s.fn(it) }));
      svg += `<path d="${C.svgLinePath(pts)}" fill="none" stroke="${s.col}" stroke-width="2.2" />`;
      pts.forEach((pt, i) => {
        if (pt.y === null) return;
        svg += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${i === selIdx ? 4.8 : 3}" fill="${s.col}" stroke="var(--bg-card)" />`;
      });
    });
    svg += C.xAxisAndHitLayer(items, state, padL, plotW, padT, plotH, H, selIdx);

    return `
      <div class="view-head"><div class="view-title-group"><h2 class="view-title">Groove &amp; tempo</h2><p class="view-insight">${C.esc(insight)}</p></div></div>
      ${C.legendHtml([{ label: "Audio drum complexity", color: "var(--c5)" }, { label: "Drum quantized %", color: "var(--c1)" }, { label: "Bass quantized %", color: "var(--c2)" }, { label: "BPM median", color: "var(--c3)", dashed: true }])}
      <div class="subpanel"><div id="gr-stage-wrap" class="svg-stage"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg></div></div>`;
  }

  function renderMelody(items, d, selIdx, state) {
    const C = window.ME_CHARTS;
    const insight = "Stepwise lyricism and post-leap gap-fill rose dramatically in Ecstatic Wave & Sketches 2026 while preserving melodic breathing space.";
    const W = Math.max(460, C.measureStageWidth("mel-stage-wrap", 960));
    const H = items.length > 8 ? 316 : 300, padL = 46, padR = 52, padT = state.granularity === "eras" ? 26 : 16, padB = items.length > 8 ? 54 : 28;
    const plotW = W - padL - padR, plotH = H - padT - padB, colW = plotW / items.length, xC = (i) => padL + colW * (i + 0.5);
    const yPct = (p) => (p === null || !Number.isFinite(p) ? null : padT + plotH * (1 - Math.min(1, p / 50)));
    const yMidi = (m) => (m === null || !Number.isFinite(m) ? null : padT + plotH * (1 - Math.max(0, Math.min(1, (m - 42) / 34))));

    let svg = C.phaseDividerLayer(items, state, padL, plotW, padT, plotH);
    svg += C.gridAxesLayer(padL, plotW, padT, plotH, [0, 0.5, 1], (r) => `${Math.round(r * 50)}%`, (r) => `M${Math.round(42 + r * 34)}`);
    [
      { fn: (it) => yPct(it.lead_step_pct), col: "var(--c1)", dashed: false },
      { fn: (it) => yPct(it.lead_gapfill_pct), col: "var(--c6)", dashed: false },
      { fn: (it) => yMidi(it.lead_midi_p50), col: "var(--c3)", dashed: true },
      { fn: (it) => yMidi(it.audio_midi_p50), col: "var(--c2)", dashed: true },
    ].forEach((s) => {
      const pts = items.map((it, i) => ({ x: xC(i), y: s.fn(it) }));
      svg += `<path d="${C.svgLinePath(pts)}" fill="none" stroke="${s.col}" stroke-width="2.2" ${s.dashed ? 'stroke-dasharray="4,3"' : ""} />`;
      pts.forEach((pt, i) => { if (pt.y !== null) svg += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${i === selIdx ? 4.8 : 3.2}" fill="${s.col}" />`; });
    });
    svg += C.xAxisAndHitLayer(items, state, padL, plotW, padT, plotH, H, selIdx);

    return `
      <div class="view-head"><div class="view-title-group"><h2 class="view-title">Melody &amp; space</h2><p class="view-insight">${C.esc(insight)}</p></div></div>
      ${C.legendHtml([{ label: "MIDI stepwise %", color: "var(--c1)" }, { label: "Leap-fill %", color: "var(--c6)" }, { label: "Lead MIDI register", color: "var(--c3)", dashed: true }, { label: "Audio melodic register", color: "var(--c2)", dashed: true }])}
      <div class="subpanel"><div id="mel-stage-wrap" class="svg-stage"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg></div></div>`;
  }

  function renderAudioExp(items, d, selIdx, state) {
    const C = window.ME_CHARTS;
    const insight = "Expressive phrasing in audio stems (2013+): audio legato climbed from 31% to 52% (80.5% in Spirit Guides) with 48–74¢ vibrato & pitch bends.";
    const W = Math.max(460, C.measureStageWidth("au-stage-wrap", 960));
    const H = items.length > 8 ? 316 : 300, padL = 46, padR = 48, padT = state.granularity === "eras" ? 26 : 16, padB = items.length > 8 ? 54 : 28;
    const plotW = W - padL - padR, plotH = H - padT - padB, colW = plotW / items.length, xC = (i) => padL + colW * (i + 0.5);
    const yPct = (p) => (p === null || !Number.isFinite(p) ? null : padT + plotH * (1 - p / 100));
    const yCents = (c) => (c === null || !Number.isFinite(c) ? null : padT + plotH * (1 - Math.min(1, c / 90)));

    let svg = C.phaseDividerLayer(items, state, padL, plotW, padT, plotH);
    svg += C.gridAxesLayer(padL, plotW, padT, plotH, [0, 0.5, 1], (r) => `${Math.round(r * 100)}%`, (r) => `${Math.round(r * 90)}¢`);
    [
      { fn: (it) => yPct(it.audio_legato_pct), col: "var(--c1)", dashed: false },
      { fn: (it) => yPct(it.midi_legato_pct), col: "var(--c6)", dashed: true },
      { fn: (it) => yCents(it.audio_vib_cents), col: "var(--c4)", dashed: false },
    ].forEach((s) => {
      const pts = items.map((it, i) => ({ x: xC(i), y: s.fn(it) }));
      svg += `<path d="${C.svgLinePath(pts)}" fill="none" stroke="${s.col}" stroke-width="2.3" ${s.dashed ? 'stroke-dasharray="4,3"' : ""} />`;
      pts.forEach((pt, i) => { if (pt.y !== null) svg += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${i === selIdx ? 4.8 : 3.2}" fill="${s.col}" />`; });
    });
    svg += C.xAxisAndHitLayer(items, state, padL, plotW, padT, plotH, H, selIdx);

    return `
      <div class="view-head"><div class="view-title-group"><h2 class="view-title">Audio expressiveness</h2><p class="view-insight">${C.esc(insight)}</p></div></div>
      ${C.legendHtml([{ label: "Audio legato %", color: "var(--c1)" }, { label: "MIDI legato %", color: "var(--c6)", dashed: true }, { label: "Audio vibrato/bend ¢", color: "var(--c4)" }])}
      <div class="subpanel"><div id="au-stage-wrap" class="svg-stage"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg></div></div>`;
  }

  function renderPalette(items, d, selIdx) {
    const C = window.ME_CHARTS;
    const insight = "Synth, instrument & processing evolution from early DAWs & live bands to Maschine/Diva, Omnisphere/Chromaphone, and Live 12.";
    const cards = items.map((it, i) => {
      const insts = (it.top_inst || []).map((x) => `<span class="gear-pill">${C.esc(x)}</span>`).join("");
      const fxs = (it.top_fx || []).map((x) => `<span class="gear-pill">${C.esc(x)}</span>`).join("");
      const fallback = it.archive_only ? `<span class="gear-pill">Pre-2013 Audio Archive</span>` : "";
      const modes = (it.top_modes_midi && it.top_modes_midi.length ? it.top_modes_midi : it.top_modes_audio || []).slice(0, 2).join(" / ") || "n/a";
      return `
        <button type="button" data-era-idx="${i}" class="palette-card ${i === selIdx ? "is-active" : ""}">
          <div>
            <div style="display:flex;justify-content:space-between;gap:6px;margin-bottom:8px">
              <strong>${C.esc(it.label)}</strong>
              <span class="muted">${C.esc(it.sublabel)}</span>
            </div>
            <div class="pill-stack" style="margin-bottom:6px">${insts || fallback}</div>
            <div class="pill-stack">${fxs}</div>
          </div>
          <div class="muted" style="font-size:11px">Modes: ${C.esc(modes)}</div>
        </button>`;
    }).join("");

    return `
      <div class="view-head"><div class="view-title-group"><h2 class="view-title">Synths &amp; FX palette</h2><p class="view-insight">${C.esc(insight)}</p></div></div>
      <div class="palette-grid">${cards}</div>`;
  }

  function renderEraInspector(d, playId) {
    const C = window.ME_CHARTS;
    const mh = d.macro_harmony || {};
    const tracksHtml = (d.tracks || []).map((t) => {
      const isPlaying = playId === t.id;
      return `
        <button type="button" class="track-btn ${isPlaying ? "is-playing" : ""}" data-track-play="${C.esc(t.id)}">
          <span class="ms filled" style="font-size:18px">${isPlaying ? "stop" : "play_arrow"}</span>
          <span>${C.esc(t.shortTitle || t.title)}</span>
          <span class="badge badge-amber">E${t.energy}</span>
        </button>`;
    }).join("");

    return `
      <div class="era-insp-top">
        <div>
          <strong style="font-family:var(--font-display);font-size:16px">${C.esc(d.label)}</strong>
          <span class="muted" style="margin-left:8px">${C.esc(d.sublabel)}${d.daw ? ` · ${C.esc(d.daw)}` : ""}</span>
        </div>
        <div class="era-track-row">${tracksHtml}</div>
      </div>
      <div class="inspector-kpis">
        <div class="kpi-box"><div class="kpi-lbl">MIK energy (median)</div><div class="kpi-val">E${C.num(mh.mik_energy_med, "/10")}</div></div>
        <div class="kpi-box"><div class="kpi-lbl">Macro harmonic complexity</div><div class="kpi-val">${C.num(mh.complexity, "/100")}</div></div>
        <div class="kpi-box"><div class="kpi-lbl">Drum complexity</div><div class="kpi-val">${C.num(mh.drum_complexity_med, "/100")}</div></div>
        <div class="kpi-box"><div class="kpi-lbl">Median tempo</div><div class="kpi-val">${C.num(d.bpm_p50, " BPM", 0)}</div></div>
      </div>`;
  }

  window.ME_VIEWS_EVOLUTION = {
    COMPARE_PRESETS,
    renderEraCompare,
    renderWorkflow,
    renderGroove,
    renderMelody,
    renderAudioExp,
    renderPalette,
    renderEraInspector,
  };
})();
