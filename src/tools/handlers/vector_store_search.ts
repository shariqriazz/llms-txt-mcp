import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './base-handler.js';
import { McpToolResponse, isDocumentPayload } from '../types.js';
import { z } from 'zod'; // Import Zod
import { Schemas } from '@qdrant/js-client-rest'; // Import Qdrant Schemas

const COLLECTION_NAME = 'documentation';

// Define the input schema using Zod
const SearchDocumentationInputSchema = z.object({
  query: z.string().min(1, { message: 'Query is required.' }),
  limit: z.coerce.number().int().min(1).max(20).optional().default(5), // Coerce to number
  url_pattern: z.string().optional(), // Add optional url_pattern
  score_threshold: z.coerce.number().min(0.0).max(1.0).optional().default(0.55), // Updated default score_threshold
  category: z.string().or(z.array(z.string())).optional(), // Allow string or array
});

// Helper function for simple wildcard matching (* only)
function wildcardMatch(pattern: string, text: string): boolean {
  // Basic escape for regex chars, then replace * with .*
  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape most special chars
    .replace(/\*/g, '.*'); // Replace * with .* wildcard
  try {
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(text);
  } catch (e) {
    console.error(`Invalid regex from pattern: ${pattern}`, e);
    return false;
  }
}

export class VectorStoreSearchHandler extends BaseHandler {
  async handle(args: any): Promise<McpToolResponse> {
    // Validate input using the Zod schema
    const validationResult = SearchDocumentationInputSchema.safeParse(args);
    if (!validationResult.success) {
      const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
      throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${errorMessage}`);
    }

    const { query, limit, url_pattern, score_threshold, category } = validationResult.data;

    try {
      // Generate embedding for the query
      const queryEmbedding = await this.apiClient.getEmbeddings(query);
      this.safeLog?.('debug', `Generated query embedding (first 5 dims): [${queryEmbedding.slice(0, 5).join(', ')}]`);

      // Build filter based on category, if provided
      let filter: Schemas['Filter'] | undefined = undefined;
      if (category && category.length > 0) {
        if (Array.isArray(category)) {
          this.safeLog?.('info', `Filtering search by categories: ${category.join(', ')}`);
          filter = {
            should: category.map(cat => ({
              key: 'category',
              match: { value: cat },
            })),
          };
        } else {
          this.safeLog?.('info', `Filtering search by category: ${category}`);
          filter = {
            must: [
              {
                key: 'category',
                match: { value: category },
              },
            ],
          };
        }
      }

      // Prepare search parameters for Qdrant
      const searchParams = {
        filter,
        vector: queryEmbedding,
        limit,
        with_payload: true,
        with_vector: false,
        score_threshold,
      };
      this.safeLog?.('debug', `Qdrant search params: ${JSON.stringify(searchParams)}`);

      // Perform the search
      let searchResults = await this.apiClient.qdrantClient.search(COLLECTION_NAME, searchParams);

      // Post-filter results by url_pattern if provided (client-side filtering)
      if (url_pattern && url_pattern.trim() !== '') {
        const trimmedPattern = url_pattern.trim();
        this.safeLog?.('debug', `Filtering search results with URL pattern: ${trimmedPattern}`);
        searchResults = searchResults.filter(result => {
          if (isDocumentPayload(result.payload) && result.payload.source) {
            return wildcardMatch(trimmedPattern, result.payload.source);
          }
          this.safeLog?.('debug', `Excluding result ID ${result.id}: Invalid payload or missing source.`);
          return false;
        });
        this.safeLog?.('debug', `Found ${searchResults.length} results after URL pattern filtering.`);
      }

      // Format the results
      const formattedResults = searchResults.map(result => {
        if (!isDocumentPayload(result.payload)) {
          this.safeLog?.('warning', `Skipping result with invalid payload: ID ${result.id}`);
          return null;
        }
        return `[${result.payload.source}](${result.payload.source})\nScore: ${result.score.toFixed(3)}\nContent: ${result.payload.text}\n`;
      }).filter(Boolean).join('\n---\n');

      return {
        content: [
          {
            type: 'text',
            text: formattedResults || 'No results found matching the query or filter.',
          },
        ],
      };
    } catch (error) {
      // Error Handling
      if (error instanceof Error) {
        if (error.message.includes('unauthorized')) {
          throw new McpError(ErrorCode.InvalidRequest, 'Failed to authenticate with Qdrant cloud while searching');
        } else if (error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT')) {
          throw new McpError(ErrorCode.InternalError, 'Connection to Qdrant cloud failed while searching');
        }
      }
      this.safeLog?.('error', `Search failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{ type: 'text', text: `Search failed: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
}