// Browser-Native Surface Theming Controller (BillSkill Pillar 2.5)
// - Defaults to 'auto' mode (following OS/browser prefers-color-scheme: dark | light)
// - One-time v2 storage migration resets legacy 2-state manual locks from btmm.theme / me.theme
// - Top-bar #theme-toggle-btn cycles: auto (brightness_auto) -> dark (dark_mode) -> light (light_mode)
// - Live OS prefers-color-scheme change listener + Settings popover [data-set-theme] two-way sync
(function () {
  "use strict";

  var THEME_KEY = "btmm.theme";
  var MIGRATION_KEY = "btmm.theme_v2";
  var VALID_MODES = { auto: true, dark: true, light: true };

  var mqlDark = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
  var mqlLight = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: light)")
    : null;

  // Retain MediaQueryList references on window so WebKit/Blink never GC active 'change' listeners.
  if (typeof window !== "undefined") {
    window.__BTMM_THEME_MQL__ = [mqlDark, mqlLight];
  }

  function normalizeMode(raw) {
    return raw && VALID_MODES[raw] ? raw : "auto";
  }

  function readSavedMode() {
    try {
      if (localStorage.getItem(MIGRATION_KEY) !== "1") {
        localStorage.removeItem(THEME_KEY);
        localStorage.removeItem("me.theme");
        localStorage.setItem(MIGRATION_KEY, "1");
        localStorage.setItem(THEME_KEY, "auto");
        return "auto";
      }
      return normalizeMode(localStorage.getItem(THEME_KEY));
    } catch (_) {
      return "auto";
    }
  }

  function resolveAutoTheme() {
    if (typeof document !== "undefined") {
      try {
        var rootCls = document.documentElement.classList;
        var bodyCls = document.body ? document.body.classList : null;
        var vscodeKind = document.body ? (document.body.getAttribute("data-vscode-theme-kind") || "") : "";
        if (rootCls.contains("dark") || (bodyCls && bodyCls.contains("dark")) || vscodeKind.indexOf("dark") !== -1) {
          return "dark";
        }
        if (rootCls.contains("light") || (bodyCls && bodyCls.contains("light")) || vscodeKind.indexOf("light") !== -1) {
          return "light";
        }
      } catch (_) {}

      try {
        if (window.parent && window.parent !== window && window.parent.document) {
          var parentTheme = window.parent.document.documentElement.getAttribute("data-theme");
          if (parentTheme === "dark" || parentTheme === "light") return parentTheme;
        }
      } catch (_) {}
    }

    if (mqlDark && mqlDark.matches) return "dark";
    return "light";
  }

  var currentMode = readSavedMode();
  var currentResolved = currentMode === "auto" ? resolveAutoTheme() : currentMode;
  var isApplying = false;

  var appTest = typeof window !== "undefined" ? window.__APP_TEST__ : null;
  var origAppApplyTheme = appTest && typeof appTest.applyTheme === "function"
    ? appTest.applyTheme
    : null;

  function syncToggleButton(mode, resolved) {
    if (typeof document === "undefined") return;
    var btn = document.getElementById("theme-toggle-btn");
    if (!btn) return;
    var icon = document.getElementById("theme-toggle-icon") || btn.querySelector(".ms");

    var iconName = "brightness_auto";
    var label = "Theme: Auto (system)";
    if (mode === "dark") {
      iconName = "dark_mode";
      label = "Theme: Dark";
    } else if (mode === "light") {
      iconName = "light_mode";
      label = "Theme: Light";
    }

    if (icon) icon.textContent = iconName;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("data-theme-mode", mode);
    btn.setAttribute("data-resolved-theme", resolved);

    document.querySelectorAll("[data-set-theme]").forEach(function (pill) {
      var active = pill.getAttribute("data-set-theme") === mode;
      pill.classList.toggle("is-active", active);
      pill.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function applyThemeMode(nextMode, opts) {
    if (isApplying) return currentResolved;
    isApplying = true;
    try {
      var mode = normalizeMode(nextMode);
      var persist = !opts || opts.persist !== false;
      currentMode = mode;

      if (persist) {
        try {
          localStorage.setItem(MIGRATION_KEY, "1");
          localStorage.setItem(THEME_KEY, mode);
        } catch (_) {}
      }

      if (origAppApplyTheme) {
        try { origAppApplyTheme(mode); } catch (_) {}
      }

      var resolved = mode === "auto" ? resolveAutoTheme() : mode;
      currentResolved = resolved;

      if (appTest && appTest.state) {
        appTest.state.themeMode = mode;
        appTest.state.resolvedTheme = resolved;
      }

      if (typeof document !== "undefined") {
        document.documentElement.setAttribute("data-theme", resolved);
        document.documentElement.setAttribute("data-theme-mode", mode);
        document.documentElement.style.colorScheme = resolved;
      }

      syncToggleButton(mode, resolved);

      if (typeof window !== "undefined") {
        if (window.ME_NODEMAP && typeof window.ME_NODEMAP.refreshTheme === "function") {
          window.ME_NODEMAP.refreshTheme();
        }
        if (window.BTMM_PLAYER && typeof window.BTMM_PLAYER.render === "function") {
          window.BTMM_PLAYER.render();
        }
        try {
          window.dispatchEvent(new CustomEvent("btmm:themechange", {
            detail: { mode: mode, resolved: resolved },
          }));
        } catch (_) {}
      }

      return resolved;
    } finally {
      isApplying = false;
    }
  }

  function cycleThemeMode() {
    var next = currentMode === "auto"
      ? "dark"
      : currentMode === "dark"
        ? "light"
        : "auto";
    return applyThemeMode(next);
  }

  function bindMediaQuery(mql, handler) {
    if (!mql) return;
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handler);
    } else if (typeof mql.addListener === "function") {
      mql.addListener(handler);
    }
  }

  function handleSystemThemeChange() {
    if (currentMode === "auto") {
      applyThemeMode("auto", { persist: false });
    }
  }

  // Expose unified API and keep window.__APP_TEST__.applyTheme synced.
  if (appTest) {
    appTest.applyTheme = function (mode) {
      return applyThemeMode(mode);
    };
  }

  if (typeof window !== "undefined") {
    window.BTMM_THEME = {
      getMode: function () { return currentMode; },
      getResolved: function () { return currentResolved; },
      setMode: function (mode) { return applyThemeMode(mode); },
      cycle: cycleThemeMode,
      refresh: handleSystemThemeChange,
    };
  }

  if (typeof document !== "undefined") {
    var toggleBtn = document.getElementById("theme-toggle-btn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", function () {
        cycleThemeMode();
      });
    }

    var settingsPop = document.getElementById("settings-popover");
    if (settingsPop) {
      settingsPop.addEventListener("click", function (ev) {
        var tBtn = ev.target && ev.target.closest ? ev.target.closest("[data-set-theme]") : null;
        if (tBtn) {
          applyThemeMode(tBtn.getAttribute("data-set-theme"));
        }
      });
    }

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) handleSystemThemeChange();
    });
  }

  if (typeof window !== "undefined") {
    bindMediaQuery(mqlDark, handleSystemThemeChange);
    bindMediaQuery(mqlLight, handleSystemThemeChange);
    window.addEventListener("focus", handleSystemThemeChange);
  }

  applyThemeMode(currentMode, { persist: false });
})();
