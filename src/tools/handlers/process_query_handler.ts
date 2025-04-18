import { BaseHandler } from './base-handler.js';
import { McpToolResponse, QdrantPoint } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { TaskInfo, TaskStatusValue, registerTask, getTaskStatus, setTaskStatus, updateTaskDetails, isTaskCancelled } from '../../tasks.js';
import * as PipelineState from '../../pipeline_state.js';
import { retryAsyncFunction } from '../utils/retry.js';
import { discoverStartingPoint } from '../utils/discovery.js';
import { crawlWebsite } from '../utils/crawler.js';
import { processSourcesWithLlm } from '../utils/llm_processor.js';
import { chunkText, generateQdrantPoints } from '../utils/vectorizer.js';
import { sanitizeFilename } from '../utils/file_utils.js';
import { ApiClient } from '../api-client.js';

// --- Input Schema ---
const ProcessQueryRequestSchema = z.object({
  topic_or_url: z.string().min(1).describe('The topic keyword or specific URL to process.'),
  category: z.string().min(1).describe('The category to assign to the processed content.'),
  crawl_depth: z.coerce.number().int().min(0).optional().default(5).describe('How many levels deeper than the discovered/provided root URL to crawl for links (default: 5).'),
  max_urls: z.coerce.number().int().min(1).optional().default(1000).describe('Maximum number of URLs to fetch and process (default: 1000).'),
  max_llm_calls: z.coerce.number().int().min(1).optional().default(1000).describe('Maximum number of calls to the LLM for synthesizing pages (default: 1000).'),
});

const ProcessQueryInputSchema = z.object({
  requests: z.array(ProcessQueryRequestSchema).min(1).describe('An array of one or more queries/URLs to process sequentially.'),
});

type QueryRequest = z.infer<typeof ProcessQueryRequestSchema>;

// --- Interfaces for Stage Results ---
interface CrawlResult {
    discoveredUrlsFilePath: string;
    category: string;
    isSourceLocal: boolean;
    originalTopicOrUrl: string;
}

interface SynthesizeResult {
    processedFilePath: string;
    category: string;
    originalTopicOrUrl: string;
}

// --- Constants ---
const MAX_RETRY_ATTEMPTS = 3; // Use a consistent retry count
const INITIAL_RETRY_DELAY_MS = 1000;
const DISCOVERED_URLS_DIR = './generated_llms_guides/crawl_outputs';
const INTERMEDIATE_OUTPUT_DIR = './generated_llms_guides/intermediate_processed';
const QDRANT_COLLECTION_NAME = 'documentation';

// --- State Management ---
interface QueuedQuery {
    mainTaskId: string;
    request: QueryRequest;
}
const queryQueue: QueuedQuery[] = [];
let isProcessing = false; // Simple lock to prevent concurrent _triggerProcessingLoop runs

// --- Handler Class ---
export class ProcessQueryHandler extends BaseHandler {

  // Inject ApiClient instance
  constructor(apiClient: ApiClient, safeLog?: any) {
    super(apiClient, safeLog);
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
        // Register one main task for the entire query processing pipeline
        const mainTaskId = registerTask('process-query');
        updateTaskDetails(mainTaskId, `Queued processing for: ${request.topic_or_url}`);
        setTaskStatus(mainTaskId, 'queued'); // Start as queued

        queryQueue.push({ mainTaskId, request });
        taskResponses.push(`Task ${mainTaskId} queued for processing "${request.topic_or_url}".`);
        this.safeLog?.('info', `Queued task ${mainTaskId} for: ${request.topic_or_url}. Queue size: ${queryQueue.length}`);
    }

    // Trigger processing loop if not already running
    this._triggerProcessingLoop(); // No await, runs in background

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
      return; // Nothing to process
    }

    isProcessing = true; // Acquire lock
    const { mainTaskId, request } = queryQueue.shift()!; // Dequeue next item

    this.safeLog?.('info', `[${mainTaskId}] Starting processing for: ${request.topic_or_url}`);
    setTaskStatus(mainTaskId, 'running'); // Mark main task as running

    try {
        // Execute stages sequentially
        updateTaskDetails(mainTaskId, `Starting Crawl stage for ${request.topic_or_url}...`);
        const crawlResult = await this._executeCrawlStage(mainTaskId, request);

        if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled during crawl.`);

        updateTaskDetails(mainTaskId, `Starting Synthesize stage for ${request.topic_or_url}...`);
        const synthesizeResult = await this._executeSynthesizeStage(mainTaskId, request, crawlResult);

        if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled during synthesize.`);

        updateTaskDetails(mainTaskId, `Starting Embed stage for ${request.topic_or_url}...`);
        await this._executeEmbedStage(mainTaskId, request, synthesizeResult);

        if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled during embed.`);

        // If all stages succeeded
        this.safeLog?.('info', `[${mainTaskId}] Query processing COMPLETED successfully for: ${request.topic_or_url}`);
        updateTaskDetails(mainTaskId, `Processing completed successfully.`);
        setTaskStatus(mainTaskId, 'completed');

    } catch (error: any) {
        this.safeLog?.('error', `[${mainTaskId}] Processing failed for query ${request.topic_or_url}. Reason: ${error.message}`);
        if (getTaskStatus(mainTaskId)?.status !== 'cancelled') {
             const errorMessage = `Processing failed: ${error?.message || 'Unknown error'}`;
             // Update details only if still running
             if (getTaskStatus(mainTaskId)?.status === 'running') {
                 updateTaskDetails(mainTaskId, errorMessage);
             }
             setTaskStatus(mainTaskId, 'failed');
        }
    } finally {
        isProcessing = false; // Release lock
        this.safeLog?.('debug', `[${mainTaskId}] Finished processing attempt. Scheduling next loop check.`);
        // Use setTimeout to yield control briefly before checking the queue again
        setTimeout(() => this._triggerProcessingLoop(), 50); // Short delay (e.g., 50ms)
    }
  }

  // --- Stage Execution Methods ---

  private async _executeCrawlStage(mainTaskId: string, request: QueryRequest): Promise<CrawlResult> {
    let discoveredUrls: string[] = [];
    let isSourceLocal = false;
    const { topic_or_url, category, crawl_depth, max_urls } = request;
    let urlsFilePath = '';

    await retryAsyncFunction(
        async () => {
            if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);

            updateTaskDetails(mainTaskId, `Crawl Stage: Starting discovery for ${topic_or_url}...`);
            const discoveryResult = await discoverStartingPoint(topic_or_url, this.safeLog);
            const start_url = discoveryResult.startUrlOrPath;
            isSourceLocal = discoveryResult.isLocal;
            updateTaskDetails(mainTaskId, `Crawl Stage: Discovery complete. Starting point: ${start_url} (Local: ${isSourceLocal})`);

            if (!isSourceLocal) {
                // Acquire browser lock specifically for the crawl operation
                if (!PipelineState.acquireBrowserLock()) {
                     this.safeLog?.('warning', `[${mainTaskId}] Failed to acquire browser lock for crawl. Retrying...`);
                     throw new Error("Could not acquire browser lock for crawling stage.");
                }
                this.safeLog?.('debug', `[${mainTaskId}] Acquired browser lock for crawl.`);
                try {
                    await this.apiClient.initBrowser();
                    if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
                    updateTaskDetails(mainTaskId, `Crawl Stage: Crawling website from ${start_url} (Depth: ${crawl_depth}, Max URLs: ${max_urls})...`);
                    // Pass mainTaskId for cancellation checks within crawlWebsite if implemented
                    discoveredUrls = await crawlWebsite(mainTaskId, start_url, crawl_depth, max_urls, this.apiClient, this.safeLog);
                } finally {
                    PipelineState.releaseBrowserLock();
                    this.safeLog?.('debug', `[${mainTaskId}] Released browser lock after crawl.`);
                }
            } else {
                updateTaskDetails(mainTaskId, `Crawl Stage: Processing local path: ${start_url}`);
                 discoveredUrls = [start_url]; // For local paths, the path itself is the "discovered URL"
            }
        },
        MAX_RETRY_ATTEMPTS, INITIAL_RETRY_DELAY_MS, `Crawl Stage for ${topic_or_url} (Task ${mainTaskId})`, this.safeLog, mainTaskId
    );

    if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled after crawl attempt.`);

    updateTaskDetails(mainTaskId, `Crawl Stage: Found ${discoveredUrls.length} source(s). Saving URL list...`);
    await fs.mkdir(DISCOVERED_URLS_DIR, { recursive: true });
    // Use mainTaskId in the filename for uniqueness
    const urlsFilename = `crawl-${mainTaskId}-urls.json`;
    urlsFilePath = path.join(DISCOVERED_URLS_DIR, urlsFilename);
    await fs.writeFile(urlsFilePath, JSON.stringify(discoveredUrls, null, 2), 'utf-8');
    this.safeLog?.('info', `[${mainTaskId}] Saved discovered URLs to ${urlsFilePath}`);

    return { discoveredUrlsFilePath: urlsFilePath, category, isSourceLocal, originalTopicOrUrl: topic_or_url };
  }

  private async _executeSynthesizeStage(mainTaskId: string, request: QueryRequest, crawlResult: CrawlResult): Promise<SynthesizeResult> {
    let finalLlmsContent = '';
    const { discoveredUrlsFilePath, category, originalTopicOrUrl, isSourceLocal } = crawlResult;
    const { max_llm_calls } = request;
    let outputFilename = '';
    let outputPath = '';

    // --- Read discoveredUrls from file ---
    let discoveredUrls: string[];
    try {
        updateTaskDetails(mainTaskId, `Synthesize Stage: Reading discovered URLs from ${discoveredUrlsFilePath}...`);
        const fileContent = await fs.readFile(discoveredUrlsFilePath, 'utf-8');
        discoveredUrls = JSON.parse(fileContent);
        if (!Array.isArray(discoveredUrls)) throw new Error('URL file content is not a valid JSON array.');
        this.safeLog?.('info', `[${mainTaskId}] Read ${discoveredUrls.length} URLs from ${discoveredUrlsFilePath}.`);
    } catch (fileError: any) {
        throw new Error(`Failed to read or parse discovered URLs file ${discoveredUrlsFilePath}: ${fileError.message}`);
    }
    // --- End Read ---

    updateTaskDetails(mainTaskId, `Synthesize Stage: Processing ${discoveredUrls.length} sources for topic: ${originalTopicOrUrl} (Max LLM Calls: ${max_llm_calls})...`);

    // Wrap the core LLM processing (including lock acquisition attempt) in the retry helper
    finalLlmsContent = await retryAsyncFunction(
        async () => {
            if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);

            // Attempt to acquire browser lock (needed for content extraction within processSourcesWithLlm)
            if (!PipelineState.acquireBrowserLock()) {
                throw new Error("Could not acquire browser lock for synthesis stage content extraction.");
            }
            this.safeLog?.('debug', `[${mainTaskId}] Acquired browser lock for synthesis.`);
            try {
                // Call the processing function
                return await processSourcesWithLlm(
                    mainTaskId, // Pass main task ID for cancellation checks
                    discoveredUrls,
                    originalTopicOrUrl,
                    max_llm_calls,
                    this.apiClient,
                    this.safeLog
                    // Pass specific LLM config here later
                );
            } finally {
                PipelineState.releaseBrowserLock();
                this.safeLog?.('debug', `[${mainTaskId}] Released browser lock after synthesis attempt.`);
            }
        },
        MAX_RETRY_ATTEMPTS, INITIAL_RETRY_DELAY_MS, `Synthesize Stage for ${originalTopicOrUrl} (Task ${mainTaskId})`, this.safeLog, mainTaskId
    );

    if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled after synthesis attempt.`);

    // --- Save Intermediate Processed File ---
    updateTaskDetails(mainTaskId, 'Synthesize Stage: LLM synthesis complete. Saving intermediate file...');
    await fs.mkdir(INTERMEDIATE_OUTPUT_DIR, { recursive: true });
    const baseFilename = sanitizeFilename(isSourceLocal ? path.basename(originalTopicOrUrl) : originalTopicOrUrl);
    outputFilename = `${baseFilename}-category-${sanitizeFilename(category)}-${mainTaskId}-synthesized.txt`; // Include mainTaskId
    outputPath = path.join(INTERMEDIATE_OUTPUT_DIR, outputFilename);
    this.safeLog?.('info', `[${mainTaskId}] Saving synthesized content to: ${outputPath}`);
    await fs.writeFile(outputPath, finalLlmsContent, 'utf-8');
    // --- End Save File ---

    return { processedFilePath: outputPath, category, originalTopicOrUrl };
  }

  private async _executeEmbedStage(mainTaskId: string, request: QueryRequest, synthesizeResult: SynthesizeResult): Promise<void> {
    const { processedFilePath, category, originalTopicOrUrl } = synthesizeResult;

    updateTaskDetails(mainTaskId, `Embed Stage: Starting embedding for file: ${processedFilePath} (Category: ${category})`);

    await retryAsyncFunction(
        async () => {
            if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);

            // --- Acquire Shared Embedding Resource Lock ---
            if (!PipelineState.acquireEmbeddingLock()) {
                this.safeLog?.('warning', `[${mainTaskId}] Failed to acquire shared embedding lock. Retrying...`);
                throw new Error("Could not acquire embedding resource lock. System busy?");
            }
            this.safeLog?.('debug', `[${mainTaskId}] Acquired shared embedding lock.`);
            try {
                await this.apiClient.initCollection(QDRANT_COLLECTION_NAME);

                updateTaskDetails(mainTaskId, `Embed Stage: Reading processed file: ${processedFilePath}`);
                const fileContent = await fs.readFile(processedFilePath, 'utf-8');

                updateTaskDetails(mainTaskId, `Embed Stage: Chunking text content...`);
                const chunks = chunkText(fileContent);

                if (chunks.length === 0) {
                    this.safeLog?.('warning', `[${mainTaskId}] No text chunks generated from ${processedFilePath}. Skipping embedding.`);
                    return; // Success, but nothing to embed
                }

                updateTaskDetails(mainTaskId, `Embed Stage: Generating embeddings for ${chunks.length} chunks...`);
                const points: QdrantPoint[] = await generateQdrantPoints(
                    chunks,
                    processedFilePath, // Use processed file path as source identifier
                    category,
                    this.apiClient,
                    this.safeLog,
                    mainTaskId // Pass main task ID for cancellation checks
                );

                if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);

                if (points.length > 0) {
                    updateTaskDetails(mainTaskId, `Embed Stage: Embedding complete. Upserting ${points.length} points to Qdrant...`);
                    await this.apiClient.qdrantClient.upsert(QDRANT_COLLECTION_NAME, { wait: true, points: points });
                    this.safeLog?.('info', `[${mainTaskId}] Successfully embedded and indexed: ${processedFilePath}`);
                } else {
                    this.safeLog?.('warning', `[${mainTaskId}] No vector points generated for ${processedFilePath} after embedding attempt.`);
                }
            } finally {
                PipelineState.releaseEmbeddingLock();
                this.safeLog?.('debug', `[${mainTaskId}] Released shared embedding lock.`);
            }
        },
        MAX_RETRY_ATTEMPTS, INITIAL_RETRY_DELAY_MS, `Embed Stage for ${processedFilePath} (Task ${mainTaskId})`, this.safeLog, mainTaskId
    );

     if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled after embed attempt.`);

     updateTaskDetails(mainTaskId, `Embed Stage: Successfully indexed content from ${processedFilePath} into category '${category}'.`);
     // Final success is marked in _triggerProcessingLoop
  }
}