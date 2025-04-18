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
    runningProgressCurrent: number;
    runningProgressTotal: number;
    // Add stage counts specifically for process-query
    runningCrawl?: number;
    runningSynthesize?: number;
    runningEmbed?: number;
}

export class CheckProgressHandler extends BaseHandler {
    async handle(args: any): Promise<McpToolResponse> {
        const allTasks = getAllTasks();
        const summary: Record<string, ProgressSummary> = {
            crawl: { total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0, runningProgressCurrent: 0, runningProgressTotal: 0 },
            'synthesize-llms-full': { total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0, runningProgressCurrent: 0, runningProgressTotal: 0 }, // Renamed from process
            embed: { total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0, runningProgressCurrent: 0, runningProgressTotal: 0 },
            'process-query': { total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0, runningProgressCurrent: 0, runningProgressTotal: 0, runningCrawl: 0, runningSynthesize: 0, runningEmbed: 0 }, // Added stage counts
            unknown: { total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0, runningProgressCurrent: 0, runningProgressTotal: 0 }
        };

        for (const [taskId, taskInfo] of allTasks.entries()) {
            let taskType = 'unknown';
            if (taskId.startsWith('crawl-')) taskType = 'crawl';
            else if (taskId.startsWith('synthesize-llms-full-')) taskType = 'synthesize-llms-full'; // Use new prefix and key
            else if (taskId.startsWith('embed-')) taskType = 'embed';
            else if (taskId.startsWith('process-query-')) taskType = 'process-query'; // Added check for new prefix

            const typeSummary = summary[taskType];
            typeSummary.total++;

            switch (taskInfo.status) {
                case 'completed': typeSummary.completed++; break;
                case 'running':
                    typeSummary.running++;
                    typeSummary.runningProgressCurrent += taskInfo.progressCurrent ?? 0;
                    typeSummary.runningProgressTotal += taskInfo.progressTotal ?? 0;
                    // Extract stage for process-query tasks based on common detail patterns
                    if (taskType === 'process-query') {
                        // Check for patterns indicating the stage
                        if (taskInfo.details.includes('Crawling') || taskInfo.details.includes('Crawl Stage:')) {
                            typeSummary.runningCrawl = (typeSummary.runningCrawl ?? 0) + 1;
                        } else if (taskInfo.details.includes('LLM Stage:') || taskInfo.details.includes('Synthesize Stage:')) {
                            typeSummary.runningSynthesize = (typeSummary.runningSynthesize ?? 0) + 1;
                        } else if (taskInfo.details.includes('Embedding') || taskInfo.details.includes('Embed Stage:')) {
                            typeSummary.runningEmbed = (typeSummary.runningEmbed ?? 0) + 1;
                        }
                        // Note: If details don't match any pattern, it won't be counted in a specific stage.
                    }
                    break;
                case 'queued': typeSummary.queued++; break;
                case 'failed': typeSummary.failed++; break;
                case 'cancelled': typeSummary.cancelled++; break;
            }
        }

        let report = "";
        for (const type in summary) {
            if (type === 'unknown' && summary[type].total === 0) continue;

            const s = summary[type];
            let runningText = `- Running: ${s.running}`;
            if (s.running > 0) {
                if (type === 'process-query') {
                    const stageDetails: string[] = [];
                    if (s.runningCrawl ?? 0 > 0) stageDetails.push(`Crawl: ${s.runningCrawl}`);
                    if (s.runningSynthesize ?? 0 > 0) stageDetails.push(`Synthesize: ${s.runningSynthesize}`);
                    if (s.runningEmbed ?? 0 > 0) stageDetails.push(`Embed: ${s.runningEmbed}`);
                    if (stageDetails.length > 0) runningText += ` (${stageDetails.join(', ')})`;
                }
                // Add overall progress if available (might be less useful if stages are shown)
                // if (s.runningProgressTotal > 0) {
                //     runningText += ` (Overall Progress: ${s.runningProgressCurrent}/${s.runningProgressTotal})`;
                // }
            }

            report += `${type.charAt(0).toUpperCase() + type.slice(1)} Tasks:\n`;
            report += `- Total: ${s.total}\n`;
            report += `- Completed: ${s.completed}\n`;
            report += `${runningText}\n`; // Use the constructed running text
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