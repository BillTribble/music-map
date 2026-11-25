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

  // Smooth 60fps log-scale zoom inertia constants (~0.885 damping per 16ms frame, exact focal-point lock)
  const TAU_ZOOM_MS = 136;             // exp(-16.67 / 136) = 0.885 damping per 60Hz frame (~240-320ms cushioned stop)
  const ZOOM_IMMEDIATE_BITE = 0.16;    // 16% instant response on wheel tick (0ms latency) + 84% inertial glide
  const MAX_ZOOM_VEL_LOGK_MS = 0.014;  // log-scale velocity cap per ms (~0.23 log-units / frame)
  const MIN_PINCH_LAUNCH_LOGK = 0.0008; // per-16.67ms frame minimum pinch flick speed to launch coast
  const STOP_ZOOM_FRAME_LOGK = 0.0004; // clean rAF stop threshold once |vLogK_per_frame| < 0.0004

  function prefersReducedMotion() {
    return Boolean(
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function createController(opts) {
    const mapWrap = opts.mapWrap;
    let momentumRaf = 0;
    let lastMomentumTs = 0;
    let coastVx = 0;
    let coastVy = 0;
    let coastVelLogK = 0; // log-scale zoom velocity per ms
    let zoomFocalX = 0;
    let zoomFocalY = 0;

    function clampVelocity(vx, vy) {
      const sp = Math.hypot(vx, vy);
      if (sp <= MAX_SPEED || sp === 0) return [vx, vy];
      const scale = MAX_SPEED / sp;
      return [vx * scale, vy * scale];
    }

    function clampZoomVel(vLogK) {
      if (!Number.isFinite(vLogK)) return 0;
      return Math.max(-MAX_ZOOM_VEL_LOGK_MS, Math.min(MAX_ZOOM_VEL_LOGK_MS, vLogK));
    }

    function clampZoom() {
      const zoom = opts.getZoom();
      const [vw, vh] = opts.getViewport();
      const [worldW, worldH] = opts.getWorldSize();
      const [slackX, slackY] = typeof opts.getPanSlack === "function" ? opts.getPanSlack() : [0, 0];
      const minK = Math.max(vw / Math.max(1, worldW), vh / Math.max(1, worldH), MIN_ZOOM);
      zoom.k = Math.max(minK, Math.min(MAX_ZOOM, Number.isFinite(zoom.k) ? zoom.k : MIN_ZOOM));
      const scaledW = worldW * zoom.k;
      const scaledH = worldH * zoom.k;
      const minX = Math.min(0, vw - slackX - scaledW);
      const minY = Math.min(0, vh - slackY - scaledH);
      zoom.x = minX >= -0.5 ? (vw - scaledW) * 0.5 : Math.max(minX, Math.min(0, zoom.x));
      zoom.y = minY >= -0.5 ? (vh - scaledH) * 0.5 : Math.max(minY, Math.min(0, zoom.y));
      if (mapWrap) {
        mapWrap.classList.toggle("is-zoomed", zoom.k > 1.02);
        mapWrap.classList.toggle("is-pannable", minX < -1 || minY < -1);
      }
    }

    function applyLogZoomStep(dLogK, focalX, focalY) {
      if (!Number.isFinite(dLogK) || Math.abs(dLogK) < 1e-7) return false;
      const zoom = opts.getZoom();
      const [vw, vh] = opts.getViewport();
      const [worldW, worldH] = opts.getWorldSize();
      const minK = Math.max(vw / Math.max(1, worldW), vh / Math.max(1, worldH), MIN_ZOOM);
      const prevK = Number.isFinite(zoom.k) && zoom.k > 0 ? zoom.k : minK;
      const nextK = Math.max(minK, Math.min(MAX_ZOOM, prevK * Math.exp(dLogK)));
      if (Math.abs(nextK - prevK) < 1e-6) return false;
      const ratio = nextK / prevK;
      zoom.x = focalX - (focalX - zoom.x) * ratio;
      zoom.y = focalY - (focalY - zoom.y) * ratio;
      zoom.k = nextK;
      return true;
    }

    function stopMomentum() {
      coastVx = 0;
      coastVy = 0;
      coastVelLogK = 0;
      if (momentumRaf && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(momentumRaf);
        momentumRaf = 0;
      }
    }

    function isCoasting() {
      return momentumRaf !== 0;
    }

    function stepMomentum(now) {
      const zoom = opts.getZoom();
      const rawDt = now - lastMomentumTs;
      lastMomentumTs = now;
      const dt = Math.min(64, Math.max(1, rawDt > 0 ? rawDt : 16.67));

      const hasZoom = Math.abs(coastVelLogK * 16.67) >= STOP_ZOOM_FRAME_LOGK;
      const hasPan = Math.hypot(coastVx, coastVy) >= STOP_SPEED;

      if (hasZoom) {
        const zDecay = Math.exp(-dt / TAU_ZOOM_MS);
        const zEffDt = TAU_ZOOM_MS * (1 - zDecay);
        const dLogK = coastVelLogK * zEffDt;
        const movedK = applyLogZoomStep(dLogK, zoomFocalX, zoomFocalY);
        if (!movedK) {
          coastVelLogK = 0;
        } else {
          coastVelLogK *= zDecay;
        }
      } else {
        coastVelLogK = 0;
      }

      if (hasPan) {
        const pDecay = Math.exp(-dt / TAU_INERTIA_MS);
        // Exact analytical integral of v0 * exp(-t / tau) over [0, dt] for true frame-rate independence
        const pEffDt = TAU_INERTIA_MS * (1 - pDecay);
        const prevX = zoom.x;
        const prevY = zoom.y;
        zoom.x += coastVx * pEffDt;
        zoom.y += coastVy * pEffDt;
        clampZoom();
        if (Math.abs(zoom.x - prevX) < 0.005) coastVx = 0;
        if (Math.abs(zoom.y - prevY) < 0.005) coastVy = 0;
        coastVx *= pDecay;
        coastVy *= pDecay;
      } else {
        coastVx = 0;
        coastVy = 0;
        clampZoom();
      }

      opts.onTransform();

      const stillPan = Math.hypot(coastVx, coastVy) >= STOP_SPEED;
      const stillZoom = Math.abs(coastVelLogK * 16.67) >= STOP_ZOOM_FRAME_LOGK;
      if (stillPan || stillZoom) {
        momentumRaf = requestAnimationFrame(stepMomentum);
      } else {
        coastVx = 0;
        coastVy = 0;
        coastVelLogK = 0;
        momentumRaf = 0;
      }
    }

    function ensureMomentumLoop() {
      if (typeof requestAnimationFrame === "undefined") return;
      if (!momentumRaf) {
        lastMomentumTs = performance.now();
        momentumRaf = requestAnimationFrame(stepMomentum);
      }
    }

    function startMomentum(vx0, vy0) {
      stopMomentum();
      if (prefersReducedMotion()) return;
      const zoom = opts.getZoom();
      const [vw, vh] = opts.getViewport();
      const [worldW, worldH] = opts.getWorldSize();
      const [slackX, slackY] = typeof opts.getPanSlack === "function" ? opts.getPanSlack() : [0, 0];
      if (worldW * zoom.k + slackX <= vw + 1 && worldH * zoom.k + slackY <= vh + 1) return;
      if (!Number.isFinite(vx0) || !Number.isFinite(vy0)) return;
      const [clampedVx, clampedVy] = clampVelocity(vx0, vy0);
      if (Math.hypot(clampedVx, clampedVy) < MIN_LAUNCH_SPEED || typeof requestAnimationFrame === "undefined") {
        return;
      }
      coastVx = clampedVx;
      coastVy = clampedVy;
      ensureMomentumLoop();
    }

    function addPanImpulse(dxPx, dyPx) {
      if (prefersReducedMotion() || typeof requestAnimationFrame === "undefined") return;
      coastVelLogK = 0;
      if (dxPx !== 0 && coastVx !== 0 && Math.sign(dxPx) !== Math.sign(coastVx)) coastVx = 0;
      if (dyPx !== 0 && coastVy !== 0 && Math.sign(dyPx) !== Math.sign(coastVy)) coastVy = 0;
      const [nvx, nvy] = clampVelocity(coastVx + dxPx / TAU_INERTIA_MS, coastVy + dyPx / TAU_INERTIA_MS);
      coastVx = nvx;
      coastVy = nvy;
      if (Math.hypot(coastVx, coastVy) >= STOP_SPEED) {
        ensureMomentumLoop();
      }
    }

    function startZoomMomentum(velLogKPerMs, focalX, focalY) {
      if (prefersReducedMotion() || typeof requestAnimationFrame === "undefined") return;
      if (!Number.isFinite(velLogKPerMs)) return;
      const clamped = clampZoomVel(velLogKPerMs);
      if (Math.abs(clamped * 16.67) < STOP_ZOOM_FRAME_LOGK) return;
      coastVx = 0;
      coastVy = 0;
      coastVelLogK = clamped;
      zoomFocalX = focalX;
      zoomFocalY = focalY;
      ensureMomentumLoop();
    }

    function addZoomImpulse(totalLogK, focalX, focalY) {
      if (!Number.isFinite(totalLogK) || Math.abs(totalLogK) < 1e-6) return;
      const clampedTotal = Math.max(-0.65, Math.min(0.65, totalLogK));
      coastVx = 0;
      coastVy = 0;
      if (prefersReducedMotion() || typeof requestAnimationFrame === "undefined") {
        stopMomentum();
        applyLogZoomStep(clampedTotal, focalX, focalY);
        clampZoom();
        opts.onTransform();
        return;
      }
      // Crisp direction reversal: cancel opposing zoom velocity immediately on direction flip
      if (coastVelLogK !== 0 && Math.sign(clampedTotal) !== Math.sign(coastVelLogK)) {
        coastVelLogK = 0;
      }
      const biteLogK = clampedTotal * ZOOM_IMMEDIATE_BITE;
      const glideLogK = clampedTotal * (1 - ZOOM_IMMEDIATE_BITE);
      const movedNow = applyLogZoomStep(biteLogK, focalX, focalY);
      clampZoom();
      opts.onTransform();

      zoomFocalX = focalX;
      zoomFocalY = focalY;
      if (movedNow || Math.abs(biteLogK) > 1e-5) {
        coastVelLogK = clampZoomVel(coastVelLogK + glideLogK / TAU_ZOOM_MS);
        if (Math.abs(coastVelLogK * 16.67) >= STOP_ZOOM_FRAME_LOGK) {
          ensureMomentumLoop();
        }
      }
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
      let pinchLastTs = 0;
      let pinchLastMoveTs = 0;
      let pinchEwmaVelLogK = 0;
      let pinchCarryLogK = 0;
      let hasPinchVel = false;
      let lastTapTs = 0;
      let lastTapXY = [0, 0];
      let suppressClickUntil = 0;

      function resetVelocityTracker(x, y, now) {
        lastPtrX = x;
        lastPtrY = y;
        lastPtrTs = now;
        lastMoveTs = 0;
        ewmaVx = 0;
        ewmaVy = 0;
        hasVelSample = false;
      }

      function resetPinchTracker(now) {
        pinchLastTs = now;
        pinchLastMoveTs = 0;
        pinchEwmaVelLogK = 0;
        pinchCarryLogK = 0;
        hasPinchVel = false;
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
          resetPinchTracker(now);
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
          const now = performance.now();
          if (pinchPrevDist > 8 && pinchPrevMid && dist > 8) {
            const rawLogStep = Math.log(dist / pinchPrevDist);
            const reduced = prefersReducedMotion();
            const stepLog = reduced ? rawLogStep : (rawLogStep * 0.82 + pinchCarryLogK * 0.5);
            pinchCarryLogK = reduced ? 0 : (rawLogStep * 0.18 + pinchCarryLogK * 0.5);

            const [vw, vh] = opts.getViewport();
            const [worldW, worldH] = opts.getWorldSize();
            const minK = Math.max(vw / Math.max(1, worldW), vh / Math.max(1, worldH), MIN_ZOOM);
            const prevK = zoom.k;
            const nextK = Math.max(minK, Math.min(MAX_ZOOM, prevK * Math.exp(stepLog)));
            const ratio = nextK / prevK;
            zoom.x = mid[0] - (pinchPrevMid[0] - zoom.x) * ratio;
            zoom.y = mid[1] - (pinchPrevMid[1] - zoom.y) * ratio;
            zoom.k = nextK;
            clampZoom();
            opts.onTransform();

            const dt = now - pinchLastTs;
            if (dt > HOLD_CUTOFF_MS) {
              pinchEwmaVelLogK = 0;
              hasPinchVel = false;
            }
            if (dt >= 0.5) {
              const effDt = Math.max(4, dt);
              const instVelLogK = clampZoomVel(rawLogStep / effDt);
              if (!hasPinchVel) {
                pinchEwmaVelLogK = instVelLogK;
                hasPinchVel = Math.abs(rawLogStep) >= 0.0018;
              } else {
                const alpha = 1 - Math.exp(-dt / VEL_EWMA_TAU_MS);
                pinchEwmaVelLogK = clampZoomVel(pinchEwmaVelLogK + alpha * (instVelLogK - pinchEwmaVelLogK));
              }
              if (Math.abs(rawLogStep) >= 0.0018) {
                pinchLastMoveTs = now;
              }
            }
          }
          pinchPrevDist = dist;
          pinchPrevMid = mid;
          pinchLastTs = now;
          return;
        }
        if (dragging) {
          const dx = ev.clientX - sx;
          const dy = ev.clientY - sy;
          const thresh = activePointerType === "touch" ? DRAG_TOUCH_PX : DRAG_MOUSE_PX;
          if (!moved && Math.hypot(dx, dy) > thresh) {
            stopMomentum();
            moved = true;
            zx = zoom.x - dx;
            zy = zoom.y - dy;
            const [vw, vh] = opts.getViewport();
            const [wW, wH] = opts.getWorldSize();
            const [slackX, slackY] = typeof opts.getPanSlack === "function" ? opts.getPanSlack() : [0, 0];
            if (wW * zoom.k + slackX > vw + 1 || wH * zoom.k + slackY > vh + 1) {
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
        const wasPinching = activePointers.size === 2;
        activePointers.delete(ev.pointerId);

        if (wasPinching) {
          suppressClickUntil = now + 280;
          if (
            ev.type !== "pointercancel" &&
            !prefersReducedMotion() &&
            hasPinchVel &&
            pinchLastMoveTs > 0 &&
            pinchPrevMid
          ) {
            const idleMs = now - pinchLastMoveTs;
            if (idleMs <= HOLD_CUTOFF_MS) {
              const releaseAtten = idleMs > 18 ? Math.exp(-(idleMs - 18) / TAU_ZOOM_MS) : 1;
              const launchVelLogK = pinchEwmaVelLogK * releaseAtten;
              if (Math.abs(launchVelLogK * 16.67) >= MIN_PINCH_LAUNCH_LOGK) {
                startZoomMomentum(launchVelLogK, pinchPrevMid[0], pinchPrevMid[1]);
              }
            }
          }
          resetPinchTracker(now);
          if (activePointers.size === 1) {
            const rem = [...activePointers.values()][0];
            dragging = true;
            moved = false;
            sx = rem.x;
            sy = rem.y;
            zx = zoom.x;
            zy = zoom.y;
            resetVelocityTracker(rem.x, rem.y, now);
            return;
          }
          dragging = false;
          mapWrap.classList.remove("is-dragging");
          return;
        }

        if (activePointers.size === 1) {
          const rem = [...activePointers.values()][0];
          dragging = true;
          moved = false;
          sx = rem.x;
          sy = rem.y;
          zx = zoom.x;
          zy = zoom.y;
          resetVelocityTracker(rem.x, rem.y, now);
          return;
        }
        if (dragging && moved) {
          suppressClickUntil = now + 260;
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
        if (performance.now() < suppressClickUntil) {
          suppressClickUntil = 0;
          ev.stopPropagation();
          ev.preventDefault();
        }
      }, true);

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
        const zoom = opts.getZoom();
        const [vw, vh] = opts.getViewport();
        const [worldW, worldH] = opts.getWorldSize();
        const [slackX, slackY] = typeof opts.getPanSlack === "function" ? opts.getPanSlack() : [0, 0];
        const canPanWorld = zoom.k > 1.005 || worldW * zoom.k + slackX > vw + 1 || worldH * zoom.k + slackY > vh + 1;
        const preferWheelScroll = typeof opts.preferWheelScroll === "function" ? opts.preferWheelScroll() : (vw <= 800);
        const [px, py] = pointerLocalXY(ev);
        const isZoomGesture = ev.ctrlKey || ev.metaKey;
        if (!isZoomGesture && canPanWorld && (preferWheelScroll || ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY))) {
          const mult = ev.deltaMode === 1 ? 18 : ev.deltaMode === 2 ? vh * 0.85 : 1;
          const dx = (ev.shiftKey && Math.abs(ev.deltaX) < 0.5) ? ev.deltaY * mult : ev.deltaX * mult;
          const dy = (ev.shiftKey && Math.abs(ev.deltaX) < 0.5) ? 0 : ev.deltaY * mult;
          if ((ev.shiftKey || ev.deltaMode === 1) && !prefersReducedMotion()) {
            zoom.x -= dx * 0.35;
            zoom.y -= dy * 0.35;
            clampZoom();
            opts.onTransform();
            addPanImpulse(-dx * 0.65, -dy * 0.65);
          } else {
            stopMomentum();
            zoom.x -= dx;
            zoom.y -= dy;
            clampZoom();
            opts.onTransform();
          }
          return;
        }
        const multZoom = ev.deltaMode === 1 ? 18 : ev.deltaMode === 2 ? 120 : 1;
        const dLogTotal = -ev.deltaY * multZoom * (isZoomGesture ? 0.008 : 0.0024);
        addZoomImpulse(dLogTotal, px, py);
      }, { passive: false });
    }

    return {
      clampZoom,
      stopMomentum,
      startMomentum,
      startZoomMomentum,
      addZoomImpulse,
      isCoasting,
      getVelocity: () => ({
        vx: coastVx,
        vy: coastVy,
        speed: Math.hypot(coastVx, coastVy),
        vLogK: coastVelLogK * 16.67,
        vLogKPerMs: coastVelLogK,
        zoomSpeed: Math.abs(coastVelLogK * 16.67),
        focalX: zoomFocalX,
        focalY: zoomFocalY,
      }),
      bind,
    };
  }

  window.BTMM_MAP_PHYSICS = { createController };
})();
