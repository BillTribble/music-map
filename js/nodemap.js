// Groove Explorer-style Interactive SVG Node Map (Similarity Default <-> 16-Era Morph)
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const PAD = 52;
  const NODE_R = 8;
  const HIT_R = 22;
  const HIT_R_MAX = 36;
  const LINKS = 2;
  const MORPH_MS = 700;

  // Token-only cluster / energy / phase color maps (all tokens present in Light & Dark modes)
  const CLUSTER_COLORS = [
    "var(--md-sys-color-on-blue-tonal)",
    "var(--md-sys-color-on-teal-tonal)",
    "var(--md-sys-color-on-green-tonal)",
    "var(--md-sys-color-on-purple-tonal)",
    "var(--md-sys-color-on-yellow-tonal)",
    "var(--md-sys-color-on-red-tonal)",
    "var(--md-sys-color-on-orange-tonal)",
  ];
  const PHASE_COLORS = {
    phase0_archive: "var(--md-sys-color-on-yellow-tonal)",
    phase1_early: "var(--md-sys-color-on-blue-tonal)",
    phase2_mid: "var(--md-sys-color-on-purple-tonal)",
    phase3_ambient: "var(--md-sys-color-on-teal-tonal)",
    phase4_recent: "var(--md-sys-color-on-red-tonal)",
  };

  let hooks = null;
  let tracks = [];
  let byId = new Map();
  let erasById = new Map();
  let styleGroups = [];
  let eraAnchors = [];
  let trackMap = {};
  let trackNear = {};

  let svg = null;
  let vp = null;
  let edgeG = null;
  let groupG = null;
  let nodeG = null;
  let panel = null;
  let legendEl = null;

  let nodes = [];
  let nodeById = new Map();
  let groupEls = [];
  let layout = "similarity"; // "similarity" | "era"
  let colorMode = "cluster"; // "cluster" | "energy" | "era"
  let filterSet = null;
  let activeClusterId = null;
  let activeEraId = null;
  let selectedId = null;
  let hoverId = null;

  let vw = 1000;
  let vh = 700;
  let zoom = { k: 1, x: 0, y: 0 };
  let tweenRaf = 0;
  let resizeRaf = 0;

  function elSvg(tag, cls) {
    const e = document.createElementNS(NS, tag);
    if (cls) e.setAttribute("class", cls);
    return e;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function energyColor(en) {
    if (en <= 2) return "var(--md-sys-color-on-blue-tonal)";
    if (en <= 4) return "var(--md-sys-color-on-teal-tonal)";
    if (en === 5) return "var(--md-sys-color-on-green-tonal)";
    if (en <= 6) return "var(--md-sys-color-on-yellow-tonal)";
    return "var(--md-sys-color-on-red-tonal)";
  }

  function energyBadgeCls(en) {
    if (en <= 2) return "badge-blue";
    if (en <= 4) return "badge-teal";
    if (en === 5) return "badge-green";
    if (en <= 6) return "badge-amber";
    return "badge-pink";
  }

  function trackColor(t) {
    if (colorMode === "energy") return energyColor(t.energy);
    if (colorMode === "era") {
      const er = erasById.get(t.era);
      return PHASE_COLORS[er && er.phase] || "var(--md-sys-color-primary)";
    }
    return CLUSTER_COLORS[(t.cluster_idx || 0) % CLUSTER_COLORS.length];
  }

  function placeOnScreen(normX, normY) {
    const w = Math.max(240, vw - PAD * 2);
    const h = Math.max(200, vh - PAD * 2);
    return [PAD + normX * w, PAD + normY * h];
  }

  function normPosFor(tid, lay) {
    const coords = trackMap[tid];
    if (!coords) return [0.5, 0.5];
    return coords[lay] || coords.similarity || [0.5, 0.5];
  }

  function buildEdges(lay) {
    const pairs = new Map();
    const keyFor = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

    if (lay === "similarity") {
      tracks.forEach((t) => {
        const list = (trackNear[t.id] || []).slice(0, LINKS);
        list.forEach(([nid, sim]) => {
          const k = keyFor(t.id, nid);
          if (!pairs.has(k)) pairs.set(k, { a: t.id, b: nid, w: sim, weak: false });
        });
      });
    } else {
      // Connect members sequentially around each era constellation
      const byEra = new Map();
      tracks.forEach((t) => {
        if (!byEra.has(t.era)) byEra.set(t.era, []);
        byEra.get(t.era).push(t);
      });
      byEra.forEach((list) => {
        for (let i = 0; i < list.length; i++) {
          const a = list[i].id;
          const b = list[(i + 1) % list.length].id;
          if (a !== b) pairs.set(keyFor(a, b), { a, b, w: 0.9, weak: false });
        }
      });
    }

    // Kruskal weak bridges so no component sits detached
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
        const d = Math.hypot(a.tx - b.tx, a.ty - b.ty);
        cands.push({ a: a.id, b: b.id, d });
      }
    }
    cands.sort((p, q) => p.d - q.d);
    for (const c of cands) {
      if (unite(c.a, c.b)) {
        pairs.set(keyFor(c.a, c.b), { a: c.a, b: c.b, w: 0.25, weak: true });
      }
    }

    edgeG.innerHTML = "";
    const edges = [...pairs.values()];
    edges.forEach((e) => {
      const ln = elSvg("line", "map-edge" + (e.weak ? " is-weak" : ""));
      edgeG.appendChild(ln);
      e.el = ln;
    });
    return edges;
  }

  let edges = [];

  function drawFloatingLabels() {
    groupG.innerHTML = "";
    groupEls = [];
    if (layout === "similarity") {
      styleGroups.forEach((g) => {
        const grp = elSvg("g", "map-group-label" + (activeClusterId === g.id ? " is-active" : ""));
        const pill = elSvg("rect", "map-group-pill");
        const label = g.label;
        const sub = `${g.members.length} tracks`;
        const w = Math.max(132, label.length * 7.3 + 30);
        pill.setAttribute("x", (-w / 2).toFixed(1));
        pill.setAttribute("y", "-18");
        pill.setAttribute("width", w.toFixed(1));
        pill.setAttribute("height", "30");
        pill.setAttribute("rx", "15");

        const txt = elSvg("text", "map-group-txt");
        txt.setAttribute("y", "-5");
        txt.textContent = label;
        const subEl = elSvg("text", "map-group-sub");
        subEl.setAttribute("y", "7");
        subEl.textContent = sub;

        grp.append(pill, txt, subEl);
        grp.addEventListener("click", (ev) => {
          ev.stopPropagation();
          setClusterFilter(activeClusterId === g.id ? null : g.id);
        });
        groupG.appendChild(grp);
        groupEls.push({ nx: g.cx, ny: g.cy, w, el: grp });
      });
    } else {
      eraAnchors.forEach((a) => {
        const er = erasById.get(a.id);
        if (!er) return;
        const grp = elSvg("g", "map-group-label" + (activeEraId === a.id ? " is-active" : ""));
        const pill = elSvg("rect", "map-group-pill");
        const label = er.label;
        const sub = er.sublabel;
        const w = Math.max(106, label.length * 6.9 + 22);
        pill.setAttribute("x", (-w / 2).toFixed(1));
        pill.setAttribute("y", "-17");
        pill.setAttribute("width", w.toFixed(1));
        pill.setAttribute("height", "28");
        pill.setAttribute("rx", "14");

        const txt = elSvg("text", "map-group-txt");
        txt.setAttribute("y", "-4");
        txt.textContent = label;
        const subEl = elSvg("text", "map-group-sub");
        subEl.setAttribute("y", "7");
        subEl.textContent = sub;

        grp.append(pill, txt, subEl);
        grp.addEventListener("click", (ev) => {
          ev.stopPropagation();
          activeEraId = activeEraId === a.id ? null : a.id;
          activeClusterId = null;
          drawFloatingLabels();
          paint();
        });
        groupG.appendChild(grp);
        groupEls.push({ nx: a.x, ny: a.y, w, el: grp });
      });
    }
    positionGroupLabels();
  }

  function positionGroupLabels() {
    const pts = groupEls.map((g) => {
      const [sx, sy] = placeOnScreen(g.nx, g.ny);
      return { g, sx, sy, w: g.w || 132, h: 32 };
    });
    const dotPts = layout === "similarity"
      ? nodes.map((n) => {
          const [nx, ny] = normPosFor(n.id, layout);
          const [px, py] = placeOnScreen(nx, ny);
          return { px, py };
        })
      : [];
    // Separate overlapping floating label pills and push away from track dots across desktop/mobile
    for (let it = 0; it < 28; it++) {
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i], b = pts[j];
          const minDx = (a.w + b.w) * 0.5 + 18;
          const minDy = 46;
          const dx = a.sx - b.sx;
          const dy = a.sy - b.sy;
          if (Math.abs(dx) < minDx && Math.abs(dy) < minDy) {
            const ox = minDx - Math.abs(dx);
            const oy = minDy - Math.abs(dy);
            if (oy <= ox * 0.85) {
              const shift = (dy >= 0 ? 1 : -1) * oy * 0.52;
              a.sy += shift;
              b.sy -= shift;
            } else {
              const shift = (dx >= 0 ? 1 : -1) * ox * 0.45;
              a.sx += shift;
              b.sx -= shift;
            }
          }
        }
      }
      if (dotPts.length) {
        pts.forEach((p) => {
          const rx = p.w * 0.5 + 12;
          const ry = 25;
          for (let k = 0; k < dotPts.length; k++) {
            const d = dotPts[k];
            const dx = p.sx - d.px;
            const dy = p.sy - d.py;
            if (Math.abs(dx) < rx && Math.abs(dy) < ry) {
              p.sy += (dy >= 0 ? 1 : -1) * (ry - Math.abs(dy)) * 0.38;
            }
          }
        });
      }
      const minTop = vw <= 520 ? 78 : 26;
      pts.forEach((p) => {
        const halfW = p.w * 0.5 + 8;
        p.sx = Math.max(halfW, Math.min(vw - halfW, p.sx));
        p.sy = Math.max(minTop, Math.min(vh - 58, p.sy));
      });
    }
    pts.forEach((p) => {
      p.g.el.setAttribute("transform", `translate(${p.sx.toFixed(1)}, ${p.sy.toFixed(1)})`);
    });
  }

  function sizeTapAreas() {
    const rScreen = Math.max(HIT_R, Math.min(HIT_R_MAX, HIT_R * Math.pow(zoom.k, 0.25)));
    const rLocal = rScreen / Math.max(0.25, zoom.k);
    nodes.forEach((n) => {
      n.hitEl.setAttribute("r", rLocal.toFixed(2));
      const lblVis = zoom.k >= 1.5 || n.id === selectedId || n.id === hoverId || n.id === hooks.playing();
      n.lblEl.style.opacity = lblVis ? "1" : "0";
    });
  }

  function applyPositions() {
    nodes.forEach((n) => {
      n.g.setAttribute("transform", `translate(${n.x.toFixed(1)}, ${n.y.toFixed(1)})`);
    });
    edges.forEach((e) => {
      const a = nodeById.get(e.a);
      const b = nodeById.get(e.b);
      if (!a || !b) return;
      e.el.setAttribute("x1", a.x.toFixed(1));
      e.el.setAttribute("y1", a.y.toFixed(1));
      e.el.setAttribute("x2", b.x.toFixed(1));
      e.el.setAttribute("y2", b.y.toFixed(1));
    });
  }

  function applyTransform() {
    vp.setAttribute("transform", `translate(${zoom.x.toFixed(1)}, ${zoom.y.toFixed(1)}) scale(${zoom.k.toFixed(4)})`);
    sizeTapAreas();
  }

  function tweenToTargets(animate) {
    if (tweenRaf && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(tweenRaf);
    nodes.forEach((n) => {
      const [nx, ny] = normPosFor(n.id, layout);
      const [tx, ty] = placeOnScreen(nx, ny);
      n.sx = n.x;
      n.sy = n.y;
      n.tx = tx;
      n.ty = ty;
    });
    if (!animate || typeof requestAnimationFrame === "undefined") {
      nodes.forEach((n) => { n.x = n.tx; n.y = n.ty; });
      applyPositions();
      positionGroupLabels();
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
      applyPositions();
      if (u < 1) tweenRaf = requestAnimationFrame(step);
      else tweenRaf = 0;
    }
    tweenRaf = requestAnimationFrame(step);
  }

  function isMatch(t) {
    if (filterSet && !filterSet.has(t.id)) return false;
    if (layout === "similarity" && activeClusterId && t.cluster_id !== activeClusterId) return false;
    if (layout === "era" && activeEraId && t.era !== activeEraId) return false;
    return true;
  }

  function paint() {
    const playId = hooks ? hooks.playing() : null;
    const pendId = hooks ? hooks.pending() : null;
    nodes.forEach((n) => {
      const col = trackColor(n.t);
      const match = isMatch(n.t);
      n.dotEl.setAttribute("fill", col);
      n.dotEl.setAttribute("r", n.id === playId ? "10" : n.id === selectedId ? "9.5" : String(NODE_R));
      n.g.classList.toggle("is-dim", !match);
      n.g.classList.toggle("is-selected", n.id === selectedId);
      n.g.classList.toggle("is-playing", n.id === playId);
      n.g.classList.toggle("is-queued", n.id === pendId && n.id !== playId);
    });

    edges.forEach((e) => {
      const lit = selectedId && (e.a === selectedId || e.b === selectedId);
      const aNode = nodeById.get(e.a);
      const bNode = nodeById.get(e.b);
      const bothDim = (!aNode || !isMatch(aNode.t)) && (!bNode || !isMatch(bNode.t));
      e.el.classList.toggle("is-lit", Boolean(lit));
      e.el.classList.toggle("is-dim", Boolean(bothDim && !lit));
    });

    sizeTapAreas();
    renderPanel();
    renderClusterChips();
  }

  function renderClusterChips() {
    if (!legendEl) return;
    if (layout !== "similarity") {
      legendEl.innerHTML = `<button type="button" class="cluster-chip ${!activeEraId ? "is-active" : ""}" data-reset-era="1">All 16 eras (${tracks.length} tracks)</button>` +
        (activeEraId && erasById.get(activeEraId)
          ? `<button type="button" class="cluster-chip is-active" data-reset-era="1">${esc(erasById.get(activeEraId).label)} ×</button>`
          : "");
      return;
    }
    legendEl.innerHTML = styleGroups.map((g, i) => {
      const act = activeClusterId === g.id;
      const col = CLUSTER_COLORS[i % CLUSTER_COLORS.length];
      return `<button type="button" class="cluster-chip ${act ? "is-active" : ""}" data-cluster="${esc(g.id)}"><span class="cluster-dot" style="background:${col}"></span><span>${esc(g.label)}</span></button>`;
    }).join("");
  }

  function meterHtml(label, val, col) {
    const v = Math.round(Number(val) || 0);
    return `
      <div>
        <div class="mp-meter-lbl"><span>${esc(label)}</span><strong>${v}</strong></div>
        <div class="mp-meter-track"><div class="mp-meter-fill" style="width:${Math.min(100, v)}%;background:${col}"></div></div>
      </div>`;
  }

  function renderPanel() {
    if (!panel || !hooks) return;
    if (!selectedId || !byId.has(selectedId)) {
      panel.hidden = true;
      return;
    }
    const t = byId.get(selectedId);
    const er = erasById.get(t.era);
    const isPlaying = hooks.playing() === t.id;
    const isPend = hooks.pending() === t.id;
    const near = (trackNear[t.id] || []).slice(0, 4);

    let beats = "";
    for (let i = 0; i < 16; i++) {
      beats += `<div class="mp-beat${i % 4 === 0 ? " down" : ""}" data-beat="${i}"></div>`;
    }

    const nearHtml = near.map(([nid, sim]) => {
      const nt = byId.get(nid);
      if (!nt) return "";
      const ner = erasById.get(nt.era);
      return `
        <button type="button" class="mp-near-item" data-jump-track="${esc(nt.id)}">
          <span><strong>${esc(nt.title)}</strong> <span class="muted">· ${esc(ner ? ner.shortLabel : nt.era)} · E${nt.energy}</span></span>
          <span class="mp-near-sim">${Math.round(sim * 100)}%</span>
        </button>`;
    }).join("");

    panel.innerHTML = `
      <div class="mp-head">
        <button type="button" class="btn-tonal mp-play ${isPlaying ? "is-playing" : ""}" data-panel-play="${esc(t.id)}" aria-label="${isPlaying ? "Stop" : "Play"}" title="${isPlaying ? "Stop playback" : "Play 8-bar loop"}">
          <span class="ms filled">${isPlaying ? "stop" : isPend ? "hourglass_top" : "play_arrow"}</span>
        </button>
        <div class="mp-titles">
          <div class="mp-name" title="${esc(t.title)}">${esc(t.title)}</div>
          <div class="mp-meta">${esc(er ? `${er.label} (${er.sublabel})` : t.era)} · ${esc(t.cluster_label)}</div>
        </div>
        <button type="button" class="icon-btn" id="mp-close" aria-label="Close track panel" title="Close">
          <span class="ms">close</span>
        </button>
      </div>
      <div class="mp-badges">
        <span class="badge ${energyBadgeCls(t.energy)}" title="Mixed In Key energy level (1–10)">Energy E${t.energy}/10</span>
        <span class="badge badge-purple">${esc(t.key_label)}</span>
        <span class="badge badge-blue">${Math.round(t.bpm)} BPM</span>
        <span class="badge badge-cyan">${t.clip_bars || 8} bars</span>
      </div>
      <div class="mp-beats" id="mp-beats">${beats}</div>
      <div class="mp-meters">
        ${meterHtml("Harmonic complexity", t.harmonic_complexity, "var(--c5)")}
        ${meterHtml("Chord richness", t.chord_richness, "var(--c1)")}
        ${meterHtml("Harmonic motion", t.harmonic_motion, "var(--c2)")}
        ${meterHtml("Drum complexity", t.drum_complexity, "var(--c3)")}
      </div>
      <div class="mp-tags">
        <span class="badge">${esc(t.harmony_tag)}</span>
        <span class="badge ${t.groove_style === "breakbeat" ? "badge-purple" : t.groove_style === "four_on_floor" ? "badge-blue" : ""}">${esc(t.rhythm_tag)}</span>
        ${t.groove_style === "breakbeat" ? `<span class="badge badge-purple">Breakbeat ${Math.round(t.breakbeat_score || 0)}%</span>` : t.groove_style === "four_on_floor" ? `<span class="badge badge-blue">4/4 Pulse ${Math.round(t.four_on_floor || 0)}%</span>` : ""}
        <span class="badge">Darkness ${Math.round(t.modal_darkness)}%</span>
      </div>
      <div class="mp-near">
        <div class="mp-near-head">Most similar tracks</div>
        ${nearHtml}
      </div>`;
    panel.hidden = false;
  }

  function bindEvents() {
    let dragging = false;
    let moved = false;
    let sx = 0, sy = 0, zx = 0, zy = 0;

    svg.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 && ev.pointerType === "mouse") return;
      dragging = true;
      moved = false;
      sx = ev.clientX;
      sy = ev.clientY;
      zx = zoom.x;
      zy = zoom.y;
    });
    window.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) > 4) moved = true;
      if (moved) {
        zoom.x = zx + dx;
        zoom.y = zy + dy;
        applyTransform();
      }
    });
    window.addEventListener("pointerup", () => {
      if (dragging && !moved) {
        // Click empty map canvas clears track selection
      }
      dragging = false;
    });

    svg.addEventListener("click", (ev) => {
      if (moved) return;
      if (ev.target === svg) {
        selectedId = null;
        if (activeClusterId || activeEraId) {
          activeClusterId = null;
          activeEraId = null;
          drawFloatingLabels();
        }
        paint();
      }
    });

    svg.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const factor = ev.deltaY < 0 ? 1.14 : 1 / 1.14;
      const nextK = Math.max(0.75, Math.min(5.0, zoom.k * factor));
      const ratio = nextK / zoom.k;
      zoom.x = px - (px - zoom.x) * ratio;
      zoom.y = py - (py - zoom.y) * ratio;
      zoom.k = nextK;
      applyTransform();
    }, { passive: false });

    panel.addEventListener("click", (ev) => {
      if (ev.target.closest("#mp-close")) {
        selectedId = null;
        paint();
        return;
      }
      const pBtn = ev.target.closest("[data-panel-play]");
      if (pBtn) {
        hooks.onTap(pBtn.getAttribute("data-panel-play"));
        return;
      }
      const jBtn = ev.target.closest("[data-jump-track]");
      if (jBtn) {
        const nid = jBtn.getAttribute("data-jump-track");
        focus(nid);
        hooks.onTap(nid);
      }
    });

    legendEl.addEventListener("click", (ev) => {
      const cBtn = ev.target.closest("[data-cluster]");
      if (cBtn) {
        const cid = cBtn.getAttribute("data-cluster");
        setClusterFilter(activeClusterId === cid ? null : cid);
        return;
      }
      if (ev.target.closest("[data-reset-era]")) {
        activeEraId = null;
        drawFloatingLabels();
        paint();
      }
    });

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        const cr = entries[0] && entries[0].contentRect;
        if (!cr || cr.width < 40 || cr.height < 40) return;
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          vw = Math.floor(cr.width);
          vh = Math.floor(cr.height);
          svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
          tweenToTargets(false);
          positionGroupLabels();
        });
      });
      const mapWrapEl = document.getElementById("map");
      if (mapWrapEl) ro.observe(mapWrapEl);
    }
  }

  function focus(tid) {
    if (!byId.has(tid)) return;
    selectedId = tid;
    paint();
  }

  function setLayout(nextLay, animate = true) {
    if (nextLay !== "similarity" && nextLay !== "era") return;
    layout = nextLay;
    activeClusterId = null;
    activeEraId = null;
    nodes.forEach((n) => {
      const [nx, ny] = normPosFor(n.id, layout);
      const [tx, ty] = placeOnScreen(nx, ny);
      n.tx = tx;
      n.ty = ty;
    });
    edges = buildEdges(layout);
    drawFloatingLabels();
    tweenToTargets(animate);
    paint();
    if (hooks && hooks.onLayoutChange) hooks.onLayoutChange(layout);
  }

  function setClusterFilter(cid) {
    activeClusterId = cid;
    drawFloatingLabels();
    paint();
  }

  function init(cfg) {
    hooks = cfg;
    tracks = cfg.tracks || [];
    byId = cfg.byId;
    erasById = cfg.erasById;
    styleGroups = cfg.styleGroups || [];
    eraAnchors = cfg.eraAnchors || [];
    trackMap = cfg.trackMap || {};
    trackNear = cfg.trackNear || {};

    svg = document.getElementById("map-svg");
    panel = document.getElementById("map-panel");
    legendEl = document.getElementById("map-legend");
    if (!svg || !panel) return;

    const mapWrap = document.getElementById("map");
    vw = Math.max(320, (mapWrap && mapWrap.clientWidth) || 1000);
    vh = Math.max(300, (mapWrap && mapWrap.clientHeight) || 680);
    svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
    svg.innerHTML = "";

    vp = elSvg("g", "map-vp");
    edgeG = elSvg("g", "map-edges");
    nodeG = elSvg("g", "map-nodes");
    groupG = elSvg("g", "map-groups");
    vp.append(edgeG, nodeG, groupG);
    svg.appendChild(vp);

    nodes = tracks.map((t) => {
      const [nx, ny] = normPosFor(t.id, layout);
      const [x, y] = placeOnScreen(nx, ny);
      const g = elSvg("g", "map-node");
      const hitEl = elSvg("circle", "map-hit");
      const ringEl = elSvg("circle", "map-ring");
      ringEl.setAttribute("r", String(NODE_R + 4.5));
      const dotEl = elSvg("circle", "map-dot");
      dotEl.setAttribute("r", String(NODE_R));
      const lblEl = elSvg("text", "map-lbl");
      lblEl.setAttribute("x", "0");
      lblEl.setAttribute("y", String(NODE_R + 13));
      lblEl.setAttribute("text-anchor", "middle");
      lblEl.textContent = t.shortTitle || t.title;
      g.append(hitEl, ringEl, dotEl, lblEl);

      const n = { id: t.id, t, g, hitEl, ringEl, dotEl, lblEl, x, y, sx: x, sy: y, tx: x, ty: y };
      g.addEventListener("pointerenter", () => { hoverId = t.id; sizeTapAreas(); });
      g.addEventListener("pointerleave", () => { hoverId = null; sizeTapAreas(); });
      g.addEventListener("click", (ev) => {
        ev.stopPropagation();
        selectedId = t.id;
        hooks.onTap(t.id);
        paint();
      });
      nodeG.appendChild(g);
      return n;
    });
    nodeById = new Map(nodes.map((n) => [n.id, n]));

    edges = buildEdges(layout);
    drawFloatingLabels();
    applyPositions();
    applyTransform();
    bindEvents();
    paint();
  }

  window.ME_NODEMAP = {
    init,
    paint,
    focus,
    setLayout,
    getLayout: () => layout,
    selected: () => selectedId,
    setFilter(setOrNull) { filterSet = setOrNull; paint(); },
    setClusterFilter,
    setColorMode(mode) { colorMode = mode; paint(); },
    getColorMode: () => colorMode,
    stepBeat(tid, beatIdx) {
      if (!panel || panel.hidden || tid !== selectedId) return;
      const beats = panel.querySelectorAll(".mp-beat");
      beats.forEach((b, i) => b.classList.toggle("on", i === beatIdx));
    },
    relayout() {
      const mapWrap = document.getElementById("map");
      if (!mapWrap || !svg) return;
      vw = Math.max(320, mapWrap.clientWidth || vw);
      vh = Math.max(300, mapWrap.clientHeight || vh);
      svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
      tweenToTargets(false);
      positionGroupLabels();
    },
  };
})();
