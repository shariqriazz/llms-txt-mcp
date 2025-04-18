import { QdrantClient } from '@qdrant/js-client-rest';
import { chromium } from 'playwright';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { EmbeddingService } from './embeddings.js';
import type { QdrantCollectionInfo } from './types.js';

// Environment variables for configuration
const EMBEDDING_PROVIDER = (process.env.EMBEDDING_PROVIDER || 'ollama') as 'ollama' | 'openai' | 'google';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL;
const OLLAMA_URL = process.env.OLLAMA_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL;
const QDRANT_URL = process.env.QDRANT_URL || 'http://127.0.0.1:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;


export class ApiClient {
  qdrantClient: QdrantClient;
  browser: any;
  private embeddingService: EmbeddingService;

  constructor() {
    // Initialize Qdrant client (URL required, API key optional)
    this.qdrantClient = new QdrantClient({
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY,
    });

    // Initialize EmbeddingService from environment configuration
    try {
        this.embeddingService = EmbeddingService.createFromConfig({
            provider: EMBEDDING_PROVIDER,
            model: EMBEDDING_MODEL,
            openaiApiKey: OPENAI_API_KEY,
            openaiBaseUrl: OPENAI_BASE_URL,
            geminiApiKey: GEMINI_API_KEY,
            geminiFallbackModel: GEMINI_FALLBACK_MODEL
        });
        console.error(`ApiClient initialized with embedding provider: ${EMBEDDING_PROVIDER}`);
    } catch (error) {
        console.error("Failed to initialize EmbeddingService:", error);
        throw new Error(`Failed to initialize EmbeddingService: ${error instanceof Error ? error.message : error}`);
    }

  }

  async initBrowser() {
    if (!this.browser) {
      try {
        console.error("Initializing Playwright Chromium browser...");
        this.browser = await chromium.launch();
        console.error("Browser initialized successfully.");
      } catch (error: any) {
        console.error("Failed to launch Playwright browser:", error);
        this.browser = null;
        throw new Error(`Failed to initialize browser: ${error.message}`);
      }
    } else {
    }
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null; // Reset the browser instance variable
    }
  }

  async getEmbeddings(text: string): Promise<number[]> {
    try {
        return await this.embeddingService.generateEmbeddings(text);
    } catch (error) {
        console.error(`Error generating embeddings via ${EMBEDDING_PROVIDER}:`, error);
        throw new McpError(
            ErrorCode.InternalError,
            `Failed to generate embeddings: ${error instanceof Error ? error.message : error}`
        );
    }
  }

  async initCollection(COLLECTION_NAME: string) {
    const requiredVectorSize = this.embeddingService.getVectorSize();
    console.error(`Required vector size for collection '${COLLECTION_NAME}': ${requiredVectorSize}`);

    try {
      // Check if collection exists
      const collections = await this.qdrantClient.getCollections();
      const collection = collections.collections.find(c => c.name === COLLECTION_NAME);

      if (!collection) {
        console.error(`Collection '${COLLECTION_NAME}' not found. Creating with vector size ${requiredVectorSize}...`);
        await this.createQdrantCollection(COLLECTION_NAME, requiredVectorSize);
        console.error(`Collection '${COLLECTION_NAME}' created successfully.`);
        return;
      }

      // Collection exists, check vector size
      console.error(`Collection '${COLLECTION_NAME}' found. Verifying vector size...`);
      const collectionInfo = await this.qdrantClient.getCollection(COLLECTION_NAME) as QdrantCollectionInfo;
      const currentVectorSize = collectionInfo?.config?.params?.vectors?.size;

      if (!currentVectorSize) {
          console.error(`Could not determine current vector size for collection '${COLLECTION_NAME}'. Recreating collection...`);
          await this.recreateQdrantCollection(COLLECTION_NAME, requiredVectorSize);
      } else if (currentVectorSize !== requiredVectorSize) {
          console.error(`Vector size mismatch for collection '${COLLECTION_NAME}': current=${currentVectorSize}, required=${requiredVectorSize}. Recreating collection...`);
          await this.recreateQdrantCollection(COLLECTION_NAME, requiredVectorSize);
      } else {
          console.error(`Collection '${COLLECTION_NAME}' vector size (${currentVectorSize}) matches required size (${requiredVectorSize}).`);
      }

    } catch (error) {
      this.handleQdrantError(error, 'initialize/verify');
    }
  }

  // Helper to create collection
  private async createQdrantCollection(name: string, vectorSize: number) {
      try {
          await this.qdrantClient.createCollection(name, {
              vectors: {
                  size: vectorSize,
                  distance: 'Cosine',
              },
              ...(QDRANT_API_KEY && {
                  optimizers_config: { default_segment_number: 2 },
                  replication_factor: 2,
              })
          });
      } catch (error) {
          this.handleQdrantError(error, 'create');
      }
  }

  // Helper to recreate collection
  private async recreateQdrantCollection(name: string, vectorSize: number) {
      try {
          console.warn(`Attempting to delete and recreate collection '${name}'...`);
          await this.qdrantClient.deleteCollection(name);
          console.error(`Collection '${name}' deleted.`);
          await this.createQdrantCollection(name, vectorSize);
          console.error(`Collection '${name}' recreated successfully with vector size ${vectorSize}.`);
      } catch (error) {
          this.handleQdrantError(error, 'recreate');
      }
  }

  // Centralized Qdrant error handling
  private handleQdrantError(error: unknown, context: string) {
      console.error(`Qdrant error during collection ${context}:`, error);
      let message = `Failed to ${context} Qdrant collection`;
      let code = ErrorCode.InternalError;

      if (error instanceof Error) {
          if (error.message.includes('Not found') && context === 'initialize/verify') {
              console.warn("Qdrant 'Not found' error during verification, likely benign.");
              return;
          }
          if (error.message.includes('already exists') && context === 'create') {
              console.warn(`Collection already exists, skipping creation.`);
              return;
          }
          if (error.message.includes('timed out') || error.message.includes('ECONNREFUSED')) {
              message = `Connection to Qdrant (${QDRANT_URL}) failed during collection ${context}. Please check Qdrant status and URL.`;
          } else if (error.message.includes('Unauthorized') || error.message.includes('Forbidden')) {
              message = `Authentication failed for Qdrant during collection ${context}. Please check QDRANT_API_KEY if using Qdrant Cloud.`;
              code = ErrorCode.InvalidRequest;
          } else {
              message = `Qdrant error during collection ${context}: ${error.message}`;
          }
      } else {
          message = `Unknown Qdrant error during collection ${context}: ${error}`;
      }
      throw new McpError(code, message);
  }
}