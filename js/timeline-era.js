// Dedicated Artistic Energy-Wave Timeline Renderer (Horizontal Desktop > 800px / Vertical Mobile <= 800px)
(function () {
  "use strict";

  const YEAR_MARKERS = [
    { eraId: "present_early_97", year: "1997" },
    { eraId: "present_breaks_99", year: "1999" },
    { eraId: "present_med_house_01", year: "2001" },
    { eraId: "present_arcadian_03", year: "2003" },
    { eraId: "hd_2005", year: "2005" },
    { eraId: "archive_2013_18", year: "2013" },
    { eraId: "le_garage", year: "2018" },
    { eraId: "psychedailies", year: "2021" },
    { eraId: "remixes_commissions", year: "2023" },
    { eraId: "ecstatic_wave", year: "2025" },
    { eraId: "sketches_2026", year: "2026" },
  ];

  function hashFrac(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 1000) / 1000;
  }

  function energyNorm(t) {
    const e = Number(t.energy || 4);
    const drum = Number(t.drum_complexity || 40) / 100;
    const da = Number(t.dark_ambient_score || 0) / 100;
    const raw = ((e - 1) / 9) * 0.84 + drum * 0.16 - da * 0.08;
    return Math.max(0.03, Math.min(0.97, raw));
  }

  const GENAI_ERA_ID = "genai_2025";
  const GENAI_ERA_DEF = {
    id: GENAI_ERA_ID,
    label: "Gen AI 25",
    shortLabel: "Gen AI",
    sublabel: "2024–25",
  };

  function eraKeyOf(t) {
    return t && t.is_ai ? GENAI_ERA_ID : (t ? t.era : "");
  }

  function computeLayout(tracks, eras, erasById, vw, vh) {
    const isMobile = vw <= 800;
    const baseEras = (eras && eras.length) ? eras.slice() : [...erasById.values()];
    const hasAiTracks = Boolean((tracks || []).some((t) => t && t.is_ai));
    const eraList = baseEras.slice();
    if (hasAiTracks && !eraList.some((e) => e.id === GENAI_ERA_ID)) {
      const sk26Idx = eraList.findIndex((e) => e.id === "sketches_2026");
      if (sk26Idx >= 0) eraList.splice(sk26Idx, 0, GENAI_ERA_DEF);
      else eraList.push(GENAI_ERA_DEF);
    }
    const eraIndexById = new Map(eraList.map((e, i) => [e.id, i]));
    const byEra = new Map(eraList.map((e) => [e.id, []]));
    (tracks || []).forEach((t) => {
      const ek = eraKeyOf(t);
      if (!byEra.has(ek)) byEra.set(ek, []);
      byEra.get(ek).push(t);
    });

    const dense = (tracks || []).length > 140;
    const coords = new Map();
    const bands = [];

    if (!isMobile) {
      // Desktop (> 800px): ~2.45-screens-wide smooth horizontal chronological scroll so all 18 eras breathe cleanly at 1x zoom
      const DESKTOP_ERA_SCREENS = 2.45;
      const padL = 32;
      const padR = 32;
      const padT = 122; // clears top-left HUD + nudged top Syne era headings + year ticks
      const padB = 42;  // clears bottom track labels + horizontal scroll indicator
      const virtualW = Math.max(1980, Math.round(vw * DESKTOP_ERA_SCREENS));
      const virtualH = vh;
      const waveH = Math.max(200, virtualH - padT - padB);
      const usableW = Math.max(1200, virtualW - padL - padR);

      const rawWidths = eraList.map((er) => {
        const cnt = (byEra.get(er.id) || []).length;
        return dense ? (52 + Math.pow(cnt, 0.62) * 18) : 130;
      });
      const rawSumW = rawWidths.reduce((a, b) => a + b, 0) || 1;
      const widths = rawWidths.map((w) => (w / rawSumW) * usableW);

      let cursorX = padL;
      eraList.forEach((er, idx) => {
        const list = byEra.get(er.id) || [];
        const colW = widths[idx];
        const x0 = cursorX;
        cursorX += colW;
        const cx = x0 + colW * 0.5;
        const padInX = Math.min(18, Math.max(10, colW * 0.12));
        const innerW = Math.max(14, colW - padInX * 2);

        list.forEach((t, ti) => {
          const en = energyNorm(t);
          const slotFrac = list.length > 1 ? (ti + 0.5) / list.length : 0.5;
          const hashX = hashFrac(t.id + "_x");
          const xFrac = slotFrac * 0.64 + hashX * 0.36;
          const jitterY = (hashFrac(t.id + "_y") - 0.5) * 32;
          const px = Math.max(x0 + padInX, Math.min(x0 + colW - padInX, x0 + padInX + xFrac * innerW));
          const py = Math.max(padT + 8, Math.min(virtualH - padB - 8, padT + (1 - en) * waveH + jitterY));
          coords.set(t.id, { x: px, y: py, era: er.id, idx: ti });
        });

        // Adaptive micro-swarm collision repulsion scaled to expanded ~2.45x column area
        const minDist = dense
          ? Math.max(18, Math.min(32, Math.sqrt((colW * waveH) / Math.max(1, list.length)) * 0.54))
          : 28;
        for (let iter = 0; iter < 28; iter++) {
          for (let i = 0; i < list.length; i++) {
            const a = coords.get(list[i].id);
            for (let j = i + 1; j < list.length; j++) {
              const b = coords.get(list[j].id);
              let dx = b.x - a.x;
              let dy = b.y - a.y;
              let dist = Math.hypot(dx, dy);
              if (dist < 0.01) { dx = 1; dy = 0.35; dist = 1.06; }
              if (dist < minDist) {
                const push = (minDist - dist) * 0.5;
                const ux = (dx / dist) * push * 0.88;
                const uy = (dy / dist) * push * 0.82;
                a.x = Math.max(x0 + padInX, Math.min(x0 + colW - padInX, a.x - ux));
                b.x = Math.max(x0 + padInX, Math.min(x0 + colW - padInX, b.x + ux));
                a.y = Math.max(padT + 8, Math.min(virtualH - padB - 8, a.y - uy));
                b.y = Math.max(padT + 8, Math.min(virtualH - padB - 8, b.y + uy));
              }
            }
          }
        }

        const meanY = list.length
          ? list.reduce((acc, t) => acc + coords.get(t.id).y, 0) / list.length
          : padT + waveH * 0.5;
        const yearObj = YEAR_MARKERS.find((ym) => ym.eraId === er.id);
        bands.push({
          id: er.id,
          idx,
          label: er.label,
          shortLabel: er.shortLabel || er.label,
          sublabel: er.sublabel || "",
          yearMark: yearObj ? yearObj.year : "",
          x: x0,
          y: 0,
          w: colW,
          h: virtualH,
          cx,
          cy: meanY,
          count: list.length,
        });
      });

      const spine = bands.filter((b) => b.count > 0).map((b) => ({ x: b.cx, y: b.cy, id: b.id }));
      return {
        isMobile: false,
        virtualW,
        virtualH,
        bands,
        spine,
        coords,
        eraIndexById,
        defaultZoom: { k: 1, x: 0, y: 0 },
      };
    }

    // Mobile (<= 800px): 3-screens-tall smooth vertical scroll (3 * vh) so every era and track is easy to browse without zooming
    const MOBILE_ERA_SCREENS = 3;
    const leftGutter = 94;
    const padR = 18;
    const padT = 72;
    const padB = 26;
    const virtualW = vw;
    const virtualH = Math.max(960, Math.round(vh * MOBILE_ERA_SCREENS));
    const bankW = Math.max(150, virtualW - leftGutter - padR);
    const usableH = Math.max(840, virtualH - padT - padB);

    const rawHeights = eraList.map((er) => {
      const cnt = (byEra.get(er.id) || []).length;
      return dense ? (32 + Math.pow(cnt, 0.65) * 16) : 90;
    });
    const rawSumH = rawHeights.reduce((a, b) => a + b, 0) || 1;
    const heights = rawHeights.map((h) => (h / rawSumH) * usableH);

    let cursorY = padT;
    eraList.forEach((er, idx) => {
      const list = byEra.get(er.id) || [];
      const rowH = heights[idx];
      const y0 = cursorY;
      cursorY += rowH;
      const cy = y0 + rowH * 0.5;
      const padInY = Math.min(12, rowH * 0.16);
      const innerH = Math.max(10, rowH - padInY * 2);

      list.forEach((t, ti) => {
        const en = energyNorm(t);
        const jitterX = (hashFrac(t.id + "_mx") - 0.5) * 34;
        const slotFrac = list.length > 1 ? (ti + 0.5) / list.length : 0.5;
        const hashY = hashFrac(t.id + "_my");
        const yFrac = slotFrac * 0.68 + hashY * 0.32;
        const px = Math.max(leftGutter + 10, Math.min(virtualW - padR, leftGutter + en * bankW + jitterX));
        const py = Math.max(y0 + padInY, Math.min(y0 + rowH - padInY, y0 + padInY + yFrac * innerH));
        coords.set(t.id, { x: px, y: py, era: er.id, idx: ti });
      });

      const minDist = dense
        ? Math.max(14, Math.min(26, Math.sqrt((bankW * rowH) / Math.max(1, list.length)) * 0.56))
        : 22;
      for (let iter = 0; iter < 28; iter++) {
        for (let i = 0; i < list.length; i++) {
          const a = coords.get(list[i].id);
          for (let j = i + 1; j < list.length; j++) {
            const b = coords.get(list[j].id);
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let dist = Math.hypot(dx, dy);
            if (dist < 0.01) { dx = 0.5; dy = 1; dist = 1.12; }
            if (dist < minDist) {
              const push = (minDist - dist) * 0.5;
              const ux = (dx / dist) * push * 0.86;
              const uy = (dy / dist) * push * 0.82;
              a.x = Math.max(leftGutter + 10, Math.min(virtualW - padR, a.x - ux));
              b.x = Math.max(leftGutter + 10, Math.min(virtualW - padR, b.x + ux));
              a.y = Math.max(y0 + padInY, Math.min(y0 + rowH - padInY, a.y - uy));
              b.y = Math.max(y0 + padInY, Math.min(y0 + rowH - padInY, b.y + uy));
            }
          }
        }
      }

      const meanX = list.length
        ? list.reduce((acc, t) => acc + coords.get(t.id).x, 0) / list.length
        : leftGutter + bankW * 0.48;
      const yearObj = YEAR_MARKERS.find((ym) => ym.eraId === er.id);
      bands.push({
        id: er.id,
        idx,
        label: er.label,
        shortLabel: er.shortLabel || er.label,
        sublabel: er.sublabel || "",
        yearMark: yearObj ? yearObj.year : "",
        x: 0,
        y: y0,
        w: virtualW,
        h: rowH,
        cx: meanX,
        cy,
        count: list.length,
      });
    });

    const spine = bands.filter((b) => b.count > 0).map((b) => ({ x: b.cx, y: b.cy, id: b.id }));
    return {
      isMobile: true,
      leftGutter,
      virtualW,
      virtualH,
      bands,
      spine,
      coords,
      eraIndexById,
      defaultZoom: { k: 1, x: 0, y: 0 },
    };
  }

  function traceSpline(ctx, pts, isMobile) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      if (!isMobile) {
        const mx = (p0.x + p1.x) * 0.5;
        ctx.bezierCurveTo(mx, p0.y, mx, p1.y, p1.x, p1.y);
      } else {
        const my = (p0.y + p1.y) * 0.5;
        ctx.bezierCurveTo(p0.x, my, p1.x, my, p1.x, p1.y);
      }
    }
  }

  function drawCanvasBackground(ctx, data, zoom, colors, activeEraId, selectedTrack) {
    if (!data) return;
    ctx.save();
    ctx.translate(zoom.x, zoom.y);
    ctx.scale(zoom.k, zoom.k);

    // Subtle alternating tonal era bands
    const selEraKey = selectedTrack ? eraKeyOf(selectedTrack) : null;
    data.bands.forEach((b) => {
      const isAct = activeEraId === b.id || selEraKey === b.id;
      if (b.idx % 2 === 1 || isAct) {
        ctx.save();
        ctx.globalAlpha = isAct ? 0.65 : 0.38;
        ctx.fillStyle = isAct ? colors.bandActive : colors.bandAlt;
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.restore();
      }
    });

    // Whisper-quiet energy guide lines
    ctx.save();
    ctx.strokeStyle = colors.gridLine;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1 / Math.max(0.5, zoom.k);
    if (!data.isMobile) {
      [0.24, 0.52, 0.8].forEach((f) => {
        const y = data.virtualH * f;
        ctx.beginPath();
        ctx.moveTo(28, y);
        ctx.lineTo(data.virtualW - 28, y);
        ctx.stroke();
      });
      ctx.globalAlpha = 0.13;
      data.bands.forEach((b, idx) => {
        if (idx === 0) return;
        ctx.beginPath();
        ctx.moveTo(b.x, 56);
        ctx.lineTo(b.x, data.virtualH - 22);
        ctx.stroke();
      });
    } else {
      const leftGutter = data.leftGutter || 94;
      [0.25, 0.55, 0.85].forEach((f) => {
        const x = leftGutter + (data.virtualW - leftGutter - 18) * f;
        ctx.beginPath();
        ctx.moveTo(x, 54);
        ctx.lineTo(x, data.virtualH - 16);
        ctx.stroke();
      });
      ctx.globalAlpha = 0.14;
      data.bands.forEach((b) => {
        ctx.beginPath();
        ctx.moveTo(8, b.y);
        ctx.lineTo(data.virtualW - 12, b.y);
        ctx.stroke();
      });
    }
    ctx.restore();

    // Organic cubic Bezier chronological energy-wave spine
    if (data.spine.length >= 2) {
      ctx.save();
      traceSpline(ctx, data.spine, data.isMobile);
      ctx.strokeStyle = colors.spineGlow;
      ctx.lineWidth = 10 / Math.max(0.6, zoom.k);
      ctx.lineCap = "round";
      ctx.globalAlpha = 0.16;
      ctx.stroke();

      traceSpline(ctx, data.spine, data.isMobile);
      ctx.strokeStyle = colors.primary;
      ctx.lineWidth = 2.2 / Math.max(0.6, zoom.k);
      ctx.globalAlpha = 0.44;
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();

    // Subtle screen-space right-edge vertical scroll thumb on 3-screen mobile Era view
    if (data.isMobile && colors.viewportH && data.virtualH * zoom.k > colors.viewportH + 24) {
      const vhScreen = colors.viewportH;
      const vwScreen = data.virtualW;
      const slackY = Number(colors.panSlackY) || 0;
      const cardTopY = Number.isFinite(colors.visiblePlayerTopY) ? colors.visiblePlayerTopY : vhScreen;
      const maxScroll = Math.max(1, data.virtualH * zoom.k + slackY - vhScreen);
      const prog = Math.max(0, Math.min(1, -zoom.y / maxScroll));
      const trackTop = 58;
      const trackBot = Math.max(trackTop + 56, Math.min(vhScreen - 16, cardTopY - 12));
      const trackLen = trackBot - trackTop;
      const visRatio = Math.max(0.08, Math.min(0.45, vhScreen / (data.virtualH * zoom.k + slackY)));
      const thumbH = Math.max(22, Math.round(trackLen * visRatio));
      const thumbY = trackTop + prog * (trackLen - thumbH);

      ctx.save();
      ctx.fillStyle = colors.gridLine;
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(vwScreen - 5.5, trackTop, 2.5, trackLen, 2);
      else ctx.rect(vwScreen - 5.5, trackTop, 2.5, trackLen);
      ctx.fill();

      ctx.fillStyle = colors.primary;
      ctx.globalAlpha = 0.56;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(vwScreen - 6, thumbY, 3.5, thumbH, 2);
      else ctx.rect(vwScreen - 6, thumbY, 3.5, thumbH);
      ctx.fill();
      ctx.restore();
    } else if (!data.isMobile && colors.viewportW && colors.viewportH && data.virtualW * zoom.k > colors.viewportW + 24) {
      // Subtle screen-space bottom-edge horizontal scroll thumb on ~2.45-screen desktop Era view (clearing player card)
      const vwScreen = colors.viewportW;
      const vhScreen = colors.viewportH;
      const slackX = Number(colors.panSlackX) || 0;
      const cardLeftX = Number.isFinite(colors.visiblePlayerLeftX) ? colors.visiblePlayerLeftX : vwScreen;
      const maxScrollX = Math.max(1, data.virtualW * zoom.k + slackX - vwScreen);
      const progX = Math.max(0, Math.min(1, -zoom.x / maxScrollX));
      const trackLeft = 24;
      const trackRight = Math.max(trackLeft + 120, Math.min(vwScreen - 24, cardLeftX - 18));
      const trackLen = trackRight - trackLeft;
      const visRatio = Math.max(0.08, Math.min(0.55, vwScreen / (data.virtualW * zoom.k + slackX)));
      const thumbW = Math.max(36, Math.round(trackLen * visRatio));
      const thumbX = trackLeft + progX * (trackLen - thumbW);

      ctx.save();
      ctx.fillStyle = colors.gridLine;
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(trackLeft, vhScreen - 12, trackLen, 2.5, 2);
      else ctx.rect(trackLeft, vhScreen - 12, trackLen, 2.5);
      ctx.fill();

      ctx.fillStyle = colors.primary;
      ctx.globalAlpha = 0.58;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(thumbX, vhScreen - 12.5, thumbW, 3.5, 2);
      else ctx.rect(thumbX, vhScreen - 12.5, thumbW, 3.5);
      ctx.fill();
      ctx.restore();
    }
  }

  function renderOverlay(svgGroup, data, zoom, vw, vh, activeEraId, onEraSelect) {
    if (!svgGroup || !data) return;
    const NS = "http://www.w3.org/2000/svg";
    svgGroup.innerHTML = "";

    data.bands.forEach((b) => {
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "era-spine-hit" + (activeEraId === b.id ? " is-active" : ""));

      const sx = b.x * zoom.k + zoom.x;
      const sy = b.y * zoom.k + zoom.y;
      const sw = b.w * zoom.k;
      const sh = b.h * zoom.k;

      if (!data.isMobile) {
        if (sx + sw < 12 || sx > vw - 12) return;
        const headerY = Math.max(78, Math.min(114, sy + 84));

        let displayLbl = sw < 84 ? b.shortLabel : b.label;
        if (sw < 88 && b.yearMark) {
          displayLbl = displayLbl.replace(/\s*'\d{2}$/, "");
        }
        if (sw < 78) {
          displayLbl = displayLbl.replace(/\s*&\s*/g, "/");
        }

        const yrText = sw >= 104 ? (b.sublabel || b.yearMark || "") : (b.yearMark || b.sublabel || "");
        const showYr = Boolean(yrText && yrText !== displayLbl && yrText !== b.label);
        const lblW = displayLbl.length * (sw < 68 ? 5.8 : 6.7) + 14;
        const yrW = showYr ? yrText.length * 5.8 + 12 : 0;
        const pillW = Math.max(38, Math.min(sw - 10, Math.max(lblW, yrW)));
        const pillHalf = pillW * 0.5;

        const visLeft = Math.max(12, sx);
        const visRight = Math.min(vw - 12, sx + sw);
        const visW = visRight - visLeft;
        const minVisW = pillW + 4;
        if (visW <= minVisW) return;

        const fullVisW = Math.max(minVisW + 6, Math.min(sw - 2, pillW + 28));
        const tEdge = Math.max(0, Math.min(1, (visW - minVisW) / Math.max(1, fullVisW - minVisW)));
        const edgeAlpha = tEdge * tEdge * (3 - 2 * tEdge);
        if (edgeAlpha < 0.02) return;

        const minCx = visLeft + pillHalf + 2;
        const maxCx = Math.max(minCx, visRight - pillHalf - 2);
        const cx = Math.max(minCx, Math.min(maxCx, sx + sw * 0.5));

        if (edgeAlpha < 0.999) {
          g.style.opacity = edgeAlpha.toFixed(3);
          if (edgeAlpha < 0.25) g.style.pointerEvents = "none";
        }

        // Year / era date range along the top wave header (skip when identical to column label, e.g. '2026' or '2024–25')
        if (showYr) {
          const yr = document.createElementNS(NS, "text");
          yr.setAttribute("class", "era-tick-year");
          yr.setAttribute("x", cx.toFixed(1));
          yr.setAttribute("y", (headerY - 12).toFixed(1));
          yr.setAttribute("text-anchor", "middle");
          yr.textContent = yrText;
          g.appendChild(yr);
        }
        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("class", "map-family-hit");
        rect.setAttribute("x", (cx - pillHalf).toFixed(1));
        rect.setAttribute("y", (headerY - 6).toFixed(1));
        rect.setAttribute("width", pillW.toFixed(1));
        rect.setAttribute("height", "24");
        rect.setAttribute("rx", "8");

        const txt = document.createElementNS(NS, "text");
        txt.setAttribute("class", "era-wave-title");
        if (sw < 66) txt.setAttribute("style", "font-size:9.5px");
        else if (sw < 82) txt.setAttribute("style", "font-size:10.5px");
        txt.setAttribute("x", cx.toFixed(1));
        txt.setAttribute("y", (headerY + 11).toFixed(1));
        txt.setAttribute("text-anchor", "middle");
        txt.textContent = displayLbl;

        g.append(rect, txt);
      } else {
        // Mobile pinned left-aligned Syne era + Inter year label across the 3-screen vertical scroll
        if (sy + sh < 62 || sy > vh - 8) return;
        const rawCy = sy + sh * 0.5;
        const minCy = Math.min(sy + sh - 16, Math.max(sy + 18, 68));
        const maxCy = Math.max(minCy, sy + sh - 18);
        const cy = Math.max(minCy, Math.min(maxCy, rawCy));
        const compactRow = sh < 38;
        let mobLbl = b.shortLabel;
        if (compactRow && b.yearMark) {
          mobLbl = mobLbl.replace(/\s*'\d{2}$/, "").replace(/\s*&\s*/g, "/");
        }
        const gutterW = (data.leftGutter || 94) - 8;
        const hitRect = document.createElementNS(NS, "rect");
        hitRect.setAttribute("class", "map-family-hit");
        hitRect.setAttribute("x", "4");
        hitRect.setAttribute("y", (cy - 16).toFixed(1));
        hitRect.setAttribute("width", String(gutterW));
        hitRect.setAttribute("height", compactRow ? "24" : "34");
        hitRect.setAttribute("rx", "8");
        g.appendChild(hitRect);

        const txt = document.createElementNS(NS, "text");
        txt.setAttribute("class", "era-wave-title");
        if (compactRow) txt.setAttribute("style", "font-size:10px");
        txt.setAttribute("x", "10");
        txt.setAttribute("y", (compactRow ? cy + 3.5 : cy - 2).toFixed(1));
        txt.textContent = mobLbl;
        g.appendChild(txt);

        const subText = b.sublabel || b.yearMark || "";
        if (!compactRow && subText && subText !== mobLbl) {
          const sub = document.createElementNS(NS, "text");
          sub.setAttribute("class", "era-tick-year");
          sub.setAttribute("x", "10");
          sub.setAttribute("y", (cy + 12).toFixed(1));
          sub.textContent = subText;
          g.appendChild(sub);
        } else if (compactRow && b.yearMark && b.yearMark !== mobLbl) {
          const yr = document.createElementNS(NS, "text");
          yr.setAttribute("class", "era-tick-year");
          yr.setAttribute("style", "font-size:9px");
          yr.setAttribute("x", String((data.leftGutter || 94) - 8));
          yr.setAttribute("y", (cy + 3.2).toFixed(1));
          yr.setAttribute("text-anchor", "end");
          yr.textContent = "'" + b.yearMark.slice(2);
          g.appendChild(yr);
        }
      }

      g.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (onEraSelect) onEraSelect(b.id);
      });
      svgGroup.appendChild(g);
    });

    const hint = document.createElementNS(NS, "text");
    hint.setAttribute("class", "era-tick-year");
    if (!data.isMobile) {
      hint.setAttribute("x", String(vw - 24));
      hint.setAttribute("y", "35");
      hint.setAttribute("text-anchor", "end");
      hint.textContent = "↑ High energy · ↓ Ambient";
    } else if (vw >= 355) {
      hint.setAttribute("x", String(vw - 12));
      hint.setAttribute("y", "33");
      hint.setAttribute("text-anchor", "end");
      hint.textContent = "Ambient ← → High energy";
    }
    svgGroup.appendChild(hint);
  }

  window.BTMM_TIMELINE_ERA = {
    computeLayout,
    drawCanvasBackground,
    renderOverlay,
  };
})();
