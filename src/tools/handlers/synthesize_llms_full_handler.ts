import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ApiClient } from '../api-client.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';

// Task Management
import { registerTask, setTaskStatus, isTaskCancelled, updateTaskDetails, getTaskStatus } from '../../tasks.js';
// Pipeline State (Locks & Queues for SynthesizeLlmsFull Tool)
import * as PipelineState from '../../pipeline_state.js';
// Import the renamed functions
import { isSynthesizeLlmsFullToolFree, acquireSynthesizeLlmsFullToolLock, releaseSynthesizeLlmsFullToolLock, enqueueForSynthesizeLlmsFull, getSynthesizeLlmsFullQueueLength, dequeueForSynthesizeLlmsFull } from '../../pipeline_state.js';
// Utilities
import { retryAsyncFunction } from '../utils/retry.js';
// NOTE: processSourcesWithLlm will be updated later to use specific LLM config
import { processSourcesWithLlm } from '../utils/llm_processor.js';
import { sanitizeFilename } from '../utils/file_utils.js';

// --- Configuration & Constants ---
const MAX_RETRY_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 1000;
// We might remove this specific key check later if config is handled per-tool
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const INTERMEDIATE_OUTPUT_DIR = './generated_llms_guides/intermediate_processed'; // Keep same output dir for now

type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;

// --- Input Schema (Renamed) ---
const SingleSynthesizeLlmsFullRequestSchema = z.object({
    crawl_task_id: z.string().min(1, { message: 'The task ID of the completed crawl stage is required.' }),
    max_llm_calls: z.coerce.number().int().min(1).optional().default(1000).describe('Maximum number of calls to the LLM for synthesizing pages (default: 1000).'),
    // Add specific LLM config overrides here later if needed
});
const SynthesizeLlmsFullInputSchema = z.object({
    requests: z.union([
        z.array(z.string().min(1)).min(1),
        z.array(SingleSynthesizeLlmsFullRequestSchema).min(1)
    ]).describe('An array of completed crawl_task_ids or an array of objects containing crawl_task_id and optional max_llm_calls.')
});
type ValidatedSingleSynthesizeLlmsFullArgs = z.infer<typeof SingleSynthesizeLlmsFullRequestSchema>;
type ValidatedSynthesizeLlmsFullInput = z.infer<typeof SynthesizeLlmsFullInputSchema>;

// Interface for data retrieved from the crawl task (remains same)
interface CrawlTaskDetails {
    status: string;
    discoveredUrlsFilePath: string;
    isSourceLocal: boolean;
    originalTopicOrUrl: string;
    category: string;
}

// Renamed Handler Class
export class SynthesizeLlmsFullHandler extends BaseHandler {

    async handle(args: any): Promise<McpToolResponse> {
        const validationResult = SynthesizeLlmsFullInputSchema.safeParse(args);
        if (!validationResult.success) {
            const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
            throw new McpError(ErrorCode.InvalidParams, `Invalid input for synthesize-llms-full: ${errorMessage}`);
        }
        const { requests } = validationResult.data;

        // TODO: Revisit this check when LLM config is separated
        if (!GEMINI_API_KEY) {
            throw new McpError(ErrorCode.InvalidRequest, 'GEMINI_API_KEY environment variable is not set.');
        }

        const taskResponses: string[] = [];
        let startedCount = 0;
        let queuedCount = 0;
        let invalidCount = 0;

        for (const request of requests) {
            let crawlTaskId: string;
            let maxLlmCalls: number | undefined;

            if (typeof request === 'string') {
                crawlTaskId = request;
                maxLlmCalls = undefined; // Use default from schema
            } else {
                crawlTaskId = request.crawl_task_id;
                maxLlmCalls = request.max_llm_calls;
            }

            // --- Pre-check: Verify Crawl Task Status ---
            const crawlTaskStatusInfo = getTaskStatus(crawlTaskId);
            if (!crawlTaskStatusInfo) {
                this.safeLog?.('warning', `Skipping synthesize-llms-full request: Crawl task ${crawlTaskId} not found.`);
                taskResponses.push(`Skipped: Crawl task ${crawlTaskId} not found.`);
                invalidCount++;
                continue;
            }
            if (crawlTaskStatusInfo.status !== 'completed') {
                 this.safeLog?.('warning', `Skipping synthesize-llms-full request: Crawl task ${crawlTaskId} has status '${crawlTaskStatusInfo.status}', expected 'completed'.`);
                 taskResponses.push(`Skipped: Crawl task ${crawlTaskId} status is '${crawlTaskStatusInfo.status}'.`);
                 invalidCount++;
                 continue;
            }
            // --- End Pre-check ---

            const executionArgs: ValidatedSingleSynthesizeLlmsFullArgs = {
                crawl_task_id: crawlTaskId,
                max_llm_calls: maxLlmCalls ?? SingleSynthesizeLlmsFullRequestSchema.shape.max_llm_calls._def.defaultValue(),
            };

            // Register task with new type 'synthesize-llms-full'
            const taskId = registerTask('synthesize-llms-full');
            this.safeLog?.('info', `Registered synthesize-llms-full task ${taskId} for crawl task: ${crawlTaskId}`);

            const queuedTask = { taskId, args: executionArgs };

            // Use renamed pipeline state functions
            if (isSynthesizeLlmsFullToolFree()) {
                if (acquireSynthesizeLlmsFullToolLock()) {
                    this.safeLog?.('info', `[${taskId}] Acquired synthesize-llms-full tool lock. Starting execution immediately.`);
                    setTaskStatus(taskId, 'running');
                    updateTaskDetails(taskId, 'Starting LLM synthesis stage...');
                    // Call renamed execution method
                    this._executeSynthesizeLlmsFull(taskId, executionArgs);
                    taskResponses.push(`Task ${taskId} started for crawl task "${crawlTaskId}".`);
                    startedCount++;
                } else {
                    this.safeLog?.('warning', `[${taskId}] Synthesize-llms-full tool lock acquisition failed (race condition?). Queueing task.`);
                    const position = enqueueForSynthesizeLlmsFull(queuedTask); // Use renamed function
                    setTaskStatus(taskId, 'queued');
                    updateTaskDetails(taskId, `Task queued for synthesize-llms-full tool. Position: ${position}`);
                    taskResponses.push(`Task ${taskId} queued (Position: ${position}) for crawl task "${crawlTaskId}".`);
                    queuedCount++;
                }
            } else {
                const position = enqueueForSynthesizeLlmsFull(queuedTask);
                setTaskStatus(taskId, 'queued');
                updateTaskDetails(taskId, `Task queued for synthesize-llms-full tool. Position: ${position}`);
                this.safeLog?.('info', `[${taskId}] Synthesize-llms-full tool busy. Task queued at position ${position}.`);
                taskResponses.push(`Task ${taskId} queued (Position: ${position}) for crawl task "${crawlTaskId}".`);
                queuedCount++;
            }
        }

        const summary = `Processed ${requests.length} synthesize-llms-full requests. Started: ${startedCount}, Queued: ${queuedCount}, Invalid/Skipped: ${invalidCount}.\nTask details:\n${taskResponses.join('\n')}`;
        return { content: [{ type: 'text', text: summary }] };
    }

    // Renamed execution method
    private async _executeSynthesizeLlmsFull(taskId: string, args: ValidatedSingleSynthesizeLlmsFullArgs): Promise<void> {
        let finalLlmsContent = '';
        let stageSucceeded = false;
        let crawlDetails: CrawlTaskDetails | null = null;
        let outputFilename = '';

        try {
            // --- Retrieve Details from Crawl Task --- (Logic remains same)
            updateTaskDetails(taskId, `Fetching details from crawl task ${args.crawl_task_id}...`);
            const crawlTaskInfo = getTaskStatus(args.crawl_task_id);
            const crawlTaskDetailsString = crawlTaskInfo?.details;
            if (!crawlTaskInfo || typeof crawlTaskDetailsString !== 'string') {
                throw new Error(`Could not retrieve details string for completed crawl task ${args.crawl_task_id}. Status: ${crawlTaskInfo?.status}`);
            }
            try {
                crawlDetails = JSON.parse(crawlTaskDetailsString) as CrawlTaskDetails;
            } catch (parseError) {
                throw new Error(`Failed to parse details from crawl task ${args.crawl_task_id}: ${parseError}`);
            }
            if (!crawlDetails || !crawlDetails.discoveredUrlsFilePath || typeof crawlDetails.category === 'undefined') {
                 throw new Error(`Incomplete details retrieved from crawl task ${args.crawl_task_id}. Missing required fields (discoveredUrlsFilePath, category).`);
             }
             const { discoveredUrlsFilePath, originalTopicOrUrl, category, isSourceLocal } = crawlDetails;
             const { max_llm_calls } = args;

             // --- Read discoveredUrls from file --- (Logic remains same)
             let discoveredUrls: string[];
             try {
                 updateTaskDetails(taskId, `Reading discovered URLs from ${discoveredUrlsFilePath}...`);
                 const fileContent = await fs.readFile(discoveredUrlsFilePath, 'utf-8');
                 discoveredUrls = JSON.parse(fileContent);
                 if (!Array.isArray(discoveredUrls)) {
                     throw new Error('File content is not a valid JSON array.');
                 }
                 this.safeLog?.('info', `[${taskId}] Successfully read ${discoveredUrls.length} URLs from ${discoveredUrlsFilePath}.`);
             } catch (fileError: any) {
                 throw new Error(`Failed to read or parse discovered URLs file ${discoveredUrlsFilePath}: ${fileError.message}`);
             }
             // --- End Read ---

             updateTaskDetails(taskId, `Synthesizing ${discoveredUrls.length} sources for topic: ${originalTopicOrUrl}`);

            // Wrap the core LLM processing in the retry helper
            // NOTE: processSourcesWithLlm will be updated later for specific config
            finalLlmsContent = await retryAsyncFunction(
                () => processSourcesWithLlm(
                    taskId,
                    discoveredUrls,
                    originalTopicOrUrl,
                    max_llm_calls,
                    this.apiClient,
                    this.safeLog
                    // Pass specific LLM config here later
                ),
                MAX_RETRY_ATTEMPTS,
                INITIAL_RETRY_DELAY_MS,
                `LLM Synthesis for ${originalTopicOrUrl} (Task ${taskId})`, // Updated log message
                this.safeLog,
                taskId
            );

            // Check cancellation after successful LLM processing (Logic remains same)
            if (isTaskCancelled(taskId)) {
                 this.safeLog?.('info', `[${taskId}] Synthesize-llms-full task cancelled after successful LLM synthesis, before saving.`);
                 setTaskStatus(taskId, 'cancelled');
                 updateTaskDetails(taskId, 'LLM synthesis completed but task was cancelled before saving.');
                 return;
            }

            // --- Save Intermediate Processed File --- (Logic remains same, filename might change slightly due to task ID prefix)
            updateTaskDetails(taskId, 'LLM synthesis complete. Saving intermediate file...');
            await fs.mkdir(INTERMEDIATE_OUTPUT_DIR, { recursive: true });
            const baseFilename = sanitizeFilename(isSourceLocal ? path.basename(originalTopicOrUrl) : originalTopicOrUrl);
            // Include category in filename
            outputFilename = `${baseFilename}-category-${sanitizeFilename(category)}-synthesized.txt`; // Changed suffix
            const outputPath = path.join(INTERMEDIATE_OUTPUT_DIR, outputFilename);
            this.safeLog?.('info', `[${taskId}] Saving synthesized content to: ${outputPath}`);
            await fs.writeFile(outputPath, finalLlmsContent, 'utf-8');
            // --- End Save File ---

            // Store details needed for the next (embed) stage (Update status/nextStep text)
            const finalDetails = {
                status: 'Synthesize-LLMS-Full Complete', // Updated status text
                processedFilePath: outputPath, // Renaming variable might be good, but path is correct
                category: category,
                originalTopicOrUrl: originalTopicOrUrl,
                crawlTaskId: args.crawl_task_id,
                nextStep: 'Run Embed Tool with this taskId' // Embed step remains the same
            };
            updateTaskDetails(taskId, JSON.stringify(finalDetails, null, 2));

            setTaskStatus(taskId, 'completed');
            stageSucceeded = true;

        } catch (error: any) {
            this.safeLog?.('error', `[${taskId}] Synthesize-llms-full stage failed permanently: ${error.message}`);
            const currentStatus = getTaskStatus(taskId)?.status;
            if (currentStatus !== 'cancelled') {
                const errorMessage = `Synthesize-llms-full stage failed: ${error?.message || 'Unknown error'}`;
                if (currentStatus === 'running') {
                   updateTaskDetails(taskId, errorMessage);
                }
                setTaskStatus(taskId, 'failed');
                if (getTaskStatus(taskId)?.details !== errorMessage) {
                    this.safeLog?.('warning', `[${taskId}] Could not update final error details as status was no longer 'running'. Final status set to 'failed'.`);
                }
            } else {
                this.safeLog?.('debug', `[${taskId}] Synthesize-llms-full stage failed, but task was already cancelled. Error: ${error?.message || 'Unknown error'}`);
            }
        } finally {
            this.safeLog?.('info', `[${taskId}] Synthesize-llms-full execution finished (Succeeded: ${stageSucceeded}).`);
            releaseSynthesizeLlmsFullToolLock();
            this.safeLog?.('info', `[${taskId}] Released synthesize-llms-full tool lock.`);
            // Trigger queue check (will be updated in pipeline_state)
        }
    }

    // Renamed Queue Checker method
    public _checkSynthesizeLlmsFullQueue(): void {
        this.safeLog?.('debug', `Checking synthesize-llms-full tool queue. Free: ${isSynthesizeLlmsFullToolFree()}, Queue size: ${getSynthesizeLlmsFullQueueLength()}`);
        if (isSynthesizeLlmsFullToolFree() && getSynthesizeLlmsFullQueueLength() > 0) {
            if (acquireSynthesizeLlmsFullToolLock()) {
                const nextTask = dequeueForSynthesizeLlmsFull();
                if (nextTask) {
                    const taskStatusInfo = getTaskStatus(nextTask.taskId);
                    if (taskStatusInfo?.status === 'cancelled') {
                        this.safeLog?.('info', `[${nextTask.taskId}] Skipping dequeued synthesize-llms-full task as it was cancelled.`);
                        releaseSynthesizeLlmsFullToolLock();
                        this._checkSynthesizeLlmsFullQueue(); // Recurse with new name
                        return;
                    }
                    this.safeLog?.('info', `[${nextTask.taskId}] Dequeuing task for synthesize-llms-full tool. Remaining queue size: ${getSynthesizeLlmsFullQueueLength()}`);
                    setTaskStatus(nextTask.taskId, 'running');
                    updateTaskDetails(nextTask.taskId, 'Starting LLM synthesis stage from queue...');
                    this._executeSynthesizeLlmsFull(nextTask.taskId, nextTask.args as ValidatedSingleSynthesizeLlmsFullArgs); // Call renamed method
                } else {
                    this.safeLog?.('warning', 'Synthesize-llms-full tool queue was not empty, but dequeue failed. Releasing lock.');
                    releaseSynthesizeLlmsFullToolLock(); // Use renamed function
                }
            } else {
                this.safeLog?.('debug', 'Synthesize-llms-full tool is free, but failed to acquire lock (race condition?).');
            }
        } else {
            this.safeLog?.('debug', 'Synthesize-llms-full tool queue is empty or tool is busy.');
        }
    }
}