import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';

import * as cursorMod from '../src/cursor.ts';
import type { DrainResult, FeedRow } from '../src/feed.ts';
import { decodeJsonl } from '../src/jsonl.ts';
import { canonicalManifestBytes, type RunManifest } from '../src/manifest.ts';
import type { Gap, Observation, Row } from '../src/observation.ts';
import { setSaltForTesting } from '../src/pii.ts';
import type { PackumentResult } from '../src/registry.ts';
import { FsStore } from '../src/store.fs.ts';
import { keys } from '../src/store.ts';
import { record } from '../src/run.ts';
import { packument } from './fixtures.ts';
import { FailingPutStore } from './stores.ts';

setSaltForTesting('test-salt-0123456789abcdef');

const HEAD = 1_000_000;
const newStore = () => new FsStore(mkdtempSync(join(tmpdir(), 'tape-run-')));

function feedRow(name: string, seq: number, rev = '1-abc'): FeedRow {
  return { seq, id: name, changes: [{ rev }] };
}

function drained(rows: FeedRow[], sinceSeq: number, lastSeq: number): DrainResult {
  return { rows, sinceSeq, lastSeq, pages: 1, atHead: true };
}

/** Serves a real captured packument for any requested name. */
function serve(fixture = 'left-pad'): (name: string) => Promise<PackumentResult> {
  const doc = packument(fixture);
  const raw = Buffer.from(JSON.stringify(doc), 'utf8');
  return async () => ({
    outcome: 'ok', status: 200, doc, raw, etag: null, bytes: raw.length, error: null,
  });
}

async function readRows(store: FsStore, prefix: string): Promise<Row[]> {
  const out: Row[] = [];
  for (const { key } of await store.list(prefix)) {
    const bytes = await store.get(key);
    if (bytes === null) continue;
    out.push(...decodeJsonl<Row>(gunzipSync(bytes).toString('utf8')));
  }
  return out;
}

const baseOpts = (store: FsStore, rows: FeedRow[], since: number, last: number) => ({
  store,
  now: new Date('2026-08-03T12:00:00Z'),
  headSeqFn: async () => HEAD,
  drainFn: async () => drained(rows, since, last),
  fetchPackumentFn: serve(),
});

describe('the run loop, end to end', () => {
  it('writes the feed, advances the cursor, and records an observation per package', async () => {
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));

    const rows = [feedRow('left-pad', 101), feedRow('@ctrl/tinycolor', 102)];
    const summary = await record(baseOpts(store, rows, 100, 102));

    assert.equal(summary.feedRows, 2);
    assert.equal(summary.fetched, 2);
    assert.equal(summary.deferred, 0);

    const feedObjects = await store.list('raw/feed/');
    assert.equal(feedObjects.length, 1);
    assert.match(feedObjects[0]!.key, /100-102\.jsonl\.gz$/);

    const obs = (await readRows(store, 'raw/obs/')).filter((r): r is Observation => r.k === 'obs');
    assert.deepEqual(obs.map((o) => o.name).sort(), ['@ctrl/tinycolor', 'left-pad']);

    const cursor = await cursorMod.read(store);
    assert.equal(cursor?.lastSeq, 102);
    assert.equal(cursor?.pendingFeedKey, null, 'released once the run completed');

    assert.equal((await store.list('raw/runs/')).length, 1, 'manifest written');
  });

  it('handles a scoped name in every key it writes', async () => {
    // 77.5% of live npm activity is scoped, and the keys percent-encode names.
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));
    await record(baseOpts(store, [feedRow('@ctrl/tinycolor', 101)], 100, 101));

    const obs = (await readRows(store, 'raw/obs/')).filter((r): r is Observation => r.k === 'obs');
    assert.equal(obs[0]?.name, '@ctrl/tinycolor');
  });
});

describe('the commit ordering — the safety argument', () => {
  it('does NOT advance the cursor when the feed bytes fail to land', async () => {
    // COMMIT A must precede COMMIT B. If the archive write fails, the cursor has
    // to stay put: those feed rows can never be re-requested, so advancing past
    // them would lose events permanently. This is the single invariant the whole
    // design rests on.
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));

    const broken = new FailingPutStore(store, (key) => key.startsWith('raw/feed/'));

    await assert.rejects(
      () => record({ ...baseOpts(store, [feedRow('left-pad', 101)], 100, 101), store: broken }),
      /object store unavailable/,
    );

    const cursor = await cursorMod.read(store);
    assert.equal(cursor?.lastSeq, 100, 'cursor must not move past unwritten feed rows');
    assert.equal((await store.list('raw/feed/')).length, 0);
  });

  it('leaves the window claimed when a run dies mid-fetch, and recovers it next time', async () => {
    // The cursor advances BEFORE packuments are fetched, deliberately — the feed
    // is the irreplaceable half. So a mid-fetch death has to leave a pointer back
    // to those names, or "delay, not loss" is only a slogan.
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));

    const rows = [feedRow('left-pad', 101), feedRow('lodash', 102)];
    await assert.rejects(() =>
      record({
        ...baseOpts(store, rows, 100, 102),
        fetchPackumentFn: async () => {
          throw new Error('killed mid-fetch');
        },
      }),
    );

    const afterCrash = await cursorMod.read(store);
    assert.equal(afterCrash?.lastSeq, 102, 'the feed bytes were durable, so the cursor moved');
    assert.ok(afterCrash?.pendingFeedKey, 'and the window is still claimed as in flight');

    // The next run finds the claim and re-queues those names from the archive.
    const summary = await record({
      ...baseOpts(store, [], 102, 102),
      now: new Date('2026-08-03T12:30:00Z'),
    });
    assert.equal(summary.feedRows, 0, 'nothing new in the feed');
    assert.equal(summary.fetched, 2, 'but both abandoned packages were re-fetched');

    const recovered = await cursorMod.read(store);
    assert.equal(recovered?.pendingFeedKey, null, 'claim released after a clean run');
  });

  it('replaying the same window is idempotent', async () => {
    // Every failure mode in this design produces duplicates rather than gaps, so
    // duplicates have to be genuinely free.
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));
    const rows = [feedRow('left-pad', 101)];

    await record(baseOpts(store, rows, 100, 101));
    const first = await store.get((await store.list('raw/feed/'))[0]!.key);

    // Rewind and replay the identical window.
    const c = await cursorMod.read(store);
    await cursorMod.write(store, { ...c!, lastSeq: 100, pendingFeedKey: null });
    await record(baseOpts(store, rows, 100, 101));

    const feedObjects = await store.list('raw/feed/');
    assert.equal(feedObjects.length, 1, 'same window, same deterministic key');
    assert.deepEqual(Buffer.from(await store.get(feedObjects[0]!.key) ?? []), Buffer.from(first!));
  });
});

describe('the deferred queue', () => {
  it('is a single key, overwritten — so no credential needs delete', async () => {
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));

    const rows = [feedRow('a', 101), feedRow('b', 102), feedRow('c', 103)];
    const first = await record({ ...baseOpts(store, rows, 100, 103), maxFetch: 1 });
    assert.equal(first.fetched, 1);
    assert.equal(first.deferred, 2);

    const work = await store.list('work/');
    assert.deepEqual(work.map((o) => o.key), [keys.deferred()]);

    // Next run picks the remainder up and clears the queue.
    const second = await record({
      ...baseOpts(store, [], 103, 103),
      now: new Date('2026-08-03T12:30:00Z'),
    });
    assert.equal(second.fetched, 2, 'the two deferred names were retried');

    const drainedQueue = await store.get(keys.deferred());
    assert.equal(gunzipSync(drainedQueue!).toString('utf8'), '', 'queue emptied, not deleted');
    assert.equal((await store.list('work/')).length, 1, 'still exactly one key');
  });
});

describe('byte accounting and the manifest', () => {
  it('reports the real stored size, not an estimate', async () => {
    // The feed blob's size used to be `receipt.rows * 100` — a RAW-byte figure
    // applied to a gzipped object, over-counting stored bytes ~3x, and it was the
    // only write in the run that was estimated rather than measured. A spend cap
    // built on that number would fire at the wrong time, so this asserts the
    // accounting against the bucket itself.
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));
    const summary = await record(baseOpts(store, [feedRow('left-pad', 101)], 100, 101));

    let stored = 0;
    for (const o of await store.list('')) {
      // The cursor is overwritten in place at a fixed few hundred bytes, so it
      // costs storage once, not once per run. Counting it per run would invent
      // tens of KB a day of growth that never actually happens.
      if (o.key === keys.cursor()) continue;
      stored += o.size;
    }
    assert.equal(summary.bytesWritten, stored, 'every byte in the bucket is accounted for');
  });

  it('writes the deferred gap row — it must be added before the final flush', async () => {
    // This row used to be added AFTER shards.flush(). ShardWriter.add only
    // auto-flushes at SHARD_MAX_ROWS or SHARD_MAX_BYTES, and one row trips
    // neither, so every deferred gap row the tape ever wrote was buffered and
    // discarded — and was absent from manifest.obsShards for the same reason.
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));

    const rows = [feedRow('a', 101), feedRow('b', 102), feedRow('c', 103)];
    const summary = await record({ ...baseOpts(store, rows, 100, 103), maxFetch: 1 });
    assert.equal(summary.deferred, 2);

    const gaps = (await readRows(store, 'raw/obs/')).filter((r): r is Gap => r.k === 'gap');
    const deferred = gaps.find((g) => g.kind === 'deferred');
    assert.ok(deferred, 'the deferred gap row must reach the archive');
    assert.equal(deferred.detail, 'count=2');
  });

  it('names and hashes everything it wrote, including retained packuments', async () => {
    // README calls the manifest "sha256 of everything written". Retained
    // packuments appeared in it nowhere at all, so a retained packument could be
    // replaced in the bucket with every manifest still verifying.
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));

    // nethix is a real tombstone, so it is retained under package_unpublished.
    await record({
      ...baseOpts(store, [feedRow('nethix', 101)], 100, 101),
      fetchPackumentFn: serve('nethix'),
    });

    const manifestKey = (await store.list('raw/runs/'))[0]!.key;
    const bytes = (await store.get(manifestKey))!;
    const manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as RunManifest;

    const feedObject = (await store.list('raw/feed/'))[0]!;
    assert.equal(manifest.feedBlob.gzBytes, feedObject.size, 'feed size matches the object');

    // The legacy one-object-per-packument prefix is a closed set — nothing
    // writes there any more, and this run must not have.
    assert.equal((await store.list('private/pkg/')).length, 0);

    const shards = await store.list('private/packuments/');
    assert.equal(shards.length, 1, 'the tombstone was retained, in a shard');
    assert.equal(manifest.retained.length, 1, 'and the manifest names the shard');
    assert.equal(manifest.retained[0]!.key, shards[0]!.key);
    assert.equal(manifest.retained[0]!.gzBytes, shards[0]!.size);
    assert.equal(manifest.retained[0]!.rows, 1);
    assert.match(manifest.retained[0]!.sha256, /^[0-9a-f]{64}$/);

    // The writer and the ledger's verifier must agree byte for byte on what
    // "canonical" means, or the chain starts failing for no reason.
    assert.equal(Buffer.compare(canonicalManifestBytes(manifest), Buffer.from(bytes)), 0);
  });
});

describe('gap rows', () => {
  it('records a 404 as an outcome rather than an error', async () => {
    // ~11% of recently-malicious packages already 404, and the takedown is what
    // makes them interesting — a miss here loses exactly the wrong events.
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));

    const summary = await record({
      ...baseOpts(store, [feedRow('deleted-thing', 101)], 100, 101),
      fetchPackumentFn: async () => ({
        outcome: 'gone', status: 404, doc: null, raw: null, etag: null, bytes: 0, error: null,
      }),
    });

    assert.equal(summary.fetched, 1);
    const obs = (await readRows(store, 'raw/obs/')).filter((r): r is Observation => r.k === 'obs');
    assert.equal(obs[0]?.outcome, 'gone');
    assert.deepEqual(obs[0]?.flags, ['gone']);
  });
});
