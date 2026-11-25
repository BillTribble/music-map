// Groove Explorer Cartographic Landmark & Screen-Space Collision-Free Track Label Engine
// World-anchored smooth genre headers + screen-density-aware progressive track label LOD with ~160ms alpha fades.
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const ANGLES = Array.from({ length: 32 }, (_, i) => {
    const step = i === 0 ? 0 : (i % 2 === 1 ? Math.ceil(i / 2) : -i / 2);
    return -Math.PI / 2 + (step * Math.PI) / 16;
  });
  const RINGS = [10, 16, 22, 30, 40, 52, 66, 84, 106, 132, 162, 198];
  const CLOSEUP_LEADER_RADII = [16, 26, 38];

  const TRACK_FADE_TAU_MS = 160;
  const TRACK_OFFSET_TAU_MS = 90;
  const CLUSTER_FADE_TAU_MS = 180;

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

  let measureCtx = null;
  let lastTrackBoxes = [];
  let lastPlacedEntries = [];
  let shownIds = new Set();

  // Persistent per-track animation state: id -> { alpha, targetAlpha, offX, offY, targetOffX, targetOffY, slotKey, w, hh, lbl, font, emph }
  const trackLabelState = new Map();
  let prevChosenAmbient = new Set();
  let lastTrackLayout = null;
  let lastTrackTs = 0;
  let trackAnimating = false;

  // Persistent world-anchor plan & per-cluster opacity state
  let worldClusterPlan = null; // { sig, groups: [...], subGroups: [...], territories: [...] }
  const clusterAlphaState = new Map(); // key -> { alpha, targetAlpha }
  let lastClusterPlanSig = "";
  let lastClusterTs = 0;
  let clusterAnimating = false;
  let lastGenreDebug = [];
  let lastTrackDebug = [];
  let lastLodDebug = { kEnter: 0, kStay: 0, kMid: 0, kClose: 0, maxAmbient: 0 };

  // Persistent SVG DOM cache so 60fps zoom/pan never destroys/recreates <g> nodes
  const svgCache = {
    root: null,
    aiRect: null,
    spokenRect: null,
    entries: new Map(), // key -> { grp, hit, txt, id }
    onToggleRef: null,
  };

  // Shared rAF settle scheduler
  let settleRaf = 0;
  let latestRequestFrameCb = null;

  function nowMs() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  function prefersReducedMotion() {
    return Boolean(
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function stepDt(prevTs, now) {
    if (!prevTs) return 16.67;
    const raw = now - prevTs;
    if (raw < 0) return 0;
    if (raw > 80) return 16.67; // first frame after an idle pause starts smoothly, then rAF settles
    return raw;
  }

  function clamp01(x) {
    return x <= 0 ? 0 : x >= 1 ? 1 : x;
  }

  function smoothstep(e0, e1, x) {
    if (e1 <= e0) return x >= e1 ? 1 : 0;
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  }

  function hash01(str) {
    let h = 2166136261;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 10000) / 10000;
  }

  function scheduleSettleIfNeeded(onRequestFrame) {
    if (typeof onRequestFrame === "function") {
      latestRequestFrameCb = onRequestFrame;
    }
    const want = (trackAnimating || clusterAnimating) && !prefersReducedMotion();
    if (!want) return;
    if (settleRaf || typeof requestAnimationFrame !== "function" || !latestRequestFrameCb) return;
    settleRaf = requestAnimationFrame(() => {
      settleRaf = 0;
      if (latestRequestFrameCb) latestRequestFrameCb();
    });
  }

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

  function signedBoxGap(a, b) {
    const gx = Math.max(b[0] - a[2], a[0] - b[2]);
    const gy = Math.max(b[1] - a[3], a[1] - b[3]);
    if (gx >= 0 || gy >= 0) {
      return Math.hypot(Math.max(0, gx), Math.max(0, gy));
    }
    return Math.max(gx, gy); // negative overlap depth
  }

  function cleanMapLabel(t) {
    let s = String((t && (t.shortTitle || t.title)) || "").trim();
    s = s.replace(/\s*[,(\[]\s*(cute|rough|ruff|wip|master|bounce|mix|edit|test).*$/i, "").trim();
    if (s.length <= 24) return s;
    const cut = s.slice(0, 23);
    const sp = cut.lastIndexOf(" ");
    return (sp >= 11 ? cut.slice(0, sp) : cut).replace(/[-–—,:;\s]+$/, "") + "…";
  }

  function getStaticHudBox(mapWrap) {
    let hudW = 248;
    if (typeof document !== "undefined" && mapWrap) {
      const mRect = mapWrap.getBoundingClientRect();
      const hudPill = document.querySelector("#map-floating-hud .map-hud-pill");
      if (hudPill) {
        const hRect = hudPill.getBoundingClientRect();
        if (hRect.width > 0) hudW = Math.max(248, hRect.right - mRect.left + 8);
      }
    }
    return [0, 0, hudW, 58];
  }

  function getUiObstacleBoxes(mapWrap) {
    const boxes = [getStaticHudBox(mapWrap)]; // top-left Vibe | Era | Star | Sketches HUD
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

  function computeUsableMapArea(vw, vh, uiBoxes) {
    const total = Math.max(1, vw * vh);
    let blocked = 0;
    for (let i = 0; i < uiBoxes.length; i++) {
      const ub = uiBoxes[i];
      const x0 = Math.max(0, ub[0]);
      const y0 = Math.max(0, ub[1]);
      const x1 = Math.min(vw, ub[2]);
      const y1 = Math.min(vh, ub[3]);
      if (x1 > x0 && y1 > y0) blocked += (x1 - x0) * (y1 - y0);
    }
    return Math.max(total * 0.34, total - blocked);
  }

  function nearestBoxPoint(sx, sy, b) {
    const nx = Math.max(b[0], Math.min(b[2], sx));
    const ny = Math.max(b[1], Math.min(b[3], sy));
    return [nx, ny];
  }

  // Compute deterministic world-space anchors at k=1 overview once per layout signature so
  // genre and AI sub-genre headers glide smoothly with their constellations without ever jumping slots.
  function ensureWorldClusterPlan(opts) {
    const { styleGroups, nodeById, nodes, vw, vh, isHidden, mapWrap } = opts;
    if (!styleGroups || !styleGroups.length || !nodeById || !nodes || !nodes.length) return null;

    let visNodeCount = 0;
    let firstHumanKey = "";
    let firstAiKey = "";
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (isHidden && isHidden(n.t)) continue;
      visNodeCount++;
      const wx = Number.isFinite(n.tx) ? n.tx : n.x;
      const wy = Number.isFinite(n.ty) ? n.ty : n.y;
      if (!firstHumanKey && !n.t.is_ai && !n.t.is_spoken_word) {
        firstHumanKey = `${Math.round(wx)},${Math.round(wy)}`;
      } else if (!firstAiKey && n.t.is_ai) {
        firstAiKey = `${Math.round(wx)},${Math.round(wy)}`;
      }
    }
    const sig = `${vw}x${vh}|g:${styleGroups.length}|v:${visNodeCount}|h:${firstHumanKey}|a:${firstAiKey}`;
    if (worldClusterPlan && worldClusterPlan.sig === sig) {
      return worldClusterPlan;
    }

    const isWide = vw > 840;
    const baseFs = isWide ? 16.2 : 11.5;
    const baseFw = isWide ? 700 : 620;
    const fontSpec = `${baseFw} ${baseFs}px Syne, Inter, sans-serif`;
    const staticUiBoxes = [getStaticHudBox(mapWrap)];

    const allDots = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (isHidden && isHidden(n.t)) continue;
      const wx = Number.isFinite(n.tx) ? n.tx : n.x;
      const wy = Number.isFinite(n.ty) ? n.ty : n.y;
      allDots.push([wx, wy, n.id]);
    }
    const dotPad = isWide ? 6.0 : 4.8;
    const dotLen = allDots.length;
    const dotX = new Float64Array(dotLen);
    const dotY = new Float64Array(dotLen);
    const dotBoxX0 = new Float64Array(dotLen);
    const dotBoxY0 = new Float64Array(dotLen);
    const dotBoxX1 = new Float64Array(dotLen);
    const dotBoxY1 = new Float64Array(dotLen);
    for (let di = 0; di < dotLen; di++) {
      const dx = allDots[di][0];
      const dy = allDots[di][1];
      dotX[di] = dx;
      dotY[di] = dy;
      dotBoxX0[di] = dx - dotPad;
      dotBoxY0[di] = dy - dotPad;
      dotBoxX1[di] = dx + dotPad;
      dotBoxY1[di] = dy + dotPad;
    }

    const reserveGuardBoxes = [];
    const territories = [];
    styleGroups.forEach((rg) => {
      if (!rg.is_ai_group && !rg.is_spoken_group) return;
      if (!rg.members || !rg.members.length) return;
      let rMinX = Infinity, rMaxX = -Infinity, rMinY = Infinity, rMaxY = -Infinity;
      const memberIds = [];
      (rg.members || []).forEach((id) => {
        const m = nodeById.get(id);
        if (!m || (isHidden && isHidden(m.t))) return;
        const wx = Number.isFinite(m.tx) ? m.tx : m.x;
        const wy = Number.isFinite(m.ty) ? m.ty : m.y;
        if (wx < rMinX) rMinX = wx;
        if (wx > rMaxX) rMaxX = wx;
        if (wy < rMinY) rMinY = wy;
        if (wy > rMaxY) rMaxY = wy;
        memberIds.push(id);
      });
      if (!memberIds.length) return;
      const padX = rg.is_spoken_group ? (isWide ? 24 : 14) : (isWide ? 32 : 12);
      const padTop = rg.is_spoken_group ? (isWide ? 18 : 12) : (isWide ? 28 : 14);
      const padBot = rg.is_spoken_group ? (isWide ? 18 : 12) : (isWide ? 30 : 18);
      territories.push({
        id: rg.id,
        isAi: Boolean(rg.is_ai_group),
        isSpoken: Boolean(rg.is_spoken_group),
        minWx: rMinX,
        maxWx: rMaxX,
        minWy: rMinY,
        maxWy: rMaxY,
        padX,
        padTop,
        padBot,
        memberIds,
      });
      const gx0 = rMinX - padX;
      const gx1 = rMaxX + padX;
      reserveGuardBoxes.push([gx0 - 2, rMinY - padTop - 26, gx1 + 4, rMaxY + padBot + 4]);
    });

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
          sxSum += Number.isFinite(m.tx) ? m.tx : m.x;
          sySum += Number.isFinite(m.ty) ? m.ty : m.y;
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
      const diff = crowdOf(gb) - crowdOf(ga);
      return diff !== 0 ? diff : String(ga.id).localeCompare(String(gb.id));
    });

    const placedFam = [];
    const plannedGroups = [];
    const plannedSubs = [];

    orderedGroups.forEach((g) => {
      const members = (g.members || [])
        .map((id) => nodeById.get(id))
        .filter((m) => m && !(isHidden && isHidden(m.t)));
      if (!members.length) return;

      const isDedicatedIsland = Boolean(g.is_ai_group || g.is_spoken_group);
      const hasSubGroups = Boolean(g.is_ai_group && Array.isArray(g.sub_groups) && g.sub_groups.length);
      const memberIds = [];
      const xs = [];
      const ys = [];
      const ownSet = new Set();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, topX = 0;

      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        const wx = Number.isFinite(m.tx) ? m.tx : m.x;
        const wy = Number.isFinite(m.ty) ? m.ty : m.y;
        memberIds.push(m.id);
        ownSet.add(m.id);
        xs.push(wx);
        ys.push(wy);
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) { minY = wy; topX = wx; }
        if (wy > maxY) maxY = wy;
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
      let label = (!isWide && shortLbl) ? shortLbl : g.label;
      let tw = textWidth(fontSpec, label);
      let hw = Math.ceil(tw * 0.50 + 3);
      const hh = Math.ceil(baseFs * 0.56 + 2);

      let best = null;
      let minK = 1.0;

      if (isDedicatedIsland) {
        const islPadX = g.is_spoken_group ? (isWide ? 24 : 14) : (isWide ? 32 : 12);
        const islBx0 = minX - islPadX;
        const islBx1 = maxX + islPadX;
        if (g.is_ai_group && shortLbl && (vw - islBx0 < 2 * hw + 12)) {
          label = shortLbl;
          tw = textWidth(fontSpec, label);
          hw = Math.ceil(tw * 0.50 + 3);
        }
        const headerOffset = g.is_spoken_group ? (isWide ? 22 : 16) : (isWide ? 34 : 18);
        const rawCenterX = (minX + maxX) * 0.5;
        const boxCenterX = (vw - islBx0 >= 2 * hw + 12)
          ? Math.max(islBx0 + hw + 2, Math.min(islBx1 - hw - 2, Math.min(vw - hw - 10, rawCenterX)))
          : Math.max(hw + 6, Math.min(vw - hw - 6, rawCenterX));
        const headerY = Math.max(hh + 10, minY - hh - headerOffset);
        best = [boxCenterX, headerY];
      } else {
        const clampX = (x) => Math.max(hw + 6, Math.min(vw - hw - 6, x));
        const clampY = (y) => Math.max(hh + 10, Math.min(vh - hh - 10, y));
        const maxRad = isWide ? 210 : 125;

        const cands = [
          [mx, minY - hh - 8],
          [topX, minY - hh - 8],
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
        const gxLo = Math.max(hw + 6, minX - hw - 18);
        const gxHi = Math.min(vw - hw - 6, maxX + hw + 18);
        const gyLo = Math.max(hh + 10, minY - hh - (isWide ? 52 : 34));
        const gyHi = Math.min(vh - hh - 10, maxY + hh + (isWide ? 52 : 34));
        for (let gy = gyLo; gy <= gyHi; gy += 5) {
          for (let gx = gxLo; gx <= gxHi; gx += 6) {
            cands.push([gx, gy]);
          }
        }
        RINGS.forEach((rad) => {
          if (rad > maxRad) return;
          ANGLES.forEach((ang) => {
            cands.push([mx + Math.cos(ang) * rad * 1.18, my + Math.sin(ang) * rad]);
            cands.push([mx + Math.cos(ang) * rad * 1.12, minY + Math.sin(ang) * rad]);
            cands.push([mx + Math.cos(ang) * rad * 1.12, maxY + Math.sin(ang) * rad]);
            cands.push([minX + Math.cos(ang) * rad, my + Math.sin(ang) * rad]);
            cands.push([maxX + Math.cos(ang) * rad, my + Math.sin(ang) * rad]);
          });
        });

        const isOwnDot = new Uint8Array(dotLen);
        for (let di = 0; di < dotLen; di++) {
          if (ownSet.has(allDots[di][2])) isOwnDot[di] = 1;
        }

        let bestScore = Infinity;
        const seenCand = new Set();
        const distWeight = isWide ? 0.85 : 1.15;
        const outerMaxCore = isWide ? 240 : 108;
        const outerMaxBox = isWide ? 160 : 56;

        for (let ci = 0; ci < cands.length; ci++) {
          const cx = clampX(cands[ci][0]);
          const cy = clampY(cands[ci][1]);
          if (cx - hw < 5 || cx + hw > vw - 5 || cy - hh < 8 || cy + hh > vh - 8) continue;
          const cKey = ((cx * 4) | 0) * 16384 + ((cy * 4) | 0);
          if (seenCand.has(cKey)) continue;
          seenCand.add(cKey);

          const distCore = Math.hypot(cx - mx, cy - my);
          const dxCoreBox = cx < cMinX ? cMinX - cx : (cx > cMaxX ? cx - cMaxX : 0);
          const dyCoreBox = cy < cMinY ? cMinY - cy : (cy > cMaxY ? cy - cMaxY : 0);
          const distCoreBox = Math.hypot(dxCoreBox, dyCoreBox);
          if (distCore > outerMaxCore || distCoreBox > outerMaxBox) continue;

          const inCoreInterior = (members.length >= 6 && dxCoreBox === 0 && dyCoreBox === 0) ? 420 : 0;
          const baseLowerBound = distCore * distWeight + inCoreInterior + (cy < minY ? -30 : 0);
          if (baseLowerBound >= bestScore) continue;

          const box = [cx - hw, cy - hh, cx + hw, cy + hh];
          const p0 = cx - hw - 2, p1 = cy - hh - 2, p2 = cx + hw + 2, p3 = cy + hh + 2;
          if (staticUiBoxes.some((ub) => boxOverlap(box, ub))) continue;
          if (reserveGuardBoxes.some((rb) => boxOverlap(box, rb))) continue;
          if (placedFam.some((pb) => boxOverlap(box, pb))) continue;

          let dotHits = 0;
          let ownD2 = Infinity, otherD2 = Infinity, ownCenterD2 = Infinity, otherCenterD2 = Infinity;
          for (let di = 0; di < dotLen; di++) {
            const px = dotX[di], py = dotY[di];
            const ddx = px < box[0] ? box[0] - px : (px > box[2] ? px - box[2] : 0);
            const ddy = py < box[1] ? box[1] - py : (py > box[3] ? py - box[3] : 0);
            const d2 = ddx * ddx + ddy * ddy;
            const cd2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
            if (isOwnDot[di] === 1) {
              if (d2 < ownD2) ownD2 = d2;
              if (cd2 < ownCenterD2) ownCenterD2 = cd2;
            } else {
              if (d2 < otherD2) otherD2 = d2;
              if (cd2 < otherCenterD2) otherCenterD2 = cd2;
            }
            if (p0 < dotBoxX1[di] && p2 > dotBoxX0[di] && p1 < dotBoxY1[di] && p3 > dotBoxY0[di]) {
              dotHits++;
              break;
            }
          }
          if (dotHits > 0) continue;
          const ownD = ownD2 < Infinity ? Math.sqrt(ownD2) : Infinity;
          const otherD = otherD2 < Infinity ? Math.sqrt(otherD2) : Infinity;
          const ownCenterD = ownCenterD2 < Infinity ? Math.sqrt(ownCenterD2) : Infinity;
          const otherCenterD = otherCenterD2 < Infinity ? Math.sqrt(otherCenterD2) : Infinity;
          if (ownCenterD > otherCenterD - (isWide ? 3.0 : 0.8)) continue;
          const stronglyCentered = ownCenterD <= otherCenterD * (isWide ? 0.72 : 0.82);
          if (!stronglyCentered && ownD > otherD + (isWide ? 10.5 : 9.5)) continue;
          if (ownD > (isWide ? 48 : 38)) continue;

          const score =
            ownD * 1.85 +
            ownCenterD * 0.45 +
            baseLowerBound +
            (otherD < ownD ? (ownD - otherD) * 24 + 420 : 0);
          if (score < bestScore) {
            bestScore = score;
            best = [cx, cy];
          }
        }

        // Interior cluster fallback at k=1
        if (!best) {
          for (let ci = 0; ci < cands.length; ci++) {
            const cx = clampX(cands[ci][0]);
            const cy = clampY(cands[ci][1]);
            if (cx - hw < 5 || cx + hw > vw - 5 || cy - hh < 8 || cy + hh > vh - 8) continue;
            const distCore = Math.hypot(cx - mx, cy - my);
            if (distCore > (isWide ? 145 : 98)) continue;
            const box = [cx - hw, cy - hh, cx + hw, cy + hh];
            const fbPad = isWide ? 3.2 : 2.2;
            const p0 = cx - hw - fbPad, p1 = cy - hh - fbPad, p2 = cx + hw + fbPad, p3 = cy + hh + fbPad;
            if (staticUiBoxes.some((ub) => boxOverlap(box, ub))) continue;
            if (reserveGuardBoxes.some((rb) => boxOverlap(box, rb))) continue;
            if (placedFam.some((pb) => boxOverlap(box, pb))) continue;

            let ownHits = 0, foreignHits = 0;
            let ownD2 = Infinity, ownCenterD2 = Infinity, otherCenterD2 = Infinity;
            for (let di = 0; di < dotLen; di++) {
              const px = dotX[di], py = dotY[di];
              const ddx = px < box[0] ? box[0] - px : (px > box[2] ? px - box[2] : 0);
              const ddy = py < box[1] ? box[1] - py : (py > box[3] ? py - box[3] : 0);
              const d2 = ddx * ddx + ddy * ddy;
              const cd2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
              if (isOwnDot[di] === 1) {
                if (d2 < ownD2) ownD2 = d2;
                if (cd2 < ownCenterD2) ownCenterD2 = cd2;
              } else if (cd2 < otherCenterD2) {
                otherCenterD2 = cd2;
              }
              if (p0 < dotBoxX1[di] && p2 > dotBoxX0[di] && p1 < dotBoxY1[di] && p3 > dotBoxY0[di]) {
                if (isOwnDot[di] === 1) ownHits++;
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
            }
          }
        }

        // Ultra-compressed fallback (e.g. narrow mobile with Gen AI ON): anchor cleanly at cluster crest and fade in at k>=1.38
        if (!best) {
          best = [
            Math.max(hw + 8, Math.min(vw - hw - 8, mx)),
            Math.max(hh + 12, Math.min(vh - hh - 12, cMinY - (hh + 6) * 0.65)),
          ];
          minK = 1.38;
        }
      }

      if (best) {
        if (minK <= 1.0) {
          placedFam.push([best[0] - hw - 6, best[1] - hh - 4, best[0] + hw + 6, best[1] + hh + 4]);
        }
        plannedGroups.push({
          key: `fam:${g.id}`,
          id: g.id,
          label,
          wx: best[0],
          wy: best[1],
          minK,
          isAiGroup: Boolean(g.is_ai_group),
          isSpokenGroup: Boolean(g.is_spoken_group),
          hasSubGroups,
          memberIds,
          unitRatio: tw / Math.max(1, baseFs),
        });
      }

      // Deterministic world anchors for Generative AI internal Discogs sub-genre lobes
      if (g.is_ai_group && Array.isArray(g.sub_groups) && g.sub_groups.length) {
        const subRefK = isWide ? 1.0 : 1.65;
        const subBaseFs = isWide ? 11.2 : 10.6;
        const subFont = `600 ${subBaseFs}px Syne, Inter, sans-serif`;
        const padX = isWide ? 32 : 12;
        const padTop = isWide ? 28 : 14;
        const padBot = isWide ? 30 : 18;
        const bx0 = minX - padX;
        const by0 = minY - padTop;
        const bx1 = maxX + padX;
        const by1 = maxY + padBot;
        const aiMemberIds = new Set(g.members || []);

        const orderedSubs = g.sub_groups.slice().sort((sa, sb) => String(sa.id).localeCompare(String(sb.id)));
        orderedSubs.forEach((sg) => {
          const smem = (sg.members || [])
            .map((id) => nodeById.get(id))
            .filter((m) => m && !(isHidden && isHidden(m.t)));
          if (!smem.length) return;
          const sMemberIds = [];
          const sxs = [], sys = [];
          const sOwn = new Set();
          let sMinY = Infinity, sMaxY = -Infinity, sMinX = Infinity, sMaxX = -Infinity;
          for (let si = 0; si < smem.length; si++) {
            const sm = smem[si];
            const wx = Number.isFinite(sm.tx) ? sm.tx : sm.x;
            const wy = Number.isFinite(sm.ty) ? sm.ty : sm.y;
            sMemberIds.push(sm.id);
            sOwn.add(sm.id);
            sxs.push(wx);
            sys.push(wy);
            if (wx < sMinX) sMinX = wx;
            if (wx > sMaxX) sMaxX = wx;
            if (wy < sMinY) sMinY = wy;
            if (wy > sMaxY) sMaxY = wy;
          }
          sxs.sort((a, b) => a - b);
          sys.sort((a, b) => a - b);
          const smx = sxs[sxs.length >> 1];
          const smy = sys[sys.length >> 1];
          const sLbl = sg.short_label || sg.label;
          const stw = textWidth(subFont, sLbl);
          const shw = Math.ceil(stw * 0.54 + 4) / subRefK;
          const shh = Math.ceil(subBaseFs * 0.62 + 2) / subRefK;

          const clampLoX = bx0 + shw + 3;
          const clampHiX = bx1 - shw - 3;
          const clampLoY = Math.max(shh + 8, by0 + shh + 4);
          const clampHiY = Math.min(vh - shh - 8, by1 - shh - 4);

          const sCands = [
            [smx, sMinY - shh - 6 / subRefK],
            [smx, sMaxY + shh + 6 / subRefK],
            [sMinX - shw - 6 / subRefK, smy],
            [sMaxX + shw + 6 / subRefK, smy],
            [smx - 10, sMinY - shh - 7 / subRefK],
            [smx + 10, sMinY - shh - 7 / subRefK],
            [smx - 10, sMaxY + shh + 7 / subRefK],
            [smx + 10, sMaxY + shh + 7 / subRefK],
          ];
          [12, 20, 30, 42].forEach((rad) => {
            const wr = rad / subRefK;
            ANGLES.forEach((ang) => {
              sCands.push([smx + Math.cos(ang) * wr * 1.12, smy + Math.sin(ang) * wr]);
              sCands.push([smx + Math.cos(ang) * wr * 1.08, sMinY + Math.sin(ang) * wr]);
              sCands.push([smx + Math.cos(ang) * wr * 1.08, sMaxY + Math.sin(ang) * wr]);
            });
          });

          let sBest = null;
          let sBestScore = Infinity;
          for (let sci = 0; sci < sCands.length; sci++) {
            const scx = clampLoX <= clampHiX ? Math.max(clampLoX, Math.min(clampHiX, sCands[sci][0])) : sCands[sci][0];
            const scy = clampLoY <= clampHiY ? Math.max(clampLoY, Math.min(clampHiY, sCands[sci][1])) : sCands[sci][1];
            const sbox = [scx - shw - 2, scy - shh - 2, scx + shw + 2, scy + shh + 2];
            if (staticUiBoxes.some((ub) => boxOverlap(sbox, ub))) continue;
            if (placedFam.some((pb) => boxOverlap(sbox, pb))) continue;
            const dCenter = Math.hypot(scx - smx, scy - smy);
            if (dCenter > 110 / subRefK) continue;

            let dc = 0;
            let ownD2 = Infinity;
            let forD2 = Infinity;
            for (let di = 0; di < dotLen; di++) {
              const did = allDots[di][2];
              const px = dotX[di], py = dotY[di];
              const ddx = px < sbox[0] ? sbox[0] - px : (px > sbox[2] ? px - sbox[2] : 0);
              const ddy = py < sbox[1] ? sbox[1] - py : (py > sbox[3] ? py - sbox[3] : 0);
              const d2 = ddx * ddx + ddy * ddy;
              if (sOwn.has(did)) {
                if (d2 < ownD2) ownD2 = d2;
              } else if (aiMemberIds.has(did)) {
                if (d2 < forD2) forD2 = d2;
              }
              if (Math.abs(px - scx) < shw + 3 && Math.abs(py - scy) < shh + 3) {
                dc += sOwn.has(did) ? 2800 : 6800;
              }
            }
            const ownD = ownD2 < Infinity ? Math.sqrt(ownD2) : 0;
            const forD = forD2 < Infinity ? Math.sqrt(forD2) : Infinity;
            const foreignPen = forD < ownD ? (ownD - forD) * 24 + 220 : 0;
            const sc = ownD * 2.0 + dCenter * 0.6 + dc + foreignPen;
            if (sc < sBestScore) {
              sBestScore = sc;
              sBest = [scx, scy];
            }
          }
          if (!sBest) sBest = [smx, Math.max(by0 + shh + 6, sMinY - shh - 4)];
          placedFam.push([sBest[0] - shw - 3, sBest[1] - shh - 2, sBest[0] + shw + 3, sBest[1] + shh + 2]);
          plannedSubs.push({
            key: `sub:${sg.id}`,
            id: sg.id,
            parentId: g.id,
            label: sLbl,
            wx: sBest[0],
            wy: sBest[1],
            minK: isWide ? 1.0 : 1.32,
            memberIds: sMemberIds,
            unitRatio: stw / Math.max(1, subBaseFs),
          });
        });
      }
    });

    worldClusterPlan = {
      sig,
      groups: plannedGroups,
      subGroups: plannedSubs,
      territories,
    };
    return worldClusterPlan;
  }

  function computeMorphDelta(memberIds, nodeById) {
    if (!memberIds || !memberIds.length || !nodeById) return [0, 0];
    let dx = 0, dy = 0, cnt = 0;
    for (let i = 0; i < memberIds.length; i++) {
      const m = nodeById.get(memberIds[i]);
      if (!m || !Number.isFinite(m.tx) || !Number.isFinite(m.ty)) continue;
      dx += m.x - m.tx;
      dy += m.y - m.ty;
      cnt++;
    }
    return cnt > 0 ? [dx / cnt, dy / cnt] : [0, 0];
  }

  function evaluateGenreItem(item, isSub, opts, uiBoxes) {
    const { nodeById, zoom, vw, vh, activeClusterId, isMatch, isHidden } = opts;
    const isWide = vw > 840;
    let visCount = 0;
    let anyMatch = false;
    for (let i = 0; i < item.memberIds.length; i++) {
      const m = nodeById ? nodeById.get(item.memberIds[i]) : null;
      if (!m || (isHidden && isHidden(m.t))) continue;
      visCount++;
      if (!anyMatch && (!isMatch || isMatch(m.t))) anyMatch = true;
    }

    const zGrow = smoothstep(1.0, 2.8, zoom.k);
    const fs = isSub
      ? ((isWide ? 11.2 : 10.6) + 1.2 * zGrow)
      : (isWide ? (16.2 + 2.3 * zGrow) : (11.5 + 3.0 * zGrow));
    const fw = isSub ? 600 : (isWide ? 700 : Math.round(620 + 80 * zGrow));
    const strokeW = isSub ? 3.2 : (isWide ? 4.0 : (3.5 + 0.5 * zGrow));

    const [mdx, mdy] = computeMorphDelta(item.memberIds, nodeById);
    const sx = (item.wx + mdx) * zoom.k + zoom.x;
    const sy = (item.wy + mdy) * zoom.k + zoom.y;
    const hw = Math.ceil(item.unitRatio * fs * 0.52 + (isSub ? 5 : 3.5));
    const hh = Math.ceil(fs * (isSub ? 0.62 : 0.58) + 2.5);

    if (visCount === 0) {
      return { sx, sy, hw, hh, fs, fw, strokeW, anyMatch: false, targetAlpha: 0 };
    }

    const inAlpha = item.minK <= 1.0 ? 1.0 : smoothstep(item.minK - 0.08, item.minK + 0.42, zoom.k);
    const actBoost = activeClusterId === item.id ? 0.65 : 0;
    let fadeStart, fadeEnd;
    if (isSub) {
      fadeStart = (isWide ? 2.25 : 2.75) + actBoost;
      fadeEnd = (isWide ? 3.85 : 4.45) + actBoost;
    } else if (item.hasSubGroups) {
      fadeStart = (isWide ? 1.80 : 2.25) + actBoost;
      fadeEnd = (isWide ? 3.15 : 3.80) + actBoost;
    } else {
      fadeStart = (isWide ? 2.10 : 2.55) + actBoost;
      fadeEnd = (isWide ? 3.70 : 4.35) + actBoost;
    }
    const outAlpha = 1 - smoothstep(fadeStart, fadeEnd, zoom.k);

    const minEdge = Math.min(
      (sx - hw) - 4,
      (vw - 4) - (sx + hw),
      (sy - hh) - 6,
      (vh - 6) - (sy + hh)
    );
    const edgeAlpha = smoothstep(-28, 4, minEdge);

    const hBox = [sx - hw, sy - hh, sx + hw, sy + hh];
    let uiAlpha = 1;
    for (let u = 0; u < uiBoxes.length; u++) {
      const gap = signedBoxGap(hBox, uiBoxes[u]);
      const a = smoothstep(-16, 16, gap);
      if (a < uiAlpha) uiAlpha = a;
    }

    const targetAlpha = clamp01(inAlpha * outAlpha * edgeAlpha * uiAlpha);
    return { sx, sy, hw, hh, fs, fw, strokeW, anyMatch, targetAlpha };
  }

  function getActiveGenreObstacleBoxes(opts, uiBoxes) {
    if (!opts || opts.layout === "era" || !opts.styleGroups || !opts.nodeById) return [];
    const plan = ensureWorldClusterPlan(opts);
    if (!plan) return [];
    const obs = [];
    const pushIfVisible = (item, isSub) => {
      const ev = evaluateGenreItem(item, isSub, opts, uiBoxes);
      const st = clusterAlphaState.get(item.key);
      const curA = st ? st.alpha : ev.targetAlpha;
      if (Math.max(curA, ev.targetAlpha) >= 0.18) {
        obs.push([ev.sx - ev.hw - 6, ev.sy - ev.hh - 4, ev.sx + ev.hw + 6, ev.sy + ev.hh + 4]);
      }
    };
    for (let i = 0; i < plan.groups.length; i++) pushIfVisible(plan.groups[i], false);
    for (let i = 0; i < plan.subGroups.length; i++) pushIfVisible(plan.subGroups[i], true);
    return obs;
  }

  // Draw crisp Inter track labels in 1:1 screen space with delayed screen-density LOD,
  // generous collision clearance, spatial hysteresis, and ~160ms exponential opacity cross-fades.
  function drawScreenTrackLabels(ctx, opts) {
    lastTrackBoxes = [];
    lastPlacedEntries = [];
    shownIds = new Set();
    lastTrackDebug = [];
    if (!ctx) return lastTrackBoxes;
    const {
      nodes,
      nodeById,
      zoom,
      vw,
      vh,
      palette,
      isMatch,
      isHidden,
      nodeScreenRadius,
      trackColor,
      playId,
      selectedId,
      hoverId,
      isStarred,
      mapWrap,
      layout,
      eraLeftGutter,
      onRequestFrame,
    } = opts;

    const now = nowMs();
    const dt = stepDt(lastTrackTs, now);
    lastTrackTs = now;
    const reducedMotion = prefersReducedMotion();

    if (layout && lastTrackLayout && layout !== lastTrackLayout) {
      trackLabelState.clear();
      prevChosenAmbient.clear();
    }
    if (layout) lastTrackLayout = layout;

    const mobileEraScroll = layout === "era" && vw <= 800;
    const uiBoxes = getUiObstacleBoxes(mapWrap);
    if (mobileEraScroll) {
      uiBoxes.push([0, 0, (eraLeftGutter || 94) + 2, vh]);
      uiBoxes.push([vw - 170, 0, vw, 48]); // "Ambient <- -> High energy" top-right header legend
    }
    const minLabelX = mobileEraScroll ? (eraLeftGutter || 94) + 3 : 6;
    const maxLabelX = mobileEraScroll ? vw - 10 : vw - 6;

    const genreBoxes = getActiveGenreObstacleBoxes(opts, uiBoxes);
    const isCompact = vw <= 640;
    const baseFs = mobileEraScroll && zoom.k < 1.55 ? 10.5 : (isCompact ? 11.2 : 11.5);

    // Screen-density-aware progressive LOD thresholds:
    // On a 390px phone in Vibe view, minDim=390 -> kEnter=2.42, kMid=4.05, kClose=5.08
    // On a 1440x900 desktop in Vibe view, minDim=844 -> kEnter=1.78, kMid=2.90, kClose=3.90
    // In mobileEraScroll (already 3-screens tall vertically), browse labels remain active at k>=1.0.
    const minDim = Math.max(320, Math.min(vw, vh));
    const kEnter = mobileEraScroll ? 1.0 : Math.max(1.78, 945 / minDim);
    const kStay = mobileEraScroll ? 1.0 : (kEnter - 0.14);
    const kMid = mobileEraScroll ? 2.2 : Math.max(2.90, 1580 / minDim);
    const kClose = mobileEraScroll ? 3.4 : Math.max(3.90, 1980 / minDim);

    const uMid = clamp01((zoom.k - kEnter) / Math.max(0.2, kMid - kEnter));
    const uClose = clamp01((zoom.k - kMid) / Math.max(0.2, kClose - kMid));
    const usableArea = computeUsableMapArea(vw, vh, uiBoxes);
    const effAreaUnits = Math.pow(Math.max(0.35, usableArea / 100000), 0.82);

    let maxAmbient = 0;
    if (mobileEraScroll) {
      maxAmbient = Math.max(6, Math.round(effAreaUnits * (9.5 + 10.0 * smoothstep(1.0, 2.6, zoom.k))));
    } else if (zoom.k >= kEnter) {
      const density = zoom.k <= kMid
        ? (1.1 + 4.9 * Math.pow(uMid, 0.85))
        : (6.0 + 14.0 * smoothstep(0, 1, uClose));
      maxAmbient = Math.max(1, Math.round(effAreaUnits * density));
    } else if (zoom.k >= kStay && prevChosenAmbient.size > 0) {
      maxAmbient = prevChosenAmbient.size;
    }

    const baseClearX = mobileEraScroll
      ? (10 - 4 * smoothstep(1.0, 2.5, zoom.k))
      : (zoom.k <= kMid ? (28 - 10 * uMid) : (18 - 8 * smoothstep(0, 1, uClose)));
    const baseClearY = mobileEraScroll
      ? (7 - 3 * smoothstep(1.0, 2.5, zoom.k))
      : (zoom.k <= kMid ? (18 - 6 * uMid) : (12 - 5 * smoothstep(0, 1, uClose)));
    const baseDotSep = mobileEraScroll
      ? (24 - 10 * smoothstep(1.0, 2.5, zoom.k))
      : (zoom.k <= kMid
          ? ((isCompact ? 74 : 84) * (1 - uMid) + 44 * uMid)
          : (44 * (1 - smoothstep(0, 1, uClose)) + 16 * smoothstep(0, 1, uClose)));

    lastLodDebug = { kEnter, kStay, kMid, kClose, maxAmbient };

    const emphCandidates = [];
    const ambientCandidates = [];
    const dotBoxes = [];
    const fastNodeLookup = nodeById || new Map(nodes.map((n) => [n.id, n]));

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if ((isHidden && isHidden(n.t)) || !isMatch(n.t)) continue;
      const sx = Number.isFinite(n.px) ? n.px : n.x * zoom.k + zoom.x;
      const sy = Number.isFinite(n.py) ? n.py : n.y * zoom.k + zoom.y;
      if (sx < -28 || sx > vw + 28 || sy < -28 || sy > vh + 28) continue;
      const r = nodeScreenRadius(n.t);
      const isPlay = n.id === playId;
      const isSel = n.id === selectedId;
      const existingSt = trackLabelState.get(n.id);
      const isHovAlreadyAmbient = n.id === hoverId && Boolean(existingSt && existingSt.alpha >= 0.55);
      const isEmph = isPlay || isSel || isHovAlreadyAmbient;

      dotBoxes.push({ id: n.id, box: [sx - r - 2.2, sy - r - 2.2, sx + r + 2.2, sy + r + 2.2] });

      if (isEmph) {
        const prio = (isPlay ? 2000 : 0) + (isSel ? 1200 : 0) + (isHovAlreadyAmbient ? 800 : 0);
        emphCandidates.push({ n, sx, sy, r, prio, emph: true, wasChosen: true });
      } else if (maxAmbient > 0 && sx >= 8 && sx <= vw - 8 && sy >= 10 && sy <= vh - 10) {
        const wasChosen = prevChosenAmbient.has(n.id);
        if (zoom.k < kEnter && !wasChosen) continue;
        const prio =
          (isStarred && isStarred(n.id) ? 200 : 0) +
          (n.t.released ? 80 : 0) +
          (Number(n.t.energy) || 0) * 2.2 +
          (wasChosen ? 24 : 0) +
          hash01(n.id) * 0.99;
        ambientCandidates.push({ n, sx, sy, r, prio, emph: false, wasChosen });
      }
    }

    emphCandidates.sort((a, b) => b.prio - a.prio);
    ambientCandidates.sort((a, b) => b.prio - a.prio);

    const allowCloseupLeaders = zoom.k >= kClose;
    const placedRawBoxes = [];
    const placedAmbientCenters = [];
    const nextChosenAmbient = new Set();
    const chosenThisFrame = new Map();

    function tryPlaceCandidate(item) {
      const lbl = cleanMapLabel(item.n.t);
      if (!lbl) return false;

      if (!item.emph) {
        const reqSep = item.wasChosen ? baseDotSep * 0.82 : baseDotSep;
        for (let ci = 0; ci < placedAmbientCenters.length; ci++) {
          const pc = placedAmbientCenters[ci];
          if (Math.hypot(item.sx - pc[0], item.sy - pc[1]) < reqSep) {
            return false;
          }
        }
      }

      const fs = item.emph ? 12 : baseFs;
      const font = `${item.emph ? 700 : 500} ${fs}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
      const w = textWidth(font, lbl);
      const hw = w * 0.5;
      const hh = item.emph ? 6.6 : (isCompact ? 5.7 : 6.0);
      const g = item.r + 4.2;

      const rawCands = [];
      if (item.n.t && item.n.t.is_spoken_word) {
        const belowBoxY = item.sy + 23;
        rawCands.push({ key: "spoken", box: [item.sx - hw, belowBoxY, item.sx + hw, belowBoxY + 2 * hh], leader: false });
      }
      if (item.n.fanAngle != null) {
        const ca = Math.cos(item.n.fanAngle);
        const sa = Math.sin(item.n.fanAngle);
        const ax = item.sx + ca * (g + 2.5);
        const ay = item.sy + sa * (g + 2.5);
        const bx0 = ca > 0.35 ? ax : ca < -0.35 ? ax - w : ax - hw;
        rawCands.push({ key: "fan", box: [bx0, ay - hh, bx0 + w, ay + hh], leader: false });
      }
      rawCands.push(
        { key: "n", box: [item.sx - hw, item.sy - g - 2 * hh, item.sx + hw, item.sy - g], leader: false },
        { key: "s", box: [item.sx - hw, item.sy + g, item.sx + hw, item.sy + g + 2 * hh], leader: false },
        { key: "e", box: [item.sx + g, item.sy - hh, item.sx + g + w, item.sy + hh], leader: false },
        { key: "w", box: [item.sx - g - w, item.sy - hh, item.sx - g, item.sy + hh], leader: false },
        { key: "ne", box: [item.sx + g - hw * 0.3, item.sy - g - 2 * hh, item.sx + g + hw * 1.7, item.sy - g], leader: false },
        { key: "nw", box: [item.sx - g - hw * 1.7, item.sy - g - 2 * hh, item.sx - g + hw * 0.3, item.sy - g], leader: false },
        { key: "se", box: [item.sx + g - hw * 0.3, item.sy + g, item.sx + g + hw * 1.7, item.sy + g + 2 * hh], leader: false },
        { key: "sw", box: [item.sx - g - hw * 1.7, item.sy + g, item.sx - g + hw * 0.3, item.sy + g + 2 * hh], leader: false }
      );

      if (allowCloseupLeaders || item.emph) {
        for (let ri = 0; ri < CLOSEUP_LEADER_RADII.length; ri++) {
          const rad = CLOSEUP_LEADER_RADII[ri];
          for (let ai = 0; ai < ANGLES.length; ai += 2) {
            const ang = ANGLES[ai];
            const ca = Math.cos(ang);
            const sa = Math.sin(ang);
            const ax = item.sx + ca * rad;
            const ay = item.sy + sa * rad;
            const bx0 = ca > 0.35 ? ax : ca < -0.35 ? ax - w : ax - hw;
            rawCands.push({ key: `L${ri}_${ai}`, box: [bx0, ay - hh, bx0 + w, ay + hh], leader: true });
          }
        }
      }

      const prevSt = trackLabelState.get(item.n.id);
      if (prevSt && prevSt.slotKey && prevSt.alpha > 0.08) {
        const prefIdx = rawCands.findIndex((c) => c.key === prevSt.slotKey);
        if (prefIdx > 0) {
          const [pref] = rawCands.splice(prefIdx, 1);
          rawCands.unshift(pref);
        }
      }

      const minGapFloorX = mobileEraScroll ? 3.5 : 6;
      const minGapFloorY = mobileEraScroll ? 2.5 : 4;
      const reqClearX = item.emph ? 5 : Math.max(minGapFloorX, item.wasChosen ? baseClearX * 0.78 : baseClearX);
      const reqClearY = item.emph ? 3.5 : Math.max(minGapFloorY, item.wasChosen ? baseClearY * 0.78 : baseClearY);

      let chosenBox = null;
      let chosenKey = null;
      let fallbackEmphBox = null;
      let fallbackEmphKey = null;

      for (let ci = 0; ci < rawCands.length; ci++) {
        let b = rawCands[ci].box;
        if (b[0] < minLabelX) {
          const sh = minLabelX - b[0];
          b = [b[0] + sh, b[1], b[2] + sh, b[3]];
        } else if (b[2] > maxLabelX) {
          const sh = b[2] - maxLabelX;
          b = [b[0] - sh, b[1], b[2] - sh, b[3]];
        }
        if (b[0] < minLabelX - 1 || b[2] > maxLabelX + 1 || b[1] < 7 || b[3] > vh - 7) continue;

        const uiTest = [b[0] - 3, b[1] - 2.5, b[2] + 3, b[3] + 2.5];
        const hitUi = uiBoxes.some((ub) => boxOverlap(uiTest, ub));
        if (hitUi && !item.emph) continue;

        if (!item.emph && genreBoxes.some((gb) => boxOverlap(b, gb))) continue;

        const clearBox = [b[0] - reqClearX, b[1] - reqClearY, b[2] + reqClearX, b[3] + reqClearY];
        let hitPlaced = false;
        for (let pi = 0; pi < placedRawBoxes.length; pi++) {
          if (boxOverlap(clearBox, placedRawBoxes[pi])) {
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
          if (item.emph && !fallbackEmphBox && !rawCands[ci].leader) {
            fallbackEmphBox = b;
            fallbackEmphKey = rawCands[ci].key;
          }
          continue;
        }

        chosenBox = b;
        chosenKey = rawCands[ci].key;
        break;
      }

      if (!chosenBox && fallbackEmphBox) {
        chosenBox = fallbackEmphBox;
        chosenKey = fallbackEmphKey;
      }
      if (!chosenBox) return false;

      placedRawBoxes.push(chosenBox);
      if (!item.emph) {
        placedAmbientCenters.push([item.sx, item.sy]);
        nextChosenAmbient.add(item.n.id);
      }
      chosenThisFrame.set(item.n.id, { item, lbl, font, w, hh, box: chosenBox, slotKey: chosenKey });
      return true;
    }

    for (let i = 0; i < emphCandidates.length; i++) {
      tryPlaceCandidate(emphCandidates[i]);
    }
    let ambientCount = 0;
    for (let i = 0; i < ambientCandidates.length && ambientCount < maxAmbient; i++) {
      if (tryPlaceCandidate(ambientCandidates[i])) {
        ambientCount++;
      }
    }
    prevChosenAmbient = nextChosenAmbient;

    const alphaBlend = reducedMotion ? 1 : (1 - Math.exp(-dt / TRACK_FADE_TAU_MS));
    const offsetBlend = reducedMotion ? 1 : (1 - Math.exp(-dt / TRACK_OFFSET_TAU_MS));
    trackAnimating = false;

    chosenThisFrame.forEach((ch, id) => {
      const cx = (ch.box[0] + ch.box[2]) * 0.5;
      const cy = (ch.box[1] + ch.box[3]) * 0.5;
      const targetOffX = cx - ch.item.sx;
      const targetOffY = cy - ch.item.sy;
      const targetAlpha = ch.item.emph ? 1.0 : 0.94;
      let st = trackLabelState.get(id);
      if (!st) {
        const instant = ch.item.emph || reducedMotion || (mobileEraScroll && zoom.k <= 1.02 && prevChosenAmbient.size <= chosenThisFrame.size && lastTrackTs === now && dt === 16.67 && trackLabelState.size === 0);
        st = {
          alpha: instant ? targetAlpha : 0,
          targetAlpha,
          offX: targetOffX,
          offY: targetOffY,
          targetOffX,
          targetOffY,
          slotKey: ch.slotKey,
          w: ch.w,
          hh: ch.hh,
          lbl: ch.lbl,
          font: ch.font,
          emph: ch.item.emph,
        };
        trackLabelState.set(id, st);
      } else {
        st.targetAlpha = targetAlpha;
        st.targetOffX = targetOffX;
        st.targetOffY = targetOffY;
        st.slotKey = ch.slotKey;
        st.w = ch.w;
        st.hh = ch.hh;
        st.lbl = ch.lbl;
        st.font = ch.font;
        st.emph = ch.item.emph;
      }
      if (ch.item.emph || reducedMotion) {
        st.alpha = targetAlpha;
      } else {
        st.alpha += (targetAlpha - st.alpha) * alphaBlend;
      }
      st.offX += (targetOffX - st.offX) * offsetBlend;
      st.offY += (targetOffY - st.offY) * offsetBlend;
      if (Math.abs(targetAlpha - st.alpha) > 0.012 || Math.hypot(targetOffX - st.offX, targetOffY - st.offY) > 0.25) {
        trackAnimating = true;
      }
    });

    const renderList = [];
    trackLabelState.forEach((st, id) => {
      if (!chosenThisFrame.has(id)) {
        st.targetAlpha = 0;
        st.emph = false;
        if (reducedMotion) st.alpha = 0;
        else st.alpha += (0 - st.alpha) * alphaBlend;
        if (st.alpha < 0.014) {
          trackLabelState.delete(id);
          return;
        }
        trackAnimating = true;
      }
      if (st.alpha < 0.014) return;
      const n = fastNodeLookup.get(id);
      if (!n || (isHidden && isHidden(n.t)) || !isMatch(n.t)) {
        trackLabelState.delete(id);
        return;
      }
      const sx = Number.isFinite(n.px) ? n.px : n.x * zoom.k + zoom.x;
      const sy = Number.isFinite(n.py) ? n.py : n.y * zoom.k + zoom.y;
      if (sx < -40 || sx > vw + 40 || sy < -40 || sy > vh + 40) return;
      const r = nodeScreenRadius(n.t);
      const cx = sx + st.offX;
      const cy = sy + st.offY;
      const hw = st.w * 0.5;
      const box = [cx - hw, cy - st.hh, cx + hw, cy + st.hh];
      if (!st.emph && st.targetAlpha === 0 && uiBoxes.some((ub) => boxOverlap(box, ub))) {
        return;
      }
      if (st.targetAlpha > 0 && st.alpha >= 0.55) {
        shownIds.add(id);
      }
      if (st.targetAlpha > 0 && st.alpha >= 0.30) {
        lastPlacedEntries.push({ id, box, alpha: st.alpha, emph: st.emph });
        lastTrackBoxes.push(box);
      }
      lastTrackDebug.push({
        id,
        label: st.lbl,
        emph: st.emph,
        alpha: Number(st.alpha.toFixed(3)),
        targetAlpha: Number(st.targetAlpha.toFixed(3)),
        box: box.map((v) => Number(v.toFixed(2))),
      });
      renderList.push({ id, n, sx, sy, r, box, st });
    });

    renderList.sort((a, b) => {
      if (a.st.emph !== b.st.emph) return a.st.emph ? 1 : -1;
      return a.st.alpha - b.st.alpha;
    });

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.miterLimit = 2;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";

    // Pass 1: subtle cartographic leader ticks for any stepped-outward close-up labels
    for (let i = 0; i < renderList.length; i++) {
      const { n, sx, sy, r, box, st } = renderList[i];
      const [nx, ny] = nearestBoxPoint(sx, sy, box);
      const dist = Math.hypot(nx - sx, ny - sy);
      if (dist > r + 8.5) {
        const ux = (nx - sx) / dist;
        const uy = (ny - sy) / dist;
        const x0 = sx + ux * (r + 1.4);
        const y0 = sy + uy * (r + 1.4);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(nx, ny);
        ctx.globalAlpha = 0.85 * st.alpha;
        ctx.lineWidth = 2.4;
        ctx.strokeStyle = palette.surfaceLowest;
        ctx.stroke();
        ctx.globalAlpha = (st.emph ? 0.85 : 0.52) * st.alpha;
        ctx.lineWidth = 1.05;
        ctx.strokeStyle = trackColor ? trackColor(n.t) : palette.outline;
        ctx.stroke();
      }
    }

    // Pass 2: crisp knock-out halo text with continuous per-track alpha
    for (let i = 0; i < renderList.length; i++) {
      const { box, st } = renderList[i];
      const cx = (box[0] + box[2]) * 0.5;
      const cy = (box[1] + box[3]) * 0.5 + 0.5;
      ctx.font = st.font;
      ctx.lineWidth = 2.9;
      ctx.strokeStyle = palette.surfaceLowest;
      ctx.globalAlpha = 0.92 * st.alpha;
      ctx.strokeText(st.lbl, cx, cy);
      ctx.fillStyle = palette.onSurface;
      ctx.globalAlpha = st.alpha;
      ctx.fillText(st.lbl, cx, cy);
    }

    ctx.restore();
    scheduleSettleIfNeeded(onRequestFrame);
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

  function clearClusterDom(svgGroup) {
    if (svgGroup) svgGroup.innerHTML = "";
    svgCache.root = null;
    svgCache.aiRect = null;
    svgCache.spokenRect = null;
    svgCache.entries.clear();
  }

  function ensureSvgEntry(svgGroup, key, id, isSub) {
    let entry = svgCache.entries.get(key);
    if (entry && entry.grp && entry.grp.parentNode === svgGroup) {
      return entry;
    }
    const grp = document.createElementNS(NS, "g");
    const hit = document.createElementNS(NS, "rect");
    hit.setAttribute("class", "map-family-hit");
    hit.setAttribute("rx", isSub ? "6" : "8");
    const txt = document.createElementNS(NS, "text");
    txt.setAttribute("class", isSub ? "map-ai-sub-label" : "map-family-label");
    grp.append(hit, txt);
    grp.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (svgCache.onToggleRef) svgCache.onToggleRef(id);
    });
    svgGroup.appendChild(grp);
    entry = { grp, hit, txt, id, isSub };
    svgCache.entries.set(key, entry);
    return entry;
  }

  // Render world-anchored, smoothly cross-fading Syne genre & AI sub-genre headers
  function renderClusterLandmarks(svgGroup, opts) {
    if (!svgGroup) return;
    const {
      nodeById,
      zoom,
      vw,
      vh,
      activeClusterId,
      onToggleCluster,
      mapWrap,
      onRequestFrame,
    } = opts;

    svgCache.onToggleRef = onToggleCluster || null;
    if (svgCache.root !== svgGroup) {
      clearClusterDom(svgGroup);
      svgCache.root = svgGroup;
    }

    const plan = ensureWorldClusterPlan(opts);
    if (!plan) {
      lastGenreDebug = [];
      return;
    }

    const now = nowMs();
    const dt = stepDt(lastClusterTs, now);
    lastClusterTs = now;
    const reducedMotion = prefersReducedMotion();
    const isFreshPlanAtOverview = plan.sig !== lastClusterPlanSig && zoom.k <= 1.05;
    if (plan.sig !== lastClusterPlanSig) {
      lastClusterPlanSig = plan.sig;
    }
    const alphaBlend = (reducedMotion || isFreshPlanAtOverview)
      ? 1
      : (1 - Math.exp(-dt / CLUSTER_FADE_TAU_MS));

    const uiBoxes = getUiObstacleBoxes(mapWrap);
    clusterAnimating = false;
    lastGenreDebug = [];
    const seenKeys = new Set();

    // Update territory dashed boundary boxes in world-projected coordinates
    let wantAiRect = false;
    let wantSpokenRect = false;
    for (let ti = 0; ti < plan.territories.length; ti++) {
      const terr = plan.territories[ti];
      const [mdx, mdy] = computeMorphDelta(terr.memberIds, nodeById);
      const bx0 = (terr.minWx + mdx) * zoom.k + zoom.x - terr.padX;
      const bx1 = (terr.maxWx + mdx) * zoom.k + zoom.x + terr.padX;
      const by0 = (terr.minWy + mdy) * zoom.k + zoom.y - terr.padTop;
      const by1 = (terr.maxWy + mdy) * zoom.k + zoom.y + terr.padBot;
      if (bx1 < -20 || bx0 > vw + 20 || by1 < -20 || by0 > vh + 20) continue;
      const w = bx1 - bx0;
      const h = by1 - by0;
      if (terr.isSpoken && w >= 20 && h >= 20) {
        wantSpokenRect = true;
        if (!svgCache.spokenRect || svgCache.spokenRect.parentNode !== svgGroup) {
          svgCache.spokenRect = document.createElementNS(NS, "rect");
          svgCache.spokenRect.setAttribute("class", "map-ai-territory-box map-spoken-island-box");
          svgCache.spokenRect.setAttribute("rx", "14");
          svgGroup.insertBefore(svgCache.spokenRect, svgGroup.firstChild);
        }
        svgCache.spokenRect.style.display = "";
        svgCache.spokenRect.setAttribute("x", bx0.toFixed(2));
        svgCache.spokenRect.setAttribute("y", by0.toFixed(2));
        svgCache.spokenRect.setAttribute("width", w.toFixed(2));
        svgCache.spokenRect.setAttribute("height", h.toFixed(2));
      } else if (terr.isAi && w > 24 && h > 24) {
        wantAiRect = true;
        if (!svgCache.aiRect || svgCache.aiRect.parentNode !== svgGroup) {
          svgCache.aiRect = document.createElementNS(NS, "rect");
          svgCache.aiRect.setAttribute("class", "map-ai-territory-box");
          svgCache.aiRect.setAttribute("rx", "18");
          svgGroup.insertBefore(svgCache.aiRect, svgGroup.firstChild);
        }
        const terrFade = 1 - 0.65 * smoothstep(3.0, 5.2, zoom.k);
        svgCache.aiRect.style.display = "";
        svgCache.aiRect.style.opacity = terrFade.toFixed(3);
        svgCache.aiRect.setAttribute("x", bx0.toFixed(2));
        svgCache.aiRect.setAttribute("y", by0.toFixed(2));
        svgCache.aiRect.setAttribute("width", w.toFixed(2));
        svgCache.aiRect.setAttribute("height", h.toFixed(2));
      }
    }
    if (!wantAiRect && svgCache.aiRect) svgCache.aiRect.style.display = "none";
    if (!wantSpokenRect && svgCache.spokenRect) svgCache.spokenRect.style.display = "none";

    function updateHeaderItem(item, isSub) {
      seenKeys.add(item.key);
      const ev = evaluateGenreItem(item, isSub, opts, uiBoxes);
      let st = clusterAlphaState.get(item.key);
      if (!st) {
        const initA = (reducedMotion || isFreshPlanAtOverview) ? ev.targetAlpha : 0;
        st = { alpha: initA, targetAlpha: ev.targetAlpha };
        clusterAlphaState.set(item.key, st);
      }
      st.targetAlpha = ev.targetAlpha;
      st.alpha += (ev.targetAlpha - st.alpha) * alphaBlend;
      if (Math.abs(ev.targetAlpha - st.alpha) > 0.01) {
        clusterAnimating = true;
      }

      const dom = ensureSvgEntry(svgGroup, item.key, item.id, isSub);
      const isOwnAiSubActive = Boolean(
        !isSub && item.isAiGroup && activeClusterId && activeClusterId.startsWith("ai_sub_")
      );
      const isDim = isSub
        ? (!ev.anyMatch || (activeClusterId && activeClusterId !== item.id && activeClusterId !== item.parentId))
        : (!ev.anyMatch || (activeClusterId && activeClusterId !== item.id && !isOwnAiSubActive));
      const baseCls = isSub ? "map-ai-sub-group" : "map-family-group";
      const cls =
        baseCls +
        (activeClusterId === item.id ? " is-active" : "") +
        (isDim ? " is-dim" : "");

      dom.grp.setAttribute("class", cls);
      dom.grp.setAttribute("transform", `translate(${ev.sx.toFixed(2)}, ${ev.sy.toFixed(2)})`);
      dom.grp.style.opacity = st.alpha.toFixed(3);
      dom.grp.style.pointerEvents = st.alpha >= 0.16 ? "auto" : "none";
      dom.grp.style.display = (st.alpha < 0.006 && ev.targetAlpha < 0.006) ? "none" : "";

      dom.hit.setAttribute("x", (-ev.hw).toFixed(1));
      dom.hit.setAttribute("y", (-ev.hh).toFixed(1));
      dom.hit.setAttribute("width", (ev.hw * 2).toFixed(1));
      dom.hit.setAttribute("height", (ev.hh * 2).toFixed(1));

      dom.txt.style.fontSize = `${ev.fs.toFixed(2)}px`;
      dom.txt.style.fontWeight = String(ev.fw);
      dom.txt.style.strokeWidth = `${ev.strokeW.toFixed(2)}px`;
      dom.txt.setAttribute("y", (ev.fs * 0.34).toFixed(2));
      if (dom.txt.textContent !== item.label) {
        dom.txt.textContent = item.label;
      }

      lastGenreDebug.push({
        key: item.key,
        id: item.id,
        label: item.label,
        isSub,
        wx: Number(item.wx.toFixed(2)),
        wy: Number(item.wy.toFixed(2)),
        sx: Number(ev.sx.toFixed(2)),
        sy: Number(ev.sy.toFixed(2)),
        alpha: Number(st.alpha.toFixed(3)),
        targetAlpha: Number(ev.targetAlpha.toFixed(3)),
        box: [
          Number((ev.sx - ev.hw).toFixed(2)),
          Number((ev.sy - ev.hh).toFixed(2)),
          Number((ev.sx + ev.hw).toFixed(2)),
          Number((ev.sy + ev.hh).toFixed(2)),
        ],
      });
    }

    for (let i = 0; i < plan.groups.length; i++) {
      updateHeaderItem(plan.groups[i], false);
    }
    for (let i = 0; i < plan.subGroups.length; i++) {
      updateHeaderItem(plan.subGroups[i], true);
    }

    svgCache.entries.forEach((entry, key) => {
      if (!seenKeys.has(key) && entry.grp) {
        entry.grp.style.display = "none";
        entry.grp.style.pointerEvents = "none";
      }
    });

    scheduleSettleIfNeeded(onRequestFrame);
  }

  function hasActiveAnimations() {
    return Boolean(trackAnimating || clusterAnimating);
  }

  function getDebugState() {
    return {
      genreHeaders: lastGenreDebug.slice(),
      trackLabels: lastTrackDebug.slice(),
      lod: { ...lastLodDebug },
      activeAnimations: hasActiveAnimations(),
    };
  }

  window.BTMM_MAP_LABELS = {
    drawScreenTrackLabels,
    renderClusterLandmarks,
    clearClusterDom,
    isLabelShown,
    hitLabelAt,
    hasActiveAnimations,
    getDebugState,
  };
})();
