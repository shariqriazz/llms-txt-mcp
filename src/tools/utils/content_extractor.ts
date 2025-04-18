import fs from 'fs/promises';
import path from 'path';
import { URL } from 'url';
import { marked } from 'marked';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';
import { ApiClient } from '../api-client.js'; // Need ApiClient for browser access
// Remove PipelineState import as browser lock is handled by ApiClient.withPage
// import * as PipelineState from '../../pipeline_state.js';

type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;

/**
 * Extracts text content from a given URL or local file path.
 * Handles HTML scraping, Markdown parsing, and DOCX extraction.
 * Uses ApiClient's managed browser pages for URL fetching.
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
      safeLog?.('debug', `Extracting content from local file: ${sourceIdentifier}`);
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
        // Assume plain text for other types
        extractedText = fileBuffer.toString('utf-8');
      }
    } else { // It's a URL
      safeLog?.('debug', `Extracting content from URL using browser pool: ${sourceUrlOrPath}`);
      // Use the managed page from ApiClient
      extractedText = await apiClient.withPage(async (page) => {
        safeLog?.('debug', `Scraping URL: ${sourceUrlOrPath}`);
        await page.goto(sourceUrlOrPath, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const pageContent = await page.content();
        const $ = cheerio.load(pageContent);
        let text = $('body').text();
        // Basic cleanup
        text = text.replace(/\s\s+/g, ' ').trim();
        return text;
      });
    }

    if (!extractedText || extractedText.trim().length === 0) {
      // Log warning instead of throwing immediately? Depends on desired behavior.
      // For now, keep throwing as it indicates a failure to get usable content.
      safeLog?.('warning', `No text content extracted from ${sourceUrlOrPath}`);
      throw new Error(`No text content extracted from ${sourceUrlOrPath}`);
    }
    safeLog?.('debug', `Extracted content length from ${sourceUrlOrPath}: ${extractedText.length}`);
    return extractedText;
}