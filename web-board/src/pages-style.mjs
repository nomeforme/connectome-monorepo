// @ts-check
/**
 * The one stylesheet of the human pages (pages.mjs), inlined into every
 * page's <style>. Tokens on :root, dark via prefers-color-scheme.
 * Mobile-first: 16px gutters, long words and URLs wrap, nothing scrolls
 * sideways.
 */
export const STYLE = `
:root{
  --bg:#eef2f1;--surface:#fbfcfc;--ink:#17201e;--muted:#5a6965;--faint:#8a9893;
  --rule:#d5dedb;--accent:#0b6e5a;--accent-ink:#ffffff;--accent-soft:#d7ece6;
  --agent:#3d5a8a;--person:#8a5a1f;--target:#fff6d6;--target-rule:#d9a400;
  --hidden-bg:#e6ebe9;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0d1211;--surface:#141b19;--ink:#e2eae7;--muted:#97a6a1;--faint:#6c7b76;
  --rule:#25302d;--accent:#5ccaa8;--accent-ink:#0d1211;--accent-soft:#16332b;
  --agent:#93b0e0;--person:#e0b072;--target:#2b2814;--target-rule:#c9a227;
  --hidden-bg:#111716;
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 var(--sans)}
a{color:var(--accent);text-underline-offset:.18em;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
.wrap{max-width:44rem;margin:0 auto;padding:0 16px}
header.top{border-bottom:1px solid var(--rule);background:var(--surface)}
header.top .wrap{display:flex;align-items:center;gap:.6rem;min-height:3.25rem}
.mark{flex:none;width:26px;height:26px;color:var(--accent)}
.brand{font-weight:650;letter-spacing:-.01em;color:var(--ink);text-decoration:none}
.crumb{color:var(--muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crumb a{color:var(--muted)}
main{padding:1.75rem 0 2.5rem}
h1{font-size:1.6rem;line-height:1.2;letter-spacing:-.02em;margin:0 0 .35rem}
.lede{color:var(--muted);margin:0 0 1.5rem;max-width:36rem}
.eyebrow{font:500 .72rem/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin:0 0 .4rem;overflow-wrap:anywhere}
.rooms{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
.rooms li{border-bottom:1px solid var(--rule)}
.rooms a{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;padding:.95rem 0;text-decoration:none;color:var(--ink)}
.rooms a>span:first-child{min-width:0;overflow-wrap:anywhere}
.rooms a:hover .rt{color:var(--accent)}
.rt{font-weight:600;font-size:1.08rem}
.rid{display:block;font:.75rem/1.4 var(--mono);color:var(--faint);overflow-wrap:anywhere}
.rstat{flex:none;text-align:right;font:.8rem/1.4 var(--mono);color:var(--muted)}
.rstat b{display:block;font-weight:600;color:var(--ink);font-size:.95rem}
.posts{list-style:none;margin:0;padding:0}
.post{background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:.8rem .95rem;margin:0 0 .65rem}
.post.reply{margin-left:min(calc(var(--d,1) * 1rem),3rem);border-left:3px solid var(--accent-soft)}
.d1{--d:1}.d2{--d:2}.d3{--d:3}
.post.target{background:var(--target);border-color:var(--target-rule);box-shadow:0 0 0 1px var(--target-rule)}
.meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:.15rem .5rem;font-size:.9rem;margin-bottom:.3rem}
.who{font-weight:650;min-width:0;overflow-wrap:anywhere}
.badge{font:600 .66rem/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;padding:.28em .5em;border-radius:999px;border:1px solid currentColor;transform:translateY(-.08em)}
.k-being{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.k-agent{color:var(--agent)}
.k-human{color:var(--person)}
.when{font:.78rem/1.4 var(--mono);color:var(--muted)}
.when time{cursor:help}
.perma{margin-left:auto;font:.78rem/1.4 var(--mono);color:var(--faint);text-decoration:none}
.perma:hover{color:var(--accent)}
.inreply{display:block;font-size:.82rem;color:var(--muted);margin:-.05rem 0 .3rem}
.inreply a{color:var(--muted)}
.text{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
details.hid{margin:0 0 .65rem}
details.hid>summary{cursor:pointer;list-style:none;display:flex;flex-wrap:wrap;gap:.2rem .5rem;align-items:baseline;
  padding:.55rem .95rem;border:1px dashed var(--rule);border-radius:10px;background:var(--hidden-bg);color:var(--muted);font-size:.88rem}
details.hid>summary::-webkit-details-marker{display:none}
details.hid>summary::before{content:"\\25B8";font-size:.8em;color:var(--faint)}
details.hid[open]>summary::before{content:"\\25BE"}
details.hid>summary .when{margin-left:auto}
details.hid .post{margin:.4rem 0 0;opacity:.72;filter:saturate(.4);border-style:dashed}
details.hid.reply{margin-left:min(calc(var(--d,1) * 1rem),3rem)}
details.hid.reply .post.reply{margin-left:0}
details.hid.target>summary{border-color:var(--target-rule);background:var(--target);color:var(--ink)}
.pager{display:flex;justify-content:space-between;gap:1rem;margin:1.25rem 0 0;font-size:.95rem}
.empty{color:var(--muted);padding:1rem 0}
footer{border-top:1px solid var(--rule);color:var(--muted);font-size:.85rem}
footer .wrap{padding-top:1rem;padding-bottom:2rem}
footer p{margin:.25rem 0}
`;
