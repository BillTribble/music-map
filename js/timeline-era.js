// Dedicated Artistic Energy-Wave Timeline Renderer (Horizontal Desktop > 800px / Vertical Mobile <= 800px)
(function () {
  "use strict";

  const YEAR_MARKERS = [
    { eraId: "present_ambient", year: "2001" },
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
      // Desktop: Left -> Right proportional chronological wave fitted 100% inside viewport (vw x vh)
      const padL = 24;
      const padR = 24;
      const padT = 104; // clears top-left HUD + top era headings + year ticks
      const padB = 34;
      const virtualW = vw;
      const virtualH = vh;
      const waveH = Math.max(200, virtualH - padT - padB);
      const usableW = Math.max(480, virtualW - padL - padR);

      const rawWidths = eraList.map((er) => {
        const cnt = (byEra.get(er.id) || []).length;
        return dense ? (34 + Math.sqrt(cnt) * 11) : 100;
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
        const padInX = Math.min(10, colW * 0.16);

        list.forEach((t, ti) => {
          const en = energyNorm(t);
          const jitterX = (hashFrac(t.id + "_x") - 0.5) * Math.max(12, colW - padInX * 2.2);
          const jitterY = (hashFrac(t.id + "_y") - 0.5) * 26;
          const px = Math.max(x0 + padInX, Math.min(x0 + colW - padInX, cx + jitterX));
          const py = Math.max(padT + 8, Math.min(virtualH - padB - 8, padT + (1 - en) * waveH + jitterY));
          coords.set(t.id, { x: px, y: py, era: er.id, idx: ti });
        });

        // Adaptive micro-swarm collision repulsion scaled to column area
        const minDist = dense
          ? Math.max(9.5, Math.min(18, Math.sqrt((colW * waveH) / Math.max(1, list.length)) * 0.46))
          : 20;
        for (let iter = 0; iter < 20; iter++) {
          for (let i = 0; i < list.length; i++) {
            const a = coords.get(list[i].id);
            for (let j = i + 1; j < list.length; j++) {
              const b = coords.get(list[j].id);
              let dx = b.x - a.x;
              let dy = b.y - a.y;
              let dist = Math.hypot(dx, dy);
              if (dist < 0.01) { dx = 1; dy = 0.35; dist = 1.06; }
              if (dist < minDist) {
                const push = (minDist - dist) * 0.48;
                const ux = (dx / dist) * push;
                const uy = (dy / dist) * push * 0.82;
                a.x = Math.max(x0 + padInX, Math.min(x0 + colW - padInX, a.x - ux));
                b.x = Math.max(x0 + padInX, Math.min(x0 + colW - padInX, b.x + ux));
                a.y = Math.max(padT + 6, Math.min(virtualH - padB - 6, a.y - uy));
                b.y = Math.max(padT + 6, Math.min(virtualH - padB - 6, b.y + uy));
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

    // Mobile (<= 800px): Top -> Bottom proportional chronological Y-axis fitted 100% inside viewport (vw x vh)
    const leftGutter = 90;
    const padR = 14;
    const padT = 68;
    const padB = 14;
    const virtualW = vw;
    const virtualH = vh;
    const bankW = Math.max(150, virtualW - leftGutter - padR);
    const usableH = Math.max(320, virtualH - padT - padB);

    const rawHeights = eraList.map((er) => {
      const cnt = (byEra.get(er.id) || []).length;
      return dense ? (18 + Math.sqrt(cnt) * 4.2) : 40;
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
      const padInY = Math.min(7, rowH * 0.18);

      list.forEach((t, ti) => {
        const en = energyNorm(t);
        const jitterX = (hashFrac(t.id + "_mx") - 0.5) * 28;
        const jitterY = (hashFrac(t.id + "_my") - 0.5) * Math.max(8, rowH - padInY * 2.2);
        const px = Math.max(leftGutter + 8, Math.min(virtualW - padR, leftGutter + en * bankW + jitterX));
        const py = Math.max(y0 + padInY, Math.min(y0 + rowH - padInY, cy + jitterY));
        coords.set(t.id, { x: px, y: py, era: er.id, idx: ti });
      });

      const minDist = dense
        ? Math.max(6.8, Math.min(16, Math.sqrt((bankW * rowH) / Math.max(1, list.length)) * 0.48))
        : 16;
      for (let iter = 0; iter < 20; iter++) {
        for (let i = 0; i < list.length; i++) {
          const a = coords.get(list[i].id);
          for (let j = i + 1; j < list.length; j++) {
            const b = coords.get(list[j].id);
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let dist = Math.hypot(dx, dy);
            if (dist < 0.01) { dx = 0.5; dy = 1; dist = 1.12; }
            if (dist < minDist) {
              const push = (minDist - dist) * 0.48;
              const ux = (dx / dist) * push * 0.85;
              const uy = (dy / dist) * push * 0.78;
              a.x = Math.max(leftGutter + 8, Math.min(virtualW - padR, a.x - ux));
              b.x = Math.max(leftGutter + 8, Math.min(virtualW - padR, b.x + ux));
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
        ctx.moveTo(40, y);
        ctx.lineTo(data.virtualW - 40, y);
        ctx.stroke();
      });
    } else {
      const leftGutter = 90;
      [0.25, 0.55, 0.85].forEach((f) => {
        const x = leftGutter + (data.virtualW - leftGutter - 14) * f;
        ctx.beginPath();
        ctx.moveTo(x, 54);
        ctx.lineTo(x, data.virtualH - 14);
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
        if (sx + sw < -80 || sx > vw + 80) return;
        const cx = sx + sw * 0.5;
        const headerY = Math.max(66, Math.min(104, sy + 72));

        // Year marker ticks along the top wave header
        if (b.yearMark) {
          const yr = document.createElementNS(NS, "text");
          yr.setAttribute("class", "era-tick-year");
          yr.setAttribute("x", cx.toFixed(1));
          yr.setAttribute("y", (headerY - 12).toFixed(1));
          yr.setAttribute("text-anchor", "middle");
          yr.textContent = b.yearMark;
          g.appendChild(yr);
        }

        const displayLbl = sw < 130 ? b.shortLabel : b.label;
        const pillW = Math.max(40, Math.min(sw - 4, displayLbl.length * 6.8 + 14));
        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("class", "map-family-hit");
        rect.setAttribute("x", (cx - pillW * 0.5).toFixed(1));
        rect.setAttribute("y", (headerY - 6).toFixed(1));
        rect.setAttribute("width", pillW.toFixed(1));
        rect.setAttribute("height", "24");
        rect.setAttribute("rx", "8");

        const txt = document.createElementNS(NS, "text");
        txt.setAttribute("class", "era-wave-title");
        if (sw < 78) txt.setAttribute("style", "font-size:10.5px");
        txt.setAttribute("x", cx.toFixed(1));
        txt.setAttribute("y", (headerY + 11).toFixed(1));
        txt.setAttribute("text-anchor", "middle");
        txt.textContent = displayLbl;

        g.append(rect, txt);
      } else {
        // Mobile pinned left-aligned Syne era + year label (compact 1-line at 1x, 2-line when zoomed)
        const cy = sy + sh * 0.5;
        if (cy < 48 || cy > vh + 24) return;
        const compactRow = sh < 36;
        const txt = document.createElementNS(NS, "text");
        txt.setAttribute("class", "era-wave-title");
        if (compactRow) txt.setAttribute("style", "font-size:10.5px");
        txt.setAttribute("x", "10");
        txt.setAttribute("y", (compactRow ? cy + 3.5 : cy - 2).toFixed(1));
        txt.textContent = b.shortLabel;
        g.appendChild(txt);

        if (!compactRow) {
          const sub = document.createElementNS(NS, "text");
          sub.setAttribute("class", "era-tick-year");
          sub.setAttribute("x", "10");
          sub.setAttribute("y", (cy + 12).toFixed(1));
          sub.textContent = b.sublabel || b.yearMark || "";
          g.appendChild(sub);
        } else if (b.yearMark) {
          const yr = document.createElementNS(NS, "text");
          yr.setAttribute("class", "era-tick-year");
          yr.setAttribute("style", "font-size:9px");
          yr.setAttribute("x", "84");
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
    } else {
      hint.setAttribute("x", String(vw - 12));
      hint.setAttribute("y", "60");
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
