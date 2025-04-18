import fs from 'fs/promises';
import path from 'path';
import { URL } from 'url';
import { performTavilySearch } from '../providers/tavily.js'; // Assuming Tavily is still used

type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;

interface DiscoveryResult {
    startUrlOrPath: string;
    isLocal: boolean;
}

/**
 * Determines the starting point for guide generation.
 * Checks if the input is a URL, searches Tavily if it's a topic,
 * or verifies if it's a local file path.
 * @param topicOrUrl The user's input (topic or URL/path).
 * @param safeLog Optional logging function.
 * @returns An object containing the starting URL/path and a boolean indicating if it's local.
 * @throws If a valid starting point cannot be determined.
 */
export async function discoverStartingPoint(
    topicOrUrl: string,
    safeLog?: LogFunction
): Promise<DiscoveryResult> {
    let startUrlOrPath: string | undefined = undefined;
    let isLocal = false;

    try {
        new URL(topicOrUrl);
        startUrlOrPath = topicOrUrl;
        safeLog?.('info', `Input is a valid URL: ${startUrlOrPath}`);
    } catch (_) {
        safeLog?.('info', `Input is not a URL, searching for topic: "${topicOrUrl}"...`);
        try {
            const searchResults = await performTavilySearch({ query: `${topicOrUrl} documentation main page`, max_results: 3 });
            let bestUrl: string | undefined = undefined;
            let minLength = Infinity;
            for (const result of searchResults.results ?? []) {
                if (result.url) {
                    if (result.url.includes('/docs') && result.url.length < minLength) {
                        bestUrl = result.url;
                        minLength = result.url.length;
                    } else if (!bestUrl && result.url.length < minLength) {
                        bestUrl = result.url;
                        minLength = result.url.length;
                    }
                }
            }
            if (bestUrl) {
                startUrlOrPath = bestUrl;
                safeLog?.('info', `Discovered URL via search: ${startUrlOrPath}`);
            } else {
                safeLog?.('warning', `Could not find relevant URL via search for "${topicOrUrl}". Checking local path...`);
            }
        } catch (searchError: any) {
            safeLog?.('error', `Tavily search failed for "${topicOrUrl}": ${searchError.message}. Checking local path...`);
        }

        if (!startUrlOrPath) {
            try {
                const resolvedPath = path.resolve(topicOrUrl);
                await fs.access(resolvedPath);
                startUrlOrPath = resolvedPath;
                isLocal = true;
                safeLog?.('info', `Input is a valid local path: ${startUrlOrPath}`);
            } catch (accessError) {
                throw new Error(`Input "${topicOrUrl}" is not a valid URL, discoverable topic, or accessible local path.`);
            }
        }
    }

    if (!startUrlOrPath) {
         throw new Error(`Failed to determine a starting point for "${topicOrUrl}".`);
    }

    return { startUrlOrPath, isLocal };
}