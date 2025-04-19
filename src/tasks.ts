import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

// --- Persistence ---
const TASK_STORE_DIR = path.join(process.cwd(), 'data'); // Store in data directory
const TASK_STORE_FILE = path.join(TASK_STORE_DIR, 'task_store.json'); // Use .json extension

// Define the structure for storing task information
export type TaskStatusValue = 'queued' | 'running' | 'cancelled' | 'completed' | 'failed';

// Define possible stage names/states (used internally and for reporting)
export type TaskStageValue =
    | 'QUEUED' // Initial state before scheduler picks up
    | 'Discovery'
    | 'Fetch'
    | 'Synthesize'
    | 'Embed'
    | 'Cleanup'
    | undefined; // Cleared on final status


export interface TaskInfo {
  status: TaskStatusValue;
  details: string;
  startTime: number; // Store as timestamp (Date.now())
  endTime: number | null; // Store as timestamp or null
  progressCurrent?: number; // Optional: Current progress unit (e.g., 7)
  progressTotal?: number;   // Optional: Total progress units (e.g., 10)
  currentStage?: TaskStageValue; // Optional: Current stage name
  description?: string; // Optional: User-friendly description of the task input
}

// Updated in-memory store for detailed task information
let taskStore = new Map<string, TaskInfo>();

// --- Persistence Functions ---
async function saveTaskStoreToFile(): Promise<void> {
    try {
        // Ensure directory exists before writing
        await fs.mkdir(TASK_STORE_DIR, { recursive: true });
        const dataToSave = JSON.stringify(Array.from(taskStore.entries()));
        await fs.writeFile(TASK_STORE_FILE, dataToSave, 'utf-8');
    } catch (error) {
        console.error(`[ERROR] Failed to save task store: ${error}`);
    }
}

async function loadTaskStoreFromFile(): Promise<void> {
    try {
        const data = await fs.readFile(TASK_STORE_FILE, 'utf-8');
        const parsedData = JSON.parse(data);
        if (Array.isArray(parsedData)) {
            taskStore = new Map<string, TaskInfo>(parsedData);
            console.error(`[INFO] Task store loaded successfully from ${TASK_STORE_FILE}. Found ${taskStore.size} tasks.`);
        } else {
             console.error(`[WARN] Invalid data format in ${TASK_STORE_FILE}. Initializing empty task store.`);
             taskStore = new Map<string, TaskInfo>();
        }
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            console.error(`[INFO] Task store file (${TASK_STORE_FILE}) not found. Initializing empty task store.`);
            taskStore = new Map<string, TaskInfo>();
        } else {
            console.error(`[ERROR] Failed to load task store: ${error}. Initializing empty task store.`);
            taskStore = new Map<string, TaskInfo>();
        }
    }
}

// --- Task Management Functions ---

/**
 * Registers a new task, assigns a unique ID, initializes its info, and returns the ID.
 * @param prefix Prefix for the task ID.
 * @param description Optional user-friendly description for the task.
 */
export function registerTask(prefix: string = 'task', description?: string): string {
  const taskId = `${prefix}-${uuidv4()}`;
  const now = Date.now();
  const initialInfo: TaskInfo = {
    status: 'queued', // Initialize as queued
    details: 'Initializing...',
    startTime: now,
    endTime: null,
    currentStage: 'QUEUED', // Initialize stage as 'QUEUED' (consistent casing)
    description: description || prefix, // Store the description
  };
  taskStore.set(taskId, initialInfo);
  console.error(`[INFO] Registered new task: ${taskId}`);
  saveTaskStoreToFile();
  return taskId;
}

/**
 * Updates the main status of a task and sets the end time if it's a final status.
 * Also clears the currentStage for final statuses.
 */
export function setTaskStatus(taskId: string, status: TaskStatusValue): void {
  const taskInfo = taskStore.get(taskId);
  if (taskInfo) {
    taskInfo.status = status;
    const isFinalState = status === 'completed' || status === 'failed' || status === 'cancelled';
    if (isFinalState && taskInfo.endTime === null) {
      taskInfo.endTime = Date.now();
      taskInfo.currentStage = undefined; // Clear stage on final state
    } else if (!isFinalState) {
        taskInfo.endTime = null;
        // Don't clear currentStage when going back to running/queued
    }
    console.error(`[INFO] Updated task ${taskId} status to: ${status}`);
    saveTaskStoreToFile();
  } else {
    console.error(`[WARN] Attempted to set status for unknown task ID: ${taskId}`);
  }
}

/**
 * Updates only the details string for a task.
 * Also parses the details string for progress information (e.g., "X/Y") and updates progress fields.
 */
export function updateTaskDetails(taskId: string, details: string): void {
    const taskInfo = taskStore.get(taskId);
    if (taskInfo) { // Update details regardless of status, but only parse progress if running
        taskInfo.details = details;

        if (taskInfo.status === 'running') {
            const progressMatch = details.match(/(\d+)\/(\d+)/);
            if (progressMatch && progressMatch.length === 3) {
                const current = parseInt(progressMatch[1], 10);
                const total = parseInt(progressMatch[2], 10);
                if (!isNaN(current) && !isNaN(total) && total > 0) {
                    taskInfo.progressCurrent = current;
                    taskInfo.progressTotal = total;
                } else {
                    taskInfo.progressCurrent = undefined;
                    taskInfo.progressTotal = undefined;
                }
            } else {
                taskInfo.progressCurrent = undefined;
                taskInfo.progressTotal = undefined;
            }
        }
        saveTaskStoreToFile();
    } else {
        console.error(`[WARN] Attempted to update details for unknown task ID: ${taskId}`);
    }
}

/**
 * Updates only the current stage of a task.
 */
export function setTaskStage(taskId: string, stage: TaskStageValue): void {
  const taskInfo = taskStore.get(taskId);
  if (taskInfo) {
    // Only update if the stage is actually changing to avoid unnecessary saves
    // Allow setting to undefined
    if (taskInfo.currentStage !== stage) {
        taskInfo.currentStage = stage;
        console.error(`[INFO] Updated task ${taskId} stage to: ${stage ?? 'undefined'}`);
        saveTaskStoreToFile(); // Save changes
    }
  } else {
    console.error(`[WARN] Attempted to set stage for unknown task ID: ${taskId}`);
  }
}

/**
 * Retrieves the detailed information object for a task.
 */
export function getTaskStatus(taskId: string): TaskInfo | undefined {
  return taskStore.get(taskId);
}

/**
 * Checks if a task has been marked as cancelled.
 */
export function isTaskCancelled(taskId: string): boolean {
  const taskInfo = taskStore.get(taskId);
  return taskInfo?.status === 'cancelled';
}


/**
 * Retrieves all tasks, optionally filtered by a prefix.
 * @param prefix Optional prefix to filter tasks (e.g., 'guide-gen-').
 * @returns A Map where keys are task IDs and values are TaskInfo objects.
 */
export function getAllTasks(prefix?: string): Map<string, TaskInfo> {
  if (!prefix) {
    return new Map(taskStore);
  }
  const filteredTasks = new Map<string, TaskInfo>();
  for (const [taskId, taskInfo] of taskStore.entries()) {
    if (taskId.startsWith(prefix)) {
      filteredTasks.set(taskId, taskInfo);
    }
  }
  return filteredTasks;
}

/**
 * Cleans up tasks from the store.
 * If taskIds are provided, only those specific tasks are removed, regardless of status.
 * If taskIds are not provided, removes all completed, failed, or cancelled tasks.
 * @param taskIds Optional array of specific task IDs to remove.
 */
export function cleanupTaskStore(taskIds?: string[]): void {
    let cleanedCount = 0;
    let changed = false;

    if (taskIds && taskIds.length > 0) {
        // Remove specific tasks by ID
        for (const idToRemove of taskIds) {
            if (taskStore.delete(idToRemove)) {
                cleanedCount++;
                changed = true;
            }
        }
        if (cleanedCount > 0) {
            console.error(`[INFO] Removed ${cleanedCount} specified tasks from store.`);
        }
    } else {
        // Default behavior: remove finished tasks
        for (const [taskId, taskInfo] of taskStore.entries()) {
            if (taskInfo.status !== 'running' && taskInfo.status !== 'queued') {
                taskStore.delete(taskId);
                cleanedCount++;
                changed = true;
            }
        }
        if (cleanedCount > 0) {
            console.error(`[INFO] Cleaned up ${cleanedCount} finished tasks from store.`);
        }
    }

    if (changed) {
        saveTaskStoreToFile();
    }
}

// --- Initial Load ---
(async () => {
    await loadTaskStoreFromFile();
})();