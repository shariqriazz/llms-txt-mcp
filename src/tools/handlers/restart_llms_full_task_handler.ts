import { BaseHandler } from './base-handler.js';
    import { McpToolResponse } from '../types.js';
    import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
    import { z } from 'zod';
    import { getTaskStatus, TaskInfo } from '../../tasks.js';
    import { GetLlmsFullHandler } from './get_llms_full_handler.js'; // Import to potentially call handle directly or reuse schema

    // --- Input Schema ---
    const RestartStageEnum = z.enum(['crawl', 'synthesize', 'embed']);
    type RestartStage = z.infer<typeof RestartStageEnum>;

    const RestartTaskInputSchema = z.object({
      failed_task_id: z.string().min(1).describe('The ID of the failed get-llms-full task to restart.'),
      restart_stage: RestartStageEnum.describe("The stage from which to restart ('crawl', 'synthesize', or 'embed')."),
    });

    type ValidatedRestartArgs = z.infer<typeof RestartTaskInputSchema>;

    // --- Interfaces from get_llms_full_handler (copy for parsing) ---
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
    interface StoredTaskDetails {
        stage: 'crawl' | 'synthesize'; // Only store details after these stages
        result: CrawlResult | SynthesizeResult;
    }

    // --- Handler Class ---
    export class RestartLlmsFullTaskHandler extends BaseHandler {

      async handle(args: any): Promise<McpToolResponse> {
        const validationResult = RestartTaskInputSchema.safeParse(args);
        if (!validationResult.success) {
          const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
          throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${errorMessage}`);
        }
        const { failed_task_id, restart_stage } = validationResult.data;

        this.safeLog?.('info', `Attempting to prepare restart for task ${failed_task_id} from stage ${restart_stage}`);

        // 1. Get failed task status and details
        const failedTaskInfo = getTaskStatus(failed_task_id);
        if (!failedTaskInfo) {
            throw new McpError(ErrorCode.InvalidRequest, `Task ${failed_task_id} not found.`); // Use InvalidRequest
        }
        // Optional: Could add a check to ensure the task actually failed, but allow restarting completed/cancelled too?
        // if (failedTaskInfo.status !== 'failed') {
        //     this.safeLog?.('warning', `Task ${failed_task_id} has status ${failedTaskInfo.status}, not 'failed'. Proceeding with restart prep anyway.`);
        // }

        // 2. Parse stored details to find necessary inputs
        let originalRequestParams: any = {}; // Store original params if possible (e.g., from initial details)
        let crawlResult: CrawlResult | null = null;
        let synthesizeResult: SynthesizeResult | null = null;

        try {
            // Attempt to parse details as JSON (could be simple string on failure)
            const parsedDetails = JSON.parse(failedTaskInfo.details) as StoredTaskDetails | any;

            // Check if details contain structured stage results
            if (parsedDetails && parsedDetails.stage && parsedDetails.result) {
                 if (parsedDetails.stage === 'crawl') {
                     crawlResult = parsedDetails.result as CrawlResult;
                 } else if (parsedDetails.stage === 'synthesize') {
                     synthesizeResult = parsedDetails.result as SynthesizeResult;
                     // If synthesize finished, we likely also have crawl results implicitly or need to find them
                     // For simplicity now, assume synthesize result is enough for embed restart
                 }
                 // Try to extract original request from somewhere if possible (maybe store it initially?)
                 // originalRequestParams = parsedDetails.originalRequest || {};
            } else {
                 // Details might be a simple error string, less info available
                 this.safeLog?.('warning', `Details for task ${failed_task_id} are not structured JSON. Restart might require more manual input.`);
                 // We might need the original request parameters here. How to get them?
                 // Maybe the initial 'Queued processing for: ...' detail could store the request?
                 // For now, we'll rely on what we can get from potential intermediate results.
            }
        } catch (e) {
            this.safeLog?.('warning', `Failed to parse details for task ${failed_task_id}. Restart might require manual input.`);
        }

        // 3. Construct new request for get_llms_full based on restart_stage
        const newRequest: any = {
            // Try to preserve original parameters if possible, otherwise use defaults/derived values
            category: crawlResult?.category || synthesizeResult?.category || 'unknown', // Need category!
            topic_or_url: crawlResult?.originalTopicOrUrl || synthesizeResult?.originalTopicOrUrl || undefined,
            // Add other params like crawl_depth, max_urls, max_llm_calls if stored/needed
        };

        let message = '';

        switch (restart_stage) {
            case 'crawl':
                // Restart from scratch - just need original topic/url and category
                if (!newRequest.topic_or_url) {
                     throw new McpError(ErrorCode.InvalidRequest, `Cannot restart from 'crawl' stage for task ${failed_task_id}: Original topic/URL not found in task details.`);
                }
                if (newRequest.category === 'unknown') {
                     this.safeLog?.('warning', `Category for task ${failed_task_id} unknown, using 'unknown'.`);
                }
                // Remove file paths if they exist
                delete newRequest.crawl_urls_file_path;
                delete newRequest.synthesized_content_file_path;
                message = `Prepared restart from 'crawl' stage. Use the following request with the 'get_llms_full' tool.`;
                break;

            case 'synthesize':
                // Need crawl result (URL file path) and category
                if (!crawlResult?.discoveredUrlsFilePath) {
                     throw new McpError(ErrorCode.InvalidRequest, `Cannot restart from 'synthesize' stage for task ${failed_task_id}: Crawl result (URL file path) not found in task details.`);
                }
                newRequest.crawl_urls_file_path = crawlResult.discoveredUrlsFilePath;
                newRequest.category = crawlResult.category; // Use category from crawl result
                // Remove synthesized path if it exists
                delete newRequest.synthesized_content_file_path;
                // topic_or_url is optional now, but keep if available for context
                newRequest.topic_or_url = crawlResult.originalTopicOrUrl;
                message = `Prepared restart from 'synthesize' stage using URL file ${newRequest.crawl_urls_file_path}. Use the following request with the 'get_llms_full' tool.`;
                break;

            case 'embed':
                // Need synthesize result (content file path) and category
                 let synthFilePath: string | undefined;
                 if (synthesizeResult?.processedFilePath) {
                     synthFilePath = synthesizeResult.processedFilePath;
                     newRequest.category = synthesizeResult.category; // Use category from synthesize result
                     newRequest.topic_or_url = synthesizeResult.originalTopicOrUrl; // Keep for context
                 } else if (crawlResult?.discoveredUrlsFilePath) {
                     // Maybe synthesize failed but crawl succeeded? Try to find synth file based on convention? Risky.
                     // Or maybe the details only contained crawl result?
                     throw new McpError(ErrorCode.InvalidRequest, `Cannot restart from 'embed' stage for task ${failed_task_id}: Synthesize result (content file path) not found in task details.`);
                 } else {
                      throw new McpError(ErrorCode.InvalidRequest, `Cannot restart from 'embed' stage for task ${failed_task_id}: No intermediate results found in task details.`);
                 }

                newRequest.synthesized_content_file_path = synthFilePath;
                // Remove crawl path if it exists
                delete newRequest.crawl_urls_file_path;
                message = `Prepared restart from 'embed' stage using content file ${newRequest.synthesized_content_file_path}. Use the following request with the 'get_llms_full' tool.`;
                break;
        }

        // Return the parameters needed to call get_llms_full
        const responsePayload = {
            tool_name: "get_llms_full",
            arguments: {
                requests: [newRequest] // Wrap in requests array
            }
        };

        return {
            content: [
                { type: 'text', text: message },
                { type: 'code', text: JSON.stringify(responsePayload, null, 2) } // Removed language property
            ]
        };
      }
    }