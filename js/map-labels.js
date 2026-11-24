// Groove Explorer Cartographic Landmark & Screen-Space Collision-Free Track Label Engine
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const ANGLES = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8].map(
    (s) => -Math.PI / 2 + (s * Math.PI) / 8
  );
  const RINGS = [12, 22, 34, 48, 66, 88, 114, 144, 180, 220];

  let measureCtx = null;
  let lastTrackBoxes = [];

  function textWidth(font, text) {
    if (!measureCtx && typeof document !== "undefined") {
      measureCtx = document.createElement("canvas").getContext("2d");
    }
    if (!measureCtx) return text.length * 6.8;
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  function boxOverlap(a, b) {
    return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  }

  function cleanMapLabel(t) {
    let s = String((t && (t.shortTitle || t.title)) || "").trim();
    // Strip noisy studio/export suffixes while keeping musical title intact
    s = s.replace(/\s*[,(\[]\s*(cute|rough|ruff|wip|master|bounce|mix|edit|test).*$/i, "").trim();
    if (s.length <= 24) return s;
    const cut = s.slice(0, 23);
    const sp = cut.lastIndexOf(" ");
    return (sp >= 12 ? cut.slice(0, sp) : cut).replace(/[-–—,:;\s]+$/, "") + "…";
  }

  function getUiObstacleBoxes(mapWrap) {
    const boxes = [[0, 0, 218, 62]]; // top-left Vibe | Era | Star HUD
    if (typeof document !== "undefined" && mapWrap) {
      const mRect = mapWrap.getBoundingClientRect();
      const card = document.getElementById("track-player-card");
      if (card && !card.hidden) {
        const cRect = card.getBoundingClientRect();
        if (cRect.width > 0 && cRect.height > 0) {
          boxes.push([
            cRect.left - mRect.left - 8,
            cRect.top - mRect.top - 8,
            cRect.right - mRect.left + 8,
            cRect.bottom - mRect.top + 8,
          ]);
        }
      }
    }
    return boxes;
  }

  // Draw crisp 12px Inter 500/700 track labels in 1:1 screen space with 3px surface knock-out halo & strict collision culling
  function drawScreenTrackLabels(ctx, opts) {
    lastTrackBoxes = [];
    if (!ctx) return lastTrackBoxes;
    const {
      nodes,
      zoom,
      vw,
      vh,
      palette,
      isMatch,
      nodeScreenRadius,
      playId,
      selectedId,
      hoverId,
      isStarred,
      mapWrap,
    } = opts;

    const zoomed = zoom.k >= 1.65;
    const uiBoxes = getUiObstacleBoxes(mapWrap);

    // Collect visible in-viewport nodes and register dot obstacles
    const visible = [];
    const dotBoxes = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!isMatch(n.t)) continue;
      const sx = n.x * zoom.k + zoom.x;
      const sy = n.y * zoom.k + zoom.y;
      if (sx < -36 || sx > vw + 36 || sy < -36 || sy > vh + 36) continue;
      const r = nodeScreenRadius(n.t);
      const isPlay = n.id === playId;
      const isSel = n.id === selectedId;
      const isHov = n.id === hoverId;
      dotBoxes.push({ id: n.id, box: [sx - r - 2.5, sy - r - 2.5, sx + r + 2.5, sy + r + 2.5] });
      if (zoomed || isPlay || isSel) {
        const prio =
          (isPlay ? 1000 : 0) +
          (isSel ? 800 : 0) +
          (isHov ? 600 : 0) +
          (isStarred && isStarred(n.id) ? 200 : 0) +
          (n.t.released ? 80 : 0) +
          (Number(n.t.energy) || 0);
        visible.push({ n, sx, sy, r, prio, emph: isPlay || isSel || isHov });
      }
    }

    if (!visible.length) return lastTrackBoxes;
    visible.sort((a, b) => b.prio - a.prio);

    ctx.save();
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.textBaseline = "middle";

    const placed = [];
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i];
      const lbl = cleanMapLabel(item.n.t);
      if (!lbl) continue;
      const font = `${item.emph ? 700 : 500} 12px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.font = font;
      const w = ctx.measureText(lbl).width;
      const hw = w * 0.5;
      const hh = 7.5;
      const gap = item.r + 6;

      // 4 outward candidate positions around the dot (above, below, right, left — Groove Explorer style)
      const cands = [
        { x: item.sx, y: item.sy - gap - 4, align: "center", box: [item.sx - hw, item.sy - gap - 4 - hh, item.sx + hw, item.sy - gap - 4 + hh] },
        { x: item.sx, y: item.sy + gap + 5, align: "center", box: [item.sx - hw, item.sy + gap + 5 - hh, item.sx + hw, item.sy + gap + 5 + hh] },
        { x: item.sx + gap, y: item.sy + 0.5, align: "left", box: [item.sx + gap, item.sy + 0.5 - hh, item.sx + gap + w, item.sy + 0.5 + hh] },
        { x: item.sx - gap, y: item.sy + 0.5, align: "right", box: [item.sx - gap - w, item.sy + 0.5 - hh, item.sx - gap, item.sy + 0.5 + hh] },
      ];

      let chosen = null;
      for (let ci = 0; ci < cands.length; ci++) {
        const c = cands[ci];
        const b = c.box;
        if (b[0] < 6 || b[2] > vw - 6 || b[1] < 8 || b[3] > vh - 8) continue;
        // Pad candidate box slightly so adjacent labels keep clean air between them
        const padB = [b[0] - 5, b[1] - 2.5, b[2] + 5, b[3] + 2.5];
        if (!item.emph && uiBoxes.some((ub) => boxOverlap(padB, ub))) continue;
        let hitPlaced = false;
        for (let pi = 0; pi < placed.length; pi++) {
          if (boxOverlap(padB, placed[pi])) { hitPlaced = true; break; }
        }
        if (hitPlaced) continue;

        let hitDot = false;
        for (let di = 0; di < dotBoxes.length; di++) {
          if (dotBoxes[di].id === item.n.id) continue;
          if (boxOverlap(b, dotBoxes[di].box)) { hitDot = true; break; }
        }
        if (hitDot && !item.emph) continue;
        chosen = c;
        break;
      }

      if (!chosen) continue;
      placed.push([chosen.box[0] - 4, chosen.box[1] - 2, chosen.box[2] + 4, chosen.box[3] + 2]);

      ctx.textAlign = chosen.align;
      ctx.globalAlpha = item.emph ? 1 : 0.94;
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = palette.surfaceLowest;
      ctx.strokeText(lbl, chosen.x, chosen.y);
      ctx.fillStyle = palette.onSurface;
      ctx.fillText(lbl, chosen.x, chosen.y);
    }

    ctx.restore();
    lastTrackBoxes = placed;
    return lastTrackBoxes;
  }

  // Render Groove Explorer cartographic floating .map-family-label landmarks (Google Sans Flex 600 + surface halo, obstacle-avoiding)
  function renderClusterLandmarks(svgGroup, opts) {
    if (!svgGroup) return;
    svgGroup.innerHTML = "";
    const {
      styleGroups,
      nodeById,
      nodes,
      zoom,
      vw,
      vh,
      activeClusterId,
      isMatch,
      onToggleCluster,
      mapWrap,
    } = opts;

    const isWide = vw > 840;
    const zoomed = zoom.k >= 1.65;
    const fs = zoomed ? (isWide ? 20 : 17) : (isWide ? 18 : 14);
    const fontSpec = `600 ${fs}px "Google Sans Flex", "Google Sans", Inter, sans-serif`;

    const uiBoxes = getUiObstacleBoxes(mapWrap);
    const allDots = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const sx = n.x * zoom.k + zoom.x;
      const sy = n.y * zoom.k + zoom.y;
      if (sx < -60 || sx > vw + 60 || sy < -60 || sy > vh + 60) continue;
      allDots.push([sx, sy, n.id]);
    }
    const dotPad = isWide ? 8.5 : 7.0;
    const dotBoxes = allDots.map(([dx, dy]) => [dx - dotPad, dy - dotPad, dx + dotPad, dy + dotPad]);
    const placedFam = [];

    // Order largest / central clusters cleanly
    styleGroups.forEach((g) => {
      const members = (g.members || []).map((id) => nodeById.get(id)).filter(Boolean);
      if (!members.length) return;
      const anyMatch = members.some((m) => isMatch(m.t));

      // Compute visible member cloud bounds in screen space
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let topX = 0, visCount = 0;
      const xs = [], ys = [];
      const ownSet = new Set();
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        ownSet.add(m.id);
        const sx = m.x * zoom.k + zoom.x;
        const sy = m.y * zoom.k + zoom.y;
        if (zoomed && (sx < -40 || sx > vw + 40 || sy < -40 || sy > vh + 40)) continue;
        xs.push(sx);
        ys.push(sy);
        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
        if (sy < minY) { minY = sy; topX = sx; }
        if (sy > maxY) maxY = sy;
        visCount++;
      }
      if (visCount === 0) return;
      xs.sort((a, b) => a - b);
      ys.sort((a, b) => a - b);

      const MOBILE_SHORT = {
        "Ambient & meditative": "Ambient",
        "Dark ambient & drone": "Dark ambient",
        "Downtempo & lush chords": "Downtempo",
        "House & ecstatic 4/4 groove": "House & 4/4",
        "Chill & steady electronic": "Chill electronic",
        "Complex drums & breaks": "Breaks & drums",
        "Hypnotic electro & microtonal": "Hypnotic electro",
        "Experimental guitar & vocal": "Guitar & vocal",
      };
      const mx = xs[xs.length >> 1];
      const my = ys[ys.length >> 1];
      const qLo = xs.length >= 10 ? Math.floor(xs.length * 0.14) : 0;
      const qHi = xs.length >= 10 ? Math.floor(xs.length * 0.86) : xs.length - 1;
      const cMinX = xs[qLo], cMaxX = xs[qHi];
      const cMinY = ys[qLo], cMaxY = ys[qHi];
      const label = (!isWide && !zoomed && MOBILE_SHORT[g.label]) ? MOBILE_SHORT[g.label] : g.label;
      const tw = textWidth(fontSpec, label);
      const hw = Math.ceil(tw * 0.52 + 5);
      const hh = Math.ceil(fs * 0.6 + 2.5);

      const clampX = (x) => Math.max(hw + 6, Math.min(vw - hw - 6, x));
      const clampY = (y) => Math.max(hh + 10, Math.min(vh - hh - 10, y));
      const maxRad = zoomed ? 220 : (isWide ? 96 : 56);

      const cands = [
        [topX, minY - hh - 7],
        [mx, minY - hh - 7],
        [mx, cMinY - hh - 9],
        [cMaxX + hw * 0.45, cMinY - hh - 6],
        [mx, cMaxY + hh + 8],
        [mx, maxY + hh + 8],
        [cMinX - hw - 6, my],
        [cMaxX + hw + 6, my],
      ];
      RINGS.forEach((rad) => {
        if (rad > maxRad) return;
        ANGLES.forEach((ang) => {
          cands.push([mx + Math.cos(ang) * rad * 1.15, my + Math.sin(ang) * rad]);
          cands.push([topX + Math.cos(ang) * rad * 1.1, minY + Math.sin(ang) * rad]);
        });
      });

      let best = null;
      let bestScore = Infinity;
      for (let ci = 0; ci < cands.length; ci++) {
        const cx = zoomed ? cands[ci][0] : clampX(cands[ci][0]);
        const cy = zoomed ? cands[ci][1] : clampY(cands[ci][1]);
        if (cx - hw < 5 || cx + hw > vw - 5 || cy - hh < 8 || cy + hh > vh - 8) continue;
        const box = [cx - hw, cy - hh, cx + hw, cy + hh];

        if (uiBoxes.some((ub) => boxOverlap(box, ub))) continue;
        if (placedFam.some((pb) => boxOverlap(box, pb))) continue;
        if (lastTrackBoxes.some((tb) => boxOverlap(box, tb))) continue;

        let dotCost = 0;
        let ownD = Infinity;
        let otherD = Infinity;
        for (let di = 0; di < allDots.length; di++) {
          const dx = allDots[di][0], dy = allDots[di][1];
          const isOwn = ownSet.has(allDots[di][2]);
          const d = Math.hypot(cx - dx, cy - dy);
          if (isOwn) { if (d < ownD) ownD = d; }
          else { if (d < otherD) otherD = d; }
          if (boxOverlap(box, dotBoxes[di])) {
            dotCost += isOwn ? 95 : 260;
          }
        }
        if (zoomed && dotCost > 0) continue;

        const distCore = Math.hypot(cx - mx, cy - my);
        let score =
          ownD * 1.2 +
          distCore * (isWide || zoomed ? 0.6 : 1.9) +
          dotCost +
          (cy < cMinY ? -8 : 0) +
          (otherD < ownD ? (ownD - otherD) * 18 + 420 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = [cx, cy];
        }
      }

      if (!best) {
        if (zoomed) return;
        best = [clampX(mx), clampY(minY - hh - 8)];
      }

      placedFam.push([best[0] - hw - 6, best[1] - hh - 4, best[0] + hw + 6, best[1] + hh + 4]);

      const grp = document.createElementNS(NS, "g");
      const cls =
        "map-family-group" +
        (activeClusterId === g.id ? " is-active" : "") +
        (!anyMatch || (activeClusterId && activeClusterId !== g.id) ? " is-dim" : "");
      grp.setAttribute("class", cls);
      grp.setAttribute("transform", `translate(${best[0].toFixed(1)}, ${best[1].toFixed(1)})`);

      const hit = document.createElementNS(NS, "rect");
      hit.setAttribute("class", "map-family-hit");
      hit.setAttribute("x", (-hw).toFixed(1));
      hit.setAttribute("y", (-hh).toFixed(1));
      hit.setAttribute("width", (hw * 2).toFixed(1));
      hit.setAttribute("height", (hh * 2).toFixed(1));
      hit.setAttribute("rx", "8");

      const txt = document.createElementNS(NS, "text");
      txt.setAttribute("class", "map-family-label");
      txt.setAttribute("y", (fs * 0.34).toFixed(1));
      txt.textContent = label;

      grp.append(hit, txt);
      grp.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (onToggleCluster) onToggleCluster(g.id);
      });
      svgGroup.appendChild(grp);
    });
  }

  window.BTMM_MAP_LABELS = {
    drawScreenTrackLabels,
    renderClusterLandmarks,
  };
})();
