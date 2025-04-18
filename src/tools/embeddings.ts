import ollama from 'ollama';
import OpenAI from 'openai';
import { GoogleGenAI } from "@google/genai";
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import pLimit from 'p-limit';

interface EmbeddingProvider {
  generateEmbeddings(text: string): Promise<number[]>;
  getVectorSize(): number;
}

class OllamaProvider implements EmbeddingProvider {
  private model: string;

  constructor(model: string = 'nomic-embed-text') {
    this.model = model;
  }

  async generateEmbeddings(text: string): Promise<number[]> {
    try {
      console.error(`Generating Ollama embeddings (${this.model}) for text:`, text.substring(0, 50) + '...');
      const response = await ollama.embeddings({
        model: this.model,
        prompt: text
      });
      console.error('Successfully generated Ollama embeddings with size:', response.embedding.length);
      return response.embedding;
    } catch (error) {
      console.error('Ollama embedding error:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to generate embeddings with Ollama: ${error}`
      );
    }
  }

  getVectorSize(): number {
    if (this.model.includes('nomic-embed-text')) {
        return 768;
    }
    console.warn(`Unknown vector size for Ollama model ${this.model}, defaulting to 768. Please verify.`);
    return 768;
  }
}

class OpenAIProvider implements EmbeddingProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string = 'text-embedding-3-small', baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model;
  }

  async generateEmbeddings(text: string): Promise<number[]> {
    try {
      console.error(`Generating OpenAI embeddings (${this.model}) for text:`, text.substring(0, 50) + '...');
      const response = await this.client.embeddings.create({
        model: this.model,
        input: text,
      });
      const embedding = response.data[0].embedding;
      console.error('Successfully generated OpenAI embeddings with size:', embedding.length);
      return embedding;
    } catch (error) {
      console.error('OpenAI embedding error:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to generate embeddings with OpenAI: ${error}`
      );
    }
  }

  getVectorSize(): number {
    if (this.model.includes('text-embedding-3-small') || this.model.includes('ada-002')) {
        return 1536;
    }
    if (this.model.includes('text-embedding-3-large')) {
        return 3072;
    }
    console.warn(`Unknown vector size for OpenAI model ${this.model}, defaulting to 1536. Please verify.`);
    return 1536;
  }
}

const GEMINI_RPM = 5;
const GEMINI_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const geminiLimiter = pLimit(GEMINI_RPM);

class GoogleGenAIProvider implements EmbeddingProvider {
  private apiKey: string;
  private primaryModel: string;
  private fallbackModel?: string;
  private requestTimestamps: number[] = [];

  constructor(apiKey: string, primaryModel: string, fallbackModel?: string) {
    if (!apiKey) {
        throw new Error('Google Gemini API key is required.');
    }
    this.apiKey = apiKey;
    this.primaryModel = primaryModel.startsWith('models/') ? primaryModel : `models/${primaryModel}`;
    if (fallbackModel) {
        this.fallbackModel = fallbackModel.startsWith('models/') ? fallbackModel : `models/${fallbackModel}`;
    }
    console.info(`Initializing GoogleGenAIProvider with primary model: ${this.primaryModel}` + (this.fallbackModel ? ` and fallback: ${this.fallbackModel}` : ''));
  }

  private async applyRateLimit(): Promise<void> {
      const now = Date.now();
      this.requestTimestamps = this.requestTimestamps.filter(ts => now - ts < GEMINI_RATE_LIMIT_WINDOW_MS);

      if (this.requestTimestamps.length >= GEMINI_RPM) {
          const oldestRequestTime = this.requestTimestamps[0];
          const timeToWait = GEMINI_RATE_LIMIT_WINDOW_MS - (now - oldestRequestTime);
          if (timeToWait > 0) {
              console.warn(`Gemini rate limit (5/min) hit. Waiting for ${timeToWait}ms...`);
              await new Promise(resolve => setTimeout(resolve, timeToWait));
              await this.applyRateLimit();
          }
      }
      this.requestTimestamps.push(Date.now());
      if (this.requestTimestamps.length > GEMINI_RPM * 2) {
          this.requestTimestamps.shift();
      }
  }

  private async _callEmbedContent(modelToUse: string, text: string): Promise<number[]> {
      await this.applyRateLimit();

      console.error(`Attempting Google Gemini embeddings with model: ${modelToUse}`);
      const genAI = new GoogleGenAI({ apiKey: this.apiKey });
      const response = await genAI.models.embedContent({
          model: modelToUse,
          contents: text,
          config: { outputDimensionality: 768 }
      });

      if (!response.embeddings || response.embeddings.length === 0) {
          throw new Error('Google Gemini API response did not contain embeddings.');
      }
      const embedding = response.embeddings[0].values;
      if (!embedding) {
          throw new Error('Google Gemini embedding object did not contain values.');
      }
      console.error(`Successfully generated Google Gemini embeddings with model ${modelToUse}. Size:`, embedding.length);
      return embedding;
  }

  async generateEmbeddings(text: string): Promise<number[]> {
    return geminiLimiter(async () => {
        try {
            return await this._callEmbedContent(this.primaryModel, text);
        } catch (error: any) {
            console.warn(`Primary Gemini model (${this.primaryModel}) failed: ${error.message || error}`);

            const isBadRequest = error.message?.includes('Bad Request') || error.status === 400;
            if (this.fallbackModel && isBadRequest) {
                console.warn(`Attempting fallback Gemini model: ${this.fallbackModel}`);
                try {
                    return await this._callEmbedContent(this.fallbackModel, text);
                } catch (fallbackError: any) {
                    console.error(`Fallback Gemini model (${this.fallbackModel}) also failed: ${fallbackError.message || fallbackError}`);
                    throw new McpError(
                        ErrorCode.InternalError,
                        `Failed to generate embeddings with Google Gemini (primary and fallback): ${fallbackError.message || fallbackError}`
                    );
                }
            } else {
                console.error(`No fallback configured or error not recoverable. Rethrowing original error.`);
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to generate embeddings with Google Gemini: ${error.message || error}`
                );
            }
        }
    });
  }

  getVectorSize(): number {
    return 768;
  }
}

export class EmbeddingService {
  private provider: EmbeddingProvider;

  constructor(provider: EmbeddingProvider) {
    this.provider = provider;
  }

  async generateEmbeddings(text: string): Promise<number[]> {
    return this.provider.generateEmbeddings(text);
  }

  getVectorSize(): number {
    return this.provider.getVectorSize();
  }

  static createFromConfig(config: {
    provider: 'ollama' | 'openai' | 'google';
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    geminiApiKey?: string;
    geminiFallbackModel?: string;
    model?: string;
  }): EmbeddingService {
    switch (config.provider) {
      case 'ollama':
        return new EmbeddingService(new OllamaProvider(config.model));
      case 'openai':
        if (!config.openaiApiKey) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'OpenAI API key (OPENAI_API_KEY) is required for openai provider'
          );
        }
        return new EmbeddingService(new OpenAIProvider(config.openaiApiKey, config.model, config.openaiBaseUrl));
      case 'google':
        if (!config.geminiApiKey) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Google Gemini API key (GEMINI_API_KEY) is required for google provider'
          );
        }
        return new EmbeddingService(new GoogleGenAIProvider(config.geminiApiKey, config.model || 'models/gemini-embedding-exp-03-07', config.geminiFallbackModel));
      default:
        const exhaustiveCheck: never = config.provider;
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown embedding provider specified: ${exhaustiveCheck}`
        );
    }
  }
}