// a minimal stdio MCP server for tests: one tool, `echo`. node --test runs
// every .mjs under test/ — run that way (not spawned by mcp-tools.test.mjs)
// it exits at once instead of waiting on stdin forever
if (process.env.MCP_ECHO_FIXTURE !== "1") process.exit(0);
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: `echo: ${req.params.arguments?.text} ${process.env.ECHO_SUFFIX ?? ""}`.trim() }],
}));
await server.connect(new StdioServerTransport());
