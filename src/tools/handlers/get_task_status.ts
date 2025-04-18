import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
// Import TaskInfo type and task functions
import { getTaskStatus, getAllTasks, TaskInfo } from '../../tasks.js';

// --- Input Schema ---
const TaskTypeEnum = z.enum(['crawl', 'synthesize-llms-full', 'embed', 'all']).optional().default('all').describe('Filter tasks by type.'); // Renamed 'process'
const DetailLevelEnum = z.enum(['simple', 'detailed']).optional().default('simple').describe('Level of detail to return.');

const GetTaskStatusInputSchema = z.object({
  taskId: z.string().min(1).optional().describe('The ID of the specific task to get status for.'),
  taskType: TaskTypeEnum,
  detail_level: DetailLevelEnum,
});
type ValidatedGetStatusArgs = z.infer<typeof GetTaskStatusInputSchema>;


// --- Helper Function for ETA ---
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
}


// --- Handler Class ---
export class GetTaskStatusHandler extends BaseHandler {

  async handle(args: any): Promise<McpToolResponse> {
    const validationResult = GetTaskStatusInputSchema.safeParse(args);
    if (!validationResult.success) {
      const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
      throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${errorMessage}`);
    }
    const { taskId, taskType, detail_level } = validationResult.data;

    let resultObject: any;

    if (taskId) {
      // --- Get Specific Task Status ---
      const taskInfo = getTaskStatus(taskId);
      if (taskInfo) {
        const outputInfo = { ...taskInfo };
        calculateAndAddEta(outputInfo);

        if (detail_level === 'simple') {
            delete (outputInfo as any).discoveredUrls;
            try {
                const parsedDetails = JSON.parse(outputInfo.details);
                if (parsedDetails && typeof parsedDetails === 'object' && parsedDetails.message) {
                    outputInfo.details = parsedDetails.message;
                } else if (parsedDetails && typeof parsedDetails === 'object' && parsedDetails.status) {
                    outputInfo.details = parsedDetails.status;
                }
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
      const allTasks = getAllTasks();
      const filteredTasks: { [key: string]: any } = {};
      let filterPrefix = '';

      switch (taskType) {
          case 'crawl': filterPrefix = 'crawl-'; break;
          case 'synthesize-llms-full': filterPrefix = 'synthesize-llms-full-'; break; // Use new type and prefix
          case 'embed': filterPrefix = 'embed-'; break;
          case 'all':
          default: filterPrefix = ''; break;
      }

      let count = 0;
      for (const [id, info] of allTasks.entries()) {
          if (filterPrefix === '' || id.startsWith(filterPrefix)) {
              const outputInfo = { ...info };
              calculateAndAddEta(outputInfo);

              if (detail_level === 'simple') {
                  delete (outputInfo as any).discoveredUrls;
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

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(resultObject, null, 2),
        },
      ],
    };
  }
}