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
  let starEmptyEl = null;

  let nodes = [];
  let nodeById = new Map();
  let edges = [];
  let eraLayout = null;
  let groupEls = [];

  let layout = "vibe"; // "vibe" | "era"
  let colorMode = "cluster"; // "cluster" | "energy" | "era"
  let filterSet = null;
  let starFilter = false;
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
      primary: val("--md-sys-color-primary", "#A7C7FA"),
      outline: val("--md-sys-color-outline-variant", "#444746"),
      surfaceLowest: val("--md-sys-color-surface-container-lowest", "#16161B"),
      onSurface: val("--md-sys-color-on-surface", "#E8E9EF"),
      playing: val("--md-sys-color-cluster-2", "#2DD4BF"),
      queued: val("--md-sys-color-cluster-4", "#FBBF24"),
      bandAlt: val("--md-sys-color-surface-container", "#1C1C22"),
      bandActive: val("--md-sys-color-surface-container-high", "#262730"),
      gridLine: val("--md-sys-color-outline-variant", "#3D404A"),
      spineGlow: val("--md-sys-color-primary-container", "#0842A1"),
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
    const base = vw <= 600
      ? 2.5 + ((e - 1) / 9) * 1.1
      : 3.4 + ((e - 1) / 9) * 1.5;
    // Shrink circle size in screen pixels as you zoom in so dense clusters open up for all track labels
    const zoomShrink = zoom.k <= 1 ? 1 : Math.max(0.56, 1 / Math.pow(zoom.k, 0.28));
    return Math.max(2.0, base * zoomShrink);
  }

  // Fan out co-located or near-touching screen dots into a small ring (Groove Explorer style)
  function computeScreenPositions() {
    const T = 7.5;
    const raw = nodes.map((n) => [n.x * zoom.k + zoom.x, n.y * zoom.k + zoom.y]);
    const taken = new Set();
    for (let i = 0; i < nodes.length; i++) {
      if (taken.has(i)) continue;
      if (!isMatch(nodes[i].t)) {
        nodes[i].px = raw[i][0];
        nodes[i].py = raw[i][1];
        nodes[i].fanAngle = null;
        taken.add(i);
        continue;
      }
      const grp = [i];
      taken.add(i);
      for (let j = i + 1; j < nodes.length; j++) {
        if (taken.has(j) || !isMatch(nodes[j].t)) continue;
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

  function isMatch(t) {
    if (filterSet && !filterSet.has(t.id)) return false;
    if (starFilter && window.BTMM_PLAYER && !window.BTMM_PLAYER.isStarred(t.id)) return false;
    if (layout === "vibe" && activeClusterId && t.cluster_id !== activeClusterId) return false;
    if (layout === "era" && activeEraId && t.era !== activeEraId) return false;
    return true;
  }

  function vibeTarget(tid) {
    const coords = trackMap[tid];
    const norm = (coords && (coords.vibe || coords.similarity)) || [0.5, 0.5];
    const topPad = vw <= 800 ? 64 : PAD;
    const sidePad = vw <= 800 ? 18 : PAD;
    const botPad = vw <= 800 ? 24 : PAD;
    const w = Math.max(220, vw - sidePad * 2);
    const h = Math.max(200, vh - topPad - botPad);
    return [sidePad + norm[0] * w, topPad + norm[1] * h];
  }

  function computeTargetPositions() {
    if (layout === "era" && window.BTMM_TIMELINE_ERA) {
      eraLayout = window.BTMM_TIMELINE_ERA.computeLayout(tracks, eras, erasById, vw, vh);
      nodes.forEach((n) => {
        const c = eraLayout.coords.get(n.id);
        n.tx = c ? c.x : vw * 0.5;
        n.ty = c ? c.y : vh * 0.5;
      });
    } else {
      eraLayout = null;
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

    if (layout === "vibe") {
      tracks.forEach((t) => {
        const list = (trackNear[t.id] || []).slice(0, LINKS);
        list.forEach(([nid, sim]) => {
          if (!nodeById.has(nid)) return;
          const k = keyFor(t.id, nid);
          if (!pairs.has(k)) pairs.set(k, { a: t.id, b: nid, w: sim, weak: false });
        });
      });

      // Kruskal bridge for detached vibe islands (only when track count <= 800)
      if (nodes.length <= 800) {
        const parent = new Map(nodes.map((n) => [n.id, n.id]));
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

        const cands = [];
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j];
            if (find(a.id) === find(b.id)) continue;
            cands.push({ a: a.id, b: b.id, d: Math.hypot(a.tx - b.tx, a.ty - b.ty) });
          }
        }
        cands.sort((p, q) => p.d - q.d);
        for (const c of cands) {
          if (unite(c.a, c.b)) pairs.set(keyFor(c.a, c.b), { a: c.a, b: c.b, w: 0.25, weak: true });
        }
      }
    } else {
      // Intra-era subtle harmonic arcs (nearest within same era)
      const byEra = new Map();
      tracks.forEach((t) => {
        if (!byEra.has(t.era)) byEra.set(t.era, []);
        byEra.get(t.era).push(t);
      });
      byEra.forEach((list) => {
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          const near = (trackNear[t.id] || []).find(([nid]) => {
            const nt = byId.get(nid);
            return nt && nt.era === t.era;
          });
          if (near) {
            const k = keyFor(t.id, near[0]);
            if (!pairs.has(k)) pairs.set(k, { a: t.id, b: near[0], w: near[1], weak: true });
          }
        }
      });
    }
    edges = [...pairs.values()];
  }

  function drawFloatingLabels() {
    if (!groupG) return;
    groupG.innerHTML = "";
    groupEls = [];

    if (layout === "era" && window.BTMM_TIMELINE_ERA && eraLayout) {
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
        mapWrap,
        onToggleCluster: (cid) => setClusterFilter(activeClusterId === cid ? null : cid),
      });
    }
  }

  function syncStarHud() {
    if (starBtn) {
      starBtn.classList.toggle("is-active", starFilter);
      starBtn.setAttribute("aria-pressed", String(starFilter));
    }
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
    hoverPill.textContent = hn.t.discogs_top ? `${hn.t.title} · ${hn.t.discogs_top}` : hn.t.title;
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
      window.BTMM_TIMELINE_ERA.drawCanvasBackground(ctx, eraLayout, zoom, {
        bandAlt: palette.bandAlt,
        bandActive: palette.bandActive,
        gridLine: palette.gridLine,
        primary: palette.primary,
        spineGlow: palette.spineGlow,
      }, activeEraId, selTrack);
    }

    computeScreenPositions();

    // Draw edges & shrunk jewel circles directly in 1:1 screen space so zooming never inflates circle size
    edges.forEach((e) => {
      const a = nodeById.get(e.a);
      const b = nodeById.get(e.b);
      if (!a || !b) return;
      const lit = selectedId && (e.a === selectedId || e.b === selectedId);
      const aMatch = isMatch(a.t);
      const bMatch = isMatch(b.t);
      if (starFilter && (!aMatch || !bMatch) && !lit) return;

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
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 1.75;
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = palette.outline;
        ctx.globalAlpha = (!aMatch && !bMatch) ? 0.05 : (layout === "era" ? 0.15 : (e.weak ? 0.16 : 0.3));
        ctx.lineWidth = 0.95;
        if (e.weak && layout === "vibe") ctx.setLineDash([3.5, 4.5]);
        else ctx.setLineDash([]);
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);

    const drawPass = (wantMatch) => {
      nodes.forEach((n) => {
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
        zoom,
        vw,
        vh,
        palette,
        isMatch,
        nodeScreenRadius,
        trackColor,
        playId,
        selectedId,
        hoverId,
        isStarred: (id) => Boolean(window.BTMM_PLAYER && window.BTMM_PLAYER.isStarred(id)),
        mapWrap,
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

  function tweenToTargets(animate) {
    if (tweenRaf && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(tweenRaf);
    nodes.forEach((n) => { n.sx = n.x; n.sy = n.y; });
    const allowMorph = animate && nodes.length <= 400 && typeof requestAnimationFrame !== "undefined";
    if (!allowMorph) {
      nodes.forEach((n) => { n.x = n.tx; n.y = n.ty; });
      paint();
      return;
    }
    const t0 = performance.now();
    function step(now) {
      const u = Math.min(1, (now - t0) / MORPH_MS);
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

  function worldSize() {
    if (layout === "era" && eraLayout && eraLayout.virtualW && eraLayout.virtualH) {
      return [eraLayout.virtualW, eraLayout.virtualH];
    }
    return [vw, vh];
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
      getViewport: () => [vw, vh],
      getWorldSize: worldSize,
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
        paint();
      });
    }

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        const cr = entries[0] && entries[0].contentRect;
        if (!cr || cr.width < 40 || cr.height < 40) return;
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
    resizeCanvas();
    computeTargetPositions();
    if (layout === "era" && eraLayout) zoom = { ...eraLayout.defaultZoom };
    clampZoom();
    tweenToTargets(animate);
    drawFloatingLabels();
  }

  function focus(tid) {
    if (!byId.has(tid)) return;
    selectedId = tid;
    if (window.BTMM_PLAYER) window.BTMM_PLAYER.select(tid, { silent: true });
    paint();
  }

  function setLayout(nextLay, animate = true) {
    stopMomentum();
    const norm = normLayoutName(nextLay);
    layout = norm;
    activeClusterId = null;
    activeEraId = null;
    resizeCanvas();
    computeTargetPositions();
    if (layout === "era" && eraLayout) {
      zoom = { ...eraLayout.defaultZoom };
    } else {
      zoom = { k: 1, x: 0, y: 0 };
    }
    clampZoom();
    buildEdges();
    tweenToTargets(animate);
    drawFloatingLabels();
    paint();
    if (hooks && hooks.onLayoutChange) hooks.onLayoutChange(layout);
  }

  function setClusterFilter(cid) {
    activeClusterId = cid;
    paint();
  }

  function firstVisibleTrackId() {
    for (let i = 0; i < nodes.length; i++) {
      if (isMatch(nodes[i].t)) return nodes[i].id;
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
    starEmptyEl = document.getElementById("star-empty-msg");
    if (!mapWrap || !canvas || !svg) return;

    ctx = canvas.getContext("2d");
    samplePalette();
    resizeCanvas();

    svg.innerHTML = "";
    groupG = elSvg("g", "map-groups");
    ringG = elSvg("g", "map-rings");
    svg.append(ringG, groupG);

    nodes = tracks.map((t) => {
      const [x, y] = vibeTarget(t.id);
      return { id: t.id, t, x, y, sx: x, sy: y, tx: x, ty: y };
    });
    nodeById = new Map(nodes.map((n) => [n.id, n]));

    computeTargetPositions();
    nodes.forEach((n) => { n.x = n.tx; n.y = n.ty; });
    clampZoom();
    buildEdges();
    bindEvents();
    paint();
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => paint());
    }
  }

  window.ME_NODEMAP = {
    init,
    paint,
    focus,
    setLayout,
    getLayout: () => layout,
    getZoom: () => ({ ...zoom }),
    selected: () => selectedId,
    setSelectedSilent(tid) { selectedId = tid; paint(); },
    firstVisibleTrackId,
    setFilter(setOrNull) { filterSet = setOrNull; paint(); },
    setClusterFilter,
    setColorMode(mode) { colorMode = mode; paint(); },
    getColorMode: () => colorMode,
    refreshTheme() { samplePalette(); paint(); },
    relayout,
  };
})();
