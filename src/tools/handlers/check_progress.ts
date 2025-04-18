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
}

export class CheckProgressHandler extends BaseHandler {
    async handle(args: any): Promise<McpToolResponse> {
        const allTasks = getAllTasks();
        const summary: Record<string, ProgressSummary> = {
            crawl: { total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0, runningProgressCurrent: 0, runningProgressTotal: 0 },
            process: { total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0, runningProgressCurrent: 0, runningProgressTotal: 0 },
            embed: { total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0, runningProgressCurrent: 0, runningProgressTotal: 0 },
            unknown: { total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0, runningProgressCurrent: 0, runningProgressTotal: 0 }
        };

        for (const [taskId, taskInfo] of allTasks.entries()) {
            let taskType = 'unknown';
            if (taskId.startsWith('crawl-')) taskType = 'crawl';
            else if (taskId.startsWith('process-')) taskType = 'process';
            else if (taskId.startsWith('embed-')) taskType = 'embed';

            const typeSummary = summary[taskType];
            typeSummary.total++;

            switch (taskInfo.status) {
                case 'completed': typeSummary.completed++; break;
                case 'running':
                    typeSummary.running++;
                    typeSummary.runningProgressCurrent += taskInfo.progressCurrent ?? 0;
                    typeSummary.runningProgressTotal += taskInfo.progressTotal ?? 0;
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
            const progressText = s.running > 0 && s.runningProgressTotal > 0 ? ` (Progress: ${s.runningProgressCurrent}/${s.runningProgressTotal})` : '';
            report += `${type.charAt(0).toUpperCase() + type.slice(1)} Tasks:\n`;
            report += `- Total: ${s.total}\n`;
            report += `- Completed: ${s.completed}\n`;
            report += `- Running: ${s.running}${progressText}\n`;
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