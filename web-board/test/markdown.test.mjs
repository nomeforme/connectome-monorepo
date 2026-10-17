// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeHref, renderMarkdown } from "../src/markdown.mjs";

test("isSafeHref keeps http(s), mailto and anchors", () => {
  for (const h of ["https://example.org/a?b=1", "http://example.org", "HTTPS://EXAMPLE.ORG", "mailto:someone@example.org", "#section"])
    assert.equal(isSafeHref(h), true, h);
});

test("isSafeHref defangs script, data, file and relative hrefs, control-char tricks included", () => {
  for (const h of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:msgbox(1)", "file:///etc/passwd", "/rooms/x", "a.md"])
    assert.equal(isSafeHref(h), false, h);
});

test("markdown renders: bold, italics, line breaks, lists, code, quotes", () => {
  assert.match(renderMarkdown("**bold** and *it*"), /<strong>bold<\/strong> and <em>it<\/em>/);
  assert.match(renderMarkdown("one\ntwo"), /one<br>two/);
  assert.match(renderMarkdown("- a\n- b"), /<ul>\s*<li>a<\/li>\s*<li>b<\/li>\s*<\/ul>/);
  assert.match(renderMarkdown("`x`"), /<code>x<\/code>/);
  assert.match(renderMarkdown("> q"), /<blockquote>/);
});

test("raw HTML in a post is inert text, never markup", () => {
  const out = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:x">y</a>');
  assert.doesNotMatch(out, /<script|<img|<a href="javascript/i);
  assert.match(out, /&lt;script&gt;/);
});

test("unsafe links are defanged to # with their text kept; reference links too", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x"]) {
    const out = renderMarkdown(`[click](${bad}) and [ref][1]\n\n[1]: ${bad}`);
    assert.doesNotMatch(out, /javascript:|data:|vbscript:/i);
    assert.match(out, /href="#"/);
    assert.match(out, /click/);
  }
});

test("safe links open in a new tab with nofollow noopener noreferrer; bare URLs autolink", () => {
  const out = renderMarkdown("[ok](https://example.org) and https://example.net/a");
  assert.match(out, /<a target="_blank" rel="nofollow noopener noreferrer" href="https:\/\/example.org">ok<\/a>/);
  assert.match(out, /href="https:\/\/example.net\/a"/);
});

test("images never load: a safe image becomes a link, an unsafe one its alt text", () => {
  const out = renderMarkdown("![pic](https://e.example/i.png) ![bad](javascript:x)");
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /href="https:\/\/e.example\/i.png"[^>]*>pic<\/a>|>pic<\/a>/);
  assert.match(out, /bad/);
  assert.doesNotMatch(out, /javascript:/);
});
