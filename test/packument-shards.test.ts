import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';

import * as cursorMod from '../src/cursor.ts';
import type { DrainResult, FeedRow } from '../src/feed.ts';
import { decodeJsonl, noGuard, sha256Hex, ShardWriter } from '../src/jsonl.ts';
import { canonicalManifestBytes, type RunManifest } from '../src/manifest.ts';
import type { Gap, Observation, Row } from '../src/observation.ts';
import {
  assertNoPersonalAddresses, assertNoPII, hashEmail, setSaltForTesting,
} from '../src/pii.ts';
import { redactPackument } from '../src/redact.ts';
import type { PackumentDoc } from '../src/packument.ts';
import type { PackumentResult } from '../src/registry.ts';
import type { RetainedPackumentRow } from '../src/run.ts';
import { record } from '../src/run.ts';
import { FsStore } from '../src/store.fs.ts';
import { packument } from './fixtures.ts';
import { CountingStore } from './stores.ts';

setSaltForTesting('test-salt-0123456789abcdef');

const HEAD = 1_000_000;
const newStore = () => new FsStore(mkdtempSync(join(tmpdir(), 'tape-pkg-')));

function feedRow(name: string, seq: number, rev = '1-abc'): FeedRow {
  return { seq, id: name, changes: [{ rev }] };
}

function drained(rows: FeedRow[], sinceSeq: number, lastSeq: number): DrainResult {
  return { rows, sinceSeq, lastSeq, pages: 1, atHead: true };
}

/** Serves a per-name document, so one package can be poisoned and others not. */
function serveByName(docs: Record<string, PackumentDoc>): (name: string) => Promise<PackumentResult> {
  return async (name: string) => {
    const doc = docs[name] ?? packument('nethix');
    const raw = Buffer.from(JSON.stringify(doc), 'utf8');
    return { outcome: 'ok', status: 200, doc, raw, etag: null, bytes: raw.length, error: null };
  };
}

const opts = (store: FsStore, rows: FeedRow[]) => ({
  store,
  now: new Date('2026-08-03T12:00:00Z'),
  headSeqFn: async () => HEAD,
  drainFn: async () => drained(rows, 100, 100 + rows.length),
  fetchPackumentFn: serveByName({}),
});

async function shardRows(store: FsStore): Promise<RetainedPackumentRow[]> {
  const out: RetainedPackumentRow[] = [];
  for (const { key } of await store.list('private/packuments/')) {
    const bytes = await store.get(key);
    if (bytes !== null) {
      out.push(...decodeJsonl<RetainedPackumentRow>(gunzipSync(bytes).toString('utf8')));
    }
  }
  return out;
}

async function obsRows(store: FsStore): Promise<Row[]> {
  const out: Row[] = [];
  for (const { key } of await store.list('raw/obs/')) {
    const bytes = await store.get(key);
    if (bytes !== null) out.push(...decodeJsonl<Row>(gunzipSync(bytes).toString('utf8')));
  }
  return out;
}

/** A tombstone under a distinct name, so N packages can all be retained. */
function tombstone(name: string): PackumentDoc {
  return { ...packument('nethix'), name, _id: name } as PackumentDoc;
}

describe('the guard on a packument shard', () => {
  it('must be assertNoPersonalAddresses — assertNoPII would kill every run', async () => {
    // THE landmine. Retained packuments deliberately keep npm's document shape,
    // including `maintainers[].email` keys whose values are now salted hashes.
    // assertNoPII adds EMAIL_KEY_RE, which matches on the KEY NAME, so it fires
    // on essentially every packument shard — and a ShardWriter guard throw is
    // caught nowhere. Swapping the guard would not skip a package; it would stop
    // the tape. This test fails loudly the day someone "tidies that up".
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));
    await record(opts(store, [feedRow('nethix', 101)]));

    const shards = await store.list('private/packuments/');
    assert.equal(shards.length, 1);
    const text = gunzipSync((await store.get(shards[0]!.key))!).toString('utf8');

    assert.ok(text.includes('"email":'), 'the hashed email KEY is deliberately still there');
    assert.doesNotThrow(() => assertNoPersonalAddresses(text, 'shard'));
    assert.throws(() => assertNoPII(text, 'shard'), /email-key/);
  });

  it('no address rule can match across a row boundary', async () => {
    // The shard text is the rows joined by \n. Neither EMAIL_RE nor MAILTO_RE
    // admits a newline, so gating each row individually really is sufficient and
    // the shard-level guard is a backstop rather than a second chance to fail.
    const spliced = `{"a":"someone"}\n{"b":"example.com"}\n`;
    assert.doesNotThrow(() => assertNoPersonalAddresses(spliced, 'boundary'));
  });
});

describe('one bad packument costs one packument', () => {
  it('refuses it, records a gap, and keeps the rest of the run', async () => {
    // Rule 1. A README that defeats redaction costs forensic depth on one
    // package; aborting costs an entire window of the registry.
    //
    // The poison is a bare `mailto:` with no parseable address after it. That is
    // the real gap between the two layers, not a contrived one: redaction only
    // applies EMAIL_RE, while the gate also runs MAILTO_RE — so this survives the
    // transform and is caught by the check that does not trust it. (A normal
    // `mailto:someone@example.com` would be redacted to `mailto:h:<hash>`, which
    // MAILTO_RE explicitly exempts.)
    const poisoned = tombstone('poisoned');
    (poisoned as Record<string, unknown>)['readme'] = 'reports to mailto:security-team';

    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));
    const summary = await record({
      ...opts(store, [feedRow('good-a', 101), feedRow('poisoned', 102), feedRow('good-b', 103)]),
      fetchPackumentFn: serveByName({
        'good-a': tombstone('good-a'),
        poisoned,
        'good-b': tombstone('good-b'),
      }),
    });

    assert.equal(summary.piiRefused, 1);
    assert.equal(summary.retained, 2, 'the other two still made it');

    const rows = await shardRows(store);
    assert.deepEqual(rows.map((r) => r.name).sort(), ['good-a', 'good-b']);

    const gaps = (await obsRows(store)).filter((r): r is Gap => r.k === 'gap');
    assert.ok(gaps.some((g) => g.kind === 'pii_refused' && g.name === 'poisoned'));

    // And the refused package's observation must NOT point at a shard, or the
    // pointer would name a shard that never contained it. This is what catches
    // reading ShardWriter.pendingKey before the refusal branch.
    const obs = (await obsRows(store)).filter((r): r is Observation => r.k === 'obs');
    assert.equal(obs.find((o) => o.name === 'poisoned')?.packumentKey, null);
    assert.ok(obs.find((o) => o.name === 'good-a')?.packumentKey?.startsWith('private/packuments/'));
  });
});

describe('the number that justifies the change', () => {
  it('collapses many packuments into very few objects', async () => {
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));

    const names = Array.from({ length: 40 }, (_, i) => `pkg-${i}`);
    const docs = Object.fromEntries(names.map((n) => [n, tombstone(n)]));
    const summary = await record({
      ...opts(store, names.map((n, i) => feedRow(n, 101 + i))),
      fetchPackumentFn: serveByName(docs),
    });

    const objects = await store.list('private/packuments/');
    assert.equal(summary.retained, 40, 'forty packuments, reported as ITEMS');
    assert.ok(objects.length <= 2, `forty packuments in ${objects.length} object(s)`);
    assert.equal(summary.retainedShards, objects.length);
    assert.equal((await shardRows(store)).length, 40);
  });

  it('spends no putIfAbsent on the packument path', async () => {
    // The HEAD inside putIfAbsent is the Class B transaction that took the
    // account down. Asserting on request COUNT rather than on the result is the
    // only way that stays true.
    const inner = newStore();
    await cursorMod.write(inner, cursorMod.initial(100, new Date()));
    const counting = new CountingStore(inner);
    await record({ ...opts(inner, [feedRow('nethix', 101)]), store: counting });

    assert.equal(counting.putIfAbsents, 0);
    assert.equal((await inner.list('private/pkg/')).length, 0, 'the legacy prefix is closed');
  });
});

describe('what must survive the layout change', () => {
  it('keeps the per-item hash byte-identical to the old one-object era', async () => {
    // The "npm mutated a packument under a stable _rev" signal only works if
    // hashes recorded before and after this change are comparable.
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));
    await record(opts(store, [feedRow('nethix', 101)]));

    const row = (await shardRows(store))[0]!;
    const expected = sha256Hex(JSON.stringify(redactPackument(packument('nethix'), hashEmail)));
    assert.equal(row.sha256, expected, 'exactly what the old code hashed');

    // And it round-trips out of the shard, so a reader can re-verify it.
    assert.equal(sha256Hex(JSON.stringify(row.doc)), row.sha256);
  });

  it('still admits on GZIPPED size, not raw', async () => {
    // The raw:gz ratio across real packuments runs 3.2x at p50 to 17.5x at p99,
    // so a raw cap would admit and reject an entirely different population. A
    // large but highly compressible document must still be retained.
    // Repetitive but realistic prose, not a single repeated character: a long
    // unbroken run of local-part characters is the EMAIL_RE backtracking case,
    // which has its own test in pii.test.ts.
    const bloated = tombstone('bloated');
    (bloated as Record<string, unknown>)['readme'] = 'the quick brown fox. '.repeat(100_000);

    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));
    const summary = await record({
      ...opts(store, [feedRow('bloated', 101)]),
      fetchPackumentFn: serveByName({ bloated }),
    });

    assert.equal(summary.retained, 1, '2 MB raw but tiny gzipped — still admitted');
    const gaps = (await obsRows(store)).filter((r): r is Gap => r.k === 'gap');
    assert.equal(gaps.filter((g) => g.kind === 'too_large').length, 0);
  });

  it('lets a schema-1 manifest keep verifying', async () => {
    // Every manifest already in the bucket has the old `retained` shape. The
    // ledger reads only `.length`, and in both eras that is the number of
    // objects the run wrote for retained packuments.
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));
    await record(opts(store, [feedRow('nethix', 101)]));

    const key = (await store.list('raw/runs/'))[0]!.key;
    const bytes = (await store.get(key))!;
    const manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as RunManifest;

    assert.equal(manifest.schema, 2);
    assert.equal(Buffer.compare(canonicalManifestBytes(manifest), Buffer.from(bytes)), 0);

    const legacy = { ...manifest, schema: 1 as const, retained: [] };
    assert.doesNotThrow(() => canonicalManifestBytes(legacy));
  });
});

describe('ShardWriter.pendingKey', () => {
  it('names the shard each row actually lands in, across a flush', async () => {
    const store = newStore();
    const writer = new ShardWriter(store, (part) => `t/part-${part}.jsonl.gz`, noGuard);
    const expected: string[] = [];

    // 260 rows, so the 250-row auto-flush fires partway through.
    for (let i = 0; i < 260; i++) {
      expected.push(writer.pendingKey);
      await writer.add({ i });
    }
    await writer.flush();

    for (const [i, key] of expected.entries()) {
      const bytes = (await store.get(key))!;
      const rows = decodeJsonl<{ i: number }>(gunzipSync(bytes).toString('utf8'));
      assert.ok(rows.some((r) => r.i === i), `row ${i} is in the shard pendingKey named`);
    }
  });
});
