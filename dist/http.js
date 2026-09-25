/**
 * HCP Engagement MCP — Streamable HTTP (remote URL for Adobe AI Assistant, etc.).
 *
 * Endpoint: POST https://<host>/mcp
 * Optional: Authorization: Bearer <MCP_API_KEY>
 */
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import "dotenv/config";
import { createHcpServer } from "./create-server.js";
import { getDatabase } from "./lib/database.js";
import { optionalEnv } from "./lib/env.js";
const apiKey = optionalEnv("MCP_API_KEY");
const host = optionalEnv("HOST") ?? "0.0.0.0";
const port = Number(process.env.PORT ?? optionalEnv("MCP_PORT") ?? "3100");
function authMiddleware(req, res, next) {
    if (!apiKey) {
        next();
        return;
    }
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (token === apiKey) {
        next();
        return;
    }
    res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
    });
}
const app = createMcpExpressApp({ host });
app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "hcp-mcp" });
});
app.post("/mcp", authMiddleware, async (req, res) => {
    const server = createHcpServer(getDatabase());
    try {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on("close", () => {
            transport.close();
            server.close();
        });
    }
    catch (error) {
        console.error("MCP HTTP error:", error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal server error" },
                id: null,
            });
        }
    }
});
app.get("/mcp", (_req, res) => {
    res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Use POST for MCP Streamable HTTP" },
        id: null,
    });
});
app.listen(port, host, () => {
    console.error(`HCP MCP HTTP listening on http://${host}:${port}/mcp`);
    console.error(`Health: http://${host}:${port}/health`);
    if (!apiKey) {
        console.error("Warning: MCP_API_KEY not set — endpoint is open to anyone who knows the URL.");
    }
});
