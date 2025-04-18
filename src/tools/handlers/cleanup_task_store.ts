import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import { z } from 'zod';
import { cleanupTaskStore } from '../../tasks.js'; // Import the cleanup function

// --- Input Schema (No parameters needed) ---
const CleanupInputSchema = z.object({});

// --- Handler Class ---
export class CleanupTaskStoreHandler extends BaseHandler {

  async handle(_args: any): Promise<McpToolResponse> {
    // 1. Validate Input (Schema is empty, so validation always passes if args is object)
    const validationResult = CleanupInputSchema.safeParse(_args || {});
    if (!validationResult.success) {
       // Should not happen with empty schema, but include for robustness
       const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
       this.safeLog?.('error', `Internal validation error for cleanup: ${errorMessage}`);
       return { content: [{ type: 'text', text: `Internal validation error.` }], isError: true };
    }

    this.safeLog?.('info', `Attempting to clean up task store...`);

    try {
      cleanupTaskStore(); // Call the existing cleanup function
      const message = "Task store cleanup executed. Completed, failed, and cancelled tasks removed from the active list.";
      this.safeLog?.('info', message);
      return { content: [{ type: 'text', text: message }] };
    } catch (error: any) {
      const errorMessage = `Error during task store cleanup: ${error.message}`;
      this.safeLog?.('error', errorMessage);
      return { content: [{ type: 'text', text: errorMessage }], isError: true };
    }
  }
}