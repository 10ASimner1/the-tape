import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { amzDate, sha256Hex, signRequest, uriEncode } from '../src/sigv4.ts';

describe('SigV4 against AWS\'s published vector', () => {
  it('reproduces the documented "GET Object" signature exactly', () => {
    // From AWS's SigV4 examples for S3. Pinning a known-good vector means a future
    // refactor cannot quietly break signing in a way that only shows up as an
    // opaque SignatureDoesNotMatch against a live bucket.
    const { headers } = signRequest({
      method: 'GET',
      path: '/test.txt',
      query: {},
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' },
      payloadSha256: sha256Hex(''),
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    });

    const signature = /Signature=([0-9a-f]+)/.exec(headers['authorization'] ?? '')?.[1];
    assert.equal(signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('signs the headers it actually sends', () => {
    const { headers } = signRequest({
      method: 'PUT', path: '/b/k', query: {},
      headers: { host: 'example.com', 'user-agent': 'the-tape/0.1.0' },
      payloadSha256: sha256Hex('body'),
      region: 'eu-central-003', service: 's3',
      accessKeyId: 'k', secretAccessKey: 's', now: new Date('2026-08-03T01:00:00Z'),
    });
    const signed = /SignedHeaders=([^,]+)/.exec(headers['authorization'] ?? '')?.[1];
    assert.equal(signed, 'host;user-agent;x-amz-content-sha256;x-amz-date');
    // The two headers the signer adds must be present on the wire, or the server
    // recomputes a different canonical request.
    assert.ok(headers['x-amz-date']);
    assert.equal(headers['x-amz-content-sha256'], sha256Hex('body'));
  });
});

describe('uriEncode', () => {
  it('escapes what encodeURIComponent leaves behind', () => {
    // The reason this is hand-rolled: encodeURIComponent leaves !*'() alone, and
    // AWS requires them escaped. The mismatch surfaces only as a signature error.
    assert.equal(uriEncode("!*'()", false), '%21%2A%27%28%29');
  });

  it('leaves RFC 3986 unreserved characters alone', () => {
    assert.equal(uriEncode('AZaz09-._~', false), 'AZaz09-._~');
  });

  it('keeps slashes in paths but escapes them in values', () => {
    assert.equal(uriEncode('raw/feed/2026', true), 'raw/feed/2026');
    assert.equal(uriEncode('raw/feed/2026', false), 'raw%2Ffeed%2F2026');
  });

  it('DOUBLE-encodes an already percent-encoded key', () => {
    // This is the one that matters. Object keys embed percent-encoded package
    // names, so a key contains literal '%' characters which must themselves become
    // '%25' in the canonical request. Getting this wrong breaks precisely the
    // scoped packages that are 77.5% of live npm activity.
    assert.equal(
      uriEncode('private/pkg/%40ctrl%2Ftinycolor/11-abc.json.gz', true),
      'private/pkg/%2540ctrl%252Ftinycolor/11-abc.json.gz',
    );
  });

  it('encodes multi-byte UTF-8 per byte', () => {
    assert.equal(uriEncode('é', false), '%C3%A9');
  });
});

describe('amzDate', () => {
  it('formats the basic ISO-8601 forms SigV4 requires', () => {
    const { long, short } = amzDate(new Date('2026-08-03T01:23:45.678Z'));
    assert.equal(long, '20260803T012345Z');
    assert.equal(short, '20260803');
  });
});
