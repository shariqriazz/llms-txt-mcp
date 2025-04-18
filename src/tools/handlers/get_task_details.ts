import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
// Import task functions
import { getTaskStatus } from '../../tasks.js';

// --- Input Schema ---
const GetTaskDetailsInputSchema = z.object({
  taskId: z.string().min(1).describe('The ID of the task to get details for.'),
});
type ValidatedGetDetailsArgs = z.infer<typeof GetTaskDetailsInputSchema>;

// --- Handler Class ---
export class GetTaskDetailsHandler extends BaseHandler {

  async handle(args: any): Promise<McpToolResponse> {
    const validationResult = GetTaskDetailsInputSchema.safeParse(args);
    if (!validationResult.success) {
      const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
      throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${errorMessage}`);
    }
    const { taskId } = validationResult.data;

    const taskInfo = getTaskStatus(taskId);

    if (!taskInfo) {
        this.safeLog?.('info', `Task ${taskId} not found when retrieving details.`);
        // Return an error or specific message indicating not found
        return {
            content: [{ type: 'text', text: `Task ${taskId} not found.` }],
            isError: true // Indicate this is an error response
        };
        // Alternatively, throw: throw new McpError(ErrorCode.InvalidParams, `Task ${taskId} not found.`);
    }

    // Return the details string directly
    // The details string often contains JSON, but we return it as raw text.
    // The client/user is responsible for parsing if needed.
    this.safeLog?.('info', `Retrieved details for task ${taskId}.`);
    return {
      content: [
        {
          type: 'text',
          text: taskInfo.details || '', // Return empty string if details are null/undefined
        },
      ],
    };
  }
}