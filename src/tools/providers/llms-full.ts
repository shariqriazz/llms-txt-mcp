import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodRawShape } from "zod";
import { ApiClient } from "../api-client.js"; // Updated import path
import {
  // Vector Store Handlers
  VectorStoreListSourcesHandler,
  VectorStoreRemoveSourceHandler,
  VectorStoreResetHandler,
  VectorStoreListCategoriesHandler,
  VectorStoreSearchHandler,
  // Utility Handlers
  UtilExtractUrlsHandler,
  CleanupTaskStoreHandler,
  // New Task-Based Handlers
  CrawlHandler,
  ProcessHandler,
  EmbedHandler,
  CancelTaskHandler,
  GetTaskStatusHandler,
  GetTaskDetailsHandler,
  CheckProgressHandler, // Added new handler
} from "../handlers/index.js";
import { pipelineEmitter } from '../../pipeline_state.js'; // Import the event emitter

// --- Configuration ---
export let apiClient: ApiClient | undefined; // Export apiClient
let isLlmsFullConfigured = false;

const COLLECTION_NAME = 'documentation'; // As defined in original handler-registry

type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;

// Corrected checkLlmsFullConfig function
export function checkLlmsFullConfig(safeLog: LogFunction): void {
    let missingVars = false;
    // Basic check for Qdrant URL
    if (!process.env.QDRANT_URL) {
        safeLog('warning', 'QDRANT_URL environment variable not set. llms-full tools require it.');
        missingVars = true;
    }
    // Basic check for provider selection
     if (!process.env.EMBEDDING_PROVIDER) {
        safeLog('warning', 'EMBEDDING_PROVIDER environment variable not set (e.g., openai, ollama, google). llms-full tools require it.');
        missingVars = true;
    } else {
        // Add checks for provider-specific keys/URLs if needed
        const provider = process.env.EMBEDDING_PROVIDER.toLowerCase();
        if (provider === 'openai' && !process.env.OPENAI_API_KEY) {
             safeLog('warning', 'EMBEDDING_PROVIDER is openai, but OPENAI_API_KEY is not set.');
             missingVars = true;
        } else if (provider === 'ollama' && !process.env.OLLAMA_BASE_URL) {
             safeLog('warning', 'EMBEDDING_PROVIDER is ollama, but OLLAMA_BASE_URL is not set (Ollama library might use OLLAMA_HOST instead).');
        } else if (provider === 'google' && !process.env.GEMINI_API_KEY) {
          safeLog('warning', 'EMBEDDING_PROVIDER is google, but GEMINI_API_KEY is not set (needed for embeddings and guide generation).');
          missingVars = true;
        }
    }
    // Also check GEMINI_API_KEY specifically if the generate tool might be used, even if embedding provider is different
    if (!process.env.GEMINI_API_KEY) {
        safeLog('warning', 'GEMINI_API_KEY environment variable not set. The llms_full_generate_llms_full_guide tool requires it.');
    }

    if (missingVars) {
        safeLog('warning', 'llms-full tools may not function correctly due to missing configuration.');
        isLlmsFullConfigured = false;
    } else {
        try {
            apiClient = new ApiClient();
            isLlmsFullConfigured = true;
             safeLog('info', 'llms-full ApiClient initialized.');
        } catch (error: any) {
            safeLog('error', `Failed to initialize llms-full ApiClient: ${error.message}`);
            apiClient = undefined;
            isLlmsFullConfigured = false;
        }
    }
}


// --- Tool Definitions (Adapting from original handler-registry.ts) ---
// Using Zod for internal definition consistency
interface LlmsFullToolDefinition {
    name: string;
    description: string;
    parameters: z.ZodObject<any>;
    handlerClass: any; // Constructor type for the handler
}

// Store handler instances for queue checking
const handlerInstances: {
    crawl?: CrawlHandler;
    process?: ProcessHandler;
    embed?: EmbedHandler;
} = {};

// Corrected llmsFullToolDefinitions object
const llmsFullToolDefinitions: Record<string, LlmsFullToolDefinition> = {
    // --- Vector Store Tools ---
    vector_store_list_sources: {
        name: 'llms_full_vector_store_list_sources',
        description: 'List all unique source URLs/paths currently indexed in the vector store. Optionally filter by category. If the store is large, consider using `llms_full_vector_store_list_categories` first to narrow down the scope.',
        parameters: z.object({
            category: z.string().optional().describe('Optional category name to filter sources by.'),
        }),
        handlerClass: VectorStoreListSourcesHandler,
    },
    vector_store_remove_source: {
        name: 'llms_full_vector_store_remove_source',
        description: 'Remove all indexed content from the vector store originating from specific source URLs/paths.',
        parameters: z.object({
            urls: z.array(z.string()).min(1).describe('Array of source URLs/paths to remove (must match exactly the indexed source string).'),
        }),
        handlerClass: VectorStoreRemoveSourceHandler,
    },
    vector_store_reset: {
        name: 'llms_full_vector_store_reset',
        description: 'Delete and recreate the documentation vector store collection (Qdrant). Warning: This permanently removes all indexed data.',
        parameters: z.object({}),
        handlerClass: VectorStoreResetHandler,
    },
    vector_store_list_categories: {
        name: 'llms_full_vector_store_list_categories',
        description: 'List all unique categories assigned to indexed sources in the vector store.',
        parameters: z.object({}),
        handlerClass: VectorStoreListCategoriesHandler,
    },
    vector_store_search: {
        name: 'llms_full_vector_store_search',
        description: 'Search the vector store using natural language. Optionally filter results by category and/or source URL/path pattern.',
        parameters: z.object({
            query: z.string().describe('The text to search for in the documentation.'),
            limit: z.coerce.number().int().min(1).max(20).optional().default(5).describe('Maximum number of results to return (1-20, default 5).'), // Use coerce
            category: z.string().or(z.array(z.string())).optional().describe('Optional category name or array of names to filter search results.'),
            url_pattern: z.string().optional().describe('Optional wildcard pattern (`*`) to filter results by source URL/path.'),
            score_threshold: z.coerce.number().min(0.0).max(1.0).optional().default(0.55).describe('Minimum similarity score (0.0-1.0) for results. Default 0.55.'), // Use coerce, updated default
        }),
        handlerClass: VectorStoreSearchHandler,
    },
    util_extract_urls: {
        name: 'llms_full_util_extract_urls',
        description: 'Utility to extract same-origin URLs from a webpage. Can find shallower links and optionally add results to the processing queue.',
        parameters: z.object({
            url: z.string().url({ message: 'Valid URL is required' }).describe('The complete URL of the webpage to analyze.'),
            add_to_queue: z.boolean().optional().default(false).describe('If true, add extracted URLs to the processing queue.'),
            maxDepth: z.number().int().min(0).optional().default(1).describe('Max additional path segments deeper than the input URL to consider (e.g., 0=same level, 1=one level deeper). Default 1.'),
        }),
        handlerClass: UtilExtractUrlsHandler,
    },
    // --- New Task-Based Tools ---
    crawl: {
        name: 'llms_full_crawl',
        description: 'Starts the crawling and discovery stage for one or more topics/URLs. Accepts an array of requests, each returning a task ID.',
        parameters: z.object({
            requests: z.array(z.object({
                topic_or_url: z.string().min(1).describe('Topic (e.g., "shadcn ui") or starting URL/path.'),
                category: z.string().min(1).describe('Category to associate with the content.'),
                crawl_depth: z.coerce.number().int().min(0).optional().default(5).describe('How many levels deeper than the discovered/provided root URL to crawl (default: 5).'),
                max_urls: z.coerce.number().int().min(1).optional().default(1000).describe('Maximum number of URLs to fetch (default: 1000).'),
            })).min(1).describe('An array containing one or more crawl requests.')
        }),
        handlerClass: CrawlHandler,
    },
    process: {
        name: 'llms_full_process',
        description: 'Starts the LLM processing stage using the output of completed crawl task(s). Accepts an array of crawl_task_ids or request objects. Returns task IDs.',
        parameters: z.object({
            requests: z.union([
                z.array(z.string().min(1)).min(1),
                z.array(z.object({
                    crawl_task_id: z.string().min(1).describe('The task ID of the completed crawl stage.'),
                    max_llm_calls: z.coerce.number().int().min(1).optional().default(1000).describe('Maximum LLM calls for processing pages (default: 1000).'),
                })).min(1)
            ]).describe('An array of completed crawl_task_ids or an array of objects containing crawl_task_id and optional max_llm_calls.')
        }),
        handlerClass: ProcessHandler,
    },
    embed: {
        name: 'llms_full_embed',
        description: 'Starts the embedding and indexing stage using the output of completed process task(s). Accepts an array of process_task_ids. Returns task IDs.',
        parameters: z.object({
            requests: z.array(z.string().min(1)).min(1).describe('An array of completed process_task_ids.')
        }),
        handlerClass: EmbedHandler,
    },
    cancel_task: {
        name: 'llms_full_cancel_task',
        description: 'Attempts to cancel a running/queued crawl, process, or embed task. Provide EITHER a specific `taskId` OR set `all` to true.',
        parameters: z.object({
            taskId: z.string().min(1).optional().describe('Optional: The unique ID of the task to cancel.'),
            all: z.boolean().optional().default(false).describe('Optional: Set true to cancel ALL active crawl/process/embed tasks instead of using taskId (default: false).'),
        }),
        handlerClass: CancelTaskHandler,
    },
    get_task_status: {
        name: 'llms_full_get_task_status',
        description: 'Get the status of a specific task (crawl, process, embed), or all tasks of a specific type, or all tasks. Control output detail with detail_level.',
        parameters: z.object({
            taskId: z.string().min(1).optional().describe('Optional: The unique ID of the task to check. If omitted, returns multiple tasks based on taskType.'),
            taskType: z.enum(['crawl', 'process', 'embed', 'all']).optional().default('all').describe('Optional: Filter tasks by type when taskId is omitted (default: all).'),
            detail_level: z.enum(['simple', 'detailed']).optional().default('simple').describe('Optional: "simple" (default) hides large fields like discoveredUrls, "detailed" includes everything.'),
        }),
        handlerClass: GetTaskStatusHandler,
    },
    get_task_details: {
        name: 'llms_full_get_task_details',
        description: 'Get the detailed output/result string for a specific task ID. This often contains JSON with results like discovered URLs or file paths.',
        parameters: z.object({
            taskId: z.string().min(1).describe('The unique ID of the task to get details for.'),
        }),
        handlerClass: GetTaskDetailsHandler,
    },
    // --- Other Tools ---
    cleanup_task_store: {
        name: 'llms_full_cleanup_task_store',
        description: 'Removes completed, failed, and cancelled tasks from the internal task list.',
        parameters: z.object({}),
        handlerClass: CleanupTaskStoreHandler,
    },
    // --- New Progress Summary Tool ---
    check_progress: {
        name: 'llms_full_check_progress',
        description: 'Provides a summary report of crawl, process, and embed tasks, categorized by status (completed, running, queued, failed, cancelled) and showing progress for running tasks.',
        parameters: z.object({}),
        handlerClass: CheckProgressHandler,
    },
  };

// Helper to convert Zod schema to JSON Schema
function zodToJsonSchema(zodSchema: z.ZodObject<any>): any {
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const key in zodSchema.shape) {
        const prop = zodSchema.shape[key];
        const description = prop.description;
        let type = 'string'; let enumValues; let items; let oneOf; // Added oneOf for union types

        // Handle complex types first (like union)
        if (prop instanceof z.ZodUnion) {
            // Basic handling for string | array[string] union
            const options = prop.options;
            if (options.length === 2 && options[0] instanceof z.ZodString && options[1] instanceof z.ZodArray && options[1].element instanceof z.ZodString) {
                oneOf = [ { type: 'string' }, { type: 'array', items: { type: 'string' } } ];
            }
            // Add more complex union handling if needed
        }
        else if (prop instanceof z.ZodString) type = 'string';
        else if (prop instanceof z.ZodNumber) type = 'number';
        else if (prop instanceof z.ZodBoolean) type = 'boolean';
        else if (prop instanceof z.ZodArray) { type = 'array'; items = { type: 'string' }; }
        else if (prop instanceof z.ZodEnum) { type = 'string'; enumValues = prop.options; }

        if (oneOf) {
             properties[key] = { oneOf, ...(description && { description }) };
        } else {
            properties[key] = { type, ...(description && { description }) };
            if (enumValues) properties[key].enum = enumValues;
            if (items) properties[key].items = items;
        }

        if (!(prop instanceof z.ZodOptional || prop instanceof z.ZodDefault)) required.push(key);
    }
    return { type: 'object', properties, ...(required.length > 0 && { required }) };
    }
   
    // Flag to ensure listener is only added once
    let pipelineListenerAttached = false;

    // --- Tool Registration Function ---
    export function registerLlmsFullTools(
    tools: Tool[],
    handlers: Map<string, (args: any) => Promise<any>>,
    safeLog: LogFunction
): void {
    if (!isLlmsFullConfigured || !apiClient) {
        safeLog('warning', 'Skipping llms-full tool registration: Client not initialized or configuration missing.');
        return;
    }

    for (const toolKey in llmsFullToolDefinitions) {
        const definition = llmsFullToolDefinitions[toolKey];
        // Instantiate the handler here
        const handlerInstance = new definition.handlerClass(apiClient, safeLog);

        // Store instances of handlers that have queues
        if (handlerInstance instanceof CrawlHandler) handlerInstances.crawl = handlerInstance;
        if (handlerInstance instanceof ProcessHandler) handlerInstances.process = handlerInstance;
        if (handlerInstance instanceof EmbedHandler) handlerInstances.embed = handlerInstance;

        // --- Attach General Pipeline Listener (only once) ---
        if (!pipelineListenerAttached && (handlerInstances.crawl || handlerInstances.process || handlerInstances.embed)) {
            pipelineEmitter.on('checkQueues', () => {
                safeLog('debug', "[Pipeline Listener] Received 'checkQueues' event. Checking tool queues...");
                // Call check methods if the handler instance exists
                handlerInstances.crawl?._checkCrawlQueue();
                handlerInstances.process?._checkProcessQueue();
                handlerInstances.embed?._checkEmbedQueue();
            });
            pipelineListenerAttached = true;
            safeLog('info', 'Attached pipeline event listener for crawl, process, and embed tool queues.');
        }
        // --- End Listener Attachment ---

        tools.push({
            name: definition.name,
            description: definition.description,
            inputSchema: zodToJsonSchema(definition.parameters)
        });

        // Ensure initCollection is called before each handler execution (except for cancel, status check, discovered urls)
        const skipInitCollection = [
            'llms_full_cancel_task',     // New cancel tool
            'llms_full_get_task_status', // New status tool
            'llms_full_get_task_details',// New details tool
            'llms_full_cleanup_task_store',
            'llms_full_check_progress', // Added new tool
            // Add other tools that don't need Qdrant init here if necessary
        ];
        if (!skipInitCollection.includes(definition.name)) {
            // Handler requires initCollection
            handlers.set(definition.name, async (args) => {
                if (!apiClient) {
                     safeLog('error', "llms-full ApiClient is undefined when handler called.");
                     throw new Error("llms-full ApiClient not initialized.");
                }
                safeLog('debug', `ApiClient object keys: ${Object.keys(apiClient || {}).join(', ')}`);
                safeLog('debug', `Does apiClient have initCollection? ${typeof (apiClient as any)?.initCollection === 'function'}`);

                try {
                    await apiClient.initCollection(COLLECTION_NAME);

                    // Validate args using Zod before execution
                    const validatedArgs = definition.parameters.parse(args);
                    // Call the handle method on the instantiated handler
                    const result = await handlerInstance.handle(validatedArgs, { cancellationToken: undefined }); // Placeholder context

                     // Format based on expected structure
                    if (result && result.content) {
                        result.content = result.content.map((part: any) =>
                            part.type === 'text' ? { ...part, text: part.text?.trim() ?? '' } : part
                        );
                        return result;
                    } else {
                        safeLog('warning', `Unexpected result format from ${definition.name}. Wrapping.`);
                        const textResult = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
                        return { content: [{ type: "text", text: textResult.trim() }] };
                    }
                } catch (error: any) {
                     safeLog('error', `llms-full tool ${definition.name} failed: ${error.message}`);
                     throw error;
                }
            });
        } else {
             handlers.set(definition.name, async (args) => {
                 try {
                     const validatedArgs = definition.parameters.parse(args);
                     const result = await handlerInstance.handle(validatedArgs, { cancellationToken: undefined }); // Placeholder context
                     return result;
                 } catch (error: any) {
                     safeLog('error', `llms-full tool ${definition.name} failed: ${error.message}`);
                     throw error;
                 }
             });
        }
    }
    safeLog('debug', 'llms-full tools registered.');
}