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
import type { Store, StoreIdentity, StoreObject } from './store.ts';

export type S3Config = {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

const S3_ENV_SUFFIXES = ['ENDPOINT', 'REGION', 'BUCKET', 'KEY_ID', 'SECRET'] as const;

/** The primary store's variables. A second store (the mirror) uses the same five
 *  suffixes under a different prefix, so it inherits the partial-config safety
 *  below rather than reimplementing it. */
export const S3_ENV_PREFIX = 'TAPE_S3_';
export const S3_MIRROR_ENV_PREFIX = 'TAPE_MIRROR_S3_';

export function s3EnvVars(prefix: string = S3_ENV_PREFIX): string[] {
  return S3_ENV_SUFFIXES.map((s) => `${prefix}${s}`);
}

export const S3_ENV_VARS = s3EnvVars();

/**
 * Reports which variables are present and which are missing, rather than
 * collapsing "none configured" and "half configured" into a single null.
 *
 * That distinction is load-bearing. A partially-set config used to fall through
 * to the local filesystem store, which on a CI runner means writing the entire
 * run to a disk that is destroyed when the job ends — while exiting zero and
 * reporting success. A rotated or mistyped secret would have looked exactly like
 * a healthy tape.
 */
export function inspectS3Env(
  env: NodeJS.ProcessEnv,
  prefix: string = S3_ENV_PREFIX,
): {
  config: S3Config | null;
  present: string[];
  missing: string[];
} {
  const vars = s3EnvVars(prefix);
  const present = vars.filter((k) => (env[k] ?? '').length > 0);
  const missing = vars.filter((k) => (env[k] ?? '').length === 0);
  if (missing.length > 0) return { config: null, present, missing };
  return {
    config: {
      endpoint: (env[`${prefix}ENDPOINT`] as string).replace(/\/+$/, ''),
      region: env[`${prefix}REGION`] as string,
      bucket: env[`${prefix}BUCKET`] as string,
      accessKeyId: env[`${prefix}KEY_ID`] as string,
      secretAccessKey: env[`${prefix}SECRET`] as string,
    },
    present,
    missing: [],
  };
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

/**
 * Above this share of requests needing a retry, something is actually wrong.
 *
 * MEASURED against Backblaze B2: a steady ~0.2-0.5% of PUTs return a transient
 * 500 and succeed on the first retry. That is normal object-store behaviour and
 * the retry loop absorbs it — but logging each one as a warning would put half a
 * dozen warnings in every run, and a channel that is always noisy is a channel
 * the operator stops reading. Individual retries are info; only an unusual RATE
 * is a warning.
 */
const RETRY_RATE_WARN = 0.05;

export class S3Store implements Store {
  readonly #cfg: S3Config;
  #requests = 0;
  #retries = 0;
  #classA = 0;
  #classB = 0;
  #classC = 0;

  constructor(cfg: S3Config) {
    this.#cfg = cfg;
  }

  /** Endpoint and bucket only — never the credentials. This is read by the mirror
   *  to prove the second copy is not the first one under another name, and it
   *  ends up in logs and in mirror/state.json. */
  get identity(): StoreIdentity {
    return { endpoint: this.#cfg.endpoint, bucket: this.#cfg.bucket };
  }

  /**
   * Transient-failure stats, and the transaction classes behind them.
   *
   * The class split exists because Class B is the limit that actually binds and
   * nothing in this project measured it until it stopped the tape. Providers
   * price and cap by class, not by request:
   *   A — PUT. Free and unlimited on B2.
   *   B — GET and HEAD. 2,500/day free, and a $0-capped account HARD-STOPS.
   *   C — LIST. Its own separate 2,500/day.
   */
  get stats(): {
    requests: number; retries: number; retryRate: number;
    classA: number; classB: number; classC: number;
  } {
    return {
      requests: this.#requests,
      retries: this.#retries,
      retryRate: this.#requests === 0 ? 0 : this.#retries / this.#requests,
      classA: this.#classA,
      classB: this.#classB,
      classC: this.#classC,
    };
  }

  /** Logs once per run rather than once per hiccup. */
  logStats(): void {
    const { requests, retries, retryRate, classA, classB, classC } = this.stats;
    const fields = {
      requests, retries, retryRatePct: Number((retryRate * 100).toFixed(2)),
      classA, classB, classC,
    };
    if (retryRate > RETRY_RATE_WARN && retries > 5) {
      log.warn('object store is failing more requests than usual', fields);
    } else {
      log.info('object store', fields);
    }
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

    this.#requests++;
    // Counted per LOGICAL request, alongside #requests, so a retry does not
    // inflate the class tally — a provider bills the operation, not the attempt.
    // An empty key means a bucket listing, which is Class C; everything else with
    // a key is addressed at an object.
    if (method === 'PUT' || method === 'DELETE') this.#classA++;
    else if (method === 'GET' && key === '') this.#classC++;
    else this.#classB++;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= HTTP_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        this.#retries++;
        await sleep(Math.min(20_000, 400 * 2 ** attempt) * (0.5 + Math.random()));
      }

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
        // Expected at a low rate; the aggregate in logStats() is the real signal.
        log.info('s3 retryable', { op: method, status: res.status, attempt });
      } catch (err) {
        if (err instanceof S3Error) throw err;
        lastErr = err;
        log.info('s3 error', { op: method, attempt, kind: (err as Error).name });
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
  /**
   * HEAD then PUT, because B2's S3 layer has no conditional write — `If-None-Match: *`
   * returns 501 NotImplemented, verified against the live endpoint on 2026-08-03.
   *
   * That HEAD is a Class B transaction, and Class B is the binding free-tier
   * limit. It used to run once per retained packument, ~1,650 times a day, which
   * is what exhausted the allowance and stopped the tape. Retained packuments are
   * batched into shards now and shards are written with plain `put`, so the only
   * remaining production callers are the store-check probe and the mirror's write
   * to its target. Think about the transaction cost before adding a third.
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
