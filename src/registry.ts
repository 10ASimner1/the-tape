/**
 * Packument fetching.
 *
 * Always the FULL packument, never the abbreviated form. The abbreviated one is
 * ~2.5-3.6x smaller and structurally email-free, which is tempting — but it has
 * no `time` map, and the `time` map is the entire state model. Without it there
 * is no version-publish recovery and no per-version-unpublish detection, which
 * is to say no project. The measured saving on the wire is only ~20% anyway,
 * because the heavy tail is version metadata that survives abbreviation.
 */

import { REGISTRY_URL } from './config.ts';
import { HttpError, type Limiter, request, ResponseTooLargeError } from './http.ts';
import type { PackumentDoc } from './packument.ts';
import { encodeName } from './store.ts';

export type FetchOutcome =
  | 'ok'
  /** HTTP 200 with no `versions` map — a fully unpublished package. */
  | 'tombstone'
  /** HTTP 404. An expected, recordable outcome: ~11% of recent malicious packages
   *  already 404, and the takedown is exactly what makes them interesting. The
   *  body is byte-identical for "never existed" and "hard-purged", so a 404 alone
   *  never proves which — only our own prior record can. */
  | 'gone'
  | 'too_large'
  | 'error';

export type PackumentResult = {
  readonly outcome: FetchOutcome;
  readonly status: number;
  readonly doc: PackumentDoc | null;
  readonly raw: Uint8Array | null;
  readonly etag: string | null;
  readonly bytes: number;
  readonly error: string | null;
};

export function packumentUrl(name: string): string {
  // A scoped name must be encoded whole: registry.npmjs.org accepts %2F for the
  // separator, and 77.5% of live activity is scoped.
  return `${REGISTRY_URL}/${encodeName(name)}`;
}

export async function fetchPackument(
  name: string,
  limiter: Limiter,
  etag?: string | null,
): Promise<PackumentResult> {
  const url = packumentUrl(name);
  const headers: Record<string, string> = {};
  // If-None-Match works and returns 304. If-Modified-Since is IGNORED by the
  // registry — sending it just wastes the round trip.
  if (etag) headers['if-none-match'] = etag;

  try {
    const res = await limiter.run(() => request(url, { accept: [404], headers }));

    if (res.status === 404) {
      return { outcome: 'gone', status: 404, doc: null, raw: null, etag: null,
               bytes: 0, error: null };
    }
    if (res.status === 304) {
      return { outcome: 'ok', status: 304, doc: null, raw: null, etag: etag ?? null,
               bytes: 0, error: null };
    }

    const doc = JSON.parse(Buffer.from(res.body).toString('utf8')) as PackumentDoc;
    const outcome: FetchOutcome = 'versions' in doc ? 'ok' : 'tombstone';
    return { outcome, status: res.status, doc, raw: res.body, etag: res.etag,
             bytes: res.body.length, error: null };
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      return { outcome: 'too_large', status: 0, doc: null, raw: null, etag: null,
               bytes: err.bytes, error: 'response_too_large' };
    }
    const status = err instanceof HttpError ? err.status : 0;
    return { outcome: 'error', status, doc: null, raw: null, etag: null, bytes: 0,
             error: (err as Error).name };
  }
}
