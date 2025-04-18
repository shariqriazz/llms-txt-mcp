import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ApiClient } from '../api-client.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { registerTask, setTaskStatus, isTaskCancelled, updateTaskDetails, TaskStatusValue, getTaskStatus } from '../../tasks.js';
import * as PipelineState from '../../pipeline_state.js';
// Import specific lock/queue functions for the crawl tool
import { isCrawlToolFree, acquireCrawlToolLock, releaseCrawlToolLock, enqueueForCrawl } from '../../pipeline_state.js';
import { retryAsyncFunction } from '../utils/retry.js';
import { discoverStartingPoint } from '../utils/discovery.js';
import { crawlWebsite } from '../utils/crawler.js';

// --- Configuration & Constants ---
const MAX_RETRY_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
const DISCOVERED_URLS_DIR = './generated_llms_guides/crawl_outputs';

type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;

// --- Input Schema ---
const SingleCrawlRequestSchema = z.object({
    topic_or_url: z.string().min(1, { message: 'Topic (e.g., "shadcn ui") or starting URL/path is required.' }),
    category: z.string().min(1, { message: 'Category is required (will be passed to subsequent stages).' }),
    crawl_depth: z.coerce.number().int().min(0).optional().default(5).describe('How many levels deeper than the discovered/provided root URL to crawl for links (default: 5).'),
    max_urls: z.coerce.number().int().min(1).optional().default(1000).describe('Maximum number of URLs to fetch and process (default: 1000).'),
});
const CrawlInputSchema = z.object({
    requests: z.array(SingleCrawlRequestSchema).min(1, { message: 'At least one crawl request is required.' })
});
type ValidatedSingleCrawlArgs = z.infer<typeof SingleCrawlRequestSchema>;
type ValidatedCrawlInput = z.infer<typeof CrawlInputSchema>;


export class CrawlHandler extends BaseHandler {

    async handle(args: any): Promise<McpToolResponse> {
        const validationResult = CrawlInputSchema.safeParse(args);
        if (!validationResult.success) {
            const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
            throw new McpError(ErrorCode.InvalidParams, `Invalid input for crawl: ${errorMessage}`);
        }
        const { requests } = validationResult.data;

        const taskResponses: string[] = [];
        let startedCount = 0;
        let queuedCount = 0;

        for (const requestArgs of requests) {
            const taskId = registerTask('crawl');
            this.safeLog?.('info', `Registered crawl task ${taskId} for: ${requestArgs.topic_or_url}`);

            const queuedTask = { taskId, args: requestArgs };

        if (isCrawlToolFree()) {
            if (acquireCrawlToolLock()) {
                this.safeLog?.('info', `[${taskId}] Acquired crawl tool lock. Starting execution immediately.`);
                setTaskStatus(taskId, 'running');
                updateTaskDetails(taskId, 'Starting crawl stage...');
                    this._executeCrawl(taskId, requestArgs);
                    taskResponses.push(`Task ${taskId} started for "${requestArgs.topic_or_url}".`);
                    startedCount++;
                } else {
                    this.safeLog?.('warning', `[${taskId}] Crawl tool lock acquisition failed (race condition?). Queueing task.`);
                    const position = enqueueForCrawl(queuedTask);
                    setTaskStatus(taskId, 'queued');
                    updateTaskDetails(taskId, `Task queued for crawl tool. Position: ${position}`);
                    taskResponses.push(`Task ${taskId} queued (Position: ${position}) for "${requestArgs.topic_or_url}".`);
                    queuedCount++;
                }
            } else {
                const position = enqueueForCrawl(queuedTask);
                setTaskStatus(taskId, 'queued');
                updateTaskDetails(taskId, `Task queued for crawl tool. Position: ${position}`);
                this.safeLog?.('info', `[${taskId}] Crawl tool busy. Task queued at position ${position}.`);
                taskResponses.push(`Task ${taskId} queued (Position: ${position}) for "${requestArgs.topic_or_url}".`);
                queuedCount++;
            }
        }

        const summary = `Processed ${requests.length} crawl requests. Started: ${startedCount}, Queued: ${queuedCount}.\nTask details:\n${taskResponses.join('\n')}`;
        return { content: [{ type: 'text', text: summary }] };
    }

    private async _executeCrawl(taskId: string, args: ValidatedSingleCrawlArgs): Promise<void> {
        let discoveredUrls: string[] = [];
        let isSourceLocal = false;
        let stageSucceeded = false;
        const { topic_or_url, category, crawl_depth, max_urls } = args;

        try {
            await retryAsyncFunction(
                async () => {
                    if (isTaskCancelled(taskId)) {
                        this.safeLog?.('info', `[${taskId}] Crawl task cancelled before attempt.`);
                        throw new McpError(ErrorCode.InternalError, `Task ${taskId} cancelled.`);
                    }

                    updateTaskDetails(taskId, 'Starting discovery phase...');
                    const discoveryResult = await discoverStartingPoint(topic_or_url, this.safeLog);
                    const start_url = discoveryResult.startUrlOrPath;
                    isSourceLocal = discoveryResult.isLocal;
                    updateTaskDetails(taskId, `Discovery complete. Starting point: ${start_url} (Local: ${isSourceLocal})`);

                    if (!isSourceLocal) {
                        if (!PipelineState.acquireBrowserLock()) {
                             this.safeLog?.('warning', `[${taskId}] Failed to acquire browser lock. Retrying...`);
                             throw new Error("Could not acquire browser lock for crawling stage.");
                        }
                        this.safeLog?.('debug', `[${taskId}] Acquired browser lock.`);
                        try {
                            await this.apiClient.initBrowser();

                            if (isTaskCancelled(taskId)) throw new McpError(ErrorCode.InternalError, `Task ${taskId} cancelled.`);
                            updateTaskDetails(taskId, `Crawling website from ${start_url}...`);
                            discoveredUrls = await crawlWebsite(taskId, start_url, crawl_depth, max_urls, this.apiClient, this.safeLog);
                        } finally {
                            PipelineState.releaseBrowserLock();
                            this.safeLog?.('debug', `[${taskId}] Released browser lock.`);
                        }
                    } else {
                        updateTaskDetails(taskId, `Processing local path: ${start_url}`);
                         discoveredUrls = [start_url];
                    }
                },
                MAX_RETRY_ATTEMPTS,
                INITIAL_RETRY_DELAY_MS,
                `Discovery/Crawl for ${topic_or_url}`,
                this.safeLog,
                taskId
            );

            if (isTaskCancelled(taskId)) {
                 this.safeLog?.('info', `[${taskId}] Crawl task cancelled after successful crawl, before final status update.`);
                 if (getTaskStatus(taskId)?.status !== 'cancelled') {
                    setTaskStatus(taskId, 'cancelled');
                 }
                 updateTaskDetails(taskId, 'Crawl completed but task was cancelled.');
                 return;
            }

            updateTaskDetails(taskId, `Discovery/Crawling finished. Found ${discoveredUrls.length} source(s). Saving URL list...`);
            this.safeLog?.('info', `[${taskId}] Found ${discoveredUrls.length} source(s) to process. Saving URL list...`);

            await fs.mkdir(DISCOVERED_URLS_DIR, { recursive: true });
            const urlsFilename = `crawl-${taskId}-urls.json`;
            const urlsFilePath = path.join(DISCOVERED_URLS_DIR, urlsFilename);
            await fs.writeFile(urlsFilePath, JSON.stringify(discoveredUrls, null, 2), 'utf-8');
            this.safeLog?.('info', `[${taskId}] Saved discovered URLs to ${urlsFilePath}`);

            const finalDetails = {
                status: 'Crawl Complete',
                discoveredUrlsFilePath: urlsFilePath,
                isSourceLocal: isSourceLocal,
                originalTopicOrUrl: topic_or_url,
                category: category,
                nextStep: 'Run Process Tool with this taskId',
                message: `Found ${discoveredUrls.length} source(s). Ready for processing.`
            };
            updateTaskDetails(taskId, JSON.stringify(finalDetails, null, 2));

            setTaskStatus(taskId, 'completed');
            stageSucceeded = true;

        } catch (error: any) {
            this.safeLog?.('error', `[${taskId}] Crawl stage failed permanently for ${topic_or_url}: ${error.message}`);
            const currentStatus = getTaskStatus(taskId)?.status;
            if (currentStatus !== 'cancelled') {
                 const errorMessage = `Crawl stage failed: ${error?.message || 'Unknown error'}`;
                 if (currentStatus === 'running') {
                    updateTaskDetails(taskId, errorMessage);
                 }
                 setTaskStatus(taskId, 'failed');
                 if (getTaskStatus(taskId)?.details !== errorMessage) {
                     this.safeLog?.('warning', `[${taskId}] Could not update final error details as status was no longer 'running'. Final status set to 'failed'.`);
                 }
            } else {
                 this.safeLog?.('debug', `[${taskId}] Crawl stage failed, but task was already cancelled. Error: ${error?.message || 'Unknown error'}`);
            }
        } finally {
            this.safeLog?.('info', `[${taskId}] Crawl execution finished (Succeeded: ${stageSucceeded}).`);

            releaseCrawlToolLock();
            this.safeLog?.('info', `[${taskId}] Released crawl tool lock.`);
        }
    }

    // --- Queue Checker ---
    public _checkCrawlQueue(): void {
        this.safeLog?.('debug', `Checking crawl tool queue. Free: ${isCrawlToolFree()}, Queue size: ${PipelineState.getCrawlQueueLength()}`);
        if (isCrawlToolFree() && PipelineState.getCrawlQueueLength() > 0) {
            if (acquireCrawlToolLock()) {
                const nextTask = PipelineState.dequeueForCrawl();
                if (nextTask) {
                    const taskStatusInfo = getTaskStatus(nextTask.taskId);
                    if (taskStatusInfo?.status === 'cancelled') {
                        this.safeLog?.('info', `[${nextTask.taskId}] Skipping dequeued crawl task as it was cancelled.`);
                        releaseCrawlToolLock();
                        this._checkCrawlQueue();
                        return;
                    }

                    this.safeLog?.('info', `[${nextTask.taskId}] Dequeuing task for crawl tool. Remaining queue size: ${PipelineState.getCrawlQueueLength()}`);
                    setTaskStatus(nextTask.taskId, 'running');
                    updateTaskDetails(nextTask.taskId, 'Starting crawl stage from queue...');
                    this._executeCrawl(nextTask.taskId, nextTask.args as ValidatedSingleCrawlArgs);
                } else {
                    this.safeLog?.('warning', 'Crawl tool queue was not empty, but dequeue failed. Releasing lock.');
                    releaseCrawlToolLock();
                }
            } else {
                this.safeLog?.('debug', 'Crawl tool is free, but failed to acquire lock (race condition?). Will retry check later.');
            }
        } else {
            this.safeLog?.('debug', 'Crawl tool queue is empty or tool is busy.');
        }
    }
}