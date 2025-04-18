import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import { cleanupTaskStore as cleanupTaskStoreFunction } from '../../tasks.js'; // Renamed import
import { z } from 'zod'; // Import Zod
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'; // Import McpError

// Define input schema with optional taskIds
const CleanupTaskStoreInputSchema = z.object({
    taskIds: z.array(z.string().min(1)).optional().describe('Optional array of specific task IDs to remove. If omitted, all finished (completed, failed, cancelled) tasks are removed.'),
});

export class CleanupTaskStoreHandler extends BaseHandler {
    async handle(args: any): Promise<McpToolResponse> {
        // Validate input
        const validationResult = CleanupTaskStoreInputSchema.safeParse(args);
        if (!validationResult.success) {
            const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
            // Use McpError for consistency
            throw new McpError(ErrorCode.InvalidParams, `Invalid input for cleanup_task_store: ${errorMessage}`);
        }

        const { taskIds } = validationResult.data;

        // Call the imported function, passing taskIds if provided
        cleanupTaskStoreFunction(taskIds);

        let message: string;
        if (taskIds && taskIds.length > 0) {
            message = `Attempted removal of specified task(s) from store: ${taskIds.join(', ')}.`;
            this.safeLog?.('info', message);
        } else {
            message = 'Task store cleanup executed. Completed, failed, and cancelled tasks removed from the active list.';
            this.safeLog?.('info', 'Task store cleanup executed.');
        }

        return {
            content: [{ type: 'text', text: message }],
        };
    }
}