import { v5 as uuidv5 } from 'uuid';
import { QdrantPoint } from '../types.js';
import { ApiClient } from '../api-client.js';
import { updateTaskDetails } from '../../tasks.js'; // Import task update function

// Define LogFunction type (or import if shared)
type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;

// Constants (Consider making these configurable)
const UUID_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1f3341';

/**
 * Chunks text into smaller pieces with overlap.
 * @param text The input text.
 * @param chunkSize The target size of each chunk.
 * @param overlap The amount of overlap between chunks.
 * @returns An array of text chunks.
 */
export const chunkText = (text: string, chunkSize = 1000, overlap = 100): string[] => {
    const chunks: string[] = [];
    let i = 0;
    while (i < text.length) {
        const end = Math.min(i + chunkSize, text.length);
        chunks.push(text.slice(i, end));
        // Move start index back by overlap for next chunk, ensuring it doesn't go before 0
        i += chunkSize - overlap;
        if (i < 0) i = 0; // Prevent negative index if overlap > chunkSize
        // Ensure loop terminates if end reaches text length
        if (end === text.length) break;
         // Prevent infinite loop if chunk size and overlap are misconfigured
        if (chunkSize <= overlap && text.length > 0) {
            console.error("Chunking error: chunkSize must be greater than overlap to prevent infinite loops.");
            return [text]; // Return original text as a single chunk to avoid loop
        }
    }
    // Filter out any potentially empty chunks resulting from edge cases
    return chunks.filter(chunk => chunk.trim().length > 0);
};

/**
 * Generates embeddings for text chunks and prepares them as Qdrant points.
 * @param chunks Array of text chunks.
 * @param sourceIdentifier The original source URL or path for metadata.
 * @param category The category assigned to the source.
 * @param apiClient The ApiClient instance for accessing the embedding service.
 * @param safeLog Optional logging function.
 * @param taskId The ID of the parent task for status updates.
 * @returns A promise resolving to an array of QdrantPoint objects.
 */
export async function generateQdrantPoints(
    chunks: string[],
    sourceIdentifier: string,
    category: string,
    apiClient: ApiClient,
    safeLog?: LogFunction,
    taskId?: string // Add taskId as an optional parameter
): Promise<QdrantPoint[]> {
    const points: QdrantPoint[] = [];
    const totalChunks = chunks.length;

    for (let i = 0; i < totalChunks; i++) {
        const chunk = chunks[i];
        const progress = `${i + 1}/${totalChunks}`;
        safeLog?.('debug', `Embedding chunk ${progress} for ${sourceIdentifier}`);

        // Update task status if taskId is provided
        if (taskId) {
            updateTaskDetails(taskId, `Embedding Stage: Processing chunk ${progress}...`);
        }

        try {
            // Sanitize chunk content to remove problematic characters for JSON
            // More aggressive sanitization: Keep only known safe characters (alphanumeric, common symbols, basic whitespace)
            // Replace any character NOT in the allowed set with an empty string.
            const sanitizedChunk = chunk.replace(/[^a-zA-Z0-9 \t\n\r.,;:!?@#$%^&*()_+\-=[\]{}|'"<>/\`~]/g, '');
            const embedding = await apiClient.getEmbeddings(sanitizedChunk); // Use sanitized chunk for embedding
            const pointId = uuidv5(`${sourceIdentifier}#${i}`, UUID_NAMESPACE);
            points.push({
                id: pointId,
                vector: embedding,
                payload: { text: sanitizedChunk, source: sourceIdentifier, chunk_index: i, category: category }, // Use sanitized chunk in payload
            });
        } catch (error: any) {
            safeLog?.('error', `Failed to generate embedding for chunk ${i} from ${sourceIdentifier}: ${error.message}`);
        }
    }
    return points;
}