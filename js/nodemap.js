// Interactive Hybrid Canvas + SVG Vibe Map & Energy-Wave Era Stage
// Features 8-cluster palette, 60fps canvas nodes/edges, and container-level Euclidean nearest-node hit-testing.
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const PAD = 56;
  const LINKS = 2;
  const MORPH_MS = 620;
  const HIT_MOUSE_PX = 30;
  const HIT_TOUCH_PX = 42;
  const DRAG_MOUSE_PX = 8;
  const DRAG_TOUCH_PX = 14;

  const CLUSTER_VARS = [
    "--md-sys-color-cluster-0",
    "--md-sys-color-cluster-1",
    "--md-sys-color-cluster-2",
    "--md-sys-color-cluster-3",
    "--md-sys-color-cluster-4",
    "--md-sys-color-cluster-5",
    "--md-sys-color-cluster-6",
    "--md-sys-color-cluster-7",
    "--md-sys-color-cluster-8",
    "--md-sys-color-cluster-9",
    "--md-sys-color-cluster-10",
  ];
  const PHASE_VARS = {
    phase0_archive: "--md-sys-color-cluster-4",
    phase1_early: "--md-sys-color-cluster-0",
    phase2_mid: "--md-sys-color-cluster-5",
    phase3_ambient: "--md-sys-color-cluster-2",
    phase4_recent: "--md-sys-color-cluster-7",
  };

  let hooks = null;
  let tracks = [];
  let eras = [];
  let byId = new Map();
  let erasById = new Map();
  let styleGroups = [];
  let eraAnchors = [];
  let trackMap = {};
  let trackNear = {};

  let mapWrap = null;
  let canvas = null;
  let ctx = null;
  let svg = null;
  let groupG = null;
  let ringG = null;
  let hoverPill = null;
  let starBtn = null;
  let sketchBtn = null;
  let eraGenAiBtn = null;
  let hudHintEl = null;
  let hudHoverTarget = null; // "star" | "sketch" | "genai" | null
  let starEmptyEl = null;

  let nodes = [];
  let nodeById = new Map();
  let edges = [];
  let eraLayout = null;
  let vibeLayout = null;
  let groupEls = [];

  let layout = "vibe"; // "vibe" | "era"
  let colorMode = "cluster"; // "cluster" | "energy" | "era"
  let filterSet = null;
  let starFilter = false;
  let showSketches = false;
  let showVibeGenAi = false;
  let showEraGenAi = false;
  let activeClusterId = null;
  let activeEraId = null;
  let selectedId = null;
  let hoverId = null;

  let vw = 1000;
  let vh = 700;
  let dpr = 1;
  let zoom = { k: 1, x: 0, y: 0 };
  let tweenRaf = 0;
  let resizeRaf = 0;
  let palette = {};

  function samplePalette() {
    if (typeof document === "undefined" || typeof getComputedStyle !== "function") return;
    const cs = getComputedStyle(document.documentElement);
    const val = (v, fb) => (cs.getPropertyValue(v) || "").trim() || fb;
    palette = {
      clusters: CLUSTER_VARS.map((v, i) => val(v, i % 2 ? "#80CFFF" : "#A7C7FA")),
      phases: Object.fromEntries(Object.entries(PHASE_VARS).map(([k, v]) => [k, val(v, "#A7C7FA")])),
      energy: [
        val("--md-sys-color-cluster-0", "#60A5FA"),
        val("--md-sys-color-cluster-2", "#2DD4BF"),
        val("--md-sys-color-cluster-3", "#4ADE80"),
        val("--md-sys-color-cluster-4", "#FBBF24"),
        val("--md-sys-color-cluster-7", "#FB7185"),
      ],
      primary: val("--md-sys-color-primary", "#D0BCFF"),
      outline: val("--md-sys-color-outline-variant", "#444746"),
      edgeLine: val("--md-sys-color-outline", "#8E9099"),
      edgeLineDark: val("--md-sys-color-on-surface-variant", "#C2C5D0"),
      surfaceLowest: val("--md-sys-color-surface-container-lowest", "#16161B"),
      onSurface: val("--md-sys-color-on-surface", "#E8E9EF"),
      playing: val("--md-sys-color-cluster-2", "#2DD4BF"),
      queued: val("--md-sys-color-cluster-4", "#FBBF24"),
      bandAlt: val("--md-sys-color-surface-container", "#1C1C22"),
      bandActive: val("--md-sys-color-surface-container-high", "#262730"),
      gridLine: val("--md-sys-color-outline-variant", "#3D404A"),
      spineGlow: val("--md-sys-color-primary-container", "#4F378B"),
    };
  }

  function normLayoutName(lay) {
    if (lay === "similarity") return "vibe";
    return lay === "era" ? "era" : "vibe";
  }

  function elSvg(tag, cls) {
    const e = document.createElementNS(NS, tag);
    if (cls) e.setAttribute("class", cls);
    return e;
  }

  function energyColor(en) {
    const e = palette.energy || [];
    if (en <= 2) return e[0] || palette.primary;
    if (en <= 4) return e[1] || palette.primary;
    if (en === 5) return e[2] || palette.primary;
    if (en <= 6) return e[3] || palette.primary;
    return e[4] || palette.primary;
  }

  function trackColor(t) {
    if (colorMode === "energy") return energyColor(t.energy);
    if (colorMode === "era") {
      const er = erasById.get(t.era);
      return (palette.phases && palette.phases[er && er.phase]) || palette.primary;
    }
    const cols = palette.clusters || [];
    const idx = Number.isFinite(t.cluster_idx) ? t.cluster_idx : 0;
    return cols[((idx % cols.length) + cols.length) % cols.length] || palette.primary;
  }

  function nodeScreenRadius(t) {
    const e = Math.max(1, Math.min(10, Number(t.energy || 4)));
    const isMobileEra = layout === "era" && vw <= 800;
    const base = vw <= 600 && !isMobileEra
      ? 2.5 + ((e - 1) / 9) * 1.1
      : 3.4 + ((e - 1) / 9) * 1.5;
    // Shrink circle size in screen pixels as you zoom in so dense clusters open up for all track labels
    const zoomShrink = zoom.k <= 1 ? 1 : Math.max(0.56, 1 / Math.pow(zoom.k, 0.28));
    return Math.max(2.0, base * zoomShrink);
  }

  function isGenAiShown() {
    return layout === "era" ? showEraGenAi : showVibeGenAi;
  }

  function isSketchHidden(t) {
    if (!t) return false;
    if (Boolean(t.is_ai) && !isGenAiShown()) return true;
    const hideSketch = !showSketches && Boolean(t.is_sketch);
    if (!hideSketch) return false;
    const playId = hooks && hooks.playing ? hooks.playing() : null;
    const pendId = hooks && hooks.pending ? hooks.pending() : null;
    if (t.id === selectedId || t.id === playId || t.id === pendId) return false;
    return true;
  }

  // Fan out co-located or near-touching screen dots into a small ring (Groove Explorer style)
  function computeScreenPositions() {
    const T = 7.5;
    const raw = nodes.map((n) => [n.x * zoom.k + zoom.x, n.y * zoom.k + zoom.y]);
    const taken = new Set();
    for (let i = 0; i < nodes.length; i++) {
      if (taken.has(i)) continue;
      if (isSketchHidden(nodes[i].t) || !isMatch(nodes[i].t)) {
        nodes[i].px = raw[i][0];
        nodes[i].py = raw[i][1];
        nodes[i].fanAngle = null;
        taken.add(i);
        continue;
      }
      const grp = [i];
      taken.add(i);
      for (let j = i + 1; j < nodes.length; j++) {
        if (taken.has(j) || isSketchHidden(nodes[j].t) || !isMatch(nodes[j].t)) continue;
        if (Math.abs(raw[i][0] - raw[j][0]) < T && Math.hypot(raw[i][0] - raw[j][0], raw[i][1] - raw[j][1]) < T) {
          grp.push(j);
          taken.add(j);
        }
      }
      if (grp.length === 1) {
        nodes[i].px = raw[i][0];
        nodes[i].py = raw[i][1];
        nodes[i].fanAngle = null;
        continue;
      }
      const cx = grp.reduce((acc, idx) => acc + raw[idx][0], 0) / grp.length;
      const cy = grp.reduce((acc, idx) => acc + raw[idx][1], 0) / grp.length;
      const gap = Math.min(40, Math.max(10, 12 * Math.sqrt(Math.max(1, zoom.k))));
      const ringR = Math.max(7, grp.length === 2 ? gap * 0.5 : gap / (2 * Math.sin(Math.PI / grp.length)));
      for (let k = 0; k < grp.length; k++) {
        const ang = -Math.PI / 2 + (2 * Math.PI * k) / grp.length;
        const ni = grp[k];
        nodes[ni].px = cx + ringR * Math.cos(ang);
        nodes[ni].py = cy + ringR * Math.sin(ang);
        nodes[ni].fanAngle = ang;
      }
    }
  }

  function territoryOf(t) {
    if (t && t.is_spoken_word) return "spoken";
    if (t && t.is_ai) return "ai";
    return "music";
  }

  function constellationKeyOf(t) {
    if (!t) return "";
    if (t.is_spoken_word) return "spoken";
    if (t.is_ai) return t.ai_sub_id || "ai_generative";
    return t.cluster_id || String(t.cluster_idx || 0);
  }

  function isClusterMatch(t) {
    if (!activeClusterId) return true;
    if (activeClusterId === "spoken_word") return Boolean(t.is_spoken_word);
    if (activeClusterId === "ai_generative") return Boolean(t.is_ai);
    if (activeClusterId.startsWith("ai_sub_")) return Boolean(t.is_ai) && t.ai_sub_id === activeClusterId;
    return !t.is_ai && !t.is_spoken_word && t.cluster_id === activeClusterId;
  }

  function eraKeyOf(t) {
    return t && t.is_ai ? "genai_2025" : (t ? t.era : "");
  }

  function isMatch(t) {
    if (isSketchHidden(t)) return false;
    if (filterSet && !filterSet.has(t.id)) return false;
    if (starFilter && window.BTMM_PLAYER && !window.BTMM_PLAYER.isStarred(t.id)) return false;
    if (layout === "vibe" && !isClusterMatch(t)) return false;
    if (layout === "era" && activeEraId && eraKeyOf(t) !== activeEraId) return false;
    return true;
  }

  function computeVibeLayout() {
    const isMobile = vw <= 768;
    const topPad = vw <= 800 ? 64 : PAD;
    const sidePad = vw <= 800 ? 16 : PAD;
    const botPad = vw <= 800 ? 24 : PAD;
    const rawW = Math.max(220, vw - sidePad * 2);
    const rawH = Math.max(200, vh - topPad - botPad);

    let hMinX = Infinity, hMaxX = -Infinity;
    let aMinX = Infinity, aMaxX = -Infinity;
    let hasHuman = false, hasAi = false;

    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t || t.is_spoken_word) continue;
      const coords = trackMap[t.id];
      const norm = coords && (coords.vibe || coords.similarity);
      if (!norm) continue;
      const nx = norm[0];
      if (t.is_ai) {
        if (showVibeGenAi) {
          if (nx < aMinX) aMinX = nx;
          if (nx > aMaxX) aMaxX = nx;
          hasAi = true;
        }
      } else {
        if (nx < hMinX) hMinX = nx;
        if (nx > hMaxX) hMaxX = nx;
        hasHuman = true;
      }
    }

    let offsetX = sidePad;
    let spanW = rawW;
    let virtualW = vw;

    if (hasHuman && hasAi && showVibeGenAi && aMaxX > hMinX + 0.05) {
      // Show Gen AI is ON: fit both the handcrafted constellation and the cohesive AI constellation cleanly on screen
      const aiPadX = vw > 840 ? 32 : 12;
      const leftPad = isMobile ? 16 : 64;
      const rightPad = isMobile ? 12 : 28;
      const denom = Math.max(0.20, aMaxX - hMinX);
      spanW = Math.max(180, (vw - leftPad - rightPad - aiPadX) / denom);
      offsetX = leftPad - hMinX * spanW;
      virtualW = vw;
    } else if (hasHuman && !showVibeGenAi && hMaxX > hMinX + 0.05) {
      // Show Gen AI is OFF (default): center 100% of the human-made catalog cleanly across the full viewport
      const sideMargin = isMobile ? 22 : Math.max(88, Math.round(vw * 0.085));
      spanW = (vw - sideMargin * 2) / (hMaxX - hMinX);
      offsetX = sideMargin - hMinX * spanW;
      virtualW = vw;
    }

    const h = vh > vw * 1.15
      ? Math.min(rawH, Math.max(rawH * 0.92, rawW * 1.45))
      : rawH;
    const startY = topPad + (rawH - h) * 0.45;
    const spreadScale = Math.max(1, Math.min(1.55, Math.hypot(spanW / rawW, 1) / Math.SQRT2));

    return {
      offsetX,
      spanW,
      startY,
      spanH: h,
      virtualW,
      virtualH: vh,
      spreadScale,
      defaultZoom: { k: 1, x: 0, y: 0 },
    };
  }

  function vibeTarget(tid) {
    const coords = trackMap[tid];
    const norm = (coords && (coords.vibe || coords.similarity)) || [0.5, 0.5];
    const vl = vibeLayout || computeVibeLayout();
    let tx = vl.offsetX + norm[0] * vl.spanW;
    const tr = byId.get(tid);
    if (tr && tr.is_spoken_word && !showVibeGenAi) {
      tx = Math.min(vw - 74, tx);
    }
    return [tx, vl.startY + norm[1] * vl.spanH];
  }

  function computeTargetPositions() {
    if (layout === "era" && window.BTMM_TIMELINE_ERA) {
      vibeLayout = null;
      const visTracks = tracks.filter((t) => !isSketchHidden(t));
      eraLayout = window.BTMM_TIMELINE_ERA.computeLayout(visTracks, eras, erasById, vw, vh);
      nodes.forEach((n) => {
        const c = eraLayout.coords.get(n.id);
        n.tx = c ? c.x : vw * 0.5;
        n.ty = c ? c.y : vh * 0.5;
      });
    } else {
      eraLayout = null;
      vibeLayout = computeVibeLayout();
      nodes.forEach((n) => {
        const [tx, ty] = vibeTarget(n.id);
        n.tx = tx;
        n.ty = ty;
      });
    }
  }

  function buildEdges() {
    const pairs = new Map();
    const keyFor = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const addEdge = (a, b, w, weak) => {
      const k = keyFor(a, b);
      if (pairs.has(k)) return;
      const aCanon = a < b ? a : b;
      const bCanon = a < b ? b : a;
      pairs.set(k, { a: aCanon, b: bCanon, w, weak });
    };
    const visNodes = nodes.filter((n) => !isSketchHidden(n.t));
    const visSet = new Set(visNodes.map((n) => n.id));

    if (layout === "vibe") {
      const minDim = Math.min(vw, vh);
      const spreadScale = (vibeLayout && vibeLayout.spreadScale) || 1;
      const maxChordPx = minDim * 0.145 * spreadScale;
      const maxIntraBridgePx = minDim * 0.22 * spreadScale;
      const maxWebPx = minDim * 0.275 * spreadScale;
      const maxSpanBridgePx = minDim * 0.36 * spreadScale;
      const MIN_CHORD_SIM = 0.56;
      const MIN_INTRA_SPAN_SIM = 0.28;

      const nearSim = new Map();
      visNodes.forEach((n) => {
        const tid = n.id;
        (trackNear[tid] || []).forEach(([nid, sim]) => {
          if (!visSet.has(nid)) return;
          const k = keyFor(tid, nid);
          const prev = nearSim.get(k) || 0;
          if (sim > prev) nearSim.set(k, sim);
        });
      });

      // Pass 1a: Intra-constellation local chords (strong internal skeleton)
      visNodes.forEach((n) => {
        const t = n.t;
        if (t.is_spoken_word) return;
        const tTerr = territoryOf(t);
        const tConst = constellationKeyOf(t);
        const minChordSim = tTerr === "ai" ? 0.50 : MIN_CHORD_SIM;
        const candidates = (trackNear[t.id] || []).filter(([nid, sim]) => {
          if (sim < minChordSim) return false;
          if (!visSet.has(nid)) return false;
          const nb = nodeById.get(nid);
          if (!nb || territoryOf(nb.t) !== tTerr || constellationKeyOf(nb.t) !== tConst) return false;
          return Math.hypot(nb.tx - n.tx, nb.ty - n.ty) <= maxChordPx;
        }).slice(0, LINKS);
        candidates.forEach(([nid, sim]) => {
          addEdge(t.id, nid, sim, false);
        });
      });

      if (visNodes.length <= 800) {
        const parent = new Map(visNodes.map((n) => [n.id, n.id]));
        const find = (x) => {
          while (parent.get(x) !== x) {
            parent.set(x, parent.get(parent.get(x)));
            x = parent.get(x);
          }
          return x;
        };
        const unite = (a, b) => {
          const ra = find(a), rb = find(b);
          if (ra !== rb) { parent.set(ra, rb); return true; }
          return false;
        };
        pairs.forEach((e) => unite(e.a, e.b));

        // Pass 1b: Intra-constellation Kruskal connectivity so each genre forms one coherent constellation
        const intraCands = [];
        nearSim.forEach((sim, k) => {
          if (sim < MIN_INTRA_SPAN_SIM || pairs.has(k)) return;
          const sep = k.indexOf("|");
          const aId = k.slice(0, sep), bId = k.slice(sep + 1);
          const a = nodeById.get(aId), b = nodeById.get(bId);
          if (!a || !b || a.t.is_spoken_word || b.t.is_spoken_word) return;
          if (territoryOf(a.t) !== territoryOf(b.t)) return;
          if (constellationKeyOf(a.t) !== constellationKeyOf(b.t)) return;
          if (find(aId) === find(bId)) return;
          const d = Math.hypot(a.tx - b.tx, a.ty - b.ty);
          if (d > maxIntraBridgePx) return;
          intraCands.push({ a: aId, b: bId, d, sim, cost: d / Math.max(0.45, sim) });
        });
        intraCands.sort((p, q) => p.cost - q.cost);
        for (const c of intraCands) {
          if (unite(c.a, c.b)) addEdge(c.a, c.b, c.sim, false);
        }

        // Pass 2: Genuine cross-genre / cross-subfamily sonic web (strictly X_hybrid acoustic cousins in trackNear — zero blind pixel bridges!)
        const crossDeg = new Map();
        const pairConstCnt = new Map();
        const bumpCross = (aId, bId, cKey) => {
          crossDeg.set(aId, (crossDeg.get(aId) || 0) + 1);
          crossDeg.set(bId, (crossDeg.get(bId) || 0) + 1);
          pairConstCnt.set(cKey, (pairConstCnt.get(cKey) || 0) + 1);
        };

        // Pass 2a: Acoustic spanning spine so all constellations weave into one connected web
        const spanCands = [];
        nearSim.forEach((sim, k) => {
          if (pairs.has(k)) return;
          const sep = k.indexOf("|");
          const aId = k.slice(0, sep), bId = k.slice(sep + 1);
          const a = nodeById.get(aId), b = nodeById.get(bId);
          if (!a || !b || a.t.is_spoken_word || b.t.is_spoken_word) return;
          const terr = territoryOf(a.t);
          if (terr !== territoryOf(b.t)) return;
          const ca = constellationKeyOf(a.t), cb = constellationKeyOf(b.t);
          if (ca === cb) return;
          const minSim = terr === "ai" ? 0.58 : 0.645;
          if (sim < minSim) return;
          const d = Math.hypot(a.tx - b.tx, a.ty - b.ty);
          const maxSpanPx = terr === "ai" ? minDim * 0.26 * spreadScale : maxSpanBridgePx;
          if (d > maxSpanPx) return;
          spanCands.push({ a: aId, b: bId, ca, cb, d, sim, cost: d / (sim * sim) });
        });
        spanCands.sort((p, q) => p.cost - q.cost);
        for (const c of spanCands) {
          if (unite(c.a, c.b)) {
            const cKey = keyFor(c.ca, c.cb);
            addEdge(c.a, c.b, c.sim, true);
            bumpCross(c.a, c.b, cKey);
          }
        }

        // Pass 2b: Multi-filament coastal cousin weave across acoustically related neighboring genres
        const weaveCands = [];
        nearSim.forEach((sim, k) => {
          if (pairs.has(k)) return;
          const sep = k.indexOf("|");
          const aId = k.slice(0, sep), bId = k.slice(sep + 1);
          const a = nodeById.get(aId), b = nodeById.get(bId);
          if (!a || !b || a.t.is_spoken_word || b.t.is_spoken_word) return;
          const terr = territoryOf(a.t);
          if (terr !== territoryOf(b.t)) return;
          const ca = constellationKeyOf(a.t), cb = constellationKeyOf(b.t);
          if (ca === cb) return;
          const minSim = terr === "ai" ? 0.62 : 0.65;
          if (sim < minSim) return;
          const d = Math.hypot(a.tx - b.tx, a.ty - b.ty);
          const maxTerrWebPx = terr === "ai" ? minDim * 0.195 * spreadScale : minDim * 0.265 * spreadScale;
          if (d > maxTerrWebPx) return;
          const score = sim - 0.22 * (d / maxTerrWebPx);
          weaveCands.push({ a: aId, b: bId, ca, cb, terr, sim, score });
        });
        weaveCands.sort((p, q) => q.score - p.score);
        for (const c of weaveCands) {
          const maxNodeCross = 2;
          if ((crossDeg.get(c.a) || 0) >= maxNodeCross || (crossDeg.get(c.b) || 0) >= maxNodeCross) continue;
          const cKey = keyFor(c.ca, c.cb);
          const maxPair = c.terr === "ai" ? 5 : 4;
          if ((pairConstCnt.get(cKey) || 0) >= maxPair) continue;
          addEdge(c.a, c.b, c.sim, true);
          bumpCross(c.a, c.b, cKey);
        }
      }
    } else {
      // Intra-era subtle harmonic arcs (nearest visible within same era & musical territory)
      const byEra = new Map();
      visNodes.forEach((n) => {
        const t = n.t;
        if (t.is_spoken_word) return;
        const ek = eraKeyOf(t);
        if (!byEra.has(ek)) byEra.set(ek, []);
        byEra.get(ek).push(t);
      });
      byEra.forEach((list) => {
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          const tTerr = territoryOf(t);
          const ek = eraKeyOf(t);
          let near = (trackNear[t.id] || []).find(([nid]) => {
            if (!visSet.has(nid)) return false;
            const nt = byId.get(nid);
            return nt && eraKeyOf(nt) === ek && territoryOf(nt) === tTerr;
          });
          if (!near && Array.isArray(t.feat_vec) && t.feat_vec.length) {
            let bestId = null;
            let bestSim = 0.45;
            const va = t.feat_vec;
            let na = 0;
            for (let k = 0; k < va.length; k++) na += va[k] * va[k];
            na = Math.sqrt(na) || 1;
            for (let j = 0; j < list.length; j++) {
              if (i === j) continue;
              const cand = list[j];
              if (territoryOf(cand) !== tTerr || !Array.isArray(cand.feat_vec)) continue;
              const vb = cand.feat_vec;
              let dot = 0, nb = 0;
              const len = Math.min(va.length, vb.length);
              for (let k = 0; k < len; k++) { dot += va[k] * vb[k]; nb += vb[k] * vb[k]; }
              const sim = dot / (na * (Math.sqrt(nb) || 1));
              if (sim > bestSim) { bestSim = sim; bestId = cand.id; }
            }
            if (bestId) near = [bestId, bestSim];
          }
          if (near) {
            const k = keyFor(t.id, near[0]);
            if (!pairs.has(k)) pairs.set(k, { a: t.id, b: near[0], w: near[1], weak: true });
          }
        }
      });
    }
    edges = [...pairs.values()];
  }

  function repaintLabelsFrame() {
    paintCanvas();
    drawFloatingLabels();
  }

  function drawFloatingLabels() {
    if (!groupG) return;
    groupEls = [];

    if (layout === "era" && window.BTMM_TIMELINE_ERA && eraLayout) {
      if (window.BTMM_MAP_LABELS && window.BTMM_MAP_LABELS.clearClusterDom) {
        window.BTMM_MAP_LABELS.clearClusterDom(groupG);
      } else {
        groupG.innerHTML = "";
      }
      window.BTMM_TIMELINE_ERA.renderOverlay(groupG, eraLayout, zoom, vw, vh, activeEraId, (eraId) => {
        activeEraId = activeEraId === eraId ? null : eraId;
        activeClusterId = null;
        paint();
      });
      return;
    }

    if (window.BTMM_MAP_LABELS) {
      window.BTMM_MAP_LABELS.renderClusterLandmarks(groupG, {
        styleGroups,
        nodeById,
        nodes,
        zoom,
        vw,
        vh,
        activeClusterId,
        isMatch,
        isHidden: isSketchHidden,
        mapWrap,
        onRequestFrame: repaintLabelsFrame,
        onToggleCluster: (cid) => setClusterFilter(activeClusterId === cid ? null : cid),
      });
    }
  }

  function updateHudHint() {
    const starLbl = document.getElementById("star-btn-label");
    const sketchLbl = document.getElementById("sketch-btn-label");
    const genaiLbl = document.getElementById("era-genai-btn-label");
    const genAiActive = isGenAiShown();
    if (starLbl) starLbl.textContent = starFilter ? "Starred only · On" : "Starred only";
    if (sketchLbl) sketchLbl.textContent = showSketches ? "Hide sketches" : "Show sketches";
    if (genaiLbl) genaiLbl.textContent = genAiActive ? "Hide Gen AI" : "Show Gen AI";
    if (starBtn) starBtn.classList.toggle("is-hint-open", hudHoverTarget === "star");
    if (sketchBtn) sketchBtn.classList.toggle("is-hint-open", hudHoverTarget === "sketch");
    if (eraGenAiBtn) eraGenAiBtn.classList.toggle("is-hint-open", hudHoverTarget === "genai");
  }

  function syncStarHud() {
    if (starBtn) {
      starBtn.classList.toggle("is-active", starFilter);
      starBtn.setAttribute("aria-pressed", String(starFilter));
      starBtn.setAttribute("aria-label", starFilter ? "Starred only (active)" : "Starred only");
    }
    if (sketchBtn) {
      sketchBtn.classList.toggle("is-active", showSketches);
      sketchBtn.setAttribute("aria-pressed", String(showSketches));
      sketchBtn.setAttribute("aria-label", showSketches ? "Hide sketches" : "Show sketches");
    }
    if (eraGenAiBtn) {
      const genAiActive = isGenAiShown();
      eraGenAiBtn.hidden = false;
      eraGenAiBtn.classList.toggle("is-active", genAiActive);
      eraGenAiBtn.setAttribute("aria-pressed", String(genAiActive));
      eraGenAiBtn.setAttribute("aria-label", genAiActive ? "Hide Gen AI" : "Show Gen AI");
    }
    updateHudHint();
    if (starEmptyEl) {
      const cnt = window.BTMM_PLAYER ? window.BTMM_PLAYER.starredCount() : 0;
      starEmptyEl.hidden = !(starFilter && cnt === 0);
    }
  }

  function updateHoverPill() {
    if (!hoverPill) return;
    const hn = hoverId ? nodeById.get(hoverId) : null;
    const alreadyLabeled = hn && window.BTMM_MAP_LABELS && window.BTMM_MAP_LABELS.isLabelShown && window.BTMM_MAP_LABELS.isLabelShown(hn.id);
    if (!hn || !isMatch(hn.t) || alreadyLabeled) {
      hoverPill.hidden = true;
      return;
    }
    const sx = Number.isFinite(hn.px) ? hn.px : hn.x * zoom.k + zoom.x;
    const sy = Number.isFinite(hn.py) ? hn.py : hn.y * zoom.k + zoom.y;
    const r = nodeScreenRadius(hn.t);
    const wip = Boolean(window.isTrackWorkInProgress && window.isTrackWorkInProgress(hn.t));
    const baseText = hn.t.discogs_top ? `${hn.t.title} · ${hn.t.discogs_top}` : hn.t.title;
    hoverPill.innerHTML = "";
    const txtSpan = document.createElement("span");
    txtSpan.textContent = baseText;
    hoverPill.appendChild(txtSpan);
    if (wip) {
      const wipSpan = document.createElement("span");
      wipSpan.className = "mp-wip-pill";
      wipSpan.textContent = "Work in progress";
      hoverPill.appendChild(wipSpan);
    }
    hoverPill.style.left = `${sx.toFixed(1)}px`;
    hoverPill.style.top = `${Math.max(44, sy - r - 12).toFixed(1)}px`;
    hoverPill.hidden = false;
  }

  function paintRings(playId, pendId) {
    if (!ringG) return;
    ringG.innerHTML = "";

    const targets = [];
    if (hoverId && hoverId !== selectedId && hoverId !== playId) targets.push({ id: hoverId, kind: "hover" });
    if (pendId && pendId !== playId) targets.push({ id: pendId, kind: "queued" });
    if (selectedId) targets.push({ id: selectedId, kind: "selected" });
    if (playId) targets.push({ id: playId, kind: "playing" });

    targets.forEach((item) => {
      const n = nodeById.get(item.id);
      if (!n) return;
      const sx = Number.isFinite(n.px) ? n.px : n.x * zoom.k + zoom.x;
      const sy = Number.isFinite(n.py) ? n.py : n.y * zoom.k + zoom.y;
      const baseR = nodeScreenRadius(n.t);

      if (item.kind === "hover") {
        const aura = elSvg("circle");
        aura.setAttribute("cx", sx.toFixed(1));
        aura.setAttribute("cy", sy.toFixed(1));
        aura.setAttribute("r", "16");
        aura.setAttribute("fill", trackColor(n.t));
        aura.setAttribute("fill-opacity", "0.2");
        ringG.appendChild(aura);
      } else {
        const ring = elSvg("circle");
        ring.setAttribute("cx", sx.toFixed(1));
        ring.setAttribute("cy", sy.toFixed(1));
        ring.setAttribute("r", String((baseR + 4.4).toFixed(1)));
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", item.kind === "playing" ? palette.playing : item.kind === "queued" ? palette.queued : palette.primary);
        ring.setAttribute("stroke-width", item.kind === "playing" ? "2.2" : "1.9");
        if (item.kind === "playing") ring.setAttribute("stroke-dasharray", "4 2.5");
        else if (item.kind === "queued") ring.setAttribute("stroke-dasharray", "3 3");
        ringG.appendChild(ring);
      }
    });
  }

  function paintCanvas() {
    if (!ctx || !canvas) return;
    const playId = hooks ? hooks.playing() : null;
    const pendId = hooks ? hooks.pending() : null;
    const selTrack = selectedId ? byId.get(selectedId) : null;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);

    if (layout === "era" && window.BTMM_TIMELINE_ERA && eraLayout) {
      let visiblePlayerTopY = vh;
      let visiblePlayerLeftX = vw;
      if (typeof document !== "undefined" && mapWrap) {
        const card = document.getElementById("track-player-card");
        if (card && !card.hidden) {
          const mRect = mapWrap.getBoundingClientRect();
          const cRect = card.getBoundingClientRect();
          if (cRect.height > 20) {
            visiblePlayerTopY = Math.max(80, cRect.top - mRect.top);
            visiblePlayerLeftX = Math.max(120, cRect.left - mRect.left);
          }
        }
      }
      const [panSlackX, panSlackY] = getPanSlack();
      window.BTMM_TIMELINE_ERA.drawCanvasBackground(ctx, eraLayout, zoom, {
        bandAlt: palette.bandAlt,
        bandActive: palette.bandActive,
        gridLine: palette.gridLine,
        primary: palette.primary,
        spineGlow: palette.spineGlow,
        viewportW: vw,
        viewportH: vh,
        panSlackX,
        panSlackY,
        visiblePlayerTopY,
        visiblePlayerLeftX,
      }, activeEraId, selTrack);
    }

    computeScreenPositions();

    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    const zoomScale = Math.max(1, zoom.k);
    const spreadScale = layout === "vibe" && vibeLayout ? vibeLayout.spreadScale : 1;
    const maxLocalDist = Math.min(vw, vh) * 0.22 * spreadScale * zoomScale + 18;
    const maxBridgeDist = Math.min(vw, vh) * 0.36 * spreadScale * zoomScale + 24;

    // Draw edges & shrunk jewel circles directly in 1:1 screen space so zooming never inflates circle size
    edges.forEach((e) => {
      const a = nodeById.get(e.a);
      const b = nodeById.get(e.b);
      if (!a || !b) return;
      if (isSketchHidden(a.t) || isSketchHidden(b.t)) return;
      const selLit = Boolean(selectedId && (e.a === selectedId || e.b === selectedId));
      const hovLit = Boolean(!selLit && hoverId && (e.a === hoverId || e.b === hoverId));
      const lit = selLit || hovLit;
      const aMatch = isMatch(a.t);
      const bMatch = isMatch(b.t);
      if (starFilter && (!aMatch || !bMatch) && !lit) return;

      let edgeAlpha = isLight ? 0.30 : 0.34;
      let edgeWidth = 1.05;
      if (!lit && layout === "vibe") {
        const d = Math.hypot(b.px - a.px, b.py - a.py);
        if (!aMatch && !bMatch) {
          if (d >= (e.weak ? maxBridgeDist : maxLocalDist)) return;
          edgeAlpha = isLight ? 0.065 : 0.075;
          edgeWidth = e.weak ? 0.85 : 0.95;
        } else if (aMatch !== bMatch) {
          if (d >= maxBridgeDist) return;
          edgeAlpha = isLight ? 0.21 : 0.26;
          edgeWidth = 0.95;
        } else if (e.weak) {
          if (d >= maxBridgeDist) return;
          const tBridge = Math.max(0.48, 1 - (d / maxBridgeDist) * 0.56);
          const simBoost = 0.86 + 0.24 * Math.min(1, Math.max(0, ((e.w || 0.68) - 0.64) / 0.22));
          edgeAlpha = (isLight ? 0.32 : 0.36) * tBridge * simBoost;
          edgeWidth = 0.95;
        } else {
          if (d >= maxLocalDist) return;
          const tLocal = Math.max(0.48, 1 - (d / maxLocalDist) * 0.60);
          edgeAlpha = (isLight ? 0.48 : 0.54) * tLocal;
          edgeWidth = 1.15;
        }
        if (edgeAlpha < 0.02) return;
      } else if (!lit && !aMatch && !bMatch) {
        edgeAlpha = 0.07;
      }

      ctx.beginPath();
      if (layout === "era") {
        const mx = (a.px + b.px) * 0.5;
        const arcOff = -Math.min(34, Math.abs(b.px - a.px) * 0.25 + 14);
        ctx.moveTo(a.px, a.py);
        ctx.quadraticCurveTo(mx, (a.py + b.py) * 0.5 + arcOff, b.px, b.py);
      } else {
        ctx.moveTo(a.px, a.py);
        ctx.lineTo(b.px, b.py);
      }

      if (lit) {
        ctx.strokeStyle = palette.primary;
        ctx.globalAlpha = selLit ? 0.90 : 0.78;
        ctx.lineWidth = e.weak ? 1.55 : 1.9;
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = isLight ? (palette.edgeLine || palette.outline) : (palette.edgeLineDark || palette.edgeLine);
        ctx.globalAlpha = edgeAlpha;
        ctx.lineWidth = edgeWidth;
        ctx.setLineDash([]);
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);

    const drawPass = (wantMatch) => {
      nodes.forEach((n) => {
        if (isSketchHidden(n.t)) return;
        const match = isMatch(n.t);
        if (match !== wantMatch) return;
        if (starFilter && !match) return;
        if (n.px < -20 || n.px > vw + 20 || n.py < -20 || n.py > vh + 20) return;
        const isPlay = n.id === playId;
        const isSel = n.id === selectedId;
        const isHov = n.id === hoverId;
        let drawR = nodeScreenRadius(n.t);
        if (isPlay) drawR += 1.3;
        else if (isSel || isHov) drawR += 0.9;

        ctx.beginPath();
        ctx.arc(n.px, n.py, drawR, 0, Math.PI * 2);
        ctx.fillStyle = trackColor(n.t);
        ctx.globalAlpha = match ? 0.95 : 0.12;
        ctx.fill();

        if (isSel || isPlay || isHov) {
          ctx.lineWidth = 1.7;
          ctx.strokeStyle = palette.surfaceLowest;
          ctx.globalAlpha = 1;
          ctx.stroke();
        } else if (match) {
          ctx.lineWidth = 1.25;
          ctx.strokeStyle = palette.surfaceLowest;
          ctx.globalAlpha = 0.88;
          ctx.stroke();
        }
      });
    };
    drawPass(false);
    drawPass(true);

    if (window.BTMM_MAP_LABELS) {
      window.BTMM_MAP_LABELS.drawScreenTrackLabels(ctx, {
        nodes,
        nodeById,
        styleGroups,
        zoom,
        vw,
        vh,
        palette,
        isMatch,
        isHidden: isSketchHidden,
        activeClusterId,
        nodeScreenRadius,
        trackColor,
        playId,
        selectedId,
        hoverId,
        isStarred: (id) => Boolean(window.BTMM_PLAYER && window.BTMM_PLAYER.isStarred(id)),
        mapWrap,
        layout,
        eraLeftGutter: eraLayout && eraLayout.leftGutter ? eraLayout.leftGutter : 94,
        onRequestFrame: repaintLabelsFrame,
      });
    }

    ctx.restore();
    paintRings(playId, pendId);
    updateHoverPill();
  }

  function paint() {
    syncStarHud();
    paintCanvas();
    drawFloatingLabels();
    if (window.BTMM_PLAYER) window.BTMM_PLAYER.render();
  }

  function tweenToTargets(animate, durMs = MORPH_MS) {
    stopMomentum();
    if (tweenRaf && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(tweenRaf);
    nodes.forEach((n) => { n.sx = n.x; n.sy = n.y; });
    const reducedMotion = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const allowMorph = animate && !reducedMotion && nodes.length <= 800 && typeof requestAnimationFrame !== "undefined";
    if (!allowMorph) {
      nodes.forEach((n) => { n.x = n.tx; n.y = n.ty; });
      paint();
      return;
    }
    const t0 = performance.now();
    function step(now) {
      const u = Math.min(1, (now - t0) / durMs);
      const ease = 1 - Math.pow(1 - u, 3);
      nodes.forEach((n) => {
        n.x = n.sx + (n.tx - n.sx) * ease;
        n.y = n.sy + (n.ty - n.sy) * ease;
      });
      paintCanvas();
      if (u < 1) tweenRaf = requestAnimationFrame(step);
      else { tweenRaf = 0; drawFloatingLabels(); }
    }
    tweenRaf = requestAnimationFrame(step);
  }

  function hitRadiusForEvent(ev) {
    const base = isTouchEvent(ev) ? HIT_TOUCH_PX : HIT_MOUSE_PX;
    return zoom.k >= 1.55 ? base + 8 : base;
  }

  function findNearestVisibleNode(px, py, maxDist) {
    let best = null;
    let bestDist = maxDist;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!isMatch(n.t)) continue;
      const sx = Number.isFinite(n.px) ? n.px : n.x * zoom.k + zoom.x;
      const sy = Number.isFinite(n.py) ? n.py : n.y * zoom.k + zoom.y;
      const d = Math.hypot(px - sx, py - sy);
      if (d <= bestDist) {
        bestDist = d;
        best = n;
      }
    }
    if (bestDist > 9 && window.BTMM_MAP_LABELS && window.BTMM_MAP_LABELS.hitLabelAt) {
      const lid = window.BTMM_MAP_LABELS.hitLabelAt(px, py);
      if (lid) {
        const ln = nodeById.get(lid);
        if (ln && isMatch(ln.t)) return ln;
      }
    }
    return best;
  }

  function pointerLocalXY(ev) {
    const rect = mapWrap.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  }

  function isTouchEvent(ev) {
    if (ev && ev.pointerType === "touch") return true;
    return typeof window !== "undefined" && window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  }

  let physics = null;
  let cachedExpandedBottomSpanY = 0;

  // Always reserve blank scrollable space behind the maximized player (even when minimized or closed)
  // so bottom-most tracks in both Vibe and Era views sit right above the maximized player's top edge.
  function getPanSlack() {
    const isMob = vw <= 840;
    const isDesktopEra = layout === "era" && vw > 800;
    let spanY = cachedExpandedBottomSpanY > 0 ? cachedExpandedBottomSpanY : 336;
    let liveDesktopSpanX = 0;
    if (typeof document !== "undefined" && mapWrap) {
      const card = document.getElementById("track-player-card");
      if (card && !card.hidden) {
        const mRect = mapWrap.getBoundingClientRect();
        const cRect = card.getBoundingClientRect();
        if (cRect.width > 40 && vw > 800) {
          liveDesktopSpanX = Math.max(0, Math.round(mRect.right - cRect.left + 42));
        }
        const isCol = card.classList.contains("is-collapsed") || card.classList.contains("mp-collapsed");
        if (!isCol) {
          if (cRect.height > 40) {
            const liveSpan = Math.max(0, mRect.bottom - cRect.top);
            const infoOpen = Boolean(window.BTMM_PLAYER && window.BTMM_PLAYER.isInfoOpen && window.BTMM_PLAYER.isInfoOpen());
            if (!card.classList.contains("is-requesting") && !infoOpen) {
              cachedExpandedBottomSpanY = Math.max(300, liveSpan);
              spanY = cachedExpandedBottomSpanY;
            } else {
              spanY = Math.max(spanY, liveSpan);
            }
          }
        } else {
          const expandInner = card.querySelector("#mp-expand-inner");
          if (expandInner && expandInner.scrollHeight > 80) {
            const estCardH = Math.min(isMob ? vh * 0.58 : vh - 36, expandInner.scrollHeight + 30);
            const estSpan = estCardH + (isMob ? 10 : 18);
            cachedExpandedBottomSpanY = Math.max(300, estSpan);
            spanY = Math.max(spanY, estSpan);
          }
        }
      }
    }

    const [, worldH] = worldSize();
    let maxNodeY = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (isSketchHidden(n.t) || !isMatch(n.t)) continue;
      const ny = Number.isFinite(n.ty) ? n.ty : n.y;
      if (ny > maxNodeY) maxNodeY = ny;
    }
    const bottomMarginWorld = maxNodeY > 0 ? Math.max(0, worldH - maxNodeY) : 0;
    const curK = Math.max(1, Number.isFinite(zoom.k) ? zoom.k : 1);
    // On Desktop Era at 1x zoom, lock vertical slack to 0 so horizontal timeline scrolling stays on a rock-steady rail
    if (isDesktopEra && curK <= 1.02) {
      const eraSlackX = Math.max(448, liveDesktopSpanX);
      return [eraSlackX, 0];
    }
    // Place the lowest visible track ~42px above the maximized player's top edge when scrolled all the way up
    const neededSlackY = (spanY + 42) - bottomMarginWorld * curK;
    const minDesktopSlackY = !isMob && curK <= 1.02 ? Math.round(spanY + 48) : 0;
    const slackY = Math.max(minDesktopSlackY, Math.min(Math.round(vh * 0.75), Math.round(Math.max(0, neededSlackY))));
    const slackX = isDesktopEra ? Math.max(448, liveDesktopSpanX) : (isMob ? 0 : Math.max(416, liveDesktopSpanX));
    return [slackX, slackY];
  }

  function worldSize() {
    if (layout === "era" && eraLayout && eraLayout.virtualW && eraLayout.virtualH) {
      return [eraLayout.virtualW, eraLayout.virtualH];
    }
    if (layout === "vibe" && vibeLayout && vibeLayout.virtualW && vibeLayout.virtualH) {
      return [vibeLayout.virtualW, vibeLayout.virtualH];
    }
    return [vw, vh];
  }

  function defaultMapZoom() {
    if (layout === "era" && eraLayout && eraLayout.defaultZoom) {
      return { ...eraLayout.defaultZoom };
    }
    if (layout === "vibe" && vibeLayout && vibeLayout.defaultZoom) {
      return { ...vibeLayout.defaultZoom };
    }
    return { k: 1, x: 0, y: 0 };
  }

  function resetCamera() {
    stopMomentum();
    zoom = defaultMapZoom();
    clampZoom();
    paint();
  }

  function clampZoom() {
    if (physics) physics.clampZoom();
  }

  function stopMomentum() {
    if (physics) physics.stopMomentum();
  }

  function bindEvents() {
    physics = window.BTMM_MAP_PHYSICS.createController({
      mapWrap,
      getZoom: () => zoom,
      getDefaultZoom: defaultMapZoom,
      getViewport: () => [vw, vh],
      getWorldSize: worldSize,
      getPanSlack,
      preferWheelScroll: () => vw <= 800,
      onTransform: () => {
        paintCanvas();
        drawFloatingLabels();
      },
      onFullPaint: () => paint(),
      onHoverMove: (ev, [px, py]) => {
        if (mapWrap.hidden || !ev.target || !mapWrap.contains(ev.target) || ev.target.closest("#map-floating-hud")) {
          if (hoverId !== null) {
            hoverId = null;
            mapWrap.classList.remove("has-hover");
            paintCanvas();
          }
          return;
        }
        const hit = findNearestVisibleNode(px, py, hitRadiusForEvent(ev));
        const nextHov = hit ? hit.id : null;
        if (nextHov !== hoverId) {
          hoverId = nextHov;
          mapWrap.classList.toggle("has-hover", Boolean(hoverId));
          paintCanvas();
        }
      },
      onHoverLeave: () => {
        if (hoverId !== null) {
          hoverId = null;
          mapWrap.classList.remove("has-hover");
          paintCanvas();
        }
      },
      onTapPoint: (ev, px, py) => {
        const hit = findNearestVisibleNode(px, py, hitRadiusForEvent(ev));
        if (!hit) return false;
        selectedId = hit.id;
        if (window.BTMM_PLAYER) window.BTMM_PLAYER.select(hit.id, { silent: true });
        if (hooks && hooks.onTap) hooks.onTap(hit.id);
        paint();
        return true;
      },
      onBackgroundTap: () => {
        selectedId = null;
        if (window.BTMM_PLAYER) window.BTMM_PLAYER.select(null, { silent: true });
        if (activeClusterId || activeEraId) {
          activeClusterId = null;
          activeEraId = null;
        }
        paint();
      },
    });
    physics.bind();

    if (starBtn) {
      starBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        starFilter = !starFilter;
        if (isTouchEvent(ev)) hudHoverTarget = null;
        paint();
      });
      starBtn.addEventListener("pointerenter", (ev) => {
        if (ev.pointerType === "touch") return;
        hudHoverTarget = "star";
        updateHudHint();
      });
      starBtn.addEventListener("pointerleave", () => { if (hudHoverTarget === "star") { hudHoverTarget = null; updateHudHint(); } });
      starBtn.addEventListener("focus", () => {
        if (!starBtn.matches || !starBtn.matches(":focus-visible")) return;
        hudHoverTarget = "star";
        updateHudHint();
      });
      starBtn.addEventListener("blur", () => { if (hudHoverTarget === "star") { hudHoverTarget = null; updateHudHint(); } });
    }

    if (sketchBtn) {
      sketchBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (isTouchEvent(ev)) hudHoverTarget = null;
        setShowSketches(!showSketches);
      });
      sketchBtn.addEventListener("pointerenter", (ev) => {
        if (ev.pointerType === "touch") return;
        hudHoverTarget = "sketch";
        updateHudHint();
      });
      sketchBtn.addEventListener("pointerleave", () => { if (hudHoverTarget === "sketch") { hudHoverTarget = null; updateHudHint(); } });
      sketchBtn.addEventListener("focus", () => {
        if (!sketchBtn.matches || !sketchBtn.matches(":focus-visible")) return;
        hudHoverTarget = "sketch";
        updateHudHint();
      });
      sketchBtn.addEventListener("blur", () => { if (hudHoverTarget === "sketch") { hudHoverTarget = null; updateHudHint(); } });
    }

    if (eraGenAiBtn) {
      eraGenAiBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (isTouchEvent(ev)) hudHoverTarget = null;
        setShowGenAi(!isGenAiShown());
      });
      eraGenAiBtn.addEventListener("pointerenter", (ev) => {
        if (ev.pointerType === "touch") return;
        hudHoverTarget = "genai";
        updateHudHint();
      });
      eraGenAiBtn.addEventListener("pointerleave", () => { if (hudHoverTarget === "genai") { hudHoverTarget = null; updateHudHint(); } });
      eraGenAiBtn.addEventListener("focus", () => {
        if (!eraGenAiBtn.matches || !eraGenAiBtn.matches(":focus-visible")) return;
        hudHoverTarget = "genai";
        updateHudHint();
      });
      eraGenAiBtn.addEventListener("blur", () => { if (hudHoverTarget === "genai") { hudHoverTarget = null; updateHudHint(); } });
    }

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        const cr = entries[0] && entries[0].contentRect;
        if (!cr || cr.width < 40 || cr.height < 40) return;
        if (Math.abs(cr.width - vw) < 0.5 && Math.abs(cr.height - vh) < 0.5) return;
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          relayout(false);
        });
      });
      ro.observe(mapWrap);
    }
  }

  function resizeCanvas() {
    if (!mapWrap || !canvas || !svg) return;
    vw = Math.max(320, mapWrap.clientWidth || 1000);
    vh = Math.max(300, mapWrap.clientHeight || 680);
    dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    canvas.width = Math.floor(vw * dpr);
    canvas.height = Math.floor(vh * dpr);
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
  }

  function relayout(animate = false) {
    stopMomentum();
    const prevVw = vw;
    const prevVh = vh;
    resizeCanvas();
    computeTargetPositions();
    if (layout === "era" && eraLayout) {
      if ((prevVw <= 800) !== (vw <= 800)) {
        zoom = { ...eraLayout.defaultZoom };
      } else if (vw <= 800 && prevVh > 0 && Math.abs(vh - prevVh) > 0.5) {
        zoom.y = zoom.y * (vh / prevVh);
      } else if (vw > 800 && prevVw > 0 && Math.abs(vw - prevVw) > 0.5) {
        zoom.x = zoom.x * (vw / prevVw);
      }
    } else if ((prevVw <= 768) !== (vw <= 768)) {
      zoom = defaultMapZoom();
    }
    clampZoom();
    if (prevVw !== vw || prevVh !== vh) buildEdges();
    tweenToTargets(animate);
    drawFloatingLabels();
  }

  function focus(tid, opts = {}) {
    if (!byId.has(tid)) return;
    stopMomentum();
    const tr = byId.get(tid);
    if (tr && isSketchHidden(tr)) {
      if (tr.is_ai) {
        if (layout === "era") showEraGenAi = true;
        else showVibeGenAi = true;
      }
      if (tr.is_sketch) showSketches = true;
      computeTargetPositions();
      nodes.forEach((n) => { n.x = n.tx; n.y = n.ty; });
      buildEdges();
    }
    if (opts && opts.centerNode) {
      const n = nodeById.get(tid);
      if (n) {
        const defFocusK = layout === "era" && vw <= 800 ? 1 : 1.85;
        const targetK = Math.max(1, Math.min(4, Number(opts.zoomK) || defFocusK));
        const anchorX = vw <= 840 ? vw * 0.5 : vw * 0.42;
        const anchorY = vw <= 840 ? vh * 0.34 : vh * 0.45;
        zoom = {
          k: targetK,
          x: anchorX - n.x * targetK,
          y: anchorY - n.y * targetK,
        };
        clampZoom();
      }
    }
    selectedId = tid;
    if (window.BTMM_PLAYER) window.BTMM_PLAYER.select(tid, { silent: true });
    paint();
    drawFloatingLabels();
  }

  function setLayout(nextLay, animate = true) {
    stopMomentum();
    const norm = normLayoutName(nextLay);
    layout = norm;
    activeClusterId = null;
    activeEraId = null;
    resizeCanvas();
    computeTargetPositions();
    zoom = defaultMapZoom();
    clampZoom();
    buildEdges();
    tweenToTargets(animate);
    drawFloatingLabels();
    paint();
    if (hooks && hooks.onLayoutChange) hooks.onLayoutChange(layout);
  }

  function setShowSketches(val) {
    const next = Boolean(val);
    if (next === showSketches) return showSketches;
    stopMomentum();
    showSketches = next;
    if (layout === "era") {
      computeTargetPositions();
      nodes.forEach((n) => { n.x = n.tx; n.y = n.ty; });
      clampZoom();
    }
    buildEdges();
    paint();
    return showSketches;
  }

  function setShowVibeGenAi(val, opts = {}) {
    const next = Boolean(val);
    if (next === showVibeGenAi) return showVibeGenAi;
    stopMomentum();
    showVibeGenAi = next;
    if (!showVibeGenAi) {
      if (activeClusterId === "ai_generative" || (activeClusterId && activeClusterId.startsWith("ai_sub_"))) {
        activeClusterId = null;
      }
      const selTr = selectedId ? byId.get(selectedId) : null;
      if (selTr && selTr.is_ai) {
        selectedId = null;
        if (window.BTMM_PLAYER) window.BTMM_PLAYER.select(null, { silent: true });
      }
      const hovTr = hoverId ? byId.get(hoverId) : null;
      if (hovTr && hovTr.is_ai) {
        hoverId = null;
        if (mapWrap) mapWrap.classList.remove("has-hover");
      }
    }
    if (layout === "vibe") {
      computeTargetPositions();
      zoom = defaultMapZoom();
      clampZoom();
      buildEdges();
      const shouldAnimate = opts && typeof opts.animate === "boolean" ? opts.animate : true;
      syncStarHud();
      tweenToTargets(shouldAnimate, 320);
      drawFloatingLabels();
      if (window.BTMM_PLAYER) window.BTMM_PLAYER.render();
      return showVibeGenAi;
    }
    buildEdges();
    paint();
    return showVibeGenAi;
  }

  function setShowEraGenAi(val) {
    const next = Boolean(val);
    if (next === showEraGenAi) return showEraGenAi;
    stopMomentum();
    showEraGenAi = next;
    if (!showEraGenAi && activeEraId === "genai_2025") activeEraId = null;
    if (layout === "era") {
      computeTargetPositions();
      nodes.forEach((n) => { n.x = n.tx; n.y = n.ty; });
      clampZoom();
    }
    buildEdges();
    paint();
    return showEraGenAi;
  }

  function setShowGenAi(val) {
    return layout === "era" ? setShowEraGenAi(val) : setShowVibeGenAi(val);
  }

  function setClusterFilter(cid) {
    stopMomentum();
    activeClusterId = cid;
    paint();
  }

  function firstVisibleTrackId() {
    for (let i = 0; i < nodes.length; i++) {
      if (!isSketchHidden(nodes[i].t) && isMatch(nodes[i].t)) return nodes[i].id;
    }
    return tracks[0] ? tracks[0].id : null;
  }

  function init(cfg) {
    hooks = cfg;
    tracks = cfg.tracks || [];
    eras = cfg.eras || [];
    byId = cfg.byId;
    erasById = cfg.erasById;
    styleGroups = cfg.styleGroups || [];
    eraAnchors = cfg.eraAnchors || [];
    trackMap = cfg.trackMap || {};
    trackNear = cfg.trackNear || {};

    mapWrap = document.getElementById("map");
    canvas = document.getElementById("map-canvas");
    svg = document.getElementById("map-svg");
    hoverPill = document.getElementById("map-hover-pill");
    starBtn = document.getElementById("star-filter-btn");
    sketchBtn = document.getElementById("sketch-filter-btn");
    eraGenAiBtn = document.getElementById("era-genai-filter-btn");
    hudHintEl = document.getElementById("map-hud-hint");
    starEmptyEl = document.getElementById("star-empty-msg");
    if (!mapWrap || !canvas || !svg) return;

    ctx = canvas.getContext("2d");
    samplePalette();
    resizeCanvas();

    svg.innerHTML = "";
    groupG = elSvg("g", "map-groups");
    ringG = elSvg("g", "map-rings");
    svg.append(ringG, groupG);

    vibeLayout = computeVibeLayout();
    nodes = tracks.map((t) => {
      const [x, y] = vibeTarget(t.id);
      return { id: t.id, t, x, y, sx: x, sy: y, tx: x, ty: y };
    });
    nodeById = new Map(nodes.map((n) => [n.id, n]));

    computeTargetPositions();
    nodes.forEach((n) => { n.x = n.tx; n.y = n.ty; });
    bindEvents();
    zoom = defaultMapZoom();
    clampZoom();
    buildEdges();
    paint();
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => paint());
    }
  }

  window.ME_NODEMAP = {
    init,
    paint,
    focus,
    resetCamera,
    setLayout,
    getLayout: () => layout,
    getZoom: () => ({ ...zoom }),
    getWorldSize: worldSize,
    getPanSlack,
    refreshLabels() { clampZoom(); paintCanvas(); drawFloatingLabels(); },
    isCoasting: () => Boolean(physics && physics.isCoasting && physics.isCoasting()),
    getVelocity: () => (physics && physics.getVelocity ? physics.getVelocity() : { vx: 0, vy: 0, speed: 0, vLogK: 0, zoomSpeed: 0 }),
    selected: () => selectedId,
    setSelectedSilent(tid) { selectedId = tid; paint(); },
    firstVisibleTrackId,
    setFilter(setOrNull) { stopMomentum(); filterSet = setOrNull; paint(); },
    setClusterFilter,
    setShowSketches,
    getShowSketches: () => showSketches,
    setShowGenAi,
    getShowGenAi: isGenAiShown,
    setShowVibeGenAi,
    getShowVibeGenAi: () => showVibeGenAi,
    setShowEraGenAi,
    getShowEraGenAi: () => showEraGenAi,
    getEdges: () => edges.slice(),
    getEdgesCountFor: (tid) => edges.filter((e) => e.a === tid || e.b === tid).length,
    getNodeScreenPos: (tid) => { const n = nodeById.get(tid); return n && Number.isFinite(n.px) ? [n.px, n.py] : null; },
    setColorMode(mode) { colorMode = mode; paint(); },
    getColorMode: () => colorMode,
    refreshTheme() { samplePalette(); paint(); },
    relayout,
  };
})();
