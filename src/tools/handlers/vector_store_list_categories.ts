import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const COLLECTION_NAME = 'documentation';

export class VectorStoreListCategoriesHandler extends BaseHandler {

  async handle(_args: any): Promise<McpToolResponse> {
    this.safeLog?.('info', `Executing vector_store_list_categories for collection: ${COLLECTION_NAME}`);
    const categories = new Set<string>();
    let offset: string | number | undefined | null = undefined; // Qdrant offset type

    try {
      // Scroll through all points, retrieving only the category payload
      while (true) {
        this.safeLog?.('debug', `Scrolling collection '${COLLECTION_NAME}' with offset: ${offset}`);
        const scrollResult = await this.apiClient.qdrantClient.scroll(COLLECTION_NAME, {
          limit: 250, // Adjust batch size as needed
          offset: offset,
          with_payload: ['category'], // Only fetch the category field
          with_vector: false,
        });

        if (!scrollResult.points || scrollResult.points.length === 0) {
          this.safeLog?.('debug', 'Scroll finished, no more points.');
          break; // No more points
        }

        for (const point of scrollResult.points) {
          if (point.payload?.category && typeof point.payload.category === 'string') {
            categories.add(point.payload.category);
          }
        }

        const nextOffset = scrollResult.next_page_offset;
        // Ensure the offset is a type we can use for the next request
        if (typeof nextOffset === 'string' || typeof nextOffset === 'number') {
            offset = nextOffset;
        } else {
            // If it's null, undefined, or an unexpected object type, stop scrolling
            this.safeLog?.('debug', `Scroll finished or encountered unexpected offset type: ${JSON.stringify(nextOffset)}`);
            break;
        }
      }

      const categoryList = Array.from(categories).sort();
      const message = categoryList.length > 0
        ? `Found ${categoryList.length} categories:\n- ${categoryList.join('\n- ')}`
        : 'No categories found in the vector store.';

      this.safeLog?.('info', `Found ${categoryList.length} distinct categories.`);
      return {
        content: [{ type: 'text', text: message }],
      };

    } catch (error: any) {
      this.safeLog?.('error', `Failed to list categories: ${error.message}`);
      // Handle specific Qdrant errors if necessary (e.g., collection not found)
      if (error.message?.includes('Not found') || error.status === 404) {
           throw new McpError(ErrorCode.InvalidRequest, `Collection '${COLLECTION_NAME}' not found.`);
      }
      throw new McpError(ErrorCode.InternalError, `Failed to list categories: ${error.message}`);
    }
  }
}
// End of VectorStoreListCategoriesHandler class