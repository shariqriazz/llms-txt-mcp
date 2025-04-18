import { BaseHandler } from './base-handler.js';
import { McpToolResponse /*, ProcessTaskArgs Define later */ } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ApiClient } from '../api-client.js';
import { z } from 'zod';
import fs from 'fs/promises'; // Already imported, ensure it stays
import path from 'path';

// Task Management
// Removed getTaskDetails, will use getTaskStatus().details instead
import { registerTask, setTaskStatus, isTaskCancelled, updateTaskDetails, getTaskStatus } from '../../tasks.js';
// Pipeline State (Locks & Queues for Process Tool)
import * as PipelineState from '../../pipeline_state.js';
import { isProcessToolFree, acquireProcessToolLock, releaseProcessToolLock, enqueueForProcess, getProcessQueueLength, dequeueForProcess } from '../../pipeline_state.js';
// Utilities
import { retryAsyncFunction } from '../utils/retry.js';
import { processSourcesWithLlm } from '../utils/llm_processor.js';
import { sanitizeFilename } from '../utils/file_utils.js'; // Needed for saving intermediate result

// --- Configuration & Constants ---
const MAX_RETRY_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 1000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const INTERMEDIATE_OUTPUT_DIR = './generated_llms_guides/intermediate_processed'; // Save processed text before embedding

// Define LogFunction type
type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;

// --- Input Schema ---
// Define schema for a single request within the array
const SingleProcessRequestSchema = z.object({
    crawl_task_id: z.string().min(1, { message: 'The task ID of the completed crawl stage is required.' }),
    max_llm_calls: z.coerce.number().int().min(1).optional().default(1000).describe('Maximum number of calls to the LLM for processing pages (default: 1000).'),
});
// Main input schema expects an array of crawl_task_ids or request objects
const ProcessInputSchema = z.object({
    // Allow either an array of strings (task IDs) or an array of objects
    requests: z.union([
        z.array(z.string().min(1)).min(1), // Array of crawl_task_id strings
        z.array(SingleProcessRequestSchema).min(1) // Array of request objects
    ]).describe('An array of completed crawl_task_ids or an array of objects containing crawl_task_id and optional max_llm_calls.')
});
// Type for the validated arguments of a single execution
type ValidatedSingleProcessArgs = z.infer<typeof SingleProcessRequestSchema>;
// Type for the overall validated input
type ValidatedProcessInput = z.infer<typeof ProcessInputSchema>;

// Interface for data retrieved from the crawl task
interface CrawlTaskDetails {
    status: string;
    discoveredUrlsFilePath: string; // Expect file path now
    isSourceLocal: boolean;
    originalTopicOrUrl: string;
    category: string;
    // crawl_depth might be needed if saving uses it? Check _finalizeStage usage
}

export class ProcessHandler extends BaseHandler {

    async handle(args: any): Promise<McpToolResponse> {
        const validationResult = ProcessInputSchema.safeParse(args);
        if (!validationResult.success) {
            const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
            throw new McpError(ErrorCode.InvalidParams, `Invalid input for process: ${errorMessage}`);
        }
        const { requests } = validationResult.data;

        if (!GEMINI_API_KEY) { // Keep this check at the top
            throw new McpError(ErrorCode.InvalidRequest, 'GEMINI_API_KEY environment variable is not set.');
        }

        const taskResponses: string[] = [];
        let startedCount = 0;
        let queuedCount = 0;
        let invalidCount = 0;

        for (const request of requests) {
            let crawlTaskId: string;
            let maxLlmCalls: number | undefined;

            // Normalize input: handle both string array and object array
            if (typeof request === 'string') {
                crawlTaskId = request;
                maxLlmCalls = undefined; // Use default in _executeProcess
            } else {
                crawlTaskId = request.crawl_task_id;
                maxLlmCalls = request.max_llm_calls;
            }

            // --- Pre-check: Verify Crawl Task Status ---
            const crawlTaskStatusInfo = getTaskStatus(crawlTaskId);
        if (!crawlTaskStatusInfo) {
                this.safeLog?.('warning', `Skipping process request: Crawl task ${crawlTaskId} not found.`);
                taskResponses.push(`Skipped: Crawl task ${crawlTaskId} not found.`);
                invalidCount++;
                continue; // Skip to the next request
            }
            if (crawlTaskStatusInfo.status !== 'completed') {
                 this.safeLog?.('warning', `Skipping process request: Crawl task ${crawlTaskId} has status '${crawlTaskStatusInfo.status}', expected 'completed'.`);
                 taskResponses.push(`Skipped: Crawl task ${crawlTaskId} status is '${crawlTaskStatusInfo.status}'.`);
                 invalidCount++;
                 continue; // Skip to the next request
            }
            // --- End Pre-check ---

            // Prepare args for execution/queueing, ensuring max_llm_calls is always a number
            const executionArgs: ValidatedSingleProcessArgs = {
                crawl_task_id: crawlTaskId,
                // Use provided maxLlmCalls or the schema's default value (1000)
                max_llm_calls: maxLlmCalls ?? SingleProcessRequestSchema.shape.max_llm_calls._def.defaultValue(),
            };

            const taskId = registerTask('process'); // New task type 'process'
            this.safeLog?.('info', `Registered process task ${taskId} for crawl task: ${crawlTaskId}`);

            const queuedTask = { taskId, args: executionArgs };

            if (isProcessToolFree()) {
                if (acquireProcessToolLock()) {
                    this.safeLog?.('info', `[${taskId}] Acquired process tool lock. Starting execution immediately.`);
                    setTaskStatus(taskId, 'running');
                    updateTaskDetails(taskId, 'Starting LLM processing stage...');
                    // Use executionArgs here
                    this._executeProcess(taskId, executionArgs);
                    taskResponses.push(`Task ${taskId} started for crawl task "${crawlTaskId}".`);
                    startedCount++;
                } else {
                    this.safeLog?.('warning', `[${taskId}] Process tool lock acquisition failed (race condition?). Queueing task.`);
                    const position = enqueueForProcess(queuedTask);
                    setTaskStatus(taskId, 'queued');
                    updateTaskDetails(taskId, `Task queued for process tool. Position: ${position}`);
                    taskResponses.push(`Task ${taskId} queued (Position: ${position}) for crawl task "${crawlTaskId}".`);
                    queuedCount++;
                }
            } else {
                const position = enqueueForProcess(queuedTask);
                setTaskStatus(taskId, 'queued');
                updateTaskDetails(taskId, `Task queued for process tool. Position: ${position}`);
                this.safeLog?.('info', `[${taskId}] Process tool busy. Task queued at position ${position}.`);
                taskResponses.push(`Task ${taskId} queued (Position: ${position}) for crawl task "${crawlTaskId}".`);
                queuedCount++;
            }
        } // End loop

        const summary = `Processed ${requests.length} process requests. Started: ${startedCount}, Queued: ${queuedCount}, Invalid/Skipped: ${invalidCount}.\nTask details:\n${taskResponses.join('\n')}`;
        return { content: [{ type: 'text', text: summary }] };
    }

    // _executeProcess now accepts ValidatedSingleProcessArgs
    private async _executeProcess(taskId: string, args: ValidatedSingleProcessArgs): Promise<void> {
        let finalLlmsContent = '';
        let stageSucceeded = false;
        let crawlDetails: CrawlTaskDetails | null = null;
        let outputFilename = ''; // To store the name of the saved intermediate file

        try {
            // --- Retrieve Details from Crawl Task ---
            updateTaskDetails(taskId, `Fetching details from crawl task ${args.crawl_task_id}...`);
            // Use getTaskStatus(taskId)?.details to get the details string
            const crawlTaskInfo = getTaskStatus(args.crawl_task_id);
            const crawlTaskDetailsString = crawlTaskInfo?.details;
            if (!crawlTaskInfo || typeof crawlTaskDetailsString !== 'string') {
                // Handle case where task or details are missing
                throw new Error(`Could not retrieve details string for completed crawl task ${args.crawl_task_id}. Status: ${crawlTaskInfo?.status}`);
            }
            try {
                crawlDetails = JSON.parse(crawlTaskDetailsString) as CrawlTaskDetails;
            } catch (parseError) {
                throw new Error(`Failed to parse details from crawl task ${args.crawl_task_id}: ${parseError}`);
            }
            // Check for the new file path property and category
            if (!crawlDetails || !crawlDetails.discoveredUrlsFilePath || typeof crawlDetails.category === 'undefined') {
                 throw new Error(`Incomplete details retrieved from crawl task ${args.crawl_task_id}. Missing required fields (discoveredUrlsFilePath, category).`);
             }
             const { discoveredUrlsFilePath, originalTopicOrUrl, category, isSourceLocal } = crawlDetails;
             const { max_llm_calls } = args;

             // --- Read discoveredUrls from file ---
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

             updateTaskDetails(taskId, `Processing ${discoveredUrls.length} sources for topic: ${originalTopicOrUrl}`);
            // --- End Retrieve Details ---

            // Wrap the core LLM processing in the retry helper
            finalLlmsContent = await retryAsyncFunction(
                () => processSourcesWithLlm(
                    taskId, // Pass current process task ID for logging within the function
                    discoveredUrls,
                    originalTopicOrUrl, // Use original topic/URL for context
                    max_llm_calls,
                    this.apiClient,
                    this.safeLog
                ),
                MAX_RETRY_ATTEMPTS,
                INITIAL_RETRY_DELAY_MS,
                `LLM Processing for ${originalTopicOrUrl} (Task ${taskId})`,
                this.safeLog,
                taskId // Pass current process task ID for cancellation checks
            );

            // Check cancellation after successful LLM processing
            if (isTaskCancelled(taskId)) {
                 this.safeLog?.('info', `[${taskId}] Process task cancelled after successful LLM processing, before saving.`);
                 setTaskStatus(taskId, 'cancelled');
                 updateTaskDetails(taskId, 'LLM processing completed but task was cancelled before saving.');
                 return; // Exit early
            }

            // --- Save Intermediate Processed File ---
            updateTaskDetails(taskId, 'LLM processing complete. Saving intermediate file...');
            await fs.mkdir(INTERMEDIATE_OUTPUT_DIR, { recursive: true });
            // Use crawl task's topic/URL and category for filename consistency? Or process task ID? Let's use topic/URL + category.
            const baseFilename = sanitizeFilename(isSourceLocal ? path.basename(originalTopicOrUrl) : originalTopicOrUrl);
            // Include category in filename to prevent overwrites if same topic is processed for different categories
            outputFilename = `${baseFilename}-category-${sanitizeFilename(category)}-processed.txt`;
            const outputPath = path.join(INTERMEDIATE_OUTPUT_DIR, outputFilename);
            this.safeLog?.('info', `[${taskId}] Saving processed content to: ${outputPath}`);
            await fs.writeFile(outputPath, finalLlmsContent, 'utf-8');
            // --- End Save File ---

            // Store details needed for the next (embed) stage
            const finalDetails = {
                status: 'Process Complete',
                processedFilePath: outputPath, // Path to the saved file
                category: category, // Pass category along
                originalTopicOrUrl: originalTopicOrUrl, // Keep for context if needed
                crawlTaskId: args.crawl_task_id, // Link back to original crawl task
                nextStep: 'Run Embed Tool with this taskId'
            };
            updateTaskDetails(taskId, JSON.stringify(finalDetails, null, 2));

            setTaskStatus(taskId, 'completed');
            stageSucceeded = true;

        } catch (error: any) {
            this.safeLog?.('error', `[${taskId}] Process stage failed permanently: ${error.message}`);
            const currentStatus = getTaskStatus(taskId)?.status;
            if (currentStatus !== 'cancelled') {
                const errorMessage = `Process stage failed: ${error?.message || 'Unknown error'}`;
                // Update details BEFORE setting final status, but only if still running
                if (currentStatus === 'running') {
                   updateTaskDetails(taskId, errorMessage);
                }
                // Now set the final status
                setTaskStatus(taskId, 'failed');
                // If updateTaskDetails was skipped because status changed, log it
                if (getTaskStatus(taskId)?.details !== errorMessage) {
                    this.safeLog?.('warning', `[${taskId}] Could not update final error details as status was no longer 'running'. Final status set to 'failed'.`);
                }
            } else {
                // Already cancelled. No need to update details here.
                this.safeLog?.('debug', `[${taskId}] Process stage failed, but task was already cancelled. Error: ${error?.message || 'Unknown error'}`);
            }
        } finally {
            this.safeLog?.('info', `[${taskId}] Process execution finished (Succeeded: ${stageSucceeded}).`);
            releaseProcessToolLock(); // Release the process tool lock
            this.safeLog?.('info', `[${taskId}] Released process tool lock.`);
            // This triggers 'checkQueues' via triggerNextPipelineSteps in pipeline_state
        }
    }

    // --- Queue Checker ---
    public _checkProcessQueue(): void {
        this.safeLog?.('debug', `Checking process tool queue. Free: ${isProcessToolFree()}, Queue size: ${getProcessQueueLength()}`);
        if (isProcessToolFree() && getProcessQueueLength() > 0) {
            if (acquireProcessToolLock()) {
                const nextTask = dequeueForProcess();
                if (nextTask) {
                    const taskStatusInfo = getTaskStatus(nextTask.taskId);
                    if (taskStatusInfo?.status === 'cancelled') {
                        this.safeLog?.('info', `[${nextTask.taskId}] Skipping dequeued process task as it was cancelled.`);
                        releaseProcessToolLock();
                        this._checkProcessQueue(); // Check again
                        return;
                    }
                    this.safeLog?.('info', `[${nextTask.taskId}] Dequeuing task for process tool. Remaining queue size: ${getProcessQueueLength()}`);
                    setTaskStatus(nextTask.taskId, 'running');
                    updateTaskDetails(nextTask.taskId, 'Starting LLM processing stage from queue...');
                    // Cast args to the single request type
                    this._executeProcess(nextTask.taskId, nextTask.args as ValidatedSingleProcessArgs);
                } else {
                    this.safeLog?.('warning', 'Process tool queue was not empty, but dequeue failed. Releasing lock.');
                    releaseProcessToolLock();
                }
            } else {
                this.safeLog?.('debug', 'Process tool is free, but failed to acquire lock (race condition?).');
            }
        } else {
            this.safeLog?.('debug', 'Process tool queue is empty or tool is busy.');
        }
    }
}