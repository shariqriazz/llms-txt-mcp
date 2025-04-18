import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getTaskStatus, TaskInfo } from '../../tasks.js';
// No longer need to import GetLlmsFullHandler
// import { GetLlmsFullHandler } from './get_llms_full_handler.js';

// --- Input Schema ---
// Add 'fetch' to the restartable stages
const RestartStageEnum = z.enum(['discovery', 'fetch', 'synthesize', 'embed']);
type RestartStage = z.infer<typeof RestartStageEnum>;

const RestartTaskInputSchema = z.object({
  failed_task_id: z.string().min(1).describe('The ID of the failed get-llms-full task to restart.'),
  restart_stage: RestartStageEnum.describe("The stage from which to restart ('discovery', 'fetch', 'synthesize', or 'embed')."),
});

type ValidatedRestartArgs = z.infer<typeof RestartTaskInputSchema>;

// --- Interfaces for parsing results from task details ---
// Keep these aligned with the result interfaces in get_llms_full_handler.ts
interface DiscoveryResult {
    sourcesFilePath: string;
    category: string;
    isSourceLocal: boolean;
    originalInput: string;
}
interface FetchResult {
    fetchOutputDirPath: string;
    category: string;
    originalInput: string;
    sourceCount: number;
}
interface SynthesizeResult {
    summaryFilePath: string;
    category: string;
    originalInput: string;
}
interface StoredTaskDetails {
    stage: 'discovery' | 'fetch' | 'synthesize'; // Stages that produce usable intermediate output
    result: DiscoveryResult | FetchResult | SynthesizeResult;
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
        throw new McpError(ErrorCode.InvalidRequest, `Task ${failed_task_id} not found.`);
    }
    // Consider allowing restart even if not 'failed'
    if (failedTaskInfo.status !== 'failed') {
        this.safeLog?.('warning', `Task ${failed_task_id} has status ${failedTaskInfo.status}, not 'failed'. Proceeding with restart prep anyway.`);
    }

    // 2. Parse stored details to find necessary inputs
    let discoveryResult: DiscoveryResult | null = null;
    let fetchResult: FetchResult | null = null;
    let synthesizeResult: SynthesizeResult | null = null;
    let originalInput: string | undefined = undefined;
    let category: string | undefined = undefined;

    try {
        const parsedDetails = JSON.parse(failedTaskInfo.details) as StoredTaskDetails | any;

        // Extract results based on the stage recorded in details
        if (parsedDetails && parsedDetails.stage && parsedDetails.result) {
             if (parsedDetails.stage === 'discovery') {
                 discoveryResult = parsedDetails.result as DiscoveryResult;
                 originalInput = discoveryResult.originalInput;
                 category = discoveryResult.category;
             } else if (parsedDetails.stage === 'fetch') {
                 fetchResult = parsedDetails.result as FetchResult;
                 originalInput = fetchResult.originalInput;
                 category = fetchResult.category;
                 // If fetch finished, we implicitly have discovery results (though not the file path directly)
             } else if (parsedDetails.stage === 'synthesize') {
                 synthesizeResult = parsedDetails.result as SynthesizeResult;
                 originalInput = synthesizeResult.originalInput;
                 category = synthesizeResult.category;
                 // If synthesize finished, we implicitly have fetch results (though not the dir path directly)
             }
        } else {
             this.safeLog?.('warning', `Details for task ${failed_task_id} are not structured JSON or lack stage info. Restart might require more manual input.`);
             // Attempt to extract original input from the initial "Queued processing for: ..." message if possible
             const queuedMatch = failedTaskInfo.details.match(/Queued processing for: (.*)/);
             if (queuedMatch && queuedMatch[1]) {
                 originalInput = queuedMatch[1].trim().replace(/^"|"$/g, ''); // Extract description
                 this.safeLog?.('info', `Extracted potential original input from queue message: ${originalInput}`);
             }
        }
    } catch (e) {
        this.safeLog?.('warning', `Failed to parse details for task ${failed_task_id}. Restart might require manual input.`);
         const queuedMatch = failedTaskInfo.details.match(/Queued processing for: (.*)/);
         if (queuedMatch && queuedMatch[1]) {
             originalInput = queuedMatch[1].trim().replace(/^"|"$/g, '');
             this.safeLog?.('info', `Extracted potential original input from queue message: ${originalInput}`);
         }
    }

    // If category is still unknown, throw error as it's required
    if (!category && restart_stage !== 'discovery') { // Discovery restart might infer category later if needed
         throw new McpError(ErrorCode.InvalidRequest, `Cannot prepare restart for task ${failed_task_id}: Category could not be determined from task details.`);
    }
    // If original input is unknown and needed, throw error
    if (!originalInput && restart_stage === 'discovery') {
         throw new McpError(ErrorCode.InvalidRequest, `Cannot restart from 'discovery' stage for task ${failed_task_id}: Original topic/URL/path not found in task details.`);
    }


    // 3. Construct new request for get_llms_full based on restart_stage
    const newRequest: any = {
        category: category || 'unknown', // Use determined category or default
        topic_or_url: originalInput, // Use determined original input
        // Add other params like crawl_depth, max_urls, max_llm_calls if they were stored/retrievable
    };

    let message = '';

    switch (restart_stage) {
        case 'discovery':
            // Restart from scratch - just need original topic/url/path and category
            if (!newRequest.topic_or_url) { // Double check originalInput was found
                 throw new McpError(ErrorCode.InvalidRequest, `Cannot restart from 'discovery' stage for task ${failed_task_id}: Original topic/URL/path not found.`);
            }
            // Remove potentially inferred intermediate file paths
            delete newRequest.discovery_output_file_path;
            delete newRequest.fetch_output_dir_path;
            delete newRequest.synthesized_content_file_path;
            message = `Prepared restart from 'discovery' stage. Use the following request with the 'get_llms_full' tool.`;
            break;

        case 'fetch':
            // Need discovery result (sources file path)
            if (!discoveryResult?.sourcesFilePath) {
                 throw new McpError(ErrorCode.InvalidRequest, `Cannot restart from 'fetch' stage for task ${failed_task_id}: Discovery result (sources file path) not found in task details.`);
            }
            newRequest.discovery_output_file_path = discoveryResult.sourcesFilePath;
            newRequest.category = discoveryResult.category; // Ensure category from discovery is used
            // topic_or_url is optional now, but keep if available for context
            newRequest.topic_or_url = discoveryResult.originalInput;
            // Remove later stage paths
            delete newRequest.fetch_output_dir_path;
            delete newRequest.synthesized_content_file_path;
            message = `Prepared restart from 'fetch' stage using sources file ${newRequest.discovery_output_file_path}. Use the following request with the 'get_llms_full' tool.`;
            break;

        case 'synthesize':
            // Need fetch result (output directory path)
            if (!fetchResult?.fetchOutputDirPath) {
                 // Maybe only discovery finished?
                 if (discoveryResult?.sourcesFilePath) {
                     throw new McpError(ErrorCode.InvalidRequest, `Cannot restart from 'synthesize' stage for task ${failed_task_id}: Fetch stage did not complete (only discovery results found). Try restarting from 'fetch'.`);
                 }
                 throw new McpError(ErrorCode.InvalidRequest, `Cannot restart from 'synthesize' stage for task ${failed_task_id}: Fetch result (output directory path) not found in task details.`);
            }
            newRequest.fetch_output_dir_path = fetchResult.fetchOutputDirPath;
            newRequest.category = fetchResult.category; // Ensure category from fetch is used
            // topic_or_url is optional now, but keep if available for context
            newRequest.topic_or_url = fetchResult.originalInput;
            // Remove later stage path
            delete newRequest.discovery_output_file_path; // Also remove discovery path
            delete newRequest.synthesized_content_file_path;
            message = `Prepared restart from 'synthesize' stage using fetched content directory ${newRequest.fetch_output_dir_path}. Use the following request with the 'get_llms_full' tool.`;
            break;

        case 'embed':
            // Need synthesize result (summary file path)
            if (!synthesizeResult?.summaryFilePath) {
                 // Maybe only fetch finished?
                 if (fetchResult?.fetchOutputDirPath) {
                     throw new McpError(ErrorCode.InvalidRequest, `Cannot restart from 'embed' stage for task ${failed_task_id}: Synthesize stage did not complete (only fetch results found). Try restarting from 'synthesize'.`);
                 }
                 // Maybe only discovery finished?
                 if (discoveryResult?.sourcesFilePath) {
                     throw new McpError(ErrorCode.InvalidRequest, `Cannot restart from 'embed' stage for task ${failed_task_id}: Fetch and Synthesize stages did not complete (only discovery results found). Try restarting from 'fetch'.`);
                 }
                 throw new McpError(ErrorCode.InvalidRequest, `Cannot restart from 'embed' stage for task ${failed_task_id}: Synthesize result (summary file path) not found in task details.`);
            }
            newRequest.synthesized_content_file_path = synthesizeResult.summaryFilePath;
            newRequest.category = synthesizeResult.category; // Ensure category from synthesize is used
            // topic_or_url is optional now, but keep if available for context
            newRequest.topic_or_url = synthesizeResult.originalInput;
            // Remove earlier stage paths
            delete newRequest.discovery_output_file_path;
            delete newRequest.fetch_output_dir_path;
            message = `Prepared restart from 'embed' stage using summary file ${newRequest.synthesized_content_file_path}. Use the following request with the 'get_llms_full' tool.`;
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
            { type: 'code', text: JSON.stringify(responsePayload, null, 2) }
        ]
    };
  }
}