import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './base-handler.js';
import { McpToolResponse, isDocumentPayload } from '../types.js';
import { Schemas } from '@qdrant/js-client-rest'; // Import Qdrant Schemas
import { z } from 'zod'; // Import Zod

const COLLECTION_NAME = 'documentation';

interface SourceInfo { // Renamed interface
  source: string; // Changed from url
  // Title is no longer consistently stored, we'll use source for display
}

interface GroupedSources {
  [domain: string]: {
    [subdomain: string]: SourceInfo[]; // Use renamed interface
  };
}

// Define Zod schema for input validation
const ListSourcesInputSchema = z.object({
  category: z.string().optional().describe('Optional category name to filter sources by.'),
});

export class VectorStoreListSourcesHandler extends BaseHandler {
  private groupSourcesByDomainAndSubdomain(sources: SourceInfo[]): GroupedSources { // Use renamed interface
    const grouped: GroupedSources = {};

    const LOCAL_FILES_DOMAIN = 'Local Files'; // Define a constant for local files

    for (const source of sources) {
      let domain: string;
      let subdomain: string;

      try {
        // Try parsing as a standard URL
        const urlObject = new URL(source.source); // Use source field
        domain = urlObject.hostname;
        const pathParts = urlObject.pathname.split('/').filter(p => p);
        subdomain = pathParts[0] || '/'; // Use first path part or root
      } catch (error) {
        // If URL parsing fails, treat as a local path
        console.warn(`Source string "${source.source}" is not a standard URL, treating as local path.`); // Use source field
        domain = LOCAL_FILES_DOMAIN;
        const pathParts = source.source.split('/').filter(p => p && p !== '.'); // Use source field
        subdomain = pathParts.length > 1 ? pathParts[0] : '/'; // Use first directory or root
      }

      // Grouping logic (remains the same)
      if (!grouped[domain]) {
        grouped[domain] = {};
      }
      if (!grouped[domain][subdomain]) {
        grouped[domain][subdomain] = [];
      }
      grouped[domain][subdomain].push(source);
    }

    return grouped;
  }

  private formatGroupedSources(grouped: GroupedSources): string { // Use renamed interface
    const output: string[] = [];
    let domainCounter = 1;

    for (const [domain, subdomains] of Object.entries(grouped)) {
      output.push(`${domainCounter}. ${domain}`);
      
      // Create a Set of unique source strings
      const uniqueSourceStrings = new Set<string>();
      for (const sources of Object.values(subdomains)) {
        for (const sourceInfo of sources) {
          uniqueSourceStrings.add(sourceInfo.source);
        }
      }

      // Convert to array and sort
      const sortedSourceStrings = Array.from(uniqueSourceStrings)
        .sort((a, b) => a.localeCompare(b));

      sortedSourceStrings.forEach((sourceString, index) => {
        // Display the source string directly as title is not available
        output.push(`${domainCounter}.${index + 1}. ${sourceString}`);
      });

      output.push(''); // Add blank line between domains
      domainCounter++;
    }

    return output.join('\n');
  }

  async handle(args: any): Promise<McpToolResponse> {
    const validationResult = ListSourcesInputSchema.safeParse(args);
    if (!validationResult.success) {
      const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
      throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${errorMessage}`);
    }
    const { category } = validationResult.data;

    try {
      const pageSize = 100;
      let offset: string | number | undefined | null = undefined; // Qdrant offset type
      const sources: SourceInfo[] = []; // Use renamed interface

      // Build filter if category is provided
      let filter: Schemas['Filter'] | undefined = undefined;
      if (category) {
        this.safeLog?.('info', `Filtering sources by category: ${category}`);
        filter = {
          must: [
            {
              key: 'category',
              match: { value: category },
            },
          ],
        };
      }

      while (true) {
        const scroll = await this.apiClient.qdrantClient.scroll(COLLECTION_NAME, {
          filter,
          with_payload: ['source'],
          with_vector: false,
          limit: pageSize,
          offset,
        });

        if (!scroll.points || scroll.points.length === 0) break;
        
        for (const point of scroll.points) {
          // Directly check for the 'source' field since that's all we requested
          if (point.payload && typeof point.payload.source === 'string') {
            sources.push({
              source: point.payload.source
            });
          } else {
            // Log if the expected 'source' field is missing or not a string
            this.safeLog?.('warning', `Skipping point ${point.id}: Missing or invalid 'source' field in payload: ${JSON.stringify(point.payload)}`);
          }
        }

        if (scroll.points.length < pageSize) break;
        const nextOffset = scroll.next_page_offset;
        // Ensure the offset is a type we can use for the next request
        if (typeof nextOffset === 'string' || typeof nextOffset === 'number') {
            offset = nextOffset;
        } else {
            // If it's null, undefined, or an unexpected object type, stop scrolling
            this.safeLog?.('debug', `Scroll finished or encountered unexpected offset type: ${JSON.stringify(nextOffset)}`);
            break;
        }
      }

      if (sources.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: category ? `No documentation sources found for category: ${category}.` : 'No documentation sources found.',
            },
          ],
        };
      }

      const grouped = this.groupSourcesByDomainAndSubdomain(sources);
      const formattedOutput = this.formatGroupedSources(grouped);

      return {
        content: [
          {
            type: 'text',
            text: formattedOutput,
          },
        ],
      };
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('unauthorized')) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            'Failed to authenticate with Qdrant cloud while listing sources'
          );
        } else if (error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT')) {
          throw new McpError(
            ErrorCode.InternalError,
            'Connection to Qdrant cloud failed while listing sources'
          );
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: `Failed to list sources: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
}