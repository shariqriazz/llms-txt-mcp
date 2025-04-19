import { BaseHandler } from './base-handler.js';
import { McpToolResponse, QdrantPoint } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit';
// Import TaskStageValue along with other task functions
import { TaskInfo, TaskStatusValue, registerTask, getTaskStatus, setTaskStatus, updateTaskDetails, isTaskCancelled, setTaskStage, TaskStageValue } from '../../tasks.js';
import * as PipelineState from '../../pipeline_state.js'; // Import all locks
import { retryAsyncFunction } from '../utils/retry.js';
import { discoverStartingPoint } from '../utils/discovery.js';
import { crawlWebsite } from '../utils/crawler.js';
import { extractTextContent } from '../utils/content_extractor.js';
import { summarizeContentFiles } from '../utils/llm_processor.js';
import { chunkText, generateQdrantPoints } from '../utils/vectorizer.js';
import { sanitizeFilename } from '../utils/file_utils.js';
import { ApiClient } from '../api-client.js';

// --- Input Schema ---
const StopStageEnum = z.enum(['discovery', 'fetch', 'synthesize']).optional().describe("Optionally stop processing after this stage ('discovery', 'fetch', or 'synthesize').");
const ProcessQueryRequestSchema = z.object({
  topic_or_url: z.string().min(1).optional().describe('The topic keyword, specific URL, or local path to process (required unless providing a file path).'),
  category: z.string().min(1).describe('The category to assign to the processed content (required).'),
  crawl_depth: z.coerce.number().int().min(0).optional().default(5).describe('How many levels deeper than the discovered/provided root URL to crawl for links (default: 5). Only used if discovery stage runs and finds a web source.'),
  max_urls: z.coerce.number().int().min(1).optional().default(1000).describe('Maximum number of URLs to discover/process (default: 1000). Used in discovery and fetch stages.'),
  max_llm_calls: z.coerce.number().int().min(1).optional().default(1000).describe('Maximum number of content files to summarize with the LLM (default: 1000). Used in synthesize stage.'),
  discovery_output_file_path: z.string().optional().describe('Optional path to a local JSON file containing an array of source URLs/paths. If provided, the discovery stage is skipped.'),
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
interface DiscoveryResult { sourcesFilePath: string; category: string; isSourceLocal: boolean; originalInput: string; }
interface FetchResult { fetchOutputDirPath: string; category: string; originalInput: string; sourceCount: number; }
interface SynthesizeResult { summaryFilePath: string; category: string; originalInput: string; }

// --- Constants ---
const MAX_RETRY_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const BASE_DATA_DIR = './data';
const DISCOVERY_OUTPUT_DIR = path.join(BASE_DATA_DIR, 'discovery_output');
const FETCH_OUTPUT_DIR = path.join(BASE_DATA_DIR, 'fetch_output');
const SYNTHESIZE_OUTPUT_DIR = path.join(BASE_DATA_DIR, 'synthesize_output');
const QDRANT_COLLECTION_NAME = 'documentation';
const BROWSER_POOL_SIZE = Math.min(Math.max(1, parseInt(process.env.BROWSER_POOL_SIZE || '5', 10) || 5), 50);
// const QDRANT_BATCH_SIZE = Math.max(1, parseInt(process.env.QDRANT_BATCH_SIZE || '100', 10) || 100); // Read inside _executeEmbedStage

// --- State Management for Concurrent Scheduler ---
// Internal state representation for the scheduler
type InternalTaskStage =
    | 'QUEUED'
    | 'WAITING_DISCOVERY' | 'RUNNING_DISCOVERY'
    | 'WAITING_FETCH' | 'RUNNING_FETCH'
    | 'WAITING_SYNTHESIZE' | 'RUNNING_SYNTHESIZE'
    | 'WAITING_EMBED' | 'RUNNING_EMBED'
    | 'WAITING_CLEANUP' | 'RUNNING_CLEANUP'
    | 'COMPLETED' | 'FAILED' | 'CANCELLED';

interface ActiveTask {
    request: QueryRequest;
    stage: InternalTaskStage; // Use internal stage representation
    discoveryResult?: DiscoveryResult;
    fetchResult?: FetchResult;
    synthesizeResult?: SynthesizeResult;
}

const activeTasks = new Map<string, ActiveTask>();
let schedulerDebounceTimeout: NodeJS.Timeout | null = null;

// --- Handler Class ---
export class GetLlmsFullHandler extends BaseHandler {

  constructor(apiClient: ApiClient, safeLog?: any) {
    super(apiClient, safeLog);
    fs.mkdir(BASE_DATA_DIR, { recursive: true }).catch(err => {
        this.safeLog?.('error', `Failed to create base data directory ${BASE_DATA_DIR}: ${err}`);
    });
    PipelineState.pipelineEmitter.on('checkQueues', () => this._triggerScheduler());
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
        const description = request.topic_or_url || request.discovery_output_file_path || request.fetch_output_dir_path || request.synthesized_content_file_path || 'unknown input';
        const mainTaskId = registerTask('get-llms-full', description); // registerTask initializes status='queued', currentStage='QUEUED'

        const initialTaskState = this._determineInitialState(request, description);
        activeTasks.set(mainTaskId, { request, ...initialTaskState });

        // Update central store with the correct *waiting* stage (not QUEUED)
        setTaskStage(mainTaskId, this._getPublicStageName(initialTaskState.stage));

        updateTaskDetails(mainTaskId, `Queued processing for: ${description}`);

        taskResponses.push(`Task ${mainTaskId} queued for processing "${description}".`);
        this.safeLog?.('info', `Queued task ${mainTaskId} for: ${description}. Initial state: ${initialTaskState.stage}. Active tasks: ${activeTasks.size}`);
    }

    this._triggerScheduler();

    const summary = `Queued ${requests.length} request(s). See task status for progress.\nTask IDs:\n${taskResponses.join('\n')}`;
    return { content: [{ type: 'text', text: summary }] };
  }

  // --- Scheduler Logic ---
  private _triggerScheduler(): void {
      if (schedulerDebounceTimeout) clearTimeout(schedulerDebounceTimeout);
      schedulerDebounceTimeout = setTimeout(() => {
          schedulerDebounceTimeout = null;
          this._runSchedulerCycle();
      }, 50);
  }

  private _runSchedulerCycle(): void {
      this.safeLog?.('debug', `Scheduler Cycle: Checking ${activeTasks.size} active tasks.`);
      let browserLockAcquiredThisCycle = false; // Track if lock was acquired in this cycle
      let synthesizeLockAcquiredThisCycle = false;
      let embedLockAcquiredThisCycle = false;

      for (const [taskId, task] of activeTasks.entries()) {
          if (task.stage.startsWith('RUNNING_') || task.stage === 'COMPLETED' || task.stage === 'FAILED' || task.stage === 'CANCELLED') {
              continue;
          }
          if (isTaskCancelled(taskId)) {
              this._handleStageError(taskId, task.stage, new Error("Task cancelled before stage start."));
              continue;
          }

          // --- Check for starting Discovery/Fetch (Browser Activity Lock) ---
          if (!browserLockAcquiredThisCycle && (task.stage === 'WAITING_DISCOVERY' || task.stage === 'WAITING_FETCH')) {
              if (PipelineState.isBrowserActivityFree()) {
                  if (PipelineState.acquireBrowserActivityLock()) {
                      this.safeLog?.('info', `[${taskId}] Scheduler: Acquiring BrowserActivityLock and starting ${task.stage === 'WAITING_DISCOVERY' ? 'Discovery' : 'Fetch'}.`);
                      browserLockAcquiredThisCycle = true; // Mark lock as acquired for this cycle
                      setTaskStatus(taskId, 'running');
                      if (task.stage === 'WAITING_DISCOVERY') {
                          task.stage = 'RUNNING_DISCOVERY';
                          setTaskStage(taskId, 'Discovery');
                          this._executeDiscoveryStage(taskId, task.request)
                              .then(result => this._handleStageCompletion(taskId, 'discovery', result))
                              .catch(error => this._handleStageError(taskId, 'discovery', error))
                              .finally(() => { PipelineState.releaseBrowserActivityLock(); this._triggerScheduler(); });
                      } else { // WAITING_FETCH
                          task.stage = 'RUNNING_FETCH';
                          setTaskStage(taskId, 'Fetch');
                          this._executeFetchStage(taskId, task.request, task.discoveryResult!)
                              .then(result => this._handleStageCompletion(taskId, 'fetch', result))
                              .catch(error => this._handleStageError(taskId, 'fetch', error))
                              .finally(() => { PipelineState.releaseBrowserActivityLock(); this._triggerScheduler(); });
                      }
                  } else { this.safeLog?.('debug', `[${taskId}] Scheduler: Failed to acquire BrowserActivityLock (race condition?).`); }
              } else { this.safeLog?.('debug', `[${taskId}] Scheduler: BrowserActivityLock busy.`); /* Don't break, check other tasks */ }
          }

          // --- Check for starting Synthesize (Synthesize Lock) ---
          else if (!synthesizeLockAcquiredThisCycle && task.stage === 'WAITING_SYNTHESIZE') {
              if (PipelineState.isSynthesizeFree()) {
                  if (PipelineState.acquireSynthesizeLock()) {
                      this.safeLog?.('info', `[${taskId}] Scheduler: Acquiring SynthesizeLock and starting Synthesize.`);
                      synthesizeLockAcquiredThisCycle = true;
                      setTaskStatus(taskId, 'running');
                      task.stage = 'RUNNING_SYNTHESIZE';
                      setTaskStage(taskId, 'Synthesize');
                      this._executeSynthesizeStage(taskId, task.request, task.fetchResult!)
                          .then(result => this._handleStageCompletion(taskId, 'synthesize', result))
                          .catch(error => this._handleStageError(taskId, 'synthesize', error))
                          .finally(() => { PipelineState.releaseSynthesizeLock(); this._triggerScheduler(); });
                  } else { this.safeLog?.('debug', `[${taskId}] Scheduler: Failed to acquire SynthesizeLock (race condition?).`); }
              } else { this.safeLog?.('debug', `[${taskId}] Scheduler: SynthesizeLock busy.`); /* Don't break */ }
          }

          // --- Check for starting Embed (Embedding Lock) ---
          else if (!embedLockAcquiredThisCycle && task.stage === 'WAITING_EMBED') {
              if (PipelineState.isEmbeddingStageFree()) {
                  if (PipelineState.acquireEmbeddingLock()) {
                      this.safeLog?.('info', `[${taskId}] Scheduler: Acquiring EmbeddingLock and starting Embed.`);
                      embedLockAcquiredThisCycle = true;
                      setTaskStatus(taskId, 'running');
                      task.stage = 'RUNNING_EMBED';
                      setTaskStage(taskId, 'Embed');
                      this._executeEmbedStage(taskId, task.synthesizeResult!)
                          .then(() => this._handleStageCompletion(taskId, 'embed', null))
                          .catch(error => this._handleStageError(taskId, 'embed', error))
                          .finally(() => { PipelineState.releaseEmbeddingLock(); this._triggerScheduler(); });
                  } else { this.safeLog?.('debug', `[${taskId}] Scheduler: Failed to acquire EmbeddingLock (race condition?).`); }
              } else { this.safeLog?.('debug', `[${taskId}] Scheduler: EmbeddingLock busy.`); /* Don't break */ }
          }

           // --- Check for starting Cleanup ---
           else if (task.stage === 'WAITING_CLEANUP') {
               this.safeLog?.('info', `[${taskId}] Scheduler: Starting Cleanup.`);
               task.stage = 'RUNNING_CLEANUP';
               setTaskStage(taskId, 'Cleanup');
               this._executeCleanupStage(taskId, task.discoveryResult ?? null, task.fetchResult ?? null, task.synthesizeResult ?? null)
                   .then(() => this._handleStageCompletion(taskId, 'cleanup', null))
                   .catch(error => this._handleStageError(taskId, 'cleanup', error))
                   .finally(() => { this._triggerScheduler(); });
           }
      }
      this.safeLog?.('debug', `Scheduler Cycle End.`);
  }

  // --- Stage Completion and Error Handling ---

  // Helper to get the public-facing stage name from the internal state
  private _getPublicStageName(internalStage: InternalTaskStage): TaskStageValue {
      let baseName: string | undefined;
      if (internalStage.startsWith('WAITING_') || internalStage.startsWith('RUNNING_')) {
          baseName = internalStage.substring(internalStage.indexOf('_') + 1);
      } else if (internalStage === 'QUEUED') {
          return 'QUEUED';
      } else {
          return undefined; // Covers COMPLETED, FAILED, CANCELLED, or unexpected values
      }

      // Check if baseName is a valid public stage name
      const validPublicStages: ReadonlyArray<Exclude<TaskStageValue, 'QUEUED' | undefined>> = ['Discovery', 'Fetch', 'Synthesize', 'Embed', 'Cleanup'];
      // Use 'as any' for includes check, but the explicit check makes the return type safe
      if (validPublicStages.includes(baseName as any)) {
          // Ensure Title Case
          return (baseName.charAt(0).toUpperCase() + baseName.slice(1).toLowerCase()) as Exclude<TaskStageValue, 'QUEUED' | undefined>;
      }

      return undefined; // Fallback if baseName is not valid
  }


  private _determineInitialState(request: QueryRequest, description: string): { stage: InternalTaskStage, discoveryResult?: DiscoveryResult, fetchResult?: FetchResult, synthesizeResult?: SynthesizeResult } {
      if (request.synthesized_content_file_path) {
          return { stage: 'WAITING_EMBED', synthesizeResult: { summaryFilePath: request.synthesized_content_file_path, category: request.category, originalInput: description } };
      } else if (request.fetch_output_dir_path) {
          return { stage: 'WAITING_SYNTHESIZE', fetchResult: { fetchOutputDirPath: request.fetch_output_dir_path, category: request.category, originalInput: description, sourceCount: 0 } };
      } else if (request.discovery_output_file_path) {
          return { stage: 'WAITING_FETCH', discoveryResult: { sourcesFilePath: request.discovery_output_file_path, category: request.category, isSourceLocal: true, originalInput: description } };
      } else {
          return { stage: 'WAITING_DISCOVERY' };
      }
  }

  private _handleStageCompletion(taskId: string, stage: 'discovery' | 'fetch' | 'synthesize' | 'embed' | 'cleanup', result: any): void {
      const task = activeTasks.get(taskId);
      if (!task || task.stage === 'CANCELLED' || task.stage === 'FAILED' || task.stage === 'COMPLETED') {
          this.safeLog?.('info', `[${taskId}] Stage ${stage} completed but task already in final state ${task?.stage}. Ignoring.`);
          return;
      }

      this.safeLog?.('info', `[${taskId}] Stage ${stage} completed successfully.`);

      if (stage === 'discovery') task.discoveryResult = result as DiscoveryResult;
      else if (stage === 'fetch') task.fetchResult = result as FetchResult;
      else if (stage === 'synthesize') task.synthesizeResult = result as SynthesizeResult;

      let nextInternalStage: InternalTaskStage = 'FAILED';
      const stopAfter = task.request.stop_after_stage;

      if (stage === 'discovery') nextInternalStage = stopAfter === 'discovery' ? 'WAITING_CLEANUP' : 'WAITING_FETCH';
      else if (stage === 'fetch') nextInternalStage = stopAfter === 'fetch' ? 'WAITING_CLEANUP' : 'WAITING_SYNTHESIZE';
      else if (stage === 'synthesize') nextInternalStage = stopAfter === 'synthesize' ? 'WAITING_CLEANUP' : 'WAITING_EMBED';
      else if (stage === 'embed') nextInternalStage = 'WAITING_CLEANUP';
      else if (stage === 'cleanup') {
          task.stage = 'COMPLETED'; // Internal state
          setTaskStatus(taskId, 'completed'); // Public status
          setTaskStage(taskId, undefined); // Clear public stage
          updateTaskDetails(taskId, `Processing completed successfully.`);
          this.safeLog?.('info', `[${taskId}] Task marked as COMPLETED.`);
          activeTasks.delete(taskId);
          return; // Don't trigger scheduler again
      }

      task.stage = nextInternalStage; // Update internal state
      // Update public stage in task store
      const publicStageName = this._getPublicStageName(nextInternalStage);
      setTaskStage(taskId, publicStageName); // Pass TaskStageValue or undefined
      this.safeLog?.('debug', `[${taskId}] Transitioning to internal state: ${nextInternalStage}, public stage: ${publicStageName}`);
      // Scheduler is triggered in the finally block of stage execution
  }

  private _handleStageError(taskId: string, stage: string | InternalTaskStage, error: any): void {
      const task = activeTasks.get(taskId);
      if (task && task.stage !== 'FAILED' && task.stage !== 'CANCELLED' && task.stage !== 'COMPLETED') {
          const stageName = typeof stage === 'string' && (stage.startsWith('RUNNING_') || stage.startsWith('WAITING_'))
              ? stage.substring(stage.indexOf('_') + 1)
              : stage;
          this.safeLog?.('error', `[${taskId}] Stage ${stageName} failed: ${error?.message || error}`);
          task.stage = 'FAILED';
          setTaskStatus(taskId, 'failed');
          setTaskStage(taskId, undefined);
          updateTaskDetails(taskId, `Stage ${stageName} failed: ${error?.message || error}`);
          activeTasks.delete(taskId);
      } else {
           this.safeLog?.('warning', `[${taskId}] Received error for stage ${stage}, but task state is ${task?.stage}. Ignoring error.`);
      }
      // Scheduler is triggered in the finally block of stage execution
  }


  // --- Stage Execution Methods ---
  // Assume locks are acquired by the scheduler before calling these.
  // Release locks in the finally block within the scheduler's async call.

  private async _executeDiscoveryStage(mainTaskId: string, request: QueryRequest): Promise<DiscoveryResult> {
    // setTaskStage is now called by the scheduler
    updateTaskDetails(mainTaskId, `Discovery Stage: Starting for ${request.topic_or_url}...`);
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
                updateTaskDetails(mainTaskId, `Discovery Stage: Crawling website from ${start_url_or_path} (Depth: ${crawl_depth}, Max URLs: ${max_urls})...`);
                discoveredSources = await crawlWebsite(mainTaskId, start_url_or_path, crawl_depth, max_urls, this.apiClient, this.safeLog);
            } else {
                const stats = await fs.stat(start_url_or_path);
                if (stats.isDirectory()) {
                    updateTaskDetails(mainTaskId, `Discovery Stage: Scanning directory: ${start_url_or_path}`);
                    const files = await fs.readdir(start_url_or_path, { recursive: true, withFileTypes: true });
                    discoveredSources = files.filter(dirent => dirent.isFile() && ['.md', '.txt', '.docx'].includes(path.extname(dirent.name).toLowerCase())).map(dirent => path.join(dirent.path, dirent.name)).slice(0, max_urls);
                } else if (stats.isFile()) {
                     updateTaskDetails(mainTaskId, `Discovery Stage: Using single local file: ${start_url_or_path}`);
                     discoveredSources = [start_url_or_path];
                } else { throw new Error(`Unsupported local path type: ${start_url_or_path}`); }
            }
        }, MAX_RETRY_ATTEMPTS, INITIAL_RETRY_DELAY_MS, `Discovery Stage for ${topic_or_url} (Task ${mainTaskId})`, this.safeLog, mainTaskId
    );
    if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
    updateTaskDetails(mainTaskId, `Discovery Stage: Found ${discoveredSources.length} source(s). Saving source list...`);
    await fs.mkdir(DISCOVERY_OUTPUT_DIR, { recursive: true });
    const sourcesFilename = `${mainTaskId}-sources.json`;
    sourcesFilePath = path.join(DISCOVERY_OUTPUT_DIR, sourcesFilename);
    await fs.writeFile(sourcesFilePath, JSON.stringify(discoveredSources, null, 2), 'utf-8');
    this.safeLog?.('info', `[${mainTaskId}] Saved discovered sources to ${sourcesFilePath}`);
    const result: DiscoveryResult = { sourcesFilePath, category, isSourceLocal, originalInput: topic_or_url! };
    updateTaskDetails(mainTaskId, JSON.stringify({ stage: 'discovery', result }, null, 2));
    return result;
  }

  private async _executeFetchStage(mainTaskId: string, request: QueryRequest, discoveryResult: DiscoveryResult): Promise<FetchResult> {
    // setTaskStage is now called by the scheduler
    updateTaskDetails(mainTaskId, `Fetch Stage: Starting for ${discoveryResult.originalInput}...`);
    const { sourcesFilePath, category, originalInput } = discoveryResult;
    const { max_urls } = request;
    let fetchedCount = 0;
    let errorCount = 0;
    let sourcesToFetch: string[];
    try {
        updateTaskDetails(mainTaskId, `Fetch Stage: Reading source list from ${sourcesFilePath}...`);
        const fileContent = await fs.readFile(sourcesFilePath, 'utf-8');
        sourcesToFetch = JSON.parse(fileContent);
        if (!Array.isArray(sourcesToFetch)) throw new Error('Source file content is not a valid JSON array.');
        if (sourcesToFetch.length > max_urls) { this.safeLog?.('warning', `[${mainTaskId}] Source list (${sourcesToFetch.length}) exceeds max_urls (${max_urls}). Truncating fetch list.`); sourcesToFetch = sourcesToFetch.slice(0, max_urls); }
        this.safeLog?.('info', `[${mainTaskId}] Read ${sourcesToFetch.length} sources to fetch from ${sourcesFilePath}.`);
    } catch (fileError: any) { throw new Error(`Failed to read or parse sources file ${sourcesFilePath}: ${fileError.message}`); }
    const fetchOutputDirPath = path.join(FETCH_OUTPUT_DIR, mainTaskId);
    await fs.mkdir(fetchOutputDirPath, { recursive: true });
    updateTaskDetails(mainTaskId, `Fetch Stage: Fetching content for ${sourcesToFetch.length} sources (Concurrency: ${BROWSER_POOL_SIZE})...`);
    const limit = pLimit(BROWSER_POOL_SIZE);
    const fetchPromises = sourcesToFetch.map((source, index) =>
        limit(async () => {
            if (isTaskCancelled(mainTaskId)) return;
            const progress = `${index + 1}/${sourcesToFetch.length}`;
            if ((index + 1) % 5 === 0 || index === sourcesToFetch.length - 1) { updateTaskDetails(mainTaskId, `Fetch Stage: Processing ${progress}: ${source}`); }
            try {
                const content = await extractTextContent(source, this.apiClient, this.safeLog);
                const outputFilename = `${sanitizeFilename(source)}.md`;
                const outputPath = path.join(fetchOutputDirPath, outputFilename);
                await fs.writeFile(outputPath, content, 'utf-8');
                fetchedCount++;
            } catch (error: any) { this.safeLog?.('error', `[${mainTaskId}] Failed to fetch/extract ${source}: ${error.message}`); errorCount++; }
        })
    );
    await Promise.all(fetchPromises);
    if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
    updateTaskDetails(mainTaskId, `Fetch Stage: Finished fetching. Success: ${fetchedCount}, Errors: ${errorCount}. Output: ${fetchOutputDirPath}`);
    if (fetchedCount === 0 && sourcesToFetch.length > 0) { throw new Error(`Fetch stage failed to process any sources successfully.`); }
    const result: FetchResult = { fetchOutputDirPath, category, originalInput, sourceCount: fetchedCount };
    updateTaskDetails(mainTaskId, JSON.stringify({ stage: 'fetch', result }, null, 2));
    return result;
  }

  private async _executeSynthesizeStage(mainTaskId: string, request: QueryRequest, fetchResult: FetchResult): Promise<SynthesizeResult> {
    // setTaskStage is now called by the scheduler
    updateTaskDetails(mainTaskId, `Synthesize Stage: Starting for ${fetchResult.originalInput} (Max LLM Calls: ${request.max_llm_calls})...`);
    const { fetchOutputDirPath, category, originalInput } = fetchResult;
    const { max_llm_calls } = request;
    const aggregatedSummary = await retryAsyncFunction(
        () => summarizeContentFiles(mainTaskId, fetchOutputDirPath, originalInput, max_llm_calls, this.safeLog),
        MAX_RETRY_ATTEMPTS, INITIAL_RETRY_DELAY_MS, `Synthesize Stage for ${originalInput} (Task ${mainTaskId})`, this.safeLog, mainTaskId
    );
    if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
    updateTaskDetails(mainTaskId, `Synthesize Stage: LLM summarization complete. Saving summary file...`);
    await fs.mkdir(SYNTHESIZE_OUTPUT_DIR, { recursive: true });
    const summaryFilename = `${mainTaskId}-summary.md`;
    const summaryFilePath = path.join(SYNTHESIZE_OUTPUT_DIR, summaryFilename);
    await fs.writeFile(summaryFilePath, aggregatedSummary, 'utf-8');
    this.safeLog?.('info', `[${mainTaskId}] Saved aggregated summary to ${summaryFilePath}`);
    const result: SynthesizeResult = { summaryFilePath, category, originalInput };
    updateTaskDetails(mainTaskId, JSON.stringify({ stage: 'synthesize', result }, null, 2));
    return result;
  }

  private async _executeEmbedStage(mainTaskId: string, synthesizeResult: SynthesizeResult): Promise<void> {
    // setTaskStage is now called by the scheduler
    updateTaskDetails(mainTaskId, `Embed Stage: Starting for ${synthesizeResult.originalInput} (Category: ${synthesizeResult.category})...`);
    const { summaryFilePath, category } = synthesizeResult;
    await retryAsyncFunction(
        async () => {
            let innerError: any = null;
            try {
                await this.apiClient.initCollection(QDRANT_COLLECTION_NAME);
                updateTaskDetails(mainTaskId, `Embed Stage: Reading summary file: ${summaryFilePath}`);
                const fileContent = await fs.readFile(summaryFilePath, 'utf-8');
                updateTaskDetails(mainTaskId, `Embed Stage: Chunking text content...`);
                const chunks = chunkText(fileContent);
                if (chunks.length === 0) { this.safeLog?.('warning', `[${mainTaskId}] No text chunks generated. Skipping embedding.`); return; }
                updateTaskDetails(mainTaskId, `Embed Stage: Generating embeddings for ${chunks.length} chunks...`);
                const points: QdrantPoint[] = await generateQdrantPoints(chunks, summaryFilePath, category, this.apiClient, this.safeLog, mainTaskId);
                if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
                if (points.length > 0) {
                    // Read QDRANT_BATCH_SIZE here
                    const qdrantBatchSize = Math.max(1, parseInt(process.env.QDRANT_BATCH_SIZE || '100', 10) || 100);
                    this.safeLog?.('debug', `[${mainTaskId}] Embed Stage Batch Size: ${qdrantBatchSize}`);
                    updateTaskDetails(mainTaskId, `Embed Stage: Embedding complete. Upserting ${points.length} points to Qdrant in batches of ${qdrantBatchSize}...`);
                    for (let i = 0; i < points.length; i += qdrantBatchSize) {
                        if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled during upsert batching.`);
                        const batch = points.slice(i, i + qdrantBatchSize);
                        const batchNum = Math.floor(i / qdrantBatchSize) + 1;
                        const totalBatches = Math.ceil(points.length / qdrantBatchSize);
                        updateTaskDetails(mainTaskId, `Embed Stage: Upserting batch ${batchNum}/${totalBatches} (${batch.length} points)...`);
                        await this.apiClient.qdrantClient.upsert(QDRANT_COLLECTION_NAME, { wait: true, points: batch });
                        this.safeLog?.('debug', `[${mainTaskId}] Upserted batch ${batchNum}/${totalBatches}`);
                    }
                    this.safeLog?.('info', `[${mainTaskId}] Successfully embedded and indexed: ${summaryFilePath}`);
                    updateTaskDetails(mainTaskId, `Embed Stage: Upsert complete for ${points.length} points.`);
                } else { this.safeLog?.('warning', `[${mainTaskId}] No vector points generated after embedding attempt.`); }
            } catch (error) { innerError = error; this.safeLog?.('error', `[${mainTaskId}] Error during embed/upsert attempt: ${JSON.stringify(error, null, 2)}`); }
            finally { if (innerError) throw innerError; }
        }, MAX_RETRY_ATTEMPTS, INITIAL_RETRY_DELAY_MS, `Embed Stage for ${summaryFilePath} (Task ${mainTaskId})`, this.safeLog, mainTaskId
    );
     if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled.`);
  }

  private async _executeCleanupStage(
      mainTaskId: string,
      discoveryResult: DiscoveryResult | null,
      fetchResult: FetchResult | null,
      synthesizeResult: SynthesizeResult | null
  ): Promise<void> {
      // setTaskStage is now called by the scheduler
      updateTaskDetails(mainTaskId, `Cleanup Stage: Starting for ${mainTaskId}...`);
      this.safeLog?.('info', `[${mainTaskId}] Starting cleanup of intermediate files...`);
      let errors: string[] = [];
      if (discoveryResult?.sourcesFilePath) {
          try { await fs.unlink(discoveryResult.sourcesFilePath); this.safeLog?.('debug', `[${mainTaskId}] Deleted discovery file: ${discoveryResult.sourcesFilePath}`); }
          catch (err: any) { if (err.code !== 'ENOENT') errors.push(`Failed to delete discovery file ${discoveryResult.sourcesFilePath}: ${err.message}`); }
      }
      if (fetchResult?.fetchOutputDirPath) {
          try { await fs.rm(fetchResult.fetchOutputDirPath, { recursive: true, force: true }); this.safeLog?.('debug', `[${mainTaskId}] Deleted fetch output directory: ${fetchResult.fetchOutputDirPath}`); }
          catch (err: any) { errors.push(`Failed to delete fetch output directory ${fetchResult.fetchOutputDirPath}: ${err.message}`); }
      }
      if (synthesizeResult?.summaryFilePath) {
          try { await fs.unlink(synthesizeResult.summaryFilePath); this.safeLog?.('debug', `[${mainTaskId}] Deleted synthesize file: ${synthesizeResult.summaryFilePath}`); }
          catch (err: any) { if (err.code !== 'ENOENT') errors.push(`Failed to delete synthesize file ${synthesizeResult.summaryFilePath}: ${err.message}`); }
      }
      if (errors.length > 0) {
          const errorMsg = `Cleanup stage completed with errors: ${errors.join('; ')}`;
          this.safeLog?.('error', `[${mainTaskId}] ${errorMsg}`);
          updateTaskDetails(mainTaskId, `Processing completed successfully, but cleanup encountered errors.`);
      } else {
          this.safeLog?.('info', `[${mainTaskId}] Cleanup completed successfully.`);
      }
  }
}