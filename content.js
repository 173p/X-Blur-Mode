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
    hideBio: false,
    hideDiscover: false,
    maskUrl: false,
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
    unreadLink: 'a[aria-label*="unread" i], a[aria-label*="notification" i], [data-testid^="AppTabBar"] a, [data-testid="dm-inbox-header"], [data-testid*="badge" i], [data-testid*="unread" i]',
    appRendered: '[data-testid="primaryColumn"], [data-testid="dm-container"], [data-testid="dm-inbox-panel"]',
    // Post / message body text. Never treated as a display name.
    bodyText: '[data-testid="tweetText"], [data-testid="dm-message-text"]',
    socialContext: '[data-testid="socialContext"]',
    dmTyping: '[data-testid*="typing" i], [aria-label*="typing" i]',
    dmReply: '[data-testid*="reply" i], [data-testid*="quoted" i]',
    socialProof: '[data-testid="UserProfileHeader_FollowedBy"], [data-testid*="followedBy" i], [data-testid*="FollowedBy" i], [aria-label*="Followed by" i]'
  };

  const HANDLE_RE = /^@[A-Za-z0-9_]{1,15}$/;
  // A DM sender label is a display name, not an @handle: any script is valid,
  // so isBareDmHandle() filters on position rather than characters.
  const BARE_LABEL_MAX = 50;
  const BARE_HANDLE_RE = /^[^\n\r]{1,50}$/u;
  const COUNT_RE = /^\d{1,4}\+?$/;
  const ZW_RE = /[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g;

  const clean = (s) => (s || "").replace(ZW_RE, "").trim();

  // Nav / chrome labels that should stay readable even inside a heading.
  const CHROME_LABEL_RE = /^(home|explore|notifications|messages|bookmarks|communities|premium|profile|more|lists|jobs|grok|settings|verified|posts|replies|highlights|articles|media|likes|following|followers|subscriptions|search|post)$/i;
  // Separate from CHROME_LABEL_RE, which the name passes also use.
  // Anything else in a social-context line is the identity.
  const TYPING_RE = /\bis typing\b|\bare typing\b/i;
  // Leading text of the profile social-proof line; the names follow it.
  const FOLLOWED_BY_RE = /^(followed by|not followed by anyone you.{0,3}re following)/i;
  const SOCIAL_VERB_RE = /^(reposted|retweeted|liked|replied|followed|pinned|subscribed|posted)$/i;
  const DM_CHROME_RE = /^(seen|sent|delivered|read|show more|show less|show thread|unsent|you|new messages?|today|yesterday|edited|forwarded|replying to|this message was deleted)$/i;
  const COUNT_LABEL_RE = /^[\d,.\s]+\s*(posts?|following|followers|likes?)?$/i;

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
    ROOT.classList.toggle("xs-bio", on && S.hideBio);
    ROOT.classList.toggle("xs-discover", on && S.hideDiscover);
    ROOT.classList.toggle("xs-reveal", on && S.revealOnHover);
    if (!on) clearBoot();
  }

  /* --------------------------------------------------------------- handles */

  function markHandles(scope) {
    for (const el of scope.querySelectorAll("span, a, div")) {
      // "handle" is no longer assigned; still recognised so a stale pill from
      // an older version is cleared rather than persisting until reload.
      const cur = el.getAttribute("data-xs");
      const marked = cur === "handle" || cur === "softhandle";
      // Owned by other passes — clearing them here causes scan flicker.
      if (cur === "dmhandle" || cur === "social") continue;
      if (el.closest('[data-xs-row="typing"]')) continue;
      if (el.childElementCount > 0) continue;
      const raw = el.textContent || "";
      if (!raw) {
        if (marked) el.removeAttribute("data-xs");
        continue;
      }
      const t = clean(raw);
      const isHandle = t.charCodeAt(0) === 64 && HANDLE_RE.test(t);
      // A mention inside body text is content, not an identity label.
      if (!isHandle || isBodyText(el)) {
        if (marked) el.removeAttribute("data-xs");
        continue;
      }
      el.setAttribute("data-xs", "softhandle");
    }
  }

  // Two shapes the leaf-only pass above misses: "@name" inside a node with
  // children, and a bare sender label with no "@" at all.
  function markDmHandles(scope) {
    const panels = [];
    const chat = scope.querySelector('[data-testid="dm-conversation-panel"]');
    if (chat) panels.push(chat);
    for (const row of scope.querySelectorAll(SEL.conversation)) panels.push(row);

    for (const panel of panels) {
      for (const el of panel.querySelectorAll('span, a, div, h1, h2')) {
        if (el.hasAttribute("data-xs")) continue;
        if (el.closest('[role="textbox"], [contenteditable], textarea, input')) continue;
        // markDmIdentity() blurs the whole typing row; a nested mark doubles it.
        if (el.closest('[data-xs-row="typing"]')) continue;
        const t = clean(el.textContent);
        if (!t) continue;

        const prefixed = t.charCodeAt(0) === 64 && HANDLE_RE.test(t);
        const bare = !prefixed && isBareDmHandle(el, t);
        if (!prefixed && !bare) continue;

        const inner = Array.from(el.querySelectorAll("*")).some(
          (c) => clean(c.textContent) === t
        );
        if (inner) continue;
        // Labels and bylines stand alone; a mention in message text stays.
        if (!bare && isBodyText(el)) continue;
        el.setAttribute("data-xs", bare ? "dmhandle" : "softhandle");
      }
    }
  }

  // Filters on position, not characters: a standalone leaf outside any
  // bubble, byline or control.
  function isBareDmHandle(el, t) {
    if (!BARE_HANDLE_RE.test(t)) return false;
    if (t.length > BARE_LABEL_MAX) return false;
    if (CHROME_LABEL_RE.test(t)) return false;
    if (DM_CHROME_RE.test(t)) return false;
    if (TYPING_RE.test(t)) return false;
    if (t.split(/\s+/).length > 4) return false;
    if (/^\d{1,2}:\d{2}(\s*[AP]M)?$/i.test(t)) return false;
    if (/^[·•\d\s]+[smhdwy]?$/i.test(t)) return false;
    // Message text and quoted posts belong to the DM / name options.
    if (isBodyText(el)) return false;
    if (el.closest('[data-testid="messageEntry"]')) return false;
    if (el.closest(SEL.userNameBlock)) return false;
    if (el.closest('time, button, [role="button"], [data-testid*="composer" i]')) return false;
    return el.childElementCount === 0;
  }

  /* ------------------------------------------------------- DM identity bits */

  function markDmIdentity(scope) {
    const panel = scope.querySelector
      ? scope.querySelector('[data-testid="dm-conversation-panel"]')
      : null;
    if (!panel) return;

    const typingCandidates = new Set([
      ...panel.querySelectorAll("div, span, p"),
      ...panel.querySelectorAll(SEL.dmTyping)
    ]);
    const typingRows = new Set();
    for (const el of typingCandidates) {
      if (el.closest('[role="textbox"], [contenteditable], textarea, input')) continue;
      if (isBodyText(el)) continue;
      if (el.closest('[data-testid="messageEntry"]')) continue;
      const t = clean(el.textContent);
      if (!t || !TYPING_RE.test(t)) continue;
      typingRows.add(typingRowFor(el, panel));
    }
    for (const row of typingRows) {
      if (!row || row.hasAttribute("data-xs")) continue;
      if (row === panel) continue;
      row.setAttribute("data-xs", "social");
      // A nested mark would rasterise on top, doubling the blur.
      row.setAttribute("data-xs-row", "typing");
      for (const inner of row.querySelectorAll("[data-xs]")) {
        inner.removeAttribute("data-xs");
      }
    }

    // Only the attribution is hidden; the quoted text belongs to the DM option.
    for (const block of panel.querySelectorAll(SEL.dmReply)) {
      if (block.closest('[role="textbox"], [contenteditable], textarea, input')) continue;
      const nameBlock = block.querySelector(SEL.userNameBlock);
      if (nameBlock) {
        const link = nameBlock.querySelector('a[role="link"]') || nameBlock.firstElementChild;
        if (link && !link.hasAttribute("data-xs")) link.setAttribute("data-xs", "social");
        continue;
      }
      for (const el of block.querySelectorAll("span, div, a")) {
        if (el.hasAttribute("data-xs")) continue;
        if (el.childElementCount > 0) continue;
        if (isBodyText(el)) continue;
        const t = clean(el.textContent);
        if (!t) continue;
        if (DM_CHROME_RE.test(t)) continue;
        if (t.length > BARE_LABEL_MAX || t.split(/\s+/).length > 4) continue;
        el.setAttribute("data-xs", "social");
        break;
      }
    }
  }

  // Climb to the row holding the name as well as the verb.
  function typingRowFor(el, panel) {
    let node = el;
    for (let depth = 0; depth < 4; depth++) {
      const parent = node.parentElement;
      if (!parent || parent === panel) break;
      if (parent.querySelector('[data-testid="messageEntry"]')) break;
      if (parent.closest('[data-testid="messageEntry"]')) break;
      node = parent;
      // Text beyond the phrase, or an avatar: this is the full indicator.
      const t = clean(node.textContent);
      if (!TYPING_RE.test(t) || node.querySelector("img, [data-testid*='avatar' i]")) break;
      if (t !== clean(el.textContent)) break;
    }
    return node;
  }

  /* -------------------------------------------------------- social context */

  // "<user> reposted": outside the User-Name block and not a bare "@handle",
  // so no other pass reaches it. The verb stays readable.
  function markSocialContext(scope) {
    for (const ctx of scope.querySelectorAll(SEL.socialContext)) {
      const leaves = Array.from(ctx.querySelectorAll("span, a, div")).filter(
        (n) => n.childElementCount === 0 && clean(n.textContent)
      );

      let tagged = false;
      for (const leaf of leaves) {
        const t = clean(leaf.textContent);
        if (SOCIAL_VERB_RE.test(t)) continue;
        if (leaf.hasAttribute("data-xs")) { tagged = true; continue; }
        leaf.setAttribute("data-xs", "social");
        tagged = true;
      }
      if (tagged) continue;

      // One text node: nothing holds the name alone, so blur the whole line.
      if (!ctx.hasAttribute("data-xs")) ctx.setAttribute("data-xs", "social");
    }

    markSocialProof(scope);
  }

  // "Followed by <a>, <b> and 12 others" on a profile. Names the mutuals, so
  // it leaks identities the profile's own byline does not.
  function markSocialProof(scope) {
    const blocks = new Set(scope.querySelectorAll(SEL.socialProof));
    // The module often carries no testid: find it by its leading phrase.
    for (const el of scope.querySelectorAll("div, span, a")) {
      const t = clean(el.textContent);
      if (!t || !FOLLOWED_BY_RE.test(t)) continue;
      if (isBodyText(el)) continue;
      if (el.closest('[role="textbox"], [contenteditable], textarea, input')) continue;
      // Innermost element still holding the whole phrase.
      if (Array.from(el.querySelectorAll("*")).some((c) => FOLLOWED_BY_RE.test(clean(c.textContent)))) continue;
      blocks.add(el);
    }

    for (const block of blocks) {
      if (block.hasAttribute("data-xs")) continue;
      if (block.closest('[role="textbox"], [contenteditable], textarea, input')) continue;
      // A lead-in span picked up on its own is part of an outer block, not a
      // block itself; blurring it would hide "Followed by" and no name.
      let nested = false;
      for (const other of blocks) {
        if (other !== block && other.contains(block)) { nested = true; break; }
      }
      if (nested) continue;
      // Blur the names only, leaving "Followed by" readable, when they sit in
      // their own elements. Avatars beside them are the avatar option's job.
      const named = Array.from(block.querySelectorAll("a, span")).filter((n) => {
        if (n.childElementCount > 0) return false;
        const t = clean(n.textContent);
        return t && !FOLLOWED_BY_RE.test(t) && !/^(and|,|\u00b7)$/i.test(t);
      });
      const whole = clean(block.textContent);
      const splitOut = named.some((n) => clean(n.textContent) !== whole);
      if (splitOut) {
        for (const n of named) {
          if (!n.hasAttribute("data-xs")) n.setAttribute("data-xs", "social");
        }
        continue;
      }
      // One text node: nothing holds the names alone, so blur the line.
      block.setAttribute("data-xs", "social");
    }
  }

  /* ----------------------------------------------------------------- names */

  // Guards every name heuristic so display-name blurring never eats a post.
  function isBodyText(el) {
    return !!el.closest(SEL.bodyText);
  }

  function markNameEl(el) {
    if (!el || el.hasAttribute("data-xs-name")) return;
    if (isBodyText(el)) return;
    el.setAttribute("data-xs-name", "");
  }

  function markNames(scope) {
    for (const block of scope.querySelectorAll(SEL.userNameBlock)) {
      const link = block.querySelector('a[role="link"]') || block.firstElementChild;
      if (link) markNameEl(link);
    }

    for (const cell of scope.querySelectorAll(SEL.userCell)) {
      if (!cell.hasAttribute("data-xs-cell")) cell.setAttribute("data-xs-cell", "");
    }

    // The bio is deliberately excluded: it has its own option.
    for (const hdr of scope.querySelectorAll('[data-testid="UserName"], [data-testid="UserProfileHeader_Items"]')) {
      for (const el of hdr.querySelectorAll("span, div")) {
        if (el.childElementCount > 0) continue;
        const t = clean(el.textContent);
        if (!t || t.startsWith("@")) continue;
        markNameEl(el);
      }
    }

    // Many user cells render the name as a plain link with no User-Name
    // testid, so tagging the cell alone never reached them.
    for (const cell of scope.querySelectorAll(SEL.userCell)) {
      const block = cell.querySelector(SEL.userNameBlock);
      if (block) {
        const link = block.querySelector('a[role="link"]') || block.firstElementChild;
        if (link) markNameEl(link);
        continue;
      }
      for (const el of cell.querySelectorAll("span, div")) {
        if (el.childElementCount > 0) continue;
        if (el.closest('button, [role="button"]')) continue;
        const t = clean(el.textContent);
        if (!t || t.startsWith("@")) continue;
        if (CHROME_LABEL_RE.test(t)) continue;
        markNameEl(el);
        break;
      }
    }

    // Sticky profile header: "Name" over "N posts".
    for (const heading of scope.querySelectorAll('h1, h2, [role="heading"]')) {
      if (isBodyText(heading)) continue;
      if (heading.closest('[data-testid="sidebarColumn"]')) continue;
      const leaves =
        heading.childElementCount === 0
          ? [heading]
          : Array.from(heading.querySelectorAll("span, div")).filter((n) => n.childElementCount === 0);
      for (const el of leaves) {
        const t = clean(el.textContent);
        if (!t) continue;
        if (CHROME_LABEL_RE.test(t)) continue;
        if (COUNT_LABEL_RE.test(t)) continue;
        markNameEl(el);
      }
    }

    for (const row of scope.querySelectorAll(SEL.conversation)) {
      if (!row.hasAttribute("data-xs-convo")) row.setAttribute("data-xs-convo", "");
      if (!row.querySelector(SEL.userNameBlock)) {
        const spans = Array.from(row.querySelectorAll("span")).filter(
          (s) => s.childElementCount === 0 && clean(s.textContent).length > 0
        );
        for (const s of spans) {
          const t = clean(s.textContent);
          if (t.startsWith("@") || /^[·•\d\s]+[smhdwy]?$/i.test(t)) continue;
          if (!s.hasAttribute("data-xs-name") && !s.hasAttribute("data-xs-convo-name")) {
            s.setAttribute("data-xs-convo-name", "");
          }
          break;
        }
      }
    }

    // Thread header only; message bodies belong to the DM option.
    const chatPanel = scope.querySelector ? scope.querySelector('[data-testid="dm-conversation-panel"]') : null;
    if (chatPanel) {
      const topBar =
        chatPanel.querySelector('header, [data-testid*="header" i], [data-testid*="topbar" i], [data-testid*="Title" i]') ||
        chatPanel.firstElementChild;
      if (topBar) {
        for (const el of topBar.querySelectorAll("div, span, h2, h1, a, p")) {
          if (el.childElementCount > 0) continue;
          if (el.closest('button, [role="button"], [data-testid*="composer" i], time, svg, input')) continue;
          const t = clean(el.textContent);
          if (!t || t.startsWith("@")) continue;
          markNameEl(el);
        }
      }
    }
  }

  /* -------------------------------------------------------------------- bio */

  // Kept separate from display names so the two options are independent.
  function markBio(scope) {
    for (const el of scope.querySelectorAll('[data-testid="UserDescription"]')) {
      if (!el.hasAttribute("data-xs-bio")) el.setAttribute("data-xs-bio", "");
    }
    for (const card of scope.querySelectorAll('[data-testid="HoverCard"]')) {
      for (const el of card.querySelectorAll('[data-testid="UserDescription"]')) {
        if (!el.hasAttribute("data-xs-bio")) el.setAttribute("data-xs-bio", "");
      }
    }
  }

  /* ---------------------------------------------------------------- badges */

  function markBadges(scope) {
    for (const link of scope.querySelectorAll(SEL.unreadLink)) {
      for (const el of link.querySelectorAll("span, div")) {
        const marked = el.hasAttribute("data-xs-count");
        if (el.childElementCount > 0) continue;
        const t = clean(el.textContent);
        const isCount = !!t && COUNT_RE.test(t);
        if (isCount === marked) continue;
        if (isCount) el.setAttribute("data-xs-count", "");
        else el.removeAttribute("data-xs-count");
      }
    }
  }

  /* ------------------------------------------------------------------- DMs */

  function markDms(scope) {
    const isContainer = (el) => {
      const tid = (el.getAttribute("data-testid") || "").toLowerCase();
      if (!tid) return false;
      return (
        tid.includes("container") ||
        tid.includes("scroller") ||
        tid.includes("list") ||
        tid.includes("panel") ||
        tid.includes("wrapper") ||
        tid.includes("scroll")
      );
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

      for (const msg of chatPanel.querySelectorAll(
        '[data-testid="messageEntry"], [data-testid^="dm-message-item"], [data-testid^="dm-message-bubble"], [data-testid="dm-message-text"], [data-testid="tweetText"]'
      )) {
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
        if (!clean(el.textContent)) continue;
        if (!el.hasAttribute("data-xs-dm")) el.setAttribute("data-xs-dm", "");
      }

      // Firefox renders DM video into bare <video> wrappers with none of the
      // tweet media testids, so the CSS-only rules miss them.
      for (const media of chatPanel.querySelectorAll(
        'video, img, [data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"], [data-testid^="dm-media"], [aria-label*="video" i], [aria-label*="GIF" i]'
      )) {
        if (composer && composer.contains(media)) continue;
        if (header && header.contains(media)) continue;
        const src = media.getAttribute("src") || "";
          if (src.includes("emoji")) continue;
        if (src.includes("profile_images") || src.includes("default_profile")) continue;
        const holder =
          media.closest(
            '[data-testid^="dm-media"], [data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"]'
          ) || media;
        if (!holder.hasAttribute("data-xs-dmmedia")) holder.setAttribute("data-xs-dmmedia", "");
      }
    }

    // Blur the preview; the row name belongs to the display-name option.
    for (const row of scope.querySelectorAll(SEL.conversation)) {
      const nameBlock = row.querySelector(SEL.userNameBlock);
      if (nameBlock) {
        for (const el of row.querySelectorAll("span")) {
          if (el.childElementCount > 0) continue;
          if (nameBlock.contains(el)) continue;
          if (!clean(el.textContent)) continue;
          if (!el.hasAttribute("data-xs-dmtext")) el.setAttribute("data-xs-dmtext", "");
        }
      } else {
        const spans = Array.from(row.querySelectorAll("span")).filter(
          (s) => s.childElementCount === 0 && clean(s.textContent).length > 0
        );
        let passedName = false;
        for (const s of spans) {
          if (s.hasAttribute("data-xs-convo-name") || s.hasAttribute("data-xs-name")) {
            passedName = true;
            continue;
          }
          const t = clean(s.textContent);
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

  /* ------------------------------------------------------------------ self */

  function markSelf(scope) {
    const btn = scope.querySelector ? scope.querySelector(SEL.accountSwitcher) : null;
    if (btn && !btn.hasAttribute("data-xs-self")) btn.setAttribute("data-xs-self", "");
  }

  /* -------------------------------------------------------------- discover */

  // Discovery modules: trends, news, follow suggestions. Each module keeps
  // its heading readable. Apostrophes are matched loosely because X mixes
  // the straight and curly forms.
  const DISCOVER_LABEL_RE = new RegExp(
    [
      "trending",
      "trends? for you",
      "what.{0,3}s happening",
      "who to follow",
      "you might like",
      "today.{0,3}s news",
      "live on x",
      "happening now",
      "in the news",
      "sports? on x",
      "only on x",
      "timeline: explore",
      "timeline: trending"
    ].join("|"),
    "i"
  );

  function isDiscoverSection(sec) {
    const label = clean(sec.getAttribute("aria-label"));
    if (label && DISCOVER_LABEL_RE.test(label)) return true;
    if (sec.querySelector('[data-testid="trend"]')) return true;

    // Live / audio spaces carry their own testids.
    if (sec.querySelector('[data-testid*="audioSpace" i], [data-testid*="liveEvent" i], [data-testid*="broadcast" i]')) {
      return true;
    }

    // Fall back to the visible heading.
    const heading = sec.querySelector('h1, h2, h3, [role="heading"]');
    if (heading && DISCOVER_LABEL_RE.test(clean(heading.textContent))) return true;
    return false;
  }

  // Climb to the element owning the heading and its rows, without
  // swallowing the whole sidebar.
  function moduleFor(heading, boundary) {
    let el = heading;
    while (el.parentElement && el.parentElement !== boundary) {
      const parent = el.parentElement;
      // Stop before a parent holding other modules' headings.
      const headingCount = parent.querySelectorAll('h1, h2, h3, [role="heading"]').length;
      if (headingCount > 1) break;
      // A parent adding content beyond the heading is the module box.
      if (clean(parent.textContent) !== clean(heading.textContent)) {
        if (parent.children.length > 1) return parent;
      }
      el = parent;
    }
    return el === heading ? heading.parentElement : el;
  }

  // X packs several modules into ONE section as sibling row groups, so a
  // section is not one module with one heading. Every heading acts as a
  // boundary; everything between headings is a row to blur.
  function markModuleRows(sec) {
    const headings = new Set(sec.querySelectorAll('h1, h2, h3, [role="heading"]'));
    for (const h of headings) {
      if (!h.hasAttribute("data-xs-discover-head")) h.setAttribute("data-xs-discover-head", "");
    }

    // The heading, or the small wrapper whose only content is that heading.
    // A big layout wrapper containing headings further down is not one:
    // treating it as one stopped the descent and marked nothing.
    const isHeadingHost = (el) => {
      for (const h of headings) {
        if (el === h) return true;
        if (el.contains(h) && clean(el.textContent) === clean(h.textContent)) return true;
      }
      return false;
    };

    // Known row types first: unambiguous wherever they appear.
    for (const row of sec.querySelectorAll('[data-testid="trend"], [data-testid="UserCell"]')) {
      if (!row.hasAttribute("data-xs-discover-item")) row.setAttribute("data-xs-discover-item", "");
    }

    // News and live entries carry no testid. Descend through single-child
    // wrappers to reach the level the rows sit at.
    let host = sec;
    while (
      host.children.length === 1 &&
      host.firstElementChild.children.length > 0 &&
      !isHeadingHost(host.firstElementChild)
    ) {
      host = host.firstElementChild;
    }

    for (const child of host.children) {
      if (isHeadingHost(child)) continue;
      if (child.hasAttribute("data-xs-discover-item")) continue;
      // Skip chrome: "Show more" links and empty spacers.
      if (!clean(child.textContent) && !child.querySelector("img, video, svg")) continue;
      if (child.closest('[data-testid="search"], form, [role="search"]')) continue;
      // A wrapper holding only marked rows needs no mark.
      if (child.querySelector("[data-xs-discover-item]") && !clean(child.textContent)) continue;
      child.setAttribute("data-xs-discover-item", "");
    }
  }

  function markDiscover(scope) {
    const sections = new Set();
    const sidebar = scope.querySelector ? scope.querySelector('[data-testid="sidebarColumn"]') : null;

    if (sidebar) {
      for (const sec of sidebar.querySelectorAll('section, [role="region"], aside, [aria-label]')) {
        if (sec.closest('[data-testid="search"], form, [role="search"]')) continue;
        if (isDiscoverSection(sec)) sections.add(sec);
      }

      // Most sidebar modules are plain unlabelled divs the query above never
      // sees. Find them by heading text and climb to their box.
      for (const heading of sidebar.querySelectorAll('h1, h2, h3, [role="heading"]')) {
        if (!DISCOVER_LABEL_RE.test(clean(heading.textContent))) continue;
        if (heading.closest('[data-testid="search"], form, [role="search"]')) continue;
        const module = moduleFor(heading, sidebar);
        if (module) sections.add(module);
      }
    }

    // Inline follow suggestions.
    for (const sec of scope.querySelectorAll('section[aria-label], [role="region"][aria-label], [aria-label]')) {
      const label = clean(sec.getAttribute("aria-label"));
      if (!label) continue;
      if (/(who to follow|you might like)/i.test(label)) sections.add(sec);
    }

    for (const sec of sections) {
      if (!sec.hasAttribute("data-xs-discover")) sec.setAttribute("data-xs-discover", "");
      markModuleRows(sec);
    }

    // Trend rows also render standalone in Explore.
    for (const trend of scope.querySelectorAll('[data-testid="trend"]')) {
      if (!trend.hasAttribute("data-xs-discover-item")) trend.setAttribute("data-xs-discover-item", "");
    }
  }

  /* ------------------------------------------------------------ URL masking */

  const MASK_PATH = "/";
  const MASK_DELAY = 500;

  let maskTimer = null;
  let maskDue = 0;
  let maskedFrom = null;
  let selfWriting = false;

  function realPath() {
    const loc = window.location;
    return loc.pathname + loc.search + loc.hash;
  }

  // Put the genuine URL back without adding a history entry.
  function unmaskUrl() {
    if (maskedFrom === null) return;
    const target = maskedFrom;
    maskedFrom = null;
    selfWriting = true;
    try {
      history.replaceState(history.state, "", target);
    } catch (_) {
    } finally {
      selfWriting = false;
    }
  }

  function maskUrlNow() {
    if (!S.enabled || !S.maskUrl) return;
    if (maskedFrom !== null) return;
    try {
      const loc = window.location;
      if (loc.pathname === MASK_PATH && !loc.search && !loc.hash) return;
      const from = realPath();
      selfWriting = true;
      try {
        history.replaceState(history.state, "", loc.origin + MASK_PATH);
        maskedFrom = from;
      } finally {
        selfWriting = false;
      }
    } catch (_) {}
  }

  function scheduleMask(delay) {
    if (!S.enabled || !S.maskUrl) return;
    const due = Date.now() + delay;
    if (maskTimer !== null && due >= maskDue) return;
    clearTimeout(maskTimer);
    maskDue = due;
    maskTimer = setTimeout(() => {
      maskTimer = null;
      maskUrlNow();
    }, delay);
  }

  // Drop a pending mask outright. Used when a navigation makes the pending
  // one refer to a path the user has already left.
  function cancelMask() {
    clearTimeout(maskTimer);
    maskTimer = null;
  }

  // Any interaction may start a navigation, so hand the true path back first
  // and re-mask once things are quiet again.
  function restoreForInteraction() {
    if (!S.enabled || !S.maskUrl) return;
    unmaskUrl();
    cancelMask();
    scheduleMask(MASK_DELAY);
  }

  // X is a SPA: it pushes a history entry on every navigation. Restore the
  // real path before it does so, then re-mask after the route settles.
  let historyHooked = false;
  function hookHistory() {
    if (historyHooked) return;
    historyHooked = true;
    for (const fn of ["pushState", "replaceState"]) {
      const orig = history[fn];
      if (typeof orig !== "function") continue;
      history[fn] = function (...args) {
        // The extension's own mask / unmask writes are not navigations.
        if (selfWriting) return orig.apply(this, args);
        // A real SPA navigation: the masked URL must not become the base it
        // resolves against, so drop the mask and let the new path stand.
        maskedFrom = null;
        const r = orig.apply(this, args);
        if (S.enabled && S.maskUrl) { cancelMask(); scheduleMask(MASK_DELAY); }
        return r;
      };
    }
    window.addEventListener("popstate", () => {
      maskedFrom = null;
      cancelMask();
      scheduleMask(MASK_DELAY);
    });
    for (const ev of ["click", "keydown", "auxclick"]) {
      window.addEventListener(ev, restoreForInteraction, true);
    }
    // Leaving masked would hand the wrong path to the next document.
    window.addEventListener("beforeunload", unmaskUrl);
    window.addEventListener("pagehide", unmaskUrl);
  }

  /* ------------------------------------------------------------------ scan */

  let scanQueued = false;
  function scan() {
    scanQueued = false;
    if (!S.enabled || !document.body) return;
    const scope = document.body;
    try {
      if (S.hideHandles) markHandles(scope);
      if (S.hideNames) markNames(scope);
      if (S.hideBio) markBio(scope);
      if (S.hideBadges) markBadges(scope);
      if (S.hideDms) markDms(scope);
      if (S.hideHandles) markDmHandles(scope);
      if (S.hideHandles) markSocialContext(scope);
      if (S.hideHandles) markDmIdentity(scope);
      if (S.hideSelf) markSelf(scope);
      if (S.hideDiscover) markDiscover(scope);
      // Masking is scheduled, not run per scan. scheduleMask() never pushes
      // an existing deadline back, so this cannot starve the pending mask.
      if (S.maskUrl && maskedFrom === null) scheduleMask(MASK_DELAY);
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

  /* --------------------------------------------------------------- overlay */

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
    hookHistory();
    // Let the initial route resolve before masking anything.
    scheduleMask(MASK_DELAY);
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
      if (S.enabled && S.maskUrl) scheduleMask(MASK_DELAY);
      else { cancelMask(); unmaskUrl(); }
    } else if (area === "local" && changes.panic) {
      panic = !!changes.panic.newValue;
      paintOverlay();
    }
  });
})();
