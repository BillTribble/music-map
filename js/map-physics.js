// Viewport Bounds Locking, 60fps Inertial Pan Momentum, Pinch-Zoom & Pointer Gesture Controller
(function () {
  "use strict";

  const DRAG_MOUSE_PX = 8;
  const DRAG_TOUCH_PX = 14;
  const MIN_ZOOM = 1.0;
  const MAX_ZOOM = 40.0;

  // Browser-feel kinetic pan physics constants (dt-normalized, refresh-rate agnostic)
  const VEL_EWMA_TAU_MS = 45;     // ~50-80ms effective velocity smoothing window
  const HOLD_CUTOFF_MS = 80;      // stationary > 80ms before pointerup => 0 post-release drift
  const MIN_LAUNCH_SPEED = 0.12;  // px/ms minimum flick speed to start coasting
  const MAX_SPEED = 3.5;          // px/ms radial velocity cap against single-frame spikes
  const TAU_INERTIA_MS = 200;     // exponential friction time constant (crisp tactile glide)
  const STOP_SPEED = 0.05;        // px/ms clean termination threshold (< 0.8px @ 60Hz)

  function createController(opts) {
    const mapWrap = opts.mapWrap;
    let momentumRaf = 0;
    let coastVx = 0;
    let coastVy = 0;

    function clampVelocity(vx, vy) {
      const sp = Math.hypot(vx, vy);
      if (sp <= MAX_SPEED || sp === 0) return [vx, vy];
      const scale = MAX_SPEED / sp;
      return [vx * scale, vy * scale];
    }

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
      coastVx = 0;
      coastVy = 0;
      if (momentumRaf && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(momentumRaf);
        momentumRaf = 0;
      }
    }

    function isCoasting() {
      return momentumRaf !== 0;
    }

    function startMomentum(vx0, vy0) {
      stopMomentum();
      const zoom = opts.getZoom();
      const [vw, vh] = opts.getViewport();
      const [worldW, worldH] = opts.getWorldSize();
      if (worldW * zoom.k <= vw + 1 && worldH * zoom.k <= vh + 1) return;
      if (!Number.isFinite(vx0) || !Number.isFinite(vy0)) return;
      const [clampedVx, clampedVy] = clampVelocity(vx0, vy0);
      if (Math.hypot(clampedVx, clampedVy) < MIN_LAUNCH_SPEED || typeof requestAnimationFrame === "undefined") {
        return;
      }
      coastVx = clampedVx;
      coastVy = clampedVy;
      let lastTs = performance.now();

      function step(now) {
        const rawDt = now - lastTs;
        lastTs = now;
        const dt = Math.min(64, Math.max(1, rawDt > 0 ? rawDt : 16.67));
        const decay = Math.exp(-dt / TAU_INERTIA_MS);
        // Exact analytical integral of v0 * exp(-t / tau) over [0, dt] for true frame-rate independence
        const effDt = TAU_INERTIA_MS * (1 - decay);
        const prevX = zoom.x;
        const prevY = zoom.y;
        zoom.x += coastVx * effDt;
        zoom.y += coastVy * effDt;
        clampZoom();
        if (Math.abs(zoom.x - prevX) < 0.005) coastVx = 0;
        if (Math.abs(zoom.y - prevY) < 0.005) coastVy = 0;
        coastVx *= decay;
        coastVy *= decay;
        opts.onTransform();
        if (Math.hypot(coastVx, coastVy) >= STOP_SPEED) {
          momentumRaf = requestAnimationFrame(step);
        } else {
          coastVx = 0;
          coastVy = 0;
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
      let lastPtrX = 0, lastPtrY = 0, lastPtrTs = 0;
      let lastMoveTs = 0;
      let ewmaVx = 0, ewmaVy = 0;
      let hasVelSample = false;
      const activePointers = new Map();
      let pinchPrevDist = 0;
      let pinchPrevMid = null;
      let lastTapTs = 0;
      let lastTapXY = [0, 0];

      function resetVelocityTracker(x, y, now) {
        lastPtrX = x;
        lastPtrY = y;
        lastPtrTs = now;
        lastMoveTs = 0;
        ewmaVx = 0;
        ewmaVy = 0;
        hasVelSample = false;
      }

      function recordDragStep(x, y) {
        const now = performance.now();
        const dt = now - lastPtrTs;
        const stepDx = x - lastPtrX;
        const stepDy = y - lastPtrY;
        const stepDist = Math.hypot(stepDx, stepDy);

        if (dt > HOLD_CUTOFF_MS) {
          ewmaVx = 0;
          ewmaVy = 0;
          hasVelSample = false;
        }

        if (dt >= 0.5) {
          const effDt = Math.max(4, dt);
          const [instVx, instVy] = clampVelocity(stepDx / effDt, stepDy / effDt);
          if (!hasVelSample) {
            ewmaVx = instVx;
            ewmaVy = instVy;
            hasVelSample = stepDist >= 0.4;
          } else {
            const alpha = 1 - Math.exp(-dt / VEL_EWMA_TAU_MS);
            ewmaVx += alpha * (instVx - ewmaVx);
            ewmaVy += alpha * (instVy - ewmaVy);
            [ewmaVx, ewmaVy] = clampVelocity(ewmaVx, ewmaVy);
          }
        }

        lastPtrX = x;
        lastPtrY = y;
        lastPtrTs = now;
        if (stepDist >= 0.4) {
          lastMoveTs = now;
        }
      }

      mapWrap.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0 && ev.pointerType === "mouse") return;
        stopMomentum();
        if (ev.target.closest("#map-floating-hud")) return;
        if (ev.target.closest(".map-group-label, .map-family-group, .map-ai-sub-group") || ev.target.closest(".era-spine-hit")) return;
        const zoom = opts.getZoom();
        const now = performance.now();
        activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (activePointers.size === 2) {
          const pts = [...activePointers.values()];
          pinchPrevDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
          const rect = mapWrap.getBoundingClientRect();
          pinchPrevMid = [(pts[0].x + pts[1].x) * 0.5 - rect.left, (pts[0].y + pts[1].y) * 0.5 - rect.top];
          dragging = false;
          moved = true;
          resetVelocityTracker(ev.clientX, ev.clientY, now);
          return;
        }
        dragging = true;
        moved = false;
        activePointerType = ev.pointerType || "mouse";
        sx = ev.clientX;
        sy = ev.clientY;
        zx = zoom.x;
        zy = zoom.y;
        resetVelocityTracker(ev.clientX, ev.clientY, now);
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
            recordDragStep(ev.clientX, ev.clientY);
            zoom.x = zx + dx;
            zoom.y = zy + dy;
            clampZoom();
            opts.onTransform();
          } else {
            // Keep pre-threshold pointer baseline fresh so a pause before flicking never dilutes flick velocity
            lastPtrX = ev.clientX;
            lastPtrY = ev.clientY;
            lastPtrTs = performance.now();
          }
          return;
        }
        opts.onHoverMove(ev, pointerLocalXY(ev));
      });

      function finishPointer(ev) {
        const zoom = opts.getZoom();
        const now = performance.now();
        activePointers.delete(ev.pointerId);
        if (activePointers.size === 1) {
          const rem = [...activePointers.values()][0];
          dragging = true;
          sx = rem.x;
          sy = rem.y;
          zx = zoom.x;
          zy = zoom.y;
          resetVelocityTracker(rem.x, rem.y, now);
          return;
        }
        if (ev.type !== "pointercancel" && dragging && moved && hasVelSample && lastMoveTs > 0) {
          const idleMs = now - lastMoveTs;
          if (idleMs <= HOLD_CUTOFF_MS) {
            const releaseAtten = idleMs > 18 ? Math.exp(-(idleMs - 18) / TAU_INERTIA_MS) : 1;
            const launchVx = ewmaVx * releaseAtten;
            const launchVy = ewmaVy * releaseAtten;
            if (Math.hypot(launchVx, launchVy) >= MIN_LAUNCH_SPEED) {
              startMomentum(launchVx, launchVy);
            }
          }
        }
        dragging = false;
        ewmaVx = 0;
        ewmaVy = 0;
        hasVelSample = false;
        mapWrap.classList.remove("is-dragging");
      }

      window.addEventListener("pointerup", finishPointer);
      window.addEventListener("pointercancel", finishPointer);
      mapWrap.addEventListener("pointerleave", () => opts.onHoverLeave());

      mapWrap.addEventListener("click", (ev) => {
        if (moved) return;
        if (ev.target.closest("#map-floating-hud")) return;
        if (ev.target.closest(".map-group-label, .map-family-group, .map-ai-sub-group") || ev.target.closest(".era-spine-hit")) return;
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
          stopMomentum();
          const nextK = zoom.k < 2.2 ? 3.8 : (zoom.k < 6.0 ? 8.0 : 1.0);
          if (nextK === 1.0 && typeof opts.getDefaultZoom === "function") {
            const defZ = opts.getDefaultZoom();
            zoom.k = defZ.k;
            zoom.x = defZ.x;
            zoom.y = defZ.y;
          } else {
            const ratio = nextK / zoom.k;
            zoom.x = px - (px - zoom.x) * ratio;
            zoom.y = py - (py - zoom.y) * ratio;
            zoom.k = nextK;
          }
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
        const [vw, vh] = opts.getViewport();
        const [worldW, worldH] = opts.getWorldSize();
        const canPanWorld = zoom.k > 1.005 || worldW * zoom.k > vw + 1 || worldH * zoom.k > vh + 1;
        const [px, py] = pointerLocalXY(ev);
        if (!ev.ctrlKey && canPanWorld && Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
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

    return {
      clampZoom,
      stopMomentum,
      startMomentum,
      isCoasting,
      getVelocity: () => ({ vx: coastVx, vy: coastVy, speed: Math.hypot(coastVx, coastVy) }),
      bind,
    };
  }

  window.BTMM_MAP_PHYSICS = { createController };
})();
