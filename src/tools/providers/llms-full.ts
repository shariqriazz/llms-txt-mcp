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
  // CrawlHandler, // Replaced by ProcessQueryHandler
  // SynthesizeLlmsFullHandler, // Replaced by ProcessQueryHandler
  // EmbedHandler, // Replaced by ProcessQueryHandler
  CancelTaskHandler,
  GetTaskStatusHandler,
  GetTaskDetailsHandler,
  CheckProgressHandler, // Added new handler
  SynthesizeAnswerHandler,
  GetLlmsFullHandler, // Renamed unified handler
  RestartLlmsFullTaskHandler, // Added restart handler
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
// No longer need to store individual stage handler instances for queue checking
// const handlerInstances: { ... } = {};

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
    // --- Unified Processing Tool ---
    get_llms_full: { // Renamed tool key
        name: 'get_llms_full', // Renamed tool name
        description: 'Processes one or more queries/URLs sequentially through crawl, synthesize, and embed stages (get_llms_full). Returns main task IDs for tracking.', // Updated description
        parameters: z.object({
            requests: z.array(z.object({
                topic_or_url: z.string().min(1).optional().describe('The topic keyword or specific URL to process (required unless providing a file path).'), // Made optional
                category: z.string().min(1).describe('The category to assign to the processed content (required).'),
                crawl_depth: z.coerce.number().int().min(0).optional().default(5).describe('Crawl depth (default: 5). Only used if crawl stage runs.'),
                max_urls: z.coerce.number().int().min(1).optional().default(1000).describe('Max URLs to crawl (default: 1000). Only used if crawl stage runs.'),
                max_llm_calls: z.coerce.number().int().min(1).optional().default(1000).describe('Max LLM calls for synthesis (default: 1000). Only used if synthesize stage runs.'),
                crawl_urls_file_path: z.string().optional().describe('Optional path to a local JSON file containing an array of URLs. Skips crawl stage.'),
                synthesized_content_file_path: z.string().optional().describe('Optional path to a local text/markdown file containing pre-synthesized content. Skips crawl and synthesize stages.'),
                stop_after_stage: z.enum(['crawl', 'synthesize']).optional().describe("Optionally stop processing after this stage ('crawl' or 'synthesize')."), // Added stop flag
            })).min(1).describe('An array of one or more queries/URLs/files to process sequentially.')
        }),
        handlerClass: GetLlmsFullHandler, // Use renamed handler class
    },
    // --- Task Management & Utility Tools ---
    cancel_task: {
        name: 'llms_full_cancel_task',
        description: 'Attempts to cancel a running/queued task (e.g., get_llms_full, crawl, synthesize, embed). Provide EITHER a specific `taskId` OR set `all` to true.', // Updated description
        parameters: z.object({
            taskId: z.string().min(1).optional().describe('Optional: The unique ID of the task to cancel.'),
            all: z.boolean().optional().default(false).describe('Optional: Set true to cancel ALL active tasks (get_llms_full, crawl, synthesize, embed) instead of using taskId (default: false).'), // Updated description
        }),
        handlerClass: CancelTaskHandler,
    },
    get_task_status: {
        name: 'llms_full_get_task_status',
        description: 'Get the status of a specific task (e.g., get_llms_full, crawl, synthesize, embed), or all tasks of a specific type, or all tasks. Control output detail with detail_level.', // Updated description
        parameters: z.object({
            taskId: z.string().min(1).optional().describe('Optional: The unique ID of the task to check. If omitted, returns multiple tasks based on taskType.'),
            taskType: z.enum(['get-llms-full', 'crawl', 'synthesize-llms-full', 'embed', 'all']).optional().default('all').describe('Optional: Filter tasks by type (e.g., get-llms-full) when taskId is omitted (default: all).'), // Added new type, updated old process->synthesize
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
    restart_task: { // New tool for restarting
        name: 'llms_full_restart_task',
        description: 'Prepares a request to restart a failed get-llms-full task from a specific stage (crawl, synthesize, or embed) using previously generated data if available.',
        parameters: z.object({
            failed_task_id: z.string().min(1).describe('The ID of the failed get-llms-full task to restart.'),
            restart_stage: z.enum(['crawl', 'synthesize', 'embed']).describe("The stage from which to restart ('crawl', 'synthesize', or 'embed')."),
        }),
        handlerClass: RestartLlmsFullTaskHandler,
    },
    // --- Other Tools ---
    cleanup_task_store: {
        name: 'llms_full_cleanup_task_store',
        description: 'Removes tasks from the internal task list. By default removes completed, failed, and cancelled tasks. Optionally removes specific tasks by ID.',
        parameters: z.object({
            taskIds: z.array(z.string().min(1)).optional().describe('Optional array of specific task IDs to remove. If omitted, all finished tasks are removed.'),
        }),
        handlerClass: CleanupTaskStoreHandler,
    },
    // --- New Progress Summary Tool ---
    check_progress: {
        name: 'llms_full_check_progress',
        description: 'Provides a summary report of tasks (e.g., get_llms_full, crawl, synthesize, embed), categorized by status (completed, running, queued, failed, cancelled) and showing progress/stage for running tasks.', // Updated description
        parameters: z.object({}),
        handlerClass: CheckProgressHandler,
    },
    synthesize_answer: {
        name: 'llms_full_synthesize_answer_from_docs',
        description: 'Searches the vector store for context related to a query and uses an LLM to synthesize an answer based on the results.',
        parameters: z.object({
            query: z.string().min(1).describe('The user query to search for and synthesize an answer from.'),
            // Add other potential parameters like search limit, score threshold?
        }),
        handlerClass: SynthesizeAnswerHandler,
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

        // No longer need to store individual handler instances for queue checking
        // if (handlerInstance instanceof CrawlHandler) ...

        // --- Attach General Pipeline Listener (only once) ---
        // Keep the listener structure in case other tools need it, but remove old checks
        if (!pipelineListenerAttached) {
            pipelineEmitter.on('checkQueues', () => {
                safeLog('debug', "[Pipeline Listener] Received 'checkQueues' event.");
                // Remove calls to old queue checks:
                // handlerInstances.crawl?._checkCrawlQueue();
                // handlerInstances.synthesizeLlmsFull?._checkSynthesizeLlmsFullQueue();
                // handlerInstances.embed?._checkEmbedQueue();
                // Add checks for other potential queue-based handlers here if needed in the future
            });
            pipelineListenerAttached = true;
            safeLog('info', 'Attached pipeline event listener.'); // Simplified message
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