import { BaseHandler } from './base-handler.js';
import { McpToolResponse } from '../types.js'; // Assuming McpToolResponse is needed

const COLLECTION_NAME = 'documentation';

export class VectorStoreResetHandler extends BaseHandler {

  async handle(_args: any): Promise<McpToolResponse> {
    this.safeLog?.('info', `Executing vector_store_reset for collection: ${COLLECTION_NAME}`);
    let collectionDeleted = false;
    let collectionRecreated = false;
    let errors: string[] = [];

    try {
      this.safeLog?.('info', `Attempting to delete Qdrant collection: ${COLLECTION_NAME}`);
      const deleteResponse = await this.apiClient.qdrantClient.deleteCollection(COLLECTION_NAME);
      this.safeLog?.('debug', `Qdrant delete collection response: ${JSON.stringify(deleteResponse)}`);
      if (deleteResponse === true) {
          collectionDeleted = true;
          this.safeLog?.('info', `Successfully deleted Qdrant collection: ${COLLECTION_NAME}`);
      } else {
          this.safeLog?.('warning', `Qdrant collection deletion might not have confirmed success: ${JSON.stringify(deleteResponse)}`);
          collectionDeleted = true;
      }
    } catch (error: any) {
        if (error.message?.includes('Not found') || error.message?.includes('doesn\'t exist')) {
             this.safeLog?.('info', `Qdrant collection ${COLLECTION_NAME} did not exist (already clear).`);
             collectionDeleted = true;
        } else {
            this.safeLog?.('error', `Failed to delete Qdrant collection ${COLLECTION_NAME}: ${error.message}`);
            errors.push(`Failed to delete Qdrant collection: ${error.message}`);
        }
    }

    if (collectionDeleted) {
        try {
            this.safeLog?.('info', `Attempting to recreate Qdrant collection: ${COLLECTION_NAME}`);
            await this.apiClient.initCollection(COLLECTION_NAME);
            collectionRecreated = true;
            this.safeLog?.('info', `Successfully ensured Qdrant collection ${COLLECTION_NAME} exists.`);
        } catch (error: any) {
            this.safeLog?.('error', `Failed to recreate Qdrant collection ${COLLECTION_NAME}: ${error.message}`);
            errors.push(`Failed to recreate Qdrant collection: ${error.message}`);
        }
    }

    let message = `Vector store reset results for '${COLLECTION_NAME}':\n- Collection deleted: ${collectionDeleted}\n- Collection recreated: ${collectionRecreated}`;
    if (errors.length > 0) {
      message += `\n\nErrors encountered:\n- ${errors.join('\n- ')}`;
    }

    return {
      content: [{ type: 'text', text: message }],
      isError: errors.length > 0 // Mark as error if any step failed critically
    };
  }
}
// End of VectorStoreResetHandler class