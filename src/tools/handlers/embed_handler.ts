import { BaseHandler } from './base-handler.js';
import { McpToolResponse, QdrantPoint } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ApiClient } from '../api-client.js';
import { z } from 'zod';
import fs from 'fs/promises';

// Task Management
import { registerTask, setTaskStatus, isTaskCancelled, updateTaskDetails, getTaskStatus } from '../../tasks.js';
// Pipeline State (Tool Lock/Queue + Shared Resource Lock)
import * as PipelineState from '../../pipeline_state.js';
import {
    isEmbedToolFree, acquireEmbedToolLock, releaseEmbedToolLock, enqueueForEmbed, getEmbedQueueLength, dequeueForEmbed,
    acquireEmbeddingLock, releaseEmbeddingLock // Import shared embedding resource lock
} from '../../pipeline_state.js';
// Utilities
import { retryAsyncFunction } from '../utils/retry.js';
import { chunkText, generateQdrantPoints } from '../utils/vectorizer.js';

// --- Configuration & Constants ---
const MAX_RETRY_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const QDRANT_COLLECTION_NAME = 'documentation';

type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;

// --- Input Schema ---
const SingleEmbedRequestSchema = z.string().min(1, { message: 'The task ID of the completed process stage is required.' });
const EmbedInputSchema = z.object({
    requests: z.array(SingleEmbedRequestSchema).min(1, { message: 'At least one process task ID is required.' })
});
type ValidatedSingleEmbedArgs = z.infer<typeof SingleEmbedRequestSchema>;
type ValidatedEmbedInput = z.infer<typeof EmbedInputSchema>;

// Interface for data retrieved from the process task
interface ProcessTaskDetails {
    status: string;
    processedFilePath: string;
    category: string;
    originalTopicOrUrl: string;
    crawlTaskId: string;
}

export class EmbedHandler extends BaseHandler {

    async handle(args: any): Promise<McpToolResponse> {
        const validationResult = EmbedInputSchema.safeParse(args);
        if (!validationResult.success) {
            const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
            throw new McpError(ErrorCode.InvalidParams, `Invalid input for embed: ${errorMessage}`);
        }
        const { requests } = validationResult.data;

        const taskResponses: string[] = [];
        let startedCount = 0;
        let queuedCount = 0;
        let invalidCount = 0;

        for (const processTaskId of requests) {

            // --- Pre-check: Verify Process Task Status ---
            const processTaskStatusInfo = getTaskStatus(processTaskId);
        if (!processTaskStatusInfo) {
                this.safeLog?.('warning', `Skipping embed request: Process task ${processTaskId} not found.`);
                taskResponses.push(`Skipped: Process task ${processTaskId} not found.`);
                invalidCount++;
                continue;
            }
            if (processTaskStatusInfo.status !== 'completed') {
                 this.safeLog?.('warning', `Skipping embed request: Process task ${processTaskId} has status '${processTaskStatusInfo.status}', expected 'completed'.`);
                 taskResponses.push(`Skipped: Process task ${processTaskId} status is '${processTaskStatusInfo.status}'.`);
                 invalidCount++;
                 continue;
            }
            // --- End Pre-check ---

            const executionArgs: ValidatedSingleEmbedArgs = processTaskId;

            const taskId = registerTask('embed');
            this.safeLog?.('info', `Registered embed task ${taskId} for process task: ${processTaskId}`);

            const queuedTask = { taskId, args: { process_task_id: executionArgs } };

        if (isEmbedToolFree()) {
            if (acquireEmbedToolLock()) {
                this.safeLog?.('info', `[${taskId}] Acquired embed tool lock. Starting execution immediately.`);
                setTaskStatus(taskId, 'running');
                updateTaskDetails(taskId, 'Starting embedding and indexing stage...');
                    this._executeEmbed(taskId, { process_task_id: executionArgs });
                    taskResponses.push(`Task ${taskId} started for process task "${processTaskId}".`);
                    startedCount++;
                } else {
                    this.safeLog?.('warning', `[${taskId}] Embed tool lock acquisition failed (race condition?). Queueing task.`);
                    const position = enqueueForEmbed(queuedTask);
                    setTaskStatus(taskId, 'queued');
                    updateTaskDetails(taskId, `Task queued for embed tool. Position: ${position}`);
                    taskResponses.push(`Task ${taskId} queued (Position: ${position}) for process task "${processTaskId}".`);
                    queuedCount++;
                }
            } else {
                const position = enqueueForEmbed(queuedTask);
                setTaskStatus(taskId, 'queued');
                updateTaskDetails(taskId, `Task queued for embed tool. Position: ${position}`);
                this.safeLog?.('info', `[${taskId}] Embed tool busy. Task queued at position ${position}.`);
                taskResponses.push(`Task ${taskId} queued (Position: ${position}) for process task "${processTaskId}".`);
                queuedCount++;
            }
        }

        const summary = `Processed ${requests.length} embed requests. Started: ${startedCount}, Queued: ${queuedCount}, Invalid/Skipped: ${invalidCount}.\nTask details:\n${taskResponses.join('\n')}`;
        return { content: [{ type: 'text', text: summary }] };
    }

    private async _executeEmbed(taskId: string, args: { process_task_id: string }): Promise<void> {
        let stageSucceeded = false;
        let processDetails: ProcessTaskDetails | null = null;
        let processedFilePath = '';
        let category = '';

        try {
            // --- Retrieve Details from Process Task ---
            updateTaskDetails(taskId, `Fetching details from process task ${args.process_task_id}...`);
            const processTaskInfo = getTaskStatus(args.process_task_id);
            const processTaskDetailsString = processTaskInfo?.details;
            if (!processTaskInfo || typeof processTaskDetailsString !== 'string') {
                throw new Error(`Could not retrieve details string for completed process task ${args.process_task_id}. Status: ${processTaskInfo?.status}`);
            }
            try {
                processDetails = JSON.parse(processTaskDetailsString) as ProcessTaskDetails;
            } catch (parseError) {
                throw new Error(`Failed to parse details from process task ${args.process_task_id}: ${parseError}`);
            }
            if (!processDetails || !processDetails.processedFilePath || !processDetails.category) {
                 throw new Error(`Incomplete details retrieved from process task ${args.process_task_id}. Missing required fields.`);
            }
            processedFilePath = processDetails.processedFilePath;
            category = processDetails.category;
            const originalTopicOrUrl = processDetails.originalTopicOrUrl;
            updateTaskDetails(taskId, `Starting embedding for file: ${processedFilePath} (Category: ${category})`);

            // Wrap embedding & indexing in retry logic
            await retryAsyncFunction(
                async () => {
                    // Check cancellation at start of attempt
                    if (isTaskCancelled(taskId)) throw new McpError(ErrorCode.InternalError, `Task ${taskId} cancelled.`);

                    // --- Acquire Shared Embedding Resource Lock ---
                    if (!acquireEmbeddingLock()) {
                        this.safeLog?.('warning', `[${taskId}] Failed to acquire shared embedding lock. Retrying...`);
                        throw new Error("Could not acquire embedding resource lock. System busy?");
                    }
                    this.safeLog?.('debug', `[${taskId}] Acquired shared embedding lock.`);
                    let embeddingLockReleased = false;
                    // --- End Acquire Lock ---

                    try {
                        await this.apiClient.initCollection(QDRANT_COLLECTION_NAME);

                        updateTaskDetails(taskId, `Reading processed file: ${processedFilePath}`);
                    const fileContent = await fs.readFile(processedFilePath, 'utf-8');

                    updateTaskDetails(taskId, `Chunking text content...`);
                    const chunks = chunkText(fileContent);

                    if (chunks.length === 0) {
                        this.safeLog?.('warning', `[${taskId}] No text chunks generated from ${processedFilePath}. Skipping embedding.`);
                        return;
                    }

                    updateTaskDetails(taskId, `Generating embeddings for ${chunks.length} chunks...`);
                    const points: QdrantPoint[] = await generateQdrantPoints(
                        chunks,
                        processedFilePath,
                        category,
                        this.apiClient,
                        this.safeLog,
                        taskId
                    );

                    if (isTaskCancelled(taskId)) throw new McpError(ErrorCode.InternalError, `Task ${taskId} cancelled.`);

                    if (points.length > 0) {
                        updateTaskDetails(taskId, `Embedding complete. Upserting ${points.length} points to Qdrant...`);
                        await this.apiClient.qdrantClient.upsert(QDRANT_COLLECTION_NAME, { wait: true, points: points });
                        this.safeLog?.('info', `[${taskId}] Successfully embedded and indexed: ${processedFilePath}`);
                    } else {
                        this.safeLog?.('warning', `[${taskId}] No vector points generated for ${processedFilePath} after embedding attempt. Check content and embedding process.`);
                    }
                    } finally {
                        if (!embeddingLockReleased) {
                            releaseEmbeddingLock();
                            embeddingLockReleased = true;
                            this.safeLog?.('debug', `[${taskId}] Released shared embedding lock.`);
                        }
                    }
                },
                MAX_RETRY_ATTEMPTS,
                INITIAL_RETRY_DELAY_MS,
                `Embedding/Indexing for ${processedFilePath} (Task ${taskId})`,
                this.safeLog,
                taskId
            );

            if (isTaskCancelled(taskId)) {
                 this.safeLog?.('info', `[${taskId}] Embed task cancelled after successful embedding/indexing.`);
                 setTaskStatus(taskId, 'cancelled');
                 updateTaskDetails(taskId, 'Embedding/Indexing completed but task was cancelled.');
                 return;
            }

            const finalDetails = {
                status: 'Embed Complete',
                indexedFilePath: processedFilePath,
                category: category,
                originalTopicOrUrl: processDetails?.originalTopicOrUrl,
                processTaskId: args.process_task_id,
                crawlTaskId: processDetails?.crawlTaskId,
                message: `Successfully indexed content from ${processedFilePath} into category '${category}'.`
            };
            updateTaskDetails(taskId, JSON.stringify(finalDetails, null, 2));
            setTaskStatus(taskId, 'completed');
            stageSucceeded = true;

        } catch (error: any) {
            this.safeLog?.('error', `[${taskId}] Embed stage failed permanently: ${error.message}`);
            const currentStatus = getTaskStatus(taskId)?.status;
            if (currentStatus !== 'cancelled') {
                const errorMessage = `Embed stage failed: ${error?.message || 'Unknown error'}`;
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
                this.safeLog?.('debug', `[${taskId}] Embed stage failed, but task was already cancelled. Error: ${error?.message || 'Unknown error'}`);
            }
        } finally {
            this.safeLog?.('info', `[${taskId}] Embed execution finished (Succeeded: ${stageSucceeded}).`);
            releaseEmbedToolLock(); // Release the embed tool lock
            this.safeLog?.('info', `[${taskId}] Released embed tool lock.`);
            // This triggers 'checkQueues' via triggerNextPipelineSteps
        }
    }

    // --- Queue Checker ---
    public _checkEmbedQueue(): void {
        this.safeLog?.('debug', `Checking embed tool queue. Free: ${isEmbedToolFree()}, Queue size: ${getEmbedQueueLength()}`);
        if (isEmbedToolFree() && getEmbedQueueLength() > 0) {
            if (acquireEmbedToolLock()) {
                const nextTask = dequeueForEmbed();
                if (nextTask) {
                    const taskStatusInfo = getTaskStatus(nextTask.taskId);
                    if (taskStatusInfo?.status === 'cancelled') {
                        this.safeLog?.('info', `[${nextTask.taskId}] Skipping dequeued embed task as it was cancelled.`);
                        releaseEmbedToolLock();
                        this._checkEmbedQueue(); // Check again
                        return;
                    }
                    this.safeLog?.('info', `[${nextTask.taskId}] Dequeuing task for embed tool. Remaining queue size: ${getEmbedQueueLength()}`);
                    setTaskStatus(nextTask.taskId, 'running');
                    updateTaskDetails(nextTask.taskId, 'Starting embedding stage from queue...');
                    // Pass the args object directly
                    this._executeEmbed(nextTask.taskId, nextTask.args as { process_task_id: string });
                } else {
                    this.safeLog?.('warning', 'Embed tool queue was not empty, but dequeue failed. Releasing lock.');
                    releaseEmbedToolLock();
                }
            } else {
                this.safeLog?.('debug', 'Embed tool is free, but failed to acquire lock (race condition?).');
            }
        } else {
            this.safeLog?.('debug', 'Embed tool queue is empty or tool is busy.');
        }
    }
}