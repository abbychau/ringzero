/** Core shared types. Zero dependencies. */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A tool invocation produced by the model. args is raw JSON (may be partial during streaming). */
export interface ToolCall {
  id: string;
  name: string;
  args: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Provider-agnostic message. Adapters convert to their protocol shape. */
export interface ProviderMessage {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

/** Tool definition advertised to the model (inputSchema is a JSON Schema object). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Context handed to tool execution. */
export interface ToolContext {
  cwd: string;
  home: string;
  /** Optional root that fs tools are locked to (paths outside are rejected). */
  workspace?: string;
  signal: AbortSignal;
  /** Ask the user to confirm a sensitive action. */
  ask(prompt: string): Promise<boolean>;
}

/** A concrete tool implementation. */
export interface Tool {
  definition: ToolDefinition;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** Chat request sent to a provider. */
export interface ChatRequest {
  system?: string[];
  messages: ProviderMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/** Streamed events emitted by a provider chat() call. */
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'finish'; usage?: TokenUsage; finishReason?: string };

/** Unified provider interface. */
export interface Provider {
  readonly id: string;
  chat(req: ChatRequest): AsyncGenerator<ChatEvent>;
  countTokens(text: string): number;
}

/** A single persisted message in a session. */
export interface SessionMessage {
  id: string;
  role: Role;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  ts: number;
}
