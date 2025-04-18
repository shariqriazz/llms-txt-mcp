import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import { z } from 'zod'; // Import Zod

const COLLECTION_NAME = 'documentation';

// Define Zod schema for input validation
const RemoveSourceInputSchema = z.object({
  urls: z.array(z.string().min(1)).min(1).describe('Array of source URLs/paths to remove (must match exactly the indexed source string).'),
});

export class VectorStoreRemoveSourceHandler extends BaseHandler {
  async handle(args: any): Promise<McpToolResponse> {
    const validationResult = RemoveSourceInputSchema.safeParse(args);
    if (!validationResult.success) {
      const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
      throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${errorMessage}`);
    }
    const { urls } = validationResult.data; // Use validated data

    try {
      const result = await this.apiClient.qdrantClient.delete(COLLECTION_NAME, {
        filter: {
          should: urls.map((url: string) => ({ // Use validated urls
            key: 'source',
            match: { value: url }
          }))
        },
        wait: true
      });

      if (!['acknowledged', 'completed'].includes(result.status)) {
        throw new Error('Delete operation failed');
      }

      return {
        content: [
          {
            type: 'text',
            text: `Successfully removed documentation from ${urls.length} source${urls.length > 1 ? 's' : ''}: ${urls.join(', ')}`, // Use validated urls
          },
        ],
      };
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('unauthorized')) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            'Failed to authenticate with Qdrant cloud while removing documentation'
          );
        } else if (error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT')) {
          throw new McpError(
            ErrorCode.InternalError,
            'Connection to Qdrant cloud failed while removing documentation'
          );
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: `Failed to remove documentation: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
}