import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApiClient } from '../api-client.js';
import { Schemas } from '@qdrant/js-client-rest'; // Import Qdrant Schemas
import { isDocumentPayload } from '../types.js'; // Import type guard
// Import LLM clients and config
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { Ollama } from 'ollama';
import OpenAI from 'openai';

// --- Input Schema ---
const COLLECTION_NAME = 'documentation'; // Define collection name

const SynthesizeInputSchema = z.object({
  query: z.string().min(1).describe('The user query to search for and synthesize an answer from.'),
  limit: z.coerce.number().int().min(1).max(10).optional().default(3).describe('Max search results to use as context (1-10, default 3).'),
  score_threshold: z.coerce.number().min(0.0).max(1.0).optional().default(0.55).describe('Min similarity score for search results (0.0-1.0, default 0.55).'),
  category: z.string().or(z.array(z.string())).optional().describe('Optional category name or array of names to filter search results.'),
});
type ValidatedSynthesizeArgs = z.infer<typeof SynthesizeInputSchema>;

// --- Handler Class ---
export class SynthesizeAnswerHandler extends BaseHandler {

  async handle(args: any): Promise<McpToolResponse> {
    const validationResult = SynthesizeInputSchema.safeParse(args);
    if (!validationResult.success) {
      const errorMessage = validationResult.error.errors.map(e => e.message).join(', ');
      throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${errorMessage}`);
    }
    // Use all validated args
    const { query, limit, score_threshold, category } = validationResult.data;

    this.safeLog?.('info', `Starting synthesis for query: "${query}"`);

    try {
      // 1. Perform Vector Search
      this.safeLog?.('debug', `Performing vector search for: "${query}" with limit=${limit}, threshold=${score_threshold}, category=${category}`);
      const searchResultsText = await this._performSearch(query, limit, score_threshold, category);

      if (!searchResultsText || searchResultsText.trim() === '' || searchResultsText.startsWith('No results found')) {
         this.safeLog?.('info', `No relevant documents found for query: "${query}"`);
         return { content: [{ type: 'text', text: 'No relevant documents found to synthesize an answer.' }] };
      }

      // 2. Construct Prompt for LLM
      const prompt = this._constructPrompt(query, searchResultsText);
      this.safeLog?.('debug', `Constructed synthesis prompt.`);

      // 3. Call LLM for Synthesis (Implementation needed)
      this.safeLog?.('debug', `Sending prompt to LLM for synthesis...`);
      const synthesizedAnswer = await this._callLLM(prompt); // Placeholder for LLM call

      // 4. Return Synthesized Answer
      this.safeLog?.('info', `Synthesis complete for query: "${query}"`);
      return { content: [{ type: 'text', text: synthesizedAnswer }] };

    } catch (error: any) {
      this.safeLog?.('error', `Synthesis failed: ${error.message}`);
      throw new McpError(ErrorCode.InternalError, `Failed to synthesize answer: ${error.message}`);
    }
  }

  // Internal search logic adapted from VectorStoreSearchHandler
  private async _performSearch(
      query: string,
      limit: number,
      score_threshold: number,
      category?: string | string[]
  ): Promise<string> {
    try {
      const queryEmbedding = await this.apiClient.getEmbeddings(query);
      this.safeLog?.('debug', `Generated query embedding for synthesis search.`);

      let filter: Schemas['Filter'] | undefined = undefined;
      if (category && category.length > 0) {
        if (Array.isArray(category)) {
          filter = { should: category.map(cat => ({ key: 'category', match: { value: cat } })) };
        } else {
          filter = { must: [{ key: 'category', match: { value: category } }] };
        }
      }

      const searchParams = {
        filter,
        vector: queryEmbedding,
        limit,
        with_payload: true,
        with_vector: false,
        score_threshold,
      };
      this.safeLog?.('debug', `Qdrant search params for synthesis: ${JSON.stringify(searchParams)}`);

      const searchResults = await this.apiClient.qdrantClient.search(COLLECTION_NAME, searchParams);

      // Format results simply for the LLM context
      const formattedResults = searchResults.map(result => {
        if (isDocumentPayload(result.payload)) {
          return `Source: ${result.payload.source}\nContent: ${result.payload.text}`;
        }
        return null;
      }).filter(Boolean).join('\n---\n');

      this.safeLog?.('info', `Retrieved ${searchResults.length} search results for synthesis context.`);
      return formattedResults || ''; // Return empty string if no results

    } catch (error: any) {
        this.safeLog?.('error', `Vector search failed during synthesis: ${error.message}`);
        // Re-throw or return empty to indicate failure to the main handle method
        throw new Error(`Vector search failed: ${error.message}`);
    }
  }

  // Helper to construct the prompt
  private _constructPrompt(query: string, context: string): string {
    return `Based on the following documentation context, please provide a comprehensive answer to the user's query. If the context doesn't fully answer the query, say so. Do not make up information not present in the context.

User Query: ${query}

Context:
---
${context}
---

Answer:`;
  }

  // LLM call logic adapted from llm_processor.ts
  private async _callLLM(prompt: string): Promise<string> {
    // Read LLM config from environment variables (same as llm_processor)
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    const LLM_PROVIDER = process.env.LLM_PROVIDER?.toLowerCase() || 'gemini';
    const LLM_MODEL = process.env.LLM_MODEL ||
        (LLM_PROVIDER === 'ollama' ? 'llama3.1:8b' :
        (LLM_PROVIDER === 'openrouter' ? 'openai/gpt-3.5-turbo' :
        'gemini-2.0-flash'));
    const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
    const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

    let llmClient: any;
    let generatedAnswer = '';
    let llmErrorReason = `LLM (${LLM_PROVIDER}) did not return valid content for synthesis.`;

    try {
        // Initialize LLM Client based on provider
        if (LLM_PROVIDER === 'gemini') {
            if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set.');
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            const safetySettings = [ // Consider if these safety settings are appropriate for synthesis
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            ];
            llmClient = genAI.getGenerativeModel({ model: LLM_MODEL, safetySettings });
            this.safeLog?.('info', `Using Gemini provider for synthesis (Model: ${LLM_MODEL})`);

            // Make API Call
            const result = await llmClient.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
            });
            const response = result.response;
            if (!response || !response.candidates || response.candidates.length === 0 || !response.candidates[0].content?.parts?.[0]?.text) {
                if (response?.promptFeedback?.blockReason) {
                    llmErrorReason = `Gemini request blocked: ${response.promptFeedback.blockReason}`;
                } else {
                    const finishReason = response?.candidates?.[0]?.finishReason;
                    if (finishReason && finishReason !== 'STOP') llmErrorReason = `Gemini generation finished unexpectedly: ${finishReason}`;
                }
                throw new Error(llmErrorReason);
            }
            generatedAnswer = response.candidates[0].content.parts[0].text;

        } else if (LLM_PROVIDER === 'ollama') {
            const ollamaConfig: { host?: string } = {};
            if (OLLAMA_BASE_URL) ollamaConfig.host = OLLAMA_BASE_URL;
            llmClient = new Ollama(ollamaConfig);
            this.safeLog?.('info', `Using Ollama provider for synthesis (Model: ${LLM_MODEL}, Host: ${OLLAMA_BASE_URL || 'default'})`);

            // Make API Call
            const result = await llmClient.generate({ model: LLM_MODEL, prompt: prompt, stream: false });
            if (!result || !result.response) throw new Error(llmErrorReason);
            generatedAnswer = result.response;

        } else if (LLM_PROVIDER === 'openrouter') {
            if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set.');
            llmClient = new OpenAI({ apiKey: OPENROUTER_API_KEY, baseURL: OPENROUTER_BASE_URL });
            this.safeLog?.('info', `Using OpenRouter provider for synthesis (Model: ${LLM_MODEL}, BaseURL: ${OPENROUTER_BASE_URL})`);

            // Make API Call
            const result = await llmClient.chat.completions.create({
                model: LLM_MODEL,
                messages: [{ role: "user", content: prompt }],
            });
            if (!result || !result.choices || result.choices.length === 0 || !result.choices[0].message?.content) {
                const finishReason = result?.choices?.[0]?.finish_reason;
                if (finishReason && finishReason !== 'stop') llmErrorReason = `OpenRouter generation finished unexpectedly: ${finishReason}`;
                throw new Error(llmErrorReason);
            }
            generatedAnswer = result.choices[0].message.content;

        } else {
            throw new Error(`Unsupported LLM_PROVIDER for synthesis: ${LLM_PROVIDER}`);
        }

        return generatedAnswer.trim();

    } catch (llmError: any) {
        const specificErrorMsg = `LLM Synthesis Error (${LLM_PROVIDER}): ${llmError.message || llmErrorReason}`;
        this.safeLog?.('error', specificErrorMsg);
        throw new Error(specificErrorMsg); // Re-throw to be caught by the main handle method
    }
  }
}