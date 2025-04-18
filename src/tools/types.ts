interface DocumentPayload {
  text: string;
  source: string;
  chunk_index: number;
  [key: string]: unknown;
}

export function isDocumentPayload(payload: unknown): payload is DocumentPayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Partial<DocumentPayload>;
  return (
    typeof p.text === 'string' &&
    typeof p.source === 'string' &&
    typeof p.chunk_index === 'number'
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
  payload?: Record<string, any>;
}

export interface LlmsFullTaskArgs {
    topic_or_url: string;
    category: string;
    crawl_depth?: number;
    max_urls?: number;
    max_llm_calls?: number;
    discoveredUrls?: string[];
    isSourceLocal?: boolean;
    finalLlmsContent?: string;
}

export interface QueuedPipelineTask {
    taskId: string;
    args: Record<string, any>;
}