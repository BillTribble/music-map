// Viewport Bounds Locking, 60fps Inertial Scroll Momentum, Pinch-Zoom & Pointer Gesture Controller
(function () {
  "use strict";

  const DRAG_MOUSE_PX = 8;
  const DRAG_TOUCH_PX = 14;
  const MIN_ZOOM = 1.0;
  const MAX_ZOOM = 6.0;

  function createController(opts) {
    const mapWrap = opts.mapWrap;
    let momentumRaf = 0;

    function clampZoom() {
      const zoom = opts.getZoom();
      const [vw, vh] = opts.getViewport();
      const [worldW, worldH] = opts.getWorldSize();
      const minK = Math.max(vw / Math.max(1, worldW), vh / Math.max(1, worldH), MIN_ZOOM);
      zoom.k = Math.max(minK, Math.min(MAX_ZOOM, Number.isFinite(zoom.k) ? zoom.k : MIN_ZOOM));
      const scaledW = worldW * zoom.k;
      const scaledH = worldH * zoom.k;
      const minX = Math.min(0, vw - scaledW);
      const minY = Math.min(0, vh - scaledH);
      zoom.x = scaledW <= vw + 0.5 ? (vw - scaledW) * 0.5 : Math.max(minX, Math.min(0, zoom.x));
      zoom.y = scaledH <= vh + 0.5 ? (vh - scaledH) * 0.5 : Math.max(minY, Math.min(0, zoom.y));
      if (mapWrap) {
        mapWrap.classList.toggle("is-zoomed", scaledW > vw + 1 || scaledH > vh + 1);
      }
    }

    function stopMomentum() {
      if (momentumRaf && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(momentumRaf);
        momentumRaf = 0;
      }
    }

    function startMomentum(vx0, vy0) {
      stopMomentum();
      const zoom = opts.getZoom();
      const [vw, vh] = opts.getViewport();
      const [worldW, worldH] = opts.getWorldSize();
      if (worldW * zoom.k <= vw + 1 && worldH * zoom.k <= vh + 1) return;
      let vx = Math.max(-3.6, Math.min(3.6, vx0));
      let vy = Math.max(-3.6, Math.min(3.6, vy0));
      if (Math.hypot(vx, vy) < 0.03 || typeof requestAnimationFrame === "undefined") return;
      let lastTs = performance.now();
      function step(now) {
        const dt = Math.min(34, Math.max(1, now - lastTs));
        lastTs = now;
        const prevX = zoom.x;
        const prevY = zoom.y;
        zoom.x += vx * dt;
        zoom.y += vy * dt;
        clampZoom();
        if (Math.abs(zoom.x - prevX) < 0.01) vx = 0;
        if (Math.abs(zoom.y - prevY) < 0.01) vy = 0;
        const decay = Math.exp(-dt / 275);
        vx *= decay;
        vy *= decay;
        opts.onTransform();
        if (Math.hypot(vx, vy) >= 0.012) {
          momentumRaf = requestAnimationFrame(step);
        } else {
          momentumRaf = 0;
        }
      }
      momentumRaf = requestAnimationFrame(step);
    }

    function pointerLocalXY(ev) {
      const rect = mapWrap.getBoundingClientRect();
      return [ev.clientX - rect.left, ev.clientY - rect.top];
    }

    function bind() {
      let dragging = false;
      let moved = false;
      let activePointerType = "mouse";
      let sx = 0, sy = 0, zx = 0, zy = 0;
      let velSamples = [];
      const activePointers = new Map();
      let pinchPrevDist = 0;
      let pinchPrevMid = null;
      let lastTapTs = 0;
      let lastTapXY = [0, 0];

      function pushVelSample(x, y) {
        const now = performance.now();
        velSamples.push({ x, y, t: now });
        while (velSamples.length > 2 && now - velSamples[0].t > 95) velSamples.shift();
      }

      mapWrap.addEventListener("pointerdown", (ev) => {
        if (ev.target.closest("#map-floating-hud")) return;
        if (ev.target.closest(".map-group-label") || ev.target.closest(".era-spine-hit")) return;
        if (ev.button !== 0 && ev.pointerType === "mouse") return;
        stopMomentum();
        const zoom = opts.getZoom();
        activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (activePointers.size === 2) {
          const pts = [...activePointers.values()];
          pinchPrevDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
          const rect = mapWrap.getBoundingClientRect();
          pinchPrevMid = [(pts[0].x + pts[1].x) * 0.5 - rect.left, (pts[0].y + pts[1].y) * 0.5 - rect.top];
          dragging = false;
          moved = true;
          velSamples = [];
          return;
        }
        dragging = true;
        moved = false;
        activePointerType = ev.pointerType || "mouse";
        sx = ev.clientX;
        sy = ev.clientY;
        zx = zoom.x;
        zy = zoom.y;
        velSamples = [];
        pushVelSample(ev.clientX, ev.clientY);
      });

      window.addEventListener("pointermove", (ev) => {
        const zoom = opts.getZoom();
        if (activePointers.has(ev.pointerId)) {
          activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        }
        if (activePointers.size === 2) {
          const pts = [...activePointers.values()];
          const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
          const rect = mapWrap.getBoundingClientRect();
          const mid = [(pts[0].x + pts[1].x) * 0.5 - rect.left, (pts[0].y + pts[1].y) * 0.5 - rect.top];
          if (pinchPrevDist > 8 && pinchPrevMid) {
            const nextK = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom.k * (dist / pinchPrevDist)));
            const ratio = nextK / zoom.k;
            zoom.x = mid[0] - (pinchPrevMid[0] - zoom.x) * ratio;
            zoom.y = mid[1] - (pinchPrevMid[1] - zoom.y) * ratio;
            zoom.k = nextK;
            clampZoom();
            opts.onTransform();
          }
          pinchPrevDist = dist;
          pinchPrevMid = mid;
          return;
        }
        if (dragging) {
          const dx = ev.clientX - sx;
          const dy = ev.clientY - sy;
          const thresh = activePointerType === "touch" ? DRAG_TOUCH_PX : DRAG_MOUSE_PX;
          if (!moved && Math.hypot(dx, dy) > thresh) {
            moved = true;
            const [vw, vh] = opts.getViewport();
            const [wW, wH] = opts.getWorldSize();
            if (wW * zoom.k > vw + 1 || wH * zoom.k > vh + 1) {
              mapWrap.classList.add("is-dragging");
            }
          }
          if (moved) {
            pushVelSample(ev.clientX, ev.clientY);
            zoom.x = zx + dx;
            zoom.y = zy + dy;
            clampZoom();
            opts.onTransform();
          }
          return;
        }
        opts.onHoverMove(ev, pointerLocalXY(ev));
      });

      function finishPointer(ev) {
        const zoom = opts.getZoom();
        activePointers.delete(ev.pointerId);
        if (activePointers.size === 1) {
          const rem = [...activePointers.values()][0];
          dragging = true;
          sx = rem.x;
          sy = rem.y;
          zx = zoom.x;
          zy = zoom.y;
          velSamples = [];
          return;
        }
        if (dragging && moved && velSamples.length >= 2) {
          const first = velSamples[0];
          const last = velSamples[velSamples.length - 1];
          const dt = last.t - first.t;
          if (dt >= 8 && performance.now() - last.t < 85) {
            startMomentum((last.x - first.x) / dt, (last.y - first.y) / dt);
          }
        }
        dragging = false;
        velSamples = [];
        mapWrap.classList.remove("is-dragging");
      }

      window.addEventListener("pointerup", finishPointer);
      window.addEventListener("pointercancel", finishPointer);
      mapWrap.addEventListener("pointerleave", () => opts.onHoverLeave());

      mapWrap.addEventListener("click", (ev) => {
        if (moved) return;
        if (ev.target.closest("#map-floating-hud")) return;
        if (ev.target.closest(".map-group-label") || ev.target.closest(".era-spine-hit")) return;
        const [px, py] = pointerLocalXY(ev);
        const handledNode = opts.onTapPoint(ev, px, py);
        if (handledNode) {
          lastTapTs = 0;
          return;
        }
        const now = performance.now();
        const zoom = opts.getZoom();
        if (now - lastTapTs < 320 && Math.hypot(px - lastTapXY[0], py - lastTapXY[1]) < 36) {
          lastTapTs = 0;
          const nextK = zoom.k > 1.15 ? 1.0 : 2.4;
          const ratio = nextK / zoom.k;
          zoom.x = px - (px - zoom.x) * ratio;
          zoom.y = py - (py - zoom.y) * ratio;
          zoom.k = nextK;
          clampZoom();
          opts.onFullPaint();
          return;
        }
        lastTapTs = now;
        lastTapXY = [px, py];
        opts.onBackgroundTap();
      });

      mapWrap.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        stopMomentum();
        const zoom = opts.getZoom();
        const [px, py] = pointerLocalXY(ev);
        if (!ev.ctrlKey && zoom.k > 1.005 && Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
          zoom.x -= ev.deltaX;
          zoom.y -= ev.deltaY;
          clampZoom();
          opts.onTransform();
          return;
        }
        const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.008 : 0.0022));
        const nextK = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom.k * factor));
        const ratio = nextK / zoom.k;
        zoom.x = px - (px - zoom.x) * ratio;
        zoom.y = py - (py - zoom.y) * ratio;
        zoom.k = nextK;
        clampZoom();
        opts.onTransform();
      }, { passive: false });
    }

    return { clampZoom, stopMomentum, startMomentum, bind };
  }

  window.BTMM_MAP_PHYSICS = { createController };
})();
