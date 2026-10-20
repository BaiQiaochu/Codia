/** Public inspection projection. Never include tool parameters, outputs or arbitrary record keys. */
export type ToolActionMetadata = {
  actionId: string;
  state: 'planned' | 'running' | 'succeeded' | 'unknown';
  toolName: string;
  readOnly: boolean;
  sessionRef: string | null;
  scopeRef: string | null;
  traceId: string | null;
  toolTraceId: string | null;
  confirmationId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};
export type ToolActionInspection = ToolActionMetadata & { sessionPath: string | null };
