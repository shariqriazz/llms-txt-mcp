import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
// Import TaskInfo type and task functions
import { getTaskStatus, getAllTasks, TaskInfo } from '../../tasks.js';

// --- Input Schema ---
const TaskTypeEnum = z.enum(['crawl', 'process', 'embed', 'all']).optional().default('all').describe('Filter tasks by type.');
const DetailLevelEnum = z.enum(['simple', 'detailed']).optional().default('simple').describe('Level of detail to return.');

const GetTaskStatusInputSchema = z.object({
  taskId: z.string().min(1).optional().describe('The ID of the specific task to get status for.'),
  taskType: TaskTypeEnum,
  detail_level: DetailLevelEnum, // Added detail_level parameter
});
type ValidatedGetStatusArgs = z.infer<typeof GetTaskStatusInputSchema>;


// --- Helper Function for ETA ---
// (Copied from previous handler, consider moving to a shared utility if used elsewhere)
function calculateAndAddEta(taskInfo: TaskInfo): void {
    if (
        taskInfo.status === 'running' &&
        typeof taskInfo.progressCurrent === 'number' && taskInfo.progressCurrent > 0 &&
        typeof taskInfo.progressTotal === 'number' && taskInfo.progressTotal > 0 &&
        taskInfo.startTime // Ensure startTime is valid
    ) {
        const now = Date.now();
        const elapsedTime = now - taskInfo.startTime;

        if (elapsedTime > 0) {
            const timePerUnit = elapsedTime / taskInfo.progressCurrent;
            const remainingUnits = taskInfo.progressTotal - taskInfo.progressCurrent;

            if (remainingUnits >= 0) {
                const remainingTimeMs = timePerUnit * remainingUnits;
                // Add ETA as a timestamp (milliseconds since epoch)
                (taskInfo as any).etaTimestamp = Math.round(now + remainingTimeMs);
            }
        }
    }
    // If conditions aren't met, etaTimestamp will not be added
}


// --- Handler Class ---
export class GetTaskStatusHandler extends BaseHandler {

  async handle(args: any): Promise<McpToolResponse> {
    const validationResult = GetTaskStatusInputSchema.safeParse(args);
    if (!validationResult.success) {
      const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
      throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${errorMessage}`);
    }
    // Destructure all validated args
    const { taskId, taskType, detail_level } = validationResult.data;

    let resultObject: any; // Use 'any' for flexibility in return type

    if (taskId) {
      // --- Get Specific Task Status ---
      const taskInfo = getTaskStatus(taskId);
      if (taskInfo) {
        // Create a copy to modify for 'simple' view
        const outputInfo = { ...taskInfo };
        calculateAndAddEta(outputInfo); // Calculate and add ETA to the copy

        // Simplify output if requested
        if (detail_level === 'simple') {
            delete (outputInfo as any).discoveredUrls; // Remove potentially large URL list
            // Optionally simplify the details string if it's JSON
            try {
                const parsedDetails = JSON.parse(outputInfo.details);
                if (parsedDetails && typeof parsedDetails === 'object' && parsedDetails.message) {
                    outputInfo.details = parsedDetails.message; // Keep only the message part
                } else if (parsedDetails && typeof parsedDetails === 'object' && parsedDetails.status) {
                    // Fallback if no message but status exists in JSON
                    outputInfo.details = parsedDetails.status;
                }
                // If parsing fails or expected fields aren't there, keep the original details string
            } catch (e) { /* Ignore parsing errors, keep original details */ }
        }
        resultObject = outputInfo;
        this.safeLog?.('info', `Retrieved status for task ${taskId} (Detail: ${detail_level})`);
      } else {
        resultObject = { taskId: taskId, status: 'not_found', details: `Task with ID ${taskId} was not found.` };
        this.safeLog?.('info', `Task ${taskId} not found.`);
      }
    } else {
      // --- Get All Tasks (Potentially Filtered) ---
      this.safeLog?.('info', `Retrieving status for ${taskType} tasks.`);
      const allTasks = getAllTasks(); // Get all tasks first
      const filteredTasks: { [key: string]: any } = {};
      let filterPrefix = '';

      switch (taskType) {
          case 'crawl': filterPrefix = 'crawl-'; break;
          case 'process': filterPrefix = 'process-'; break;
          case 'embed': filterPrefix = 'embed-'; break;
          case 'all':
          default: filterPrefix = ''; break; // No prefix means get all
      }

      let count = 0;
      for (const [id, info] of allTasks.entries()) {
          if (filterPrefix === '' || id.startsWith(filterPrefix)) {
              // Create a copy to modify for 'simple' view
              const outputInfo = { ...info };
              calculateAndAddEta(outputInfo); // Calculate and add ETA to the copy

              // Simplify output if requested
              if (detail_level === 'simple') {
                  delete (outputInfo as any).discoveredUrls;
                  // Optionally simplify the details string if it's JSON
                  try {
                      const parsedDetails = JSON.parse(outputInfo.details);
                      if (parsedDetails && typeof parsedDetails === 'object' && parsedDetails.message) {
                          outputInfo.details = parsedDetails.message;
                      } else if (parsedDetails && typeof parsedDetails === 'object' && parsedDetails.status) {
                          outputInfo.details = parsedDetails.status;
                      }
                  } catch (e) { /* Ignore parsing errors, keep original details */ }
              }
              filteredTasks[id] = outputInfo;
              count++;
          }
      }

      resultObject = filteredTasks;
      this.safeLog?.('info', `Found ${count} tasks matching filter '${taskType}'.`);
    }

    // Return stringified JSON
    return {
      content: [
        {
          type: 'text', // Return as stringified JSON text
          text: JSON.stringify(resultObject, null, 2), // Pretty print JSON
        },
      ],
    };
  }
}