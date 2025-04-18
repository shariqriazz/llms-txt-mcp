import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import { getAllTasks, TaskInfo, TaskStatusValue } from '../../tasks.js';

interface ProgressSummary {
    total: number;
    completed: number;
    running: number;
    queued: number;
    failed: number;
    cancelled: number;
    // Store details for the single running get-llms-full task, if any
    runningStage?: 'Discovery' | 'Fetch' | 'Synthesize' | 'Embed' | 'Cleanup' | 'Unknown'; // Added new stages
    runningTaskProgressCurrent?: number;
    runningTaskProgressTotal?: number;
}

export class CheckProgressHandler extends BaseHandler {
    async handle(args: any): Promise<McpToolResponse> {
        const allTasks = getAllTasks();
        const summary: Record<string, ProgressSummary> = {
            // Only initialize summaries for task types we expect to report
            'get-llms-full': { total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0 },
            unknown: { total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0 } // Catch-all
        };

        for (const [taskId, taskInfo] of allTasks.entries()) {
            let taskType = 'unknown'; // Default to unknown
            if (taskId.startsWith('get-llms-full-')) {
                taskType = 'get-llms-full'; // Only specifically identify the unified task type
            }

            // Ensure the summary object exists for the determined type (handles potential future types)
            if (!summary[taskType]) {
                summary[taskType] = { total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0 };
            }

            const typeSummary = summary[taskType];
            typeSummary.total++;

            switch (taskInfo.status) {
                case 'completed': typeSummary.completed++; break;
                case 'running':
                    typeSummary.running++;
                    // For get-llms-full, store the single running task's stage and progress
                    if (taskType === 'get-llms-full') {
                        typeSummary.runningTaskProgressCurrent = taskInfo.progressCurrent;
                        typeSummary.runningTaskProgressTotal = taskInfo.progressTotal;
                        // Prioritize the dedicated stage field
                        if (taskInfo.currentStage) {
                             // Map the stored stage name directly (ensure casing matches enum/expected values)
                             const stageName = taskInfo.currentStage.charAt(0).toUpperCase() + taskInfo.currentStage.slice(1);
                             typeSummary.runningStage = stageName as ('Discovery' | 'Fetch' | 'Synthesize' | 'Embed' | 'Cleanup');
                        } else {
                            // Fallback to parsing details if currentStage is not set (should be rare)
                            typeSummary.runningStage = 'Unknown'; // Default
                            const detailsLower = taskInfo.details.toLowerCase();
                            if (detailsLower.includes('discovery stage:')) { typeSummary.runningStage = 'Discovery'; }
                            else if (detailsLower.includes('fetch stage:')) { typeSummary.runningStage = 'Fetch'; }
                            else if (detailsLower.includes('synthesize stage:')) { typeSummary.runningStage = 'Synthesize'; }
                            else if (detailsLower.includes('embed stage:') || detailsLower.includes('embedding stage:')) { typeSummary.runningStage = 'Embed'; }
                            else if (detailsLower.includes('cleanup stage:')) { typeSummary.runningStage = 'Cleanup'; }
                        }
                    }
                    break;
                case 'queued': typeSummary.queued++; break;
                case 'failed': typeSummary.failed++; break;
                case 'cancelled': typeSummary.cancelled++; break;
            }
        }

        let report = "";
        for (const type in summary) {
            // Skip empty categories unless it's 'unknown' and has tasks
            if (summary[type].total === 0 && type !== 'unknown') continue;
            if (type === 'unknown' && summary[type].total === 0) continue;


            const s = summary[type];
            let runningText = `- Running: ${s.running}`;
            if (s.running > 0) {
                // Add stage and progress details specifically for get-llms-full
                if (type === 'get-llms-full' && s.runningStage) {
                    let stageDetail = s.runningStage;
                    if (s.runningTaskProgressCurrent !== undefined && s.runningTaskProgressTotal !== undefined && s.runningTaskProgressTotal > 0) {
                        stageDetail += ` [${s.runningTaskProgressCurrent}/${s.runningTaskProgressTotal}]`;
                    }
                    runningText += ` (${stageDetail})`;
                }
                // Add a generic progress indicator for 'unknown' tasks if applicable (optional)
                // else if (type === 'unknown' && s.runningProgressTotal > 0) {
                //     runningText += ` (Progress: ${s.runningProgressCurrent}/${s.runningProgressTotal})`;
                // }
            }

            // Format type name nicely (e.g., "Get-llms-full")
            const formattedTypeName = type.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('-');
            report += `${formattedTypeName} Tasks:\n`;
            report += `- Total: ${s.total}\n`;
            report += `- Completed: ${s.completed}\n`;
            report += `${runningText}\n`;
            report += `- Queued: ${s.queued}\n`;
            if (s.failed > 0) report += `- Failed: ${s.failed}\n`;
            if (s.cancelled > 0) report += `- Cancelled: ${s.cancelled}\n`;
            report += "\n";
        }

        if (report === "") {
            report = "No tasks found in the store.";
        }

        return {
            content: [{ type: 'text', text: report.trim() }],
        };
    }
}