# Plan: Improve Pipeline Robustness and Reporting

**1. Goal:**
1.  Fix the "Bad Request" error during Qdrant upsert in the Embed stage by implementing batching.
2.  Improve the accuracy and consistency of stage reporting in `llms_full_check_progress` by fixing initial stage messages and optionally adding a dedicated `currentStage` field.

**2. Affected Components:**
*   `src/tools/handlers/get_llms_full_handler.ts`: Needs modification for batching upserts and fixing initial stage detail messages. Optionally, call `setTaskStage`.
*   `src/tasks.ts`: Optionally, modify `TaskInfo` and add `setTaskStage`.
*   `src/tools/handlers/check_progress.ts`: Optionally, modify to prioritize `currentStage`.

**3. Detailed Steps:**

*   **Step 1: Implement Batching in Embed Stage (`src/tools/handlers/get_llms_full_handler.ts`)**
    *   Locate the `_executeEmbedStage` method.
    *   Inside the `retryAsyncFunction` block, after `generateQdrantPoints` successfully returns the `points` array (around line 486).
    *   Define a `QDRANT_BATCH_SIZE` constant (e.g., `100`).
    *   Replace the single `upsert` call (around line 494) with a loop:
        ```typescript
        const QDRANT_BATCH_SIZE = 100; // Or read from env var
        for (let i = 0; i < points.length; i += QDRANT_BATCH_SIZE) {
            if (isTaskCancelled(mainTaskId)) throw new McpError(ErrorCode.InternalError, `Task ${mainTaskId} cancelled during upsert batching.`);
            const batch = points.slice(i, i + QDRANT_BATCH_SIZE);
            const batchNum = Math.floor(i / QDRANT_BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(points.length / QDRANT_BATCH_SIZE);
            updateTaskDetails(mainTaskId, `Embed Stage: Upserting batch ${batchNum}/${totalBatches} (${batch.length} points)...`);
            await apiClient.qdrantClient.upsert(QDRANT_COLLECTION_NAME, { wait: true, points: batch });
            safeLog?.('debug', `[${mainTaskId}] Upserted batch ${batchNum}/${totalBatches}`);
        }
        // Original log after loop finishes
        safeLog?.('info', `[${mainTaskId}] Successfully embedded and indexed: ${summaryFilePath}`);
        // Update details message after successful upsert loop
        updateTaskDetails(mainTaskId, `Embed Stage: Upsert complete for ${points.length} points.`);
        ```
    *   Adjust the final success message update (line 513) if needed.

*   **Step 2: Fix Initial Stage Detail Messages (`src/tools/handlers/get_llms_full_handler.ts`)**
    *   Verify and correct the *first* `updateTaskDetails` call within each `_execute...Stage` method (Discovery, Fetch, Synthesize, Embed, Cleanup) to use the exact format `" Stage: Starting..."`.
        *   Line 298: `updateTaskDetails(mainTaskId, \`Discovery Stage: Starting for ${request.topic_or_url}...\`);`
        *   Line 359: `updateTaskDetails(mainTaskId, \`Fetch Stage: Starting for ${originalInput}...\`);`
        *   Line 423: `updateTaskDetails(mainTaskId, \`Synthesize Stage: Starting for ${originalInput} (Max LLM Calls: ${max_llm_calls})...\`);`
        *   Line 461: `updateTaskDetails(mainTaskId, \`Embed Stage: Starting for ${originalInput} (Category: ${category})...\`);`
        *   Line 522: `updateTaskDetails(mainTaskId, \`Cleanup Stage: Starting for ${mainTaskId}...\`);`

*   **Step 3 (Optional - Implement `currentStage` field): Modify `TaskInfo` Interface (`src/tasks.ts`)**
    *   Add `currentStage?: string;` to the `TaskInfo` interface.
    *   Initialize `currentStage` in `registerTask`.
    *   Clear `currentStage` in `setTaskStatus` for final states.

*   **Step 4 (Optional - Implement `currentStage` field): Add `setTaskStage` Function (`src/tasks.ts`)**
    *   Create the `setTaskStage` function as described previously to update `taskInfo.currentStage` and save.

*   **Step 5 (Optional - Implement `currentStage` field): Update Stage Execution Methods (`src/tools/handlers/get_llms_full_handler.ts`)**
    *   Add calls to `setTaskStage(mainTaskId, 'StageName');` at the beginning of each `_execute...Stage` method.

*   **Step 6 (Optional - Implement `currentStage` field): Modify Progress Checker (`src/tools/handlers/check_progress.ts`)**
    *   Update the logic to prioritize `taskInfo.currentStage` before falling back to parsing `taskInfo.details`.

*   **Step 7: Testing**
    *   Run a `get_llms_full` task with a large input known to cause the upsert error to verify batching works.
    *   Run a `get_llms_full` task and use `check_progress` frequently during stage transitions to verify the "Unknown" state is resolved by the message fix (or the `currentStage` implementation if chosen).

*   **Step 8: Write Plan to File** (This step)
    *   Save this combined plan to `plan.md`.

**4. Mermaid Diagram (Illustrating Batching - Optional `currentStage` not shown):**

```mermaid
sequenceDiagram
    participant Handler as get_llms_full_handler
    participant Tasks as tasks.ts
    participant Vectorizer as vectorizer.ts
    participant Qdrant as apiClient.qdrantClient

    Handler->>Tasks: setTaskStatus(taskId, 'running')
    Handler->>Tasks: updateTaskDetails(taskId, "Embed Stage: Starting...")

    Handler->>Vectorizer: generateQdrantPoints(chunks, ...)
    Vectorizer-->>Handler: points[]

    loop For Each Batch in points[]
        Handler->>Tasks: updateTaskDetails(taskId, "Embed Stage: Upserting batch X/Y...")
        Handler->>Qdrant: upsert(collection, {points: batch})
        Qdrant-->>Handler: Success/Error
    end

    Handler->>Tasks: updateTaskDetails(taskId, "Embed Stage: Upsert complete...")
    Handler->>Tasks: setTaskStatus(taskId, 'completed')