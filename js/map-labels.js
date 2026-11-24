// Groove Explorer Cartographic Landmark & Screen-Space Collision-Free Track Label Engine
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const ANGLES = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8].map(
    (s) => -Math.PI / 2 + (s * Math.PI) / 8
  );
  const RINGS = [12, 22, 34, 48, 66, 88, 114, 144, 180, 220];
  const LEADER_RADII = [15, 23, 32, 42, 54, 68, 84, 102, 122];

  let measureCtx = null;
  let lastTrackBoxes = [];
  let lastPlacedEntries = [];
  let shownIds = new Set();

  function textWidth(font, text) {
    if (!measureCtx && typeof document !== "undefined") {
      measureCtx = document.createElement("canvas").getContext("2d");
    }
    if (!measureCtx) return text.length * 6.4;
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  function boxOverlap(a, b) {
    return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  }

  function cleanMapLabel(t) {
    let s = String((t && (t.shortTitle || t.title)) || "").trim();
    s = s.replace(/\s*[,(\[]\s*(cute|rough|ruff|wip|master|bounce|mix|edit|test).*$/i, "").trim();
    if (s.length <= 24) return s;
    const cut = s.slice(0, 23);
    const sp = cut.lastIndexOf(" ");
    return (sp >= 11 ? cut.slice(0, sp) : cut).replace(/[-–—,:;\s]+$/, "") + "…";
  }

  function getUiObstacleBoxes(mapWrap) {
    const boxes = [[0, 0, 214, 58]]; // top-left Vibe | Era | Star HUD
    if (typeof document !== "undefined" && mapWrap) {
      const mRect = mapWrap.getBoundingClientRect();
      const card = document.getElementById("track-player-card");
      if (card && !card.hidden) {
        const cRect = card.getBoundingClientRect();
        if (cRect.width > 0 && cRect.height > 0) {
          boxes.push([
            cRect.left - mRect.left - 6,
            cRect.top - mRect.top - 6,
            cRect.right - mRect.left + 6,
            cRect.bottom - mRect.top + 6,
          ]);
        }
      }
    }
    return boxes;
  }

  function nearestBoxPoint(sx, sy, b) {
    const nx = Math.max(b[0], Math.min(b[2], sx));
    const ny = Math.max(b[1], Math.min(b[3], sy));
    return [nx, ny];
  }

  // Draw crisp Inter track labels in 1:1 screen space with surface knock-out halo,
  // 8 immediate slots + concentric cartographic leader slots so 100% of zoomed-in cluster tracks show their names.
  function drawScreenTrackLabels(ctx, opts) {
    lastTrackBoxes = [];
    lastPlacedEntries = [];
    shownIds = new Set();
    if (!ctx) return lastTrackBoxes;
    const {
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
      isStarred,
      mapWrap,
    } = opts;

    const zoomed = zoom.k >= 1.55;
    const uiBoxes = getUiObstacleBoxes(mapWrap);
    const isCompact = vw <= 600;
    const baseFs = isCompact ? 11 : 11.5;

    const visible = [];
    const dotBoxes = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!isMatch(n.t)) continue;
      const sx = Number.isFinite(n.px) ? n.px : n.x * zoom.k + zoom.x;
      const sy = Number.isFinite(n.py) ? n.py : n.y * zoom.k + zoom.y;
      if (sx < -24 || sx > vw + 24 || sy < -24 || sy > vh + 24) continue;
      const r = nodeScreenRadius(n.t);
      const isPlay = n.id === playId;
      const isSel = n.id === selectedId;
      const isHov = n.id === hoverId;
      dotBoxes.push({ id: n.id, box: [sx - r - 1.2, sy - r - 1.2, sx + r + 1.2, sy + r + 1.2] });
      if ((zoomed && sx >= 6 && sx <= vw - 6 && sy >= 8 && sy <= vh - 8) || isPlay || isSel) {
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

    const allowLeaderRings = zoom.k >= 2.2 || visible.length <= 160;
    const placed = [];
    const toDraw = [];

    for (let i = 0; i < visible.length; i++) {
      const item = visible[i];
      const lbl = cleanMapLabel(item.n.t);
      if (!lbl) continue;
      const fs = item.emph ? 12 : baseFs;
      const font = `${item.emph ? 700 : 500} ${fs}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
      const w = textWidth(font, lbl);
      const hw = w * 0.5;
      const hh = item.emph ? 6.4 : (isCompact ? 5.5 : 5.8);
      const g = item.r + 3.8;

      const cands = [];
      if (item.n.fanAngle != null) {
        const ca = Math.cos(item.n.fanAngle);
        const sa = Math.sin(item.n.fanAngle);
        const ax = item.sx + ca * (g + 2);
        const ay = item.sy + sa * (g + 2);
        const bx0 = ca > 0.35 ? ax : ca < -0.35 ? ax - w : ax - hw;
        cands.push({ box: [bx0, ay - hh, bx0 + w, ay + hh], leader: false });
      }
      // 8 tight adjacent slots around the small dot
      cands.push(
        { box: [item.sx - hw, item.sy - g - 2 * hh, item.sx + hw, item.sy - g], leader: false },
        { box: [item.sx - hw, item.sy + g, item.sx + hw, item.sy + g + 2 * hh], leader: false },
        { box: [item.sx + g, item.sy - hh, item.sx + g + w, item.sy + hh], leader: false },
        { box: [item.sx - g - w, item.sy - hh, item.sx - g, item.sy + hh], leader: false },
        { box: [item.sx + g - hw * 0.3, item.sy - g - 2 * hh, item.sx + g + hw * 1.7, item.sy - g], leader: false },
        { box: [item.sx - g - hw * 1.7, item.sy - g - 2 * hh, item.sx - g + hw * 0.3, item.sy - g], leader: false },
        { box: [item.sx + g - hw * 0.3, item.sy + g, item.sx + g + hw * 1.7, item.sy + g + 2 * hh], leader: false },
        { box: [item.sx - g - hw * 1.7, item.sy + g, item.sx - g + hw * 0.3, item.sy + g + 2 * hh], leader: false }
      );

      if (allowLeaderRings) {
        for (let ri = 0; ri < LEADER_RADII.length; ri++) {
          const rad = LEADER_RADII[ri];
          for (let ai = 0; ai < ANGLES.length; ai++) {
            const ang = ANGLES[ai];
            const ca = Math.cos(ang);
            const sa = Math.sin(ang);
            const ax = item.sx + ca * rad;
            const ay = item.sy + sa * rad;
            const bx0 = ca > 0.35 ? ax : ca < -0.35 ? ax - w : ax - hw;
            cands.push({ box: [bx0, ay - hh, bx0 + w, ay + hh], leader: true });
          }
        }
      }

      let chosenBox = null;
      for (let ci = 0; ci < cands.length; ci++) {
        let b = cands[ci].box;
        if (b[0] < 4) {
          const sh = 4 - b[0];
          b = [b[0] + sh, b[1], b[2] + sh, b[3]];
        } else if (b[2] > vw - 4) {
          const sh = b[2] - (vw - 4);
          b = [b[0] - sh, b[1], b[2] - sh, b[3]];
        }
        if (b[0] < 3 || b[2] > vw - 3 || b[1] < 6 || b[3] > vh - 6) continue;

        const padB = [b[0] - 1.4, b[1] - 0.9, b[2] + 1.4, b[3] + 0.9];
        if (!item.emph && uiBoxes.some((ub) => boxOverlap(padB, ub))) continue;

        let hitPlaced = false;
        for (let pi = 0; pi < placed.length; pi++) {
          if (boxOverlap(padB, placed[pi])) {
            hitPlaced = true;
            break;
          }
        }
        if (hitPlaced) continue;

        let hitDot = false;
        for (let di = 0; di < dotBoxes.length; di++) {
          if (dotBoxes[di].id === item.n.id) continue;
          if (boxOverlap(b, dotBoxes[di].box)) {
            hitDot = true;
            break;
          }
        }
        if (hitDot && !item.emph) continue;

        chosenBox = b;
        break;
      }

      if (!chosenBox) continue;
      placed.push(chosenBox);
      shownIds.add(item.n.id);
      lastPlacedEntries.push({ id: item.n.id, box: chosenBox });
      toDraw.push({ item, lbl, font, box: chosenBox });
    }

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.miterLimit = 2;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";

    // Pass 1: subtle cartographic leader ticks for any stepped-outward labels so lines sit cleanly beneath text
    for (let i = 0; i < toDraw.length; i++) {
      const { item, box } = toDraw[i];
      const [nx, ny] = nearestBoxPoint(item.sx, item.sy, box);
      const dist = Math.hypot(nx - item.sx, ny - item.sy);
      if (dist > item.r + 7.5) {
        const ux = (nx - item.sx) / dist;
        const uy = (ny - item.sy) / dist;
        const x0 = item.sx + ux * (item.r + 1.4);
        const y0 = item.sy + uy * (item.r + 1.4);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(nx, ny);
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 2.4;
        ctx.strokeStyle = palette.surfaceLowest;
        ctx.stroke();
        ctx.globalAlpha = item.emph ? 0.85 : 0.52;
        ctx.lineWidth = 1.05;
        ctx.strokeStyle = trackColor ? trackColor(item.n.t) : palette.outline;
        ctx.stroke();
      }
    }

    // Pass 2: crisp knock-out halo text
    for (let i = 0; i < toDraw.length; i++) {
      const { item, lbl, font, box } = toDraw[i];
      const cx = (box[0] + box[2]) * 0.5;
      const cy = (box[1] + box[3]) * 0.5 + 0.5;
      ctx.font = font;
      ctx.globalAlpha = item.emph ? 1 : 0.95;
      ctx.lineWidth = 2.9;
      ctx.strokeStyle = palette.surfaceLowest;
      ctx.strokeText(lbl, cx, cy);
      ctx.fillStyle = palette.onSurface;
      ctx.fillText(lbl, cx, cy);
    }

    ctx.restore();
    lastTrackBoxes = placed;
    return lastTrackBoxes;
  }

  function isLabelShown(id) {
    return shownIds.has(id);
  }

  function hitLabelAt(px, py) {
    for (let i = lastPlacedEntries.length - 1; i >= 0; i--) {
      const b = lastPlacedEntries[i].box;
      if (px >= b[0] - 3 && px <= b[2] + 3 && py >= b[1] - 3 && py <= b[3] + 3) {
        return lastPlacedEntries[i].id;
      }
    }
    return null;
  }

  // Render Groove Explorer cartographic floating .map-family-label landmarks
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
    const zoomed = zoom.k >= 1.55;
    const fs = zoomed ? (isWide ? 20 : 17) : (isWide ? 18 : 14);
    const fontSpec = `600 ${fs}px "Google Sans Flex", "Google Sans", Inter, sans-serif`;

    const uiBoxes = getUiObstacleBoxes(mapWrap);
    const allDots = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const sx = Number.isFinite(n.px) ? n.px : n.x * zoom.k + zoom.x;
      const sy = Number.isFinite(n.py) ? n.py : n.y * zoom.k + zoom.y;
      if (sx < -60 || sx > vw + 60 || sy < -60 || sy > vh + 60) continue;
      allDots.push([sx, sy, n.id]);
    }
    const dotPad = zoomed ? 5.0 : (isWide ? 7.5 : 6.0);
    const dotBoxes = allDots.map(([dx, dy]) => [dx - dotPad, dy - dotPad, dx + dotPad, dy + dotPad]);
    const placedFam = [];

    const MOBILE_SHORT = {
      "Ambient & meditative": "Ambient",
      "Dark ambient & drone": "Dark ambient",
      "Downtempo & lush chords": "Downtempo",
      "House & ecstatic 4/4 groove": "House & 4/4",
      "Chill & steady electronic": "Chill electronic",
      "Complex drums & breaks": "Breaks & drums",
      "Hypnotic electro & microtonal": "Hypnotic electro",
      "Experimental guitar & vocal": "Guitar & vocal",
      "Ambient & soundscape": "Ambient",
      "Hypnotic & dub techno": "Dub techno",
      "Downtempo & leftfield": "Downtempo",
      "House & deep groove": "House & deep",
      "Indie, post-punk & guitar": "Indie & guitar",
      "Electro, acid & techno": "Electro & techno",
      "IDM, glitch & industrial": "IDM & industrial",
      "Jungle, DnB & breakcore": "DnB & breaks",
      "Piano, classical & folk": "Piano & acoustic",
      "UK bass, dubstep & juke": "UK bass & dubstep",
    };

    styleGroups.forEach((g) => {
      const members = (g.members || []).map((id) => nodeById.get(id)).filter(Boolean);
      if (!members.length) return;
      const anyMatch = members.some((m) => isMatch(m.t));

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let topX = 0, visCount = 0;
      const xs = [], ys = [];
      const ownSet = new Set();
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        ownSet.add(m.id);
        const sx = Number.isFinite(m.px) ? m.px : m.x * zoom.k + zoom.x;
        const sy = Number.isFinite(m.py) ? m.py : m.y * zoom.k + zoom.y;
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

      const mx = xs[xs.length >> 1];
      const my = ys[ys.length >> 1];
      const qLo = xs.length >= 10 ? Math.floor(xs.length * 0.14) : 0;
      const qHi = xs.length >= 10 ? Math.floor(xs.length * 0.86) : xs.length - 1;
      const cMinX = xs[qLo], cMaxX = xs[qHi];
      const cMinY = ys[qLo], cMaxY = ys[qHi];
      const shortLbl = g.short_label || MOBILE_SHORT[g.label];
      const label = (!isWide && !zoomed && shortLbl) ? shortLbl : g.label;
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
        if (!zoomed && distCore > (isWide ? 150 : 80)) continue;
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
    isLabelShown,
    hitLabelAt,
  };
})();
