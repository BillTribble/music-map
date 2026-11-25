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
    let hudW = 248;
    if (typeof document !== "undefined" && mapWrap) {
      const mRect = mapWrap.getBoundingClientRect();
      const hudPill = document.querySelector("#map-floating-hud .map-hud-pill");
      if (hudPill) {
        const hRect = hudPill.getBoundingClientRect();
        if (hRect.width > 0) hudW = Math.max(248, hRect.right - mRect.left + 8);
      }
    }
    const boxes = [[0, 0, hudW, 58]]; // top-left Vibe | Era | Star | Sketches HUD
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
      if (item.n.t && item.n.t.is_spoken_word) {
        const belowBoxY = item.sy + 23;
        cands.push({ box: [item.sx - hw, belowBoxY, item.sx + hw, belowBoxY + 2 * hh], leader: false });
      }
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
      isHidden,
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
      if (isHidden && isHidden(n.t)) continue;
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
      "Hypnotic, dub & microtonal": "Hypnotic & dub",
      "Downtempo & leftfield": "Downtempo",
      "House & deep groove": "House & deep",
      "Indie, post-punk & guitar": "Indie & guitar",
      "Electro, acid & techno": "Electro & techno",
      "IDM, glitch & industrial": "IDM & industrial",
      "Jungle, DnB & breakcore": "DnB & breaks",
      "Piano, classical & folk": "Piano & acoustic",
      "UK bass, dubstep & juke": "UK bass & dubstep",
      "Generative AI music": "AI music",
      "Spoken word": "Spoken word",
    };

    // Pre-compute Generative AI & Spoken Word island bounds so handcrafted landmark headers never cross into them
    const reserveGuardBoxes = [];
    styleGroups.forEach((rg) => {
      if (!rg.is_ai_group && !rg.is_spoken_group) return;
      let rMinX = Infinity, rMaxX = -Infinity, rMinY = Infinity, rMaxY = -Infinity, rCnt = 0;
      (rg.members || []).forEach((id) => {
        const m = nodeById.get(id);
        if (!m || (isHidden && isHidden(m.t))) return;
        const sx = Number.isFinite(m.px) ? m.px : m.x * zoom.k + zoom.x;
        const sy = Number.isFinite(m.py) ? m.py : m.y * zoom.k + zoom.y;
        if (zoomed && (sx < -40 || sx > vw + 40 || sy < -40 || sy > vh + 40)) return;
        if (sx < rMinX) rMinX = sx;
        if (sx > rMaxX) rMaxX = sx;
        if (sy < rMinY) rMinY = sy;
        if (sy > rMaxY) rMaxY = sy;
        rCnt++;
      });
      if (rCnt > 0) {
        const padX = rg.is_spoken_group ? (isWide ? 24 : 14) : (isWide ? 36 : 16);
        const padTop = rg.is_spoken_group ? (isWide ? 18 : 12) : (isWide ? 30 : 16);
        const padBot = rg.is_spoken_group ? (isWide ? 18 : 12) : (isWide ? 28 : 16);
        reserveGuardBoxes.push([
          Math.max(4, rMinX - padX) - 8,
          Math.max(4, rMinY - padTop) - 28,
          Math.min(vw - 6, rMaxX + padX) + 8,
          Math.min(vh - 6, rMaxY + padBot) + 8,
        ]);
      }
    });

    styleGroups.forEach((g) => {
      const members = (g.members || [])
        .map((id) => nodeById.get(id))
        .filter((m) => m && !(isHidden && isHidden(m.t)));
      if (!members.length) return;
      const anyMatch = members.some((m) => isMatch(m.t));

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let topX = 0, visCount = 0;
      const xs = [], ys = [];
      const fullXs = [], fullYs = [];
      const ownSet = new Set();
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        ownSet.add(m.id);
        const sx = Number.isFinite(m.px) ? m.px : m.x * zoom.k + zoom.x;
        const sy = Number.isFinite(m.py) ? m.py : m.y * zoom.k + zoom.y;
        fullXs.push(sx);
        fullYs.push(sy);
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

      // Never stamp a primary genre landmark header on a zoomed viewport over 1–2 stray border outliers
      const isDedicatedIsland = Boolean(g.is_ai_group || g.is_spoken_group);
      if (zoomed && !isDedicatedIsland && members.length >= 4) {
        const minReq = Math.max(3, Math.ceil(members.length * 0.12));
        if (visCount < Math.min(members.length, minReq)) return;
        fullXs.sort((a, b) => a - b);
        fullYs.sort((a, b) => a - b);
        const fqLo = fullXs.length >= 8 ? Math.floor(fullXs.length * 0.14) : 0;
        const fqHi = fullXs.length >= 8 ? Math.floor(fullXs.length * 0.86) : fullXs.length - 1;
        const coreMargin = 72 * Math.sqrt(Math.max(1, zoom.k));
        xs.sort((a, b) => a - b);
        ys.sort((a, b) => a - b);
        const vMx = xs[xs.length >> 1];
        const vMy = ys[ys.length >> 1];
        if (
          vMx < fullXs[fqLo] - coreMargin ||
          vMx > fullXs[fqHi] + coreMargin ||
          vMy < fullYs[fqLo] - coreMargin ||
          vMy > fullYs[fqHi] + coreMargin
        ) {
          return;
        }
        if (visCount < members.length * 0.35) {
          let ownNear = 0, otherNear = 0;
          const neighR = 95;
          for (let di = 0; di < allDots.length; di++) {
            if (Math.hypot(allDots[di][0] - vMx, allDots[di][1] - vMy) <= neighR) {
              if (ownSet.has(allDots[di][2])) ownNear++;
              else otherNear++;
            }
          }
          if (otherNear > ownNear * 2.2) return;
        }
      }

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

      const anchorTopX = zoomed ? topX : mx;
      const anchorMinY = zoomed ? minY : cMinY;
      const anchorMaxY = zoomed ? maxY : cMaxY;

      const cands = [
        [anchorTopX, anchorMinY - hh - 9],
        [mx, cMinY - hh - 11],
        [mx, cMinY - hh - 22],
        [cMaxX + hw * 0.45, cMinY - hh - 9],
        [cMinX - hw * 0.45, cMinY - hh - 9],
        [mx, anchorMaxY + hh + 10],
        [mx, anchorMaxY + hh + 22],
        [cMaxX + hw * 0.45, anchorMaxY + hh + 10],
        [cMinX - hw * 0.45, anchorMaxY + hh + 10],
        [cMinX - hw - 10, my],
        [cMaxX + hw + 10, my],
        [cMinX - hw - 8, cMinY - hh],
        [cMaxX + hw + 8, cMinY - hh],
        [cMinX - hw - 8, cMaxY + hh],
        [cMaxX + hw + 8, cMaxY + hh],
      ];
      for (let ui = 0; ui < uiBoxes.length; ui++) {
        const ub = uiBoxes[ui];
        if (my >= ub[1] - 12 && mx >= ub[0] - 32 && mx <= ub[2] + 32) {
          const aboveCardY = ub[1] - hh - 8;
          if (aboveCardY >= cMinY - 56 && aboveCardY <= cMaxY + 32) {
            cands.push([mx, aboveCardY]);
            cands.push([cMinX, aboveCardY]);
            cands.push([cMaxX, aboveCardY]);
          }
        }
      }
      RINGS.forEach((rad) => {
        if (rad > maxRad) return;
        ANGLES.forEach((ang) => {
          cands.push([mx + Math.cos(ang) * rad * 1.18, my + Math.sin(ang) * rad]);
          cands.push([anchorTopX + Math.cos(ang) * rad * 1.12, anchorMinY + Math.sin(ang) * rad]);
        });
      });

      let best = null;
      let bestScore = Infinity;
      for (let ci = 0; ci < cands.length; ci++) {
        const cx = zoomed ? cands[ci][0] : clampX(cands[ci][0]);
        const cy = zoomed ? cands[ci][1] : clampY(cands[ci][1]);
        if (cx - hw < 5 || cx + hw > vw - 5 || cy - hh < 8 || cy + hh > vh - 8) continue;
        const box = [cx - hw, cy - hh, cx + hw, cy + hh];
        const padBox = [cx - hw - 3, cy - hh - 3, cx + hw + 3, cy + hh + 3];

        if (uiBoxes.some((ub) => boxOverlap(box, ub))) continue;
        if (!isDedicatedIsland && reserveGuardBoxes.some((rb) => boxOverlap(box, rb))) continue;
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
          if (boxOverlap(padBox, dotBoxes[di])) {
            dotCost += isOwn ? 240 : 720;
          }
        }
        if (zoomed && dotCost > 0) continue;

        const distCore = Math.hypot(cx - mx, cy - my);
        const dxCoreBox = cx < cMinX ? cMinX - cx : (cx > cMaxX ? cx - cMaxX : 0);
        const dyCoreBox = cy < cMinY ? cMinY - cy : (cy > cMaxY ? cy - cMaxY : 0);
        const distCoreBox = Math.hypot(dxCoreBox, dyCoreBox);
        if (!zoomed && (distCore > (isWide ? 165 : 112) || distCoreBox > (isWide ? 105 : 64))) continue;
        const inCoreInterior = (!zoomed && visCount >= 6 && dxCoreBox === 0 && dyCoreBox === 0) ? 280 : 0;
        let score =
          ownD * 1.05 +
          distCore * (isWide || zoomed ? 0.55 : 1.5) +
          dotCost +
          inCoreInterior +
          (cy < cMinY ? -12 : 0) +
          (otherD < ownD ? (ownD - otherD) * 18 + 420 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = [cx, cy];
        }
      }

      if (g.is_ai_group || g.is_spoken_group) {
        const headerOffset = g.is_spoken_group ? (isWide ? 22 : 16) : (isWide ? 34 : 20);
        const boxCenterX = Math.max(hw + 8, Math.min(vw - hw - 8, (minX + maxX) * 0.5));
        const headerY = Math.max(hh + 10, minY - hh - headerOffset);
        const hBox = [boxCenterX - hw, headerY - hh, boxCenterX + hw, headerY + hh];
        if (!uiBoxes.some((ub) => boxOverlap(hBox, ub)) && !placedFam.some((pb) => boxOverlap(hBox, pb))) {
          best = [boxCenterX, headerY];
        }
      }

      if (!best) return;

      placedFam.push([best[0] - hw - 6, best[1] - hh - 4, best[0] + hw + 6, best[1] + hh + 4]);

      const grp = document.createElementNS(NS, "g");
      const isOwnAiSubActive = Boolean(
        g.is_ai_group && activeClusterId && activeClusterId.startsWith("ai_sub_")
      );
      const cls =
        "map-family-group" +
        (activeClusterId === g.id ? " is-active" : "") +
        (!anyMatch || (activeClusterId && activeClusterId !== g.id && !isOwnAiSubActive) ? " is-dim" : "");
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

      // Dedicated Spoken Word mini-island boundary
      if (g.is_spoken_group) {
        const sPadX = isWide ? 24 : 14;
        const sPadY = isWide ? 18 : 12;
        const sx0 = Math.max(4, minX - sPadX);
        const sy0 = Math.max(4, minY - sPadY);
        const sx1 = Math.min(vw - 6, maxX + sPadX);
        const sy1 = Math.min(vh - 6, maxY + sPadY);
        if (sx1 - sx0 >= 20 && sy1 - sy0 >= 20) {
          const sBox = document.createElementNS(NS, "rect");
          sBox.setAttribute("class", "map-ai-territory-box map-spoken-island-box");
          sBox.setAttribute("x", sx0.toFixed(1));
          sBox.setAttribute("y", sy0.toFixed(1));
          sBox.setAttribute("width", (sx1 - sx0).toFixed(1));
          sBox.setAttribute("height", (sy1 - sy0).toFixed(1));
          sBox.setAttribute("rx", "14");
          svgGroup.insertBefore(sBox, svgGroup.firstChild);
        }
      }

      // Dedicated Generative AI territory boundary + internal Discogs genre sub-labels
      if (g.is_ai_group) {
        const padX = isWide ? 36 : 16;
        const padTop = isWide ? 30 : 16;
        const padBot = isWide ? 28 : 16;
        const bx0 = Math.max(4, minX - padX);
        const by0 = Math.max(4, minY - padTop);
        const bx1 = Math.min(vw - 6, maxX + padX);
        const by1 = Math.min(vh - 6, maxY + padBot);
        if (bx1 - bx0 > 28 && by1 - by0 > 28) {
          const tBox = document.createElementNS(NS, "rect");
          tBox.setAttribute("class", "map-ai-territory-box");
          tBox.setAttribute("x", bx0.toFixed(1));
          tBox.setAttribute("y", by0.toFixed(1));
          tBox.setAttribute("width", (bx1 - bx0).toFixed(1));
          tBox.setAttribute("height", (by1 - by0).toFixed(1));
          tBox.setAttribute("rx", "18");
          svgGroup.insertBefore(tBox, svgGroup.firstChild);
        }

        if ((isWide || zoom.k >= 1.35) && Array.isArray(g.sub_groups)) {
          const subFs = zoomed ? 12.5 : 11.5;
          const subFont = `500 ${subFs}px Inter, -apple-system, sans-serif`;
          g.sub_groups.forEach((sg) => {
            const smem = (sg.members || [])
              .map((id) => nodeById.get(id))
              .filter((m) => m && !(isHidden && isHidden(m.t)));
            if (!smem.length) return;
            const sAnyMatch = smem.some((m) => isMatch(m.t));
            const sxs = [], sys = [];
            const sOwn = new Set();
            let sMinY = Infinity, sMaxY = -Infinity, sMinX = Infinity, sMaxX = -Infinity;
            for (let si = 0; si < smem.length; si++) {
              const sm = smem[si];
              sOwn.add(sm.id);
              const sx = Number.isFinite(sm.px) ? sm.px : sm.x * zoom.k + zoom.x;
              const sy = Number.isFinite(sm.py) ? sm.py : sm.y * zoom.k + zoom.y;
              sxs.push(sx);
              sys.push(sy);
              if (sx < sMinX) sMinX = sx;
              if (sx > sMaxX) sMaxX = sx;
              if (sy < sMinY) sMinY = sy;
              if (sy > sMaxY) sMaxY = sy;
            }
            sxs.sort((a, b) => a - b);
            sys.sort((a, b) => a - b);
            const smx = sxs[sxs.length >> 1];
            const smy = sys[sys.length >> 1];
            const sLbl = sg.short_label || sg.label;
            const stw = textWidth(subFont, sLbl);
            const shw = Math.ceil(stw * 0.52 + 4);
            const shh = Math.ceil(subFs * 0.6 + 2);

            const sCands = [
              [smx, sMinY - shh - 8],
              [smx, sMaxY + shh + 9],
              [sMinX - shw - 8, smy],
              [sMaxX + shw + 8, smy],
              [smx, by0 + shh + 5],
              [smx, by1 - shh - 5],
            ];
            [16, 26, 38, 50].forEach((rad) => {
              ANGLES.forEach((ang) => {
                sCands.push([smx + Math.cos(ang) * rad * 1.15, smy + Math.sin(ang) * rad]);
              });
            });

            let sBest = null;
            let sBestScore = Infinity;
            const clampLoX = Math.max(shw + 6, bx0 + shw + 5);
            const clampHiX = Math.min(vw - shw - 6, bx1 - shw - 5);
            const clampLoY = Math.max(shh + 8, by0 + shh + 4);
            const clampHiY = Math.min(vh - shh - 8, by1 - shh - 4);
            for (let sci = 0; sci < sCands.length; sci++) {
              const scx = clampLoX <= clampHiX ? Math.max(clampLoX, Math.min(clampHiX, sCands[sci][0])) : Math.max(shw + 6, Math.min(vw - shw - 6, sCands[sci][0]));
              const scy = clampLoY <= clampHiY ? Math.max(clampLoY, Math.min(clampHiY, sCands[sci][1])) : Math.max(shh + 8, Math.min(vh - shh - 8, sCands[sci][1]));
              const sbox = [scx - shw - 2, scy - shh - 2, scx + shw + 2, scy + shh + 2];
              if (uiBoxes.some((ub) => boxOverlap(sbox, ub))) continue;
              if (placedFam.some((pb) => boxOverlap(sbox, pb))) continue;
              if (lastTrackBoxes.some((tb) => boxOverlap(sbox, tb))) continue;

              let dc = 0;
              for (let di = 0; di < allDots.length; di++) {
                if (boxOverlap(sbox, dotBoxes[di])) {
                  dc += sOwn.has(allDots[di][2]) ? 260 : 480;
                }
              }
              const dCore = Math.hypot(scx - smx, scy - smy);
              if (dCore > 80) continue;
              const sc = dCore + dc;
              if (sc < sBestScore) {
                sBestScore = sc;
                sBest = [scx, scy];
              }
            }
            if (!sBest) return;
            placedFam.push([sBest[0] - shw - 4, sBest[1] - shh - 3, sBest[0] + shw + 4, sBest[1] + shh + 3]);

            const sGrp = document.createElementNS(NS, "g");
            const sCls =
              "map-ai-sub-group" +
              (activeClusterId === sg.id ? " is-active" : "") +
              (!sAnyMatch || (activeClusterId && activeClusterId !== sg.id && activeClusterId !== g.id) ? " is-dim" : "");
            sGrp.setAttribute("class", sCls);
            sGrp.setAttribute("transform", `translate(${sBest[0].toFixed(1)}, ${sBest[1].toFixed(1)})`);

            const sHit = document.createElementNS(NS, "rect");
            sHit.setAttribute("class", "map-family-hit");
            sHit.setAttribute("x", (-shw).toFixed(1));
            sHit.setAttribute("y", (-shh).toFixed(1));
            sHit.setAttribute("width", (shw * 2).toFixed(1));
            sHit.setAttribute("height", (shh * 2).toFixed(1));
            sHit.setAttribute("rx", "6");

            const sTxt = document.createElementNS(NS, "text");
            sTxt.setAttribute("class", "map-ai-sub-label");
            sTxt.setAttribute("y", (subFs * 0.34).toFixed(1));
            sTxt.textContent = sLbl;

            sGrp.append(sHit, sTxt);
            sGrp.addEventListener("click", (ev) => {
              ev.stopPropagation();
              if (onToggleCluster) onToggleCluster(sg.id);
            });
            svgGroup.appendChild(sGrp);
          });
        }
      }
    });
  }

  window.BTMM_MAP_LABELS = {
    drawScreenTrackLabels,
    renderClusterLandmarks,
    isLabelShown,
    hitLabelAt,
  };
})();
