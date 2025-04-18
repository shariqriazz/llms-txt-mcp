import { QdrantClient } from '@qdrant/js-client-rest';
// Removed OpenAI import: import OpenAI from 'openai';
import { chromium } from 'playwright';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { EmbeddingService } from './embeddings.js'; // Path is correct now
import type { QdrantCollectionInfo } from './types.js'; // Path is correct now

// Environment variables for configuration
const EMBEDDING_PROVIDER = (process.env.EMBEDDING_PROVIDER || 'ollama') as 'ollama' | 'openai' | 'google';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL; // Let providers handle defaults
const OLLAMA_URL = process.env.OLLAMA_URL; // Optional, provider might have default
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL; // Optional
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // Use singular key
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL; // Add fallback model env var
const QDRANT_URL = process.env.QDRANT_URL || 'http://127.0.0.1:6333'; // Default to local Qdrant
const QDRANT_API_KEY = process.env.QDRANT_API_KEY; // Optional, only needed for cloud

// Removed strict checks for QDRANT_URL/QDRANT_API_KEY

export class ApiClient {
  qdrantClient: QdrantClient;
  // Removed openaiClient: openaiClient?: OpenAI;
  browser: any;
  private embeddingService: EmbeddingService; // Added embeddingService property

  constructor() {
    // Initialize Qdrant client (URL required, API key optional)
    this.qdrantClient = new QdrantClient({
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY, // Will be undefined if not set, which is fine for local Qdrant
    });

    // Initialize EmbeddingService from environment configuration
    try {
        this.embeddingService = EmbeddingService.createFromConfig({
            provider: EMBEDDING_PROVIDER,
            model: EMBEDDING_MODEL,
            // ollamaBaseUrl removed as it's handled internally by the ollama library via OLLAMA_HOST env var if needed
            openaiApiKey: OPENAI_API_KEY,
            openaiBaseUrl: OPENAI_BASE_URL,
            geminiApiKey: GEMINI_API_KEY, // Pass singular key
            geminiFallbackModel: GEMINI_FALLBACK_MODEL // Pass fallback model name
        });
        console.error(`ApiClient initialized with embedding provider: ${EMBEDDING_PROVIDER}`);
    } catch (error) {
        console.error("Failed to initialize EmbeddingService:", error);
        // Decide how to handle this - throw, or maybe allow server to run without embedding?
        // For now, rethrow to prevent server starting in a broken state.
        throw new Error(`Failed to initialize EmbeddingService: ${error instanceof Error ? error.message : error}`);
    }

    // Removed direct OpenAI client initialization
  }

  async initBrowser() {
    if (!this.browser) {
      try {
        console.error("Initializing Playwright Chromium browser..."); // Add log
        this.browser = await chromium.launch();
        console.error("Browser initialized successfully."); // Add log
      } catch (error: any) {
        console.error("Failed to launch Playwright browser:", error);
        this.browser = null; // Ensure browser is null on failure
        // Rethrow the error so the caller (retry logic) knows initialization failed
        throw new Error(`Failed to initialize browser: ${error.message}`);
      }
    } else {
       // console.error("Browser already initialized."); // Optional debug log
    }
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null; // Reset the browser instance variable
    }
  }

  // Replaced with delegation to EmbeddingService
  async getEmbeddings(text: string): Promise<number[]> {
    try {
        return await this.embeddingService.generateEmbeddings(text);
    } catch (error) {
        // Log the specific embedding error
        console.error(`Error generating embeddings via ${EMBEDDING_PROVIDER}:`, error);
        // Rethrow as an McpError
        throw new McpError(
            ErrorCode.InternalError,
            `Failed to generate embeddings: ${error instanceof Error ? error.message : error}`
        );
    }
  }

  // Updated initCollection to use dynamic vector size and handle potential mismatches
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
                  distance: 'Cosine', // Or make configurable? Cosine is common.
              },
              // Add optimized settings for cloud deployment if QDRANT_API_KEY is set?
              ...(QDRANT_API_KEY && {
                  optimizers_config: { default_segment_number: 2 },
                  replication_factor: 2, // Sensible defaults for cloud
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
          // Only ignore "Not found" during the initial check/verify step, not during recreate steps
          if (error.message.includes('Not found') && context === 'initialize/verify') {
              // This might be expected if checking info on a non-existent collection before creation attempt
              console.warn("Qdrant 'Not found' error during verification, likely benign.");
              return; // Don't throw for this specific case during verification
          }
          if (error.message.includes('already exists') && context === 'create') {
              console.warn(`Collection already exists, skipping creation.`);
              return; // Don't throw if creation fails because it exists
          }
          if (error.message.includes('timed out') || error.message.includes('ECONNREFUSED')) {
              message = `Connection to Qdrant (${QDRANT_URL}) failed during collection ${context}. Please check Qdrant status and URL.`;
          } else if (error.message.includes('Unauthorized') || error.message.includes('Forbidden')) {
              message = `Authentication failed for Qdrant during collection ${context}. Please check QDRANT_API_KEY if using Qdrant Cloud.`;
              code = ErrorCode.InvalidRequest; // Auth error is likely bad config
          } else {
              message = `Qdrant error during collection ${context}: ${error.message}`;
          }
      } else {
          message = `Unknown Qdrant error during collection ${context}: ${error}`;
      }
      throw new McpError(code, message);
  }
}