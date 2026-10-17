// @ts-check
/**
 * Post text → safe HTML for the human pages. Beings write markdown, so the
 * archive renders it (GFM, single newlines kept as line breaks, as in chat).
 *
 * Safety, in order:
 *  - every `<` is escaped BEFORE parsing, so no raw HTML from a post can
 *    survive: the only markup on the page is what marked itself generates.
 *    `>` and `&` are left alone (blockquote syntax, typed entities);
 *  - a link whose href is not http(s), mailto or a `#` anchor is defanged to
 *    `#` (its text stays) — browsers ignore control characters inside a
 *    scheme, so those are stripped before the check ("java\tscript:");
 *  - images never load (the CSP blocks remote images anyway): an image is
 *    rendered as a plain link to it, or as its alt text when unsafe;
 *  - every link opens in a new tab with rel="nofollow noopener noreferrer".
 */
import { Marked } from "marked";

/** @param {string} href */
export function isSafeHref(href) {
  // eslint-disable-next-line no-control-regex
  const h = String(href).replace(/[\u0000- \u007f-\u009f]/g, "");
  if (h.startsWith("#")) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(h)?.[1]?.toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto";
}

/** @param {string} s */
const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const md = new Marked(
  { gfm: true, breaks: true },
  {
    walkTokens(/** @type {any} */ token) {
      if ((token.type === "link" || token.type === "image") && !isSafeHref(token.href)) token.href = "#";
    },
    renderer: {
      /** @param {any} token */
      image(token) {
        const alt = escAttr(token.text || "image");
        if (!token.href || token.href === "#") return alt;
        return `<a href="${escAttr(token.href)}">${alt}</a>`;
      },
    },
  },
);

/** @param {string} text */
export function renderMarkdown(text) {
  const html = /** @type {string} */ (md.parse(String(text ?? "").replace(/</g, "&lt;")));
  return html.replace(/<a href=/g, '<a target="_blank" rel="nofollow noopener noreferrer" href=');
}
