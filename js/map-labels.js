// Groove Explorer Cartographic Landmark & Screen-Space Collision-Free Track Label Engine
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const ANGLES = Array.from({ length: 32 }, (_, i) => {
    const step = i === 0 ? 0 : (i % 2 === 1 ? Math.ceil(i / 2) : -i / 2);
    return -Math.PI / 2 + (step * Math.PI) / 16;
  });
  const RINGS = [10, 16, 22, 30, 40, 52, 66, 84, 106, 132, 162, 198];
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
      layout,
      eraLeftGutter,
    } = opts;

    const zoomed = zoom.k >= 1.55;
    const mobileEraScroll = layout === "era" && vw <= 800;
    const showBrowseLabels = zoomed || mobileEraScroll;
    const uiBoxes = getUiObstacleBoxes(mapWrap);
    if (mobileEraScroll) {
      uiBoxes.push([0, 0, (eraLeftGutter || 94) + 2, vh]);
      uiBoxes.push([vw - 170, 0, vw, 48]); // "Ambient <- -> High energy" top-right header legend
    }
    const minLabelX = mobileEraScroll ? (eraLeftGutter || 94) + 3 : 4;
    const maxLabelX = mobileEraScroll ? vw - 10 : vw - 4;
    const isCompact = vw <= 600;
    const baseFs = mobileEraScroll && !zoomed ? 10.5 : (isCompact ? 11 : 11.5);

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
      if ((showBrowseLabels && sx >= 6 && sx <= vw - 6 && sy >= 8 && sy <= vh - 8) || isPlay || isSel) {
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

    const allowLeaderRings = zoom.k >= 2.2 || (!mobileEraScroll && zoomed && visible.length <= 160);
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
      let fallbackEmphBox = null;
      for (let ci = 0; ci < cands.length; ci++) {
        let b = cands[ci].box;
        if (b[0] < minLabelX) {
          const sh = minLabelX - b[0];
          b = [b[0] + sh, b[1], b[2] + sh, b[3]];
        } else if (b[2] > maxLabelX) {
          const sh = b[2] - maxLabelX;
          b = [b[0] - sh, b[1], b[2] - sh, b[3]];
        }
        if (b[0] < minLabelX - 1 || b[2] > maxLabelX + 1 || b[1] < 6 || b[3] > vh - 6) continue;

        const padB = [b[0] - 1.4, b[1] - 0.9, b[2] + 1.4, b[3] + 0.9];
        const hitUi = uiBoxes.some((ub) => boxOverlap(padB, ub));
        if (hitUi && !item.emph) continue;

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
        if (hitDot || hitUi) {
          if (item.emph && !fallbackEmphBox && !cands[ci].leader) fallbackEmphBox = b;
          continue;
        }

        chosenBox = b;
        break;
      }
      if (!chosenBox && fallbackEmphBox) chosenBox = fallbackEmphBox;

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
    const fs = zoomed ? (isWide ? 18.5 : 15.5) : (isWide ? 16.5 : 11.2);
    const fw = isWide || zoomed ? 700 : 600;
    const fontSpec = `${fw} ${fs}px Syne, Inter, sans-serif`;

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
    const dotPad = zoomed ? 5.8 : (isWide ? 6.2 : 5.0);
    const dotLen = allDots.length;
    const dotX = new Float64Array(dotLen);
    const dotY = new Float64Array(dotLen);
    const dotBoxX0 = new Float64Array(dotLen);
    const dotBoxY0 = new Float64Array(dotLen);
    const dotBoxX1 = new Float64Array(dotLen);
    const dotBoxY1 = new Float64Array(dotLen);
    for (let di = 0; di < dotLen; di++) {
      const dx = allDots[di][0], dy = allDots[di][1];
      dotX[di] = dx;
      dotY[di] = dy;
      dotBoxX0[di] = dx - dotPad;
      dotBoxY0[di] = dy - dotPad;
      dotBoxX1[di] = dx + dotPad;
      dotBoxY1[di] = dy + dotPad;
    }
    const placedFam = [];

    const MOBILE_SHORT = {
      "Ambient & meditative": "Ambient",
      "Ambient & soundscapes": "Ambient",
      "Meditative beats": "Meditative",
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
      if (!rg.members || rg.members.length === 0) return;
      let rMinX = Infinity, rMaxX = -Infinity, rMinY = Infinity, rMaxY = -Infinity, rCnt = 0;
      (rg.members || []).forEach((id) => {
        const m = nodeById.get(id);
        if (!m || (isHidden && isHidden(m.t))) return;
        const sx = Number.isFinite(m.px) ? m.px : m.x * zoom.k + zoom.x;
        const sy = Number.isFinite(m.py) ? m.py : m.y * zoom.k + zoom.y;
        if (sx < rMinX) rMinX = sx;
        if (sx > rMaxX) rMaxX = sx;
        if (sy < rMinY) rMinY = sy;
        if (sy > rMaxY) rMaxY = sy;
        rCnt++;
      });
      if (rCnt > 0) {
        const padX = rg.is_spoken_group ? (isWide ? 24 : 14) : (isWide ? 32 : 12);
        const padTop = rg.is_spoken_group ? (isWide ? 18 : 12) : (isWide ? 28 : 14);
        const padBot = rg.is_spoken_group ? (isWide ? 18 : 12) : (isWide ? 30 : 18);
        const gx0 = rMinX - padX;
        const gx1 = rMaxX + padX;
        if (gx1 > -24 && gx0 < vw + 24) {
          reserveGuardBoxes.push([
            gx0 - 2,
            rMinY - padTop - 26,
            gx1 + 4,
            rMaxY + padBot + 4,
          ]);
          const rShort = rg.short_label || MOBILE_SHORT[rg.label];
          let rLbl = (!isWide && !zoomed && rShort) ? rShort : rg.label;
          let rHw = Math.ceil(textWidth(fontSpec, rLbl) * 0.57 + 8);
          if (rg.is_ai_group && rShort && (vw - gx0 < 2 * rHw + 12)) {
            rLbl = rShort;
            rHw = Math.ceil(textWidth(fontSpec, rLbl) * 0.57 + 8);
          }
          const rHh = Math.ceil(fs * 0.65 + 3.5);
          const rHeaderOffset = rg.is_spoken_group ? (isWide ? 22 : 16) : (isWide ? 34 : 18);
          const rRawCenterX = (rMinX + rMaxX) * 0.5;
          const rBoxCenterX = (vw - gx0 >= 2 * rHw + 12)
            ? Math.max(gx0 + rHw + 2, Math.min(gx1 - rHw - 2, Math.min(vw - rHw - 10, rRawCenterX)))
            : rRawCenterX;
          const rHeaderY = zoomed ? (rMinY - rHh - rHeaderOffset) : Math.max(rHh + 10, rMinY - rHh - rHeaderOffset);
          if (rHeaderY - rHh >= 6 && rBoxCenterX - rHw >= 4 && rBoxCenterX + rHw <= vw - 4) {
            reserveGuardBoxes.push([
              rBoxCenterX - rHw - 6,
              rHeaderY - rHh - 4,
              rBoxCenterX + rHw + 6,
              rHeaderY + rHh + 4,
            ]);
          }
        }
      }
    });

    // Place most-constrained interior clusters first so landlocked genres (e.g. UK bass, Downtempo)
    // secure clean zero-collision channel slots before outer peninsulas claim shared borders.
    const orderedGroups = styleGroups.slice().sort((ga, gb) => {
      const da = Boolean(ga.is_ai_group || ga.is_spoken_group) ? 0 : 1;
      const db = Boolean(gb.is_ai_group || gb.is_spoken_group) ? 0 : 1;
      if (da !== db) return da - db;
      const crowdOf = (g) => {
        const memSet = new Set(g.members || []);
        let sxSum = 0, sySum = 0, cnt = 0;
        memSet.forEach((id) => {
          const m = nodeById.get(id);
          if (!m || (isHidden && isHidden(m.t))) return;
          sxSum += Number.isFinite(m.px) ? m.px : m.x * zoom.k + zoom.x;
          sySum += Number.isFinite(m.py) ? m.py : m.y * zoom.k + zoom.y;
          cnt++;
        });
        if (!cnt) return 0;
        const cx = sxSum / cnt, cy = sySum / cnt;
        let foreignNear = 0;
        for (let di = 0; di < dotLen; di++) {
          if (!memSet.has(allDots[di][2]) && Math.hypot(dotX[di] - cx, dotY[di] - cy) <= 155) {
            foreignNear++;
          }
        }
        return foreignNear;
      };
      return crowdOf(gb) - crowdOf(ga);
    });

    orderedGroups.forEach((g) => {
      const members = (g.members || [])
        .map((id) => nodeById.get(id))
        .filter((m) => m && !(isHidden && isHidden(m.t)));
      if (!members.length) return;
      const anyMatch = members.some((m) => isMatch(m.t));

      const isDedicatedIsland = Boolean(g.is_ai_group || g.is_spoken_group);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let fullMinX = Infinity, fullMaxX = -Infinity, fullMinY = Infinity, fullMaxY = -Infinity;
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
        if (sx < fullMinX) fullMinX = sx;
        if (sx > fullMaxX) fullMaxX = sx;
        if (sy < fullMinY) fullMinY = sy;
        if (sy > fullMaxY) fullMaxY = sy;
        if (!isDedicatedIsland && zoomed && (sx < -40 || sx > vw + 40 || sy < -40 || sy > vh + 40)) continue;
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
      let label = (!isWide && !zoomed && shortLbl) ? shortLbl : g.label;
      let tw = textWidth(fontSpec, label);
      let hw = Math.ceil(tw * 0.50 + 2.5);
      const hh = Math.ceil(fs * 0.56 + 2);

      const clampX = (x) => Math.max(hw + 6, Math.min(vw - hw - 6, x));
      const clampY = (y) => Math.max(hh + 10, Math.min(vh - hh - 10, y));
      const maxRad = zoomed ? 220 : (isWide ? 210 : 125);

      const anchorTopX = zoomed ? topX : mx;
      const anchorMinY = minY;
      const anchorMaxY = maxY;

      const cands = [
        [topX, minY - hh - 8],
        [mx, minY - hh - 8],
        [mx - 18, minY - hh - 10],
        [mx + 18, minY - hh - 10],
        [mx - 36, minY - hh - 12],
        [mx + 36, minY - hh - 12],
        [mx - 54, minY - hh - 14],
        [mx + 54, minY - hh - 14],
        [mx, minY - hh - 18],
        [mx - 24, minY - hh - 20],
        [mx + 24, minY - hh - 20],
        [mx, minY - hh - 30],
        [cMaxX + hw * 0.45, minY - hh - 10],
        [cMinX - hw * 0.45, minY - hh - 10],
        [maxX + hw * 0.55, minY - hh - 8],
        [minX - hw * 0.55, minY - hh - 8],
        [mx, maxY + hh + 8],
        [mx - 18, maxY + hh + 10],
        [mx + 18, maxY + hh + 10],
        [mx - 36, maxY + hh + 12],
        [mx + 36, maxY + hh + 12],
        [mx, maxY + hh + 20],
        [mx, maxY + hh + 32],
        [cMaxX + hw * 0.45, maxY + hh + 10],
        [cMinX - hw * 0.45, maxY + hh + 10],
        [minX - hw - 7, my],
        [minX - hw - 7, my - 14],
        [minX - hw - 7, my + 14],
        [maxX + hw + 7, my],
        [maxX + hw + 7, my - 14],
        [maxX + hw + 7, my + 14],
        [minX - hw - 6, minY - hh],
        [maxX + hw + 6, minY - hh],
        [minX - hw - 6, maxY + hh],
        [maxX + hw + 6, maxY + hh],
        [mx, cMinY - hh - 10],
        [mx, cMaxY + hh + 10],
        [cMinX - hw - 8, my],
        [cMaxX + hw + 8, my],
      ];
      for (let ui = 0; ui < uiBoxes.length; ui++) {
        const ub = uiBoxes[ui];
        if (my >= ub[1] - 12 && mx >= ub[0] - 32 && mx <= ub[2] + 32) {
          const aboveCardY = ub[1] - hh - 8;
          if (aboveCardY >= minY - 64 && aboveCardY <= maxY + 32) {
            cands.push([mx, aboveCardY]);
            cands.push([cMinX, aboveCardY]);
            cands.push([cMaxX, aboveCardY]);
          }
        }
      }
      if (!zoomed) {
        const stepX = isWide ? 6 : 6;
        const stepY = isWide ? 5 : 5;
        const gxLo = Math.max(hw + 6, minX - hw - 18);
        const gxHi = Math.min(vw - hw - 6, maxX + hw + 18);
        const gyLo = Math.max(hh + 10, minY - hh - (isWide ? 52 : 34));
        const gyHi = Math.min(vh - hh - 10, maxY + hh + (isWide ? 52 : 34));
        for (let gy = gyLo; gy <= gyHi; gy += stepY) {
          for (let gx = gxLo; gx <= gxHi; gx += stepX) {
            cands.push([gx, gy]);
          }
        }
      }
      RINGS.forEach((rad) => {
        if (rad > maxRad) return;
        ANGLES.forEach((ang) => {
          cands.push([mx + Math.cos(ang) * rad * 1.18, my + Math.sin(ang) * rad]);
          cands.push([anchorTopX + Math.cos(ang) * rad * 1.12, anchorMinY + Math.sin(ang) * rad]);
          cands.push([mx + Math.cos(ang) * rad * 1.12, anchorMaxY + Math.sin(ang) * rad]);
          cands.push([minX + Math.cos(ang) * rad, my + Math.sin(ang) * rad]);
          cands.push([maxX + Math.cos(ang) * rad, my + Math.sin(ang) * rad]);
        });
      });

      let best = null;
      let bestScore = Infinity;
      let bestDotHits = Infinity;

      if (g.is_ai_group || g.is_spoken_group) {
        const islPadX = g.is_spoken_group ? (isWide ? 24 : 14) : (isWide ? 32 : 12);
        const islPadTop = g.is_spoken_group ? (isWide ? 18 : 12) : (isWide ? 28 : 14);
        const islPadBot = g.is_spoken_group ? (isWide ? 18 : 12) : (isWide ? 30 : 18);
        const islBx0 = fullMinX - islPadX;
        const islBx1 = fullMaxX + islPadX;
        const islBy0 = fullMinY - islPadTop;
        const islBy1 = fullMaxY + islPadBot;
        if (islBx1 < -20 || islBx0 > vw + 20 || islBy1 < -20 || islBy0 > vh + 20) return;

        // Render dedicated territory boundary in true world-projected coordinates so partial right-edge peeks clip naturally
        if (g.is_spoken_group && islBx1 - islBx0 >= 20 && islBy1 - islBy0 >= 20) {
          const sBox = document.createElementNS(NS, "rect");
          sBox.setAttribute("class", "map-ai-territory-box map-spoken-island-box");
          sBox.setAttribute("x", islBx0.toFixed(1));
          sBox.setAttribute("y", islBy0.toFixed(1));
          sBox.setAttribute("width", (islBx1 - islBx0).toFixed(1));
          sBox.setAttribute("height", (islBy1 - islBy0).toFixed(1));
          sBox.setAttribute("rx", "14");
          svgGroup.insertBefore(sBox, svgGroup.firstChild);
        } else if (g.is_ai_group && islBx1 - islBx0 > 24 && islBy1 - islBy0 > 24) {
          const tBox = document.createElementNS(NS, "rect");
          tBox.setAttribute("class", "map-ai-territory-box");
          tBox.setAttribute("x", islBx0.toFixed(1));
          tBox.setAttribute("y", islBy0.toFixed(1));
          tBox.setAttribute("width", (islBx1 - islBx0).toFixed(1));
          tBox.setAttribute("height", (islBy1 - islBy0).toFixed(1));
          tBox.setAttribute("rx", "18");
          svgGroup.insertBefore(tBox, svgGroup.firstChild);
        }

        if (g.is_ai_group && shortLbl && (vw - islBx0 < 2 * hw + 12)) {
          label = shortLbl;
          tw = textWidth(fontSpec, label);
          hw = Math.ceil(tw * 0.50 + 2.5);
        }
        const headerOffset = g.is_spoken_group ? (isWide ? 22 : 16) : (isWide ? 34 : 18);
        const rawCenterX = (fullMinX + fullMaxX) * 0.5;
        const boxCenterX = (vw - islBx0 >= 2 * hw + 12)
          ? Math.max(islBx0 + hw + 2, Math.min(islBx1 - hw - 2, Math.min(vw - hw - 10, rawCenterX)))
          : rawCenterX;
        const headerY = zoomed ? (fullMinY - hh - headerOffset) : Math.max(hh + 10, fullMinY - hh - headerOffset);
        if (headerY - hh >= 6 && boxCenterX - hw >= 4 && boxCenterX + hw <= vw - 4) {
          const hBox = [boxCenterX - hw, headerY - hh, boxCenterX + hw, headerY + hh];
          if (
            !uiBoxes.some((ub) => boxOverlap(hBox, ub)) &&
            !placedFam.some((pb) => boxOverlap(hBox, pb)) &&
            !lastTrackBoxes.some((tb) => boxOverlap(hBox, tb))
          ) {
            best = [boxCenterX, headerY];
            bestDotHits = 0;
          }
        }
      }

      if (!best && !isDedicatedIsland) {
        const isOwnDot = new Uint8Array(dotLen);
        for (let di = 0; di < dotLen; di++) {
          if (ownSet.has(allDots[di][2])) isOwnDot[di] = 1;
        }

        const seenCand = new Set();
        const distWeight = zoomed ? 0.55 : (isWide ? 0.85 : 1.15);
        const outerMaxCore = isWide ? 240 : 108;
        const outerMaxBox = isWide ? 160 : 56;

        for (let ci = 0; ci < cands.length; ci++) {
          const cx = zoomed ? cands[ci][0] : clampX(cands[ci][0]);
          const cy = zoomed ? cands[ci][1] : clampY(cands[ci][1]);
          if (cx - hw < 5 || cx + hw > vw - 5 || cy - hh < 8 || cy + hh > vh - 8) continue;
          const cKey = ((cx * 4) | 0) * 16384 + ((cy * 4) | 0);
          if (seenCand.has(cKey)) continue;
          seenCand.add(cKey);

          const distCore = Math.hypot(cx - mx, cy - my);
          const dxCoreBox = cx < cMinX ? cMinX - cx : (cx > cMaxX ? cx - cMaxX : 0);
          const dyCoreBox = cy < cMinY ? cMinY - cy : (cy > cMaxY ? cy - cMaxY : 0);
          const distCoreBox = Math.hypot(dxCoreBox, dyCoreBox);
          if (!zoomed && (distCore > outerMaxCore || distCoreBox > outerMaxBox)) continue;

          const inCoreInterior = (!zoomed && visCount >= 6 && dxCoreBox === 0 && dyCoreBox === 0) ? 420 : 0;
          const baseLowerBound = distCore * distWeight + inCoreInterior + (cy < minY ? -26 : 0);
          if (baseLowerBound >= bestScore) continue;

          const box = [cx - hw, cy - hh, cx + hw, cy + hh];
          const p0 = cx - hw - 2, p1 = cy - hh - 2, p2 = cx + hw + 2, p3 = cy + hh + 2;

          if (uiBoxes.some((ub) => boxOverlap(box, ub))) continue;
          if (!isDedicatedIsland && reserveGuardBoxes.some((rb) => boxOverlap(box, rb))) continue;
          if (placedFam.some((pb) => boxOverlap(box, pb))) continue;
          if (lastTrackBoxes.some((tb) => boxOverlap(box, tb))) continue;

          let dotCost = 0;
          let dotHits = 0;
          let ownD2 = Infinity;
          let otherD2 = Infinity;
          let ownCenterD2 = Infinity;
          let otherCenterD2 = Infinity;
          let pruned = false;
          const b0 = box[0], b1 = box[1], b2 = box[2], b3 = box[3];
          for (let di = 0; di < dotLen; di++) {
            const px = dotX[di], py = dotY[di];
            const ddx = px < b0 ? b0 - px : (px > b2 ? px - b2 : 0);
            const ddy = py < b1 ? b1 - py : (py > b3 ? py - b3 : 0);
            const d2 = ddx * ddx + ddy * ddy;
            const cdx = px - cx, cdy = py - cy;
            const cd2 = cdx * cdx + cdy * cdy;
            const isOwn = isOwnDot[di] === 1;
            if (isOwn) {
              if (d2 < ownD2) ownD2 = d2;
              if (cd2 < ownCenterD2) ownCenterD2 = cd2;
            } else {
              if (d2 < otherD2) otherD2 = d2;
              if (cd2 < otherCenterD2) otherCenterD2 = cd2;
            }
            if (p0 < dotBoxX1[di] && p2 > dotBoxX0[di] && p1 < dotBoxY1[di] && p3 > dotBoxY0[di]) {
              if (zoomed) { pruned = true; break; }
              dotHits++;
              dotCost += isOwn ? 16000 : 32000;
              if (baseLowerBound + dotCost >= bestScore) { pruned = true; break; }
            }
          }
          if (pruned) continue;
          const ownD = ownD2 < Infinity ? Math.sqrt(ownD2) : Infinity;
          const otherD = otherD2 < Infinity ? Math.sqrt(otherD2) : Infinity;
          const ownCenterD = ownCenterD2 < Infinity ? Math.sqrt(ownCenterD2) : Infinity;
          const otherCenterD = otherCenterD2 < Infinity ? Math.sqrt(otherCenterD2) : Infinity;
          if (!zoomed && !isDedicatedIsland) {
            if (dotHits > 0) continue;
            if (ownCenterD > otherCenterD - (isWide ? 3.0 : 0.8)) continue;
            const stronglyCentered = ownCenterD <= otherCenterD * (isWide ? 0.72 : 0.82);
            if (!stronglyCentered && ownD > otherD + (isWide ? 10.5 : 9.5)) continue;
            if (ownD > (isWide ? 48 : 38)) continue;
          }

          const maxDistCore = dotHits === 0 ? outerMaxCore : (isWide ? 185 : 115);
          const maxDistBox = dotHits === 0 ? outerMaxBox : (isWide ? 128 : 80);
          if (!zoomed && (distCore > maxDistCore || distCoreBox > maxDistBox)) continue;
          let score =
            ownD * 1.85 +
            ownCenterD * 0.45 +
            baseLowerBound +
            dotCost +
            (otherD < ownD ? (ownD - otherD) * 24 + 420 : 0);
          if (score < bestScore) {
            bestScore = score;
            best = [cx, cy];
            bestDotHits = dotHits;
          }
        }

        // Interior cluster fallback: guarantee landlocked islands (e.g. Hypnotic/dub, Meditative, Downtempo)
        // never drop their header while strictly forbidding UI/label overlaps and foreign-cluster dot hits.
        if (!best && !zoomed) {
          for (let ci = 0; ci < cands.length; ci++) {
            const cx = clampX(cands[ci][0]);
            const cy = clampY(cands[ci][1]);
            if (cx - hw < 5 || cx + hw > vw - 5 || cy - hh < 8 || cy + hh > vh - 8) continue;
            const distCore = Math.hypot(cx - mx, cy - my);
            if (distCore > (isWide ? 145 : 98)) continue;
            const box = [cx - hw, cy - hh, cx + hw, cy + hh];
            const fbPad = isWide ? 3.2 : 2.2;
            const p0 = cx - hw - fbPad, p1 = cy - hh - fbPad, p2 = cx + hw + fbPad, p3 = cy + hh + fbPad;
            if (uiBoxes.some((ub) => boxOverlap(box, ub))) continue;
            if (reserveGuardBoxes.some((rb) => boxOverlap(box, rb))) continue;
            if (placedFam.some((pb) => boxOverlap(box, pb))) continue;
            if (lastTrackBoxes.some((tb) => boxOverlap(box, tb))) continue;

            let ownHits = 0, foreignHits = 0;
            let ownD2 = Infinity, ownCenterD2 = Infinity, otherCenterD2 = Infinity;
            for (let di = 0; di < dotLen; di++) {
              const px = dotX[di], py = dotY[di];
              const ddx = px < box[0] ? box[0] - px : (px > box[2] ? px - box[2] : 0);
              const ddy = py < box[1] ? box[1] - py : (py > box[3] ? py - box[3] : 0);
              const d2 = ddx * ddx + ddy * ddy;
              const cd2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
              const isOwn = isOwnDot[di] === 1;
              if (isOwn) {
                if (d2 < ownD2) ownD2 = d2;
                if (cd2 < ownCenterD2) ownCenterD2 = cd2;
              } else if (cd2 < otherCenterD2) {
                otherCenterD2 = cd2;
              }
              if (p0 < dotBoxX1[di] && p2 > dotBoxX0[di] && p1 < dotBoxY1[di] && p3 > dotBoxY0[di]) {
                if (isOwn) ownHits++;
                else { foreignHits++; break; }
              }
            }
            if (foreignHits > 0 || ownHits > 2) continue;
            const ownD = ownD2 < Infinity ? Math.sqrt(ownD2) : Infinity;
            const ownCenterD = ownCenterD2 < Infinity ? Math.sqrt(ownCenterD2) : Infinity;
            const otherCenterD = otherCenterD2 < Infinity ? Math.sqrt(otherCenterD2) : Infinity;
            if (ownCenterD > otherCenterD + (isWide ? 6.0 : 2.5) || ownD > (isWide ? 44 : 38)) continue;
            const fbScore = ownHits * 8000 + distCore * 1.4 + ownD * 2.0 + ownCenterD * 0.5;
            if (fbScore < bestScore) {
              bestScore = fbScore;
              best = [cx, cy];
              bestDotHits = ownHits;
            }
          }
        }
      }

      if (best && (isWide || zoomed || isDedicatedIsland || bestDotHits <= 2)) {
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
        txt.style.fontSize = `${fs}px`;
        txt.setAttribute("y", (fs * 0.34).toFixed(1));
        txt.textContent = label;

        grp.append(hit, txt);
        grp.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (onToggleCluster) onToggleCluster(g.id);
        });
        svgGroup.appendChild(grp);
      }

      // Internal Discogs genre sub-labels inside the Generative AI territory box
      if (g.is_ai_group) {
        const padX = isWide ? 32 : 12;
        const padTop = isWide ? 28 : 14;
        const padBot = isWide ? 30 : 18;
        const bx0 = fullMinX - padX;
        const by0 = fullMinY - padTop;
        const bx1 = fullMaxX + padX;
        const by1 = fullMaxY + padBot;

        if ((isWide || zoom.k >= 1.35) && Array.isArray(g.sub_groups)) {
          const subFs = zoomed ? 12 : 11;
          const subFont = `600 ${subFs}px Syne, Inter, sans-serif`;
          const aiMemberIds = new Set(g.members || []);
          const orderedSubs = g.sub_groups.slice().sort((sa, sb) => {
            const subCrowd = (sg) => {
              const sSet = new Set(sg.members || []);
              let sxS = 0, syS = 0, cnt = 0;
              sSet.forEach((id) => {
                const m = nodeById.get(id);
                if (!m || (isHidden && isHidden(m.t))) return;
                sxS += Number.isFinite(m.px) ? m.px : m.x * zoom.k + zoom.x;
                syS += Number.isFinite(m.py) ? m.py : m.y * zoom.k + zoom.y;
                cnt++;
              });
              if (!cnt) return 0;
              const cx = sxS / cnt, cy = syS / cnt;
              let nearOther = 0;
              for (let di = 0; di < dotLen; di++) {
                const did = allDots[di][2];
                if (aiMemberIds.has(did) && !sSet.has(did) && Math.hypot(dotX[di] - cx, dotY[di] - cy) <= 115) {
                  nearOther++;
                }
              }
              return nearOther;
            };
            return subCrowd(sb) - subCrowd(sa);
          });

          orderedSubs.forEach((sg) => {
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
            const shw = Math.ceil(stw * 0.56 + 5);
            const shh = Math.ceil(subFs * 0.64 + 2.5);
            if (smx - shw < 6 || smx + shw > vw - 6) return;

            const clampLoX = bx0 + shw + 4;
            const clampHiX = bx1 - shw - 4;
            const clampLoY = Math.max(shh + 8, by0 + shh + 5);
            const clampHiY = Math.min(vh - shh - 8, by1 - shh - 5);

            // Coastal & channel candidate slots around each AI lobe (above top lobes, beside middle lobes, below bottom lobes)
            const sCands = [
              [smx, sMinY - shh - 7],
              [smx - 12, sMinY - shh - 8],
              [smx + 12, sMinY - shh - 8],
              [smx, sMaxY + shh + 7],
              [smx - 12, sMaxY + shh + 8],
              [smx + 12, sMaxY + shh + 8],
              [sMinX - shw - 7, smy],
              [sMinX - shw - 7, smy - 12],
              [sMinX - shw - 7, smy + 12],
              [sMaxX + shw + 7, smy],
              [sMaxX + shw + 7, smy - 12],
              [sMaxX + shw + 7, smy + 12],
              [sMinX, sMinY - shh - 7],
              [sMaxX, sMinY - shh - 7],
              [sMinX, sMaxY + shh + 7],
              [sMaxX, sMaxY + shh + 7],
            ];
            [12, 20, 30, 42, 56].forEach((rad) => {
              ANGLES.forEach((ang) => {
                sCands.push([smx + Math.cos(ang) * rad * 1.12, smy + Math.sin(ang) * rad]);
                sCands.push([smx + Math.cos(ang) * rad * 1.10, sMinY + Math.sin(ang) * rad]);
                sCands.push([smx + Math.cos(ang) * rad * 1.10, sMaxY + Math.sin(ang) * rad]);
                sCands.push([sMinX + Math.cos(ang) * rad, smy + Math.sin(ang) * rad]);
                sCands.push([sMaxX + Math.cos(ang) * rad, smy + Math.sin(ang) * rad]);
              });
            });
            if (!zoomed && clampLoX <= clampHiX && clampLoY <= clampHiY) {
              const gxLo = Math.max(clampLoX, sMinX - shw - 28);
              const gxHi = Math.min(clampHiX, sMaxX + shw + 28);
              const gyLo = Math.max(clampLoY, sMinY - shh - 26);
              const gyHi = Math.min(clampHiY, sMaxY + shh + 26);
              for (let gy = gyLo; gy <= gyHi; gy += 5) {
                for (let gx = gxLo; gx <= gxHi; gx += 6) {
                  sCands.push([gx, gy]);
                }
              }
            }

            let sBest = null;
            let sBestScore = Infinity;
            const sIsOwn = new Uint8Array(dotLen);
            const sIsAiForeign = new Uint8Array(dotLen);
            for (let di = 0; di < dotLen; di++) {
              const did = allDots[di][2];
              if (sOwn.has(did)) sIsOwn[di] = 1;
              else if (aiMemberIds.has(did)) sIsAiForeign[di] = 1;
            }
            const seenSCand = new Set();
            for (let sci = 0; sci < sCands.length; sci++) {
              const scx = clampLoX <= clampHiX ? Math.max(clampLoX, Math.min(clampHiX, sCands[sci][0])) : sCands[sci][0];
              const scy = clampLoY <= clampHiY ? Math.max(clampLoY, Math.min(clampHiY, sCands[sci][1])) : Math.max(shh + 8, Math.min(vh - shh - 8, sCands[sci][1]));
              if (scx - shw < 6 || scx + shw > vw - 6) continue;
              const sKey = ((scx * 4) | 0) * 16384 + ((scy * 4) | 0);
              if (seenSCand.has(sKey)) continue;
              seenSCand.add(sKey);

              const sp0 = scx - shw - 2.5, sp1 = scy - shh - 2.5, sp2 = scx + shw + 2.5, sp3 = scy + shh + 2.5;
              const sbox = [sp0, sp1, sp2, sp3];
              if (uiBoxes.some((ub) => boxOverlap(sbox, ub))) continue;
              if (placedFam.some((pb) => boxOverlap(sbox, pb))) continue;
              if (lastTrackBoxes.some((tb) => boxOverlap(sbox, tb))) continue;

              const dCenter = Math.hypot(scx - smx, scy - smy);
              if (dCenter > (zoomed ? 150 : 125)) continue;

              let dc = 0;
              let ownD2 = Infinity;
              let forD2 = Infinity;
              for (let di = 0; di < dotLen; di++) {
                const px = dotX[di], py = dotY[di];
                const ddx = px < sp0 ? sp0 - px : (px > sp2 ? px - sp2 : 0);
                const ddy = py < sp1 ? sp1 - py : (py > sp3 ? py - sp3 : 0);
                const d2 = ddx * ddx + ddy * ddy;
                if (sIsOwn[di]) {
                  if (d2 < ownD2) ownD2 = d2;
                } else if (sIsAiForeign[di]) {
                  if (d2 < forD2) forD2 = d2;
                }
                if (sp0 < dotBoxX1[di] && sp2 > dotBoxX0[di] && sp1 < dotBoxY1[di] && sp3 > dotBoxY0[di]) {
                  dc += sIsOwn[di] ? 3400 : 7600;
                }
              }
              const ownD = ownD2 < Infinity ? Math.sqrt(ownD2) : 0;
              const forD = forD2 < Infinity ? Math.sqrt(forD2) : Infinity;
              if (ownD > 42) continue;
              const foreignPen = forD < ownD ? (ownD - forD) * 26 + 260 : 0;
              const sc = ownD * 2.1 + dCenter * 0.55 + dc + foreignPen;
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
