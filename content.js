(() => {
  "use strict";

  const api = globalThis.chrome || globalThis.browser;
  const ROOT = document.documentElement;

  const pcall = (invoke) =>
    new Promise((resolve) => {
      try {
        const r = invoke(resolve);
        if (r && typeof r.then === "function") r.then(resolve, () => resolve(null));
      } catch (_) {
        resolve(null);
      }
    });

  const sget = (area, defaults) =>
    pcall((cb) => api.storage[area].get(defaults, cb)).then((v) => ({
      ...defaults,
      ...(v || {})
    }));

  function sset(area, obj) {
    try {
      const r = api.storage[area].set(obj);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (_) {}
  }

  const DEFAULTS = {
    enabled: true,
    hideHandles: true,
    hideNames: false,
    hideAvatars: true,
    hideMedia: false,
    hideBadges: true,
    hideDms: true,
    hideDmInbox: false,
    hideSelf: true,
    scrubTitle: true,
    revealOnHover: true,
    blurOnUnfocus: false,
    idleBlur: false,
    idleSeconds: 45
  };

  let S = { ...DEFAULTS };
  let panic = false;
  let softBlur = false;

  // Prevent flash of unredacted content before storage resolves
  ROOT.classList.add("xs-boot");
  const bootTimer = setTimeout(clearBoot, 4000);
  function clearBoot() {
    clearTimeout(bootTimer);
    ROOT.classList.remove("xs-boot");
  }

  const SEL = {
    userNameBlock: '[data-testid="User-Name"], [data-testid="UserName"]',
    userCell: '[data-testid="UserCell"]',
    accountSwitcher: '[data-testid="SideNav_AccountSwitcher_Button"]',
    conversation: '[data-testid="conversation"], [data-testid^="dm-conversation-item"], [data-testid="dm-conversation-item"]',
    messageEntry: '[data-testid="messageEntry"], [data-testid^="dm-message-item"], [data-testid^="dm-message-entry"], [data-testid^="dm-message-bubble"], [data-testid="dm-message-text"], [data-testid="chat-message"], [data-testid^="chat-message-item"]',
    unreadLink: 'a[aria-label*="unread" i], a[aria-label*="notification" i], [data-testid^="AppTabBar"] a, [data-testid="dm-inbox-header"], [data-testid*="badge" i], [data-testid*="unread" i]',
    appRendered: '[data-testid="primaryColumn"], [data-testid="dm-container"], [data-testid="dm-inbox-panel"]'
  };

  const HANDLE_RE = /^@[A-Za-z0-9_]{1,15}$/;
  const COUNT_RE = /^\d{1,4}\+?$/;

  function applyFlags() {
    const on = S.enabled;
    ROOT.classList.toggle("xs-on", on);
    ROOT.classList.toggle("xs-handles", on && S.hideHandles);
    ROOT.classList.toggle("xs-names", on && S.hideNames);
    ROOT.classList.toggle("xs-avatars", on && S.hideAvatars);
    ROOT.classList.toggle("xs-media", on && S.hideMedia);
    ROOT.classList.toggle("xs-badges", on && S.hideBadges);
    ROOT.classList.toggle("xs-dms", on && S.hideDms);
    ROOT.classList.toggle("xs-dminbox", on && S.hideDmInbox);
    ROOT.classList.toggle("xs-self", on && S.hideSelf);
    ROOT.classList.toggle("xs-reveal", on && S.revealOnHover);
    if (!on) clearBoot();
  }

  function markHandles(scope) {
    for (const el of scope.querySelectorAll("span, a")) {
      const marked = el.hasAttribute("data-xs");
      if (el.childElementCount > 0) continue;
      const raw = el.textContent || "";
      if (!raw) {
        if (marked) el.removeAttribute("data-xs");
        continue;
      }
      const t = raw.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, "").trim();
      const isHandle = t.charCodeAt(0) === 64 && HANDLE_RE.test(t);
      if (isHandle === marked) continue;
      if (isHandle) el.setAttribute("data-xs", "handle");
      else el.removeAttribute("data-xs");
    }
  }

  function markNames(scope) {
    for (const block of scope.querySelectorAll(SEL.userNameBlock)) {
      const link = block.querySelector('a[role="link"]') || block.firstElementChild;
      if (link && !link.hasAttribute("data-xs-name")) {
        link.setAttribute("data-xs-name", "");
      }
    }
    for (const cell of scope.querySelectorAll(SEL.userCell)) {
      if (!cell.hasAttribute("data-xs-cell")) cell.setAttribute("data-xs-cell", "");
    }
    for (const row of scope.querySelectorAll(SEL.conversation)) {
      if (!row.hasAttribute("data-xs-convo")) row.setAttribute("data-xs-convo", "");
      if (!row.querySelector(SEL.userNameBlock)) {
        const spans = Array.from(row.querySelectorAll("span")).filter(
          (s) => s.childElementCount === 0 && s.textContent && s.textContent.trim().length > 0
        );
        for (const s of spans) {
          const t = s.textContent.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, "").trim();
          if (t.startsWith("@") || /^[·•\d\s]+[smhdwy]?$/i.test(t)) continue;
          if (!s.hasAttribute("data-xs-name") && !s.hasAttribute("data-xs-convo-name")) {
            s.setAttribute("data-xs-convo-name", "");
          }
          break;
        }
      }
    }

    // DM conversation panel top header and reply-to user names
    for (const el of scope.querySelectorAll('[class*="text-headline2"], [class*="text-subtext2"], [data-testid*="reply" i] span, [class*="font-chirp"][class*="font-medium"]')) {
      if (el.childElementCount > 0) continue;
      if (el.closest('button, [role="button"], [data-testid*="composer" i], time, svg, input')) continue;
      const raw = el.textContent || "";
      const t = raw.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, "").trim();
      if (!t || t.startsWith("@")) continue;
      if (!el.hasAttribute("data-xs-name")) {
        el.setAttribute("data-xs-name", "");
      }
    }

    const chatPanel = scope.querySelector ? scope.querySelector('[data-testid="dm-conversation-panel"]') : null;
    if (chatPanel) {
      const topBar = chatPanel.querySelector('header, [data-testid*="header" i], [data-testid*="topbar" i], [data-testid*="Title" i]') || chatPanel.firstElementChild;
      if (topBar) {
        for (const el of topBar.querySelectorAll('div, span, h2, h1, a, p')) {
          if (el.childElementCount > 0) continue;
          if (el.closest('button, [role="button"], [data-testid*="composer" i], time, svg, input')) continue;
          const raw = el.textContent || "";
          const t = raw.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, "").trim();
          if (!t || t.startsWith("@")) continue;
          if (!el.hasAttribute("data-xs-name")) {
            el.setAttribute("data-xs-name", "");
          }
        }
      }
    }
  }

  function markBadges(scope) {
    for (const link of scope.querySelectorAll(SEL.unreadLink)) {
      for (const el of link.querySelectorAll("span, div")) {
        const marked = el.hasAttribute("data-xs-count");
        if (el.childElementCount > 0) continue;
        const raw = el.textContent || "";
        const t = raw.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, "").trim();
        const isCount = !!t && COUNT_RE.test(t);
        if (isCount === marked) continue;
        if (isCount) el.setAttribute("data-xs-count", "");
        else el.removeAttribute("data-xs-count");
      }
    }
  }

  function markDms(scope) {
    const isContainer = (el) => {
      const tid = (el.getAttribute("data-testid") || "").toLowerCase();
      if (!tid) return false;
      return tid.includes("container") || tid.includes("scroller") || tid.includes("list") || tid.includes("panel") || tid.includes("wrapper") || tid.includes("scroll");
    };

    for (const msg of scope.querySelectorAll('[data-testid="messageEntry"]')) {
      if (isContainer(msg)) continue;
      if (msg.closest('[data-testid*="composer" i], [role="textbox"], textarea, input')) continue;
      if (!msg.hasAttribute("data-xs-dm")) msg.setAttribute("data-xs-dm", "");
    }

    const chatPanel = scope.querySelector ? scope.querySelector('[data-testid="dm-conversation-panel"]') : null;
    if (chatPanel) {
      const composer = chatPanel.querySelector('[data-testid*="composer" i], [role="textbox"], [contenteditable="true"], textarea, form');
      const header = chatPanel.querySelector('[data-testid="dm-conversation-header"], [data-testid="dm-header-title"], header');

      for (const msg of chatPanel.querySelectorAll('[data-testid="messageEntry"], [data-testid^="dm-message-item"], [data-testid^="dm-message-bubble"], [data-testid="dm-message-text"], [data-testid="tweetText"]')) {
        if (composer && composer.contains(msg)) continue;
        if (header && header.contains(msg)) continue;
        if (isContainer(msg)) continue;
        if (!msg.hasAttribute("data-xs-dm")) msg.setAttribute("data-xs-dm", "");
      }

      for (const el of chatPanel.querySelectorAll('div[dir="auto"], span[dir="auto"], div[dir="ltr"] > span')) {
        if (composer && composer.contains(el)) continue;
        if (header && header.contains(el)) continue;
        if (el.closest('[data-testid*="composer" i], [role="textbox"], [contenteditable], textarea, input, header, button')) continue;
        if (isContainer(el)) continue;
        const t = (el.textContent || "").trim();
        if (!t) continue;
        if (!el.hasAttribute("data-xs-dm")) el.setAttribute("data-xs-dm", "");
      }
    }

    for (const row of scope.querySelectorAll(SEL.conversation)) {
      const nameBlock = row.querySelector(SEL.userNameBlock);
      if (nameBlock) {
        for (const el of row.querySelectorAll("span")) {
          if (el.childElementCount > 0) continue;
          if (nameBlock.contains(el)) continue;
          if (!el.textContent || !el.textContent.trim()) continue;
          if (!el.hasAttribute("data-xs-dmtext")) el.setAttribute("data-xs-dmtext", "");
        }
      } else {
        const spans = Array.from(row.querySelectorAll("span")).filter(
          (s) => s.childElementCount === 0 && s.textContent && s.textContent.trim().length > 0
        );
        let passedName = false;
        for (const s of spans) {
          if (s.hasAttribute("data-xs-convo-name") || s.hasAttribute("data-xs-name")) {
            passedName = true;
            continue;
          }
          const t = s.textContent.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, "").trim();
          if (t.startsWith("@")) continue;
          if (/^[·•\d\s]+[smhdwy]?$/i.test(t)) continue;
          if (passedName) {
            if (!s.hasAttribute("data-xs-dmtext")) s.setAttribute("data-xs-dmtext", "");
          } else {
            passedName = true;
          }
        }
      }
    }
  }

  function markSelf(scope) {
    const btn = scope.querySelector ? scope.querySelector(SEL.accountSwitcher) : null;
    if (btn && !btn.hasAttribute("data-xs-self")) btn.setAttribute("data-xs-self", "");
  }

  let scanQueued = false;
  function scan() {
    scanQueued = false;
    if (!S.enabled || !document.body) return;
    const scope = document.body;
    try {
      if (S.hideHandles) markHandles(scope);
      if (S.hideNames) markNames(scope);
      if (S.hideBadges) markBadges(scope);
      if (S.hideDms) markDms(scope);
      if (S.hideSelf) markSelf(scope);
      if (scope.querySelector(SEL.appRendered)) clearBoot();
    } catch (_) {}
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    const run = () => setTimeout(scan, 60);
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 400 });
    } else {
      run();
    }
  }

  function scrubTitle() {
    if (!S.enabled || !S.scrubTitle) return;
    if (document.title !== "X") document.title = "X";
  }

  let overlay = null;
  let hintEl = null;

  function buildOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "xs-overlay";
    overlay.setAttribute("role", "presentation");
    overlay.tabIndex = -1;
    const card = document.createElement("div");
    card.className = "xs-overlay-card";
    const title = document.createElement("div");
    title.className = "xs-overlay-title";
    title.textContent = "Screen hidden";
    hintEl = document.createElement("div");
    hintEl.className = "xs-overlay-hint";
    card.append(title, hintEl);
    overlay.append(card);
    (document.body || ROOT).append(overlay);
    return overlay;
  }

  function paintOverlay() {
    const show = S.enabled && (panic || softBlur);
    if (!show) {
      if (overlay) overlay.classList.remove("xs-visible");
      return;
    }
    const el = buildOverlay();
    hintEl.textContent = "Press Esc to show the page again";
    el.classList.add("xs-visible");
    try { el.focus({ preventScroll: true }); } catch (_) {}
  }

  function setPanic(v) {
    panic = !!v;
    paintOverlay();
    sset("local", { panic });
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      if (!S.enabled || !(panic || softBlur)) return;
      e.preventDefault();
      e.stopPropagation();
      if (softBlur) { softBlur = false; paintOverlay(); }
      if (panic) setPanic(false);
    },
    true
  );

  window.addEventListener("blur", () => {
    if (S.enabled && S.blurOnUnfocus) { softBlur = true; paintOverlay(); }
  });
  window.addEventListener("focus", () => {
    if (softBlur) { softBlur = false; paintOverlay(); }
  });
  document.addEventListener("visibilitychange", () => {
    if (!S.blurOnUnfocus) return;
    softBlur = document.hidden;
    paintOverlay();
  });

  let idleTimer = null;
  function resetIdle() {
    if (softBlur && !document.hidden && document.hasFocus()) {
      softBlur = false;
      paintOverlay();
    }
    clearTimeout(idleTimer);
    if (!S.enabled || !S.idleBlur) return;
    idleTimer = setTimeout(() => {
      softBlur = true;
      paintOverlay();
    }, Math.max(10, S.idleSeconds) * 1000);
  }
  ["mousemove", "keydown", "wheel", "touchstart", "click"].forEach((ev) =>
    window.addEventListener(ev, resetIdle, { passive: true })
  );

  function startObserving() {
    if (!document.body) return;
    new MutationObserver(() => { queueScan(); scrubTitle(); }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
    const head = document.head;
    if (head) {
      new MutationObserver(scrubTitle).observe(head, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }
    queueScan();
    scrubTitle();
    resetIdle();
  }

  function boot() {
    applyFlags();
    paintOverlay();
    if (document.body) startObserving();
    else document.addEventListener("DOMContentLoaded", startObserving, { once: true });
  }

  Promise.all([
    sget("sync", DEFAULTS),
    sget("local", { panic: false })
  ])
    .then(([sync, local]) => {
      S = { ...DEFAULTS, ...sync };
      panic = !!local.panic;
      boot();
    })
    .catch(() => { clearBoot(); });

  api.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") {
      for (const k of Object.keys(changes)) {
        const v = changes[k].newValue;
        S[k] = v === undefined ? DEFAULTS[k] : v;
      }
      applyFlags();
      queueScan();
      scrubTitle();
      resetIdle();
      paintOverlay();
    } else if (area === "local" && changes.panic) {
      panic = !!changes.panic.newValue;
      paintOverlay();
    }
  });
})();
