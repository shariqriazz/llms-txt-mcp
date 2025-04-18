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
  all: z.boolean().optional().default(false).describe('Set to true to cancel all active (running or queued) crawl, process, or embed tasks.'),
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
        this.safeLog?.('info', `Attempting to cancel ALL active crawl, process, and embed tasks.`);
        let cancelledCount = 0;
        let alreadyFinishedCount = 0;
        // Get all tasks and filter locally
        const allTasks = getAllTasks();
        const relevantPrefixes = ['crawl-', 'process-', 'embed-'];

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
        const message = `Cancellation requested for ${cancelledCount} active task(s) (crawl, process, embed). ${alreadyFinishedCount} relevant task(s) were already finished or cancelled.`;
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
          let removed = false;
          let queueName = 'unknown';

          // Determine queue based on taskId prefix
          if (taskId.startsWith('crawl-')) {
              removed = PipelineState.removeFromCrawlQueue(taskId);
              queueName = 'crawl';
          } else if (taskId.startsWith('process-')) {
              removed = PipelineState.removeFromProcessQueue(taskId);
              queueName = 'process';
          } else if (taskId.startsWith('embed-')) {
              removed = PipelineState.removeFromEmbedQueue(taskId);
              queueName = 'embed';
          }

          if (removed) {
              setTaskStatus(taskId, 'cancelled');
              this.safeLog?.('info', `Removed queued task ${taskId} from ${queueName} queue and marked as cancelled.`);
              return { content: [{ type: 'text', text: `Task ${taskId} was queued in '${queueName}' and has been removed and cancelled.` }] };
          } else {
               // Task status is 'queued' but it wasn't found in the expected queue.
               this.safeLog?.('warning', `Task ${taskId} was queued but not found in ${queueName} queue (likely dequeued just before cancellation). Marking cancelled.`);
               setTaskStatus(taskId, 'cancelled');
               return { content: [{ type: 'text', text: `Task ${taskId} was queued but not found in the ${queueName} queue (possibly already running?). Marked as cancelled.` }] };
          }
      } else {
         // Should be unreachable due to the initial check, but handle defensively
         this.safeLog?.('error', `Task ${taskId} has unexpected status '${currentTaskInfo.status}' during cancellation.`);
         return { content: [{ type: 'text', text: `Task ${taskId} has an unexpected status '${currentTaskInfo.status}'. Cancellation may not have fully completed.` }], isError: true };
     }
  }
}