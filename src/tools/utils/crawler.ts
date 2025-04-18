import { URL } from 'url';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit'; // Import p-limit
import { ApiClient } from '../api-client.js'; // For browser page access
// Remove PipelineState import as browser lock is handled by ApiClient.withPage
// import * as PipelineState from '../../pipeline_state.js';
import { isTaskCancelled, updateTaskDetails } from '../../tasks.js'; // For cancellation check and progress updates
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// Define LogFunction type (or import if shared)
type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;

// Read Browser Pool Size, default to 5, min 1, max 50
let parsedPoolSize = parseInt(process.env.BROWSER_POOL_SIZE || '5', 10);
if (isNaN(parsedPoolSize)) parsedPoolSize = 5;
const BROWSER_POOL_SIZE = Math.min(Math.max(1, parsedPoolSize), 50);

// --- Link Extraction Logic (Internal Helper) ---
// (Remains the same)
function _extractLinksFromHtml(htmlContent: string, pageUrlStr: string, baseUrl: URL, safeLog?: LogFunction): Set<string> {
    const extractedUrls = new Set<string>();
    const $ = cheerio.load(htmlContent);

    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (href) {
        try {
          const linkUrl = new URL(href, pageUrlStr);
          // Only add same-origin links, ignore fragments and trailing hashes
          if (linkUrl.hostname === baseUrl.hostname && !linkUrl.hash && !linkUrl.href.endsWith('#')) {
            extractedUrls.add(linkUrl.href);
          }
        } catch (e) {
          safeLog?.('debug', `Ignoring invalid href: ${href} on page ${pageUrlStr}`);
        }
      }
    });
    return extractedUrls;
}


/**
 * Crawls a website starting from a given URL to discover relevant documentation links concurrently.
 * @param taskId The ID of the parent task for status updates and cancellation checks.
 * @param start_url The initial URL to begin crawling.
 * @param crawl_depth Maximum depth to crawl relative to the start URL.
 * @param max_urls Maximum number of relevant URLs to discover.
 * @param apiClient The ApiClient instance for browser access.
 * @param safeLog Optional logging function.
 * @returns A promise resolving to an array of discovered URLs.
 * @throws If crawling fails or is cancelled.
 */
export async function crawlWebsite(
    taskId: string,
    start_url: string,
    crawl_depth: number,
    max_urls: number,
    apiClient: ApiClient,
    safeLog?: LogFunction
): Promise<string[]> {
    updateTaskDetails(taskId, `Starting crawl from ${start_url} (Depth: ${crawl_depth}, Max URLs: ${max_urls}, Concurrency: ${BROWSER_POOL_SIZE})...`);
    const sourceUrlObj = new URL(start_url);
    const urlsFound = new Set<string>([start_url]); // Stores all valid URLs found
    const visited = new Set<string>([start_url]); // Stores URLs that have been processed or added to queue
    let currentQueue: { url: string; depth: number }[] = [{ url: start_url, depth: 0 }]; // URLs to process in the current level/batch
    let crawledCount = 0; // Track total pages processed for logging/updates

    // Initialize concurrency limiter
    const limit = pLimit(BROWSER_POOL_SIZE);

    // Regexes for filtering URLs (consider making these configurable)
    const docKeywordRegexes = [
        /\/docs\//i, /\/guide\//i, /\/api\//i, /\/learn\//i, /\/reference\//i, /\/tutorial\//i, /\/documentation\//i, /\/examples\//i, /\/start\//i, /\/quickstart\//i,
        /\/concepts\//i, /\/faq\//i, /\/help\//i, /\/sdk\//i, /\/spec\//i, /\/manual\//i, /\/handbook\//i, /\/getting-started\//i, /\/intro\//i, /\/introduction\//i,
        /\/overview\//i, /\/cheatsheet\//i, /\/resources\//i, /\/walkthrough\//i, /\/howto\//i, /\/how-to\//i, /\/instructions\//i, /\/guides\//i, /\/knowledge-base\//i,
        /\/kb\//i, /\/manuals\//i, /\/articles\//i, /\/cookbook\//i, /\/primers\//i, /\/best-practices\//i, /\/blueprints\//i, /\/patterns\//i, /\/integration\//i,
        /\/integrations\//i, /\/modules\//i, /\/packages\//i, /\/libraries\//i, /\/functions\//i, /\/methods\//i, /\/classes\//i, /\/interfaces\//i, /\/protocols\//i,
        /\/endpoints\//i, /\/routes\//i, /\/parameters\//i, /\/arguments\//i, /\/returns\//i, /\/responses\//i, /\/errors\//i, /\/troubleshooting\//i, /\/debug\//i,
        /\/debugging\//i, /\/solutions\//i, /\/setup\//i, /\/install\//i, /\/installation\//i, /\/configure\//i, /\/configuration\//i, /\/settings\//i, /\/options\//i,
        /\/architecture\//i, /\/structure\//i, /\/design\//i, /\/implementation\//i, /\/schema\//i, /\/schemas\//i, /\/migration\//i, /\/migrations\//i, /\/version\//i,
        /\/versions\//i, /\/changelog\//i, /\/release-notes\//i, /\/roadmap\//i, /\/glossary\//i, /\/terminology\//i, /\/definitions\//i, /\/appendix\//i, /\/addendum\//i,
        /\/supplement\//i, /\/supplementary\//i, /\/videos\//i, /\/screencasts\//i, /\/webinars\//i, /\/workshops\//i
    ];
    const ignoreKeywordRegexes = [
        /\/blog\//i, /\/marketing\//i, /\/pricing\//i, /\/about\//i, /\/contact\//i, /\/jobs\//i, /\/legal\//i, /\/news\//i, /\/press\//i, /\/community\//i,
        /\/changelog\//i, /\/support\//i, /\/login\//i, /\/signup\//i, /\/register\//i, /\/download\//i, /\/showcase\//i, /\/gallery\//i, /\/status\//i,
        /\/privacy\//i, /\/terms\//i, /\/security\//i, /\/careers\//i, /\/team\//i, /\/staff\//i, /\/leadership\//i, /\/management\//i, /\/executives\//i,
        /\/board\//i, /\/investors\//i, /\/partners\//i, /\/alliance\//i, /\/affiliate\//i, /\/affiliates\//i, /\/sponsors\//i, /\/sponsorship\//i, /\/advertise\//i,
        /\/advertising\//i, /\/ads\//i, /\/banners\//i, /\/media\//i, /\/branding\//i, /\/brand\//i, /\/logo\//i, /\/logos\//i, /\/identity\//i, /\/story\//i,
        /\/history\//i, /\/mission\//i, /\/vision\//i, /\/values\//i, /\/culture\//i, /\/diversity\//i, /\/inclusion\//i, /\/responsibility\//i, /\/sustainability\//i,
        /\/impact\//i, /\/social\//i, /\/environment\//i, /\/environmental\//i, /\/green\//i, /\/eco\//i, /\/charity\//i, /\/nonprofit\//i, /\/donations\//i,
        /\/contribute\//i, /\/events\//i, /\/webinar\//i, /\/conference\//i, /\/meetup\//i, /\/summit\//i, /\/symposium\//i, /\/convention\//i, /\/expo\//i,
        /\/exhibition\//i, /\/fair\//i, /\/award\//i, /\/awards\//i, /\/recognition\//i, /\/achievements\//i, /\/testimonials\//i, /\/reviews\//i, /\/feedback\//i,
        /\/survey\//i, /\/polls\//i, /\/newsletter\//i, /\/subscribe\//i, /\/subscription\//i, /\/plans\//i, /\/packages\//i, /\/bundles\//i, /\/offers\//i,
        /\/deals\//i, /\/discount\//i, /\/promo\//i, /\/promotion\//i, /\/special\//i, /\/sale\//i, /\/trial\//i, /\/free-trial\//i, /\/demo\//i, /\/shopping\//i,
        /\/shop\//i, /\/store\//i, /\/cart\//i, /\/checkout\//i, /\/payment\//i, /\/billing\//i, /\/invoice\//i, /\/receipts\//i, /\/order\//i, /\/purchase\//i
    ];
    const ignoreExtensions = ['.zip', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.css', '.js', '.xml', '.ico', '.webmanifest', '.json', '.txt', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.mov', '.avi', '.wmv', '.flv', '.mkv', '.webm', '.ogg', '.wav', '.aac', '.m4a', '.flac', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.tsv', '.odt', '.ods', '.odp', '.pages', '.numbers', '.key', '.rtf', '.md', '.markdown', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.config', '.conf', '.properties', '.env', '.bak', '.backup', '.tmp', '.temp', '.cache', '.log', '.logs', '.lock', '.swp', '.swo', '.swn', '.gitignore', '.gitattributes', '.gitmodules', '.npmignore', '.npmrc', '.nvmrc', '.eslintrc', '.eslintignore', '.prettierrc', '.prettierignore', '.babelrc', '.editorconfig', '.travis.yml', '.github', '.gitlab', '.vscode', '.idea', '.DS_Store', '.htaccess', '.htpasswd', '.well-known', '.map', '.min', '.min.js', '.min.css', '.bundle.js', '.bundle.css', '.chunk.js', '.chunk.css', '.module.js', '.module.css', '.test.js', '.spec.js', '.fixture.js'];
    const languagePathRegex = /\/(?!en|en-[a-z]{2})[a-z]{2}(?:-[a-z]{2})?\//i;

    while (currentQueue.length > 0 && urlsFound.size < max_urls) {
        if (isTaskCancelled(taskId)) {
            updateTaskDetails(taskId, 'Cancellation requested during crawling.');
            safeLog?.('info', `[${taskId}] Cancellation requested during crawling phase.`);
            throw new McpError(ErrorCode.InternalError, `LLMS Full generation task ${taskId} cancelled by user during crawling.`);
        }

        const processingPromises: Promise<void>[] = [];
        const nextQueue: { url: string; depth: number }[] = []; // Collect URLs for the next level

        // Update progress before starting the batch
        updateTaskDetails(taskId, `Crawling level (Depth ${currentQueue[0]?.depth || 0}): Processing ${currentQueue.length} URLs, Found ${urlsFound.size}/${max_urls}...`);

        for (const current of currentQueue) {
            // Check limits and filters *before* scheduling the task
            if (urlsFound.size >= max_urls) break;

            if (current.depth >= crawl_depth || ignoreKeywordRegexes.some(regex => regex.test(current.url)) || ignoreExtensions.some(ext => current.url.toLowerCase().endsWith(ext))) {
                safeLog?.('debug', `[${taskId}] Skipping pre-crawl (depth/ignore regex/extension): ${current.url}`);
                continue;
            }

            processingPromises.push(limit(async () => {
                if (isTaskCancelled(taskId) || urlsFound.size >= max_urls) return; // Check again inside limiter

                crawledCount++;
                try {
                    const links = await apiClient.withPage(async (page) => {
                        safeLog?.('debug', `[${taskId}] Crawling: ${current.url} at depth ${current.depth}`);
                        await page.goto(current.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                        const content = await page.content();
                        return _extractLinksFromHtml(content, current.url, sourceUrlObj, safeLog);
                    });

                    // Process extracted links (needs synchronization for shared sets)
                    for (const link of links) {
                        // Lock or careful management needed if Set operations aren't atomic enough under high concurrency
                        // For simplicity here, assuming basic Set operations are okay for now.
                        if (urlsFound.size >= max_urls) break; // Check limit again

                        if (!visited.has(link)) {
                            const lowerLink = link.toLowerCase();
                            // Filter out ignored keywords, extensions, and non-English paths
                            if (
                                ignoreKeywordRegexes.some(regex => regex.test(link)) ||
                                ignoreExtensions.some(ext => lowerLink.endsWith(ext)) ||
                                languagePathRegex.test(lowerLink)
                            ) {
                                safeLog?.('debug', `[${taskId}] Ignoring filtered link (keyword/extension/language): ${link}`);
                                continue;
                            }
                            // Add if it looks like a doc link OR if we haven't reached max depth
                            if (docKeywordRegexes.some(regex => regex.test(link)) || current.depth < crawl_depth) {
                                visited.add(link); // Mark as visited *before* adding to queue/found
                                urlsFound.add(link);
                                // Add to the *next* level's queue
                                nextQueue.push({ url: link, depth: current.depth + 1 });
                            } else {
                                safeLog?.('debug', `[${taskId}] Ignoring non-doc-like link at max depth: ${link}`);
                            }
                        }
                    }
                } catch (crawlError: any) {
                    safeLog?.('warning', `[${taskId}] Failed to crawl ${current.url}: ${crawlError.message}`);
                } finally {
                    // Update progress roughly after each task finishes
                    if (crawledCount % 10 === 0) { // Update less frequently
                         updateTaskDetails(taskId, `Crawling: Processed ~${crawledCount} pages, Found ${urlsFound.size}/${max_urls}...`);
                    }
                }
            }));
        }

        // Wait for all concurrent tasks for the current level to complete
        await Promise.all(processingPromises);

        // Prepare for the next level
        currentQueue = nextQueue;
    }

    updateTaskDetails(taskId, `Crawling finished. Found ${urlsFound.size} URLs.`);
    return Array.from(urlsFound);
}