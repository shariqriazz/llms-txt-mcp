import { Tool } from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";

// --- Configuration ---
let TAVILY_API_KEY: string | undefined;
let axiosInstance: AxiosInstance;

const TAVILY_BASE_URLS = {
  search: 'https://api.tavily.com/search',
  extract: 'https://api.tavily.com/extract' // Assuming extract endpoint exists based on original code
};

export function checkTavilyConfig(): void {
  TAVILY_API_KEY = process.env.TAVILY_API_KEY;
  if (!TAVILY_API_KEY) {
    console.warn("[WARN] TAVILY_API_KEY environment variable not set. Tavily tools will not function.");
  } else {
     axiosInstance = axios.create({
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          // Tavily API key is passed in the request body, not headers
        }
      });
  }
}

// --- API Interfaces ---
export interface TavilySearchResult { // Export interface
    title: string;
    url: string;
    content: string;
    score: number;
    published_date?: string;
    raw_content?: string;
}

// Interface for the /extract endpoint result item
interface TavilyExtractResult {
    url: string;
    content?: string; // Main extracted content might be here
    raw_content?: string; // Raw HTML content
    images?: Array<string | { url: string; description?: string; }>; // Images might be per-URL
    // Note: Assuming title, score, published_date are NOT returned by /extract
}

// Interface for the overall /extract response
interface TavilyExtractResponse {
    results: Array<TavilyExtractResult>;
    response_time?: number;
    // Assuming query, follow_up_questions, answer are NOT returned by /extract
}

export interface TavilyResponse { // Export interface
  query: string;
  follow_up_questions?: Array<string>;
  answer?: string;
  images?: Array<string | { url: string; description?: string; }>;
  results: Array<TavilySearchResult>;
  response_time?: number;
}

// --- Tool Definitions ---
// Note: Schemas are copied directly from the initial prompt's description of tavily-mcp
const TAVILY_SEARCH_TOOL: Tool = {
    name: "tavily_search",
    description: "A powerful web search tool that provides comprehensive, real-time results using Tavily's AI search engine. Returns relevant web content with customizable parameters for result count, content type, and domain filtering. Ideal for gathering current information, news, and detailed web content analysis.",
    inputSchema: {
        type: "object",
        properties: {
            query: { type: "string", description: "Search query" },
            search_depth: { type: "string", enum: ["basic", "advanced"], description: "The depth of the search. It can be 'basic' or 'advanced'", default: "basic" },
            topic: { type: "string", enum: ["general", "news"], description: "The category of the search. This will determine which of our agents will be used for the search", default: "general" },
            days: { type: "number", description: "The number of days back from the current date to include in the search results. This specifies the time frame of data to be retrieved. Please note that this feature is only available when using the 'news' search topic", default: 3 },
            time_range: { type: "string", description: "The time range back from the current date to include in the search results. This feature is available for both 'general' and 'news' search topics", enum: ["day", "week", "month", "year", "d", "w", "m", "y"] },
            max_results: { type: "number", description: "The maximum number of search results to return", default: 10, minimum: 5, maximum: 20 },
            include_images: { type: "boolean", description: "Include a list of query-related images in the response", default: false },
            include_image_descriptions: { type: "boolean", description: "Include a list of query-related images and their descriptions in the response", default: false },
            include_raw_content: { type: "boolean", description: "Include the cleaned and parsed HTML content of each search result", default: false },
            include_domains: { type: "array", items: { type: "string" }, description: "A list of domains to specifically include in the search results, if the user asks to search on specific sites set this to the domain of the site", default: [] },
            exclude_domains: { type: "array", items: { type: "string" }, description: "List of domains to specifically exclude, if the user asks to exclude a domain set this to the domain of the site", default: [] }
        },
        required: ["query"]
    }
};

const TAVILY_EXTRACT_TOOL: Tool = {
    name: "tavily_extract",
    description: "A powerful web content extraction tool that retrieves and processes raw content from specified URLs, ideal for data collection, content analysis, and research tasks.",
    inputSchema: {
        type: "object",
        properties: {
            urls: { type: "array", items: { type: "string" }, description: "List of URLs to extract content from" },
            extract_depth: { type: "string", enum: ["basic", "advanced"], description: "Depth of extraction - 'basic' or 'advanced', if usrls are linkedin use 'advanced' or if explicitly told to use advanced", default: "basic" },
            include_images: { type: "boolean", description: "Include a list of images extracted from the urls in the response", default: false }
        },
        required: ["urls"]
    }
};

// --- API Call Logic ---
export async function performTavilySearch(params: any): Promise<TavilyResponse> { // Export function
    if (!TAVILY_API_KEY) throw new Error("TAVILY_API_KEY is not configured.");
    if (!axiosInstance) throw new Error("Axios instance not initialized for Tavily.");

    // Add topic: "news" if query contains the word "news" and topic not already set
    const searchParams = {
      ...params,
      api_key: TAVILY_API_KEY,
      topic: params.topic || (params.query?.toLowerCase().includes('news') ? 'news' : 'general')
    };

    try {
        const response = await axiosInstance.post(TAVILY_BASE_URLS.search, searchParams);
        return response.data as TavilyResponse;
    } catch (error: any) {
        if (error.response?.status === 401) throw new Error('Tavily API Error: Invalid API key');
        if (error.response?.status === 429) throw new Error('Tavily API Error: Usage limit exceeded');
        if (error.response?.data?.error) throw new Error(`Tavily API Error: ${error.response.data.error}`);
        throw error;
    }
}

async function performTavilyExtract(params: any): Promise<TavilyExtractResponse> { // Correct return type
    if (!TAVILY_API_KEY) throw new Error("TAVILY_API_KEY is not configured.");
    if (!axiosInstance) throw new Error("Axios instance not initialized for Tavily.");

    const extractParams = {
      ...params,
      api_key: TAVILY_API_KEY
    };

    try {
        // Assuming the extract endpoint returns a similar structure to search for formatting
        const response = await axiosInstance.post(TAVILY_BASE_URLS.extract, extractParams);
        return response.data as TavilyExtractResponse; // Use the correct response type
    } catch (error: any) {
        if (error.response?.status === 401) throw new Error('Tavily API Error: Invalid API key');
        if (error.response?.status === 429) throw new Error('Tavily API Error: Usage limit exceeded');
         if (error.response?.data?.error) throw new Error(`Tavily API Error: ${error.response.data.error}`);
        throw error;
    }
}

// --- Result Formatting ---
function formatTavilyResults(response: TavilyResponse): string {
  const output: string[] = [];

  // Include answer if available
  if (response.answer) {
    output.push(`Answer: ${response.answer}`);
  }

  // Include follow-up questions if available
  if (response.follow_up_questions && response.follow_up_questions.length > 0) {
      output.push('\nFollow-up Questions:');
      response.follow_up_questions.forEach(q => output.push(`- ${q}`));
  }

  // Format detailed search results
  if (response.results && response.results.length > 0) {
      output.push('\nDetailed Results:');
      response.results.forEach((result, index) => {
        output.push(`\nResult ${index + 1}:`);
        output.push(`Title: ${result.title}`);
        output.push(`URL: ${result.url}`);
        if (result.published_date) output.push(`Published Date: ${result.published_date}`);
        if (result.score !== undefined) output.push(`Score: ${result.score.toFixed(4)}`);
        output.push(`Content: ${result.content}`);
        if (result.raw_content) {
          output.push(`Raw Content: ${result.raw_content.substring(0, 500)}...`); // Limit raw content length
        }
      });
  } else {
      output.push('\nNo detailed results found.');
  }

   // Include images if available
   if (response.images && response.images.length > 0) {
       output.push('\nImages:');
       response.images.forEach(img => {
           if (typeof img === 'string') {
               output.push(`- ${img}`);
           } else {
               output.push(`- ${img.url} ${img.description ? `(${img.description})` : ''}`);
           }
       });
   }


  return output.join('\n').trim();
}

// --- Formatting function specifically for /extract results ---
function formatTavilyExtractResults(response: TavilyExtractResponse): string {
  const output: string[] = [];

  if (response.results && response.results.length > 0) {
      output.push('Extraction Results:');
      response.results.forEach((result, index) => {
        output.push(`
Result ${index + 1}:`);
        output.push(`URL: ${result.url}`);
        // Prefer 'content' if available, otherwise show snippet of 'raw_content'
        if (result.content) {
            output.push(`Content: ${result.content}`);
        } else if (result.raw_content) {
            output.push(`Raw Content Snippet: ${result.raw_content.substring(0, 500)}...`);
        }
        // Handle images if they are part of the per-URL result
        if (result.images && result.images.length > 0) {
            output.push('Images:');
            result.images.forEach(img => {
                if (typeof img === 'string') {
                    output.push(`- ${img}`);
                } else {
                    output.push(`- ${img.url} ${img.description ? `(${img.description})` : ''}`);
                }
            });
        }
      });
  } else {
      output.push('No extraction results found.');
  }

  return output.join('\n').trim();
}

// --- Tool Registration Function ---
export function registerTavilyTools(
    tools: Tool[],
    handlers: Map<string, (args: any) => Promise<any>>,
    safeLog: (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void
): void {
    if (!TAVILY_API_KEY) {
        safeLog('warning', 'Skipping Tavily tool registration: TAVILY_API_KEY not set.');
        return;
    }

    tools.push(TAVILY_SEARCH_TOOL, TAVILY_EXTRACT_TOOL);

    handlers.set(TAVILY_SEARCH_TOOL.name, async (args) => {
        safeLog('info', `Executing ${TAVILY_SEARCH_TOOL.name} with query: ${args.query}`);
        const results = await performTavilySearch(args);
        return { content: [{ type: "text", text: formatTavilyResults(results) }] };
    });

    handlers.set(TAVILY_EXTRACT_TOOL.name, async (args) => {
        safeLog('info', `Executing ${TAVILY_EXTRACT_TOOL.name} for URLs: ${args.urls?.join(', ')}`);
         // Assuming extract returns a similar structure for formatting
        const results = await performTavilyExtract(args);
        return { content: [{ type: "text", text: formatTavilyExtractResults(results) }] };
    });

    safeLog('debug', 'Tavily tools registered.');
}