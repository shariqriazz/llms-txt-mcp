import { EventEmitter } from 'events';
import { QueuedPipelineTask } from './tools/types.js';

// --- Event Emitter ---
export const pipelineEmitter = new EventEmitter();

// --- Pipeline Stage Status ---
// --- Tool-Specific Locks ---
let isCrawlToolBusy: boolean = false;    // Lock for the 'crawl' tool
let isSynthesizeLlmsFullToolBusy: boolean = false; // Renamed lock for the 'synthesize-llms-full' tool
let isEmbedToolBusy: boolean = false;    // Lock for the 'embed' tool

// --- Resource Locks ---
let isBrowserBusy: boolean = false;      // Shared browser resource lock

// --- Legacy Locks (Potentially remove later) ---
let isLLMBusy: boolean = false;          // Legacy LLM stage lock?
let isEmbeddingBusy: boolean = false;    // Legacy Embedding stage lock?

// --- Queues for Waiting Tasks ---
// --- Tool-Specific Queues ---
const crawlToolQueue: QueuedPipelineTask[] = [];   // Queue for the 'crawl' tool
const synthesizeLlmsFullToolQueue: QueuedPipelineTask[] = []; // Renamed queue for the 'synthesize-llms-full' tool
const embedToolQueue: QueuedPipelineTask[] = [];   // Queue for the 'embed' tool

// --- Legacy Queues (Potentially remove later) ---
const llmQueue: QueuedPipelineTask[] = [];         // Legacy LLM queue?
// Embedding queue was previously managed differently, now using embedToolQueue

// --- Lock Management Functions ---

// --- Tool Lock Management ---

// Crawl Tool Lock
export function isCrawlToolFree(): boolean { return !isCrawlToolBusy; }
export function acquireCrawlToolLock(): boolean {
    if (!isCrawlToolBusy) { isCrawlToolBusy = true; return true; } return false;
}
export function releaseCrawlToolLock(): void {
    isCrawlToolBusy = false;
    triggerNextPipelineSteps(); // Check queues after releasing lock
}

// SynthesizeLlmsFull Tool Lock (Renamed from Process)
export function isSynthesizeLlmsFullToolFree(): boolean { return !isSynthesizeLlmsFullToolBusy; }
export function acquireSynthesizeLlmsFullToolLock(): boolean {
    if (!isSynthesizeLlmsFullToolBusy) { isSynthesizeLlmsFullToolBusy = true; return true; } return false;
}
export function releaseSynthesizeLlmsFullToolLock(): void {
    isSynthesizeLlmsFullToolBusy = false;
    triggerNextPipelineSteps(); // Check queues after releasing lock
}

// Embed Tool Lock (New)
export function isEmbedToolFree(): boolean { return !isEmbedToolBusy; }
export function acquireEmbedToolLock(): boolean {
    if (!isEmbedToolBusy) { isEmbedToolBusy = true; return true; } return false;
}
export function releaseEmbedToolLock(): void {
    isEmbedToolBusy = false;
    triggerNextPipelineSteps(); // Check queues after releasing lock
}


// --- Legacy Lock Management (Potentially remove later) ---

// LLM Lock
export function isLLMStageFree(): boolean { return !isLLMBusy; }
export function acquireLLMLock(): boolean {
    // Fail only if LLM stage itself is busy
    if (!isLLMBusy) { isLLMBusy = true; return true; } return false;
}
export function releaseLLMLock(): void {
    isLLMBusy = false;
    triggerNextPipelineSteps(); // Trigger check when lock is released
}

// Embedding Lock (Legacy Stage)
export function isEmbeddingStageFree(): boolean { return !isEmbeddingBusy; } // Keep for potential legacy use
export function acquireEmbeddingLock(): boolean { // Keep for potential legacy use
    if (!isEmbeddingBusy) { isEmbeddingBusy = true; return true; } return false;
}
export function releaseEmbeddingLock(): void { // Keep for potential legacy use
    isEmbeddingBusy = false;
    triggerNextPipelineSteps();
}


// --- Resource Lock Management ---

// Browser Lock
export function isBrowserFree(): boolean { return !isBrowserBusy; }
export function acquireBrowserLock(): boolean {
    if (!isBrowserBusy) { isBrowserBusy = true; return true; } return false;
}
export function releaseBrowserLock(): void {
    isBrowserBusy = false;
    // Releasing browser doesn't directly trigger pipeline stages,
    // but stages waiting for it might now succeed on their next check.
    triggerNextPipelineSteps(); // Trigger a general check
}


// --- Tool Queue Management ---

// Crawl Tool Queue
export function enqueueForCrawl(task: QueuedPipelineTask): number {
    crawlToolQueue.push(task);
    return crawlToolQueue.length;
}
export function dequeueForCrawl(): QueuedPipelineTask | undefined {
    return crawlToolQueue.shift();
}
export function getCrawlQueueLength(): number {
    return crawlToolQueue.length;
}
export function removeFromCrawlQueue(taskId: string): boolean {
    const index = crawlToolQueue.findIndex(task => task.taskId === taskId);
    if (index > -1) { crawlToolQueue.splice(index, 1); return true; } return false;
}

// SynthesizeLlmsFull Tool Queue (Renamed from Process)
export function enqueueForSynthesizeLlmsFull(task: QueuedPipelineTask): number {
    synthesizeLlmsFullToolQueue.push(task);
    return synthesizeLlmsFullToolQueue.length;
}
export function dequeueForSynthesizeLlmsFull(): QueuedPipelineTask | undefined {
    return synthesizeLlmsFullToolQueue.shift();
}
export function getSynthesizeLlmsFullQueueLength(): number {
    return synthesizeLlmsFullToolQueue.length;
}
export function removeFromSynthesizeLlmsFullQueue(taskId: string): boolean {
    const index = synthesizeLlmsFullToolQueue.findIndex(task => task.taskId === taskId);
    if (index > -1) { synthesizeLlmsFullToolQueue.splice(index, 1); return true; } return false;
}

// Embed Tool Queue (New)
export function enqueueForEmbed(task: QueuedPipelineTask): number {
    embedToolQueue.push(task);
    return embedToolQueue.length;
}
export function dequeueForEmbed(): QueuedPipelineTask | undefined {
    return embedToolQueue.shift();
}
export function getEmbedQueueLength(): number {
    return embedToolQueue.length;
}
export function removeFromEmbedQueue(taskId: string): boolean {
    const index = embedToolQueue.findIndex(task => task.taskId === taskId);
    if (index > -1) { embedToolQueue.splice(index, 1); return true; } return false;
}


// --- Legacy Queue Management (Potentially remove later) ---


export function enqueueForLLM(task: QueuedPipelineTask): number {
    llmQueue.push(task);
    return llmQueue.length;
}
export function dequeueForLLM(): QueuedPipelineTask | undefined {
    return llmQueue.shift();
}
export function getLLMQueueLength(): number {
    return llmQueue.length;
}
// Function to remove a task from the LLM queue by ID (for cancellation)
export function removeFromLLMQueue(taskId: string): boolean {
    const index = llmQueue.findIndex(task => task.taskId === taskId);
    if (index > -1) { llmQueue.splice(index, 1); return true; } return false;
}

// --- Central Trigger Function ---
// This function should be called periodically or when locks are released.
// It signals the *need* to check queues, but doesn't perform the checks itself here.
// The actual checks (_checkCrawlQueue, _checkLLMQueue, embedding check)
// should be initiated from the main server loop or orchestrator.
let triggerTimeout: NodeJS.Timeout | null = null;
export function triggerNextPipelineSteps(): void {
    // Debounce the trigger to avoid rapid checks
    if (triggerTimeout) return;
    triggerTimeout = setTimeout(() => {
        pipelineEmitter.emit('checkQueues'); // Emit event instead of just logging
        triggerTimeout = null;
    }, 100); // Wait 100ms before emitting
}
