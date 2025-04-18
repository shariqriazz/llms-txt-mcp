import { URL } from 'url';
import * as cheerio from 'cheerio';
import { ApiClient } from '../api-client.js'; // For browser page access
import * as PipelineState from '../../pipeline_state.js'; // For browser lock
import { isTaskCancelled, updateTaskDetails } from '../../tasks.js'; // For cancellation check and progress updates
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// Define LogFunction type (or import if shared)
type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;

// --- Link Extraction Logic (Internal Helper) ---
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
 * Crawls a website starting from a given URL to discover relevant documentation links.
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
    updateTaskDetails(taskId, `Starting crawl from ${start_url} (Depth: ${crawl_depth}, Max URLs: ${max_urls})...`);
    const sourceUrlObj = new URL(start_url);
    const urlsFound = new Set<string>([start_url]);
    const queue: { url: string; depth: number }[] = [{ url: start_url, depth: 0 }];
    const visited = new Set<string>([start_url]);

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
    let crawledCount = 0;

    // Acquire browser lock for the duration of the crawl stage
    // Note: The caller (_crawlStage) already acquires this lock, so we don't need it here.
    // If this function were called independently, it *would* need lock management.
    // if (!PipelineState.acquireBrowserLock()) {
    //     throw new Error("Could not acquire browser lock for crawling.");
    // }

    try {
        while (queue.length > 0 && urlsFound.size < max_urls) {
            if (isTaskCancelled(taskId)) {
                updateTaskDetails(taskId, 'Cancellation requested during crawling.');
                safeLog?.('info', `[${taskId}] Cancellation requested during crawling phase.`);
                throw new McpError(ErrorCode.InternalError, `LLMS Full generation task ${taskId} cancelled by user during crawling.`); // Updated message
            }
            crawledCount++;
            if (crawledCount % 5 === 0 || queue.length === 0) {
                // Update details with X/Y format for progress parsing
                updateTaskDetails(taskId, `Crawling ${urlsFound.size}/${max_urls}`);
            }

            const current = queue.shift();
            // Filter based on depth, keywords, and extensions
            if (!current || current.depth >= crawl_depth || ignoreKeywordRegexes.some(regex => regex.test(current.url)) || ignoreExtensions.some(ext => current.url.toLowerCase().endsWith(ext))) {
                if (current) safeLog?.('debug', `[${taskId}] Skipping crawl (depth/ignore regex/extension): ${current.url}`);
                continue;
            }

            // Ensure browser is available (should be initialized by caller)
            if (!apiClient.browser) {
                 throw new Error("Browser not available for crawling page.");
            }

            const page = await apiClient.browser.newPage();
            try {
                safeLog?.('debug', `[${taskId}] Crawling: ${current.url} at depth ${current.depth}`);
                await page.goto(current.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); // Shorter timeout?
                const content = await page.content();
                const links = _extractLinksFromHtml(content, current.url, sourceUrlObj, safeLog);

                for (const link of links) {
                    if (!visited.has(link) && urlsFound.size < max_urls) {
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
                            visited.add(link);
                            urlsFound.add(link);
                            queue.push({ url: link, depth: current.depth + 1 });
                        } else {
                            safeLog?.('debug', `[${taskId}] Ignoring non-doc-like link at max depth: ${link}`);
                        }
                    }
                }
            } catch (crawlError: any) {
                safeLog?.('warning', `[${taskId}] Failed to crawl ${current.url}: ${crawlError.message}`);
            } finally {
                await page.close();
            }
        }
        return Array.from(urlsFound);
    } finally {
        // Release browser lock (handled by caller _crawlStage)
        // PipelineState.releaseBrowserLock();
    }
}