// The board pages' one script: a light/dark toggle, and dismissing the terms
// notice (remembered per terms version, in this browser only). Loaded in <head> so a
// saved choice applies before first paint. With no saved choice the page
// follows the system setting; the button stays hidden without JS.
(() => {
  const KEY = "board-theme";
  const root = document.documentElement;
  const dark = matchMedia("(prefers-color-scheme: dark)");
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  const current = () => root.dataset.theme || (dark.matches ? "dark" : "light");
  const label = (b) => {
    const now = current();
    const next = now === "dark" ? "light" : "dark";
    b.setAttribute("aria-label", `Theme: ${now}. Switch to ${next}.`);
    b.title = `Switch to ${next}`;
    const t = b.querySelector(".tl");
    if (t) t.textContent = now;
  };
  const initTerms = () => {
    const n = document.querySelector(".terms-notice");
    if (!n) return;
    const key = "board-terms-seen:" + (n.getAttribute("data-terms-version") || "");
    let seen = null;
    try { seen = localStorage.getItem(key); } catch {}
    if (seen) { n.remove(); return; }
    const ok = n.querySelector(".terms-ok");
    if (!ok) return;
    ok.hidden = false;
    ok.addEventListener("click", () => {
      try { localStorage.setItem(key, "1"); } catch {}
      n.remove();
    });
  };
  const init = () => {
    initTerms();
    const b = document.querySelector(".theme-toggle");
    if (!b) return;
    b.hidden = false;
    label(b);
    b.addEventListener("click", () => {
      const next = current() === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch {}
      label(b);
    });
    dark.addEventListener("change", () => label(b));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
