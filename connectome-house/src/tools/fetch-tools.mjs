// @ts-check
/* connectome-house/src/tools/fetch-tools.mjs — the fleet's `fetch` tool
 * (bot-runtime.ts's createHttpTool, config-driven "http" type), ported
 * verbatim: no auth, no VEIL, same schema and defaults.
 */
import { traceReach } from "../trace.mjs";

const TIMEOUT_MS = 30_000;
const USER_AGENT = "Mozilla/5.0 (compatible; ConnectomeBot/1.0)";
const MAX_RESPONSE_LENGTH = 50_000;

/** @param {{}} [_deps] no runtime deps — a plain HTTP GET, nothing to gate on. */
export function makeFetchTools(_deps = {}) {
  const definitions = [
    {
      name: "fetch",
      description:
        "Fetch content from a URL. Use this to retrieve web pages, APIs, or any HTTP-accessible content.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch content from (must be a valid HTTP/HTTPS URL)",
          },
        },
        required: ["url"],
      },
    },
  ];

  let activeCtx = null;
  const beginTurn = (ctx) => {
    activeCtx = ctx;
  };

  async function run(input) {
    const url = input?.url;
    if (!url) return "Error: No URL provided";
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
      });
      if (!res.ok) return `Error fetching ${url}: HTTP ${res.status} ${res.statusText}`;
      return (await res.text()).substring(0, MAX_RESPONSE_LENGTH);
    } catch (e) {
      return `Error fetching ${url}: ${e.message}`;
    }
  }

  // one reach, world-facted like every house tool (trace.mjs's traceReach).
  function execute(call) {
    return traceReach(activeCtx, call, async () => ({ content: await run(call.input) }));
  }

  return { definitions, execute, beginTurn };
}
