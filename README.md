# llms-full MCP Server

This Model Context Protocol (MCP) server provides tools for managing and searching a local RAG documentation system (using Qdrant and various embedding providers) and leverages Tavily AI for web search and discovery. It features a multi-stage pipeline for processing documentation sources.

## Features

*   **API Integration:** Access tools powered by Tavily AI and llms-full through one server.
*   **Web Search:** Perform general web search via Tavily (`tavily_search`, `tavily_extract`).
*   **Documentation RAG:** Manage and query local documentation indexed in a vector store (Qdrant + OpenAI/Ollama/Google). Includes tools for listing sources/categories, removing sources, resetting the store, and performing vector search (`llms_full_vector_store_*`).
*   **Task-Based Pipeline:** A multi-stage pipeline for ingesting documentation:
    *   **Crawl (`llms_full_crawl`):** Discovers URLs for a topic (using Tavily) or starts from a given URL/path. Crawls linked pages based on depth/limits.
    *   **Process (`llms_full_process`):** Takes completed crawl tasks, extracts content from discovered URLs, uses an LLM (Gemini or Ollama) to generate structured markdown, and saves intermediate files.
    *   **Embed (`llms_full_embed`):** Takes completed process tasks, reads the generated markdown, chunks/embeds the content using the configured embedding provider, and indexes it into the Qdrant vector store.
*   **Task Management:** Tools to monitor and manage pipeline tasks (`llms_full_get_task_status`, `llms_full_get_task_details`, `llms_full_cancel_task`, `llms_full_check_progress`, `llms_full_cleanup_task_store`).
*   **Concurrency Control:** Uses locks and queues to manage concurrent execution of pipeline stages and shared resources (like the browser).
*   **Robust & Configurable:** Includes API key/config management via environment variables and clear logging.

## Available Tools

This server provides the following tools:

**Tavily AI Tools:** (Requires `TAVILY_API_KEY`)

*   `tavily_search`: AI-powered web search with filtering options. Used by `llms_full_crawl` for topic discovery.
*   `tavily_extract`: Extract content from specified URLs.

**llms-full Tools:** (Requires Qdrant & Embedding configuration)

*   **Vector Store Management:**
    *   `llms_full_vector_store_list_categories`: List all unique categories assigned to indexed sources.
    *   `llms_full_vector_store_list_sources`: List all unique source URLs/paths currently indexed. Optionally filter by category.
    *   `llms_full_vector_store_remove_source`: Remove all indexed content originating from specific source URLs/paths.
    *   `llms_full_vector_store_reset`: Delete and recreate the documentation vector store collection. **Warning: This permanently removes all indexed data.**
    *   `llms_full_vector_store_search`: Search the vector store using natural language. Optionally filter by category (string or array), source URL/path pattern (`*` wildcard), and minimum score threshold (default 0.55).

*   **Pipeline Tools:**
    *   `llms_full_crawl`: Starts the crawling/discovery stage for one or more topics/URLs. Accepts an array of requests (topic/URL, category, crawl_depth, max_urls). Returns task IDs.
    *   `llms_full_process`: Starts the LLM processing stage using the output of completed crawl task(s). Accepts an array of crawl_task_ids or objects specifying `crawl_task_id` and `max_llm_calls`. Returns task IDs.
    *   `llms_full_embed`: Starts the embedding/indexing stage using the output of completed process task(s). Accepts an array of process_task_ids. Returns task IDs.

*   **Task Management Tools:**
    *   `llms_full_get_task_status`: Get the status of a specific task (crawl, process, embed) using `taskId`, or list tasks filtered by `taskType` ('crawl', 'process', 'embed', 'all'). Control output detail with `detail_level` ('simple', 'detailed'). Includes ETA estimation for running tasks with progress.
    *   `llms_full_get_task_details`: Get the detailed output/result string for a specific task ID (e.g., path to discovered URLs file, path to processed content file, error messages).
    *   `llms_full_cancel_task`: Attempts to cancel running/queued task(s). Provide EITHER a specific `taskId` OR set `all: true` to cancel all active crawl/process/embed tasks.
    *   `llms_full_check_progress`: Provides a summary report of crawl, process, and embed tasks, categorized by status (completed, running, queued, failed, cancelled) and showing aggregated progress (X/Y) for running tasks.
    *   `llms_full_cleanup_task_store`: Removes completed, failed, and cancelled tasks from the internal task list.

*   **Utilities:**
    *   `llms_full_util_extract_urls`: Utility to extract same-origin URLs from a webpage. Can find shallower links (controlled by `maxDepth`) and optionally add results to a processing queue file (`add_to_queue: true`).

*(Refer to the input schema definitions within the source code or use an MCP inspector tool for detailed parameters for each tool.)*

## Prerequisites

*   [Node.js](https://nodejs.org/) (v20 or higher recommended)
*   An MCP-compatible client (e.g., Cline, Cursor, Claude Desktop)
*   API Keys / Service Access for the components you intend to use (see Configuration).

## Installation & Running

### Option 1: Using NPX (Recommended for Clients)

You can run the server directly using `npx` within your MCP client configuration. This ensures you're using the latest published version.

```bash
# Example command for client configuration:
# NOTE: Replace 'llms-full-mcp-server' with the actual published package name if different.
npx -y llms-full-mcp-server
```

### Option 2: Manual Installation (for Development)

1.  Clone the repository:
    ```bash
    git clone <repository-url>
    cd llms-full-mcp-new # Or your local directory name
    ```
2.  Install dependencies (using Bun is recommended):
    ```bash
    bun install
    ```
    Or using npm:
    ```bash
    npm install
    ```
3.  Build the project:
    ```bash
    bun run build # Or npm run build
    ```
4.  Run the server:
    ```bash
    bun start # Or npm start
    ```
    Or for development with auto-rebuild (using npm scripts):
    ```bash
    npm run dev
    ```

## Configuration

### Environment Variables

Set these variables directly in your shell, using a `.env` file in the server's directory (if running manually), or within the MCP client's configuration interface. **Only set keys for services you intend to use.**

*   **Tavily (for Web Search & Crawl Discovery):**
    *   `TAVILY_API_KEY`: Your Tavily API key. **Required** for `tavily_search`, `tavily_extract`, and topic discovery in `llms_full_crawl`.

*   **LLM (for Process Stage):**
    *   `LLM_PROVIDER`: (Optional) Choose `gemini` (default) or `ollama`.
    *   `LLM_MODEL`: (Optional) Specific model name. Defaults to `gemini-2.0-flash` for `gemini`, or `llama3.1:8b` for `ollama`.
    *   `GEMINI_API_KEY`: **Required** if `LLM_PROVIDER` is `gemini`.
    *   `OLLAMA_BASE_URL`: (Optional) Base URL for Ollama if not default and `LLM_PROVIDER` is `ollama`.

*   **Embeddings (for Embed Stage & RAG):**
    *   `EMBEDDING_PROVIDER`: Choose `openai`, `ollama`, or `google`. **Required for llms-full.**
    *   `EMBEDDING_MODEL`: (Optional) Specific model name (e.g., `text-embedding-3-small`, `nomic-embed-text`, `models/embedding-001`). Defaults handled internally.
    *   `OPENAI_API_KEY`: **Required** if `EMBEDDING_PROVIDER` is `openai`.
    *   `OPENAI_BASE_URL`: (Optional) For OpenAI-compatible APIs.
    *   `OLLAMA_MODEL`: **Required** if `EMBEDDING_PROVIDER` is `ollama` (e.g., `nomic-embed-text`). URL often handled by `OLLAMA_HOST` env var.
    *   `GEMINI_API_KEY`: **Required** if `EMBEDDING_PROVIDER` is `google`. (Can be same as LLM key).
    *   `GEMINI_FALLBACK_MODEL`: (Optional) Fallback Gemini embedding model if primary fails (e.g., `text-embedding-004`).

*   **Vector Store (Qdrant):**
    *   `QDRANT_URL`: URL of your Qdrant instance (e.g., `http://localhost:6333`). **Required for llms-full.**
    *   `QDRANT_API_KEY`: (Optional) API key for Qdrant Cloud or secured instances.

### MCP Client Configuration (Example)

Add/modify the entry in your client's MCP configuration file:

```json
{
  "mcpServers": {
    "llms-full-mcp": { // Internal server name
      "command": "node", // Or "npx"
      "args": ["/Users/shariqriaz/projects/llms-full-mcp-new/build/index.js"], // Or ["-y", "llms-full-mcp-server"]
      "env": {
        // --- Required ---
        "QDRANT_URL": "http://141.147.116.40:6333",
        "EMBEDDING_PROVIDER": "ollama", // Choose: openai, ollama, google
        // --- Required based on choices above ---
        "TAVILY_API_KEY": "YOUR_TAVILY_KEY", // Needed for crawl discovery
        "GEMINI_API_KEY": "YOUR_GEMINI_KEY", // Needed if LLM/Embedding provider is google
        "OLLAMA_MODEL": "nomic-embed-text", // Needed if Embedding provider is ollama
        // "OPENAI_API_KEY": "YOUR_OPENAI_KEY", // Needed if Embedding provider is openai
        // --- Optional ---
        "LLM_PROVIDER": "gemini", // Default: gemini
        "LLM_MODEL": "gemini-2.0-flash", // Default depends on LLM_PROVIDER
        // "OLLAMA_BASE_URL": "http://localhost:11434",
        // "QDRANT_API_KEY": "YOUR_QDRANT_KEY",
        // "OPENAI_BASE_URL": "https://api.together.xyz/v1",
        // "EMBEDDING_MODEL": "models/embedding-001", // Default depends on EMBEDDING_PROVIDER
        // "GEMINI_FALLBACK_MODEL": "text-embedding-004"
      }
    }
  }
}
```

**Important:** Replace placeholders, set required keys based on your provider choices, and ensure `command`/`args` are correct. Restart your MCP client after changes.

## Usage Examples

*   "Use `tavily_search` to find recent news about vector databases."
*   "Start crawling documentation for 'shadcn ui' under category 'shadcn' using `llms_full_crawl`." (Note the task ID)
*   "Start processing the completed crawl task 'crawl-xxxxxxxx-...' using `llms_full_process`." (Note the task ID)
*   "Start embedding the completed process task 'process-xxxxxxxx-...' using `llms_full_embed`." (Note the task ID)
*   "Check the overall progress of tasks using `llms_full_check_progress`."
*   "Get the status for task 'process-xxxxxxxx-...' using `llms_full_get_task_status`."
*   "Get the detailed results file path for completed task 'process-xxxxxxxx-...' using `llms_full_get_task_details`."
*   "Cancel task 'crawl-xxxxxxxx-...' using `llms_full_cancel_task`."
*   "Cancel all active pipeline tasks using `llms_full_cancel_task` with `all: true`."
*   "Clean up finished tasks from the store using `llms_full_cleanup_task_store`."
*   "List documentation categories using `llms_full_vector_store_list_categories`."
*   "Search the documentation for 'state management' in the 'react' category using `llms_full_vector_store_search`."
*   "Reset the documentation vector store using `llms_full_vector_store_reset`."

## Development

*   **Build:** `bun run build` (or `npm run build`)
*   **Run:** `bun start` (or `npm start`)
*   **Develop:** `npm run dev` (watches for changes and rebuilds/restarts)

## License

MIT