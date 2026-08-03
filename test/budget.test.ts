import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';

import * as budgetMod from '../src/budget.ts';
import { BUDGET_HARD_FRACTION, BUDGET_SOFT_FRACTION, STORAGE_FREE_TIER_BYTES } from '../src/config.ts';
import * as cursorMod from '../src/cursor.ts';
import type { DrainResult, FeedRow } from '../src/feed.ts';
import { decodeJsonl } from '../src/jsonl.ts';
import { shouldRetainPackument } from '../src/observation.ts';
import type { Gap, Row } from '../src/observation.ts';
import { setSaltForTesting } from '../src/pii.ts';
import type { PackumentResult } from '../src/registry.ts';
import { record } from '../src/run.ts';
import { FsStore } from '../src/store.fs.ts';
import { keys, type Store } from '../src/store.ts';
import { packument } from './fixtures.ts';

setSaltForTesting('test-salt-0123456789abcdef');

const HEAD = 1_000_000;
const CEILING = 1_000_000;
const newStore = () => new FsStore(mkdtempSync(join(tmpdir(), 'tape-budget-')));
/** Only writeFeedBlob can mint a real receipt; the budget never reads it. */
const RECEIPT = {} as never;

function feedRow(name: string, seq: number, rev = '1-abc'): FeedRow {
  return { seq, id: name, changes: [{ rev }] };
}

function drained(rows: FeedRow[], sinceSeq: number, lastSeq: number): DrainResult {
  return { rows, sinceSeq, lastSeq, pages: 1, atHead: true };
}

function serve(fixture: string): () => Promise<PackumentResult> {
  const doc = packument(fixture);
  const raw = Buffer.from(JSON.stringify(doc), 'utf8');
  return async () => ({
    outcome: 'ok', status: 200, doc, raw, etag: null, bytes: raw.length, error: null,
  });
}

/** Seeds the anchor the recorder reads, at a chosen fraction of the ceiling. */
async function seedUsage(store: Store, storedBytes: number, at = '2026-08-03T03:23:00Z') {
  await budgetMod.write(store, {
    schema: 1, storedBytes, objects: 1, measuredAt: at, byPrefix: {},
  });
}

const opts = (store: FsStore, rows: FeedRow[], fixture = 'left-pad') => ({
  store,
  now: new Date('2026-08-03T12:00:00Z'),
  storageCeilingBytes: CEILING,
  headSeqFn: async () => HEAD,
  drainFn: async () => drained(rows, 100, 100 + rows.length),
  fetchPackumentFn: serve(fixture),
});

async function gapsIn(store: FsStore): Promise<Gap[]> {
  const out: Row[] = [];
  for (const { key } of await store.list('raw/obs/')) {
    const bytes = await store.get(key);
    if (bytes !== null) out.push(...decodeJsonl<Row>(gunzipSync(bytes).toString('utf8')));
  }
  return out.filter((r): r is Gap => r.k === 'gap');
}

describe('the ladder', () => {
  it('picks a tier at each threshold', () => {
    const at = (f: number) => budgetMod.tierFor(RECEIPT, Math.ceil(CEILING * f), CEILING);
    assert.equal(at(0), 'normal');
    assert.equal(at(BUDGET_SOFT_FRACTION - 0.01), 'normal');
    assert.equal(at(BUDGET_SOFT_FRACTION), 'soft');
    assert.equal(at(BUDGET_HARD_FRACTION - 0.01), 'soft');
    assert.equal(at(BUDGET_HARD_FRACTION), 'hard');
    assert.equal(at(10), 'hard');
  });

  it('takes its ceiling from the environment, and refuses nonsense', () => {
    assert.equal(budgetMod.ceilingBytes({}), STORAGE_FREE_TIER_BYTES);
    assert.equal(budgetMod.ceilingBytes({ TAPE_STORAGE_CEILING_BYTES: '500' }), 500);
    // One knob: an absurdly high ceiling is how the cap is disabled, so there is
    // no second flag to fall out of sync with it.
    assert.equal(budgetMod.ceilingBytes({ TAPE_STORAGE_CEILING_BYTES: '1e15' }), 1e15);
    assert.throws(() => budgetMod.ceilingBytes({ TAPE_STORAGE_CEILING_BYTES: 'lots' }), /not a positive/);
  });
});

describe('what each tier gives up', () => {
  it('cuts by irreplaceability, not by size', () => {
    // The whole argument for the soft rung in one assertion: an unpublished
    // package's packument 404s tomorrow; a new package's is still there. So under
    // storage pressure the tape keeps death certificates and gives up birth
    // certificates. security_holder survives every tier — it is npm's own
    // takeover marker, it is tiny, and a takeover is what this archive is for.
    const at = (flags: string[], tier: 'normal' | 'soft') =>
      shouldRetainPackument({ flags }, tier);

    assert.equal(at(['package_unpublished'], 'normal'), true);
    assert.equal(at(['package_unpublished'], 'soft'), true, 'this one 404s tomorrow');
    assert.equal(at(['security_holder_confirmed'], 'soft'), true);

    assert.equal(at(['new_package'], 'normal'), true);
    assert.equal(at(['new_package'], 'soft'), false, 'this one is still re-fetchable');
    assert.equal(at(['install_scripts'], 'normal'), true);
    assert.equal(at(['install_scripts'], 'soft'), false);
    assert.equal(at(['version_unpublished'], 'normal'), false, 'never retained at any tier');
  });

  it('SOFT keeps the tombstone and skips the re-fetchable packument', async () => {
    const tombstone = newStore();
    await cursorMod.write(tombstone, cursorMod.initial(100, new Date()));
    await seedUsage(tombstone, CEILING * 0.8);
    const kept = await record({
      ...opts(tombstone, [feedRow('nethix', 101)], 'nethix'),
      fetchPackumentFn: serve('nethix'),
    });
    assert.equal(kept.storage.tier, 'soft');
    assert.equal(kept.retained, 1, 'the death certificate is kept');
    assert.equal((await tombstone.list('private/packuments/')).length, 1);

    // left-pad observed hours after its real 2014 creation is flagged new_package
    // and nothing else — retained normally, skipped under pressure.
    const fresh = newStore();
    await cursorMod.write(fresh, cursorMod.initial(100, new Date()));
    await seedUsage(fresh, CEILING * 0.8, '2014-03-14T03:00:00Z');
    const dropped = await record({
      ...opts(fresh, [feedRow('left-pad', 101)]),
      now: new Date('2014-03-14T12:00:00Z'),
    });
    assert.equal(dropped.storage.tier, 'soft');
    assert.equal(dropped.retained, 0, 'the re-fetchable one is not');
    assert.equal(dropped.retentionSkipped, 1);

    // Observations still land at the soft tier — only the payload is given up.
    assert.ok((await fresh.list('raw/obs/')).length > 0);
    const budgetGap = (await gapsIn(fresh)).find((g) => g.kind === 'budget');
    assert.ok(budgetGap, 'one row per degraded run makes it queryable in the index');
    assert.match(budgetGap.detail!, /tier=soft;retention_skipped=1/);
  });

  it('HARD is the existing triage path, and still records its own degradation', async () => {
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));
    await seedUsage(store, CEILING * 0.95);

    const summary = await record(opts(store, [feedRow('left-pad', 101), feedRow('lodash', 102)]));
    assert.equal(summary.storage.tier, 'hard');
    assert.equal(summary.mode, 'triage');
    assert.equal(summary.triageReason, 'budget', 'mode is the behaviour, this is the cause');
    assert.equal(summary.fetched, 0);
    assert.equal((await store.list('private/')).length, 0);

    const triage = (await gapsIn(store)).find((g) => g.kind === 'triage');
    assert.ok(triage, 'the record of the degradation is never itself a casualty of it');
    assert.match(triage.detail!, /reason=budget/);

    // And the names are all still in the deferred queue, so this is delay only.
    assert.equal(summary.deferred, 2);
  });
});

describe('the rule the cap may never break', () => {
  it('writes the feed and advances the cursor at 100x over the ceiling', async () => {
    // The single most important test here. The changes feed is queryable forward
    // only and has no substitute anywhere on the internet, so refusing to write it
    // is the one refusal that loses data permanently. `tierFor` takes a
    // FeedReceipt it never reads precisely so this cannot regress silently: the
    // budget is not evaluable until the feed is already durable.
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));
    await seedUsage(store, CEILING * 100);

    const summary = await record(opts(store, [feedRow('left-pad', 101)]));
    assert.equal(summary.storage.tier, 'hard');
    assert.equal((await store.list('raw/feed/')).length, 1, 'COMMIT A happened anyway');
    assert.equal((await cursorMod.read(store))?.lastSeq, 101, 'and COMMIT B followed it');
    assert.equal(summary.feedRows, 1);
  });

  it('under-estimates rather than over-estimates when the anchor is missing', async () => {
    // No anchor means the estimate is drift only, which fails TOWARD recording.
    // A cap that guesses high would degrade a healthy tape on no evidence.
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));

    const summary = await record(opts(store, [feedRow('left-pad', 101)]));
    assert.equal(summary.storage.tier, 'normal');
    assert.equal(summary.storage.anchored, false);
    assert.equal(summary.storage.stale, true, 'and the operator is told the cap is not enforcing');
  });

  it('warns but does not fail when the anchor is stale', async () => {
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));
    await seedUsage(store, CEILING * 0.1, '2026-06-01T00:00:00Z'); // two months old

    const summary = await record(opts(store, [feedRow('left-pad', 101)]));
    assert.equal(summary.storage.stale, true);
    assert.equal(summary.storage.anchored, true);
    assert.equal(summary.feedRows, 1, 'the tape outranks its own accounting');
  });
});

describe('the accounting behind the cap', () => {
  it('latches the tier for the whole run', async () => {
    // A tier that flipped mid-loop would produce a half-retaining run that is hard
    // to reason about and harder to test. The contract is: uniform within a run,
    // and the NEXT run picks up the change.
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));
    // Just under soft. The run's own bytes push past it, but not until it ends.
    await seedUsage(store, Math.ceil(CEILING * BUDGET_SOFT_FRACTION) - 1);

    const first = await record({
      ...opts(store, [feedRow('nethix', 101)], 'nethix'),
      fetchPackumentFn: serve('nethix'),
    });
    assert.equal(first.storage.tier, 'normal', 'latched at the top of the run');

    const second = await record({
      ...opts(store, [feedRow('nethix', 102)], 'nethix'),
      now: new Date('2026-08-03T12:15:00Z'),
      fetchPackumentFn: serve('nethix'),
    });
    assert.equal(second.storage.tier, 'soft', 'and the next run sees the drift');
  });

  it('resets the drift when a newer measurement lands', async () => {
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));
    await seedUsage(store, 1000, '2026-08-03T03:00:00Z');
    await record(opts(store, [feedRow('left-pad', 101)]));

    const drifted = (await cursorMod.read(store))!;
    assert.ok(drifted.bytesSinceUsageAnchor > 0);
    assert.equal(drifted.usageAnchorAt, '2026-08-03T03:00:00Z');

    // A fresh nightly measurement supersedes the drift rather than adding to it.
    await seedUsage(store, 50_000, '2026-08-04T03:00:00Z');
    const after = await record({
      ...opts(store, [feedRow('lodash', 102)]),
      now: new Date('2026-08-04T12:00:00Z'),
    });
    const reset = (await cursorMod.read(store))!;
    assert.equal(reset.usageAnchorAt, '2026-08-04T03:00:00Z');
    assert.ok(after.storage.storedBytes >= 50_000 && after.storage.storedBytes < 60_000,
      'the anchor is truth; the drift restarts from it');
  });

  it('measures the bucket rather than projecting it', async () => {
    // The one number allowed to make the recorder degrade itself is measured, not
    // estimated. A storage figure guessed at a desk was wrong by 13x once already.
    const store = newStore();
    await store.put('raw/feed/a.gz', Buffer.alloc(500));
    await store.put('private/pkg/x/1.gz', Buffer.alloc(1500));
    await store.put(keys.cursor(), Buffer.alloc(300));

    const usage = await budgetMod.measure(store, new Date('2026-08-03T03:23:00Z'));
    assert.equal(usage.storedBytes, 2300, 'state/ bills too, even though the mirror skips it');
    assert.equal(usage.objects, 3);
    assert.equal(usage.byPrefix['private/']?.bytes, 1500);
    assert.equal(usage.byPrefix['state/']?.bytes, 300);
  });
});
