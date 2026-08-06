/** Fetch with retry/backoff for transient failures (429, 5xx, network errors). */

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 500;
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Don't retry explicit aborts or timeouts: retrying a hung request just
      // delays the error the user needs to see.
      const isAbort =
        err instanceof DOMException &&
        (err.name === 'AbortError' || err.name === 'TimeoutError');
      if (attempt >= retries || isAbort) throw err;
      attempt++;
      await sleep(base * 2 ** (attempt - 1), opts.signal);
      continue;
    }
    const retryable =
      res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) return res;
    const retryAfter = Number(res.headers.get('retry-after') ?? 0);
    const delay = retryAfter > 0 ? retryAfter * 1000 : base * 2 ** attempt;
    res.body?.cancel();
    attempt++;
    await sleep(delay, opts.signal);
  }
}
