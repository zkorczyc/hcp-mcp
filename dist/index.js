/**
 * HCP Engagement MCP — stdio (local Cursor / Claude Desktop).
 */
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHcpServer } from "./create-server.js";
import { getSupabaseClient } from "./lib/supabase.js";
async function main() {
    const server = createHcpServer(getSupabaseClient());
    await server.connect(new StdioServerTransport());
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
