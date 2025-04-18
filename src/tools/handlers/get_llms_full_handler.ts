import { BaseHandler } from './base-handler.js';
import { McpToolResponse, QdrantPoint } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit'; // Import p-limit for Fetch stage concurrency
import { TaskInfo, TaskStatusValue, registerTask, getTaskStatus, setTaskStatus, updateTaskDetails, isTaskCancelled, setTaskStage } from '../../tasks.js'; // Added setTaskStage
import * as PipelineState from '../../pipeline_state.js'; // Re-add for embedding lock
import { retryAsyncFunction } from '../utils/retry.js';
import { discoverStartingPoint } from '../utils/discovery.js';
import { crawlWebsite } from '../utils/crawler.js'; // Consider renaming this later
import { extractTextContent } from '../utils/content_extractor.js'; // Needed for Fetch stage
import { summarizeContentFiles } from '../utils/llm_processor.js'; // Use renamed function
import { chunkText, generateQdrantPoints } from '../utils/vectorizer.js';
import { sanitizeFilename } from '../utils/file_utils.js';
import { ApiClient } from '../api-client.js';

// --- Input Schema ---
// Add fetch_output_dir_path for restarting
const StopStageEnum = z.enum(['discovery', 'fetch', 'synthesize']).optional().describe("Optionally stop processing after this stage ('discovery', 'fetch', or 'synthesize').");

const ProcessQueryRequestSchema = z.object({
  topic_or_url: z.string().min(1).optional().describe('The topic keyword, specific URL, or local path to process (required unless providing a file path).'),
  category: z.string().min(1).describe('The category to assign to the processed content (required).'),
  crawl_depth: z.coerce.number().int().min(0).optional().default(5).describe('How many levels deeper than the discovered/provided root URL to crawl for links (default: 5). Only used if discovery stage runs and finds a web source.'),
  max_urls: z.coerce.number().int().min(1).optional().default(1000).describe('Maximum number of URLs to discover/process (default: 1000). Used in discovery and fetch stages.'),
  max_llm_calls: z.coerce.number().int().min(1).optional().default(1000).describe('Maximum number of content files to summarize with the LLM (default: 1000). Used in synthesize stage.'),
  // Renamed crawl_urls_file_path to discovery_output_file_path
  discovery_output_file_path: z.string().optional().describe('Optional path to a local JSON file containing an array of source URLs/paths. If provided, the discovery stage is skipped.'),
  // Added fetch_output_dir_path
  fetch_output_dir_path: z.string().optional().describe('Optional path to a local directory containing pre-fetched content files (.md). If provided, discovery and fetch stages are skipped.'),
  synthesized_content_file_path: z.string().optional().describe('Optional path to a local markdown file containing pre-synthesized content. If provided, discovery, fetch and synthesize stages are skipped.'),
  stop_after_stage: StopStageEnum,
}).refine(data => data.topic_or_url || data.discovery_output_file_path || data.fetch_output_dir_path || data.synthesized_content_file_path, {
    message: "Either topic_or_url, discovery_output_file_path, fetch_output_dir_path, or synthesized_content_file_path must be provided.",
});


const ProcessQueryInputSchema = z.object({
  requests: z.array(ProcessQueryRequestSchema).min(1).describe('An array of one or more queries/URLs/files to process sequentially.'),
});

type QueryRequest = z.infer<typeof ProcessQueryRequestSchema>;

// --- Interfaces for Stage Results ---
interface DiscoveryResult {
    sourcesFilePath: string; // Path to the JSON file listing URLs/paths
    category: string;
    isSourceLocal: boolean; // Was the *initial* input local?
    originalInput: string; // The original topic_or_url or input file path
}

interface FetchResult {
    fetchOutputDirPath: string; // Path to the directory containing fetched .md files
    category: string;
    originalInput: string;
    sourceCount: number; // How many files were fetched/created
}

interface SynthesizeResult {
    summaryFilePath: string; // Path to the aggregated summary .md file
    category: string;
    originalInput: string;
}

// --- Constants ---
const MAX_RETRY_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const BASE_DATA_DIR = './data'; // New base directory
const DISCOVERY_OUTPUT_DIR = path.join(BASE_DATA_DIR, 'discovery_output');
const FETCH_OUTPUT_DIR = path.join(BASE_DATA_DIR, 'fetch_output');
const SYNTHESIZE_OUTPUT_DIR = path.join(BASE_DATA_DIR, 'synthesize_output');
const QDRANT_COLLECTION_NAME = 'documentation';

// Read Browser Pool Size for Fetch stage concurrency
const BROWSER_POOL_SIZE = Math.min(Math.max(1, parseInt(process.env.BROWSER_POOL_SIZE || '5', 10) || 5), 50);
// Read Qdrant Batch Size
const QDRANT_BATCH_SIZE = Math.max(1, parseInt(process.env.QDRANT_BATCH_SIZE || '100', 10) || 100);


// --- State Management ---
interface QueuedQuery {
    mainTaskId: string;
    request: QueryRequest;
}
const queryQueue: QueuedQuery[] = [];
let isProcessing = false;

// --- Handler Class ---
export class GetLlmsFullHandler extends BaseHandler {

  constructor(apiClient: ApiClient, safeLog?: any) {
    super(apiClient, safeLog);
    // Ensure base data directory exists on startup
    fs.mkdir(BASE_DATA_DIR, { recursive: true }).catch(err => {
        this.safeLog?.('error', `Failed to create base data directory ${BASE_DATA_DIR}: ${err}`);
    });
  }

  async handle(args: any): Promise<McpToolResponse> {
    const validationResult = ProcessQueryInputSchema.safeParse(args);
    if (!validationResult.success) {
      const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
      throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${errorMessage}`);
    }
    const { requests } = validationResult.data;

    const taskResponses: string[] = [];
    for (const request of requests) {
        const mainTaskId = registerTask('get-llms-full');
        const description = request.topic_or_url || request.discovery_output_file_path || request.fetch_output_dir_path || request.synthesized_content_file_path || 'unknown input';
        updateTaskDetails(mainTaskId, `Queued processing for: ${description}`);
        setTaskStatus(mainTaskId, 'queued');

        queryQueue.push({ mainTaskId, request });
        taskResponses.push(`Task ${mainTaskId} queued for processing "${description}".`);
        this.safeLog?.('info', `Queued task ${mainTaskId} for: ${description}. Queue size: ${queryQueue.length}`);
    }

    this._triggerProcessingLoop();

    const summary = `Queued ${requests.length} requests for sequential processing.\nTask details:\n${taskResponses.join('\n')}`;
    return { content: [{ type: 'text', text: summary }] };
  }

  // --- Processing Loop ---
  private async _triggerProcessingLoop(): Promise<void> {
    if (isProcessing) {
      this.safeLog?.('debug', 'Processing loop already active.');
      return;
    }
    if (queryQueue.length === 0) {
      this.safeLog?.('debug', 'Processing queue is empty. Loop idle.');
      return;
    }

    if (isProcessing) return;
    isProcessing = true;

    const { mainTaskId, request } = queryQueue.shift()!;

    const taskInfo = getTaskStatus(mainTaskId);
    if (taskInfo?.status === 'cancelled') {
        this.safeLog?.('info', `[${mainTaskId}] Skipping cancelled task dequeued.`);
        isProcessing = false;
        setTimeout(() => this._triggerProcessingLoop(), 50);
        return;
    }

    const description = request.topic_or_url || request.discovery_output_file_path || request.fetch_output_dir_path || request.synthesized_content_file_path || 'unknown input';
    this.safeLog?.('info', `[${mainTaskId}] Starting processing for: ${description}`);
    setTaskStatus(mainTaskId, 'running');

    let discoveryResult: DiscoveryResult | null = null;
    let fetchResult: FetchResult | null = null;
    let synthesizeResult: SynthesizeResult | null = null;
    let completedNormally = false;
    let finalStatus: TaskStatusValue = 'failed'; // Assume failure unless explicitly completed

    try {
        // --- Stage Execution Logic ---
        if (request.synthesized_content_file_path) {
            // Skip Discovery, Fetch, Synthesize
            this.safeLog?.('info', `[${mainTaskId}] Skipping Discovery, Fetch, Synthesize stages (Synthesized file provided).`);
            synthesizeResult = {
                summaryFilePath: request.synthesized_content_file_path,
                category: request.category,
                originalInput: description
            };
            await this._executeEmbedStage(mainTaskId, synthesizeResult);
            completedNormally = true; // Embed is the last processing stage

        } else if (request.fetch_output_dir_path) {
            // Skip Discovery, Fetch
            this.safeLog?.('info', `[${mainTaskId}] Skipping Discovery, Fetch stages (Fetch output dir provided).`);
            // We need to know the source count if possible, maybe scan the dir? For now, set 0.
            fetchResult = {
                fetchOutputDirPath: request.fetch_output_dir_path,
                category: request.category,
                originalInput: description,
                sourceCount: 0 // Unknown count when skipping fetch stage
            };
            synthesizeResult = await this._executeSynthesizeStage(mainTaskId, request, fetchResult);
            if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
            if (request.stop_after_stage === 'synthesize') {
                completedNormally = true;
            } else {
                await this._executeEmbedStage(mainTaskId, synthesizeResult);
                completedNormally = true;
            }

        } else if (request.discovery_output_file_path) {
            // Skip Discovery
            this.safeLog?.('info', `[${mainTaskId}] Skipping Discovery stage (Discovery output file provided).`);
            discoveryResult = {
                sourcesFilePath: request.discovery_output_file_path,
                category: request.category,
                isSourceLocal: true, // Assume local if file path provided
                originalInput: description
            };
            fetchResult = await this._executeFetchStage(mainTaskId, request, discoveryResult);
            if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
            if (request.stop_after_stage === 'fetch') {
                completedNormally = true;
            } else {
                synthesizeResult = await this._executeSynthesizeStage(mainTaskId, request, fetchResult);
                if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
                if (request.stop_after_stage === 'synthesize') {
                    completedNormally = true;
                } else {
                    await this._executeEmbedStage(mainTaskId, synthesizeResult);
                    completedNormally = true;
                }
            }

        } else if (request.topic_or_url) {
            // Full Pipeline
            discoveryResult = await this._executeDiscoveryStage(mainTaskId, request);
            if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
            if (request.stop_after_stage === 'discovery') {
                completedNormally = true;
            } else {
                fetchResult = await this._executeFetchStage(mainTaskId, request, discoveryResult);
                if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
                if (request.stop_after_stage === 'fetch') {
                    completedNormally = true;
                } else {
                    synthesizeResult = await this._executeSynthesizeStage(mainTaskId, request, fetchResult);
                    if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
                    if (request.stop_after_stage === 'synthesize') {
                        completedNormally = true;
                    } else {
                        await this._executeEmbedStage(mainTaskId, synthesizeResult);
                        completedNormally = true;
                    }
                }
            }
        } else {
             throw new Error("Invalid request state: No valid starting input found.");
        }

        // --- Final Status Update ---
        if (isTaskCancelled(mainTaskId)) {
             finalStatus = 'cancelled';
             this.safeLog?.('info', `[${mainTaskId}] Task processing stopped due to cancellation.`);
             updateTaskDetails(mainTaskId, `Task cancelled during ${getTaskStatus(mainTaskId)?.details || 'processing'}.`);
        } else if (completedNormally) {
            finalStatus = 'completed';
            const stoppedAfter = request.stop_after_stage || 'embed';
            this.safeLog?.('info', `[${mainTaskId}] Processing COMPLETED successfully for: ${description} (Stopped after: ${stoppedAfter})`);

            // Try to run cleanup only if the full pipeline completed (embed was the last step)
            if (stoppedAfter === 'embed') {
                try {
                    await this._executeCleanupStage(mainTaskId, discoveryResult, fetchResult, synthesizeResult);
                } catch (cleanupError: any) {
                    this.safeLog?.('error', `[${mainTaskId}] Cleanup stage failed: ${cleanupError.message}. Task still marked completed.`);
                    // Don't change status back to failed just because cleanup failed
                }
            } else {
                 // Update details with path to last output if stopped early
                 let lastOutputPath = '';
                 if (stoppedAfter === 'discovery') lastOutputPath = discoveryResult?.sourcesFilePath || '';
                 else if (stoppedAfter === 'fetch') lastOutputPath = fetchResult?.fetchOutputDirPath || '';
                 else if (stoppedAfter === 'synthesize') lastOutputPath = synthesizeResult?.summaryFilePath || '';
                 // Ensure the result object exists before accessing properties
                 const resultPayload = {
                     stage: stoppedAfter,
                     result: { outputPath: lastOutputPath }
                 };
                 updateTaskDetails(mainTaskId, JSON.stringify(resultPayload, null, 2));
            }
        } else {
            // Should not happen if logic is correct, but handle defensively
            finalStatus = 'failed';
            this.safeLog?.('error', `[${mainTaskId}] Task ended in unexpected state.`);
            updateTaskDetails(mainTaskId, 'Task failed due to unexpected state.');
        }

    } catch (error: any) {
        this.safeLog?.('error', `[${mainTaskId}] Processing failed for query ${description}. Reason: ${error.message}`);
        finalStatus = 'failed';
        // Update details only if not already cancelled
        if (getTaskStatus(mainTaskId)?.status !== 'cancelled') {
             const errorMessage = `Processing failed: ${error?.message || 'Unknown error'}`;
             updateTaskDetails(mainTaskId, errorMessage);
        }
    } finally {
        setTaskStatus(mainTaskId, finalStatus); // Set final status
        isProcessing = false;
        this.safeLog?.('debug', `[${mainTaskId}] Finished processing attempt. Scheduling next loop check.`);
        setTimeout(() => this._triggerProcessingLoop(), 50);
    }
  }

  // --- Stage Execution Methods ---

  private async _executeDiscoveryStage(mainTaskId: string, request: QueryRequest): Promise<DiscoveryResult> {
    setTaskStage(mainTaskId, 'Discovery'); // Set stage explicitly
    updateTaskDetails(mainTaskId, `Discovery Stage: Starting for ${request.topic_or_url}...`); // Already Corrected
    let discoveredSources: string[] = [];
    let isSourceLocal = false;
    const { topic_or_url, category, crawl_depth, max_urls } = request;
    let sourcesFilePath = '';

    await retryAsyncFunction(
        async () => {
            if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
            updateTaskDetails(mainTaskId, `Discovery Stage: Discovering sources for ${topic_or_url}...`);
            const discoveryResult = await discoverStartingPoint(topic_or_url!, this.safeLog);
            const start_url_or_path = discoveryResult.startUrlOrPath;
            isSourceLocal = discoveryResult.isLocal;
            updateTaskDetails(mainTaskId, `Discovery Stage: Starting point: ${start_url_or_path} (Local: ${isSourceLocal})`);

            if (!isSourceLocal) {
                // Use crawlWebsite for web discovery
                updateTaskDetails(mainTaskId, `Discovery Stage: Crawling website from ${start_url_or_path} (Depth: ${crawl_depth}, Max URLs: ${max_urls})...`);
                discoveredSources = await crawlWebsite(mainTaskId, start_url_or_path, crawl_depth, max_urls, this.apiClient, this.safeLog);
            } else {
                // Handle local path - check if it's a directory or file
                const stats = await fs.stat(start_url_or_path);
                if (stats.isDirectory()) {
                    updateTaskDetails(mainTaskId, `Discovery Stage: Scanning directory: ${start_url_or_path}`);
                    // Basic recursive scan for .md, .txt, .docx (can be expanded)
                    const files = await fs.readdir(start_url_or_path, { recursive: true, withFileTypes: true });
                    discoveredSources = files
                        .filter(dirent => dirent.isFile() && ['.md', '.txt', '.docx'].includes(path.extname(dirent.name).toLowerCase()))
                        .map(dirent => path.join(dirent.path, dirent.name)) // Use dirent.path
                        .slice(0, max_urls); // Apply max_urls limit
                } else if (stats.isFile()) {
                     updateTaskDetails(mainTaskId, `Discovery Stage: Using single local file: ${start_url_or_path}`);
                     discoveredSources = [start_url_or_path];
                } else {
                    throw new Error(`Unsupported local path type: ${start_url_or_path}`);
                }
            }
        },
        MAX_RETRY_ATTEMPTS, INITIAL_RETRY_DELAY_MS, `Discovery Stage for ${topic_or_url} (Task ${mainTaskId})`, this.safeLog, mainTaskId
    );

    if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);

    updateTaskDetails(mainTaskId, `Discovery Stage: Found ${discoveredSources.length} source(s). Saving source list...`);
    await fs.mkdir(DISCOVERY_OUTPUT_DIR, { recursive: true });
    const sourcesFilename = `${mainTaskId}-sources.json`;
    sourcesFilePath = path.join(DISCOVERY_OUTPUT_DIR, sourcesFilename);
    await fs.writeFile(sourcesFilePath, JSON.stringify(discoveredSources, null, 2), 'utf-8');
    this.safeLog?.('info', `[${mainTaskId}] Saved discovered sources to ${sourcesFilePath}`);

    const result: DiscoveryResult = { sourcesFilePath, category, isSourceLocal, originalInput: topic_or_url! };
    updateTaskDetails(mainTaskId, JSON.stringify({ stage: 'discovery', result }, null, 2)); // Update details with result path
    return result;
  }

  private async _executeFetchStage(mainTaskId: string, request: QueryRequest, discoveryResult: DiscoveryResult): Promise<FetchResult> {
    const { sourcesFilePath, category, originalInput } = discoveryResult;
    const { max_urls } = request; // Use max_urls from request to limit fetching too
    let fetchedCount = 0;
    let errorCount = 0;

    setTaskStage(mainTaskId, 'Fetch'); // Set stage explicitly
    updateTaskDetails(mainTaskId, `Fetch Stage: Starting for ${originalInput}...`); // Already Corrected

    let sourcesToFetch: string[];
    try {
        updateTaskDetails(mainTaskId, `Fetch Stage: Reading source list from ${sourcesFilePath}...`);
        const fileContent = await fs.readFile(sourcesFilePath, 'utf-8');
        sourcesToFetch = JSON.parse(fileContent);
        if (!Array.isArray(sourcesToFetch)) throw new Error('Source file content is not a valid JSON array.');
        // Apply max_urls limit if necessary
        if (sourcesToFetch.length > max_urls) {
            this.safeLog?.('warning', `[${mainTaskId}] Source list (${sourcesToFetch.length}) exceeds max_urls (${max_urls}). Truncating fetch list.`);
            sourcesToFetch = sourcesToFetch.slice(0, max_urls);
        }
        this.safeLog?.('info', `[${mainTaskId}] Read ${sourcesToFetch.length} sources to fetch from ${sourcesFilePath}.`);
    } catch (fileError: any) {
        throw new Error(`Failed to read or parse sources file ${sourcesFilePath}: ${fileError.message}`);
    }

    const fetchOutputDirPath = path.join(FETCH_OUTPUT_DIR, mainTaskId);
    await fs.mkdir(fetchOutputDirPath, { recursive: true });
    updateTaskDetails(mainTaskId, `Fetch Stage: Fetching content for ${sourcesToFetch.length} sources (Concurrency: ${BROWSER_POOL_SIZE})...`);

    const limit = pLimit(BROWSER_POOL_SIZE);
    const fetchPromises = sourcesToFetch.map((source, index) =>
        limit(async () => {
            if (isTaskCancelled(mainTaskId)) return; // Stop processing this item

            const progress = `${index + 1}/${sourcesToFetch.length}`;
            // Update details more frequently during fetch
            if ((index + 1) % 5 === 0 || index === sourcesToFetch.length - 1) {
                 updateTaskDetails(mainTaskId, `Fetch Stage: Processing ${progress}: ${source}`);
            }
            try {
                const content = await extractTextContent(source, this.apiClient, this.safeLog);
                const outputFilename = `${sanitizeFilename(source)}.md`;
                const outputPath = path.join(fetchOutputDirPath, outputFilename);
                await fs.writeFile(outputPath, content, 'utf-8');
                fetchedCount++;
            } catch (error: any) {
                this.safeLog?.('error', `[${mainTaskId}] Failed to fetch/extract ${source}: ${error.message}`);
                errorCount++;
                // Optionally save error info? For now, just log and count.
            }
        })
    );

    await Promise.all(fetchPromises);

    if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);

    updateTaskDetails(mainTaskId, `Fetch Stage: Finished fetching. Success: ${fetchedCount}, Errors: ${errorCount}. Output: ${fetchOutputDirPath}`);
    if (fetchedCount === 0 && sourcesToFetch.length > 0) {
        throw new Error(`Fetch stage failed to process any sources successfully.`);
    }

    const result: FetchResult = { fetchOutputDirPath, category, originalInput, sourceCount: fetchedCount };
    updateTaskDetails(mainTaskId, JSON.stringify({ stage: 'fetch', result }, null, 2)); // Update details with result path
    return result;
  }

  private async _executeSynthesizeStage(mainTaskId: string, request: QueryRequest, fetchResult: FetchResult): Promise<SynthesizeResult> {
    const { fetchOutputDirPath, category, originalInput, sourceCount } = fetchResult;
    const { max_llm_calls } = request;

    setTaskStage(mainTaskId, 'Synthesize'); // Set stage explicitly
    updateTaskDetails(mainTaskId, `Synthesize Stage: Starting for ${originalInput} (Max LLM Calls: ${max_llm_calls})...`); // Already Corrected

    // Call the refactored summarizeContentFiles function
    const aggregatedSummary = await retryAsyncFunction(
        () => summarizeContentFiles(
            mainTaskId,
            fetchOutputDirPath,
            originalInput, // Pass originalInput as topic for the header
            max_llm_calls,
            this.safeLog
        ),
        MAX_RETRY_ATTEMPTS,
        INITIAL_RETRY_DELAY_MS,
        `Synthesize Stage for ${originalInput} (Task ${mainTaskId})`,
        this.safeLog,
        mainTaskId
    );

    if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);

    // summarizeContentFiles now handles internal looping, progress updates, and error aggregation
    // We just need to save the final result.
    updateTaskDetails(mainTaskId, `Synthesize Stage: LLM summarization complete. Saving summary file...`);

    await fs.mkdir(SYNTHESIZE_OUTPUT_DIR, { recursive: true });
    const summaryFilename = `${mainTaskId}-summary.md`;
    const summaryFilePath = path.join(SYNTHESIZE_OUTPUT_DIR, summaryFilename);
    await fs.writeFile(summaryFilePath, aggregatedSummary, 'utf-8');
    this.safeLog?.('info', `[${mainTaskId}] Saved aggregated summary to ${summaryFilePath}`);

    const result: SynthesizeResult = { summaryFilePath, category, originalInput };
    updateTaskDetails(mainTaskId, JSON.stringify({ stage: 'synthesize', result }, null, 2)); // Update details with result path
    return result;
  }


  private async _executeEmbedStage(mainTaskId: string, synthesizeResult: SynthesizeResult): Promise<void> {
    const { summaryFilePath, category, originalInput } = synthesizeResult;
    setTaskStage(mainTaskId, 'Embed'); // Set stage explicitly
    updateTaskDetails(mainTaskId, `Embed Stage: Starting for ${originalInput} (Category: ${category})...`); // Already Corrected

    await retryAsyncFunction(
        async () => {
            if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
            // Use the shared embedding lock from pipeline_state
            if (!PipelineState.acquireEmbeddingLock()) {
                this.safeLog?.('warning', `[${mainTaskId}] Failed to acquire shared embedding lock. Retrying...`);
                throw new Error("Could not acquire embedding resource lock. System busy?");
            }
            this.safeLog?.('debug', `[${mainTaskId}] Acquired shared embedding lock.`);
            let innerError: any = null;
            try {
                await this.apiClient.initCollection(QDRANT_COLLECTION_NAME);
                updateTaskDetails(mainTaskId, `Embed Stage: Reading summary file: ${summaryFilePath}`);
                const fileContent = await fs.readFile(summaryFilePath, 'utf-8');
                updateTaskDetails(mainTaskId, `Embed Stage: Chunking text content...`);
                const chunks = chunkText(fileContent);

                if (chunks.length === 0) {
                    this.safeLog?.('warning', `[${mainTaskId}] No text chunks generated from ${summaryFilePath}. Skipping embedding.`);
                    return;
                }

                updateTaskDetails(mainTaskId, `Embed Stage: Generating embeddings for ${chunks.length} chunks...`);
                const points: QdrantPoint[] = await generateQdrantPoints(
                    chunks, summaryFilePath, category, this.apiClient, this.safeLog, mainTaskId // Pass taskId
                );

                if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);

                if (points.length > 0) {
                    updateTaskDetails(mainTaskId, `Embed Stage: Embedding complete. Upserting ${points.length} points to Qdrant in batches of ${QDRANT_BATCH_SIZE}...`);
                    // Use QDRANT_BATCH_SIZE read from env/default
                    for (let i = 0; i < points.length; i += QDRANT_BATCH_SIZE) {
                        if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled during upsert batching.`);
                        const batch = points.slice(i, i + QDRANT_BATCH_SIZE);
                        const batchNum = Math.floor(i / QDRANT_BATCH_SIZE) + 1;
                        const totalBatches = Math.ceil(points.length / QDRANT_BATCH_SIZE);
                        updateTaskDetails(mainTaskId, `Embed Stage: Upserting batch ${batchNum}/${totalBatches} (${batch.length} points)...`);
                        await this.apiClient.qdrantClient.upsert(QDRANT_COLLECTION_NAME, { wait: true, points: batch });
                        this.safeLog?.('debug', `[${mainTaskId}] Upserted batch ${batchNum}/${totalBatches}`);
                    }
                    this.safeLog?.('info', `[${mainTaskId}] Successfully embedded and indexed: ${summaryFilePath}`);
                    // Update details message after successful upsert loop
                    updateTaskDetails(mainTaskId, `Embed Stage: Upsert complete for ${points.length} points.`);
                } else {
                    this.safeLog?.('warning', `[${mainTaskId}] No vector points generated for ${summaryFilePath} after embedding attempt.`);
                }
            } catch (error) {
                innerError = error;
                this.safeLog?.('error', `[${mainTaskId}] Error during embed/upsert attempt: ${JSON.stringify(error, null, 2)}`);
            } finally {
                PipelineState.releaseEmbeddingLock();
                this.safeLog?.('debug', `[${mainTaskId}] Released shared embedding lock.`);
                if (innerError) throw innerError;
            }
        },
        MAX_RETRY_ATTEMPTS, INITIAL_RETRY_DELAY_MS, `Embed Stage for ${summaryFilePath} (Task ${mainTaskId})`, this.safeLog, mainTaskId
    );

     if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
     const finalDetailMsg = `Embed Stage: Successfully indexed content from ${summaryFilePath} into category '${category}'.`;
     updateTaskDetails(mainTaskId, finalDetailMsg); // Keep this final detail before cleanup
  }

  private async _executeCleanupStage(
      mainTaskId: string,
      discoveryResult: DiscoveryResult | null,
      fetchResult: FetchResult | null,
      synthesizeResult: SynthesizeResult | null
  ): Promise<void> {
      setTaskStage(mainTaskId, 'Cleanup'); // Set stage explicitly
      updateTaskDetails(mainTaskId, `Cleanup Stage: Starting for ${mainTaskId}...`); // Already Corrected
      this.safeLog?.('info', `[${mainTaskId}] Starting cleanup of intermediate files...`);
      let errors: string[] = [];

      // Delete discovery output
      if (discoveryResult?.sourcesFilePath) {
          try {
              await fs.unlink(discoveryResult.sourcesFilePath);
              this.safeLog?.('debug', `[${mainTaskId}] Deleted discovery file: ${discoveryResult.sourcesFilePath}`);
          } catch (err: any) {
              if (err.code !== 'ENOENT') { // Ignore if file already gone
                  errors.push(`Failed to delete discovery file ${discoveryResult.sourcesFilePath}: ${err.message}`);
              }
          }
      }

      // Delete fetch output directory
      if (fetchResult?.fetchOutputDirPath) {
          try {
              await fs.rm(fetchResult.fetchOutputDirPath, { recursive: true, force: true });
              this.safeLog?.('debug', `[${mainTaskId}] Deleted fetch output directory: ${fetchResult.fetchOutputDirPath}`);
          } catch (err: any) {
               errors.push(`Failed to delete fetch output directory ${fetchResult.fetchOutputDirPath}: ${err.message}`);
          }
      }

      // Delete synthesize output file
      if (synthesizeResult?.summaryFilePath) {
          try {
              await fs.unlink(synthesizeResult.summaryFilePath);
              this.safeLog?.('debug', `[${mainTaskId}] Deleted synthesize file: ${synthesizeResult.summaryFilePath}`);
          } catch (err: any) {
              if (err.code !== 'ENOENT') { // Ignore if file already gone
                  errors.push(`Failed to delete synthesize file ${synthesizeResult.summaryFilePath}: ${err.message}`);
              }
          }
      }

      if (errors.length > 0) {
          const errorMsg = `Cleanup stage completed with errors: ${errors.join('; ')}`;
          this.safeLog?.('error', `[${mainTaskId}] ${errorMsg}`);
          // Update details slightly to mention cleanup errors, but task is still complete
          updateTaskDetails(mainTaskId, `Processing completed successfully, but cleanup encountered errors.`);
          // Optionally re-throw or handle differently? For now, just log.
      } else {
          this.safeLog?.('info', `[${mainTaskId}] Cleanup completed successfully.`);
          updateTaskDetails(mainTaskId, `Processing completed successfully.`); // Final success message
      }
  }

  // Removed _callLLMForSummary as logic moved to summarizeContentFiles
}