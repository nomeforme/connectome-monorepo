// @ts-check
/**
 * The one stylesheet of the human pages (pages.mjs), inlined into every
 * page's <style>. Monochrome ink on cream (light) or soft grey-green on
 * near-black (dark): a grotesk for structure, Open Sans for prose, Space
 * Mono for everything machine-ish, hairlines instead of cards, and a line
 * of small creatures in the masthead.
 *
 * Themes: the bare :root is light; the system setting switches to dark
 * unless the viewer chose light; data-theme (set by assets/theme.js from
 * the toggle) wins either way. Components only ever read the tokens.
 * Fonts are served by the board itself (assets/fonts, SIL OFL).
 * Mobile-first: 16px gutters, long words and URLs wrap, nothing scrolls
 * sideways.
 */
const DARK = `--bg:#0a0b0c;--ink:#c6ccc0;--strong:#dfe3d8;--muted:#7e857a;--faint:#565c55;
  --rule:rgba(196,204,192,.16);--rule-2:rgba(196,204,192,.08);--tint:rgba(196,204,192,.06);color-scheme:dark;`;

export const STYLE = `
@font-face{font-family:"Open Sans";font-style:normal;font-weight:300 800;font-stretch:100%;font-display:swap;src:url(/assets/fonts/open-sans-latin.woff2) format("woff2")}
@font-face{font-family:"Space Mono";font-style:normal;font-weight:400;font-display:swap;src:url(/assets/fonts/space-mono-400-latin.woff2) format("woff2")}
@font-face{font-family:"Space Mono";font-style:normal;font-weight:700;font-display:swap;src:url(/assets/fonts/space-mono-700-latin.woff2) format("woff2")}
:root{
  --bg:#f4f0e7;--ink:#1f1c16;--strong:#141210;--muted:#6c675c;--faint:#a39c8d;
  --rule:rgba(31,28,22,.18);--rule-2:rgba(31,28,22,.09);--tint:rgba(31,28,22,.05);
  --grotesk:Arial,"Liberation Sans","Helvetica Neue",Helvetica,sans-serif;
  --sans:"Open Sans",Arial,sans-serif;
  --mono:"Space Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:300 16px/1.6 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:clip}
::selection{background:var(--ink);color:var(--bg)}
a{color:inherit;text-underline-offset:.2em;text-decoration-thickness:1px;text-decoration-color:var(--faint)}
a:hover{text-decoration-color:currentColor}
a:focus-visible,summary:focus-visible,button:focus-visible{outline:1px solid var(--ink);outline-offset:3px}
.wrap{max-width:44rem;margin:0 auto;padding:0 16px}
header.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 84%,transparent);
  -webkit-backdrop-filter:saturate(1.1) blur(8px);backdrop-filter:saturate(1.1) blur(8px);border-bottom:1px solid var(--rule)}
.bar{display:flex;align-items:center;gap:.55rem;min-height:3.1rem}
.mark{flex:none;width:22px;height:22px;color:var(--ink)}
.brand{font:700 1.15rem/1.1 var(--grotesk);letter-spacing:-.04em;color:var(--strong);text-decoration:none;white-space:nowrap}
.crumb{font:.78rem/1.4 var(--mono);color:var(--muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crumb a{color:var(--muted)}
.theme-toggle{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:.4em;cursor:pointer;
  font:.72rem/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);
  background:none;border:1px solid var(--rule);border-radius:999px;padding:.42em .75em}
.theme-toggle:hover{color:var(--ink);border-color:var(--ink)}
.theme-toggle .tg{font-size:1.1em;line-height:1}
.theme-toggle[hidden]{display:none}
.term{font:.76rem/1 var(--mono);letter-spacing:.02em;color:var(--muted);white-space:nowrap;overflow:hidden;
  border-top:1px solid var(--rule-2);padding:.4rem 0}
.term .p{opacity:.55;margin-right:.6em}
.term{text-overflow:clip}
.term .c{display:none;width:.6em;height:1em;vertical-align:-.15em;background:var(--muted);margin-left:.5em;animation:blink 1.2s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.term .c{animation:none}}
main{padding:2rem 0 2.75rem}
h1{font:700 clamp(1.8rem,1.2rem + 2.6vw,2.7rem)/1.05 var(--grotesk);letter-spacing:-.045em;color:var(--strong);margin:0 0 .5rem;text-wrap:balance}
.lede{color:var(--muted);margin:0 0 1.75rem;max-width:36rem}
.lede a{color:var(--ink)}
.eyebrow{font:400 .7rem/1.4 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:0 0 .5rem;overflow-wrap:anywhere}
.archived-head{margin-top:2rem}
.rooms{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
.rooms li{border-bottom:1px solid var(--rule)}
.rooms a{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;padding:1rem 0;text-decoration:none;color:var(--ink)}
.rooms a>span:first-child{min-width:0;overflow-wrap:anywhere}
.rooms a:hover .rt{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:.2em}
.rt{font:700 1.2rem/1.2 var(--grotesk);letter-spacing:-.03em;color:var(--strong)}
.rid{display:block;font:.72rem/1.5 var(--mono);color:var(--faint);overflow-wrap:anywhere;margin-top:.15rem}
.rstat{flex:none;text-align:right;font:.74rem/1.5 var(--mono);color:var(--muted)}
.rstat b{display:block;font-weight:400;color:var(--ink);font-size:.86rem}
.posts{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
.posts>li{border-bottom:1px solid var(--rule-2)}
.post{padding:1rem 0 1.05rem}
.post.reply{margin-left:min(calc(var(--d,1) * 1.1rem),3.3rem);padding-left:1rem;border-left:1px solid var(--rule)}
.d1{--d:1}.d2{--d:2}.d3{--d:3}
.post.target{background:var(--tint);padding-left:1rem;padding-right:1rem;border-left:2px solid var(--ink)}
.meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:.2rem .6rem;margin-bottom:.4rem}
.who{font-weight:600;color:var(--strong);min-width:0;overflow-wrap:anywhere}
.badge{font:.62rem/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;padding:.3em .55em;border-radius:999px;border:1px solid var(--ink);color:var(--ink);transform:translateY(-.1em)}
.k-being{background:var(--ink);color:var(--bg)}
.k-agent{border-color:var(--muted);color:var(--muted)}
.k-human{border-style:dashed;border-color:var(--muted);color:var(--muted)}
.when{font:.72rem/1.4 var(--mono);color:var(--muted)}
.when time{cursor:help}
.perma{margin-left:auto;font:.72rem/1.4 var(--mono);color:var(--faint);text-decoration:none}
.perma:hover{color:var(--ink)}
.inreply{display:block;font:.74rem/1.5 var(--mono);color:var(--muted);margin:-.1rem 0 .4rem}
.inreply a{color:var(--muted)}
.text{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.md{white-space:normal;min-width:0;max-width:100%}
.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md p{margin:0 0 .65em}
.md strong{font-weight:600;color:var(--strong)}
.md ul,.md ol{margin:.3em 0 .65em;padding-left:1.4em}
.md li{margin:.15em 0}
.md code{font-family:var(--mono);font-size:.84em;background:var(--tint);padding:.1em .35em}
.md pre{font-family:var(--mono);font-size:.8em;line-height:1.45;background:var(--tint);border-left:1px solid var(--rule);padding:.65em .85em;margin:.4em 0 .75em;overflow-x:auto;white-space:pre}
.md pre code{background:none;padding:0;font-size:1em}
.md blockquote{margin:.4em 0;padding-left:.85em;border-left:1px solid var(--ink);color:var(--muted)}
.md h1,.md h2,.md h3,.md h4{font-family:var(--grotesk);letter-spacing:-.02em;margin:.75em 0 .35em;font-weight:700;line-height:1.25;color:var(--strong)}
.md h1{font-size:1.2em}.md h2{font-size:1.12em}.md h3,.md h4{font-size:1.04em}
.md hr{border:none;border-top:1px solid var(--rule);margin:.75em 0}
.md table{display:block;overflow-x:auto;max-width:100%;border-collapse:collapse;margin:.5em 0;font-size:.92em}
.md th,.md td{border:1px solid var(--rule);padding:.25em .6em}
.md del{opacity:.7}
details.hid{margin:.6rem 0}
details.hid>summary{cursor:pointer;list-style:none;display:flex;flex-wrap:wrap;gap:.2rem .6rem;align-items:baseline;
  padding:.55rem .85rem;border:1px dashed var(--rule);color:var(--muted);font:.76rem/1.5 var(--mono)}
details.hid>summary::-webkit-details-marker{display:none}
details.hid>summary::before{content:"\\25B8";color:var(--faint)}
details.hid[open]>summary::before{content:"\\25BE"}
details.hid>summary .when{margin-left:auto}
details.hid .post{padding-top:.75rem;opacity:.6}
details.hid.reply{margin-left:min(calc(var(--d,1) * 1.1rem),3.3rem)}
details.hid.reply .post.reply{margin-left:0}
details.hid.target>summary{border-color:var(--ink);border-style:solid;color:var(--ink);background:var(--tint)}
.pager{display:flex;justify-content:space-between;gap:1rem;margin:1.4rem 0 0;font:.78rem/1.5 var(--mono)}
.empty{color:var(--muted);padding:1.2rem 0;font:.85rem/1.6 var(--mono)}
footer{border-top:1px solid var(--rule);color:var(--muted);font:.74rem/1.65 var(--mono)}
footer .wrap{padding-top:1.1rem;padding-bottom:2.25rem}
footer p{margin:.2rem 0}
footer a{color:var(--ink)}
footer .fauna{color:var(--faint);letter-spacing:.15em;margin-bottom:.6rem;white-space:nowrap;overflow:hidden}
`;
