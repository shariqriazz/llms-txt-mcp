# llms-full MCP Server

This Model Context Protocol (MCP) server provides tools for managing and searching a local RAG documentation system (using Qdrant and various embedding providers) and leverages Tavily AI for web search and discovery. It features a unified, sequential pipeline for processing documentation sources.

## Features

*   **API Integration:** Access tools powered by Tavily AI and llms-full through one server.
*   **Web Search:** Perform general web search via Tavily (`tavily_search`, `tavily_extract`).
*   **Documentation RAG:** Manage and query local documentation indexed in a vector store (Qdrant + OpenAI/Ollama/Google). Includes tools for listing sources/categories, removing sources, resetting the store, and performing vector search (`llms_full_vector_store_*`).
*   **Unified Pipeline (`get_llms_full`):** Processes documentation sources (topics, URLs, or local files/directories) through a Discovery -> Fetch -> Synthesize -> Embed -> Cleanup pipeline. While requests are processed sequentially, web discovery and content fetching within a request can run concurrently.
   *   **Discovery:** Discovers source URLs for a topic (using Tavily) or starts from a given URL/path. Concurrently crawls linked pages if it's a web source (based on depth/limits and `BROWSER_POOL_SIZE`). Lists files if it's a local directory. Saves the list of discovered sources (URLs/paths) to a JSON file (`./data/discovery_output/<taskId>-sources.json`). (Can be skipped by providing `discovery_output_file_path`).
   *   **Fetch:** Reads the source list. Concurrently fetches content for each source using Playwright (via `BROWSER_POOL_SIZE`) for URLs or reads local files. Extracts plain text and saves each source's content to a separate Markdown file (`./data/fetch_output/<taskId>/<sanitized_name>.md`). (Can be skipped by providing `fetch_output_dir_path`).
   *   **Synthesize:** Reads the individual content files from the Fetch stage. Sequentially uses a configured LLM (Gemini, Ollama, OpenRouter, Chutes via `PIPELINE_LLM_*`) to generate structured markdown summaries for up to `max_llm_calls` files. Aggregates summaries into a single file (`./data/synthesize_output/<taskId>-summary.md`). (Can be skipped by providing `synthesized_content_file_path`).
   *   **Embed:** Takes the aggregated summary file, chunks/embeds the content using the configured embedding provider (`EMBEDDING_*`), and indexes it into the Qdrant vector store.
   *   **Cleanup:** Automatically deletes intermediate files/directories from the Discovery, Fetch, and Synthesize stages upon successful completion of the Embed stage.
   *   **Stage Control:** Optionally skip initial stages (`discovery_output_file_path`, `fetch_output_dir_path`, `synthesized_content_file_path`) or stop after a specific stage (`stop_after_stage: 'discovery' | 'fetch' | 'synthesize'`).
*   **Task Management:** Tools to monitor and manage pipeline tasks (`llms_full_get_task_status`, `llms_full_get_task_details`, `llms_full_cancel_task`, `llms_full_check_progress`, `llms_full_cleanup_task_store`, `llms_full_restart_task`).
*   **Task Restart:** Restart failed `get_llms_full` tasks from a specific stage (`discovery`, `fetch`, `synthesize`, `embed`) using previously generated intermediate data (`llms_full_restart_task`).
*   **Concurrency Control:** Implements a scheduler to manage concurrent task execution. Allows browser-dependent stages (Discovery, Fetch) of one task to potentially run concurrently with CPU/API-bound stages (Synthesize, Embed) of another task, respecting resource limits and locks:
    *   **Browser Activity:** Only one Discovery or Fetch stage runs at a time across all tasks (uses `BrowserActivityLock`). Internal operations within these stages (page fetching) use `p-limit` based on `BROWSER_POOL_SIZE`.
    *   **Synthesize:** Only one Synthesize stage runs at a time across all tasks (uses `SynthesizeLock`). Internal LLM calls within this stage use `p-limit` based on `LLM_CONCURRENCY`.
    *   **Embed:** Only one Embed stage runs at a time across all tasks (uses `EmbeddingLock`). Internal Qdrant upserts use batching (`QDRANT_BATCH_SIZE`).
*   **Robust & Configurable:** Includes API key/config management via environment variables and clear logging. Intermediate files are stored in the `./data/` directory.

## Available Tools

This server provides the following tools:

**Tavily AI Tools:** (Requires `TAVILY_API_KEY`)

*   `tavily_search`: AI-powered web search with filtering options. Used internally by `get_llms_full` for topic discovery.
*   `tavily_extract`: Extract content from specified URLs.

**llms-full Tools:** (Requires Qdrant & Embedding configuration)

*   **Vector Store Management:**
    *   `llms_full_vector_store_list_categories`: List all unique categories assigned to indexed sources.
    *   `llms_full_vector_store_list_sources`: List all unique source URLs/paths currently indexed. Optionally filter by category.
    *   `llms_full_vector_store_remove_source`: Remove all indexed content originating from specific source URLs/paths.
    *   `llms_full_vector_store_reset`: Delete and recreate the documentation vector store collection. **Warning: This permanently removes all indexed data.**
    *   `llms_full_vector_store_search`: Search the vector store using natural language. Optionally filter by category (string or array), source URL/path pattern (`*` wildcard), and minimum score threshold (default 0.55).

*   **Unified Pipeline Tool:**
    *   `get_llms_full`: Processes one or more queries/URLs/files/directories through the Discovery -> Fetch -> Synthesize -> Embed -> Cleanup pipeline. Accepts an array of requests, each specifying `category` and one of `topic_or_url`, `discovery_output_file_path` (skips discovery), `fetch_output_dir_path` (skips discovery & fetch), or `synthesized_content_file_path` (skips discovery, fetch & synthesize). Can optionally stop after a specific stage using `stop_after_stage: 'discovery' | 'fetch' | 'synthesize'`. Returns main task IDs for tracking. Intermediate files are stored in `./data/`.

*   **Task Management Tools:**
    *   `llms_full_get_task_status`: Get the status of a specific task (e.g., `get-llms-full`) using `taskId`, or list tasks filtered by `taskType` ('get-llms-full', 'all'). Control output detail with `detail_level` ('simple', 'detailed'). Includes ETA estimation for running tasks with progress.
    *   `llms_full_get_task_details`: Get the detailed output/result string for a specific task ID (e.g., paths to intermediate files, error messages, final status).
    *   `llms_full_cancel_task`: Attempts to cancel running/queued task(s). Provide EITHER a specific `taskId` OR set `all: true` to cancel all active `get-llms-full` tasks.
    *   `llms_full_check_progress`: Provides a summary report of `get-llms-full` tasks categorized by status (Total, Completed, Queued, Failed, Cancelled, Running (Overall)). Also lists tasks currently *actively processing* a stage, showing their Stage, Progress [X/Y], Description, and Elapsed Time.
    *   `llms_full_cleanup_task_store`: Removes tasks from the internal task list. By default removes completed, failed, and cancelled tasks. Optionally removes specific tasks by ID using the `taskIds` array parameter. (Note: Does not delete intermediate files from disk).
    *   `llms_full_restart_task`: Prepares a request to restart a failed `get-llms-full` task from a specific stage (`discovery`, `fetch`, `synthesize`, or `embed`) using previously generated intermediate data if available. Takes `failed_task_id` and `restart_stage`. Returns the parameters needed to call `get_llms_full` for the restart.

*   **Utilities:**
    *   `llms_full_util_extract_urls`: Utility to extract same-origin URLs from a webpage. Can find shallower links (controlled by `maxDepth`).
    *   `llms_full_synthesize_answer_from_docs`: Searches the vector store for context related to a query and uses an LLM to synthesize an answer based on the results.

*(Refer to the input schema definitions within the source code or use an MCP inspector tool for detailed parameters for each tool.)*

## Prerequisites

*   [Node.js](https://nodejs.org/) (v20 or higher recommended)
*   An MCP-compatible client (e.g., Cline, Cursor, Claude Desktop)
*   API Keys / Service Access for the components you intend to use (see Configuration).
*   **Qdrant Instance:** A running Qdrant vector database instance accessible by the server. You can run it locally using Docker:
    ```bash
    # Example running Qdrant with Docker and setting an API key
    docker run -d -p 6333:6333 \
        -e QDRANT__SERVICE__API_KEY=your_secret_api_key_here \
        qdrant/qdrant
    ```
    *Remember to set the `QDRANT_URL` and `QDRANT_API_KEY` environment variables for the MCP server accordingly.*

## Installation & Running

### Option 1: Using NPX (Recommended for Simple Client Integration)

You can run the server directly using `npx` within your MCP client configuration. This ensures you're using the latest published version.

```bash
# Example command for client configuration:
# NOTE: Replace 'llms-full-mcp-server' with the actual published package name if different.
npx -y llms-full-mcp-server
```

### Option 2: Manual Installation (for Development or Background Service)

1.  Clone the repository:
    ```bash
    git clone https://github.com/shariqriazz/llms-txt-mcp.git
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
4.  Run the server (choose one):
    *   **Foreground (Stdio):** For direct client integration or testing.
        ```bash
        bun start # Or npm start
        ```
    *   **Foreground (SSE):** For testing the SSE transport.
        ```bash
        MCP_TRANSPORT=sse MCP_PORT=3000 node build/index.js
        ```
    *   **Background (SSE - Recommended for Persistent Tasks):** Use a process manager like `pm2` or run in the background.
        ```bash
        # Example using pm2 (install with: npm install -g pm2)
        # Ensure required env vars (API keys, QDRANT_URL etc.) are set in your environment or use pm2 ecosystem file
        MCP_TRANSPORT=sse MCP_PORT=3000 pm2 start build/index.js --name llms-full-mcp

        # Example using basic backgrounding (less robust)
        MCP_TRANSPORT=sse MCP_PORT=3000 node build/index.js &
        ```
    *   **Development (Stdio with Auto-Rebuild):**
    ```bash
    npm run dev
    ```

## Configuration

### Environment Variables

Set these variables directly in your shell, using a `.env` file in the server's directory (if running manually), or within the MCP client's configuration interface. **Only set keys for services you intend to use.**

*   **Tavily (for Web Search & Crawl Discovery):**

*   **MCP Server Transport:**
    *   `MCP_TRANSPORT`: (Optional) Set to `sse` to enable Server-Sent Events transport over HTTP. Defaults to `stdio`.
    *   `MCP_PORT`: (Optional) Port number for SSE transport. Defaults to `3000`.
    *   `MCP_HOST`: (Optional) Hostname for SSE transport. Defaults to `localhost`.

*   **Tavily (for Web Search & Crawl Discovery):**
    *   `TAVILY_API_KEY`: Your Tavily API key. **Required** for `tavily_search`, `tavily_extract`, and topic discovery in `get_llms_full`.

*   **LLM (for Pipeline Synthesis Stage):**
    *   `PIPELINE_LLM_PROVIDER`: (Optional) Choose `gemini` (default), `ollama`, `openrouter`, or `chutes`.
    *   `PIPELINE_LLM_MODEL`: (Optional) Specific model name. Defaults depend on provider (e.g., `gemini-2.0-flash`, `llama3.1:8b`, `google/gemini-2.5-pro-exp-03-25:free`, `chutesai/Llama-4-Maverick-17B-128E-Instruct-FP8`).

*   **LLM (for Synthesize Answer Tool):**
    *   `SYNTHESIZE_LLM_PROVIDER`: (Optional) Choose `gemini` (default), `ollama`, `openrouter`, or `chutes`.
    *   `SYNTHESIZE_LLM_MODEL`: (Optional) Specific model name. Defaults depend on provider (e.g., `gemini-2.0-flash`, `llama3.1:8b`, `google/gemini-2.5-pro-exp-03-25:free`, `chutesai/Llama-4-Maverick-17B-128E-Instruct-FP8`).

*   **LLM Credentials & Shared Config:**
    *   `GEMINI_API_KEY`: **Required** if *any* LLM provider is `gemini` (or if embedding provider is `google`).
    *   `OPENROUTER_API_KEY`: **Required** if *any* LLM provider is `openrouter`.
    *   `CHUTES_API_KEY`: **Required** if *any* LLM provider is `chutes`.
    *   `OLLAMA_BASE_URL`: (Optional) Base URL for Ollama if *any* LLM provider is `ollama` and it's not default.
    *   `OPENROUTER_BASE_URL`: (Optional) Base URL for OpenRouter API if not default and *any* LLM provider is `openrouter`.
    *   `CHUTES_BASE_URL`: (Optional) Base URL for Chutes API (defaults to `https://llm.chutes.ai/v1`).

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

*   **Browser Pool:**
    *   `BROWSER_POOL_SIZE`: (Optional) Number of concurrent browser pages to use for crawling and content extraction. Defaults to `5`. Increase cautiously (up to a maximum of `50`) for faster processing of many URLs, but monitor RAM/CPU usage. Values below 1 are treated as 1.
   *   `LLM_CONCURRENCY`: (Optional) Number of concurrent LLM API calls during the Synthesize stage. Defaults to `3`. Increase cautiously based on LLM provider rate limits. Values below 1 are treated as 1.
   *   `QDRANT_BATCH_SIZE`: (Optional) Number of points to send in each batch during Qdrant upsert in the Embed stage. Defaults to `100`. Decrease if encountering payload size limits, increase cautiously for potentially faster indexing. Values below 1 are treated as 1.

### MCP Client Configuration (Example)

Add/modify the entry in your client's MCP configuration file (e.g., `settings.json` for Cline/Cursor).

**Option A: Stdio Transport (Server launched by client)**

```json
{
  "mcpServers": {
    "llms-full-mcp": { // Internal server name
      "command": "node", // Or "npx"
      "args": ["./build/index.js"], // Relative path example
      "env": {
        // Environment variables are passed by the client to the server process
        "QDRANT_URL": "http://localhost:6333", // Example
        "EMBEDDING_PROVIDER": "ollama", // Example
        "OLLAMA_MODEL": "nomic-embed-text", // Example
        "TAVILY_API_KEY": "YOUR_TAVILY_KEY", // Example
        "GEMINI_API_KEY": "YOUR_GEMINI_KEY", // Example
        "PIPELINE_LLM_PROVIDER": "gemini", // Example
        "..." : "..." // Add other required/optional vars
      }
    }
  }
}
```

**Option B: SSE Transport (Server running independently)**

*First, ensure the server is running in the background with `MCP_TRANSPORT=sse` and the necessary API keys/config set in its environment.*

```json
{
  "mcpServers": {
    "llms-full-mcp": {
      "type": "sse",
      "url": "http://localhost:3000",
      "alwaysAllow": [
        "tavily_search",
        "tavily_extract",
        "llms_full_vector_store_list_sources",
        "llms_full_vector_store_remove_source",
        "llms_full_vector_store_reset",
        "llms_full_vector_store_list_categories",
        "llms_full_vector_store_search",
        "llms_full_util_extract_urls",
        "llms_full_cancel_task",
        "llms_full_get_task_status",
        "llms_full_get_task_details",
        "llms_full_check_progress",
        "llms_full_synthesize_answer_from_docs",
        "get_llms_full",
        "llms_full_restart_task",
        "llms_full_cleanup_task_store"
      ],
      "timeout": 3600,
      "disabled": false
    }
  }
}
```

**Important:**
*   For Stdio: Replace placeholders in `env`, set required keys based on your provider choices, and ensure `command`/`args` are correct.
*   For SSE: Ensure the server is running independently with the correct environment variables set *before* configuring the client.
*   Restart your MCP client after making changes to its configuration.

## Usage Examples

*   "Use `tavily_search` to find recent news about vector databases."
*   "Process documentation for 'shadcn ui' under category 'shadcn' using `get_llms_full`." (Note the task ID)
*   "Process documentation for 'Radix UI' but stop after the discovery stage using `get_llms_full` with `stop_after_stage: 'discovery'`."
*   "Process documentation using a pre-existing source list file `./data/discovery_output/task123-sources.json` for category 'react' using `get_llms_full` with the `discovery_output_file_path` parameter (skips discovery)."
*   "Process documentation using a pre-existing fetched content directory `./data/fetch_output/task123/` for category 'vue' using `get_llms_full` with the `fetch_output_dir_path` parameter (skips discovery & fetch)."
*   "Process documentation using a pre-synthesized content file `./data/synthesize_output/task123-summary.md` for category 'nextjs' using `get_llms_full` with the `synthesized_content_file_path` parameter (runs embed & cleanup only)."
*   "Check the overall progress of tasks using `llms_full_check_progress`."
*   "Get the status for task 'get-llms-full-xxxxxxxx-...' using `llms_full_get_task_status`."
*   "Get the detailed results (e.g., intermediate file paths) for task 'get-llms-full-xxxxxxxx-...' using `llms_full_get_task_details`."
*   "Cancel task 'get-llms-full-xxxxxxxx-...' using `llms_full_cancel_task`."
*   "Cancel all active `get-llms-full` tasks using `llms_full_cancel_task` with `all: true`."
*   "Clean up finished tasks from the *internal task list* using `llms_full_cleanup_task_store` (does not delete files)."
*   "Remove specific tasks 'get-llms-full-xxxx', 'get-llms-full-yyyy' from the *internal task list* using `llms_full_cleanup_task_store` with the `taskIds` parameter."
*   "If task 'get-llms-full-zzzz' failed during synthesize, prepare a restart request using `llms_full_restart_task` with `failed_task_id: 'get-llms-full-zzzz'` and `restart_stage: 'synthesize'`. Then use the output to call `get_llms_full`."
*   "List documentation categories using `llms_full_vector_store_list_categories`."
*   "Search the documentation for 'state management' in the 'react' category using `llms_full_vector_store_search`."
*   "Ask 'how to integrate shadcn buttons with react-hook-form' using `llms_full_synthesize_answer_from_docs`."
*   "Reset the documentation vector store using `llms_full_vector_store_reset`."

## Development

*   **Build:** `bun run build` (or `npm run build`)
*   **Run:** `bun start` (or `npm start`)
*   **Develop:** `npm run dev` (watches for changes and rebuilds/restarts)

## License

MIT