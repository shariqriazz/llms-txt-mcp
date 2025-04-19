#!/usr/bin/env node

import http from 'node:http'; // Import Node HTTP module
import { URL } from 'node:url'; // Import URL for parsing

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"; // Import SSE transport (Corrected casing)
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

// --- Transport Configuration ---
const MCP_TRANSPORT = process.env.MCP_TRANSPORT?.toLowerCase() || 'stdio'; // Default to stdio
const MCP_PORT = parseInt(process.env.MCP_PORT || '3000', 10); // Default port 3000 for SSE
const MCP_HOST = process.env.MCP_HOST || 'localhost'; // Default host for SSE

// Log transport settings for verification
safeLog('debug', `MCP Transport Config: Transport=${MCP_TRANSPORT}, Host=${MCP_HOST}, Port=${MCP_PORT}`);

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

// --- Global HTTP Server and SSE Transport Store ---
let httpServer: http.Server | null = null;
let sseTransport: SSEServerTransport | null = null; // Assuming single client connection for simplicity
const SSE_POST_ENDPOINT = '/mcp-message'; // Endpoint for receiving messages from client

// --- Setup MCP Server Instance and Handlers (Run Once) ---
// Populate tools and handlers arrays/maps
registerTavilyTools(allTools, toolHandlers, safeLog);
registerLlmsFullTools(allTools, toolHandlers, safeLog);

// Setup request handlers on the main MCP Server instance
setupRequestHandlers(server, allTools, toolHandlers, safeLog);

safeLog('info', `MCP Server instance created with ${allTools.length} tools registered.`);


// --- Server Startup ---
async function runServer() {
  try {
    if (MCP_TRANSPORT === 'sse') {
        // --- SSE Transport Logic ---
        httpServer = http.createServer(async (req, res) => {
            safeLog('debug', `HTTP Request Received: ${req.method} ${req.url}`); // Add logging
            // Basic CORS handling
            res.setHeader('Access-Control-Allow-Origin', '*'); // Adjust in production
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // Add other headers if needed

            if (req.method === 'OPTIONS') {
                res.writeHead(204); // No Content
                res.end();
                return;
            }

            if (req.method === 'GET' && req.url === '/') { // Endpoint to establish SSE connection
                safeLog('info', 'SSE connection requested.');
                if (sseTransport) {
                    safeLog('warning', 'Existing SSE transport found, closing before creating new one.');
                    await sseTransport.close(); // Close existing if any
                }

                // Create transport *inside* the request handler
                sseTransport = new SSEServerTransport(SSE_POST_ENDPOINT, res);

                sseTransport.onclose = () => {
                    safeLog('info', 'SSE transport closed.');
                    sseTransport = null; // Clear the reference
                };
                sseTransport.onerror = (error) => {
                    safeLog('error', `SSE transport error: ${error.message}`);
                    sseTransport = null;
                };

                try {
                    // await sseTransport.start(); // Removed: connect() calls start() internally
                    await server.connect(sseTransport); // Connect MCP Server logic
                    safeLog('info', 'SSE transport started and connected to MCP Server.');
                } catch (connectError: any) {
                    safeLog('error', `Failed to start/connect SSE transport: ${connectError.message}`);
                    res.writeHead(500);
                    res.end('Failed to establish SSE connection.');
                    sseTransport = null;
                }

            } else if (req.method === 'POST') {
                // Parse URL to check pathname, ignoring query string
                const requestUrl = new URL(req.url || '', `http://${req.headers.host}`);
                if (requestUrl.pathname === SSE_POST_ENDPOINT || requestUrl.pathname === '/') {
                    // Handle valid POST endpoint
                    if (sseTransport) {
                        await sseTransport.handlePostMessage(req, res);
                    } else {
                        safeLog('error', 'Received POST message but no active SSE transport.');
                        res.writeHead(503); // Service Unavailable
                        res.end('No active SSE connection.');
                    }
                } else {
                    // Handle POST to unexpected path
                    safeLog('warning', `Received POST request to unexpected path: ${requestUrl.pathname}`);
                    res.writeHead(404);
                    res.end('Not Found');
                }
            } else {
                // Handle other methods (PUT, DELETE, etc.) or unexpected GET paths
                safeLog('warning', `Unhandled HTTP request: ${req.method} ${req.url}`);
                res.writeHead(404); // Or 405 Method Not Allowed
                res.end('Not Found');
            }
        }); // End of httpServer.createServer callback

        httpServer.listen(MCP_PORT, MCP_HOST, () => {
            safeLog('info', `llms-full MCP Server (SSE) listening on http://${MCP_HOST}:${MCP_PORT}`);
        });

    } else {
        // --- Stdio Transport Logic ---
        safeLog('info', 'Configuring server for Stdio transport.');
        const transport = new StdioServerTransport();
        await server.connect(transport);
        safeLog('info', 'Stdio transport connected to MCP Server.');
        safeLog('info', 'llms-full MCP Server (Stdio) running.');
    }

    // Note: Tool registration and handler setup now happens *before* connect

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
    if (httpServer) {
        safeLog('info', 'Closing HTTP server...');
        httpServer.close();
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
    if (httpServer) {
        safeLog('info', 'Closing HTTP server...');
        httpServer.close();
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