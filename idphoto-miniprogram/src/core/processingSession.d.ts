export interface SessionParams {
  source: { path: string; width: number; height: number; forceCloud?: boolean } | null;
  specId: string;
  dpi: number;
  bg: any;
  customTarget?: { width: number; height: number } | null;
  kbLimit?: number;
  beauty: { enabled: boolean; smooth: number; whiten: number; brighten: number };
  suit: { enabled: boolean; templateId: string };
  consents: string[];
  cropWindow: { x: number; y: number; w: number; h: number; ratio?: number } | null;
  cropConfirmed: boolean;
}
export interface SessionError { code: string; message: string; traceId: string | null; retryable?: boolean }
export interface SessionState {
  revision: number;
  sourceId: number;
  status: 'empty' | 'crop' | 'ready' | 'processing' | 'success' | 'error' | 'cancelled';
  stage: string;
  params: SessionParams;
  selfChecked: boolean;
  output: any;
  error: SessionError | null;
  traceId: string | null;
  changed: string[];
}
export interface TaskResult<T = any> { ok: boolean; output?: T; error?: SessionError }
export interface SessionTask {
  readonly sourceId: number;
  readonly revision: number;
  readonly params: Readonly<SessionParams>;
  readonly traceId: string;
  current(): boolean;
  check(): void;
  call<T>(operation: () => T | Promise<T>): Promise<T>;
  onCancel(cancel: () => void): void;
  step(stage: string): void;
}
export interface ProcessingSession {
  getState(): SessionState;
  update(change: Partial<Omit<SessionParams, 'cropConfirmed'>>): { ok: boolean; state?: SessionState; error?: SessionError };
  confirmCrop(): { ok: boolean; state?: SessionState; error?: SessionError };
  cancel(): void;
  execute<T>(kind: string, work: (task: SessionTask) => T | Promise<T>): Promise<TaskResult<T>>;
  subscribe(listener: (state: SessionState) => void): () => void;
  confirmSelfCheck(value: boolean): boolean;
  dispose(): void;
}
export function createProcessingSession(options?: {
  timeoutMs?: number;
  tool?: string;
  logger?: (event: { code: string; traceId: string; kind?: string; stage?: string }) => void;
}): ProcessingSession;
