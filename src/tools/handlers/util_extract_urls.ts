import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod'; // Import Zod
import { URL } from 'url'; // Ensure URL is imported

// Import Tavily search function and types (adjust path as necessary)
import { performTavilySearch, TavilyResponse, TavilySearchResult } from '../providers/tavily.js'; // Updated path

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const QUEUE_FILE = path.join(__dirname, '..', 'queue.txt'); // Go up one level from handlers

// Define the Zod schema for input validation
const ExtractUrlsSchema = z.object({
  url: z.string().url({ message: 'Valid URL is required' }).describe('The complete URL of the webpage to analyze.'),
  add_to_queue: z.boolean().optional().default(false).describe('If true, add extracted URLs to the processing queue.'),
  maxDepth: z.number().int().min(0).optional().default(1).describe('Max additional path segments deeper than the input URL to consider (e.g., 0=same level, 1=one level deeper). Default 1.'),
});

type ExtractUrlsArgs = z.infer<typeof ExtractUrlsSchema>;

export class UtilExtractUrlsHandler extends BaseHandler {
  // Helper function to extract and filter links from HTML content
  private _extractLinksFromHtml(htmlContent: string, pageUrlStr: string): Set<string> {
    const extractedUrls = new Set<string>();
    const pageUrl = new URL(pageUrlStr); // The URL of the page *being parsed*
    const $ = cheerio.load(htmlContent);

    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (href) {
        try {
          const linkUrl = new URL(href, pageUrlStr); // Resolve relative to the page being parsed

          // Basic filtering: same origin, no hash
          if (linkUrl.hostname !== pageUrl.hostname || linkUrl.hash || linkUrl.href.endsWith('#')) {
            return; // Skip different domains or fragment links
          }
          extractedUrls.add(linkUrl.href);
        } catch (e) {
          // Ignore invalid URLs
          this.safeLog?.('debug', `Ignoring invalid href: ${href} on page ${pageUrlStr}`);
        }
      }
    });
    return extractedUrls;
  }

  async handle(args: ExtractUrlsArgs): Promise<McpToolResponse> {
    // Validation is now handled by Zod
    if (!args.url) {
      throw new McpError(ErrorCode.InvalidParams, 'URL is required');
    }

    // No longer need to manage browser/page directly here
    // await this.apiClient.initBrowser();
    // const page = await this.apiClient.browser.newPage();

    try {
      const inputUrl = new URL(args.url);
      const inputHost = inputUrl.hostname;
      const inputPathSegments = inputUrl.pathname.split('/').filter(Boolean);
      const inputDepth = inputPathSegments.length;

      this.safeLog?.('info', `Extracting URLs from ${args.url} with maxDepth=${args.maxDepth}`);

      // --- 1. Extract links from the initial page using withPage ---
      const initialLinks = await this.apiClient.withPage(async (page) => {
          await page.goto(args.url, { waitUntil: 'networkidle' }); // Use networkidle for potentially dynamic pages
          const initialContent = await page.content();
          return this._extractLinksFromHtml(initialContent, args.url);
      });
      this.safeLog?.('debug', `Found ${initialLinks.size} initial links on ${args.url}`);

      // Filter initial links based on maxDepth (relative to input path)
      const filteredInitialLinks = new Set<string>();
      initialLinks.forEach(linkStr => {
        try {
          const linkUrl = new URL(linkStr);
          const linkSegments = linkUrl.pathname.split('/').filter(Boolean);
          const linkDepth = linkSegments.length;

          // Check if it's a subpath (starts with the same segments)
          let isSubPath = true;
          for (let i = 0; i < inputDepth; i++) {
            if (i >= linkDepth || linkSegments[i] !== inputPathSegments[i]) {
              isSubPath = false;
              break;
            }
          }

          if (isSubPath) {
            const depthDifference = linkDepth - inputDepth;
            if (depthDifference >= 0 && depthDifference <= args.maxDepth) {
              filteredInitialLinks.add(linkStr);
            }
          }
        } catch (e) {
          this.safeLog?.('debug', `Error processing initial link ${linkStr}: ${e}`);
        }
      });
      this.safeLog?.('debug', `Filtered ${filteredInitialLinks.size} initial links based on maxDepth=${args.maxDepth}`);

      const combinedUrls = new Set<string>(filteredInitialLinks); // Start with filtered initial links
      const potentialShallowLinks = new Set<string>();
      let parentFetchFailed = false;
      let searchFallbackUsed = false;

      // --- 2. Attempt to fetch parent page using withPage ---
      let parentUrlStr: string | null = null;
      if (inputDepth > 0) {
        const parentPath = '/' + inputPathSegments.slice(0, -1).join('/') + (inputPathSegments.length > 1 ? '/' : '');
        parentUrlStr = new URL(parentPath, inputUrl.origin).href;
        this.safeLog?.('debug', `Calculated parent URL: ${parentUrlStr}`);
      } else {
        this.safeLog?.('debug', `Input URL ${args.url} is at root, no parent to fetch.`);
        parentFetchFailed = true; // No parent exists
      }

      if (parentUrlStr) {
        try {
          this.safeLog?.('info', `Attempting to fetch parent page: ${parentUrlStr}`);
          const parentLinks = await this.apiClient.withPage(async (parentPage) => {
              await parentPage.goto(parentUrlStr!, { waitUntil: 'networkidle' }); // Use networkidle
              const parentContent = await parentPage.content();
              return this._extractLinksFromHtml(parentContent, parentUrlStr!);
          });
          this.safeLog?.('debug', `Found ${parentLinks.size} links on parent page ${parentUrlStr}`);
          parentLinks.forEach(link => potentialShallowLinks.add(link));
        } catch (error: any) {
          this.safeLog?.('warning', `Failed to fetch or parse parent page ${parentUrlStr}: ${error.message}`);
          parentFetchFailed = true;
        }
      }

      // --- 3. Search Fallback ---
      if (parentFetchFailed || potentialShallowLinks.size === 0) {
         this.safeLog?.('info', `Parent fetch failed or yielded no links. Triggering search fallback for ${inputHost}.`);
         searchFallbackUsed = true;
         try {
            const searchQuery = `site:${inputHost} related pages`;
            const searchParams = {
                query: searchQuery,
                include_domains: [inputHost], // Restrict to the same domain
                max_results: 10 // Get a reasonable number of results
            };
            this.safeLog?.('debug', `Performing Tavily search with params: ${JSON.stringify(searchParams)}`);
            const searchResponse: TavilyResponse = await performTavilySearch(searchParams);

            if (searchResponse.results && searchResponse.results.length > 0) {
                this.safeLog?.('debug', `Found ${searchResponse.results.length} search results.`);
                searchResponse.results.forEach((result: TavilySearchResult) => {
                    if (result.url) {
                        try {
                           const searchUrl = new URL(result.url);
                           if(searchUrl.hostname === inputHost && !searchUrl.hash && !searchUrl.href.endsWith('#')) {
                               potentialShallowLinks.add(searchUrl.href);
                           }
                        } catch (e) {
                            this.safeLog?.('debug', `Ignoring invalid URL from search result: ${result.url}`);
                        }
                    }
                });
            } else {
                this.safeLog?.('debug', 'Search fallback returned no results.');
            }
         } catch (error: any) {
            this.safeLog?.('error', `Search fallback failed: ${error.message}`);
            // Continue even if search fails
         }
      }

      // --- 4. Combine, Filter (Shallow/Same Level), and Deduplicate ---
      this.safeLog?.('debug', `Combining ${filteredInitialLinks.size} initial links and ${potentialShallowLinks.size} potential shallow links.`);
      potentialShallowLinks.forEach(link => combinedUrls.add(link));

      const finalUrlArray: string[] = [];
      combinedUrls.forEach(linkStr => {
        try {
          const linkUrl = new URL(linkStr);
          if (linkUrl.hostname === inputHost) {
            const linkSegments = linkUrl.pathname.split('/').filter(Boolean);
            const linkDepth = linkSegments.length;
            if (linkDepth <= inputDepth) {
              finalUrlArray.push(linkStr); // Keep same level or shallower
            }
          }
        } catch (e) {
          this.safeLog?.('debug', `Error during final filtering for ${linkStr}: ${e}`);
        }
      });

       const uniqueFinalUrls = Array.from(new Set(finalUrlArray));

      this.safeLog?.('info', `Final filtered URL count: ${uniqueFinalUrls.length}`);

      // --- 5. Return or Add to Queue ---
      if (args.add_to_queue) {
        try {
          // Ensure queue file exists
          try { await fs.access(QUEUE_FILE); } catch { await fs.writeFile(QUEUE_FILE, ''); }
          // Append URLs to queue
          const urlsToAdd = uniqueFinalUrls.join('\n') + (uniqueFinalUrls.length > 0 ? '\n' : '');
          await fs.appendFile(QUEUE_FILE, urlsToAdd);
          return {
            content: [{
                type: 'text',
                text: `Successfully added ${uniqueFinalUrls.length} URLs (maxDepth=${args.maxDepth}, parentFetch=${!parentFetchFailed}, searchFallback=${searchFallbackUsed}) to the queue`,
            }],
          };
        } catch (error: any) {
          this.safeLog?.('error', `Failed to add URLs to queue: ${error.message || error}`);
          return {
            content: [{
                type: 'text',
                text: `Found ${uniqueFinalUrls.length} URLs but failed to add to queue: ${error.message || error}`,
            }],
            isError: true,
          };
        }
      }

      // Return the found URLs if not adding to queue
      return {
        content: [{
            type: 'text',
            text: uniqueFinalUrls.length > 0
              ? `Found ${uniqueFinalUrls.length} URLs (maxDepth=${args.maxDepth}, parentFetch=${!parentFetchFailed}, searchFallback=${searchFallbackUsed}):\n${uniqueFinalUrls.join('\n')}`
              : `No URLs found matching criteria (maxDepth=${args.maxDepth}, parentFetch=${!parentFetchFailed}, searchFallback=${searchFallbackUsed}).`,
        }],
      };
    } catch (error: any) {
      this.safeLog?.('error', `Failed to extract URLs: ${error.message || error}`);
      return {
        content: [{
            type: 'text',
            text: `Failed to extract URLs: ${error.message || error}`,
        }],
        isError: true,
      };
    }
    // No finally block needed here as withPage handles page closing
    // and cleanup should happen at server shutdown
  }
}