/**
 * HCP Engagement MCP — stdio (local Cursor / Claude Desktop).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "dotenv/config";
import { createHcpServer } from "./create-server.js";
import { getDatabase } from "./lib/database.js";
async function main() {
    const server = createHcpServer(getDatabase());
    await server.connect(new StdioServerTransport());
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
