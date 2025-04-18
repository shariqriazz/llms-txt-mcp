// Updated DocumentPayload to reflect actual Qdrant structure
interface DocumentPayload {
  text: string;
  source: string; // Changed from url
  chunk_index: number; // Added chunk_index
  [key: string]: unknown; // Allow other potential fields
}

// Updated type guard for the new DocumentPayload structure
export function isDocumentPayload(payload: unknown): payload is DocumentPayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Partial<DocumentPayload>;
  return (
    typeof p.text === 'string' &&
    typeof p.source === 'string' &&
    typeof p.chunk_index === 'number'
    // Removed checks for _type, url, title, timestamp
  );
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

export interface McpToolResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError?: boolean;
}

// Added types for Qdrant collection info check
interface QdrantVectorParams {
  size: number;
  distance: string;
}

interface QdrantCollectionParams {
  vectors: QdrantVectorParams;
}

interface QdrantCollectionConfig {
  params: QdrantCollectionParams;
}

export interface QdrantCollectionInfo {
  config: QdrantCollectionConfig;
}

// Type for Qdrant points being upserted
export interface QdrantPoint {
  id: string | number;
  vector: number[];
  payload?: Record<string, any>; // Payload is optional and can have any structure
}

// Arguments for llms-full generation tasks (matching Zod schema in handler) // Updated comment
export interface LlmsFullTaskArgs { // Renamed interface
    topic_or_url: string;
    category: string;
    crawl_depth?: number;
    max_urls?: number;
    max_llm_calls?: number;
    // Internal data passed between stages
    discoveredUrls?: string[];
    isSourceLocal?: boolean;
    finalLlmsContent?: string; // Renamed property
}

// Structure for items in pipeline queues (used by pipeline_state)
export interface QueuedPipelineTask {
    taskId: string;
    args: Record<string, any>; // Allow any arguments structure for queued tasks
}