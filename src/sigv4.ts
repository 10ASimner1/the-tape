/**
 * AWS Signature Version 4, in about a hundred lines of `node:crypto`.
 *
 * The alternative was `@aws-sdk/client-s3`, which pulls in a few dozen transitive
 * packages. For a project whose entire subject is npm supply-chain risk, importing
 * a dependency tree to talk to an object store would be the wrong story to tell.
 * SigV4 is a well-specified hashing exercise and it does not change.
 */

import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data as never).digest('hex');

const hmac = (key: Uint8Array | string, data: string): Buffer =>
  createHmac('sha256', key as never).update(data, 'utf8').digest();

/**
 * RFC 3986 unreserved characters stay literal; everything else becomes %XX.
 *
 * `encodeURIComponent` is NOT a substitute: it leaves `!*'()` unescaped, which
 * produces a canonical request that disagrees with the server's and yields an
 * opaque SignatureDoesNotMatch.
 *
 * Encoding is byte-wise so multi-byte UTF-8 is escaped per byte, and it is applied
 * to the RAW key. Our keys already contain percent-encoded package names
 * (`%40ctrl%2Ftinycolor`), so those `%` characters are themselves escaped to `%25`
 * here — double-encoding is correct, and getting it wrong is the classic way this
 * breaks on exactly the scoped packages that are 77.5% of npm.
 */
export function uriEncode(value: string, keepSlash: boolean): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === '/' && keepSlash) out += '/';
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** `20260803T004500Z` and `20260803`. */
export function amzDate(now: Date): { long: string; short: string } {
  const long = `${now.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
  return { long, short: long.slice(0, 8) };
}

export type SigningInput = {
  readonly method: string;
  /** Raw, unencoded object path including the leading slash and bucket. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadSha256: string;
  readonly region: string;
  readonly service: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly now: Date;
};

/**
 * Returns the headers to send, including `Authorization`.
 *
 * Every value fed into the canonical request must match the bytes actually put on
 * the wire, which is why the caller is given back the encoded path to use rather
 * than being trusted to re-derive it.
 */
export function signRequest(input: SigningInput): {
  headers: Record<string, string>;
  encodedPath: string;
  canonicalQuery: string;
} {
  const { long, short } = amzDate(input.now);
  const scope = `${short}/${input.region}/${input.service}/aws4_request`;

  const encodedPath = uriEncode(input.path, true);

  // Query parameters are sorted by encoded key, and both key and value are encoded.
  const canonicalQuery = Object.keys(input.query)
    .sort()
    .map((k) => `${uriEncode(k, false)}=${uriEncode(input.query[k] ?? '', false)}`)
    .join('&');

  const headers: Record<string, string> = {
    ...input.headers,
    'x-amz-date': long,
    'x-amz-content-sha256': input.payloadSha256,
  };

  // Canonical headers: lowercased names, trimmed values, sorted, newline-terminated.
  const sortedNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v.trim();

  const canonicalHeaders = sortedNames.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    input.method,
    encodedPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join('\n');

  const stringToSign = [ALGORITHM, long, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, short), input.region), input.service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    headers: {
      ...headers,
      authorization:
        `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    encodedPath,
    canonicalQuery,
  };
}
