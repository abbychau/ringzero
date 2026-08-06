/**
 * Minimal SSE parser for OpenAI-compatible and Anthropic streaming.
 * Zero dependencies — works on a ReadableStream body or a raw string.
 */

export interface SSEEvent {
  event?: string;
  data: string;
}

/** Parse a full SSE text into events (also used for tests). */
export function parseSSE(input: string): SSEEvent[] {
  const out: SSEEvent[] = [];
  let event: string | undefined;
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      const data = line.slice(5).trimStart();
      if (data === '[DONE]') return out;
      out.push({ event, data });
      event = undefined;
    } else if (line === '') {
      event = undefined;
    }
  }
  return out;
}

/** Consume a fetch Response body and yield SSE events incrementally. */
export async function* consumeSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  /** Abort if no bytes arrive for this long (stalled stream). 0 = off. */
  idleTimeoutMs = 0,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  // Race each read against a fresh idle timer so a server that stops sending
  // surfaces an error instead of hanging forever.
  const read = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (idleTimeoutMs <= 0) return reader.read();
    let t: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        t = setTimeout(
          () => reject(new Error(`API stream idle — no data for ${idleTimeoutMs}ms`)),
          idleTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(t));
  };
  try {
    while (true) {
      if (signal?.aborted)
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Aborted', 'AbortError');
      const { done, value } = await read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const data = line.slice(5).trimStart();
          if (data === '[DONE]') return;
          yield { event, data };
          event = undefined;
        } else if (line === '') {
          event = undefined;
        }
      }
    }
    // Flush a final partial line (stream that ends without a trailing newline).
    if (buf) {
      const line = buf.replace(/\r$/, '');
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const data = line.slice(5).trimStart();
        if (data !== '[DONE]') yield { event, data };
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed, or cancelled by the idle-timeout path */
    }
    reader.releaseLock();
  }
}
