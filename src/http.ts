/**
 * The only place the recorder talks to the network.
 *
 * npm's crawler policy asks for ~1 request/second and reserves the right to
 * "rate-limit or ban your IP, user-agent or both". The job finishes in about 90
 * seconds, so nothing in the timing arithmetic surfaces the fact that it pulls
 * several GB a day from a third party — which makes politeness the most likely
 * way this project gets shut off. Hence a real limiter, not an aspiration.
 */

import { HTTP_MAX_RETRIES, HTTP_TIMEOUT_MS, MAX_RESPONSE_BYTES, USER_AGENT } from './config.ts';
import { log } from './log.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Spaces request STARTS at a fixed rate and caps in-flight requests. */
export class Limiter {
  #active = 0;
  #nextSlot = 0;
  #waiters: Array<() => void> = [];
  readonly #intervalMs: number;
  readonly #concurrency: number;

  constructor(rps: number, concurrency: number) {
    this.#intervalMs = 1000 / rps;
    this.#concurrency = concurrency;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.#active >= this.#concurrency) {
      await new Promise<void>((r) => this.#waiters.push(r));
    }
    this.#active++;
    const now = Date.now();
    const start = Math.max(now, this.#nextSlot);
    this.#nextSlot = start + this.#intervalMs;
    if (start > now) await sleep(start - now);
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#waiters.shift()?.();
    }
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly permanent: boolean;
  constructor(status: number, url: string, permanent: boolean) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.permanent = permanent;
  }
}

export class ResponseTooLargeError extends Error {
  readonly bytes: number;
  constructor(url: string, bytes: number) {
    super(`response exceeded ${MAX_RESPONSE_BYTES} bytes for ${url} (read ${bytes})`);
    this.name = 'ResponseTooLargeError';
    this.bytes = bytes;
  }
}

export type FetchResult = {
  readonly status: number;
  readonly body: Uint8Array;
  readonly etag: string | null;
  readonly bytes: number;
};

/**
 * Reads the body with a hard ceiling, aborting mid-stream rather than after the
 * fact, so one pathological packument cannot eat the run's budget. (The largest
 * real one measured was 4.88 MB gzipped / 26.8 MB raw.)
 */
async function readCapped(res: Response, url: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) throw new ResponseTooLargeError(url, declared);

  if (!res.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ResponseTooLargeError(url, total);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export type FetchOptions = {
  readonly headers?: Record<string, string>;
  /** Statuses to return rather than throw. 404 is an expected, recordable outcome
   *  for ~11% of malicious packages — the takedown is what makes them interesting. */
  readonly accept?: readonly number[];
  readonly method?: string;
};

export async function request(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const accept = new Set([200, ...(opts.accept ?? [])]);
  let lastErr: unknown;

  for (let attempt = 0; attempt <= HTTP_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with jitter. npm's downloads API returns
      // `Retry-After: 0`, which is useless, so we always use our own schedule.
      const backoff = Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random());
      await sleep(backoff);
    }
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          'user-agent': USER_AGENT,
          'accept-encoding': 'gzip',
          ...opts.headers,
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        redirect: 'follow',
      });

      if (accept.has(res.status) || res.status === 304) {
        return {
          status: res.status,
          body: res.status === 304 ? new Uint8Array(0) : await readCapped(res, url),
          etag: res.headers.get('etag'),
          bytes: 0,
        };
      }

      // A 400 from the changes feed means an unsupported parameter — npm removed
      // include_docs, feed, heartbeat, timeout, style and filter in Feb 2025.
      // That is a config error, not a blip; retrying just burns the budget.
      const permanent = res.status === 400 || res.status === 401 || res.status === 403;
      await res.body?.cancel();
      const err = new HttpError(res.status, url, permanent);
      if (permanent) throw err;
      lastErr = err;
      log.warn('http retryable', { status: res.status, attempt });
    } catch (err) {
      if (err instanceof HttpError && err.permanent) throw err;
      if (err instanceof ResponseTooLargeError) throw err;
      lastErr = err;
      log.warn('http error', { attempt, kind: (err as Error).name });
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function requestJson<T>(url: string, opts?: FetchOptions): Promise<T> {
  const res = await request(url, opts);
  return JSON.parse(Buffer.from(res.body).toString('utf8')) as T;
}
