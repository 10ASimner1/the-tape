import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertDistinctConfig, assertSamePrimary, mirror, readState, SameStoreError,
} from '../src/mirror.ts';
import { FsStore } from '../src/store.fs.ts';
import type { Store } from '../src/store.ts';
import { CountingStore, FailingPutStore, VanishingGetStore } from './stores.ts';

const NOW = new Date('2026-08-03T05:41:00Z');
const newStore = () => new FsStore(mkdtempSync(join(tmpdir(), 'tape-mirror-')));

/** A miniature archive: every prefix the mirror cares about, plus the two it
 *  must leave alone. */
async function seed(store: Store): Promise<void> {
  const put = (k: string, v: string) => store.put(k, Buffer.from(v, 'utf8'));
  await put('raw/feed/2026/08/03/100-101.jsonl.gz', 'feed-one');
  await put('raw/feed/2026/08/03/101-102.jsonl.gz', 'feed-two');
  await put('raw/runs/2026/08/03/run-a.json', 'manifest-a');
  await put('raw/obs/2026/08/03/run-a/part-000.jsonl.gz', 'obs-one');
  await put('raw/obs/2026/08/03/run-a/part-001.jsonl.gz', 'obs-two');
  await put('raw/osv/2026/08/03/run-a.jsonl.gz', 'osv');
  await put('private/pkg/left-pad/1-abc.json.gz', 'packument');
  // Neither of these is a record, and neither may be mirrored.
  await put('state/cursor.json', '{"lastSeq":102}');
  await put('work/deferred/current.jsonl.gz', 'queue');
}

/** Archive keys only — `mirror/` is the mirror's own bookkeeping, not a copy of
 *  anything, and it lives on the mirror precisely so it survives the primary. */
const keysOf = async (s: Store, p = '') =>
  (await s.list(p)).map((o) => o.key).filter((k) => !k.startsWith('mirror/')).sort();
const run = (primary: Store, target: Store, extra: Record<string, unknown> = {}) =>
  mirror({ primary, mirror: target, now: NOW, skipProbe: true, ...extra });

describe('the mirror copies the archive and nothing else', () => {
  it('copies every immutable prefix, and neither the cursor nor the work queue', async () => {
    // state/ is mutable and work/ is a cache. Leaving both out is what makes the
    // mirror a pure append, so the mirror credential needs neither delete nor
    // overwrite — and it is why the restore drill has to re-derive the cursor.
    const primary = newStore();
    const target = newStore();
    await seed(primary);

    const report = await run(primary, target);
    assert.equal(report.copied, 7);
    assert.equal(report.complete, true);

    const copied = await keysOf(target);
    assert.ok(copied.includes('raw/feed/2026/08/03/100-101.jsonl.gz'));
    assert.ok(copied.includes('private/pkg/left-pad/1-abc.json.gz'));
    assert.ok(!copied.includes('state/cursor.json'), 'the cursor is deliberately not mirrored');
    assert.ok(!copied.includes('work/deferred/current.jsonl.gz'), 'the queue is a cache');
  });

  it('is idempotent — a second run issues no writes at all', async () => {
    // Proves the DIFF, not just the copy. Without this the mirror could be
    // re-uploading the whole archive nightly and nothing would say so.
    const primary = newStore();
    const inner = newStore();
    await seed(primary);
    await run(primary, inner);

    const counting = new CountingStore(inner);
    const second = await run(primary, counting);
    assert.equal(second.copied, 0);
    assert.equal(counting.putIfAbsents, 0, 'nothing was re-copied');
    assert.equal(counting.puts, 1, 'only mirror/state.json was written');
  });

  it('resumes after a mid-copy failure, holding no state to do it', async () => {
    const primary = newStore();
    const inner = newStore();
    await seed(primary);

    const flaky = new FailingPutStore(inner, (k) => k.includes('part-001'));
    await assert.rejects(() => run(primary, flaky), /object store unavailable/);
    const partial = await keysOf(inner);
    assert.ok(partial.length > 0 && partial.length < 7, 'some progress, not all');

    // Nothing was recorded about where it stopped. The diff is recomputed.
    const report = await run(primary, inner);
    assert.equal(report.complete, true);
    assert.equal((await keysOf(inner)).length, 7);
  });

  it('copies the irreplaceable prefixes first when it runs out of budget', async () => {
    // Rule 1 as a testable property: a mirror that cannot finish must have
    // spent what time it had on the feed, which nothing else on the internet has.
    const primary = newStore();
    const target = newStore();
    await seed(primary);

    const report = await run(primary, target, { maxObjects: 2 });
    assert.equal(report.complete, false);
    assert.deepEqual(await keysOf(target, 'raw/feed/'), [
      'raw/feed/2026/08/03/100-101.jsonl.gz',
      'raw/feed/2026/08/03/101-102.jsonl.gz',
    ]);
    assert.deepEqual(await keysOf(target, 'private/'), [], 'discretionary bytes waited');
  });
});

describe('what the mirror refuses to decide', () => {
  it('reports a size mismatch and leaves the object alone', async () => {
    // In an append-only archive two different sizes at one key means one side is
    // corrupt, and which side is right is a human decision, not a default.
    const primary = newStore();
    const target = newStore();
    await seed(primary);
    const key = 'raw/obs/2026/08/03/run-a/part-000.jsonl.gz';
    await target.put(key, Buffer.from('trunc', 'utf8'));

    const report = await run(primary, target);
    assert.deepEqual(report.prefixes.find((p) => p.prefix === 'raw/obs/')?.mismatched, [key]);
    assert.equal(Buffer.from((await target.get(key))!).toString('utf8'), 'trunc',
      'not silently overwritten');

    const repaired = await run(primary, target, { repair: true });
    assert.equal(repaired.mismatched, 1, 'still reported');
    assert.equal(Buffer.from((await target.get(key))!).toString('utf8'), 'obs-one');
  });

  it('treats a vanished source object as an alarm and keeps going', async () => {
    // The primary listed it and then could not produce it. An append-only archive
    // does not do that, so it is never a retry — but it must not stop the copy of
    // everything else either.
    const primary = newStore();
    await seed(primary);
    const gone = 'private/pkg/left-pad/1-abc.json.gz';

    const report = await run(new VanishingGetStore(primary, (k) => k === gone), newStore());
    assert.equal(report.vanished, 1);
    assert.equal(report.copied, 6, 'the other six still landed');
  });

  it('catches a same-length forgery that the size check cannot see', async () => {
    // The routine size comparison covers 100% of objects on a weak property; the
    // deep check covers a handful on a strong one. Neither substitutes for the
    // other, and this is the case that proves it.
    const primary = newStore();
    const target = newStore();
    await seed(primary);
    await run(primary, target);

    const key = 'raw/feed/2026/08/03/100-101.jsonl.gz';
    await target.put(key, Buffer.from('feed-XXX', 'utf8')); // same length, different bytes

    const sizeOnly = await run(primary, target);
    assert.equal(sizeOnly.mismatched, 0, 'byte length alone sees nothing wrong');

    const deep = await run(primary, target, { verify: 'all' });
    assert.deepEqual(deep.verifyFailures, [key]);
  });
});

describe('proving the second copy is actually a second copy', () => {
  it('refuses two stores that resolve to the same place', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tape-same-'));
    assert.throws(
      () => assertDistinctConfig(new FsStore(root), new FsStore(root)),
      SameStoreError,
    );
  });

  it('catches the same store even when the config looks different', async () => {
    // A CNAME, or an http/https spelling difference, defeats a config comparison.
    // The nonce probe does not care what anything is called.
    const root = mkdtempSync(join(tmpdir(), 'tape-alias-'));
    const a = new FsStore(root);
    const b = new FsStore(`${root}${join('/', '.')}`);
    await assert.rejects(
      () => mirror({ primary: a, mirror: b, now: NOW }),
      SameStoreError,
    );
  });

  it('refuses a mirror that was built from a different primary', async () => {
    // Copying a second archive into it would interleave two histories in one
    // bucket, and the run would look like a huge successful backfill.
    const primary = newStore();
    const target = newStore();
    await seed(primary);
    await run(primary, target);

    const state = await readState(target);
    assert.ok(state?.primary, 'the mirror records which primary it came from');
    assert.throws(() => assertSamePrimary(state, newStore()), /interleave two histories/);
    assert.doesNotThrow(() => assertSamePrimary(state, primary));
  });
});
