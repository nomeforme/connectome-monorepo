// @ts-check
/* Generic HTTP plumbing (JSON writer, body reader, ETag validators) shared
 * by every cacheable route — nothing here is house-specific. */

/** write a JSON response with the given status code. */
export const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

/** read + parse a request body as JSON; a missing or malformed body
 * resolves to `{}` rather than rejecting — every caller treats absence of
 * an expected field as its own 400, not a body-parse error. */
export const body = (req) =>
  new Promise((r) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        r(JSON.parse(s || "{}"));
      } catch {
        r({});
      }
    });
  });

/** quoted ETag from size+mtime — a faithful proxy since content here only
 * changes via rsync or a regen pass, both of which move mtime.
 * @param {import("node:fs").Stats} st */
export const fileTag = (st) => `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

/** match an `if-none-match` header against a tag per RFC 9110's comparison
 * rules: strips a weak (`W/`) prefix and honors the `*` wildcard. */
export const etagMatches = (inm, tag) =>
  typeof inm === "string" &&
  (inm.trim() === "*" ||
    inm
      .split(",")
      .map((s) => s.trim().replace(/^W\//, ""))
      .includes(tag));
