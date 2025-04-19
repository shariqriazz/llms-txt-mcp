import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { Ollama } from 'ollama'; // Import Ollama
import OpenAI from 'openai'; // Import OpenAI for OpenRouter
import fs from 'fs/promises'; // Import fs for reading files
import path from 'path'; // Import path for joining paths
import pLimit from 'p-limit'; // Import p-limit
import { isTaskCancelled, updateTaskDetails } from '../../tasks.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;

// Configuration from Environment Variables (Read inside function now)
// const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
// const CHUTES_API_KEY = process.env.CHUTES_API_KEY;
// const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
// const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
// const CHUTES_BASE_URL = process.env.CHUTES_BASE_URL || "https://llm.chutes.ai/v1";
// const PIPELINE_LLM_PROVIDER = process.env.PIPELINE_LLM_PROVIDER?.toLowerCase() || 'gemini';
// const PIPELINE_LLM_MODEL = process.env.PIPELINE_LLM_MODEL ||
//     (PIPELINE_LLM_PROVIDER === 'ollama' ? 'llama3.1:8b' :
//     (PIPELINE_LLM_PROVIDER === 'openrouter' ? 'google/gemini-2.5-pro-exp-03-25:free' :
//     (PIPELINE_LLM_PROVIDER === 'chutes' ? 'chutesai/Llama-4-Maverick-17B-128E-Instruct-FP8' :
//     'gemini-2.0-flash')));

// Concurrency Settings (Read inside function now)
// const LLM_CONCURRENCY = Math.max(1, parseInt(process.env.LLM_CONCURRENCY || '3', 10) || 3); // Default 3, min 1

// Interface for LLM processing results
interface LlmResult {
    filename: string;
    summarySection?: string;
    error?: string;
}


/**
 * Reads content files from a directory and uses an LLM concurrently to generate summaries.
 * @param taskId The ID of the parent task.
 * @param fetchOutputDirPath Path to the directory containing fetched .md files.
 * @param topic The original topic/URL for context in the final guide header.
 * @param max_llm_calls Maximum number of content files to process with the LLM.
 * @param safeLog Optional logging function.
 * @returns A promise resolving to the aggregated Markdown content string.
 * @throws If the LLM API key is missing or a critical error occurs.
 */
export async function summarizeContentFiles(
    taskId: string,
    fetchOutputDirPath: string,
    topic: string,
    max_llm_calls: number,
    safeLog?: LogFunction
): Promise<string> {

    // --- Read LLM Config and Initialize Client ---
    const pipelineLlmProvider = process.env.PIPELINE_LLM_PROVIDER?.toLowerCase() || 'gemini';
    const geminiApiKey = process.env.GEMINI_API_KEY;
    const openrouterApiKey = process.env.OPENROUTER_API_KEY;
    const chutesApiKey = process.env.CHUTES_API_KEY;
    const ollamaBaseUrl = process.env.OLLAMA_BASE_URL;
    const openrouterBaseUrl = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
    const chutesBaseUrl = process.env.CHUTES_BASE_URL || "https://llm.chutes.ai/v1";
    const pipelineLlmModel = process.env.PIPELINE_LLM_MODEL ||
        (pipelineLlmProvider === 'ollama' ? 'llama3.1:8b' :
        (pipelineLlmProvider === 'openrouter' ? 'google/gemini-2.5-pro-exp-03-25:free' :
        (pipelineLlmProvider === 'chutes' ? 'chutesai/Llama-4-Maverick-17B-128E-Instruct-FP8' :
        'gemini-2.0-flash')));

    safeLog?.('debug', `[${taskId}] Synthesize Stage Config: Provider=${pipelineLlmProvider}, Model=${pipelineLlmModel}`);

    let llmClient: any;
    if (pipelineLlmProvider === 'gemini') {
        if (!geminiApiKey) throw new McpError(ErrorCode.InvalidRequest, 'PIPELINE_LLM_PROVIDER is "gemini" but GEMINI_API_KEY not set.');
        const genAI = new GoogleGenerativeAI(geminiApiKey);
        const safetySettings = [ { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE }, { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE }, { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE }, { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }, ];
        llmClient = genAI.getGenerativeModel({ model: pipelineLlmModel, safetySettings });
    } else if (pipelineLlmProvider === 'ollama') {
        const ollamaConfig: { host?: string } = {}; if (ollamaBaseUrl) ollamaConfig.host = ollamaBaseUrl; llmClient = new Ollama(ollamaConfig); safeLog?.('info', `[${taskId}] Using Ollama provider with model ${pipelineLlmModel} at ${ollamaBaseUrl || 'default'}`);
    } else if (pipelineLlmProvider === 'openrouter') {
        if (!openrouterApiKey) throw new McpError(ErrorCode.InvalidRequest, 'PIPELINE_LLM_PROVIDER is "openrouter" but OPENROUTER_API_KEY not set.'); llmClient = new OpenAI({ apiKey: openrouterApiKey, baseURL: openrouterBaseUrl }); safeLog?.('info', `[${taskId}] Using OpenRouter provider with model ${pipelineLlmModel} at ${openrouterBaseUrl}`);
    } else if (pipelineLlmProvider === 'chutes') {
        if (!chutesApiKey) throw new McpError(ErrorCode.InvalidRequest, 'PIPELINE_LLM_PROVIDER is "chutes" but CHUTES_API_KEY not set.'); llmClient = new OpenAI({ apiKey: chutesApiKey, baseURL: chutesBaseUrl }); safeLog?.('info', `[${taskId}] Using Chutes provider with model ${pipelineLlmModel} at ${chutesBaseUrl}`);
    } else { throw new McpError(ErrorCode.InvalidRequest, `Unsupported PIPELINE_LLM_PROVIDER: ${pipelineLlmProvider}. Must be 'gemini', 'ollama', 'openrouter', or 'chutes'.`); }


    let llmErrors = 0;
    let processedCount = 0; // Counts successful LLM calls
    let firstErrorMessage: string | null = null;
    let completedSummaries: LlmResult[] = []; // Store results from concurrent calls

    // --- Read content files ---
    let contentFiles: string[];
    try {
        contentFiles = (await fs.readdir(fetchOutputDirPath)).filter(f => f.endsWith('.md'));
        safeLog?.('info', `[${taskId}] Synthesize Stage: Found ${contentFiles.length} content files in ${fetchOutputDirPath}.`);
    } catch (readDirError: any) {
        throw new Error(`Synthesize Stage: Failed to read fetch output directory ${fetchOutputDirPath}: ${readDirError.message}`);
    }

    // Apply max_llm_calls limit
    const filesToProcess = contentFiles.slice(0, max_llm_calls);
    if (contentFiles.length > max_llm_calls) {
         safeLog?.('warning', `[${taskId}] Synthesize Stage: Number of content files (${contentFiles.length}) exceeds max_llm_calls (${max_llm_calls}). Processing first ${max_llm_calls}.`);
    }

    // Read LLM_CONCURRENCY here
    const llmConcurrency = Math.max(1, parseInt(process.env.LLM_CONCURRENCY || '3', 10) || 3);
    safeLog?.('debug', `[${taskId}] Synthesize Stage Concurrency: ${llmConcurrency}`);
    updateTaskDetails(taskId, `Synthesize Stage: Summarizing ${filesToProcess.length} content files (LLM Concurrency: ${llmConcurrency})...`);

    // --- Concurrent LLM Processing ---
    const llmLimiter = pLimit(llmConcurrency);
    let processedInBatch = 0; // Track progress within concurrent calls

    const llmPromises = filesToProcess.map((filename, index) =>
        llmLimiter(async (): Promise<LlmResult> => {
            const filePath = path.join(fetchOutputDirPath, filename);

            if (isTaskCancelled(taskId)) {
                return { filename, error: 'Task cancelled during LLM processing.' };
            }

            try {
                // Read the content file
                const sourceContent = await fs.readFile(filePath, 'utf-8');
                if (!sourceContent || sourceContent.trim().length === 0) {
                    safeLog?.('warning', `[${taskId}] Synthesize Stage: Skipping empty content file: ${filename}`);
                    return { filename, error: 'Empty content file.' };
                }

                // --- LLM Call Logic ---
                const prompt = `Generate a Markdown section summarizing the key information from the following documentation content, suitable for inclusion in a larger guide. Follow these guidelines:\n  - Use clear and concise language. Avoid jargon where possible or explain it.\n  - Implement a clear hierarchy of headings and subheadings (use ## or ### appropriately for sections within this source).\n  - Prioritize API references, usage examples, and common errors/FAQs if present.\n  - Exclude redundant explanations, marketing fluff, navigation elements, and complex formatting not suitable for Markdown.\n  - Ensure information conveyed through images in the original content is described in text.\n  - Format code snippets clearly using Markdown code blocks.\n  - Format troubleshooting/FAQs as Q&A if applicable.\n\n  Documentation Content from ${filename}:\n  ---\n  ${sourceContent.substring(0, 100000)}\n  ---\n  `;

                safeLog?.('debug', `[${taskId}] Synthesize Stage: Sending content from ${filename} to ${pipelineLlmProvider}...`);

                let generatedSection = '';
                let llmErrorReason = `LLM (${pipelineLlmProvider}) did not return valid content.`;

                // --- LLM API Call (remains the same logic per call) ---
                if (pipelineLlmProvider === 'gemini') {
                    const llmResult = await llmClient.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
                    const response = llmResult.response;
                    if (!response || !response.candidates || response.candidates.length === 0 || !response.candidates[0].content?.parts?.[0]?.text) {
                        if (response?.promptFeedback?.blockReason) llmErrorReason = `Gemini request blocked: ${response.promptFeedback.blockReason}`;
                        else { const fr = response?.candidates?.[0]?.finishReason; if (fr && fr !== 'STOP') llmErrorReason = `Gemini generation finished unexpectedly: ${fr}`; }
                        throw new Error(llmErrorReason);
                    }
                    generatedSection = response.candidates[0].content.parts[0].text;
                } else if (pipelineLlmProvider === 'ollama') {
                    const llmResult = await llmClient.generate({ model: pipelineLlmModel, prompt: prompt, stream: false });
                    if (!llmResult || !llmResult.response) throw new Error(llmErrorReason);
                    generatedSection = llmResult.response;
                } else if (pipelineLlmProvider === 'openrouter' || pipelineLlmProvider === 'chutes') {
                    const llmResult = await llmClient.chat.completions.create({ model: pipelineLlmModel, messages: [{ role: "user", content: prompt }] });
                    if (!llmResult || !llmResult.choices || llmResult.choices.length === 0 || !llmResult.choices[0].message?.content) {
                        const fr = llmResult?.choices?.[0]?.finish_reason; if (fr && fr !== 'stop') llmErrorReason = `${pipelineLlmProvider} generation finished unexpectedly: ${fr}`;
                        throw new Error(llmErrorReason);
                    }
                    generatedSection = llmResult.choices[0].message.content;
                }
                // --- End LLM API Call ---

                processedInBatch++;
                // Update progress more frequently during concurrent calls
                if (processedInBatch % 5 === 0 || processedInBatch === filesToProcess.length) {
                    updateTaskDetails(taskId, `Synthesize Stage: Summarized ${processedInBatch}/${filesToProcess.length} files...`);
                }
                safeLog?.('debug', `[${taskId}] Synthesize Stage: Successfully generated section from ${filename} using ${pipelineLlmProvider}.`);
                return { filename, summarySection: generatedSection };

            } catch (llmError: any) {
                let specificErrorMsg = `LLM Error on ${filename}: ${llmError.message || 'Unknown LLM error'}`;
                if (['openrouter', 'chutes'].includes(pipelineLlmProvider) && llmError instanceof Error) {
                    try { specificErrorMsg += ` | Raw Error: ${JSON.stringify(llmError, Object.getOwnPropertyNames(llmError))}`; } catch (e) { /* ignore */ }
                }
                safeLog?.('error', `[${taskId}] Synthesize Stage: ${specificErrorMsg}`);
                // Don't update main task details here to avoid flooding, just return error
                if (!firstErrorMessage) firstErrorMessage = specificErrorMsg;
                return { filename, error: specificErrorMsg };
            }
        })
    );

    // Wait for all concurrent LLM calls to finish
    completedSummaries = await Promise.all(llmPromises);

    // --- Aggregate results ---
    // Use the locally read variables for the header
    const finalLlmProvider = process.env.PIPELINE_LLM_PROVIDER?.toLowerCase() || 'gemini';
    const finalLlmModel = process.env.PIPELINE_LLM_MODEL ||
        (finalLlmProvider === 'ollama' ? 'llama3.1:8b' :
        (finalLlmProvider === 'openrouter' ? 'google/gemini-2.5-pro-exp-03-25:free' :
        (finalLlmProvider === 'chutes' ? 'chutesai/Llama-4-Maverick-17B-128E-Instruct-FP8' :
        'gemini-2.0-flash')));
    let finalLlmsContent = `# LLMS Full Content for ${topic} (Provider: ${finalLlmProvider}, Model: ${finalLlmModel})\n\n`;
    for (const result of completedSummaries) {
        if (result.summarySection) {
            finalLlmsContent += `\n\n--- Source File: ${result.filename} ---\n\n${result.summarySection}`;
            processedCount++;
        } else if (result.error && !result.error.includes('Task cancelled')) {
            llmErrors++;
            // Keep track of the first error if not already set
             if (!firstErrorMessage) firstErrorMessage = result.error;
        }
    }


    updateTaskDetails(taskId, `Synthesize stage finished. Summarized ${processedCount} files with ${llmErrors} LLM errors.`);
    if (!isTaskCancelled(taskId) && processedCount === 0 && filesToProcess.length > 0) {
        const finalErrorMsg = firstErrorMessage || `Synthesize Stage: Failed to process or generate content for any files.`;
        throw new Error(finalErrorMsg);
    }
    safeLog?.('info', `[${taskId}] Synthesize Stage: Summarized ${processedCount} files with ${llmErrors} LLM errors.`);

    return finalLlmsContent;
}