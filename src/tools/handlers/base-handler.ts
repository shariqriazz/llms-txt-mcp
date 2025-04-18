import { ApiClient } from '../api-client.js';
import { McpToolResponse } from '../types.js';

// Define LogFunction type if not already globally available
type LogFunction = (level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency', data: any) => void;


export abstract class BaseHandler {
  protected apiClient: ApiClient;
  protected safeLog?: LogFunction;

  constructor(apiClient: ApiClient, safeLog?: LogFunction) {
    this.apiClient = apiClient;
    this.safeLog = safeLog;
  }

  protected abstract handle(args: any): Promise<McpToolResponse>;
}