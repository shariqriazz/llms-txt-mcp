import fs from 'fs/promises';
import path from 'path';
import { URL } from 'url';
import { marked } from 'marked';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';
import { ApiClient } from '../api-client.js'; // Need ApiClient for browser access
import * as PipelineState from '../../pipeline_state.js'; // Need for browser lock

type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;

/**
 * Extracts text content from a given URL or local file path.
 * Handles HTML scraping, Markdown parsing, and DOCX extraction.
 * Manages browser instance and locking for URL fetching.
 * @param sourceUrlOrPath The URL or local file path.
 * @param apiClient The ApiClient instance (for browser access).
 * @param safeLog Optional logging function.
 * @returns The extracted text content.
 * @throws If the source is invalid, inaccessible, or content extraction fails.
 */
export async function extractTextContent(
    sourceUrlOrPath: string,
    apiClient: ApiClient, // Pass apiClient instance
    safeLog?: LogFunction
): Promise<string> {
    let extractedText = '';
    let isLocalPath = false;
    let sourceIdentifier = sourceUrlOrPath;

    try {
      new URL(sourceUrlOrPath);
    } catch (_) {
      try {
        const resolvedPath = path.resolve(sourceUrlOrPath);
        await fs.access(resolvedPath);
        isLocalPath = true;
        sourceIdentifier = resolvedPath;
      } catch (accessError) {
        throw new Error(`Local path not found or inaccessible: ${sourceUrlOrPath}`);
      }
    }

    if (isLocalPath) {
      const ext = path.extname(sourceIdentifier).toLowerCase();
      const fileBuffer = await fs.readFile(sourceIdentifier);
      if (ext === '.md') {
        const html = await marked.parse(fileBuffer.toString('utf-8'));
        const $ = cheerio.load(html);
        extractedText = $('body').text();
      } else if (ext === '.docx') {
        const result = await mammoth.extractRawText({ buffer: fileBuffer });
        extractedText = result.value;
      } else {
        extractedText = fileBuffer.toString('utf-8');
      }
    } else { // It's a URL
      let browser = apiClient?.browser;
      if (!browser) {
        safeLog?.('debug', 'Initializing temporary browser for extraction...');
        await apiClient.initBrowser(); // Ensure browser is initialized
        browser = apiClient.browser;
      }

      if (!browser) {
        throw new Error("Browser instance could not be initialized.");
      }

      // Lock acquisition is now handled by the caller (e.g., llm_processor)
      // if (!PipelineState.acquireBrowserLock()) {
      //     safeLog?.('warning', `Failed to acquire browser lock for ${sourceUrlOrPath}. Retrying might be needed.`);
      //     throw new Error("Could not acquire browser lock for URL content extraction.");
      // }

      const page = await browser.newPage();
      try {
        safeLog?.('debug', `Scraping URL: ${sourceUrlOrPath}`);
        await page.goto(sourceUrlOrPath, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const pageContent = await page.content();
        const $ = cheerio.load(pageContent);
        extractedText = $('body').text();
        extractedText = extractedText.replace(/\s\s+/g, ' ').trim();
      } finally {
        await page.close();
        // Lock release is now handled by the caller
        // PipelineState.releaseBrowserLock(); // Release browser lock after scraping
        // safeLog?.('debug', `Released browser lock after scraping ${sourceUrlOrPath}`);
      }
    }

    if (!extractedText || extractedText.trim().length === 0) {
      throw new Error(`No text content extracted from ${sourceUrlOrPath}`);
    }
    return extractedText;
}