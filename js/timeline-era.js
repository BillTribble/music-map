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

  function computeLayout(tracks, eras, erasById, vw, vh) {
    const isMobile = vw <= 800;
    const eraList = (eras && eras.length) ? eras : [...erasById.values()];
    const eraIndexById = new Map(eraList.map((e, i) => [e.id, i]));
    const byEra = new Map(eraList.map((e) => [e.id, []]));
    (tracks || []).forEach((t) => {
      if (!byEra.has(t.era)) byEra.set(t.era, []);
      byEra.get(t.era).push(t);
    });

    const dense = (tracks || []).length > 140;
    const coords = new Map();
    const bands = [];

    if (!isMobile) {
      // Desktop: Left -> Right proportional chronological wave, Y = Sonic Energy & Intensity
      const padL = 56;
      const padR = 56;
      const padT = 114; // clears top-left HUD + top era headings + year ticks
      const padB = 46;
      const virtualH = Math.max(580, vh);
      const waveH = Math.max(280, virtualH - padT - padB);

      const widths = eraList.map((er) => {
        const cnt = (byEra.get(er.id) || []).length;
        return dense
          ? Math.max(108, Math.min(360, Math.round(78 + Math.sqrt(cnt) * 23)))
          : Math.max(115, Math.round((Math.max(vw, 1840) - padL - padR) / Math.max(1, eraList.length)));
      });
      const totalColsW = widths.reduce((a, b) => a + b, 0);
      const virtualW = Math.max(vw, padL + padR + totalColsW);

      let cursorX = padL;
      eraList.forEach((er, idx) => {
        const list = byEra.get(er.id) || [];
        const colW = widths[idx];
        const x0 = cursorX;
        cursorX += colW;
        const cx = x0 + colW * 0.5;
        const padInX = 14;

        list.forEach((t, ti) => {
          const en = energyNorm(t);
          const jitterX = (hashFrac(t.id + "_x") - 0.5) * Math.max(24, colW - padInX * 2.5);
          const jitterY = (hashFrac(t.id + "_y") - 0.5) * 28;
          const px = Math.max(x0 + padInX, Math.min(x0 + colW - padInX, cx + jitterX));
          const py = Math.max(padT + 8, Math.min(virtualH - padB - 8, padT + (1 - en) * waveH + jitterY));
          coords.set(t.id, { x: px, y: py, era: er.id, idx: ti });
        });

        // Micro-swarm collision repulsion (>= 18px center spacing at 1.0x)
        const minDist = dense ? 19 : 22;
        for (let iter = 0; iter < 22; iter++) {
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
                const uy = (dy / dist) * push * 0.78;
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
      const fitK = Math.max(0.28, Math.min(1.0, (vw - 24) / virtualW));
      return {
        isMobile: false,
        virtualW,
        virtualH,
        bands,
        spine,
        coords,
        eraIndexById,
        defaultZoom: {
          k: fitK,
          x: Math.max(8, (vw - virtualW * fitK) * 0.5),
          y: Math.max(0, (vh - virtualH * fitK) * 0.5),
        },
      };
    }

    // Mobile (<= 800px): Top -> Bottom proportional chronological Y-axis, X = Sonic Energy & Groove Tension
    const leftGutter = 110;
    const padR = 18;
    const padT = 76;
    const padB = 90;
    const bankW = Math.max(150, vw - leftGutter - padR);

    const heights = eraList.map((er) => {
      const cnt = (byEra.get(er.id) || []).length;
      return dense
        ? Math.max(84, Math.min(460, Math.round(64 + Math.sqrt(cnt) * 28)))
        : 108;
    });
    const totalRowsH = heights.reduce((a, b) => a + b, 0);
    const virtualW = vw;
    const virtualH = Math.max(vh, padT + padB + totalRowsH);

    let cursorY = padT;
    eraList.forEach((er, idx) => {
      const list = byEra.get(er.id) || [];
      const rowH = heights[idx];
      const y0 = cursorY;
      cursorY += rowH;
      const cy = y0 + rowH * 0.5;
      const padInY = 14;

      list.forEach((t, ti) => {
        const en = energyNorm(t);
        const jitterX = (hashFrac(t.id + "_mx") - 0.5) * 32;
        const jitterY = (hashFrac(t.id + "_my") - 0.5) * Math.max(22, rowH - padInY * 2.5);
        const px = Math.max(leftGutter + 12, Math.min(virtualW - padR, leftGutter + en * bankW + jitterX));
        const py = Math.max(y0 + padInY, Math.min(y0 + rowH - padInY, cy + jitterY));
        coords.set(t.id, { x: px, y: py, era: er.id, idx: ti });
      });

      // >= 22px center spacing for effortless thumb tapping
      const minDist = dense ? 22 : 24;
      for (let iter = 0; iter < 22; iter++) {
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
              const ux = (dx / dist) * push * 0.78;
              const uy = (dy / dist) * push;
              a.x = Math.max(leftGutter + 12, Math.min(virtualW - padR, a.x - ux));
              b.x = Math.max(leftGutter + 12, Math.min(virtualW - padR, b.x + ux));
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
    data.bands.forEach((b) => {
      const isAct = activeEraId === b.id || (selectedTrack && selectedTrack.era === b.id);
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
      const leftGutter = 110;
      [0.25, 0.55, 0.85].forEach((f) => {
        const x = leftGutter + (data.virtualW - leftGutter - 18) * f;
        ctx.beginPath();
        ctx.moveTo(x, 60);
        ctx.lineTo(x, data.virtualH - 40);
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

        const pillW = Math.min(Math.max(66, sw - 6), (b.shortLabel.length * 7.2) + 18);
        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("class", "map-group-pill");
        rect.setAttribute("x", (cx - pillW * 0.5).toFixed(1));
        rect.setAttribute("y", (headerY - 4).toFixed(1));
        rect.setAttribute("width", pillW.toFixed(1));
        rect.setAttribute("height", "24");
        rect.setAttribute("rx", "12");

        const txt = document.createElementNS(NS, "text");
        txt.setAttribute("class", "era-wave-title");
        txt.setAttribute("x", cx.toFixed(1));
        txt.setAttribute("y", (headerY + 12).toFixed(1));
        txt.setAttribute("text-anchor", "middle");
        txt.textContent = sw < 130 ? b.shortLabel : b.label;

        g.append(rect, txt);
      } else {
        // Mobile pinned left-aligned Syne era + year label
        const cy = sy + sh * 0.5;
        if (cy < 48 || cy > vh + 40) return;
        const txt = document.createElementNS(NS, "text");
        txt.setAttribute("class", "era-wave-title");
        txt.setAttribute("x", "12");
        txt.setAttribute("y", (cy - 2).toFixed(1));
        txt.textContent = b.shortLabel;

        const sub = document.createElementNS(NS, "text");
        sub.setAttribute("class", "era-tick-year");
        sub.setAttribute("x", "12");
        sub.setAttribute("y", (cy + 13).toFixed(1));
        sub.textContent = b.sublabel || b.yearMark || "";

        g.append(txt, sub);
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
      hint.setAttribute("x", "18");
      hint.setAttribute("y", String(Math.max(134, Math.min(vh - 24, 134))));
      hint.textContent = "↑ High energy";
    } else {
      hint.setAttribute("x", String(vw - 14));
      hint.setAttribute("y", "64");
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
