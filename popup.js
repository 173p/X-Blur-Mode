const api = globalThis.chrome || globalThis.browser;

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

const BOOLS = Object.keys(DEFAULTS).filter((k) => k !== "idleSeconds");
const $ = (id) => document.getElementById(id);
const specimen = $("specimen");

function paint(s) {
  specimen.classList.toggle("off", !s.enabled);
  specimen.classList.toggle("h-handle", s.enabled && s.hideHandles);
  specimen.classList.toggle("h-name", s.enabled && s.hideNames);
  specimen.classList.toggle("h-avatar", s.enabled && s.hideAvatars);
  specimen.classList.toggle("h-media", s.enabled && s.hideMedia);
  specimen.classList.toggle("h-badge", s.enabled && s.hideBadges);

  $("masterText").textContent = s.enabled ? "On" : "Off";
  $("idleRow").classList.toggle("disabled", !s.idleBlur);
  document.querySelector("main").classList.toggle("disabled", !s.enabled);
}

function read() {
  const s = { idleSeconds: Number($("idleSeconds").value) };
  for (const k of BOOLS) s[k] = $(k).checked;
  return s;
}

function save() {
  const s = read();
  api.storage.sync.set(s);
  paint(s);
}

sget("sync", DEFAULTS).then((s) => {
  for (const k of BOOLS) $(k).checked = !!s[k];
  $("idleSeconds").value = String(s.idleSeconds);
  paint(s);
});

for (const k of BOOLS) $(k).addEventListener("change", save);
$("idleSeconds").addEventListener("change", save);

function paintPanic(on) {
  $("panic").classList.toggle("active", on);
  $("panicText").textContent = on ? "Show the screen" : "Hide the screen now";
  $("panicHint").textContent = on ? "or press Esc" : "";
}

sget("local", { panic: false }).then((loc) => paintPanic(!!loc.panic));

$("panic").addEventListener("click", async () => {
  const loc = await sget("local", { panic: false });
  const next = !loc.panic;
  api.storage.local.set({ panic: next });
  paintPanic(next);
  if (next) window.close();
});
