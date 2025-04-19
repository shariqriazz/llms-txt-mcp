import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import { getAllTasks, TaskInfo, TaskStatusValue, TaskStageValue } from '../../tasks.js'; // Import TaskStageValue

// Helper function to format milliseconds into a human-readable string
function formatElapsedTime(ms: number): string {
    if (ms < 0) ms = 0;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    const s = seconds % 60;
    const m = minutes % 60;
    const h = hours % 24;
    const d = days;

    let parts: string[] = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0 || parts.length === 0) parts.push(`${s}s`);

    return parts.join(' ');
}

interface RunningTaskInfo {
    stage: TaskStageValue;
    progressStr: string;
    description: string;
    elapsed: string;
}

interface ProgressSummary {
    total: number;
    completed: number;
    running: number; // Count of tasks with status 'running'
    queued: number;
    failed: number;
    cancelled: number;
    runningTaskDetails: RunningTaskInfo[]; // Store structured info
}

export class CheckProgressHandler extends BaseHandler {
    async handle(args: any): Promise<McpToolResponse> {
        const allTasks = getAllTasks();
        const summary: ProgressSummary = {
            total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0,
            runningTaskDetails: []
        };

        for (const [taskId, taskInfo] of allTasks.entries()) {
            if (!taskId.startsWith('get-llms-full-')) {
                continue;
            }

            summary.total++;

            switch (taskInfo.status) {
                case 'completed': summary.completed++; break;
                case 'queued': summary.queued++; break;
                case 'failed': summary.failed++; break;
                case 'cancelled': summary.cancelled++; break;
                case 'running':
                    summary.running++; // Increment total running count

                    let stage: TaskStageValue = undefined;
                    let progressStr = '';
                    let description = taskInfo.description || 'Unknown Topic';
                    let isActiveInStage = false; // Flag to check if actively processing vs waiting

                    // --- Determine Stage (Prioritize currentStage) ---
                    if (taskInfo.currentStage && taskInfo.currentStage !== 'QUEUED') {
                        stage = taskInfo.currentStage;
                    } else {
                        // Fallback parsing details (less reliable)
                        const detailsLower = taskInfo.details.toLowerCase();
                        if (detailsLower.includes('discovery stage:')) { stage = 'Discovery'; }
                        else if (detailsLower.includes('fetch stage:')) { stage = 'Fetch'; }
                        else if (detailsLower.includes('synthesize stage:')) { stage = 'Synthesize'; }
                        else if (detailsLower.includes('embed stage:') || detailsLower.includes('embedding stage:')) { stage = 'Embed'; }
                        else if (detailsLower.includes('cleanup stage:')) { stage = 'Cleanup'; }
                    }

                    // --- Determine Progress ---
                    if (taskInfo.progressCurrent !== undefined && taskInfo.progressTotal !== undefined && taskInfo.progressTotal > 0) {
                        progressStr = ` [${taskInfo.progressCurrent}/${taskInfo.progressTotal}]`;
                        // Assume if progress is being updated, it's active in the stage
                        isActiveInStage = true;
                    }

                    // --- Check if actively processing based on details ---
                    // This helps differentiate between "running" status but "waiting" for next stage lock
                    if (!isActiveInStage && taskInfo.details) {
                         const detailsLower = taskInfo.details.toLowerCase();
                         // Check for messages indicating active processing within a stage
                         if (detailsLower.includes('processing') ||
                             detailsLower.includes('summarized') ||
                             detailsLower.includes('upserting batch') ||
                             detailsLower.includes('fetching content') ||
                             detailsLower.includes('crawling website') ||
                             detailsLower.includes('scanning directory') ||
                             detailsLower.includes('generating embeddings'))
                         {
                             isActiveInStage = true;
                         }
                         // If details contain JSON result from *previous* stage, it's likely waiting
                         if (detailsLower.startsWith('{') && detailsLower.includes('"stage":')) {
                             isActiveInStage = false;
                         }
                    }

                    // Only add to the detailed running list if it seems actively processing a stage
                    if (isActiveInStage && stage) {
                        const elapsedMs = Date.now() - taskInfo.startTime;
                        const formattedElapsed = formatElapsedTime(elapsedMs);
                        summary.runningTaskDetails.push({
                            stage: stage,
                            progressStr: progressStr,
                            description: description,
                            elapsed: formattedElapsed
                        });
                    }
                    break; // End of 'running' case
            }
        }

        // --- Report Generation ---
        let report = "Get-Llms-Full Tasks:\n";
        report += `- Total: ${summary.total}\n`;
        report += `- Completed: ${summary.completed}\n`;
        report += `- Queued: ${summary.queued}\n`;
        if (summary.failed > 0) report += `- Failed: ${summary.failed}\n`;
        if (summary.cancelled > 0) report += `- Cancelled: ${summary.cancelled}\n`;
        report += `- Running (Overall): ${summary.running}\n`; // Show total tasks with 'running' status

        if (summary.runningTaskDetails.length > 0) {
            report += `\nActively Processing (${summary.runningTaskDetails.length}):\n`;
            // Sort? Optional
            // summary.runningTaskDetails.sort((a, b) => (a.description || '').localeCompare(b.description || ''));
            report += summary.runningTaskDetails.map(
                r => `- ${r.stage}${r.progressStr} (${r.description}) - Elapsed: ${r.elapsed}`
            ).join('\n');
        } else if (summary.running > 0) {
             report += `(Tasks are running but may be waiting between stages)`;
        }


        if (summary.total === 0) {
            report = "No get-llms-full tasks found in the store.";
        }

        return {
            content: [{ type: 'text', text: report.trim() }],
        };
    }
}