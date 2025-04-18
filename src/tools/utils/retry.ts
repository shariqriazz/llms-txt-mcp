import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { isTaskCancelled } from '../../tasks.js'; // Assuming tasks.ts is two levels up

// Define LogFunction type (Consider moving to a more central types file if used widely)
type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;

/**
 * Retries an asynchronous function with exponential backoff and jitter.
 * Checks for task cancellation before each attempt and during error handling.
 * @param fn The async function to retry.
 * @param maxAttempts Maximum number of attempts.
 * @param initialDelayMs Initial delay in milliseconds.
 * @param taskDescription Description of the task for logging.
 * @param safeLog Optional logging function.
 * @param taskId Optional task ID for cancellation checks and logging.
 * @returns The result of the function if successful.
 * @throws The last error encountered after all attempts fail, or an McpError if cancelled.
 */
export async function retryAsyncFunction<T>(
    fn: () => Promise<T>,
    maxAttempts: number,
    initialDelayMs: number,
    taskDescription: string,
    safeLog?: LogFunction,
    taskId?: string
): Promise<T> {
    let attempts = 0;
    while (attempts < maxAttempts) {
        try {
            // Check for cancellation before starting the attempt
            if (taskId && isTaskCancelled(taskId)) {
                 safeLog?.('info', `[${taskId}] Task cancelled before starting/retrying ${taskDescription}.`);
                 throw new McpError(ErrorCode.InternalError, `Task ${taskId} cancelled.`);
            }
            // Attempt the function
            return await fn();
        } catch (error: any) {
            // Check for cancellation immediately after an error
            if (taskId && isTaskCancelled(taskId)) {
                 safeLog?.('info', `[${taskId}] Task cancelled during ${taskDescription} attempt ${attempts + 1}.`);
                 // Re-throw cancellation error, preserving original if it was also cancellation
                 throw error instanceof McpError && error.message.includes('cancelled')
                   ? error
                   : new McpError(ErrorCode.InternalError, `Task ${taskId} cancelled during operation.`);
            }

            attempts++;
            safeLog?.('warning', `[${taskId || 'Retry'}] Attempt ${attempts}/${maxAttempts} failed for ${taskDescription}: ${error.message}`);

            // Check if the error is an McpError and if its code indicates a non-retriable issue
            // We generally retry InternalError (-32603) and potentially others,
            // but not client-side errors like InvalidParams (-32602) or MethodNotFound (-32601)
            // or specific internal errors that shouldn't be retried.
            if (error instanceof McpError && error.code !== ErrorCode.InternalError) {
                 safeLog?.('error', `[${taskId || 'Retry'}] Non-retriable MCP error encountered for ${taskDescription}. Aborting retries.`);
                 throw error;
            }

            // Check if max attempts reached
            if (attempts >= maxAttempts) {
                safeLog?.('error', `[${taskId || 'Retry'}] All ${maxAttempts} attempts failed for ${taskDescription}.`);
                throw error; // Throw the last error encountered
            }

            // Calculate delay with exponential backoff and jitter
            const delayTime = initialDelayMs * Math.pow(2, attempts - 1);
            const jitter = delayTime * 0.2 * Math.random(); // Add up to 20% jitter
            const waitTime = Math.round(delayTime + jitter);

            safeLog?.('info', `[${taskId || 'Retry'}] Retrying ${taskDescription} in ${waitTime}ms...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
    // This line should theoretically be unreachable if logic is correct
    throw new Error(`Retry logic failed unexpectedly after ${attempts} attempts for ${taskDescription}`);
}