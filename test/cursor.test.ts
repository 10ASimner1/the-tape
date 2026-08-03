import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import * as cursorMod from '../src/cursor.ts';
import { FsStore } from '../src/store.fs.ts';
import { keys } from '../src/store.ts';

const newStore = () => new FsStore(mkdtempSync(join(tmpdir(), 'tape-cursor-')));
const write = async (store: FsStore, obj: unknown) =>
  store.put(keys.cursor(), Buffer.from(JSON.stringify(obj), 'utf8'));

describe('cursor schema drift', () => {
  it('fills in fields added after the stored cursor was written', async () => {
    // This is not hypothetical — it took the recorder down in production. A cursor
    // written before `pendingFeedKey` existed read back as `undefined`, which
    // passed a `!== null` check, and the resulting get() of an empty key fetched a
    // bucket listing that then failed to gunzip. An archive that runs for years
    // will keep meeting older cursors, so normalising on read is the fix rather
    // than trusting every call site.
    const store = newStore();
    await write(store, { schema: 1, lastSeq: 122_957_464, lastRunId: '2026-08-03T01-14-06Z' });

    const cursor = await cursorMod.read(store);
    assert.ok(cursor);
    assert.equal(cursor.lastSeq, 122_957_464);
    // Every absent field must come back as a real null, never undefined.
    assert.strictEqual(cursor.pendingFeedKey, null);
    assert.strictEqual(cursor.osvWatermark, null);
    assert.strictEqual(cursor.lastRunCompletedAt, null);
    assert.strictEqual(cursor.bytesWrittenMonth, 0);
    assert.equal(typeof cursor.monthKey, 'string');

    for (const [k, v] of Object.entries(cursor)) {
      assert.notEqual(v, undefined, `${k} must not be undefined`);
    }
  });

  it('refuses a cursor with no usable position rather than guessing', async () => {
    // Silently defaulting lastSeq to 0 would re-read the entire feed from the
    // beginning, where 9,999 of the first 10,000 rows are ancient tombstones.
    const store = newStore();
    await write(store, { schema: 1, lastRunId: 'x' });
    await assert.rejects(() => cursorMod.read(store), /lastSeq/);
  });

  it('returns null when there is no cursor at all', async () => {
    assert.equal(await cursorMod.read(newStore()), null);
  });
});

describe('cursor pending-window lifecycle', () => {
  it('claims the feed window on advance and releases it on completion', async () => {
    const now = new Date('2026-08-03T09:00:00Z');
    const start = cursorMod.initial(100, now);
    assert.equal(start.pendingFeedKey, null);

    // Only writeFeedBlob can mint a real receipt; this stands in for one.
    const receipt = { lastSeq: 200, key: 'raw/feed/2026/08/03/100-200.jsonl.gz' } as never;

    const advanced = cursorMod.advance(start, receipt, now);
    assert.equal(advanced.lastSeq, 200);
    assert.equal(advanced.pendingFeedKey, 'raw/feed/2026/08/03/100-200.jsonl.gz',
      'the window is in flight until the run finishes');

    const done = cursorMod.withRunComplete(advanced, 'run-1', now, 1234);
    assert.equal(done.pendingFeedKey, null, 'released only once the run completed');
    assert.equal(done.lastRunId, 'run-1');
  });

  it('refuses to move backwards', () => {
    const now = new Date('2026-08-03T09:00:00Z');
    const at500 = cursorMod.initial(500, now);
    const backwards = { lastSeq: 400, key: 'k' } as never;
    assert.throws(() => cursorMod.advance(at500, backwards, now), /backwards/);
  });
});
