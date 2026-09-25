import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseClient } from "./lib/database.js";
/** Shared MCP tool registrations for stdio and HTTP transports. */
export declare function createHcpServer(sql: DatabaseClient): McpServer;
