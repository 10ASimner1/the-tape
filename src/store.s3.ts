/**
 * S3-compatible object store. Works against Backblaze B2, Cloudflare R2, AWS and
 * MinIO — the provider is a config value, not an architectural commitment.
 *
 * Path-style addressing (`https://endpoint/bucket/key`) rather than virtual-hosted,
 * because it sidesteps DNS-compatibility rules on bucket names and works
 * identically everywhere.
 */

import { HTTP_MAX_RETRIES, HTTP_TIMEOUT_MS, USER_AGENT } from './config.ts';
import { log } from './log.ts';
import { sha256Hex, signRequest } from './sigv4.ts';
import type { Store, StoreObject } from './store.ts';

export type S3Config = {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

export function s3ConfigFromEnv(env: NodeJS.ProcessEnv): S3Config | null {
  const endpoint = env['TAPE_S3_ENDPOINT'];
  const region = env['TAPE_S3_REGION'];
  const bucket = env['TAPE_S3_BUCKET'];
  const accessKeyId = env['TAPE_S3_KEY_ID'];
  const secretAccessKey = env['TAPE_S3_SECRET'];
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint: endpoint.replace(/\/+$/, ''), region, bucket, accessKeyId, secretAccessKey };
}

export class S3Error extends Error {
  readonly status: number;
  constructor(status: number, op: string, key: string, body: string) {
    // S3 error bodies are XML and carry no credentials, but they can echo the key,
    // so this stays terse — workflow logs are public.
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? 'Unknown';
    super(`S3 ${op} failed: HTTP ${status} ${code} (key: ${key})`);
    this.name = 'S3Error';
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Minimal XML field extraction. S3 list responses are machine-generated and
 *  well-formed, so a parser dependency would be a poor trade here. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Guards against a falsy key silently addressing the bucket itself. */
function assertObjectKey(key: string, op: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `S3 ${op} called with an empty key. An empty key addresses the bucket, not an ` +
        `object, so this would have returned a listing instead of failing.`,
    );
  }
}

export class S3Store implements Store {
  readonly #cfg: S3Config;

  constructor(cfg: S3Config) {
    this.#cfg = cfg;
  }

  async #send(
    method: string,
    key: string,
    opts: { body?: Uint8Array; query?: Record<string, string>; accept?: number[] } = {},
  ): Promise<{ status: number; body: Uint8Array; headers: Headers }> {
    const { endpoint, region, bucket, accessKeyId, secretAccessKey } = this.#cfg;
    const host = new URL(endpoint).host;
    const path = `/${bucket}${key ? `/${key}` : ''}`;
    const query = opts.query ?? {};
    const body = opts.body ?? new Uint8Array(0);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= HTTP_MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(Math.min(20_000, 400 * 2 ** attempt) * (0.5 + Math.random()));

      // Re-signed on every attempt: a signature carries a timestamp and expires.
      const { headers, encodedPath, canonicalQuery } = signRequest({
        method,
        path,
        query,
        headers: { host, 'user-agent': USER_AGENT },
        payloadSha256: sha256Hex(body),
        region,
        service: 's3',
        accessKeyId,
        secretAccessKey,
        now: new Date(),
      });

      const url = `${endpoint}${encodedPath}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
      try {
        const init: RequestInit = {
          method,
          headers,
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        };
        // Assigned rather than spread: the global `BodyInit` type is not in scope
        // under a Node-only lib, and a bare Uint8Array is a valid fetch body.
        if (method === 'PUT') (init as { body?: unknown }).body = body;

        const res = await fetch(url, init);

        const accepted = [200, 204, ...(opts.accept ?? [])];
        if (accepted.includes(res.status)) {
          return {
            status: res.status,
            body: new Uint8Array(await res.arrayBuffer()),
            headers: res.headers,
          };
        }

        const text = await res.text();
        // 4xx other than throttling is a real error — retrying just burns budget
        // and, on a signature mismatch, would retry forever.
        if (res.status < 500 && res.status !== 429) {
          throw new S3Error(res.status, method, key, text);
        }
        lastErr = new S3Error(res.status, method, key, text);
        log.warn('s3 retryable', { op: method, status: res.status, attempt });
      } catch (err) {
        if (err instanceof S3Error) throw err;
        lastErr = err;
        log.warn('s3 error', { op: method, attempt, kind: (err as Error).name });
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async get(key: string): Promise<Uint8Array | null> {
    // An empty key addresses the BUCKET, not an object, and S3 answers that with
    // an XML listing rather than an error. A caller passing a missing key would
    // then get a plausible-looking body instead of null — which is precisely how
    // an undefined cursor field turned into an unexplained gunzip failure.
    assertObjectKey(key, 'get');
    const res = await this.#send('GET', key, { accept: [404] });
    return res.status === 404 ? null : res.body;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    assertObjectKey(key, 'put');
    await this.#send('PUT', key, { body });
  }

  /**
   * Every key this is used for is content-addressed by (name, rev), so a lost race
   * writes byte-identical content. That makes a HEAD-then-PUT sufficient and means
   * we do not depend on conditional PUT, which B2's S3 layer does not offer.
   *
   * The value here is avoiding a redundant upload, not mutual exclusion — the
   * recorder's actual concurrency control is the cursor commit, not the blob write.
   */
  async putIfAbsent(key: string, body: Uint8Array): Promise<{ written: boolean }> {
    assertObjectKey(key, 'putIfAbsent');
    const head = await this.#send('HEAD', key, { accept: [404] });
    if (head.status !== 404) return { written: false };
    await this.put(key, body);
    return { written: true };
  }

  async list(prefix: string): Promise<StoreObject[]> {
    const out: StoreObject[] = [];
    let token: string | undefined;

    do {
      const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
      if (token !== undefined) query['continuation-token'] = token;

      const res = await this.#send('GET', '', { query });
      const xml = Buffer.from(res.body).toString('utf8');

      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const entry = m[1] ?? '';
        const k = /<Key>([\s\S]*?)<\/Key>/.exec(entry)?.[1];
        const size = /<Size>(\d+)<\/Size>/.exec(entry)?.[1];
        if (k !== undefined) out.push({ key: unescapeXml(k), size: Number(size ?? 0) });
      }

      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      token = truncated
        ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1]
        : undefined;
      if (truncated && token === undefined) {
        throw new Error('S3 list reported truncation without a continuation token');
      }
    } while (token !== undefined);

    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key, 'delete');
    await this.#send('DELETE', key, { accept: [404] });
  }
}
