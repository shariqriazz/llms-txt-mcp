import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { Ollama } from 'ollama'; // Import Ollama
import { ApiClient } from '../api-client.js';
import { extractTextContent as extractContentUtil } from './content_extractor.js'; // Import extractor util
import { isTaskCancelled, updateTaskDetails } from '../../tasks.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { acquireBrowserLock, releaseBrowserLock } from '../../pipeline_state.js';

type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;

// Configuration from Environment Variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LLM_PROVIDER = process.env.LLM_PROVIDER?.toLowerCase() || 'gemini'; // Default to gemini
const LLM_MODEL = process.env.LLM_MODEL || (LLM_PROVIDER === 'ollama' ? 'llama3.1:8b' : 'gemini-2.0-flash'); // Default model based on provider
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL; // Optional: e.g., http://host.docker.internal:11434

/**
 * Processes a list of URLs/paths using an LLM to generate guide content.
 * @param taskId The ID of the parent task.
 * @param urlsToProcess List of URLs or local file paths.
 * @param topic The original topic/URL for context in the final guide header.
 * @param max_llm_calls Maximum number of sources to process with the LLM.
 * @param apiClient The ApiClient instance.
 * @param safeLog Optional logging function.
 * @returns A promise resolving to the aggregated Markdown content string.
 * @throws If the LLM API key is missing or a critical error occurs.
 */
export async function processSourcesWithLlm(
    taskId: string,
    urlsToProcess: string[],
    topic: string,
    max_llm_calls: number,
    apiClient: ApiClient,
    safeLog?: LogFunction
): Promise<string> {

    let llmClient: any;
    if (LLM_PROVIDER === 'gemini') {
        if (!GEMINI_API_KEY) {
            throw new McpError(ErrorCode.InvalidRequest, 'LLM_PROVIDER is "gemini" but GEMINI_API_KEY environment variable is not set.');
        }
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const safetySettings = [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ];
        const generationConfig = { };
        llmClient = genAI.getGenerativeModel({ model: LLM_MODEL, safetySettings, generationConfig });
    } else if (LLM_PROVIDER === 'ollama') {
        const ollamaConfig: { host?: string } = {};
        if (OLLAMA_BASE_URL) {
            ollamaConfig.host = OLLAMA_BASE_URL;
        }
        llmClient = new Ollama(ollamaConfig);
        safeLog?.('info', `[${taskId}] Using Ollama provider with model ${LLM_MODEL} at ${OLLAMA_BASE_URL || 'default'}`);
    } else {
        throw new McpError(ErrorCode.InvalidRequest, `Unsupported LLM_PROVIDER: ${LLM_PROVIDER}. Must be 'gemini' or 'ollama'.`);
    }

    let finalLlmsContent = `# LLMS Full Content for ${topic} (Provider: ${LLM_PROVIDER}, Model: ${LLM_MODEL})\n\n`;
    let llmErrors = 0;
    let processedCount = 0;

    updateTaskDetails(taskId, `Starting LLM processing stage for ${urlsToProcess.length} sources...`);
    safeLog?.('info', `[${taskId}] Starting LLM stage. Processing up to ${max_llm_calls} sources.`);

    // --- Acquire Browser Lock for Extraction ---
    if (!acquireBrowserLock()) {
        safeLog?.('error', `[${taskId}] LLM Stage: Failed to acquire browser lock before starting processing loop.`);
        throw new Error("Could not acquire browser lock for LLM stage content extraction.");
    }
    safeLog?.('debug', `[${taskId}] LLM Stage: Acquired browser lock.`);
    let browserLockReleased = false;
    // --- End Acquire Browser Lock ---

    try {
        for (let i = 0; i < urlsToProcess.length; i++) {
            const itemPathOrUrl = urlsToProcess[i];
            if (isTaskCancelled(taskId)) {
            updateTaskDetails(taskId, 'Cancellation requested during LLM processing.');
            safeLog?.('info', `[${taskId}] Cancellation requested during LLM stage.`);
            throw new McpError(ErrorCode.InternalError, `LLMS Full generation task ${taskId} cancelled by user during LLM stage.`);
        }
        if (processedCount >= max_llm_calls) {
            safeLog?.('warning', `[${taskId}] Reached max_llm_calls limit (${max_llm_calls}). Stopping LLM processing.`);
            break;
        }

        updateTaskDetails(taskId, `LLM Stage: Processing source ${i + 1}/${urlsToProcess.length}: Extracting content...`);
        try {
            safeLog?.('debug', `[${taskId}] LLM Stage: Processing source: ${itemPathOrUrl}`);
            // Ensure browser is initialized if needed by extractor
            await apiClient.initBrowser();
            const sourceContent = await extractContentUtil(itemPathOrUrl, apiClient, safeLog);
            safeLog?.('debug', `[${taskId}] LLM Stage: Extracted content length for ${itemPathOrUrl}: ${sourceContent.length}`);

            if (!sourceContent || sourceContent.trim().length === 0) {
                safeLog?.('warning', `[${taskId}] LLM Stage: Skipping ${itemPathOrUrl}: No content extracted.`);
                continue;
            }

            const prompt = `Generate a Markdown section summarizing the key information from the following documentation content, suitable for inclusion in a larger 'llms-full.txt' guide. Follow these guidelines:\n  - Use clear and concise language. Avoid jargon where possible or explain it.\n  - Implement a clear hierarchy of headings and subheadings (use ## or ### appropriately for sections within this source).\n  - Prioritize API references, usage examples, and common errors/FAQs if present.\n  - Exclude redundant explanations, marketing fluff, navigation elements, and complex formatting not suitable for Markdown.\n  - Ensure information conveyed through images in the original content is described in text.\n  - Format code snippets clearly using Markdown code blocks.\n  - Format troubleshooting/FAQs as Q&A if applicable.\n\n  Documentation Content for ${itemPathOrUrl}:\n  ---\n  ${sourceContent.substring(0, 100000)}\n  ---\n  `;

            updateTaskDetails(taskId, `LLM Stage: Processing source ${i + 1}/${urlsToProcess.length}: Sending to LLM...`);
            safeLog?.('debug', `[${taskId}] LLM Stage: Sending content from ${itemPathOrUrl} to ${LLM_PROVIDER}...`);

            let generatedSection = '';
            let llmErrorReason = `LLM (${LLM_PROVIDER}) did not return valid content.`;

            try {
                if (LLM_PROVIDER === 'gemini') {
                    const result = await llmClient.generateContent({
                        contents: [{ role: "user", parts: [{ text: prompt }] }],
                        // safetySettings and generationConfig are now part of llmClient initialization
                    });
                    processedCount++;
                    const response = result.response;

                    if (!response || !response.candidates || response.candidates.length === 0 || !response.candidates[0].content?.parts?.[0]?.text) {
                        if (response?.promptFeedback?.blockReason) {
                            llmErrorReason = `Gemini request blocked due to safety settings: ${response.promptFeedback.blockReason}`;
                        } else {
                            const finishReason = response?.candidates?.[0]?.finishReason;
                            if (finishReason && finishReason !== 'STOP') {
                                llmErrorReason = `Gemini generation finished unexpectedly: ${finishReason}`;
                            }
                        }
                        throw new Error(llmErrorReason);
                    }
                    generatedSection = response.candidates[0].content.parts[0].text;

                } else if (LLM_PROVIDER === 'ollama') {
                    const result = await llmClient.generate({
                        model: LLM_MODEL,
                        prompt: prompt,
                        stream: false,
                    });
                    processedCount++;

                    if (!result || !result.response) {
                        throw new Error(llmErrorReason);
                    }
                    generatedSection = result.response;
                }

                finalLlmsContent += `\n\n--- Source: ${itemPathOrUrl} ---\n\n${generatedSection}`;
                safeLog?.('debug', `[${taskId}] LLM Stage: Successfully generated section from ${itemPathOrUrl} using ${LLM_PROVIDER}.`);

            } catch (llmError: any) {
                // Catch errors from either Gemini or Ollama calls
                const specificErrorMsg = `LLM Error on ${itemPathOrUrl}: ${llmError.message || llmErrorReason}`;
                safeLog?.('error', `[${taskId}] LLM Stage: ${specificErrorMsg}`);
                // Update task details with the specific LLM error
                updateTaskDetails(taskId, specificErrorMsg);
                llmErrors++;
                continue;
            }

        } catch (extractionOrOtherError: any) {
            const specificErrorMsg = `Error processing ${itemPathOrUrl}: ${extractionOrOtherError.message}`;
            safeLog?.('error', `[${taskId}] LLM Stage: ${specificErrorMsg}`);
            updateTaskDetails(taskId, specificErrorMsg);
            llmErrors++;
        }
    }

    updateTaskDetails(taskId, `LLM stage finished. Processed ${processedCount} sources with ${llmErrors} errors.`);
    if (!isTaskCancelled(taskId) && processedCount === 0 && urlsToProcess.length > 0) {
        throw new Error(`LLM Stage: Failed to process or generate content for any sources.`);
    }
    safeLog?.('info', `[${taskId}] LLM Stage: Processed ${processedCount} sources with ${llmErrors} errors.`);

    return finalLlmsContent;

    } finally {
        if (!browserLockReleased) {
            releaseBrowserLock();
            browserLockReleased = true;
            safeLog?.('debug', `[${taskId}] LLM Stage: Released browser lock.`);
        }
    }
}