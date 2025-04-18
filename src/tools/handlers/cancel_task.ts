import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
// Import task functions including getAllTasks
import { setTaskStatus, getTaskStatus, getAllTasks, TaskInfo, updateTaskDetails } from '../../tasks.js'; // Added updateTaskDetails
// Import pipeline state functions for queue removal (all new ones)
import * as PipelineState from '../../pipeline_state.js';

// --- Input Schema ---
const CancelTaskInputSchema = z.object({
  taskId: z.string().min(1).optional().describe('The ID of the specific task to cancel.'),
  all: z.boolean().optional().default(false).describe('Set to true to cancel all active (running or queued) get-llms-full tasks.'), // Updated description
});
type ValidatedCancelArgs = z.infer<typeof CancelTaskInputSchema>;

// --- Handler Class ---
export class CancelTaskHandler extends BaseHandler {

  async handle(args: any): Promise<McpToolResponse> {
    const validationResult = CancelTaskInputSchema.safeParse(args);
    if (!validationResult.success) {
      const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
      throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${errorMessage}`);
    }
    const { taskId, all } = validationResult.data;

    if (!taskId && !all) {
        throw new McpError(ErrorCode.InvalidParams, 'Either taskId or the "all" flag must be provided.');
    }
    if (taskId && all) {
        throw new McpError(ErrorCode.InvalidParams, 'Cannot specify both taskId and the "all" flag.');
    }

    if (taskId) {
        // --- Cancel Single Task ---
        this.safeLog?.('info', `Attempting to cancel task: ${taskId}`);
        return this._cancelSingleTask(taskId);
    } else {
        // --- Cancel All Tasks (crawl, process, embed) ---
        this.safeLog?.('info', `Attempting to cancel ALL active get-llms-full tasks.`); // Updated log
        let cancelledCount = 0;
        let alreadyFinishedCount = 0;
        // Get all tasks and filter locally
        const allTasks = getAllTasks();
        const relevantPrefixes = ['get-llms-full-']; // Only target the unified task prefix

        for (const [id, info] of allTasks.entries()) {
            // Check if task ID starts with one of the relevant prefixes
            if (relevantPrefixes.some(prefix => id.startsWith(prefix))) {
                if (info.status === 'running' || info.status === 'queued') {
                    // Attempt cancellation (ignore response here, focus on aggregate)
                    this._cancelSingleTask(id);
                    cancelledCount++;
                } else {
                    alreadyFinishedCount++;
                }
            }
        }
        const message = `Cancellation requested for ${cancelledCount} active get-llms-full task(s). ${alreadyFinishedCount} relevant task(s) were already finished or cancelled.`; // Updated message
        this.safeLog?.('info', message);
        return { content: [{ type: 'text', text: message }] };
    }
  }

  // --- Helper to cancel a single task ---
  private _cancelSingleTask(taskId: string): McpToolResponse {
      const currentTaskInfo = getTaskStatus(taskId);

      if (!currentTaskInfo) {
        this.safeLog?.('warning', `Task ${taskId} not found during cancellation attempt.`);
        return { content: [{ type: 'text', text: `Task ${taskId} not found.` }], isError: true };
      }

      // Check if already cancelled/finished first
      if (currentTaskInfo.status === 'cancelled' || currentTaskInfo.status === 'completed' || currentTaskInfo.status === 'failed') {
          this.safeLog?.('info', `Task ${taskId} already finished/cancelled (status: ${currentTaskInfo.status}). No action taken.`);
          return { content: [{ type: 'text', text: `Task ${taskId} is already finished or cancelled (status: ${currentTaskInfo.status}).` }] };
      }

      if (currentTaskInfo.status === 'running') {
        setTaskStatus(taskId, 'cancelled');
        this.safeLog?.('info', `Requested cancellation for running task ${taskId}.`);
        return { content: [{ type: 'text', text: `Cancellation requested for running task ${taskId}. The process will stop shortly.` }] };
      } else if (currentTaskInfo.status === 'queued') {
          // For queued tasks (now only get-llms-full), just set status to cancelled.
          // The GetLlmsFullHandler's internal loop will skip it when dequeued.
          setTaskStatus(taskId, 'cancelled');
          this.safeLog?.('info', `Marked queued task ${taskId} as cancelled.`);
          return { content: [{ type: 'text', text: `Task ${taskId} was queued and has been marked as cancelled.` }] };
      } else {
         // Should be unreachable due to the initial check, but handle defensively
         this.safeLog?.('error', `Task ${taskId} has unexpected status '${currentTaskInfo.status}' during cancellation.`);
         return { content: [{ type: 'text', text: `Task ${taskId} has an unexpected status '${currentTaskInfo.status}'. Cancellation may not have fully completed.` }], isError: true };
     }
  }
}