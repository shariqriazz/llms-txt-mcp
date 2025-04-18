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
      topic_or_url: z.string().min(1).optional().describe('The topic keyword or specific URL to process (required unless providing a file path).'),
      category: z.string().min(1).describe('The category to assign to the processed content (required).'),
      crawl_depth: z.coerce.number().int().min(0).optional().default(5).describe('How many levels deeper than the discovered/provided root URL to crawl for links (default: 5). Only used if crawl stage runs.'),
      max_urls: z.coerce.number().int().min(1).optional().default(1000).describe('Maximum number of URLs to fetch and process (default: 1000). Only used if crawl stage runs.'),
      max_llm_calls: z.coerce.number().int().min(1).optional().default(1000).describe('Maximum number of calls to the LLM for synthesizing pages (default: 1000). Only used if synthesize stage runs.'),
      crawl_urls_file_path: z.string().optional().describe('Optional path to a local JSON file containing an array of URLs. If provided, the crawl stage is skipped.'),
      synthesized_content_file_path: z.string().optional().describe('Optional path to a local text/markdown file containing pre-synthesized content. If provided, crawl and synthesize stages are skipped.'),
    }).refine(data => data.topic_or_url || data.crawl_urls_file_path || data.synthesized_content_file_path, {
        message: "Either topic_or_url, crawl_urls_file_path, or synthesized_content_file_path must be provided.",
        // Add path if needed, though refine applies to the whole object
    });


    const ProcessQueryInputSchema = z.object({
      requests: z.array(ProcessQueryRequestSchema).min(1).describe('An array of one or more queries/URLs/files to process sequentially.'),
    });

    type QueryRequest = z.infer<typeof ProcessQueryRequestSchema>;

    // --- Interfaces for Stage Results ---
    interface CrawlResult {
        discoveredUrlsFilePath: string;
        category: string;
        isSourceLocal: boolean;
        originalTopicOrUrl: string; // Keep original for context even if path provided
    }

    interface SynthesizeResult {
        processedFilePath: string;
        category: string;
        originalTopicOrUrl: string; // Keep original for context
    }


    // --- Constants ---
    const MAX_RETRY_ATTEMPTS = 3;
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
    let isProcessing = false;

    // --- Handler Class ---
    export class GetLlmsFullHandler extends BaseHandler {

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
            const mainTaskId = registerTask('get-llms-full');
            const description = request.topic_or_url || request.crawl_urls_file_path || request.synthesized_content_file_path || 'unknown input';
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

        // Attempt to acquire lock - double check pattern
        if (isProcessing) return; // Already processing, exit
        isProcessing = true;

        const { mainTaskId, request } = queryQueue.shift()!;

        // Check if the task was cancelled while in the queue
        const taskInfo = getTaskStatus(mainTaskId);
        if (taskInfo?.status === 'cancelled') {
            this.safeLog?.('info', `[${mainTaskId}] Skipping cancelled task dequeued for processing: ${request.topic_or_url || request.crawl_urls_file_path || request.synthesized_content_file_path}`);
            isProcessing = false;
            setTimeout(() => this._triggerProcessingLoop(), 50);
            return;
        }

        const description = request.topic_or_url || request.crawl_urls_file_path || request.synthesized_content_file_path || 'unknown input';
        this.safeLog?.('info', `[${mainTaskId}] Starting processing for: ${description}`);
        setTaskStatus(mainTaskId, 'running');

        try {
            let crawlResult: CrawlResult | null = null;
            let synthesizeResult: SynthesizeResult | null = null;

            // Determine starting point based on provided inputs
            if (request.synthesized_content_file_path) {
                // --- Skip to Embed Stage ---
                this.safeLog?.('info', `[${mainTaskId}] Skipping Crawl and Synthesize stages, using provided content file: ${request.synthesized_content_file_path}`);
                updateTaskDetails(mainTaskId, `Starting Embed stage using file: ${request.synthesized_content_file_path}...`);
                // SynthesizeResult needs category and original topic (even if null/derived)
                synthesizeResult = {
                    processedFilePath: request.synthesized_content_file_path,
                    category: request.category,
                    originalTopicOrUrl: request.topic_or_url || request.synthesized_content_file_path // Use path as fallback identifier
                };
                await this._executeEmbedStage(mainTaskId, synthesizeResult);

            } else if (request.crawl_urls_file_path) {
                // --- Skip to Synthesize Stage ---
                this.safeLog?.('info', `[${mainTaskId}] Skipping Crawl stage, using provided URL file: ${request.crawl_urls_file_path}`);
                updateTaskDetails(mainTaskId, `Starting Synthesize stage using URL file: ${request.crawl_urls_file_path}...`);
                // CrawlResult needs category, original topic, and path
                crawlResult = {
                    discoveredUrlsFilePath: request.crawl_urls_file_path,
                    category: request.category,
                    isSourceLocal: true, // Assume local if path provided? Or determine based on content? For now, assume local.
                    originalTopicOrUrl: request.topic_or_url || request.crawl_urls_file_path // Use path as fallback identifier
                };
                synthesizeResult = await this._executeSynthesizeStage(mainTaskId, request, crawlResult);

                if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled during synthesize.`);

                updateTaskDetails(mainTaskId, `Starting Embed stage for ${description}...`);
                await this._executeEmbedStage(mainTaskId, synthesizeResult);

            } else if (request.topic_or_url) {
                // --- Full Pipeline ---
                updateTaskDetails(mainTaskId, `Starting Crawl stage for ${request.topic_or_url}...`);
                crawlResult = await this._executeCrawlStage(mainTaskId, request);

                if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled during crawl.`);

                updateTaskDetails(mainTaskId, `Starting Synthesize stage for ${request.topic_or_url}...`);
                synthesizeResult = await this._executeSynthesizeStage(mainTaskId, request, crawlResult);

                if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled during synthesize.`);

                updateTaskDetails(mainTaskId, `Starting Embed stage for ${request.topic_or_url}...`);
                await this._executeEmbedStage(mainTaskId, synthesizeResult);
            } else {
                 // This case should be prevented by the Zod refine validation
                 throw new Error("Invalid request: No topic, URL, or file path provided.");
            }


            if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled during final stage.`);

            // If all stages succeeded
            this.safeLog?.('info', `[${mainTaskId}] Query processing COMPLETED successfully for: ${description}`);
            updateTaskDetails(mainTaskId, `Processing completed successfully.`);
            setTaskStatus(mainTaskId, 'completed');

        } catch (error: any) {
            this.safeLog?.('error', `[${mainTaskId}] Processing failed for query ${description}. Reason: ${error.message}`);
            if (getTaskStatus(mainTaskId)?.status !== 'cancelled') {
                 const errorMessage = `Processing failed: ${error?.message || 'Unknown error'}`;
                 if (getTaskStatus(mainTaskId)?.status === 'running') {
                     updateTaskDetails(mainTaskId, errorMessage);
                 }
                 setTaskStatus(mainTaskId, 'failed');
            }
        } finally {
            isProcessing = false;
            this.safeLog?.('debug', `[${mainTaskId}] Finished processing attempt. Scheduling next loop check.`);
            setTimeout(() => this._triggerProcessingLoop(), 50);
        }
      }

      // --- Stage Execution Methods ---

      // _executeCrawlStage remains largely the same as before
      private async _executeCrawlStage(mainTaskId: string, request: QueryRequest): Promise<CrawlResult> {
        let discoveredUrls: string[] = [];
        let isSourceLocal = false;
        // topic_or_url is guaranteed by the calling logic if this stage runs
        const { topic_or_url, category, crawl_depth, max_urls } = request;
        let urlsFilePath = '';

        await retryAsyncFunction(
            async () => {
                if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);

                updateTaskDetails(mainTaskId, `Crawl Stage: Starting discovery for ${topic_or_url}...`);
                const discoveryResult = await discoverStartingPoint(topic_or_url!, this.safeLog); // Use non-null assertion
                const start_url = discoveryResult.startUrlOrPath;
                isSourceLocal = discoveryResult.isLocal;
                updateTaskDetails(mainTaskId, `Crawl Stage: Discovery complete. Starting point: ${start_url} (Local: ${isSourceLocal})`);

                if (!isSourceLocal) {
                    if (!PipelineState.acquireBrowserLock()) {
                         this.safeLog?.('warning', `[${mainTaskId}] Failed to acquire browser lock for crawl. Retrying...`);
                         throw new Error("Could not acquire browser lock for crawling stage.");
                    }
                    this.safeLog?.('debug', `[${mainTaskId}] Acquired browser lock for crawl.`);
                    try {
                        await this.apiClient.initBrowser();
                        if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
                        updateTaskDetails(mainTaskId, `Crawl Stage: Crawling website from ${start_url} (Depth: ${crawl_depth}, Max URLs: ${max_urls})...`);
                        discoveredUrls = await crawlWebsite(mainTaskId, start_url, crawl_depth, max_urls, this.apiClient, this.safeLog);
                    } finally {
                        PipelineState.releaseBrowserLock();
                        this.safeLog?.('debug', `[${mainTaskId}] Released browser lock after crawl.`);
                    }
                } else {
                    updateTaskDetails(mainTaskId, `Crawl Stage: Processing local path: ${start_url}`);
                     discoveredUrls = [start_url];
                }
            },
            MAX_RETRY_ATTEMPTS, INITIAL_RETRY_DELAY_MS, `Crawl Stage for ${topic_or_url} (Task ${mainTaskId})`, this.safeLog, mainTaskId
        );

        if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled after crawl attempt.`);

        updateTaskDetails(mainTaskId, `Crawl Stage: Found ${discoveredUrls.length} source(s). Saving URL list...`);
        await fs.mkdir(DISCOVERED_URLS_DIR, { recursive: true });
        const urlsFilename = `crawl-${mainTaskId}-urls.json`;
        urlsFilePath = path.join(DISCOVERED_URLS_DIR, urlsFilename);
        await fs.writeFile(urlsFilePath, JSON.stringify(discoveredUrls, null, 2), 'utf-8');
        this.safeLog?.('info', `[${mainTaskId}] Saved discovered URLs to ${urlsFilePath}`);

        const result: CrawlResult = { discoveredUrlsFilePath: urlsFilePath, category, isSourceLocal, originalTopicOrUrl: topic_or_url! };
        // Store structured result in task details for potential restart
        updateTaskDetails(mainTaskId, JSON.stringify({ stage: 'crawl', result }, null, 2));
        return result;
      }

      // Modified to accept CrawlResult directly
      private async _executeSynthesizeStage(mainTaskId: string, request: QueryRequest, crawlResult: CrawlResult): Promise<SynthesizeResult> {
        let finalLlmsContent = '';
        const { discoveredUrlsFilePath, category, originalTopicOrUrl, isSourceLocal } = crawlResult;
        const { max_llm_calls } = request; // Get max_llm_calls from the original request
        let outputFilename = '';
        let outputPath = '';

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

        updateTaskDetails(mainTaskId, `Synthesize Stage: Processing ${discoveredUrls.length} sources for topic: ${originalTopicOrUrl} (Max LLM Calls: ${max_llm_calls})...`);

        finalLlmsContent = await retryAsyncFunction(
            async () => {
                if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
                if (!PipelineState.acquireBrowserLock()) {
                    throw new Error("Could not acquire browser lock for synthesis stage content extraction.");
                }
                this.safeLog?.('debug', `[${mainTaskId}] Acquired browser lock for synthesis.`);
                try {
                    return await processSourcesWithLlm(
                        mainTaskId, discoveredUrls, originalTopicOrUrl, max_llm_calls, this.apiClient, this.safeLog
                    );
                } finally {
                    PipelineState.releaseBrowserLock();
                    this.safeLog?.('debug', `[${mainTaskId}] Released browser lock after synthesis attempt.`);
                }
            },
            MAX_RETRY_ATTEMPTS, INITIAL_RETRY_DELAY_MS, `Synthesize Stage for ${originalTopicOrUrl} (Task ${mainTaskId})`, this.safeLog, mainTaskId
        );

        if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled after synthesis attempt.`);

        updateTaskDetails(mainTaskId, 'Synthesize Stage: LLM synthesis complete. Saving intermediate file...');
        await fs.mkdir(INTERMEDIATE_OUTPUT_DIR, { recursive: true });
        const baseFilename = sanitizeFilename(isSourceLocal ? path.basename(originalTopicOrUrl) : originalTopicOrUrl);
        outputFilename = `${baseFilename}-category-${sanitizeFilename(category)}-${mainTaskId}-synthesized.txt`;
        outputPath = path.join(INTERMEDIATE_OUTPUT_DIR, outputFilename);
        this.safeLog?.('info', `[${mainTaskId}] Saving synthesized content to: ${outputPath}`);
        await fs.writeFile(outputPath, finalLlmsContent, 'utf-8');

        const result: SynthesizeResult = { processedFilePath: outputPath, category, originalTopicOrUrl };
        // Store structured result in task details for potential restart
        updateTaskDetails(mainTaskId, JSON.stringify({ stage: 'synthesize', result }, null, 2));
        return result;
      }

      // Modified to accept SynthesizeResult directly
      private async _executeEmbedStage(mainTaskId: string, synthesizeResult: SynthesizeResult): Promise<void> {
        const { processedFilePath, category, originalTopicOrUrl } = synthesizeResult;

        updateTaskDetails(mainTaskId, `Embed Stage: Starting embedding for file: ${processedFilePath} (Category: ${category})`);

        await retryAsyncFunction(
            async () => {
                if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
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
                        return;
                    }

                    updateTaskDetails(mainTaskId, `Embed Stage: Generating embeddings for ${chunks.length} chunks...`);
                    const points: QdrantPoint[] = await generateQdrantPoints(
                        chunks, processedFilePath, category, this.apiClient, this.safeLog, mainTaskId
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
         const finalDetailMsg = `Embed Stage: Successfully indexed content from ${processedFilePath} into category '${category}'.`;
         updateTaskDetails(mainTaskId, finalDetailMsg); // Keep final embed message simple
         // Final success status is set in _triggerProcessingLoop
      }
    }