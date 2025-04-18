#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// Import tool registration functions
import { registerTavilyTools, checkTavilyConfig } from "./tools/providers/tavily.js";
// Import apiClient as well
import { registerLlmsFullTools, checkLlmsFullConfig, apiClient } from "./tools/providers/llms-full.js";

// --- Configuration Check ---
// Check if required API keys are present, log warnings if not.
// The server will still run, but tools requiring missing keys will fail.
checkTavilyConfig();
checkLlmsFullConfig(safeLog);

// --- Server Initialization ---
const server = new Server(
  {
    name: "llms-full-mcp",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
      logging: {}, // Enable logging capability
    },
  }
);

// --- Logging ---
// Simplified logging - always use console.error for stdio servers
function safeLog(
  level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency',
  data: any
): void {
  const message = `[${level.toUpperCase()}] ${new Date().toISOString()} - ${typeof data === 'object' ? JSON.stringify(data) : String(data)}`;
  // Always log to stderr for stdio transport to avoid interfering with protocol messages on stdout
  console.error(message);
}

// --- Tool Registration ---
// Define handlers and tools array globally
const allTools: Tool[] = [];
const toolHandlers: Map<string, (args: any) => Promise<any>> = new Map();

// --- Request Handlers ---

// --- Server Startup ---
async function runServer() {
  try {
    const transport = new StdioServerTransport();

    await server.connect(transport);

    // --- Tool Registration (Populate After Connection) ---
    // Clear any previous state if runServer is called again (though unlikely here)
    allTools.length = 0;
    toolHandlers.clear();

    // Populate tools and handlers
    registerTavilyTools(allTools, toolHandlers, safeLog);
    registerLlmsFullTools(allTools, toolHandlers, safeLog);

    // --- Setup Request Handlers (After Connection & Tool Registration) ---
    setupRequestHandlers(server, allTools, toolHandlers, safeLog);


    // Now that we're connected and handlers are set, log success
    // Log initialization success via console.error as well
    console.error(`llms-full MCP Server initialized successfully with ${allTools.length} tools.`);
    console.error("llms-full MCP Server running on stdio.");
  } catch (error) {
    console.error("Fatal error running server:", error);
  process.exit(1);
}
}

// --- Request Handler Setup Function ---
// Moved the handler setup logic here to keep runServer cleaner
function setupRequestHandlers(
  server: Server,
  allTools: Tool[],
  toolHandlers: Map<string, (args: any) => Promise<any>>,
  safeLog: (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void
) {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const response = { tools: allTools }; // Access global allTools
    return response;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const startTime = Date.now();
    const { name, arguments: args } = request.params;
    safeLog('info', `Received CallTool request for: ${name}`);
    safeLog('debug', `Arguments: ${JSON.stringify(args)}`);

    const handler = toolHandlers.get(name); // Access global toolHandlers

    if (!handler) {
      safeLog('error', `Unknown tool called: ${name}`);
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    try {
      const result = await handler(args || {});
      const duration = Date.now() - startTime;
      safeLog('info', `Tool ${name} executed successfully in ${duration}ms.`);
      safeLog('debug', `Result for ${name}: ${JSON.stringify(result)}`);
      // Ensure result is always an object with content array
      if (typeof result === 'string') {
          return { content: [{ type: 'text', text: result.trim() }] }; // Trim result
      } else if (result && Array.isArray(result.content)) {
           // Ensure text content is trimmed
          result.content = result.content.map((part: any) =>
              part.type === 'text' ? { ...part, text: part.text?.trim() ?? '' } : part
          );
          return result;
      } else {
           safeLog('warning', `Unexpected result format for tool ${name}. Wrapping in text content.`);
           // Ensure stringified result is trimmed
           return { content: [{ type: 'text', text: JSON.stringify(result).trim() }] };
      }
    } catch (error: any) {
      const duration = Date.now() - startTime;
      safeLog('error', `Error executing tool ${name} after ${duration}ms: ${error.message}`);
      safeLog('debug', `Error details: ${error.stack}`);
      return {
        content: [
          {
            type: "text",
             // Ensure error message is trimmed
            text: `Error executing ${name}: ${error.message}`.trim(),
          },
        ],
        isError: true,
      };
    }
  });
}

// --- Graceful Shutdown ---
process.on('SIGINT', async () => {
  safeLog('info', 'Received SIGINT, shutting down server...');
  if (apiClient) { // apiClient is now imported and accessible
      safeLog('info', 'Cleaning up API client resources (e.g., browser)...');
      await apiClient.cleanup();
  }
  await server.close();
  console.error('Server shut down gracefully.');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  safeLog('info', 'Received SIGTERM, shutting down server...');
  if (apiClient) { // apiClient is now imported and accessible
      safeLog('info', 'Cleaning up API client resources (e.g., browser)...');
      await apiClient.cleanup();
  }
  await server.close();
  console.error('Server shut down gracefully.');
  process.exit(0);
});

// --- Run the server ---
runServer().catch((error) => {
  console.error("Unhandled error during server startup:", error);
  process.exit(1);
});